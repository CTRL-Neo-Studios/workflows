import type { NodeMode, TypeTable, TypeTerm } from "../core";

/** Named colors a `TypeDef.color` may use; each is a `--wf-<name>` variable in style.css. Other values pass through as CSS. */
export const PALETTE: readonly string[] = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

/** A palette name as its `--wf-<name>` variable; any other value is taken as CSS. */
export const paletteColor = (color: string): string =>
  PALETTE.includes(color) ? `var(--wf-${color})` : color;

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/**
 * The color of a port or wire. Lists and Dictionaries take their item's color; a type without its own `color`
 * takes its nearest ancestor's, else a stable pick from the palette; unresolved variables are `--wf-type-generic`.
 */
export function typeColor(types: TypeTable, term: TypeTerm | undefined): string {
  if (!term || term.kind === "var") return "var(--wf-type-generic)";
  if (term.id === "List") return typeColor(types, term.args?.[0]);
  if (term.id === "Dictionary") return typeColor(types, term.args?.[1]);
  if (["any", "string", "number", "boolean"].includes(term.id)) return `var(--wf-type-${term.id})`;
  for (let def = types.get(term.id); def;) {
    if (def.color) return paletteColor(def.color);
    def = def.extends?.kind === "con" ? types.get(def.extends.id) : undefined;
  }
  return paletteColor(PALETTE[hash(term.id) % PALETTE.length]!);
}

/** Handle shape: a circle for one value, a square grid for a List, a diamond for a Dictionary. */
export function typeShape(term: TypeTerm | undefined): "one" | "list" | "dict" {
  if (term?.kind !== "con") return "one";
  return term.id === "List" ? "list" : term.id === "Dictionary" ? "dict" : "one";
}

export interface ModeStyle {
  /** Nuxt UI semantic color, so modes follow the host's theme. */
  color: "error" | "info" | "success" | "warning";
  /** Default icon; a manifest's `icon` replaces it. */
  icon: string;
  /** Classes for the icon tile. Full strings, so Tailwind finds them when it scans this package. */
  tile: string;
}

export const MODE_STYLES: Record<NodeMode, ModeStyle> = {
  event: { color: "error", icon: "i-lucide-zap", tile: "bg-error/10 text-error" },
  exec: { color: "info", icon: "i-lucide-play", tile: "bg-info/10 text-info" },
  pure: { color: "success", icon: "i-lucide-sigma", tile: "bg-success/10 text-success" },
  once: { color: "warning", icon: "i-lucide-database", tile: "bg-warning/10 text-warning" },
};

/** Short text for a traced value: strings quoted, collections by size. */
export function formatValue(value: unknown, max = 28): string {
  let s: string;
  if (value instanceof Map) s = `Dictionary(${value.size})`;
  else if (Array.isArray(value) && value.length > 3) s = `List(${value.length})`;
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
