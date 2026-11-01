# @type32/workflows

A visual node-scripting toolkit. Language developers define types, nodes and effects in TypeScript; end users build documents from those nodes on a canvas; the engine validates (and, from M2, runs) them. Documents are untrusted data: the engine never evaluates code from a document.

Design: [Node Engine Spec](https://github.com/CTRL-Neo-Studios/vertex/blob/t32/feature/workflows/Node%20Engine%20Spec.md). Vertex is the first language.

> Status: M1. `@type32/workflows/core` has the type system, language definition and `validate`. The runtime, `std`, `testing` and the Vue canvas follow.

## Usage

```ts
import { defineLanguage, t, tvar, validate } from "@type32/workflows/core";

const vertex = defineLanguage<{ fs: { rename(file: string, name: string): Promise<string> } }>({
  id: "vertex",
  version: 1,
})
  .type({ id: "vertex.File", label: "File" })
  .capability({ id: "fs", mutates: true, label: "Modify files" })
  .node({
    type: "vertex.rename",
    version: 1,
    mode: "exec",
    label: "Rename",
    exec: { out: ["then"] },
    inputs: { file: { type: t("vertex.File") }, newName: { type: t("string") } },
    outputs: { file: { type: t("vertex.File") } },
    requires: ["fs"],
    async run(ctx) {
      const { file, newName } = await ctx.inputs();
      ctx.output("file", await ctx.effects.fs.rename(String(file), String(newName)));
      return "then";
    },
  })
  .build(); // throws on any manifest problem

// Editors need only the JSON manifest.
const analysis = validate(document, vertex.manifest);
analysis.diagnostics; // [{ code: "E_TYPE_MISMATCH", message: "e7: string → vertex.File", at: { edge: "e7" } }, …]
analysis.typeOf("n3", "item", "out"); // resolved port type, e.g. { kind: "con", id: "vertex.File" }
analysis.capabilities; // Set { "fs", … } reachable from event nodes
```

Generic nodes declare `typeParams: [{ name: "T", bound?: t("vertex.Entry") }]` and use `tvar("T")` in port types; `validate` infers each instance's `T` from its edges.

## Scripts

| Script              | Does                                    |
| ------------------- | --------------------------------------- |
| `bun run build`     | Bundle `src/core` → `dist/` + `.d.mts`  |
| `bun run test`      | Run Vitest once (`test:watch` to watch) |
| `bun run typecheck` | `tsc --noEmit`                          |
| `bun run lint`      | Oxlint                                  |
| `bun run format`    | Oxfmt (`format:check` to verify only)   |
| `bun run check`     | lint + format:check + typecheck + test  |
| `bun run changeset` | Record a change for the next release    |

Minimum supported TypeScript for consumers is **6.0.3**; CI typechecks against it. Subpath exports are listed by hand in `package.json`.

## Releasing

Run `bun run changeset` in your PR. On merge to `main`, the Release workflow opens a "Version Packages" PR; merging that publishes to npm.

## License

MIT
