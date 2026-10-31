import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { randomToken, sha256Hex } from "../src/app-auth.ts";
import { permissionsForRole } from "../src/app-types.ts";
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
  type RecordCommercialProposalInput,
  type RecordCommercialPublicationInput,
  type RecordCommercialQuoteInput,
} from "../src/commercial-store.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import { reconcileCustomerContractAcceptanceAttempts } from "../src/customer-contract-acceptance.ts";

const TENANT = "ironwrap";
/**
 * Every row here is seeded off the wall clock, and the routes read the wall clock too, so anything
 * the fixture means as "still current" is anchored to the run. A far-future calendar pin only
 * postpones the day the window stops containing `now` and the whole chain fails closed.
 */
const A_YEAR = 365 * 24 * 60 * 60_000;
const POLICY_VALID_FROM = new Date(Date.now() - A_YEAR).toISOString();
const POLICY_VALID_UNTIL = new Date(Date.now() + A_YEAR).toISOString();
const QUOTE_VALID_UNTIL = new Date(Date.now() + A_YEAR)
  .toISOString()
  .slice(0, 10);
const PORTAL_LINK_EXPIRES_AT = new Date(Date.now() + A_YEAR).toISOString();
const PUBLIC_ORIGIN = "https://app.example.com";
const OWNER_ID = "appu_owner_0001";
const ENVELOPE_ID = "ow_acceptance_0001";
const LEAD_ID = "lead:acceptance:0001";
const CUSTOMER_ID = "customer:acceptance:0001";
const JOB_ID = "job:acceptance:0001";
const CUSTOMER_EMAIL = "Ada.Customer@Example.com";
const EMAIL_HASH = createHash("sha256")
  .update(CUSTOMER_EMAIL.toLowerCase())
  .digest("hex");
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const TERMS_JSON = JSON.stringify(TERMS);
const TERMS_HASH = createHash("sha256").update(TERMS_JSON).digest("hex");
const EVIDENCE = [
  { ref: "r2://commercial/evidence/acceptance.json", sha256: "a".repeat(64) },
] as const;

interface NativeChain {
  quoteId: string;
  quoteRevisionId: string;
  proposalPackId: string;
  proposalRevisionId: string;
  publicationVersion: number;
}

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  throwNextBatchAfterCommit = false;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seedOperatingCore(this.raw);
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
      if (this.throwNextBatchAfterCommit) {
        this.throwNextBatchAfterCommit = false;
        throw new Error("simulated_lost_d1_response");
      }
      return results;
    } catch (error) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
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

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...this.args);
    return {
      success: true,
      meta: { changes: totalChanges(this.database) - before },
    };
  }
}

test("scheduled acceptance recovery advances beyond its first bounded window", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    acceptance_id: `acceptance_${String(index + 1).padStart(16, "0")}`,
    tenant_id: TENANT,
  }));
  const attempted: string[] = [];
  let cursor: { last_tenant_id: string; last_acceptance_id: string } | null = null;
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("commercial_deposit_derivation_cursors")) return cursor as T | null;
          if (sql.includes("FROM commercial_deposit_derivations")) {
            attempted.push(String(args[1]));
            return null;
          }
          throw new Error(`unexpected recovery first: ${sql}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("state = 'receipt_stored'")) return { results: [] };
          if (sql.includes("state = 'accepted'")) {
            let selected = rows;
            if (sql.includes("acceptance_id > ?")) {
              selected = selected.filter((row) => row.acceptance_id > String(args[1]));
            } else if (sql.includes("acceptance_id <= ?")) {
              selected = selected.filter((row) => row.acceptance_id <= String(args[1]));
            }
            return { results: selected.slice(0, 100) as T[] };
          }
          throw new Error(`unexpected recovery all: ${sql}`);
        },
        async run(): Promise<{ success: true }> {
          if (sql.includes("INSERT INTO commercial_deposit_derivation_cursors")) {
            cursor = {
              last_tenant_id: String(args[0]),
              last_acceptance_id: String(args[1]),
            };
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
  const env = { DB: db, APP_TENANT_ID: TENANT } as unknown as AppEnv;

  await reconcileCustomerContractAcceptanceAttempts(env, new Date("2026-08-24T10:00:00.000Z"));
  await reconcileCustomerContractAcceptanceAttempts(env, new Date("2026-08-24T10:05:00.000Z"));

  assert.ok(attempted.includes(rows[100]!.acceptance_id));
});

class MemoryR2 {
  readonly objects = new Map<
    string,
    { body: string; object: Record<string, unknown> }
  >();

  async head(key: string) {
    return this.objects.get(key)?.object ?? null;
  }

  async put(
    key: string,
    value: string,
    options: {
      sha256?: string;
      customMetadata?: Record<string, string>;
      onlyIf?: unknown;
    },
  ) {
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
    return object;
  }
}

async function setup(
  options: {
    contracts?: 0 | 1 | 2;
  } = {},
) {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const sentEmails: string[] = [];
  const fetchUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  const env = testEnv(db, raw);

  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    fetchUrls.push(url.href);
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-test-token" });
    }
    if (
      url.href ===
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    ) {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      sentEmails.push(Buffer.from(payload.raw, "base64url").toString("utf8"));
      return Response.json({ id: `gmail-${sentEmails.length}` });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      return new Response("read scope required", { status: 403 });
    }
    throw new Error(`unexpected non-Gmail fetch ${url.href}`);
  };

  const contracts = options.contracts ?? 1;
  const chain = contracts > 0 ? await seedNativeContract(env, "primary") : null;
  if (contracts === 2) await seedNativeContract(env, "alternate");
  return {
    db,
    raw,
    env,
    chain,
    sentEmails,
    fetchUrls,
    restore() {
      globalThis.fetch = originalFetch;
      db.close();
    },
  };
}

function testEnv(
  db: SqliteD1,
  raw: MemoryR2,
): AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string } {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return {
    DB: db as never,
    RAW: raw as never,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
    APP_AUTH_PEPPER:
      "customer-contract-acceptance-test-pepper-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "service@example.com",
      private_key: privateKey,
    }),
    FROM_EMAIL: "contracts@example.com",
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "customer-acceptance-native-test",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: POLICY_VALID_FROM,
      valid_until: POLICY_VALID_UNTIL,
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
  } as AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };
}

async function seedNativeContract(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
  suffix: string,
): Promise<NativeChain> {
  const base = new Date(Date.now() - 60_000);
  const quoteId = `customer-quote:acceptance:${suffix}`;
  const quoteRevisionId = `quote-revision:acceptance:${suffix}:1`;
  const proposalPackId = `proposal-pack:acceptance:${suffix}`;
  const proposalRevisionId = `proposal-revision:acceptance:${suffix}:1`;
  const quote: RecordCommercialQuoteInput = {
    tenantId: TENANT,
    quoteRevisionId,
    customerQuoteId: quoteId,
    revisionNumber: 1,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    status: "approved",
    currency: "CAD",
    validUntil: QUOTE_VALID_UNTIL,
    terms: TERMS,
    evidence: EVIDENCE,
    lines: [
      {
        lineId: "scope:roof",
        sequence: 1,
        kind: "labour",
        description: "Install approved roofing scope",
        quantityMicros: 1_000_000,
        uom: "job",
        unitPriceCents: 100_000,
        taxCode: "GST",
        taxCents: 5_000,
      },
    ],
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `acceptance:quote:${suffix}`,
  };
  const preparedQuote = await prepareCommercialQuote(quote);
  const quotePermit = await admitFor(
    env,
    "quote.revision.record",
    { type: "customer_quote", id: quoteId, version: 1 },
    preparedQuote.command,
    `permit:acceptance:quote:${suffix}`,
    base,
    preparedQuote.totalCents,
  );
  quote.authority = { kind: "policy_permit", permitId: quotePermit.permit_id };
  await recordCommercialQuoteRevision(
    env,
    quote,
    new Date(base.getTime() + 1_000),
  );

  const proposal: RecordCommercialProposalInput = {
    tenantId: TENANT,
    proposalRevisionId,
    proposalPackId,
    revisionNumber: 1,
    quoteRevisionId,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    title: "Complete roof replacement proposal",
    summary: "Approved scope, price, schedule assumptions, and warranty.",
    terms: TERMS,
    contentRef: `r2://commercial/proposals/${suffix}.pdf`,
    contentHash: "b".repeat(64),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `acceptance:proposal:${suffix}`,
  };
  const preparedProposal = await prepareCommercialProposal(proposal);
  const proposalPermit = await admitFor(
    env,
    "proposal.revision.record",
    { type: "proposal", id: proposalPackId, version: 1 },
    preparedProposal.command,
    `permit:acceptance:proposal:${suffix}`,
    new Date(base.getTime() + 2_000),
  );
  proposal.authority = {
    kind: "policy_permit",
    permitId: proposalPermit.permit_id,
  };
  await recordCommercialProposalRevision(
    env,
    proposal,
    new Date(base.getTime() + 3_000),
  );

  const chain = {
    quoteId,
    quoteRevisionId,
    proposalPackId,
    proposalRevisionId,
    publicationVersion: 1,
  };
  await recordPublicationTransition(
    env,
    chain,
    "published",
    new Date(base.getTime() + 4_000),
  );
  return chain;
}

async function recordPublicationTransition(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
  chain: NativeChain,
  state: "published" | "withdrawn",
  now: Date,
  previousState: "draft" | "published" | "withdrawn" =
    state === "published" ? "draft" : "published",
): Promise<void> {
  const publicationVersion =
    chain.publicationVersion + (previousState === "draft" ? 0 : 1);
  const action =
    state === "published" ? "proposal.publish" : "proposal.withdraw";
  const input: RecordCommercialPublicationInput = {
    tenantId: TENANT,
    proposalRevisionId: chain.proposalRevisionId,
    proposalPackId: chain.proposalPackId,
    publicationVersion,
    previousState,
    state,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `acceptance:publication:${chain.proposalPackId}:${publicationVersion}`,
  };
  const permit = await admitFor(
    env,
    action,
    {
      type: "proposal_publication",
      id: chain.proposalPackId,
      version: publicationVersion,
    },
    buildCommercialPublicationCommand(input),
    `permit:acceptance:publication:${chain.proposalPackId}:${publicationVersion}`,
    now,
  );
  input.authority = { kind: "policy_permit", permitId: permit.permit_id };
  input.externalEffectId = `effect:acceptance:${chain.proposalPackId}:${publicationVersion}`;
  await executePublicationEffect(env, permit, input, action, now);
  await recordCommercialProposalPublication(
    env,
    input,
    new Date(now.getTime() + 1),
  );
  chain.publicationVersion = publicationVersion;
}

async function admitFor(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
  action: CommercialAction,
  aggregate: {
    type: "customer_quote" | "proposal" | "proposal_publication";
    id: string;
    version: number;
  },
  command: unknown,
  idempotencyKey: string,
  now: Date,
  amountCents: number | null = null,
): Promise<CommercialPermitRecord> {
  const result = await admitCommercialPermit(
    env,
    {
      tenantId: TENANT,
      actor: { type: "agent", id: "sales-orchestrator" },
      action,
      aggregate,
      amountCents,
      command,
      facts: {
        source: "native-operating-core",
        observed_version: aggregate.version,
      },
      factsObservedAt: now.toISOString(),
      evidence: EVIDENCE,
      idempotencyKey,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    },
    now,
  );
  return result.permit;
}

async function executePublicationEffect(
  env: AppEnv,
  permit: CommercialPermitRecord,
  input: RecordCommercialPublicationInput & { externalEffectId?: string },
  action: "proposal.publish" | "proposal.withdraw",
  now: Date,
): Promise<void> {
  await runExternalEffect(
    env,
    {
      effectId: input.externalEffectId,
      tenantId: TENANT,
      actor: { type: "agent", id: "sales-orchestrator" },
      taskId: `commercial:${input.externalEffectId}`,
      authority: commercialEffectAuthority(permit),
      aggregate: {
        type: "proposal_publication",
        id: input.proposalPackId,
        version: input.publicationVersion,
      },
      intentId: input.proposalRevisionId,
      action,
      request: {
        proposal_revision_id: input.proposalRevisionId,
        state: input.state,
      },
      provider: "customer-portal",
      providerAccountRef: TENANT,
      idempotencyKey: `effect:${input.idempotencyKey}`,
      deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      preconditions: { quote_status: "approved" },
      evidenceRefs: EVIDENCE.map(({ ref }) => ref),
      expectedReadback: { state: input.state },
      // A proposal send runs once: D1 refuses any other retry limit for it (0164).
      retryLimit: 0,
      compensationPlan: {},
      correlationId: input.externalEffectId,
    },
    {
      async dispatch() {
        return {
          outcome: "accepted" as const,
          value: { state: input.state },
          providerExternalId: input.externalEffectId,
          providerResponse: { state: input.state },
          readback: {
            status: "match" as const,
            observed: { state: input.state },
          },
        };
      },
      async replay() {
        return { state: input.state };
      },
    },
    now,
  );
}

function seedOperatingCore(db: DatabaseSync): void {
  const now = new Date(Date.now() - 120_000).toISOString();
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', NULL, 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, now, now);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Ada Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(ENVELOPE_ID, CUSTOMER_EMAIL, "raw/acceptance/0001.json", now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Ada Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(
    LEAD_ID,
    TENANT,
    ENVELOPE_ID,
    "raw/acceptance/0001.json",
    CUSTOMER_EMAIL,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Ada Customer', ?, 'active', 1, ?, ?)`,
  ).run(
    CUSTOMER_ID,
    TENANT,
    ENVELOPE_ID,
    "raw/acceptance/0001.json",
    CUSTOMER_EMAIL,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, service_type, job_status, current_gate_state, version,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    JOB_ID,
    TENANT,
    LEAD_ID,
    CUSTOMER_ID,
    ENVELOPE_ID,
    "raw/acceptance/0001.json",
    now,
    now,
  );
}

async function seedPortalLink(db: SqliteD1): Promise<string> {
  const token = randomToken();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO customer_portal_links
     (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
      created_at, expires_at, revoked_at, revoked_by_user_id, last_accessed_at, access_count,
      issued_ip_hash, issued_user_agent_hash)
     VALUES ('portal_00000000-0000-4000-8000-000000000001', ?, ?, ?, ?, ?, ?,
             ?, NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(
      await sha256Hex(token),
      TENANT,
      JOB_ID,
      CUSTOMER_ID,
      OWNER_ID,
      now,
      PORTAL_LINK_EXPIRES_AT,
      "a".repeat(64),
      "b".repeat(64),
    );
  return token;
}

async function issueChallenge(
  env: AppEnv,
  portalToken: string,
): Promise<Response> {
  return await worker.fetch(
    new Request(
      `${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/challenge`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_ORIGIN,
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify({ token: portalToken }),
      },
    ),
    env as never,
    {} as never,
  );
}

function emailChallengeToken(sentEmails: string[]): string {
  const match = sentEmails
    .at(-1)
    ?.match(/contract-accept#token=([A-Za-z0-9_-]{43})/);
  assert.ok(match, "missing emailed acceptance fragment");
  return match[1]!;
}

function confirmRequest(
  token: string,
  idempotencyKey: string,
  signerName = "Ada Customer",
): Request {
  return new Request(
    `${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/confirm`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
        "cf-connecting-ip": "203.0.113.9",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ token, signer_name: signerName, accepted: true }),
    },
  );
}

function previewRequest(token: string): Request {
  return new Request(
    `${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/preview`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
      },
      body: JSON.stringify({ token }),
    },
  );
}

function authenticatedRouteRequest(
  acceptanceId: string,
  idempotencyKey: string,
): Request {
  return new Request(
    `${PUBLIC_ORIGIN}/api/v1/commercial/deposit-intents/reconcile`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-csrf-token": "csrf",
      },
      body: JSON.stringify({ acceptance_id: acceptanceId }),
    },
  );
}

function authenticatedPhaseRequest(jobId: string): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(jobId)}/phase`, {
    method: "GET",
  });
}

function authenticatedRouteAuth(role: AppRole): AuthContext {
  const now = new Date().toISOString();
  const userId = role === "owner" ? OWNER_ID : `appu_${role}_0001`;
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "c".repeat(64),
      session_created_at: now,
      session_expires_at: new Date(Date.now() + A_YEAR).toISOString(),
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      user_id: userId,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "test",
      created_at: now,
      updated_at: now,
    },
  };
}

function totalChanges(database: DatabaseSync): number {
  return Number(
    (
      database.prepare("SELECT total_changes() AS total").get() as {
        total: number;
      }
    ).total,
  );
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

test("native customer acceptance is pinned, receipt-backed, atomically bound, and replay-safe", async () => {
  const h = await setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.status, 200, await challenge.clone().text());
    assert.equal(
      ((await challenge.json()) as { status: string }).status,
      "challenge_sent",
    );
    assert.ok(
      h.fetchUrls.every((url) =>
        ["oauth2.googleapis.com", "gmail.googleapis.com"].includes(
          new URL(url).host,
        ),
      ),
    );

    const challengeToken = emailChallengeToken(h.sentEmails);
    const preview = await worker.fetch(
      previewRequest(challengeToken),
      h.env as never,
      {} as never,
    );
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await preview.json(), {
      status: "ready",
      quote_version: 1,
      total_cents: 105_000,
      currency: "CAD",
      valid_until: QUOTE_VALID_UNTIL,
      proposal_title: "Complete roof replacement proposal",
      proposal_summary: "Approved scope, price, schedule assumptions, and warranty.",
      terms: TERMS,
    });
    const persistedChallenge = h.db.raw
      .prepare("SELECT * FROM customer_portal_acceptance_challenges")
      .get() as Record<string, unknown>;
    assert.equal(persistedChallenge.roof_job_id, JOB_ID);
    assert.equal(persistedChallenge.customer_id, CUSTOMER_ID);
    assert.equal(persistedChallenge.email_hash, EMAIL_HASH);
    assert.equal(persistedChallenge.quote_id, h.chain!.quoteId);
    assert.equal(persistedChallenge.quote_version, 1);
    assert.equal(persistedChallenge.proposal_pack_id, h.chain!.proposalPackId);
    assert.equal(persistedChallenge.terms_hash, TERMS_HASH);
    assert.equal(persistedChallenge.terms_json, TERMS_JSON);
    assert.equal(
      JSON.stringify(persistedChallenge).includes(CUSTOMER_EMAIL),
      false,
    );
    assert.equal(
      JSON.stringify(persistedChallenge).includes(challengeToken),
      false,
    );

    const first = await worker.fetch(
      confirmRequest(challengeToken, "acceptance-confirm-native-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(first.status, 200, await first.clone().text());
    const accepted = (await first.json()) as {
      status: string;
      acceptance_id: string;
    };
    assert.equal(accepted.status, "accepted");
    assert.match(accepted.acceptance_id, /^acceptance_[0-9a-f-]{36}$/);
    const consumedPreview = await worker.fetch(
      previewRequest(challengeToken),
      h.env as never,
      {} as never,
    );
    assert.equal(consumedPreview.status, 404);

    const binding = h.db.raw
      .prepare(
        `SELECT * FROM commercial_acceptance_bindings WHERE acceptance_id = ?`,
      )
      .get(accepted.acceptance_id) as Record<string, unknown>;
    assert.equal(binding.quote_revision_id, h.chain!.quoteRevisionId);
    assert.equal(binding.proposal_revision_id, h.chain!.proposalRevisionId);
    assert.equal(binding.roof_job_id, JOB_ID);
    assert.equal(binding.customer_id, CUSTOMER_ID);
    assert.equal(binding.terms_hash, TERMS_HASH);
    const publication = h.db.raw
      .prepare(
        `SELECT publication_event_id, publication_version
           FROM commercial_proposal_publication_events
          WHERE proposal_revision_id = ? AND state = 'published'
          ORDER BY publication_version DESC LIMIT 1`,
      )
      .get(h.chain!.proposalRevisionId) as {
      publication_event_id: string;
      publication_version: number;
    };
    const derivation = h.db.raw
      .prepare(
        `SELECT state, blocker_code, acceptance_id, quote_revision_id,
                proposal_revision_id, proposal_version, publication_event_id,
                publication_version, command_fingerprint, idempotency_key_hash,
                version
           FROM commercial_deposit_derivations
          WHERE tenant_id = ? AND acceptance_id = ?`,
      )
      .get(TENANT, accepted.acceptance_id) as Record<string, unknown>;
    assert.equal(derivation.state, "blocked");
    assert.equal(derivation.blocker_code, "provider_mapping_missing");
    assert.equal(derivation.acceptance_id, accepted.acceptance_id);
    assert.equal(derivation.quote_revision_id, h.chain!.quoteRevisionId);
    assert.equal(derivation.proposal_revision_id, h.chain!.proposalRevisionId);
    assert.equal(derivation.proposal_version, 1);
    assert.equal(derivation.publication_event_id, publication.publication_event_id);
    assert.equal(derivation.publication_version, publication.publication_version);
    assert.match(String(derivation.command_fingerprint), /^[0-9a-f]{64}$/);
    assert.match(String(derivation.idempotency_key_hash), /^[0-9a-f]{64}$/);
    assert.equal(
      h.db.raw
        .prepare(
          `SELECT lifecycle_status, version FROM operating_leads
            WHERE tenant_id = ? AND lead_id = ?`,
        )
        .get(TENANT, LEAD_ID)
        ?.lifecycle_status,
      "converted",
    );
    assert.equal(
      h.db.raw
        .prepare(
          `SELECT lifecycle_status, version FROM operating_leads
            WHERE tenant_id = ? AND lead_id = ?`,
        )
        .get(TENANT, LEAD_ID)
        ?.version,
      2,
    );
    assert.equal(
      h.db.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM commercial_deposit_derivations
            WHERE tenant_id = ? AND acceptance_id = ?`,
        )
        .get(TENANT, accepted.acceptance_id)!.count,
      1,
    );
    const reconcile = await handleAuthenticatedRoute(
      authenticatedRouteRequest(
        accepted.acceptance_id,
        "acceptance-deposit-reconcile-0001",
      ),
      h.env,
      authenticatedRouteAuth("owner"),
    );
    assert.equal(reconcile.status, 200, await reconcile.clone().text());
    const reconciled = await reconcile.json() as {
      request: { state: string; replayed: boolean };
      derivation: { state: string; blocker_code: string };
    };
    assert.equal(reconciled.request.state, "blocked");
    assert.equal(reconciled.request.replayed, false);
    assert.equal(reconciled.derivation.state, "blocked");
    assert.equal(reconciled.derivation.blocker_code, "provider_mapping_missing");
    const reconcileReplay = await handleAuthenticatedRoute(
      authenticatedRouteRequest(
        accepted.acceptance_id,
        "acceptance-deposit-reconcile-0001",
      ),
      h.env,
      authenticatedRouteAuth("owner"),
    );
    assert.equal(reconcileReplay.status, 200);
    assert.equal(
      (await reconcileReplay.json() as { request: { replayed: boolean } }).request.replayed,
      true,
    );
    const unauthorized = await handleAuthenticatedRoute(
      authenticatedRouteRequest(
        accepted.acceptance_id,
        "acceptance-deposit-reconcile-unauthorized",
      ),
      h.env,
      authenticatedRouteAuth("production"),
    );
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), {
      error: "accounting_review_required",
    });
    const phase = await handleAuthenticatedRoute(
      authenticatedPhaseRequest(JOB_ID),
      h.env,
      authenticatedRouteAuth("owner"),
    );
    assert.equal(phase.status, 200, await phase.clone().text());
    const phaseModel = await phase.json() as {
      phase: string;
      facts: {
        commercial: {
          quote: { quote_revision_id: string } | null;
          proposal: { proposal_revision_id: string } | null;
          publication: { state: string } | null;
          acceptance: { acceptance_id: string } | null;
          deposit_derivation: { state: string; blocker_code: string } | null;
        };
        safety: { blocked: boolean };
      };
    };
    assert.equal(phaseModel.phase, "deposit_pending");
    assert.equal(phaseModel.facts.commercial.quote?.quote_revision_id, h.chain!.quoteRevisionId);
    assert.equal(phaseModel.facts.commercial.proposal?.proposal_revision_id, h.chain!.proposalRevisionId);
    assert.equal(phaseModel.facts.commercial.publication?.state, "published");
    assert.equal(phaseModel.facts.commercial.acceptance?.acceptance_id, accepted.acceptance_id);
    assert.equal(phaseModel.facts.commercial.deposit_derivation?.state, "blocked");
    assert.equal(phaseModel.facts.commercial.deposit_derivation?.blocker_code, "provider_mapping_missing");
    assert.equal(phaseModel.facts.safety.blocked, false);
    assert.equal(
      h.db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM external_effects WHERE provider = 'frappe'",
        )
        .get()!.count,
      0,
    );

    const receipt = h.raw.objects.get(
      `customer-contract-acceptance/v1/${accepted.acceptance_id}.json`,
    );
    assert.ok(receipt);
    assert.equal(receipt!.body.includes(CUSTOMER_EMAIL), false);
    assert.equal(receipt!.body.includes(challengeToken), false);
    assert.equal(receipt!.body.includes(TERMS_HASH), true);
    assert.equal(receipt!.body.includes(EMAIL_HASH), true);
    assert.equal(
      binding.receipt_hash,
      createHash("sha256").update(receipt!.body).digest("hex"),
    );

    const replay = await worker.fetch(
      confirmRequest(challengeToken, "acceptance-confirm-native-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), accepted);
    const mismatch = await worker.fetch(
      confirmRequest(
        challengeToken,
        "acceptance-confirm-native-0001",
        "Other Representative",
      ),
      h.env as never,
      {} as never,
    );
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), {
      error: "acceptance_idempotency_conflict",
    });
    const used = await worker.fetch(
      confirmRequest(challengeToken, "acceptance-confirm-native-0002"),
      h.env as never,
      {} as never,
    );
    assert.equal(used.status, 409);
    assert.deepEqual(await used.json(), { error: "acceptance_challenge_used" });
    assert.equal(
      h.db.raw
        .prepare("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings")
        .get()!.count,
      1,
    );

    const events = h.db.raw
      .prepare(
        "SELECT event_type FROM customer_portal_acceptance_events ORDER BY event_id",
      )
      .all() as Array<{ event_type: string }>;
    assert.deepEqual(
      events.map(({ event_type }) => event_type),
      [
        "intent_recorded",
        "receipt_stored",
        // Schema-compatibility name: this is the native transactional commit marker.
        "frappe_commit_attempted",
        "accepted",
      ],
    );
  } finally {
    h.restore();
  }
});

test("native acceptance reads back a commit whose D1 response was lost", async () => {
  const h = await setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
    h.db.throwNextBatchAfterCommit = true;
    const response = await worker.fetch(
      confirmRequest(
        emailChallengeToken(h.sentEmails),
        "acceptance-lost-response-0001",
      ),
      h.env as never,
      {} as never,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const accepted = (await response.json()) as { acceptance_id: string };
    assert.equal(
      h.db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM commercial_acceptance_bindings WHERE acceptance_id = ?",
        )
        .get(accepted.acceptance_id)!.count,
      1,
    );
  } finally {
    h.restore();
  }
});

test("confirmation rejects and replays when the published contract changed after the challenge", async () => {
  const h = await setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
    const challenge = h.db.raw
      .prepare("SELECT created_at FROM customer_portal_acceptance_challenges")
      .get() as { created_at: string };
    await recordPublicationTransition(
      h.env,
      h.chain!,
      "withdrawn",
      new Date(Date.parse(challenge.created_at) + 1),
    );
    const token = emailChallengeToken(h.sentEmails);
    const preview = await worker.fetch(
      previewRequest(token),
      h.env as never,
      {} as never,
    );
    assert.equal(preview.status, 409);
    assert.deepEqual(await preview.json(), { error: "acceptance_contract_changed" });
    const first = await worker.fetch(
      confirmRequest(token, "acceptance-contract-drift-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(first.status, 409);
    assert.deepEqual(await first.json(), { error: "acceptance_rejected" });
    const replay = await worker.fetch(
      confirmRequest(token, "acceptance-contract-drift-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: "acceptance_rejected" });
    const intent = h.db.raw
      .prepare(
        "SELECT state, error_code FROM customer_portal_acceptance_intents",
      )
      .get() as { state: string; error_code: string };
    assert.equal(intent.state, "rejected");
    assert.equal(intent.error_code, "native_contract_changed");
    assert.equal(
      h.db.raw
        .prepare("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings")
        .get()!.count,
      0,
    );
  } finally {
    h.restore();
  }
});

for (const reviseProposal of [false, true]) {
  test(`preview and confirmation reject same-terms republication with ${reviseProposal ? "a new" : "the same"} proposal revision`, async () => {
    const h = await setup();
    try {
      const portalToken = await seedPortalLink(h.db);
      assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
      const challenge = h.db.raw
        .prepare(
          "SELECT created_at, quote_id, quote_version, terms_hash FROM customer_portal_acceptance_challenges",
        )
        .get() as {
        created_at: string;
        quote_id: string;
        quote_version: number;
        terms_hash: string;
      };
      const chain = h.chain!;
      const issuedAt = Date.parse(challenge.created_at);
      await recordPublicationTransition(
        h.env,
        chain,
        "withdrawn",
        new Date(issuedAt + 1),
      );
      if (reviseProposal) {
        const input: RecordCommercialProposalInput = {
          tenantId: TENANT,
          proposalRevisionId: "proposal-revision:acceptance:primary:2",
          proposalPackId: chain.proposalPackId,
          revisionNumber: 2,
          quoteRevisionId: chain.quoteRevisionId,
          roofJobId: JOB_ID,
          customerId: CUSTOMER_ID,
          supersedesProposalRevisionId: chain.proposalRevisionId,
          title: "Revised roof replacement proposal",
          summary: "Updated presentation with unchanged scope, price, and terms.",
          terms: TERMS,
          contentRef: "r2://commercial/proposals/primary-revised.pdf",
          contentHash: "c".repeat(64),
          evidence: EVIDENCE,
          authority: { kind: "policy_permit", permitId: "pending" },
          idempotencyKey: "acceptance:proposal:primary:2",
        };
        const prepared = await prepareCommercialProposal(input);
        const permit = await admitFor(
          h.env,
          "proposal.revision.record",
          { type: "proposal", id: chain.proposalPackId, version: 2 },
          prepared.command,
          "permit:acceptance:proposal:primary:2",
          new Date(issuedAt + 10),
        );
        input.authority = { kind: "policy_permit", permitId: permit.permit_id };
        const result = await recordCommercialProposalRevision(
          h.env,
          input,
          new Date(issuedAt + 11),
        );
        assert.equal(result.kind, "created");
        assert.equal(result.proposal.terms_hash, challenge.terms_hash);
        chain.proposalRevisionId = result.proposal.proposal_revision_id;
      }
      const republishedAt = issuedAt + 21;
      await recordPublicationTransition(
        h.env,
        chain,
        "published",
        new Date(republishedAt - 1),
        "withdrawn",
      );
      // Both publications must be in the past for a current-time preview to
      // expose the stale-token bug rather than refuse a future fixture event.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, republishedAt - Date.now() + 1)),
      );
      assert.equal(chain.publicationVersion, 3);
      assert.equal(challenge.quote_id, chain.quoteId);
      assert.equal(challenge.quote_version, 1);
      assert.equal(challenge.terms_hash, TERMS_HASH);

      const token = emailChallengeToken(h.sentEmails);
      const preview = await worker.fetch(
        previewRequest(token),
        h.env as never,
        {} as never,
      );
      const confirmation = await worker.fetch(
        confirmRequest(token, "acceptance-republished-contract-0001"),
        h.env as never,
        {} as never,
      );
      assert.equal(confirmation.status, 409);
      assert.deepEqual(await confirmation.json(), { error: "acceptance_rejected" });
      const intent = h.db.raw
        .prepare("SELECT state, error_code FROM customer_portal_acceptance_intents")
        .get() as { state: string; error_code: string };
      assert.equal(intent.state, "rejected");
      assert.equal(intent.error_code, "native_contract_changed");
      assert.equal(
        h.db.raw
          .prepare("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings")
          .get()!.count,
        0,
      );
      assert.equal(h.sentEmails.length, 1);
      assert.equal(preview.headers.get("cache-control"), "private, no-store");
      assert.equal(preview.status, 409);
      assert.deepEqual(await preview.json(), { error: "acceptance_contract_changed" });
    } finally {
      h.restore();
    }
  });
}

test("missing or ambiguous native contract chains fail closed before email delivery", async () => {
  for (const contracts of [0, 2] as const) {
    const h = await setup({ contracts });
    try {
      const portalToken = await seedPortalLink(h.db);
      const response = await issueChallenge(h.env, portalToken);
      assert.equal(response.status, 503, `contracts=${contracts}`);
      assert.deepEqual(await response.json(), { error: "portal_unavailable" });
      assert.equal(h.sentEmails.length, 0);
      assert.equal(
        h.db.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM customer_portal_acceptance_challenges",
          )
          .get()!.count,
        0,
      );
    } finally {
      h.restore();
    }
  }
});

test("native acceptance snapshot and commit require a qualified lead atomically", async () => {
  for (const lifecycleStatus of ["untriaged", "triaged", "disqualified"] as const) {
    const h = await setup();
    try {
      const portalToken = await seedPortalLink(h.db);
      const challenge = await issueChallenge(h.env, portalToken);
      assert.equal(challenge.status, 200, lifecycleStatus);
      const challengeToken = emailChallengeToken(h.sentEmails);
      h.db.raw.prepare(
        `UPDATE operating_leads SET lifecycle_status = ?, version = version + 1
          WHERE tenant_id = ? AND lead_id = ?`,
      ).run(lifecycleStatus, TENANT, LEAD_ID);
      const confirmation = await worker.fetch(
        confirmRequest(challengeToken, `acceptance-unqualified-${lifecycleStatus}-0001`),
        h.env as never,
        {} as never,
      );
      assert.equal(confirmation.status, 409, lifecycleStatus);
      assert.equal(
        h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings").get()!.count,
        0,
      );
      assert.equal(
        h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_deposit_derivations").get()!.count,
        0,
      );
      assert.equal(
        h.db.raw.prepare("SELECT state FROM customer_portal_acceptance_intents").get()!.state,
        "rejected",
      );
    } finally {
      h.restore();
    }
  }
});

test("Gmail send response confirms the prepared message with a send-only grant", async () => {
  const h = await setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.status, 200);
    assert.equal(h.sentEmails.length, 1);
    assert.match(h.sentEmails[0]!, new RegExp(`^To: ${CUSTOMER_EMAIL}$`, "m"));
    assert.match(h.sentEmails[0]!, /^Subject: =\?UTF-8\?B\?[^?]+\?=$/m);
    assert.ok(h.sentEmails[0]!.includes(emailChallengeToken(h.sentEmails)));
    assert.equal(h.fetchUrls.filter((url) => url.includes("/messages/send")).length, 1);
    assert.equal(h.fetchUrls.some((url) => /\/messages\/[^/]+\?/.test(url)), false);
    const effect = h.db.raw
      .prepare(
        `SELECT state, expected_readback_json, provider_external_id, provider_response_hash, readback_hash
         FROM external_effects WHERE provider = 'gmail' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as {
        state: string;
        expected_readback_json: string;
        provider_external_id: string;
        provider_response_hash: string;
        readback_hash: string;
      };
    assert.equal(effect.state, "succeeded");
    assert.equal(effect.provider_external_id, "gmail-1");
    assert.match(effect.provider_response_hash, /^[0-9a-f]{64}$/);
    assert.match(effect.readback_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      Object.keys(JSON.parse(effect.expected_readback_json)).sort(),
      ["html_sha256", "subject_sha256", "to_sha256"],
    );
    assert.equal(effect.expected_readback_json.includes(CUSTOMER_EMAIL), false);
  } finally {
    h.restore();
  }
});

test("acceptance remains false by default and needs delivery, not dedicated Frappe secrets", async () => {
  const h = await setup();
  try {
    const portalToken = await seedPortalLink(h.db);
    h.env.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED = "false";
    assert.equal((await issueChallenge(h.env, portalToken)).status, 404);

    h.env.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED = "true";
    delete h.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const unavailable = await issueChallenge(h.env, portalToken);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "portal_unavailable" });
  } finally {
    h.restore();
  }
});

test("acceptance readiness uses native bindings without BFF or Frappe read configuration", async () => {
  const h = await setup();
  try {
    assert.equal(h.env.APP_BFF_ENABLED, undefined);
    assert.equal(h.env.ERPNEXT_BASE_URL, undefined);
    assert.equal(h.env.ERPNEXT_API_KEY, undefined);
    assert.equal(h.env.ERPNEXT_API_SECRET, undefined);
    const portalToken = await seedPortalLink(h.db);

    const expectUnavailable = async (
      mutate: () => void,
      restore: () => void,
    ): Promise<void> => {
      mutate();
      const response = await issueChallenge(h.env, portalToken);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "portal_unavailable" });
      restore();
    };

    const tenantId = h.env.APP_TENANT_ID;
    await expectUnavailable(
      () => {
        h.env.APP_TENANT_ID = "";
      },
      () => {
        h.env.APP_TENANT_ID = tenantId;
      },
    );
    const publicOrigin = h.env.APP_PUBLIC_ORIGIN;
    await expectUnavailable(
      () => {
        h.env.APP_PUBLIC_ORIGIN = "";
      },
      () => {
        h.env.APP_PUBLIC_ORIGIN = publicOrigin;
      },
    );
    const allowedOrigins = h.env.APP_ALLOWED_ORIGINS;
    await expectUnavailable(
      () => {
        h.env.APP_ALLOWED_ORIGINS = "";
      },
      () => {
        h.env.APP_ALLOWED_ORIGINS = allowedOrigins;
      },
    );
    const authPepper = h.env.APP_AUTH_PEPPER;
    await expectUnavailable(
      () => {
        h.env.APP_AUTH_PEPPER = "too-short";
      },
      () => {
        h.env.APP_AUTH_PEPPER = authPepper;
      },
    );
    const db = h.env.DB;
    await expectUnavailable(
      () => {
        h.env.DB = {} as never;
      },
      () => {
        h.env.DB = db;
      },
    );
    const raw = h.env.RAW;
    await expectUnavailable(
      () => {
        h.env.RAW = {} as never;
      },
      () => {
        h.env.RAW = raw;
      },
    );
    const serviceAccount = h.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    await expectUnavailable(
      () => {
        h.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
      },
      () => {
        h.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
      },
    );
    const fromEmail = h.env.FROM_EMAIL;
    await expectUnavailable(
      () => {
        h.env.FROM_EMAIL = "";
      },
      () => {
        h.env.FROM_EMAIL = fromEmail;
      },
    );

    const ready = await issueChallenge(h.env, portalToken);
    assert.equal(ready.status, 200, await ready.clone().text());
  } finally {
    h.restore();
  }
});
