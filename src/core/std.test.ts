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

/** Runs `x` as `value` would and returns the run result, for nodes that fault. */
async function outcome(x: NodeSpec, port: string) {
  const { result } = await runProbe({ s: "p.start", x, l: "p.log" }, [
    "s.then>l.exec",
    `x.${port}>l.value`,
  ]);
  return result;
}

const threw = (message: string) => ({
  status: "fault",
  fault: { code: "E_NODE_THREW", message: `x: ${message}` },
});

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

describe("operators", () => {
  test.each([
    ["std.add", 7, 2, 9],
    ["std.subtract", 7, 2, 5],
    ["std.multiply", 7, 2, 14],
    ["std.divide", 7, 2, 3.5],
    ["std.remainder", 7, 3, 1],
    ["std.remainder", -1, 3, 2],
    ["std.remainder", 5, -3, -1],
    ["std.lessThan", 1, 2, true],
    ["std.greaterThan", 1, 2, false],
  ])("%s %d %d", async (type, a, b, expected) => {
    expect(await value({ type, literals: { a, b } }, "result")).toBe(expected);
  });

  test.each(["std.divide", "std.remainder"])("%s by zero faults", async (type) => {
    expect(await outcome({ type, literals: { a: 1, b: 0 } }, "result")).toMatchObject(
      threw("Can't divide by zero"),
    );
  });

  test("round", async () => {
    expect(await value({ type: "std.round", literals: { value: 2.5 } }, "result")).toBe(3);
  });

  test("now is read once per run", async () => {
    const { result, log } = await runProbe({ s: "p.start", n: "std.now", a: "p.log", b: "p.log" }, [
      "s.then>a.exec",
      "a.then>b.exec",
      "n.date>a.value",
      "n.date>b.value",
    ]);
    expect(result.status).toBe("ok");
    expect(log[0]).toBe(log[1]);
    expect(new Date(log[0] as string).toISOString()).toBe(log[0]);
  });

  test("formatDate writes the tokens in local time and keeps other text", async () => {
    const date = new Date(2026, 0, 2, 3, 4, 5).toISOString();
    const format = (literals: Record<string, string>) =>
      value({ type: "std.formatDate", literals: { date, ...literals } }, "text");
    expect(await format({ pattern: "YYYY-MM-DD HH:mm:ss, day DD" })).toBe(
      "2026-01-02 03:04:05, day 02",
    );
    expect(await format({})).toBe("2026-01-02");
    expect(
      await outcome({ type: "std.formatDate", literals: { date: "soon" } }, "text"),
    ).toMatchObject(threw("Can't read 'soon' as a date"));
  });
});

describe("text", () => {
  test.each([
    [{ type: "std.textContains", literals: { text: "Hello", search: "ELL" } }, "result", true],
    [
      { type: "std.replace", literals: { search: ".", replacement: "$&", text: "a.b.c" } },
      "text",
      "a$&b$&c",
    ],
    [{ type: "std.replace", literals: { search: ".", text: "a.b" } }, "text", "ab"],
    [{ type: "std.split", literals: { text: "a,b,,c" } }, "parts", ["a", "b", "", "c"]],
    [{ type: "std.split", literals: { text: "a b", separator: " " } }, "parts", ["a", "b"]],
    [{ type: "std.trim", literals: { text: "  a b \n" } }, "text", "a b"],
    [{ type: "std.upperCase", literals: { text: "aB" } }, "text", "AB"],
    [{ type: "std.lowerCase", literals: { text: "aB" } }, "text", "ab"],
    [{ type: "std.letterOf", literals: { index: 1, text: "a😀b" } }, "letter", "😀"],
  ])("%o", async (x, port, expected) => {
    expect(await value(x, port)).toEqual(expected);
  });

  test("letterOf out of range faults", async () => {
    expect(
      await outcome({ type: "std.letterOf", literals: { index: 3, text: "abc" } }, "letter"),
    ).toMatchObject(threw("Index 3 is out of range (0–2)"));
  });
});

describe("lists", () => {
  const nums = { T: num };
  test.each([
    [{ type: "std.first", literals: { list: [1, 2, 3] }, typeArgs: nums }, "item", 1],
    [{ type: "std.last", literals: { list: [1, 2, 3] }, typeArgs: nums }, "item", 3],
    [{ type: "std.itemAt", literals: { index: 1, list: [1, 2, 3] }, typeArgs: nums }, "item", 2],
    [{ type: "std.sort", literals: { list: [10, 2, 1] }, typeArgs: nums }, "list", [1, 2, 10]],
    [
      { type: "std.sort", literals: { list: ["b", "C", "a"] }, typeArgs: { T: str } },
      "list",
      ["a", "b", "C"],
    ],
    [
      { type: "std.sort", literals: { list: [2, 10, 1], descending: true }, typeArgs: nums },
      "list",
      [10, 2, 1],
    ],
    [
      {
        type: "std.unique",
        literals: { list: [[1], [2], [1]] },
        typeArgs: { T: t("List", num) },
      },
      "list",
      [[1], [2]],
    ],
    [
      {
        type: "std.listContains",
        literals: { list: [[1, 2]], item: [1, 2] },
        typeArgs: { T: t("List", num) },
      },
      "result",
      true,
    ],
    [
      { type: "std.listContains", literals: { list: [1, 2], item: 3 }, typeArgs: nums },
      "result",
      false,
    ],
  ])("%o", async (x, port, expected) => {
    expect(await value(x, port)).toEqual(expected);
  });

  test.each(["std.first", "std.last"])("%s of an empty list faults", async (type) => {
    expect(await outcome({ type, literals: { list: [] }, typeArgs: nums }, "item")).toMatchObject(
      threw(`Index ${type === "std.first" ? 0 : -1} is out of range (empty)`),
    );
  });

  test("filter works out keep per item from its own item, then continues with the list", async () => {
    const { result, log } = await runProbe(
      {
        s: "p.start",
        f: { type: "std.filter", literals: { list: [3, 1, 4, 2, 5] }, typeArgs: nums },
        gt: { type: "std.greaterThan", literals: { b: 2 } },
        l: "p.log",
      },
      ["s.then>f.exec", "f.item>gt.a", "gt.result>f.keep", "f.then>l.exec", "f.list>l.value"],
    );
    expect(result.status).toBe("ok");
    expect(log).toEqual([[3, 4, 5]]);
  });

  test("map works out value per item from its own item and index", async () => {
    const { result, log } = await runProbe(
      {
        s: "p.start",
        m: { type: "std.map", literals: { list: [1, 2, 3] }, typeArgs: { T: num, U: num } },
        mul: { type: "std.multiply", literals: { b: 10 } },
        add: "std.add",
        l: "p.log",
      },
      [
        "s.then>m.exec",
        "m.item>mul.a",
        "mul.result>add.a",
        "m.index>add.b",
        "add.result>m.value",
        "m.then>l.exec",
        "m.list>l.value",
      ],
    );
    expect(result.status).toBe("ok");
    expect(log).toEqual([[10, 21, 32]]);
  });
});
