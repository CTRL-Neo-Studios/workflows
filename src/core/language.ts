import type { NodeInstance, Program } from "./document";
import {
  type CapabilityDef,
  checkManifest,
  type ConversionDef,
  conversionKey,
  type LanguageManifest,
  type NodeManifest,
} from "./manifest";
import type { TypeDef } from "./types";

export interface PureContext<E> {
  inputs: Record<string, unknown>;
  /** Narrowed to the node's `requires`. */
  effects: E;
  signal: AbortSignal;
}

export interface ExecContext<E> {
  input(port: string): Promise<unknown>;
  inputs(): Promise<Record<string, unknown>>;
  output(port: string, value: unknown): void;
  /** Runs the chain connected to `port` and resolves when it finishes. Rejects with that chain's fault. */
  fire(port: string, opts?: { scope?: true | Record<string, unknown> }): Promise<void>;
  effects: E;
  signal: AbortSignal;
}

export type PureRun<E> = (
  ctx: PureContext<E>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;
/** The returned exec output continues the chain; `void` ends it. */
export type ExecRun<E> = (ctx: ExecContext<E>) => string | void | Promise<string | void>;

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

/** A node manifest plus its implementation; the mode decides which `run` it takes. */
export type NodeDef<E> = NodeManifest & { migrate?: Record<number, NodeMigration> } & (
    | { mode: "pure" | "once"; run: PureRun<E> }
    | { mode: "exec"; run: ExecRun<E> }
    | { mode: "event" }
  );

export interface ConversionImpl extends ConversionDef {
  convert: (value: unknown) => unknown;
}

export interface LanguageOptions {
  id: string;
  version: number;
  /** Languages whose types, capabilities, conversions and nodes are merged in (e.g. std). */
  include?: readonly Language<object>[];
  migrate?: Record<number, DocumentMigration>;
}

export class LanguageBuilder<E extends object> {
  readonly #options: LanguageOptions;
  readonly #types: TypeDef[] = [];
  readonly #capabilities: CapabilityDef[] = [];
  readonly #conversions: ConversionImpl[] = [];
  readonly #nodes: NodeDef<E>[] = [];

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

  conversion(def: ConversionImpl): this {
    this.#conversions.push(def);
    return this;
  }

  node(def: NodeDef<E>): this {
    this.#nodes.push(def);
    return this;
  }

  /** Flattens includes, runs every `checkManifest` rule and throws on the first problem. */
  build(): Language<E> {
    const { id, version, include = [], migrate } = this.#options;
    const nodes = new Map<string, NodeImpl<E>>(include.flatMap((l) => [...l.nodes]));
    const conversions = new Map(include.flatMap((l) => [...l.conversions]));

    const nodeManifests: NodeManifest[] = [];
    for (const def of this.#nodes) {
      const { run, migrate: nodeMigrate, ...manifest }: NodeManifest & NodeImpl<E> = def;
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
      nodes: [...include.flatMap((l) => l.manifest.nodes), ...nodeManifests],
    };
    checkManifest(manifest);
    return { manifest, nodes, conversions, ...(migrate && { migrate }) };
  }
}

/** `E` is the language's effect interface, keyed by capability id. */
export function defineLanguage<E extends object = object>(
  options: LanguageOptions,
): LanguageBuilder<E> {
  return new LanguageBuilder<E>(options);
}
