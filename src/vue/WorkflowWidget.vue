<script setup lang="ts">
import { computed, ref } from "vue";
import type { Json } from "../core";
import type { WidgetSlotProps } from "./editor";

// The default literal editor, picked from the type's schema. Hosts replace it through the canvas's #widget slot.
const props = defineProps<WidgetSlotProps>();

const kind = computed(() => {
  const s = props.schema;
  if (!s) return undefined;
  if (Array.isArray(s.enum)) return s.enum.length ? "enum" : undefined;
  if (s.type === "boolean") return "boolean";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "string") return "string";
  return "json";
});
const options = computed(() =>
  Array.isArray(props.schema?.enum) ? (props.schema.enum as Json[]) : [],
);
const shown = (v: Json | undefined): string =>
  v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);

// Empty text unsets the literal, so the default (or a wire) applies again.
function text(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  props.update(value === "" ? undefined : value);
}
function number(event: Event): void {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  props.update(Number.isNaN(value) ? undefined : value);
}
function choose(event: Event): void {
  const i = Number((event.target as HTMLSelectElement).value);
  props.update(i < 0 ? undefined : options.value[i]);
}
const badJson = ref(false);
function json(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  try {
    props.update(value === "" ? undefined : (JSON.parse(value) as Json));
    badJson.value = false;
  } catch {
    badJson.value = true;
  }
}
</script>

<template>
  <input
    v-if="kind === 'string'"
    class="wf-input"
    type="text"
    :value="shown(value)"
    :placeholder="shown(fallback)"
    @input="text"
  />
  <input
    v-else-if="kind === 'number'"
    class="wf-input"
    type="number"
    :step="schema?.type === 'integer' ? 1 : 'any'"
    :value="value"
    :placeholder="shown(fallback)"
    @input="number"
  />
  <input
    v-else-if="kind === 'boolean'"
    class="wf-check"
    type="checkbox"
    :checked="(value ?? fallback) === true"
    @change="update(($event.target as HTMLInputElement).checked)"
  />
  <select
    v-else-if="kind === 'enum'"
    class="wf-input"
    :value="options.findIndex((o) => JSON.stringify(o) === JSON.stringify(value))"
    @change="choose"
  >
    <option :value="-1">{{ fallback === undefined ? "—" : `${shown(fallback)} (default)` }}</option>
    <option v-for="(o, i) in options" :key="i" :value="i">{{ shown(o) }}</option>
  </select>
  <input
    v-else-if="kind === 'json'"
    class="wf-input wf-input-json"
    :class="{ 'wf-input-bad': badJson }"
    type="text"
    spellcheck="false"
    :value="shown(value)"
    :placeholder="shown(fallback) || 'JSON'"
    @change="json"
  />
</template>
