<script setup lang="ts">
import type { ContextMenuItem } from "@nuxt/ui";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed } from "vue";
import type { MenuTarget, WidgetSlotProps, WorkflowEditor } from "./editor";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import WorkflowInspector from "./WorkflowInspector.vue";
import WorkflowPalette from "./WorkflowPalette.vue";

// The whole editor: a full-bleed canvas with the node library and the inspector as floating cards over it.
const { editor, menu } = defineProps<{
  editor: WorkflowEditor;
  menu?: (target: MenuTarget, items: ContextMenuItem[][]) => ContextMenuItem[][];
}>();
const library = defineModel<boolean>("library", { default: true });
const inspector = defineModel<boolean>("inspector", { default: true });
const snap = defineModel<boolean>("snap", { default: false });
const minimap = defineModel<boolean>("minimap", { default: false });
defineSlots<{
  /** Buttons at the top right, beside the inspector's toggle (e.g. Run). */
  toolbar?(): unknown;
  /** More content at the bottom of the inspector card (e.g. run results). */
  inspector?(): unknown;
  widget?(props: WidgetSlotProps): unknown;
  selection?(props: { nodes: string[] }): unknown;
}>();

const m = editor.messages;
// Card widths (w-72, w-80) plus their 0.75rem margin, so the canvas keeps its controls clear of them.
const insets = computed(() => ({
  left: library.value ? 300 : 0,
  right: inspector.value ? 332 : 0,
}));
const card =
  "pointer-events-auto min-h-0 flex-1 overflow-hidden rounded-xl bg-default/95 shadow-lg ring ring-default backdrop-blur";
</script>

<template>
  <div class="relative size-full overflow-hidden">
    <WorkflowCanvas
      v-model:snap="snap"
      v-model:minimap="minimap"
      class="absolute inset-0"
      :editor="editor"
      :menu="menu"
      :insets="insets"
    >
      <template v-if="$slots.widget" #widget="w"><slot name="widget" v-bind="w" /></template>
      <template v-if="$slots.selection" #selection="s"
        ><slot name="selection" v-bind="s"
      /></template>
    </WorkflowCanvas>

    <div class="pointer-events-none absolute inset-y-3 left-3 z-10 flex w-72 flex-col gap-2">
      <div class="pointer-events-auto self-start">
        <UButton
          :color="library ? 'primary' : 'neutral'"
          :variant="library ? 'soft' : 'outline'"
          size="sm"
          icon="i-lucide-panel-left"
          :label="m.library"
          :aria-pressed="library"
          :class="['shadow-sm', !library && 'bg-default']"
          @click="library = !library"
        />
      </div>
      <div v-if="library" :class="card">
        <WorkflowPalette :editor="editor" />
      </div>
    </div>

    <div class="pointer-events-none absolute inset-y-3 right-3 z-10 flex w-80 flex-col gap-2">
      <div class="pointer-events-auto flex items-center justify-end gap-1.5">
        <slot name="toolbar" />
        <UButton
          :color="inspector ? 'primary' : 'neutral'"
          :variant="inspector ? 'soft' : 'outline'"
          size="sm"
          icon="i-lucide-panel-right"
          :label="m.inspector"
          :aria-pressed="inspector"
          :class="['shadow-sm', !inspector && 'bg-default']"
          @click="inspector = !inspector"
        />
      </div>
      <div v-if="inspector" :class="[card, 'overflow-y-auto']">
        <WorkflowInspector :editor="editor" />
        <slot name="inspector" />
      </div>
    </div>
  </div>
</template>
