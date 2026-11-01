import type { DataPortDef, TypeParamDef } from "./manifest";
import type { Json } from "./schema";
import type { TypeTerm } from "./types";

/** A document as saved (`.workflow` in Vertex). Untrusted data: always `validate` before use. */
export interface DocumentV1 {
  format: 1;
  language: { id: string; version: number };
  meta?: { name?: string; description?: string };
  program: Program;
  view: View;
}

export interface Program {
  graph: Graph;
  variables: VariableDecl[];
  functions: FunctionDecl[];
}

export interface Graph {
  nodes: NodeInstance[];
  edges: EdgeInstance[];
}

export interface NodeInstance {
  /** Unique across the whole document, function bodies included. */
  id: string;
  type: string;
  version: number;
  literals?: Record<string, Json>;
  typeArgs?: Record<string, TypeTerm>;
  variadic?: number;
  /** core.call → function id; core.get / core.set → variable id. */
  ref?: string;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface EdgeInstance {
  id: string;
  from: PortRef;
  to: PortRef;
}

/** `type` must be ground. */
export interface VariableDecl {
  id: string;
  name: string;
  type: TypeTerm;
  default?: Json;
}

export interface FunctionDecl {
  id: string;
  name: string;
  /** Rigid inside the body, fresh per core.call outside it. */
  typeParams?: TypeParamDef[];
  /** false = pure function: the body may contain no exec nodes. */
  exec: boolean;
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
  locals?: VariableDecl[];
  /** Exactly one core.entry; exactly one core.return. */
  graph: Graph;
}

/** View-only: never affects validation, execution or the program hash. */
export interface View {
  positions: Record<string, { x: number; y: number }>;
  groups: Group[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface Group {
  id: string;
  graph: "main" | string;
  label?: string;
  color?: string;
  nodes: string[];
}
