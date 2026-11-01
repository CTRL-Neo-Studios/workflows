import { describe, expect, test } from "vitest";
import type { DocumentV1 } from "./document";
import { probe, runDoc } from "./fixtures/probe";
import { compile } from "./runtime";
import { buildDocument, type DocumentSpec, type FunctionSpec, type NodeSpec } from "./testing";
import { formatType, t, tvar, type TypeTerm } from "./types";
import { validate } from "./validate";

const S = t("string");
const N = t("number");
const T = tvar("T");
const U = tvar("U");
const List = (x: TypeTerm): TypeTerm => t("List", x);

const doc = (spec: DocumentSpec): DocumentV1 => buildDocument(probe, spec);
const codes = (d: DocumentV1): string[] =>
  validate(d, probe.manifest).diagnostics.map((x) => x.code);

/** M3 acceptance: map<T: string, U>(list: List<T>, table: Dictionary<T, U>) → List<U>, via a local accumulator. */
const map: FunctionSpec = {
  typeParams: [{ name: "T", bound: S }, { name: "U" }],
  exec: true,
  inputs: { list: { type: List(T) }, table: { type: t("Dictionary", T, U) } },
  outputs: { out: { type: List(U) } },
  locals: [{ id: "acc", name: "acc", type: List(U), default: [] }],
  nodes: {
    fe: "core.entry",
    each: "std.forEach",
    get: "std.dictGet",
    acc: { type: "core.get", ref: "acc" },
    app: "std.append",
    set: { type: "core.set", ref: "acc" },
    fr: "core.return",
  },
  edges: [
    "fe.then > each.exec",
    "fe.list > each.list",
    "fe.table > get.dict",
    "each.item > get.key",
    "each.body > get.exec",
    "get.found > set.exec",
    "acc.value > app.list",
    "get.value > app.item",
    "app.list > set.value",
    "each.done > fr.exec",
    "acc.value > fr.out",
  ],
};

describe("generic map<T, U>", () => {
  const twoCalls = doc({
    nodes: {
      s: "p.start",
      m1: {
        type: "core.call",
        ref: "map",
        literals: { list: ["a", "z", "b"], table: { a: 1, b: 2 } },
        typeArgs: { T: S, U: N },
      },
      l1: "p.log",
      m2: {
        type: "core.call",
        ref: "map",
        literals: { list: ["x"], table: { x: [true] } },
        typeArgs: { T: S, U: List(t("boolean")) },
      },
      l2: "p.log",
    },
    edges: [
      "s.then > m1.exec",
      "m1.then > l1.exec",
      "m1.out > l1.value",
      "l1.then > m2.exec",
      "m2.then > l2.exec",
      "m2.out > l2.value",
    ],
    functions: { map },
  });

  test("type-checks once with rigid T and U, and each call instantiates them", () => {
    const a = validate(twoCalls, probe.manifest);
    expect(a.diagnostics).toEqual([]);
    const type = (node: string, port: string, dir: "in" | "out"): string =>
      formatType(a.typeOf(node, port, dir)!);
    expect(type("each", "item", "out")).toBe("T");
    expect(type("get", "value", "out")).toBe("U");
    expect(type("app", "list", "out")).toBe("List<U>");
    expect(type("m1", "out", "out")).toBe("List<number>");
    expect(type("m2", "out", "out")).toBe("List<List<boolean>>");
  });

  test("runs at both instantiations, with fresh locals per call and depth 1 inside", async () => {
    const { result, log, trace } = await runDoc(twoCalls);
    expect(result.status).toBe("ok");
    expect(log).toEqual([[1, 2], [[true]]]);
    const depths = trace.flatMap((e) => (e.t === "enter" && e.node === "each" ? [e.depth] : []));
    expect(new Set(depths)).toEqual(new Set([1]));
  });

  test("T and U are inferred from the call's edges", async () => {
    const d = doc({
      nodes: {
        s: "p.start",
        k: { type: "std.dictKeys", literals: { dict: { a: 1 } }, typeArgs: { K: S, V: N } },
        d: {
          type: "std.dictSet",
          literals: { dict: { a: 1 }, key: "b", value: 2 },
          typeArgs: { K: S, V: N },
        },
        m: { type: "core.call", ref: "map" },
        l: "p.log",
      },
      edges: [
        "s.then > m.exec",
        "k.keys > m.list",
        "d.dict > m.table",
        "m.then > l.exec",
        "m.out > l.value",
      ],
      functions: { map },
    });
    expect(formatType(validate(d, probe.manifest).typeOf("m", "out", "out")!)).toBe("List<number>");
    expect((await runDoc(d)).log).toEqual([[1]]);
  });

  test("a call must satisfy the bound", () => {
    const d = doc({
      nodes: {
        m: {
          type: "core.call",
          ref: "map",
          literals: { list: [], table: {} },
          typeArgs: { T: N, U: N },
        },
      },
      functions: { map },
    });
    expect(validate(d, probe.manifest).diagnostics.map((x) => x.message)).toEqual([
      "T = number is not a string",
    ]);
  });
});

/** f<T>(x: T) passes x into a string input. */
const usesT = (bound?: TypeTerm): FunctionSpec => ({
  typeParams: [bound ? { name: "T", bound } : { name: "T" }],
  exec: true,
  inputs: { x: { type: T } },
  outputs: {},
  nodes: { fe: "core.entry", x: "p.text", fr: "core.return" },
  edges: ["fe.then > x.exec", "fe.x > x.s", "x.then > fr.exec"],
});

describe("rigid type parameters", () => {
  test("T is only itself: it can't flow into string unless bounded by it", () => {
    const messages = validate(
      doc({ nodes: {}, functions: { f: usesT() } }),
      probe.manifest,
    ).diagnostics.map((d) => d.message);
    expect(messages).toEqual(["f.e2: T → string"]);
    expect(codes(doc({ nodes: {}, functions: { f: usesT(S) } }))).toEqual([]);
  });

  test("no literal fits T, but [] fits List<T>", () => {
    const f: FunctionSpec = {
      typeParams: [{ name: "T" }],
      exec: true,
      inputs: {},
      outputs: {},
      locals: [
        { id: "one", name: "one", type: T },
        { id: "many", name: "many", type: List(T), default: [] },
      ],
      nodes: {
        fe: "core.entry",
        set: { type: "core.set", ref: "one", literals: { value: 5 } },
        fr: "core.return",
      },
      edges: ["fe.then > set.exec", "set.then > fr.exec"],
    };
    const { diagnostics } = validate(doc({ nodes: {}, functions: { f } }), probe.manifest);
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["E_LITERAL_INVALID", "set.value literal: $: no literal fits this type"],
    ]);
  });

  test("an unbounded T can't be a Dictionary key", () => {
    const f: FunctionSpec = {
      typeParams: [{ name: "T" }],
      exec: true,
      inputs: { d: { type: t("Dictionary", T, N) } },
      outputs: {},
      nodes: { fe: "core.entry", fr: "core.return" },
      edges: ["fe.then > fr.exec"],
    };
    expect(codes(doc({ nodes: {}, functions: { f } }))).toEqual(["E_KEY_TYPE"]);
  });

  test("a document can't forge a rigid variable", () => {
    const forged: TypeTerm = { kind: "var", name: "T", rigid: true };
    const d = doc({
      nodes: { n: { type: "std.length", literals: { list: [] }, typeArgs: { T: forged } } },
    });
    expect(codes(d)).toEqual(["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"]);
  });
});

describe("calls", () => {
  /** first<T>(list: List<T>): T. Returns from inside the loop, through a try that mustn't catch the return. */
  const first: FunctionSpec = {
    typeParams: [{ name: "T" }],
    exec: true,
    inputs: { list: { type: List(T) } },
    outputs: { out: { type: T } },
    locals: [{ id: "hit", name: "hit", type: T }],
    nodes: {
      fe: "core.entry",
      each: "std.forEach",
      iter: { type: "p.note", literals: { text: "iter" } },
      tr: "std.try",
      set: { type: "core.set", ref: "hit" },
      fr: "core.return",
      hit: { type: "core.get", ref: "hit" },
      caught: { type: "p.note", literals: { text: "caught" } },
    },
    edges: [
      "fe.then > each.exec",
      "fe.list > each.list",
      "each.body > iter.exec",
      "iter.then > tr.exec",
      "tr.body > set.exec",
      "each.item > set.value",
      "set.then > fr.exec",
      "hit.value > fr.out",
      "tr.catch > caught.exec",
    ],
  };
  const callFirst = (list: string[]): DocumentV1 =>
    doc({
      nodes: {
        s: "p.start",
        f: { type: "core.call", ref: "first", literals: { list }, typeArgs: { T: S } },
        l: "p.log",
      },
      edges: ["s.then > f.exec", "f.then > l.exec", "f.out > l.value"],
      functions: { first },
    });

  test("core.return ends the call at once, even inside forEach and try", async () => {
    const { result, log } = await runDoc(callFirst(["a", "b"]));
    expect(result.status).toBe("ok");
    expect(log).toEqual(["iter", "a"]);
  });

  test("a chain that ends without core.return faults E_NO_RETURN", async () => {
    const { result } = await runDoc(callFirst([]));
    expect(result).toMatchObject({ status: "fault", fault: { code: "E_NO_RETURN", node: "f" } });
  });

  test("recursion stops at the depth limit, and try can't catch it", async () => {
    const loop: FunctionSpec = {
      exec: true,
      inputs: {},
      outputs: {},
      nodes: { fe: "core.entry", c: { type: "core.call", ref: "loop" }, fr: "core.return" },
      edges: ["fe.then > c.exec", "c.then > fr.exec"],
    };
    const d = doc({
      nodes: {
        s: "p.start",
        tr: "std.try",
        start: { type: "core.call", ref: "loop" },
        n: { type: "p.note", literals: { text: "caught" } },
      },
      edges: ["s.then > tr.exec", "tr.body > start.exec", "tr.catch > n.exec"],
      functions: { loop },
    });
    const { result, log } = await runDoc(d, { limits: { depth: 5 } });
    expect(result).toMatchObject({ status: "fault", fault: { code: "E_DEPTH_LIMIT" } });
    expect(log).toEqual([]);
  });

  test("pure functions are evaluated where they're pulled", async () => {
    const twice: FunctionSpec = {
      exec: false,
      inputs: { x: { type: S } },
      outputs: { out: { type: S } },
      nodes: { fe: "core.entry", cc: { type: "std.concat", variadic: 2 }, fr: "core.return" },
      edges: ["fe.x > cc.arg0", "fe.x > cc.arg1", "cc.out > fr.out"],
    };
    const d = doc({
      nodes: {
        s: "p.start",
        tw: { type: "core.call", ref: "twice", literals: { x: "ab" } },
        l: "p.log",
      },
      edges: ["s.then > l.exec", "tw.out > l.value"],
      functions: { twice },
    });
    expect((await runDoc(d)).log).toEqual(["abab"]);
  });

  test("capabilities count nodes reached through calls", () => {
    const say: FunctionSpec = {
      exec: true,
      inputs: {},
      outputs: {},
      nodes: { fe: "core.entry", p: "p.peek", fr: "core.return" },
      edges: ["fe.then > p.exec", "p.then > fr.exec"],
    };
    const called = doc({
      nodes: { s: "p.start", c: { type: "core.call", ref: "say" } },
      edges: ["s.then > c.exec"],
      functions: { say },
    });
    expect([...compile(called, probe).capabilities]).toEqual(["log"]);
    expect([
      ...compile(doc({ nodes: { s: "p.start" }, functions: { say } }), probe).capabilities,
    ]).toEqual([]);
  });
});

describe("variables", () => {
  test("get reads the slot when pulled, set writes it; reading an unset one faults", async () => {
    const d = doc({
      nodes: {
        s: "p.start",
        before: "p.log",
        g1: { type: "core.get", ref: "count" },
        set: { type: "core.set", ref: "count", literals: { value: 5 } },
        after: "p.log",
        g2: { type: "core.get", ref: "count" },
        unset: "p.log",
        g3: { type: "core.get", ref: "none" },
      },
      edges: [
        "s.then > before.exec",
        "g1.value > before.value",
        "before.then > set.exec",
        "set.then > after.exec",
        "g2.value > after.value",
        "after.then > unset.exec",
        "g3.value > unset.value",
      ],
      variables: [
        { id: "count", name: "count", type: N, default: 0 },
        { id: "none", name: "none", type: N },
      ],
    });
    const { result, log } = await runDoc(d);
    expect(log).toEqual([0, 5]);
    expect(result.fault).toMatchObject({ code: "E_UNSET_VALUE", node: "g3" });
  });
});

/** An exec function with no ports; `nodes` defaults to just an entry and a return. */
const fn = (
  nodes: Record<string, NodeSpec> = { fe: "core.entry", fr: "core.return" },
  extra: Partial<FunctionSpec> = {},
): FunctionSpec => ({
  exec: true,
  inputs: {},
  outputs: {},
  nodes,
  ...extra,
});

/** Two functions with the same id can't be written as a record, so the second is appended after building. */
function duplicateFunction(): DocumentV1 {
  const d = doc({ nodes: {}, functions: { f: fn() } });
  d.program.functions.push({
    id: "f",
    name: "f",
    exec: true,
    inputs: {},
    outputs: {},
    graph: { nodes: [], edges: [] },
  });
  return d;
}

describe("structure", () => {
  test.each<[string, DocumentV1, string[]]>([
    [
      "two entries",
      doc({
        nodes: {},
        functions: { f: fn({ fe: "core.entry", fr: "core.return", fe2: "core.entry" }) },
      }),
      ["E_FUNCTION_SHAPE"],
    ],
    [
      "no return",
      doc({ nodes: {}, functions: { f: fn({ fe: "core.entry" }) } }),
      ["E_FUNCTION_SHAPE"],
    ],
    ["entry in the main graph", doc({ nodes: { e: "core.entry" } }), ["E_FUNCTION_SHAPE"]],
    [
      "event node in a function body",
      doc({
        nodes: {},
        functions: { f: fn({ fe: "core.entry", fr: "core.return", ev: "p.start" }) },
      }),
      ["E_FUNCTION_SHAPE"],
    ],
    [
      "exec node in a pure function",
      doc({
        nodes: {},
        functions: {
          f: fn(
            { fe: "core.entry", fr: "core.return", n: { type: "p.note", literals: { text: "x" } } },
            { exec: false },
          ),
        },
      }),
      ["E_FUNCTION_SHAPE"],
    ],
    [
      "call to an unknown function",
      doc({ nodes: { c: { type: "core.call", ref: "nope" } } }),
      ["E_UNKNOWN_REF"],
    ],
    [
      "another function's local",
      doc({
        nodes: {},
        functions: {
          f: fn(undefined, { locals: [{ id: "x", name: "x", type: N }] }),
          g: fn({ ge: "core.entry", gr: "core.return", get: { type: "core.get", ref: "x" } }),
        },
      }),
      ["E_UNKNOWN_REF"],
    ],
    ["duplicate function id", duplicateFunction(), ["E_DUPLICATE_ID"]],
    [
      "undeclared type parameter in a signature",
      doc({ nodes: {}, functions: { f: fn(undefined, { inputs: { x: { type: T } } }) } }),
      ["E_INVALID_TYPE"],
    ],
    [
      "invalid variable default",
      doc({ nodes: {}, variables: [{ id: "v", name: "v", type: N, default: "x" }] }),
      ["E_LITERAL_INVALID"],
    ],
    [
      "generic document variable",
      doc({ nodes: {}, variables: [{ id: "v", name: "v", type: T }] }),
      ["E_INVALID_TYPE"],
    ],
    ["unknown core node", doc({ nodes: { x: "core.nope" } }), ["E_UNKNOWN_NODE_TYPE"]],
  ])("%s", (_, d, expected) => {
    expect(codes(d)).toEqual(expected);
  });
});
