import { describe, expect, test } from "vitest";
import { std, vertex } from "./fixtures/section10";
import { defineLanguage } from "./language";
import { checkManifest, type LanguageManifest, type NodeManifest } from "./manifest";
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
      "std.forEach",
      "std.concat",
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
    // @ts-expect-error exec nodes need run
    const missing = defineLanguage({ id: "x", version: 1 }).node({
      type: "x.a",
      version: 1,
      mode: "exec",
      label: "A",
    });
    expect(() => missing.build()).toThrow("Node 'x.a': run is required");

    const extra = defineLanguage({ id: "x", version: 1 }).node({
      type: "x.a",
      version: 1,
      mode: "event",
      label: "A",
      // @ts-expect-error event nodes have no run
      run: () => {},
    });
    expect(() => extra.build()).toThrow("Node 'x.a': event nodes have no run");
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
