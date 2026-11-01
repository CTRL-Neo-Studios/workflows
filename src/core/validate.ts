import type { Diagnostic, DiagnosticCode, DiagnosticLocation } from "./diagnostics";
import type { DocumentV1, EdgeInstance, Graph } from "./document";
import { type Constraint, type Instance, resolve, solve, type TypeVar } from "./infer";
import {
  checkManifest,
  conversionKey,
  type DataPortDef,
  type LanguageManifest,
  type NodeManifest,
} from "./manifest";
import {
  coreManifest,
  declarations,
  type Declarations,
  docTerm,
  type FunctionInfo,
} from "./program";
import { type Json, validateValue } from "./schema";
import { formatType, isGround, type TypeTable, type TypeTerm } from "./types";

export interface Analysis {
  diagnostics: Diagnostic[];
  /** Resolved type of a data port; unsolved variables stay as `var` terms. `undefined` for exec or unknown ports. */
  typeOf(node: string, port: string, dir: "in" | "out"): TypeTerm | undefined;
  /**
   * The node's ports, variadic ones expanded; a core.* node's come from the document. `undefined` for a node
   * that was left out (unknown type, wrong version, bad variadic count or ref); it has a diagnostic.
   */
  ports(node: string): NodePorts | undefined;
  /** Edges whose value goes through a `ConversionDef`. */
  convertedEdges: ReadonlySet<string>;
  /** Capabilities of every node reachable from an event node, including through called functions (§7). */
  capabilities: ReadonlySet<string>;
}

export interface NodePorts {
  /** For core.* nodes, built from the document. */
  manifest: NodeManifest;
  execIn: string[];
  execOut: string[];
  /** Port types are unresolved; `typeOf` gives the inferred ones. Variadic inputs are `required`. */
  inputs: [name: string, def: DataPortDef][];
  outputs: [name: string, def: DataPortDef][];
}

// ponytail: fixed cap on document-chosen variadic counts; make it a manifest/limit option if a language needs more.
const MAX_VARIADIC = 1024;

type Port = { kind: "exec" } | { kind: "data"; def: DataPortDef };
const EXEC: Port = { kind: "exec" };

export interface DataEdge {
  edge: EdgeInstance;
  from: Instance;
  out: DataPortDef;
  to: Instance;
  in: DataPortDef;
}

export interface ExecEdge {
  edge: EdgeInstance;
  from: Instance;
  to: Instance;
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
export function dataInputs(inst: Instance): [string, DataPortDef, boolean][] {
  const m = inst.manifest;
  const ports: [string, DataPortDef, boolean][] = Object.entries(m.inputs ?? {}).map(
    ([name, def]) => [name, def, def.required === true],
  );
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

/** Records the port as used; false if it already was. */
function claim(used: Map<Instance, Set<string>>, inst: Instance, port: string): boolean {
  const ports = used.get(inst) ?? new Set<string>();
  used.set(inst, ports);
  if (ports.has(port)) return false;
  ports.add(port);
  return true;
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

/** A function body's entry and return instances, when present. */
export interface Body {
  entry?: Instance;
  ret?: Instance;
}

/** What `compile` needs beyond the public `Analysis`. */
export interface Analyzed {
  analysis: Analysis;
  instances: ReadonlyMap<string, Instance>;
  execEdges: readonly ExecEdge[];
  dataEdges: readonly DataEdge[];
  decls: Declarations;
  bodies: ReadonlyMap<string, Body>;
  /** core.call → its callee's entry and return, so reachability follows calls. */
  calls: ReadonlyMap<Instance, Instance[]>;
}

/** Capabilities of the nodes reachable from `starts`: forward along exec edges and calls, backward along data edges. */
export function reachableCapabilities(starts: Iterable<Instance>, analyzed: Analyzed): Set<string> {
  const next = new Map<Instance, Instance[]>(analyzed.calls);
  for (const e of analyzed.execEdges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  for (const e of analyzed.dataEdges) next.set(e.to, [...(next.get(e.to) ?? []), e.from]);
  const stack = [...starts];
  const reached = new Set(stack);
  while (stack.length) {
    for (const n of next.get(stack.pop()!) ?? []) {
      if (reached.has(n)) continue;
      reached.add(n);
      stack.push(n);
    }
  }
  const capabilities = new Set<string>();
  for (const inst of reached) for (const id of inst.manifest.requires ?? []) capabilities.add(id);
  return capabilities;
}

/** Event nodes that start a run; a function's entry looks like one but only a call starts it. */
export function isEvent(inst: Instance): boolean {
  return inst.manifest.mode === "event" && inst.node.type !== "core.entry";
}

/**
 * Checks a document against a language manifest without running anything (§3.4, §6.1).
 * Needs only the manifest, so editors can validate any language. Throws only if the manifest itself is invalid.
 */
export function validate(doc: DocumentV1, manifest: LanguageManifest): Analysis {
  return analyze(doc, manifest).analysis;
}

export function analyze(doc: DocumentV1, manifest: LanguageManifest): Analyzed {
  const lang = checkManifest(manifest);
  const types = lang.types;
  const diagnostics: Diagnostic[] = [];
  const report = (code: DiagnosticCode, message: string, at?: DiagnosticLocation): void => {
    diagnostics.push(
      at ? { code, severity: "error", message, at } : { code, severity: "error", message },
    );
  };
  const instances = new Map<string, Instance>();
  const execEdges: ExecEdge[] = [];
  const dataEdges: DataEdge[] = [];
  const convertedEdges = new Set<string>();
  const capabilities = new Set<string>();
  const bodies = new Map<string, Body>();
  const calls = new Map<Instance, Instance[]>();
  const analysis: Analysis = {
    diagnostics,
    typeOf(node, port, dir) {
      const inst = instances.get(node);
      if (!inst) return undefined;
      const p = dir === "in" ? inputPort(inst, port) : outputPort(inst, port);
      return p?.kind === "data" ? resolve(p.def.type, inst) : undefined;
    },
    ports(node) {
      const inst = instances.get(node);
      if (!inst) return undefined;
      const m = inst.manifest;
      const v = m.variadic;
      const execOut = [...(m.exec?.out ?? [])];
      if (v?.kind === "execOut")
        for (let i = 0; i < inst.variadic; i++) execOut.push(`${v.prefix}${i}`);
      return {
        manifest: m,
        execIn: m.mode === "exec" ? (m.exec?.in ?? ["exec"]) : [],
        execOut,
        inputs: dataInputs(inst).map(([name, def, required]) => [
          name,
          required && !def.required ? { ...def, required } : def,
        ]),
        outputs: Object.entries(m.outputs ?? {}),
      };
    },
    convertedEdges,
    capabilities,
  };
  const empty: Declarations = { variables: new Map(), functions: new Map() };
  const analyzed: Analyzed = {
    analysis,
    instances,
    execEdges,
    dataEdges,
    decls: empty,
    bodies,
    calls,
  };

  if (doc.format !== 1) {
    report("E_NEWER_FORMAT", `Document format ${String(doc.format)} is not supported (expected 1)`);
    return analyzed;
  }
  if (doc.language.id !== manifest.language.id) {
    report(
      "E_LANGUAGE_MISMATCH",
      `Document is for '${doc.language.id}', not '${manifest.language.id}'`,
    );
    return analyzed;
  }
  if (doc.language.version > manifest.language.version) {
    report(
      "E_NEWER_LANGUAGE",
      `Document needs ${doc.language.id} v${doc.language.version}; this is v${manifest.language.version}`,
    );
    return analyzed;
  }

  const decls = declarations(doc, types, report);
  analyzed.decls = decls;

  // Node and edge ids are unique across the whole document; remember which graph owns each node.
  const graphs: { id: string; graph: Graph; fn: FunctionInfo | undefined }[] = [
    { id: "main", graph: doc.program.graph, fn: undefined },
    ...doc.program.functions.flatMap((f) => {
      const fn = decls.functions.get(f.id);
      // A function that failed its declaration checks was reported; its body isn't checked further.
      return fn?.decl === f ? [{ id: f.id, graph: f.graph, fn }] : [];
    }),
  ];
  const graphOf = new Map<string, string>();
  const edgeIds = new Set<string>();
  const dupEdges = new Set<EdgeInstance>();
  for (const { id, graph } of [
    { id: "main", graph: doc.program.graph },
    ...doc.program.functions.map((f) => ({ id: f.id, graph: f.graph })),
  ]) {
    for (const node of graph.nodes) {
      if (graphOf.has(node.id))
        report("E_DUPLICATE_ID", `Duplicate node id '${node.id}'`, { node: node.id });
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

  // Instances. A node whose shape can't be trusted (unknown type, other version, bad variadic count, bad ref) is
  // reported once and then left out, so its edges don't pile up follow-on errors.
  for (const {
    id: graph,
    graph: { nodes },
    fn,
  } of graphs) {
    for (const node of nodes) {
      if (graphOf.get(node.id) !== graph || instances.has(node.id)) continue;
      const at = { node: node.id };
      let m = lang.nodes.get(node.type);
      if (node.type.startsWith("core.")) {
        const core = coreManifest(node, fn, decls);
        if ("code" in core) {
          report(core.code, core.message, at);
          continue;
        }
        m = core;
      }
      if (!m) {
        report("E_UNKNOWN_NODE_TYPE", `Unknown node type '${node.type}'`, at);
        continue;
      }
      if (node.version > m.version) {
        report("E_NEWER_NODE", `${node.type} v${node.version} is newer than v${m.version}`, at);
        continue;
      }
      if (node.version < m.version) {
        report(
          "E_NODE_OUTDATED",
          `${node.type} v${node.version} needs migrating to v${m.version}`,
          at,
        );
        continue;
      }
      const v = m.variadic;
      const n = node.variadic ?? v?.min ?? 0;
      if (!v && node.variadic !== undefined) {
        report("E_VARIADIC_COUNT", `${node.type} has no variadic ports`, at);
        continue;
      }
      if (
        v &&
        (!Number.isInteger(n) || n < (v.min ?? 0) || n > Math.min(v.max ?? Infinity, MAX_VARIADIC))
      ) {
        report("E_VARIADIC_COUNT", `Variadic count ${n} is out of range for ${node.type}`, at);
        continue;
      }

      const vars = new Map<string, TypeVar>();
      for (const p of m.typeParams ?? [])
        vars.set(p.name, p.bound ? { name: p.name, bound: p.bound } : { name: p.name });
      for (const [name, term] of Object.entries(node.typeArgs ?? {})) {
        const tv = vars.get(name);
        if (!tv) {
          report("E_INVALID_TYPE", `${node.type} has no type parameter '${name}'`, at);
          continue;
        }
        // Inside a generic function, a pin may name the function's own (rigid) parameters.
        const pin = docTerm(term, types, fn?.rigid ?? new Map());
        if (typeof pin === "string") report("E_INVALID_TYPE", `Type argument ${name}: ${pin}`, at);
        else if (tv.bound && !types.isSubtype(pin, tv.bound)) {
          report(
            "E_TYPE_MISMATCH",
            `${name} = ${formatType(pin)} is not a ${formatType(tv.bound)}`,
            at,
          );
        } else tv.pin = pin;
      }
      const inst: Instance = { node, manifest: m, variadic: n, vars, graph };
      instances.set(node.id, inst);
      if (fn && node.type === "core.entry")
        bodies.set(graph, { ...bodies.get(graph), entry: inst });
      if (fn && node.type === "core.return") bodies.set(graph, { ...bodies.get(graph), ret: inst });
    }
  }

  // Function shape (§6): one entry and one return; no event nodes (only a call starts a body); a pure function's
  // body has no exec nodes.
  for (const { id, graph, fn } of graphs) {
    if (!fn) continue;
    const count = (type: string): number => graph.nodes.filter((n) => n.type === type).length;
    for (const type of ["core.entry", "core.return"]) {
      if (count(type) !== 1)
        report("E_FUNCTION_SHAPE", `Function '${id}' needs exactly one ${type}`, { function: id });
    }
    for (const node of graph.nodes) {
      const inst = instances.get(node.id);
      const at = { function: id, node: node.id };
      if (inst && isEvent(inst)) {
        report(
          "E_FUNCTION_SHAPE",
          `Event node ${node.id} belongs in the main graph, not in function '${id}'`,
          at,
        );
      } else if (
        !fn.decl.exec &&
        (inst?.manifest.mode === "exec" || inst?.manifest.mode === "event")
      ) {
        report("E_FUNCTION_SHAPE", `Pure function '${id}' can't contain exec node ${node.id}`, at);
      }
    }
  }
  for (const inst of instances.values()) {
    if (inst.node.type !== "core.call") continue;
    const body = bodies.get(inst.node.ref ?? "");
    calls.set(
      inst,
      [body?.entry, body?.ret].filter((x) => x !== undefined),
    );
  }

  // Edges (§6.1), each inside its own graph.
  const usedExecOut = new Map<Instance, Set<string>>();
  const usedDataIn = new Map<Instance, Set<string>>();
  for (const {
    id: graph,
    graph: { edges },
  } of graphs) {
    for (const edge of edges) {
      if (dupEdges.has(edge)) continue;
      const at = { edge: edge.id };
      let ends = true;
      for (const ref of [edge.from, edge.to]) {
        const owner = graphOf.get(ref.node);
        if (owner === undefined)
          report("E_UNKNOWN_REF", `Edge ${edge.id} points at missing node '${ref.node}'`, at);
        else if (owner !== graph) report("E_CROSS_GRAPH", `Edge ${edge.id} leaves its graph`, at);
        ends &&= owner === graph;
      }
      const from = instances.get(edge.from.node);
      const to = instances.get(edge.to.node);
      if (!ends || !from || !to) {
        // The source was already reported; still count the target as wired so it gets no follow-on errors.
        if (ends && to) claim(usedDataIn, to, edge.to.port);
        continue;
      }
      const out = outputPort(from, edge.from.port);
      const inp = inputPort(to, edge.to.port);
      if (!out)
        report("E_UNKNOWN_PORT", `${edge.from.node} has no output '${edge.from.port}'`, {
          ...at,
          ...edge.from,
        });
      if (!inp)
        report("E_UNKNOWN_PORT", `${edge.to.node} has no input '${edge.to.port}'`, {
          ...at,
          ...edge.to,
        });
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
  }

  for (const e of backEdges(instances.values(), execEdges)) {
    report("E_EXEC_CYCLE", `Exec edge ${e.edge.id} closes a cycle`, { edge: e.edge.id });
  }
  const pureEdges = dataEdges.filter((e) =>
    [e.from, e.to].every((i) => i.manifest.mode === "pure" || i.manifest.mode === "once"),
  );
  for (const e of backEdges(instances.values(), pureEdges)) {
    report("E_DATA_CYCLE", `Data edge ${e.edge.id} closes a cycle through pure nodes`, {
      edge: e.edge.id,
    });
  }

  // Inference and checks (§3.4). Edges never cross graphs, so one solve covers every body independently.
  const constraints: Constraint[] = dataEdges.map((e) => ({
    sub: e.out.type,
    subOf: e.from,
    sup: e.in.type,
    supOf: e.to,
  }));
  diagnostics.push(...solve(types, [...instances.values()], constraints));

  for (const { edge, from, out, to, in: inp } of dataEdges) {
    const a = resolve(out.type, from);
    const b = resolve(inp.type, to);
    if (!isGround(a) || !isGround(b) || types.isSubtype(a, b)) continue;
    if (lang.conversions.has(conversionKey(a, b))) convertedEdges.add(edge.id);
    else
      report("E_TYPE_MISMATCH", `${edge.id}: ${formatType(a)} → ${formatType(b)}`, {
        edge: edge.id,
      });
  }

  for (const inst of instances.values()) {
    const at = { node: inst.node.id };
    for (const v of inst.vars.values()) {
      if (v.bound && v.solution && !types.isSubtype(v.solution, v.bound)) {
        report(
          "E_TYPE_MISMATCH",
          `${v.name} = ${formatType(v.solution)} is not a ${formatType(v.bound)}`,
          at,
        );
      }
    }
    const ports = [...dataInputs(inst), ...Object.entries(inst.manifest.outputs ?? {})];
    for (const [port, def] of ports) {
      const key = firstBadKey(types, resolve(def.type, inst));
      if (key)
        report("E_KEY_TYPE", `${formatType(key)} can't be a Dictionary key`, { ...at, port });
    }

    // Literals, defaults and required inputs (§3.4 step 6, §8.4 order: edge, literal, default).
    const literals = inst.node.literals ?? {};
    for (const port of Object.keys(literals)) {
      if (inputPort(inst, port)?.kind !== "data") {
        report("E_UNKNOWN_PORT", `${inst.node.type} has no data input '${port}' for a literal`, {
          ...at,
          port,
        });
      }
    }
    const connected = usedDataIn.get(inst);
    for (const [port, def, required] of dataInputs(inst)) {
      if (connected?.has(port)) continue;
      const here = { ...at, port };
      const type = resolve(def.type, inst);
      const check = (value: Json, what: string): void => {
        if (!isGround(type)) {
          report(
            "E_UNRESOLVED_TYPE",
            `${inst.node.id}.${port}: type ${formatType(type)} is unresolved`,
            here,
          );
          return;
        }
        const schema = types.schemaFor(type);
        const problem = schema
          ? validateValue(schema, value)
          : `${formatType(type)} takes no literals`;
        if (problem)
          report("E_LITERAL_INVALID", `${inst.node.id}.${port} ${what}: ${problem}`, here);
      };
      if (Object.hasOwn(literals, port)) check(literals[port]!, "literal");
      // Ground defaults were checked with the manifest or function declaration; generic ones only once T is known.
      else if (def.default !== undefined) {
        if (!isGround(def.type) && isGround(type)) check(def.default, "default");
      } else if (required)
        report("E_REQUIRED_INPUT", `${inst.node.id}.${port} needs a value`, here);
    }
  }

  const events = [...instances.values()].filter(isEvent);
  for (const id of reachableCapabilities(events, analyzed)) capabilities.add(id);
  return analyzed;
}
