<script setup lang="ts">
import UAlert from "@nuxt/ui/components/Alert.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { computed } from "vue";
import type { Diagnostic } from "../core";
import type { WorkflowEditor } from "./editor";

const { editor } = defineProps<{ editor: WorkflowEditor }>();
const m = editor.messages;

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
  <section class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-1">
      <UTooltip v-for="c in capabilities" :key="c.id" :text="c.description ?? c.label">
        <UBadge
          :color="c.mutates ? 'warning' : 'neutral'"
          variant="subtle"
          :icon="c.mutates ? 'i-lucide-pencil' : 'i-lucide-eye'"
          :label="c.label"
        />
      </UTooltip>
      <span v-if="!capabilities.length" class="text-xs text-muted">{{ m.noCapabilities }}</span>
    </div>
    <UAlert
      v-if="!diagnostics.length"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="m.noProblems"
    />
    <div
      v-for="(d, i) in diagnostics"
      :key="i"
      :role="target(d) ? 'button' : undefined"
      :class="target(d) ? 'cursor-pointer' : ''"
      @click="show(d)"
    >
      <UAlert
        :color="d.severity === 'error' ? 'error' : 'warning'"
        variant="subtle"
        :icon="d.severity === 'error' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'"
        :title="d.code"
        :description="d.message"
        :ui="{ title: 'font-mono text-xs', description: 'text-xs' }"
      />
    </div>
  </section>
</template>
