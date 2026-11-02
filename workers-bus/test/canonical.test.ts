import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/canonical.ts";

// Stored envelope, ledger and effect hashes depend on these exact bytes. Keys sort by
// UTF-16 code unit (unlike tools/canonical-json.mjs, which uses localeCompare).
const VECTORS: Array<[name: string, value: unknown, canonical: string, sha256: string]> = [
  [
    "scalars",
    [null, true, false, 0, -0, 1.5, 1e21, "", "line\nbreak \"quoted\" \u00e9 \u2028 \ud83d\ude00"],
    "[null,true,false,0,0,1.5,1e+21,\"\",\"line\\nbreak \\\"quoted\\\" \u00e9 \u2028 \ud83d\ude00\"]",
    "856140e0bc096ff21dd2071b9b30fa72c06b73992a1ee5baf60d8d443641c841",
  ],
  [
    "key order",
    { b: 1, a: 2, B: 3, A: 4, _x: 5, "a-b": 6, a_b: 7, aB: 8, "10": 9, "9": 10, "\u00e9": 11, z: 12 },
    "{\"10\":9,\"9\":10,\"A\":4,\"B\":3,\"_x\":5,\"a\":2,\"a-b\":6,\"aB\":8,\"a_b\":7,\"b\":1,\"z\":12,\"\u00e9\":11}",
    "aa455d6b33b3a9c154879cf821446d4e714d30171fd19a7aded1d110fb53e1c0",
  ],
  [
    "nested",
    { kind: "newo_event", payload: { b: [1, { d: null, c: "x" }], a: true } },
    "{\"kind\":\"newo_event\",\"payload\":{\"a\":true,\"b\":[1,{\"c\":\"x\",\"d\":null}]}}",
    "27b091d33522dd68c83da139b53c992da9bf155eceebe2e05c29eefde8835960",
  ],
  [
    "empty containers",
    { a: {}, b: [], c: [[], {}] },
    "{\"a\":{},\"b\":[],\"c\":[[],{}]}",
    "925c673adf18ca220ee7da7f5e344def6f8c60be721b2ef68c93a67ee7d9c883",
  ],
];

for (const [name, value, canonical, sha256] of VECTORS) {
  test(`canonical JSON keeps its pinned bytes and hash: ${name}`, async () => {
    assert.equal(canonicalJson(value), canonical);
    assert.equal(await sha256Hex(canonicalJson(value)), sha256);
  });
}

test("canonical JSON refuses values JSON cannot encode", () => {
  assert.throws(() => canonicalJson(undefined), /canonical_json_unsupported_value/);
  assert.throws(() => canonicalJson({ missing: undefined }), /canonical_json_unsupported_value/);
  assert.throws(() => canonicalJson([() => 1]), /canonical_json_unsupported_value/);
});
