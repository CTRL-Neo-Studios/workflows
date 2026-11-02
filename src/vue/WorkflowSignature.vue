<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USwitch from "@nuxt/ui/components/Switch.vue";
import { computed, ref } from "vue";
import type { PortSide, WorkflowEditor } from "./editor";
import WorkflowTypeSelect from "./WorkflowTypeSelect.vue";

// A block's signature: name, exec or pure, inputs, outputs and exits. Renaming a port rewires what uses it.
const { editor, id } = defineProps<{ editor: WorkflowEditor; id: string }>();
const m = editor.messages;
const fn = computed(() => editor.document.value.program.functions.find((f) => f.id === id));
const uses = computed(() => editor.analysis.value.references(id).length);
const sections = computed(() => {
  const f = fn.value;
  if (!f) return [];
  const data = (side: "inputs" | "outputs", label: string) => ({
    side,
    label,
    ports: Object.entries(f[side]).map(([name, def]) => ({ name, type: def.type })),
  });
  return [
    data("inputs", m.value.inputs),
    data("outputs", m.value.outputs),
    ...(f.exec
      ? [
          {
            side: "exits" as const,
            label: m.value.exits,
            ports: (f.exits ?? ["then"]).map((name) => ({ name, type: undefined })),
          },
        ]
      : []),
  ];
});

function rename(side: PortSide, from: string, event: Event): void {
  const input = event.target as HTMLInputElement;
  if (!editor.renamePort(id, side, from, input.value)) input.value = from;
}

const confirming = ref(false);
function remove(): void {
  if (uses.value && !confirming.value) confirming.value = true;
  else editor.removeFunction(id);
}
</script>

<template>
  <div v-if="fn" class="flex flex-col gap-3">
    <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
      <span class="text-xs text-muted">{{ m.name }}</span>
      <UInput
        size="xs"
        :model-value="fn.name"
        @update:model-value="editor.updateFunction(id, { name: String($event) })"
      />
      <span class="text-xs text-muted">{{ m.execBlock }}</span>
      <USwitch
        size="xs"
        :model-value="fn.exec"
        @update:model-value="editor.updateFunction(id, { exec: $event })"
      />
    </div>

    <section v-for="s in sections" :key="s.side" class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold text-dimmed uppercase">{{ s.label }}</h4>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-plus"
          :label="m.addPort"
          @click="editor.addPort(id, s.side)"
        />
      </div>
      <div v-for="p in s.ports" :key="p.name" class="flex items-center gap-1.5">
        <UInput
          size="xs"
          class="min-w-0 flex-1 font-mono"
          :default-value="p.name"
          @change="rename(s.side, p.name, $event)"
        />
        <WorkflowTypeSelect
          v-if="p.type && s.side !== 'exits'"
          :editor="editor"
          :model-value="p.type"
          @update:model-value="
            editor.setPortType(id, s.side as 'inputs' | 'outputs', p.name, $event)
          "
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          :aria-label="m.remove"
          :disabled="s.side === 'exits' && s.ports.length < 2"
          @click="editor.removePort(id, s.side, p.name)"
        />
      </div>
    </section>

    <div class="flex flex-wrap items-center gap-1.5">
      <UButton
        v-if="editor.graphId.value !== id"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-square-arrow-out-up-right"
        :label="m.open"
        @click="editor.graphId.value = id"
      />
      <UButton
        color="error"
        variant="soft"
        size="xs"
        icon="i-lucide-trash-2"
        :label="confirming ? m.deleteAnyway : m.delete"
        @click="remove"
      />
    </div>
    <p v-if="confirming" class="text-xs text-error">{{ m.usedBy(uses) }}</p>
  </div>
</template>
