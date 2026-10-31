import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAppApi, handleAuthenticatedRoute } from "../src/app-api.ts";
import { buildEstimatorWorkbenchReadModel, buildProductionRunwayReadModel } from "../src/app-read-models.ts";
import { authenticateAppRequest, sessionHashFor } from "../src/app-auth.ts";
import { buildNowReadModel } from "../src/now-read-model.ts";
import { readOfficeJobIdentitySources } from "../src/office-job-identity-read.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import {
  createQuoteRevisionApprovalRequest,
  quoteRevisionApprovalProjection,
  type CreateQuoteRevisionApprovalRequestInput,
} from "../src/quote-revision-approval-store.ts";

const TENANT = "ironwrap";
const AT = new Date(0).toISOString();
const OWNER = "appu_d5_owner";
const JOB_A = "job:office-d5:a";
const JOB_B = "job:office-d5:b";
const JOB_FOREIGN = "job:office-d5:foreign";
const QUOTE_A = "quote-revision:office-d5:a";
const QUOTE_B = "quote-revision:office-d5:b";
const QUOTE_FOREIGN = "quote-revision:office-d5:foreign";

type Identity = {
  id: string;
  roof_job_id: string;
  job_number: string | null;
  customer_display_name: string | null;
  address: string | null;
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  readonly queries: string[] = [];
  readonly bindings: Array<{ sql: string; count: number }> = [];
  failIdentity = false;
  beforeIdentityRead: (() => Promise<void>) | undefined;

  constructor(migrations?: string[]) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of migrations ?? readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    this.queries.push(sql);
    const identity = sql.includes("AS customer_display_name");
    if (identity && this.failIdentity) throw new Error("synthetic_identity_store_unavailable");
    const statement = this.raw.prepare(sql);
    return {
      bind: (...args: unknown[]) => {
        this.bindings.push({ sql, count: args.length });
        return {
          first: async <T>() => {
            if (identity) await this.beforeIdentityRead?.();
            return (statement.get(...args) ?? null) as T | null;
          },
          all: async <T>() => {
            if (identity) await this.beforeIdentityRead?.();
            return { results: statement.all(...args) as T[] };
          },
          run: async () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } }),
        };
      },
    };
  }
}

function fixture() {
  const db = new SqliteD1();
  const env = { DB: db as never } as AppEnv;
  db.raw.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Synthetic Owner', 'owner',
             'owner@example.invalid', 1, 'seed', ?, ?)`,
  ).run(OWNER, TENANT, AT, AT);
  for (const [suffix, tenant, job, quote] of [
    ["a", TENANT, JOB_A, QUOTE_A],
    ["b", TENANT, JOB_B, QUOTE_B],
    ["foreign", "iroof", JOB_FOREIGN, QUOTE_FOREIGN],
  ] as const) {
    const envelope = `envelope:office-d5:${suffix}`;
    const lead = `lead:office-d5:${suffix}`;
    const customer = `customer:office-d5:${suffix}`;
    const property = `property:office-d5:${suffix}`;
    db.raw.prepare(
      `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key,
        ts, status, created_at, updated_at)
       VALUES (?, 'website', 'Unrelated synthetic lead', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
    ).run(envelope, `lead-${suffix}@example.invalid`, `raw/synthetic/${suffix}.json`, AT, AT, AT);
    db.raw.prepare(
      `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
        contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'website', 'Unrelated synthetic lead', ?, 'qualified', 1, ?, ?)`,
    ).run(lead, tenant, envelope, `raw/synthetic/${suffix}.json`, `lead-${suffix}@example.invalid`, AT, AT);
    db.raw.prepare(
      `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
    ).run(customer, tenant, envelope, `Synthetic Customer ${suffix.toUpperCase()}`, `customer-${suffix}@example.invalid`, AT, AT);
    db.raw.prepare(
      `INSERT INTO operating_properties
       (property_id, tenant_id, property_key, lead_id, source_envelope_id,
        address_line1, city, province, postal_code, country, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Synthetic City', 'AB', 'T0A 0A0', 'Canada', 1, ?, ?)`,
    ).run(property, tenant, `synthetic-${suffix}`, lead, envelope, `Unit ${suffix.toUpperCase()}, 10 Synthetic Avenue`, AT, AT);
    db.raw.prepare(
      `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
        brand, job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified', 'qualification', 1, ?, ?)`,
    ).run(job, tenant, lead, customer, property, envelope, `SYN-${suffix.toUpperCase()}`, AT, AT);
    seedQuote(db.raw, tenant, job, customer, quote);
  }
  return { db, env };
}

function seedQuote(db: DatabaseSync, tenant: string, job: string, customer: string, quote: string) {
  const digest = hash("[]");
  const command = hash(quote);
  const permit = `permit:${quote}`;
  const aggregate = `customer-${quote}`;
  db.prepare(
    `INSERT INTO commercial_authority_permits
     (permit_id, tenant_id, policy_id, policy_version, policy_digest,
      policy_snapshot_json, action, actor_type, actor_id, aggregate_type,
      aggregate_id, aggregate_version, amount_cents, command_fingerprint,
      facts_digest, evidence_refs_json, evidence_digest, idempotency_key_hash,
      request_fingerprint, issued_at, expires_at)
     VALUES (?, ?, 'synthetic-d5-policy', 'v1', ?, '{}', 'quote.revision.record',
             'owner', ?, 'customer_quote', ?, 1, 0, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(permit, tenant, digest, OWNER, aggregate, command, digest, digest, command, command, AT, new Date(60_000).toISOString());
  db.prepare(
    `INSERT INTO commercial_quote_revisions
     (quote_revision_id, tenant_id, customer_quote_id, revision_number,
      roof_job_id, customer_id, status, currency, valid_until, subtotal_cents,
      tax_cents, total_cents, terms_json, terms_hash, evidence_refs_json,
      evidence_digest, policy_permit_id, authority_evidence_digest,
      command_fingerprint, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 'approved', 'CAD', ?, 0, 0, 0, '{}', ?, '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(quote, tenant, aggregate, job, customer, new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), hash("{}"), digest, permit, digest, command, command, AT);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function auth(role: AppRole = "owner", tenantId = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "synthetic-d5-csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64), session_created_at: AT,
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null,
      user_id: OWNER, tenant_id: tenantId, email_normalized: "owner@example.invalid",
      display_name: "Synthetic Owner", role, frappe_user_id: null, active: 1,
      created_by: "seed", created_at: AT, updated_at: AT,
    },
  };
}

function expected(suffix: string, job: string): Identity {
  return {
    id: job, roof_job_id: job, job_number: `SYN-${suffix}`,
    customer_display_name: `Synthetic Customer ${suffix}`,
    address: `Unit ${suffix}, 10 Synthetic Avenue, Synthetic City AB T0A 0A0, Canada`,
  };
}

async function get(env: AppEnv, path: string, actor = auth()) {
  return await handleAuthenticatedRoute(new Request(`https://app.example.invalid${path}`), env, actor);
}

async function approval(env: AppEnv, overrides: Partial<CreateQuoteRevisionApprovalRequestInput> = {}) {
  const correctionReason = "Synthetic correction after reviewed roof evidence.";
  const input: CreateQuoteRevisionApprovalRequestInput = {
    id: "quote-revision-approval:office-d5-synthetic-0001", tenantId: TENANT,
    prepareIdempotencyKey: "synthetic-d5-prepare", intentFingerprint: "a".repeat(64),
    actorUser: "estimator@example.invalid", siteId: "synthetic-d5-site", roofJobId: JOB_A,
    sourceCustomerQuoteId: QUOTE_A, sourceQuoteVersion: 1, sourceQuoteStatus: "Approved",
    sourceQuoteModified: AT, targetCustomerQuoteId: "quote-revision:office-d5:next",
    targetQuoteVersion: 2, correctionReason, requestText: correctionReason,
    writeArgsJson: "{}", previewJson: "{}", argsDigest: "b".repeat(64),
    previewDigest: "c".repeat(64), receiptPreviewDigest: "d".repeat(64),
    dryRunReceipt: "synthetic-d5-receipt".repeat(3),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), requestedByUserId: OWNER,
    requestedByFrappeUser: "owner@example.invalid", runId: "run:office-d5:approval", now: AT,
    ...overrides,
  };
  input.writeArgsJson = JSON.stringify({ roof_job_id: input.roofJobId, customer_quote_id: input.sourceCustomerQuoteId });
  input.previewJson = JSON.stringify({
    would_write: false, append_only: true,
    target: { doctype: "Customer Quote", name: input.targetCustomerQuoteId },
    source: { customer_quote_id: input.sourceCustomerQuoteId, roof_job: input.roofJobId,
      quote_version: input.sourceQuoteVersion, status: input.sourceQuoteStatus, modified: input.sourceQuoteModified },
    draft: { customer_quote_id: input.targetCustomerQuoteId, roof_job: input.roofJobId,
      quote_version: input.targetQuoteVersion, status: "Draft", supersedes: input.sourceCustomerQuoteId,
      correction_reason: input.correctionReason },
  });
  const created = await createQuoteRevisionApprovalRequest(env, input);
  assert.equal(created.kind, "created");
  return created.request;
}

const detailPath = (id: string) => `/api/v1/quote-revision-approvals/${encodeURIComponent(id)}`;

function getIdentity(env: AppEnv, path: string, actor = auth()) {
  return get(env, `${path}?include_job_identity=1`, actor);
}

test("D5 projects each exact estimator job customer and street through the route", async () => {
  const { db, env } = fixture();
  try {
    for (const [job, suffix] of [[JOB_A, "A"], [JOB_B, "B"]]) {
      const response = await getIdentity(env, `/api/v1/estimator/jobs/${encodeURIComponent(job)}`, auth("sales"));
      assert.equal(response.status, 200);
      const body = await response.json() as { job: Identity };
      for (const [key, value] of Object.entries(expected(suffix, job))) {
        assert.equal(body.job[key as keyof Identity], value, `${job}.${key}`);
      }
    }
  } finally { db.raw.close(); }
});

test("D5 projects exact production identities without changing list scopes or exposing contact data", async () => {
  const { db, env } = fixture();
  try {
    const response = await getIdentity(env, "/api/v1/production", auth("production"));
    assert.equal(response.status, 200);
    const body = await response.json() as { jobs: Array<Identity>; summary: { active_jobs: number } };
    assert.equal(body.summary.active_jobs, 2);
    for (const [job, suffix] of [[JOB_A, "A"], [JOB_B, "B"]]) {
      const row = body.jobs.find((entry) => entry.id === job)!;
      assert.equal(row.customer_display_name, expected(suffix, job).customer_display_name);
      assert.equal(row.address, expected(suffix, job).address);
    }
    assert.equal(body.jobs.some((row) => row.id === JOB_FOREIGN), false);
    assert.doesNotMatch(JSON.stringify(body), /customer-[ab]@|Unrelated synthetic lead|contact_email|contact_phone/);
  } finally { db.raw.close(); }
});

test("D5 quote detail binds the exact reviewed native revision while queue and mutation projections stay unchanged", async () => {
  const { db, env } = fixture();
  try {
    const record = await approval(env);
    const frozen = quoteRevisionApprovalProjection(record);
    const response = await getIdentity(env, detailPath(frozen.id), auth("sales"));
    assert.equal(response.status, 200);
    const detail = await response.json() as { job: Identity | null; approval: unknown };
    assert.deepEqual(detail.job, expected("A", JOB_A));
    assert.deepEqual(detail.approval, frozen);
    const identityCount = identityReads(db).length;
    const queue = await get(env, "/api/v1/quote-revision-approvals?include_job_identity=1");
    const body = await queue.json() as { approvals: unknown[] };
    assert.deepEqual(body.approvals, [frozen]);
    assert.equal(Object.hasOwn(body, "job"), false);
    assert.doesNotMatch(JSON.stringify(body), /Synthetic Customer|Synthetic Avenue|customer_display_name|contact_email|contact_phone/);
    const actor = auth();
    actor.session.frappe_user_id = "owner@example.invalid";
    actor.session.session_created_at = new Date().toISOString();
    env.APP_APPROVAL_APPROVER_ID = "owner@example.invalid";
    const rejected = await handleAuthenticatedRoute(new Request(
      `https://app.example.invalid${detailPath(frozen.id)}/reject?include_job_identity=1`,
      { method: "POST", headers: { "content-type": "application/json",
        "x-csrf-token": actor.csrfToken, "idempotency-key": "synthetic-d5-reject" },
        body: JSON.stringify({ version: 1, reason: "Synthetic owner declined this correction." }) },
    ), env, actor);
    assert.equal(rejected.status, 200);
    const mutation = await rejected.json() as { approval: { state: string; approved_snapshot: unknown } };
    assert.equal(mutation.approval.state, "denied");
    assert.deepEqual(mutation.approval.approved_snapshot, frozen.approved_snapshot);
    assert.equal(Object.hasOwn(mutation, "job"), false);
    assert.equal(identityReads(db).length, identityCount);
    assert.doesNotMatch(JSON.stringify(mutation), /Synthetic Customer|Synthetic Avenue|customer_display_name|contact_email|contact_phone/);
  } finally { db.raw.close(); }
});

test("D5 missing street stays null even with a locality, and identity changes advance source freshness", async () => {
  const { db, env } = fixture();
  try {
    const updated = new Date(120_000).toISOString();
    db.raw.prepare(
      `UPDATE operating_properties SET address_line1 = '   ', version = version + 1,
       updated_at = ? WHERE property_id = 'property:office-d5:a'`,
    ).run(updated);
    db.raw.prepare(
      `UPDATE operating_customers SET display_name = '  Synthetic Customer A  ',
       version = version + 1 WHERE customer_id = 'customer:office-d5:a'`,
    ).run();
    const estimator = await buildEstimatorWorkbenchReadModel(env, auth(), JOB_A, new Date(), { includeJobIdentity: true });
    const production = await buildProductionRunwayReadModel(env, auth(), { includeJobIdentity: true });
    assert.equal(estimator?.job.address, null);
    assert.equal(estimator.job.customer_display_name, "Synthetic Customer A");
    assert.equal(estimator.source_updated_at, updated);
    assert.equal(production.jobs.find((row) => row.id === JOB_A)?.address, null);
    assert.equal(production.source_updated_at, updated);
    const record = await approval(env);
    const detail = await (await getIdentity(env, detailPath(record.quote_revision_approval_id))).json() as { job: Identity };
    assert.equal(detail.job.address, null);
    assert.equal(detail.job.customer_display_name, "Synthetic Customer A");
  } finally { db.raw.close(); }
});

// Deliberately model damaged/older links without changing any production guard or migration.
// Foreign keys are restored before the readers run; a tenant join must not trust a bare ID.
function insertDamagedJob(db: DatabaseSync, job: string, customer: string, property: string | null) {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.prepare(
      `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
        job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES (?, ?, 'lead:office-d5:a', ?, ?, 'envelope:office-d5:a', NULL,
               'roof_replacement', 'qualified', 'qualification', 1, ?, ?)`,
    ).run(job, TENANT, customer, property, AT, AT);
  } finally { db.exec("PRAGMA foreign_keys = ON"); }
}

test("D5 missing customer/site and foreign links stay null in SQLite reads without borrowing another job", async () => {
  const { db, env } = fixture();
  try {
    const missing = "job:office-d5:missing-identity";
    const foreignLinks = "job:office-d5:foreign-links";
    insertDamagedJob(db.raw, missing, "customer:office-d5:absent", null);
    insertDamagedJob(db.raw, foreignLinks, "customer:office-d5:foreign", "property:office-d5:foreign");
    for (const job of [missing, foreignLinks]) {
      const estimator = await buildEstimatorWorkbenchReadModel(env, auth(), job, new Date(), { includeJobIdentity: true });
      assert.equal(estimator?.job.customer_display_name, null);
      assert.equal(estimator.job.address, null);
      const production = await buildProductionRunwayReadModel(env, auth(), { includeJobIdentity: true });
      const row = production.jobs.find((entry) => entry.id === job)!;
      assert.equal(row.customer_display_name, null);
      assert.equal(row.address, null);
      assert.equal(row.job_number, null);
    }
    const identities = await readOfficeJobIdentitySources(env, TENANT, [JOB_A, missing, foreignLinks, "job:office-d5:absent"]);
    assert.equal(identities.has("job:office-d5:absent"), false);
    assert.deepEqual(identities.get(JOB_A)?.job, expected("A", JOB_A));
    assert.equal(identities.get(foreignLinks)?.job.customer_display_name, null);
    assert.equal(identities.get(foreignLinks)?.job.address, null);
  } finally { db.raw.close(); }
});

test("D5 job and approval routes preserve missing/foreign tenant responses and production tenant isolation", async () => {
  const { db, env } = fixture();
  try {
    const record = await approval(env);
    for (const actor of [auth(), auth("owner", "iroof")]) {
      const absent = await getIdentity(env, "/api/v1/estimator/jobs/job%3Aoffice-d5%3Aabsent", actor);
      assert.equal(absent.status, 404);
    }
    assert.equal((await getIdentity(env, `/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, auth("owner", "iroof"))).status, 404);
    assert.equal((await getIdentity(env, detailPath(record.quote_revision_approval_id), auth("owner", "iroof"))).status, 404);
    assert.equal(identityReads(db).length, 0);
    const foreignProduction = await buildProductionRunwayReadModel(env, auth("production", "iroof"), { includeJobIdentity: true });
    assert.equal(foreignProduction.jobs.length, 1);
    assert.equal(foreignProduction.jobs[0].id, JOB_FOREIGN);
    assert.equal(foreignProduction.jobs[0].customer_display_name, "Synthetic Customer FOREIGN");
    assert.equal(foreignProduction.jobs[0].address, expected("FOREIGN", JOB_FOREIGN).address);
  } finally { db.raw.close(); }
});

for (const [label, overrides] of [
  ["another job's source quote", { sourceCustomerQuoteId: QUOTE_B }],
  ["wrong source version", { sourceQuoteVersion: 2, targetQuoteVersion: 3 }],
  ["foreign source quote", { sourceCustomerQuoteId: QUOTE_FOREIGN }],
  ["foreign job and source", { roofJobId: JOB_FOREIGN, sourceCustomerQuoteId: QUOTE_FOREIGN }],
  ["compatibility aggregate ID", { sourceCustomerQuoteId: `customer-${QUOTE_A}` }],
  ["missing native quote", { sourceCustomerQuoteId: "quote-revision:office-d5:absent" }],
  ["missing job", { roofJobId: "job:office-d5:absent" }],
] as Array<[string, Partial<CreateQuoteRevisionApprovalRequestInput>]>) {
  test(`D5 quote detail returns explicit null for ${label}`, async () => {
    const { db, env } = fixture();
    try {
      const record = await approval(env, overrides);
      const response = await getIdentity(env, detailPath(record.quote_revision_approval_id));
      assert.equal(response.status, 200);
      const detail = await response.json() as { job: Identity | null; approval: unknown };
      assert.equal(Object.hasOwn(detail, "job"), true);
      assert.equal(detail.job, null);
      assert.deepEqual(detail.approval, quoteRevisionApprovalProjection(record));
    } finally { db.raw.close(); }
  });
}

test("D5 quote detail requires the reviewed quote customer to equal the exact job customer", async () => {
  const { db, env } = fixture();
  try {
    const mismatched = "quote-revision:office-d5:customer-mismatch";
    seedQuote(db.raw, TENANT, JOB_A, "customer:office-d5:b", mismatched);
    const record = await approval(env, { sourceCustomerQuoteId: mismatched });
    const response = await getIdentity(env, detailPath(record.quote_revision_approval_id));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { job: Identity | null }).job, null);
  } finally { db.raw.close(); }
});

test("D5 older approval storage without native identity tables remains readable with explicit null", async () => {
  const db = new SqliteD1(["0011_app_bff_auth.sql", "0017_quote_revision_approval_requests.sql"]);
  const env = { DB: db as never } as AppEnv;
  try {
    db.raw.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, active, created_by, created_at, updated_at)
       VALUES (?, ?, 'owner@example.invalid', 'Synthetic Owner', 'owner', 1, 'seed', ?, ?)`,
    ).run(OWNER, TENANT, AT, AT);
    const record = await approval(env);
    const response = await getIdentity(env, detailPath(record.quote_revision_approval_id));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { job: Identity | null }).job, null);
  } finally { db.raw.close(); }
});

test("D5 retains all existing role gates before any database or identity read", async () => {
  let queries = 0;
  const env = { DB: { prepare: () => { queries++; throw new Error("unauthorized read"); } } } as unknown as AppEnv;
  for (const [path, roles] of [
    [`/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, ["field", "production", "accounting"]],
    ["/api/v1/production", ["field", "sales", "accounting"]],
    [detailPath("quote-revision-approval:office-d5-synthetic-0001"), ["field", "production", "accounting"]],
  ] as Array<[string, AppRole[]]>) {
    for (const role of roles) assert.equal((await getIdentity(env, path, auth(role))).status, 403);
  }
  await assert.rejects(buildEstimatorWorkbenchReadModel(env, auth("field"), JOB_A), /office_scope_required/);
  await assert.rejects(buildProductionRunwayReadModel(env, auth("sales")), /production_scope_required/);
  assert.equal(queries, 0);
});

test("D5 preserves production's bounded inventory and runs no query for an empty identity batch", async () => {
  const { db, env } = fixture();
  try {
    for (let index = 0; index < 101; index++) {
      db.raw.prepare(
        `INSERT INTO operating_roof_jobs
         (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
          job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
         SELECT ?, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
                ?, service_type, job_status, current_gate_state, version, created_at, updated_at
           FROM operating_roof_jobs WHERE roof_job_id = ?`,
      ).run(`job:office-d5:bounded:${index.toString().padStart(3, "0")}`, `SYN-BOUND-${index}`, JOB_A);
    }
    const production = await buildProductionRunwayReadModel(env, auth(), { includeJobIdentity: true });
    assert.equal(production.jobs.length, 100);
    assert.ok(production.partial_sources.includes("active_jobs"));
    assert.ok(production.jobs.every((job) => job.customer_display_name !== null && job.address !== null));
    const identityReads = db.bindings.filter((entry) => entry.sql.includes("AS customer_display_name"));
    assert.ok(identityReads.length > 0);
    assert.ok(identityReads.every((entry) => entry.count <= 100), "D1 allows at most 100 bound parameters per query");
    assert.equal(production.jobs.some((job) => job.id === JOB_FOREIGN), false);
    const queries = db.queries.length;
    assert.equal((await readOfficeJobIdentitySources(env, TENANT, [])).size, 0);
    assert.equal(db.queries.length, queries);
  } finally { db.raw.close(); }
});

const legacyQueries = [
  "", "?unrelated=1", "?include_job_identity", "?include_job_identity=",
  "?include_job_identity=0", "?include_job_identity=true", "?include_job_identity=01",
  "?include_job_identity=%201", "?include_job_identity=1%20", "?include_job_identity=+1",
  "?include_job_identity=1&include_job_identity=1",
  "?include_job_identity=0&include_job_identity=1",
  "?include_job_identity=1&include_job_identity=",
  "?include_job_identity=1&include%5Fjob_identity=1",
  "?%69nclude_job_identity=%31&include_job_identity=1",
];
const identityQueries = [
  "?include_job_identity=1", "?include_job_identity=%31",
  "?%69nclude_job_identity=1", "?unrelated=1&include_job_identity=1",
];
const identityReads = (db: SqliteD1) => db.queries.filter((sql) => sql.includes("AS customer_display_name"));

function assertRepresentation(body: Record<string, any>, included: boolean) {
  const jobs = body.jobs ?? (body.approval ? [] : [body.job]);
  if (body.approval) assert.equal(Object.hasOwn(body, "job"), included);
  for (const job of jobs) {
    assert.equal(Object.hasOwn(job, "customer_display_name"), included);
    assert.equal(Object.hasOwn(job, "address"), included);
  }
}

test("D5 capability defaults off and only one decoded value 1 selects identity on each GET", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 3_600_000 });
  const { db, env } = fixture();
  try {
    const record = await approval(env);
    for (const path of [
      `/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, "/api/v1/production",
      detailPath(record.quote_revision_approval_id),
    ]) {
      const baseline = await get(env, path);
      assert.equal(baseline.status, 200);
      const legacy = await baseline.json() as Record<string, any>;
      assertRepresentation(legacy, false);
      for (const query of legacyQueries) {
        const before = identityReads(db).length;
        const response = await get(env, path + query);
        assert.equal(response.status, 200, path + query);
        assert.deepEqual(await response.json(), legacy, path + query);
        assert.equal(identityReads(db).length, before, path + query);
      }
      for (const query of identityQueries) {
        const before = identityReads(db).length;
        const response = await get(env, path + query);
        assert.equal(response.status, 200, path + query);
        const body = await response.json() as Record<string, any>;
        assertRepresentation(body, true);
        assert.equal(identityReads(db).length, before + 1, path + query);
      }
    }
  } finally { db.raw.close(); }
});

test("D5 legacy queries and default readers exclude identity failures and identity freshness", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 3_600_000 });
  const { db, env } = fixture();
  try {
    const record = await approval(env);
    const estimator = await buildEstimatorWorkbenchReadModel(env, auth(), JOB_A, new Date(42));
    const production = await buildProductionRunwayReadModel(env, auth());
    assert.equal(estimator?.read_model_generated_at, new Date(42).toISOString());
    assertRepresentation(estimator!, false);
    assertRepresentation(production, false);
    const nowActors = [auth("production"), auth("owner"), auth("ops")];
    const now = await Promise.all(nowActors.map((actor) => buildNowReadModel(env, actor)));
    const paths = [
      `/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, "/api/v1/production",
      detailPath(record.quote_revision_approval_id),
    ];
    const baselines = await Promise.all(paths.map(async (path) => (await get(env, path)).json()));
    const updated = new Date(120_000).toISOString();
    db.raw.prepare("UPDATE operating_customers SET display_name = 'Synthetic changed identity', version = version + 1, updated_at = ?").run(updated);
    db.raw.prepare("UPDATE operating_properties SET address_line1 = '20 Synthetic New Avenue', version = version + 1, updated_at = ?").run(updated);
    const opted = await buildEstimatorWorkbenchReadModel(env, auth(), JOB_A, new Date(42), { includeJobIdentity: true });
    assert.equal(opted?.source_updated_at, updated);
    assert.equal(opted.job.customer_display_name, "Synthetic changed identity");
    const before = identityReads(db).length;
    db.failIdentity = true;
    for (const [index, path] of paths.entries()) {
      for (const query of legacyQueries) {
        const response = await get(env, path + query);
        assert.equal(response.status, 200, path + query);
        assert.deepEqual(await response.json(), baselines[index], path + query);
      }
    }
    assert.deepEqual(await buildEstimatorWorkbenchReadModel(env, auth(), JOB_A, new Date(42)), estimator);
    assert.deepEqual(await buildProductionRunwayReadModel(env, auth()), production);
    assert.deepEqual(await Promise.all(nowActors.map((actor) => buildNowReadModel(env, actor))), now);
    assert.equal(identityReads(db).length, before);
    for (const path of paths) assert.equal((await getIdentity(env, path)).status, 502);
    assert.equal(identityReads(db).length, before + paths.length);
  } finally { db.raw.close(); }
});

test("D5 an overlapping identity request cannot enable identity on a legacy request", async () => {
  const { db, env } = fixture();
  try {
    const record = await approval(env);
    for (const path of [
      `/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, "/api/v1/production",
      detailPath(record.quote_revision_approval_id),
    ]) {
      let started!: () => void;
      let release!: () => void;
      const reachedIdentity = new Promise<void>((resolve) => { started = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      db.beforeIdentityRead = async () => { started(); await barrier; };
      const opted = getIdentity(env, path);
      await reachedIdentity;
      const before = identityReads(db).length;
      try {
        const response = await get(env, path);
        assert.equal(response.status, 200);
        assertRepresentation(await response.json() as Record<string, any>, false);
        assert.equal(identityReads(db).length, before);
      } finally { release(); }
      const response = await opted;
      assert.equal(response.status, 200);
      assertRepresentation(await response.json() as Record<string, any>, true);
    }
  } finally { db.raw.close(); }
});

async function sessionFixture(db: SqliteD1, env: AppEnv, options: {
  tenant?: string; expired?: boolean; role?: AppRole;
} = {}) {
  const tenant = options.tenant ?? TENANT;
  const role = options.role ?? "owner";
  const user = `appu_d5_session_${tenant}_${role}`;
  const token = "t".repeat(43);
  Object.assign(env, {
    APP_BFF_ENABLED: "true", APP_TENANT_ID: TENANT, APP_TENANT_NAME: "Synthetic OS",
    APP_TENANT_BRAND: "Synthetic", APP_LOCALE: "en-CA", APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD", APP_PUBLIC_ORIGIN: "http://localhost:7100",
    APP_ALLOWED_ORIGINS: "http://localhost:7100", APP_ALLOW_INSECURE_LOCAL: "true",
    APP_AUTH_PEPPER: "synthetic-d5-session-pepper-which-is-not-a-secret",
  });
  db.raw.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'Synthetic Session User', ?, ?, 1, 'seed', ?, ?)`,
  ).run(user, tenant, `${user}@example.invalid`, ["owner", "field"].includes(role) ? role : "ops", role, AT, AT);
  db.raw.prepare(
    `INSERT INTO app_sessions
     (session_hash, user_id, tenant_id, created_at, expires_at, last_seen_at, created_ip_hash, created_user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(await sessionHashFor(env, token), user, tenant, AT,
    new Date(options.expired ? 1 : Date.now() + 3_600_000).toISOString(), AT, "a".repeat(64), "b".repeat(64));
  return (path: string, init?: RequestInit) => new Request(`http://localhost:7100${path}`, {
    ...init, headers: { cookie: `__Host-ironwrap_session=${token}`, ...init?.headers },
  });
}

test("D5 actual cookie authentication refuses missing, expired, foreign and denied sessions before identity reads", async () => {
  for (const options of [undefined, { expired: true }, { tenant: "iroof" }, { role: "accounting" as const }]) {
    const { db, env } = fixture();
    try {
      const request = await sessionFixture(db, env, options);
      const paths = [`/api/v1/estimator/jobs/${encodeURIComponent(JOB_A)}`, "/api/v1/production",
        detailPath("quote-revision-approval:office-d5-synthetic-0001")];
      for (const path of paths) {
        const req = options ? request(path + "?include_job_identity=1") : new Request(`http://localhost:7100${path}?include_job_identity=1`);
        const response = await handleAppApi(req, env, { waitUntil() {} } as never);
        assert.equal(response.status, options?.role ? 403 : 401);
      }
      assert.equal(identityReads(db).length, 0);
    } finally { db.raw.close(); }
  }
});

test("D5 the real production gate default runway remains independent of identity storage", async () => {
  const { db, env } = fixture();
  try {
    const request = await sessionFixture(db, env);
    const outcome = await authenticateAppRequest(request("/api/v1/production"), env);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("synthetic_session_setup_failed");
    db.failIdentity = true;
    const path = `/api/v1/production/jobs/${encodeURIComponent(JOB_A)}/gates/Deposit/clearance?include_job_identity=1`;
    const response = await handleAuthenticatedRoute(request(path, {
      method: "POST", headers: { "x-csrf-token": outcome.auth.csrfToken, "idempotency-key": "synthetic-d5-clearance-key" },
      body: JSON.stringify({ basis: "deposit_settlement" }),
    }), env, outcome.auth);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "production_gate_record_unavailable" });
    assert.equal(identityReads(db).length, 0);
    assert.ok(db.queries.some((sql) => sql.includes("FROM operating_production_gates")));
  } finally { db.raw.close(); }
});
