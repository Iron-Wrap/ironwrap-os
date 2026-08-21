// production-gate-clearance.test.ts - the six scheduling gates finally have producers.
//
// The point every case here defends is ELEC-120 finding 3: gate states were
// validated and enforced, and nothing in the product could move one off `Blocked`.
// So these tests drive the real route, through the real runway read, into a real
// R2 receipt, and assert exactly what reaches Frappe - not that the module agrees
// with itself.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  depositSettlementReceipt,
  frappeRefusalCode,
  parseProductionGateClearance,
  settledDepositIntent,
  settlementObservedAt,
} from "../src/production-gate-clearance.ts";
import type { AccountingIntentRecord } from "../src/accounting-intents.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const OWNER = "owner@example.com";
const JOB_ID = "job:elec122";
const CLEARANCE_PATH = (gate: string, job = JOB_ID) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/clearance`;
const KEY = "gate-clearance-key-0000000001";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    const now = new Date().toISOString();
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insert.run("appu_owner_0001", TENANT, OWNER, "Owner", "owner", OWNER, now, now);
    insert.run("appu_ops_0001", TENANT, "ops@example.com", "Ops", "ops", "ops@example.com", now, now);
    insert.run(
      "appu_owner_0002",
      TENANT,
      "unbound@example.com",
      "Unbound Owner",
      "owner",
      null,
      now,
      now,
    );
  }

  seedNativeRunway(jobId = JOB_ID, gateState = "blocked"): void {
    const now = "2026-08-20T10:00:00.000Z";
    this.raw
      .prepare(
        `INSERT INTO envelopes
         (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
          status, created_at, updated_at)
         VALUES (?, 'manual', 'Gate Customer', 'gate@example.invalid', '{}',
                 'raw/gate/0001.json', ?, 'reconciled', ?, ?)`,
      )
      .run("ow_gate_clearance_0001", now, now, now);
    this.raw
      .prepare(
        `INSERT INTO operating_leads
         (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
          lifecycle_status, version, created_at, updated_at)
         VALUES ('lead:gate:0001', ?, 'ow_gate_clearance_0001', 'manual',
                 'Gate Customer', 'gate@example.invalid', 'qualified', 1, ?, ?)`,
      )
      .run(TENANT, now, now);
    this.raw
      .prepare(
        `INSERT INTO operating_customers
         (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
          lifecycle_status, version, created_at, updated_at)
         VALUES ('customer:gate:0001', ?, 'ow_gate_clearance_0001',
                 'Gate Customer', 'gate@example.invalid', 'active', 1, ?, ?)`,
      )
      .run(TENANT, now, now);
    this.raw
      .prepare(
        `INSERT INTO operating_roof_jobs
         (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id,
          brand, job_number, service_type, job_status, current_gate_state,
          version, created_at, updated_at)
         VALUES (?, ?, 'lead:gate:0001', 'customer:gate:0001',
                 'ow_gate_clearance_0001', 'ironwrap', 'IW-122-1', 'Roofing',
                 'qualified', 'blocked', 1, ?, ?)`,
      )
      .run(jobId, TENANT, now, now);
    const insertGate = this.raw.prepare(
      `INSERT INTO operating_production_gates
       (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state,
        owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
       VALUES (?, ?, ?, 'ow_gate_clearance_0001', ?, ?, 'owner@example.com',
               ?, '2026-08-21T12:00:00.000Z', 'No active blocker', 1, ?, ?)`,
    );
    for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
      insertGate.run(
        `gate:elec122:${gate.toLowerCase()}`,
        TENANT,
        jobId,
        gate,
        gateState,
        now,
        now,
        now,
      );
    }
  }

  /** Seed one money-lane row in the state an authenticated read-back would have left. */
  seedDepositIntent(overrides: Partial<AccountingIntentRecord> = {}): void {
    const row: Record<string, unknown> = {
      intent_id: "acct-intent-deposit-0000001",
      tenant_id: TENANT,
      kind: "deposit_invoice",
      roof_job_id: JOB_ID,
      basis_json: "{}",
      basis_sha256: "a".repeat(64),
      source_documents_json: "[]",
      expected_sha256: "b".repeat(64),
      tax_policy_snapshot_sha256: "e".repeat(64),
      provider: "quickbooks",
      realm_id: "4620816365000000000",
      provider_entity_type: "Invoice",
      provider_payload_json: "{}",
      provider_payload_sha256: "c".repeat(64),
      provider_request_id: "req-deposit-0000000000001",
      currency: "CAD",
      subtotal: "5000.00",
      tax_amount: "250.00",
      total_amount: "5250.00",
      settled_amount: "5250.00",
      authority_permit_ref: "permit:test",
      authority_policy_ref: "policy:test",
      authority_policy_version: "1",
      authority_max_amount: "100000.00",
      effect_id: "effect:deposit-0000000000001",
      effect_idempotency_key: "effect-key-deposit-000000001",
      compensates_effect_id: null,
      final_invoice_intent_id: null,
      compensates_intent_id: null,
      state: "reconciled",
      version: 1,
      blocker_code: null,
      blocker_next_step: null,
      reason_code: null,
      error_code: null,
      derived_by_actor_kind: "owner",
      derived_by_user_id: "appu_owner_0001",
      derived_at: "2026-08-20T12:00:00.000Z",
      approved_by_user_id: "appu_owner_0002",
      approved_at: "2026-08-20T12:02:00.000Z",
      rejected_by_user_id: null,
      rejected_at: null,
      provider_entity_id: "1042",
      // `reconciled` is only legal when the observed fact set matches the expected
      // one; the storage layer enforces it, so the fixture honours it.
      observed_sha256: "b".repeat(64),
      provider_submitted_at: "2026-08-20T12:05:00.000Z",
      provider_reconciled_at: "2026-08-20T12:10:00.000Z",
      created_at: "2026-08-20T12:00:00.000Z",
      updated_at: "2026-08-20T12:10:00.000Z",
      ...overrides,
    };
    const columns = Object.keys(row);
    this.raw
      .prepare(
        `INSERT INTO accounting_intents (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...(columns.map((column) => row[column]) as never[]));
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();
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
    if (this.objects.has(key) && options.onlyIf) return null;
    const checksum = Buffer.from(options.sha256 ?? "", "hex");
    this.objects.set(key, {
      body: value,
      object: {
        size: new TextEncoder().encode(value).byteLength,
        checksums: {
          sha256: checksum.buffer.slice(
            checksum.byteOffset,
            checksum.byteOffset + checksum.byteLength,
          ),
        },
        customMetadata: options.customMetadata,
      },
    });
    return this.objects.get(key)!.object;
  }
}

interface FrappeCall {
  body: Record<string, unknown>;
}

interface Harness {
  env: AppEnv;
  db: SqliteD1;
  raw: MemoryR2;
  frappeCalls: FrappeCall[];
  restore: () => void;
}

function setup(options: {
  gateState?: string;
  jobStatus?: string;
  jobs?: boolean;
  frappeStatus?: number;
  frappeBody?: string;
} = {}): Harness {
  const db = new SqliteD1();
  if (options.jobs !== false) {
    const nativeState = (options.gateState ?? "Blocked").toLowerCase();
    db.seedNativeRunway(JOB_ID, nativeState === "ready" ? "ready" : "blocked");
  }
  const raw = new MemoryR2();
  const frappeCalls: FrappeCall[] = [];
  const original = globalThis.fetch;
  const env = {
    DB: db as never,
    RAW: raw as never,
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_TIME_ZONE: "America/Edmonton",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
  } as AppEnv;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inbound = input instanceof Request ? input : new Request(input, init);
    const url = new URL(inbound.url);
    if (url.pathname.endsWith("record_production_gate_clearance")) {
      frappeCalls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (options.frappeStatus && options.frappeStatus !== 200) {
        return new Response(
          options.frappeBody ?? '{"exception":"production_gate_actor_role_denied: nope"}',
          { status: options.frappeStatus },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        message: {
          gate: {
            name: `GATE-${String(body.gate)}`,
            gate: body.gate,
            roof_job: JOB_ID,
            state: body.clearance === "waived" ? "Waived" : "Ready",
          },
          evidence_item: body.evidence ? `gate-clearance:${String(body.decision_id)}` : null,
          actor_role: "IronWrap Owner",
          replayed: false,
        },
      });
    }
    const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (doctype === "Roof Job") {
      return Response.json({
        data: options.jobs === false
          ? []
          : [{
            name: JOB_ID,
            job_number: "IW-122-1",
            brand: "IronWrap Exteriors",
            service_type: "Roofing",
            job_status: options.jobStatus ?? "Won",
            modified: "2026-08-20T10:00:00.000Z",
          }],
      });
    }
    if (doctype === "Production Gate State") {
      return Response.json({
        data: ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
          name: `GATE-${gate}`,
          roof_job: JOB_ID,
          gate,
          state: options.gateState ?? "Blocked",
          modified: "2026-08-20T10:00:00.000Z",
        })),
      });
    }
    return Response.json({ data: [] });
  };

  return {
    env,
    db,
    raw,
    frappeCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function auth(role: AppRole, userId = role === "owner" ? "appu_owner_0001" : "appu_ops_0001"): AuthContext {
  const now = new Date();
  const email = userId === "appu_owner_0001"
    ? OWNER
    : userId === "appu_ops_0001"
      ? "ops@example.com"
      : "unbound@example.com";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: new Date(now.getTime() - 60_000).toISOString(),
      session_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      revoked_at: null,
      user_id: userId,
      tenant_id: TENANT,
      email_normalized: email,
      display_name: role,
      role,
      frappe_user_id: userId === "appu_owner_0002" ? null : email,
      active: 1,
      created_by: OWNER,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

function request(
  path: string,
  body: Record<string, unknown>,
  options: { idempotency?: string | null; csrf?: boolean } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf");
  if (options.idempotency !== null) headers.set("idempotency-key", options.idempotency ?? KEY);
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function post(
  harness: Harness,
  path: string,
  body: Record<string, unknown>,
  context = auth("owner"),
  options: { idempotency?: string | null; csrf?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleAuthenticatedRoute(
    request(path, body, options),
    harness.env,
    context,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("an ops session may read the runway but never clear a gate", async () => {
  const harness = setup();
  try {
    const result = await post(
      harness,
      CLEARANCE_PATH("Weather"),
      { basis: "office_waiver", reason: "Forecast clear through the install window." },
      auth("ops"),
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "production_gate_clearance_forbidden");
  } finally {
    harness.restore();
  }
});

test("an owner with no leftover Frappe identity still clears a gate on D1", async () => {
  const harness = setup();
  try {
    const result = await post(
      harness,
      CLEARANCE_PATH("Weather"),
      { basis: "office_waiver", reason: "Forecast clear through the install window." },
      auth("owner", "appu_owner_0002"),
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.clearance, "waived");
    const row = harness.db.raw.prepare(
      `SELECT state, cleared_by_user_id, clearance_basis
         FROM operating_production_gates
        WHERE gate = 'Weather'`,
    ).get() as { state: string; cleared_by_user_id: string; clearance_basis: string };
    assert.equal(row.state, "waived");
    assert.equal(row.cleared_by_user_id, "appu_owner_0002");
    assert.equal(row.clearance_basis, "office_waiver");
  } finally {
    harness.restore();
  }
});

test("a clearance without CSRF or an idempotency key is refused before any read", async () => {
  const harness = setup();
  try {
    const noCsrf = await post(
      harness,
      CLEARANCE_PATH("Access"),
      { basis: "office_waiver", reason: "Homeowner confirmed side-yard access." },
      auth("owner"),
      { csrf: false },
    );
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error, "csrf_failed");
    const noKey = await post(
      harness,
      CLEARANCE_PATH("Access"),
      { basis: "office_waiver", reason: "Homeowner confirmed side-yard access." },
      auth("owner"),
      { idempotency: null },
    );
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error, "idempotency_key_required");
  } finally {
    harness.restore();
  }
});

test("Completion is a closeout gate and is not clearable on this rail", async () => {
  const harness = setup();
  try {
    const result = await post(harness, CLEARANCE_PATH("Completion"), {
      basis: "office_waiver",
      reason: "Work finished ahead of the closeout review.",
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_production_gate_clearance");
  } finally {
    harness.restore();
  }
});

test("a job the caller's own runway cannot see has no gate to clear", async () => {
  const harness = setup({ jobs: false });
  try {
    const result = await post(harness, CLEARANCE_PATH("Materials"), {
      basis: "office_waiver",
      reason: "Panels staged at the shop and released for delivery.",
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "production_gate_job_not_on_runway");
  } finally {
    harness.restore();
  }
});

test("an office waiver persists on D1 as a waived gate attributed to the app user", async () => {
  const harness = setup();
  try {
    const reason = "No deposit on this insurance restoration file; carrier pays on completion.";
    const result = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "office_waiver",
      reason,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.clearance, "waived");
    assert.equal(result.body.basis, "office_waiver");
    assert.equal(result.body.evidence_item, null);
    assert.equal(result.body.actor_role, "owner");
    const row = harness.db.raw.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id
         FROM operating_production_gates
        WHERE gate = 'Deposit'`,
    ).get() as {
      state: string;
      version: number;
      clearance_basis: string;
      clearance_decision_id: string;
      cleared_by_user_id: string;
    };
    assert.equal(row.state, "waived");
    assert.equal(row.version, 2);
    assert.equal(row.clearance_basis, "office_waiver");
    assert.equal(row.clearance_decision_id, KEY);
    assert.equal(row.cleared_by_user_id, "appu_owner_0001");
    assert.equal(harness.raw.objects.size, 0);
  } finally {
    harness.restore();
  }
});

test("a waiver with no real reason is refused", async () => {
  const harness = setup();
  try {
    for (const reason of ["", "ok", " ".repeat(20)]) {
      const result = await post(harness, CLEARANCE_PATH("Safety"), {
        basis: "office_waiver",
        reason,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, "invalid_production_gate_clearance");
    }
  } finally {
    harness.restore();
  }
});

test("the Deposit gate refuses a settlement clearance the money lane has not settled", async () => {
  const harness = setup();
  try {
    const result = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "deposit_settlement_not_observed");
    assert.equal(harness.raw.objects.size, 0);
  } finally {
    harness.restore();
  }
});

test("a settled deposit invoice clears the gate on a stored, hashed receipt", async () => {
  const harness = setup();
  harness.db.seedDepositIntent();
  try {
    const result = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.clearance, "verified");
    assert.equal(result.body.evidence_item, `gate-clearance:${KEY}`);

    const [stored] = [...harness.raw.objects.entries()];
    assert.equal(stored[0], `production-gate-clearance/v1/${KEY}.json`);
    const receipt = JSON.parse(stored[1].body) as Record<string, unknown>;
    assert.equal(receipt.kind, "production_gate_clearance");
    assert.equal(receipt.basis, "deposit_settlement");
    assert.equal(receipt.settlement_observed_at, "2026-08-20T12:10:00.000Z");
    assert.deepEqual(receipt.money_intent, {
      intent_id: "acct-intent-deposit-0000001",
      kind: "deposit_invoice",
      state: "reconciled",
      provider: "quickbooks",
      realm_id: "4620816365000000000",
      provider_entity_type: "Invoice",
      provider_entity_id: "1042",
      currency: "CAD",
      total_amount: "5250.00",
      settled_amount: "5250.00",
      observed_sha256: "b".repeat(64),
      provider_reconciled_at: "2026-08-20T12:10:00.000Z",
    });

    const row = harness.db.raw.prepare(
      `SELECT state, clearance_basis, clearance_decision_id, evidence_refs_json
         FROM operating_production_gates
        WHERE gate = 'Deposit'`,
    ).get() as {
      state: string;
      clearance_basis: string;
      clearance_decision_id: string;
      evidence_refs_json: string;
    };
    assert.equal(row.state, "complete");
    assert.equal(row.clearance_basis, "deposit_settlement");
    assert.equal(row.clearance_decision_id, KEY);
    const evidence = JSON.parse(row.evidence_refs_json) as Record<string, unknown>;
    assert.equal(evidence.r2_key, `production-gate-clearance/v1/${KEY}.json`);
    assert.equal(
      evidence.content_checksum,
      createHash("sha256").update(stored[1].body).digest("hex"),
    );
    assert.equal(
      evidence.content_length,
      new TextEncoder().encode(stored[1].body).byteLength,
    );
  } finally {
    harness.restore();
  }
});

test("the same settlement clearance twice stores the same bytes and converges", async () => {
  const harness = setup();
  harness.db.seedDepositIntent();
  try {
    const first = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
    });
    const stored = harness.raw.objects.get(`production-gate-clearance/v1/${KEY}.json`)!.body;
    const second = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
    });
    assert.equal(first.status, 200);
    // A retry re-stores identical bytes rather than colliding with its own first
    // attempt, which is what an immutable object store does to a wall-clock stamp.
    assert.equal(second.status, 200);
    assert.equal(harness.raw.objects.size, 1);
    assert.equal(harness.raw.objects.get(`production-gate-clearance/v1/${KEY}.json`)!.body, stored);
  } finally {
    harness.restore();
  }
});

test("a receipt that could not be stored never becomes a cleared gate", async () => {
  const harness = setup();
  harness.db.seedDepositIntent();
  harness.raw.failNextPut = true;
  try {
    const result = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "production_gate_receipt_unavailable");
    const row = harness.db.raw.prepare(
      `SELECT state FROM operating_production_gates WHERE gate = 'Deposit'`,
    ).get() as { state: string };
    assert.equal(row.state, "blocked");
  } finally {
    harness.restore();
  }
});

test("settlement is a Deposit-only basis and takes no caller prose", async () => {
  const harness = setup();
  harness.db.seedDepositIntent();
  try {
    const wrongGate = await post(harness, CLEARANCE_PATH("Crew"), {
      basis: "deposit_settlement",
    });
    assert.equal(wrongGate.status, 400);
    const withReason = await post(harness, CLEARANCE_PATH("Deposit"), {
      basis: "deposit_settlement",
      reason: "The customer told me they paid.",
    });
    assert.equal(withReason.status, 400);
  } finally {
    harness.restore();
  }
});

test("a second clearance with a different decision is refused as already cleared", async () => {
  const harness = setup();
  try {
    const first = await post(harness, CLEARANCE_PATH("Access"), {
      basis: "office_waiver",
      reason: "Homeowner confirmed the side-yard gate stays unlocked.",
    });
    assert.equal(first.status, 200);
    const result = await post(
      harness,
      CLEARANCE_PATH("Access"),
      { basis: "office_waiver", reason: "Homeowner confirmed the side-yard gate stays unlocked." },
      auth("owner"),
      { idempotency: "gate-clearance-key-0000000002" },
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "production_gate_already_cleared");
  } finally {
    harness.restore();
  }
});

test("the same waiver decision id replays the stored D1 clearance", async () => {
  const harness = setup();
  try {
    const first = await post(harness, CLEARANCE_PATH("Weather"), {
      basis: "office_waiver",
      reason: "Environment Canada shows a dry three-day window from Monday.",
    });
    const second = await post(harness, CLEARANCE_PATH("Weather"), {
      basis: "office_waiver",
      reason: "Environment Canada shows a dry three-day window from Monday.",
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    const row = harness.db.raw.prepare(
      `SELECT version FROM operating_production_gates WHERE gate = 'Weather'`,
    ).get() as { version: number };
    assert.equal(row.version, 2);
  } finally {
    harness.restore();
  }
});

test("the runway advertises the clearing action only to a session that may use it", async () => {
  const harness = setup();
  try {
    const owner = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/production"),
      harness.env,
      auth("owner"),
    );
    const ownerBody = (await owner.json()) as { allowed_actions: string[] };
    assert.ok(ownerBody.allowed_actions.includes("production_gate.clear"));

    const ops = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/production"),
      harness.env,
      auth("ops"),
    );
    const opsBody = (await ops.json()) as { allowed_actions: string[] };
    assert.ok(!opsBody.allowed_actions.includes("production_gate.clear"));
  } finally {
    harness.restore();
  }
});

test("settledDepositIntent ranks a reconciled invoice over a partial one and ignores a zero settlement", () => {
  const base = {
    kind: "deposit_invoice",
    settled_amount: "100.00",
    provider_reconciled_at: "2026-08-20T12:00:00.000Z",
  } as unknown as AccountingIntentRecord;
  const partial = { ...base, intent_id: "a", state: "partially_settled" } as AccountingIntentRecord;
  const reconciled = { ...base, intent_id: "b", state: "reconciled" } as AccountingIntentRecord;
  const zero = {
    ...base,
    intent_id: "c",
    state: "reconciled",
    settled_amount: "0.00",
  } as AccountingIntentRecord;
  assert.equal(settledDepositIntent([partial, reconciled])?.intent_id, "b");
  assert.equal(settledDepositIntent([partial])?.intent_id, "a");
  assert.equal(settledDepositIntent([zero]), null);
  assert.equal(settledDepositIntent([]), null);
  assert.equal(
    settledDepositIntent([
      { ...base, intent_id: "d", state: "submitted" } as AccountingIntentRecord,
    ]),
    null,
  );
});

test("the receipt is canonical, so the same observation always hashes the same", () => {
  const intent = {
    intent_id: "acct-intent-deposit-0000001",
    kind: "deposit_invoice",
    state: "reconciled",
    provider: "quickbooks",
    realm_id: "realm",
    provider_entity_type: "Invoice",
    provider_entity_id: "1042",
    currency: "CAD",
    total_amount: "5250.00",
    settled_amount: "5250.00",
    observed_sha256: "d".repeat(64),
    provider_reconciled_at: "2026-08-20T12:10:00.000Z",
  } as unknown as AccountingIntentRecord;
  const input = {
    tenantId: TENANT,
    roofJobId: JOB_ID,
    decisionId: KEY,
    clearedByUserId: "appu_owner_0001",
    intent,
  };
  assert.equal(depositSettlementReceipt(input), depositSettlementReceipt({ ...input }));
  // No wall-clock stamp anywhere in it: R2 stores the receipt immutably, so a
  // "when this ran" field would make every retry collide with its own first
  // attempt. Found exactly that way on a real stack.
  const decoded = JSON.parse(depositSettlementReceipt(input)) as Record<string, unknown>;
  assert.equal(decoded.settlement_observed_at, "2026-08-20T12:10:00.000Z");
  assert.ok(!("observed_at" in decoded));
  assert.equal(
    settlementObservedAt({ ...intent, provider_reconciled_at: null } as AccountingIntentRecord),
    null,
  );
  assert.equal(
    settlementObservedAt({
      ...intent,
      provider_reconciled_at: null,
      updated_at: "2026-08-20T12:11:00.000Z",
    } as AccountingIntentRecord),
    "2026-08-20T12:11:00.000Z",
  );
});

test("parse and refusal-code helpers refuse what they cannot read", () => {
  assert.equal(parseProductionGateClearance("Weather", JOB_ID, "short", { basis: "office_waiver" }), null);
  assert.equal(
    parseProductionGateClearance("Weather", JOB_ID, KEY, { basis: "office_waiver", extra: 1 }),
    null,
  );
  assert.equal(parseProductionGateClearance("Weather", JOB_ID, KEY, { basis: "nonsense" }), null);
  assert.equal(frappeRefusalCode("nothing machine readable here"), "production_gate_frappe_refused");
  assert.equal(
    frappeRefusalCode('{"exception":"production_gate_not_found: no such gate"}'),
    "production_gate_not_found",
  );
  // The module path is in every Frappe traceback and matches the code shape; a real
  // refusal once surfaced as the meaningless code `production_gate_api` because of it.
  assert.equal(
    frappeRefusalCode(
      'File "/apps/ironwrap_roofing/ironwrap_roofing/production_gate_api.py", line 400',
    ),
    "production_gate_frappe_refused",
  );
  // A rule with no code of its own is not given one.
  assert.equal(
    frappeRefusalCode(
      '{"exception":"frappe.exceptions.PermissionError: a waiver must be attributed to the current owner-level actor"}',
    ),
    "production_gate_frappe_refused",
  );
});
