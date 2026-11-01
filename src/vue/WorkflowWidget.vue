<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import UInputNumber from "@nuxt/ui/components/InputNumber.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import USwitch from "@nuxt/ui/components/Switch.vue";
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
const shown = (v: Json | undefined): string =>
  v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);

// Select items need string values: an option's index, and `-` for "no literal".
const options = computed(() =>
  Array.isArray(props.schema?.enum) ? (props.schema.enum as Json[]) : [],
);
const items = computed(() => [
  { label: props.fallback === undefined ? "—" : `${shown(props.fallback)} (default)`, value: "-" },
  ...options.value.map((o, i) => ({ label: shown(o), value: String(i) })),
]);
const chosen = computed(() => {
  const i = options.value.findIndex((o) => JSON.stringify(o) === JSON.stringify(props.value));
  return i < 0 ? "-" : String(i);
});

const badJson = ref(false);
function json(text: string): void {
  try {
    props.update(text === "" ? undefined : (JSON.parse(text) as Json));
    badJson.value = false;
  } catch {
    badJson.value = true;
  }
}
</script>

<template>
  <!-- Empty text unsets the literal, so the default (or a wire) applies again. -->
  <UInput
    v-if="kind === 'string'"
    size="xs"
    class="w-32"
    :model-value="shown(value)"
    :placeholder="shown(fallback)"
    @update:model-value="update($event === '' ? undefined : String($event))"
  />
  <UInputNumber
    v-else-if="kind === 'number'"
    size="xs"
    class="w-28"
    :step="schema?.type === 'integer' ? 1 : 0.1"
    :model-value="typeof value === 'number' ? value : null"
    :placeholder="shown(fallback)"
    @update:model-value="update($event ?? undefined)"
  />
  <USwitch
    v-else-if="kind === 'boolean'"
    size="xs"
    :model-value="(value ?? fallback) === true"
    @update:model-value="update($event)"
  />
  <USelect
    v-else-if="kind === 'enum'"
    size="xs"
    class="w-32"
    :items="items"
    :model-value="chosen"
    @update:model-value="update($event === '-' ? undefined : options[Number($event)])"
  />
  <UInput
    v-else-if="kind === 'json'"
    size="xs"
    class="w-32 font-mono"
    :color="badJson ? 'error' : 'neutral'"
    :highlight="badJson"
    :default-value="shown(value)"
    :placeholder="shown(fallback) || 'JSON'"
    @change="json(($event.target as HTMLInputElement).value)"
  />
</template>
