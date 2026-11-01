import type { Diagnostic, DiagnosticCode, DiagnosticLocation } from "./diagnostics";
import type { NodeInstance } from "./document";
import type { NodeManifest } from "./manifest";
import { formatType, isGround, t, termEquals, type TypeTable, type TypeTerm } from "./types";

/** One copy of a manifest type parameter, owned by one node instance (§3.1 fresh variables). */
export interface TypeVar {
  name: string;
  bound?: TypeTerm;
  /** From `typeArgs`: fixed, never solved, only checked. */
  pin?: TypeTerm;
  solution?: TypeTerm;
}

export interface Instance {
  node: NodeInstance;
  manifest: NodeManifest;
  /** Variadic port count. */
  variadic: number;
  vars: Map<string, TypeVar>;
}

/** `sub <: sup`, each side read in the variable scope of its own instance. */
export interface Constraint {
  sub: TypeTerm;
  subOf: Instance;
  sup: TypeTerm;
  supOf: Instance;
}

/**
 * Rounds allowed beyond one per variable. A round moves a solution one edge further, so a chain of n generic
 * nodes legitimately needs n rounds; only growth past that is a type that never settles.
 */
const EXTRA_ROUNDS = 64;

/** Substitutes pins and current solutions. Unsolved variables stay as they are. */
export function resolve(term: TypeTerm, inst: Instance): TypeTerm {
  if (term.kind === "var") {
    const v = inst.vars.get(term.name);
    return v?.pin ?? v?.solution ?? term;
  }
  return term.args?.length ? t(term.id, ...term.args.map((arg) => resolve(arg, inst))) : term;
}

function mentions(term: TypeTerm, name: string): boolean {
  return term.kind === "var"
    ? term.name === name
    : (term.args ?? []).some((arg) => mentions(arg, name));
}

interface Bounds {
  lower: Map<string, TypeTerm>;
  upper: Map<string, TypeTerm>;
  infinite: boolean;
}

/**
 * Solves every unpinned variable in place (§3.4 steps 2–3). Each round recomputes all bounds from scratch,
 * reading other variables through their current solutions, so the result doesn't depend on constraint order.
 * Phase 1 uses lower bounds only; phase 2 also solves variables that have only upper bounds.
 */
export function solve(
  types: TypeTable,
  instances: readonly Instance[],
  constraints: readonly Constraint[],
): Diagnostic[] {
  const free: { inst: Instance; v: TypeVar }[] = [];
  for (const inst of instances)
    for (const v of inst.vars.values()) if (!v.pin) free.push({ inst, v });

  const errors = new Map<TypeVar, Diagnostic>();
  let rounds = 0;
  for (const useUpper of [false, true]) {
    for (;;) {
      const bounds = collect(types, free, constraints);
      errors.clear();
      const changed: { inst: Instance; v: TypeVar }[] = [];
      for (const entry of free) {
        const { inst, v } = entry;
        const b = bounds.get(v);
        let next: TypeTerm | undefined;
        const at = { node: inst.node.id };
        if (b?.infinite) {
          errors.set(v, error("E_INFINITE_TYPE", `${v.name} would contain itself`, at));
        } else if (b?.lower.size) {
          const [first, ...rest] = b.lower.values();
          next = rest.reduce<TypeTerm | undefined>((acc, x) => acc && types.join(acc, x), first);
          if (!next) {
            const list = [...b.lower.keys()].join(", ");
            errors.set(v, error("E_NO_COMMON_TYPE", `${v.name}: no common type for ${list}`, at));
          }
        } else if (useUpper && b?.upper.size) {
          const uppers = [...b.upper.values()];
          next = uppers.find((u) => uppers.every((o) => types.isSubtype(u, o)));
          if (!next) {
            const list = [...b.upper.keys()].join(", ");
            errors.set(v, error("E_NO_COMMON_TYPE", `${v.name}: no type fits all of ${list}`, at));
          }
        }
        const same = next && v.solution ? termEquals(next, v.solution) : next === v.solution;
        if (!same) changed.push(entry);
        if (next) v.solution = next;
        else delete v.solution;
      }
      if (!changed.length) break;
      // ponytail: O(rounds × constraints); a worklist keyed by variable if documents reach ~10k generic nodes.
      if (++rounds >= EXTRA_ROUNDS + free.length) {
        for (const { inst, v } of changed) {
          delete v.solution;
          errors.set(
            v,
            error("E_INFINITE_TYPE", `${v.name} never settles`, { node: inst.node.id }),
          );
        }
        return [...errors.values()];
      }
    }
  }
  return [...errors.values()];
}

function error(code: DiagnosticCode, message: string, at: DiagnosticLocation): Diagnostic {
  return { code, severity: "error", message, at };
}

function collect(
  types: TypeTable,
  free: readonly { inst: Instance; v: TypeVar }[],
  constraints: readonly Constraint[],
): Map<TypeVar, Bounds> {
  const bounds = new Map<TypeVar, Bounds>();
  const of = (v: TypeVar): Bounds => {
    let b = bounds.get(v);
    if (!b) bounds.set(v, (b = { lower: new Map(), upper: new Map(), infinite: false }));
    return b;
  };
  /** `v (of inst) <dir> other (of otherInst)`, kept only once `other` is ground. */
  const add = (
    v: TypeVar,
    inst: Instance,
    dir: "lower" | "upper",
    other: TypeTerm,
    otherInst: Instance,
  ): void => {
    if (otherInst === inst && mentions(other, v.name)) {
      of(v).infinite = true;
      return;
    }
    const ground = resolve(other, otherInst);
    if (isGround(ground)) of(v)[dir].set(formatType(ground), ground);
  };
  const freeVar = (term: TypeTerm, inst: Instance): TypeVar | undefined => {
    const v = term.kind === "var" ? inst.vars.get(term.name) : undefined;
    return v && !v.pin ? v : undefined;
  };
  const decompose = (sub: TypeTerm, so: Instance, sup: TypeTerm, po: Instance): void => {
    const x = freeVar(sub, so);
    const y = freeVar(sup, po);
    if (x && x === y) return; // T <: T
    if (x || y) {
      if (x) add(x, so, "upper", sup, po);
      if (y) add(y, po, "lower", sub, so);
      return;
    }
    const a = sub.kind === "var" ? so.vars.get(sub.name)?.pin : sub;
    const b = sup.kind === "var" ? po.vars.get(sup.name)?.pin : sup;
    if (a?.kind !== "con" || b?.kind !== "con" || a.id !== b.id) return; // left for the check step
    for (const [i, param] of (types.get(a.id)?.params ?? []).entries()) {
      const ai = a.args?.[i];
      const bi = b.args?.[i];
      if (!ai || !bi) continue;
      decompose(ai, so, bi, po);
      if (param.variance === "inv") decompose(bi, po, ai, so);
    }
  };

  for (const c of constraints) decompose(c.sub, c.subOf, c.sup, c.supOf);
  for (const { inst, v } of free) if (v.bound) add(v, inst, "upper", v.bound, inst);
  return bounds;
}
