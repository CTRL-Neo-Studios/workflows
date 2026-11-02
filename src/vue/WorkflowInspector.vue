<script setup lang="ts">
import UAlert from "@nuxt/ui/components/Alert.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import { computed } from "vue";
import { formatType, parseLabel } from "../core";
import type { WorkflowEditor } from "./editor";
import { formatValue, MODE_STYLES } from "./theme";
import WorkflowDiagnostics from "./WorkflowDiagnostics.vue";
import WorkflowSignature from "./WorkflowSignature.vue";
import WorkflowVariable from "./WorkflowVariable.vue";
import WorkflowWidget from "./WorkflowWidget.vue";

// The selected node's details and inputs, and the declaration behind a variable or block node; with nothing
// selected, the open block's signature and the workflow's capabilities and problems.
const { editor } = defineProps<{ editor: WorkflowEditor }>();
const m = editor.messages;

const selected = computed(() => editor.selection.value);
const single = computed(() => (selected.value.length === 1 ? selected.value[0] : undefined));
const node = computed(() => editor.graph.value.nodes.find((n) => n.id === single.value));
const ports = computed(() => (single.value ? editor.ports(single.value) : undefined));
const look = computed(() => editor.look(node.value?.type ?? ""));
// Core nodes are titled by their declaration (a variable's or block's name), not a sentence label.
const parts = computed(() =>
  node.value?.type.startsWith("core.")
    ? [{ text: editor.title(node.value.id) }]
    : parseLabel(ports.value?.manifest.label ?? ""),
);
const variable = computed(() => {
  const n = node.value;
  return (n?.type === "core.get" || n?.type === "core.set") && n.ref && editor.variable(n.ref)
    ? n.ref
    : undefined;
});
const block = computed(() => {
  const n = node.value;
  const open = editor.graphId.value === "main" ? undefined : editor.graphId.value;
  if (n?.type === "core.call") return n.ref;
  if (n?.type === "core.entry" || n?.type === "core.return") return open;
  return selected.value.length ? undefined : open;
});
const problems = computed(() =>
  single.value ? (editor.problems.value.nodes.get(single.value) ?? []) : [],
);
const values = computed(() =>
  single.value ? editor.traced.value.nodes.get(single.value)?.values : undefined,
);
/** The edge feeding an input, if wired. */
const source = (port: string) =>
  editor.graph.value.edges.find((e) => e.to.node === single.value && e.to.port === port)?.from;
const typeIn = (port: string) => editor.analysis.value.typeOf(single.value ?? "", port, "in");
const typeOut = (port: string) => editor.analysis.value.typeOf(single.value ?? "", port, "out");
const tint = computed(() => (look.value.color ? { "--wf-cat": look.value.color } : {}));
</script>

<template>
  <div class="flex flex-col gap-4 p-3">
    <template v-if="node && ports">
      <header class="flex items-start gap-2.5">
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-lg"
          :class="look.color ? 'wf-node-tile' : MODE_STYLES[ports.manifest.mode].tile"
          :style="tint"
        >
          <UIcon :name="look.icon" class="size-4" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-highlighted">
            <template v-for="(p, i) in parts" :key="i">
              <span v-if="'text' in p">{{ p.text }}</span>
              <span v-else class="rounded bg-elevated px-1 text-xs font-normal text-muted">{{
                ports.manifest.inputs?.[p.input]?.label ?? p.input
              }}</span>
            </template>
          </p>
          <div class="mt-1 flex flex-wrap gap-1">
            <UBadge color="neutral" variant="subtle" size="sm" :label="look.category.label" />
            <UBadge
              v-for="cap in ports.manifest.requires ?? []"
              :key="cap"
              color="neutral"
              variant="outline"
              size="sm"
              :label="cap"
            />
          </div>
        </div>
      </header>
      <p v-if="ports.manifest.description" class="text-sm text-muted">
        {{ ports.manifest.description }}
      </p>

      <section v-if="variable" class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold text-dimmed uppercase">{{ m.categoryVariables }}</h4>
        <WorkflowVariable :key="variable" :editor="editor" :id="variable" />
      </section>
      <section v-if="block" class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold text-dimmed uppercase">{{ m.block }}</h4>
        <WorkflowSignature :key="block" :editor="editor" :id="block" />
      </section>

      <UAlert
        v-for="d in problems"
        :key="d.code + d.message"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        :title="d.code"
        :description="d.message"
        :ui="{ title: 'font-mono text-xs', description: 'text-xs' }"
      />

      <section v-if="ports.inputs.length" class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold text-dimmed uppercase">{{ m.inputs }}</h4>
        <div v-for="[name, def] in ports.inputs" :key="name" class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm text-default">
              {{ def.label ?? name }}<span v-if="def.required" class="text-error">*</span>
            </span>
            <span class="truncate font-mono text-xs text-dimmed">
              {{ formatType(typeIn(name) ?? def.type) }}
            </span>
          </div>
          <UButton
            v-if="source(name)"
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-plug"
            class="self-start"
            :label="`${editor.title(source(name)!.node)} · ${source(name)!.port}`"
            @click="editor.focus(source(name)!.node)"
          />
          <WorkflowWidget
            v-else-if="editor.widgetFor(node.id, name)"
            v-bind="editor.widgetFor(node.id, name)!"
          />
        </div>
      </section>

      <section v-if="ports.outputs.length" class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold text-dimmed uppercase">{{ m.outputs }}</h4>
        <div
          v-for="[name, def] in ports.outputs"
          :key="name"
          class="flex items-center justify-between gap-2"
        >
          <span class="text-sm text-default">{{ def.label ?? name }}</span>
          <UBadge
            v-if="values?.has(name)"
            color="neutral"
            variant="soft"
            size="sm"
            class="max-w-40 font-mono"
            :label="formatValue(values.get(name), 60)"
          />
          <span v-else class="truncate font-mono text-xs text-dimmed">
            {{ formatType(typeOut(name) ?? def.type) }}
          </span>
        </div>
      </section>
    </template>

    <template v-else-if="selected.length > 1">
      <p class="text-sm font-semibold text-highlighted">{{ m.selected(selected.length) }}</p>
      <div class="flex flex-col gap-0.5">
        <UButton
          v-for="id in selected"
          :key="id"
          color="neutral"
          variant="ghost"
          size="sm"
          class="justify-start"
          :icon="editor.look(editor.graph.value.nodes.find((n) => n.id === id)?.type ?? '').icon"
          :label="editor.title(id)"
          @click="editor.focus(id)"
        />
      </div>
    </template>

    <template v-else>
      <template v-if="block">
        <p class="text-sm font-semibold text-highlighted">{{ m.block }}</p>
        <WorkflowSignature :key="block" :editor="editor" :id="block" />
      </template>
      <p class="text-sm font-semibold text-highlighted">{{ m.workflow }}</p>
      <WorkflowDiagnostics :editor="editor" />
    </template>
  </div>
</template>
