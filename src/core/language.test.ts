import { describe, expect, test } from "vitest";
import { vertex } from "./fixtures/section10";
import { std } from "./std";
import { defineLanguage } from "./language";
import {
  checkManifest,
  labelText,
  parseLabel,
  type LanguageManifest,
  type NodeManifest,
} from "./manifest";
import { t, tvar } from "./types";

const str = t("string");
const num = t("number");
const File = t("vertex.File");
const T = tvar("T");

describe("defineLanguage", () => {
  test("flattens includes into a JSON-only manifest and keeps implementations aside", () => {
    const { manifest } = vertex;
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(manifest.nodes.map((n) => n.type)).toEqual([
      ...std.manifest.nodes.map((n) => n.type),
      "vertex.onManual",
      "vertex.queryByTag",
      "vertex.fileName",
      "vertex.rename",
      "vertex.setProperty",
    ]);
    expect(vertex.nodes.get("std.forEach")?.run).toBe(std.nodes.get("std.forEach")?.run);
    expect(vertex.nodes.get("vertex.onManual")).toEqual({});
  });

  test("an editor can check the manifest from JSON alone", () => {
    const checked = checkManifest(JSON.parse(JSON.stringify(vertex.manifest)));
    expect(checked.types.isSubtype(t("List", File), t("List", t("any")))).toBe(true);
    expect(checked.nodes.get("vertex.rename")?.requires).toEqual(["fs"]);
  });

  test("run must match the mode", () => {
    const missing = defineLanguage({ id: "x", version: 1 })
      // @ts-expect-error exec nodes need run
      .node({
        type: "x.a",
        version: 1,
        mode: "exec",
        label: "A",
      });
    expect(() => missing.build()).toThrow("Node 'x.a': run is required");

    const extra = defineLanguage({ id: "x", version: 1 })
      // @ts-expect-error event nodes have no run
      .node({
        type: "x.a",
        version: 1,
        mode: "event",
        label: "A",
        run: () => {},
      });
    expect(() => extra.build()).toThrow("Node 'x.a': event nodes have no run");
  });

  // The assertions are the @ts-expect-error lines: `bun run typecheck` fails if any of them stops being an error.
  test("contexts are typed from the node definition", () => {
    interface Fx {
      fs: { rename(file: string, name: string): Promise<string> };
      net: { get(url: string): Promise<string> };
    }
    const builder = defineLanguage<Fx, { "x.File": string }>({ id: "x", version: 1 })
      .type({ id: "x.File" })
      .capability({ id: "fs", mutates: true, label: "Files" })
      .capability({ id: "net", mutates: false, label: "Network" })
      .node({
        type: "x.rename",
        version: 1,
        mode: "exec",
        label: "Rename",
        exec: { out: ["then"] },
        inputs: { file: { type: t("x.File"), required: true }, name: { type: str } },
        outputs: { file: { type: t("x.File") } },
        requires: ["fs"],
        async run(ctx) {
          const { file, name } = await ctx.inputs();
          // @ts-expect-error an optional, unwired input may be undefined
          const n: string = name;
          ctx.output("file", await ctx.effects.fs.rename(file, name ?? n));
          // @ts-expect-error only declared capabilities are in ctx.effects
          void ctx.effects.net;
          // @ts-expect-error unknown port
          await ctx.input("fiel");
          // @ts-expect-error wrong value type for the port
          ctx.output("file", 1);
          // @ts-expect-error unknown exec output
          await ctx.fire("else");
          return "then";
        },
      })
      // @ts-expect-error run may only continue on a declared exec output (an arrow `run` reports at the call)
      .node({
        type: "x.bad",
        version: 1,
        mode: "exec",
        label: "Bad",
        exec: { out: ["then"] },
        run: () => "nope",
      })
      .node({
        type: "x.count",
        version: 1,
        mode: "pure",
        label: "Count",
        typeParams: [{ name: "T" }],
        inputs: {
          list: { type: t("List", tvar("T")), required: true },
          scale: { type: num, default: 1 },
        },
        variadic: { kind: "input", prefix: "arg", type: str },
        outputs: { n: { type: num } },
        run: ({ inputs }) => {
          // Generic parts are unknown, built-ins map to their values, defaults make an input present.
          // A variadic port may be past this instance's count, so it's `string | undefined`.
          const items: readonly unknown[] = inputs.list;
          const first: string = inputs.arg0 ?? "";
          return { n: items.length * inputs.scale + first.length };
        },
      })
      .node({
        type: "x.wrong",
        version: 1,
        mode: "pure",
        label: "Wrong",
        outputs: { n: { type: num } },
        // @ts-expect-error outputs must have their declared types
        run: () => ({ n: "1" }),
      });
    expect(() => builder.build()).not.toThrow();
  });

  test("an included node type can't be redefined", () => {
    const builder = defineLanguage({ id: "x", version: 1, include: [std] }).node({
      type: "std.concat",
      version: 1,
      mode: "pure",
      label: "Mine",
      run: () => ({}),
    });
    expect(() => builder.build()).toThrow("Duplicate node type 'std.concat'");
  });
});

/** A manifest with one node built from `base` plus `node`. */
function manifestWith(
  node: Partial<NodeManifest>,
  extra: Partial<LanguageManifest> = {},
): LanguageManifest {
  return {
    manifest: 1,
    language: { id: "x", version: 1 },
    types: [{ id: "vertex.File" }],
    conversions: [],
    capabilities: [
      { id: "fs", mutates: true, label: "Files" },
      { id: "index", mutates: false, label: "Index" },
    ],
    nodes: [{ type: "x.n", version: 1, mode: "exec", label: "N", ...node }],
    ...extra,
  };
}

describe("checkManifest", () => {
  test.each<[string, Partial<NodeManifest>, string | RegExp]>([
    ["reserved namespace", { type: "core.x" }, "the 'core.' namespace is reserved"],
    ["bad version", { version: 0 }, "version must be a positive integer"],
    ["missing label", { label: "" }, "label is required"],
    ["pure with exec ports", { mode: "pure", exec: { out: [] } }, "pure nodes have no exec ports"],
    [
      "event with exec input",
      { mode: "event", exec: { in: ["go"], out: ["then"] } },
      "no exec inputs",
    ],
    [
      "pure requires mutating",
      { mode: "pure", requires: ["fs"] },
      "can't require mutating capability 'fs'",
    ],
    ["unknown capability", { requires: ["net"] }, "unknown capability 'net'"],
    [
      "unknown port type",
      { inputs: { a: { type: t("vertex.Fil") } } },
      "input 'a': Unknown type 'vertex.Fil'",
    ],
    [
      "undeclared type variable",
      { inputs: { a: { type: t("List", T) } } },
      "undeclared type parameter 'T'",
    ],
    [
      "rigid variable in a manifest",
      {
        typeParams: [{ name: "T" }],
        outputs: { a: { type: { kind: "var", name: "T", rigid: true } } },
      },
      "output 'a': undeclared type parameter 'T'",
    ],
    [
      "duplicate type parameter",
      { typeParams: [{ name: "T" }, { name: "T" }] },
      "duplicate type parameter 'T'",
    ],
    ["non-ground bound", { typeParams: [{ name: "T", bound: tvar("U") }] }, "bound of 'T'"],
    [
      "data input named like the exec input",
      { inputs: { exec: { type: str } } },
      "duplicate input port 'exec'",
    ],
    [
      "output named like an exec output",
      { exec: { out: ["done"] }, outputs: { done: { type: str } } },
      "duplicate output port 'done'",
    ],
    ["duplicate exec port", { exec: { out: ["a", "a"] } }, "duplicate exec port"],
    ["output with default", { outputs: { a: { type: str, default: "x" } } }, "inputs only"],
    [
      "invalid default",
      { inputs: { a: { type: num, default: "x" } } },
      "input 'a' default: $: expected number",
    ],
    [
      "default on an opaque type",
      { inputs: { a: { type: File, default: "x" } } },
      "opaque type vertex.File",
    ],
    [
      "execOut variadic on pure",
      { mode: "pure", variadic: { kind: "execOut", prefix: "c" } },
      "need an exec node",
    ],
    [
      "variadic input without type",
      { variadic: { kind: "input", prefix: "arg" } },
      "variadic inputs need a type",
    ],
    [
      "variadic prefix collides",
      { variadic: { kind: "input", prefix: "arg", type: str }, inputs: { arg0: { type: str } } },
      "port 'arg0' collides with variadic prefix 'arg'",
    ],
    [
      "variadic min > max",
      { variadic: { kind: "input", prefix: "arg", type: str, min: 3, max: 1 } },
      "min exceeds max",
    ],
    ["unknown category", { category: "x.misc" }, "unknown category 'x.misc'"],
    [
      "label placeholder that isn't an input",
      { label: "Rename {file}", inputs: { name: { type: str } } },
      "label names '{file}', which isn't an input",
    ],
  ])("%s", (_, node, message) => {
    expect(() => checkManifest(manifestWith(node))).toThrow(message);
  });

  test("accepts once + non-mutating capability, generic defaults and bounded parameters", () => {
    expect(() =>
      checkManifest(
        manifestWith({
          mode: "once",
          requires: ["index"],
          typeParams: [{ name: "T", bound: t("vertex.File") }],
          inputs: { a: { type: t("List", T), default: [] } },
          outputs: { out: { type: T } },
        }),
      ),
    ).not.toThrow();
  });

  test.each<[string, Partial<LanguageManifest>, string]>([
    [
      "reserved language id",
      { language: { id: "core", version: 1 } },
      "Invalid language id 'core'",
    ],
    [
      "duplicate capability",
      {
        capabilities: [
          { id: "a", mutates: false, label: "A" },
          { id: "a", mutates: true, label: "A" },
        ],
      },
      "Duplicate capability 'a'",
    ],
    [
      "duplicate category",
      {
        categories: [
          { id: "x.a", label: "A" },
          { id: "x.a", label: "B" },
        ],
      },
      "Duplicate category 'x.a'",
    ],
    ["reserved category id", { categories: [{ id: "core.x", label: "X" }] }, "invalid id"],
    [
      "non-ground conversion",
      { conversions: [{ from: T, to: str }] },
      "Conversion T→string: undeclared type parameter 'T'",
    ],
    [
      "duplicate conversion",
      {
        conversions: [
          { from: num, to: str },
          { from: num, to: str },
        ],
      },
      "Duplicate conversion number→string",
    ],
  ])("%s", (_, extra, message) => {
    expect(() => checkManifest(manifestWith({}, extra))).toThrow(message);
  });
});

test("sentence labels split at their inputs; as text, inputs read by their labels", () => {
  expect(parseLabel("Rename {file} to {newName}")).toEqual([
    { text: "Rename " },
    { input: "file" },
    { text: " to " },
    { input: "newName" },
  ]);
  expect(parseLabel("{a}{b}")).toEqual([{ input: "a" }, { input: "b" }]);
  const inputs = { file: { type: str, label: "the file" }, newName: { type: str } };
  expect(labelText({ label: "Rename {file} to {newName}", inputs })).toBe(
    "Rename the file to newName",
  );
});
