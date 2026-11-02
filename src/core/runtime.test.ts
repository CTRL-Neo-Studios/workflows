import { describe, expect, test } from "vitest";
import { holdWaits, runProbe } from "./fixtures/probe";
import { archiveDrafts, vertex, type VertexEffects } from "./fixtures/section10";
import { compile, CompileError } from "./runtime";
import { edge, formatTrace, record, run } from "./testing";
import { t } from "./types";

const event = "vertex.onManual";

/** §10's handlers: index returns a and b; rename returns the renamed path. */
function handlers(): VertexEffects {
  return {
    index: { byTag: async () => ["/v/a.md", "/v/b.md"] },
    fs: {
      rename: async (file, newName) => file.replace(/[^/]*$/, `${newName}.md`),
      setProperty: async () => {},
    },
  };
}

describe("§10 worked example", () => {
  test("runs in 11 steps with the documented effect order", async () => {
    const rec = record(handlers());
    const { result } = await run(vertex, archiveDrafts(), { event, effects: rec.effects });
    expect(result).toEqual({ status: "ok", steps: 11 });
    expect(rec.log()).toEqual([
      "index.byTag(draft)",
      "fs.rename(/v/a.md, a_archive)",
      "fs.setProperty(/v/a_archive.md, status, archived)",
      "fs.rename(/v/b.md, b_archive)",
      "fs.setProperty(/v/b_archive.md, status, archived)",
    ]);
  });

  test("trace follows the step table: pure nodes enter after their inputs", async () => {
    const { trace } = await run(vertex, archiveDrafts(), { event, effects: handlers() });
    const iteration = [
      "~n3.body",
      ">n5",
      ">n4",
      "<n4",
      ">n6",
      "<n6",
      "<n5.then",
      ">n7",
      "<n7.then",
    ];
    expect(formatTrace(trace)).toEqual([
      ">n1",
      "<n1.then",
      ">n3",
      ">n2",
      "<n2",
      ...iteration,
      ...iteration,
      "<n3.done",
    ]);
  });

  test("trace 'values' adds outputs, including per-iteration scope values", async () => {
    const { trace } = await run(vertex, archiveDrafts(), {
      event,
      effects: handlers(),
      trace: "values",
    });
    expect(formatTrace(trace)).toEqual(
      expect.arrayContaining(["n3.item=/v/a.md", "n6.out=b_archive", "n5.file=/v/b_archive.md"]),
    );
  });

  test("reading a loop body's output after the loop faults E_UNSET_VALUE", async () => {
    const doc = archiveDrafts();
    doc.program.graph.nodes.push({
      id: "n8",
      type: "vertex.rename",
      version: 1,
      literals: { newName: "x" },
    });
    doc.program.graph.edges.push(
      edge("n3.done > n8.exec", "e10"),
      edge("n5.file > n8.file", "e11"),
    );
    const rec = record(handlers());
    const { result, trace } = await run(vertex, doc, { event, effects: rec.effects });
    expect(result.fault).toMatchObject({ code: "E_UNSET_VALUE", node: "n8" });
    expect(result.fault?.message).toContain("n5.file");
    expect(rec.log()).toHaveLength(5); // both iterations ran first
    expect(formatTrace(trace).at(-1)).toBe("!n8 E_UNSET_VALUE");
  });

  test("limits.steps = 5 faults E_STEP_LIMIT", async () => {
    const rec = record(handlers());
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: rec.effects,
      limits: { steps: 5 },
    });
    expect(result).toMatchObject({ status: "fault", fault: { code: "E_STEP_LIMIT" }, steps: 5 });
    expect(rec.log()).toEqual(["index.byTag(draft)"]);
  });

  test("a missing handler fails before anything runs", async () => {
    const rec = record(handlers());
    const { fs: _, ...noFs } = rec.effects;
    // Deliberately incomplete: the host forgot a handler.
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: noFs as VertexEffects,
    });
    expect(result).toEqual({
      status: "fault",
      fault: { code: "E_MISSING_EFFECT", message: "No handler for fs" },
      steps: 0,
    });
    expect(rec.log()).toEqual([]);
  });

  test("a thrown effect error becomes E_NODE_THREW on that node", async () => {
    const cause = new Error("disk full");
    const impl = handlers();
    impl.fs.rename = () => Promise.reject(cause);
    const { result } = await run(vertex, archiveDrafts(), { event, effects: impl });
    expect(result.fault).toEqual({
      code: "E_NODE_THREW",
      message: "n5: disk full",
      node: "n5",
      cause,
    });
  });

  test("abort stops at the next node boundary", async () => {
    const controller = new AbortController();
    const impl = handlers();
    impl.index.byTag = async () => {
      controller.abort();
      return ["/v/a.md"];
    };
    const rec = record(impl);
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: rec.effects,
      signal: controller.signal,
    });
    expect(result.status).toBe("aborted");
    expect(rec.log()).toEqual(["index.byTag(draft)"]);
  });

  test("timeoutMs aborts even when an effect ignores the signal", async () => {
    const impl = handlers();
    impl.index.byTag = async () => {
      // Real clock on purpose: the timeout runs on the platform timer and Date.now.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ["/v/a.md"];
    };
    const rec = record(impl);
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: rec.effects,
      limits: { timeoutMs: 5 },
    });
    expect(result.status).toBe("aborted");
    expect(rec.log()).toEqual(["index.byTag(draft)"]);
  });

  test("time in interactive capability calls doesn't count toward timeoutMs", async () => {
    const impl = handlers();
    impl.index.byTag = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return ["/v/a.md"];
    };
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: impl,
      limits: { timeoutMs: 20 },
      interactive: ["index"],
    });
    expect(result.status).toBe("ok");
  });

  test("beforeStep runs before each event and exec node, and its waits don't count either", async () => {
    const seen: string[] = [];
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: handlers(),
      limits: { timeoutMs: 20 },
      beforeStep: async (node) => {
        seen.push(node);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    expect(result.status).toBe("ok");
    expect(seen).toEqual(["n1", "n3", "n5", "n7", "n5", "n7"]);
  });

  test("aborting while beforeStep waits stops before that node", async () => {
    const controller = new AbortController();
    const rec = record(handlers());
    const { result } = await run(vertex, archiveDrafts(), {
      event,
      effects: rec.effects,
      signal: controller.signal,
      beforeStep: (node) => {
        if (node === "n5") controller.abort();
      },
    });
    expect(result.status).toBe("aborted");
    expect(rec.log()).toEqual(["index.byTag(draft)"]);
  });

  test("compile rejects invalid documents", () => {
    const doc = archiveDrafts();
    doc.program.graph.edges.find((e) => e.id === "e7")!.from = { node: "n4", port: "name" };
    expect(() => compile(doc, vertex)).toThrow(CompileError);
  });
});

describe("runtime", () => {
  test("ctx.effects holds only the node's declared capabilities", async () => {
    const { log } = await runProbe({ s: "p.start", p: "p.peek" }, ["s.then>p.exec"]);
    expect(log).toEqual(["log"]);
  });

  test("pure values are cached per consumer activation and fresh per loop iteration", async () => {
    const { log } = await runProbe(
      {
        s: "p.start",
        each: { type: "std.forEach", literals: { list: [1, 2] }, typeArgs: { T: t("number") } },
        c: "p.counter",
        p: "p.pair",
      },
      ["s.then>each.exec", "each.body>p.exec", "c.n>p.a", "c.n>p.b"],
    );
    expect(log).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("converted edges run the language's conversion", async () => {
    const { log } = await runProbe({ s: "p.start", n: "p.num", x: "p.text" }, [
      "s.then>x.exec",
      "n.n>x.s",
    ]);
    expect(log).toEqual(["#42"]);
  });

  test("Dictionary literals arrive as Maps, List literals as arrays", async () => {
    const { log } = await runProbe(
      {
        s: "p.start",
        k: {
          type: "std.dictKeys",
          literals: { dict: { a: 1, b: 2 } },
          typeArgs: { K: t("string"), V: t("number") },
        },
        l: "p.log",
      },
      ["s.then>l.exec", "k.keys>l.value"],
    );
    expect(log).toEqual([["a", "b"]]);
  });

  test("each event instance runs in document order with the payload as its outputs", async () => {
    const { result, log } = await runProbe(
      { s1: "p.start", a: "p.log", s2: "p.start", b: "p.log" },
      ["s1.then>a.exec", "s1.value>a.value", "s2.then>b.exec", "s2.value>b.value"],
      { payload: { value: 7 } },
    );
    expect(result).toEqual({ status: "ok", steps: 4 });
    expect(log).toEqual([7, 7]);
  });

  test.each<[string, Record<string, string>, string[], string]>([
    [
      "pure node missing an output",
      { s: "p.start", m: "p.missing", l: "p.log" },
      ["s.then>l.exec", "m.n>l.value"],
      "E_OUTPUT_MISSING",
    ],
    ["run throws", { s: "p.start", f: "p.fail" }, ["s.then>f.exec"], "E_NODE_THREW"],
    [
      "output to an undeclared port",
      { s: "p.start", b: "p.badOutput" },
      ["s.then>b.exec"],
      "E_NODE_THREW",
    ],
    [
      "two fires at once",
      { s: "p.start", tw: "p.twice", l: "p.peek" },
      ["s.then>tw.exec", "tw.body>l.exec"],
      "E_CONCURRENT_FIRE",
    ],
  ])("%s faults", async (_, nodes, edges, code) => {
    const { result } = await runProbe(nodes, edges);
    expect(result).toMatchObject({ status: "fault", fault: { code } });
  });

  test("a chain still running when the run ends stops at its next step", async () => {
    const release = holdWaits();
    const { result, log } = await runProbe(
      {
        s: "p.start",
        tw: "p.twice",
        w: "p.wait",
        n: { type: "p.note", literals: { text: "late" } },
      },
      ["s.then>tw.exec", "tw.body>w.exec", "w.then>n.exec"],
    );
    expect(result.fault?.code).toBe("E_CONCURRENT_FIRE");
    release();
    // setImmediate runs after every pending microtask, i.e. after the released chain has tried its next step.
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual([]);
  });
});
