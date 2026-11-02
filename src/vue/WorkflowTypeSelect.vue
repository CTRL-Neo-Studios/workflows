<script setup lang="ts">
import USelectMenu from "@nuxt/ui/components/SelectMenu.vue";
import { computed } from "vue";
import { formatType, t, type TypeTerm } from "../core";
import type { WorkflowEditor } from "./editor";

// Param-less types and Lists of them; a current type outside those is offered as-is.
const { editor, modelValue } = defineProps<{ editor: WorkflowEditor; modelValue: TypeTerm }>();
const emit = defineEmits<{ "update:modelValue": [TypeTerm] }>();

const terms = computed(() => {
  const ids = [
    "string",
    "number",
    "boolean",
    "any",
    ...editor.manifest.types.filter((d) => !d.params?.length).map((d) => d.id),
  ];
  const all: TypeTerm[] = [...ids.map((id) => t(id)), ...ids.map((id) => t("List", t(id)))];
  const current = formatType(modelValue);
  return all.some((x) => formatType(x) === current) ? all : [modelValue, ...all];
});
const items = computed(() => terms.value.map((x) => formatType(x)));
function pick(label: string): void {
  const term = terms.value.find((x) => formatType(x) === label);
  if (term) emit("update:modelValue", term);
}
</script>

<template>
  <USelectMenu
    size="xs"
    class="w-36 font-mono"
    :items="items"
    :model-value="formatType(modelValue)"
    @update:model-value="pick(String($event))"
  />
</template>
