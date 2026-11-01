import type { DocumentV1 } from "./document";

/** Sorted keys, no whitespace, `undefined` properties dropped (as JSON.stringify does). */
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 (hex) of the canonical JSON of `{ format, language, program }` (§6). View and meta don't count, so moving
 * nodes, regrouping or renaming keeps the hash. Hosts key trust records by it; the file never contains it.
 */
export async function hashProgram(doc: DocumentV1): Promise<string> {
  const text = canonical({ format: doc.format, language: doc.language, program: doc.program });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
