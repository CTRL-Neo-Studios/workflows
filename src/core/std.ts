// `@type32/workflows/core/std` (§4.5). Ordinary nodes: nothing here is special to the runtime.
import { defineLanguage, type Language } from "./language";
import { t, type TypeTerm, tvar } from "./types";

const T = tvar("T");
const K = tvar("K");
const V = tvar("V");
const bool = t("boolean");
const str = t("string");
const num = t("number");
// Generic so the literal term type survives and the node contexts stay typed.
const List = <X extends TypeTerm>(item: X) => t("List", item);
const Dict = t("Dictionary", K, V);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural for Lists, Dictionaries and JSON objects; identity for everything else (opaque values). */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a instanceof Map) {
    return (
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([k, v]) => b.has(k) && equal(v, b.get(k)))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}

export const std: Language<object> = defineLanguage({ id: "std", version: 1 })
  .node({
    type: "std.if",
    version: 1,
    mode: "exec",
    label: "If",
    category: "Control",
    description:
      "Runs then or else, then continues on done. Values set in the branch stay visible after it.",
    exec: { out: ["then", "else", "done"] },
    inputs: { condition: { type: bool, required: true } },
    async run(ctx) {
      await ctx.fire((await ctx.input("condition")) ? "then" : "else");
      return "done";
    },
  })
  .node({
    type: "std.forEach",
    version: 1,
    mode: "exec",
    label: "For Each",
    category: "Control",
    description: "Runs body once per item, each in its own scope, then continues on done.",
    typeParams: [{ name: "T" }],
    exec: { out: ["body", "done"] },
    inputs: { list: { type: List(T), required: true } },
    outputs: { item: { type: T }, index: { type: num } },
    async run(ctx) {
      for (const [index, item] of (await ctx.input("list")).entries()) {
        await ctx.fire("body", { scope: { item, index } });
      }
      return "done";
    },
  })
  .node({
    type: "std.sequence",
    version: 1,
    mode: "exec",
    label: "Sequence",
    category: "Control",
    description: "Runs then0, then1, … in order.",
    exec: { out: [] },
    variadic: { kind: "execOut", prefix: "then", min: 1 },
    async run(ctx) {
      for (let i = 0; i < ctx.variadic; i++) await ctx.fire(`then${i}`);
    },
  })
  .node({
    type: "std.try",
    version: 1,
    mode: "exec",
    label: "Try",
    category: "Control",
    description:
      "Runs body; if it faults, runs catch with the error message. Then continues on done. Limits and aborts can't be caught.",
    exec: { out: ["body", "catch", "done"] },
    outputs: { error: { type: str } },
    async run(ctx) {
      try {
        await ctx.fire("body");
      } catch (error) {
        await ctx.fire("catch", {
          scope: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      return "done";
    },
  })
  .node({
    type: "std.equals",
    version: 1,
    mode: "pure",
    label: "Equals",
    category: "Logic",
    typeParams: [{ name: "T" }],
    inputs: { a: { type: T }, b: { type: T } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: equal(inputs.a, inputs.b) }),
  })
  .node({
    type: "std.not",
    version: 1,
    mode: "pure",
    label: "Not",
    category: "Logic",
    inputs: { value: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: !inputs.value }),
  })
  .node({
    type: "std.and",
    version: 1,
    mode: "pure",
    label: "And",
    category: "Logic",
    inputs: { a: { type: bool, required: true }, b: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a && inputs.b }),
  })
  .node({
    type: "std.or",
    version: 1,
    mode: "pure",
    label: "Or",
    category: "Logic",
    inputs: { a: { type: bool, required: true }, b: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a || inputs.b }),
  })
  .node({
    type: "std.concat",
    version: 1,
    mode: "pure",
    label: "Concat",
    category: "Text",
    variadic: { kind: "input", prefix: "arg", type: str, min: 1 },
    outputs: { out: { type: str } },
    run: ({ inputs, variadic }) => ({
      out: Array.from({ length: variadic }, (_, i) => inputs[`arg${i}`]).join(""),
    }),
  })
  .node({
    type: "std.length",
    version: 1,
    mode: "pure",
    label: "Length",
    category: "Lists",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true } },
    outputs: { length: { type: num } },
    run: ({ inputs }) => ({ length: inputs.list.length }),
  })
  .node({
    type: "std.append",
    version: 1,
    mode: "pure",
    label: "Append",
    category: "Lists",
    description: "A new List with item added at the end; the input is unchanged.",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true }, item: { type: T, required: true } },
    outputs: { list: { type: List(T) } },
    run: ({ inputs }) => ({ list: [...inputs.list, inputs.item] }),
  })
  .node({
    type: "std.flatten",
    version: 1,
    mode: "pure",
    label: "Flatten",
    category: "Lists",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(List(T)), required: true } },
    outputs: { list: { type: List(T) } },
    run: ({ inputs }) => ({ list: inputs.list.flat() }),
  })
  .node({
    type: "std.dictGet",
    version: 1,
    mode: "exec",
    label: "Get",
    category: "Dictionaries",
    typeParams: [{ name: "K" }, { name: "V" }],
    exec: { out: ["found", "missing"] },
    inputs: { dict: { type: Dict, required: true }, key: { type: K, required: true } },
    outputs: { value: { type: V } },
    async run(ctx) {
      const { dict, key } = await ctx.inputs();
      if (!dict.has(key)) return "missing";
      ctx.output("value", dict.get(key));
      return "found";
    },
  })
  .node({
    type: "std.dictSet",
    version: 1,
    mode: "pure",
    label: "Set",
    category: "Dictionaries",
    description: "A new Dictionary with key set to value; the input is unchanged.",
    typeParams: [{ name: "K" }, { name: "V" }],
    inputs: {
      dict: { type: Dict, required: true },
      key: { type: K, required: true },
      value: { type: V, required: true },
    },
    outputs: { dict: { type: Dict } },
    run: ({ inputs }) => ({ dict: new Map(inputs.dict).set(inputs.key, inputs.value) }),
  })
  .node({
    type: "std.dictKeys",
    version: 1,
    mode: "pure",
    label: "Keys",
    category: "Dictionaries",
    typeParams: [{ name: "K" }, { name: "V" }],
    inputs: { dict: { type: Dict, required: true } },
    outputs: { keys: { type: List(K) } },
    run: ({ inputs }) => ({ keys: [...inputs.dict.keys()] }),
  })
  .build();
