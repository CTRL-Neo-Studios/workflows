<script setup lang="ts">
import { useVueFlow } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { WorkflowEditor, XY } from "./editor";

// An overview of the graph and the visible area; pointing or dragging in it moves the view there.
const { flowId, editor } = defineProps<{ flowId: string; editor: WorkflowEditor }>();
const { getNodes, viewport, dimensions, setViewport } = useVueFlow(flowId);

const W = 200;
const H = 136;
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const visible = computed<Box>(() => {
  const { x, y, zoom } = viewport.value;
  const { width, height } = dimensions.value;
  return { x: -x / zoom, y: -y / zoom, w: width / zoom, h: height / zoom };
});
const typeOf = computed(() => new Map(editor.graph.value.nodes.map((n) => [n.id, n.type])));
const rects = computed(() =>
  getNodes.value.map((n) => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.dimensions.width || 160,
    h: n.dimensions.height || 60,
    color: editor.look(typeOf.value.get(n.id) ?? "").color,
    selected: n.selected,
  })),
);

// While dragging, the frame stays put; otherwise it would chase the view being moved.
const held = ref<Box>();
const frame = computed<Box>(() => {
  if (held.value) return held.value;
  const boxes = [...rects.value, visible.value];
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const pad = 40;
  return { x: left - pad, y: top - pad, w: right - left + 2 * pad, h: bottom - top + 2 * pad };
});
const scale = computed(() => Math.min(W / frame.value.w, H / frame.value.h));
// Centered in the map; `sx`/`sy` map flow coordinates into it.
const sx = (x: number): number =>
  (x - frame.value.x) * scale.value + (W - frame.value.w * scale.value) / 2;
const sy = (y: number): number =>
  (y - frame.value.y) * scale.value + (H - frame.value.h * scale.value) / 2;

const svg = ref<SVGSVGElement>();
function flowAt(event: PointerEvent): XY {
  const box = svg.value!.getBoundingClientRect();
  const px = ((event.clientX - box.left) / box.width) * W;
  const py = ((event.clientY - box.top) / box.height) * H;
  return {
    x: frame.value.x + (px - (W - frame.value.w * scale.value) / 2) / scale.value,
    y: frame.value.y + (py - (H - frame.value.h * scale.value) / 2) / scale.value,
  };
}
function centerOn(p: XY): void {
  const { zoom } = viewport.value;
  const { width, height } = dimensions.value;
  void setViewport({ x: width / 2 - p.x * zoom, y: height / 2 - p.y * zoom, zoom });
}
function down(event: PointerEvent): void {
  held.value = frame.value;
  svg.value?.setPointerCapture(event.pointerId);
  centerOn(flowAt(event));
}
function move(event: PointerEvent): void {
  if (held.value) centerOn(flowAt(event));
}
function up(event: PointerEvent): void {
  held.value = undefined;
  svg.value?.releasePointerCapture(event.pointerId);
}
</script>

<template>
  <svg
    ref="svg"
    class="nodrag nowheel nopan cursor-pointer rounded-lg bg-default/90 shadow-sm ring ring-default backdrop-blur"
    :viewBox="`0 0 ${W} ${H}`"
    :width="W"
    :height="H"
    @pointerdown.stop="down"
    @pointermove="move"
    @pointerup="up"
  >
    <rect
      v-for="r in rects"
      :key="r.id"
      :x="sx(r.x)"
      :y="sy(r.y)"
      :width="Math.max(2, r.w * scale)"
      :height="Math.max(2, r.h * scale)"
      rx="2"
      :style="{ fill: r.selected ? 'var(--ui-primary)' : (r.color ?? 'var(--ui-border-accented)') }"
      :fill-opacity="r.selected ? 0.9 : 0.55"
    />
    <rect
      :x="sx(visible.x)"
      :y="sy(visible.y)"
      :width="visible.w * scale"
      :height="visible.h * scale"
      rx="3"
      fill="none"
      stroke-width="1.5"
      :style="{ stroke: 'var(--ui-primary)' }"
    />
  </svg>
</template>
