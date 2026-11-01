import { describe, expect, test } from "vitest";
import { t, TypeTable, type TypeTerm } from "./types";

// Vertex's hierarchy (§11): Entry ← File ← Note, Entry ← Folder. Path extends string, so it is a key type.
const table = new TypeTable([
  { id: "vertex.Entry" },
  { id: "vertex.File", extends: t("vertex.Entry") },
  { id: "vertex.Note", extends: t("vertex.File") },
  { id: "vertex.Folder", extends: t("vertex.Entry") },
  { id: "vertex.Path", extends: t("string") },
]);

const Entry = t("vertex.Entry");
const File = t("vertex.File");
const Note = t("vertex.Note");
const Folder = t("vertex.Folder");
const str = t("string");
const num = t("number");
const List = (x: TypeTerm) => t("List", x);
const Dict = (k: TypeTerm, v: TypeTerm) => t("Dictionary", k, v);
const rigidT: TypeTerm = { kind: "var", name: "T", rigid: true };

describe("isSubtype", () => {
  test("nominal chain, upcasts only", () => {
    expect(table.isSubtype(Note, Entry)).toBe(true);
    expect(table.isSubtype(Entry, Note)).toBe(false);
    expect(table.isSubtype(Folder, File)).toBe(false);
    expect(table.isSubtype(num, t("any"))).toBe(true);
    expect(table.isSubtype(t("any"), File)).toBe(false);
  });

  test("List is covariant, including nested", () => {
    expect(table.isSubtype(List(Note), List(Entry))).toBe(true);
    expect(table.isSubtype(List(Entry), List(Note))).toBe(false);
    expect(table.isSubtype(List(List(Note)), List(List(File)))).toBe(true);
    expect(table.isSubtype(List(num), List(str))).toBe(false);
  });

  test("Dictionary: K invariant, V covariant", () => {
    expect(table.isSubtype(Dict(str, Note), Dict(str, Entry))).toBe(true);
    expect(table.isSubtype(Dict(t("vertex.Path"), Note), Dict(str, Note))).toBe(false);
    expect(table.isSubtype(Dict(str, Note), Dict(t("vertex.Path"), Note))).toBe(false);
  });

  test("rigid variables: only T <: T and T <: any", () => {
    expect(table.isSubtype(rigidT, rigidT)).toBe(true);
    expect(table.isSubtype(rigidT, t("any"))).toBe(true);
    expect(table.isSubtype(rigidT, str)).toBe(false);
    expect(table.isSubtype(str, rigidT)).toBe(false);
  });
});

describe("join", () => {
  test("nearest common ancestor other than any", () => {
    expect(table.join(Note, Folder)).toEqual(Entry);
    expect(table.join(Note, File)).toEqual(File);
    expect(table.join(File, num)).toBeUndefined();
    expect(table.join(str, num)).toBeUndefined();
  });

  test("an explicit any absorbs", () => {
    expect(table.join(File, t("any"))).toEqual(t("any"));
  });

  test("joins out arguments, requires equal inv arguments", () => {
    expect(table.join(List(Note), List(Folder))).toEqual(List(Entry));
    expect(table.join(Dict(str, Note), Dict(str, Folder))).toEqual(Dict(str, Entry));
    expect(table.join(Dict(str, Note), Dict(t("vertex.Path"), Note))).toBeUndefined();
    expect(table.join(List(File), Dict(str, File))).toBeUndefined();
  });
});

test("isKey is inherited through extends", () => {
  expect(table.isKey(str)).toBe(true);
  expect(table.isKey(t("vertex.Path"))).toBe(true);
  expect(table.isKey(File)).toBe(false);
  expect(table.isKey(t("any"))).toBe(false);
  expect(table.isKey(List(str))).toBe(false);
});

test("check rejects unknown types and wrong arity", () => {
  expect(table.check(List(List(Note)))).toBeUndefined();
  expect(table.check(t("vertex.Nope"))).toMatch(/Unknown type 'vertex.Nope'/);
  expect(table.check(t("List"))).toMatch(/takes 1/);
  expect(table.check(List(t("string", num)))).toMatch(/'string' takes 0/);
});

describe("definition errors", () => {
  test.each([
    ["duplicate id", [{ id: "string" }], /Duplicate type 'string'/],
    [
      "cycle",
      [
        { id: "a", extends: t("b") },
        { id: "b", extends: t("a") },
      ],
      /Cyclic extends/,
    ],
    ["unknown parent", [{ id: "a", extends: t("nope") }], /unknown type 'nope'/],
    [
      "params with extends",
      [{ id: "Box", params: [{ name: "T", variance: "out" as const }], extends: t("string") }],
      /has params/,
    ],
    ["extends a parameterized type", [{ id: "a", extends: t("List", str) }], /without params/],
  ])("%s", (_, defs, message) => {
    expect(() => new TypeTable(defs)).toThrow(message);
  });
});
