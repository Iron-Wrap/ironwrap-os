import assert from "node:assert/strict";
import { test } from "node:test";

import { validateIndependentIssuerRequest as enforcerValidate } from "../../tools/release-promotion.mjs";
import {
  IssuerError,
  canonicalJson,
  issuerRunIdFor,
  secretEquals,
  sha256Hex,
  validateIndependentIssuerRequest,
} from "../src/contract.mjs";

/**
 * The issuer validates the trigger itself rather than trusting the caller, which means two
 * independent implementations of one contract. This file is what stops them drifting: every case
 * runs through BOTH the enforcer's exported validator and the issuer's mirror, and the two must
 * agree on the verdict and on the refusal code. A change to either side that is not made to the
 * other fails here, long before it fails a release at 3am.
 */

const COMMIT = "a".repeat(40);
const BASE = "e".repeat(40);
const HEAD = "f".repeat(40);
const GIT_TREE = "1".repeat(40);
const TREE = "b".repeat(64);
const ARTIFACT = "c".repeat(64);
const KEY_DIGEST = "d".repeat(64);
const NOW = Date.parse("2026-08-23T00:00:00.000Z");
const REQUESTED_AT = "2026-08-22T23:59:00.000Z";
const EXPIRES_AT = "2026-08-23T00:04:00.000Z";
const now = () => NOW;

function requestFixture(overrides = {}) {
  return {
    schema: "ironwrap_independent_issuer_request_v2",
    phase: "review",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 266,
    base_commit: BASE,
    head_commit: HEAD,
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    source_tree_sha256: TREE,
    diff_sha256: "9".repeat(64),
    ci_run_id: "31970000001",
    candidate_artifact: {
      actions_run_id: "31970000002",
      actions_run_attempt: "1",
      name: "iro41-review-candidate",
      content_digest: ARTIFACT,
    },
    publication: {
      ref: `release-review/${COMMIT}`,
      path: `.release/reviews/${COMMIT}.json`,
    },
    receipt_key: {
      public_key_sha256: KEY_DIGEST,
      key_version: "review-key-2026-08",
    },
    requested_at: REQUESTED_AT,
    expires_at: EXPIRES_AT,
    requested_by: "release-admission@ironwrapexteriors.com",
    expected_issuer: {
      principal: "independent-reviewer@ironwrapexteriors.com",
      task_id: "independent-source-review",
    },
    ...overrides,
  };
}

function drop(object, key) {
  const copy = structuredClone(object);
  delete copy[key];
  return copy;
}

function verdict(validate, request, code) {
  try {
    validate(request, now);
    return { accepted: true };
  } catch (error) {
    const message = String(error?.message ?? "");
    return {
      accepted: false,
      code: message.replace(/^release_promotion_/, ""),
    };
  }
  // eslint-disable-next-line no-unreachable -- `code` documents the caller's expectation only
  return code;
}

/** Each case: a mutation of the valid fixture that both validators must refuse identically. */
const CASES = [
  ["valid fixture", requestFixture()],
  ["unknown key", { ...requestFixture(), extra: 1 }],
  ["missing key", drop(requestFixture(), "diff_sha256")],
  [
    "wrong schema",
    requestFixture({ schema: "ironwrap_independent_issuer_request_v1" }),
  ],
  ["unknown phase", requestFixture({ phase: "audit" })],
  ["bad repository", requestFixture({ repository: "ironwrap-os" })],
  ["zero pr number", requestFixture({ pr_number: 0 })],
  ["float pr number", requestFixture({ pr_number: 1.5 })],
  ["short commit", requestFixture({ source_commit: "abc" })],
  ["uppercase commit", requestFixture({ base_commit: "A".repeat(40) })],
  [
    "publication ref drift",
    requestFixture({
      publication: {
        ref: `release-review/${BASE}`,
        path: `.release/reviews/${COMMIT}.json`,
      },
    }),
  ],
  [
    "publication path drift",
    requestFixture({
      publication: {
        ref: `release-review/${COMMIT}`,
        path: `.release/reviews/${BASE}.json`,
      },
    }),
  ],
  [
    "evidence phase publication",
    requestFixture({
      phase: "release-evidence",
      publication: {
        ref: `release-evidence/${COMMIT}`,
        path: `.release/evidence/${COMMIT}.json`,
      },
      expected_issuer: {
        principal: "independent-reviewer@ironwrapexteriors.com",
        task_id: "independent-release-evidence",
      },
    }),
  ],
  [
    "evidence phase with review publication",
    requestFixture({ phase: "release-evidence" }),
  ],
  ["bad digest", requestFixture({ diff_sha256: "z".repeat(64) })],
  [
    "bad artifact digest",
    requestFixture({
      candidate_artifact: {
        ...requestFixture().candidate_artifact,
        content_digest: "short",
      },
    }),
  ],
  ["zero run id", requestFixture({ ci_run_id: "0" })],
  ["non numeric run id", requestFixture({ ci_run_id: "run-1" })],
  [
    "bad artifact name",
    requestFixture({
      candidate_artifact: {
        ...requestFixture().candidate_artifact,
        name: "-leading-dash",
      },
    }),
  ],
  [
    "requester is the reviewer",
    requestFixture({
      requested_by: "independent-reviewer@ironwrapexteriors.com",
    }),
  ],
  [
    "requester not an identity",
    requestFixture({ requested_by: "release-admission" }),
  ],
  [
    "reviewer not an identity",
    requestFixture({
      expected_issuer: {
        principal: "reviewer",
        task_id: "independent-source-review",
      },
    }),
  ],
  [
    "short task id",
    requestFixture({
      expected_issuer: {
        principal: "independent-reviewer@ironwrapexteriors.com",
        task_id: "a",
      },
    }),
  ],
  [
    "short key version",
    requestFixture({
      receipt_key: { public_key_sha256: KEY_DIGEST, key_version: "a" },
    }),
  ],
  [
    "timestamp without milliseconds",
    requestFixture({ requested_at: "2026-08-22T23:59:00Z" }),
  ],
  [
    "expiry before request",
    requestFixture({ expires_at: "2026-08-22T23:58:00.000Z" }),
  ],
  [
    "window longer than ten minutes",
    requestFixture({ expires_at: "2026-08-23T00:11:00.000Z" }),
  ],
  [
    "requested far in the future",
    requestFixture({
      requested_at: "2026-08-23T00:02:00.000Z",
      expires_at: "2026-08-23T00:06:00.000Z",
    }),
  ],
  [
    "already expired",
    requestFixture({
      requested_at: "2026-08-22T23:50:00.000Z",
      expires_at: "2026-08-22T23:55:00.000Z",
    }),
  ],
  ["null body", null],
  ["array body", []],
];

/** Mutations drawn only from values the enforcer itself could ever produce: strings and absences. */
const STRING_VALUES = [
  "",
  " ",
  "0",
  "a".repeat(39),
  "a".repeat(41),
  "A".repeat(40),
  "a".repeat(64),
  "z".repeat(64),
  "2026-08-22T23:59:00Z",
  "2026-08-23T00:04:00.000Z",
  "2026-08-22T23:50:00.000Z",
  `release-review/${COMMIT}`,
  `.release/reviews/${COMMIT}.json`,
  `release-evidence/${COMMIT}`,
  "x@y.z",
  "x@y",
  "a".repeat(256),
  "Iron-Wrap/ironwrap-os",
  "review",
  "release-evidence",
  "audit",
  "review-key-2026-08",
  "independent-source-review",
  "release-admission@ironwrapexteriors.com",
  "independent-reviewer@ironwrapexteriors.com",
];

/** Values the enforcer would never send, which this validator is allowed to refuse more eagerly. */
const EXOTIC_VALUES = [
  null,
  0,
  1,
  1.5,
  NaN,
  true,
  false,
  [],
  {},
  ["a".repeat(40)],
  12345,
];

const FIELD_PATHS = [
  ["schema"],
  ["phase"],
  ["repository"],
  ["pr_number"],
  ["base_commit"],
  ["head_commit"],
  ["source_commit"],
  ["source_git_tree"],
  ["source_tree_sha256"],
  ["diff_sha256"],
  ["ci_run_id"],
  ["requested_at"],
  ["expires_at"],
  ["requested_by"],
  ["candidate_artifact", "actions_run_id"],
  ["candidate_artifact", "actions_run_attempt"],
  ["candidate_artifact", "name"],
  ["candidate_artifact", "content_digest"],
  ["publication", "ref"],
  ["publication", "path"],
  ["receipt_key", "public_key_sha256"],
  ["receipt_key", "key_version"],
  ["expected_issuer", "principal"],
  ["expected_issuer", "task_id"],
];

/** Deterministic, so a divergence found here is reproducible rather than a flake. */
function mutator(seed) {
  let state = seed;
  const next = () =>
    (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return {
    pick: (values) => values[Math.floor(next() * values.length)],
    chance: next,
  };
}

function mutate(random, values) {
  const request = requestFixture();
  const count = 1 + Math.floor(random.chance() * 3);
  for (let index = 0; index < count; index += 1) {
    const path = random.pick(FIELD_PATHS);
    let node = request;
    for (const key of path.slice(0, -1)) node = node[key];
    const action = random.chance();
    if (action < 0.08) delete node[path.at(-1)];
    else if (action < 0.14) node[`${path.at(-1)}_extra`] = 1;
    else node[path.at(-1)] = random.pick(values);
  }
  return request;
}

test("on input the enforcer could actually send, the two validators agree exactly", () => {
  const random = mutator(20260915);
  let checked = 0;
  let accepted = 0;
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const request = mutate(random, STRING_VALUES);
    const mine = verdict(validateIndependentIssuerRequest, request);
    const theirs = verdict(enforcerValidate, request);
    checked += 1;
    if (theirs.accepted) accepted += 1;
    assert.deepEqual(
      mine,
      theirs,
      `iteration ${iteration}: ${JSON.stringify(request).slice(0, 300)}`,
    );
  }
  assert.ok(
    checked === 4000 && accepted > 0,
    `checked ${checked}, ${accepted} still valid`,
  );
});

test("the issuer never acknowledges anything the enforcer would reject", () => {
  const random = mutator(9152026);
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const request = mutate(random, [...STRING_VALUES, ...EXOTIC_VALUES]);
    const mine = verdict(validateIndependentIssuerRequest, request);
    const theirs = verdict(enforcerValidate, request);
    if (mine.accepted) {
      assert.equal(
        theirs.accepted,
        true,
        `iteration ${iteration} accepted here but not there: ${JSON.stringify(request).slice(0, 300)}`,
      );
    }
  }
});

test("the issuer's validator agrees with the release enforcer on every case", () => {
  for (const [name, request] of CASES) {
    const mine = verdict(validateIndependentIssuerRequest, request);
    const theirs = verdict(enforcerValidate, request);
    assert.deepEqual(
      mine,
      theirs,
      `${name}: issuer ${JSON.stringify(mine)} vs enforcer ${JSON.stringify(theirs)}`,
    );
  }
});

test("the valid fixture is accepted and both phases of it are addressable", () => {
  assert.equal(
    verdict(validateIndependentIssuerRequest, requestFixture()).accepted,
    true,
  );
  assert.equal(verdict(enforcerValidate, requestFixture()).accepted, true);
});

test("a refusal carries a code and an HTTP status", () => {
  try {
    validateIndependentIssuerRequest(requestFixture({ phase: "audit" }), now);
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof IssuerError);
    assert.equal(error.code, "issuer_request_invalid");
    assert.equal(error.status, 400);
  }
});

test("an expired request is a conflict, not a malformed one", () => {
  try {
    validateIndependentIssuerRequest(
      requestFixture({
        requested_at: "2026-08-22T23:50:00.000Z",
        expires_at: "2026-08-22T23:55:00.000Z",
      }),
      now,
    );
    assert.fail("expected a refusal");
  } catch (error) {
    assert.equal(error.code, "issuer_request_expired");
    assert.equal(error.status, 409);
  }
});

test("the canonical digest matches what the enforcer computes over its own body", async () => {
  const request = requestFixture();
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.equal(canonicalJson(request), canonicalJson(reordered));
  const digest = await sha256Hex(canonicalJson(request));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(issuerRunIdFor(digest), `issuer-run-${digest.slice(0, 32)}`);
  assert.match(issuerRunIdFor(digest), /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/);
});

test("secret comparison rejects near misses and accepts the exact token", () => {
  assert.equal(secretEquals("trigger-token", "trigger-token"), true);
  assert.equal(secretEquals("trigger-token", "trigger-toke"), false);
  assert.equal(secretEquals("trigger-token", "trigger-tokeN"), false);
  assert.equal(secretEquals("", ""), true);
  assert.equal(secretEquals(undefined, "x"), false);
});
