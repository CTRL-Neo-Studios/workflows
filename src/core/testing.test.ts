import { expect, test } from "vitest";
import { archiveDrafts, vertex } from "./fixtures/section10";
import { defineLanguage } from "./language";
import { assertValid, buildDocument, record } from "./testing";

test("record follows class methods and nested objects, keeping `this`", async () => {
  class Files {
    root = "/v";
    async rename(file: string, name: string): Promise<string> {
      return `${this.root}/${name}.md (from ${file})`;
    }
  }
  const rec = record({ fs: new Files(), deep: { index: { byTag: (tag: string) => [tag] } } });
  expect(await rec.effects.fs.rename("/v/a.md", "b")).toBe("/v/b.md (from /v/a.md)");
  expect(rec.effects.deep.index.byTag("x")).toEqual(["x"]);
  expect(rec.log()).toEqual(["fs.rename(/v/a.md, b)", "deep.index.byTag(x)"]);
});

test("assertValid lists every diagnostic", () => {
  const doc = archiveDrafts();
  doc.program.graph.edges.find((e) => e.id === "e7")!.from = { node: "n4", port: "name" };
  expect(() => assertValid(doc, vertex)).toThrow(
    'Document has 1 diagnostic(s):\n  E_TYPE_MISMATCH e7: string → vertex.File at {"edge":"e7"}',
  );
  expect(assertValid(archiveDrafts(), vertex).diagnostics).toEqual([]);
});

test("buildDocument takes node versions from the manifest unless given", () => {
  const lang = defineLanguage({ id: "x", version: 2 })
    .node({ type: "x.go", version: 3, mode: "event", label: "Go", exec: { out: ["then"] } })
    .build();
  const doc = buildDocument(lang, {
    nodes: { a: "x.go", b: { type: "x.go", version: 1 }, c: "core.entry" },
  });
  expect(doc.language).toEqual({ id: "x", version: 2 });
  expect(doc.program.graph.nodes.map((n) => n.version)).toEqual([3, 1, 1]);
});
