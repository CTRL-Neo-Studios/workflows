import type { Diagnostic, DiagnosticCode, DiagnosticLocation } from "./diagnostics";
import type { DocumentV1, EdgeInstance } from "./document";
import { type Constraint, type Instance, resolve, solve, type TypeVar } from "./infer";
import { checkManifest, conversionKey, type DataPortDef, type LanguageManifest } from "./manifest";
import { type Json, validateValue } from "./schema";
import { formatType, isGround, type TypeTable, type TypeTerm } from "./types";

export interface Analysis {
  diagnostics: Diagnostic[];
  /** Resolved type of a data port; unsolved variables stay as `var` terms. `undefined` for exec or unknown ports. */
  typeOf(node: string, port: string, dir: "in" | "out"): TypeTerm | undefined;
  /** Edges whose value goes through a `ConversionDef`. */
  convertedEdges: ReadonlySet<string>;
  /** Capabilities of every node reachable from an event node (§7). */
  capabilities: ReadonlySet<string>;
}

/** Type arguments come from untrusted documents; recursion over them must stay shallow. */
const MAX_TYPE_DEPTH = 32;
// ponytail: fixed cap on document-chosen variadic counts; make it a manifest/limit option if a language needs more.
const MAX_VARIADIC = 1024;

type Port = { kind: "exec" } | { kind: "data"; def: DataPortDef };
const EXEC: Port = { kind: "exec" };

interface DataEdge {
  edge: EdgeInstance;
  from: Instance;
  out: DataPortDef;
  to: Instance;
  in: DataPortDef;
}

interface ExecEdge {
  edge: EdgeInstance;
  from: Instance;
  to: Instance;
}

/** Stops descending at `max`, so a hostile 100k-deep term costs `max` steps, not a stack overflow. */
function deeperThan(term: TypeTerm, max: number): boolean {
  if (max <= 0) return true;
  return term.kind === "con" && (term.args ?? []).some((arg) => deeperThan(arg, max - 1));
}

/** `${prefix}${i}` with 0 <= i < n, no leading zeros. */
function isVariadicPort(name: string, prefix: string, n: number): boolean {
  const rest = name.slice(prefix.length);
  return name.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(rest) && Number(rest) < n;
}

function inputPort(inst: Instance, name: string): Port | undefined {
  const m = inst.manifest;
  if (m.mode === "exec" && (m.exec?.in ?? ["exec"]).includes(name)) return EXEC;
  if (m.inputs && Object.hasOwn(m.inputs, name)) return { kind: "data", def: m.inputs[name]! };
  const v = m.variadic;
  if (v?.kind === "input" && v.type && isVariadicPort(name, v.prefix, inst.variadic)) {
    return { kind: "data", def: { type: v.type } };
  }
  return undefined;
}

function outputPort(inst: Instance, name: string): Port | undefined {
  const m = inst.manifest;
  if (m.exec?.out.includes(name)) return EXEC;
  if (m.outputs && Object.hasOwn(m.outputs, name)) return { kind: "data", def: m.outputs[name]! };
  const v = m.variadic;
  if (v?.kind === "execOut" && isVariadicPort(name, v.prefix, inst.variadic)) return EXEC;
  return undefined;
}

/** Every data input, variadic ones included, with whether it needs a value. */
function dataInputs(inst: Instance): [string, DataPortDef, boolean][] {
  const m = inst.manifest;
  const ports: [string, DataPortDef, boolean][] = Object.entries(m.inputs ?? {}).map(([name, def]) => [
    name,
    def,
    def.required === true,
  ]);
  const v = m.variadic;
  if (v?.kind === "input" && v.type) {
    // Variadic inputs have no default, so each one needs an edge or a literal.
    for (let i = 0; i < inst.variadic; i++) ports.push([`${v.prefix}${i}`, { type: v.type }, true]);
  }
  return ports;
}

function firstBadKey(types: TypeTable, term: TypeTerm): TypeTerm | undefined {
  if (term.kind === "var") return undefined;
  const key = term.args?.[0];
  if (term.id === "Dictionary" && key && isGround(key) && !types.isKey(key)) return key;
  for (const arg of term.args ?? []) {
    const bad = firstBadKey(types, arg);
    if (bad) return bad;
  }
  return undefined;
}

/** Edges that close a cycle, found by an iterative DFS (graphs are untrusted, so no recursion). */
function backEdges<T extends { from: Instance; to: Instance; edge: EdgeInstance }>(
  nodes: Iterable<Instance>,
  edges: readonly T[],
): T[] {
  const next = new Map<Instance, T[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e]);
  const state = new Map<Instance, "open" | "done">();
  const found: T[] = [];
  for (const root of nodes) {
    if (state.has(root)) continue;
    state.set(root, "open");
    const stack: { node: Instance; i: number }[] = [{ node: root, i: 0 }];
    while (stack.length) {
      const top = stack.at(-1)!;
      const e = next.get(top.node)?.[top.i++];
      if (!e) {
        state.set(top.node, "done");
        stack.pop();
      } else if (state.get(e.to) === "open") {
        found.push(e);
      } else if (!state.has(e.to)) {
        state.set(e.to, "open");
        stack.push({ node: e.to, i: 0 });
      }
    }
  }
  return found;
}

/**
 * Checks a document against a language manifest without running anything (§3.4, §6.1).
 * Needs only the manifest, so editors can validate any language. Throws only if the manifest itself is invalid.
 */
export function validate(doc: DocumentV1, manifest: LanguageManifest): Analysis {
  const lang = checkManifest(manifest);
  const types = lang.types;
  const diagnostics: Diagnostic[] = [];
  const report = (code: DiagnosticCode, message: string, at?: DiagnosticLocation): void => {
    diagnostics.push(at ? { code, severity: "error", message, at } : { code, severity: "error", message });
  };
  const instances = new Map<string, Instance>();
  const convertedEdges = new Set<string>();
  const capabilities = new Set<string>();
  const analysis: Analysis = {
    diagnostics,
    typeOf(node, port, dir) {
      const inst = instances.get(node);
      if (!inst) return undefined;
      const p = dir === "in" ? inputPort(inst, port) : outputPort(inst, port);
      return p?.kind === "data" ? resolve(p.def.type, inst) : undefined;
    },
    convertedEdges,
    capabilities,
  };

  if (doc.format !== 1) {
    report("E_NEWER_FORMAT", `Document format ${String(doc.format)} is not supported (expected 1)`);
    return analysis;
  }
  if (doc.language.id !== manifest.language.id) {
    report("E_LANGUAGE_MISMATCH", `Document is for '${doc.language.id}', not '${manifest.language.id}'`);
    return analysis;
  }
  if (doc.language.version > manifest.language.version) {
    report(
      "E_NEWER_LANGUAGE",
      `Document needs ${doc.language.id} v${doc.language.version}; this is v${manifest.language.version}`,
    );
    return analysis;
  }

  // Ids are unique across the whole document; remember which graph owns each node.
  // ponytail: function bodies are only scanned for ids here; validating them is M3.
  const graphs = [
    { id: "main", graph: doc.program.graph },
    ...doc.program.functions.map((f) => ({ id: f.id, graph: f.graph })),
  ];
  const graphOf = new Map<string, string>();
  const edgeIds = new Set<string>();
  const dupEdges = new Set<EdgeInstance>();
  for (const { id, graph } of graphs) {
    for (const node of graph.nodes) {
      if (graphOf.has(node.id)) report("E_DUPLICATE_ID", `Duplicate node id '${node.id}'`, { node: node.id });
      else graphOf.set(node.id, id);
    }
    for (const edge of graph.edges) {
      if (!edgeIds.has(edge.id)) edgeIds.add(edge.id);
      else {
        dupEdges.add(edge);
        report("E_DUPLICATE_ID", `Duplicate edge id '${edge.id}'`, { edge: edge.id });
      }
    }
  }

  // Instances. A node whose shape can't be trusted (unknown type, other version, bad variadic count) is reported
  // once and then left out, so its edges don't pile up follow-on errors.
  for (const node of doc.program.graph.nodes) {
    if (graphOf.get(node.id) !== "main" || instances.has(node.id)) continue;
    const at = { node: node.id };
    const m = lang.nodes.get(node.type);
    if (!m) {
      report("E_UNKNOWN_NODE_TYPE", `Unknown node type '${node.type}'`, at);
      continue;
    }
    if (node.version > m.version) {
      report("E_NEWER_NODE", `${node.type} v${node.version} is newer than v${m.version}`, at);
      continue;
    }
    if (node.version < m.version) {
      report("E_NODE_OUTDATED", `${node.type} v${node.version} needs migrating to v${m.version}`, at);
      continue;
    }
    const v = m.variadic;
    const n = node.variadic ?? v?.min ?? 0;
    if (!v && node.variadic !== undefined) {
      report("E_VARIADIC_COUNT", `${node.type} has no variadic ports`, at);
      continue;
    }
    if (v && (!Number.isInteger(n) || n < (v.min ?? 0) || n > Math.min(v.max ?? Infinity, MAX_VARIADIC))) {
      report("E_VARIADIC_COUNT", `Variadic count ${n} is out of range for ${node.type}`, at);
      continue;
    }

    const vars = new Map<string, TypeVar>();
    for (const p of m.typeParams ?? []) vars.set(p.name, p.bound ? { name: p.name, bound: p.bound } : { name: p.name });
    for (const [name, term] of Object.entries(node.typeArgs ?? {})) {
      const tv = vars.get(name);
      if (!tv) {
        report("E_INVALID_TYPE", `${node.type} has no type parameter '${name}'`, at);
        continue;
      }
      const problem = deeperThan(term, MAX_TYPE_DEPTH)
        ? `Type argument ${name} is nested deeper than ${MAX_TYPE_DEPTH}`
        : (types.check(term) ?? (isGround(term) ? undefined : `Type argument ${name} must be concrete`));
      if (problem) report("E_INVALID_TYPE", problem, at);
      else if (tv.bound && !types.isSubtype(term, tv.bound)) {
        report("E_TYPE_MISMATCH", `${name} = ${formatType(term)} is not a ${formatType(tv.bound)}`, at);
      } else tv.pin = term;
    }
    instances.set(node.id, { node, manifest: m, variadic: n, vars });
  }

  // Edges (§6.1).
  const execEdges: ExecEdge[] = [];
  const dataEdges: DataEdge[] = [];
  const usedExecOut = new Map<Instance, Set<string>>();
  const usedDataIn = new Map<Instance, Set<string>>();
  /** Records the port as used; false if it already was. */
  const claim = (used: Map<Instance, Set<string>>, inst: Instance, port: string): boolean => {
    const ports = used.get(inst) ?? new Set<string>();
    used.set(inst, ports);
    if (ports.has(port)) return false;
    ports.add(port);
    return true;
  };
  for (const edge of doc.program.graph.edges) {
    if (dupEdges.has(edge)) continue;
    const at = { edge: edge.id };
    let ends = true;
    for (const ref of [edge.from, edge.to]) {
      const owner = graphOf.get(ref.node);
      if (owner === undefined) report("E_UNKNOWN_REF", `Edge ${edge.id} points at missing node '${ref.node}'`, at);
      else if (owner !== "main") report("E_CROSS_GRAPH", `Edge ${edge.id} leaves the main graph`, at);
      ends &&= owner === "main";
    }
    const from = instances.get(edge.from.node);
    const to = instances.get(edge.to.node);
    if (!ends || !from || !to) continue;
    const out = outputPort(from, edge.from.port);
    const inp = inputPort(to, edge.to.port);
    if (!out) report("E_UNKNOWN_PORT", `${edge.from.node} has no output '${edge.from.port}'`, { ...at, ...edge.from });
    if (!inp) report("E_UNKNOWN_PORT", `${edge.to.node} has no input '${edge.to.port}'`, { ...at, ...edge.to });
    if (!out || !inp) continue;
    if (out.kind !== inp.kind) {
      report("E_KIND_MISMATCH", `Edge ${edge.id} connects ${out.kind} to ${inp.kind}`, at);
    } else if (out.kind === "exec") {
      if (!claim(usedExecOut, from, edge.from.port)) {
        report("E_EXEC_FANOUT", `${edge.from.node}.${edge.from.port} already has an edge`, at);
      } else execEdges.push({ edge, from, to });
    } else if (inp.kind === "data") {
      if (inp.def.wire === false) {
        report("E_KIND_MISMATCH", `${edge.to.node}.${edge.to.port} takes only a literal`, at);
      } else if (!claim(usedDataIn, to, edge.to.port)) {
        report("E_DATA_FANIN", `${edge.to.node}.${edge.to.port} already has an edge`, at);
      } else dataEdges.push({ edge, from, out: out.def, to, in: inp.def });
    }
  }

  for (const e of backEdges(instances.values(), execEdges)) {
    report("E_EXEC_CYCLE", `Exec edge ${e.edge.id} closes a cycle`, { edge: e.edge.id });
  }
  const evaluated = (inst: Instance): boolean => inst.manifest.mode === "pure" || inst.manifest.mode === "once";
  const pureEdges = dataEdges.filter((e) => evaluated(e.from) && evaluated(e.to));
  for (const e of backEdges(instances.values(), pureEdges)) {
    report("E_DATA_CYCLE", `Data edge ${e.edge.id} closes a cycle through pure nodes`, { edge: e.edge.id });
  }

  // Inference and checks (§3.4).
  const constraints: Constraint[] = dataEdges.map((e) => ({ sub: e.out.type, subOf: e.from, sup: e.in.type, supOf: e.to }));
  diagnostics.push(...solve(types, [...instances.values()], constraints));

  for (const { edge, from, out, to, in: inp } of dataEdges) {
    const a = resolve(out.type, from);
    const b = resolve(inp.type, to);
    if (!isGround(a) || !isGround(b) || types.isSubtype(a, b)) continue;
    if (lang.conversions.has(conversionKey(a, b))) convertedEdges.add(edge.id);
    else report("E_TYPE_MISMATCH", `${edge.id}: ${formatType(a)} → ${formatType(b)}`, { edge: edge.id });
  }

  for (const inst of instances.values()) {
    const at = { node: inst.node.id };
    for (const v of inst.vars.values()) {
      if (v.bound && v.solution && !types.isSubtype(v.solution, v.bound)) {
        report("E_TYPE_MISMATCH", `${v.name} = ${formatType(v.solution)} is not a ${formatType(v.bound)}`, at);
      }
    }
    const ports = [...dataInputs(inst), ...Object.entries(inst.manifest.outputs ?? {})];
    for (const [port, def] of ports) {
      const key = firstBadKey(types, resolve(def.type, inst));
      if (key) report("E_KEY_TYPE", `${formatType(key)} can't be a Dictionary key`, { ...at, port });
    }

    // Literals, defaults and required inputs (§3.4 step 6, §8.4 order: edge, literal, default).
    const literals = inst.node.literals ?? {};
    for (const port of Object.keys(literals)) {
      if (inputPort(inst, port)?.kind !== "data") {
        report("E_UNKNOWN_PORT", `${inst.node.type} has no data input '${port}' for a literal`, { ...at, port });
      }
    }
    const connected = usedDataIn.get(inst);
    for (const [port, def, required] of dataInputs(inst)) {
      if (connected?.has(port)) continue;
      const here = { ...at, port };
      const type = resolve(def.type, inst);
      const check = (value: Json, what: string): void => {
        if (!isGround(type)) {
          report("E_UNRESOLVED_TYPE", `${inst.node.id}.${port}: type ${formatType(type)} is unresolved`, here);
          return;
        }
        const schema = types.schemaFor(type);
        const problem = schema ? validateValue(schema, value) : `${formatType(type)} takes no literals`;
        if (problem) report("E_LITERAL_INVALID", `${inst.node.id}.${port} ${what}: ${problem}`, here);
      };
      if (Object.hasOwn(literals, port)) check(literals[port]!, "literal");
      // Ground defaults were checked with the manifest; generic ones only once T is known.
      else if (def.default !== undefined) {
        if (!isGround(def.type) && isGround(type)) check(def.default, "default");
      } else if (required) report("E_REQUIRED_INPUT", `${inst.node.id}.${port} needs a value`, here);
    }
  }

  // Capabilities: forward along exec edges from event nodes, backward along data edges to the nodes they read.
  const next = new Map<Instance, Instance[]>();
  for (const e of execEdges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  for (const e of dataEdges) next.set(e.to, [...(next.get(e.to) ?? []), e.from]);
  const stack = [...instances.values()].filter((inst) => inst.manifest.mode === "event");
  const reached = new Set(stack);
  while (stack.length) {
    for (const n of next.get(stack.pop()!) ?? []) {
      if (reached.has(n)) continue;
      reached.add(n);
      stack.push(n);
    }
  }
  for (const inst of reached) for (const id of inst.manifest.requires ?? []) capabilities.add(id);

  return analysis;
}
