// `string` before `boolean`: Vue derives prop types from this order, and a Boolean ahead of String turns an
// empty-string prop into `true`.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A JSON Schema subset (§3.2): type, enum, const, items, properties, required, additionalProperties,
 * minimum, maximum, minLength, maxLength, pattern. `{ $param: 'T' }` stands for the schema of the type bound to T.
 */
export type SchemaTemplate = Record<string, unknown>;

const TYPES = ["string", "number", "integer", "boolean", "array", "object"];

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Definition-time check: only the supported subset, and `$param` names from `params`. Returns an error message. */
export function checkTemplate(
  schema: unknown,
  params: readonly string[],
  at = "schema",
): string | undefined {
  if (!isObject(schema)) return `${at} must be an object`;
  if ("$param" in schema) {
    if (Object.keys(schema).length !== 1) return `${at}: $param must be the only key`;
    const name = schema.$param;
    return typeof name === "string" && params.includes(name)
      ? undefined
      : `${at}: unknown $param ${JSON.stringify(name)}`;
  }
  for (const [key, value] of Object.entries(schema)) {
    const here = `${at}.${key}`;
    let error: string | undefined;
    switch (key) {
      case "type":
        if (typeof value !== "string" || !TYPES.includes(value))
          error = `${here} must be one of ${TYPES.join(", ")}`;
        break;
      case "enum":
        if (!Array.isArray(value)) error = `${here} must be an array`;
        break;
      case "const":
        break;
      case "items":
        error = checkTemplate(value, params, here);
        break;
      case "additionalProperties":
        if (typeof value !== "boolean") error = checkTemplate(value, params, here);
        break;
      case "properties":
        if (!isObject(value)) error = `${here} must be an object`;
        else {
          for (const [name, sub] of Object.entries(value)) {
            error ??= checkTemplate(sub, params, `${here}.${name}`);
          }
        }
        break;
      case "required":
        if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
          error = `${here} must be an array of strings`;
        }
        break;
      case "minimum":
      case "maximum":
        if (typeof value !== "number") error = `${here} must be a number`;
        break;
      case "minLength":
      case "maxLength":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          error = `${here} must be a non-negative integer`;
        }
        break;
      case "pattern":
        try {
          if (typeof value !== "string") throw new TypeError();
          RegExp(value, "u"); // throws on invalid syntax
        } catch {
          error = `${here} must be a valid regular expression`;
        }
        break;
      default:
        error = `${here} is not supported`;
    }
    if (error) return error;
  }
  return undefined;
}

/** Replaces every `$param` with `resolve(name)`. `undefined` if any referenced param is opaque. */
export function instantiate(
  schema: SchemaTemplate,
  resolve: (param: string) => SchemaTemplate | undefined,
): SchemaTemplate | undefined {
  if (typeof schema.$param === "string") return resolve(schema.$param);
  const out: SchemaTemplate = { ...schema };
  for (const key of ["items", "additionalProperties"]) {
    const sub = schema[key];
    if (!isObject(sub)) continue;
    const resolved = instantiate(sub, resolve);
    if (!resolved) return undefined;
    out[key] = resolved;
  }
  if (isObject(schema.properties)) {
    const properties: SchemaTemplate = {};
    for (const [name, sub] of Object.entries(schema.properties)) {
      const resolved = isObject(sub) ? instantiate(sub, resolve) : undefined;
      if (!resolved) return undefined;
      properties[name] = resolved;
    }
    out.properties = properties;
  }
  return out;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEquals(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && jsonEquals(a[k], b[k]))
  );
}

function hasType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return false;
  }
}

/** Validates a literal against an instantiated, `checkTemplate`-approved schema. Returns the first error. */
export function validateValue(
  schema: SchemaTemplate,
  value: unknown,
  at = "$",
): string | undefined {
  if (schema.type !== undefined && !hasType(schema.type, value))
    return `${at}: expected ${String(schema.type)}`;
  if ("const" in schema && !jsonEquals(schema.const, value)) {
    return `${at}: expected ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => jsonEquals(x, value))) {
    if (!schema.enum.length) return `${at}: no literal fits this type`;
    return `${at}: expected one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`;
  }

  if (typeof value === "string") {
    const length = [...value].length; // code points, as JSON Schema counts them
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      return `${at}: shorter than ${schema.minLength}`;
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      return `${at}: longer than ${schema.maxLength}`;
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      return `${at}: does not match ${schema.pattern}`;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return `${at}: less than ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return `${at}: greater than ${schema.maximum}`;
  }

  if (Array.isArray(value) && isObject(schema.items)) {
    for (const [i, item] of value.entries()) {
      const error = validateValue(schema.items, item, `${at}[${i}]`);
      if (error) return error;
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      const missing = schema.required.find(
        (k) => typeof k === "string" && !Object.hasOwn(value, k),
      );
      if (missing !== undefined) return `${at}: missing ${JSON.stringify(missing)}`;
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    const extra = schema.additionalProperties;
    for (const [key, item] of Object.entries(value)) {
      const here = `${at}.${key}`;
      const sub = Object.hasOwn(properties, key) ? properties[key] : extra;
      if (sub === false) return `${here}: not allowed`;
      if (!isObject(sub)) continue;
      const error = validateValue(sub, item, here);
      if (error) return error;
    }
  }
  return undefined;
}
