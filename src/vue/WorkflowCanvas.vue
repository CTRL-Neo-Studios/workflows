<script setup lang="ts">
import {
  ConnectionMode,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeDragEvent,
  type ViewportTransform,
} from "@vue-flow/core";
import { computed, nextTick, provide, ref, useId, watch } from "vue";
import {
  CANVAS,
  handleId,
  PALETTE_MIME,
  portOf,
  type NodeInit,
  type NodeSlotProps,
  type WidgetSlotProps,
  type WorkflowEditor,
} from "./editor";
import { typeColor } from "./theme";
import WorkflowNode from "./WorkflowNode.vue";

const { editor } = defineProps<{ editor: WorkflowEditor }>();
defineSlots<{
  /**
   * Replaces a whole node; render `WorkflowNode` inside it to keep the default body. That `WorkflowNode` takes
   * its own `#widget` slot: the canvas's `#widget` reaches only the nodes the canvas renders.
   */
  node?(props: NodeSlotProps): unknown;
  /** Replaces the literal editor of one unwired input. */
  widget?(props: WidgetSlotProps): unknown;
}>();

const hint = ref<string>();
provide(CANVAS, { editor, hint });

const flowId = useId();
const {
  addSelectedNodes,
  dimensions,
  findNode,
  fitView,
  screenToFlowCoordinate,
  setEdges,
  setNodes,
  viewport,
  zoomIn,
  zoomOut,
} = useVueFlow(flowId);

const doc = editor.document;
// Decided once: fitting later, when the first node of an empty document appears, would zoom onto that node.
const fitOnInit = !doc.value.view.viewport && editor.graph.value.nodes.length > 0;
const nodes = computed<Node[]>(() =>
  editor.graph.value.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: { ...(doc.value.view.positions[n.id] ?? { x: 0, y: 0 }) },
  })),
);

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
watch(nodes, (n) => setNodes(n), { immediate: true });
watch(edges, (e) => setEdges(e), { immediate: true });

const portRef = (
  node: string,
  handle: string | null | undefined,
): { node: string; port: string } => ({
  node,
  port: portOf(handle),
});
function onConnect(c: Connection): void {
  editor.connect(portRef(c.source, c.sourceHandle), portRef(c.target, c.targetHandle));
}
function onNodesChange(changes: NodeChange[]): void {
  const gone = changes.flatMap((c) => (c.type === "remove" ? [c.id] : []));
  if (gone.length) editor.removeNodes(gone);
}
function onEdgesChange(changes: EdgeChange[]): void {
  const gone = changes.flatMap((c) => (c.type === "remove" ? [c.id] : []));
  if (gone.length) editor.removeEdges(gone);
}
function onDragStop({ nodes: moved }: NodeDragEvent): void {
  for (const n of moved) editor.moveNode(n.id, n.position);
}

function updateCenter(v: ViewportTransform): void {
  const { width, height } = dimensions.value;
  editor.center.value = { x: (width / 2 - v.x) / v.zoom - 80, y: (height / 2 - v.y) / v.zoom - 40 };
}
function onViewport(v: ViewportTransform): void {
  doc.value.view.viewport = { x: v.x, y: v.y, zoom: v.zoom };
  updateCenter(v);
}

function onDrop(event: DragEvent): void {
  const raw = event.dataTransfer?.getData(PALETTE_MIME);
  if (!raw) return;
  const { type, init } = JSON.parse(raw) as { type: string; init?: NodeInit };
  const at = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  editor.addNode(type, { x: at.x - 20, y: at.y - 16 }, init);
}

watch(editor.focused, async (request) => {
  if (!request) return;
  await nextTick();
  const n = findNode(request.node);
  if (!n) return;
  addSelectedNodes([n]);
  await fitView({ nodes: [request.node], maxZoom: 1.2, duration: 300 });
});
watch(editor.graphId, async () => {
  await nextTick();
  await fitView({ maxZoom: 1, duration: 200 });
});

// The dot grid moves and scales with the view.
const grid = computed(() => {
  const { x, y, zoom } = viewport.value;
  const size = 22 * zoom;
  return { backgroundSize: `${size}px ${size}px`, backgroundPosition: `${x}px ${y}px` };
});
</script>
<template>
  <div class="wf-canvas" :style="grid" @dragover.prevent @drop.prevent="onDrop">
    <VueFlow
      :id="flowId"
      :connection-mode="ConnectionMode.Strict"
      :default-viewport="doc.view.viewport ?? { x: 0, y: 0, zoom: 1 }"
      :fit-view-on-init="fitOnInit"
      :delete-key-code="['Backspace', 'Delete']"
      :min-zoom="0.2"
      :max-zoom="2"
      :elevate-nodes-on-select="false"
      @connect="onConnect"
      @connect-end="hint = undefined"
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @node-drag-stop="onDragStop"
      @viewport-change-end="onViewport"
      @pane-ready="updateCenter(viewport)"
    >
      <template #node-workflow="p">
        <slot name="node" :id="p.id" :selected="p.selected">
          <WorkflowNode :id="p.id" :selected="p.selected">
            <template v-if="$slots.widget" #widget="w"><slot name="widget" v-bind="w" /></template>
          </WorkflowNode>
        </slot>
      </template>
    </VueFlow>

    <div v-if="hint" class="wf-hint">{{ hint }}</div>
    <div class="wf-controls">
      <button type="button" title="Zoom in" @click="zoomIn()">+</button>
      <button type="button" title="Zoom out" @click="zoomOut()">−</button>
      <button type="button" title="Fit view" @click="fitView({ duration: 200 })">⤢</button>
    </div>
  </div>
</template>
