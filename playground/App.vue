<script setup lang="ts">
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
    n3: { x: 320, y: 60 },
    n4: { x: 340, y: 300 },
    n6: { x: 580, y: 300 },
    n5: { x: 860, y: 40 },
    n7: { x: 1160, y: 40 },
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
</script>

<template>
  <div class="app">
    <header class="bar">
      <strong class="brand">Workflows <span>playground</span></strong>
      <button type="button" @click="load(empty())">New</button>
      <button type="button" @click="load(example())">Load §10 example</button>
      <span class="spacer" />
      <button type="button" class="run" :disabled="running" @click="start">▶ Run “On Run”</button>
    </header>

    <aside class="left"><WorkflowPalette :editor="editor" /></aside>

    <main class="center">
      <WorkflowCanvas :key="canvasKey" :editor="editor" />
    </main>

    <aside class="right">
      <section>
        <h2>Problems</h2>
        <WorkflowDiagnostics :editor="editor" />
      </section>

      <section>
        <h2>Run</h2>
        <p v-if="error" class="fault">{{ error }}</p>
        <p v-else-if="!result" class="muted">Not run yet.</p>
        <p v-else :class="result.status">
          {{ result.status }} · {{ result.steps }} steps
          <template v-if="result.fault"
            ><br />{{ result.fault.code }}: {{ result.fault.message }}</template
          >
        </p>
        <ol v-if="log.length" class="log">
          <li v-for="(line, i) in log" :key="i">{{ line }}</li>
        </ol>
      </section>

      <section>
        <h2>
          Vault
          <button type="button" class="small" @click="resetVault">Reset</button>
        </h2>
        <table>
          <tr v-for="f in vault" :key="f.path + JSON.stringify(f.props)">
            <td>
              <code>{{ f.path }}</code>
            </td>
            <td>
              <span v-for="t in f.tags" :key="t" class="tag">#{{ t }}</span>
            </td>
            <td>
              <code>{{ JSON.stringify(f.props) }}</code>
            </td>
          </tr>
        </table>
      </section>

      <details v-if="traceLines.length">
        <summary>Trace ({{ traceLines.length }})</summary>
        <pre>{{ traceLines.join("\n") }}</pre>
      </details>
      <details>
        <summary>Document JSON</summary>
        <pre>{{ json }}</pre>
      </details>
    </aside>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--wf-bg);
  color: var(--wf-fg);
  font: 13px/1.4 var(--wf-font);
  color-scheme: light dark;
}
.app {
  display: grid;
  grid-template: "bar bar bar" auto "left center right" 1fr / 240px 1fr 340px;
  height: 100%;
}
.bar {
  grid-area: bar;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface);
}
.brand {
  margin-right: 12px;
  font-size: 15px;
  background: linear-gradient(90deg, var(--wf-fuchsia), var(--wf-sky));
  background-clip: text;
  color: transparent;
}
.brand span {
  font-weight: 400;
}
.spacer {
  flex: 1;
}
button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--wf-border);
  border-radius: 7px;
  background: var(--wf-surface-2);
  color: var(--wf-fg);
  font: inherit;
  cursor: pointer;
}
button:hover {
  border-color: var(--wf-blue);
}
button.run {
  border: 0;
  background: linear-gradient(90deg, var(--wf-rose), var(--wf-orange));
  color: white;
  font-weight: 650;
}
button.small {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 400;
}
.left,
.right {
  overflow: auto;
  background: var(--wf-surface);
}
.left {
  grid-area: left;
  border-right: 1px solid var(--wf-border);
}
.center {
  grid-area: center;
  min-width: 0;
}
.right {
  grid-area: right;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  border-left: 1px solid var(--wf-border);
}
h2 {
  display: flex;
  justify-content: space-between;
  margin: 0 0 8px;
  color: var(--wf-muted);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
p {
  margin: 0;
}
.ok {
  color: var(--wf-ok);
  font-weight: 600;
}
.fault,
.aborted {
  color: var(--wf-error);
  font-weight: 600;
}
.muted {
  color: var(--wf-muted);
}
.log {
  margin: 8px 0 0;
  padding-left: 20px;
  font-family: var(--wf-mono);
  font-size: 11.5px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
td {
  padding: 4px 4px;
  border-bottom: 1px solid var(--wf-border);
  vertical-align: top;
}
.tag {
  margin-right: 4px;
  color: var(--wf-violet);
}
pre {
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--wf-surface-2);
  font: 11px/1.4 var(--wf-mono);
}
summary {
  cursor: pointer;
  color: var(--wf-muted);
  font-weight: 600;
}
</style>
