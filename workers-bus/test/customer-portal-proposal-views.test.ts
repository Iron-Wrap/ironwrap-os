// B1: the first time a customer's portal link opened a published proposal (0163).
//
// The database is the full migration chain and the commercial chain is recorded through the real
// permit, effect and ledger code, so every 0163 guard runs against the deployed schema. Nothing
// here mocks the clock: the guards compare `first_viewed_at` with D1's own clock. Portal requests
// are built the way the app builds them (app/src/portal/portal-api.ts): credentials omitted, so a
// request never carries the office cookie.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mock, test } from "node:test";

import worker from "../src/index.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import {
  admitCommercialPermit,
  commercialEffectAuthority,
  type CommercialAction,
  type CommercialPermitRecord,
} from "../src/commercial-authority.ts";
import {
  buildCommercialPublicationCommand,
  prepareCommercialProposal,
  prepareCommercialQuote,
  recordCommercialProposalPublication,
  recordCommercialProposalRevision,
  recordCommercialQuoteRevision,
  type RecordCommercialPublicationInput,
} from "../src/commercial-store.ts";
import { handleCustomerPortalLinks } from "../src/customer-portal.ts";
import {
  pruneCustomerPortalProposalViews,
  pruneCustomerPortalRecords,
} from "../src/customer-portal-store.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";

const TENANT = "ironwrap";
const ORIGIN = "https://app.example.com";
const OWNER_ID = "appu_owner_0001";
const LEAD_ID = "lead:portal-views:0001";
const CUSTOMER_ID = "customer:portal-views:0001";
const JOB_ID = "job:portal-views:0001";
const RAW_KEY = "raw/portal-views/0001.json";
const OFFICE = { ip: "198.51.100.7", userAgent: "Synthetic office browser" };
const CUSTOMER = { ip: "203.0.113.20", userAgent: "Synthetic customer phone" };
const A_YEAR = 365 * 24 * 60 * 60_000;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const EVIDENCE = [{ ref: "r2://commercial/evidence/portal-views.json", sha256: "a".repeat(64) }] as const;
const VIEW_COLUMNS = [
  "view_id",
  "tenant_id",
  "link_id",
  "roof_job_id",
  "customer_id",
  "proposal_pack_id",
  "proposal_revision_id",
  "publication_event_id",
  "first_viewed_at",
] as const;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(database: DatabaseSync, statement: StatementSync, args: unknown[] = []) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  /** `meta.changes` as D1 reports it: a total_changes() delta, trigger writes included. */
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const total = () =>
      Number((this.database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
    const before = total();
    this.statement.run(...this.args);
    return { success: true, meta: { changes: total() - before } };
  }
}

type TestEnv = AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };

interface Chain {
  proposalPackId: string;
  proposalRevisionId: string;
  publicationVersion: number;
}

/** `viewsEnabled: null` leaves the flag out of the environment altogether. */
function testEnv(db: SqliteD1, viewsEnabled: string | null): TestEnv {
  return {
    DB: db as never,
    RAW: { async head() { return null; }, async put() { return {}; } } as never,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    ...(viewsEnabled === null ? {} : { APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED: viewsEnabled }),
    APP_TENANT_ID: TENANT,
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: ORIGIN,
    APP_ALLOWED_ORIGINS: ORIGIN,
    APP_AUTH_PEPPER: "customer-portal-views-test-pepper-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    FROM_EMAIL: "portal@example.invalid",
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "customer-portal-views-test",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: new Date(Date.now() - A_YEAR).toISOString(),
      valid_until: new Date(Date.now() + A_YEAR).toISOString(),
      max_fact_age_seconds: 3_600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: [
        "quote.revision.record",
        "proposal.revision.record",
        "proposal.publish",
        "proposal.withdraw",
      ],
      allowed_actor_types: ["agent"],
      max_quote_total_cents: 1_000_000,
    }),
  } as TestEnv;
}

async function setup(viewsEnabled: string | null = "true") {
  const db = new SqliteD1();
  seedOperatingCore(db.raw);
  const env = testEnv(db, viewsEnabled);
  const chain = await seedPublishedProposal(env, new Date(Date.now() - 60_000));
  return { db, env, chain, close: () => db.raw.close() };
}

function seedOperatingCore(db: DatabaseSync): void {
  const at = new Date(Date.now() - 120_000).toISOString();
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner', NULL, 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, at, at);
  db.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES ('ow_portal_views_0001', 'website', 'Synthetic Customer', 'customer@example.invalid',
             '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(RAW_KEY, at, at, at);
  db.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, 'ow_portal_views_0001', ?, 'website', 'Synthetic Customer',
             'customer@example.invalid', 'qualified', 1, ?, ?)`,
  ).run(LEAD_ID, TENANT, RAW_KEY, at, at);
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, 'ow_portal_views_0001', ?, 'Synthetic Customer', 'customer@example.invalid',
             'active', 1, ?, ?)`,
  ).run(CUSTOMER_ID, TENANT, RAW_KEY, at, at);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
        source_raw_key, brand, service_type, job_status, current_gate_state, version, created_at,
        updated_at)
     VALUES (?, ?, ?, ?, NULL, 'ow_portal_views_0001', ?, 'ironwrap', 'roof_replacement',
             'qualified', 'qualification', 1, ?, ?)`,
  ).run(JOB_ID, TENANT, LEAD_ID, CUSTOMER_ID, RAW_KEY, at, at);
}

/** An approved quote, its proposal and a published first version, through the real ledger. */
async function seedPublishedProposal(env: TestEnv, base: Date): Promise<Chain> {
  const at = (offsetMs: number) => new Date(base.getTime() + offsetMs);
  const quoteId = "customer-quote:portal-views";
  const quoteRevisionId = "quote-revision:portal-views:1";
  const proposalPackId = "proposal-pack:portal-views";
  const proposalRevisionId = "proposal-revision:portal-views:1";
  const quote = {
    tenantId: TENANT,
    quoteRevisionId,
    customerQuoteId: quoteId,
    revisionNumber: 1,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    status: "approved" as const,
    currency: "CAD",
    validUntil: new Date(Date.now() + A_YEAR).toISOString().slice(0, 10),
    terms: TERMS,
    evidence: EVIDENCE,
    lines: [{
      lineId: "scope:roof",
      sequence: 1,
      kind: "labour" as const,
      description: "Install approved roofing scope",
      quantityMicros: 1_000_000,
      uom: "job",
      unitPriceCents: 100_000,
      taxCode: "GST",
      taxCents: 5_000,
    }],
    authority: { kind: "policy_permit" as const, permitId: "pending" },
    idempotencyKey: "portal-views:quote",
  };
  const preparedQuote = await prepareCommercialQuote(quote);
  quote.authority.permitId = (await admitFor(env, "quote.revision.record",
    { type: "customer_quote", id: quoteId, version: 1 }, preparedQuote.command,
    "permit:portal-views:quote", base, preparedQuote.totalCents)).permit_id;
  await recordCommercialQuoteRevision(env, quote, at(1_000));

  const proposal = {
    tenantId: TENANT,
    proposalRevisionId,
    proposalPackId,
    revisionNumber: 1,
    quoteRevisionId,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    title: "Synthetic roof replacement proposal",
    summary: "Approved scope, price and warranty for a synthetic job.",
    terms: TERMS,
    contentRef: "r2://commercial/proposals/portal-views.pdf",
    contentHash: "b".repeat(64),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit" as const, permitId: "pending" },
    idempotencyKey: "portal-views:proposal",
  };
  const preparedProposal = await prepareCommercialProposal(proposal);
  proposal.authority.permitId = (await admitFor(env, "proposal.revision.record",
    { type: "proposal", id: proposalPackId, version: 1 }, preparedProposal.command,
    "permit:portal-views:proposal", at(2_000))).permit_id;
  await recordCommercialProposalRevision(env, proposal, at(3_000));

  const chain = { proposalPackId, proposalRevisionId, publicationVersion: 1 };
  await recordPublicationTransition(env, chain, "published", "draft", at(4_000));
  return chain;
}

/** Publish, withdraw or republish through a permit, a succeeded effect and the ledger. */
async function recordPublicationTransition(
  env: TestEnv,
  chain: Chain,
  state: "published" | "withdrawn",
  previousState: "draft" | "published" | "withdrawn",
  now: Date,
): Promise<void> {
  const publicationVersion = chain.publicationVersion + (previousState === "draft" ? 0 : 1);
  const action = state === "published" ? "proposal.publish" : "proposal.withdraw";
  const input: RecordCommercialPublicationInput = {
    tenantId: TENANT,
    proposalRevisionId: chain.proposalRevisionId,
    proposalPackId: chain.proposalPackId,
    publicationVersion,
    previousState,
    state,
    authority: { kind: "policy_permit", permitId: "pending" },
    externalEffectId: `effect:portal-views:${publicationVersion}`,
    idempotencyKey: `portal-views:publication:${publicationVersion}`,
  };
  const permit = await admitFor(env, action,
    { type: "proposal_publication", id: chain.proposalPackId, version: publicationVersion },
    buildCommercialPublicationCommand(input), `permit:portal-views:publication:${publicationVersion}`, now);
  input.authority = { kind: "policy_permit", permitId: permit.permit_id };
  await runExternalEffect(env, {
    effectId: input.externalEffectId,
    tenantId: TENANT,
    actor: { type: "agent", id: "sales-orchestrator" },
    taskId: `commercial:${input.externalEffectId}`,
    authority: commercialEffectAuthority(permit),
    aggregate: { type: "proposal_publication", id: chain.proposalPackId, version: publicationVersion },
    intentId: chain.proposalRevisionId,
    action,
    request: { proposal_revision_id: chain.proposalRevisionId, state },
    provider: "customer-portal",
    providerAccountRef: TENANT,
    idempotencyKey: `effect:${input.idempotencyKey}`,
    deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    preconditions: { quote_status: "approved" },
    evidenceRefs: EVIDENCE.map(({ ref }) => ref),
    expectedReadback: { state },
    retryLimit: 1,
    compensationPlan: {},
    correlationId: input.externalEffectId!,
  }, {
    async dispatch() {
      return {
        outcome: "accepted" as const,
        value: { state },
        providerExternalId: input.externalEffectId!,
        providerResponse: { state },
        readback: { status: "match" as const, observed: { state } },
      };
    },
    async replay() {
      return { state };
    },
  }, now);
  await recordCommercialProposalPublication(env, input, new Date(now.getTime() + 1));
  chain.publicationVersion = publicationVersion;
}

async function admitFor(
  env: TestEnv,
  action: CommercialAction,
  aggregate: { type: "customer_quote" | "proposal" | "proposal_publication"; id: string; version: number },
  command: unknown,
  idempotencyKey: string,
  now: Date,
  amountCents: number | null = null,
): Promise<CommercialPermitRecord> {
  return (await admitCommercialPermit(env, {
    tenantId: TENANT,
    actor: { type: "agent", id: "sales-orchestrator" },
    action,
    aggregate,
    amountCents,
    command,
    facts: { source: "native-operating-core", observed_version: aggregate.version },
    factsObservedAt: now.toISOString(),
    evidence: EVIDENCE,
    idempotencyKey,
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  }, now)).permit;
}

function ownerAuth(): AuthContext {
  const now = new Date().toISOString();
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole("owner"),
    session: {
      session_hash: "c".repeat(64),
      session_created_at: now,
      session_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      user_id: OWNER_ID,
      tenant_id: TENANT,
      email_normalized: "owner@example.invalid",
      display_name: "Owner",
      role: "owner",
      frappe_user_id: null,
      active: 1,
      created_by: "test-seed",
      created_at: now,
      updated_at: now,
    },
  };
}

/** Issue a link the way the office does, from the office device. A new link revokes the old one. */
async function issueLink(env: TestEnv): Promise<{ token: string; linkId: string }> {
  const response = await handleCustomerPortalLinks(
    new Request(`${ORIGIN}/api/v1/customer-portal/links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-csrf-token": "csrf",
        "cf-connecting-ip": OFFICE.ip,
        "user-agent": OFFICE.userAgent,
      },
      body: JSON.stringify({
        roof_job_id: JOB_ID,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      }),
    }),
    env,
    ownerAuth(),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { portal_url: string; link: { id: string } };
  const token = new URLSearchParams(new URL(body.portal_url).hash.slice(1)).get("token");
  assert.ok(token);
  return { token, linkId: body.link.id };
}

/** An ExecutionContext that keeps what the Worker hands to waitUntil, so a test can await it. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    },
    pending,
    settled: () => Promise.allSettled(pending),
  };
}

/**
 * The resolve request exactly as the app sends it: JSON, no cookie (credentials are omitted), and
 * `staff_preview: true` only when the app knows an office sign-in is live in that browser. The
 * address and the user agent are what the browser and Cloudflare add.
 */
function resolveRequest(token: string, options: { device?: { ip: string; userAgent: string }; staffPreview?: boolean } = {}) {
  const device = options.device ?? CUSTOMER;
  return new Request(`${ORIGIN}/api/v1/customer-portal/resolve`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": device.ip,
      "user-agent": device.userAgent,
    },
    body: JSON.stringify(options.staffPreview ? { token, staff_preview: true } : { token }),
  });
}

/** Open the page and wait for whatever the Worker left running after the response. */
async function openPortal(
  env: TestEnv,
  token: string,
  options: { device?: { ip: string; userAgent: string }; staffPreview?: boolean } = {},
) {
  const run = executionContext();
  const response = await worker.fetch(resolveRequest(token, options), env as never, run.ctx as never);
  assert.equal(response.status, 200, await response.clone().text());
  const model = (await response.json()) as { proposal: unknown; read_model_generated_at: string };
  await run.settled();
  return model;
}

function views(db: SqliteD1): Array<Record<string, string>> {
  return db.raw
    .prepare("SELECT * FROM customer_portal_proposal_views ORDER BY first_viewed_at, link_id")
    .all() as Array<Record<string, string>>;
}

function publicationEventId(db: SqliteD1, chain: Chain, version: number): string {
  return (db.raw
    .prepare(
      `SELECT publication_event_id FROM commercial_proposal_publication_events
        WHERE proposal_pack_id = ? AND publication_version = ?`,
    )
    .get(chain.proposalPackId, version) as { publication_event_id: string }).publication_event_id;
}

let linkSequence = 0;

/** A link row written straight into D1, for the guards that the routes never let a request reach. */
function insertLink(
  db: SqliteD1,
  overrides: {
    tenantId?: string;
    issuedByUserId?: string;
    roofJobId?: string;
    customerId?: string;
    createdAt?: string;
    expiresAt?: string;
    revokedAt?: string;
  } = {},
): string {
  linkSequence += 1;
  const linkId = `portal_00000000-0000-4000-8000-${String(linkSequence).padStart(12, "0")}`;
  db.raw
    .prepare(
      `INSERT INTO customer_portal_links
         (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id, created_at,
          expires_at, revoked_at, revoked_by_user_id, last_accessed_at, access_count,
          issued_ip_hash, issued_user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    )
    .run(
      linkId,
      createHash("sha256").update(linkId).digest("hex"),
      overrides.tenantId ?? TENANT,
      overrides.roofJobId ?? JOB_ID,
      overrides.customerId ?? CUSTOMER_ID,
      overrides.issuedByUserId ?? OWNER_ID,
      overrides.createdAt ?? new Date(Date.now() - 60 * 60_000).toISOString(),
      overrides.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      overrides.revokedAt ?? null,
      overrides.revokedAt ? OWNER_ID : null,
      "d".repeat(64),
      "e".repeat(64),
    );
  return linkId;
}

function insertView(db: SqliteD1, row: Record<(typeof VIEW_COLUMNS)[number], string>, verb = "INSERT"): void {
  db.raw
    .prepare(
      `${verb} INTO customer_portal_proposal_views (${VIEW_COLUMNS.join(", ")})
       VALUES (${VIEW_COLUMNS.map(() => "?").join(", ")})`,
    )
    .run(...VIEW_COLUMNS.map((column) => row[column]));
}

function viewRow(
  db: SqliteD1,
  chain: Chain,
  linkId: string,
  overrides: Partial<Record<(typeof VIEW_COLUMNS)[number], string>> = {},
): Record<(typeof VIEW_COLUMNS)[number], string> {
  return {
    view_id: `portal-view:${createHash("sha256").update(`${linkId}|${JSON.stringify(overrides)}`).digest("hex")}`,
    tenant_id: TENANT,
    link_id: linkId,
    roof_job_id: JOB_ID,
    customer_id: CUSTOMER_ID,
    proposal_pack_id: chain.proposalPackId,
    proposal_revision_id: chain.proposalRevisionId,
    publication_event_id: publicationEventId(db, chain, 1),
    first_viewed_at: new Date().toISOString(),
    ...overrides,
  };
}

function refused(run: () => void, code: string): void {
  assert.throws(run, (error: unknown) => String(error).includes(code), `expected ${code}`);
}

test("only the first open of a published proposal through a link is kept", async () => {
  const h = await setup();
  const logged = mock.method(console, "log", () => {});
  try {
    const first = await issueLink(h.env);
    const page = await openPortal(h.env, first.token);
    assert.ok(page.proposal, "the page shows the published proposal");
    const recorded = views(h.db);
    assert.equal(recorded.length, 1);
    const [row] = recorded;
    const eventId = publicationEventId(h.db, h.chain, 1);
    assert.deepEqual(
      { ...row, first_viewed_at: undefined },
      {
        view_id: `portal-view:${createHash("sha256").update(`${TENANT}|${first.linkId}|${eventId}`).digest("hex")}`,
        tenant_id: TENANT,
        link_id: first.linkId,
        roof_job_id: JOB_ID,
        customer_id: CUSTOMER_ID,
        proposal_pack_id: h.chain.proposalPackId,
        proposal_revision_id: h.chain.proposalRevisionId,
        publication_event_id: eventId,
        first_viewed_at: undefined,
      },
    );
    assert.ok(Math.abs(Date.parse(row!.first_viewed_at!) - Date.now()) < 5_000);
    // Ids and one time: the row has no column for an address, a device or a later visit.
    assert.deepEqual(Object.keys(row!).sort(), [...VIEW_COLUMNS].sort());
    // The customer's page carries none of it.
    const served = JSON.stringify(page);
    assert.equal(served.includes(eventId), false);
    assert.equal(served.includes("viewed"), false);

    await openPortal(h.env, first.token);
    await openPortal(h.env, first.token);
    assert.deepEqual(views(h.db), recorded, "later opens add nothing and change nothing");
    assert.equal(
      logged.mock.calls.some((call) => String(call.arguments[0]).includes("customer_portal_proposal_view")),
      false,
      "a later open is skipped by the writer itself, not refused by D1",
    );

    // A new link starts its own first open of the same publication (and revokes the old link).
    const second = await issueLink(h.env);
    await openPortal(h.env, second.token);
    assert.deepEqual(views(h.db).map((view) => view.link_id), [first.linkId, second.linkId]);
  } finally {
    logged.mock.restore();
    h.close();
  }
});

test("no first open is recorded when the page shows no proposal", async () => {
  const h = await setup();
  try {
    await recordPublicationTransition(h.env, h.chain, "withdrawn", "published", new Date(Date.now() - 30_000));
    const { token } = await issueLink(h.env);
    const page = await openPortal(h.env, token);
    assert.equal(page.proposal, null);
    assert.deepEqual(views(h.db), []);
  } finally {
    h.close();
  }
});

test("only a request the app sends without the staff flag, from another device, is a customer's open", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    // An office sign-in is live in the browser, so the app marks the request as a staff preview.
    assert.ok((await openPortal(h.env, token, { staffPreview: true })).proposal, "staff still see the page");
    assert.deepEqual(views(h.db), [], "staff_preview never records");
    // No flag, but the device that issued the link.
    assert.ok((await openPortal(h.env, token, { device: OFFICE })).proposal);
    assert.deepEqual(views(h.db), [], "the issuer device never records");
    // No flag and another device: the customer's open.
    await openPortal(h.env, token);
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("the resolve body takes the token and, at most, staff_preview: true", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    for (const body of [
      { token, staff_preview: false },
      { token, staff_preview: "true" },
      { token, staff_preview: true, extra: 1 },
      { token, viewed: true },
    ]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/api/v1/customer-portal/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify(body),
        }),
        h.env as never,
        executionContext().ctx as never,
      );
      assert.equal(response.status, 404, JSON.stringify(body));
    }
    assert.deepEqual(views(h.db), []);
  } finally {
    h.close();
  }
});

test("an open from the device that issued the link is not a customer's open", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    assert.ok((await openPortal(h.env, token, { device: OFFICE })).proposal);
    assert.deepEqual(views(h.db), []);
    // Both hashes must match: the same address with another browser counts.
    await openPortal(h.env, token, { device: { ip: OFFICE.ip, userAgent: CUSTOMER.userAgent } });
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("a revoked link opens nothing and records nothing", async () => {
  const h = await setup();
  try {
    const { token, linkId } = await issueLink(h.env);
    const revoked = await handleCustomerPortalLinks(
      new Request(`${ORIGIN}/api/v1/customer-portal/links/${linkId}/revoke`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-csrf-token": "csrf" },
      }),
      h.env,
      ownerAuth(),
    );
    assert.equal(revoked.status, 200);
    const response = await worker.fetch(resolveRequest(token), h.env as never, executionContext().ctx as never);
    assert.equal(response.status, 404);
    assert.deepEqual(views(h.db), []);
  } finally {
    h.close();
  }
});

test("with the flag off or absent, an open records nothing", async () => {
  for (const flag of [null, "false", "TRUE"]) {
    const h = await setup(flag);
    try {
      const { token } = await issueLink(h.env);
      assert.ok((await openPortal(h.env, token)).proposal);
      assert.deepEqual(views(h.db), [], `flag ${flag}`);
    } finally {
      h.close();
    }
  }
});

test("the first-open write runs after the response, so a slow or failing write never touches the page", async () => {
  const h = await setup();
  const logged = mock.method(console, "log", () => {});
  try {
    const { token } = await issueLink(h.env);
    const expected = await openPortal({ ...h.env, APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED: "false" }, token);
    const sameModel = (model: { read_model_generated_at: string }) =>
      assert.deepEqual({ ...model, read_model_generated_at: null }, { ...expected, read_model_generated_at: null });
    const writing = (run: (statement: SqliteStatement) => Promise<unknown>) => ({
      prepare(sql: string) {
        const statement = h.db.prepare(sql);
        if (!sql.includes("INSERT INTO customer_portal_proposal_views")) return statement;
        return { bind: (...args: unknown[]) => ({ run: () => run(statement.bind(...args)) }) };
      },
      batch: (statements: SqliteStatement[]) => h.db.batch(statements),
    });

    // A write that has not finished: the page is already served, and the row lands later.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = executionContext();
    let timer!: ReturnType<typeof setTimeout>;
    const response = await Promise.race([
      worker.fetch(
        resolveRequest(token),
        { ...h.env, DB: writing(async (statement) => {
          await gate;
          return await statement.run();
        }) } as never,
        slow.ctx as never,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the page waited for the first-open write")), 5_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(response.status, 200);
    sameModel((await response.json()) as { read_model_generated_at: string });
    assert.equal(slow.pending.length, 1, "the write was handed to waitUntil");
    assert.deepEqual(views(h.db), [], "the page did not wait for the write");
    release();
    await slow.settled();
    assert.equal(views(h.db).length, 1);

    // A write that fails: the page is the same, and the failure is logged.
    const second = await issueLink(h.env);
    sameModel(await openPortal({ ...h.env, DB: writing(async () => {
      throw new Error("D1_ERROR: simulated outage");
    }) } as never, second.token));
    assert.equal(views(h.db).length, 1);
    // A database without 0163 at all.
    h.db.raw.exec("DROP TABLE customer_portal_proposal_views");
    const third = await issueLink(h.env);
    sameModel(await openPortal(h.env, third.token));

    const failures = logged.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call.arguments[0])) as { at?: string; error?: string };
        } catch {
          return {};
        }
      })
      .filter((entry) => entry.at === "customer_portal_proposal_view");
    assert.equal(failures.length, 2);
    assert.match(failures[0]!.error!, /simulated outage/);
    assert.match(failures[1]!.error!, /no such table: customer_portal_proposal_views/);
  } finally {
    logged.mock.restore();
    h.close();
  }
});

test("D1 refuses a first open whose link is not the row's own tenant, job and customer", async () => {
  const h = await setup();
  try {
    const linkId = insertLink(h.db);
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { tenant_id: "other-tenant" })),
      "customer_portal_proposal_view_link_mismatch");
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { roof_job_id: "job:portal-views:other" })),
      "customer_portal_proposal_view_link_mismatch");
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { customer_id: "customer:portal-views:other" })),
      "customer_portal_proposal_view_link_mismatch");
    insertView(h.db, viewRow(h.db, h.chain, linkId));
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("D1 refuses a first open through a link that was revoked or expired at that moment", async () => {
  const h = await setup();
  try {
    const revoked = insertLink(h.db, { revokedAt: new Date(Date.now() - 1_000).toISOString() });
    refused(() => insertView(h.db, viewRow(h.db, h.chain, revoked)), "customer_portal_proposal_view_link_not_live");
    const expired = insertLink(h.db, {
      createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    refused(() => insertView(h.db, viewRow(h.db, h.chain, expired)), "customer_portal_proposal_view_link_not_live");
    // Revoked after the open: the open happened while the link was live.
    const revokedLater = insertLink(h.db, { revokedAt: new Date(Date.now() + 30_000).toISOString() });
    insertView(h.db, viewRow(h.db, h.chain, revokedLater));
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("D1 refuses a first open of a publication that is not published or not this job's", async () => {
  const h = await setup();
  try {
    const linkId = insertLink(h.db);
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { proposal_pack_id: "proposal-pack:portal-views:other" })),
      "customer_portal_proposal_view_publication_mismatch");
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { proposal_revision_id: "proposal-revision:portal-views:other" })),
      "customer_portal_proposal_view_publication_mismatch");
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { publication_event_id: "commercial-publication:missing:0001" })),
      "customer_portal_proposal_view_publication_mismatch");
    // A link for another job, or for another customer, cannot record this job's proposal.
    for (const other of [
      { roof_job_id: "job:portal-views:other", customer_id: CUSTOMER_ID },
      { roof_job_id: JOB_ID, customer_id: "customer:portal-views:other" },
    ]) {
      const otherLink = insertLink(h.db, { roofJobId: other.roof_job_id, customerId: other.customer_id });
      refused(() => insertView(h.db, viewRow(h.db, h.chain, otherLink, other)),
        "customer_portal_proposal_view_publication_mismatch");
    }
    // Another tenant holding the same job and customer ids cannot record this tenant's proposal.
    h.db.raw
      .prepare(
        `INSERT INTO app_users
           (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
            active, created_by, created_at, updated_at)
         VALUES (?, 'other-tenant', 'other@example.invalid', 'Other owner', 'owner', 'owner', NULL, 1,
                 'test-seed', ?, ?)`,
      )
      .run("appu_other_0001", new Date().toISOString(), new Date().toISOString());
    const otherTenantLink = insertLink(h.db, { tenantId: "other-tenant", issuedByUserId: "appu_other_0001" });
    refused(() => insertView(h.db, viewRow(h.db, h.chain, otherTenantLink, { tenant_id: "other-tenant" })),
      "customer_portal_proposal_view_publication_mismatch");
    insertView(h.db, viewRow(h.db, h.chain, linkId));
    assert.equal(views(h.db).length, 1);
    // A withdrawal is not a published proposal.
    await recordPublicationTransition(h.env, h.chain, "withdrawn", "published", new Date(Date.now() - 30_000));
    refused(() => insertView(h.db, viewRow(h.db, h.chain, linkId, { publication_event_id: publicationEventId(h.db, h.chain, 2) })),
      "customer_portal_proposal_view_publication_mismatch");
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("D1 holds first_viewed_at to its own clock, within 60 seconds", async () => {
  const h = await setup();
  try {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    for (const offset of [-70_000, 70_000, -A_YEAR]) {
      refused(() => insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), { first_viewed_at: at(offset) })),
        "customer_portal_proposal_view_clock_skew");
    }
    for (const offset of [-50_000, 50_000]) {
      insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), { first_viewed_at: at(offset) }));
    }
    refused(() => insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), { first_viewed_at: "2026-13-45T99:99:99.999Z" })),
      "customer_portal_proposal_view_clock_skew");
    refused(() => insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), { first_viewed_at: at(0).replace("Z", "+00:00") })),
      "CHECK constraint failed");
    assert.equal(views(h.db).length, 2);
  } finally {
    h.close();
  }
});

test("first-open rows are never updated, and REPLACE cannot rewrite them", async () => {
  const h = await setup();
  try {
    const linkId = insertLink(h.db);
    const row = viewRow(h.db, h.chain, linkId);
    insertView(h.db, row);
    const kept = views(h.db);
    refused(() => h.db.raw.prepare("UPDATE customer_portal_proposal_views SET first_viewed_at = ?").run(new Date().toISOString()),
      "customer_portal_proposal_views_append_only");
    refused(() => h.db.raw.prepare("DELETE FROM customer_portal_proposal_views").run(),
      "customer_portal_proposal_views_append_only");
    refused(() => insertView(h.db, { ...row, first_viewed_at: new Date().toISOString() }, "INSERT OR REPLACE"),
      "customer_portal_proposal_views_append_only");
    refused(() => insertView(h.db, { ...row, view_id: `portal-view:${"f".repeat(64)}` }, "REPLACE"),
      "customer_portal_proposal_views_append_only");
    refused(() => insertView(h.db, { ...row, link_id: insertLink(h.db) }, "REPLACE"),
      "customer_portal_proposal_views_append_only");
    assert.deepEqual(views(h.db), kept);
  } finally {
    h.close();
  }
});

/**
 * A row written before today's clock allows it: the open D1 would have accepted at `firstViewedAt`.
 * The insert guard holds every new row to D1's own clock, so the test sets it aside for this one
 * insert and restores the exact trigger D1 had.
 */
function insertHistoricView(db: SqliteD1, row: Record<(typeof VIEW_COLUMNS)[number], string>): void {
  const guard = db.raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_portal_proposal_views_validate_insert'")
    .get() as { sql: string };
  db.raw.exec("DROP TRIGGER customer_portal_proposal_views_validate_insert");
  try {
    insertView(db, row);
  } finally {
    db.raw.exec(guard.sql);
  }
}

test("a first open younger than 3 years survives the retention prune and refuses a direct DELETE", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    await openPortal(h.env, token);
    const kept = views(h.db);
    assert.equal(kept.length, 1);
    assert.equal(await pruneCustomerPortalProposalViews(h.env), 0);
    assert.deepEqual(views(h.db), kept);
    refused(() => h.db.raw.prepare("DELETE FROM customer_portal_proposal_views WHERE view_id = ?").run(kept[0]!.view_id),
      "customer_portal_proposal_views_append_only");
    // Days short of 3 years (3 calendar years are 1095 or 1096 days) is still young.
    const young = insertLink(h.db, { createdAt: new Date(Date.now() - 3 * A_YEAR).toISOString() });
    insertHistoricView(h.db, viewRow(h.db, h.chain, young, {
      first_viewed_at: new Date(Date.now() - 3 * A_YEAR + 2 * 24 * 60 * 60_000).toISOString(),
    }));
    refused(() => h.db.raw.prepare("DELETE FROM customer_portal_proposal_views WHERE link_id = ?").run(young),
      "customer_portal_proposal_views_append_only");
    assert.equal(await pruneCustomerPortalProposalViews(h.env), 0);
    assert.equal(views(h.db).length, 2);
  } finally {
    h.close();
  }
});

test("a first open older than 3 years is deleted by the retention prune, and then its link prunes", async () => {
  const h = await setup();
  try {
    // A link the customer opened just over 3 years ago (days past any leap day), which ended soon after.
    const old = insertLink(h.db, {
      createdAt: new Date(Date.now() - 3 * A_YEAR - 20 * 24 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 3 * A_YEAR + 20 * 24 * 60 * 60_000).toISOString(),
    });
    insertHistoricView(h.db, viewRow(h.db, h.chain, old, {
      first_viewed_at: new Date(Date.now() - 3 * A_YEAR - 10 * 24 * 60 * 60_000).toISOString(),
    }));
    const { token } = await issueLink(h.env);
    await openPortal(h.env, token);
    assert.equal(views(h.db).length, 2);
    const linkIds = () =>
      (h.db.raw.prepare("SELECT link_id FROM customer_portal_links").all() as Array<{ link_id: string }>).map((row) => row.link_id);

    // While the row lives, the link prune keeps its link.
    await pruneCustomerPortalRecords(h.env);
    assert.ok(linkIds().includes(old));

    assert.equal(await pruneCustomerPortalProposalViews(h.env), 1);
    assert.deepEqual(views(h.db).map((view) => view.link_id).includes(old), false);
    assert.equal(views(h.db).length, 1, "the fresh open stays");
    await pruneCustomerPortalRecords(h.env);
    assert.equal(linkIds().includes(old), false, "its link prunes once the row is gone");
  } finally {
    h.close();
  }
});

/**
 * One row naming `linkId` in each table that references a portal link. A seeder writes only its own
 * table's row; anything else it needs (an acceptance's challenge) names a separate long-lived link,
 * so the link under test is kept for this table's row alone.
 */
const LINK_REFERENCE_SEEDERS: Record<string, (h: Awaited<ReturnType<typeof setup>>, linkId: string) => void> = {
  customer_portal_acceptance_challenges: (h, linkId) => {
    insertChallenge(h.db, linkId);
  },
  customer_portal_acceptance_intents: (h, linkId) => {
    const challengeId = insertChallenge(h.db, insertLink(h.db, { expiresAt: new Date(Date.now() + 5 * A_YEAR).toISOString() }));
    const acceptanceId = `acceptance_${hex(`acceptance|${linkId}`).slice(0, 32)}`;
    h.db.raw.prepare(
      `INSERT INTO customer_portal_acceptance_intents
         (acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id, tenant_id,
          portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version,
          proposal_pack_id, terms_hash, terms_json, signer_name, signer_ip_hash, accepted_at,
          receipt_key, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quote:portal-views', 1, ?, ?, '{}', 'Synthetic Signer', ?,
               ?, ?, 'receipt_pending', ?, ?)`,
    ).run(
      acceptanceId, hex(`key|${acceptanceId}`), hex(`request|${acceptanceId}`), challengeId, TENANT, linkId,
      JOB_ID, CUSTOMER_ID, hex("email"), h.chain.proposalPackId, hex("terms"), hex("ip"), new Date().toISOString(),
      `customer-contract-acceptance/v1/${TENANT}/${acceptanceId}.json`, new Date().toISOString(), new Date().toISOString(),
    );
  },
  customer_portal_decision_intents: (h, linkId) => {
    const decisionId = `decision_${hex(`decision|${linkId}`).slice(0, 32)}`;
    h.db.raw.prepare(
      `INSERT INTO customer_portal_decision_intents
         (decision_id, idempotency_key_hash, request_fingerprint, tenant_id, portal_link_id,
          roof_job_id, customer_id, option_package_id, option_tier, option_label, selected_at,
          selector_ip_hash, receipt_key, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'option:portal-views', 'Better', 'Synthetic charcoal standing seam',
               ?, ?, ?, 'receipt_pending', ?, ?)`,
    ).run(
      decisionId, hex(`key|${decisionId}`), hex(`request|${decisionId}`), TENANT, linkId, JOB_ID, CUSTOMER_ID,
      new Date().toISOString(), hex("ip"), `customer-portal-decision/v1/${TENANT}/${decisionId}.json`,
      new Date().toISOString(), new Date().toISOString(),
    );
  },
  customer_portal_proposal_views: (h, linkId) => {
    insertView(h.db, viewRow(h.db, h.chain, linkId));
  },
};

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function insertChallenge(db: SqliteD1, linkId: string): string {
  const challengeId = `acceptance_challenge_${hex(`challenge|${linkId}`).slice(0, 32)}`;
  const createdAt = new Date().toISOString();
  db.raw.prepare(
    `INSERT INTO customer_portal_acceptance_challenges
       (challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
        quote_id, quote_version, proposal_pack_id, terms_hash, terms_json, request_ip_hash,
        request_user_agent_hash, state, created_at, expires_at, sent_at, provider_message_id,
        consumed_at, invalidated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'quote:portal-views', 1, 'proposal-pack:portal-views', ?, '{}', ?, ?,
             'invalidated', ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    challengeId, hex(`token|${challengeId}`), TENANT, linkId, JOB_ID, CUSTOMER_ID, hex("email"), hex("terms"),
    hex("ip"), hex("ua"), createdAt, new Date(Date.now() + 60 * 60_000).toISOString(), createdAt,
  );
  return challengeId;
}

test("the daily link prune keeps every link a RESTRICT key names, read from the schema, and deletes the rest", async () => {
  const h = await setup();
  try {
    const referencers = h.db.raw
      .prepare(
        `SELECT m.name AS child, fk."from" AS column, fk.on_delete
           FROM sqlite_master m, pragma_foreign_key_list(m.name) fk
          WHERE m.type = 'table' AND fk."table" = 'customer_portal_links'
          ORDER BY m.name, fk."from"`,
      )
      .all() as Array<{ child: string; column: string; on_delete: string }>;
    assert.ok(referencers.length >= 4, "the schema has tables that reference a portal link");
    for (const { child, on_delete } of referencers) assert.equal(on_delete, "RESTRICT", child);
    assert.deepEqual(
      referencers.map(({ child }) => child).filter((child) => !(child in LINK_REFERENCE_SEEDERS)),
      [],
      "every table that references a portal link needs a seeder here, and the prune must keep its links",
    );

    // Every link below ends within the hour; the prune runs as if two years had passed.
    const named = new Map<string, string>();
    for (const { child, column } of referencers) {
      const linkId = insertLink(h.db);
      LINK_REFERENCE_SEEDERS[child]!(h, linkId);
      const count = h.db.raw.prepare(`SELECT COUNT(*) AS count FROM ${child} WHERE ${column} = ?`).get(linkId) as { count: number };
      assert.equal(count.count, 1, `${child} names its own link`);
      named.set(child, linkId);
    }
    const unreferenced = insertLink(h.db);
    const linkIds = () =>
      (h.db.raw.prepare("SELECT link_id FROM customer_portal_links").all() as Array<{ link_id: string }>).map((row) => row.link_id);
    const before = linkIds();

    await pruneCustomerPortalRecords(h.env, new Date(Date.now() + 2 * A_YEAR));

    const after = linkIds();
    for (const [child, linkId] of named) assert.ok(after.includes(linkId), `the link ${child} names is kept`);
    assert.equal(after.includes(unreferenced), false, "a link nothing names is deleted");
    assert.deepEqual(after.sort(), before.filter((linkId) => linkId !== unreferenced).sort());
  } finally {
    h.close();
  }
});
