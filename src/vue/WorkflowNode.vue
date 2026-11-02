<script setup lang="ts">
import UAlert from "@nuxt/ui/components/Alert.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UCard from "@nuxt/ui/components/Card.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import UInputNumber from "@nuxt/ui/components/InputNumber.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { Handle, Position, type ValidConnectionFunc } from "@vue-flow/core";
import { computed, inject } from "vue";
import { formatType, parseLabel, t, type DataPortDef, type TypeTerm } from "../core";
import { CANVAS, handleId, portOf, type WidgetSlotProps } from "./editor";
import { formatValue, MODE_STYLES, typeColor, typeShape } from "./theme";
import WorkflowWidget from "./WorkflowWidget.vue";

const { id, selected = false } = defineProps<{ id: string; selected?: boolean }>();
defineSlots<{ widget?(props: WidgetSlotProps): unknown }>();

const ctx = inject(CANVAS);
if (!ctx) throw new Error("WorkflowNode must be rendered inside WorkflowCanvas");
const { editor, hint } = ctx;

const node = computed(() => editor.graph.value.nodes.find((n) => n.id === id));
const ports = computed(() => editor.ports(id));
const manifest = computed(
  () => ports.value?.manifest ?? editor.manifest.nodes.find((m) => m.type === node.value?.type),
);
const style = computed(() => MODE_STYLES[manifest.value?.mode ?? "exec"]);
const look = computed(() => editor.look(node.value?.type ?? ""));
// A sentence label ('Rename {file} to {newName}') puts those inputs' editors in the header. Core nodes are
// titled by their declaration.
const parts = computed(() =>
  node.value?.type.startsWith("core.")
    ? [{ text: editor.title(id) }]
    : parseLabel(manifest.value?.label ?? node.value?.type ?? ""),
);
const inline = computed(() => new Set(parts.value.flatMap((p) => ("input" in p ? [p.input] : []))));
const inputDef = (name: string): DataPortDef | undefined =>
  ports.value?.inputs.find(([n]) => n === name)?.[1];
const problems = computed(() => editor.problems.value.nodes.get(id) ?? []);
const trace = computed(() => editor.traced.value.nodes.get(id));
const edges = computed(() => editor.graph.value.edges);
const wiredIn = computed(
  () => new Set(edges.value.filter((e) => e.to.node === id).map((e) => e.to.port)),
);
const wiredOut = computed(
  () => new Set(edges.value.filter((e) => e.from.node === id).map((e) => e.from.port)),
);

// The card's ring carries the node's state; later entries win.
const ring = computed(() => {
  if (trace.value?.fault) return "ring-2 ring-error shadow-lg shadow-error/25";
  if (selected) return "ring-2 ring-primary";
  if (problems.value.length) return "ring-error";
  if (trace.value?.runs) return "ring-success shadow-lg shadow-success/20";
  return "";
});

const typeIn = (port: string): TypeTerm | undefined => editor.analysis.value.typeOf(id, port, "in");
const typeOut = (port: string): TypeTerm | undefined =>
  editor.analysis.value.typeOf(id, port, "out");
const portStyle = (term: TypeTerm | undefined): Record<string, string> => ({
  "--wf-port": typeColor(editor.types, term),
});
const portProblem = (port: string): string | undefined =>
  problems.value.find((d) => d.at?.port === port)?.message;
const label = (name: string, def: DataPortDef): string => def.label ?? name;
// The default exec ports carry no information beyond their arrow.
const execLabel = (name: string): string => (name === "exec" || name === "then" ? "" : name);

// Rendered only for inputs the node has, so the props exist.
const widget = (port: string): WidgetSlotProps => editor.widgetFor(id, port)!;

// Pins offered for type parameters: param-less types; a pin to anything else is shown as-is.
// Select items can't use an empty value, so `*` stands for "inferred".
const AUTO = "*";
function pinItems(name: string): { label: string; value: string }[] {
  const ids = [
    "string",
    "number",
    "boolean",
    "any",
    ...editor.manifest.types.filter((d) => !d.params?.length).map((d) => d.id),
  ];
  const current = pinned(name);
  if (current !== AUTO && !ids.includes(current)) ids.unshift(current);
  return [
    { label: editor.messages.value.auto, value: AUTO },
    ...ids.map((x) => ({ label: x, value: x })),
  ];
}
function pinned(name: string): string {
  const term = node.value?.typeArgs?.[name];
  return term ? formatType(term) : AUTO;
}
function pin(name: string, value: string): void {
  if (value !== pinned(name)) editor.setTypeArg(id, name, value === AUTO ? undefined : t(value));
}

const variadic = computed(() => manifest.value?.variadic);
const count = computed(() => node.value?.variadic ?? variadic.value?.min ?? 0);
// A return in a block with several exits picks the one it leaves through.
const exits = computed(() => {
  if (node.value?.type !== "core.return") return [];
  const fn = editor.document.value.program.functions.find((f) => f.id === editor.graphId.value);
  return fn?.exec && fn.exits && fn.exits.length > 1 ? fn.exits : [];
});

const checkConnection: ValidConnectionFunc = (c) => {
  const problem = editor.connectionProblem(
    { node: c.source, port: portOf(c.sourceHandle) },
    { node: c.target, port: portOf(c.targetHandle) },
  );
  // The edge id in "e10: string → vertex.File" names an edge that doesn't exist yet.
  hint.value =
    problem &&
    editor.messages.value.cantConnect(problem.message.replace(`${problem.at?.edge}: `, ""));
  return !problem;
};
</script>

<template>
  <UCard
    class="wf-node"
    :style="look.color ? { '--wf-cat': look.color } : {}"
    :ui="{
      root: ['min-w-44 max-w-112 overflow-visible transition-shadow', ring],
      header: [
        'rounded-t-[calc(var(--ui-radius)*2)] px-3 py-2 sm:px-3',
        look.color && 'wf-node-header',
      ],
      body: 'px-3 py-1.5 sm:px-3 sm:py-1.5',
      footer: 'px-3 py-2 sm:px-3',
    }"
  >
    <template #header>
      <div class="flex items-center gap-2" :title="manifest?.description">
        <span
          class="flex size-6 shrink-0 items-center justify-center self-start rounded-md"
          :class="look.color ? 'wf-node-tile' : style.tile"
        >
          <UIcon :name="look.icon" class="size-3.5" />
        </span>
        <span
          class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium text-highlighted"
        >
          <template v-for="(p, i) in parts" :key="i">
            <span v-if="'text' in p" class="whitespace-pre-wrap">{{ p.text.trim() }}</span>
            <template v-else-if="inputDef(p.input)">
              <UBadge
                v-if="wiredIn.has(p.input)"
                color="neutral"
                variant="soft"
                size="sm"
                icon="i-lucide-plug"
                :label="label(p.input, inputDef(p.input)!)"
              />
              <span v-else class="nodrag nowheel inline-flex font-normal">
                <slot name="widget" v-bind="widget(p.input)">
                  <WorkflowWidget v-bind="widget(p.input)" />
                </slot>
              </span>
            </template>
            <span v-else class="text-muted">{{ "{" + p.input + "}" }}</span>
          </template>
        </span>
        <UBadge
          v-if="trace?.runs"
          color="success"
          variant="subtle"
          size="sm"
          :label="`×${trace.runs}`"
        />
        <UBadge
          v-for="cap in manifest?.requires ?? []"
          :key="cap"
          color="neutral"
          variant="outline"
          size="sm"
          :label="cap"
        />
        <UTooltip v-if="problems.length" :text="problems.map((d) => d.message).join('\n')">
          <UBadge
            color="error"
            variant="solid"
            size="sm"
            icon="i-lucide-circle-alert"
            :label="problems.length"
          />
        </UTooltip>
      </div>
    </template>

    <div v-if="!ports" class="py-1 text-xs text-error">
      <p v-for="d in problems" :key="d.code + d.message">{{ d.message }}</p>
    </div>

    <div v-else class="flex justify-between gap-5">
      <div class="flex min-w-0 flex-col gap-0.5">
        <div
          v-for="name in ports.execIn"
          :key="`x-${name}`"
          class="wf-port wf-port-in relative flex min-h-7 items-center gap-1.5"
        >
          <Handle
            :id="handleId('exec', name)"
            type="target"
            :position="Position.Left"
            class="wf-handle wf-handle-exec"
            :class="{ 'wf-wired': wiredIn.has(name) }"
            :is-valid-connection="checkConnection"
          />
          <span class="text-xs text-muted">{{ execLabel(name) }}</span>
        </div>
        <!-- Inputs shown in a sentence label keep their row for the wire, without a second editor; settings
             (no wire) in the sentence need no row at all. -->
        <div
          v-for="[name, def] in ports.inputs.filter(([n, d]) => !inline.has(n) || d.wire !== false)"
          :key="`d-${name}`"
          class="wf-port wf-port-in relative flex min-h-7 items-center gap-1.5"
          :style="portStyle(typeIn(name))"
        >
          <Handle
            v-if="def.wire !== false"
            :id="handleId('data', name)"
            type="target"
            :position="Position.Left"
            class="wf-handle wf-handle-data"
            :class="[`wf-shape-${typeShape(typeIn(name))}`, { 'wf-wired': wiredIn.has(name) }]"
            v-bind="{ title: formatType(typeIn(name) ?? def.type) }"
            :is-valid-connection="checkConnection"
          />
          <UTooltip :text="portProblem(name) ?? formatType(typeIn(name) ?? def.type)">
            <span
              class="text-xs whitespace-nowrap"
              :class="portProblem(name) ? 'text-error underline decoration-wavy' : 'text-toned'"
            >
              {{ label(name, def) }}<span v-if="def.required" class="text-error">*</span>
            </span>
          </UTooltip>
          <div v-if="!wiredIn.has(name) && !inline.has(name)" class="nodrag nowheel">
            <slot name="widget" v-bind="widget(name)">
              <WorkflowWidget v-bind="widget(name)" />
            </slot>
          </div>
        </div>
      </div>

      <div class="flex min-w-0 flex-col items-end gap-0.5">
        <div
          v-for="name in ports.execOut"
          :key="`x-${name}`"
          class="wf-port wf-port-out relative flex min-h-7 items-center gap-1.5"
        >
          <span class="text-xs text-muted">{{ execLabel(name) }}</span>
          <Handle
            :id="handleId('exec', name)"
            type="source"
            :position="Position.Right"
            class="wf-handle wf-handle-exec"
            :class="{ 'wf-wired': wiredOut.has(name) }"
            :is-valid-connection="checkConnection"
          />
        </div>
        <div
          v-for="[name, def] in ports.outputs"
          :key="`d-${name}`"
          class="wf-port wf-port-out relative flex min-h-7 items-center gap-1.5"
          :style="portStyle(typeOut(name))"
        >
          <UTooltip v-if="trace?.values.has(name)" :text="formatValue(trace.values.get(name), 400)">
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
              class="max-w-32 font-mono"
              :label="formatValue(trace.values.get(name))"
            />
          </UTooltip>
          <UTooltip :text="formatType(typeOut(name) ?? def.type)">
            <span class="text-xs whitespace-nowrap text-toned">{{ label(name, def) }}</span>
          </UTooltip>
          <Handle
            :id="handleId('data', name)"
            type="source"
            :position="Position.Right"
            class="wf-handle wf-handle-data"
            :class="[`wf-shape-${typeShape(typeOut(name))}`, { 'wf-wired': wiredOut.has(name) }]"
            v-bind="{ title: formatType(typeOut(name) ?? def.type) }"
            :is-valid-connection="checkConnection"
          />
        </div>
      </div>
    </div>

    <UAlert
      v-if="trace?.fault"
      class="mt-1.5 mb-1 w-0 min-w-full"
      color="error"
      variant="subtle"
      icon="i-lucide-octagon-alert"
      :title="trace.fault.code"
      :description="trace.fault.message"
      :ui="{ root: 'p-2 gap-2', title: 'text-xs', description: 'text-xs', icon: 'size-4' }"
    />

    <template v-if="ports && (manifest?.typeParams?.length || variadic || exits.length)" #footer>
      <div class="nodrag flex flex-wrap items-center gap-2">
        <USelect
          v-if="exits.length"
          size="xs"
          class="w-32"
          :items="exits"
          :model-value="node?.ref ?? exits[0] ?? ''"
          @update:model-value="editor.setRef(id, String($event))"
        />
        <div
          v-for="p in manifest?.typeParams ?? []"
          :key="p.name"
          class="flex items-center gap-1.5"
        >
          <span class="font-mono text-xs font-semibold text-secondary">{{ p.name }}</span>
          <USelect
            size="xs"
            class="w-28"
            :items="pinItems(p.name)"
            :model-value="pinned(p.name)"
            @update:model-value="pin(p.name, String($event))"
          />
        </div>
        <div v-if="variadic" class="flex items-center gap-1.5">
          <span class="text-xs text-muted">{{ variadic.prefix }}</span>
          <UInputNumber
            size="xs"
            class="w-24"
            :min="variadic.min ?? 0"
            :max="variadic.max ?? 1024"
            :model-value="count"
            @update:model-value="editor.setVariadic(id, $event ?? count)"
          />
        </div>
      </div>
    </template>
  </UCard>
</template>
