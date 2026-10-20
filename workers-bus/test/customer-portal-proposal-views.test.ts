// B1: the first time a customer's portal link opened a published proposal (0163).
//
// The database is the full migration chain and the commercial chain is recorded through the real
// permit, effect and ledger code, so every 0163 guard runs against the deployed schema. Nothing
// here mocks the clock: the guard compares `first_viewed_at` with D1's own clock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mock, test } from "node:test";

import worker from "../src/index.ts";
import { randomToken, sessionHashFor } from "../src/app-auth.ts";
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
  pruneCustomerPortalRecords,
  readProposalFirstViewedAt,
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

async function open(
  env: TestEnv,
  token: string,
  device = CUSTOMER,
  cookie?: string,
): Promise<Response> {
  return await worker.fetch(
    new Request(`${ORIGIN}/api/v1/customer-portal/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "cf-connecting-ip": device.ip,
        "user-agent": device.userAgent,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ token }),
    }),
    env as never,
    {} as never,
  );
}

async function openPortal(env: TestEnv, token: string, device = CUSTOMER, cookie?: string) {
  const response = await open(env, token, device, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { proposal: unknown; read_model_generated_at: string };
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
  overrides: { roofJobId?: string; customerId?: string; createdAt?: string; expiresAt?: string; revokedAt?: string } = {},
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
      TENANT,
      overrides.roofJobId ?? JOB_ID,
      overrides.customerId ?? CUSTOMER_ID,
      OWNER_ID,
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
  try {
    const first = await issueLink(h.env);
    const page = await openPortal(h.env, first.token);
    assert.ok(page.proposal, "the page shows the published proposal");
    const recorded = views(h.db);
    assert.equal(recorded.length, 1);
    const [row] = recorded;
    assert.deepEqual(
      { ...row, view_id: undefined, first_viewed_at: undefined },
      {
        view_id: undefined,
        tenant_id: TENANT,
        link_id: first.linkId,
        roof_job_id: JOB_ID,
        customer_id: CUSTOMER_ID,
        proposal_pack_id: h.chain.proposalPackId,
        proposal_revision_id: h.chain.proposalRevisionId,
        publication_event_id: publicationEventId(h.db, h.chain, 1),
        first_viewed_at: undefined,
      },
    );
    assert.match(row!.view_id!, /^portal-view:[0-9a-f]{64}$/);
    assert.ok(Math.abs(Date.parse(row!.first_viewed_at!) - Date.now()) < 5_000);
    // Ids and one time: the row has no column for an address, a device or a later visit.
    assert.deepEqual(Object.keys(row!).sort(), [...VIEW_COLUMNS].sort());
    // The customer's page carries none of it.
    const served = JSON.stringify(page);
    assert.equal(served.includes(publicationEventId(h.db, h.chain, 1)), false);
    assert.equal(served.includes("viewed"), false);

    await openPortal(h.env, first.token);
    await openPortal(h.env, first.token);
    assert.deepEqual(views(h.db), recorded, "later opens add nothing and change nothing");

    // A new link starts its own first open of the same publication (and revokes the old link).
    const second = await issueLink(h.env);
    await openPortal(h.env, second.token);
    assert.deepEqual(views(h.db).map((view) => view.link_id), [first.linkId, second.linkId]);
    assert.equal(
      await readProposalFirstViewedAt(h.env, {
        tenantId: TENANT,
        proposalPackId: h.chain.proposalPackId,
        proposalRevisionId: h.chain.proposalRevisionId,
      }),
      row!.first_viewed_at,
      "the staff read gives the earliest open",
    );
  } finally {
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

test("a request carrying a live staff session is not a customer's open", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    const sessionToken = randomToken();
    h.db.raw
      .prepare(
        `INSERT INTO app_sessions
           (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
            created_ip_hash, created_user_agent_hash, device_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        await sessionHashFor(h.env, sessionToken),
        OWNER_ID,
        TENANT,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 60 * 60_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        "d".repeat(64),
        "e".repeat(64),
      );
    const lastSeen = () =>
      (h.db.raw.prepare("SELECT last_seen_at FROM app_sessions").get() as { last_seen_at: string }).last_seen_at;
    const seenBefore = lastSeen();

    const staffPage = await openPortal(h.env, token, CUSTOMER, `__Host-ironwrap_session=${sessionToken}`);
    assert.ok(staffPage.proposal, "staff still see the page");
    assert.deepEqual(views(h.db), []);
    assert.equal(lastSeen(), seenBefore, "the check reads the session without touching it");

    // A cookie that names no live session is not staff.
    await openPortal(h.env, token, CUSTOMER, `__Host-ironwrap_session=${randomToken()}`);
    assert.equal(views(h.db).length, 1);
  } finally {
    h.close();
  }
});

test("an open from the device that issued the link is not a customer's open", async () => {
  const h = await setup();
  try {
    const { token } = await issueLink(h.env);
    assert.ok((await openPortal(h.env, token, OFFICE)).proposal);
    assert.deepEqual(views(h.db), []);
    // Both hashes must match: the same address with another browser counts.
    await openPortal(h.env, token, { ip: OFFICE.ip, userAgent: CUSTOMER.userAgent });
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
    assert.equal((await open(h.env, token)).status, 404);
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

test("a failed first-open write never breaks the customer's page", async () => {
  const h = await setup();
  const logged = mock.method(console, "log", () => {});
  try {
    const { token } = await issueLink(h.env);
    const expected = await openPortal({ ...h.env, APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED: "false" }, token);

    // D1 failing on the write itself.
    const failingDb = {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO customer_portal_proposal_views")) throw new Error("D1_ERROR: simulated outage");
        return h.db.prepare(sql);
      },
      batch: (statements: SqliteStatement[]) => h.db.batch(statements),
    };
    const page = await openPortal({ ...h.env, DB: failingDb as never }, token);
    assert.deepEqual({ ...page, read_model_generated_at: null }, { ...expected, read_model_generated_at: null });

    // A database without 0163 at all.
    h.db.raw.exec("DROP TABLE customer_portal_proposal_views");
    const withoutTable = await openPortal(h.env, token);
    assert.deepEqual({ ...withoutTable, read_model_generated_at: null }, { ...expected, read_model_generated_at: null });

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
    // Another job's and customer's link cannot record this job's proposal.
    const otherLink = insertLink(h.db, { roofJobId: "job:portal-views:other", customerId: "customer:portal-views:other" });
    refused(() => insertView(h.db, viewRow(h.db, h.chain, otherLink, {
      roof_job_id: "job:portal-views:other",
      customer_id: "customer:portal-views:other",
    })), "customer_portal_proposal_view_publication_mismatch");
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
    refused(() => insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), { first_viewed_at: at(0).replace("Z", "+00:00") })),
      "CHECK constraint failed");
    assert.equal(views(h.db).length, 2);
  } finally {
    h.close();
  }
});

test("first-open rows are append-only and REPLACE cannot rewrite them", async () => {
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
    assert.deepEqual(views(h.db), kept);
  } finally {
    h.close();
  }
});

test("the daily portal prune keeps a link that a first open names and never deletes the record", async () => {
  const h = await setup();
  try {
    const viewed = await issueLink(h.env);
    await openPortal(h.env, viewed.token);
    const unviewed = insertLink(h.db);
    const recorded = views(h.db);
    assert.equal(recorded.length, 1);

    // Past the portal's one-year link window for both links.
    await pruneCustomerPortalRecords(h.env, new Date(Date.now() + 2 * A_YEAR));
    const links = (h.db.raw.prepare("SELECT link_id FROM customer_portal_links ORDER BY link_id").all() as Array<{ link_id: string }>)
      .map((link) => link.link_id);
    assert.deepEqual(links, [viewed.linkId]);
    assert.equal(links.includes(unviewed), false);
    assert.deepEqual(views(h.db), recorded);
    assert.deepEqual(h.db.raw.prepare("SELECT * FROM customer_portal_access_throttles").all(), []);
  } finally {
    h.close();
  }
});

test("the staff read counts only the live publication, at or after the latest send attempt started", async () => {
  const h = await setup();
  try {
    const read = () =>
      readProposalFirstViewedAt(h.env, {
        tenantId: TENANT,
        proposalPackId: h.chain.proposalPackId,
        proposalRevisionId: h.chain.proposalRevisionId,
      });
    assert.equal(await read(), null, "nothing opened yet");
    const { token } = await issueLink(h.env);
    await openPortal(h.env, token);
    const firstOpen = views(h.db)[0]!.first_viewed_at;
    assert.equal(await read(), firstOpen);

    // Withdrawn: no live publication, so no open counts.
    await recordPublicationTransition(h.env, h.chain, "withdrawn", "published", new Date(Date.now() + 1_000));
    assert.equal(await read(), null);

    // Republished as version 3 by a send that starts after the customer's open.
    const republishAt = new Date(Date.now() + 5_000);
    await recordPublicationTransition(h.env, h.chain, "published", "withdrawn", republishAt);
    assert.equal(await read(), null, "an open of version 1 does not answer for version 3");
    await openPortal(h.env, token);
    const beforeAttempt = views(h.db).filter((view) => view.publication_event_id === publicationEventId(h.db, h.chain, 3));
    assert.equal(beforeAttempt.length, 1);
    assert.ok(beforeAttempt[0]!.first_viewed_at < republishAt.toISOString());
    assert.equal(await read(), null, "an open before the latest attempt started does not count");

    const afterAttempt = new Date(republishAt.getTime() + 10_000).toISOString();
    insertView(h.db, viewRow(h.db, h.chain, insertLink(h.db), {
      publication_event_id: publicationEventId(h.db, h.chain, 3),
      first_viewed_at: afterAttempt,
    }));
    assert.equal(await read(), afterAttempt);
    assert.equal(
      await readProposalFirstViewedAt(h.env, {
        tenantId: "other-tenant",
        proposalPackId: h.chain.proposalPackId,
        proposalRevisionId: h.chain.proposalRevisionId,
      }),
      null,
    );
  } finally {
    h.close();
  }
});
