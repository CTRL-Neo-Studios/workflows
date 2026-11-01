import { describe, expect, test } from "vitest";
import { validateValue } from "./schema";
import { t, tvar, TypeTable, type TypeDef, type TypeTerm } from "./types";

const table = new TypeTable([
  { id: "vertex.File" },
  { id: "vertex.Path", extends: t("string"), schema: { type: "string", pattern: "^/" } },
  {
    id: "Pair",
    params: [
      { name: "A", variance: "out" },
      { name: "B", variance: "out" },
    ],
    schema: {
      type: "object",
      properties: { first: { $param: "A" }, second: { $param: "B" } },
      required: ["first", "second"],
      additionalProperties: false,
    },
  },
  { id: "Tagged", params: [{ name: "T", variance: "out" }], schema: { type: "string" } },
]);

const str = t("string");
const num = t("number");
const File = t("vertex.File");

/** Literal check as `validate` will run it: resolve the schema, then validate. */
function literal(type: TypeTerm, value: unknown): string | undefined {
  const schema = table.schemaFor(type);
  if (!schema) throw new Error("opaque");
  return validateValue(schema, value);
}

describe("schemaFor", () => {
  test("fills in nested type arguments", () => {
    expect(table.schemaFor(t("List", t("List", num)))).toEqual({
      type: "array",
      items: { type: "array", items: { type: "number" } },
    });
    expect(table.schemaFor(t("Dictionary", str, num))).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  test("opaque: no schema, opaque argument, non-string Dictionary key, unresolved variable", () => {
    expect(table.schemaFor(t("any"))).toBeUndefined();
    expect(table.schemaFor(File)).toBeUndefined();
    expect(table.schemaFor(t("List", File))).toBeUndefined();
    expect(table.schemaFor(t("Pair", str, File))).toBeUndefined();
    expect(table.schemaFor(t("Dictionary", num, num))).toBeUndefined();
    expect(table.schemaFor(t("Dictionary", t("vertex.Path"), num))).toBeUndefined();
    expect(table.schemaFor(tvar("T"))).toBeUndefined();
  });

  test("an argument the schema doesn't reference may be opaque", () => {
    expect(table.schemaFor(t("Tagged", File))).toEqual({ type: "string" });
  });
});

describe("validateValue", () => {
  test.each([
    [num, 3, undefined],
    [num, "3", "$: expected number"],
    [t("boolean"), 0, "$: expected boolean"],
    [t("List", num), [1, "x"], "$[1]: expected number"],
    [t("Dictionary", str, t("List", str)), { a: ["x"], b: [1] }, "$.b[0]: expected string"],
    [t("Dictionary", str, num), [], "$: expected object"],
    [t("vertex.Path"), "/notes", undefined],
    [t("vertex.Path"), "notes", "$: does not match ^/"],
    [t("Pair", str, num), { first: "a", second: 1 }, undefined],
    [t("Pair", str, num), { first: "a" }, '$: missing "second"'],
    [t("Pair", str, num), { first: "a", second: 1, third: 0 }, "$.third: not allowed"],
    [t("Pair", str, num), { first: 1, second: 1 }, "$.first: expected string"],
  ])("%j accepts %j → %s", (type, value, error) => {
    expect(literal(type, value)).toBe(error);
  });

  test("keywords on hand-written schemas", () => {
    expect(validateValue({ type: "integer" }, 1.5)).toBe("$: expected integer");
    expect(validateValue({ type: "integer" }, 2)).toBeUndefined();
    expect(validateValue({ enum: ["a", { b: 1 }] }, { b: 1 })).toBeUndefined();
    expect(validateValue({ enum: ["a"] }, "b")).toBe('$: expected one of "a"');
    expect(validateValue({ const: [1, 2] }, [1, 2])).toBeUndefined();
    expect(validateValue({ const: { a: 1 } }, { a: 1, b: 2 })).toBe('$: expected {"a":1}');
    expect(validateValue({ minimum: 0, maximum: 10 }, -1)).toBe("$: less than 0");
    expect(validateValue({ minimum: 0, maximum: 10 }, 11)).toBe("$: greater than 10");
    // Lengths count code points: "😀😀" is 2, not 4 UTF-16 units.
    expect(validateValue({ maxLength: 2 }, "😀😀")).toBeUndefined();
    expect(validateValue({ minLength: 3 }, "😀😀")).toBe("$: shorter than 3");
    expect(validateValue({ required: ["constructor"] }, {})).toBe('$: missing "constructor"');
  });
});

describe("template errors at definition time", () => {
  test.each<[string, TypeDef, RegExp]>([
    [
      "unsupported keyword",
      { id: "a", schema: { oneOf: [] } },
      /'a' schema.oneOf is not supported/,
    ],
    ["unknown $param", { id: "a", schema: { items: { $param: "T" } } }, /unknown \$param "T"/],
    [
      "$param with siblings",
      {
        id: "a",
        params: [{ name: "T", variance: "out" }],
        schema: { $param: "T", type: "string" },
      },
      /only key/,
    ],
    ["bad pattern", { id: "a", schema: { pattern: "(" } }, /valid regular expression/],
    [
      "nested bad keyword",
      { id: "a", schema: { properties: { x: { minLength: -1 } } } },
      /schema.properties.x.minLength/,
    ],
    ["bad type", { id: "a", schema: { type: "null" } }, /schema.type must be one of/],
  ])("%s", (_, def, message) => {
    expect(() => new TypeTable([def])).toThrow(message);
  });
});
