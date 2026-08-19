// Route-level cover for the service lifecycle BFF surface. These exercise `handleAuthenticatedRoute`
// itself -- authority, request shape, identifier derivation, and the codes a refused transition
// returns -- rather than the store, which `service-case-store.test.ts` covers directly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const OWNER_ID = "appu_owner_0001";
const OPS_ID = "appu_ops_0001";
const FIELD_ID = "appu_field_0001";
const DIGEST_INTAKE = "a".repeat(64);
const DIGEST_TRIAGE = "b".repeat(64);
const DIGEST_DIAGNOSIS = "c".repeat(64);
const DIGEST_PARTS = "d".repeat(64);
const DIGEST_FIELD = "e".repeat(64);
const DIGEST_CUSTOMER = "f".repeat(64);
const DIGEST_RECOVERY = "1".repeat(64);

/** Extended SQLite result codes D1 names in its wrapper; the low byte of each is `SQLITE_CONSTRAINT`. */
const SQLITE_EXTENDED_CONSTRAINT: Record<number, string> = {
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
};

/**
 * Real D1 never surfaces SQLite's bare text. It wraps every failure as
 * `D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`, and it says
 * `SQLITE_CONSTRAINT` where `node:sqlite` says `constraint failed`. Forwarding the bare message is
 * precisely what let the 502-for-409 mapping defect ship green -- every one of `0056`'s 38
 * `RAISE(ABORT, ...)` refusals answered `502 service_case_store_unavailable` in production while
 * this suite saw a clean `409` (Multica ELEC-22 §5). So the fake speaks production's dialect: the
 * refusal codes asserted below are now reached through the same string the Worker really catches.
 */
function asD1Error(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const errcode = (error as { errcode?: number }).errcode ?? 0;
  if ((errcode & 0xff) !== 19) return new Error(`D1_ERROR: ${error.message}: SQLITE_ERROR`);
  const extended = SQLITE_EXTENDED_CONSTRAINT[errcode];
  const detail = extended ? `SQLITE_CONSTRAINT (extended: ${extended})` : "SQLITE_CONSTRAINT";
  return new Error(`D1_ERROR: ${error.message}: ${detail}`);
}

function throughD1<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw asD1Error(error);
  }
}

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  /** Fires as each statement is prepared -- the seam a racing writer needs to land mid-call. */
  onPrepare: ((sql: string) => void) | null = null;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of ["0011_app_bff_auth.sql", "0056_service_case_lifecycle.sql"]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const now = "2026-08-18T09:00:00.000Z";
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insert.run(OWNER_ID, TENANT, "owner@example.invalid", "Owner", "owner", "owner@example.invalid", now, now);
    insert.run(OPS_ID, TENANT, "ops@example.invalid", "Ops", "ops", "ops@example.invalid", now, now);
    insert.run(FIELD_ID, TENANT, "field@example.invalid", "Field", "field", "field@example.invalid", now, now);
  }

  /**
   * Real D1 counts trigger-written rows in `meta.changes`; `sqlite3_changes()`, which
   * `node:sqlite` reports, does not. The lifecycle tables are covered in AFTER-UPDATE triggers, so
   * a fake that forwarded `result.changes` would report 1 where production reports 2 and hide any
   * guard that mis-reads a triggered write. `total_changes()` deltas match D1's semantics.
   */
  private totalChanges(): number {
    return Number((this.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
  }

  prepare(sql: string) {
    this.onPrepare?.(sql);
    return {
      bind: (...args: unknown[]) => {
        const statement = throughD1(() => this.raw.prepare(sql));
        return {
          first: async <T>() =>
            throughD1(() => (statement.get(...(args as never[])) ?? null) as T | null),
          all: async <T>() =>
            throughD1(() => ({ results: statement.all(...(args as never[])) as T[] })),
          run: async () =>
            throughD1(() => {
              const before = this.totalChanges();
              statement.run(...(args as never[]));
              return { success: true, meta: { changes: this.totalChanges() - before } };
            }),
        };
      },
    };
  }
}

function env(db = new SqliteD1()): AppEnv {
  return { DB: db as never, APP_ALLOW_INSECURE_LOCAL: "true" } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  const now = new Date();
  const userId = role === "owner" ? OWNER_ID : role === "ops" ? OPS_ID : FIELD_ID;
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: new Date(now.getTime() - 60_000).toISOString(),
      session_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      revoked_at: null,
      user_id: userId,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: OWNER_ID,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  } as AuthContext;
}

function request(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  csrf = true,
): Request {
  const headers = new Headers();
  if (csrf) headers.set("x-csrf-token", "csrf");
  if (body) headers.set("content-type", "application/json");
  return new Request(`https://app.example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(
  appEnv: AppEnv,
  role: AppRole,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  csrf = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleAuthenticatedRoute(request(method, path, body, csrf), appEnv, auth(role));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function intakeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_id: "CUST-0001",
    property_key: "PROP-0001",
    roof_job_id: "JOB-0001",
    warranty_packet_id: "WP-0001",
    severity: "standard",
    symptom_code: "interior_water_stain",
    reported_channel: "phone",
    consent_ref: "CONSENT-0001",
    intake_evidence_digest: DIGEST_INTAKE,
    response_sla_minutes: 1440,
    intake_code: "callback_reported",
    ...overrides,
  };
}

function caseId(payload: Record<string, unknown>): string {
  return (payload.service_case as Record<string, unknown>).service_case_id as string;
}

/** Drives one case from intake to a verified remedy, returning its server-minted ids. */
async function throughRemedy(
  appEnv: AppEnv,
  role: AppRole = "ops",
): Promise<{ id: string; remedyId: string }> {
  const opened = await call(appEnv, role, "POST", "/api/v1/service-cases", intakeBody());
  assert.equal(opened.status, 201);
  const id = caseId(opened.body);
  const triage = await call(appEnv, role, "POST", `/api/v1/service-cases/${id}/triage`, {
    advisory_source: "none",
    final_category: "material_manufacturer",
    responsibility: "manufacturer",
    evidence_digest: DIGEST_TRIAGE,
  });
  assert.equal(triage.status, 201);
  const diagnosis = await call(appEnv, role, "POST", `/api/v1/service-cases/${id}/diagnoses`, {
    root_cause_code: "granule_loss_defect",
    corrective_action_code: "replace_affected_field",
    work_package_ref: "wp:JOB-0001:service",
    work_package_version: 1,
    warranty_reserve_cents: 120_000,
    evidence_digest: DIGEST_DIAGNOSIS,
  });
  assert.equal(diagnosis.status, 201);
  const remedy = await call(appEnv, role, "POST", `/api/v1/service-cases/${id}/remedies`, {
    scheduled_start_at: "2026-08-25T14:00:00.000Z",
    scheduled_end_at: "2026-08-25T20:00:00.000Z",
    parts_manifest_digest: DIGEST_PARTS,
  });
  assert.equal(remedy.status, 201);
  const remedyId = (remedy.body.remedy as Record<string, unknown>).remedy_id as string;
  const verified = await call(
    appEnv,
    role,
    "POST",
    `/api/v1/service-cases/${id}/remedies/${remedyId}/verification`,
    {
      outcome: "verified",
      field_evidence_digest: DIGEST_FIELD,
      cost_actual_cents: 98_000,
    },
  );
  assert.equal(verified.status, 200);
  return { id, remedyId };
}

test("the office can run a callback from intake to an accepted, closed remedy over the API", async () => {
  const appEnv = env();
  const { id, remedyId } = await throughRemedy(appEnv);

  const accepted = await call(
    appEnv,
    "ops",
    "POST",
    `/api/v1/service-cases/${id}/remedies/${remedyId}/customer-decision`,
    {
      decision: "accepted",
      acceptance_ref: "CUSTDEC-0001",
      evidence_digest: DIGEST_CUSTOMER,
    },
  );
  assert.equal(accepted.status, 200);
  assert.equal((accepted.body.service_case as Record<string, unknown>).state, "customer_accepted");

  const closed = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/closure`, {
    closure_reason: "remedied_accepted",
    evidence_digest: DIGEST_CUSTOMER,
  });
  assert.equal(closed.status, 200);
  assert.equal((closed.body.service_case as Record<string, unknown>).state, "closed");

  const detail = await call(appEnv, "ops", "GET", `/api/v1/service-cases/${id}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body.service_case as Record<string, unknown>).closure_reason, "remedied_accepted");
  assert.equal((detail.body.triage as unknown[]).length, 1);
  assert.equal((detail.body.diagnoses as unknown[]).length, 1);
  assert.equal((detail.body.remedies as unknown[]).length, 1);
  assert.deepEqual((detail.body.events as { event_type: string }[]).map((event) => event.event_type), [
    "case_opened",
    "triaged",
    "diagnosed",
    "remedy_issued",
    "remedy_verified",
    "customer_accepted",
    "closed",
  ]);
  const cost = detail.body.cost as Record<string, number>;
  assert.equal(cost.warranty_reserve_cents, 120_000);
  assert.equal(cost.actual_cost_cents, 98_000);
  assert.equal(cost.net_cost_cents, 98_000);

  const queue = await call(appEnv, "ops", "GET", "/api/v1/service-cases");
  assert.equal(queue.status, 200);
  assert.equal((queue.body.service_cases as unknown[]).length, 1);
  // A tenant identifier is deployment state, not office information.
  assert.equal((queue.body.service_cases as Record<string, unknown>[])[0]?.tenant_id, undefined);
});

test("triage attribution is the authenticated session, never a field in the request body", async () => {
  const appEnv = env();
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  const id = caseId(opened.body);

  const triage = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/triage`, {
    advisory_source: "model",
    advisory_category: "workmanship",
    advisory_confidence_bps: 8_200,
    final_category: "workmanship",
    responsibility: "ironwrap_workmanship",
    evidence_digest: DIGEST_TRIAGE,
  });
  assert.equal(triage.status, 201);
  const record = triage.body.triage as Record<string, unknown>;
  assert.equal(record.decided_by_user_id, OPS_ID);
  assert.equal(record.decided_by_role, "ops");
  assert.equal(record.authority_kind, "human");
  assert.equal(record.advisory_category, "workmanship");
  assert.equal((opened.body.service_case as Record<string, unknown>).opened_by_user_id, OPS_ID);
});

test("a model advisory without its confidence is refused before it reaches the store", async () => {
  const appEnv = env();
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  const id = caseId(opened.body);

  const refused = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/triage`, {
    advisory_source: "model",
    advisory_category: "workmanship",
    final_category: "workmanship",
    responsibility: "ironwrap_workmanship",
    evidence_digest: DIGEST_TRIAGE,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_service_triage_advisory");
});

test("a second report of the same symptom is answered as a linked duplicate", async () => {
  const appEnv = env();
  const first = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  assert.equal(first.body.result, "opened");

  const second = await call(
    appEnv,
    "ops",
    "POST",
    "/api/v1/service-cases",
    intakeBody({ reported_channel: "portal" }),
  );
  assert.equal(second.status, 201);
  assert.equal(second.body.result, "duplicate");
  assert.equal((second.body.service_case as Record<string, unknown>).state, "closed");
  assert.equal(
    (second.body.original_case as Record<string, unknown>).service_case_id,
    caseId(first.body),
  );
});

test("the field role never reaches the service lifecycle, and no office write survives a missing CSRF token", async () => {
  const appEnv = env();
  const denied = await call(appEnv, "field", "GET", "/api/v1/service-cases");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "office_role_required");

  const noCsrf = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody(), false);
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const queue = await call(appEnv, "ops", "GET", "/api/v1/service-cases");
  assert.equal((queue.body.service_cases as unknown[]).length, 0);
});

test("a remedy is only reachable under the case that owns it", async () => {
  const appEnv = env();
  const first = await throughRemedy(appEnv);
  const second = await call(
    appEnv,
    "ops",
    "POST",
    "/api/v1/service-cases",
    intakeBody({ symptom_code: "ridge_cap_lifting" }),
  );
  const otherCaseId = caseId(second.body);

  const crossed = await call(
    appEnv,
    "ops",
    "POST",
    `/api/v1/service-cases/${otherCaseId}/remedies/${first.remedyId}/verification`,
    { outcome: "verified", field_evidence_digest: DIGEST_FIELD, cost_actual_cents: 1_000 },
  );
  assert.equal(crossed.status, 404);
});

test("an illegal lifecycle step is answered with the rule that refused it, not a server fault", async () => {
  const appEnv = env();
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  const id = caseId(opened.body);

  // Remedy work cannot be issued off a case that was never diagnosed.
  const early = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/remedies`, {
    scheduled_start_at: "2026-08-25T14:00:00.000Z",
    scheduled_end_at: "2026-08-25T20:00:00.000Z",
    parts_manifest_digest: DIGEST_PARTS,
  });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "service_case_diagnosis_required");

  // An untriaged intake case may close as withdrawn but never as a remedied one.
  const wrongClosure = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/closure`, {
    closure_reason: "remedied_accepted",
  });
  assert.equal(wrongClosure.status, 409);
  assert.equal(wrongClosure.body.error, "service_case_closure_reason_not_allowed");

  const withdrawn = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/closure`, {
    closure_reason: "withdrawn",
  });
  assert.equal(withdrawn.status, 200);
  assert.equal((withdrawn.body.service_case as Record<string, unknown>).state, "closed");
});

test("an unexpected field is refused rather than silently dropped", async () => {
  const appEnv = env();
  const refused = await call(
    appEnv,
    "ops",
    "POST",
    "/api/v1/service-cases",
    intakeBody({ opened_by_user_id: OWNER_ID }),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "unexpected_field");
});

test("an emergency callback cannot be filed behind a routine response window", async () => {
  const appEnv = env();
  const refused = await call(
    appEnv,
    "ops",
    "POST",
    "/api/v1/service-cases",
    intakeBody({ severity: "emergency", response_sla_minutes: 1440 }),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "service_case_emergency_sla_exceeded");
});

test("cost recovery is the owner's decision and runs the one-attempt effect shape without a provider", async () => {
  const appEnv = env();
  const { id, remedyId } = await throughRemedy(appEnv, "owner");
  await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/remedies/${remedyId}/customer-decision`,
    { decision: "accepted", acceptance_ref: "CUSTDEC-0001", evidence_digest: DIGEST_CUSTOMER },
  );

  const claimBody = {
    counterparty_kind: "manufacturer",
    counterparty_ref: "SUP-SHINGLE-CO",
    claim_basis_code: "material_defect_granule_loss",
    claimed_amount_cents: 150_000,
    evidence_digest: DIGEST_RECOVERY,
    deadline_at: "2036-09-19T09:10:00.000Z",
  };
  const opsDenied = await call(
    appEnv,
    "ops",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims`,
    claimBody,
  );
  assert.equal(opsDenied.status, 403);
  assert.equal(opsDenied.body.error, "owner_role_required");

  const claimed = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims`,
    claimBody,
  );
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.result, "opened");
  const claim = claimed.body.claim as Record<string, unknown>;
  assert.equal(claim.state, "pending");
  assert.equal(claim.actor_user_id, OWNER_ID);
  assert.equal(claim.actor_role, "owner");
  assert.match(String(claim.authority_ref), /^svc_triage_/);
  assert.equal(claim.correlation_id, `svc-case:${id}`);
  // The effect-runtime request identity is internal; the office reads the claim, not its hash.
  assert.equal(claim.request_hash, undefined);
  assert.equal(claim.tenant_id, undefined);

  // The same claim requested twice is one intent, not two attempts at the same money.
  const again = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims`,
    claimBody,
  );
  assert.equal(again.status, 200);
  assert.equal(again.body.result, "already_recorded");
  assert.equal((again.body.claim as Record<string, unknown>).claim_id, claim.claim_id);

  const claimId = claim.claim_id as string;
  const leased = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/lease`,
    { lease_seconds: 3_600 },
  );
  assert.equal(leased.status, 200);
  assert.equal((leased.body.claim as Record<string, unknown>).state, "leased");

  const release = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/lease`,
    { lease_seconds: 3_600 },
  );
  assert.equal(release.status, 409);
  assert.equal(release.body.result, "already_attempted");

  const settled = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/result`,
    {
      outcome: "succeeded",
      result_ref: "manufacturer-claim:MC-0001",
      recovered_amount_cents: 110_000,
    },
  );
  assert.equal(settled.status, 200);
  assert.equal((settled.body.claim as Record<string, unknown>).state, "succeeded");

  const detail = await call(appEnv, "owner", "GET", `/api/v1/service-cases/${id}`);
  const cost = detail.body.cost as Record<string, number>;
  assert.equal(cost.recovered_cents, 110_000);
  assert.equal(cost.net_cost_cents, 0);
});

test("an uncertain claim is reconciled by the owner and never retried behind their back", async () => {
  const appEnv = env();
  const { id } = await throughRemedy(appEnv, "owner");
  const claimed = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims`,
    {
      counterparty_kind: "supplier",
      counterparty_ref: "SUP-METAL-CO",
      claim_basis_code: "short_shipped_coil",
      claimed_amount_cents: 90_000,
      evidence_digest: DIGEST_RECOVERY,
      deadline_at: "2036-09-19T09:10:00.000Z",
    },
  );
  const claimId = (claimed.body.claim as Record<string, unknown>).claim_id as string;
  await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/lease`,
    { lease_seconds: 3_600 },
  );
  const uncertain = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/result`,
    { outcome: "uncertain", result_ref: "supplier-claim:unknown", result_code: "submission_timeout" },
  );
  assert.equal((uncertain.body.claim as Record<string, unknown>).state, "uncertain");

  const reconciled = await call(
    appEnv,
    "owner",
    "POST",
    `/api/v1/service-cases/${id}/cost-recovery-claims/${claimId}/reconcile`,
    { outcome: "executed", reconciliation_ref: "statement:2026-09", recovered_amount_cents: 40_000 },
  );
  assert.equal(reconciled.status, 200);
  const record = reconciled.body.claim as Record<string, unknown>;
  assert.equal(record.state, "reconciled");
  assert.equal(record.recovered_amount_cents, 40_000);
  assert.equal(record.attempt_count, 1);
});

test("an unknown service path is a 404, not a partially matched route", async () => {
  const appEnv = env();
  const missing = await call(appEnv, "ops", "GET", "/api/v1/service-cases/svc_case_missing");
  assert.equal(missing.status, 404);

  const badTail = await call(appEnv, "ops", "POST", "/api/v1/service-cases/svc_case_x/unknown", {});
  assert.equal(badTail.status, 404);
});

test("the callback desk lists every open case, and only narrows when the caller asks it to", async () => {
  const appEnv = env();
  const symptoms = [
    "interior_water_stain",
    "ridge_cap_lifting",
    "granule_loss_visible",
    "flashing_separation",
    "soffit_water_ingress",
    "gutter_overflow",
  ];
  for (const symptom_code of symptoms) {
    const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody({ symptom_code }));
    assert.equal(opened.status, 201);
    assert.equal(opened.body.result, "opened");
  }

  // The PWA calls this path with no query at all. An absent `limit` is the default, never a bound:
  // `Number(null)` is 0, and a parser that only screens for NaN collapses the desk to one case.
  const desk = await call(appEnv, "ops", "GET", "/api/v1/service-cases");
  assert.equal(desk.status, 200);
  assert.equal((desk.body.service_cases as unknown[]).length, symptoms.length);

  const blank = await call(appEnv, "ops", "GET", "/api/v1/service-cases?limit=");
  assert.equal((blank.body.service_cases as unknown[]).length, symptoms.length);

  const unparseable = await call(appEnv, "ops", "GET", "/api/v1/service-cases?limit=all");
  assert.equal((unparseable.body.service_cases as unknown[]).length, symptoms.length);

  // An explicit bound is still a bound, and the clamp still holds at both ends.
  const asked = await call(appEnv, "ops", "GET", "/api/v1/service-cases?limit=2");
  assert.equal((asked.body.service_cases as unknown[]).length, 2);

  const clamped = await call(appEnv, "ops", "GET", "/api/v1/service-cases?limit=0");
  assert.equal((clamped.body.service_cases as unknown[]).length, 1);
});

test("a transition whose version another writer already took is still refused with a conflict", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  assert.equal(opened.status, 201);
  const id = caseId(opened.body);

  // A racing writer takes version 1 between this request's read and its write -- the one thing the
  // optimistic-concurrency guard exists to catch. Once fired, the seam clears itself.
  db.onPrepare = (sql) => {
    if (!sql.startsWith("UPDATE service_cases")) return;
    db.onPrepare = null;
    db.raw.exec(`UPDATE service_cases SET version = version + 1 WHERE service_case_id = '${id}'`);
  };

  const stale = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/triage`, {
    advisory_source: "none",
    final_category: "material_manufacturer",
    responsibility: "manufacturer",
    evidence_digest: DIGEST_TRIAGE,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "service_case_transition_conflict");

  // The refusal is real: the case never moved, and no transition event was appended.
  const detail = await call(appEnv, "ops", "GET", `/api/v1/service-cases/${id}`);
  assert.equal((detail.body.service_case as Record<string, unknown>).state, "intake");
  assert.deepEqual(
    (detail.body.events as { event_type: string }[]).map((event) => event.event_type),
    ["case_opened"],
  );
});

test("D1's error wrapper does not turn a refused transition into a server fault", async () => {
  // The exact string the Worker catches in production. `node:sqlite` reports SQLite's bare message,
  // real D1 wraps it, and a start-anchored match on the rule code saw only the former -- which is
  // how all 38 of `0056`'s refusals reached callers as `502` (Multica ELEC-22 §5).
  const wrapped = asD1Error(
    Object.assign(new Error("service_case_closure_reason_not_allowed"), { errcode: 1811 }),
  ) as Error;
  assert.equal(
    wrapped.message,
    "D1_ERROR: service_case_closure_reason_not_allowed: SQLITE_CONSTRAINT " +
      "(extended: SQLITE_CONSTRAINT_TRIGGER)",
  );

  const appEnv = env();
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  const id = caseId(opened.body);

  const withdrawn = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/closure`, {
    closure_reason: "withdrawn",
  });
  assert.equal(withdrawn.status, 200);

  // Triage on a closed case -- ELEC-22 §5's fourth probe, which answered `502` on real D1. The
  // closure already took the case to its next version, so `0056`'s triage guard is the trigger that
  // refuses it; the refusal only ever reaches the route through D1's wrapper, and it is the
  // caller's mistake, so it must read as one.
  const late = await call(appEnv, "ops", "POST", `/api/v1/service-cases/${id}/triage`, {
    advisory_source: "none",
    final_category: "material_manufacturer",
    responsibility: "manufacturer",
    evidence_digest: DIGEST_TRIAGE,
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "service_case_triage_case_version_mismatch");

  // It fails closed, exactly as the trigger intends: no state moved, no event appended.
  const detail = await call(appEnv, "ops", "GET", `/api/v1/service-cases/${id}`);
  assert.equal((detail.body.service_case as Record<string, unknown>).state, "closed");
  assert.deepEqual(
    (detail.body.events as { event_type: string }[]).map((event) => event.event_type),
    ["case_opened", "closed"],
  );
});

test("a genuine store fault is still answered as a server fault, not as a refused transition", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const opened = await call(appEnv, "ops", "POST", "/api/v1/service-cases", intakeBody());
  const id = caseId(opened.body);

  // A missing table carries a token shaped exactly like a lifecycle rule code but no constraint
  // marker. Widening the 409 branch must not let that masquerade as a business outcome.
  db.onPrepare = (sql) => {
    if (!sql.includes("service_case_events")) return;
    throw new Error("D1_ERROR: no such table: service_case_events: SQLITE_ERROR");
  };

  const broken = await call(appEnv, "ops", "GET", `/api/v1/service-cases/${id}`);
  assert.equal(broken.status, 502);
  assert.equal(broken.body.error, "service_case_store_unavailable");
});
