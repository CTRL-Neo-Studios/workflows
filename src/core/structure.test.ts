import { describe, expect, test } from "vitest";
import type { DocumentV1 } from "./document";
import { extractFunction, nextId } from "./extract";
import { probe, runDoc } from "./fixtures/probe";
import { buildDocument, type DocumentSpec, type FunctionSpec } from "./testing";
import { t } from "./types";
import { validate } from "./validate";

const S = t("string");
const B = t("boolean");
const doc = (spec: DocumentSpec): DocumentV1 => buildDocument(probe, spec);
const codes = (d: DocumentV1): string[] =>
  validate(d, probe.manifest).diagnostics.map((x) => x.code);
const note = (text: string) => ({ type: "p.note", literals: { text } });

/** branch(flag) leaves through `yes` or `no`. */
const branch = (patch: Partial<FunctionSpec> = {}): FunctionSpec => ({
  exec: true,
  inputs: { flag: { type: B } },
  outputs: {},
  exits: ["yes", "no"],
  nodes: {
    fe: "core.entry",
    i: "std.if",
    ry: { type: "core.return", ref: "yes" },
    rn: { type: "core.return", ref: "no" },
  },
  edges: ["fe.then > i.exec", "fe.flag > i.condition", "i.then > ry.exec", "i.else > rn.exec"],
  ...patch,
});

const caller = (flag: boolean, f = branch()): DocumentV1 =>
  doc({
    nodes: {
      s: "p.start",
      c: { type: "core.call", ref: "b", literals: { flag } },
      y: note("yes"),
      n: note("no"),
    },
    edges: ["s.then > c.exec", "c.yes > y.exec", "c.no > n.exec"],
    functions: { b: f },
  });

describe("named exits", () => {
  test.each([
    [true, ["yes"]],
    [false, ["no"]],
  ])("the call continues on the exit its return names (flag %s)", async (flag, log) => {
    expect(codes(caller(flag))).toEqual([]);
    expect((await runDoc(caller(flag))).log).toEqual(log);
  });

  test("several returns may leave through one exit; an omitted ref is the first exit", async () => {
    const f = branch({
      nodes: { fe: "core.entry", i: "std.if", r1: "core.return", r2: "core.return" },
      edges: ["fe.then > i.exec", "fe.flag > i.condition", "i.then > r1.exec", "i.else > r2.exec"],
    });
    expect(codes(caller(false, f))).toEqual([]);
    expect((await runDoc(caller(false, f))).log).toEqual(["yes"]);
  });

  test.each([
    ["a pure function with exits", { exec: false, nodes: { fe: "core.entry", fr: "core.return" } }],
    ["no exits", { exits: [] }],
    ["duplicate exits", { exits: ["yes", "yes"] }],
    ["an unnamed exit", { exits: ["yes", ""] }],
    ["an exec function without a return", { nodes: { fe: "core.entry" }, edges: [] }],
  ] as [string, Partial<FunctionSpec>][])("%s is E_FUNCTION_SHAPE", (_, patch) => {
    expect(codes(doc({ nodes: {}, functions: { b: branch(patch) } }))).toContain(
      "E_FUNCTION_SHAPE",
    );
  });

  test("a return naming an unknown exit is E_UNKNOWN_REF", () => {
    const f = branch({
      nodes: { fe: "core.entry", r: { type: "core.return", ref: "maybe" } },
      edges: ["fe.then > r.exec"],
    });
    expect(codes(doc({ nodes: {}, functions: { b: f } }))).toEqual(["E_UNKNOWN_REF"]);
  });
});

test("references lists calls of a function and gets/sets of a variable, locals included", () => {
  const d = doc({
    variables: [{ id: "v", name: "v", type: S }],
    nodes: { c: { type: "core.call", ref: "f" }, set: { type: "core.set", ref: "v" } },
    functions: {
      f: {
        exec: false,
        inputs: {},
        outputs: {},
        locals: [{ id: "l", name: "l", type: S }],
        nodes: {
          fe: "core.entry",
          get: { type: "core.get", ref: "v" },
          loc: { type: "core.get", ref: "l" },
          self: { type: "core.call", ref: "f" },
          fr: "core.return",
        },
      },
    },
  });
  const a = validate(d, probe.manifest);
  expect(a.references("v")).toEqual([
    { graph: "main", node: "set" },
    { graph: "f", node: "get" },
  ]);
  expect(a.references("f")).toEqual([
    { graph: "main", node: "c" },
    { graph: "f", node: "self" },
  ]);
  expect(a.references("l")).toEqual([{ graph: "f", node: "loc" }]);
  expect(a.references("nothing")).toEqual([]);
});

test("nextId counts every id with the prefix: nodes, edges, declarations, frames", () => {
  const d = doc({
    variables: [{ id: "v4", name: "v", type: S }],
    nodes: { n3: "p.start", n10: "p.start", nx: "p.start" },
    edges: ["n3.then > n10.exec"],
  });
  d.view.groups.push({ id: "g2", graph: "main", x: 0, y: 0, width: 1, height: 1 });
  expect(nextId(d, "n")).toBe("n11");
  expect(nextId(d, "e")).toBe("e2");
  expect(nextId(d, "v")).toBe("v5");
  expect(nextId(d, "g")).toBe("g3");
  expect(nextId(d, "c")).toBe("c1");
});

describe("extractFunction", () => {
  test("a pure selection becomes a pure block with its wired-out values as outputs", async () => {
    const d = doc({
      nodes: {
        s: "p.start",
        c: { type: "std.concat", variadic: 2, literals: { arg0: "a", arg1: "b" } },
        l: "p.log",
      },
      edges: ["s.then > l.exec", "c.out > l.value"],
    });
    const r = extractFunction(d, probe.manifest, ["c"], "ab");
    if ("error" in r) throw new Error(r.error);
    const f = r.doc.program.functions[0]!;
    expect(f).toMatchObject({ name: "ab", exec: false, inputs: {}, outputs: { out: { type: S } } });
    expect(f.exits).toBeUndefined();
    expect(codes(r.doc)).toEqual([]);
    expect((await runDoc(r.doc)).log).toEqual(["ab"]);
    expect(d.program.functions).toEqual([]);
  });

  test("an exec chain keeps its order, inputs and continuation", async () => {
    const d = doc({
      nodes: {
        s: "p.start",
        c: { type: "std.concat", variadic: 2, literals: { arg0: "a", arg1: "b" } },
        one: note("one"),
        x: "p.text",
        two: note("two"),
      },
      edges: ["s.then > one.exec", "one.then > x.exec", "c.out > x.s", "x.then > two.exec"],
    });
    const before = (await runDoc(d)).log;
    const r = extractFunction(d, probe.manifest, ["one", "x"], "block");
    if ("error" in r) throw new Error(r.error);
    const f = r.doc.program.functions[0]!;
    expect(f).toMatchObject({ exec: true, inputs: { s: { type: S } }, exits: ["then"] });
    expect(r.doc.program.graph.nodes.map((n) => n.id)).toEqual(["s", "c", r.call, "two"]);
    expect(codes(r.doc)).toEqual([]);
    expect((await runDoc(r.doc)).log).toEqual(before);
    expect(before).toEqual(["one", "ab", "two"]);
  });

  test("several exec wires out become exits named after their ports", () => {
    const d = doc({
      nodes: { s: "p.start", i: "std.if", a: note("a"), b: note("b") },
      edges: ["s.then > i.exec", "i.then > a.exec", "i.else > b.exec"],
    });
    const r = extractFunction(d, probe.manifest, ["i"], "if");
    if ("error" in r) throw new Error(r.error);
    expect(r.doc.program.functions[0]!.exits).toEqual(["then", "else"]);
    expect(codes(r.doc)).toEqual(["E_REQUIRED_INPUT"]);
  });

  test.each([
    ["an event node", ["s"], "Event nodes"],
    ["nodes from two graphs", ["one", "fn"], "same graph"],
    ["a function's entry", ["fe"], "entry and return"],
    ["a local's get", ["lg"], "Local variable"],
    ["two exec entry points", ["one", "two"], "more than one node"],
    ["a wire of unresolved type", ["ap"], "unresolved type"],
  ])("refuses %s", (_, nodes, error) => {
    const d = doc({
      nodes: {
        s: "p.start",
        i: "std.if",
        one: note("one"),
        two: note("two"),
        ap: "std.append",
        len: "std.length",
      },
      edges: ["s.then > i.exec", "i.then > one.exec", "i.else > two.exec", "ap.list > len.list"],
      functions: {
        f: {
          exec: true,
          inputs: {},
          outputs: {},
          locals: [{ id: "loc", name: "loc", type: S }],
          nodes: {
            fe: "core.entry",
            fn: note("in f"),
            lg: { type: "core.get", ref: "loc" },
            fr: "core.return",
          },
        },
      },
    });
    expect(extractFunction(d, probe.manifest, nodes, "x")).toEqual({
      error: expect.stringContaining(error),
    });
  });
});
