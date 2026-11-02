// `@type32/workflows/core/std` (§4.5). Ordinary nodes: nothing here is special to the runtime.
import { defineLanguage, type Language } from "./language";
import { t, type TypeTerm, tvar } from "./types";

const T = tvar("T");
const K = tvar("K");
const V = tvar("V");
const U = tvar("U");
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

/** Numbers first, numerically; then everything else as text. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return String(a).localeCompare(String(b));
}

/** `items[index]` (0-based), or a fault. */
function nth<X>(items: readonly X[], index: number): X {
  if (Number.isInteger(index) && index >= 0 && index < items.length) return items[index] as X;
  throw new Error(
    `Index ${index} is out of range (${items.length ? `0–${items.length - 1}` : "empty"})`,
  );
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

export const std: Language<object> = defineLanguage({ id: "std", version: 1 })
  // Colors after Scratch's: Control amber, Operators green, Lists red.
  .category({ id: "std.control", label: "Control", color: "amber", icon: "i-lucide-repeat" })
  .category({
    id: "std.operators",
    label: "Operators",
    color: "green",
    icon: "i-lucide-calculator",
  })
  .category({ id: "std.text", label: "Text", color: "lime", icon: "i-lucide-type" })
  .category({ id: "std.lists", label: "Lists", color: "red", icon: "i-lucide-list" })
  .category({
    id: "std.dictionaries",
    label: "Dictionaries",
    color: "rose",
    icon: "i-lucide-book-key",
  })
  .node({
    type: "std.if",
    version: 1,
    mode: "exec",
    label: "If",
    category: "std.control",
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
    category: "std.control",
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
    category: "std.control",
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
    category: "std.control",
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
    label: "{a} = {b}",
    category: "std.operators",
    typeParams: [{ name: "T" }],
    inputs: { a: { type: T }, b: { type: T } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: equal(inputs.a, inputs.b) }),
  })
  .node({
    type: "std.not",
    version: 1,
    mode: "pure",
    label: "not {value}",
    category: "std.operators",
    inputs: { value: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: !inputs.value }),
  })
  .node({
    type: "std.and",
    version: 1,
    mode: "pure",
    label: "{a} and {b}",
    category: "std.operators",
    inputs: { a: { type: bool, required: true }, b: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a && inputs.b }),
  })
  .node({
    type: "std.or",
    version: 1,
    mode: "pure",
    label: "{a} or {b}",
    category: "std.operators",
    inputs: { a: { type: bool, required: true }, b: { type: bool, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a || inputs.b }),
  })
  .node({
    type: "std.add",
    version: 1,
    mode: "pure",
    label: "{a} + {b}",
    category: "std.operators",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs }) => ({ result: inputs.a + inputs.b }),
  })
  .node({
    type: "std.subtract",
    version: 1,
    mode: "pure",
    label: "{a} − {b}",
    category: "std.operators",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs }) => ({ result: inputs.a - inputs.b }),
  })
  .node({
    type: "std.multiply",
    version: 1,
    mode: "pure",
    label: "{a} × {b}",
    category: "std.operators",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs }) => ({ result: inputs.a * inputs.b }),
  })
  .node({
    type: "std.divide",
    version: 1,
    mode: "pure",
    label: "{a} ÷ {b}",
    category: "std.operators",
    description: "Faults when b is 0.",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs }) => {
      if (inputs.b === 0) throw new Error("Can't divide by zero");
      return { result: inputs.a / inputs.b };
    },
  })
  .node({
    type: "std.remainder",
    version: 1,
    mode: "pure",
    label: "{a} mod {b}",
    category: "std.operators",
    description:
      "What's left after dividing a by b, with the sign of b (-1 mod 3 is 2). Faults when b is 0.",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs: { a, b } }) => {
      if (b === 0) throw new Error("Can't divide by zero");
      return { result: ((a % b) + b) % b };
    },
  })
  .node({
    type: "std.round",
    version: 1,
    mode: "pure",
    label: "Round {value}",
    category: "std.operators",
    inputs: { value: { type: num, required: true } },
    outputs: { result: { type: num } },
    run: ({ inputs }) => ({ result: Math.round(inputs.value) }),
  })
  .node({
    type: "std.lessThan",
    version: 1,
    mode: "pure",
    label: "{a} < {b}",
    category: "std.operators",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a < inputs.b }),
  })
  .node({
    type: "std.greaterThan",
    version: 1,
    mode: "pure",
    label: "{a} > {b}",
    category: "std.operators",
    inputs: { a: { type: num, required: true }, b: { type: num, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.a > inputs.b }),
  })
  .node({
    type: "std.now",
    version: 1,
    mode: "once",
    label: "Now",
    category: "std.operators",
    description:
      "The date and time (ISO 8601), read once per run: every use in a run sees the same.",
    outputs: { date: { type: str } },
    run: () => ({ date: new Date().toISOString() }),
  })
  .node({
    type: "std.formatDate",
    version: 1,
    mode: "pure",
    label: "Format {date} as {pattern}",
    category: "std.operators",
    description:
      "Writes date in local time, replacing YYYY, MM, DD, HH, mm and ss in pattern. Faults on a date it can't read.",
    inputs: {
      date: { type: str, required: true },
      pattern: { type: str, default: "YYYY-MM-DD" },
    },
    outputs: { text: { type: str } },
    run: ({ inputs }) => {
      const d = new Date(inputs.date);
      if (Number.isNaN(d.getTime())) throw new Error(`Can't read '${inputs.date}' as a date`);
      const tokens: Record<string, string> = {
        YYYY: pad(d.getFullYear(), 4),
        MM: pad(d.getMonth() + 1, 2),
        DD: pad(d.getDate(), 2),
        HH: pad(d.getHours(), 2),
        mm: pad(d.getMinutes(), 2),
        ss: pad(d.getSeconds(), 2),
      };
      return { text: inputs.pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]!) };
    },
  })
  .node({
    type: "std.concat",
    version: 1,
    mode: "pure",
    label: "Join",
    category: "std.text",
    variadic: { kind: "input", prefix: "arg", type: str, min: 1 },
    outputs: { out: { type: str } },
    run: ({ inputs, variadic }) => ({
      out: Array.from({ length: variadic }, (_, i) => inputs[`arg${i}`]).join(""),
    }),
  })
  .node({
    type: "std.textContains",
    version: 1,
    mode: "pure",
    label: "{text} contains {search}",
    category: "std.text",
    description: "Ignores case.",
    inputs: { text: { type: str, required: true }, search: { type: str, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({
      result: inputs.text.toLowerCase().includes(inputs.search.toLowerCase()),
    }),
  })
  .node({
    type: "std.replace",
    version: 1,
    mode: "pure",
    label: "Replace {search} with {replacement} in {text}",
    category: "std.text",
    description: "Replaces every occurrence, matching the text exactly.",
    inputs: {
      search: { type: str, required: true },
      replacement: { type: str, default: "" },
      text: { type: str, required: true },
    },
    outputs: { text: { type: str } },
    // A function replacement, so `$&` and friends stay literal.
    run: ({ inputs }) => ({
      text: inputs.text.replaceAll(inputs.search, () => inputs.replacement),
    }),
  })
  .node({
    type: "std.split",
    version: 1,
    mode: "pure",
    label: "Split {text} by {separator}",
    category: "std.text",
    inputs: { text: { type: str, required: true }, separator: { type: str, default: "," } },
    outputs: { parts: { type: List(str) } },
    run: ({ inputs }) => ({ parts: inputs.text.split(inputs.separator) }),
  })
  .node({
    type: "std.trim",
    version: 1,
    mode: "pure",
    label: "Trim {text}",
    category: "std.text",
    description: "Removes whitespace from both ends.",
    inputs: { text: { type: str, required: true } },
    outputs: { text: { type: str } },
    run: ({ inputs }) => ({ text: inputs.text.trim() }),
  })
  .node({
    type: "std.upperCase",
    version: 1,
    mode: "pure",
    label: "Uppercase {text}",
    category: "std.text",
    inputs: { text: { type: str, required: true } },
    outputs: { text: { type: str } },
    run: ({ inputs }) => ({ text: inputs.text.toUpperCase() }),
  })
  .node({
    type: "std.lowerCase",
    version: 1,
    mode: "pure",
    label: "Lowercase {text}",
    category: "std.text",
    inputs: { text: { type: str, required: true } },
    outputs: { text: { type: str } },
    run: ({ inputs }) => ({ text: inputs.text.toLowerCase() }),
  })
  .node({
    type: "std.letterOf",
    version: 1,
    mode: "pure",
    label: "Letter {index} of {text}",
    category: "std.text",
    description: "Counts from 0. Faults when there's no letter at index.",
    inputs: { index: { type: num, required: true }, text: { type: str, required: true } },
    outputs: { letter: { type: str } },
    run: ({ inputs }) => ({ letter: nth([...inputs.text], inputs.index) }),
  })
  .node({
    type: "std.length",
    version: 1,
    mode: "pure",
    label: "Count of {list}",
    category: "std.lists",
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
    category: "std.lists",
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
    category: "std.lists",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(List(T)), required: true } },
    outputs: { list: { type: List(T) } },
    run: ({ inputs }) => ({ list: inputs.list.flat() }),
  })
  .node({
    type: "std.first",
    version: 1,
    mode: "pure",
    label: "First of {list}",
    category: "std.lists",
    description: "Faults when the list is empty.",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true } },
    outputs: { item: { type: T } },
    run: ({ inputs }) => ({ item: nth(inputs.list, 0) }),
  })
  .node({
    type: "std.last",
    version: 1,
    mode: "pure",
    label: "Last of {list}",
    category: "std.lists",
    description: "Faults when the list is empty.",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true } },
    outputs: { item: { type: T } },
    run: ({ inputs }) => ({ item: nth(inputs.list, inputs.list.length - 1) }),
  })
  .node({
    type: "std.itemAt",
    version: 1,
    mode: "pure",
    label: "Item {index} of {list}",
    category: "std.lists",
    description: "Counts from 0. Faults when there's no item at index.",
    typeParams: [{ name: "T" }],
    inputs: { index: { type: num, required: true }, list: { type: List(T), required: true } },
    outputs: { item: { type: T } },
    run: ({ inputs }) => ({ item: nth(inputs.list, inputs.index) }),
  })
  .node({
    type: "std.sort",
    version: 1,
    mode: "pure",
    label: "Sort {list}",
    category: "std.lists",
    description: "A new List: numbers first, smallest first, then text alphabetically.",
    typeParams: [{ name: "T" }],
    inputs: {
      list: { type: List(T), required: true },
      descending: { type: bool, default: false, wire: false },
    },
    outputs: { list: { type: List(T) } },
    run: ({ inputs }) => ({
      list: inputs.list.toSorted((a, b) => (inputs.descending ? compare(b, a) : compare(a, b))),
    }),
  })
  .node({
    type: "std.unique",
    version: 1,
    mode: "pure",
    label: "Unique items of {list}",
    category: "std.lists",
    description: "A new List without repeats, keeping each item's first occurrence.",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true } },
    outputs: { list: { type: List(T) } },
    // ponytail: O(n²) for structural equality; hash a canonical form if lists get large.
    run: ({ inputs: { list } }) => ({
      list: list.filter((x, i) => list.findIndex((y) => equal(x, y)) === i),
    }),
  })
  .node({
    type: "std.listContains",
    version: 1,
    mode: "pure",
    label: "{list} contains {item}",
    category: "std.lists",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(T), required: true }, item: { type: T, required: true } },
    outputs: { result: { type: bool } },
    run: ({ inputs }) => ({ result: inputs.list.some((x) => equal(x, inputs.item)) }),
  })
  .node({
    type: "std.filter",
    version: 1,
    mode: "exec",
    label: "Keep items of {list} where {keep}",
    category: "std.lists",
    description:
      "Works out keep once per item, where it can read item and index, then continues on then with the kept items as list.",
    typeParams: [{ name: "T" }],
    exec: { out: ["then"] },
    inputs: { list: { type: List(T), required: true }, keep: { type: bool, required: true } },
    outputs: { item: { type: T }, index: { type: num }, list: { type: List(T) } },
    async run(ctx) {
      const kept = [];
      for (const [index, item] of (await ctx.input("list")).entries()) {
        if (await ctx.input("keep", { scope: { item, index } })) kept.push(item);
      }
      ctx.output("list", kept);
      return "then";
    },
  })
  .node({
    type: "std.map",
    version: 1,
    mode: "exec",
    label: "Map {list} to {value}",
    category: "std.lists",
    description:
      "Works out value once per item, where it can read item and index, then continues on then with the results as list.",
    typeParams: [{ name: "T" }, { name: "U" }],
    exec: { out: ["then"] },
    inputs: { list: { type: List(T), required: true }, value: { type: U, required: true } },
    outputs: { item: { type: T }, index: { type: num }, list: { type: List(U) } },
    async run(ctx) {
      const mapped = [];
      for (const [index, item] of (await ctx.input("list")).entries()) {
        mapped.push(await ctx.input("value", { scope: { item, index } }));
      }
      ctx.output("list", mapped);
      return "then";
    },
  })
  .node({
    type: "std.dictGet",
    version: 1,
    mode: "exec",
    label: "Get",
    category: "std.dictionaries",
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
    category: "std.dictionaries",
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
    category: "std.dictionaries",
    typeParams: [{ name: "K" }, { name: "V" }],
    inputs: { dict: { type: Dict, required: true } },
    outputs: { keys: { type: List(K) } },
    run: ({ inputs }) => ({ keys: [...inputs.dict.keys()] }),
  })
  .build();
