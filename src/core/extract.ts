// "Make block from selection" (M9): moves nodes into a new function and leaves a call in their place.
import type {
  DocumentV1,
  EdgeInstance,
  FunctionDecl,
  Graph,
  NodeInstance,
  PortRef,
} from "./document";
import type { DataPortDef, LanguageManifest } from "./manifest";
import { isGround, tvar, type TypeTerm } from "./types";
import { validate } from "./validate";

/**
 * `${prefix}${max + 1}` over every id `${prefix}<integer>` in the document: nodes and edges of every graph,
 * functions, variables (locals too), groups and comments.
 */
export function nextId(doc: DocumentV1, prefix: string): string {
  const { program, view } = doc;
  const items = [
    ...[program.graph, ...program.functions.map((f) => f.graph)].flatMap((g) => [
      ...g.nodes,
      ...g.edges,
    ]),
    ...program.functions,
    ...program.variables,
    ...program.functions.flatMap((f) => f.locals ?? []),
    ...view.groups,
    ...(view.comments ?? []),
  ];
  let max = 0;
  for (const { id } of items) {
    const rest = id.slice(prefix.length);
    if (id.startsWith(prefix) && /^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

export type ExtractResult = { doc: DocumentV1; function: string; call: string } | { error: string };

/** The home function's rigid parameters become the new function's own, so its signature names them plainly. */
function plain(term: TypeTerm): TypeTerm {
  if (term.kind === "var") return tvar(term.name);
  return term.args?.length
    ? { kind: "con", id: term.id, args: term.args.map(plain) }
    : { kind: "con", id: term.id };
}

/** `base`, else `base2`, `base3`, … whichever is free; claims it. */
function unique(taken: Set<string>, base: string): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

const key = (p: PortRef): string => JSON.stringify([p.node, p.port]);

/**
 * Moves `nodes` (all in one graph) into a new function called `name` and puts a call to it where they were:
 * crossing data wires become inputs and outputs, crossing exec wires the entry and the exits. Never mutates
 * `doc`; returns a changed copy, or why the selection can't become a block.
 */
export function extractFunction(
  doc: DocumentV1,
  manifest: LanguageManifest,
  nodes: readonly string[],
  name: string,
): ExtractResult {
  const analysis = validate(doc, manifest);
  const out = structuredClone(doc);
  const sel = new Set(nodes);
  if (!sel.size) return { error: "Select at least one node." };
  const homes = [
    { graph: out.program.graph, fn: undefined },
    ...out.program.functions.map((f) => ({ graph: f.graph, fn: f })),
  ].filter((h) => h.graph.nodes.some((n) => sel.has(n.id)));
  if (homes.length > 1) return { error: "The selected nodes must all be in the same graph." };
  const home: { graph: Graph; fn: FunctionDecl | undefined } | undefined = homes[0];
  const moved = home?.graph.nodes.filter((n) => sel.has(n.id)) ?? [];
  if (!home || moved.length < sel.size) return { error: "A selected node doesn't exist." };

  for (const n of moved) {
    if (n.type === "core.entry" || n.type === "core.return")
      return { error: "A function's entry and return can't move into a block." };
    const mode = analysis.ports(n.id)?.manifest.mode;
    if (!mode) return { error: `Node ${n.id} has errors; fix them first.` };
    if (mode === "event") return { error: "Event nodes can't move into a block." };
    const local = home.fn?.locals?.find((v) => v.id === n.ref);
    if ((n.type === "core.get" || n.type === "core.set") && local)
      return { error: `Local variable '${local.name}' can't leave its function.` };
  }
  // Every moved node has ports: a node without them was refused above.
  const ports = (id: string): { execIn: string[]; execOut: string[] } => analysis.ports(id)!;
  const exec = moved.some((n) => analysis.ports(n.id)!.manifest.mode === "exec");

  const G = home.graph;
  const inner: EdgeInstance[] = [];
  const into: EdgeInstance[] = [];
  const outOf: EdgeInstance[] = [];
  const kept: EdgeInstance[] = [];
  for (const e of G.edges) {
    const from = sel.has(e.from.node);
    const to = sel.has(e.to.node);
    (from && to ? inner : to ? into : from ? outOf : kept).push(e);
  }
  const execInto = into.filter((e) => ports(e.to.node).execIn.includes(e.to.port));
  const execOutOf = outOf.filter((e) => ports(e.from.node).execOut.includes(e.from.port));
  if (new Set(execInto.map((e) => key(e.to))).size > 1)
    return { error: "Exec wires enter the selection at more than one node." };

  const typeParams = home.fn?.typeParams ?? [];
  const inputs: Record<string, DataPortDef> = {};
  const outputs: Record<string, DataPortDef> = {};
  const body: Graph = { nodes: [], edges: inner };
  const decl: FunctionDecl = {
    id: nextId(out, "f"),
    name,
    ...(typeParams.length ? { typeParams } : {}),
    exec,
    inputs,
    outputs,
    graph: body,
  };
  out.program.functions.push(decl);

  const spots = moved.flatMap((n) => out.view.positions[n.id] ?? []);
  const [left, top, right] = spots.length
    ? [
        Math.min(...spots.map((p) => p.x)),
        Math.min(...spots.map((p) => p.y)),
        Math.max(...spots.map((p) => p.x)),
      ]
    : [0, 0, 0];
  // Ids are counted from before the move: while nodes and wires are in transit, `nextId` wouldn't see them.
  let nodeNo = Number(nextId(out, "n").slice(1));
  let edgeNo = Number(nextId(out, "e").slice(1));
  const newNode = (): string => `n${nodeNo++}`;
  const call: NodeInstance = {
    id: newNode(),
    type: "core.call",
    version: 1,
    ref: decl.id,
    ...(typeParams.length
      ? { typeArgs: Object.fromEntries(typeParams.map((p) => [p.name, tvar(p.name)])) }
      : {}),
  };
  const first = G.nodes.indexOf(moved[0]!);
  G.nodes = G.nodes.filter((n) => !sel.has(n.id));
  G.nodes.splice(first, 0, call);
  G.edges = kept;
  out.view.positions[call.id] = { x: left, y: top };
  const entry: NodeInstance = { id: newNode(), type: "core.entry", version: 1 };
  body.nodes.push(entry, ...moved);
  out.view.positions[entry.id] = { x: left - 260, y: top };
  const wire = (graph: Graph, from: PortRef, to: PortRef): void => {
    graph.edges.push({ id: `e${edgeNo++}`, from, to });
  };

  // Port names are per direction and shared by exec and data ports, so an exec function keeps its own free.
  const inNames = new Set(exec ? ["exec", "then"] : []);
  const outNames = new Set(exec ? ["exec"] : []);
  const params = new Map<string, string>();
  const results = new Map<string, string>();
  const returned: [PortRef, string][] = [];
  for (const e of [...into, ...outOf]) {
    if (execInto.includes(e) || execOutOf.includes(e)) continue;
    const type = [
      analysis.typeOf(e.from.node, e.from.port, "out"),
      analysis.typeOf(e.to.node, e.to.port, "in"),
    ].find((x) => x !== undefined && isGround(x));
    if (!type) return { error: `Wire ${e.id} crosses the selection with an unresolved type.` };
    if (sel.has(e.to.node)) {
      let port = params.get(key(e.from));
      if (port === undefined) {
        port = unique(inNames, e.to.port);
        params.set(key(e.from), port);
        inputs[port] = { type: plain(type) };
        wire(G, e.from, { node: call.id, port });
      }
      wire(body, { node: entry.id, port }, e.to);
    } else {
      let port = results.get(key(e.from));
      if (port === undefined) {
        port = unique(outNames, e.from.port);
        results.set(key(e.from), port);
        outputs[port] = { type: plain(type) };
        returned.push([e.from, port]);
      }
      wire(G, { node: call.id, port }, e.to);
    }
  }

  // Entered where the exec wires entered, else at the one exec node nothing inside leads to.
  const heads = moved.flatMap((n) => {
    const { execIn } = ports(n.id);
    const led = inner.some((e) => e.to.node === n.id && execIn.includes(e.to.port));
    return execIn.length && !led ? [{ node: n.id, port: execIn[0]! }] : [];
  });
  const start = execInto[0]?.to ?? (heads.length === 1 ? heads[0] : undefined);
  if (start) wire(body, { node: entry.id, port: "then" }, start);
  for (const e of execInto) {
    e.to = { node: call.id, port: "exec" };
    G.edges.push(e);
  }

  // One exit per inside exec output wired out; with none, one `then`, from the one dangling exec output if any.
  const exits = new Map<string, { exit: string; from?: PortRef }>();
  const many = new Set(execOutOf.map((e) => key(e.from))).size > 1;
  for (const e of execOutOf) {
    const exit = exits.get(key(e.from))?.exit ?? unique(outNames, many ? e.from.port : "then");
    exits.set(key(e.from), { exit, from: e.from });
    e.from = { node: call.id, port: exit };
    G.edges.push(e);
  }
  if (exec && !exits.size) {
    const dangling = moved.flatMap((n) =>
      ports(n.id)
        .execOut.filter((port) => !inner.some((e) => e.from.node === n.id && e.from.port === port))
        .map((port) => ({ node: n.id, port })),
    );
    exits.set("", {
      exit: unique(outNames, "then"),
      ...(dangling.length === 1 && { from: dangling[0]! }),
    });
  }
  if (exec) decl.exits = [...exits.values()].map((x) => x.exit);
  // A pure function has one return and no exits.
  const rets: { exit?: string; from?: PortRef }[] = exec ? [...exits.values()] : [{}];
  for (const [i, { exit, from }] of rets.entries()) {
    const ret: NodeInstance = {
      id: newNode(),
      type: "core.return",
      version: 1,
      ...(exit !== undefined && { ref: exit }),
    };
    body.nodes.push(ret);
    out.view.positions[ret.id] = { x: right + 260, y: top + i * 160 };
    if (from) wire(body, from, { node: ret.id, port: "exec" });
    for (const [source, port] of returned) wire(body, source, { node: ret.id, port });
  }
  return { doc: out, function: decl.id, call: call.id };
}
