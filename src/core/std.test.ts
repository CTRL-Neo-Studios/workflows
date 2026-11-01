import { describe, expect, test } from "vitest";
import { runProbe } from "./fixtures/probe";
import type { NodeSpec } from "./testing";
import { t } from "./types";

const note = (text: string) => ({ type: "p.note", literals: { text } });
const str = t("string");
const num = t("number");

/** Logs `port` of node `x` (plus any `extra` nodes and edges) and returns the logged value. */
async function value(
  x: NodeSpec,
  port: string,
  extra: Record<string, NodeSpec> = {},
  edges: string[] = [],
): Promise<unknown> {
  const { result, log } = await runProbe({ s: "p.start", x, l: "p.log", ...extra }, [
    "s.then>l.exec",
    `x.${port}>l.value`,
    ...edges,
  ]);
  expect(result.status).toBe("ok");
  return log[0];
}

describe("control", () => {
  test.each([
    [true, ["then", "done"]],
    [false, ["else", "done"]],
  ])("if %s", async (condition, expected) => {
    const { log } = await runProbe(
      {
        s: "p.start",
        i: { type: "std.if", literals: { condition } },
        a: note("then"),
        b: note("else"),
        c: note("done"),
      },
      ["s.then>i.exec", "i.then>a.exec", "i.else>b.exec", "i.done>c.exec"],
    );
    expect(log).toEqual(expected);
  });

  test("values set in an If branch stay visible after it", async () => {
    const { result, log } = await runProbe(
      {
        s: "p.start",
        i: { type: "std.if", literals: { condition: true } },
        set: { type: "p.set", literals: { value: "kept" } },
        l: "p.log",
      },
      ["s.then>i.exec", "i.then>set.exec", "i.done>l.exec", "set.value>l.value"],
    );
    expect(result.status).toBe("ok");
    expect(log).toEqual(["kept"]);
  });

  test("sequence fires its outputs in order", async () => {
    const { log } = await runProbe(
      {
        s: "p.start",
        q: { type: "std.sequence", variadic: 3 },
        a: note("a"),
        b: note("b"),
        c: note("c"),
      },
      ["s.then>q.exec", "q.then2>c.exec", "q.then0>a.exec", "q.then1>b.exec"],
    );
    expect(log).toEqual(["a", "b", "c"]);
  });

  test("forEach exposes item and index per iteration", async () => {
    const { log } = await runProbe(
      {
        s: "p.start",
        each: { type: "std.forEach", literals: { list: ["x", "y"] }, typeArgs: { T: str } },
        a: "p.log",
        b: "p.log",
      },
      [
        "s.then>each.exec",
        "each.body>a.exec",
        "each.item>a.value",
        "a.then>b.exec",
        "each.index>b.value",
      ],
    );
    expect(log).toEqual(["x", 0, "y", 1]);
  });

  test("try runs catch with the fault message, then done", async () => {
    const { result, log } = await runProbe(
      { s: "p.start", tr: "std.try", f: "p.fail", l: "p.log", d: note("done") },
      ["s.then>tr.exec", "tr.body>f.exec", "tr.catch>l.exec", "tr.error>l.value", "tr.done>d.exec"],
    );
    expect(result.status).toBe("ok");
    expect(log).toEqual(["f: boom", "done"]);
  });

  test("try can't catch the step limit", async () => {
    const { result, log } = await runProbe(
      { s: "p.start", tr: "std.try", a: note("a"), b: note("b"), c: note("caught") },
      ["s.then>tr.exec", "tr.body>a.exec", "a.then>b.exec", "tr.catch>c.exec"],
      { limits: { steps: 3 } },
    );
    expect(result).toMatchObject({ status: "fault", fault: { code: "E_STEP_LIMIT" }, steps: 3 });
    expect(log).toEqual(["a"]);
  });
});

describe("values", () => {
  test("logic", async () => {
    expect(await value({ type: "std.not", literals: { value: true } }, "result")).toBe(false);
    expect(await value({ type: "std.and", literals: { a: true, b: false } }, "result")).toBe(false);
    expect(await value({ type: "std.or", literals: { a: true, b: false } }, "result")).toBe(true);
  });

  test("equals is structural for Lists and Dictionaries", async () => {
    const dicts = {
      type: "std.equals",
      literals: { a: { k: [1, 2] }, b: { k: [1, 2] } },
      typeArgs: { T: t("Dictionary", str, t("List", num)) },
    };
    expect(await value(dicts, "result")).toBe(true);
    const lists = {
      type: "std.equals",
      literals: { a: [1, 2], b: [2, 1] },
      typeArgs: { T: t("List", num) },
    };
    expect(await value(lists, "result")).toBe(false);
  });

  test("concat joins variadic inputs in index order", async () => {
    expect(
      await value(
        { type: "std.concat", variadic: 3, literals: { arg2: "c", arg0: "a", arg1: "b" } },
        "out",
      ),
    ).toBe("abc");
  });

  test("flatten and length", async () => {
    const flat = { type: "std.flatten", literals: { list: [[1, 2], [3]] }, typeArgs: { T: num } };
    expect(await value(flat, "list")).toEqual([1, 2, 3]);
    expect(
      await value(
        { type: "std.length", literals: { list: [1, 2, 3] }, typeArgs: { T: num } },
        "length",
      ),
    ).toBe(3);
  });

  test("dictSet returns a new Dictionary and leaves its input unchanged", async () => {
    const pins = { K: str, V: num };
    const keys = await value(
      { type: "std.dictKeys", typeArgs: pins },
      "keys",
      {
        d: {
          type: "std.dictSet",
          literals: { dict: { a: 1 }, key: "b", value: 2 },
          typeArgs: pins,
        },
      },
      ["d.dict>x.dict"],
    );
    expect(keys).toEqual(["a", "b"]);
  });

  test.each([
    ["a", ["found", 1]],
    ["z", ["missing"]],
  ])("dictGet %s", async (key, expected) => {
    const { log } = await runProbe(
      {
        s: "p.start",
        g: { type: "std.dictGet", literals: { dict: { a: 1 }, key }, typeArgs: { K: str, V: num } },
        f: note("found"),
        v: "p.log",
        m: note("missing"),
      },
      ["s.then>g.exec", "g.found>f.exec", "f.then>v.exec", "g.value>v.value", "g.missing>m.exec"],
    );
    expect(log).toEqual(expected);
  });
});
