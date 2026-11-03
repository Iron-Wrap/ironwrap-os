import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import {
  canonicalV2,
  decodeV2,
  encodeV2,
  parseCanonicalV2,
  requestFingerprintV2,
  sha256V2,
  subjectDigestV2,
  validateExchange,
  validateControlHead,
  validateReceipt,
} from "../shared/auth-protocol-v2.mjs";
import {
  protocolTokenHashFor,
  protocolContextHashFor,
  sessionHashFor,
} from "../workers-bus/src/app-auth.ts";
const vectors = JSON.parse(
  await readFile(
    new URL("../shared/auth-protocol-v2.vectors.json", import.meta.url),
    "utf8",
  ),
);
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("v2 producer/client-contract/writer codec pins exact Unicode/key/integer/array/null bytes", async () => {
  for (const vector of vectors.valid) {
    assert.equal(canonicalV2(vector.value), vector.canonical);
    assert.equal(encodeV2(vector.value), vector.header);
    assert.deepEqual(decodeV2(vector.header), vector.value);
    assert.equal(await sha256V2(vector.canonical), vector.sha256);
    assert.equal(
      Buffer.from(vector.canonical).toString("base64url"),
      vector.header,
    );
  }
});
test("noncanonical/duplicate/escaped-duplicate/counter/Unicode values fail closed", () => {
  for (const input of vectors.rejectCanonicalInputs) {
    assert.throws(() => parseCanonicalV2(input));
    assert.throws(() => decodeV2(Buffer.from(input).toString("base64url")));
  }
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -1,
    -0,
    1.1,
    new Date(),
    [undefined],
    Array(1),
    { x: undefined },
  ])
    assert.throws(() => canonicalV2(value));
  assert.throws(() => decodeV2("e30="));
  assert.throws(() => decodeV2("A".repeat(4097)));
  assert.throws(() => decodeV2(Buffer.from("\ufeff{}").toString("base64url")));
});
test("strict exchange and receipt shapes cannot echo an invented authenticated result", () => {
  const exchange = {
    v: 2,
    exchangeId: "exchange-v2-1",
    issuer: "issuer-v2-1",
    kind: "read",
    baseGeneration: 0,
  };
  assert.deepEqual(validateExchange(exchange), exchange);
  assert.throws(() => validateExchange({ ...exchange, extra: true }));
  assert.throws(() => validateExchange({ ...exchange, issuer: null }));
  assert.throws(() => validateReceipt({ v: 2, kind: "authenticated" }));
  assert.throws(() =>
    validateControlHead({ format: "ironwrap-auth-control-v2" }),
  );
});
test("actual serialized target fingerprint and subject tuple have independent byte/digest oracles", async () => {
  const request = new Request(
    "https://app.example.invalid/api/v1/jobs/JOB%2FSYNTHETIC?x=2&x=1",
  );
  assert.equal(
    await requestFingerprintV2(request, "exchange-v2-1"),
    sha("GET\0/api/v1/jobs/JOB%2FSYNTHETIC?x=2&x=1\0exchange-v2-1"),
  );
  const dto = {
    tenant: { id: "synthetic" },
    user: {
      id: "appu_synthetic",
      role: "field",
      frappe_user_id: "crew@example.invalid",
    },
    session_expires_at: "synthetic-expiry",
    source_updated_at: null,
    permissions: ["z", "a"],
    allowed_actions: ["b", "a"],
    csrf_token: "c".repeat(43),
  };
  const tuple = [
    "synthetic",
    "appu_synthetic",
    "field",
    "crew@example.invalid",
    "synthetic-expiry",
    null,
    ["a", "z"],
    ["a", "b"],
    sha("c".repeat(43)),
    "b".repeat(64),
  ];
  assert.equal(
    await subjectDigestV2(dto, "b".repeat(64)),
    sha(JSON.stringify(tuple)),
  );
  for (const invalid of [
    { ...dto, permissions: "az" },
    { ...dto, permissions: ["a", "a"] },
    { ...dto, user: { ...dto.user, frappe_user_id: undefined } },
    { ...dto, source_updated_at: undefined },
  ])
    await assert.rejects(subjectDigestV2(invalid, "b".repeat(64)));
  await assert.rejects(subjectDigestV2(dto, null));
});
test("new issuer domains never alias old sessions or either old grant digest", async () => {
  const env = {
    APP_AUTH_PEPPER: "synthetic-pepper-with-more-than-thirty-two-characters",
  };
  const raw = "t".repeat(43);
  const hmac = (value) =>
    createHmac("sha256", env.APP_AUTH_PEPPER).update(value).digest("hex");
  assert.equal(await sessionHashFor(env, raw), hmac(`session:${raw}`));
  assert.equal(
    await sessionHashFor(env, raw, "issuer-v2-1"),
    hmac(`session:v2:issuer-v2-1:${raw}`),
  );
  assert.equal(
    await protocolTokenHashFor(env, "issuer-v2-1", "pair", raw),
    hmac(`grant:v2:issuer-v2-1:pair:${raw}`),
  );
  assert.equal(
    await protocolContextHashFor(env, "synthetic", raw),
    hmac(`auth-context:v2:synthetic:${raw}`),
  );
  assert.notEqual(
    await sessionHashFor(env, raw),
    await sessionHashFor(env, raw, "issuer-v2-1"),
  );
  assert.notEqual(
    await protocolTokenHashFor(env, "issuer-v2-1", "magic", raw),
    sha(raw),
  );
  assert.notEqual(
    await protocolTokenHashFor(env, "issuer-v2-1", "magic", raw),
    await protocolTokenHashFor(env, "issuer-v2-1", "pair", raw),
  );
});
