import { type Json, validateValue } from "./schema";
import { formatType, isGround, type TypeDef, type TypeTerm, TypeTable } from "./types";

export type NodeMode = "event" | "exec" | "pure" | "once";

export interface DataPortDef {
  type: TypeTerm;
  label?: string;
  /** Inputs only. */
  default?: Json;
  /** Inputs only. `false` = a setting that takes only a literal (dropdowns etc.). Default true. */
  wire?: boolean;
  /** Inputs only. No edge, literal or default → `E_REQUIRED_INPUT`. */
  required?: boolean;
}

export interface VariadicDef {
  kind: "input" | "execOut";
  /** Ports are `${prefix}0` … `${prefix}${n-1}`; `n` is stored on the instance. */
  prefix: string;
  /** Required for kind `input`. */
  type?: TypeTerm;
  min?: number;
  max?: number;
}

/** A type parameter of a generic node or function. `bound` adds `T <: bound` and is the fallback when T is unconstrained. */
export interface TypeParamDef {
  name: string;
  bound?: TypeTerm;
}

export interface NodeManifest {
  /** Namespaced: `std.forEach`, `vertex.rename`. `core.` is reserved. */
  type: string;
  version: number;
  mode: NodeMode;
  /** exec: `in` defaults to `['exec']`. event: `in` not allowed. pure/once: absent. */
  exec?: { in?: string[]; out: string[] };
  typeParams?: TypeParamDef[];
  inputs?: Record<string, DataPortDef>;
  outputs?: Record<string, DataPortDef>;
  variadic?: VariadicDef;
  /** Capability ids (§7). */
  requires?: string[];
  /**
   * Shown on the node. May embed inputs as `{name}`, which editors render inline, Scratch-style:
   * `'Rename {file} to {newName}'`.
   */
  label: string;
  /** A `CategoryDef` id. Uncategorized nodes are grouped by namespace. */
  category?: string;
  description?: string;
  icon?: string;
  /** Overrides the category's color for this node: a palette name (`sky`, `rose`, …) or any CSS color. */
  color?: string;
}

/** A group of nodes in editors: the palette's sections, and the tint of their nodes' headers. */
export interface CategoryDef {
  /** Namespaced like nodes: `std.control`, `vertex.files`. `core.` is reserved. */
  id: string;
  label: string;
  /** A palette name (`sky`, `rose`, …) or any CSS color. */
  color?: string;
  icon?: string;
  /** Sorts categories, lowest first; ties keep declaration order (included languages first). Default 0. */
  order?: number;
}

/** A label split at its `{input}` placeholders. */
export type LabelPart = { text: string } | { input: string };

export function parseLabel(label: string): LabelPart[] {
  return label
    .split(/(\{\w+\})/)
    .filter(Boolean)
    .map((s) => (/^\{\w+\}$/.test(s) ? { input: s.slice(1, -1) } : { text: s }));
}

/** The label as plain text, placeholders replaced by their inputs' labels (else names). */
export function labelText(node: Pick<NodeManifest, "label" | "inputs">): string {
  return parseLabel(node.label)
    .map((p) => ("text" in p ? p.text : (node.inputs?.[p.input]?.label ?? p.input)))
    .join("");
}

/** Both sides ground, e.g. number → string. */
export interface ConversionDef {
  from: TypeTerm;
  to: TypeTerm;
}

export interface CapabilityDef {
  id: string;
  mutates: boolean;
  label: string;
  description?: string;
}

export interface LanguageManifest {
  manifest: 1;
  language: { id: string; version: number };
  types: TypeDef[];
  conversions: ConversionDef[];
  capabilities: CapabilityDef[];
  /** Absent in manifests from before categories existed. */
  categories?: CategoryDef[];
  /** Already flattened: included languages are merged in. */
  nodes: NodeManifest[];
}

/** A manifest that passed `checkManifest`, indexed for lookups. */
export interface CheckedManifest {
  manifest: LanguageManifest;
  types: TypeTable;
  nodes: ReadonlyMap<string, NodeManifest>;
  capabilities: ReadonlyMap<string, CapabilityDef>;
  categories: ReadonlyMap<string, CategoryDef>;
  /** Keys from `conversionKey`. */
  conversions: ReadonlySet<string>;
}

const MODES: readonly NodeMode[] = ["event", "exec", "pure", "once"];

export function conversionKey(from: TypeTerm, to: TypeTerm): string {
  return `${formatType(from)}→${formatType(to)}`;
}

/** Name of the first type variable in `term` that isn't a declared, non-rigid parameter. */
function undeclaredVar(term: TypeTerm, params: ReadonlySet<string>): string | undefined {
  if (term.kind === "var") return params.has(term.name) && !term.rigid ? undefined : term.name;
  for (const arg of term.args ?? []) {
    const name = undeclaredVar(arg, params);
    if (name !== undefined) return name;
  }
  return undefined;
}

function checkTerm(
  term: TypeTerm,
  types: TypeTable,
  params: ReadonlySet<string>,
): string | undefined {
  const error = types.check(term);
  if (error) return error;
  const name = undeclaredVar(term, params);
  return name === undefined ? undefined : `undeclared type parameter '${name}'`;
}

function checkNode(
  node: NodeManifest,
  types: TypeTable,
  capabilities: ReadonlyMap<string, CapabilityDef>,
  categories: ReadonlyMap<string, CategoryDef>,
): string | undefined {
  if (node.type.startsWith("core.")) return "the 'core.' namespace is reserved";
  if (!Number.isInteger(node.version) || node.version < 1)
    return "version must be a positive integer";
  if (!MODES.includes(node.mode)) return `unknown mode '${String(node.mode)}'`;
  if (typeof node.label !== "string" || !node.label) return "label is required";
  for (const part of parseLabel(node.label)) {
    if ("input" in part && !node.inputs?.[part.input])
      return `label names '{${part.input}}', which isn't an input`;
  }
  if (node.category !== undefined && !categories.has(node.category))
    return `unknown category '${node.category}'`;
  const dataOnly = node.mode === "pure" || node.mode === "once";
  if (dataOnly && node.exec) return `${node.mode} nodes have no exec ports`;
  if (node.mode === "event" && node.exec?.in) return "event nodes have no exec inputs";

  const params = new Set<string>();
  for (const param of node.typeParams ?? []) {
    if (params.has(param.name)) return `duplicate type parameter '${param.name}'`;
    params.add(param.name);
    if (!param.bound) continue;
    const error = checkTerm(param.bound, types, new Set());
    if (error) return `bound of '${param.name}': ${error}`;
  }

  // Exec and data ports share a namespace per direction: an edge end names only `{ node, port }`.
  const execIn = node.mode === "exec" ? (node.exec?.in ?? ["exec"]) : [];
  const execOut = node.exec?.out ?? [];
  const inNames = new Set(execIn);
  const outNames = new Set(execOut);
  if (inNames.size !== execIn.length || outNames.size !== execOut.length)
    return "duplicate exec port";

  for (const [name, port] of Object.entries(node.inputs ?? {})) {
    if (inNames.has(name)) return `duplicate input port '${name}'`;
    inNames.add(name);
    const error = checkTerm(port.type, types, params);
    if (error) return `input '${name}': ${error}`;
    // Defaults on generic ports are checked per instance by `validate`, once T is known.
    if (port.default === undefined || !isGround(port.type)) continue;
    const schema = types.schemaFor(port.type);
    if (!schema)
      return `input '${name}': opaque type ${formatType(port.type)} can't have a default`;
    const invalid = validateValue(schema, port.default);
    if (invalid) return `input '${name}' default: ${invalid}`;
  }
  for (const [name, port] of Object.entries(node.outputs ?? {})) {
    if (outNames.has(name)) return `duplicate output port '${name}'`;
    outNames.add(name);
    if (port.default !== undefined || port.wire !== undefined || port.required !== undefined) {
      return `output '${name}': default, wire and required are for inputs only`;
    }
    const error = checkTerm(port.type, types, params);
    if (error) return `output '${name}': ${error}`;
  }

  const variadic = node.variadic;
  if (variadic) {
    if (!variadic.prefix) return "variadic prefix is required";
    if (variadic.kind === "execOut" && node.mode !== "exec")
      return "variadic exec outputs need an exec node";
    if (variadic.kind === "execOut" && variadic.type) return "variadic exec outputs have no type";
    if (variadic.kind === "input") {
      if (!variadic.type) return "variadic inputs need a type";
      const error = checkTerm(variadic.type, types, params);
      if (error) return `variadic: ${error}`;
    }
    const counts = [variadic.min, variadic.max];
    if (!counts.every((n) => n === undefined || (Number.isInteger(n) && n >= 0))) {
      return "variadic min/max must be non-negative integers";
    }
    if ((variadic.min ?? 0) > (variadic.max ?? Infinity)) return "variadic min exceeds max";
    const names = variadic.kind === "input" ? inNames : outNames;
    const clash = [...names].find(
      (name) =>
        name.startsWith(variadic.prefix) && /^\d+$/.test(name.slice(variadic.prefix.length)),
    );
    if (clash) return `port '${clash}' collides with variadic prefix '${variadic.prefix}'`;
  }

  for (const id of node.requires ?? []) {
    const capability = capabilities.get(id);
    if (!capability) return `unknown capability '${id}'`;
    if (dataOnly && capability.mutates)
      return `${node.mode} nodes can't require mutating capability '${id}'`;
  }
  return undefined;
}

/** Throws on the first problem. Language code is trusted, so problems are developer errors, not diagnostics. */
export function checkManifest(manifest: LanguageManifest): CheckedManifest {
  if (manifest.manifest !== 1)
    throw new Error(`Unsupported manifest format ${String(manifest.manifest)}`);
  const { id, version } = manifest.language;
  if (!id || id === "core") throw new Error(`Invalid language id '${id}'`);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Language '${id}': version must be a positive integer`);
  }

  const types = new TypeTable(manifest.types);

  const capabilities = new Map<string, CapabilityDef>();
  for (const capability of manifest.capabilities) {
    if (capabilities.has(capability.id)) throw new Error(`Duplicate capability '${capability.id}'`);
    capabilities.set(capability.id, capability);
  }

  const categories = new Map<string, CategoryDef>();
  for (const category of manifest.categories ?? []) {
    const at = `Category '${category.id}'`;
    if (!category.id || category.id.startsWith("core.")) throw new Error(`${at}: invalid id`);
    if (categories.has(category.id)) throw new Error(`Duplicate category '${category.id}'`);
    if (typeof category.label !== "string" || !category.label)
      throw new Error(`${at}: label is required`);
    if (category.order !== undefined && !Number.isFinite(category.order))
      throw new Error(`${at}: order must be a finite number`);
    categories.set(category.id, category);
  }

  const conversions = new Set<string>();
  for (const { from, to } of manifest.conversions) {
    const key = conversionKey(from, to);
    const error = checkTerm(from, types, new Set()) ?? checkTerm(to, types, new Set());
    if (error) throw new Error(`Conversion ${key}: ${error}`);
    if (conversions.has(key)) throw new Error(`Duplicate conversion ${key}`);
    conversions.add(key);
  }

  const nodes = new Map<string, NodeManifest>();
  for (const node of manifest.nodes) {
    if (nodes.has(node.type)) throw new Error(`Duplicate node type '${node.type}'`);
    const error = checkNode(node, types, capabilities, categories);
    if (error) throw new Error(`Node '${node.type}': ${error}`);
    nodes.set(node.type, node);
  }

  return { manifest, types, nodes, capabilities, categories, conversions };
}
