import type { NodeInstance, Program } from "./document";
import {
  type CapabilityDef,
  type CategoryDef,
  checkManifest,
  type ConversionDef,
  conversionKey,
  type DataPortDef,
  type LanguageManifest,
  type NodeManifest,
  type VariadicDef,
} from "./manifest";
import type { Json } from "./schema";
import type { TypeDef } from "./types";

/**
 * The TypeScript type of a term's run-time values (§3.2). `V` maps the language's own type ids to their value types;
 * built-ins map themselves, `List` is a readonly array, `Dictionary` a `ReadonlyMap`. Variables and unmapped ids
 * (`any` included) are `unknown`.
 */
export type ValueOf<T, V> = T extends { kind: "var" }
  ? unknown
  : T extends { kind: "con"; id: "string" }
    ? string
    : T extends { kind: "con"; id: "number" }
      ? number
      : T extends { kind: "con"; id: "boolean" }
        ? boolean
        : T extends { kind: "con"; id: "List"; args: [infer X] }
          ? readonly ValueOf<X, V>[]
          : T extends { kind: "con"; id: "Dictionary"; args: [infer K, infer X] }
            ? ReadonlyMap<ValueOf<K, V>, ValueOf<X, V>>
            : T extends { kind: "con"; id: infer I extends keyof V }
              ? V[I]
              : unknown;

type Ports = Record<string, DataPortDef>;

/** An input is `undefined` when nothing is wired, no literal is set and it has no default. */
export type InputValues<I, V> = {
  [P in keyof I]: I[P] extends DataPortDef
    ?
        | ValueOf<I[P]["type"], V>
        | (I[P] extends { required: true } | { default: Json } ? never : undefined)
    : never;
};

export type OutputValues<O, V> = {
  [P in keyof O]: O[P] extends DataPortDef ? ValueOf<O[P]["type"], V> : never;
};

/** Variadic inputs (`arg0`, `arg1`, …); each one needs an edge or a literal, so none is `undefined`. */
type VariadicInputs<VD, V> = [VD] extends [
  { kind: "input"; prefix: infer P extends string; type: infer T },
]
  ? { [K in `${P}${number}`]: ValueOf<T, V> }
  : unknown;

type VariadicOuts<VD> = [VD] extends [{ kind: "execOut"; prefix: infer P extends string }]
  ? `${P}${number}`
  : never;

/** `I`: input values, `E`: effects (only the node's `requires`). Untyped by default. */
export interface PureContext<E, I = Record<string, unknown>> {
  inputs: I;
  /** Only the capabilities in the node's `requires`; the others are absent at run time. */
  effects: E;
  signal: AbortSignal;
  /** This instance's variadic port count. */
  variadic: number;
}

/** `I` / `O`: input and output values, `X`: exec output names. Untyped by default. */
export interface ExecContext<
  E,
  I = Record<string, unknown>,
  O = Record<string, unknown>,
  X extends string = string,
> {
  /**
   * Reads an input. With `scope`, reads it in a child scope where those values are this node's outputs,
   * recomputing the pure nodes it reads: once per item, for a filter or a map.
   */
  input<P extends keyof I & string>(
    port: P,
    opts?: { scope: Record<string, unknown> },
  ): Promise<I[P]>;
  inputs(): Promise<I>;
  output<P extends keyof O & string>(port: P, value: O[P]): void;
  /**
   * Runs the chain connected to `port` and resolves when it finishes; an unconnected port resolves at once.
   * Rejects with that chain's fault. `scope` runs it in a child scope; values become this node's outputs there.
   */
  fire(port: X, opts?: { scope?: true | Record<string, unknown> }): Promise<void>;
  /** Only the capabilities in the node's `requires`; the others are absent at run time. */
  effects: E;
  signal: AbortSignal;
  /** This instance's variadic port count. */
  variadic: number;
}

export type PureRun<E, I = Record<string, unknown>, O = Record<string, unknown>> = (
  ctx: PureContext<E, I>,
) => O | Promise<O>;
/** The returned exec output continues the chain; `void` ends it. */
export type ExecRun<
  E,
  I = Record<string, unknown>,
  O = Record<string, unknown>,
  X extends string = string,
> = (ctx: ExecContext<E, I, O, X>) => X | void | Promise<X | void>;

/** Version n → n+1. */
export type NodeMigration = (node: NodeInstance) => NodeInstance;
/** Language version n → n+1. */
export type DocumentMigration = (program: Program) => Program;

/** Event nodes have no `run`: `dispatch` activates them. */
export interface NodeImpl<E> {
  run?: PureRun<E> | ExecRun<E>;
  migrate?: Record<number, NodeMigration>;
}

export interface Language<E> {
  manifest: LanguageManifest;
  nodes: ReadonlyMap<string, NodeImpl<E>>;
  /** Keyed by `conversionKey(from, to)`. */
  conversions: ReadonlyMap<string, (value: unknown) => unknown>;
  /** Language version n → n+1. */
  migrate?: Record<number, DocumentMigration>;
}

type NodeBase = Omit<
  NodeManifest,
  "mode" | "exec" | "inputs" | "outputs" | "variadic" | "requires"
> & {
  migrate?: Record<number, NodeMigration>;
};

/**
 * An exec node. Port names, value types, exec outputs and capabilities are checked against the definition:
 * `ctx.input('typo')`, a wrong `output` value, `return 'unknown'` or `ctx.effects.undeclared` don't compile.
 */
export type ExecNodeDef<E, V, I, O, X extends string, R extends keyof E, VD> = NodeBase & {
  mode: "exec";
  exec?: { in?: string[]; out: X[] };
  inputs?: I;
  outputs?: O;
  variadic?: VD;
  requires?: R[];
  run(
    ctx: ExecContext<
      Pick<E, R>,
      InputValues<I, V> & VariadicInputs<VD, V>,
      OutputValues<O, V>,
      X | VariadicOuts<VD>
    >,
  ): NoInfer<X | VariadicOuts<VD>> | void | Promise<NoInfer<X | VariadicOuts<VD>> | void>;
};

/** A pure or once node: `run` must return every declared output, with its declared type. */
export type PureNodeDef<E, V, I, O, R extends keyof E, VD> = NodeBase & {
  mode: "pure" | "once";
  inputs?: I;
  outputs?: O;
  variadic?: VD;
  requires?: R[];
  run(
    ctx: PureContext<Pick<E, R>, InputValues<I, V> & VariadicInputs<VD, V>>,
  ): NoInfer<OutputValues<O, V>> | Promise<NoInfer<OutputValues<O, V>>>;
};

export type EventNodeDef<O> = NodeBase & {
  mode: "event";
  exec?: { out: string[] };
  outputs?: O;
  run?: never;
};

export interface ConversionImpl extends ConversionDef {
  convert: (value: unknown) => unknown;
}

export interface LanguageOptions {
  id: string;
  version: number;
  /** Languages whose types, capabilities, categories, conversions and nodes are merged in (e.g. std). */
  include?: readonly Language<object>[];
  migrate?: Record<number, DocumentMigration>;
}

/** What the builder keeps per node: the manifest plus its implementation, untyped. */
type StoredNode<E> = NodeManifest & NodeImpl<E>;

/** `E`: effect interface keyed by capability id. `V`: value types of the language's own type ids. */
export class LanguageBuilder<E extends object, V = {}> {
  readonly #options: LanguageOptions;
  readonly #types: TypeDef[] = [];
  readonly #capabilities: CapabilityDef[] = [];
  readonly #conversions: ConversionImpl[] = [];
  readonly #categories: CategoryDef[] = [];
  readonly #nodes: StoredNode<E>[] = [];

  constructor(options: LanguageOptions) {
    this.#options = options;
  }

  type(def: TypeDef): this {
    this.#types.push(def);
    return this;
  }

  capability(def: CapabilityDef): this {
    this.#capabilities.push(def);
    return this;
  }

  category(def: CategoryDef): this {
    this.#categories.push(def);
    return this;
  }

  conversion(def: ConversionImpl): this {
    this.#conversions.push(def);
    return this;
  }

  node<
    const I extends Ports = {},
    const O extends Ports = {},
    const X extends string = never,
    const R extends keyof E & string = never,
    const VD extends VariadicDef | undefined = undefined,
  >(
    def: ExecNodeDef<E, V, I, O, X, R, VD> | PureNodeDef<E, V, I, O, R, VD> | EventNodeDef<O>,
  ): this {
    // The typed `run` expects a context narrowed to the declared ports. The runtime builds exactly that context for
    // a validated program, so storing it under the untyped signature is safe.
    this.#nodes.push(def as unknown as StoredNode<E>);
    return this;
  }

  /** Flattens includes, runs every `checkManifest` rule and throws on the first problem. */
  build(): Language<E> {
    const { id, version, include = [], migrate } = this.#options;
    const nodes = new Map<string, NodeImpl<E>>(include.flatMap((l) => [...l.nodes]));
    const conversions = new Map(include.flatMap((l) => [...l.conversions]));

    const nodeManifests: NodeManifest[] = [];
    for (const def of this.#nodes) {
      const { run, migrate: nodeMigrate, ...manifest } = def;
      const needsRun = def.mode !== "event";
      if (needsRun !== (typeof run === "function")) {
        throw new Error(
          `Node '${def.type}': ${needsRun ? "run is required" : "event nodes have no run"}`,
        );
      }
      nodeManifests.push(manifest);
      nodes.set(def.type, { ...(run && { run }), ...(nodeMigrate && { migrate: nodeMigrate }) });
    }
    for (const { from, to, convert } of this.#conversions)
      conversions.set(conversionKey(from, to), convert);

    const manifest: LanguageManifest = {
      manifest: 1,
      language: { id, version },
      types: [...include.flatMap((l) => l.manifest.types), ...this.#types],
      conversions: [
        ...include.flatMap((l) => l.manifest.conversions),
        ...this.#conversions.map(({ from, to }) => ({ from, to })),
      ],
      capabilities: [...include.flatMap((l) => l.manifest.capabilities), ...this.#capabilities],
      categories: [...include.flatMap((l) => l.manifest.categories ?? []), ...this.#categories],
      nodes: [...include.flatMap((l) => l.manifest.nodes), ...nodeManifests],
    };
    checkManifest(manifest);
    return { manifest, nodes, conversions, ...(migrate && { migrate }) };
  }
}

/**
 * `E` is the language's effect interface, keyed by capability id. `V` maps the language's type ids to the
 * TypeScript types of their values, e.g. `{ "vertex.File": string }`, so node contexts are typed.
 */
export function defineLanguage<E extends object = object, V = {}>(
  options: LanguageOptions,
): LanguageBuilder<E, V> {
  return new LanguageBuilder<E, V>(options);
}
