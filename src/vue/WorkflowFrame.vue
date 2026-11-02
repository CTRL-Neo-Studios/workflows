<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UPopover from "@nuxt/ui/components/Popover.vue";
import { useVueFlow } from "@vue-flow/core";
import { computed, inject, nextTick, ref } from "vue";
import type { Comment, Group } from "../core";
import { CANVAS } from "./editor";
import { PALETTE, paletteColor } from "./theme";

// A group or a comment on the canvas. Dragged by its header (the canvas moves a group's contents with it),
// resized by its corner.
const { id, kind } = defineProps<{ id: string; kind: "group" | "comment" }>();
const ctx = inject(CANVAS);
if (!ctx) throw new Error("WorkflowFrame must be rendered inside WorkflowCanvas");
const { editor } = ctx;
const m = editor.messages;
const { viewport } = useVueFlow();

const frame = computed<(Group & Partial<Comment>) | undefined>(() =>
  kind === "group"
    ? editor.groups.value.find((g) => g.id === id)
    : editor.comments.value.find((c) => c.id === id),
);
const style = computed(() => {
  const f = frame.value;
  return f
    ? {
        width: `${f.width}px`,
        height: `${f.height}px`,
        ...(f.color && { "--wf-frame": paletteColor(f.color) }),
      }
    : {};
});

const editing = ref(false);
const input = ref<HTMLInputElement>();
async function rename(): Promise<void> {
  editing.value = true;
  await nextTick();
  input.value?.select();
}

const MIN = { width: 160, height: 72 };
function resize(start: PointerEvent): void {
  const f = frame.value;
  if (!f) return;
  const from = { x: start.clientX, y: start.clientY, width: f.width, height: f.height };
  const move = (e: PointerEvent): void => {
    const zoom = viewport.value.zoom;
    editor.updateFrame(id, {
      width: Math.max(MIN.width, Math.round(from.width + (e.clientX - from.x) / zoom)),
      height: Math.max(MIN.height, Math.round(from.height + (e.clientY - from.y) / zoom)),
    });
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <div
    v-if="frame"
    class="wf-frame group/frame relative flex flex-col"
    :class="
      kind === 'group' ? 'wf-frame-group rounded-xl' : 'wf-frame-comment rounded-lg shadow-md'
    "
    :style="style"
  >
    <div
      class="wf-frame-handle flex shrink-0 cursor-grab items-center gap-1 rounded-t-[inherit] ps-3 pe-1"
      :class="kind === 'group' ? 'h-9' : 'h-7'"
    >
      <template v-if="kind === 'group'">
        <input
          v-if="editing"
          ref="input"
          class="nodrag min-w-0 flex-1 bg-transparent text-sm font-semibold text-highlighted outline-none"
          :value="frame.label ?? ''"
          :placeholder="m.group"
          @input="editor.updateFrame(id, { label: ($event.target as HTMLInputElement).value })"
          @keydown.enter="editing = false"
          @blur="editing = false"
        />
        <span
          v-else
          class="min-w-0 flex-1 truncate text-sm font-semibold"
          :class="frame.label ? 'text-highlighted' : 'text-dimmed'"
          @dblclick.stop="rename"
          >{{ frame.label || m.group }}</span
        >
      </template>
      <span v-else class="flex-1" />
      <div
        class="nodrag flex items-center opacity-0 transition-opacity group-hover/frame:opacity-100 focus-within:opacity-100"
      >
        <UButton
          v-if="kind === 'group'"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-pencil"
          :aria-label="m.rename"
          @click="rename"
        />
        <UPopover :content="{ side: 'bottom', align: 'end' }">
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-palette"
            :aria-label="m.color"
          />
          <template #content>
            <div class="grid grid-cols-6 gap-1.5 p-2">
              <button
                type="button"
                class="size-5 rounded-full bg-elevated ring ring-accented"
                :aria-label="m.auto"
                @click="editor.updateFrame(id, { color: undefined })"
              />
              <button
                v-for="c in PALETTE"
                :key="c"
                type="button"
                class="size-5 rounded-full ring-offset-1 ring-offset-default"
                :class="frame.color === c && 'ring-2 ring-inverted'"
                :style="{ background: paletteColor(c) }"
                :aria-label="c"
                @click="editor.updateFrame(id, { color: c })"
              />
            </div>
          </template>
        </UPopover>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          :aria-label="m.delete"
          @click="editor.removeNodes([id])"
        />
      </div>
    </div>
    <textarea
      v-if="kind === 'comment'"
      class="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-3 pb-2 text-sm text-highlighted outline-none placeholder:text-dimmed"
      :value="frame.text ?? ''"
      :placeholder="m.commentPlaceholder"
      @input="editor.updateFrame(id, { text: ($event.target as HTMLTextAreaElement).value })"
    />
    <div
      class="nodrag wf-frame-resize absolute right-0 bottom-0 size-4 cursor-se-resize"
      @pointerdown.stop.prevent="resize"
    />
  </div>
</template>
