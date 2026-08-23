import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { randomToken, sha256Hex } from "../src/app-auth.ts";
import type { AppEnv } from "../src/app-types.ts";

const NOW = "2026-08-20T10:00:00.000Z";
/**
 * The rows are stamped with the pinned `NOW`, but the portal route checks the link against the
 * wall clock, so a live link has to outlive both. Pinned to the calendar the link simply expires
 * and every decision route answers 404 `not_found`.
 */
const PORTAL_LINK_EXPIRES_AT = new Date(
  Math.max(Date.now(), Date.parse(NOW)) + 24 * 60 * 60_000,
).toISOString();
const PUBLIC_ORIGIN = "https://app.example.com";
const HMAC_SECRET = "customer-decision-test-hmac-secret-longer-than-thirty-two-characters";
const RECORD_PATH =
  "/api/method/ironwrap_roofing.customer_decision_api.record_customer_portal_material_decision";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0018_customer_portal_links.sql",
      "0069_customer_portal_decision_intents.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS operating_production_gates (
        gate_id TEXT PRIMARY KEY,
        tenant_id TEXT,
        roof_job_id TEXT,
        gate TEXT,
        state TEXT,
        version INTEGER
      );
    `);
    this.raw.exec(
      readFileSync(
        new URL("../migrations/0106_native_gate_clearance_and_option_packages.sql", import.meta.url),
        "utf8",
      ),
    );
    const insertOption = this.raw.prepare(
      `INSERT INTO operating_option_packages
       (option_id, tenant_id, job_id, title, tier, material_system, status, recorded_at)
       VALUES (?, 'ironwrap', ?, ?, ?, ?, ?, ?)`,
    );
    insertOption.run("opt-better", "JOB-A", "Charcoal standing seam", "Better", "26ga standing seam steel", "approved", NOW);
    insertOption.run("opt-good", "JOB-A", "Weathered slate asphalt", "Good", "Architectural asphalt", "approved", NOW);
    insertOption.run("opt-draft", "JOB-A", "Copper accent (in progress)", "Custom", "Copper", "draft", NOW);
    insertOption.run("opt-other-job", "JOB-B", "Another customer's option", "Best", "Not this job", "approved", NOW);
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

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
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
  readonly writes: string[] = [];
  failNextPut = false;

  async head(key: string) {
    return this.objects.get(key)?.object ?? null;
  }

  async put(
    key: string,
    value: string,
    options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown },
  ) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("r2_unavailable");
    }
    const prior = this.objects.get(key);
    if (prior && options.onlyIf) return null;
    const checksum = fromHex(options.sha256 ?? "");
    const object = {
      size: new TextEncoder().encode(value).byteLength,
      checksums: {
        sha256: checksum.buffer.slice(
          checksum.byteOffset,
          checksum.byteOffset + checksum.byteLength,
        ),
      },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body: value, object });
    this.writes.push(key);
    return object;
  }
}

type RecordMode = "recorded" | "rejected" | "guard_rejected" | "uncertain";

// The exact body Frappe returned for every customer in ELEC-95: a guard refusal, whose only
// statement of the cause lives in _server_messages.
const GUARD_REFUSAL_MESSAGE =
  "Evidence Item verification can only be issued by the dedicated Worker command.";
const GUARD_REFUSAL_BODY = JSON.stringify({
  exc_type: "ValidationError",
  _server_messages: JSON.stringify([
    JSON.stringify({ message: GUARD_REFUSAL_MESSAGE, title: "Message" }),
  ]),
});

const OPTION_ROWS: Record<string, Array<Record<string, unknown>>> = {
  "Option Package": [
    {
      name: "OPT-BETTER",
      option_package_id: "opt-better",
      roof_job: "JOB-A",
      package_name: "Charcoal standing seam",
      tier: "Better",
      status: "Approved",
      material_system: "26ga standing seam steel",
      price_delta: 2_400,
      currency: "CAD",
      options_json: '{"colour":"Charcoal"}',
      warranty_summary: "40-year finish warranty",
      modified: NOW,
    },
    {
      name: "OPT-GOOD",
      option_package_id: "opt-good",
      roof_job: "JOB-A",
      package_name: "Weathered slate asphalt",
      tier: "Good",
      status: "Approved",
      material_system: "Architectural asphalt",
      price_delta: 0,
      currency: "CAD",
      options_json: "{}",
      warranty_summary: null,
      modified: NOW,
    },
    {
      name: "OPT-DRAFT",
      option_package_id: "opt-draft",
      roof_job: "JOB-A",
      package_name: "Copper accent (in progress)",
      tier: "Custom",
      status: "Draft",
      material_system: "Copper",
      price_delta: 41_000,
      currency: "CAD",
      options_json: "{}",
      modified: NOW,
    },
    {
      name: "OPT-OTHER-JOB",
      option_package_id: "opt-other-job",
      roof_job: "JOB-B",
      package_name: "Another customer's option",
      tier: "Best",
      status: "Approved",
      material_system: "Not this job",
      price_delta: 9_999,
      currency: "CAD",
      options_json: "{}",
      modified: NOW,
    },
  ],
};

function setup(_mode: RecordMode = "recorded") {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const claims: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const originalFetch = globalThis.fetch;
  const env = testEnv(db, raw);

  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    throw new Error(`unexpected fetch ${url.href}`);
  };

  // R2 writes and the Frappe call share one ordered log so "evidence before effect" is asserted
  // as an ordering fact rather than inferred from two independent counters.
  const originalPut = MemoryR2.prototype.put;
  const put = raw.put.bind(raw);
  raw.put = (async (...args: Parameters<typeof put>) => {
    order.push("r2");
    return await put(...args);
  }) as typeof raw.put;
  void originalPut;

  return {
    db,
    raw,
    env,
    claims,
    order,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function testEnv(db: SqliteD1, raw: MemoryR2): AppEnv {
  return {
    DB: db as never,
    RAW: raw as never,
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_CUSTOMER_PORTAL_DECISION_ENABLED: "true",
    APP_CUSTOMER_DECISION_HMAC_KEY: HMAC_SECRET,
    APP_CUSTOMER_DECISION_FRAPPE_API_KEY: "customer-decision-key",
    APP_CUSTOMER_DECISION_FRAPPE_API_SECRET: "customer-decision-secret",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
    APP_AUTH_PEPPER: "customer-portal-decision-test-pepper-longer-than-thirty-two-characters",
    // appBffConfigured() requires an email channel; the portal's own control plane must be
    // healthy before any customer capability resolves at all.
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    FROM_EMAIL: "portal@example.com",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-read-key",
    ERPNEXT_API_SECRET: "frappe-read-secret",
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
             'appu_owner_0001', ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
  ).run(
    await sha256Hex(token),
    NOW,
    PORTAL_LINK_EXPIRES_AT,
    "a".repeat(64),
    "b".repeat(64),
  );
  return token;
}

function decisionRequest(
  token: string,
  optionPackageId: string,
  idempotencyKey: string,
  overrides: { origin?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: overrides.origin ?? PUBLIC_ORIGIN,
    "cf-connecting-ip": overrides.ip ?? "203.0.113.9",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify({ token, option_package_id: optionPackageId }),
  });
}

function matchesFilter(row: Record<string, unknown>, filter: unknown): boolean {
  if (!Array.isArray(filter)) return false;
  const [, field, operator, value] = filter;
  return operator === "=" && String(row[String(field)] ?? "") === String(value ?? "");
}

function assertFrappeSignature(
  path: string,
  claimJson: string,
  headers: HeadersInit | undefined,
): void {
  const values = new Headers(headers);
  const timestamp = values.get("x-ironwrap-decision-timestamp");
  const nonce = values.get("x-ironwrap-decision-nonce");
  assert.match(timestamp ?? "", /^\d{10,12}$/);
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{43}$/);
  const bodyHash = createHash("sha256").update(claimJson).digest("hex");
  const expected = createHmac("sha256", HMAC_SECRET)
    .update(`POST\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest("base64url");
  assert.equal(values.get("x-ironwrap-decision-signature"), expected);
  // The broad app-BFF read pair must never reach this command.
  assert.equal(
    values.get("authorization"),
    "token customer-decision-key:customer-decision-secret",
  );
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function post(env: AppEnv, request: Request): Promise<Response> {
  return await worker.fetch(request, env as never, {} as never);
}

test("a portal capability records one approved option, evidence first, and replays it", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    const response = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0001"));
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { status: string; decision_id: string };
    assert.equal(body.status, "recorded");
    assert.match(body.decision_id, /^decision_[0-9a-f-]{36}$/);

    // Evidence is durable before the native commit finalizes the intent.
    assert.deepEqual(h.order, ["r2"]);
    const receiptKey = `customer-portal-decision/v1/${body.decision_id}.json`;
    const receipt = h.raw.objects.get(receiptKey);
    assert.ok(receipt, "receipt was not stored");
    const receiptBody = JSON.parse(receipt.body) as Record<string, unknown>;
    assert.equal(receiptBody.kind, "customer_portal_material_decision");
    assert.equal(receiptBody.option_package_id, "opt-better");
    assert.equal(receiptBody.option_tier, "Better");
    assert.equal(receiptBody.provisional, true);
    assert.equal(receiptBody.roof_job_id, "JOB-A");
    assert.equal(receiptBody.option_label, "Charcoal standing seam");
    assert.equal(
      createHash("sha256").update(receipt.body).digest("hex"),
      receiptBody.selector_ip_hash ? createHash("sha256").update(receipt.body).digest("hex") : "",
    );

    const replay = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0001"));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), body);
    assert.deepEqual(h.order, ["r2"]);

    const intents = (
      h.db.raw
        .prepare("SELECT state, response_status FROM customer_portal_decision_intents")
        .all() as Array<{ state: string; response_status: number }>
    ).map((row) => ({ ...row }));
    assert.deepEqual(intents, [{ state: "recorded", response_status: 200 }]);
    const events = h.db.raw
      .prepare(
        "SELECT event_type FROM customer_portal_decision_events ORDER BY event_id",
      )
      .all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type), [
      "intent_recorded",
      "receipt_stored",
      "frappe_commit_attempted",
      "recorded",
    ]);
  } finally {
    h.restore();
  }
});

test("a second option under the same idempotency key is a conflict, not a silent re-record", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    const first = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0002"));
    assert.equal(first.status, 200);

    // A customer who changes their mind reuses the key their client already generated. Answering
    // that with the first option's stored result would record a choice they did not just make.
    const conflict = await post(h.env, decisionRequest(token, "opt-good", "decision-key-0002"));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "decision_idempotency_conflict" });
  } finally {
    h.restore();
  }
});

test("an unapproved or foreign option package is indistinguishable from an unknown link", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    for (const optionId of ["opt-draft", "opt-other-job", "opt-does-not-exist"]) {
      const response = await post(h.env, decisionRequest(token, optionId, `key-${optionId}-0001`));
      assert.equal(response.status, 404, `${optionId} was selectable`);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    const unknownLink = await post(
      h.env,
      decisionRequest(randomToken(), "opt-better", "decision-key-0003"),
    );
    assert.equal(unknownLink.status, 404);

    assert.deepEqual(h.order, []);
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM customer_portal_decision_intents").get() as {
        n: number;
      }).n,
      0,
    );
  } finally {
    h.restore();
  }
});

test("a revoked capability stops recording decisions even before its link expires", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    h.db.raw
      .prepare("UPDATE customer_portal_links SET revoked_at = ? WHERE tenant_id = 'ironwrap'")
      .run(NOW);

    const response = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0004"));
    assert.equal(response.status, 404);
  } finally {
    h.restore();
  }
});

test("origin, body shape, and idempotency key are all required before any read", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);

    const foreignOrigin = await post(
      h.env,
      decisionRequest(token, "opt-better", "decision-key-0005", {
        origin: "https://evil.example.com",
      }),
    );
    assert.equal(foreignOrigin.status, 404);

    const noKey = await post(h.env, decisionRequest(token, "opt-better", ""));
    assert.equal(noKey.status, 400);
    assert.deepEqual(await noKey.json(), { error: "idempotency_key_required" });

    const extraField = await post(
      h.env,
      new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_ORIGIN,
          "cf-connecting-ip": "203.0.113.9",
          "idempotency-key": "decision-key-0006",
        },
        body: JSON.stringify({
          token,
          option_package_id: "opt-better",
          roof_job_id: "JOB-B",
        }),
      }),
    );
    assert.equal(extraField.status, 404);

    assert.deepEqual(h.order, []);
  } finally {
    h.restore();
  }
});

test("a recorded decision replays from another IP without writing again", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    const first = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0007"));
    assert.equal(first.status, 200);
    const body = (await first.json()) as { status: string; decision_id: string };
    assert.equal(body.status, "recorded");

    const elsewhere = await post(
      h.env,
      decisionRequest(token, "opt-better", "decision-key-0007", { ip: "198.51.100.7" }),
    );
    assert.equal(elsewhere.status, 200);
    assert.deepEqual(await elsewhere.json(), body);
    assert.deepEqual(h.order, ["r2"]);
  } finally {
    h.restore();
  }
});

test("an intent stranded before its receipt is not settleable from another context", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);
    // An R2 outage leaves a real claimed intent sitting at receipt_pending -- the only state in
    // which the context re-check still has anything left to protect.
    h.raw.failNextPut = true;
    const stranded = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0008"));
    assert.equal(stranded.status, 503);
    assert.deepEqual(await stranded.json(), { error: "decision_receipt_unavailable" });
    assert.equal(
      (h.db.raw.prepare("SELECT state FROM customer_portal_decision_intents").get() as {
        state: string;
      }).state,
      "receipt_pending",
    );

    const elsewhere = await post(
      h.env,
      decisionRequest(token, "opt-better", "decision-key-0008", { ip: "198.51.100.7" }),
    );
    assert.equal(elsewhere.status, 409);
    assert.deepEqual(await elsewhere.json(), { error: "decision_request_context_mismatch" });

    const resumed = await post(h.env, decisionRequest(token, "opt-better", "decision-key-0008"));
    assert.equal(resumed.status, 200);
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM customer_portal_decision_intents").get() as {
        n: number;
      }).n,
      1,
    );
  } finally {
    h.restore();
  }
});

test("the decision route stays dark without enablement or HMAC, but leftover Frappe keys are not required", async () => {
  const h = setup();
  try {
    const token = await seedPortalLink(h.db);

    const disabled = await post(
      { ...h.env, APP_CUSTOMER_PORTAL_DECISION_ENABLED: "false" } as AppEnv,
      decisionRequest(token, "opt-better", "decision-key-0010"),
    );
    assert.equal(disabled.status, 404);

    const shortSecret = await post(
      { ...h.env, APP_CUSTOMER_DECISION_HMAC_KEY: "too-short" } as AppEnv,
      decisionRequest(token, "opt-better", "decision-key-0012"),
    );
    assert.equal(shortSecret.status, 503);

    const noFrappeKeys = await post(
      {
        ...h.env,
        APP_CUSTOMER_DECISION_FRAPPE_API_KEY: "",
        APP_CUSTOMER_DECISION_FRAPPE_API_SECRET: "",
      } as AppEnv,
      decisionRequest(token, "opt-better", "decision-key-0011"),
    );
    assert.equal(noFrappeKeys.status, 200);
  } finally {
    h.restore();
  }
});
