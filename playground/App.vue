<script setup lang="ts">
import { useColorMode } from "@vueuse/core";
import UAlert from "@nuxt/ui/components/Alert.vue";
import UApp from "@nuxt/ui/components/App.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UCollapsible from "@nuxt/ui/components/Collapsible.vue";
import { computed, reactive, ref } from "vue";
import { CompileError, type DocumentV1, type RunResult } from "../src/core";
import { archiveDrafts, vertex, type VertexEffects } from "../src/core/fixtures/section10";
import { buildDocument, formatTrace, record, run } from "../src/core/testing";
import {
  useWorkflowEditor,
  WorkflowCanvas,
  WorkflowDiagnostics,
  WorkflowPalette,
} from "../src/vue";

// The §10 language against an in-memory vault.
interface VaultFile {
  path: string;
  tags: string[];
  props: Record<string, unknown>;
}
const freshVault = (): VaultFile[] => [
  { path: "/v/a.md", tags: ["draft"], props: {} },
  { path: "/v/b.md", tags: ["draft", "idea"], props: {} },
  { path: "/v/c.md", tags: ["published"], props: { status: "live" } },
];
const vault = reactive<VaultFile[]>(freshVault());
const file = (path: string): VaultFile => {
  const f = vault.find((x) => x.path === path);
  if (!f) throw new Error(`No file ${path}`);
  return f;
};
const effects: VertexEffects = {
  index: { byTag: async (tag) => vault.filter((f) => f.tags.includes(tag)).map((f) => f.path) },
  fs: {
    async rename(path, newName) {
      const dir = path.slice(0, path.lastIndexOf("/") + 1);
      const ext = /\.[^./]*$/.exec(path)?.[0] ?? "";
      const f = file(path);
      f.path = `${dir}${newName}${ext}`;
      return f.path;
    },
    async setProperty(path, key, value) {
      file(path).props[key] = value;
    },
  },
};

const empty = (): DocumentV1 => buildDocument(vertex, { nodes: {} });
// §10 as the spec draws it, left to right.
function example(): DocumentV1 {
  const doc = archiveDrafts();
  doc.view.positions = {
    n1: { x: 0, y: 40 },
    n2: { x: 0, y: 200 },
    n3: { x: 380, y: 60 },
    n4: { x: 400, y: 320 },
    n6: { x: 640, y: 320 },
    n5: { x: 940, y: 40 },
    n7: { x: 1260, y: 40 },
  };
  return doc;
}

const editor = useWorkflowEditor(vertex.manifest, empty());
const canvasKey = ref(0);
function load(doc: DocumentV1): void {
  editor.document.value = doc;
  canvasKey.value++; // a fresh canvas fits the new document into view
  result.value = undefined;
  log.value = [];
}

const result = ref<RunResult>();
const log = ref<string[]>([]);
const error = ref<string>();
const running = ref(false);
async function start(): Promise<void> {
  running.value = true;
  error.value = undefined;
  try {
    const rec = record(effects);
    const doc = editor.snapshot();
    const out = await run(vertex, doc, {
      event: "vertex.onManual",
      effects: rec.effects,
      trace: "values",
    });
    result.value = out.result;
    log.value = rec.log();
    editor.trace.value = out.trace;
  } catch (e) {
    error.value = e instanceof CompileError ? "Fix the problems first." : String(e);
  } finally {
    running.value = false;
  }
}
function resetVault(): void {
  vault.splice(0, vault.length, ...freshVault());
}

const traceLines = computed(() => formatTrace(editor.trace.value));
const json = computed(() => JSON.stringify(editor.document.value, null, 2));
const mode = useColorMode();
</script>

<template>
  <UApp>
    <div
      class="grid h-dvh grid-cols-[15rem_1fr_22rem] grid-rows-[auto_1fr] bg-default text-default"
    >
      <header class="col-span-3 flex items-center gap-2 border-b border-default px-4 py-2">
        <span class="me-3 text-sm font-semibold text-highlighted">
          Workflows <span class="font-normal text-muted">playground</span>
        </span>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-file-plus"
          label="New"
          @click="load(empty())"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-book-open"
          label="Load §10 example"
          @click="load(example())"
        />
        <span class="flex-1" />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="mode === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun'"
          aria-label="Toggle color mode"
          @click="mode = mode === 'dark' ? 'light' : 'dark'"
        />
        <UButton
          size="sm"
          icon="i-lucide-play"
          label="Run “On Run”"
          :loading="running"
          @click="start"
        />
      </header>

      <aside class="overflow-auto border-e border-default">
        <WorkflowPalette :editor="editor" />
      </aside>

      <main class="min-w-0">
        <WorkflowCanvas :key="canvasKey" :editor="editor" />
      </main>

      <aside class="flex flex-col gap-5 overflow-auto border-s border-default p-4">
        <section>
          <h2 class="mb-2 text-xs font-medium text-dimmed">Problems</h2>
          <WorkflowDiagnostics :editor="editor" />
        </section>

        <section class="run">
          <h2 class="mb-2 text-xs font-medium text-dimmed">Run</h2>
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-x"
            :title="error"
          />
          <p v-else-if="!result" class="text-sm text-muted">Not run yet.</p>
          <UAlert
            v-else
            :color="result.status === 'ok' ? 'success' : 'error'"
            variant="subtle"
            :icon="result.status === 'ok' ? 'i-lucide-circle-check' : 'i-lucide-octagon-alert'"
            :title="`${result.status} · ${result.steps} steps`"
            :description="result.fault ? `${result.fault.code}: ${result.fault.message}` : ''"
          />
          <ol v-if="log.length" class="mt-2 list-decimal ps-5 font-mono text-xs text-toned">
            <li v-for="(line, i) in log" :key="i">{{ line }}</li>
          </ol>
        </section>

        <section class="vault">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-xs font-medium text-dimmed">Vault</h2>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-rotate-ccw"
              label="Reset"
              @click="resetVault"
            />
          </div>
          <div class="divide-y divide-default rounded-md border border-default text-xs">
            <div
              v-for="f in vault"
              :key="f.path + JSON.stringify(f.props)"
              class="flex flex-col gap-1 p-2"
            >
              <code class="text-highlighted">{{ f.path }}</code>
              <div class="flex flex-wrap items-center gap-1">
                <UBadge
                  v-for="t in f.tags"
                  :key="t"
                  color="secondary"
                  variant="subtle"
                  size="sm"
                  :label="`#${t}`"
                />
                <code class="text-muted">{{ JSON.stringify(f.props) }}</code>
              </div>
            </div>
          </div>
        </section>

        <UCollapsible v-if="traceLines.length">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            block
            class="justify-start"
            trailing-icon="i-lucide-chevron-down"
            :label="`Trace (${traceLines.length})`"
          />
          <template #content>
            <pre class="max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs">{{
              traceLines.join("\n")
            }}</pre>
          </template>
        </UCollapsible>
        <UCollapsible>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            block
            class="justify-start"
            trailing-icon="i-lucide-chevron-down"
            label="Document JSON"
          />
          <template #content>
            <pre class="json max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs">{{
              json
            }}</pre>
          </template>
        </UCollapsible>
      </aside>
    </div>
  </UApp>
</template>
