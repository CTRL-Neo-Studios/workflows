<script setup lang="ts">
import type { ContextMenuItem } from "@nuxt/ui";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UContextMenu from "@nuxt/ui/components/ContextMenu.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import UFieldGroup from "@nuxt/ui/components/FieldGroup.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import {
  ConnectionMode,
  SelectionMode,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeDragEvent,
  getRectOfNodes,
  type OnConnectStartParams,
  type ViewportTransform,
} from "@vue-flow/core";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  useId,
  watch,
} from "vue";
import {
  arrange,
  CANVAS,
  handleId,
  PALETTE_MIME,
  portOf,
  type ArrangeOp,
  type MenuTarget,
  type NodeInit,
  type NodeSlotProps,
  type PaletteEntry,
  type PortEnd,
  type WidgetSlotProps,
  type WorkflowEditor,
  type XY,
} from "./editor";
import type { Frame } from "../core";
import { typeColor } from "./theme";
import WorkflowFrame from "./WorkflowFrame.vue";
import WorkflowMinimap from "./WorkflowMinimap.vue";
import WorkflowNode from "./WorkflowNode.vue";
import WorkflowQuickAdd from "./WorkflowQuickAdd.vue";

const {
  editor,
  menu,
  insets = {},
} = defineProps<{
  editor: WorkflowEditor;
  /** Adjusts a context menu before it opens: add, remove or reorder its item groups. */
  menu?: ((target: MenuTarget, items: ContextMenuItem[][]) => ContextMenuItem[][]) | undefined;
  /** Space covered by panels over the canvas's edges, in px; the canvas's own controls stay clear of it. */
  insets?: { left?: number; right?: number };
}>();
/** Snap nodes to the dot grid while dragging them. */
const snap = defineModel<boolean>("snap", { default: false });
const minimap = defineModel<boolean>("minimap", { default: false });
defineSlots<{
  /**
   * Replaces a whole node; render `WorkflowNode` inside it to keep the default body. That `WorkflowNode` takes
   * its own `#widget` slot: the canvas's `#widget` reaches only the nodes the canvas renders.
   */
  node?(props: NodeSlotProps): unknown;
  /** Replaces the literal editor of one unwired input. */
  widget?(props: WidgetSlotProps): unknown;
  /** Extra buttons in the bar shown while several nodes are selected. */
  selection?(props: { nodes: string[] }): unknown;
}>();

const m = editor.messages;
const hint = ref<string>();
provide(CANVAS, { editor, hint });

const flowId = useId();
const {
  addSelectedNodes,
  dimensions,
  findNode,
  getNodes,
  getSelectedEdges,
  getSelectedNodes,
  removeSelectedNodes,
  screenToFlowCoordinate,
  setEdges,
  setNodes,
  setViewport,
  viewport,
  zoomIn,
  zoomOut,
} = useVueFlow(flowId);

const doc = editor.document;
// Decided once: fitting later, when the first node of an empty document appears, would zoom onto that node.
let fitOnInit = !doc.value.view.viewport && editor.graph.value.nodes.length > 0;
function onNodesInitialized(): void {
  if (fitOnInit) void fit({ duration: 0 });
  fitOnInit = false;
}

/** Fits nodes (all by default) into the part of the canvas that panels don't cover. */
async function fit({
  ids,
  maxZoom = 1,
  duration = 200,
}: { ids?: string[]; maxZoom?: number; duration?: number } = {}): Promise<void> {
  const shown = ids ? ids.flatMap((id) => findNode(id) ?? []) : getNodes.value;
  if (!shown.length) return;
  const box = getRectOfNodes(shown);
  const margin = 48;
  const left = (insets.left ?? 0) + margin;
  const { width, height } = dimensions.value;
  const w = Math.max(120, width - left - (insets.right ?? 0) - margin);
  const h = Math.max(120, height - 2 * margin);
  const zoom = Math.max(0.2, Math.min(maxZoom, w / box.width, h / box.height));
  await setViewport(
    {
      x: left + (w - box.width * zoom) / 2 - box.x * zoom,
      y: margin + (h - box.height * zoom) / 2 - box.y * zoom,
      zoom,
    },
    { duration },
  );
}
// Groups first, under everything; then comments; then the program's nodes. Frames aren't selectable, so a
// selection box never catches one; their headers carry their buttons instead.
const nodes = computed<Node[]>(() => [
  ...editor.groups.value.map((g) => frameNode(g, "wf-group", -1)),
  ...editor.comments.value.map((c) => frameNode(c, "wf-comment", 0)),
  ...editor.graph.value.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: { ...(doc.value.view.positions[n.id] ?? { x: 0, y: 0 }) },
  })),
]);
function frameNode(f: Frame, type: string, zIndex: number): Node {
  return {
    id: f.id,
    type,
    position: { x: f.x, y: f.y },
    selectable: false,
    dragHandle: ".wf-frame-handle",
    zIndex,
  };
}

// Edges whose ports aren't rendered (the node or port is unknown) are left out; their diagnostics list them.
const edges = computed<Edge[]>(() => {
  const a = editor.analysis.value;
  const { edges: bad } = editor.problems.value;
  const { edges: taken } = editor.traced.value;
  return editor.graph.value.edges.flatMap((e) => {
    const from = a.ports(e.from.node);
    const to = a.ports(e.to.node);
    if (!from || !to) return [];
    const exec = from.execOut.includes(e.from.port);
    if (exec ? !to.execIn.includes(e.to.port) : !from.outputs.some(([p]) => p === e.from.port))
      return [];
    if (!exec && !to.inputs.some(([p]) => p === e.to.port)) return [];
    const kind = exec ? "exec" : "data";
    return [
      {
        id: e.id,
        source: e.from.node,
        sourceHandle: handleId(kind, e.from.port),
        target: e.to.node,
        targetHandle: handleId(kind, e.to.port),
        class: {
          [`wf-edge-${kind}`]: true,
          "wf-edge-invalid": bad.has(e.id),
          "wf-edge-converted": a.convertedEdges.has(e.id),
          "wf-edge-taken": taken.has(e.id),
        },
        style: exec
          ? {}
          : { "--wf-port": typeColor(editor.types, a.typeOf(e.from.node, e.from.port, "out")) },
        animated: exec && taken.has(e.id),
      },
    ];
  });
});

// The store is set directly rather than through VueFlow's :nodes/:edges props: those pause while VueFlow
// applies its own changes (a delete, say), and a document update landing in that window was dropped.
// Nodes go first, in one watcher: VueFlow drops an edge whose node it doesn't have yet, and two watchers of
// one component run in the order they were triggered. Selection lives only in the store, so it's carried over.
watch(
  [nodes, edges],
  ([nextNodes, nextEdges]) => {
    const nodesOn = new Set(getSelectedNodes.value.map((n) => n.id));
    const edgesOn = new Set(getSelectedEdges.value.map((e) => e.id));
    setNodes(nextNodes.map((n) => ({ ...n, selected: nodesOn.has(n.id) })));
    setEdges(nextEdges.map((e) => ({ ...e, selected: edgesOn.has(e.id) })));
  },
  { immediate: true },
);

const selectedIds = computed(() => getSelectedNodes.value.map((n) => n.id));
watch(selectedIds, (ids) => (editor.selection.value = ids), { immediate: true });

// Arranging uses the nodes' rendered sizes, which only the canvas knows.
function arrangeSelected(op: ArrangeOp): void {
  const rects = selectedIds.value.flatMap((id) => {
    const n = findNode(id);
    return n ? [{ id, ...n.position, width: n.dimensions.width, height: n.dimensions.height }] : [];
  });
  editor.moveNodes(arrange(rects, op));
}
const arrangeItem = (label: string, icon: string, op: ArrangeOp, disabled = false) => ({
  label,
  icon: `i-lucide-${icon}`,
  disabled,
  onSelect: () => arrangeSelected(op),
});
const arrangeItems = computed(() => {
  const msg = m.value;
  const item = arrangeItem;
  const few = selectedIds.value.length < 3;
  return [
    [
      item(msg.alignLeft, "align-start-vertical", "left"),
      item(msg.alignCenter, "align-center-vertical", "center"),
      item(msg.alignRight, "align-end-vertical", "right"),
    ],
    [
      item(msg.alignTop, "align-start-horizontal", "top"),
      item(msg.alignMiddle, "align-center-horizontal", "middle"),
      item(msg.alignBottom, "align-end-horizontal", "bottom"),
    ],
    [
      item(msg.distributeHorizontally, "align-horizontal-space-around", "distributeX", few),
      item(msg.distributeVertically, "align-vertical-space-around", "distributeY", few),
    ],
  ];
});

async function select(ids: string[]): Promise<void> {
  removeSelectedNodes(getSelectedNodes.value);
  await nextTick();
  addSelectedNodes(ids.flatMap((id) => findNode(id) ?? []));
}

const portRef = (
  node: string,
  handle: string | null | undefined,
): { node: string; port: string } => ({
  node,
  port: portOf(handle),
});

// A wire dropped on empty canvas opens the quick-add, filtered to nodes that can take it.
let dragging: PortEnd | undefined;
let connected = false;
function onConnectStart({ nodeId, handleId: handle, handleType }: OnConnectStartParams): void {
  connected = false;
  dragging =
    nodeId && handle
      ? {
          node: nodeId,
          port: portOf(handle),
          side: handleType === "source" ? "out" : "in",
          exec: handle.startsWith("exec:"),
        }
      : undefined;
}
function onConnect(c: Connection): void {
  connected = true;
  editor.connect(portRef(c.source, c.sourceHandle), portRef(c.target, c.targetHandle));
}
function onConnectEnd(event?: MouseEvent | TouchEvent): void {
  hint.value = undefined;
  const end = dragging;
  dragging = undefined;
  if (connected || !end || !(event instanceof MouseEvent)) return;
  if ((event.target as Element | null)?.closest(".vue-flow__handle")) return;
  openQuick({ x: event.clientX, y: event.clientY }, [end]);
}

function onNodesChange(changes: NodeChange[]): void {
  const gone = changes.flatMap((c) => (c.type === "remove" ? [c.id] : []));
  if (gone.length) editor.removeNodes(gone);
  // Arrow-key nudges: a position with `dragging: false`. A drag ends without a position; see onDragStop.
  for (const c of changes)
    if (c.type === "position" && c.position && !c.dragging) editor.moveNode(c.id, c.position);
}
function onEdgesChange(changes: EdgeChange[]): void {
  const gone = changes.flatMap((c) => (c.type === "remove" ? [c.id] : []));
  if (gone.length) editor.removeEdges(gone);
}
// Dragging a group carries what lies wholly inside it (nodes, comments, smaller groups) along.
let carried = new Map<string, { start: XY; members: { id: string; start: XY }[] }>();
function onDragStart({ nodes: dragged }: NodeDragEvent): void {
  carried = new Map();
  const moving = new Set(dragged.map((n) => n.id));
  for (const g of dragged) {
    if (g.type !== "wf-group") continue;
    const { x, y } = g.position;
    const { width, height } = g.dimensions;
    const members = getNodes.value.flatMap((n) =>
      !moving.has(n.id) &&
      n.position.x >= x &&
      n.position.y >= y &&
      n.position.x + n.dimensions.width <= x + width &&
      n.position.y + n.dimensions.height <= y + height
        ? [{ id: n.id, start: { ...n.position } }]
        : [],
    );
    carried.set(g.id, { start: { x, y }, members });
  }
}
function onDrag({ nodes: dragged }: NodeDragEvent): void {
  for (const g of dragged) {
    const c = carried.get(g.id);
    if (!c) continue;
    const dx = g.position.x - c.start.x;
    const dy = g.position.y - c.start.y;
    for (const member of c.members) {
      const n = findNode(member.id);
      if (n) n.position = { x: member.start.x + dx, y: member.start.y + dy };
    }
  }
}
function onDragStop({ nodes: moved }: NodeDragEvent): void {
  const positions: Record<string, XY> = {};
  for (const n of moved) positions[n.id] = n.position;
  for (const c of carried.values())
    for (const member of c.members) {
      const n = findNode(member.id);
      if (n) positions[member.id] = n.position;
    }
  carried = new Map();
  editor.moveNodes(positions);
}

// The middle of the part panels don't cover.
function updateCenter(v: ViewportTransform): void {
  const { width, height } = dimensions.value;
  const left = insets.left ?? 0;
  const x = left + (width - left - (insets.right ?? 0)) / 2;
  editor.center.value = { x: (x - v.x) / v.zoom - 80, y: (height / 2 - v.y) / v.zoom - 40 };
}
function onViewport(v: ViewportTransform): void {
  doc.value.view.viewport = { x: v.x, y: v.y, zoom: v.zoom };
  updateCenter(v);
}

// Where the pointer last was over the canvas, in screen coordinates: paste and Tab add there.
const root = ref<HTMLElement>();
let pointer: XY | undefined;
const flowAt = (screen: XY): XY => screenToFlowCoordinate(screen);
// Nodes are placed by their top-left corner; this puts the cursor a little inside the new node.
const nodeAt = (screen: XY): XY => {
  const p = flowAt(screen);
  return { x: p.x - 20, y: p.y - 16 };
};

function onDrop(event: DragEvent): void {
  const raw = event.dataTransfer?.getData(PALETTE_MIME);
  if (!raw) return;
  const { type, init } = JSON.parse(raw) as { type: string; init?: NodeInit };
  editor.addNode(type, nodeAt({ x: event.clientX, y: event.clientY }), init);
}

// Quick-add: a node search where it was asked for, optionally wired to existing ports.
interface Quick {
  screen: XY;
  ends: PortEnd[];
  replacing?: string;
}
const quick = ref<Quick>();
const quickEntries = computed<PaletteEntry[]>(() => {
  const q = quick.value;
  if (!q) return [];
  const all = editor.entries.value;
  return q.ends.length
    ? all.filter((e) => editor.fit(e.type, e.init ?? {}, q.ends, q.replacing))
    : all;
});
const quickStyle = computed(() => {
  const q = quick.value;
  const box = root.value?.getBoundingClientRect();
  if (!q || !box) return {};
  // Kept inside the canvas: the card is 18rem wide and up to ~24rem tall.
  const x = Math.min(q.screen.x - box.left, box.width - 296);
  const y = Math.min(q.screen.y - box.top, box.height - 400);
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` };
});
function openQuick(screen: XY, ends: PortEnd[] = [], replacing?: string): void {
  quick.value = { screen, ends, ...(replacing !== undefined && { replacing }) };
}
function closeQuick(): void {
  quick.value = undefined;
  root.value?.focus({ preventScroll: true });
}
async function pick(entry: PaletteEntry): Promise<void> {
  const q = quick.value;
  if (!q) return;
  const at = nodeAt(q.screen);
  const init = entry.init ?? {};
  const id = q.ends.length
    ? editor.addWired(entry.type, at, init, q.ends, q.replacing)
    : editor.addNode(entry.type, at, init);
  closeQuick();
  if (id) await select([id]);
}

const here = (): XY => pointer ?? centerScreen();
function centerScreen(): XY {
  const box = root.value?.getBoundingClientRect();
  return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
}

async function paste(screen: XY): Promise<void> {
  const ids = await editor.pasteFromClipboard(flowAt(screen));
  if (ids.length) await select(ids);
}
async function duplicate(ids: string[]): Promise<void> {
  const copies = editor.duplicate(ids);
  if (copies.length) await select(copies);
}
async function cut(ids: string[]): Promise<void> {
  await editor.copyToClipboard(ids);
  editor.removeNodes(ids);
}
const selectAll = (): void => addSelectedNodes(getNodes.value.filter((n) => n.type === "workflow"));

// Shown where connection hints go, for a few seconds.
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notice(text: string): void {
  hint.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (hint.value = undefined), 4000);
}

function groupSelected(): void {
  const box = getRectOfNodes(getSelectedNodes.value);
  editor.addGroup({ x: box.x - 24, y: box.y - 60, width: box.width + 48, height: box.height + 84 });
}
async function makeBlock(ids: string[]): Promise<void> {
  const made = editor.makeBlock(ids);
  if ("error" in made) notice(made.error);
  else await select([made.call]);
}
const openBlock = (fn: string): void => {
  editor.graphId.value = fn;
};
const block = computed(() =>
  editor.document.value.program.functions.find((f) => f.id === editor.graphId.value),
);

// Typing in a node's fields keeps its own shortcuts and menu.
const editable = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

// Shortcuts apply while the canvas is the last thing used. They're read on the window, not the canvas: an
// edit can remove the focused element (an undo replaces every node), and focus then falls to <body>.
let active = false;
function onWindowPointerdown(event: PointerEvent): void {
  const el = event.target as Element;
  // The context menu renders outside the canvas; choosing from it keeps the canvas active.
  if (!el.closest?.("[role='menu']")) active = !!root.value?.contains(el);
}
function onWindowFocusin(event: FocusEvent): void {
  const el = event.target as Element;
  if (el === document.body || el.closest?.("[role='menu']")) return;
  if (!root.value?.contains(el)) active = false;
}
// Space held turns a left-button drag into a pan. VueFlow's own Space key doesn't (it never registers here,
// and a panOnDrag button list rejects the left button anyway), so panOnDrag is `true` while Space is down.
const spaceHeld = ref(false);
const releaseSpace = (event?: KeyboardEvent): void => {
  if (!event || event.code === "Space") spaceHeld.value = false;
};
const noSpace = (): void => releaseSpace();
onMounted(() => {
  window.addEventListener("pointerdown", onWindowPointerdown, true);
  window.addEventListener("focusin", onWindowFocusin);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", releaseSpace);
  window.addEventListener("blur", noSpace);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerdown, true);
  window.removeEventListener("focusin", onWindowFocusin);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("keyup", releaseSpace);
  window.removeEventListener("blur", noSpace);
});

function onKeydown(event: KeyboardEvent): void {
  const el = event.target as Element;
  // Focus sits in the canvas, on <body> after an edit removed the focused node, or in the menu while it fades.
  const ours = el === document.body || root.value?.contains(el) || el.closest?.("[role='menu']");
  if (!active || !ours) return;
  if (editable(event.target) || quick.value) return;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const ids = selectedIds.value;
  if (mod && key === "z") {
    if (event.shiftKey) editor.redo();
    else editor.undo();
  } else if (mod && key === "y") editor.redo();
  else if (mod && key === "c") void editor.copyToClipboard(ids);
  else if (mod && key === "x") void cut(ids);
  else if (mod && key === "v") void paste(here());
  else if (mod && key === "d") void duplicate(ids);
  else if (mod && key === "a") selectAll();
  else if (!mod && event.key === "Tab") openQuick(here());
  else if (event.key === "Escape") removeSelectedNodes(getSelectedNodes.value);
  else if (event.code === "Space") spaceHeld.value = true;
  else return;
  event.preventDefault();
  event.stopPropagation();
}

// VueFlow's pane cancels mousedown, so clicking it wouldn't focus the canvas.
function onPointerdown(event: PointerEvent): void {
  if (!root.value?.contains(document.activeElement) && !editable(event.target))
    root.value?.focus({ preventScroll: true });
}

function onDblclick(event: MouseEvent): void {
  const el = event.target as Element;
  if (editable(el)) return;
  const id = el.closest(".vue-flow__node-workflow")?.getAttribute("data-id");
  const n = id ? editor.graph.value.nodes.find((x) => x.id === id) : undefined;
  if (n?.type === "core.call" && n.ref) openBlock(n.ref);
  else if (el.closest(".vue-flow__pane") && !el.closest(".vue-flow__node, .vue-flow__edge"))
    openQuick({ x: event.clientX, y: event.clientY });
}

// Context menus: one UContextMenu around the canvas, its items built for whatever was right-clicked. They're
// built once per opening: rebuilt while open (an item's action changes the graph), the menu wouldn't close.
const menuItems = shallowRef<ContextMenuItem[][]>([]);

function targetOf(event: MouseEvent): MenuTarget {
  const el = event.target as Element;
  const at = { x: event.clientX, y: event.clientY };
  const handle =
    el.closest(".vue-flow__handle") ?? el.closest(".wf-port")?.querySelector(".vue-flow__handle");
  const node = handle?.getAttribute("data-nodeid");
  const id = handle?.getAttribute("data-handleid");
  if (handle && node && id) {
    const side = handle.classList.contains("source") ? "out" : "in";
    return {
      kind: "port",
      end: { node, port: portOf(id), side, exec: id.startsWith("exec:") },
      at,
    };
  }
  const selected = selectedIds.value;
  if (el.closest(".vue-flow__nodesselection-rect") && selected[0])
    return { kind: "node", node: selected[0], nodes: selected, at };
  // Groups and comments get the canvas's menu; their own buttons are on their headers.
  const nodeId = el.closest(".vue-flow__node-workflow")?.getAttribute("data-id");
  if (nodeId)
    return {
      kind: "node",
      node: nodeId,
      nodes: selected.includes(nodeId) ? selected : [nodeId],
      at,
    };
  const edge = el.closest(".vue-flow__edge")?.getAttribute("data-id");
  if (edge) return { kind: "edge", edge, at };
  return { kind: "pane", at };
}

function onContextmenu(event: MouseEvent): void {
  // Fields keep the browser's menu (paste, spelling): stopping here keeps the event from the trigger.
  if (editable(event.target)) {
    event.stopPropagation();
    return;
  }
  const target = targetOf(event);
  const items = itemsFor(target);
  menuItems.value = menu ? menu(target, items) : items;
}

const edgeAt = (id: string) => editor.graph.value.edges.find((e) => e.id === id);

function references(id: string): ContextMenuItem[] {
  const msg = m.value;
  const fns = editor.document.value.program.functions;
  const refs = editor.analysis.value.references(id);
  if (!refs.length) return [{ label: msg.noReferences, disabled: true }];
  return refs.map((r) => ({
    label: msg.referenceIn(
      r.graph === "main" ? msg.main : (fns.find((f) => f.id === r.graph)?.name ?? r.graph),
      editor.title(r.node),
    ),
    onSelect: () => editor.focus(r.node),
  }));
}

function itemsFor(t: MenuTarget): ContextMenuItem[][] {
  const msg = m.value;
  const history: ContextMenuItem[] = [
    {
      label: msg.undo,
      icon: "i-lucide-undo-2",
      kbds: ["meta", "z"],
      disabled: !editor.canUndo.value,
      onSelect: () => editor.undo(),
    },
    {
      label: msg.redo,
      icon: "i-lucide-redo-2",
      kbds: ["shift", "meta", "z"],
      disabled: !editor.canRedo.value,
      onSelect: () => editor.redo(),
    },
  ];
  if (t.kind === "pane")
    return [
      [
        {
          label: msg.addNode,
          icon: "i-lucide-plus",
          kbds: ["tab"],
          onSelect: () => openQuick(t.at),
        },
        {
          label: msg.addComment,
          icon: "i-lucide-sticky-note",
          onSelect: () => addComment(t.at),
        },
      ],
      [
        {
          label: msg.paste,
          icon: "i-lucide-clipboard-paste",
          kbds: ["meta", "v"],
          onSelect: () => paste(t.at),
        },
        {
          label: msg.selectAll,
          icon: "i-lucide-box-select",
          kbds: ["meta", "a"],
          disabled: !getNodes.value.length,
          onSelect: selectAll,
        },
      ],
      history,
      [{ label: msg.fitView, icon: "i-lucide-scan", onSelect: () => fit() }],
    ];
  if (t.kind === "node") {
    const n = editor.graph.value.nodes.find((x) => x.id === t.node);
    const fn =
      n?.type === "core.call"
        ? editor.document.value.program.functions.find((f) => f.id === n.ref)
        : undefined;
    const declared = n?.ref !== undefined && /^core\.(call|get|set)$/.test(n.type);
    const wired = editor.graph.value.edges.some(
      (e) => t.nodes.includes(e.from.node) || t.nodes.includes(e.to.node),
    );
    return [
      [
        {
          label: msg.copy,
          icon: "i-lucide-copy",
          kbds: ["meta", "c"],
          onSelect: () => editor.copyToClipboard(t.nodes),
        },
        {
          label: msg.cut,
          icon: "i-lucide-scissors",
          kbds: ["meta", "x"],
          onSelect: () => cut(t.nodes),
        },
        {
          label: msg.duplicate,
          icon: "i-lucide-copy-plus",
          kbds: ["meta", "d"],
          onSelect: () => duplicate(t.nodes),
        },
      ],
      [
        {
          label: msg.disconnectAll,
          icon: "i-lucide-unplug",
          disabled: !wired,
          onSelect: () => t.nodes.forEach((id) => editor.disconnect(id)),
        },
        {
          label: msg.makeBlock,
          icon: "i-lucide-puzzle",
          onSelect: () => makeBlock(t.nodes),
        },
        ...(fn
          ? [
              {
                label: msg.goToDefinition,
                icon: "i-lucide-square-arrow-out-up-right",
                onSelect: () => openBlock(fn.id),
              },
            ]
          : []),
        ...(declared
          ? [
              {
                label: msg.findReferences,
                icon: "i-lucide-list-tree",
                children: references(n.ref ?? ""),
              },
            ]
          : []),
      ],
      [
        {
          label: msg.delete,
          icon: "i-lucide-trash-2",
          color: "error",
          kbds: ["delete"],
          onSelect: () => editor.removeNodes(t.nodes),
        },
      ],
    ];
  }
  if (t.kind === "edge") {
    const e = edgeAt(t.edge);
    const exec = !!e && !!editor.ports(e.from.node)?.execOut.includes(e.from.port);
    return [
      [
        {
          label: msg.insertNode,
          icon: "i-lucide-between-horizontal-start",
          disabled: !e,
          onSelect: () =>
            e &&
            openQuick(
              t.at,
              [
                { ...e.from, side: "out", exec },
                { ...e.to, side: "in", exec },
              ],
              e.id,
            ),
        },
      ],
      [
        {
          label: msg.delete,
          icon: "i-lucide-trash-2",
          color: "error",
          onSelect: () => editor.removeEdges([t.edge]),
        },
      ],
    ];
  }
  const { end } = t;
  const edgesHere = editor.graph.value.edges.filter((e) => {
    const p = end.side === "out" ? e.from : e.to;
    return p.node === end.node && p.port === end.port;
  });
  const literal = editor.graph.value.nodes.find((x) => x.id === end.node)?.literals?.[end.port];
  return [
    [{ label: msg.addNode, icon: "i-lucide-plus", onSelect: () => openQuick(t.at, [end]) }],
    [
      {
        label: msg.disconnect,
        icon: "i-lucide-unplug",
        disabled: !edgesHere.length,
        onSelect: () => editor.disconnect(end),
      },
      ...(end.side === "in" && !end.exec && literal !== undefined
        ? [
            {
              label: msg.resetValue,
              icon: "i-lucide-rotate-ccw",
              onSelect: () => editor.setLiteral(end.node, end.port, undefined),
            },
          ]
        : []),
    ],
  ];
}

watch(editor.focused, async (request) => {
  if (!request) return;
  await nextTick();
  const n = findNode(request.node);
  if (!n) return;
  addSelectedNodes([n]);
  await fit({ ids: [request.node], maxZoom: 1.2, duration: 300 });
});
watch(editor.graphId, async () => {
  await nextTick();
  await fit();
});

// The dot grid moves and scales with the view; snapping uses the same spacing, so nodes land on the dots.
const GRID = 22;
const grid = computed(() => {
  const { x, y, zoom } = viewport.value;
  const size = GRID * zoom;
  return { backgroundSize: `${size}px ${size}px`, backgroundPosition: `${x}px ${y}px` };
});

// A closing menu would focus the canvas root; when an item opened the quick-add, its search keeps focus, and
// a new comment gets its text field.
let newComment: string | undefined;
const commentField = (id: string): HTMLElement | null | undefined =>
  root.value?.querySelector<HTMLElement>(`.vue-flow__node[data-id="${id}"] textarea`);
function refocus(event: Event): void {
  if (quick.value) event.preventDefault();
  const field = newComment && commentField(newComment);
  newComment = undefined;
  if (!field) return;
  event.preventDefault();
  field.focus();
}
function addComment(screen: XY): void {
  newComment = editor.addComment(flowAt(screen));
}
</script>
<template>
  <UContextMenu :items="menuItems" size="sm" :content="{ onCloseAutoFocus: refocus }">
    <div
      ref="root"
      class="wf-canvas relative size-full outline-none"
      tabindex="-1"
      :style="grid"
      @dragover.prevent
      @drop.prevent="onDrop"
      @pointerdown.capture="onPointerdown"
      @pointermove="pointer = { x: $event.clientX, y: $event.clientY }"
      @pointerleave="pointer = undefined"
      @dblclick="onDblclick"
      @contextmenu.capture="onContextmenu"
    >
      <VueFlow
        :id="flowId"
        :connection-mode="ConnectionMode.Strict"
        :default-viewport="doc.view.viewport ?? { x: 0, y: 0, zoom: 1 }"
        :delete-key-code="['Backspace', 'Delete']"
        :min-zoom="0.2"
        :max-zoom="2"
        :elevate-nodes-on-select="false"
        :selection-key-code="true"
        :selection-mode="SelectionMode.Partial"
        :pan-on-drag="spaceHeld || [1]"
        :pan-on-scroll="true"
        :zoom-on-double-click="false"
        :multi-selection-key-code="['Shift', 'Meta', 'Control']"
        :snap-to-grid="snap"
        :snap-grid="[GRID, GRID]"
        @connect="onConnect"
        @connect-start="onConnectStart"
        @connect-end="onConnectEnd"
        @nodes-change="onNodesChange"
        @edges-change="onEdgesChange"
        @node-drag-start="onDragStart"
        @node-drag="onDrag"
        @node-drag-stop="onDragStop"
        @viewport-change-end="onViewport"
        @pane-ready="updateCenter(viewport)"
        @nodes-initialized="onNodesInitialized"
      >
        <template #node-workflow="p">
          <slot name="node" :id="p.id" :selected="p.selected">
            <WorkflowNode :id="p.id" :selected="p.selected">
              <template v-if="$slots.widget" #widget="w"
                ><slot name="widget" v-bind="w"
              /></template>
            </WorkflowNode>
          </slot>
        </template>
        <template #node-wf-group="p"><WorkflowFrame :id="p.id" kind="group" /></template>
        <template #node-wf-comment="p"><WorkflowFrame :id="p.id" kind="comment" /></template>
      </VueFlow>

      <!-- Overlays, kept clear of panels over the canvas's edges (`insets`). -->
      <div
        class="pointer-events-none absolute inset-y-0 z-5"
        :style="{ left: `${insets.left ?? 0}px`, right: `${insets.right ?? 0}px` }"
      >
        <div
          v-if="!editor.graph.value.nodes.length"
          class="absolute inset-0 flex items-center justify-center p-6"
        >
          <div class="flex max-w-xs flex-col items-center gap-2 text-center">
            <span
              class="flex size-11 items-center justify-center rounded-full bg-elevated text-muted"
            >
              <UIcon name="i-lucide-mouse-pointer-click" class="size-5" />
            </span>
            <p class="text-sm font-medium text-highlighted">{{ m.emptyTitle }}</p>
            <p class="text-sm text-muted">{{ m.emptyHint }}</p>
          </div>
        </div>

        <div
          v-if="block"
          class="pointer-events-auto absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-default p-1 shadow-sm ring ring-default"
        >
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            class="rounded-full"
            icon="i-lucide-workflow"
            :label="m.main"
            @click="editor.graphId.value = 'main'"
          />
          <UIcon name="i-lucide-chevron-right" class="size-3.5 text-dimmed" />
          <span class="flex items-center gap-1.5 px-2 text-xs font-medium text-highlighted">
            <UIcon name="i-lucide-puzzle" class="size-3.5 text-(--wf-pink)" />
            {{ block.name }}
          </span>
        </div>

        <UBadge
          v-if="hint"
          class="absolute left-1/2 -translate-x-1/2 shadow-lg"
          :class="block ? 'top-14' : 'top-3'"
          color="error"
          size="lg"
          icon="i-lucide-circle-alert"
          :label="hint"
        />

        <div
          v-if="selectedIds.length > 1"
          class="pointer-events-auto absolute bottom-14 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-default py-1 ps-4 pe-1.5 shadow-lg ring ring-default"
        >
          <span class="pe-2 text-sm whitespace-nowrap text-muted">{{
            m.selected(selectedIds.length)
          }}</span>
          <slot name="selection" :nodes="selectedIds" />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            class="rounded-full"
            icon="i-lucide-group"
            :label="m.group"
            @click="groupSelected"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            class="rounded-full"
            icon="i-lucide-puzzle"
            :label="m.makeBlock"
            @click="makeBlock(selectedIds)"
          />
          <UDropdownMenu :items="arrangeItems" size="sm" :content="{ side: 'top' }">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              class="rounded-full"
              icon="i-lucide-layout-grid"
              trailing-icon="i-lucide-chevron-up"
              :label="m.arrange"
            />
          </UDropdownMenu>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            class="rounded-full"
            icon="i-lucide-copy-plus"
            :label="m.duplicate"
            @click="duplicate(selectedIds)"
          />
          <UButton
            color="error"
            variant="ghost"
            size="sm"
            class="rounded-full"
            icon="i-lucide-trash-2"
            :label="m.delete"
            @click="editor.removeNodes(selectedIds)"
          />
        </div>

        <UFieldGroup class="pointer-events-auto absolute bottom-3 left-3 shadow-sm">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-zoom-in"
            :aria-label="m.zoomIn"
            @click="zoomIn()"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-zoom-out"
            :aria-label="m.zoomOut"
            @click="zoomOut()"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-scan"
            :aria-label="m.fitView"
            @click="fit()"
          />
          <UButton
            :color="snap ? 'primary' : 'neutral'"
            :variant="snap ? 'soft' : 'outline'"
            size="sm"
            icon="i-lucide-magnet"
            :aria-label="m.snapToGrid"
            :aria-pressed="snap"
            @click="snap = !snap"
          />
          <UButton
            :color="minimap ? 'primary' : 'neutral'"
            :variant="minimap ? 'soft' : 'outline'"
            size="sm"
            icon="i-lucide-map"
            :aria-label="m.minimap"
            :aria-pressed="minimap"
            @click="minimap = !minimap"
          />
        </UFieldGroup>

        <WorkflowMinimap
          v-if="minimap"
          class="pointer-events-auto absolute right-3 bottom-3"
          :flow-id="flowId"
          :editor="editor"
        />
      </div>

      <WorkflowQuickAdd
        v-if="quick"
        class="absolute z-20"
        :style="quickStyle"
        :editor="editor"
        :entries="quickEntries"
        @pick="pick"
        @close="closeQuick"
      />
      <div v-if="quick" class="absolute inset-0 z-15" @pointerdown="closeQuick" />
    </div>
  </UContextMenu>
</template>
