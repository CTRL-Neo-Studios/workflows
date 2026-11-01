import {
  computed,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
  type ShallowRef,
} from "vue";
import {
  TypeTable,
  validate,
  type Analysis,
  type Diagnostic,
  type DocumentV1,
  type Fault,
  type Graph,
  type Json,
  type LanguageManifest,
  type NodeInstance,
  type NodePorts,
  type PortRef,
  type SchemaTemplate,
  type TraceEvent,
  type TypeTerm,
} from "../core";

export interface XY {
  x: number;
  y: number;
}

/** Fields a palette entry may preset on a new node. */
export type NodeInit = Partial<Pick<NodeInstance, "ref" | "literals" | "typeArgs" | "variadic">>;

export interface NodeTrace {
  /** Times the node was entered. */
  runs: number;
  fault?: Fault;
  /** Last value of each output port; needs `trace: 'values'`. */
  values: Map<string, unknown>;
}

export interface WorkflowEditor {
  readonly manifest: LanguageManifest;
  readonly types: TypeTable;
  /** The document being edited, deeply reactive. Edit it through the methods so ids and edges stay consistent. */
  readonly document: Ref<DocumentV1>;
  /** `'main'` or a function id: the graph the canvas shows and new nodes go into. */
  readonly graphId: Ref<string>;
  readonly graph: ComputedRef<Graph>;
  /** `validate` of the current document, rerun on every program change. */
  readonly analysis: ComputedRef<Analysis>;
  readonly problems: ComputedRef<{
    nodes: Map<string, Diagnostic[]>;
    edges: Map<string, Diagnostic[]>;
  }>;
  /** Trace of the last run, shown on the canvas. Cleared when the program changes. */
  readonly trace: ShallowRef<readonly TraceEvent[]>;
  readonly traced: ComputedRef<{ nodes: Map<string, NodeTrace>; edges: Set<string> }>;
  /** Where a node added without a position goes; the canvas keeps it at the center of the view. */
  readonly center: Ref<XY>;
  /** The latest request to bring a node into view; a new object each time, so asking twice still triggers. */
  readonly focused: Ref<{ node: string } | undefined>;
  ports(node: string): NodePorts | undefined;
  /** Adds a node to the current graph; returns its id. Core nodes are version 1, others the manifest's version. */
  addNode(type: string, at?: XY, init?: NodeInit): string;
  /** Also removes their edges and view data. */
  removeNodes(ids: Iterable<string>): void;
  moveNode(id: string, at: XY): void;
  /**
   * Why `from → to` can't be connected: the first error the edge would add, other than missing or unchecked
   * values. `undefined` = fine. Wiring a used data input or exec output replaces its edge, as `connect` does.
   */
  connectionProblem(from: PortRef, to: PortRef): Diagnostic | undefined;
  /** Adds the edge, replacing the one on the same data input or exec output; returns the new edge's id. */
  connect(from: PortRef, to: PortRef): string;
  removeEdges(ids: Iterable<string>): void;
  /** `undefined` removes the literal. */
  setLiteral(node: string, port: string, value: Json | undefined): void;
  /** `undefined` unpins the type parameter. */
  setTypeArg(node: string, name: string, term: TypeTerm | undefined): void;
  /** Also removes the edges and literals of variadic ports that go away. */
  setVariadic(node: string, count: number): void;
  /** Switches to the node's graph and asks the canvas to show it. */
  focus(node: string): void;
  /** A plain copy of the document, e.g. to save or run it. Documents are JSON, so it's a JSON round trip. */
  snapshot(): DocumentV1;
}

// A new edge may leave inputs unset or literals unchecked; that's normal mid-edit, not a reason to refuse it.
const VALUE_CODES = new Set(["E_REQUIRED_INPUT", "E_LITERAL_INVALID", "E_UNRESOLVED_TYPE"]);

const key = (d: Diagnostic): string => `${d.code} ${d.message}`;

function graphs(doc: DocumentV1): Graph[] {
  return [doc.program.graph, ...doc.program.functions.map((f) => f.graph)];
}

function graphOfNode(doc: DocumentV1, node: string): Graph | undefined {
  return graphs(doc).find((g) => g.nodes.some((n) => n.id === node));
}

/** `${prefix}${max + 1}` over every id with that prefix in the document, function bodies included. */
function nextId(doc: DocumentV1, prefix: "n" | "e"): string {
  let max = 0;
  for (const g of graphs(doc)) {
    for (const { id } of prefix === "n" ? g.nodes : g.edges) {
      const n = id.startsWith(prefix) ? Number(id.slice(1)) : NaN;
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

const same = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.port === b.port;

/** Adds `from → to` to `doc`, dropping the edge it replaces. */
function place(doc: DocumentV1, analysis: Analysis, from: PortRef, to: PortRef): string {
  const graph = graphOfNode(doc, from.node) ?? doc.program.graph;
  const dataIn = analysis.ports(to.node)?.inputs.some(([name]) => name === to.port) ?? false;
  const execOut = analysis.ports(from.node)?.execOut.includes(from.port) ?? false;
  graph.edges = graph.edges.filter(
    (e) => !(dataIn && same(e.to, to)) && !(execOut && same(e.from, from)),
  );
  const id = nextId(doc, "e");
  graph.edges.push({ id, from: { ...from }, to: { ...to } });
  return id;
}

/** What `WorkflowCanvas` provides to the nodes inside it. */
export interface CanvasContext {
  editor: WorkflowEditor;
  /** Why the connection being dragged can't be made. */
  hint: Ref<string | undefined>;
}

export const CANVAS: InjectionKey<CanvasContext> = Symbol("workflow-canvas");

/** VueFlow handle ids: exec and data ports may share a name, so the kind is part of the id. */
export const handleId = (kind: "exec" | "data", port: string): string => `${kind}:${port}`;
export const portOf = (handle: string | null | undefined): string =>
  handle?.replace(/^\w+:/, "") ?? "";

/** Drag-and-drop payload type from `WorkflowPalette` to `WorkflowCanvas`: JSON `{ type, init? }`. */
export const PALETTE_MIME = "application/x-workflow-node";

/** Props of `WorkflowCanvas`'s `#widget` slot: one unwired data input. */
export interface WidgetSlotProps {
  node: string;
  port: string;
  /** Resolved type; may still contain variables. */
  type: TypeTerm | undefined;
  /** The literal schema of the type; `undefined` when it takes no literals (opaque or unresolved). */
  schema: SchemaTemplate | undefined;
  value: Json | undefined;
  /** The port's default, for a placeholder. */
  fallback: Json | undefined;
  /** `undefined` removes the literal. */
  update: (value: Json | undefined) => void;
}

/** Props of `WorkflowCanvas`'s `#node` slot. */
export interface NodeSlotProps {
  id: string;
  selected: boolean;
}

export function useWorkflowEditor(manifest: LanguageManifest, initial: DocumentV1): WorkflowEditor {
  const types = new TypeTable(manifest.types);
  // Called through a plain signature: `ref`'s UnwrapRef<DocumentV1> recurses through Json until TS gives up.
  const document = (ref as (value: DocumentV1) => Ref<DocumentV1>)(initial);
  const graphId = ref("main");
  const graph = computed(() => {
    const doc = document.value;
    return doc.program.functions.find((f) => f.id === graphId.value)?.graph ?? doc.program.graph;
  });
  const analysis = computed(() => validate(document.value, manifest));
  const trace = shallowRef<readonly TraceEvent[]>([]);
  const center = ref<XY>({ x: 0, y: 0 });
  const focused = ref<{ node: string }>();

  watch(
    () => document.value.program,
    () => (trace.value = []),
    { deep: true },
  );

  const problems = computed(() => {
    const nodes = new Map<string, Diagnostic[]>();
    const edges = new Map<string, Diagnostic[]>();
    for (const d of analysis.value.diagnostics) {
      if (d.at?.node) nodes.set(d.at.node, [...(nodes.get(d.at.node) ?? []), d]);
      if (d.at?.edge) edges.set(d.at.edge, [...(edges.get(d.at.edge) ?? []), d]);
    }
    return { nodes, edges };
  });

  const traced = computed(() => {
    const nodes = new Map<string, NodeTrace>();
    const taken = new Set<string>();
    const at = (id: string): NodeTrace => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { runs: 0, values: new Map() }));
      return n;
    };
    const outOf = new Map<string, string[]>();
    for (const g of graphs(document.value)) {
      for (const e of g.edges) {
        const k = `${e.from.node}.${e.from.port}`;
        outOf.set(k, [...(outOf.get(k) ?? []), e.id]);
      }
    }
    for (const ev of trace.value) {
      if (ev.t === "enter") at(ev.node).runs++;
      else if (ev.t === "fault") at(ev.node).fault = ev.fault;
      else if (ev.t === "value") at(ev.node).values.set(ev.port, ev.value);
      const port = ev.t === "exit" || ev.t === "fire" || ev.t === "value" ? ev.port : undefined;
      if (port !== undefined) for (const id of outOf.get(`${ev.node}.${port}`) ?? []) taken.add(id);
    }
    return { nodes, edges: taken };
  });

  const snapshot = (): DocumentV1 => JSON.parse(JSON.stringify(document.value)) as DocumentV1;

  const findNode = (id: string): NodeInstance | undefined =>
    graphOfNode(document.value, id)?.nodes.find((n) => n.id === id);

  const setLiteral = (node: string, port: string, value: Json | undefined): void => {
    const n = findNode(node);
    if (!n) return;
    const literals = { ...n.literals };
    if (value === undefined) delete literals[port];
    else literals[port] = value;
    if (Object.keys(literals).length) n.literals = literals;
    else delete n.literals;
  };
  return {
    manifest,
    types,
    document,
    graphId,
    graph,
    analysis,
    problems,
    trace,
    traced,
    center,
    focused,
    ports: (node) => analysis.value.ports(node),
    snapshot,

    addNode(type, at, init = {}) {
      const doc = document.value;
      const id = nextId(doc, "n");
      const version = manifest.nodes.find((m) => m.type === type)?.version ?? 1;
      // Stagger nodes added without a position, so repeated clicks don't stack them exactly.
      const step = (graph.value.nodes.length % 6) * 24;
      doc.view.positions[id] = at ?? { x: center.value.x + step, y: center.value.y + step };
      graph.value.nodes.push({
        id,
        type,
        version,
        ...(JSON.parse(JSON.stringify(init)) as NodeInit),
      });
      return id;
    },

    removeNodes(ids) {
      const gone = new Set(ids);
      const doc = document.value;
      for (const g of graphs(doc)) {
        g.nodes = g.nodes.filter((n) => !gone.has(n.id));
        g.edges = g.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node));
      }
      for (const id of gone) delete doc.view.positions[id];
      for (const group of doc.view.groups) group.nodes = group.nodes.filter((n) => !gone.has(n));
    },

    moveNode(id, at) {
      document.value.view.positions[id] = { x: at.x, y: at.y };
    },

    connectionProblem(from, to) {
      const before = new Set(analysis.value.diagnostics.map(key));
      const doc = snapshot();
      place(doc, analysis.value, from, to);
      return validate(doc, manifest).diagnostics.find(
        (d) => !before.has(key(d)) && !VALUE_CODES.has(d.code),
      );
    },

    connect(from, to) {
      return place(document.value, analysis.value, from, to);
    },

    removeEdges(ids) {
      const gone = new Set(ids);
      for (const g of graphs(document.value)) g.edges = g.edges.filter((e) => !gone.has(e.id));
    },

    setLiteral,

    setTypeArg(node, name, term) {
      const n = findNode(node);
      if (!n) return;
      const args = { ...n.typeArgs };
      if (term === undefined) delete args[name];
      else args[name] = term;
      if (Object.keys(args).length) n.typeArgs = args;
      else delete n.typeArgs;
    },

    setVariadic(node, count) {
      const n = findNode(node);
      const v = analysis.value.ports(node)?.manifest.variadic;
      const g = graphOfNode(document.value, node);
      if (!n || !v || !g) return;
      n.variadic = count;
      const dropped = (port: string): boolean => {
        const i = port.startsWith(v.prefix) ? Number(port.slice(v.prefix.length)) : NaN;
        return Number.isInteger(i) && i >= count;
      };
      const side = v.kind === "input" ? "to" : "from";
      g.edges = g.edges.filter((e) => !(e[side].node === node && dropped(e[side].port)));
      if (v.kind === "input") {
        for (const port of Object.keys(n.literals ?? {}))
          if (dropped(port)) setLiteral(node, port, undefined);
      }
    },

    focus(node) {
      const doc = document.value;
      const fn = doc.program.functions.find((f) => f.graph.nodes.some((n) => n.id === node));
      graphId.value = fn?.id ?? "main";
      focused.value = { node };
    },
  };
}
