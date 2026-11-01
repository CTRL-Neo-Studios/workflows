// The language and document behind the spec's §10 worked example. Shared by tests; not part of the package.
import type { DocumentV1, EdgeInstance } from "../document";
import { defineLanguage, type Language } from "../language";
import { t, tvar } from "../types";

export interface VertexEffects {
  index: { byTag(tag: string): Promise<string[]> };
  fs: {
    rename(file: string, newName: string): Promise<string>;
    setProperty(file: string, key: string, value: unknown): Promise<void>;
  };
}

const T = tvar("T");
const str = t("string");
const File = t("vertex.File");

export const std: Language<object> = defineLanguage({ id: "std", version: 1 })
  .node({
    type: "std.forEach",
    version: 1,
    mode: "exec",
    label: "For Each",
    typeParams: [{ name: "T" }],
    exec: { out: ["body", "done"] },
    inputs: { list: { type: t("List", T) } },
    outputs: { item: { type: T }, index: { type: t("number") } },
    async run(ctx) {
      const list = await ctx.input("list");
      if (!Array.isArray(list)) throw new TypeError("list is not an array");
      for (const [index, item] of list.entries())
        await ctx.fire("body", { scope: { item, index } });
      return "done";
    },
  })
  .node({
    type: "std.concat",
    version: 1,
    mode: "pure",
    label: "Concat",
    variadic: { kind: "input", prefix: "arg", type: str, min: 1 },
    outputs: { out: { type: str } },
    run: ({ inputs }) => ({ out: Object.values(inputs).join("") }),
  })
  .build();

export const vertex: Language<VertexEffects> = defineLanguage<VertexEffects>({
  id: "vertex",
  version: 1,
  include: [std],
})
  .type({ id: "vertex.File", label: "File", color: "sky" })
  .capability({ id: "index", mutates: false, label: "Read the workspace index" })
  .capability({ id: "fs", mutates: true, label: "Modify files" })
  .node({
    type: "vertex.onManual",
    version: 1,
    mode: "event",
    label: "On Run",
    exec: { out: ["then"] },
  })
  .node({
    type: "vertex.queryByTag",
    version: 1,
    mode: "once",
    label: "Files Tagged",
    inputs: { tag: { type: str, wire: false, required: true } },
    outputs: { files: { type: t("List", File) } },
    requires: ["index"],
    run: async ({ inputs, effects }) => ({ files: await effects.index.byTag(String(inputs.tag)) }),
  })
  .node({
    type: "vertex.fileName",
    version: 1,
    mode: "pure",
    label: "File Name",
    inputs: { file: { type: File } },
    outputs: { name: { type: str } },
    run: ({ inputs }) => ({
      name: String(inputs.file)
        .replace(/^.*\//, "")
        .replace(/\.[^.]*$/, ""),
    }),
  })
  .node({
    type: "vertex.rename",
    version: 1,
    mode: "exec",
    label: "Rename",
    exec: { out: ["then"] },
    inputs: { file: { type: File }, newName: { type: str } },
    outputs: { file: { type: File } },
    requires: ["fs"],
    async run(ctx) {
      const { file, newName } = await ctx.inputs();
      ctx.output("file", await ctx.effects.fs.rename(String(file), String(newName)));
      return "then";
    },
  })
  .node({
    type: "vertex.setProperty",
    version: 1,
    mode: "exec",
    label: "Set Property",
    typeParams: [{ name: "T" }],
    exec: { out: ["then"] },
    inputs: { file: { type: File }, key: { type: str }, value: { type: T } },
    requires: ["fs"],
    async run(ctx) {
      const { file, key, value } = await ctx.inputs();
      await ctx.effects.fs.setProperty(String(file), String(key), value);
      return "then";
    },
  })
  .build();

function edge(id: string, from: string, to: string): EdgeInstance {
  const [fn = "", fp = ""] = from.split(".");
  const [tn = "", tp = ""] = to.split(".");
  return { id, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
}

/** "Archive every file tagged `draft`". Returns a fresh copy, so tests may mutate it. */
export function archiveDrafts(): DocumentV1 {
  return {
    format: 1,
    language: { id: "vertex", version: 1 },
    program: {
      graph: {
        nodes: [
          { id: "n1", type: "vertex.onManual", version: 1 },
          { id: "n2", type: "vertex.queryByTag", version: 1, literals: { tag: "draft" } },
          { id: "n3", type: "std.forEach", version: 1 },
          { id: "n4", type: "vertex.fileName", version: 1 },
          { id: "n5", type: "vertex.rename", version: 1 },
          { id: "n6", type: "std.concat", version: 1, variadic: 2, literals: { arg1: "_archive" } },
          {
            id: "n7",
            type: "vertex.setProperty",
            version: 1,
            literals: { key: "status", value: "archived" },
            typeArgs: { T: t("string") },
          },
        ],
        edges: [
          edge("e1", "n1.then", "n3.exec"),
          edge("e2", "n2.files", "n3.list"),
          edge("e3", "n3.body", "n5.exec"),
          edge("e4", "n3.item", "n4.file"),
          edge("e5", "n4.name", "n6.arg0"),
          edge("e6", "n6.out", "n5.newName"),
          edge("e7", "n3.item", "n5.file"),
          edge("e8", "n5.then", "n7.exec"),
          edge("e9", "n5.file", "n7.file"),
        ],
      },
      variables: [],
      functions: [],
    },
    view: { positions: {}, groups: [] },
  };
}
