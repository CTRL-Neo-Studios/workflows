// `@type32/workflows/core/testing`: helpers for testing a language (§2, §7). No test framework dependency:
// everything returns plain data or throws a plain Error.
import type {
  DocumentV1,
  EdgeInstance,
  FunctionDecl,
  NodeInstance,
  VariableDecl,
} from "./document";
import type { Language } from "./language";
import type { LanguageManifest } from "./manifest";
import { compile, type RunLimits, type RunResult, type TraceEvent } from "./runtime";
import { type Analysis, validate } from "./validate";

export interface RecordedCall {
  /** Dotted path from the effects root, e.g. `fs.rename`. */
  path: string;
  args: unknown[];
}

export interface Recording<E> {
  /** Pass this as `RunOptions.effects`. Calls go through to the implementation and are recorded on the way. */
  effects: E;
  calls: RecordedCall[];
  /** One line per call, e.g. `fs.rename(/v/a.md, a_archive)`: strings as-is, other values as JSON. */
  log(): string[];
}

function format(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function recordingProxy(target: object, path: string, calls: RecordedCall[]): object {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value: unknown = Reflect.get(obj, key, receiver);
      if (typeof key !== "string") return value;
      const here = path ? `${path}.${key}` : key;
      if (typeof value === "function") {
        return (...args: unknown[]): unknown => {
          calls.push({ path: here, args });
          return Reflect.apply(value, obj, args);
        };
      }
      return typeof value === "object" && value !== null
        ? recordingProxy(value, here, calls)
        : value;
    },
  });
}

/**
 * Wraps an effect implementation so every call, at any depth, is recorded in order. Reads go through to `impl`,
 * so replacing a method on the recording's `effects` later still works.
 */
export function record<E extends object>(impl: E): Recording<E> {
  const calls: RecordedCall[] = [];
  // The proxy has exactly E's shape: every read goes through to `impl`.
  const effects = recordingProxy(impl, "", calls) as E;
  return {
    effects,
    calls,
    log: () => calls.map((c) => `${c.path}(${c.args.map(format).join(", ")})`),
  };
}

/** `id: type`, or a partial instance. `version` defaults to the manifest's current version. */
export type NodeSpec = string | (Omit<NodeInstance, "id" | "version"> & { version?: number });

export interface GraphSpec {
  nodes: Record<string, NodeSpec>;
  /** `"from.port > to.port"`. Ids are `e1`, `e2`, … (in a function: `<function id>.e1`, …). */
  edges?: string[];
}

export interface FunctionSpec extends Omit<FunctionDecl, "id" | "name" | "graph">, GraphSpec {
  /** Defaults to the function id. */
  name?: string;
}

export interface DocumentSpec extends GraphSpec {
  variables?: VariableDecl[];
  /** Keyed by function id. */
  functions?: Record<string, FunctionSpec>;
  meta?: DocumentV1["meta"];
}

/** `"a.port > b.port"` → an edge. */
export function edge(spec: string, id: string): EdgeInstance {
  const [from = "", to = ""] = spec.split(">").map((s) => s.trim());
  const [fromNode = "", fromPort = ""] = from.split(".");
  const [toNode = "", toPort = ""] = to.split(".");
  return { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

/** A document for `language` from a compact spec. It isn't validated: tests may build invalid documents on purpose. */
export function buildDocument(
  language: { manifest: LanguageManifest },
  spec: DocumentSpec,
): DocumentV1 {
  const { manifest } = language;
  const versions = new Map(manifest.nodes.map((n) => [n.type, n.version]));
  const graph = (
    { nodes, edges = [] }: GraphSpec,
    prefix: string,
  ): DocumentV1["program"]["graph"] => ({
    nodes: Object.entries(nodes).map(([id, n]): NodeInstance => {
      const { version, ...rest } = typeof n === "string" ? { type: n } : n;
      return { id, version: version ?? versions.get(rest.type) ?? 1, ...rest };
    }),
    edges: edges.map((e, i) => edge(e, `${prefix}e${i + 1}`)),
  });
  const doc: DocumentV1 = {
    format: 1,
    language: { ...manifest.language },
    program: {
      graph: graph(spec, ""),
      variables: spec.variables ?? [],
      functions: Object.entries(spec.functions ?? {}).map(
        ([id, { name, nodes, edges, ...decl }]) => ({
          id,
          name: name ?? id,
          ...decl,
          graph: graph({ nodes, ...(edges && { edges }) }, `${id}.`),
        }),
      ),
    },
    view: { positions: {}, groups: [] },
  };
  if (spec.meta) doc.meta = spec.meta;
  return doc;
}

/** Validates and throws a readable Error listing every diagnostic, so a test failure says what's wrong. */
export function assertValid(doc: DocumentV1, language: { manifest: LanguageManifest }): Analysis {
  const analysis = validate(doc, language.manifest);
  if (analysis.diagnostics.length) {
    const lines = analysis.diagnostics.map(
      (d) => `  ${d.code} ${d.message}${d.at ? ` at ${JSON.stringify(d.at)}` : ""}`,
    );
    throw new Error(
      `Document has ${analysis.diagnostics.length} diagnostic(s):\n${lines.join("\n")}`,
    );
  }
  return analysis;
}

export interface RunSpec<E> {
  /** The event node type to dispatch. */
  event: string;
  payload?: Record<string, unknown>;
  effects: E;
  limits?: RunLimits;
  signal?: AbortSignal;
  /** Default 'nodes'. */
  trace?: "nodes" | "values";
}

export interface TestRun {
  result: RunResult;
  trace: TraceEvent[];
}

/** Compiles (throwing `CompileError` on any error diagnostic), dispatches one event and captures the trace. */
export async function run<E extends object>(
  language: Language<E>,
  doc: DocumentV1,
  spec: RunSpec<E>,
): Promise<TestRun> {
  const trace: TraceEvent[] = [];
  const { event, payload, trace: level = "nodes", ...opts } = spec;
  const result = await compile(doc, language).dispatch(event, payload, {
    ...opts,
    trace: level,
    onTrace: (e) => void trace.push(e),
  });
  return { result, trace };
}

/**
 * Compact trace lines: `>n1` enter, `<n1.then` exit (with port), `~n3.body` fire, `n3.item=/v/a.md` value,
 * `!n8 E_UNSET_VALUE` fault.
 */
export function formatTrace(events: readonly TraceEvent[]): string[] {
  return events.map((e) => {
    switch (e.t) {
      case "enter":
        return `>${e.node}`;
      case "exit":
        return `<${e.node}${e.port === undefined ? "" : `.${e.port}`}`;
      case "fire":
        return `~${e.node}.${e.port}`;
      case "value":
        return `${e.node}.${e.port}=${format(e.value)}`;
      case "fault":
        return `!${e.node} ${e.fault.code}`;
    }
  });
}
