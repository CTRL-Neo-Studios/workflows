import type { Diagnostic } from "./diagnostics";
import type { DocumentV1 } from "./document";
import type { Instance } from "./infer";
import type { ExecContext, ExecRun, Language, PureRun } from "./language";
import { conversionKey } from "./manifest";
import type { TypeTerm } from "./types";
import { analyze, dataInputs, isEvent, reachableCapabilities } from "./validate";

export type FaultCode =
  | "E_MISSING_EFFECT"
  | "E_STEP_LIMIT"
  | "E_DEPTH_LIMIT"
  | "E_UNSET_VALUE"
  | "E_CONCURRENT_FIRE"
  | "E_OUTPUT_MISSING"
  | "E_NO_RETURN"
  | "E_NODE_THREW";

export interface Fault {
  code: FaultCode;
  message: string;
  node?: string;
  cause?: unknown;
}

/** How a fault travels through a run: `ctx.fire` and `ctx.input` reject with it, and `std.try` catches it. */
export class FaultError extends Error {
  readonly fault: Fault;
  constructor(fault: Fault) {
    super(fault.message);
    this.name = "FaultError";
    this.fault = fault;
  }
}

/** Thrown by `compile` when the document has error diagnostics. */
export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(`Document has ${diagnostics.length} error(s); first: ${diagnostics[0]?.message ?? ""}`);
    this.name = "CompileError";
    this.diagnostics = diagnostics;
  }
}

export type TraceEvent =
  /** Pure and once nodes: emitted after their inputs resolve. `depth` is the call depth. */
  | { t: "enter"; node: string; depth: number }
  | { t: "exit"; node: string; port?: string; depth: number }
  /** An exec node's `fire(port)`, before the chain on `port` runs (and before its scope values). */
  | { t: "fire"; node: string; port: string; depth: number }
  /** Only with `trace: 'values'`. */
  | { t: "value"; node: string; port: string; value: unknown }
  | { t: "fault"; node: string; fault: Fault };

export interface RunLimits {
  /** Default 100_000. */
  steps?: number;
  /** Maximum call depth. Default 64. */
  depth?: number;
  /** No default: runs without a timeout unless set. Time the run spends waiting on the user doesn't count. */
  timeoutMs?: number;
}

export interface RunOptions<E> {
  effects: E;
  signal?: AbortSignal;
  limits?: RunLimits;
  /** Default 'off'. */
  trace?: "off" | "nodes" | "values";
  onTrace?: (event: TraceEvent) => void;
  /**
   * Capabilities whose calls wait on the user (prompts, pickers). Their methods are awaited, and the time spent
   * in them doesn't count toward `timeoutMs`.
   */
  interactive?: readonly string[];
  /**
   * Awaited before each event and exec node runs, e.g. a debugger's step. The run waits for it, and that time
   * doesn't count toward `timeoutMs`.
   */
  beforeStep?: (node: string) => void | Promise<void>;
}

export interface RunResult {
  status: "ok" | "fault" | "aborted";
  fault?: Fault;
  steps: number;
}

export interface CompiledProgram<E> {
  /** Capabilities of every node reachable from an event node (§7). */
  capabilities: ReadonlySet<string>;
  /** Runs every instance of `eventType`, one after another, in document order. Never rejects for program errors. */
  dispatch(
    eventType: string,
    payload: Record<string, unknown> | undefined,
    opts: RunOptions<E>,
  ): Promise<RunResult>;
}

type CoreKind = "entry" | "return" | "call" | "get" | "set";
const CORE_KINDS: Record<string, CoreKind> = {
  "core.entry": "entry",
  "core.return": "return",
  "core.call": "call",
  "core.get": "get",
  "core.set": "set",
};

/** A node instance with everything the runtime needs, resolved once at compile time. */
interface CompiledNode<E> {
  id: string;
  mode: Instance["manifest"]["mode"];
  /** core.* nodes are run by the runtime itself. */
  core?: CoreKind;
  /** core.call → function id; core.get / core.set → variable id; core.return (exec) → the exit it leaves through. */
  ref: string;
  exec?: ExecRun<E>;
  pure?: PureRun<E>;
  /** Exec output port → the node it activates. */
  next: Map<string, CompiledNode<E>>;
  execOuts: ReadonlySet<string>;
  /** Data input port → its source. */
  wires: Map<
    string,
    { from: CompiledNode<E>; port: string; convert?: (value: unknown) => unknown }
  >;
  /** Decoded literal, else default, for each input that has one. */
  fallback: Map<string, unknown>;
  inputs: string[];
  outputs: string[];
  requires: string[];
  variadic: number;
}

interface CompiledFunction<E> {
  name: string;
  exec: boolean;
  entry: CompiledNode<E>;
  /** A pure function's only core.return; an exec function leaves through whichever return runs. */
  ret: CompiledNode<E>;
  /** Local ids, with their decoded defaults where declared. */
  locals: ReadonlyMap<string, { value: unknown } | undefined>;
}

/** Literals are JSON. List items are decoded recursively; `Dictionary` (JSON object, K = string) becomes a `Map`. */
function decode(value: unknown, type: TypeTerm | undefined): unknown {
  if (type?.kind !== "con") return value;
  const [a, b] = type.args ?? [];
  if (type.id === "List" && Array.isArray(value)) return value.map((item) => decode(item, a));
  if (
    type.id === "Dictionary" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return new Map(Object.entries(value).map(([k, v]) => [k, decode(v, b)]));
  }
  return value;
}

/** Validates, then links the document into a runnable program. Throws `CompileError` on any error diagnostic. */
export function compile<E extends object>(
  doc: DocumentV1,
  language: Language<E>,
): CompiledProgram<E> {
  const analyzed = analyze(doc, language.manifest);
  const { analysis, instances, execEdges, dataEdges, decls, bodies } = analyzed;
  const errors = analysis.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new CompileError(errors);

  const nodes = new Map<Instance, CompiledNode<E>>();
  for (const inst of instances.values()) {
    const { id, type } = inst.node;
    const m = inst.manifest;
    const core = CORE_KINDS[type];
    const run = language.nodes.get(type)?.run;
    if (!core && m.mode !== "event" && typeof run !== "function")
      throw new Error(`Language has no run for '${type}'`);
    const literals = inst.node.literals ?? {};
    const fallback = new Map<string, unknown>();
    const inputs: string[] = [];
    for (const [port, def] of dataInputs(inst)) {
      inputs.push(port);
      const value = Object.hasOwn(literals, port) ? literals[port] : def.default;
      if (value !== undefined) fallback.set(port, decode(value, analysis.typeOf(id, port, "in")));
    }
    const v = m.variadic;
    const variadicOuts =
      v?.kind === "execOut"
        ? Array.from({ length: inst.variadic }, (_, i) => `${v.prefix}${i}`)
        : [];
    // The mode decides the signature; `NodeDef` pairs them when the language is built.
    const runs =
      core || m.mode === "event"
        ? {}
        : m.mode === "exec"
          ? { exec: run as ExecRun<E> }
          : { pure: run as PureRun<E> };
    nodes.set(inst, {
      id,
      mode: m.mode,
      ...(core && { core }),
      ref:
        inst.node.ref ??
        (core === "return" ? decls.functions.get(inst.graph)?.exits[0] : undefined) ??
        "",
      ...runs,
      next: new Map(),
      execOuts: new Set([...(m.exec?.out ?? []), ...variadicOuts]),
      wires: new Map(),
      fallback,
      inputs,
      outputs: Object.keys(m.outputs ?? {}),
      requires: m.requires ?? [],
      variadic: inst.variadic,
    });
  }
  // Every edge end is an instance: `analyze` only keeps edges between instances.
  for (const e of execEdges) nodes.get(e.from)!.next.set(e.edge.from.port, nodes.get(e.to)!);
  for (const e of dataEdges) {
    const from = nodes.get(e.from)!;
    let convert: ((value: unknown) => unknown) | undefined;
    if (analysis.convertedEdges.has(e.edge.id)) {
      const a = analysis.typeOf(e.edge.from.node, e.edge.from.port, "out");
      const b = analysis.typeOf(e.edge.to.node, e.edge.to.port, "in");
      convert = a && b ? language.conversions.get(conversionKey(a, b)) : undefined;
    }
    const wire = convert
      ? { from, port: e.edge.from.port, convert }
      : { from, port: e.edge.from.port };
    nodes.get(e.to)!.wires.set(e.edge.to.port, wire);
  }

  // Validation guarantees every surviving function has exactly one entry and at least one return.
  const functions = new Map<string, CompiledFunction<E>>();
  for (const [id, fn] of decls.functions) {
    const body = bodies.get(id);
    const ret = body?.rets[0];
    if (!body?.entry || !ret) continue;
    const locals = new Map<string, { value: unknown } | undefined>();
    for (const l of fn.locals.values())
      locals.set(l.id, l.default === undefined ? undefined : { value: decode(l.default, l.type) });
    functions.set(id, {
      name: fn.decl.name,
      exec: fn.decl.exec,
      entry: nodes.get(body.entry)!,
      ret: nodes.get(ret)!,
      locals,
    });
  }
  const globals = [...decls.variables.values()].map((v) => ({
    id: v.id,
    initial: v.default === undefined ? undefined : { value: decode(v.default, v.type) },
  }));

  const events = new Map<string, { nodes: CompiledNode<E>[]; requires: Set<string> }>();
  for (const [inst, node] of nodes) {
    if (!isEvent(inst)) continue;
    const entry = events.get(inst.node.type) ?? { nodes: [], requires: new Set() };
    entry.nodes.push(node);
    for (const id of reachableCapabilities([inst], analyzed)) entry.requires.add(id);
    events.set(inst.node.type, entry);
  }

  return {
    capabilities: analysis.capabilities,
    async dispatch(eventType, payload, opts) {
      const entry = events.get(eventType);
      const handlers = new Map<string, unknown>(Object.entries(opts.effects));
      const missing = [...(entry?.requires ?? [])].filter((id) => handlers.get(id) === undefined);
      if (missing.length) {
        return {
          status: "fault",
          fault: { code: "E_MISSING_EFFECT", message: `No handler for ${missing.join(", ")}` },
          steps: 0,
        };
      }
      const slots = new Map<string, unknown>();
      // Variables live for the whole run; decoded values are shared, which is safe because values are immutable.
      for (const g of globals) if (g.initial) slots.set(g.id, g.initial.value);
      return new Run<E>(opts, handlers, functions, slots).dispatch(entry?.nodes ?? [], payload);
    },
  };
}

/** The run is over (aborted, timed out, or finished while a stray chain was still going). */
class Stopped extends Error {}

/** `timeoutMs` as an abort, on a clock that stops while the run waits on the user. */
class Clock {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  #left: number;
  #since = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #held = 0;

  constructor(ms: number) {
    this.#left = ms;
    this.#run();
  }

  #run(): void {
    this.#since = Date.now();
    this.#timer = setTimeout(() => this.#controller.abort(), this.#left);
  }

  hold(): void {
    if (this.#held++ > 0) return;
    clearTimeout(this.#timer);
    this.#left -= Date.now() - this.#since;
  }

  release(): void {
    if (--this.#held === 0 && !this.signal.aborted) this.#run();
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

/** Unwinds a call once its core.return ran; only that call's boundary catches it. */
class Returned extends Error {}

/** One function call (§8.5). The main graph runs in frame 0. */
interface Frame {
  depth: number;
  args: Record<string, unknown>;
  /** Set values of this call's locals. */
  locals: Map<string, unknown>;
  localIds: ReadonlySet<string>;
  /** Set by the core.return that ran: its values and the exit the call continues on. */
  result?: { exit: string; values: Record<string, unknown> };
  /** Thrown at every later step of this call once core.return ran. */
  unwind: Returned;
  returned: boolean;
}

function newFrame(
  depth: number,
  args: Record<string, unknown>,
  locals?: ReadonlyMap<string, { value: unknown } | undefined>,
): Frame {
  const values = new Map<string, unknown>();
  for (const [id, initial] of locals ?? []) if (initial) values.set(id, initial.value);
  return {
    depth,
    args,
    locals: values,
    localIds: new Set(locals?.keys()),
    unwind: new Returned(),
    returned: false,
  };
}

class Scope<E> {
  readonly #values = new Map<CompiledNode<E>, Map<string, unknown>>();
  readonly parent: Scope<E> | undefined;
  readonly frame: Frame;

  /** A root scope (a new call) has no parent; a child scope stays in its parent's frame. */
  constructor(parent: Scope<E> | undefined, frame: Frame) {
    this.parent = parent;
    this.frame = frame;
  }

  set(node: CompiledNode<E>, port: string, value: unknown): void {
    const ports = this.#values.get(node) ?? new Map<string, unknown>();
    this.#values.set(node, ports.set(port, value));
  }

  /** Nearest value up the parent chain. */
  find(node: CompiledNode<E>, port: string): { value: unknown } | undefined {
    const ports = this.#values.get(node);
    return ports?.has(port) ? { value: ports.get(port) } : this.parent?.find(node, port);
  }
}

/** Pure results for one consumer activation (§8.4). */
type Cache<E> = Map<CompiledNode<E>, Promise<Record<string, unknown>>>;

class Run<E> {
  steps = 0;
  /** Set once the run must stop: a limit, an abort, or the end of the run. Every later step throws it. */
  fatal: Error | undefined;
  readonly #once: Cache<E> = new Map();
  readonly #effects = new Map<CompiledNode<E>, E>();
  readonly #handlers: Map<string, unknown>;
  readonly #functions: ReadonlyMap<string, CompiledFunction<E>>;
  /** Document variables. */
  readonly #globals: Map<string, unknown>;
  readonly #signal: AbortSignal;
  readonly #clock: Clock | undefined;
  readonly #maxSteps: number;
  readonly #maxDepth: number;
  readonly #trace: "off" | "nodes" | "values";
  readonly #onTrace: ((event: TraceEvent) => void) | undefined;
  readonly #onStep: ((node: string) => void | Promise<void>) | undefined;

  constructor(
    opts: RunOptions<E>,
    handlers: Map<string, unknown>,
    functions: ReadonlyMap<string, CompiledFunction<E>>,
    globals: Map<string, unknown>,
  ) {
    const { signal, limits = {} } = opts;
    this.#clock = limits.timeoutMs === undefined ? undefined : new Clock(limits.timeoutMs);
    this.#signal = AbortSignal.any([signal, this.#clock?.signal].filter((s) => s !== undefined));
    this.#handlers = new Map(handlers);
    for (const id of opts.interactive ?? []) {
      const handler = handlers.get(id);
      if (typeof handler === "object" && handler !== null)
        this.#handlers.set(id, this.#waitingOn(handler));
    }
    this.#functions = functions;
    this.#globals = globals;
    this.#maxSteps = limits.steps ?? 100_000;
    this.#maxDepth = limits.depth ?? 64;
    this.#trace = opts.onTrace ? (opts.trace ?? "off") : "off";
    this.#onTrace = opts.onTrace;
    this.#onStep = opts.beforeStep;
  }

  /** Runs `wait` with the timeout's clock stopped. */
  async #paused<T>(wait: () => T | Promise<T>): Promise<T> {
    this.#clock?.hold();
    try {
      return await wait();
    } finally {
      this.#clock?.release();
    }
  }

  /** An interactive capability's handler, every method (at any depth) called with the clock stopped. */
  #waitingOn(target: object): object {
    return new Proxy(target, {
      get: (obj, key, receiver) => {
        const value: unknown = Reflect.get(obj, key, receiver);
        if (typeof value === "function")
          return (...args: unknown[]) => this.#paused(() => Reflect.apply(value, obj, args));
        return typeof value === "object" && value !== null ? this.#waitingOn(value) : value;
      },
    });
  }

  /** `beforeStep`, unless the node won't run anyway. */
  async #beforeStep(node: CompiledNode<E>, frame: Frame): Promise<void> {
    const hook = this.#onStep;
    if (hook && !this.fatal && !frame.returned) await this.#paused(() => hook(node.id));
  }

  #emit(event: TraceEvent): void {
    if (this.#trace === "off" || (event.t === "value" && this.#trace !== "values")) return;
    this.#onTrace?.(event);
  }

  #fault(code: FaultCode, message: string, node: string, cause?: unknown): FaultError {
    const fault: Fault =
      cause === undefined ? { code, message, node } : { code, message, node, cause };
    this.#emit({ t: "fault", node, fault });
    return new FaultError(fault);
  }

  /** One step at a node boundary (§8.6). Throws instead if the run, or this call, must stop. */
  #step(node: CompiledNode<E>, frame: Frame): void {
    if (!this.fatal && this.#signal.aborted) this.fatal = new Stopped("aborted");
    if (!this.fatal && this.steps >= this.#maxSteps) {
      this.fatal = this.#fault("E_STEP_LIMIT", `Step limit ${this.#maxSteps} reached`, node.id);
    }
    if (this.fatal) throw this.fatal;
    if (frame.returned) throw frame.unwind;
    this.steps++;
  }

  /** After a node's run returns: stop if the run or the call ended while it ran (e.g. `std.try` swallowed it). */
  #checkpoint(frame: Frame): void {
    if (this.fatal) throw this.fatal;
    if (frame.returned) throw frame.unwind;
  }

  /** Turns whatever a node's run threw into the error that continues up the chain. */
  #caught(error: unknown, node: CompiledNode<E>): Error {
    if (this.fatal) return this.fatal;
    if (this.#signal.aborted) return (this.fatal = new Stopped("aborted"));
    if (error instanceof FaultError || error instanceof Returned) return error;
    const message = error instanceof Error ? error.message : String(error);
    return this.#fault("E_NODE_THREW", `${node.id}: ${message}`, node.id, error);
  }

  #effectsOf(node: CompiledNode<E>): E {
    let effects = this.#effects.get(node);
    if (!effects) {
      // Narrowed at run time to `requires` (§7), so a node can't reach a capability it didn't declare.
      // Typed as the whole E until typed contexts land (M4).
      effects = Object.fromEntries(node.requires.map((id) => [id, this.#handlers.get(id)])) as E;
      this.#effects.set(node, effects);
    }
    return effects;
  }

  async dispatch(
    starts: readonly CompiledNode<E>[],
    payload: Record<string, unknown> | undefined,
  ): Promise<RunResult> {
    try {
      for (const node of starts) {
        const root = new Scope<E>(undefined, newFrame(0, {}));
        await this.#start(node, root, payload ?? {});
      }
      if (this.fatal) throw this.fatal;
      return { status: "ok", steps: this.steps };
    } catch (error) {
      const e = this.fatal ?? error;
      if (e instanceof Stopped) return { status: "aborted", steps: this.steps };
      if (e instanceof FaultError) return { status: "fault", fault: e.fault, steps: this.steps };
      throw e;
    } finally {
      // A chain still running (e.g. the other side of a concurrent fire) stops at its next step.
      this.fatal ??= new Stopped("finished");
      this.#clock?.stop();
    }
  }

  /** Activates an event or an exec function's entry: `values` become its outputs in `root`, then the chain runs. */
  async #start(
    node: CompiledNode<E>,
    root: Scope<E>,
    values: Record<string, unknown>,
  ): Promise<void> {
    const depth = root.frame.depth;
    await this.#beforeStep(node, root.frame);
    this.#step(node, root.frame);
    this.#emit({ t: "enter", node: node.id, depth });
    for (const port of node.outputs) {
      if (!Object.hasOwn(values, port)) continue;
      root.set(node, port, values[port]);
      this.#emit({ t: "value", node: node.id, port, value: values[port] });
    }
    // An event continues on its first exec output (`then` by convention).
    const [port] = node.execOuts;
    this.#emit(
      port === undefined
        ? { t: "exit", node: node.id, depth }
        : { t: "exit", node: node.id, port, depth },
    );
    await this.#chain(port === undefined ? undefined : node.next.get(port), root);
  }

  async #chain(start: CompiledNode<E> | undefined, scope: Scope<E>): Promise<void> {
    for (let node = start; node;) {
      const port = await this.#activate(node, scope);
      node = port === undefined ? undefined : node.next.get(port);
    }
  }

  /** Enters a function: a new frame whose root scope has no parent (§8.3). */
  #enter(
    call: CompiledNode<E>,
    scope: Scope<E>,
    args: Record<string, unknown>,
  ): { fn: CompiledFunction<E>; root: Scope<E> } {
    const fn = this.#functions.get(call.ref)!;
    const depth = scope.frame.depth + 1;
    if (depth > this.#maxDepth) {
      this.fatal = this.#fault(
        "E_DEPTH_LIMIT",
        `Call depth limit ${this.#maxDepth} reached`,
        call.id,
      );
      throw this.fatal;
    }
    return { fn, root: new Scope<E>(undefined, newFrame(depth, args, fn.locals)) };
  }

  /** The slot a core.get / core.set names: a local of the current call, else a document variable. */
  #slots(node: CompiledNode<E>, frame: Frame): Map<string, unknown> {
    return frame.localIds.has(node.ref) ? frame.locals : this.#globals;
  }

  /** core.* exec nodes. Returns the exec output to continue on. */
  async #activateCore(
    node: CompiledNode<E>,
    scope: Scope<E>,
    cache: Cache<E>,
  ): Promise<string | undefined> {
    const frame = scope.frame;
    switch (node.core) {
      case "set": {
        this.#slots(node, frame).set(node.ref, await this.#input(node, "value", scope, cache));
        return "then";
      }
      case "return": {
        frame.result = { exit: node.ref, values: await this.#inputs(node, scope, cache) };
        frame.returned = true;
        this.#emit({ t: "exit", node: node.id, depth: frame.depth });
        throw frame.unwind;
      }
      case "call": {
        const { fn, root } = this.#enter(node, scope, await this.#inputs(node, scope, cache));
        try {
          await this.#start(fn.entry, root, root.frame.args);
        } catch (error) {
          if (error !== root.frame.unwind) throw error;
        }
        const { result } = root.frame;
        if (!result) {
          throw this.#fault(
            "E_NO_RETURN",
            `${fn.name} ended without reaching core.return`,
            node.id,
          );
        }
        for (const port of node.outputs) {
          scope.set(node, port, result.values[port]);
          this.#emit({ t: "value", node: node.id, port, value: result.values[port] });
        }
        return result.exit;
      }
      default:
        throw new Error(`${node.id}: core.${String(node.core)} can't be activated`);
    }
  }

  /** One exec activation (§8.2): one step, then `run`. Returns the exec output to continue on. */
  async #activate(node: CompiledNode<E>, scope: Scope<E>): Promise<string | undefined> {
    const frame = scope.frame;
    await this.#beforeStep(node, frame);
    this.#step(node, frame);
    this.#emit({ t: "enter", node: node.id, depth: frame.depth });
    const cache: Cache<E> = new Map();
    if (node.core) {
      const port = await this.#activateCore(node, scope, cache);
      this.#emit(
        port === undefined
          ? { t: "exit", node: node.id, depth: frame.depth }
          : { t: "exit", node: node.id, port, depth: frame.depth },
      );
      return port;
    }
    let firing = false;
    /** A child scope where `values` are this node's outputs. */
    const scoped = (values: Record<string, unknown>): Scope<E> => {
      const child = new Scope<E>(scope, frame);
      for (const [p, value] of Object.entries(values)) {
        child.set(node, p, value);
        this.#emit({ t: "value", node: node.id, port: p, value });
      }
      return child;
    };
    const ctx: ExecContext<E> = {
      input: (port, opts) =>
        opts
          ? this.#input(node, port, scoped(opts.scope), new Map())
          : this.#input(node, port, scope, cache),
      inputs: () => this.#inputs(node, scope, cache),
      output: (port, value) => {
        if (!node.outputs.includes(port)) throw new TypeError(`${node.id} has no output '${port}'`);
        scope.set(node, port, value);
        this.#emit({ t: "value", node: node.id, port, value });
      },
      fire: async (port, opts) => {
        if (!node.execOuts.has(port))
          throw new TypeError(`${node.id} has no exec output '${port}'`);
        if (firing) {
          throw this.#fault(
            "E_CONCURRENT_FIRE",
            `${node.id} fired '${port}' while another fire was running`,
            node.id,
          );
        }
        firing = true;
        this.#emit({ t: "fire", node: node.id, port, depth: frame.depth });
        try {
          const child =
            opts?.scope === undefined
              ? scope
              : opts.scope === true
                ? new Scope<E>(scope, frame)
                : scoped(opts.scope);
          await this.#chain(node.next.get(port), child);
        } finally {
          firing = false;
        }
      },
      effects: this.#effectsOf(node),
      signal: this.#signal,
      variadic: node.variadic,
    };
    let result: string | void;
    try {
      result = await node.exec!(ctx);
    } catch (error) {
      throw this.#caught(error, node);
    }
    this.#checkpoint(frame);
    if (typeof result !== "string") {
      this.#emit({ t: "exit", node: node.id, depth: frame.depth });
      return undefined;
    }
    if (!node.execOuts.has(result))
      throw this.#caught(new TypeError(`returned unknown exec output '${result}'`), node);
    this.#emit({ t: "exit", node: node.id, port: result, depth: frame.depth });
    return result;
  }

  async #inputs(
    node: CompiledNode<E>,
    scope: Scope<E>,
    cache: Cache<E>,
  ): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {};
    // In declaration order, so effects and steps are deterministic.
    for (const port of node.inputs) values[port] = await this.#input(node, port, scope, cache);
    return values;
  }

  /** §8.4: edge, else literal, else default. */
  async #input(
    node: CompiledNode<E>,
    port: string,
    scope: Scope<E>,
    cache: Cache<E>,
  ): Promise<unknown> {
    if (!node.inputs.includes(port)) throw new TypeError(`${node.id} has no input '${port}'`);
    const wire = node.wires.get(port);
    if (!wire) return node.fallback.get(port);
    const { from } = wire;
    let value: unknown;
    if (from.mode === "pure" || from.mode === "once") {
      value = (await this.#evaluate(from, scope, cache))[wire.port];
    } else {
      const found = scope.find(from, wire.port);
      if (!found) {
        throw this.#fault(
          "E_UNSET_VALUE",
          `${node.id}.${port} reads ${from.id}.${wire.port}, which isn't set in this scope`,
          node.id,
        );
      }
      value = found.value;
    }
    return wire.convert ? wire.convert(value) : value;
  }

  /** Pure: once per consumer activation. Once: once per run. */
  #evaluate(
    node: CompiledNode<E>,
    scope: Scope<E>,
    cache: Cache<E>,
  ): Promise<Record<string, unknown>> {
    const store = node.mode === "once" ? this.#once : cache;
    let result = store.get(node);
    if (!result) {
      result = this.#compute(node, scope, node.mode === "once" ? new Map() : cache);
      store.set(node, result);
    }
    return result;
  }

  /** core.* pure nodes: a function's entry, a variable read, a pure call. */
  async #computeCore(
    node: CompiledNode<E>,
    scope: Scope<E>,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const frame = scope.frame;
    switch (node.core) {
      case "entry":
        return frame.args;
      case "get": {
        const slots = this.#slots(node, frame);
        if (!slots.has(node.ref))
          throw this.#fault(
            "E_UNSET_VALUE",
            `${node.id} reads variable '${node.ref}' before it is set`,
            node.id,
          );
        return { value: slots.get(node.ref) };
      }
      case "call": {
        const { fn, root } = this.#enter(node, scope, inputs);
        // A pure call evaluates its function's return inputs in the callee's frame, with a fresh cache.
        this.#step(fn.ret, root.frame);
        this.#emit({ t: "enter", node: fn.ret.id, depth: root.frame.depth });
        const result = await this.#inputs(fn.ret, root, new Map());
        this.#emit({ t: "exit", node: fn.ret.id, depth: root.frame.depth });
        return result;
      }
      default:
        throw new Error(`${node.id}: core.${String(node.core)} can't be evaluated`);
    }
  }

  async #compute(
    node: CompiledNode<E>,
    scope: Scope<E>,
    cache: Cache<E>,
  ): Promise<Record<string, unknown>> {
    const frame = scope.frame;
    const inputs = await this.#inputs(node, scope, cache);
    this.#step(node, frame);
    this.#emit({ t: "enter", node: node.id, depth: frame.depth });
    let outputs: Record<string, unknown>;
    try {
      outputs = node.core
        ? await this.#computeCore(node, scope, inputs)
        : await node.pure!({
            inputs,
            effects: this.#effectsOf(node),
            signal: this.#signal,
            variadic: node.variadic,
          });
    } catch (error) {
      throw this.#caught(error, node);
    }
    this.#checkpoint(frame);
    for (const port of node.outputs) {
      if (!Object.hasOwn(outputs, port))
        throw this.#fault("E_OUTPUT_MISSING", `${node.id} returned no '${port}'`, node.id);
      this.#emit({ t: "value", node: node.id, port, value: outputs[port] });
    }
    this.#emit({ t: "exit", node: node.id, depth: frame.depth });
    return outputs;
  }
}
