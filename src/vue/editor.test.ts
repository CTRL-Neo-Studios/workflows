import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { archiveDrafts, vertex } from "../core/fixtures/section10";
import { record, run } from "../core/testing";
import { useWorkflowEditor } from "./editor";

const editorFor = (doc = archiveDrafts()) => useWorkflowEditor(vertex.manifest, doc);
const p = (ref: string) => {
  const [node = "", port = ""] = ref.split(".");
  return { node, port };
};
const edgesOf = (e: ReturnType<typeof editorFor>): string[] =>
  e.graph.value.edges.map((x) => `${x.from.node}.${x.from.port} > ${x.to.node}.${x.to.port}`);

describe("connect", () => {
  test("replaces the edge on a wired data input and on a wired exec output", () => {
    const e = editorFor();
    const id = e.connect(p("n4.name"), p("n5.newName")); // n6.out > n5.newName goes
    e.connect(p("n3.done"), p("n7.exec")); // n5.then > n7.exec stays: exec inputs take many edges
    e.connect(p("n3.done"), p("n5.exec")); // n3.done > n7.exec goes: an exec output has one edge
    expect(id).toBe("e10");
    expect(edgesOf(e)).toContain("n4.name > n5.newName");
    expect(edgesOf(e)).not.toContain("n6.out > n5.newName");
    expect(edgesOf(e)).toContain("n5.then > n7.exec");
    expect(edgesOf(e)).toContain("n3.done > n5.exec");
    expect(edgesOf(e)).not.toContain("n3.done > n7.exec");
    expect(e.analysis.value.diagnostics).toEqual([]);
    // Checking a drag still works once edits have rebuilt the edge arrays through the reactive proxy.
    expect(e.connectionProblem(p("n6.out"), p("n5.newName"))).toBeUndefined();
  });

  test("connectionProblem refuses wiring and type errors, not unset values", () => {
    const e = editorFor();
    // §10's negative case, as a drag: it would replace e7 with a string into a File input.
    expect(e.connectionProblem(p("n4.name"), p("n5.file"))?.message).toMatch(
      /string → vertex\.File/,
    );
    expect(e.connectionProblem(p("n5.then"), p("n7.file"))?.code).toBe("E_KIND_MISMATCH");
    expect(e.connectionProblem(p("n7.then"), p("n5.exec"))?.code).toBe("E_EXEC_CYCLE");
    expect(e.connectionProblem(p("n5.file"), p("n7.file"))).toBeUndefined(); // replaces e9 with itself

    // A fresh Rename: wiring its exec in leaves its data inputs unset, which is fine mid-edit.
    const fresh = e.addNode("vertex.rename");
    expect(e.connectionProblem(p("n7.then"), p(`${fresh}.exec`))).toBeUndefined();
  });
});

test("ids are unique across function bodies", () => {
  const doc = archiveDrafts();
  doc.program.functions.push({
    id: "f",
    name: "f",
    exec: true,
    inputs: {},
    outputs: {},
    graph: { nodes: [{ id: "n41", type: "core.entry", version: 1 }], edges: [] },
  });
  expect(editorFor(doc).addNode("std.not", { x: 0, y: 0 })).toBe("n42");
});

test("shrinking a variadic drops the edges and literals of ports that go away", () => {
  const e = editorFor();
  e.setVariadic("n6", 3);
  e.setLiteral("n6", "arg2", "!");
  e.connect(p("n4.name"), p("n6.arg1"));
  e.setVariadic("n6", 1);
  const n6 = e.graph.value.nodes.find((n) => n.id === "n6");
  expect(n6?.variadic).toBe(1);
  expect(n6?.literals).toBeUndefined();
  expect(edgesOf(e).filter((x) => x.includes("n6.arg"))).toEqual(["n4.name > n6.arg0"]);
});

test("removing a node removes its edges and position", () => {
  const doc = archiveDrafts();
  doc.view.positions.n4 = { x: 1, y: 2 };
  const e = editorFor(doc);
  e.removeNodes(["n4"]);
  expect(edgesOf(e).some((x) => x.includes("n4."))).toBe(false);
  expect(e.document.value.view.positions.n4).toBeUndefined();
  expect(e.analysis.value.diagnostics.map((d) => d.code)).toEqual(["E_REQUIRED_INPUT"]); // n6.arg0
});

test("a run's trace marks fired exec edges and value-carrying data edges; edits clear it", async () => {
  const e = editorFor();
  const vault = { "/v/a.md": "a" };
  const { trace } = await run(vertex, e.document.value, {
    event: "vertex.onManual",
    trace: "values",
    effects: record({
      index: { byTag: async () => Object.keys(vault) },
      fs: {
        rename: async (_: string, name: string) => `/v/${name}.md`,
        setProperty: async () => {},
      },
    }).effects,
  });
  e.trace.value = trace;
  const { nodes, edges } = e.traced.value;
  const byId = new Map(e.graph.value.edges.map((x) => [x.id, `${x.from.node}.${x.from.port}`]));
  expect([...edges].map((id) => byId.get(id)).toSorted()).toEqual(
    // Every edge: n1.then (exit), n3.body (fire), n5.then (exit), and each data edge carried a value.
    [...byId.values()].toSorted(),
  );
  expect(nodes.get("n5")).toMatchObject({
    runs: 1,
    values: new Map([["file", "/v/a_archive.md"]]),
  });

  e.setLiteral("n2", "tag", "other");
  await nextTick();
  expect(e.trace.value).toEqual([]);
});
