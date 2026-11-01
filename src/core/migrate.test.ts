import { describe, expect, test } from "vitest";
import type { DocumentV1 } from "./document";
import { buildDocument } from "./testing";
import { archiveDrafts, vertex } from "./fixtures/section10";
import { hashProgram } from "./hash";
import { defineLanguage } from "./language";
import { migrate } from "./migrate";
import { t } from "./types";
import { validate } from "./validate";

/** Language v3 whose `m.say` node is v3; every migration step records itself. */
function versioned(steps: string[]) {
  return defineLanguage({
    id: "m",
    version: 3,
    migrate: {
      1: (program) => (steps.push("language 1→2"), program),
      2: (program) => (steps.push("language 2→3"), program),
    },
  })
    .node({ type: "m.go", version: 1, mode: "event", label: "Go", exec: { out: ["then"] } })
    .node({
      type: "m.say",
      version: 3,
      mode: "exec",
      label: "Say",
      inputs: { text: { type: t("string") } },
      migrate: {
        // v1 called the input `msg`; v2 kept it in `literals.message`; v3 uses `text`.
        1: (n) => (steps.push("node 1→2"), { ...n, literals: { message: n.literals?.msg ?? "" } }),
        2: (n) => (steps.push("node 2→3"), { ...n, literals: { text: n.literals?.message ?? "" } }),
      },
      run: () => {},
    })
    .build();
}

/** What a v1 file looked like: language v1, `m.say` v1 with its old `msg` literal. */
function oldDoc(): Record<string, unknown> {
  const doc = buildDocument(versioned([]), {
    nodes: { g: "m.go", s: { type: "m.say", version: 1, literals: { msg: "hi" } } },
    edges: ["g.then > s.exec"],
  });
  doc.language.version = 1;
  return JSON.parse(JSON.stringify(doc));
}

describe("migrate", () => {
  test("runs language migrations, then node migrations, one version at a time", () => {
    const steps: string[] = [];
    const lang = versioned(steps);
    const result = migrate(oldDoc(), lang);
    if (!("doc" in result)) throw new Error(JSON.stringify(result.diagnostics));
    expect(steps).toEqual(["language 1→2", "language 2→3", "node 1→2", "node 2→3"]);
    expect(result.changed).toBe(true);
    expect(result.doc.language).toEqual({ id: "m", version: 3 });
    expect(result.doc.program.graph.nodes[1]).toEqual({
      id: "s",
      type: "m.say",
      version: 3,
      literals: { text: "hi" },
    });
    expect(validate(result.doc, lang.manifest).diagnostics).toEqual([]);
  });

  test("a current document comes back unchanged", () => {
    const input = archiveDrafts();
    const result = migrate(JSON.parse(JSON.stringify(input)), vertex);
    expect(result).toEqual({ doc: input, changed: false });
  });

  test.each<[string, (d: Record<string, unknown>) => void, string]>([
    ["newer format", (d) => void (d.format = 2), "E_NEWER_FORMAT"],
    [
      "newer language",
      (d) => void ((d.language as { version: number }).version = 4),
      "E_NEWER_LANGUAGE",
    ],
    [
      "other language",
      (d) => void ((d.language as { id: string }).id = "x"),
      "E_LANGUAGE_MISMATCH",
    ],
    [
      "newer node",
      (d) => void ((d.program as DocumentV1["program"]).graph.nodes[1]!.version = 9),
      "E_NEWER_NODE",
    ],
  ])("%s: not migrated, read-only", (_, mutate, code) => {
    const raw = oldDoc();
    mutate(raw);
    const result = migrate(raw, versioned([]));
    expect("diagnostics" in result && result.diagnostics.map((d) => d.code)).toEqual([code]);
  });

  test("a missing migration step is a language bug and throws", () => {
    const lang = defineLanguage({ id: "m", version: 2 }).build();
    expect(() =>
      migrate(
        { ...oldDoc(), program: { graph: { nodes: [], edges: [] }, variables: [], functions: [] } },
        lang,
      ),
    ).toThrow("Language 'm' has no migration from v1");
  });
});

const deep = (levels: number, leaf: unknown, wrap: (x: unknown) => unknown): unknown => {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = wrap(value);
  return value;
};
const withNode = (node: Record<string, unknown>): Record<string, unknown> => {
  const raw = JSON.parse(JSON.stringify(archiveDrafts()));
  raw.program.graph.nodes.push({ id: "x", type: "std.length", version: 1, ...node });
  return raw;
};
const invalid = (raw: unknown): string | undefined => {
  const result = migrate(raw, vertex);
  return "diagnostics" in result
    ? `${result.diagnostics[0]!.code} ${result.diagnostics[0]!.message}`
    : undefined;
};
describe("parsing untrusted input", () => {
  test.each<[string, unknown, string]>([
    ["not an object", "{}", "E_INVALID_DOCUMENT $: expected an object"],
    ["no format", {}, "E_INVALID_DOCUMENT format: expected an integer ≥ 1"],
    [
      "missing program",
      { format: 1, language: { id: "vertex", version: 1 }, view: { positions: {}, groups: [] } },
      "E_INVALID_DOCUMENT program: expected an object",
    ],
    [
      "bad node version",
      withNode({ version: "1" }),
      "E_INVALID_DOCUMENT program.graph.nodes[7].version: expected an integer ≥ 1",
    ],
    [
      "bad term kind",
      withNode({ typeArgs: { T: { kind: "fn" } } }),
      'E_INVALID_DOCUMENT program.graph.nodes[7].typeArgs.T.kind: expected "con" or "var"',
    ],
  ])("%s", (_, raw, message) => {
    expect(invalid(raw)).toBe(message);
  });

  test("hostile nesting is rejected without overflowing the stack", () => {
    const term = deep(100_000, { kind: "con", id: "string" }, (x) => ({
      kind: "con",
      id: "List",
      args: [x],
    }));
    expect(invalid(withNode({ typeArgs: { T: term } }))).toMatch(
      /E_INVALID_DOCUMENT .*nested at most 64/,
    );
    const literal = deep(100_000, 1, (x) => [x]);
    expect(invalid(withNode({ literals: { list: literal } }))).toMatch(
      /E_INVALID_DOCUMENT .*nested at most 256/,
    );
  });

  test("keeps only known fields, drops engine-only ones, and can't pollute prototypes", () => {
    const raw = withNode({
      junk: 1,
      typeArgs: { T: { kind: "var", name: "T", rigid: true, bound: { kind: "con", id: "any" } } },
      literals: JSON.parse('{"list": {"__proto__": {"polluted": true}}}'),
    });
    raw.extra = "x";
    const result = migrate(raw, vertex);
    if (!("doc" in result)) throw new Error("expected a document");
    const x = result.doc.program.graph.nodes.at(-1)!;
    expect(Object.keys(result.doc)).toEqual(["format", "language", "program", "view"]);
    expect(x).not.toHaveProperty("junk");
    expect(x.typeArgs).toEqual({ T: { kind: "var", name: "T" } });
    expect(Object.hasOwn(x.literals!.list as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("hashProgram", () => {
  test("ignores view, meta and key order; changes with the program", async () => {
    const a = archiveDrafts();
    const b = archiveDrafts();
    b.view.positions = { n1: { x: 10, y: 20 } };
    b.meta = { name: "Archive" };
    const c: DocumentV1 = JSON.parse(
      JSON.stringify({ view: a.view, program: a.program, language: a.language, format: a.format }),
    );
    const d = archiveDrafts();
    d.program.graph.nodes[1]!.literals = { tag: "final" };

    const [ha, hb, hc, hd] = await Promise.all([a, b, c, d].map(hashProgram));
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(hb).toBe(ha);
    expect(hc).toBe(ha);
    expect(hd).not.toBe(ha);
  });
});
