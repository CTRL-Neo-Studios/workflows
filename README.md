# @type32/workflows

A visual node-scripting toolkit. Language developers define types, nodes and effects in TypeScript; end users build documents from those nodes on a canvas; the engine validates and runs them. Documents are untrusted data: the engine never evaluates code from a document.

Design: [Node Engine Spec](https://github.com/CTRL-Neo-Studios/vertex/blob/t32/feature/workflows/Node%20Engine%20Spec.md). Vertex is the first language.

> Status: M5. `@type32/workflows/core` has the type system, language definition with typed node contexts, `validate`, the runtime, functions and variables, `migrate` and `hashProgram`; `@type32/workflows/core/std` has the standard nodes; `@type32/workflows/core/testing` has test helpers; `@type32/workflows/vue` has the canvas editor.

## Usage

```ts
import { compile, defineLanguage, t, validate } from "@type32/workflows/core";
import { std } from "@type32/workflows/core/std";

// Effects keyed by capability id, and the TypeScript value type of each of the language's own types.
const vertex = defineLanguage<
  { fs: { rename(file: string, name: string): Promise<string> } },
  { "vertex.File": string }
>({
  id: "vertex",
  version: 1,
  include: [std], // control, operators (logic, math, compare, dates), text, lists (filter, map, sort, …), dictionaries
})
  .type({ id: "vertex.File", label: "File", schema: { type: "string", pattern: "^/" } }) // a schema allows literals
  .capability({ id: "fs", mutates: true, label: "Modify files" })
  .node({
    type: "vertex.onManual",
    version: 1,
    mode: "event",
    label: "On Run",
    exec: { out: ["then"] },
  })
  .node({
    type: "vertex.rename",
    version: 1,
    mode: "exec",
    label: "Rename",
    exec: { out: ["then"] },
    inputs: {
      file: { type: t("vertex.File"), required: true },
      newName: { type: t("string"), required: true },
    },
    outputs: { file: { type: t("vertex.File") } },
    requires: ["fs"],
    async run(ctx) {
      const { file, newName } = await ctx.inputs(); // file: string, newName: string
      ctx.output("file", await ctx.effects.fs.rename(file, newName)); // ctx.effects has only `fs`
      return "then"; // only declared exec outputs compile
    },
  })
  .build(); // throws on any manifest problem

// Editors need only the JSON manifest.
const analysis = validate(document, vertex.manifest);
analysis.diagnostics; // [{ code: "E_TYPE_MISMATCH", message: "e7: string → vertex.File", at: { edge: "e7" } }, …]
analysis.typeOf("n3", "item", "out"); // resolved port type, e.g. { kind: "con", id: "vertex.File" }
analysis.capabilities; // Set { "fs", … } reachable from event nodes

// Hosts run it. compile throws CompileError on any error diagnostic; dispatch never rejects for program errors.
const result = await compile(document, vertex).dispatch("vertex.onManual", undefined, {
  effects: { fs: { rename: async (file, name) => `/vault/${name}.md` } }, // each node sees only its `requires`
  signal, // abort → { status: "aborted" }
  limits: { steps: 1_000, timeoutMs: 10_000 },
  trace: "nodes",
  onTrace: (event) => console.log(event), // { t: "enter" | "exit" | "fire" | "value" | "fault", node, … }
});
result; // { status: "ok" | "fault" | "aborted", fault?: { code: "E_UNSET_VALUE", message, node }, steps }
```

`ctx` is typed from the definition: port names, value types (`List` → `readonly T[]`, `Dictionary` → `ReadonlyMap`, generic parts `unknown`), exec outputs and capabilities are checked at compile time. An input without `required` or a `default` may be `undefined`.

### Testing a language

```ts
import { buildDocument, formatTrace, record, run } from "@type32/workflows/core/testing";

const doc = buildDocument(vertex, {
  nodes: {
    go: "vertex.onManual",
    r: { type: "vertex.rename", literals: { file: "/v/a.md", newName: "b" } },
  },
  edges: ["go.then > r.exec"],
});
const rec = record({ fs: { rename: async (file: string, name: string) => `/v/${name}.md` } });
const { result, trace } = await run(vertex, doc, {
  event: "vertex.onManual",
  effects: rec.effects,
});
rec.log(); // ["fs.rename(/v/a.md, b)"]
formatTrace(trace); // [">go", "<go.then", ">r", "<r.then"]; `~n3.body` is a fire
```

`assertValid(doc, language)` throws an Error listing every diagnostic. The helpers don't depend on a test framework.

Generic nodes declare `typeParams: [{ name: "T", bound?: t("vertex.Entry") }]` and use `tvar("T")` in port types; `validate` infers each instance's `T` from its edges.

Run-time values: `List` is an array, `Dictionary` is a `ReadonlyMap` (`Dictionary` literals are decoded to `Map`). Limit faults and aborts are fatal; `std.try` catches only node errors and other faults.

Loading a file: `migrate(JSON.parse(text), language)` is the boundary for untrusted input. It returns `{ doc, changed }` (a clean `DocumentV1` with only known fields, migrated to the current format, language and node versions) or `{ diagnostics }` when the file is invalid or newer than the code, in which case the host opens it read-only. `hashProgram(doc)` is the SHA-256 of the program, ignoring view and meta; hosts key trust records by it.

Functions live in `doc.program.functions`. A body has one `core.entry` and one `core.return`; `core.call` calls it, `core.get`/`core.set` read and write document variables or the function's locals. Generic functions declare `typeParams` (with optional bounds), are checked once with those as rigid types, and are instantiated fresh at each call. Reaching `core.return` ends the call at once; an exec function that never reaches it faults `E_NO_RETURN`.

### Editing on a canvas

Peer dependencies: `vue`, `@vue-flow/core` and `@nuxt/ui`. The components are built from Nuxt UI, so set it up in the host (the `@nuxt/ui` module in Nuxt, or its Vite and Vue plugins with `<UApp>`), and let Tailwind scan this package from your CSS entry:

```css
@import "tailwindcss";
@import "@nuxt/ui";
@source "../node_modules/@type32/workflows/dist"; /* relative to this file */
```

```vue
<script setup lang="ts">
import "@type32/workflows/vue/style.css";
import { useWorkflowEditor, WorkflowWidget, WorkflowWorkbench } from "@type32/workflows/vue";

const editor = useWorkflowEditor(vertex.manifest, document); // the manifest is enough to edit
async function start() {
  const { trace } = await run(vertex, editor.snapshot(), {
    event: "vertex.onManual",
    effects,
    trace: "values",
  });
  editor.trace.value = trace; // run counts, values, taken edges and faults on the canvas
}
</script>

<template>
  <!-- canvas, node library and inspector; or compose WorkflowCanvas, WorkflowPalette, WorkflowInspector yourself -->
  <WorkflowWorkbench :editor="editor">
    <template #toolbar><UButton label="Run" @click="start" /></template>
    <!-- optional: replace one type's literal editor (on the canvas and in the inspector), keep the default for the rest -->
    <template #widget="w">
      <MyFilePicker v-if="w.type?.kind === 'con' && w.type.id === 'vertex.File'" v-bind="w" />
      <WorkflowWidget v-else v-bind="w" />
    </template>
  </WorkflowWorkbench>
</template>
```

`WorkflowWidget` is the default literal editor, picked from the type's schema: text, number, switch, a select for an `enum`, chips for a list of text, and JSON text for anything else.

`analysis` reruns `validate` on every change. A drag that would add a wiring or type error is refused, and the reason is shown. Wiring a used data input or exec output replaces its edge. Nodes follow the host's Nuxt UI theme; port and wire colors are `--wf-*` CSS variables. `bun run play` opens a playground with the §10 language and an in-memory vault.

Languages group their nodes into categories, which give the node library its sections and the nodes their header color. A label can embed inputs, which the node shows inline as a sentence:

```ts
defineLanguage({ id: "notes", version: 1, include: [std] })
  .category({ id: "notes.files", label: "Files", color: "teal", icon: "i-lucide-folder" })
  .node({
    type: "notes.rename",
    label: "Rename {file} to {newName}", // inputs named here render inline
    category: "notes.files",
    // …
  });
```

Colors (`TypeDef`, `CategoryDef`, and a node's own `color`) take a palette name (`sky`, `rose`, …) or any CSS color. Variables and My Blocks come after categories of `order` 0 or less, so `order: 1` puts a language's own sections after them, as in Scratch.

To translate a language, rewrite its manifest's strings before handing it to the editor: node `label` (keep the `{input}` placeholders) and `description`, port `label`s, `exec.labels` for exec outputs, and the category, type and capability labels.

A node that works out an input once per item, like `std.filter`, reads it in a child scope where the item is its own output: `await ctx.input("keep", { scope: { item, index } })` recomputes the pure nodes behind `keep` for that item.

On the canvas, dragging empty space draws a selection box; scroll, two fingers, Space+drag or the middle button pan, and ⌘/Ctrl+scroll or a pinch zooms. Shortcuts: ⌘Z / ⇧⌘Z undo and redo (every document edit except the viewport), ⌘C / ⌘X / ⌘V / ⌘D copy, cut, paste at the cursor and duplicate, ⌘A select all, Tab or a double-click opens a node search at the cursor. Dropping a wire on empty space opens that search filtered to nodes that can take it, and wires the one you pick. Right-clicking the canvas, a node, an edge or a port opens a menu; `WorkflowCanvas`'s `menu` prop can change its items, and its `#selection` slot adds buttons to the bar shown under a multi-node selection.

```ts
const editor = useWorkflowEditor(vertex.manifest, document, {
  messages: () => ({ undo: t("undo"), selected: (n) => t("selected", { n }) }), // translate the built-in strings
  clipboard: { read: readText, write: writeText }, // default: navigator.clipboard
});
```

Copies go to the clipboard as JSON (`parseClip` reads them back), so they paste into another document of the same language. When the clipboard can't be read (a denied permission), paste falls back to the last copy made in the app.

Programs grow structure from the library and the selection bar. Variables and My Blocks in the node library create variables and blocks (functions); click or drag a variable for a Get, ⌥ for a Set; the inspector edits the declaration behind a selected node (a block's name, inputs, outputs and exits). An exec block may have several exits, and each Return names one, so a call can branch like `std.if`. Select nodes and choose Make block to move them into a new block called in their place (`extractFunction` in core does the work), or Group to frame them; dragging a group's header moves what's inside it, and the canvas menu adds sticky comments. Groups and comments live in `view`, so they don't change the program hash. Double-click a call to open its block; the breadcrumb leads back.

Run through the editor to watch it on the canvas: `editor.run` hands you the `onTrace`, `signal` and `beforeStep` to spread into the run, and the canvas shows a run bar (Pause, Step, Continue, Cancel) and glows the nodes running now.

```ts
editor.stepping.value = stepThrough; // stop before the first node
const { result } = await editor.run((live) =>
  run(vertex, editor.snapshot(), { event: "vertex.onManual", effects, trace: "values", ...live }),
);
```

Time spent in `beforeStep` and in the capabilities named in `interactive` (prompts, pickers) doesn't count toward `limits.timeoutMs`.

## Scripts

| Script              | Does                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun run build`     | Bundle `src/core` and `src/vue` → `dist/` + `.d.mts`                                                   |
| `bun run play`      | Vite playground (`playground/`)                                                                        |
| `bun run test`      | Run Vitest once (`test:watch` to watch)                                                                |
| `bun run typecheck` | `ui:prepare` (generates Nuxt UI's theme types), vue-tsc (TypeScript 6.0.3), TypeScript 7 on `src/core` |
| `bun run lint`      | Oxlint                                                                                                 |
| `bun run format`    | Oxfmt (`format:check` to verify only)                                                                  |
| `bun run check`     | lint + format:check + typecheck + test                                                                 |
| `bun run changeset` | Record a change for the next release                                                                   |

Minimum supported TypeScript for consumers is **6.0.3**, the pinned dev `typescript`, so `typecheck` runs against it. vue-tsc needs the TypeScript API, which 7.0 lacks; TypeScript 7 (`typescript7`) checks `src/core` with no DOM lib. Subpath exports are listed by hand in `package.json`.

## Releasing

Run `bun run changeset` in your PR. On merge to `main`, the Release workflow opens a "Version Packages" PR; merging that publishes to npm.

## License

MIT
