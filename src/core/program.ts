// Document-level declarations (variables, functions) and the built-in core.* nodes (§4.4, §8.5).
import type { DiagnosticCode, DiagnosticLocation } from "./diagnostics";
import type { DocumentV1, FunctionDecl, NodeInstance, VariableDecl } from "./document";
import type { DataPortDef, NodeManifest, TypeParamDef } from "./manifest";
import { type Json, validateValue } from "./schema";
import { formatType, isGround, type TypeTable, type TypeTerm } from "./types";

/** Type arguments come from untrusted documents; recursion over them must stay shallow. */
export const MAX_TYPE_DEPTH = 32;

export type Report = (code: DiagnosticCode, message: string, at: DiagnosticLocation) => void;

/** Variable name → the term that replaces it. */
type Params = ReadonlyMap<string, TypeTerm>;
const NO_PARAMS: Params = new Map();

export interface FunctionInfo {
  decl: FunctionDecl;
  /** As seen by callers: type parameters are ordinary variables, instantiated fresh per call node. */
  typeParams: TypeParamDef[];
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
  /** As seen inside the body: each parameter replaced by its rigid term (bound attached). */
  rigid: Params;
  bodyInputs: Record<string, DataPortDef>;
  bodyOutputs: Record<string, DataPortDef>;
  /** Local variables, types rigid. */
  locals: Map<string, VariableDecl>;
  /** An exec function's exec outputs, in order; none for a pure function. */
  exits: string[];
}

export interface Declarations {
  variables: Map<string, VariableDecl>;
  functions: Map<string, FunctionInfo>;
}

/** Stops descending at `max`, so a hostile 100k-deep term costs `max` steps, not a stack overflow. */
function deeperThan(term: TypeTerm, max: number): boolean {
  if (max <= 0) return true;
  return term.kind === "con" && (term.args ?? []).some((arg) => deeperThan(arg, max - 1));
}

function rebuild(term: TypeTerm, params: Params): TypeTerm {
  if (term.kind === "var") return params.get(term.name)!;
  return term.args?.length
    ? { kind: "con", id: term.id, args: term.args.map((a) => rebuild(a, params)) }
    : { kind: "con", id: term.id };
}

function firstUnknownVar(term: TypeTerm, params: Params): string | undefined {
  if (term.kind === "var") return params.has(term.name) ? undefined : term.name;
  for (const arg of term.args ?? []) {
    const name = firstUnknownVar(arg, params);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * Checks a type term from the document and rebuilds it: only known types, at most `MAX_TYPE_DEPTH` deep, and
 * only variables named in `params`, each replaced by its term there. A document can't forge a rigid variable.
 */
export function docTerm(term: TypeTerm, types: TypeTable, params: Params): TypeTerm | string {
  if (deeperThan(term, MAX_TYPE_DEPTH)) return `type is nested deeper than ${MAX_TYPE_DEPTH}`;
  const error = types.check(term);
  if (error) return error;
  const unknown = firstUnknownVar(term, params);
  return unknown === undefined ? rebuild(term, params) : `unknown type parameter '${unknown}'`;
}

function checkValue(types: TypeTable, type: TypeTerm, value: Json): string | undefined {
  const schema = types.schemaFor(type);
  return schema ? validateValue(schema, value) : `${formatType(type)} takes no literals`;
}

/** Checks `doc.program.variables` and `doc.program.functions`; returns the valid ones, normalized. */
export function declarations(doc: DocumentV1, types: TypeTable, report: Report): Declarations {
  const variables = new Map<string, VariableDecl>();
  const variable = (
    v: VariableDecl,
    params: Params,
    into: Map<string, VariableDecl>,
    at: DiagnosticLocation,
  ): void => {
    if (variables.has(v.id) || into.has(v.id)) {
      report("E_DUPLICATE_ID", `Duplicate variable id '${v.id}'`, at);
      return;
    }
    const type = docTerm(v.type, types, params);
    if (typeof type === "string") {
      report("E_INVALID_TYPE", `Variable '${v.id}': ${type}`, at);
      return;
    }
    const problem = v.default === undefined ? undefined : checkValue(types, type, v.default);
    if (problem) report("E_LITERAL_INVALID", `Variable '${v.id}' default: ${problem}`, at);
    else
      into.set(
        v.id,
        v.default === undefined
          ? { id: v.id, name: v.name, type }
          : { id: v.id, name: v.name, type, default: v.default },
      );
  };
  for (const v of doc.program.variables) variable(v, NO_PARAMS, variables, { variable: v.id });

  const functions = new Map<string, FunctionInfo>();
  for (const decl of doc.program.functions) {
    const at = { function: decl.id };
    if (functions.has(decl.id)) {
      report("E_DUPLICATE_ID", `Duplicate function id '${decl.id}'`, at);
      continue;
    }
    let ok = true;
    const typeParams: TypeParamDef[] = [];
    const plain = new Map<string, TypeTerm>();
    const rigid = new Map<string, TypeTerm>();
    for (const p of decl.typeParams ?? []) {
      const bound = p.bound === undefined ? undefined : docTerm(p.bound, types, NO_PARAMS);
      if (plain.has(p.name) || typeof bound === "string") {
        report(
          "E_INVALID_TYPE",
          `Function '${decl.id}' type parameter '${p.name}': ${bound ?? "duplicate"}`,
          at,
        );
        ok = false;
        continue;
      }
      typeParams.push(bound ? { name: p.name, bound } : { name: p.name });
      plain.set(p.name, { kind: "var", name: p.name });
      rigid.set(
        p.name,
        bound
          ? { kind: "var", name: p.name, rigid: true, bound }
          : { kind: "var", name: p.name, rigid: true },
      );
    }
    const ports = (
      defs: Record<string, DataPortDef>,
      dir: string,
    ): [Record<string, DataPortDef>, Record<string, DataPortDef>] => {
      const sig: Record<string, DataPortDef> = {};
      const body: Record<string, DataPortDef> = {};
      for (const [name, def] of Object.entries(defs)) {
        const type = docTerm(def.type, types, plain);
        if (typeof type === "string") {
          report("E_INVALID_TYPE", `Function '${decl.id}' ${dir} '${name}': ${type}`, {
            ...at,
            port: name,
          });
          ok = false;
          continue;
        }
        // Generic defaults are checked per call node, once T is known.
        if (def.default !== undefined && isGround(type)) {
          const problem = checkValue(types, type, def.default);
          if (problem) {
            report(
              "E_LITERAL_INVALID",
              `Function '${decl.id}' ${dir} '${name}' default: ${problem}`,
              { ...at, port: name },
            );
            ok = false;
          }
        }
        sig[name] = { ...def, type };
        body[name] = { type: rebuild(type, rigid) };
      }
      return [sig, body];
    };
    const [inputs, bodyInputs] = ports(decl.inputs, "input");
    const [outputs, bodyOutputs] = ports(decl.outputs, "output");
    const locals = new Map<string, VariableDecl>();
    for (const v of decl.locals ?? []) variable(v, rigid, locals, { ...at, variable: v.id });
    const exits = decl.exits ?? (decl.exec ? ["then"] : []);
    // Exec and data outputs share the call's port names.
    const clash = exits.find((x) => Object.hasOwn(decl.outputs, x));
    const badExits = [
      !decl.exec && decl.exits !== undefined && "a pure function has no exits",
      decl.exec && !exits.length && "an exec function needs at least one exit",
      exits.includes("") && "an exit needs a name",
      new Set(exits).size < exits.length && "exit names must be unique",
      clash !== undefined && `exit '${clash}' is also an output`,
    ].find((x) => typeof x === "string");
    if (badExits) {
      report("E_FUNCTION_SHAPE", `Function '${decl.id}': ${badExits}`, at);
      ok = false;
    }
    if (!ok) continue;
    functions.set(decl.id, {
      decl,
      typeParams,
      inputs,
      outputs,
      rigid,
      bodyInputs,
      bodyOutputs,
      locals,
      exits,
    });
  }
  return { variables, functions };
}

/** Output ports carry only a type and label. */
function asOutputs(defs: Record<string, DataPortDef>): Record<string, DataPortDef> {
  return Object.fromEntries(
    Object.entries(defs).map(([name, d]) => [
      name,
      d.label === undefined ? { type: d.type } : { type: d.type, label: d.label },
    ]),
  );
}

/** Every function output must get a value before the call ends. */
function asRequired(defs: Record<string, DataPortDef>): Record<string, DataPortDef> {
  return Object.fromEntries(
    Object.entries(defs).map(([name, d]) => [name, { type: d.type, required: true }]),
  );
}

/**
 * The manifest of a core.* instance, built from the document (§4.4). `fn` is the function whose body holds
 * the node, if any. Returns a diagnostic when the node doesn't fit where it is.
 */
export function coreManifest(
  node: NodeInstance,
  fn: FunctionInfo | undefined,
  decls: Declarations,
): NodeManifest | { code: DiagnosticCode; message: string } {
  const base = { type: node.type, version: 1, label: node.type };
  switch (node.type) {
    case "core.entry":
    case "core.return": {
      if (!fn)
        return { code: "E_FUNCTION_SHAPE", message: `${node.type} belongs in a function body` };
      const exec = fn.decl.exec;
      if (node.type === "core.entry") {
        const outputs = asOutputs(fn.bodyInputs);
        // An exec entry starts the body like an event starts the main graph.
        return exec
          ? { ...base, mode: "event", exec: { out: ["then"] }, outputs }
          : { ...base, mode: "pure", outputs };
      }
      // `ref` names the exit the return leaves through; omitted, the first.
      if (node.ref !== undefined && !fn.exits.includes(node.ref))
        return {
          code: "E_UNKNOWN_REF",
          message: `core.return names unknown exit '${node.ref}'`,
        };
      const inputs = asRequired(fn.bodyOutputs);
      return exec
        ? { ...base, mode: "exec", exec: { out: [] }, inputs }
        : { ...base, mode: "pure", inputs };
    }
    case "core.call": {
      const g = decls.functions.get(node.ref ?? "");
      if (!g)
        return {
          code: "E_UNKNOWN_REF",
          message: `core.call refers to unknown function '${node.ref ?? ""}'`,
        };
      const shape = {
        ...base,
        label: g.decl.name,
        typeParams: g.typeParams,
        inputs: g.inputs,
        outputs: asOutputs(g.outputs),
      };
      return g.decl.exec
        ? { ...shape, mode: "exec", exec: { out: g.exits } }
        : { ...shape, mode: "pure" };
    }
    case "core.get":
    case "core.set": {
      const v = fn?.locals.get(node.ref ?? "") ?? decls.variables.get(node.ref ?? "");
      if (!v)
        return {
          code: "E_UNKNOWN_REF",
          message: `${node.type} refers to unknown variable '${node.ref ?? ""}'`,
        };
      return node.type === "core.get"
        ? { ...base, label: v.name, mode: "pure", outputs: { value: { type: v.type } } }
        : {
            ...base,
            label: v.name,
            mode: "exec",
            exec: { out: ["then"] },
            inputs: { value: { type: v.type, required: true } },
          };
    }
    default:
      return { code: "E_UNKNOWN_NODE_TYPE", message: `Unknown node type '${node.type}'` };
  }
}
