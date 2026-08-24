import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import { buildSalesReadModel } from "../src/app-read-models.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";
import {
  beginCommercialDepositDerivationRequest,
  deriveSuccess,
  ensureCommercialDepositDerivation,
  type CommercialDepositDerivationRecord,
} from "../src/commercial-deposit.ts";
import type { AccountingIntentRecord } from "../src/accounting-intents.ts";
import { taxForSubtotal } from "../src/native-final-invoice-producer.ts";
import {
  derivePhase,
  depositIntentIsReconciled,
  selectPhaseWorkPackage,
} from "../src/commercial-job-phase.ts";

const TENANT = "ironwrap";
const PUBLIC_ORIGIN = "https://app.example.invalid";
const OWNER_ID = "appu_owner_0001";
const OPS_ID = "appu_ops_0001";
const OTHER_OPS_ID = "appu_ops_0002";
const CUSTOMER_EMAIL = "customer@example.invalid";
const EVIDENCE = [{
  ref: "r2://technical-reference/iro208-commercial-reference.json",
  sha256: "a".repeat(64),
}] as const;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const POLICY_VALID_FROM = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
const POLICY_VALID_UNTIL = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
const QUOTE_VALID_UNTIL = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString().slice(0, 10);

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  throwNextBatchAfterCommit = false;

  constructor(lastMigration?: string) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
      if (file === lastMigration) break;
    }
    // Identity setup is the only fixture write.  Operating and commercial facts are created below
    // by the same intake and role/public routes used by a deployed tenant.
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
         user_id, tenant_id, email_normalized, display_name, role, access_role,
         frappe_user_id, active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'reference-test', ?, ?)`,
    );
    const now = new Date().toISOString();
    insert.run(OWNER_ID, TENANT, "owner@example.invalid", "Owner", "owner", "owner", "owner@example.invalid", now, now);
    insert.run(OPS_ID, TENANT, "ops@example.invalid", "Ops", "ops", "ops", "ops@example.invalid", now, now);
    insert.run(OTHER_OPS_ID, TENANT, "other-ops@example.invalid", "Other Ops", "ops", "ops", "other-ops@example.invalid", now, now);
  }

  prepare(sql: string): SqliteStatement {
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
        throw new Error("synthetic_lost_d1_response");
      }
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

  bind(...args: unknown[]): SqliteStatement {
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
    return { success: true, meta: { changes: totalChanges(this.database) - before } };
  }
}

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();

  async head(key: string): Promise<Record<string, unknown> | null> {
    return this.objects.get(key)?.object ?? null;
  }

  async put(
    key: string,
    value: string,
    options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown },
  ): Promise<Record<string, unknown> | null> {
    const prior = this.objects.get(key);
    if (prior && options.onlyIf) return null;
    const bytes = fromHex(options.sha256 ?? "");
    const object = {
      size: new TextEncoder().encode(value).byteLength,
      checksums: { sha256: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body: value, object });
    return object;
  }
}

class FakeIntegrations {
  readonly sentEmails: string[] = [];
  readonly mappingEntities: Record<string, Record<string, unknown>> = {
    Customer: {
      Id: "501", Active: true, SyncToken: "1", MetaData: { LastUpdatedTime: new Date().toISOString() },
      PrimaryEmailAddr: { Address: CUSTOMER_EMAIL },
    },
    Item: {
      Id: "601", Active: true, SyncToken: "2", MetaData: { LastUpdatedTime: new Date().toISOString() },
      Type: "Service", IncomeAccountRef: { value: "401" },
    },
    Account: {
      Id: "401", Active: true, SyncToken: "6", MetaData: { LastUpdatedTime: new Date().toISOString() },
      AccountType: "Income", Classification: "Revenue",
    },
    TaxCode: {
      Id: "701", Active: true, SyncToken: "3", MetaData: { LastUpdatedTime: new Date().toISOString() },
      Name: "GST", SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: "702" } }] },
    },
    TaxRate: {
      Id: "702", Active: true, SyncToken: "4", MetaData: { LastUpdatedTime: new Date().toISOString() }, RateValue: 5,
    },
    Term: {
      Id: "801", Active: true, SyncToken: "5", MetaData: { LastUpdatedTime: new Date().toISOString() }, DueDays: 30,
    },
  };

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.href === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
      return Response.json({
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        x_refresh_token_expires_in: 8_640_000,
      });
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "synthetic-gmail-token" });
    }
    if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      this.sentEmails.push(Buffer.from(payload.raw, "base64url").toString("utf8"));
      return Response.json({ id: `gmail-${this.sentEmails.length}` });
    }
    if (url.hostname === "gmail.googleapis.com" && url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      const messageId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const index = Number(messageId.replace(/^gmail-/, "")) - 1;
      const message = this.sentEmails[index];
      if (!message) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ id: messageId, raw: Buffer.from(message).toString("base64url") });
    }
    if (url.hostname === "sandbox-quickbooks.api.intuit.com" && method === "GET") {
      const entityMatch = url.pathname.match(/\/(account|customer|item|taxcode|taxrate|term)\/([^/]+)$/u);
      if (entityMatch) {
        const entityName = {
          account: "Account", customer: "Customer", item: "Item", taxcode: "TaxCode", taxrate: "TaxRate", term: "Term",
        }[entityMatch[1]!]!;
        const entity = this.mappingEntities[entityName];
        return entity ? Response.json({ [entityName]: entity }) : Response.json({ Fault: { Error: [{ code: "610" }] } }, { status: 404 });
      }
    }
    throw new Error(`unexpected synthetic integration request: ${method} ${url}`);
  };
}

function env(db: SqliteD1, raw: MemoryR2, queue: QueueDouble): AppEnv {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return {
    DB: db as never,
    RAW: raw as never,
    JN_QUEUE: queue as never,
    EFFECT_RUNTIME_ENABLED: "true",
    JOBNIMBUS_ENABLED: "false",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    APP_BFF_ENABLED: "true",
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
    APP_AUTH_PEPPER: "iro208-reference-test-pepper-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "service@example.invalid", private_key: privateKey }),
    FROM_EMAIL: "contracts@example.invalid",
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "iro208-commercial-reference",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: POLICY_VALID_FROM,
      valid_until: POLICY_VALID_UNTIL,
      max_fact_age_seconds: 3_600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: ["lead.triage.record", "quote.revision.record", "proposal.revision.record", "proposal.publish", "proposal.withdraw"],
      allowed_actor_types: ["owner", "worker"],
      max_quote_total_cents: 1_000_000,
    }),
    QB_OAUTH_ENABLED: "true",
    QB_FINAL_INVOICE_ENABLED: "true",
    QB_API_ENVIRONMENT: "sandbox",
    QB_API_MINOR_VERSION: "75",
    QB_API_TIMEOUT_MS: "1000",
    QB_CLIENT_ID: "synthetic-client-id",
    QB_CLIENT_SECRET: "synthetic-client-secret",
    QB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    QB_TOKEN_ENCRYPTION_KEY_VERSION: "test-v1",
  } as AppEnv;
}

interface QueueMessage {
  envelope_id: string;
}

class QueueDouble {
  readonly messages: QueueMessage[] = [];
  async send(message: QueueMessage): Promise<void> {
    this.messages.push(message);
  }
  async sendBatch(messages: Array<{ body: QueueMessage }>): Promise<void> {
    this.messages.push(...messages.map((message) => message.body));
  }
}

class DerivationRaceDb {
  readonly intent = { intent_id: "acct-intent:race-winner" };
  winnerState: "pending" | "blocked" | "derived" = "derived";
  derivation: CommercialDepositDerivationRecord = {
    derivation_id: "commercial-deposit-derivation:race",
    acceptance_binding_id: "commercial-acceptance-binding:race",
    acceptance_id: "acceptance_race_winner",
    tenant_id: TENANT,
    quote_revision_id: "quote-revision:race",
    proposal_revision_id: "proposal-revision:race",
    proposal_version: 1,
    publication_event_id: "publication-event:race",
    publication_version: 1,
    roof_job_id: "job:race-winner",
    customer_id: "customer:race-winner",
    customer_quote_id: "customer-quote:race",
    quote_version: 1,
    quote_currency: "CAD",
    quote_subtotal_cents: 100_000,
    quote_tax_cents: 5_000,
    quote_total_cents: 105_000,
    deposit_percent: 25,
    terms_hash: "a".repeat(64),
    receipt_hash: "b".repeat(64),
    accepted_at: new Date().toISOString(),
    basis_json: "{}",
    basis_sha256: null,
    evidence_refs_json: "[]",
    command_fingerprint: "c".repeat(64),
    idempotency_key_hash: "d".repeat(64),
    state: "blocked",
    intent_id: null,
    blocker_code: "provider_mapping_missing",
    blocker_next_step: "record_native_provider_mapping",
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  prepare(sql: string): RaceStatement {
    return new RaceStatement(this, sql);
  }
}

class RaceStatement {
  private readonly database: DerivationRaceDb;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(database: DerivationRaceDb, sql: string, args: unknown[] = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): RaceStatement {
    return new RaceStatement(this.database, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM commercial_deposit_derivations")) return this.database.derivation as T;
    if (this.sql.includes("FROM accounting_intents")) return this.database.intent as T;
    return null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.sql.includes("UPDATE commercial_deposit_derivations")) {
      // The competing worker wins the CAS immediately before this caller reads back the row.
      const deriveWinner = this.sql.includes("state = 'derived'");
      const winnerState = deriveWinner ? this.database.winnerState : "derived";
      this.database.derivation = {
        ...this.database.derivation,
        state: winnerState,
        intent_id: winnerState === "derived" ? this.database.intent.intent_id : null,
        blocker_code: winnerState === "blocked" ? "provider_mapping_missing" : null,
        blocker_next_step: winnerState === "blocked" ? "record_native_provider_mapping" : null,
        version: this.database.derivation.version + 1,
      };
      return { success: true, meta: { changes: 0 } };
    }
    throw new Error(`unexpected_race_sql:${this.sql}:${this.args.length}`);
  }
}

function auth(role: AppRole, userId = role === "owner" ? OWNER_ID : role === "ops" ? OPS_ID : `appu_${role}_0001`): AuthContext {
  const now = new Date().toISOString();
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "c".repeat(64), session_created_at: now,
      session_expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null,
      device_id: null, device_proof_hash: null, user_id: userId, tenant_id: TENANT,
      email_normalized: userId === OTHER_OPS_ID ? "other-ops@example.invalid" : `${role}@example.invalid`,
      display_name: userId === OTHER_OPS_ID ? "Other Ops" : role,
      role, frappe_user_id: userId === OTHER_OPS_ID ? "other-ops@example.invalid" : `${role}@example.invalid`,
      active: 1, created_by: "reference-test", created_at: now, updated_at: now,
    },
  };
}

function request(path: string, body: Record<string, unknown>, idempotencyKey: string): Request {
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "idempotency-key": idempotencyKey,
      "x-csrf-token": "csrf", origin: PUBLIC_ORIGIN, "cf-connecting-ip": "203.0.113.20",
    },
    body: JSON.stringify(body),
  });
}

function publicRequest(path: string, body: Record<string, unknown>, idempotencyKey?: string): Request {
  const headers = new Headers({
    "content-type": "application/json", origin: PUBLIC_ORIGIN, "cf-connecting-ip": "203.0.113.21",
  });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request(`${PUBLIC_ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function duplicateLeadBody(): Record<string, unknown> {
  return {
    name: "Ada Customer", email: CUSTOMER_EMAIL, phone: "+14035550101",
    address: "100 Technical Reference Way", city: "Calgary", province: "AB", postal_code: "T2P 1J9",
    service: "Roof replacement", message: "Synthetic technical-reference intake; never customer proof.",
  };
}

function quoteBody(
  ids: Identities,
  factsObservedAt: string,
  terms: Record<string, unknown> = TERMS,
  lines: Array<Record<string, unknown>> = [{
    line_id: "scope:roof", sequence: 1, kind: "labour", description: "Synthetic accepted roofing scope",
    quantity_micros: 1_000_000, uom: "job", unit_price_cents: 100_000, tax_code: "GST", tax_cents: 5_000,
  }],
): Record<string, unknown> {
  return {
    quote_revision_id: `quote-revision:iro208:${ids.leadId}`, customer_quote_id: `customer-quote:iro208:${ids.leadId}`,
    revision_number: 1, roof_job_id: ids.jobId, customer_id: ids.customerId, facts_observed_at: factsObservedAt,
    supersedes_quote_revision_id: null, status: "approved", currency: "CAD", valid_until: QUOTE_VALID_UNTIL,
    terms, correction_reason: null,
    lines, evidence: EVIDENCE,
  };
}

function proposalBody(ids: Identities, factsObservedAt: string, terms: Record<string, unknown> = TERMS): Record<string, unknown> {
  return {
    proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`, proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
    revision_number: 1, quote_revision_id: `quote-revision:iro208:${ids.leadId}`, roof_job_id: ids.jobId,
    customer_id: ids.customerId, facts_observed_at: factsObservedAt, title: "Synthetic technical-reference proposal",
    summary: "A bounded synthetic proposal used only to prove the native route spine.", terms,
    content_ref: `r2://technical-reference/iro208/${ids.leadId}.pdf`, content_hash: "b".repeat(64), evidence: EVIDENCE,
  };
}

interface Identities {
  envelopeId: string;
  leadId: string;
  customerId: string;
  propertyId: string;
  jobId: string;
}

async function intakeAndMaterialize(h: Harness): Promise<Identities> {
  const intake = await handleAuthenticatedRoute(
    request("/api/v1/sales/leads", duplicateLeadBody(), "iro208-intake-0001"),
    h.env,
    auth("ops"),
  );
  assert.equal(intake.status, 200, await intake.clone().text());
  const accepted = await intake.json() as { lead: { envelope_id: string; duplicate: boolean } };
  assert.equal(accepted.lead.duplicate, false);
  const duplicate = await handleAuthenticatedRoute(
    request("/api/v1/sales/leads", duplicateLeadBody(), "iro208-intake-duplicate-0001"),
    h.env,
    auth("ops"),
  );
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  const duplicateBody = await duplicate.json() as { lead: { duplicate: boolean; envelope_id: string } };
  assert.equal(duplicateBody.lead.duplicate, true);
  assert.equal(duplicateBody.lead.envelope_id, accepted.lead.envelope_id);
  const queued = h.queue.messages.splice(0).map((body) => ({
    body,
    ack() {},
    retry() { throw new Error("queue_retry_unexpected"); },
  }));
  await worker.queue({ queue: "ironwrap-jobs", messages: queued } as never, h.env as never, {} as never);
  const sales = await buildSalesReadModel(h.env, auth("ops"));
  assert.equal(sales.leads.length, 1);
  const lead = sales.leads[0]!;
  assert.equal(lead.contact.email, CUSTOMER_EMAIL);
  assert.ok(lead.job?.id);
  const job = h.db.raw.prepare(
    `SELECT customer_id, property_id FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
  ).get(TENANT, lead.job!.id) as { customer_id: string; property_id: string };
  assert.ok(job.property_id);
  return {
    envelopeId: accepted.lead.envelope_id,
    leadId: lead.id,
    customerId: job.customer_id,
    propertyId: job.property_id,
    jobId: lead.job!.id,
  };
}

interface Harness {
  db: SqliteD1;
  raw: MemoryR2;
  queue: QueueDouble;
  env: AppEnv;
  fake: FakeIntegrations;
  restore(): void;
}

function setup(lastMigration?: string): Harness {
  const db = new SqliteD1(lastMigration);
  const raw = new MemoryR2();
  const queue = new QueueDouble();
  const fake = new FakeIntegrations();
  const envValue = env(db, raw, queue);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetcher;
  return {
    db, raw, queue, env: envValue, fake,
    restore() {
      globalThis.fetch = originalFetch;
      db.raw.close();
    },
  };
}

async function runPublicationEffect(
  h: Harness,
  permit: Record<string, unknown>,
  ids: Identities,
  effectId: string,
  mode: "success" | "refused" | "lost" | "mismatch",
): Promise<void> {
  const expected = {
    proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
    proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
    publication_version: 1,
    state: "published",
  };
  await runExternalEffect(
    h.env,
    {
      effectId, tenantId: TENANT, actor: { type: "worker", id: OPS_ID }, taskId: `task:${effectId}`,
      authority: {
        permitRef: String(permit.permit_id), policyRef: String(permit.policy_ref), policyVersion: String(permit.policy_version),
        tenantId: TENANT, actorType: "worker", actorId: OPS_ID, expiresAt: String(permit.expires_at),
        allowedActions: ["proposal.publish"],
      },
      aggregate: { type: "proposal_publication", id: expected.proposal_pack_id, version: 1 },
      intentId: expected.proposal_revision_id, action: "proposal.publish", request: expected,
      provider: "synthetic-publication-provider", providerAccountRef: TENANT,
      idempotencyKey: `${effectId}:key`, deadlineAt: new Date(Date.parse(String(permit.expires_at)) - 1_000).toISOString(),
      preconditions: {}, evidenceRefs: EVIDENCE.map((entry) => entry.ref), expectedReadback: expected,
      correlationId: effectId,
    },
    {
      async dispatch() {
        if (mode === "lost") throw new Error("synthetic_provider_response_lost");
        if (mode === "refused") return { outcome: "rejected" as const, detailCode: "provider_refused" };
        return {
          outcome: "accepted" as const,
          value: { published: true },
          providerExternalId: effectId,
          providerResponse: { publication: mode === "mismatch" ? "different" : "published" },
          readback: {
            status: "match" as const,
            observed: mode === "mismatch" ? { ...expected, state: "withdrawn" } : expected,
          },
        };
      },
      async replay() {
        return { published: true };
      },
    },
  );
}

async function preparePublication(h: Harness, ids: Identities, idempotencyKey: string): Promise<Record<string, unknown>> {
  const response = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-publications/prepare", {
      proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
      proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
      publication_version: 1, previous_state: "draft", state: "published",
      facts_observed_at: new Date().toISOString(), evidence: EVIDENCE,
    }, idempotencyKey), h.env, auth("ops"),
  );
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { permit: Record<string, unknown> }).permit;
}

async function issuePortalLink(h: Harness, ids: Identities): Promise<string> {
  const response = await handleAuthenticatedRoute(
    request("/api/v1/customer-portal/links", {
      roof_job_id: ids.jobId,
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, "iro208-portal-link-0001"),
    h.env,
    auth("owner"),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { portal_url: string };
  const token = new URL(body.portal_url).hash.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token);
  return token;
}

async function acceptPublicContract(h: Harness, token: string): Promise<string> {
  const resolved = await worker.fetch(
    publicRequest("/api/v1/customer-portal/resolve", { token }), h.env as never, {} as never,
  );
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const challenge = await worker.fetch(
    publicRequest("/api/v1/customer-portal/acceptance/challenge", { token }), h.env as never, {} as never,
  );
  assert.equal(challenge.status, 200, await challenge.clone().text());
  const challengeToken = h.fake.sentEmails.at(-1)?.match(/contract-accept#token=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(challengeToken);
  h.db.throwNextBatchAfterCommit = true;
  const confirmed = await worker.fetch(
    publicRequest("/api/v1/customer-portal/acceptance/confirm", { token: challengeToken, signer_name: "Ada Customer", accepted: true }, "iro208-acceptance-0001"),
    h.env as never,
    {} as never,
  );
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const body = await confirmed.json() as { status: string; acceptance_id: string };
  assert.equal(body.status, "accepted");
  return body.acceptance_id;
}

async function connectQuickBooks(h: Harness): Promise<void> {
  const handoff = await handleAuthenticatedRoute(
    request("/api/v1/quickbooks/connect", { return_path: "/accounting/quickbooks" }, "iro208-qbo-connect-0001"),
    h.env,
    auth("owner"),
  );
  assert.equal(handoff.status, 201, await handoff.clone().text());
  const body = await handoff.json() as { connect_url: string; redirect_uri: string };
  const authorization = new URL(body.connect_url);
  const callback = new URL(body.redirect_uri);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-oauth-code");
  callback.searchParams.set("realmId", "1234567890");
  const connected = await worker.fetch(new Request(callback), h.env as never, {} as never);
  assert.equal(connected.status, 303, await connected.clone().text());
}

async function publishSyntheticContract(
  h: Harness,
  ids: Identities,
  terms: Record<string, unknown>,
  label: string,
  lines?: Array<Record<string, unknown>>,
): Promise<void> {
  const triage = await handleAuthenticatedRoute(
    request("/api/v1/commercial/lead-triage-decisions", {
      lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "normal",
      category: "replacement", summary: `Synthetic ${label} triage.`, next_action: "Prepare the synthetic proposal.",
    }, `iro208-invalid-${label}-triage-0001`), h.env, auth("ops"),
  );
  assert.equal(triage.status, 201, await triage.clone().text());
  const quote = await handleAuthenticatedRoute(
    request("/api/v1/commercial/quote-revisions", quoteBody(ids, new Date().toISOString(), terms, lines), `iro208-invalid-${label}-quote-0001`), h.env, auth("ops"),
  );
  assert.equal(quote.status, 201, await quote.clone().text());
  const proposal = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-revisions", proposalBody(ids, new Date().toISOString(), terms), `iro208-invalid-${label}-proposal-0001`), h.env, auth("ops"),
  );
  assert.equal(proposal.status, 201, await proposal.clone().text());
  const permit = await preparePublication(h, ids, `iro208-invalid-${label}-publication-prepare-0001`);
  await runPublicationEffect(h, permit, ids, `effect:iro208:invalid:${label}`, "success");
  const settled = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-publications", {
      proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
      proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
      publication_version: 1, previous_state: "draft", state: "published",
      permit_id: permit.permit_id, external_effect_id: `effect:iro208:invalid:${label}`,
    }, `iro208-invalid-${label}-publication-settle-0001`), h.env, auth("ops"),
  );
  assert.equal(settled.status, 201, await settled.clone().text());
}

function totalChanges(database: DatabaseSync): number {
  return Number((database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function reconcileTaxCase(input: {
  label: string;
  terms?: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, input.terms ?? TERMS, input.label, input.lines);
    const token = await issuePortalLink(h, ids);
    const acceptanceId = await acceptPublicContract(h, token);
    await configureDepositAccounting(h, ids, input.label);
    const reconciled = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, `iro208-tax-reconcile-${input.label}-00001`),
      h.env,
      auth("owner"),
    );
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    return await reconciled.json() as Record<string, unknown>;
  } finally {
    h.restore();
  }
}

async function configureDepositAccounting(h: Harness, ids: Identities, label: string): Promise<void> {
  await connectQuickBooks(h);
  const tax = await handleAuthenticatedRoute(
    request("/api/v1/accounting/tax/snapshots", {
      jurisdiction: "CA-AB", tax_code: "GST", provider_tax_code_id: "701", rate_percent: "5.0000",
      effective_from: new Date().toISOString().slice(0, 10), effective_to: null,
      source_ref: `Synthetic technical reference for ${label}; not customer proof.`,
    }, `iro208-tax-${label}-00001`), h.env, auth("owner"),
  );
  assert.equal(tax.status, 201, await tax.clone().text());
  const mapping = await handleAuthenticatedRoute(
    request("/api/v1/quickbooks/final-invoice-mappings", {
      roof_job_id: ids.jobId, qbo_customer_id: "501", qbo_item_id: "601", qbo_tax_code_id: "701", qbo_terms_id: "801",
      jurisdiction: "CA-AB", tax_code: "GST", payment_terms_days: 30, correction_reason: null,
    }, `iro208-mapping-${label}-00001`), h.env, auth("owner"), { quickBooksFetcher: h.fake.fetcher },
  );
  assert.equal(mapping.status, 200, await mapping.clone().text());
}

test("0116 backfills shipped acceptances into the native activation and deposit queue", async () => {
  const h = setup("0115_company_profile_convergence.sql");
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, TERMS, "upgrade-backfill");
    const acceptanceId = await acceptPublicContract(h, await issuePortalLink(h, ids));
    assert.equal(
      h.db.raw.prepare(
        "SELECT COUNT(*) AS count FROM commercial_acceptance_bindings WHERE acceptance_id = ?",
      ).get(acceptanceId)!.count,
      1,
    );
    assert.equal(
      h.db.raw.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'commercial_deposit_derivations'",
      ).get()!.count,
      0,
    );

    h.db.raw.exec(readFileSync(
      new URL("../migrations/0116_native_commercial_deposit_derivation.sql", import.meta.url),
      "utf8",
    ));

    const derivation = h.db.raw.prepare(
      `SELECT acceptance_id, state, deposit_percent, quote_total_cents
         FROM commercial_deposit_derivations WHERE acceptance_id = ?`,
    ).get(acceptanceId) as {
      acceptance_id: string;
      state: string;
      deposit_percent: number;
      quote_total_cents: number;
    };
    assert.deepEqual({ ...derivation }, {
      acceptance_id: acceptanceId,
      state: "pending",
      deposit_percent: 25,
      quote_total_cents: 105_000,
    });
    assert.equal(
      h.db.raw.prepare(
        `SELECT event_type FROM commercial_deposit_derivation_events
          WHERE derivation_id = (
            SELECT derivation_id FROM commercial_deposit_derivations WHERE acceptance_id = ?
          )`,
      ).get(acceptanceId)!.event_type,
      "enqueued",
    );
    assert.equal(
      h.db.raw.prepare("SELECT lifecycle_status FROM operating_customers WHERE customer_id = ?")
        .get(ids.customerId)!.lifecycle_status,
      "active",
    );
    assert.equal(
      h.db.raw.prepare("SELECT lifecycle_status FROM operating_leads WHERE lead_id = ?")
        .get(ids.leadId)!.lifecycle_status,
      "converted",
    );
  } finally {
    h.restore();
  }
});

test("acceptance refuses non-integer and out-of-range deposit percentages atomically", async () => {
  const cases: Array<[string, unknown]> = [["string", "25"], ["decimal", 25.5], ["range", 101]];
  for (const [label, depositPercent] of cases) {
    const h = setup();
    try {
      const ids = await intakeAndMaterialize(h);
      await publishSyntheticContract(h, ids, { ...TERMS, deposit_percent: depositPercent }, label);
      const token = await issuePortalLink(h, ids);
      const challenge = await worker.fetch(
        publicRequest("/api/v1/customer-portal/acceptance/challenge", { token }), h.env as never, {} as never,
      );
      assert.equal(challenge.status, 200, await challenge.clone().text());
      const challengeToken = h.fake.sentEmails.at(-1)?.match(/contract-accept#token=([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(challengeToken);
      const confirmed = await worker.fetch(
        publicRequest("/api/v1/customer-portal/acceptance/confirm", {
          token: challengeToken, signer_name: "Ada Customer", accepted: true,
        }, `iro208-invalid-${label}-acceptance-0001`), h.env as never, {} as never,
      );
      assert.equal(confirmed.status, 503, await confirmed.clone().text());
      assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings").get()!.count, 0);
      assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_deposit_derivations").get()!.count, 0);
    } finally {
      h.restore();
    }
  }
});

test("commercial deposit tax is bound to one provider code, snapshot rate, and exact deposit rounding", async () => {
  assert.equal(taxForSubtotal(11, "5.0000"), 1);
  assert.equal(taxForSubtotal(6, "5.0000"), 0);

  const wrongTax = await reconcileTaxCase({
    label: "wrong-tax",
    lines: [{
      line_id: "scope:roof", sequence: 1, kind: "labour", description: "Wrong accepted tax",
      quantity_micros: 1_000_000, uom: "job", unit_price_cents: 100_000, tax_code: "GST", tax_cents: 6_000,
    }],
  });
  assert.equal((wrongTax.derivation as Record<string, unknown>).state, "blocked");
  assert.equal((wrongTax.derivation as Record<string, unknown>).blocker_code, "commercial_tax_snapshot_mismatch");
  assert.equal(wrongTax.intent, null);

  const wrongCode = await reconcileTaxCase({
    label: "wrong-code",
    lines: [{
      line_id: "scope:roof", sequence: 1, kind: "labour", description: "Wrong provider code",
      quantity_micros: 1_000_000, uom: "job", unit_price_cents: 100_000, tax_code: "PST", tax_cents: 5_000,
    }],
  });
  assert.equal((wrongCode.derivation as Record<string, unknown>).state, "blocked");
  assert.equal((wrongCode.derivation as Record<string, unknown>).blocker_code, "commercial_tax_code_ambiguous");
  assert.equal(wrongCode.intent, null);

  const mixedCode = await reconcileTaxCase({
    label: "mixed-code",
    lines: [
      {
        line_id: "scope:gst", sequence: 1, kind: "labour", description: "GST line",
        quantity_micros: 1_000_000, uom: "job", unit_price_cents: 50_000, tax_code: "GST", tax_cents: 2_500,
      },
      {
        line_id: "scope:pst", sequence: 2, kind: "material", description: "PST line",
        quantity_micros: 1_000_000, uom: "job", unit_price_cents: 50_000, tax_code: "PST", tax_cents: 2_500,
      },
    ],
  });
  assert.equal((mixedCode.derivation as Record<string, unknown>).state, "blocked");
  assert.equal((mixedCode.derivation as Record<string, unknown>).blocker_code, "commercial_tax_code_ambiguous");
  assert.equal(mixedCode.intent, null);

  const rounded = await reconcileTaxCase({
    label: "rounding-edge",
    terms: { ...TERMS, deposit_percent: 50 },
    lines: [{
      line_id: "scope:rounding", sequence: 1, kind: "labour", description: "Half-cent deposit tax edge",
      quantity_micros: 1_000_000, uom: "job", unit_price_cents: 11, tax_code: "GST", tax_cents: 1,
    }],
  });
  assert.equal((rounded.derivation as Record<string, unknown>).state, "derived");
  assert.equal((rounded.intent as Record<string, unknown>).total_amount, "0.06");
});

test("commercial derivation and phase readers fail closed on races, partial payment, and warranty claims", async () => {
  const raceDb = new DerivationRaceDb();
  const raced = await ensureCommercialDepositDerivation(
    { DB: raceDb as never } as AppEnv,
    { tenantId: TENANT, acceptanceId: raceDb.derivation.acceptance_id },
  );
  assert.ok(raced);
  assert.equal(raced.derivation.state, "derived");
  assert.equal(raced.replayed, true);
  assert.equal(raced.intent?.intent_id, raceDb.intent.intent_id);

  const blockedRaceDb = new DerivationRaceDb();
  blockedRaceDb.winnerState = "blocked";
  const blockedRace = await deriveSuccess(
    { DB: blockedRaceDb as never } as AppEnv,
    blockedRaceDb.derivation,
    blockedRaceDb.intent as AccountingIntentRecord,
    "e".repeat(64),
    new Date(),
  );
  assert.ok(blockedRace);
  assert.equal(blockedRace.derivation.state, "blocked");
  assert.equal(blockedRace.intent, null);

  const pendingRaceDb = new DerivationRaceDb();
  pendingRaceDb.winnerState = "pending";
  const pendingRace = await deriveSuccess(
    { DB: pendingRaceDb as never } as AppEnv,
    pendingRaceDb.derivation,
    pendingRaceDb.intent as AccountingIntentRecord,
    "f".repeat(64),
    new Date(),
  );
  assert.ok(pendingRace);
  assert.equal(pendingRace.derivation.state, "pending");
  assert.equal(pendingRace.intent, null);

  assert.equal(
    depositIntentIsReconciled("acct-intent:partial", [{ intent_id: "acct-intent:partial", state: "partially_settled" }]),
    false,
  );
  assert.equal(
    depositIntentIsReconciled("acct-intent:reconciled", [{ intent_id: "acct-intent:reconciled", state: "reconciled" }]),
    true,
  );

  const phaseInput = {
    jobStatus: "qualified", leadStatus: "converted",
    quote: {} as never, proposal: {} as never,
    publication: { state: "published" } as never,
    acceptance: {} as never, deposit: { state: "derived", intent_id: "acct-intent:reconciled" } as never,
    depositReconciled: true, finalInvoiceReconciled: true, allRequiredGatesReady: true,
    safetyBlocked: false, assignment: null, workPackage: null, completionPacket: null,
  };
  assert.equal(derivePhase(phaseInput), "production_ready");
  assert.equal(derivePhase({ ...phaseInput, safetyBlocked: true }), "safety_blocked");
  assert.equal(derivePhase({ ...phaseInput, jobStatus: "cancelled", safetyBlocked: true }), "cancelled");
  assert.equal(
    derivePhase({ ...phaseInput, completionPacket: {} as never }),
    "financially_closed",
  );
  assert.equal(
    derivePhase({
      ...phaseInput,
      finalInvoiceReconciled: false,
      workPackage: { status: "Completed" } as never,
    }),
    "production_ready",
  );
  assert.equal(
    derivePhase({
      ...phaseInput,
      quote: null,
      proposal: null,
      publication: null,
      acceptance: null,
      deposit: null,
      depositReconciled: false,
      safetyBlocked: true,
    }),
    "safety_blocked",
  );
  assert.equal(
    selectPhaseWorkPackage([
      { work_package_id: "wp-complete", version: 1, status: "Completed", updated_at: "2026-08-24T12:00:00.000Z" },
      { work_package_id: "wp-active", version: 1, status: "In Progress", updated_at: "2026-08-24T11:00:00.000Z" },
    ])?.work_package_id,
    "wp-active",
  );
});

test("IRO-208 no-seed native lead-to-deposit reference path is governed and recoverable", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    const staleTriage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "high",
        category: "replacement", summary: "Synthetic qualified lead.", next_action: "Prepare approved quote.",
      }, "iro208-triage-0001"), h.env, auth("ops"),
    );
    assert.equal(staleTriage.status, 201, await staleTriage.clone().text());
    const staleReplay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "high",
        category: "replacement", summary: "Synthetic stale revision.", next_action: "Must refuse stale revision.",
      }, "iro208-triage-stale-0001"), h.env, auth("ops"),
    );
    assert.equal(staleReplay.status, 409);
    assert.deepEqual(await staleReplay.json(), { error: "commercial_triage_version_conflict" });

    const unauthorizedQuote = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", quoteBody(ids, new Date().toISOString()), "iro208-quote-unauthorized-0001"),
      h.env, auth("production"),
    );
    assert.equal(unauthorizedQuote.status, 403);

    const quoteInput = quoteBody(ids, new Date().toISOString());
    const quote = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", quoteInput, "iro208-quote-0001"),
      h.env, auth("ops"),
    );
    assert.equal(quote.status, 201, await quote.clone().text());
    const proposalInput = proposalBody(ids, new Date().toISOString());
    const proposal = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", proposalInput, "iro208-proposal-0001"),
      h.env, auth("ops"),
    );
    assert.equal(proposal.status, 201, await proposal.clone().text());
    const unknownPermit = await preparePublication(h, ids, "iro208-publication-prepare-unknown-0001");
    const unknownSettlementBody = {
      proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
      proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
      publication_version: 1, previous_state: "draft", state: "published",
      permit_id: unknownPermit.permit_id, external_effect_id: "effect:iro208:unknown",
    };
    const unknown = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", unknownSettlementBody, "iro208-publication-unknown-0001"), h.env, auth("ops"),
    );
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), { error: "commercial_publication_effect_mismatch" });
    const refusedPermit = await preparePublication(h, ids, "iro208-publication-prepare-refused-0001");
    await runPublicationEffect(h, refusedPermit, ids, "effect:iro208:refused", "refused");
    const refused = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: refusedPermit.permit_id, external_effect_id: "effect:iro208:refused" }, "iro208-publication-refused-0001"), h.env, auth("ops"),
    );
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "commercial_publication_effect_mismatch" });
    const lostPermit = await preparePublication(h, ids, "iro208-publication-prepare-lost-0001");
    await runPublicationEffect(h, lostPermit, ids, "effect:iro208:lost", "lost");
    const lost = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: lostPermit.permit_id, external_effect_id: "effect:iro208:lost" }, "iro208-publication-lost-0001"), h.env, auth("ops"),
    );
    assert.equal(lost.status, 409);
    const mismatchPermit = await preparePublication(h, ids, "iro208-publication-prepare-mismatch-0001");
    await runPublicationEffect(h, mismatchPermit, ids, "effect:iro208:mismatch", "mismatch");
    const mismatch = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: mismatchPermit.permit_id, external_effect_id: "effect:iro208:mismatch" }, "iro208-publication-mismatch-0001"), h.env, auth("ops"),
    );
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: "commercial_publication_effect_mismatch" });
    const successPermit = await preparePublication(h, ids, "iro208-publication-prepare-success-0001");
    await runPublicationEffect(h, successPermit, ids, "effect:iro208:success", "success");
    const settled = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: successPermit.permit_id, external_effect_id: "effect:iro208:success" }, "iro208-publication-success-0001"), h.env, auth("ops"),
    );
    assert.equal(settled.status, 201, await settled.clone().text());
    const otherActor = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: successPermit.permit_id, external_effect_id: "effect:iro208:success" }, "iro208-publication-other-actor-0001"), h.env, auth("ops", OTHER_OPS_ID),
    );
    assert.equal(otherActor.status, 403);
    assert.deepEqual(await otherActor.json(), { error: "commercial_permit_actor_mismatch" });
    const settledReplay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: successPermit.permit_id, external_effect_id: "effect:iro208:success" }, "iro208-publication-success-0001"), h.env, auth("ops"),
    );
    assert.equal(settledReplay.status, 200);

    const portalToken = await issuePortalLink(h, ids);
    const acceptanceId = await acceptPublicContract(h, portalToken);
    const quoteReplayAfterConversion = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", quoteInput, "iro208-quote-0001"),
      h.env,
      auth("ops"),
    );
    assert.equal(quoteReplayAfterConversion.status, 200, await quoteReplayAfterConversion.clone().text());
    assert.equal((await quoteReplayAfterConversion.json() as { replayed: boolean }).replayed, true);
    const proposalReplayAfterConversion = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", proposalInput, "iro208-proposal-0001"),
      h.env,
      auth("ops"),
    );
    assert.equal(proposalReplayAfterConversion.status, 200, await proposalReplayAfterConversion.clone().text());
    assert.equal((await proposalReplayAfterConversion.json() as { replayed: boolean }).replayed, true);
    const blocked = h.db.raw.prepare(
      `SELECT state, blocker_code FROM commercial_deposit_derivations WHERE tenant_id = ? AND acceptance_id = ?`,
    ).get(TENANT, acceptanceId) as { state: string; blocker_code: string };
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.blocker_code, "provider_mapping_missing");
    const blockedTerminal = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-blocked-terminal-0001"),
      h.env,
      auth("owner"),
    );
    assert.equal(blockedTerminal.status, 200, await blockedTerminal.clone().text());
    const blockedTerminalBody = await blockedTerminal.json() as {
      request: { state: string; replayed: boolean };
      derivation: { state: string; blocker_code: string; version: number };
      intent: unknown;
    };
    assert.equal(blockedTerminalBody.request.state, "blocked");
    assert.equal(blockedTerminalBody.request.replayed, false);
    assert.equal(blockedTerminalBody.derivation.state, "blocked");
    assert.equal(blockedTerminalBody.derivation.blocker_code, "provider_mapping_missing");
    assert.equal(blockedTerminalBody.intent, null);
    const fingerprintRequest = await beginCommercialDepositDerivationRequest(h.env, {
      tenantId: TENANT,
      acceptanceId,
      actorUserId: OWNER_ID,
      idempotencyKey: "iro208-deposit-fingerprint-0001",
      policyVersion: "policy-v1",
      evidenceRefs: ["r2://technical-reference/iro208/reconcile.json"],
    });
    assert.equal(fingerprintRequest?.replayed, false);
    await assert.rejects(
      beginCommercialDepositDerivationRequest(h.env, {
        tenantId: TENANT,
        acceptanceId,
        actorUserId: OWNER_ID,
        idempotencyKey: "iro208-deposit-fingerprint-0001",
        policyVersion: "policy-v2",
        evidenceRefs: ["r2://technical-reference/iro208/reconcile.json"],
      }),
      /commercial_deposit_reconcile_idempotency_conflict/,
    );
    await assert.rejects(
      beginCommercialDepositDerivationRequest(h.env, {
        tenantId: TENANT,
        acceptanceId,
        actorUserId: OWNER_ID,
        idempotencyKey: "iro208-deposit-fingerprint-0001",
        policyVersion: "policy-v1",
        evidenceRefs: ["r2://technical-reference/iro208/other.json"],
      }),
      /commercial_deposit_reconcile_idempotency_conflict/,
    );
    const unauthorizedDeposit = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-unauthorized-0001"), h.env, auth("production"),
    );
    assert.equal(unauthorizedDeposit.status, 403);
    assert.deepEqual(await unauthorizedDeposit.json(), { error: "accounting_review_required" });

    await connectQuickBooks(h);
    const tax = await handleAuthenticatedRoute(
      request("/api/v1/accounting/tax/snapshots", {
        jurisdiction: "CA-AB", tax_code: "GST", provider_tax_code_id: "701", rate_percent: "5.0000",
        effective_from: new Date().toISOString().slice(0, 10), effective_to: null,
        source_ref: "Synthetic technical reference; not customer proof.",
      }, "iro208-tax-00001"), h.env, auth("owner"),
    );
    assert.equal(tax.status, 201, await tax.clone().text());
    const mapping = await handleAuthenticatedRoute(
      request("/api/v1/quickbooks/final-invoice-mappings", {
        roof_job_id: ids.jobId, qbo_customer_id: "501", qbo_item_id: "601", qbo_tax_code_id: "701", qbo_terms_id: "801",
        jurisdiction: "CA-AB", tax_code: "GST", payment_terms_days: 30, correction_reason: null,
      }, "iro208-mapping-0001"), h.env, auth("owner"), { quickBooksFetcher: h.fake.fetcher },
    );
    assert.equal(mapping.status, 200, await mapping.clone().text());
    const reconciled = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-reconcile-0001"), h.env, auth("owner"),
    );
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    const reconciledBody = await reconciled.json() as { request: { state: string }; derivation: { state: string; intent_id: string | null }; intent: { intent_id: string; total_amount: string } | null };
    assert.equal(reconciledBody.request.state, "derived");
    assert.equal(reconciledBody.derivation.state, "derived");
    assert.ok(reconciledBody.derivation.intent_id);
    assert.ok(reconciledBody.intent?.intent_id);
    assert.equal(reconciledBody.intent?.total_amount, "262.50");
    const providerPayload = JSON.parse(
      (h.db.raw.prepare("SELECT provider_payload_json FROM accounting_intents WHERE intent_id = ?")
        .get(reconciledBody.intent!.intent_id) as { provider_payload_json: string }).provider_payload_json,
    ) as { SalesTermRef?: { value?: string } };
    assert.equal(providerPayload.SalesTermRef?.value, "801");
    const replay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-reconcile-0001"), h.env, auth("owner"),
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { request: { replayed: boolean } }).request.replayed, true);
    const blockedTerminalReplay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-blocked-terminal-0001"),
      h.env,
      auth("owner"),
    );
    assert.equal(blockedTerminalReplay.status, 200, await blockedTerminalReplay.clone().text());
    const blockedTerminalReplayBody = await blockedTerminalReplay.json() as {
      request: { state: string; replayed: boolean };
      derivation: { state: string; blocker_code: string; version: number };
      intent: unknown;
    };
    assert.equal(blockedTerminalReplayBody.request.state, "blocked");
    assert.equal(blockedTerminalReplayBody.request.replayed, true);
    assert.equal(blockedTerminalReplayBody.derivation.state, "blocked");
    assert.equal(blockedTerminalReplayBody.derivation.blocker_code, "provider_mapping_missing");
    assert.equal(blockedTerminalReplayBody.derivation.version, blockedTerminalBody.derivation.version);
    assert.equal(blockedTerminalReplayBody.intent, null);
    const duplicateDerivation = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-reconcile-duplicate-0001"), h.env, auth("owner"),
    );
    assert.equal(duplicateDerivation.status, 200);
    assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_deposit_derivations").get()!.count, 1);
    assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_intents WHERE kind = 'deposit_invoice'").get()!.count, 1);

    const phase = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(ids.jobId)}/phase`), h.env, auth("owner"),
    );
    assert.equal(phase.status, 200, await phase.clone().text());
    const phaseBody = await phase.json() as { phase: string; facts: { commercial: { acceptance: Record<string, unknown> | null; deposit_derivation: { state: string; intent_id: string | null } | null }; safety: { blocked: boolean } } };
    assert.equal(phaseBody.phase, "deposit_pending");
    assert.equal(phaseBody.facts.commercial.acceptance?.acceptance_id, acceptanceId);
    assert.equal(phaseBody.facts.commercial.deposit_derivation?.state, "derived");
    assert.ok(phaseBody.facts.commercial.deposit_derivation?.intent_id);
    assert.equal(phaseBody.facts.safety.blocked, false);
  } finally {
    h.restore();
  }
});

test("commercial phase refuses multiple public quote and proposal heads", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "normal",
        category: "replacement", summary: "Synthetic head ambiguity triage.", next_action: "Prepare the synthetic quote.",
      }, "iro208-heads-triage-0001"), h.env, auth("ops"),
    );
    assert.equal(triage.status, 201, await triage.clone().text());
    const quote = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", quoteBody(ids, new Date().toISOString()), "iro208-heads-quote-0001"),
      h.env, auth("ops"),
    );
    assert.equal(quote.status, 201, await quote.clone().text());
    const proposal = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", proposalBody(ids, new Date().toISOString()), "iro208-heads-proposal-0001"),
      h.env, auth("ops"),
    );
    assert.equal(proposal.status, 201, await proposal.clone().text());

    const secondProposal = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        {
          ...proposalBody(ids, new Date().toISOString()),
          proposal_revision_id: `proposal-revision:iro208:${ids.leadId}:second`,
          proposal_pack_id: `proposal-pack:iro208:${ids.leadId}:second`,
          content_ref: `r2://technical-reference/iro208/${ids.leadId}/second.pdf`,
        },
        "iro208-heads-proposal-0002",
      ),
      h.env,
      auth("ops"),
    );
    assert.equal(secondProposal.status, 201, await secondProposal.clone().text());
    const proposalPhase = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(ids.jobId)}/phase`), h.env, auth("owner"),
    );
    assert.equal(proposalPhase.status, 200, await proposalPhase.clone().text());
    const proposalPhaseBody = await proposalPhase.json() as {
      phase: string;
      stale_reasons: string[];
      facts: { commercial: { quote: unknown; proposal: unknown; acceptance: unknown; deposit_derivation: unknown } };
    };
    assert.equal(proposalPhaseBody.phase, "commercial_in_progress");
    assert.ok(proposalPhaseBody.facts.commercial.quote);
    assert.equal(proposalPhaseBody.facts.commercial.proposal, null);
    assert.equal(proposalPhaseBody.facts.commercial.acceptance, null);
    assert.equal(proposalPhaseBody.facts.commercial.deposit_derivation, null);
    assert.ok(proposalPhaseBody.stale_reasons.includes("commercial.proposal_head_ambiguous"));

    const secondQuote = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/quote-revisions",
        {
          ...quoteBody(ids, new Date().toISOString()),
          quote_revision_id: `quote-revision:iro208:${ids.leadId}:second`,
          customer_quote_id: `customer-quote:iro208:${ids.leadId}:second`,
        },
        "iro208-heads-quote-0002",
      ),
      h.env,
      auth("ops"),
    );
    assert.equal(secondQuote.status, 201, await secondQuote.clone().text());
    const quotePhase = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(ids.jobId)}/phase`), h.env, auth("owner"),
    );
    assert.equal(quotePhase.status, 200, await quotePhase.clone().text());
    const quotePhaseBody = await quotePhase.json() as {
      phase: string;
      stale_reasons: string[];
      facts: { commercial: { quote: unknown; proposal: unknown; acceptance: unknown; deposit_derivation: unknown } };
    };
    assert.equal(quotePhaseBody.phase, "qualified");
    assert.equal(quotePhaseBody.facts.commercial.quote, null);
    assert.equal(quotePhaseBody.facts.commercial.proposal, null);
    assert.equal(quotePhaseBody.facts.commercial.acceptance, null);
    assert.equal(quotePhaseBody.facts.commercial.deposit_derivation, null);
    assert.ok(quotePhaseBody.stale_reasons.includes("commercial.quote_head_ambiguous"));
  } finally {
    h.restore();
  }
});

test("commercial phase refuses two unsuperseded leaves in one quote lineage", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "normal",
        category: "replacement", summary: "Synthetic same-lineage ambiguity triage.", next_action: "Prepare the synthetic quote.",
      }, "iro208-lineage-triage-0001"), h.env, auth("ops"),
    );
    assert.equal(triage.status, 201, await triage.clone().text());
    const base = quoteBody(ids, new Date().toISOString());
    const quote = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", base, "iro208-lineage-quote-0001"),
      h.env,
      auth("ops"),
    );
    assert.equal(quote.status, 201, await quote.clone().text());
    h.db.raw.exec("DROP TRIGGER commercial_quote_revision_sequence_guard");
    for (const revision of [3, 2]) {
      const fork = await handleAuthenticatedRoute(
        request(
          "/api/v1/commercial/quote-revisions",
          {
            ...base,
            quote_revision_id: `${base.quote_revision_id}:fork-${revision}`,
            revision_number: revision,
            supersedes_quote_revision_id: base.quote_revision_id,
            correction_reason: `Synthetic fork revision ${revision} used to prove ambiguity.`,
            facts_observed_at: new Date().toISOString(),
          },
          `iro208-lineage-quote-000${revision}`,
        ),
        h.env,
        auth("ops"),
      );
      assert.equal(fork.status, 201, await fork.clone().text());
    }

    const phase = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(ids.jobId)}/phase`),
      h.env,
      auth("owner"),
    );
    assert.equal(phase.status, 200, await phase.clone().text());
    const body = await phase.json() as {
      phase: string;
      stale_reasons: string[];
      facts: { commercial: { quote: unknown } };
    };
    assert.equal(body.phase, "qualified");
    assert.equal(body.facts.commercial.quote, null);
    assert.ok(body.stale_reasons.includes("commercial.quote_head_ambiguous"));
  } finally {
    h.restore();
  }
});

test("commercial deposit derivation refuses independent quote and proposal heads", async () => {
  for (const headKind of ["quote", "proposal"] as const) {
    const h = setup();
    try {
      const ids = await intakeAndMaterialize(h);
      await publishSyntheticContract(h, ids, TERMS, `independent-${headKind}`);
      if (headKind === "quote") {
        const base = quoteBody(ids, new Date().toISOString());
        const secondQuote = await handleAuthenticatedRoute(
          request(
            "/api/v1/commercial/quote-revisions",
            {
              ...base,
              quote_revision_id: `${base.quote_revision_id}:independent`,
              customer_quote_id: `${base.customer_quote_id}:independent`,
            },
            `iro208-independent-${headKind}-0001`,
          ),
          h.env,
          auth("ops"),
        );
        assert.equal(secondQuote.status, 201, await secondQuote.clone().text());
      } else {
        const base = proposalBody(ids, new Date().toISOString());
        const secondProposal = await handleAuthenticatedRoute(
          request(
            "/api/v1/commercial/proposal-revisions",
            {
              ...base,
              proposal_revision_id: `${base.proposal_revision_id}:independent`,
              proposal_pack_id: `${base.proposal_pack_id}:independent`,
              content_ref: `r2://technical-reference/iro208/${ids.leadId}/independent-proposal.pdf`,
            },
            `iro208-independent-${headKind}-0001`,
          ),
          h.env,
          auth("ops"),
        );
        assert.equal(secondProposal.status, 201, await secondProposal.clone().text());
      }

      const acceptanceId = await acceptPublicContract(h, await issuePortalLink(h, ids));
      const initial = h.db.raw
        .prepare(
          `SELECT state, blocker_code FROM commercial_deposit_derivations
            WHERE tenant_id = ? AND acceptance_id = ?`,
        )
        .get(TENANT, acceptanceId) as { state: string; blocker_code: string | null };
      assert.equal(initial.state, "blocked");
      assert.equal(initial.blocker_code, "commercial_head_changed");

      const retry = await handleAuthenticatedRoute(
        request(
          "/api/v1/commercial/deposit-intents/reconcile",
          { acceptance_id: acceptanceId },
          `iro208-independent-${headKind}-retry-0001`,
        ),
        h.env,
        auth("owner"),
      );
      assert.equal(retry.status, 200, await retry.clone().text());
      const body = await retry.json() as {
        derivation: { state: string; blocker_code: string | null; intent_id: string | null };
        intent: unknown;
      };
      assert.equal(body.derivation.state, "blocked");
      assert.equal(body.derivation.blocker_code, "commercial_head_changed");
      assert.equal(body.derivation.intent_id, null);
      assert.equal(body.intent, null);
    } finally {
      h.restore();
    }
  }
});

test("terminal failed deposit reconciliation replays without work while a fresh key recovers", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, TERMS, "failed-terminal");
    const acceptanceId = await acceptPublicContract(h, await issuePortalLink(h, ids));
    await configureDepositAccounting(h, ids, "failed-terminal");

    const originalPrepare = h.db.prepare.bind(h.db);
    h.db.prepare = ((sql: string) => {
      if (sql.includes("accounting_intents")) throw new Error("synthetic_reconcile_failure");
      return originalPrepare(sql);
    }) as typeof h.db.prepare;
    const failed = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-failed-terminal-0001"),
      h.env,
      auth("owner"),
    );
    assert.equal(failed.status, 502);
    const requestRow = h.db.raw.prepare(
      `SELECT state, derivation_version FROM commercial_deposit_derivation_requests
        WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(TENANT) as { state: string; derivation_version: number };
    assert.equal(requestRow.state, "failed");
    const derivationBeforeReplay = h.db.raw.prepare(
      `SELECT state, version FROM commercial_deposit_derivations WHERE tenant_id = ? AND acceptance_id = ?`,
    ).get(TENANT, acceptanceId) as { state: string; version: number };
    assert.equal(derivationBeforeReplay.state, "blocked");
    const failedReplay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-failed-terminal-0001"),
      h.env,
      auth("owner"),
    );
    assert.equal(failedReplay.status, 502);
    const derivationAfterReplay = h.db.raw.prepare(
      `SELECT state, version FROM commercial_deposit_derivations WHERE tenant_id = ? AND acceptance_id = ?`,
    ).get(TENANT, acceptanceId) as { state: string; version: number };
    assert.deepEqual(derivationAfterReplay, derivationBeforeReplay);

    h.db.prepare = originalPrepare;
    const recovered = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: acceptanceId }, "iro208-deposit-failed-recovery-0001"),
      h.env,
      auth("owner"),
    );
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json() as { derivation: { state: string } }).derivation.state, "derived");
  } finally {
    h.restore();
  }
});

test("deposit derivation blocks a superseding quote that arrives after acceptance", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, TERMS, "stale-commercial-head");
    const acceptanceId = await acceptPublicContract(h, await issuePortalLink(h, ids));
    const initial = h.db.raw.prepare(
      `SELECT state, blocker_code FROM commercial_deposit_derivations
        WHERE tenant_id = ? AND acceptance_id = ?`,
    ).get(TENANT, acceptanceId) as { state: string; blocker_code: string | null };
    assert.equal(initial.state, "blocked");
    assert.equal(initial.blocker_code, "provider_mapping_missing");

    const originalQuote = quoteBody(ids, new Date().toISOString());
    const correction = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/quote-revisions",
        {
          ...originalQuote,
          quote_revision_id: `quote-revision:iro208:${ids.leadId}:correction`,
          revision_number: 2,
          supersedes_quote_revision_id: originalQuote.quote_revision_id,
          correction_reason: "Synthetic correction used to prove stale acceptance blocking.",
          facts_observed_at: new Date().toISOString(),
        },
        "iro208-stale-commercial-head-correction-0001",
      ),
      h.env,
      auth("ops"),
    );
    assert.equal(correction.status, 201, await correction.clone().text());

    const retry = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/deposit-intents/reconcile",
        { acceptance_id: acceptanceId },
        "iro208-stale-commercial-head-retry-0001",
      ),
      h.env,
      auth("owner"),
    );
    assert.equal(retry.status, 200, await retry.clone().text());
    const body = await retry.json() as {
      derivation: { state: string; blocker_code: string | null; intent_id: string | null };
      intent: unknown;
    };
    assert.equal(body.derivation.state, "blocked");
    assert.equal(body.derivation.blocker_code, "commercial_head_changed");
    assert.equal(body.derivation.intent_id, null);
    assert.equal(body.intent, null);
  } finally {
    h.restore();
  }
});
