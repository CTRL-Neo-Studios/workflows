import { checkTemplate, instantiate, type SchemaTemplate } from "./schema";

/** A type expression (§3.1). `con` applies a type constructor; `var` is a type variable. */
export type TypeTerm =
  | { kind: "con"; id: string; args?: TypeTerm[] }
  /**
   * `rigid`: a generic function's own type parameter inside its body, an opaque type that is only itself.
   * `bound` (rigid only, set by the engine from the function's `typeParams`): what the parameter is known to be.
   */
  | { kind: "var"; name: string; rigid?: true; bound?: TypeTerm };

/** `out` = covariant (read-only position), `inv` = invariant. */
export type Variance = "out" | "inv";

export interface TypeDef {
  id: string;
  params?: { name: string; variance: Variance }[];
  /** Single nominal parent. Only on types without params. Default: `any`. */
  extends?: TypeTerm;
  /** May be used as a Dictionary key. Inherited through `extends`. */
  key?: true;
  /** Absent = opaque: values only arrive over wires, never as literals. */
  schema?: SchemaTemplate;
  label?: string;
  color?: string;
}

/** A constructor term whose type keeps the literal id and arguments, so typed run contexts can map it to values. */
export type Con<I extends string = string, A extends TypeTerm[] = TypeTerm[]> = A extends []
  ? { kind: "con"; id: I }
  : { kind: "con"; id: I; args: A };

export function t<const I extends string, A extends TypeTerm[]>(id: I, ...args: A): Con<I, A> {
  // TS can't narrow the conditional return type of a generic function; both branches build exactly Con<I, A>.
  return (args.length ? { kind: "con", id, args } : { kind: "con", id }) as Con<I, A>;
}

export function tvar<const N extends string>(name: N): { kind: "var"; name: N } {
  return { kind: "var", name };
}

/** No unsolved variables. A rigid variable counts as ground: inside its function it's a fixed type. */
export function isGround(term: TypeTerm): boolean {
  if (term.kind === "var") return term.rigid === true;
  return (term.args ?? []).every(isGround);
}

export function termEquals(a: TypeTerm, b: TypeTerm): boolean {
  if (a.kind === "var") return b.kind === "var" && a.name === b.name;
  if (b.kind === "var") return false;
  const aa = a.args ?? [];
  const ba = b.args ?? [];
  return a.id === b.id && aa.length === ba.length && aa.every((x, i) => termEquals(x, ba[i]!));
}

/** `List<vertex.File>`, `Dictionary<string, T>`. */
export function formatType(term: TypeTerm): string {
  if (term.kind === "var") return term.name;
  return term.args?.length ? `${term.id}<${term.args.map(formatType).join(", ")}>` : term.id;
}

export const BUILTIN_TYPES: readonly TypeDef[] = [
  { id: "any" },
  { id: "string", key: true, schema: { type: "string" } },
  { id: "number", key: true, schema: { type: "number" } },
  { id: "boolean", key: true, schema: { type: "boolean" } },
  {
    id: "List",
    params: [{ name: "T", variance: "out" }],
    schema: { type: "array", items: { $param: "T" } },
  },
  {
    id: "Dictionary",
    params: [
      { name: "K", variance: "inv" },
      { name: "V", variance: "out" },
    ],
    // Only for K = string (see schemaFor); other key types make the Dictionary opaque.
    schema: { type: "object", additionalProperties: { $param: "V" } },
  },
];

/**
 * The types of one language: built-ins plus its own. Answers subtyping (§3.3), join and key questions.
 * Methods other than `check` assume well-formed terms; run `check` on untrusted terms first.
 */
export class TypeTable {
  readonly #defs = new Map<string, TypeDef>();
  /** Param-less type → [itself, parent, …, 'any']. Parameterized type → [itself, 'any']. */
  readonly #chains = new Map<string, string[]>();

  constructor(defs: readonly TypeDef[]) {
    for (const def of [...BUILTIN_TYPES, ...defs]) {
      if (this.#defs.has(def.id)) throw new Error(`Duplicate type '${def.id}'`);
      this.#defs.set(def.id, def);
    }
    for (const def of this.#defs.values()) {
      if (def.schema) {
        const error = checkTemplate(def.schema, def.params?.map((p) => p.name) ?? []);
        if (error) throw new Error(`'${def.id}' ${error}`);
      }
      const parent = def.extends;
      if (!parent) continue;
      if (def.id === "any") throw new Error(`'any' can't extend another type`);
      if (def.params?.length) throw new Error(`'${def.id}' has params and can't declare extends`);
      if (parent.kind !== "con" || parent.args?.length) {
        throw new Error(`'${def.id}' must extend a type without params`);
      }
      const parentDef = this.#defs.get(parent.id);
      if (!parentDef) throw new Error(`'${def.id}' extends unknown type '${parent.id}'`);
      if (parentDef.params?.length)
        throw new Error(`'${def.id}' must extend a type without params`);
    }
    for (const id of this.#defs.keys()) this.#chains.set(id, this.#walk(id));
  }

  #walk(id: string): string[] {
    const chain = [id];
    let def = this.#defs.get(id);
    while (def && def.id !== "any") {
      const next = def.extends?.kind === "con" ? def.extends.id : "any";
      if (chain.includes(next)) throw new Error(`Cyclic extends: ${[...chain, next].join(" → ")}`);
      chain.push(next);
      def = this.#defs.get(next);
    }
    return chain;
  }

  get(id: string): TypeDef | undefined {
    return this.#defs.get(id);
  }

  /** Error message if `term` names an unknown type or has the wrong number of arguments. */
  check(term: TypeTerm): string | undefined {
    if (term.kind === "var") return undefined;
    const def = this.#defs.get(term.id);
    if (!def) return `Unknown type '${term.id}'`;
    const want = def.params?.length ?? 0;
    const args = term.args ?? [];
    if (args.length !== want) {
      return `'${term.id}' takes ${want} type argument(s), got ${args.length}`;
    }
    for (const arg of args) {
      const error = this.check(arg);
      if (error) return error;
    }
    return undefined;
  }

  /**
   * `a <: b`: a value of type `a` can flow into `b`. A rigid `T` is a subtype only of itself, of `any`,
   * and of whatever its bound is a subtype of; nothing but `T` is a subtype of `T`.
   */
  isSubtype(a: TypeTerm, b: TypeTerm): boolean {
    if (b.kind === "con" && b.id === "any") return true;
    if (a.kind === "var") {
      if (b.kind === "var") return a.name === b.name;
      return a.bound !== undefined && this.isSubtype(a.bound, b);
    }
    if (b.kind === "var") return false;
    if (!a.args?.length && !b.args?.length) return this.#chains.get(a.id)?.includes(b.id) ?? false;
    if (a.id !== b.id) return false;
    const params = this.#defs.get(a.id)?.params ?? [];
    return params.every((p, i) => {
      const x = a.args?.[i];
      const y = b.args?.[i];
      if (!x || !y) return false;
      return this.isSubtype(x, y) && (p.variance === "out" || this.isSubtype(y, x));
    });
  }

  /** Least upper bound, or `undefined` (`E_NO_COMMON_TYPE`). Never widens to `any` on its own. */
  join(a: TypeTerm, b: TypeTerm): TypeTerm | undefined {
    if (this.isSubtype(a, b)) return b;
    if (this.isSubtype(b, a)) return a;
    if (a.kind === "var") return a.bound ? this.join(a.bound, b) : undefined;
    if (b.kind === "var") return b.bound ? this.join(a, b.bound) : undefined;
    if (a.args?.length || b.args?.length) {
      if (a.id !== b.id) return undefined;
      const params = this.#defs.get(a.id)?.params ?? [];
      const args: TypeTerm[] = [];
      for (const [i, p] of params.entries()) {
        const x = a.args?.[i];
        const y = b.args?.[i];
        if (!x || !y) return undefined;
        const joined = p.variance === "out" ? this.join(x, y) : termEquals(x, y) ? x : undefined;
        if (!joined) return undefined;
        args.push(joined);
      }
      return t(a.id, ...args);
    }
    const other = this.#chains.get(b.id) ?? [];
    const common = this.#chains.get(a.id)?.find((id) => id !== "any" && other.includes(id));
    return common ? t(common) : undefined;
  }

  /** Usable as a Dictionary key: a param-less type whose own def or an ancestor sets `key`, or a rigid `T` bounded by one. */
  isKey(term: TypeTerm): boolean {
    if (term.kind === "var") return term.bound !== undefined && this.isKey(term.bound);
    if (term.args?.length) return false;
    return this.#chains.get(term.id)?.some((id) => this.#defs.get(id)?.key) ?? false;
  }

  /**
   * The literal schema of a ground type, `$param`s filled in. `undefined` = opaque: the type, or a type
   * argument its schema references, has no schema. Schemas aren't inherited through `extends`.
   */
  schemaFor(term: TypeTerm): SchemaTemplate | undefined {
    // A rigid T could be anything at a call site, so no literal fits it, but [] still fits List<T>.
    if (term.kind === "var") return term.rigid ? { enum: [] } : undefined;
    const def = this.#defs.get(term.id);
    if (!def?.schema) return undefined;
    const key = term.args?.[0];
    if (term.id === "Dictionary" && !(key && termEquals(key, t("string")))) return undefined;
    return instantiate(def.schema, (name) => {
      const arg = term.args?.[def.params?.findIndex((p) => p.name === name) ?? -1];
      return arg && this.schemaFor(arg);
    });
  }
}
