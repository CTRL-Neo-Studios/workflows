// The language and document behind the spec's §10 worked example. Shared by tests; not part of the package.
import type { DocumentV1 } from "../document";
import { defineLanguage, type Language } from "../language";
import { std } from "../std";
import { buildDocument } from "../testing";
import { t, tvar } from "../types";

export interface VertexEffects {
  index: { byTag(tag: string): Promise<string[]> };
  fs: {
    rename(file: string, newName: string): Promise<string>;
    setProperty(file: string, key: string, value: unknown): Promise<void>;
  };
}

/** Value types of the language's own type ids: a file is its path. */
interface VertexValues {
  "vertex.File": string;
}

const T = tvar("T");
const str = t("string");
const File = t("vertex.File");

export const vertex: Language<VertexEffects> = defineLanguage<VertexEffects, VertexValues>({
  id: "vertex",
  version: 1,
  include: [std],
})
  .type({ id: "vertex.File", label: "File", color: "sky" })
  .capability({ id: "index", mutates: false, label: "Read the workspace index" })
  .capability({ id: "fs", mutates: true, label: "Modify files" })
  .category({
    id: "vertex.events",
    label: "Events",
    color: "yellow",
    icon: "i-lucide-zap",
    order: -1,
  })
  .category({ id: "vertex.files", label: "Files", color: "sky", icon: "i-lucide-files" })
  .node({
    type: "vertex.onManual",
    version: 1,
    mode: "event",
    label: "On Run",
    category: "vertex.events",
    exec: { out: ["then"] },
  })
  .node({
    type: "vertex.queryByTag",
    version: 1,
    mode: "once",
    label: "Files tagged {tag}",
    category: "vertex.files",
    inputs: { tag: { type: str, wire: false, required: true } },
    outputs: { files: { type: t("List", File) } },
    requires: ["index"],
    run: async ({ inputs, effects }) => ({ files: await effects.index.byTag(inputs.tag) }),
  })
  .node({
    type: "vertex.fileName",
    version: 1,
    mode: "pure",
    label: "Name of {file}",
    category: "vertex.files",
    inputs: { file: { type: File, required: true } },
    outputs: { name: { type: str } },
    run: ({ inputs }) => ({ name: inputs.file.replace(/^.*\//, "").replace(/\.[^.]*$/, "") }),
  })
  .node({
    type: "vertex.rename",
    version: 1,
    mode: "exec",
    label: "Rename {file} to {newName}",
    category: "vertex.files",
    exec: { out: ["then"] },
    inputs: { file: { type: File, required: true }, newName: { type: str, required: true } },
    outputs: { file: { type: File } },
    requires: ["fs"],
    async run(ctx) {
      const { file, newName } = await ctx.inputs();
      ctx.output("file", await ctx.effects.fs.rename(file, newName));
      return "then";
    },
  })
  .node({
    type: "vertex.setProperty",
    version: 1,
    mode: "exec",
    label: "Set {key} of {file} to {value}",
    category: "vertex.files",
    typeParams: [{ name: "T" }],
    exec: { out: ["then"] },
    inputs: {
      file: { type: File, required: true },
      key: { type: str, required: true },
      value: { type: T, required: true },
    },
    requires: ["fs"],
    async run(ctx) {
      const { file, key, value } = await ctx.inputs();
      await ctx.effects.fs.setProperty(file, key, value);
      return "then";
    },
  })
  .build();

/** "Archive every file tagged `draft`". Returns a fresh copy, so tests may mutate it. */
export function archiveDrafts(): DocumentV1 {
  return buildDocument(vertex, {
    nodes: {
      n1: "vertex.onManual",
      n2: { type: "vertex.queryByTag", literals: { tag: "draft" } },
      n3: "std.forEach",
      n4: "vertex.fileName",
      n5: "vertex.rename",
      n6: { type: "std.concat", variadic: 2, literals: { arg1: "_archive" } },
      n7: {
        type: "vertex.setProperty",
        literals: { key: "status", value: "archived" },
        typeArgs: { T: str },
      },
    },
    edges: [
      "n1.then > n3.exec",
      "n2.files > n3.list",
      "n3.body > n5.exec",
      "n3.item > n4.file",
      "n4.name > n6.arg0",
      "n6.out > n5.newName",
      "n3.item > n5.file",
      "n5.then > n7.exec",
      "n5.file > n7.file",
    ],
  });
}
