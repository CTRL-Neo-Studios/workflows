// A host language for runtime and std tests: nodes record what they see through a `log` effect.
import type { DocumentV1 } from "../document";
import { defineLanguage, type Language } from "../language";
import type { RunResult, TraceEvent } from "../runtime";
import { std } from "../std";
import { buildDocument, type NodeSpec, record, run, type RunSpec } from "../testing";
import { t } from "../types";

export interface ProbeEffects {
  log: { write(value: unknown): void };
  other: { write(value: unknown): void };
}

let counter = 0;
let held: Promise<void> = Promise.resolve();

/** Makes every `p.wait` block until the returned function is called. */
export function holdWaits(): () => void {
  let release: (() => void) | undefined;
  // Executor form: the package targets ES2023, which has no Promise.withResolvers.
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release?.();
}

export const probe: Language<ProbeEffects> = defineLanguage<ProbeEffects>({
  id: "p",
  version: 1,
  include: [std],
})
  .capability({ id: "log", mutates: true, label: "Log" })
  .capability({ id: "other", mutates: true, label: "Other" })
  .conversion({ from: t("number"), to: t("string"), convert: (n) => `#${String(n)}` })
  .node({
    type: "p.start",
    version: 1,
    mode: "event",
    label: "Start",
    exec: { out: ["then"] },
    outputs: { value: { type: t("number") } },
  })
  .node({
    type: "p.log",
    version: 1,
    mode: "exec",
    label: "Log",
    exec: { out: ["then"] },
    inputs: { value: { type: t("any") } },
    requires: ["log"],
    async run(ctx) {
      ctx.effects.log.write(await ctx.input("value"));
      return "then";
    },
  })
  .node({
    type: "p.note",
    version: 1,
    mode: "exec",
    label: "Note",
    exec: { out: ["then"] },
    inputs: { text: { type: t("string"), required: true } },
    requires: ["log"],
    async run(ctx) {
      ctx.effects.log.write(await ctx.input("text"));
      return "then";
    },
  })
  .node({
    type: "p.text",
    version: 1,
    mode: "exec",
    label: "Text",
    exec: { out: ["then"] },
    inputs: { s: { type: t("string") } },
    requires: ["log"],
    async run(ctx) {
      ctx.effects.log.write(await ctx.input("s"));
      return "then";
    },
  })
  .node({
    type: "p.peek",
    version: 1,
    mode: "exec",
    label: "Peek",
    exec: { out: ["then"] },
    requires: ["log"],
    run(ctx) {
      ctx.effects.log.write(Object.keys(ctx.effects).join(","));
      return "then";
    },
  })
  .node({
    type: "p.set",
    version: 1,
    mode: "exec",
    label: "Set",
    exec: { out: ["then"] },
    inputs: { value: { type: t("string"), required: true } },
    outputs: { value: { type: t("string") } },
    async run(ctx) {
      ctx.output("value", await ctx.input("value"));
      return "then";
    },
  })
  .node({
    type: "p.pair",
    version: 1,
    mode: "exec",
    label: "Pair",
    exec: { out: ["then"] },
    inputs: { a: { type: t("number") }, b: { type: t("number") } },
    requires: ["log"],
    async run(ctx) {
      const { a, b } = await ctx.inputs();
      ctx.effects.log.write([a, b]);
      return "then";
    },
  })
  .node({
    type: "p.counter",
    version: 1,
    mode: "pure",
    label: "Counter",
    outputs: { n: { type: t("number") } },
    run: () => ({ n: ++counter }),
  })
  .node({
    type: "p.num",
    version: 1,
    mode: "pure",
    label: "Num",
    outputs: { n: { type: t("number") } },
    run: () => ({ n: 42 }),
  })
  .node({
    type: "p.missing",
    version: 1,
    mode: "pure",
    label: "Missing",
    outputs: { n: { type: t("number") } },
    // @ts-expect-error deliberately breaks the contract to exercise the runtime's E_OUTPUT_MISSING check
    run: () => ({}),
  })
  .node({
    type: "p.fail",
    version: 1,
    mode: "exec",
    label: "Fail",
    exec: { out: ["then"] },
    run() {
      throw new Error("boom");
    },
  })
  .node({
    type: "p.badOutput",
    version: 1,
    mode: "exec",
    label: "Bad Output",
    run(ctx) {
      // @ts-expect-error deliberately writes an undeclared port to exercise the runtime check
      ctx.output("nope", 1);
    },
  })
  .node({
    type: "p.twice",
    version: 1,
    mode: "exec",
    label: "Twice",
    exec: { out: ["body"] },
    async run(ctx) {
      await Promise.all([ctx.fire("body"), ctx.fire("body")]);
    },
  })
  .node({
    type: "p.wait",
    version: 1,
    mode: "exec",
    label: "Wait",
    exec: { out: ["then"] },
    async run() {
      await held;
      return "then";
    },
  })
  .build();

type ProbeOptions = Omit<RunSpec<ProbeEffects>, "event" | "effects">;

interface ProbeRun {
  result: RunResult;
  /** Everything written to `log`, in order. */
  log: unknown[];
  trace: TraceEvent[];
}

/** Runs a probe document from `p.start`. */
export async function runDoc(doc: DocumentV1, opts: ProbeOptions = {}): Promise<ProbeRun> {
  counter = 0;
  const { effects, calls } = record<ProbeEffects>({ log: { write() {} }, other: { write() {} } });
  const { result, trace } = await run(probe, doc, { event: "p.start", effects, ...opts });
  return { result, trace, log: calls.filter((c) => c.path === "log.write").map((c) => c.args[0]) };
}

/** `runDoc` for a main graph only. */
export function runProbe(
  nodes: Record<string, NodeSpec>,
  edges: string[],
  opts: ProbeOptions = {},
): Promise<ProbeRun> {
  return runDoc(buildDocument(probe, { nodes, edges }), opts);
}
