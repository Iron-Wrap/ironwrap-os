import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { randomToken, sha256Hex } from "../src/app-auth.ts";
import type { AppEnv } from "../src/app-types.ts";

const NOW = "2026-07-31T10:00:00.000Z";
const PUBLIC_ORIGIN = "https://app.example.com";
const HMAC_SECRET = "customer-acceptance-test-hmac-secret-longer-than-thirty-two-characters";
const CUSTOMER_EMAIL = "Ada.Customer@Example.com";
const EMAIL_HASH = createHash("sha256").update(CUSTOMER_EMAIL.trim().toLowerCase()).digest("hex");
const TERMS = { clauses: [{ id: "scope-a", text: "Install approved roofing." }], version: "v1" };
const TERMS_JSON = '{"clauses":[{"id":"scope-a","text":"Install approved roofing."}],"version":"v1"}';
const TERMS_HASH = createHash("sha256").update(TERMS_JSON).digest("hex");

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0018_customer_portal_links.sql",
      "0029_customer_contract_acceptance.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    this.raw.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES ('appu_owner_0001', 'ironwrap', 'owner@example.com', 'Owner', 'owner',
               'owner@example.com', 1, 'seed', ?, ?)`,
    ).run(NOW, NOW);
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(
    raw: DatabaseSync,
    sql: string,
    args: unknown[],
  ) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();

  async head(key: string) {
    return this.objects.get(key)?.object ?? null;
  }

  async put(key: string, value: string, options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown }) {
    const prior = this.objects.get(key);
    if (prior && options.onlyIf) return null;
    const checksum = fromHex(options.sha256 ?? "");
    const object = {
      size: new TextEncoder().encode(value).byteLength,
      checksums: { sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength) },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body: value, object });
    return object;
  }
}

type CommitMode = "accepted" | "rejected" | "uncertain";

function setup(mode: CommitMode = "accepted") {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const sentEmails: string[] = [];
  const prepareClaims: Array<Record<string, unknown>> = [];
  const commitClaims: Array<Record<string, unknown>> = [];
  let activeMode = mode;
  let activeEmailHash = EMAIL_HASH;
  const originalFetch = globalThis.fetch;
  const env = testEnv(db, raw);

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-test-token" });
    }
    if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      sentEmails.push(Buffer.from(payload.raw, "base64url").toString("utf8"));
      return Response.json({ id: `gmail-${sentEmails.length}` });
    }
    if (url.pathname.includes("customer_contract_acceptance_api.")) {
      const body = JSON.parse(String(init?.body)) as { customer_claim_json?: unknown };
      assert.equal(typeof body.customer_claim_json, "string");
      assertFrappeSignature(url.pathname, body.customer_claim_json, init?.headers);
      const claim = JSON.parse(body.customer_claim_json) as Record<string, unknown>;
      if (url.pathname.endsWith("prepare_customer_portal_contract_acceptance")) {
        prepareClaims.push(claim);
        return Response.json({
          message: {
            email: CUSTOMER_EMAIL,
            email_hash: activeEmailHash,
            display_name: "Ada Customer",
            roof_job_id: "JOB-A",
            customer_id: "CUSTOMER-A",
            quote_id: "QUOTE-A",
            quote_version: 2,
            proposal_pack_id: "PACK-A",
            terms: TERMS,
            terms_hash: TERMS_HASH,
          },
        });
      }
      commitClaims.push(claim);
      if (activeMode === "rejected") return new Response("denied", { status: 409 });
      if (activeMode === "uncertain") return new Response("outage", { status: 503 });
      return Response.json({ message: { acceptance_id: claim.acceptance_id } });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };

  return {
    db,
    raw,
    env,
    sentEmails,
    prepareClaims,
    commitClaims,
    setMode(next: CommitMode) { activeMode = next; },
    setEmailHash(next: string) { activeEmailHash = next; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

function testEnv(db: SqliteD1, raw: MemoryR2): AppEnv {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return {
    DB: db as never,
    RAW: raw as never,
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "true",
    APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: HMAC_SECRET,
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: "customer-acceptance-key",
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET: "customer-acceptance-secret",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
    APP_AUTH_PEPPER: "customer-contract-acceptance-test-pepper-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "service@example.com", private_key: privateKey }),
    FROM_EMAIL: "contracts@example.com",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
  } as AppEnv;
}

async function seedPortalLink(db: SqliteD1): Promise<string> {
  const token = randomToken();
  db.raw.prepare(
    `INSERT INTO customer_portal_links
     (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
      created_at, expires_at, revoked_at, revoked_by_user_id, last_accessed_at, access_count,
      issued_ip_hash, issued_user_agent_hash)
     VALUES ('portal_00000000-0000-4000-8000-000000000001', ?, 'ironwrap', 'JOB-A', 'CUSTOMER-A',
             'appu_owner_0001', ?, '2030-01-01T00:00:00.000Z', NULL, NULL, NULL, 0, ?, ?)`,
  ).run(
    await sha256Hex(token),
    NOW,
    "a".repeat(64),
    "b".repeat(64),
  );
  return token;
}

async function issueChallenge(env: AppEnv, portalToken: string): Promise<{ token: string; response: Response }> {
  const response = await worker.fetch(
    new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ token: portalToken }),
    }),
    env as never,
    {} as never,
  );
  return { token: "", response };
}

function emailChallengeToken(sentEmails: string[]): string {
  const match = sentEmails.at(-1)?.match(/contract-accept#token=([A-Za-z0-9_-]{43})/);
  assert.ok(match, "missing emailed acceptance fragment");
  return match[1]!;
}

function confirmRequest(token: string, idempotencyKey: string, signerName = "Ada Customer"): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PUBLIC_ORIGIN,
      "cf-connecting-ip": "203.0.113.9",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ token, signer_name: signerName, accepted: true }),
  });
}

function assertFrappeSignature(path: string, claimJson: string, headers: HeadersInit | undefined): void {
  const values = new Headers(headers);
  const timestamp = values.get("x-ironwrap-acceptance-timestamp");
  const nonce = values.get("x-ironwrap-acceptance-nonce");
  assert.match(timestamp ?? "", /^\d{10,12}$/);
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{43}$/);
  const bodyHash = createHash("sha256").update(claimJson).digest("hex");
  const expected = createHmac("sha256", HMAC_SECRET)
    .update(`POST\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest("base64url");
  assert.equal(values.get("x-ironwrap-acceptance-signature"), expected);
  assert.equal(values.get("authorization"), "token customer-acceptance-key:customer-acceptance-secret");
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

test("customer acceptance is email-challenge-only, pinned, receipt-backed, and replay-safe", async () => {
  const h = setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.response.status, 200);
    const challengeBody = await challenge.response.json() as { status: string; expires_at: string };
    assert.equal(challengeBody.status, "challenge_sent");
    assert.match(challengeBody.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(h.prepareClaims.length, 1);
    const { challenge_id: preparedChallengeId, ...prepareAnchors } = h.prepareClaims[0]!;
    assert.deepEqual(prepareAnchors, {
      customer_id: "CUSTOMER-A",
      portal_link_id: "portal_00000000-0000-4000-8000-000000000001",
      roof_job_id: "JOB-A",
      tenant_id: "ironwrap",
    });
    assert.match(String(preparedChallengeId), /^acceptance_challenge_[0-9a-f-]{36}$/);

    const challengeToken = emailChallengeToken(h.sentEmails);
    assert.match(challengeToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(h.sentEmails[0]!.includes(CUSTOMER_EMAIL), true);
    assert.equal(h.sentEmails[0]!.includes("/contract-accept#token="), true);
    const persistedChallenge = h.db.raw.prepare("SELECT * FROM customer_portal_acceptance_challenges").get() as Record<string, unknown>;
    assert.equal(JSON.stringify(persistedChallenge).includes(CUSTOMER_EMAIL), false);
    assert.equal(JSON.stringify(persistedChallenge).includes(challengeToken), false);
    assert.match(String(persistedChallenge.token_hash), /^[0-9a-f]{64}$/);
    assert.equal(persistedChallenge.email_hash, EMAIL_HASH);
    assert.equal(persistedChallenge.provider_message_id, "gmail-1");
    assert.throws(
      () => h.db.raw.prepare(
        "UPDATE customer_portal_acceptance_challenges SET roof_job_id = 'JOB-B' WHERE challenge_id = ?",
      ).run(preparedChallengeId),
      /customer_portal_acceptance_challenge_immutable/,
    );
    assert.throws(
      () => h.db.raw.prepare(
        `UPDATE customer_portal_acceptance_challenges
         SET state = 'pending_delivery', sent_at = NULL, provider_message_id = NULL
         WHERE challenge_id = ?`,
      ).run(preparedChallengeId),
      /customer_portal_acceptance_challenge_invalid_transition/,
    );
    assert.throws(
      () => h.db.raw.prepare(
        "DELETE FROM customer_portal_acceptance_challenges WHERE challenge_id = ?",
      ).run(preparedChallengeId),
      /customer_portal_acceptance_challenges_append_only/,
    );

    const first = await worker.fetch(confirmRequest(challengeToken, "acceptance-confirm-0001"), h.env as never, {} as never);
    assert.equal(first.status, 200);
    const accepted = await first.json() as { status: string; acceptance_id: string };
    assert.deepEqual(accepted.status, "accepted");
    assert.match(accepted.acceptance_id, /^acceptance_[0-9a-f-]{36}$/);
    assert.equal(h.commitClaims.length, 1);
    const {
      accepted_at: acceptedAt,
      receipt_captured_at: receiptCapturedAt,
      receipt_content_length: receiptContentLength,
      receipt_hash: receiptHash,
      ...commitAnchors
    } = h.commitClaims[0]!;
    assert.deepEqual(commitAnchors, {
      acceptance_id: accepted.acceptance_id,
      challenge_id: String(preparedChallengeId),
      customer_id: "CUSTOMER-A",
      email_hash: EMAIL_HASH,
      portal_link_id: "portal_00000000-0000-4000-8000-000000000001",
      proposal_pack_id: "PACK-A",
      quote_id: "QUOTE-A",
      quote_version: 2,
      receipt_content_type: "application/json",
      receipt_key: `customer-contract-acceptance/v1/${accepted.acceptance_id}.json`,
      roof_job_id: "JOB-A",
      signer_ip: "203.0.113.9",
      signer_name: "Ada Customer",
      tenant_id: "ironwrap",
      terms_hash: TERMS_HASH,
    });
    assert.match(String(acceptedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(receiptCapturedAt, acceptedAt);
    assert.match(String(receiptHash), /^[0-9a-f]{64}$/);
    assert.ok(Number(receiptContentLength) > 0);

    const receipt = h.raw.objects.get(`customer-contract-acceptance/v1/${accepted.acceptance_id}.json`);
    assert.ok(receipt);
    assert.equal(receipt!.body.includes(CUSTOMER_EMAIL), false);
    assert.equal(receipt!.body.includes(challengeToken), false);
    assert.equal(receipt!.body.includes(TERMS_HASH), true);
    assert.equal(receipt!.body.includes(EMAIL_HASH), true);
    assert.equal(receipt!.body.includes("signer_ip_hash"), true);
    assert.equal(receiptHash, createHash("sha256").update(receipt!.body).digest("hex"));

    const replay = await worker.fetch(confirmRequest(challengeToken, "acceptance-confirm-0001"), h.env as never, {} as never);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), accepted);
    assert.equal(h.commitClaims.length, 1);

    const mismatch = await worker.fetch(confirmRequest(challengeToken, "acceptance-confirm-0001", "Other Representative"), h.env as never, {} as never);
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: "acceptance_idempotency_conflict" });
    const used = await worker.fetch(confirmRequest(challengeToken, "acceptance-confirm-0002"), h.env as never, {} as never);
    assert.equal(used.status, 409);
    assert.deepEqual(await used.json(), { error: "acceptance_challenge_used" });
    assert.equal(h.commitClaims.length, 1);

    const events = h.db.raw.prepare(
      "SELECT event_type FROM customer_portal_acceptance_events ORDER BY event_id",
    ).all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type), [
      "intent_recorded",
      "receipt_stored",
      "frappe_commit_attempted",
      "accepted",
    ]);
    assert.throws(
      () => h.db.raw.prepare(
        "UPDATE customer_portal_acceptance_events SET detail_code = 'rewritten' WHERE event_id = 1",
      ).run(),
      /customer_portal_acceptance_events_append_only/,
    );
    assert.throws(
      () => h.db.raw.prepare(
        "UPDATE customer_portal_acceptance_intents SET receipt_hash = ? WHERE acceptance_id = ?",
      ).run("f".repeat(64), accepted.acceptance_id),
      /customer_portal_acceptance_invalid_transition/,
    );
    assert.throws(
      () => h.db.raw.prepare(
        "DELETE FROM customer_portal_acceptance_intents WHERE acceptance_id = ?",
      ).run(accepted.acceptance_id),
      /customer_portal_acceptance_intents_append_only/,
    );

    const cookieOnly = await worker.fetch(
      new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie: "__Host-ironwrap_session=not-authority" },
        body: JSON.stringify({ token: randomToken() }),
      }),
      h.env as never,
      {} as never,
    );
    assert.equal(cookieOnly.status, 404);
    assert.deepEqual(await cookieOnly.json(), { error: "not_found" });
  } finally {
    h.restore();
  }
});

test("customer acceptance is false by default and never falls back to broad ERP credentials", async () => {
  const h = setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    h.env.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED = "false";
    const disabled = await issueChallenge(h.env, portalToken);
    assert.equal(disabled.response.status, 404);
    assert.deepEqual(await disabled.response.json(), { error: "not_found" });
    assert.equal(h.prepareClaims.length, 0);

    h.env.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED = "true";
    delete h.env.APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY;
    delete h.env.APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET;
    const globalOnly = await issueChallenge(h.env, portalToken);
    assert.equal(globalOnly.response.status, 503);
    assert.deepEqual(await globalOnly.response.json(), { error: "portal_unavailable" });
    assert.equal(h.prepareClaims.length, 0);
  } finally {
    h.restore();
  }
});


test("customer acceptance rejects a too-short dedicated HMAC secret", async () => {
  const h = setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    h.env.APP_CUSTOMER_ACCEPTANCE_HMAC_KEY = "short-hmac-secret";
    const response = await issueChallenge(h.env, portalToken);
    assert.equal(response.response.status, 503);
    assert.deepEqual(await response.response.json(), { error: "portal_unavailable" });
    assert.equal(h.prepareClaims.length, 0);
  } finally {
    h.restore();
  }
});

test("customer acceptance verifies Frappe's normalized email hash before delivery", async () => {
  const h = setup();
  try {
    h.setEmailHash("f".repeat(64));
    const portalToken = await seedPortalLink(h.db);
    const response = await issueChallenge(h.env, portalToken);
    assert.equal(response.response.status, 503);
    assert.deepEqual(await response.response.json(), { error: "portal_unavailable" });
    assert.equal(h.sentEmails.length, 0);
    assert.equal(
      h.db.raw.prepare("SELECT COUNT(*) AS count FROM customer_portal_acceptance_challenges").get()!.count,
      0,
    );
  } finally {
    h.restore();
  }
});

test("customer acceptance records Frappe 4xx as a replay-safe rejection", async () => {
  const h = setup("rejected");
  try {
    const portalToken = await seedPortalLink(h.db);
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.response.status, 200);
    const token = emailChallengeToken(h.sentEmails);
    const first = await worker.fetch(confirmRequest(token, "acceptance-reject-0001"), h.env as never, {} as never);
    assert.equal(first.status, 409);
    assert.deepEqual(await first.json(), { error: "acceptance_rejected" });
    const replay = await worker.fetch(confirmRequest(token, "acceptance-reject-0001"), h.env as never, {} as never);
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: "acceptance_rejected" });
    assert.equal(h.commitClaims.length, 1);
  } finally {
    h.restore();
  }
});

test("customer acceptance makes Frappe transport or 5xx uncertainty terminal without a blind retry", async () => {
  const h = setup("uncertain");
  try {
    const portalToken = await seedPortalLink(h.db);
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.response.status, 200);
    const token = emailChallengeToken(h.sentEmails);
    const first = await worker.fetch(confirmRequest(token, "acceptance-uncertain-0001"), h.env as never, {} as never);
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { status: string; acceptance_id: string };
    assert.deepEqual(firstBody.status, "uncertain");
    const replay = await worker.fetch(confirmRequest(token, "acceptance-uncertain-0001"), h.env as never, {} as never);
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal(h.commitClaims.length, 1);
    const state = h.db.raw.prepare(
      "SELECT state, error_code FROM customer_portal_acceptance_intents",
    ).get() as { state: string; error_code: string };
    assert.equal(state.state, "uncertain");
    assert.equal(state.error_code, "frappe_http_503");
  } finally {
    h.restore();
  }
});
