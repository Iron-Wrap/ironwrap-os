import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canonicalJson, sha256Hex } from "../src/contract.mjs";
import { handle } from "../src/worker.mjs";

/**
 * The issuer against a real SQLite ledger, not a stub map: the append-only triggers and the primary
 * key are half the replay contract, so a fake that merely remembers values would prove nothing
 * about the behaviour D1 actually enforces.
 */

const COMMIT = "a".repeat(40);
const NOW = Date.parse("2026-08-23T00:00:00.000Z");
const TOKEN = "issuer-trigger-token-0123456789-abcdef";
const ENV = Object.freeze({
  ISSUER_TRIGGER_TOKEN: TOKEN,
  ISSUER_REPOSITORY: "Iron-Wrap/ironwrap-os",
  ISSUER_REQUESTER_IDENTITY: "release-admission@ironwrapexteriors.com",
  ISSUER_PRINCIPAL: "independent-reviewer@ironwrapexteriors.com",
  ISSUER_TASK_IDS: "independent-source-review,independent-release-evidence",
  ISSUER_KEY_VERSION: "review-key-2026-08",
});

/** The D1 surface this Worker uses, backed by the same SQL the migration installs. */
function ledger() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../migrations/0001_issuer_ledger.sql", import.meta.url),
      "utf8",
    ),
  );
  return {
    db,
    prepare(sql) {
      const statement = db.prepare(sql);
      let bound = [];
      const api = {
        bind(...values) {
          bound = values;
          return api;
        },
        async first() {
          return statement.get(...bound) ?? null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          return statement.run(...bound);
        },
      };
      return api;
    },
  };
}

function environment(overrides = {}) {
  return { ...ENV, LEDGER: ledger(), ...overrides };
}

function requestFixture(overrides = {}) {
  return {
    schema: "ironwrap_independent_issuer_request_v2",
    phase: "review",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 266,
    base_commit: "e".repeat(40),
    head_commit: "f".repeat(40),
    source_commit: COMMIT,
    source_git_tree: "1".repeat(40),
    source_tree_sha256: "b".repeat(64),
    diff_sha256: "9".repeat(64),
    ci_run_id: "31970000001",
    candidate_artifact: {
      actions_run_id: "31970000002",
      actions_run_attempt: "1",
      name: "iro41-review-candidate",
      content_digest: "c".repeat(64),
    },
    publication: {
      ref: `release-review/${COMMIT}`,
      path: `.release/reviews/${COMMIT}.json`,
    },
    receipt_key: {
      public_key_sha256: "d".repeat(64),
      key_version: "review-key-2026-08",
    },
    requested_at: "2026-08-22T23:59:00.000Z",
    expires_at: "2026-08-23T00:04:00.000Z",
    requested_by: "release-admission@ironwrapexteriors.com",
    expected_issuer: {
      principal: "independent-reviewer@ironwrapexteriors.com",
      task_id: "independent-source-review",
    },
    ...overrides,
  };
}

function trigger(
  body,
  { token = TOKEN, method = "POST", path = "/v2/independent-issuer" } = {},
) {
  const serialised = typeof body === "string" ? body : canonicalJson(body);
  return new Request(`https://issuer.example.invalid${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : serialised,
  });
}

async function call(env, body, options, now = NOW) {
  const response = await handle(trigger(body, options), env, () => now);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
    headers: response.headers,
  };
}

test("an exact trigger is acknowledged with the digest and run id the receipt must carry", async () => {
  const env = environment();
  const request = requestFixture();
  const { status, body, headers } = await call(env, request);
  assert.equal(status, 200);
  const expectedDigest = await sha256Hex(canonicalJson(request));
  assert.deepEqual(Object.keys(body.acknowledgement).sort(), [
    "accepted_at",
    "issuer_principal",
    "issuer_run_id",
    "issuer_task_id",
    "key_version",
    "phase",
    "repository",
    "request_digest",
    "schema",
    "source_commit",
    "status",
  ]);
  assert.equal(
    body.acknowledgement.schema,
    "ironwrap_independent_issuer_ack_v1",
  );
  assert.equal(body.acknowledgement.status, "accepted");
  assert.equal(body.acknowledgement.request_digest, expectedDigest);
  assert.equal(
    body.acknowledgement.issuer_principal,
    request.expected_issuer.principal,
  );
  assert.equal(
    body.acknowledgement.issuer_task_id,
    request.expected_issuer.task_id,
  );
  assert.equal(
    body.acknowledgement.key_version,
    request.receipt_key.key_version,
  );
  assert.equal(
    body.acknowledgement.issuer_run_id,
    `issuer-run-${expectedDigest.slice(0, 32)}`,
  );
  assert.equal(body.acknowledgement.accepted_at, new Date(NOW).toISOString());
  assert.equal(headers.get("cache-control"), "private, no-store");
});

test("a body whose keys arrive in another order still digests to the canonical form", async () => {
  const env = environment();
  const request = requestFixture();
  const reordered = JSON.stringify(
    Object.fromEntries(Object.entries(request).reverse()),
  );
  const { status, body } = await call(env, reordered);
  assert.equal(status, 200);
  assert.equal(
    body.acknowledgement.request_digest,
    await sha256Hex(canonicalJson(request)),
  );
});

test("an exact still-valid replay returns the ledgered acknowledgement and writes no second row", async () => {
  const env = environment();
  const first = await call(env, requestFixture());
  const second = await call(env, requestFixture(), undefined, NOW + 60_000);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.acknowledgement, first.body.acknowledgement);
  assert.equal(
    env.LEDGER.db
      .prepare("SELECT count(*) AS n FROM independent_issuer_acknowledgements")
      .get().n,
    1,
  );
});

test("a replay after the window has closed fails closed instead of re-acknowledging", async () => {
  const env = environment();
  await call(env, requestFixture());
  const expired = await call(
    env,
    requestFixture(),
    undefined,
    Date.parse("2026-08-23T00:05:00.000Z"),
  );
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error, "issuer_request_expired");
});

test("two concurrent triggers for one request converge on a single acknowledgement", async () => {
  const env = environment();
  const [left, right] = await Promise.all([
    call(env, requestFixture()),
    call(env, requestFixture()),
  ]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  assert.deepEqual(left.body.acknowledgement, right.body.acknowledgement);
  assert.equal(
    env.LEDGER.db
      .prepare("SELECT count(*) AS n FROM independent_issuer_acknowledgements")
      .get().n,
    1,
  );
});

test("the wrong token, the wrong route and the wrong method are all refused", async () => {
  const env = environment();
  assert.equal(
    (await call(env, requestFixture(), { token: "wrong-token" })).status,
    401,
  );
  assert.equal(
    (await call(env, requestFixture(), { token: `${TOKEN}x` })).status,
    401,
  );
  assert.equal(
    (await call(env, requestFixture(), { path: "/v2/issue" })).status,
    404,
  );
  assert.equal(
    (await call(env, requestFixture(), { method: "PUT" })).status,
    405,
  );
  assert.equal(
    env.LEDGER.db
      .prepare("SELECT count(*) AS n FROM independent_issuer_acknowledgements")
      .get().n,
    0,
  );
});

test("a trigger for another repository, requester, reviewer, task or key version is refused", async () => {
  const env = environment();
  const drifts = [
    [
      requestFixture({
        repository: "Iron-Wrap/other-repo",
        publication: {
          ref: `release-review/${COMMIT}`,
          path: `.release/reviews/${COMMIT}.json`,
        },
      }),
      "issuer_request_repository_drift",
    ],
    [
      requestFixture({ requested_by: "someone-else@ironwrapexteriors.com" }),
      "issuer_request_requester_drift",
    ],
    [
      requestFixture({
        expected_issuer: {
          principal: "other-reviewer@ironwrapexteriors.com",
          task_id: "independent-source-review",
        },
      }),
      "issuer_request_principal_drift",
    ],
    [
      requestFixture({
        expected_issuer: {
          principal: "independent-reviewer@ironwrapexteriors.com",
          task_id: "some-other-task",
        },
      }),
      "issuer_request_task_drift",
    ],
    [
      requestFixture({
        receipt_key: {
          public_key_sha256: "d".repeat(64),
          key_version: "review-key-2099-01",
        },
      }),
      "issuer_request_key_version_drift",
    ],
  ];
  for (const [body, code] of drifts) {
    const response = await call(env, body);
    assert.equal(response.status, 403, code);
    assert.equal(response.body.error, code);
  }
  assert.equal(
    env.LEDGER.db
      .prepare("SELECT count(*) AS n FROM independent_issuer_acknowledgements")
      .get().n,
    0,
  );
});

test("a malformed, oversized or already-expired trigger never reaches the ledger", async () => {
  const env = environment();
  assert.equal((await call(env, "{not json")).status, 400);
  assert.equal(
    (await call(env, requestFixture({ phase: "audit" }))).body.error,
    "issuer_request_invalid",
  );
  assert.equal(
    (
      await call(
        env,
        requestFixture(),
        undefined,
        Date.parse("2026-08-23T00:10:00.000Z"),
      )
    ).body.error,
    "issuer_request_expired",
  );
  const oversized = await call(
    env,
    `${canonicalJson(requestFixture())}${" ".repeat(33 * 1024)}`,
  );
  assert.equal(oversized.status, 413);
  assert.equal(
    env.LEDGER.db
      .prepare("SELECT count(*) AS n FROM independent_issuer_acknowledgements")
      .get().n,
    0,
  );
});

test("a deployment with no trigger token refuses everyone instead of accepting everyone", async () => {
  for (const token of [undefined, "", "short-token"]) {
    const env = environment({ ISSUER_TRIGGER_TOKEN: token });
    const post = await call(env, requestFixture(), { token: "" });
    assert.equal(
      post.status,
      503,
      `POST with configured token ${JSON.stringify(token)}`,
    );
    assert.equal(post.body.error, "issuer_configuration_missing:trigger_token");
    const read = await call(env, undefined, {
      method: "GET",
      token: "",
      path: `/v2/independent-issuer/acknowledgements/${COMMIT}`,
    });
    assert.equal(
      read.status,
      503,
      "the acknowledgement read must not be open either",
    );
    assert.equal(
      env.LEDGER.db
        .prepare(
          "SELECT count(*) AS n FROM independent_issuer_acknowledgements",
        )
        .get().n,
      0,
    );
  }
});

test("configuration this deployment never received refuses rather than guessing", async () => {
  const env = environment({ ISSUER_PRINCIPAL: "" });
  const response = await call(env, requestFixture());
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "issuer_configuration_missing:principal");
});

test("the reviewer can read back which run id a commit was acknowledged for", async () => {
  const env = environment();
  const { body } = await call(env, requestFixture());
  const read = await call(env, undefined, {
    method: "GET",
    path: `/v2/independent-issuer/acknowledgements/${COMMIT}`,
  });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.acknowledgements, [body.acknowledgement]);
  const unauthorised = await call(env, undefined, {
    method: "GET",
    token: "wrong-token",
    path: `/v2/independent-issuer/acknowledgements/${COMMIT}`,
  });
  assert.equal(unauthorised.status, 401);
});

test("an acknowledgement cannot be edited or deleted once the reviewer is bound to it", async () => {
  const env = environment();
  await call(env, requestFixture());
  assert.throws(
    () =>
      env.LEDGER.db.exec(
        "UPDATE independent_issuer_acknowledgements SET issuer_run_id = 'other'",
      ),
    /append_only/,
  );
  assert.throws(
    () => env.LEDGER.db.exec("DELETE FROM independent_issuer_acknowledgements"),
    /retained/,
  );
});
