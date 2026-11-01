export type DiagnosticCode =
  // Structure
  | "E_DUPLICATE_ID"
  | "E_UNKNOWN_NODE_TYPE"
  | "E_UNKNOWN_PORT"
  | "E_UNKNOWN_REF"
  | "E_KIND_MISMATCH"
  | "E_EXEC_FANOUT"
  | "E_DATA_FANIN"
  | "E_EXEC_CYCLE"
  | "E_DATA_CYCLE"
  | "E_CROSS_GRAPH"
  | "E_FUNCTION_SHAPE"
  | "E_VARIADIC_COUNT"
  | "E_INVALID_DOCUMENT"
  // Types
  | "E_TYPE_MISMATCH"
  | "E_NO_COMMON_TYPE"
  | "E_INFINITE_TYPE"
  | "E_KEY_TYPE"
  | "E_UNRESOLVED_TYPE"
  | "E_LITERAL_INVALID"
  | "E_REQUIRED_INPUT"
  | "E_INVALID_TYPE"
  // Versions
  | "E_LANGUAGE_MISMATCH"
  | "E_NEWER_FORMAT"
  | "E_NEWER_LANGUAGE"
  | "E_NEWER_NODE"
  | "E_NODE_OUTDATED";

export interface DiagnosticLocation {
  node?: string;
  port?: string;
  edge?: string;
  variable?: string;
  function?: string;
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning";
  message: string;
  at?: DiagnosticLocation;
}
