import assert from "node:assert/strict";
import test from "node:test";
import { assertStrictSchema, canonicalJson, validate } from "../src/gateway/schema.ts";
import { OUTPUT_SCHEMA } from "./helpers.ts";

test("strict schemas are accepted and loose ones are refused before any provider call", () => {
  assert.doesNotThrow(() => assertStrictSchema(OUTPUT_SCHEMA));
  const loose = [
    [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, /additionalProperties/],
    [{ type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: [] }, /required/],
    [{ type: "array" }, /items/],
    [{ type: "string", format: "email" }, /unsupported keyword format/],
    [{ type: "object", additionalProperties: false, properties: { a: { oneOf: [] } }, required: ["a"] }, /oneOf/],
    [{ description: "no type" }, /type, enum or const/],
  ] as const;
  for (const [schema, message] of loose) assert.throws(() => assertStrictSchema(schema), message);
});

test("unknown fields, missing fields and wrong types are violations", () => {
  assert.deepEqual(validate(OUTPUT_SCHEMA, { decision: "propose", note: null }), []);
  assert.deepEqual(validate(OUTPUT_SCHEMA, { decision: "propose", note: "ok", extra: 1 }), ["$: unknown field extra"]);
  assert.deepEqual(validate(OUTPUT_SCHEMA, { decision: "propose" }), ["$: missing field note"]);
  assert.deepEqual(validate(OUTPUT_SCHEMA, { decision: "send", note: null }), ["$.decision: not an allowed value"]);
  assert.deepEqual(validate(OUTPUT_SCHEMA, { decision: "propose", note: 7 }), ["$.note: expected string or null"]);
  assert.deepEqual(validate(OUTPUT_SCHEMA, []), ["$: expected object"]);
});

test("string, number and array bounds are enforced exactly", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "count", "ids"],
    properties: {
      text: { type: "string", minLength: 2, maxLength: 3, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 0, maximum: 2 },
      ids: { type: "array", items: { type: "string" }, maxItems: 2, uniqueItems: true },
    },
  };
  assertStrictSchema(schema);
  assert.deepEqual(validate(schema, { text: "ab", count: 2, ids: ["a"] }), []);
  assert.deepEqual(validate(schema, { text: "abcd", count: 1.5, ids: ["a", "a", "b"] }), [
    "$.text: too long",
    "$.count: expected integer",
    "$.ids: too many items",
    "$.ids: items must be unique",
  ]);
  assert.deepEqual(validate(schema, { text: "A1", count: -1, ids: [] }), ["$.text: does not match pattern", "$.count: below minimum"]);
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("field names inherited from Object.prototype are unknown fields too", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const value = JSON.parse(`{"decision":"propose","note":null,"${key}":{"x":1}}`);
    assert.deepEqual(validate(OUTPUT_SCHEMA, value), [`$: unknown field ${key}`], key);
  }
  assert.deepEqual(validate(OUTPUT_SCHEMA, JSON.parse('{"decision":"propose","__proto__":null}')), [
    "$: unknown field __proto__",
    "$: missing field note",
  ]);
});
