<script setup lang="ts">
import { computed } from "vue";
import type { Diagnostic } from "../core";
import type { WorkflowEditor } from "./editor";

const { editor } = defineProps<{ editor: WorkflowEditor }>();

const diagnostics = computed(() => editor.analysis.value.diagnostics);
const capabilities = computed(() => {
  const caps = editor.analysis.value.capabilities;
  return editor.manifest.capabilities.filter((c) => caps.has(c.id));
});

/** The node a diagnostic points at: its own, or an edge's source. */
function target(d: Diagnostic): string | undefined {
  if (d.at?.node) return d.at.node;
  const id = d.at?.edge;
  if (!id) return undefined;
  const doc = editor.document.value;
  for (const g of [doc.program.graph, ...doc.program.functions.map((f) => f.graph)]) {
    const e = g.edges.find((x) => x.id === id);
    if (e) return e.from.node;
  }
  return undefined;
}
function show(d: Diagnostic): void {
  const node = target(d);
  if (node) editor.focus(node);
}
</script>

<template>
  <section class="wf-diagnostics">
    <div class="wf-caps">
      <span
        v-for="c in capabilities"
        :key="c.id"
        class="wf-badge wf-badge-cap"
        :class="{ 'wf-badge-mutates': c.mutates }"
        :title="c.description ?? c.label"
        >{{ c.label }}</span
      >
      <span v-if="!capabilities.length" class="wf-muted">No capabilities needed</span>
    </div>
    <p v-if="!diagnostics.length" class="wf-ok">No problems</p>
    <ul v-else>
      <li
        v-for="(d, i) in diagnostics"
        :key="i"
        :class="`wf-diag-${d.severity}`"
        :role="target(d) ? 'button' : undefined"
        @click="show(d)"
      >
        <code>{{ d.code }}</code>
        <span>{{ d.message }}</span>
      </li>
    </ul>
  </section>
</template>
