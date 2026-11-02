import { afterEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { archiveDrafts, vertex } from "../core/fixtures/section10";
import { record, run } from "../core/testing";
import { defineLanguage } from "../core";
import { std } from "../core/std";
import { arrange, parseClip, useWorkflowEditor, type PortEnd } from "./editor";

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

const literal = (e: ReturnType<typeof editorFor>) =>
  e.graph.value.nodes.find((n) => n.id === "n2")?.literals?.tag;
const out = (ref: string, exec = false): PortEnd => ({ ...p(ref), side: "out", exec });
const into = (ref: string, exec = false): PortEnd => ({ ...p(ref), side: "in", exec });

describe("history", () => {
  afterEach(() => vi.useRealTimers());

  test("steps through edits; repeats of one edit under 500 ms apart are one step; the viewport isn't an edit", async () => {
    vi.useFakeTimers();
    const e = editorFor();
    const original = JSON.stringify(e.document.value.program);
    e.addNode("std.not", { x: 0, y: 0 });
    await nextTick();
    vi.advanceTimersByTime(100); // a different edit right after is still its own step
    e.setLiteral("n2", "tag", "a"); // typing: two keystrokes, one step
    await nextTick();
    vi.advanceTimersByTime(100);
    e.setLiteral("n2", "tag", "ab");
    await nextTick();
    vi.advanceTimersByTime(100);
    e.document.value.view.viewport = { x: 5, y: 5, zoom: 1 };
    await nextTick();

    e.undo();
    await nextTick();
    expect(literal(e)).toBe("draft");
    expect(e.graph.value.nodes.some((n) => n.id === "n8")).toBe(true);
    expect(e.document.value.view.viewport).toEqual({ x: 5, y: 5, zoom: 1 });
    e.undo();
    await nextTick();
    expect(JSON.stringify(e.document.value.program)).toBe(original);
    expect(e.canUndo.value).toBe(false);

    e.redo();
    e.redo();
    await nextTick();
    expect(literal(e)).toBe("ab");
    expect(e.canRedo.value).toBe(false);

    e.undo();
    await nextTick();
    expect(e.canRedo.value).toBe(true);
    e.removeNodes(["n8"]); // a new edit drops what could be redone
    await nextTick();
    expect(e.canRedo.value).toBe(false);
  });
});

describe("clipboard", () => {
  test("copy keeps the edges between copied nodes; paste gives fresh ids and shifts positions", () => {
    const doc = archiveDrafts();
    doc.view.positions.n4 = { x: 100, y: 50 };
    doc.view.positions.n6 = { x: 300, y: 80 };
    const e = editorFor(doc);
    const clip = e.copy(["n4", "n6", "missing"]);
    expect(clip?.nodes.map((n) => n.id)).toEqual(["n4", "n6"]);
    expect(
      clip?.edges.map((x) => `${x.from.node}.${x.from.port} > ${x.to.node}.${x.to.port}`),
    ).toEqual(["n4.name > n6.arg0"]);

    const ids = e.paste(clip!, { x: 0, y: 0 }); // top-left corner at (0, 0)
    expect(ids).toEqual(["n8", "n9"]);
    expect(edgesOf(e)).toContain("n8.name > n9.arg0");
    expect(e.graph.value.nodes.find((n) => n.id === "n9")).toMatchObject({
      variadic: 2,
      literals: { arg1: "_archive" },
    });
    expect(e.document.value.view.positions.n8).toEqual({ x: 0, y: 0 });
    expect(e.document.value.view.positions.n9).toEqual({ x: 200, y: 30 });

    expect(e.duplicate(["n4"])).toEqual(["n10"]);
    expect(e.document.value.view.positions.n10).toEqual({ x: 132, y: 82 });
  });

  test("a clip from another language pastes nothing", () => {
    const e = editorFor();
    const clip = { ...e.copy(["n4"])!, language: "other" };
    expect(e.paste(clip)).toEqual([]);
    expect(e.graph.value.nodes).toHaveLength(7);
  });

  test("parseClip accepts a copy and rejects text that isn't one", () => {
    const clip = editorFor().copy(["n4", "n6"])!;
    expect(parseClip(JSON.stringify(clip))).toEqual(clip);
    expect(parseClip("hello")).toBeUndefined();
    expect(parseClip(JSON.stringify({ ...clip, format: "x" }))).toBeUndefined();
    const badEdge = {
      ...clip,
      edges: [{ id: "e1", from: { node: "n4" }, to: { node: "n6", port: "arg0" } }],
    };
    expect(parseClip(JSON.stringify(badEdge))).toBeUndefined();
    const badPos = { ...clip, positions: { n4: { x: "1", y: 0 } } };
    expect(parseClip(JSON.stringify(badPos))).toBeUndefined();
  });

  test("pasting from a clipboard that can't be read falls back to the last copy", async () => {
    const denied = { read: () => Promise.reject(new Error("denied")), write: async () => {} };
    const e = useWorkflowEditor(vertex.manifest, archiveDrafts(), { clipboard: denied });
    await e.copyToClipboard(["n4"]);
    expect(await e.pasteFromClipboard()).toEqual(["n8"]);

    // A readable clipboard holding other text wins: the user copied that since.
    const text = { read: async () => "some text", write: async () => {} };
    const other = useWorkflowEditor(vertex.manifest, archiveDrafts(), { clipboard: text });
    expect(await other.pasteFromClipboard()).toEqual([]);
  });
});

describe("wiring new nodes", () => {
  test("fit finds the port of a new node that takes a dragged wire, or none", () => {
    const e = editorFor();
    expect(e.fit("std.forEach", {}, [out("n2.files")])).toEqual(["list"]);
    expect(e.fit("std.not", {}, [out("n2.files")])).toBeUndefined(); // a list isn't a boolean
    expect(e.fit("vertex.setProperty", {}, [out("n5.then", true)])).toEqual(["exec"]);
    expect(e.fit("std.not", {}, [out("n5.then", true)])).toBeUndefined(); // pure: no exec input
    expect(e.fit("vertex.fileName", {}, [into("n5.newName")])).toEqual(["name"]);
  });

  test("addWired inserts a node into an edge, replacing it", () => {
    const e = editorFor();
    const edge = e.graph.value.edges.find((x) => x.from.node === "n5" && x.from.port === "then")!;
    const ends = [out("n5.then", true), into("n7.exec", true)];
    const id = e.addWired("vertex.rename", { x: 0, y: 0 }, {}, ends, edge.id);
    expect(edgesOf(e)).toEqual(
      expect.arrayContaining([`n5.then > ${id}.exec`, `${id}.then > n7.exec`]),
    );
    expect(edgesOf(e)).not.toContain("n5.then > n7.exec");
    expect(e.addWired("std.not", { x: 0, y: 0 }, {}, ends)).toBeUndefined();
    expect(e.graph.value.nodes).toHaveLength(8);
  });

  test("disconnect removes the edges at one port, or at a whole node", () => {
    const e = editorFor();
    e.disconnect(out("n3.item"));
    expect(edgesOf(e).filter((x) => x.startsWith("n3."))).toEqual(["n3.body > n5.exec"]);
    e.disconnect("n5");
    expect(edgesOf(e).some((x) => x.includes("n5."))).toBe(false);
  });
});

describe("arrange", () => {
  const rects = [
    { id: "a", x: 0, y: 0, width: 100, height: 40 },
    { id: "b", x: 300, y: 50, width: 60, height: 80 },
    { id: "c", x: 140, y: 10, width: 40, height: 20 },
  ];
  test("aligns edges and centers to the selection's bounds", () => {
    expect(arrange(rects, "left")).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 50 },
      c: { x: 0, y: 10 },
    });
    expect(arrange(rects, "right").b).toEqual({ x: 300, y: 50 });
    expect(arrange(rects, "right").a).toEqual({ x: 260, y: 0 });
    expect(arrange(rects, "center").c).toEqual({ x: 160, y: 10 }); // bounds 0–360, center 180
    expect(arrange(rects, "bottom").a).toEqual({ x: 0, y: 90 }); // bottom 130
    expect(arrange(rects, "middle").c).toEqual({ x: 140, y: 55 });
  });
  test("spacing evenly keeps the outermost nodes and equalizes the gaps", () => {
    // Across: a ends at 100, b starts at 300; c (40 wide) gets 80 px either side.
    expect(arrange(rects, "distributeX")).toEqual({
      a: { x: 0, y: 0 },
      c: { x: 180, y: 10 },
      b: { x: 300, y: 50 },
    });
  });
});

test("categories: the language's by order (only those in use), built-ins after order 0, then namespaces", () => {
  const lang = defineLanguage({ id: "x", version: 1, include: [std] })
    .category({ id: "x.first", label: "First", color: "sky", order: -1 })
    .category({ id: "x.late", label: "Late", order: 1 })
    .category({ id: "x.unused", label: "Unused" })
    .node({
      type: "x.after",
      version: 1,
      mode: "pure",
      label: "After",
      category: "x.late",
      run: () => ({}),
    })
    .node({
      type: "x.go",
      version: 1,
      mode: "event",
      label: "Go",
      category: "x.first",
      exec: { out: ["then"] },
    })
    .node({ type: "y.loose", version: 1, mode: "pure", label: "Loose", run: () => ({}) })
    .build();
  const doc = archiveDrafts();
  doc.language = { id: "x", version: 1 };
  const e = useWorkflowEditor(lang.manifest, doc);
  expect(e.categories.value.map((c) => c.id)).toEqual([
    "x.first",
    "std.control",
    "std.operators",
    "std.text",
    "std.lists",
    "std.dictionaries",
    "core.variables",
    "core.functions",
    "x.late",
    "ns:y",
  ]);
  expect(e.look("x.go")).toMatchObject({ color: "var(--wf-sky)", category: { label: "First" } });
  expect(e.look("y.loose")).toMatchObject({ color: undefined, category: { label: "Y" } });
});

describe("blocks", () => {
  test("renaming and removing ports rewires the calls, the entry and the returns", () => {
    const e = editorFor();
    const f = e.addFunction();
    const [entry, ret] = e.document.value.program.functions[0]!.graph.nodes.map((n) => n.id);
    const input = e.addPort(f, "inputs");
    const output = e.addPort(f, "outputs");
    const call = e.addNode("core.call", { x: 0, y: 0 }, { ref: f });
    e.setLiteral(call, input, "x");
    e.connect(p(`${call}.${output}`), p("n5.newName"));
    e.graphId.value = f;
    e.connect(p(`${entry}.${input}`), p(`${ret}.${output}`));

    expect(e.renamePort(f, "inputs", input, "exec")).toBe(false); // the call's exec input
    expect(e.renamePort(f, "inputs", input, "name")).toBe(true);
    expect(e.renamePort(f, "outputs", output, "result")).toBe(true);
    expect(edgesOf(e)).toContain(`${entry}.name > ${ret}.result`);
    e.graphId.value = "main";
    expect(edgesOf(e)).toContain(`${call}.result > n5.newName`);
    expect(e.graph.value.nodes.find((n) => n.id === call)?.literals).toEqual({ name: "x" });

    e.removePort(f, "outputs", "result");
    expect(edgesOf(e).filter((x) => x.startsWith(`${call}.`))).toEqual([]);
  });

  test("an exit's returns follow its renames and go with it; the last exit stays", () => {
    const e = editorFor();
    const f = e.addFunction();
    e.graphId.value = f;
    const exit = e.addPort(f, "exits");
    const ret = e.addNode("core.return", undefined, { ref: exit });
    e.renamePort(f, "exits", exit, "failed");
    expect(e.graph.value.nodes.find((n) => n.id === ret)?.ref).toBe("failed");
    e.removePort(f, "exits", "failed");
    e.removePort(f, "exits", "then");
    expect(e.graph.value.nodes.some((n) => n.id === ret)).toBe(false);
    expect(e.document.value.program.functions[0]!.exits).toEqual(["then"]);
  });

  test("removing a variable or a block removes the nodes using it", () => {
    const e = editorFor();
    const v = e.addVariable();
    const get = e.addNode("core.get", undefined, { ref: v });
    const f = e.addFunction();
    const call = e.addNode("core.call", undefined, { ref: f });
    e.removeVariable(v);
    e.removeFunction(f);
    expect(e.graph.value.nodes.some((n) => n.id === get || n.id === call)).toBe(false);
    expect(e.analysis.value.diagnostics).toEqual([]);
  });

  test("make block is one undo step", async () => {
    const e = editorFor();
    const before = JSON.stringify(e.document.value.program);
    expect(e.makeBlock(["n5"])).toEqual({ call: expect.any(String) });
    expect(e.analysis.value.diagnostics).toEqual([]);
    await nextTick();
    e.undo();
    expect(JSON.stringify(e.document.value.program)).toBe(before);
  });
});

test("groups and comments move and go through the node methods", () => {
  const e = editorFor();
  const g = e.addGroup({ x: 0, y: 0, width: 300, height: 200 });
  const c = e.addComment({ x: 10, y: 10 });
  e.moveNodes({ [g]: { x: 40, y: 50 }, n5: { x: 1, y: 2 } });
  expect(e.groups.value[0]).toMatchObject({ x: 40, y: 50, width: 300 });
  expect(e.document.value.view.positions.n5).toEqual({ x: 1, y: 2 });
  e.removeNodes([g, c]);
  expect([e.groups.value, e.comments.value]).toEqual([[], []]);
});

test("a live run stops before each node while stepping, and cancel ends it", async () => {
  const e = editorFor();
  const effects = {
    index: { byTag: async () => ["/v/a.md"] },
    fs: { rename: async (_: string, n: string) => `/v/${n}.md`, setProperty: async () => {} },
  };
  e.stepping.value = true;
  const done = e.run((live) =>
    run(vertex, e.snapshot(), { event: "vertex.onManual", effects, ...live }),
  );
  await vi.waitFor(() => expect(e.pausedAt.value).toBe("n1"));
  expect(e.running.value).toBe(true);
  e.step();
  await vi.waitFor(() => expect(e.pausedAt.value).toBe("n3"));
  e.cancel();
  expect((await done).result.status).toBe("aborted");
  expect([e.running.value, e.stepping.value, e.pausedAt.value, e.active.value.size]).toEqual([
    false,
    false,
    undefined,
    0,
  ]);
  // Cancelled before For Each ran, so the query it pulls from never did.
  expect(e.trace.value.filter((x) => x.t === "enter").map((x) => x.node)).toEqual(["n1"]);
});
