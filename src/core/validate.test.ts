import { describe, expect, test } from "vitest";
import type { DocumentV1, EdgeInstance, NodeInstance } from "./document";
import { archiveDrafts, std, vertex } from "./fixtures/section10";
import { defineLanguage } from "./language";
import { formatType, t, tvar, type TypeTerm } from "./types";
import { validate, type Analysis } from "./validate";

const codes = (a: Analysis): string[] => a.diagnostics.map((d) => d.code);
const typeOf = (a: Analysis, node: string, port: string, dir: "in" | "out"): string | undefined => {
  const term = a.typeOf(node, port, dir);
  return term && formatType(term);
};
const nest = (term: TypeTerm, levels: number): TypeTerm => {
  for (let i = 0; i < levels; i++) term = t("List", term);
  return term;
};

describe("§10 worked example", () => {
  test("infers the documented types and capabilities", () => {
    const a = validate(archiveDrafts(), vertex.manifest);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "n3", "list", "in")).toBe("List<vertex.File>");
    expect(typeOf(a, "n3", "item", "out")).toBe("vertex.File");
    expect(typeOf(a, "n7", "value", "in")).toBe("string");
    expect(typeOf(a, "n3", "body", "out")).toBeUndefined(); // exec port
    expect([...a.capabilities].toSorted()).toEqual(["fs", "index"]);
    expect(a.convertedEdges.size).toBe(0);
  });

  test("e7 rewired to n4.name → n5.file", () => {
    const doc = archiveDrafts();
    const e7 = doc.program.graph.edges.find((e) => e.id === "e7")!;
    e7.from = { node: "n4", port: "name" };
    expect(validate(doc, vertex.manifest).diagnostics).toEqual([
      {
        code: "E_TYPE_MISMATCH",
        severity: "error",
        message: "e7: string → vertex.File",
        at: { edge: "e7" },
      },
    ]);
  });

  test("n7.typeArgs removed", () => {
    const doc = archiveDrafts();
    delete doc.program.graph.nodes.find((n) => n.id === "n7")!.typeArgs;
    const { diagnostics } = validate(doc, vertex.manifest);
    expect(diagnostics.map((d) => [d.code, d.at])).toEqual([
      ["E_UNRESOLVED_TYPE", { node: "n7", port: "value" }],
    ]);
  });

  test("results don't depend on edge order", () => {
    const doc = archiveDrafts();
    doc.program.graph.edges.reverse();
    doc.program.graph.nodes.reverse();
    const a = validate(doc, vertex.manifest);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "n3", "item", "out")).toBe("vertex.File");
  });

  test("capabilities only count nodes reachable from an event", () => {
    const doc = archiveDrafts();
    doc.program.graph.edges = doc.program.graph.edges.filter((e) => e.id !== "e1");
    expect([...validate(doc, vertex.manifest).capabilities]).toEqual([]);
  });
});

// A language exercising §3.3–3.4 directly.
const T = tvar("T");
const List = (x: TypeTerm): TypeTerm => t("List", x);
const Entry = t("vertex.Entry");
const lang = defineLanguage({ id: "t", version: 1, include: [std] })
  .type({ id: "vertex.Entry" })
  .type({ id: "vertex.File", extends: Entry })
  .type({ id: "vertex.Note", extends: t("vertex.File") })
  .type({ id: "vertex.Folder", extends: Entry })
  .type({ id: "vertex.Path", extends: t("string"), schema: { type: "string" } })
  .conversion({ from: t("number"), to: t("string"), convert: String })
  .node({
    type: "t.note",
    version: 1,
    mode: "pure",
    label: "Note",
    outputs: { v: { type: t("vertex.Note") } },
    run: () => ({}),
  })
  .node({
    type: "t.folder",
    version: 1,
    mode: "pure",
    label: "Folder",
    outputs: { v: { type: t("vertex.Folder") } },
    run: () => ({}),
  })
  .node({
    type: "t.num",
    version: 1,
    mode: "pure",
    label: "Num",
    outputs: { v: { type: t("number") } },
    run: () => ({}),
  })
  .node({
    type: "t.path",
    version: 1,
    mode: "pure",
    label: "Path",
    outputs: { v: { type: t("vertex.Path") } },
    run: () => ({}),
  })
  .node({
    type: "t.nested",
    version: 1,
    mode: "pure",
    label: "Nested",
    outputs: { v: { type: List(List(t("string"))) } },
    run: () => ({}),
  })
  .node({
    type: "t.pair",
    version: 1,
    mode: "pure",
    label: "Pair",
    typeParams: [{ name: "T" }],
    inputs: { a: { type: T }, b: { type: T } },
    outputs: { list: { type: List(T) } },
    run: () => ({}),
  })
  .node({
    type: "t.empty",
    version: 1,
    mode: "pure",
    label: "Empty",
    typeParams: [{ name: "T" }],
    outputs: { list: { type: List(T) } },
    run: () => ({}),
  })
  .node({
    type: "t.flatten",
    version: 1,
    mode: "pure",
    label: "Flatten",
    typeParams: [{ name: "T" }],
    inputs: { list: { type: List(List(T)) } },
    outputs: { list: { type: List(T) } },
    run: () => ({}),
  })
  .node({
    type: "t.dict",
    version: 1,
    mode: "pure",
    label: "Dict",
    typeParams: [{ name: "K" }],
    inputs: { key: { type: tvar("K") } },
    outputs: { dict: { type: t("Dictionary", tvar("K"), t("number")) } },
    run: () => ({}),
  })
  .node({
    type: "t.keep",
    version: 1,
    mode: "pure",
    label: "Keep",
    typeParams: [{ name: "T", bound: Entry }],
    inputs: { x: { type: T } },
    outputs: { x: { type: T } },
    run: () => ({}),
  })
  .node({
    type: "t.wrap",
    version: 1,
    mode: "exec",
    label: "Wrap",
    typeParams: [{ name: "T" }],
    inputs: { x: { type: T } },
    outputs: { list: { type: List(T) } },
    run: () => {},
  })
  .node({
    type: "t.files",
    version: 1,
    mode: "exec",
    label: "Files",
    inputs: { files: { type: List(t("vertex.File")) } },
    run: () => {},
  })
  .node({
    type: "t.text",
    version: 1,
    mode: "exec",
    label: "Text",
    inputs: { s: { type: t("string") } },
    run: () => {},
  })
  .node({
    type: "t.strs",
    version: 1,
    mode: "exec",
    label: "Strs",
    inputs: { list: { type: List(t("string")) } },
    run: () => {},
  })
  .build();

/** `nodes` as `id: type`, edges as `from.port>to.port`. */
function check(
  nodes: Record<string, string | Omit<NodeInstance, "id" | "version">>,
  edges: string[],
): Analysis {
  const doc: DocumentV1 = {
    format: 1,
    language: { id: "t", version: 1 },
    program: {
      graph: {
        nodes: Object.entries(nodes).map(([id, n]) =>
          typeof n === "string" ? { id, type: n, version: 1 } : { id, version: 1, ...n },
        ),
        edges: edges.map((spec, i): EdgeInstance => {
          const [from = "", to = ""] = spec.split(">");
          const [fn = "", fp = ""] = from.split(".");
          const [tn = "", tp = ""] = to.split(".");
          return { id: `e${i + 1}`, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
        }),
      },
      variables: [],
      functions: [],
    },
    view: { positions: {}, groups: [] },
  };
  return validate(doc, lang.manifest);
}

describe("inference", () => {
  test("a variable with several lower bounds takes their join", () => {
    const a = check({ n: "t.note", f: "t.folder", p: "t.pair" }, ["n.v>p.a", "f.v>p.b"]);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "p", "list", "out")).toBe("List<vertex.Entry>");
  });

  test("no common type is an error, never a silent any", () => {
    const a = check({ n: "t.note", x: "t.num", p: "t.pair" }, ["n.v>p.a", "x.v>p.b"]);
    expect(codes(a)).toEqual(["E_NO_COMMON_TYPE"]);
    expect(a.diagnostics[0]?.message).toMatch(/vertex\.Note.*number|number.*vertex\.Note/);
    expect(typeOf(a, "p", "list", "out")).toBe("List<T>");
  });

  test("pinning T to any accepts both", () => {
    const a = check({ n: "t.note", x: "t.num", p: { type: "t.pair", typeArgs: { T: t("any") } } }, [
      "n.v>p.a",
      "x.v>p.b",
    ]);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "p", "list", "out")).toBe("List<any>");
  });

  test("a variable with only an upper bound takes it", () => {
    const a = check({ e: "t.empty", f: "t.files" }, ["e.list>f.files"]);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "e", "list", "out")).toBe("List<vertex.File>");
  });

  test("nested generics through forEach and flatten", () => {
    const a = check({ n: "t.nested", each: "std.forEach", flat: "t.flatten" }, [
      "n.v>each.list",
      "n.v>flat.list",
    ]);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "each", "item", "out")).toBe("List<string>");
    expect(typeOf(a, "flat", "list", "out")).toBe("List<string>");
  });

  test("Dictionary keys must be key types; key-ness is inherited", () => {
    expect(codes(check({ n: "t.note", d: "t.dict" }, ["n.v>d.key"]))).toEqual(["E_KEY_TYPE"]);
    const a = check({ p: "t.path", d: "t.dict" }, ["p.v>d.key"]);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "d", "dict", "out")).toBe("Dictionary<vertex.Path, number>");
  });

  test("a self-referential variable fails instead of looping", () => {
    expect(codes(check({ w: "t.wrap" }, ["w.list>w.x"]))).toEqual(["E_INFINITE_TYPE"]);
  });

  test("a chain of 100 generic nodes settles (more than the base round limit)", () => {
    const nodes: Record<string, string> = { n: "t.note" };
    const edges = ["n.v>k0.x"];
    for (let i = 0; i < 100; i++) {
      nodes[`k${i}`] = "t.keep";
      if (i) edges.push(`k${i - 1}.x>k${i}.x`);
    }
    const a = check(nodes, edges);
    expect(a.diagnostics).toEqual([]);
    expect(typeOf(a, "k99", "x", "out")).toBe("vertex.Note");
  });

  test("bounded parameters keep the caller's subtype and fall back to the bound", () => {
    const kept = check({ n: "t.note", k: "t.keep" }, ["n.v>k.x"]);
    expect(kept.diagnostics).toEqual([]);
    expect(typeOf(kept, "k", "x", "out")).toBe("vertex.Note");
    expect(typeOf(check({ k: "t.keep" }, []), "k", "x", "out")).toBe("vertex.Entry");
    expect(
      check({ x: "t.num", k: "t.keep" }, ["x.v>k.x"]).diagnostics.map((d) => d.message),
    ).toEqual(["T = number is not a vertex.Entry"]);
    expect(codes(check({ k: { type: "t.keep", typeArgs: { T: t("number") } } }, []))).toEqual([
      "E_TYPE_MISMATCH",
    ]);
  });

  test("conversions apply to ground edges only, never inside type arguments", () => {
    const a = check({ x: "t.num", s: "t.text" }, ["x.v>s.s"]);
    expect(a.diagnostics).toEqual([]);
    expect([...a.convertedEdges]).toEqual(["e1"]);
    const b = check({ x: "t.num", p: "t.pair", s: "t.strs" }, ["x.v>p.a", "p.list>s.list"]);
    expect(b.diagnostics.map((d) => d.message)).toEqual(["e2: List<number> → List<string>"]);
  });
});

const node = (doc: DocumentV1, id: string): NodeInstance =>
  doc.program.graph.nodes.find((n) => n.id === id)!;
const addEdge = (doc: DocumentV1, id: string, from: string, to: string): void => {
  const [fn = "", fp = ""] = from.split(".");
  const [tn = "", tp = ""] = to.split(".");
  doc.program.graph.edges.push({ id, from: { node: fn, port: fp }, to: { node: tn, port: tp } });
};
describe("structure and literals", () => {
  test.each<[string, (doc: DocumentV1) => void, string[]]>([
    [
      "duplicate node id",
      (d) => void d.program.graph.nodes.push({ id: "n1", type: "vertex.onManual", version: 1 }),
      ["E_DUPLICATE_ID"],
    ],
    ["duplicate edge id", (d) => addEdge(d, "e1", "n7.then", "n3.exec"), ["E_DUPLICATE_ID"]],
    [
      "unknown node type",
      (d) => void (node(d, "n1").type = "vertex.nope"),
      ["E_UNKNOWN_NODE_TYPE"],
    ],
    ["outdated node", (d) => void (node(d, "n4").version = 0), ["E_NODE_OUTDATED"]],
    ["newer node", (d) => void (node(d, "n4").version = 2), ["E_NEWER_NODE"]],
    ["unknown port", (d) => void (d.program.graph.edges[3]!.to.port = "nope"), ["E_UNKNOWN_PORT"]],
    [
      "prototype key is not a port",
      (d) => void (d.program.graph.edges[3]!.to.port = "constructor"),
      ["E_UNKNOWN_PORT"],
    ],
    ["exec into data", (d) => addEdge(d, "x", "n3.body", "n4.file"), ["E_KIND_MISMATCH"]],
    [
      "edge into a literal-only input",
      (d) => addEdge(d, "x", "n4.name", "n2.tag"),
      ["E_KIND_MISMATCH"],
    ],
    ["exec fan-out", (d) => addEdge(d, "x", "n3.body", "n7.exec"), ["E_EXEC_FANOUT"]],
    ["data fan-in", (d) => addEdge(d, "x", "n3.item", "n5.file"), ["E_DATA_FANIN"]],
    ["exec cycle", (d) => addEdge(d, "x", "n7.then", "n5.exec"), ["E_EXEC_CYCLE"]],
    [
      "data cycle through pure nodes",
      (d) => addEdge(d, "x", "n6.out", "n6.arg1"),
      ["E_DATA_CYCLE"],
    ],
    ["edge to a missing node", (d) => addEdge(d, "x", "n1.then", "ghost.exec"), ["E_UNKNOWN_REF"]],
    [
      "edge into a function body",
      (d) => {
        d.program.functions.push({
          id: "f",
          name: "f",
          exec: true,
          inputs: {},
          outputs: {},
          graph: { nodes: [{ id: "f1", type: "vertex.rename", version: 1 }], edges: [] },
        });
        addEdge(d, "x", "n7.then", "f1.exec");
      },
      ["E_CROSS_GRAPH"],
    ],
    [
      "literal on a missing port",
      (d) => void (node(d, "n4").literals = { nope: 1 }),
      ["E_UNKNOWN_PORT"],
    ],
    ["invalid literal", (d) => void (node(d, "n2").literals = { tag: 5 }), ["E_LITERAL_INVALID"]],
    [
      "literal for an opaque type",
      (d) => {
        d.program.graph.edges = d.program.graph.edges.filter((e) => e.id !== "e4");
        node(d, "n4").literals = { file: "/v/a.md" };
      },
      ["E_LITERAL_INVALID"],
    ],
    [
      "required input without value",
      (d) => void delete node(d, "n2").literals,
      ["E_REQUIRED_INPUT"],
    ],
    [
      "variadic input without value",
      (d) => void delete node(d, "n6").literals,
      ["E_REQUIRED_INPUT"],
    ],
    ["variadic count below min", (d) => void (node(d, "n6").variadic = 0), ["E_VARIADIC_COUNT"]],
    [
      "variadic count on a fixed node",
      (d) => void (node(d, "n4").variadic = 1),
      ["E_VARIADIC_COUNT"],
    ],
    ["hostile variadic count", (d) => void (node(d, "n6").variadic = 1e9), ["E_VARIADIC_COUNT"]],
    [
      "unknown type parameter",
      (d) => void (node(d, "n7").typeArgs = { U: t("string") }),
      ["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"],
    ],
    [
      "non-concrete type argument",
      (d) => void (node(d, "n7").typeArgs = { T: tvar("X") }),
      ["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"],
    ],
    [
      "unknown type in type argument",
      (d) => void (node(d, "n7").typeArgs = { T: t("nope") }),
      ["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"],
    ],
    [
      "type argument too deep",
      (d) => void (node(d, "n7").typeArgs = { T: nest(t("string"), 40) }),
      ["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"],
    ],
    [
      "hostile 100k-deep type argument",
      (d) => void (node(d, "n7").typeArgs = { T: nest(t("string"), 100_000) }),
      ["E_INVALID_TYPE", "E_UNRESOLVED_TYPE"],
    ],
    [
      "other language",
      (d) => void (d.language = { id: "other", version: 1 }),
      ["E_LANGUAGE_MISMATCH"],
    ],
    [
      "newer language",
      (d) => void (d.language = { id: "vertex", version: 2 }),
      ["E_NEWER_LANGUAGE"],
    ],
  ])("%s", (_, mutate, expected) => {
    const doc = archiveDrafts();
    mutate(doc);
    expect(codes(validate(doc, vertex.manifest))).toEqual(expected);
  });
});
