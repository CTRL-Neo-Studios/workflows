<script setup lang="ts">
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UPopover from "@nuxt/ui/components/Popover.vue";
import { computed, ref } from "vue";
import { formatType } from "../core";
import { PALETTE_MIME, type CategoryView, type PaletteEntry, type WorkflowEditor } from "./editor";
import { MODE_STYLES } from "./theme";
import WorkflowVariable from "./WorkflowVariable.vue";

// The node library: a rail of categories (Scratch-style) beside a scrolling list of node cards. Variables and
// My Blocks list the document's declarations, with buttons to make new ones.
const { editor } = defineProps<{ editor: WorkflowEditor }>();
const m = editor.messages;

const query = ref("");
const matches = (text: string): boolean =>
  text.toLowerCase().includes(query.value.trim().toLowerCase());
const BUILT_IN = new Set(["core.variables", "core.functions"]);
const groups = computed<[CategoryView, PaletteEntry[]][]>(() => {
  const byCategory = new Map<string, PaletteEntry[]>();
  for (const e of editor.entries.value) {
    if (!matches(`${e.label} ${e.type} ${e.description ?? ""}`)) continue;
    byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
  }
  return editor.categories.value.flatMap((c) => {
    const items = byCategory.get(c.id);
    const shown = items ?? (BUILT_IN.has(c.id) && !query.value.trim() ? [] : undefined);
    return shown ? [[c, shown] as [CategoryView, PaletteEntry[]]] : [];
  });
});

const fn = computed(() =>
  editor.document.value.program.functions.find((f) => f.id === editor.graphId.value),
);
const variables = computed(() =>
  [
    ...(fn.value?.locals ?? []).map((decl) => ({ decl, local: true })),
    ...editor.document.value.program.variables.map((decl) => ({ decl, local: false })),
  ].filter((v) => matches(v.decl.name)),
);
const newVariableItems = computed(() => [
  [
    { label: m.value.localVariable, onSelect: () => editor.addVariable(true) },
    { label: m.value.globalVariable, onSelect: () => editor.addVariable() },
  ],
]);
function newBlock(): void {
  editor.graphId.value = editor.addFunction();
}
// A variable adds a Get; with ⌥ held, a Set.
const variableNode = (event: MouseEvent, variable: string) => ({
  type: event.altKey ? "core.set" : "core.get",
  init: { ref: variable },
});
function addVariableNode(event: MouseEvent, variable: string): void {
  const n = variableNode(event, variable);
  editor.addNode(n.type, undefined, n.init);
}

const list = ref<HTMLElement>();
const sections = new Map<string, HTMLElement>();
const current = ref<string>();
// The list is the sections' offset parent (it's `relative`), so `offsetTop` is their scroll position.
let jumpedAt = 0;
function jump(id: string): void {
  current.value = id;
  jumpedAt = Date.now();
  const el = sections.get(id);
  list.value?.scrollTo({ top: el?.offsetTop ?? 0, behavior: "smooth" });
}
// The rail marks the section at the top of the list; not while a jump scrolls there (the last sections may
// never reach the top).
function onScroll(): void {
  const box = list.value;
  if (!box || Date.now() - jumpedAt < 800) return;
  let top: string | undefined;
  for (const [c] of groups.value) {
    const el = sections.get(c.id);
    if (el && el.offsetTop <= box.scrollTop + 8) top = c.id;
  }
  current.value = top ?? groups.value[0]?.[0].id;
}

function drag(event: DragEvent, payload: { type: string; init?: PaletteEntry["init"] }): void {
  event.dataTransfer?.setData(PALETTE_MIME, JSON.stringify(payload));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
const tint = (color: string | undefined) => (color ? { "--wf-cat": color } : {});
const card =
  "flex items-start gap-2 rounded-lg bg-default p-2 text-start ring ring-default transition hover:bg-elevated/60 hover:ring-accented";
</script>

<template>
  <div class="flex h-full min-h-0">
    <nav
      class="flex w-16 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-e border-default py-2"
    >
      <button
        v-for="[c] in groups"
        :key="c.id"
        type="button"
        class="flex w-full flex-col items-center gap-1 px-1 py-1.5 text-[10px] leading-tight transition-colors"
        :class="current === c.id ? 'text-highlighted' : 'text-muted hover:text-default'"
        @click="jump(c.id)"
      >
        <span
          class="flex size-7 items-center justify-center rounded-full transition-transform"
          :class="[
            c.color ? 'wf-node-tile' : 'bg-elevated text-muted',
            current === c.id && 'scale-110',
          ]"
          :style="tint(c.color)"
        >
          <UIcon :name="c.icon ?? 'i-lucide-shapes'" class="size-4" />
        </span>
        <span class="w-full truncate text-center">{{ c.label }}</span>
      </button>
    </nav>

    <div class="flex min-w-0 flex-1 flex-col">
      <div class="p-2">
        <UInput
          v-model="query"
          icon="i-lucide-search"
          size="sm"
          class="w-full"
          :placeholder="m.searchNodes"
        />
      </div>
      <div ref="list" class="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2" @scroll="onScroll">
        <section
          v-for="[c, items] in groups"
          :key="c.id"
          :ref="(el) => el && sections.set(c.id, el as HTMLElement)"
          class="pb-3"
        >
          <h3
            class="sticky top-0 z-1 flex items-center gap-1.5 bg-default py-1 text-xs font-semibold text-highlighted"
          >
            <span class="wf-cat-dot size-2.5 rounded-full" :style="tint(c.color)" />
            {{ c.label }}
          </h3>
          <!-- Variables: the declarations themselves; get and set come from dragging or clicking one. -->
          <div v-if="c.id === 'core.variables'" class="flex flex-col gap-1.5 pt-2">
            <UDropdownMenu v-if="fn" :items="newVariableItems" size="sm">
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                icon="i-lucide-plus"
                class="self-start"
                :label="m.newVariable"
              />
            </UDropdownMenu>
            <UButton
              v-else
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              class="self-start"
              :label="m.newVariable"
              @click="editor.addVariable()"
            />
            <p v-if="variables.length" class="text-xs text-dimmed">{{ m.variableHint }}</p>
            <div v-for="v in variables" :key="v.decl.id" class="flex items-stretch gap-1">
              <button
                type="button"
                draggable="true"
                :class="[card, 'min-w-0 flex-1 items-center']"
                :title="m.variableHint"
                @dragstart="drag($event, variableNode($event, v.decl.id))"
                @click="addVariableNode($event, v.decl.id)"
              >
                <span
                  class="wf-node-tile flex size-6 shrink-0 items-center justify-center rounded-md"
                  :style="tint(c.color)"
                >
                  <UIcon name="i-lucide-variable" class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{
                  v.decl.name
                }}</span>
                <span class="truncate font-mono text-xs text-dimmed">{{
                  formatType(v.decl.type)
                }}</span>
                <UIcon v-if="v.local" name="i-lucide-house" class="size-3.5 text-dimmed" />
              </button>
              <UPopover :content="{ side: 'right', align: 'start' }">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-pencil"
                  :aria-label="m.rename"
                />
                <template #content>
                  <div class="w-72 p-3"><WorkflowVariable :editor="editor" :id="v.decl.id" /></div>
                </template>
              </UPopover>
            </div>
          </div>

          <div v-else class="flex flex-col gap-1.5 pt-2">
            <UButton
              v-if="c.id === 'core.functions'"
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              class="self-start"
              :label="m.newBlock"
              @click="newBlock"
            />
            <div v-for="e in items" :key="e.key" class="flex items-stretch gap-1">
              <button
                type="button"
                draggable="true"
                :class="[card, 'min-w-0 flex-1']"
                :title="e.type"
                @dragstart="drag($event, { type: e.type, init: e.init })"
                @click="editor.addNode(e.type, undefined, e.init)"
              >
                <span
                  class="flex size-6 shrink-0 items-center justify-center rounded-md"
                  :class="e.color ? 'wf-node-tile' : MODE_STYLES[e.mode].tile"
                  :style="tint(e.color)"
                >
                  <UIcon :name="e.icon" class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium text-highlighted">
                    <template v-for="(p, i) in e.parts" :key="i">
                      <span v-if="'text' in p">{{ p.text }}</span>
                      <span
                        v-else
                        class="rounded bg-elevated px-1 text-xs font-normal text-muted"
                        >{{ p.input }}</span
                      >
                    </template>
                  </span>
                  <span v-if="e.description" class="line-clamp-2 text-xs text-muted">
                    {{ e.description }}
                  </span>
                </span>
                <UBadge
                  v-for="cap in e.requires"
                  :key="cap"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :label="cap"
                />
              </button>
              <UButton
                v-if="e.type === 'core.call'"
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-square-arrow-out-up-right"
                :aria-label="m.open"
                @click="editor.graphId.value = e.init?.ref ?? 'main'"
              />
            </div>
          </div>
        </section>
        <p v-if="!groups.length" class="px-2 text-sm text-muted">{{ m.noMatches }}</p>
      </div>
    </div>
  </div>
</template>
