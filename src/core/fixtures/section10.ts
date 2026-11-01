// The language behind the spec's §10 worked example. Shared by tests; not part of the package.
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
