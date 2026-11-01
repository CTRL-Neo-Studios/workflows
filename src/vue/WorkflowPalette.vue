<script setup lang="ts">
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import { computed, ref } from "vue";
import type { NodeMode } from "../core";
import { PALETTE_MIME, type NodeInit, type WorkflowEditor } from "./editor";
import { MODE_STYLES } from "./theme";

const { editor } = defineProps<{ editor: WorkflowEditor }>();

interface Entry {
  key: string;
  type: string;
  label: string;
  mode: NodeMode;
  category: string;
  description?: string | undefined;
  icon?: string | undefined;
  requires: string[];
  init?: NodeInit;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Language nodes, plus the core nodes that fit the current graph: variable get/set, calls, and a function's
// entry and return while it has none.
const entries = computed<Entry[]>(() => {
  const doc = editor.document.value;
  const fn = doc.program.functions.find((f) => f.id === editor.graphId.value);
  const list: Entry[] = editor.manifest.nodes
    .filter((m) => m.mode !== "event" || !fn)
    .map((m) => ({
      key: m.type,
      type: m.type,
      label: m.label,
      mode: m.mode,
      category:
        m.category ?? (m.mode === "event" ? "Events" : titleCase(m.type.split(".")[0] ?? "")),
      description: m.description,
      icon: m.icon,
      requires: m.requires ?? [],
    }));
  const core = (e: Omit<Entry, "key" | "requires">): void => {
    list.push({ ...e, key: `${e.type}:${e.init?.ref ?? ""}`, requires: [] });
  };
  for (const v of [...(fn?.locals ?? []), ...doc.program.variables]) {
    const init = { ref: v.id };
    core({ type: "core.get", label: `Get ${v.name}`, mode: "pure", category: "Variables", init });
    core({ type: "core.set", label: `Set ${v.name}`, mode: "exec", category: "Variables", init });
  }
  for (const f of doc.program.functions) {
    const mode = f.exec ? "exec" : "pure";
    core({ type: "core.call", label: f.name, mode, category: "Functions", init: { ref: f.id } });
  }
  if (fn) {
    for (const [type, label] of [
      ["core.entry", "Entry"],
      ["core.return", "Return"],
    ] as const) {
      if (fn.graph.nodes.some((n) => n.type === type)) continue;
      core({
        type,
        label,
        mode: fn.exec ? (type === "core.entry" ? "event" : "exec") : "pure",
        category: "Function",
      });
    }
  }
  return list;
});

const query = ref("");
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const byCategory = new Map<string, Entry[]>();
  for (const e of entries.value) {
    const text = `${e.label} ${e.type} ${e.category} ${e.description ?? ""}`.toLowerCase();
    if (q && !text.includes(q)) continue;
    byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
  }
  return [...byCategory];
});

function drag(event: DragEvent, e: Entry): void {
  event.dataTransfer?.setData(PALETTE_MIME, JSON.stringify({ type: e.type, init: e.init }));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
</script>

<template>
  <nav class="flex flex-col gap-3 p-3">
    <UInput v-model="query" icon="i-lucide-search" size="sm" placeholder="Search nodes" />
    <section v-for="[category, items] in groups" :key="category" class="flex flex-col gap-0.5">
      <p class="px-2 pb-1 text-xs font-medium text-dimmed">{{ category }}</p>
      <UButton
        v-for="e in items"
        :key="e.key"
        color="neutral"
        variant="ghost"
        size="sm"
        block
        class="justify-start"
        draggable="true"
        :title="e.description ?? e.type"
        @dragstart="drag($event, e)"
        @click="editor.addNode(e.type, undefined, e.init)"
      >
        <template #leading>
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded"
            :class="MODE_STYLES[e.mode].tile"
          >
            <UIcon :name="e.icon ?? MODE_STYLES[e.mode].icon" class="size-3" />
          </span>
        </template>
        <span class="truncate">{{ e.label }}</span>
        <template #trailing>
          <span class="ms-auto flex gap-1">
            <UBadge
              v-for="cap in e.requires"
              :key="cap"
              color="neutral"
              variant="outline"
              size="sm"
              :label="cap"
            />
          </span>
        </template>
      </UButton>
    </section>
    <p v-if="!groups.length" class="px-2 text-sm text-muted">No nodes match “{{ query }}”.</p>
  </nav>
</template>
