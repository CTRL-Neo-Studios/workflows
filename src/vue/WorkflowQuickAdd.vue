<script setup lang="ts">
import UCommandPalette from "@nuxt/ui/components/CommandPalette.vue";
import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui";
import { computed } from "vue";
import type { PaletteEntry, WorkflowEditor } from "./editor";

// A search card for adding one node, shown where it was asked for (cursor, dropped wire, edge).
const { editor, entries } = defineProps<{ editor: WorkflowEditor; entries: PaletteEntry[] }>();
const emit = defineEmits<{ pick: [entry: PaletteEntry]; close: [] }>();

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() =>
  editor.categories.value.flatMap((c) => {
    const items = entries
      .filter((e) => e.category === c.id)
      .map((e): CommandPaletteItem => ({
        label: e.label,
        ...(e.description !== undefined && { description: e.description }),
        icon: e.icon,
        onSelect: () => emit("pick", e),
      }));
    return items.length ? [{ id: c.id, label: c.label, items }] : [];
  }),
);
</script>

<template>
  <div
    class="nodrag nowheel nopan w-72 overflow-hidden rounded-lg bg-default shadow-xl ring ring-default"
    @keydown.esc.stop.prevent="emit('close')"
    @pointerdown.stop
  >
    <UCommandPalette
      :groups="groups"
      :placeholder="editor.messages.value.searchNodes"
      autofocus
      :ui="{ content: 'max-h-80' }"
    >
      <template #empty>
        <p class="py-4 text-sm">{{ editor.messages.value.noMatches }}</p>
      </template>
    </UCommandPalette>
  </div>
</template>
