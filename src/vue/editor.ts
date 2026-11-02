import {
  computed,
  ref,
  shallowRef,
  triggerRef,
  toValue,
  watch,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from "vue";
import {
  extractFunction,
  isGround,
  labelText,
  nextId,
  parseLabel,
  TypeTable,
  validate,
  type Analysis,
  type Comment,
  type Diagnostic,
  type DocumentV1,
  type EdgeInstance,
  type Fault,
  type FunctionDecl,
  type Graph,
  type Group,
  type Json,
  type LabelPart,
  type LanguageManifest,
  type NodeInstance,
  type NodeMode,
  type NodePorts,
  type PortRef,
  type SchemaTemplate,
  type TraceEvent,
  type TypeTerm,
  type VariableDecl,
} from "../core";
import { defaultMessages, type WorkflowMessages } from "./messages";
import { MODE_STYLES, paletteColor } from "./theme";

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
  /**
   * Runs `start` live: it gets the `onTrace`, `signal` and `beforeStep` to pass to `dispatch` (or core's `run`).
   * `trace` fills in as the run goes (once per frame), `active` holds the nodes running now, and `cancel`,
   * `stepping` and `step` control it. Resolves with what `start` returns; throws if a run is already going.
   */
  run<R>(start: (live: LiveRun) => Promise<R>): Promise<R>;
  readonly running: Ref<boolean>;
  /** Nodes entered and not yet left, during a live run. */
  readonly active: ShallowRef<ReadonlySet<string>>;
  /** While true, a live run stops before each event and exec node; set it before or during the run. */
  readonly stepping: Ref<boolean>;
  /** The node a stopped run waits before; the canvas brings it into view. */
  readonly pausedAt: Ref<string | undefined>;
  /** Lets a stopped run go on: to its next node while `stepping`, else to the end. */
  step(): void;
  /** Aborts the live run: it ends `aborted`. */
  cancel(): void;
  /** Where a node added without a position goes; the canvas keeps it at the center of the view. */
  readonly center: Ref<XY>;
  /** The latest request to bring a node into view; a new object each time, so asking twice still triggers. */
  readonly focused: Ref<{ node: string } | undefined>;
  ports(node: string): NodePorts | undefined;
  /** Adds a node to the current graph; returns its id. Core nodes are version 1, others the manifest's version. */
  addNode(type: string, at?: XY, init?: NodeInit): string;
  /** Also removes their edges and view data. Group and comment ids remove those. */
  removeNodes(ids: Iterable<string>): void;
  /** Nodes, groups or comments. */
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

  /** Built-in UI strings: the defaults with the `messages` option over them. */
  readonly messages: ComputedRef<WorkflowMessages>;
  /** What can be added to the current graph: language nodes, plus the core nodes that fit it. */
  readonly entries: ComputedRef<PaletteEntry[]>;
  /** The categories `entries` use, in palette order: the language's, then Variables and My Blocks, then namespaces. */
  readonly categories: ComputedRef<CategoryView[]>;
  /** How nodes of `type` are drawn: category, color and icon. */
  look(type: string): NodeLook;
  /** A node's title as plain text: its label, or Entry / Return for a block's own nodes. */
  title(node: string): string;
  /** The selected nodes of the current graph, kept by the canvas. */
  readonly selection: Ref<string[]>;
  /** Moves several nodes, groups or comments as one edit, e.g. after aligning them. */
  moveNodes(positions: Record<string, XY>): void;
  /** Props for the literal editor of one input; `undefined` when the node has no such input. */
  widgetFor(node: string, port: string): WidgetSlotProps | undefined;

  readonly canUndo: ComputedRef<boolean>;
  readonly canRedo: ComputedRef<boolean>;
  /** Steps back through edits to the program and the view (not the viewport). Repeats of one small edit under 500 ms apart are one step. */
  undo(): void;
  redo(): void;

  /** The nodes among `ids` in the current graph and the edges between them; `undefined` when there are none. */
  copy(ids: Iterable<string>): NodeClip | undefined;
  /**
   * Adds a clip's nodes to the current graph with fresh ids: their top-left corner at `at`, else offset from
   * where they were copied. Returns the new ids; none when the clip is for another language.
   */
  paste(clip: NodeClip, at?: XY): string[];
  /** `paste(copy(ids))`, offset. */
  duplicate(ids: Iterable<string>): string[];
  /** Copies to the system clipboard, and to an in-app fallback for when the clipboard can't be read back. */
  copyToClipboard(ids: Iterable<string>): Promise<void>;
  /** Pastes the clipboard if it holds a clip, else the last copy made in this app. */
  pasteFromClipboard(at?: XY): Promise<string[]>;

  /** Removes every edge at a node, or at one of its ports. */
  disconnect(at: string | PortEnd): void;
  /**
   * For a new `type` node, the port of it that would wire to each end, in order, without errors other than
   * unset values; `undefined` when some end has no such port. `replacing` is an edge removed first.
   */
  fit(type: string, init: NodeInit, ends: PortEnd[], replacing?: string): string[] | undefined;
  /** Adds a node wired to `ends` as `fit` finds; `undefined`, with nothing changed, when it doesn't fit. */
  addWired(
    type: string,
    at: XY,
    init: NodeInit,
    ends: PortEnd[],
    replacing?: string,
  ): string | undefined;

  /** Groups and comments of the current graph. */
  readonly groups: ComputedRef<Group[]>;
  readonly comments: ComputedRef<Comment[]>;
  /** A group frame in the current graph; returns its id. */
  addGroup(box: Box, label?: string): string;
  /** A sticky note at `at` in the current graph; returns its id. */
  addComment(at: XY): string;
  /** Changes a group or comment. `color: undefined` clears it. Repeats under 500 ms are one undo step. */
  updateFrame(id: string, patch: FramePatch): void;

  /** A document variable, or a local of the current block when `local`; a string named `variableName(n)`. */
  addVariable(local?: boolean): string;
  /** The declaration of a document variable or local, and the block a local belongs to. */
  variable(id: string): { decl: VariableDecl; fn?: FunctionDecl } | undefined;
  /** A new type drops the default unless the patch sets one; `default: undefined` clears it. */
  updateVariable(id: string, patch: VariablePatch): void;
  /** Also removes its get and set nodes. */
  removeVariable(id: string): void;

  /** A block (function) with an entry and a return, named `blockName(n)`; returns its id. Doesn't open it. */
  addFunction(exec?: boolean): string;
  /** Turning a block pure drops its exits. */
  updateFunction(id: string, patch: { name?: string; exec?: boolean }): void;
  /** Also removes its calls and its body's groups and comments; leaves the block if it's open. */
  removeFunction(id: string): void;
  /** Adds an input, output (a string) or exit with a fresh name; returns the name. */
  addPort(fn: string, side: PortSide): string;
  /** Renames a port and every edge, literal and return using it; `false`, with nothing changed, when `to` is empty or taken. */
  renamePort(fn: string, side: PortSide, from: string, to: string): boolean;
  setPortType(fn: string, side: "inputs" | "outputs", name: string, type: TypeTerm): void;
  /** Also removes the edges and literals using it; removing an exit removes its returns. */
  removePort(fn: string, side: PortSide, name: string): void;
  /** Sets or clears a node's `ref`, e.g. the exit a return leaves through. */
  setRef(node: string, ref: string | undefined): void;
  /** Moves nodes of the current graph into a new block and calls it in their place (`extractFunction`). */
  makeBlock(nodes: Iterable<string>): { call: string } | { error: string };
}

/** What `editor.run` hands its callback: spread it into the run's options. */
export interface LiveRun {
  onTrace(event: TraceEvent): void;
  signal: AbortSignal;
  beforeStep(node: string): void | Promise<void>;
}

export type PortSide = "inputs" | "outputs" | "exits";

/** A rectangle in flow coordinates. */
export interface Box extends XY {
  width: number;
  height: number;
}

export interface FramePatch extends Partial<Box> {
  label?: string;
  text?: string;
  color?: string | undefined;
}

export interface VariablePatch {
  name?: string;
  type?: TypeTerm;
  default?: Json | undefined;
}

export interface EditorOptions {
  /** Overrides for the built-in UI strings, e.g. a translation. */
  messages?: MaybeRefOrGetter<Partial<WorkflowMessages> | undefined>;
  /** Defaults to `navigator.clipboard`. */
  clipboard?: { read(): Promise<string>; write(text: string): Promise<void> };
}

/** An existing port. `side: 'out'` is an output, so a new node attaches by an input. */
export interface PortEnd extends PortRef {
  side: "in" | "out";
  exec: boolean;
}

/** Copied nodes, as JSON on the clipboard. */
export interface NodeClip {
  format: "workflow-nodes";
  language: string;
  nodes: NodeInstance[];
  edges: EdgeInstance[];
  positions: Record<string, XY>;
}

/** One thing the palette or quick-add can add. */
export interface PaletteEntry {
  key: string;
  type: string;
  /** Plain text: a sentence label's inputs are replaced by their labels. */
  label: string;
  /** The label split at its inputs, for showing them as slots. */
  parts: LabelPart[];
  mode: NodeMode;
  /** A `CategoryView` id. */
  category: string;
  description?: string | undefined;
  /** From `look`. */
  icon: string;
  /** From `look`. */
  color?: string | undefined;
  requires: string[];
  init?: NodeInit;
}

/** A palette section. `color` is CSS (palette names resolved); none means neutral. */
export interface CategoryView {
  id: string;
  label: string;
  color?: string | undefined;
  icon?: string | undefined;
}

export interface NodeLook {
  category: CategoryView;
  /** CSS; the node's own color, else its category's. None means neutral. */
  color?: string | undefined;
  /** The node's own icon, else its category's, else its mode's. */
  icon: string;
}

export type ArrangeOp =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "distributeX"
  | "distributeY";

export interface Rect extends XY {
  id: string;
  width: number;
  height: number;
}

/**
 * New top-left corners for aligning nodes by an edge or center, or spacing them evenly (equal gaps between
 * neighbours, the outermost two staying put).
 */
export function arrange(rects: readonly Rect[], op: ArrangeOp): Record<string, XY> {
  const out: Record<string, XY> = {};
  if (!rects.length) return out;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  const at = (r: Rect, x: number, y: number): void => {
    out[r.id] = { x: Math.round(x), y: Math.round(y) };
  };
  if (op === "distributeX" || op === "distributeY") {
    const horizontal = op === "distributeX";
    const size = (r: Rect): number => (horizontal ? r.width : r.height);
    const start = (r: Rect): number => (horizontal ? r.x : r.y);
    const sorted = rects.toSorted((a, b) => start(a) - start(b));
    const span =
      (horizontal ? right - left : bottom - top) - sorted.reduce((s, r) => s + size(r), 0);
    const gap = sorted.length > 1 ? span / (sorted.length - 1) : 0;
    let cursor = horizontal ? left : top;
    for (const r of sorted) {
      if (horizontal) at(r, cursor, r.y);
      else at(r, r.x, cursor);
      cursor += size(r) + gap;
    }
    return out;
  }
  for (const r of rects) {
    if (op === "left") at(r, left, r.y);
    else if (op === "center") at(r, (left + right - r.width) / 2, r.y);
    else if (op === "right") at(r, right - r.width, r.y);
    else if (op === "top") at(r, r.x, top);
    else if (op === "middle") at(r, r.x, (top + bottom - r.height) / 2);
    else at(r, r.x, bottom - r.height);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPort = (v: unknown): v is PortRef =>
  isObject(v) && typeof v.node === "string" && typeof v.port === "string";

/**
 * Reads a clip from clipboard text. The text is untrusted: only the shape is checked here, and `validate`
 * reports whatever else is wrong once it's pasted.
 */
export function parseClip(text: string): NodeClip | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v) || v.format !== "workflow-nodes" || typeof v.language !== "string")
    return undefined;
  const { nodes, edges, positions } = v;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !isObject(positions)) return undefined;
  const nodeOk = (n: unknown): boolean =>
    isObject(n) &&
    typeof n.id === "string" &&
    typeof n.type === "string" &&
    typeof n.version === "number";
  const edgeOk = (e: unknown): boolean =>
    isObject(e) && typeof e.id === "string" && isPort(e.from) && isPort(e.to);
  const xyOk = (p: unknown): boolean => isObject(p) && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!nodes.every(nodeOk) || !edges.every(edgeOk) || !Object.values(positions).every(xyOk))
    return undefined;
  return v as unknown as NodeClip;
}

// The last copy in this app, for when the system clipboard can't be read (permissions, WebKit).
let lastClip: NodeClip | undefined;

const view = (id: string, label: string, color?: string, icon?: string): CategoryView => ({
  id,
  label,
  ...(color !== undefined && { color: paletteColor(color) }),
  ...(icon !== undefined && { icon }),
});
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const HISTORY_LIMIT = 200;
const MERGE_MS = 500;
// What undo restores: everything but the viewport. `undefined` drops the key from the JSON.
const content = (d: DocumentV1): string =>
  JSON.stringify({ ...d, view: { ...d.view, viewport: undefined } });

// A new edge may leave inputs unset or literals unchecked; that's normal mid-edit, not a reason to refuse it.
const VALUE_CODES = new Set(["E_REQUIRED_INPUT", "E_LITERAL_INVALID", "E_UNRESOLVED_TYPE"]);

const key = (d: Diagnostic): string => `${d.code} ${d.message}`;

function graphs(doc: DocumentV1): Graph[] {
  return [doc.program.graph, ...doc.program.functions.map((f) => f.graph)];
}

function graphOfNode(doc: DocumentV1, node: string): Graph | undefined {
  return graphs(doc).find((g) => g.nodes.some((n) => n.id === node));
}

/** The exits of an exec function, in order; a return without `ref` leaves through the first. */
const exitsOf = (fn: FunctionDecl): string[] => fn.exits ?? ["then"];

/** `ports` with key `from` renamed to `to`, keeping the order. */
const renamed = <T>(ports: Record<string, T>, from: string, to: string): Record<string, T> =>
  Object.fromEntries(Object.entries(ports).map(([k, v]) => [k === from ? to : k, v]));

const STRING: TypeTerm = { kind: "con", id: "string" };

/** Renames (`to` a name) or drops (`to` undefined) the edges at one port of the given nodes. */
function rewire(
  g: Graph,
  nodes: NodeInstance[],
  end: "from" | "to",
  port: string,
  to?: string,
): void {
  const at = new Set(nodes.map((n) => n.id));
  const hit = (e: EdgeInstance): boolean => at.has(e[end].node) && e[end].port === port;
  if (to === undefined) g.edges = g.edges.filter((e) => !hit(e));
  else for (const e of g.edges) if (hit(e)) e[end].port = to;
}

const ofType = (fn: FunctionDecl, type: string): NodeInstance[] =>
  fn.graph.nodes.filter((n) => n.type === type);

const portNames = (fn: FunctionDecl, side: PortSide): string[] =>
  side === "exits" ? exitsOf(fn) : Object.keys(fn[side]);

// A call's exec and data ports share names, so a new name must be free on both.
const takenNames = (fn: FunctionDecl, side: PortSide): string[] =>
  side === "inputs"
    ? [...portNames(fn, side), ...(fn.exec ? ["exec", "then"] : [])]
    : [...Object.keys(fn.outputs), ...(fn.exec ? [...exitsOf(fn), "exec"] : [])];

const same = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.port === b.port;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

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

const isExecEdge = (a: Analysis, e: EdgeInstance): boolean =>
  a.ports(e.from.node)?.execOut.includes(e.from.port) ?? false;

/** The edge from `end` to port `port` of `node`, the other way round when `end` is an input. */
const wire = (end: PortEnd, node: string, port: string): [PortRef, PortRef] =>
  end.side === "out"
    ? [
        { node: end.node, port: end.port },
        { node, port },
      ]
    : [
        { node, port },
        { node: end.node, port: end.port },
      ];

/** The ports of a node that could attach to `end`. */
function candidates(ports: NodePorts, end: PortEnd): string[] {
  if (end.exec) return end.side === "out" ? ports.execIn : ports.execOut;
  return end.side === "out"
    ? ports.inputs.filter(([, def]) => def.wire !== false).map(([name]) => name)
    : ports.outputs.map(([name]) => name);
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
  /** The editor's strings, for the widget's own labels. */
  messages: WorkflowMessages;
}

/** Props of `WorkflowCanvas`'s `#node` slot. */
export interface NodeSlotProps {
  id: string;
  selected: boolean;
}

/**
 * What a canvas context menu was opened on. `nodes` are the nodes its actions apply to: the selection when
 * the clicked node is part of it, else that node.
 */
export type MenuTarget =
  | { kind: "pane"; at: XY }
  | { kind: "node"; node: string; nodes: string[]; at: XY }
  | { kind: "edge"; edge: string; at: XY }
  | { kind: "port"; end: PortEnd; at: XY };

export function useWorkflowEditor(
  manifest: LanguageManifest,
  initial: DocumentV1,
  options: EditorOptions = {},
): WorkflowEditor {
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

  const focus = (node: string): void => {
    const doc = document.value;
    const fn = doc.program.functions.find((f) => f.graph.nodes.some((n) => n.id === node));
    graphId.value = fn?.id ?? "main";
    focused.value = { node };
  };

  // Live runs. Events are kept in one array, shown at most once per frame: a run can make thousands a second.
  const running = ref(false);
  const active = shallowRef<ReadonlySet<string>>(new Set());
  const stepping = ref(false);
  const pausedAt = ref<string>();
  let controller: AbortController | undefined;
  let resume: (() => void) | undefined;
  const step = (): void => {
    const go = resume;
    resume = undefined;
    pausedAt.value = undefined;
    go?.();
  };
  const run = async <R>(start: (live: LiveRun) => Promise<R>): Promise<R> => {
    if (running.value) throw new Error("A run is already going");
    running.value = true;
    controller = new AbortController();
    const events: TraceEvent[] = [];
    const open = new Map<string, number>();
    trace.value = events;
    let queued = false;
    const show = (): void => {
      queued = false;
      triggerRef(trace);
      active.value = new Set(open.keys());
    };
    const later =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (f: () => void) => setTimeout(f, 16);
    try {
      return await start({
        signal: controller.signal,
        onTrace(event) {
          events.push(event);
          if (event.t === "enter") open.set(event.node, (open.get(event.node) ?? 0) + 1);
          else if (event.t === "exit") {
            const n = (open.get(event.node) ?? 1) - 1;
            if (n) open.set(event.node, n);
            else open.delete(event.node);
          }
          if (!queued) later(show);
          queued = true;
        },
        beforeStep(node) {
          if (!stepping.value || controller?.signal.aborted) return undefined;
          show();
          pausedAt.value = node;
          focus(node);
          return new Promise<void>((r) => (resume = r));
        },
      });
    } finally {
      step();
      open.clear();
      show();
      running.value = false;
      stepping.value = false;
      controller = undefined;
    }
  };

  const snapshot = (): DocumentV1 => clone(document.value);
  const versionOf = (type: string): number =>
    manifest.nodes.find((m) => m.type === type)?.version ?? 1;

  const findNode = (id: string): NodeInstance | undefined =>
    graphOfNode(document.value, id)?.nodes.find((n) => n.id === id);

  // Names the edit being made, when repeats of it may merge into one undo step (see the history below).
  let editKey: string | undefined;
  const setLiteral = (node: string, port: string, value: Json | undefined): void => {
    const n = findNode(node);
    if (!n) return;
    editKey = `literal ${node} ${port}`;
    const literals = { ...n.literals };
    if (value === undefined) delete literals[port];
    else literals[port] = value;
    if (Object.keys(literals).length) n.literals = literals;
    else delete n.literals;
  };

  const messages = computed<WorkflowMessages>(() => ({
    ...defaultMessages,
    ...toValue(options.messages),
  }));

  // Categories: the language's, sorted by `order` (ties keep declaration order), with the built-in ones for
  // variables and functions after those of order 0 or less, then one per namespace for uncategorized nodes.
  const declared = (manifest.categories ?? []).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const builtIn = computed(() => ({
    variables: view(
      "core.variables",
      messages.value.categoryVariables,
      "orange",
      "i-lucide-variable",
    ),
    functions: view("core.functions", messages.value.categoryFunctions, "pink", "i-lucide-puzzle"),
  }));
  const CORE_ICONS: Record<string, string> = {
    "core.get": "i-lucide-variable",
    "core.set": "i-lucide-variable",
    "core.call": "i-lucide-puzzle",
    "core.entry": "i-lucide-log-in",
    "core.return": "i-lucide-log-out",
  };
  const nodeManifests = new Map(manifest.nodes.map((n) => [n.type, n]));
  const look = (type: string): NodeLook => {
    if (type.startsWith("core.")) {
      const category =
        type === "core.get" || type === "core.set"
          ? builtIn.value.variables
          : builtIn.value.functions;
      return { category, color: category.color, icon: CORE_ICONS[type] ?? "i-lucide-puzzle" };
    }
    const n = nodeManifests.get(type);
    const def = n?.category === undefined ? undefined : declared.find((c) => c.id === n.category);
    const namespace = type.split(".")[0] ?? "";
    const category = def
      ? view(def.id, def.label, def.color, def.icon)
      : view(`ns:${namespace}`, titleCase(namespace));
    const color = n?.color === undefined ? category.color : paletteColor(n.color);
    return {
      category,
      color,
      icon: n?.icon ?? category.icon ?? MODE_STYLES[n?.mode ?? "exec"].icon,
    };
  };

  // Language nodes, plus the core nodes that fit the current graph: variable get/set, calls, and a function's
  // entry and return while it has none.
  const entries = computed<PaletteEntry[]>(() => {
    const m = messages.value;
    const doc = document.value;
    const fn = doc.program.functions.find((f) => f.id === graphId.value);
    const list: PaletteEntry[] = [];
    const add = (
      e: Pick<PaletteEntry, "type" | "label" | "mode"> & Partial<PaletteEntry>,
    ): void => {
      const l = look(e.type);
      list.push({
        key: `${e.type}:${e.init?.ref ?? ""}`,
        parts: [{ text: e.label }],
        category: l.category.id,
        icon: l.icon,
        color: l.color,
        requires: [],
        ...e,
      });
    };
    for (const n of manifest.nodes) {
      if (n.mode === "event" && fn) continue;
      add({
        type: n.type,
        label: labelText(n),
        parts: parseLabel(n.label),
        mode: n.mode,
        description: n.description,
        requires: n.requires ?? [],
      });
    }
    for (const v of [...(fn?.locals ?? []), ...doc.program.variables]) {
      const init = { ref: v.id };
      add({ type: "core.get", label: m.getVariable(v.name), mode: "pure", init });
      add({ type: "core.set", label: m.setVariable(v.name), mode: "exec", init });
    }
    for (const f of doc.program.functions)
      add({
        type: "core.call",
        label: f.name,
        mode: f.exec ? "exec" : "pure",
        init: { ref: f.id },
      });
    if (fn) {
      if (!fn.graph.nodes.some((n) => n.type === "core.entry"))
        add({ type: "core.entry", label: m.entry, mode: fn.exec ? "event" : "pure" });
      // An exec block may return through each of its exits, as often as it likes; a pure one once.
      const exits = exitsOf(fn);
      if (fn.exec)
        for (const exit of exits)
          add({
            type: "core.return",
            label: exits.length > 1 ? m.returnVia(exit) : m.return,
            mode: "exec",
            init: { ref: exit },
          });
      else if (!fn.graph.nodes.some((n) => n.type === "core.return"))
        add({ type: "core.return", label: m.return, mode: "pure" });
    }
    return list;
  });

  // Variables and My Blocks always show, for their New buttons.
  const categories = computed<CategoryView[]>(() => {
    const used = new Set([
      ...entries.value.map((e) => e.category),
      "core.variables",
      "core.functions",
    ]);
    const toView = (c: (typeof declared)[number]) => view(c.id, c.label, c.color, c.icon);
    const early = declared.filter((c) => (c.order ?? 0) <= 0);
    const all = [
      ...early.map(toView),
      builtIn.value.variables,
      builtIn.value.functions,
      ...declared.slice(early.length).map(toView),
    ];
    // Namespace groups, in the order their nodes appear.
    for (const e of entries.value) {
      if (e.category.startsWith("ns:") && !all.some((c) => c.id === e.category))
        all.push(look(e.type).category);
    }
    return all.filter((c) => used.has(c.id));
  });

  const selection = ref<string[]>([]);

  // History: snapshots of `content`, taken by watching the document, so every edit counts, however it's made.
  // Repeats of one small edit within MERGE_MS (typing into one field, nudging one node) are one step; the
  // methods making those edits name them in `editKey`.
  const past = shallowRef<string[]>([]);
  const future = shallowRef<string[]>([]);
  let committed = content(document.value);
  let lastKey: string | undefined;
  let lastEdit = 0;
  watch(
    document,
    () => {
      const made = editKey;
      editKey = undefined;
      const now = content(document.value);
      if (now === committed) return;
      const at = Date.now();
      const repeat = made !== undefined && made === lastKey && at - lastEdit < MERGE_MS;
      if (!repeat) past.value = [...past.value, committed].slice(-HISTORY_LIMIT);
      lastKey = made;
      lastEdit = at;
      future.value = [];
      committed = now;
    },
    { deep: true },
  );
  const travel = (from: ShallowRef<string[]>, to: ShallowRef<string[]>): void => {
    const target = from.value.at(-1);
    if (target === undefined) return;
    from.value = from.value.slice(0, -1);
    to.value = [...to.value, committed];
    const doc = JSON.parse(target) as DocumentV1;
    const viewport = document.value.view.viewport;
    if (viewport) doc.view.viewport = viewport;
    committed = content(doc);
    lastKey = undefined;
    document.value = doc;
    if (!doc.program.functions.some((f) => f.id === graphId.value)) graphId.value = "main";
  };

  const addNode = (type: string, at?: XY, init: NodeInit = {}): string => {
    const doc = document.value;
    const id = nextId(doc, "n");
    // Stagger nodes added without a position, so repeated clicks don't stack them exactly.
    const stagger = (graph.value.nodes.length % 6) * 24;
    doc.view.positions[id] = at ?? { x: center.value.x + stagger, y: center.value.y + stagger };
    graph.value.nodes.push({ id, type, version: versionOf(type), ...clone(init) });
    return id;
  };
  const connect = (from: PortRef, to: PortRef): string =>
    place(document.value, analysis.value, from, to);
  const removeEdges = (ids: Iterable<string>): void => {
    const gone = new Set(ids);
    for (const g of graphs(document.value)) g.edges = g.edges.filter((e) => !gone.has(e.id));
  };

  // Groups and comments: view-only frames, each in one graph.
  const frameOf = (id: string): (Group & Partial<Comment>) | undefined => {
    const v = document.value.view;
    return v.groups.find((g) => g.id === id) ?? v.comments?.find((c) => c.id === id);
  };
  const moveTo = (id: string, at: XY): void => {
    const f = frameOf(id);
    if (f) Object.assign(f, { x: at.x, y: at.y });
    else document.value.view.positions[id] = { x: at.x, y: at.y };
  };
  const removeNodes = (ids: Iterable<string>): void => {
    const gone = new Set(ids);
    const doc = document.value;
    for (const g of graphs(doc)) {
      g.nodes = g.nodes.filter((n) => !gone.has(n.id));
      g.edges = g.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node));
    }
    for (const id of gone) delete doc.view.positions[id];
    doc.view.groups = doc.view.groups.filter((g) => !gone.has(g.id));
    if (doc.view.comments) doc.view.comments = doc.view.comments.filter((c) => !gone.has(c.id));
  };

  const currentFn = (): FunctionDecl | undefined =>
    document.value.program.functions.find((f) => f.id === graphId.value);
  const fnById = (id: string): FunctionDecl | undefined =>
    document.value.program.functions.find((f) => f.id === id);
  const findVariable = (id: string): { decl: VariableDecl; fn?: FunctionDecl } | undefined => {
    const doc = document.value;
    const decl = doc.program.variables.find((v) => v.id === id);
    if (decl) return { decl };
    for (const fn of doc.program.functions) {
      const local = fn.locals?.find((v) => v.id === id);
      if (local) return { decl: local, fn };
    }
    return undefined;
  };
  const uses = (id: string): string[] => analysis.value.references(id).map((r) => r.node);

  /** The call nodes of a function, with the graph each is in. */
  const callsOf = (fn: string): { g: Graph; n: NodeInstance }[] =>
    graphs(document.value).flatMap((g) =>
      g.nodes.filter((n) => n.type === "core.call" && n.ref === fn).map((n) => ({ g, n })),
    );

  /** Renames (`to` a name) or removes a port of `fn`, with the edges, literals and returns using it. */
  const changePort = (fn: FunctionDecl, side: PortSide, name: string, to?: string): void => {
    const calls = callsOf(fn.id);
    if (side === "inputs") {
      if (to === undefined) delete fn.inputs[name];
      else fn.inputs = renamed(fn.inputs, name, to);
      for (const { g, n } of calls) {
        rewire(g, [n], "to", name, to);
        const value = n.literals?.[name];
        if (value !== undefined) {
          setLiteral(n.id, name, undefined);
          if (to !== undefined) setLiteral(n.id, to, value);
        }
      }
      rewire(fn.graph, ofType(fn, "core.entry"), "from", name, to);
    } else if (side === "outputs") {
      if (to === undefined) delete fn.outputs[name];
      else fn.outputs = renamed(fn.outputs, name, to);
      for (const { g, n } of calls) rewire(g, [n], "from", name, to);
      rewire(fn.graph, ofType(fn, "core.return"), "to", name, to);
    } else {
      const exits = exitsOf(fn);
      const returns = ofType(fn, "core.return").filter((n) => (n.ref ?? exits[0]) === name);
      if (to === undefined) removeNodes(returns.map((n) => n.id));
      else for (const n of returns) if (n.ref !== undefined) n.ref = to;
      fn.exits =
        to === undefined
          ? exits.filter((x) => x !== name)
          : exits.map((x) => (x === name ? to : x));
      for (const { g, n } of calls) rewire(g, [n], "from", name, to);
    }
  };

  const copy = (ids: Iterable<string>): NodeClip | undefined => {
    const wanted = new Set(ids);
    const g = graph.value;
    const nodes = g.nodes.filter((n) => wanted.has(n.id));
    if (!nodes.length) return undefined;
    const kept = new Set(nodes.map((n) => n.id));
    const positions = document.value.view.positions;
    return clone({
      format: "workflow-nodes",
      language: document.value.language.id,
      nodes,
      edges: g.edges.filter((e) => kept.has(e.from.node) && kept.has(e.to.node)),
      positions: Object.fromEntries(nodes.map((n) => [n.id, positions[n.id] ?? { x: 0, y: 0 }])),
    });
  };

  const paste = (clip: NodeClip, at?: XY): string[] => {
    const doc = document.value;
    if (clip.language !== doc.language.id || !clip.nodes.length) return [];
    const where = (id: string): XY => clip.positions[id] ?? { x: 0, y: 0 };
    const xs = clip.nodes.map((n) => where(n.id));
    const shift = at
      ? { x: at.x - Math.min(...xs.map((p) => p.x)), y: at.y - Math.min(...xs.map((p) => p.y)) }
      : { x: 32, y: 32 };
    const g = graph.value;
    const ids = new Map<string, string>();
    for (const n of clip.nodes) {
      const id = nextId(doc, "n");
      ids.set(n.id, id);
      const { type, version, literals, typeArgs, variadic, ref: target } = clone(n);
      g.nodes.push({
        id,
        type,
        version,
        ...(literals !== undefined && { literals }),
        ...(typeArgs !== undefined && { typeArgs }),
        ...(variadic !== undefined && { variadic }),
        ...(target !== undefined && { ref: target }),
      });
      const p = where(n.id);
      doc.view.positions[id] = { x: p.x + shift.x, y: p.y + shift.y };
    }
    for (const e of clip.edges) {
      const from = ids.get(e.from.node);
      const to = ids.get(e.to.node);
      if (from && to)
        g.edges.push({
          id: nextId(doc, "e"),
          from: { node: from, port: e.from.port },
          to: { node: to, port: e.to.port },
        });
    }
    return [...ids.values()];
  };

  const nav = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const clipboard =
    options.clipboard ??
    (nav && { read: () => nav.readText(), write: (text: string) => nav.writeText(text) });

  const fit = (
    type: string,
    init: NodeInit,
    ends: PortEnd[],
    replacing?: string,
  ): string[] | undefined => {
    const trial = snapshot();
    if (replacing)
      for (const g of graphs(trial)) g.edges = g.edges.filter((e) => e.id !== replacing);
    const g =
      trial.program.functions.find((f) => f.id === graphId.value)?.graph ?? trial.program.graph;
    const id = nextId(trial, "n");
    g.nodes.push({ id, type, version: versionOf(type), ...clone(init) });
    const a = validate(trial, manifest);
    const ports = a.ports(id);
    if (!ports) return undefined;
    const before = new Set(a.diagnostics.map(key));
    const chosen: string[] = [];
    for (const end of ends) {
      const port = candidates(ports, end).find((p) => {
        const doc = clone(trial);
        const [from, to] = wire(end, id, p);
        place(doc, a, from, to);
        return !validate(doc, manifest).diagnostics.some(
          (d) => !before.has(key(d)) && !VALUE_CODES.has(d.code),
        );
      });
      if (port === undefined) return undefined;
      chosen.push(port);
    }
    return chosen;
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
    run,
    running,
    active,
    stepping,
    pausedAt,
    step,
    cancel() {
      controller?.abort();
      step();
    },
    center,
    focused,
    ports: (node) => analysis.value.ports(node),
    snapshot,
    messages,
    entries,
    categories,
    look,
    selection,
    moveNodes(positions) {
      for (const [id, at] of Object.entries(positions)) moveTo(id, at);
    },
    title(node) {
      const n = findNode(node);
      const m = messages.value;
      if (n?.type === "core.entry") return m.entry;
      if (n?.type === "core.return") {
        const fn = document.value.program.functions.find((f) => f.graph.nodes.includes(n));
        const exits = fn?.exec ? exitsOf(fn) : [];
        return exits.length > 1 ? m.returnVia(n.ref ?? exits[0] ?? "") : m.return;
      }
      const p = analysis.value.ports(node)?.manifest;
      if (!p) return n?.type ?? node;
      return n?.type === "core.set" ? m.setVariable(p.label) : labelText(p);
    },
    widgetFor(node, port) {
      const def = analysis.value.ports(node)?.inputs.find(([name]) => name === port)?.[1];
      if (!def) return undefined;
      const type = analysis.value.typeOf(node, port, "in");
      return {
        node,
        port,
        type,
        schema: type && isGround(type) ? types.schemaFor(type) : undefined,
        value: findNode(node)?.literals?.[port],
        fallback: def.default,
        update: (value) => setLiteral(node, port, value),
        messages: messages.value,
      };
    },

    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    undo: () => travel(past, future),
    redo: () => travel(future, past),

    copy,
    paste,
    duplicate: (ids) => {
      const clip = copy(ids);
      return clip ? paste(clip) : [];
    },
    async copyToClipboard(ids) {
      const clip = copy(ids);
      if (!clip) return;
      lastClip = clip;
      await clipboard?.write(JSON.stringify(clip)).catch(() => undefined);
    },
    async pasteFromClipboard(at) {
      let clip = lastClip;
      // A readable clipboard holding something else wins over the fallback: the user copied that since. A
      // browser asking for permission can take a while to answer, so the fallback is used after half a second.
      if (clipboard) {
        const late = new Promise<NodeClip | undefined>((r) => setTimeout(() => r(lastClip), 500));
        clip = await Promise.race([clipboard.read().then(parseClip, () => lastClip), late]);
      }
      return clip ? paste(clip, at) : [];
    },

    disconnect(at) {
      const node = typeof at === "string" ? at : at.node;
      const g = graphOfNode(document.value, node);
      if (!g) return;
      const a = analysis.value;
      g.edges = g.edges.filter((e) => {
        if (typeof at === "string") return e.from.node !== node && e.to.node !== node;
        return !(same(at.side === "out" ? e.from : e.to, at) && isExecEdge(a, e) === at.exec);
      });
    },
    fit,
    addWired(type, at, init, ends, replacing) {
      const ports = fit(type, init, ends, replacing);
      if (!ports) return undefined;
      if (replacing) removeEdges([replacing]);
      const id = addNode(type, at, init);
      ends.forEach((end, i) => connect(...wire(end, id, ports[i] ?? "")));
      return id;
    },

    addNode,

    removeNodes,

    moveNode(id, at) {
      editKey = `move ${id}`;
      moveTo(id, at);
    },

    connectionProblem(from, to) {
      const before = new Set(analysis.value.diagnostics.map(key));
      const doc = snapshot();
      place(doc, analysis.value, from, to);
      return validate(doc, manifest).diagnostics.find(
        (d) => !before.has(key(d)) && !VALUE_CODES.has(d.code),
      );
    },

    connect,
    removeEdges,

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

    focus,

    groups: computed(() => document.value.view.groups.filter((g) => g.graph === graphId.value)),
    comments: computed(() =>
      (document.value.view.comments ?? []).filter((c) => c.graph === graphId.value),
    ),
    addGroup(box, label) {
      const doc = document.value;
      const id = nextId(doc, "g");
      doc.view.groups.push({
        id,
        graph: graphId.value,
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        ...(label !== undefined && { label }),
      });
      return id;
    },
    addComment(at) {
      const doc = document.value;
      const id = nextId(doc, "c");
      const { x, y } = { x: Math.round(at.x), y: Math.round(at.y) };
      (doc.view.comments ??= []).push({
        id,
        graph: graphId.value,
        x,
        y,
        width: 220,
        height: 120,
        color: "yellow",
        text: "",
      });
      return id;
    },
    updateFrame(id, patch) {
      const f = frameOf(id) as Record<string, unknown> | undefined;
      if (!f) return;
      editKey = `frame ${id}`;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete f[k];
        else f[k] = v;
      }
    },

    addVariable(local = false) {
      const doc = document.value;
      const fn = local ? currentFn() : undefined;
      const count =
        doc.program.variables.length +
        doc.program.functions.reduce((s, f) => s + (f.locals?.length ?? 0), 0);
      const id = nextId(doc, "v");
      const decl = { id, name: messages.value.variableName(count + 1), type: STRING, default: "" };
      if (fn) fn.locals = [...(fn.locals ?? []), decl];
      else doc.program.variables.push(decl);
      return id;
    },
    variable: findVariable,
    updateVariable(id, patch) {
      const v = findVariable(id)?.decl;
      if (!v) return;
      editKey = `variable ${id}`;
      if (patch.name !== undefined) v.name = patch.name;
      if (patch.type !== undefined) v.type = clone(patch.type);
      if ("default" in patch || patch.type !== undefined) {
        if (patch.default === undefined) delete v.default;
        else v.default = clone(patch.default);
      }
    },
    removeVariable(id) {
      const found = findVariable(id);
      if (!found) return;
      removeNodes(uses(id));
      const { fn } = found;
      if (fn) fn.locals = (fn.locals ?? []).filter((v) => v.id !== id);
      else
        document.value.program.variables = document.value.program.variables.filter(
          (v) => v.id !== id,
        );
    },

    addFunction(exec = true) {
      const doc = document.value;
      const id = nextId(doc, "f");
      const first = Number(nextId(doc, "n").slice(1));
      const [entry, ret] = [`n${first}`, `n${first + 1}`];
      doc.view.positions[entry] = { x: 0, y: 0 };
      doc.view.positions[ret] = { x: 360, y: 0 };
      doc.program.functions.push({
        id,
        name: messages.value.blockName(doc.program.functions.length + 1),
        exec,
        inputs: {},
        outputs: {},
        graph: {
          nodes: [
            { id: entry, type: "core.entry", version: 1 },
            { id: ret, type: "core.return", version: 1 },
          ],
          edges: exec
            ? [
                {
                  id: nextId(doc, "e"),
                  from: { node: entry, port: "then" },
                  to: { node: ret, port: "exec" },
                },
              ]
            : [],
        },
      });
      return id;
    },
    updateFunction(id, patch) {
      const fn = fnById(id);
      if (!fn) return;
      editKey = `function ${id}`;
      if (patch.name !== undefined) fn.name = patch.name;
      if (patch.exec === undefined || patch.exec === fn.exec) return;
      // Exec wires at the block's own nodes and at its calls no longer fit.
      if (!patch.exec) {
        for (const name of exitsOf(fn))
          for (const { g, n } of callsOf(id)) rewire(g, [n], "from", name);
        for (const { g, n } of callsOf(id)) rewire(g, [n], "to", "exec");
        rewire(fn.graph, ofType(fn, "core.entry"), "from", "then");
        rewire(fn.graph, ofType(fn, "core.return"), "to", "exec");
        for (const n of ofType(fn, "core.return")) delete n.ref;
        delete fn.exits;
      }
      fn.exec = patch.exec;
    },
    removeFunction(id) {
      const fn = fnById(id);
      if (!fn) return;
      removeNodes([...uses(id), ...fn.graph.nodes.map((n) => n.id)]);
      const doc = document.value;
      doc.program.functions = doc.program.functions.filter((f) => f.id !== id);
      doc.view.groups = doc.view.groups.filter((g) => g.graph !== id);
      if (doc.view.comments) doc.view.comments = doc.view.comments.filter((c) => c.graph !== id);
      if (graphId.value === id) graphId.value = "main";
    },
    addPort(fnId, side) {
      const fn = fnById(fnId);
      if (!fn) return "";
      const base = side === "inputs" ? "input" : side === "outputs" ? "output" : "exit";
      const taken = takenNames(fn, side);
      let k = 1;
      while (taken.includes(`${base}${k}`)) k++;
      const name = `${base}${k}`;
      if (side === "exits") fn.exits = [...exitsOf(fn), name];
      else fn[side] = { ...fn[side], [name]: { type: STRING } };
      return name;
    },
    renamePort(fnId, side, from, to) {
      const fn = fnById(fnId);
      const name = to.trim();
      if (!fn || !name || !portNames(fn, side).includes(from)) return false;
      if (name === from) return true;
      if (takenNames(fn, side).includes(name)) return false;
      changePort(fn, side, from, name);
      return true;
    },
    setPortType(fnId, side, name, type) {
      const fn = fnById(fnId);
      const def = fn?.[side][name];
      if (!fn || !def) return;
      // A default of the old type wouldn't fit the new one.
      const { default: _, ...rest } = def;
      fn[side][name] = { ...rest, type: clone(type) };
    },
    removePort(fnId, side, name) {
      const fn = fnById(fnId);
      if (!fn || !portNames(fn, side).includes(name)) return;
      if (side === "exits" && exitsOf(fn).length < 2) return;
      changePort(fn, side, name);
    },
    setRef(node, value) {
      const n = findNode(node);
      if (!n) return;
      if (value === undefined) delete n.ref;
      else n.ref = value;
    },
    makeBlock(ids) {
      const doc = document.value;
      const name = messages.value.blockName(doc.program.functions.length + 1);
      const r = extractFunction(snapshot(), manifest, [...ids], name);
      if ("error" in r) return r;
      document.value = r.doc;
      return { call: r.call };
    },
  };
}
