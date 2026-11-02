import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "./canonical-json.mjs";

// Release permits and promotion records are signed over these exact bytes. The vectors
// were computed with the helper's previous home (the ERPNext MCP approval contract) and
// must never change: keys sort with localeCompare and undefined members drop.
const VECTORS = [
  [
    "scalars",
    [null, true, false, 0, -0, 1.5, 1e21, "", "line\nbreak \"quoted\" \u00e9 \u2028 \ud83d\ude00"],
    "[null,true,false,0,0,1.5,1e+21,\"\",\"line\\nbreak \\\"quoted\\\" \u00e9 \u2028 \ud83d\ude00\"]",
    "856140e0bc096ff21dd2071b9b30fa72c06b73992a1ee5baf60d8d443641c841",
  ],
  [
    "key order",
    { b: 1, a: 2, B: 3, A: 4, _x: 5, "a-b": 6, a_b: 7, aB: 8, "10": 9, "9": 10, "\u00e9": 11, z: 12 },
    "{\"9\":10,\"10\":9,\"_x\":5,\"a\":2,\"A\":4,\"a_b\":7,\"a-b\":6,\"aB\":8,\"b\":1,\"B\":3,\"\u00e9\":11,\"z\":12}",
    "bc4ddd4d0949d4f66bac993f1b33917cfaac617de978ca8507d624fdb4a49a97",
  ],
  [
    "undefined members",
    { keep: null, drop: undefined, list: [1, undefined, { inner: undefined, value: "v" }] },
    "{\"keep\":null,\"list\":[1,null,{\"value\":\"v\"}]}",
    "3c500a4ac926ffd6e4596978463634967567692857662d4c7a6d39f74543bb11",
  ],
  [
    "nested permit shape",
    {
      schema: "ironwrap_release_permit_v2",
      commit: "0123456789abcdef0123456789abcdef01234567",
      evidence: [{ kind: "ci", run_id: 41492544328, ok: true }, { kind: "deploy", digest: "sha256:ab" }],
      environment: { name: "production", vars: { APP_LOCALE: "en-CA", APP_CURRENCY: "CAD" } },
    },
    "{\"commit\":\"0123456789abcdef0123456789abcdef01234567\",\"environment\":{\"name\":\"production\",\"vars\":{\"APP_CURRENCY\":\"CAD\",\"APP_LOCALE\":\"en-CA\"}},\"evidence\":[{\"kind\":\"ci\",\"ok\":true,\"run_id\":41492544328},{\"digest\":\"sha256:ab\",\"kind\":\"deploy\"}],\"schema\":\"ironwrap_release_permit_v2\"}",
    "b1451daf33f15cdfe448cafec30c8cbc3ebe6f3f1725e542aee0d44ace2ae29a",
  ],
  [
    "empty containers",
    { a: {}, b: [], c: [[], {}] },
    "{\"a\":{},\"b\":[],\"c\":[[],{}]}",
    "925c673adf18ca220ee7da7f5e344def6f8c60be721b2ef68c93a67ee7d9c883",
  ],
];

for (const [name, value, canonical, sha256] of VECTORS) {
  test(`release canonical JSON keeps its pinned bytes and hash: ${name}`, () => {
    assert.equal(canonicalJson(value), canonical);
    assert.equal(createHash("sha256").update(canonicalJson(value)).digest("hex"), sha256);
  });
}
