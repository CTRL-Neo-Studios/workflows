<script setup lang="ts">
import { Handle, Position, type ValidConnectionFunc } from "@vue-flow/core";
import { computed, inject } from "vue";
import { formatType, isGround, t, type DataPortDef, type Json, type TypeTerm } from "../core";
import { CANVAS, handleId, portOf, type WidgetSlotProps } from "./editor";
import { formatValue, modeColor, typeColor, typeShape } from "./theme";
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
const mode = computed(() => manifest.value?.mode ?? "exec");
const problems = computed(() => editor.problems.value.nodes.get(id) ?? []);
const trace = computed(() => editor.traced.value.nodes.get(id));
const edges = computed(() => editor.graph.value.edges);
const wiredIn = computed(
  () => new Set(edges.value.filter((e) => e.to.node === id).map((e) => e.to.port)),
);
const wiredOut = computed(
  () => new Set(edges.value.filter((e) => e.from.node === id).map((e) => e.from.port)),
);

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

function widget(port: string, def: DataPortDef): WidgetSlotProps {
  const type = typeIn(port);
  return {
    node: id,
    port,
    type,
    schema: type && isGround(type) ? editor.types.schemaFor(type) : undefined,
    value: node.value?.literals?.[port],
    fallback: def.default,
    update: (value: Json | undefined) => editor.setLiteral(id, port, value),
  };
}

// Pins offered for type parameters: param-less types; a pin to anything else is shown as-is.
const groundTypes = computed(() => [
  "string",
  "number",
  "boolean",
  "any",
  ...editor.manifest.types.filter((d) => !d.params?.length).map((d) => d.id),
]);
const pinned = (name: string): string => {
  const term = node.value?.typeArgs?.[name];
  return term ? formatType(term) : "";
};
function pin(name: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  editor.setTypeArg(id, name, value ? t(value) : undefined);
}

const variadic = computed(() => manifest.value?.variadic);
const count = computed(() => node.value?.variadic ?? variadic.value?.min ?? 0);

const checkConnection: ValidConnectionFunc = (c) => {
  const problem = editor.connectionProblem(
    { node: c.source, port: portOf(c.sourceHandle) },
    { node: c.target, port: portOf(c.targetHandle) },
  );
  // The edge id in "e10: string → vertex.File" names an edge that doesn't exist yet.
  hint.value = problem && `Can't connect: ${problem.message.replace(`${problem.at?.edge}: `, "")}`;
  return !problem;
};
</script>

<template>
  <div
    class="wf-node"
    :class="[
      `wf-mode-${mode}`,
      {
        'wf-selected': selected,
        'wf-invalid': problems.length,
        'wf-ran': trace?.runs,
        'wf-faulted': trace?.fault,
      },
    ]"
    :style="{ '--wf-accent': modeColor(mode) }"
  >
    <header class="wf-node-header" :title="manifest?.description">
      <span class="wf-node-title">{{ manifest?.label ?? node?.type }}</span>
      <span class="wf-node-badges">
        <span v-if="trace?.runs" class="wf-badge wf-badge-runs" :title="`Ran ${trace.runs}×`"
          >×{{ trace.runs }}</span
        >
        <span
          v-for="cap in manifest?.requires ?? []"
          :key="cap"
          class="wf-badge wf-badge-cap"
          :title="`Needs ${cap}`"
          >{{ cap }}</span
        >
        <span
          v-if="problems.length"
          class="wf-badge wf-badge-error"
          :title="problems.map((d) => d.message).join('\n')"
          >{{ problems.length }}</span
        >
      </span>
    </header>

    <div v-if="!ports" class="wf-node-broken">
      <div v-for="d in problems" :key="d.code + d.message">{{ d.message }}</div>
    </div>

    <div v-else class="wf-node-body">
      <div class="wf-col wf-col-in">
        <div v-for="name in ports.execIn" :key="`x-${name}`" class="wf-port wf-port-exec">
          <Handle
            :id="handleId('exec', name)"
            type="target"
            :position="Position.Left"
            class="wf-handle wf-handle-exec"
            :class="{ 'wf-wired': wiredIn.has(name) }"
            :is-valid-connection="checkConnection"
          />
          <span class="wf-port-label">{{ execLabel(name) }}</span>
        </div>
        <div
          v-for="[name, def] in ports.inputs"
          :key="`d-${name}`"
          class="wf-port wf-port-data"
          :class="{ 'wf-port-invalid': portProblem(name) }"
          :style="portStyle(typeIn(name))"
          :title="portProblem(name) ?? formatType(typeIn(name) ?? def.type)"
        >
          <Handle
            v-if="def.wire !== false"
            :id="handleId('data', name)"
            type="target"
            :position="Position.Left"
            class="wf-handle wf-handle-data"
            :class="[`wf-shape-${typeShape(typeIn(name))}`, { 'wf-wired': wiredIn.has(name) }]"
            :is-valid-connection="checkConnection"
          />
          <span class="wf-port-label"
            >{{ label(name, def) }}<span v-if="def.required" class="wf-required">*</span></span
          >
          <div v-if="!wiredIn.has(name)" class="wf-port-widget nodrag nowheel">
            <slot name="widget" v-bind="widget(name, def)">
              <WorkflowWidget v-bind="widget(name, def)" />
            </slot>
          </div>
        </div>
      </div>

      <div class="wf-col wf-col-out">
        <div v-for="name in ports.execOut" :key="`x-${name}`" class="wf-port wf-port-exec">
          <span class="wf-port-label">{{ execLabel(name) }}</span>
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
          class="wf-port wf-port-data"
          :style="portStyle(typeOut(name))"
          :title="formatType(typeOut(name) ?? def.type)"
        >
          <span
            v-if="trace?.values.has(name)"
            class="wf-value"
            :title="String(formatValue(trace.values.get(name), 400))"
            >{{ formatValue(trace.values.get(name)) }}</span
          >
          <span class="wf-port-label">{{ label(name, def) }}</span>
          <Handle
            :id="handleId('data', name)"
            type="source"
            :position="Position.Right"
            class="wf-handle wf-handle-data"
            :class="[`wf-shape-${typeShape(typeOut(name))}`, { 'wf-wired': wiredOut.has(name) }]"
            :is-valid-connection="checkConnection"
          />
        </div>
      </div>
    </div>

    <footer
      v-if="ports && (manifest?.typeParams?.length || variadic)"
      class="wf-node-footer nodrag"
    >
      <label v-for="p in manifest?.typeParams ?? []" :key="p.name" class="wf-typearg">
        <span>{{ p.name }}</span>
        <select :value="pinned(p.name)" @change="pin(p.name, $event)">
          <option value="">auto</option>
          <option
            v-if="pinned(p.name) && !groundTypes.includes(pinned(p.name))"
            :value="pinned(p.name)"
          >
            {{ pinned(p.name) }}
          </option>
          <option v-for="id in groundTypes" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <span v-if="variadic" class="wf-variadic">
        <button
          type="button"
          :disabled="count <= (variadic.min ?? 0)"
          title="Remove the last port"
          @click="editor.setVariadic(id, count - 1)"
        >
          −
        </button>
        <span>{{ count }} {{ variadic.prefix }}</span>
        <button
          type="button"
          :disabled="count >= (variadic.max ?? Infinity)"
          title="Add a port"
          @click="editor.setVariadic(id, count + 1)"
        >
          +
        </button>
      </span>
    </footer>

    <div v-if="trace?.fault" class="wf-node-fault">
      {{ trace.fault.code }}: {{ trace.fault.message }}
    </div>
  </div>
</template>
