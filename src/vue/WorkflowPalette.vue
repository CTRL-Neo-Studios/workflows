<script setup lang="ts">
import { computed, ref } from "vue";
import type { NodeMode } from "../core";
import { PALETTE_MIME, type NodeInit, type WorkflowEditor } from "./editor";
import { modeColor } from "./theme";

const { editor } = defineProps<{ editor: WorkflowEditor }>();

interface Entry {
  key: string;
  type: string;
  label: string;
  mode: NodeMode;
  category: string;
  description?: string | undefined;
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
  <nav class="wf-palette">
    <input
      v-model="query"
      class="wf-input wf-palette-search"
      type="search"
      placeholder="Search nodes"
    />
    <section v-for="[category, items] in groups" :key="category" class="wf-palette-group">
      <h3>{{ category }}</h3>
      <button
        v-for="e in items"
        :key="e.key"
        type="button"
        class="wf-palette-item"
        draggable="true"
        :style="{ '--wf-accent': modeColor(e.mode) }"
        :title="e.description ?? e.type"
        @dragstart="drag($event, e)"
        @click="editor.addNode(e.type, undefined, e.init)"
      >
        <span class="wf-palette-label">{{ e.label }}</span>
        <span v-for="cap in e.requires" :key="cap" class="wf-badge wf-badge-cap">{{ cap }}</span>
        <span class="wf-palette-mode">{{ e.mode }}</span>
      </button>
    </section>
    <p v-if="!groups.length" class="wf-muted">No nodes match “{{ query }}”.</p>
  </nav>
</template>
