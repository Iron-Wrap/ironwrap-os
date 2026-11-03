import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalV2,
  parseCanonicalV2,
  encodeV2,
  decodeV2,
  sha256V2,
  safeCounter,
  validateControlHead,
  validateExchange,
} from "../shared/auth-protocol-v2.mjs";
import { canonicalJson } from "./canonical-json.mjs";

test("v2 committed wire vectors preserve exact canonical/header/hash bytes", async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL("../shared/auth-protocol-v2.vectors.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of vectors.valid) {
    assert.equal(canonicalV2(vector.value), vector.canonical);
    assert.equal(encodeV2(vector.value), vector.header);
    assert.equal(await sha256V2(vector.canonical), vector.sha256);
    assert.deepEqual(decodeV2(vector.header), vector.value);
  }
  for (const raw of vectors.rejectCanonicalInputs)
    assert.throws(() => parseCanonicalV2(raw));
});

test("v2 rejects unsupported structure, malformed Unicode, numeric aliases and alternate header encodings", () => {
  for (const value of [
    -0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => safeCounter(value));
  for (const value of [
    undefined,
    { value: undefined },
    { value: 1n },
    new Date(0),
    [1, , 2],
    { [Symbol("hidden")]: 1 },
    "\ud800",
  ])
    assert.throws(() => canonicalV2(value));
  const encoded = encodeV2({ a: 1 });
  for (const value of [
    encoded + "=",
    " " + encoded,
    "/",
    Buffer.from('{"a":1,"a":1}').toString("base64url"),
    "_w",
  ])
    assert.throws(() => decodeV2(value));
  assert.throws(() => decodeV2(encodeV2({ large: "x".repeat(5000) })));
  // Release tools intentionally retain localeCompare; only the new v2 domain uses
  // the shared code-unit form. This test must not normalize the historical domain.
  const value = { Z: 1, a: 2, Ä: 3 };
  assert.notEqual(canonicalJson(value), canonicalV2(value));
  assert.equal(canonicalV2(value), '{"Z":1,"a":2,"Ä":3}');
});

test("control and exchange wire shapes reject extra fields, duplicate versions and crossed identities", () => {
  const head = {
    format: "ironwrap-auth-control-v2",
    controlRevision: 1,
    minProducerProtocol: 1,
    mode: "staged",
    activationId: "activation-v2:1:synthetic",
    issuer: "issuer-v2:1:synthetic",
    databaseIdentity: "synthetic-database",
    allowedProducerBindings: [
      {
        versionId: "synthetic-version",
        artifactHash: "a".repeat(64),
        componentManifestHash: "b".repeat(64),
        protocol: 2,
        databaseIdentity: "synthetic-database",
        issuer: "issuer-v2:1:synthetic",
      },
    ],
    qualificationReceiptHash: null,
  };
  assert.equal(validateControlHead(head), head);
  for (const change of [
    { extra: true },
    { controlRevision: 0 },
    { mode: "active" },
    { qualificationReceiptHash: "c".repeat(64) },
    { allowedProducerBindings: [] },
    {
      allowedProducerBindings: [
        ...head.allowedProducerBindings,
        ...head.allowedProducerBindings,
      ],
    },
    { issuer: "different-issuer" },
    { databaseIdentity: "different-database" },
  ])
    assert.throws(() => validateControlHead({ ...head, ...change }));
  const exchange = {
    v: 2,
    exchangeId: "synthetic-exchange",
    issuer: null,
    kind: "discovery",
    baseGeneration: 0,
  };
  assert.equal(validateExchange(exchange), exchange);
  assert.throws(() => validateExchange({ ...exchange, baseGeneration: 1 }));
  assert.throws(() => validateExchange({ ...exchange, extra: true }));
});
