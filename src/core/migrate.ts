// The boundary for untrusted documents (§6.2): parse `unknown` into a clean DocumentV1, then migrate it.
import type { Diagnostic } from "./diagnostics";
import type {
  DocumentV1,
  EdgeInstance,
  FunctionDecl,
  Graph,
  Group,
  NodeInstance,
  PortRef,
  Program,
  VariableDecl,
  View,
} from "./document";
import type { Language } from "./language";
import type { DataPortDef, TypeParamDef } from "./manifest";
import { isObject, type Json } from "./schema";
import type { TypeTerm } from "./types";

/** The document format this engine writes. */
export const DOCUMENT_FORMAT = 1;

/** Engine-owned: format n → n+1, on the raw object before parsing. Kept indefinitely; none yet. */
const FORMAT_MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> =
  {};

/** Parsing recursion limits, so a hostile document can't overflow the stack. `validate` caps type depth lower. */
const MAX_TERM_DEPTH = 64;
const MAX_JSON_DEPTH = 256;

export type MigrateResult = { doc: DocumentV1; changed: boolean } | { diagnostics: Diagnostic[] };

class Invalid extends Error {}

function fail(at: string, what: string): never {
  throw new Invalid(`${at}: expected ${what}`);
}

function obj(value: unknown, at: string): Record<string, unknown> {
  return isObject(value) ? value : fail(at, "an object");
}

function str(value: unknown, at: string): string {
  return typeof value === "string" ? value : fail(at, "a string");
}

function int(value: unknown, at: string, min: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min
    ? value
    : fail(at, `an integer ≥ ${min}`);
}

function num(value: unknown, at: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(at, "a number");
}

function bool(value: unknown, at: string): boolean {
  return typeof value === "boolean" ? value : fail(at, "a boolean");
}

function list<T>(value: unknown, at: string, item: (v: unknown, at: string) => T): T[] {
  return Array.isArray(value) ? value.map((v, i) => item(v, `${at}[${i}]`)) : fail(at, "an array");
}

/** Own keys only; `Object.fromEntries` defines them, so a `__proto__` key can't reach the prototype. */
function record<T>(
  value: unknown,
  at: string,
  item: (v: unknown, at: string) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj(value, at)).map(([k, v]) => [k, item(v, `${at}.${k}`)]),
  );
}

function json(value: unknown, at: string, depth = 0): Json {
  if (depth > MAX_JSON_DEPTH) fail(at, `JSON nested at most ${MAX_JSON_DEPTH} deep`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fail(at, "a finite number");
  if (Array.isArray(value)) return value.map((v, i) => json(v, `${at}[${i}]`, depth + 1));
  return record(value, at, (v, here) => json(v, here, depth + 1));
}

/** Rigid flags and bounds are the engine's to set, so they're dropped here. */
function term(value: unknown, at: string, depth = 0): TypeTerm {
  if (depth > MAX_TERM_DEPTH) fail(at, `a type nested at most ${MAX_TERM_DEPTH} deep`);
  const o = obj(value, at);
  if (o.kind === "var") return { kind: "var", name: str(o.name, `${at}.name`) };
  if (o.kind !== "con") fail(`${at}.kind`, `"con" or "var"`);
  const id = str(o.id, `${at}.id`);
  if (o.args === undefined) return { kind: "con", id };
  return {
    kind: "con",
    id,
    args: list(o.args, `${at}.args`, (v, here) => term(v, here, depth + 1)),
  };
}

function portRef(value: unknown, at: string): PortRef {
  const o = obj(value, at);
  return { node: str(o.node, `${at}.node`), port: str(o.port, `${at}.port`) };
}

function node(value: unknown, at: string): NodeInstance {
  const o = obj(value, at);
  const out: NodeInstance = {
    id: str(o.id, `${at}.id`),
    type: str(o.type, `${at}.type`),
    version: int(o.version, `${at}.version`, 1),
  };
  if (o.literals !== undefined) out.literals = record(o.literals, `${at}.literals`, json);
  if (o.typeArgs !== undefined)
    out.typeArgs = record(o.typeArgs, `${at}.typeArgs`, (v, here) => term(v, here));
  if (o.variadic !== undefined) out.variadic = int(o.variadic, `${at}.variadic`, 0);
  if (o.ref !== undefined) out.ref = str(o.ref, `${at}.ref`);
  return out;
}

function edge(value: unknown, at: string): EdgeInstance {
  const o = obj(value, at);
  return {
    id: str(o.id, `${at}.id`),
    from: portRef(o.from, `${at}.from`),
    to: portRef(o.to, `${at}.to`),
  };
}

function graph(value: unknown, at: string): Graph {
  const o = obj(value, at);
  return { nodes: list(o.nodes, `${at}.nodes`, node), edges: list(o.edges, `${at}.edges`, edge) };
}

function variable(value: unknown, at: string): VariableDecl {
  const o = obj(value, at);
  const out: VariableDecl = {
    id: str(o.id, `${at}.id`),
    name: str(o.name, `${at}.name`),
    type: term(o.type, `${at}.type`),
  };
  if (o.default !== undefined) out.default = json(o.default, `${at}.default`);
  return out;
}

function port(value: unknown, at: string): DataPortDef {
  const o = obj(value, at);
  const out: DataPortDef = { type: term(o.type, `${at}.type`) };
  if (o.label !== undefined) out.label = str(o.label, `${at}.label`);
  if (o.default !== undefined) out.default = json(o.default, `${at}.default`);
  if (o.wire !== undefined) out.wire = bool(o.wire, `${at}.wire`);
  if (o.required !== undefined) out.required = bool(o.required, `${at}.required`);
  return out;
}

function typeParam(value: unknown, at: string): TypeParamDef {
  const o = obj(value, at);
  const name = str(o.name, `${at}.name`);
  return o.bound === undefined ? { name } : { name, bound: term(o.bound, `${at}.bound`) };
}

function fn(value: unknown, at: string): FunctionDecl {
  const o = obj(value, at);
  const out: FunctionDecl = {
    id: str(o.id, `${at}.id`),
    name: str(o.name, `${at}.name`),
    exec: bool(o.exec, `${at}.exec`),
    inputs: record(o.inputs, `${at}.inputs`, port),
    outputs: record(o.outputs, `${at}.outputs`, port),
    graph: graph(o.graph, `${at}.graph`),
  };
  if (o.typeParams !== undefined)
    out.typeParams = list(o.typeParams, `${at}.typeParams`, typeParam);
  if (o.locals !== undefined) out.locals = list(o.locals, `${at}.locals`, variable);
  return out;
}

function program(value: unknown, at: string): Program {
  const o = obj(value, at);
  return {
    graph: graph(o.graph, `${at}.graph`),
    variables: list(o.variables, `${at}.variables`, variable),
    functions: list(o.functions, `${at}.functions`, fn),
  };
}

function group(value: unknown, at: string): Group {
  const o = obj(value, at);
  const out: Group = {
    id: str(o.id, `${at}.id`),
    graph: str(o.graph, `${at}.graph`),
    nodes: list(o.nodes, `${at}.nodes`, str),
  };
  if (o.label !== undefined) out.label = str(o.label, `${at}.label`);
  if (o.color !== undefined) out.color = str(o.color, `${at}.color`);
  return out;
}

function view(value: unknown, at: string): View {
  const o = obj(value, at);
  const point = (v: unknown, here: string): { x: number; y: number } => {
    const p = obj(v, here);
    return { x: num(p.x, `${here}.x`), y: num(p.y, `${here}.y`) };
  };
  const out: View = {
    positions: record(o.positions, `${at}.positions`, point),
    groups: list(o.groups, `${at}.groups`, group),
  };
  if (o.viewport !== undefined) {
    const v = obj(o.viewport, `${at}.viewport`);
    out.viewport = {
      x: num(v.x, `${at}.viewport.x`),
      y: num(v.y, `${at}.viewport.y`),
      zoom: num(v.zoom, `${at}.viewport.zoom`),
    };
  }
  return out;
}

function parse(raw: Record<string, unknown>): DocumentV1 {
  const language = obj(raw.language, "language");
  const doc: DocumentV1 = {
    format: 1,
    language: {
      id: str(language.id, "language.id"),
      version: int(language.version, "language.version", 1),
    },
    program: program(raw.program, "program"),
    view: view(raw.view, "view"),
  };
  if (raw.meta !== undefined) {
    const meta = obj(raw.meta, "meta");
    doc.meta = {};
    if (meta.name !== undefined) doc.meta.name = str(meta.name, "meta.name");
    if (meta.description !== undefined)
      doc.meta.description = str(meta.description, "meta.description");
  }
  return doc;
}

function error(code: Diagnostic["code"], message: string): { diagnostics: Diagnostic[] } {
  return { diagnostics: [{ code, severity: "error", message }] };
}

/**
 * Turns an untrusted document (e.g. `JSON.parse` output) into a current `DocumentV1` (§6.2): document format,
 * then language, then each node. Never writes anything; `changed` tells the host a save would rewrite the file.
 * A document or node newer than the code isn't migrated: the result is diagnostics, and the host opens it read-only.
 * Throws only if the language lacks a migration it declares a version for (a bug in the language).
 */
export function migrate<E>(raw: unknown, language: Language<E>): MigrateResult {
  let changed = false;
  if (!isObject(raw)) return error("E_INVALID_DOCUMENT", "$: expected an object");
  let input = raw;
  const format = input.format;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    return error("E_INVALID_DOCUMENT", "format: expected an integer ≥ 1");
  }
  if (format > DOCUMENT_FORMAT) {
    return error("E_NEWER_FORMAT", `Document format ${format} is newer than ${DOCUMENT_FORMAT}`);
  }
  for (let f = format; f < DOCUMENT_FORMAT; f++) {
    const step = FORMAT_MIGRATIONS[f];
    if (!step) throw new Error(`No migration from document format ${f}`);
    input = step(input);
    changed = true;
  }

  let doc: DocumentV1;
  try {
    doc = parse(input);
  } catch (e) {
    if (e instanceof Invalid) return error("E_INVALID_DOCUMENT", e.message);
    throw e;
  }

  const { id, version } = language.manifest.language;
  if (doc.language.id !== id)
    return error("E_LANGUAGE_MISMATCH", `Document is for '${doc.language.id}', not '${id}'`);
  if (doc.language.version > version) {
    return error(
      "E_NEWER_LANGUAGE",
      `Document needs ${id} v${doc.language.version}; this is v${version}`,
    );
  }
  for (let v = doc.language.version; v < version; v++) {
    const step = language.migrate?.[v];
    if (!step) throw new Error(`Language '${id}' has no migration from v${v}`);
    doc.program = step(doc.program);
    changed = true;
  }
  doc.language = { id, version };

  const manifests = new Map(language.manifest.nodes.map((m) => [m.type, m]));
  const diagnostics: Diagnostic[] = [];
  for (const g of [doc.program.graph, ...doc.program.functions.map((f) => f.graph)]) {
    g.nodes = g.nodes.map((n) => {
      const m = manifests.get(n.type);
      // Unknown and core.* types are left to `validate`.
      if (!m) return n;
      if (n.version > m.version) {
        diagnostics.push({
          code: "E_NEWER_NODE",
          severity: "error",
          message: `${n.type} v${n.version} is newer than v${m.version}`,
          at: { node: n.id },
        });
        return n;
      }
      let current = n;
      for (let v = n.version; v < m.version; v++) {
        const step = language.nodes.get(n.type)?.migrate?.[v];
        if (!step) throw new Error(`Node '${n.type}' has no migration from v${v}`);
        current = { ...step(current), version: v + 1 };
        changed = true;
      }
      return current;
    });
  }
  return diagnostics.length ? { diagnostics } : { doc, changed };
}
