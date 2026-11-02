<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import { computed, ref } from "vue";
import { isGround } from "../core";
import type { WidgetSlotProps, WorkflowEditor } from "./editor";
import WorkflowTypeSelect from "./WorkflowTypeSelect.vue";
import WorkflowWidget from "./WorkflowWidget.vue";

// One variable's declaration: name, type, default; deleting it asks first while nodes use it.
const { editor, id } = defineProps<{ editor: WorkflowEditor; id: string }>();
const m = editor.messages;
const decl = computed(() => editor.variable(id)?.decl);
const uses = computed(() => editor.analysis.value.references(id).length);

const widget = computed<WidgetSlotProps | undefined>(() => {
  const v = decl.value;
  if (!v) return undefined;
  return {
    node: "",
    port: "",
    type: v.type,
    schema: isGround(v.type) ? editor.types.schemaFor(v.type) : undefined,
    value: v.default,
    fallback: undefined,
    update: (value) => editor.updateVariable(id, { default: value }),
    messages: m.value,
  };
});

const confirming = ref(false);
function remove(): void {
  if (uses.value && !confirming.value) confirming.value = true;
  else editor.removeVariable(id);
}
</script>

<template>
  <div v-if="decl" class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
    <span class="text-xs text-muted">{{ m.name }}</span>
    <UInput
      size="xs"
      :model-value="decl.name"
      @update:model-value="editor.updateVariable(id, { name: String($event) })"
    />
    <span class="text-xs text-muted">{{ m.type }}</span>
    <WorkflowTypeSelect
      :editor="editor"
      :model-value="decl.type"
      @update:model-value="editor.updateVariable(id, { type: $event })"
    />
    <template v-if="widget?.schema">
      <span class="text-xs text-muted">{{ m.defaultLabel }}</span>
      <div><WorkflowWidget v-bind="widget" /></div>
    </template>
    <p v-if="confirming" class="col-span-2 text-xs text-error">{{ m.usedBy(uses) }}</p>
    <UButton
      class="col-span-2 justify-self-start"
      color="error"
      variant="soft"
      size="xs"
      icon="i-lucide-trash-2"
      :label="confirming ? m.deleteAnyway : m.delete"
      @click="remove"
    />
  </div>
</template>
