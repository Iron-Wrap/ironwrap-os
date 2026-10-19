// Strict JSON Schema subset for action arguments, the same dialect the agent-host gateway uses
// for model output: every object declares `additionalProperties: false` and lists every property
// as required (optional values carry a `null` type member). An unknown field is a violation.
//
// `validate` also reads one bounded map form that only action arguments use (a settings edit's
// values by key): an object whose `additionalProperties` is the schema of every value, its keys
// checked against `propertyNames` and counted against `minProperties` and `maxProperties`. It is
// not part of the output dialect, so `assertStrictSchema` still refuses it.

export type JsonSchema = { [key: string]: unknown };

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "description",
  "title",
]);

export function assertStrictSchema(schema: unknown, path = "$"): asserts schema is JsonSchema {
  if (!isPlainObject(schema)) throw new TypeError(`${path}: schema must be an object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new TypeError(`${path}: unsupported keyword ${key}`);
  }
  const types = typeList(schema.type);
  if (types.length === 0 && schema.enum === undefined && schema.const === undefined) {
    throw new TypeError(`${path}: type, enum or const is required`);
  }
  for (const type of types) {
    if (!TYPES.has(type)) throw new TypeError(`${path}: unsupported type ${type}`);
  }
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) {
      throw new TypeError(`${path}: objects must set additionalProperties to false`);
    }
    const properties = schema.properties;
    if (!isPlainObject(properties)) throw new TypeError(`${path}: objects must declare properties`);
    const required = schema.required;
    const names = Object.keys(properties);
    if (
      !Array.isArray(required) ||
      required.length !== names.length ||
      !names.every((name) => required.includes(name))
    ) {
      throw new TypeError(`${path}: every property must be listed in required`);
    }
    for (const name of names) assertStrictSchema(properties[name], `${path}.${name}`);
  }
  if (types.includes("array")) {
    if (schema.items === undefined) throw new TypeError(`${path}: arrays must declare items`);
    assertStrictSchema(schema.items, `${path}[]`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new TypeError(`${path}: pattern must be a string`);
    new RegExp(schema.pattern, "u");
  }
}

/** Returns the first violations found; an empty list means the value conforms. */
export function validate(schema: JsonSchema, value: unknown, path = "$", errors: string[] = []): string[] {
  if (errors.length >= 20) return errors;
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: must equal the constant`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path}: not an allowed value`);
    return errors;
  }
  const types = typeList(schema.type);
  if (types.length > 0 && !types.some((type) => hasType(value, type))) {
    errors.push(`${path}: expected ${types.join(" or ")}`);
    return errors;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${path}: too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match pattern`);
    }
  } else if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above maximum`);
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => canonicalJson(item)));
      if (seen.size !== value.length) errors.push(`${path}: items must be unique`);
    }
    value.forEach((item, index) => validate(schema.items as JsonSchema, item, `${path}[${index}]`, errors));
  } else if (isPlainObject(value)) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const values = isPlainObject(schema.additionalProperties) ? (schema.additionalProperties as JsonSchema) : null;
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) errors.push(`${path}: too few fields`);
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) errors.push(`${path}: too many fields`);
    for (const key of keys) {
      if (isPlainObject(schema.propertyNames)) validate(schema.propertyNames as JsonSchema, key, `${path}[${JSON.stringify(key)}]`, errors);
      if (Object.hasOwn(properties, key)) continue;
      if (values) validate(values, value[key], `${path}.${key}`, errors);
      else errors.push(`${path}: unknown field ${key}`);
    }
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing field ${key}`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`, errors);
    }
  }
  return errors;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}


function typeList(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.every((item) => typeof item === "string")) return type;
  return [];
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
