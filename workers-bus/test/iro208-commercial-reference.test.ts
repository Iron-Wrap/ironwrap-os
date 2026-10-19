import assert from "node:assert/strict";
import {
  sourceBindingChanges,
  type CommercialContextReadModel,
} from "../src/commercial-context.ts";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import { buildSalesReadModel } from "../src/app-read-models.ts";
import { reconcileExternalEffect, runExternalEffect } from "../src/effect-runtime.ts";
import { recordProposalDeliveryConfirmation } from "../src/commercial-store.ts";
import {
  beginCommercialDepositDerivationRequest,
  deriveSuccess,
  ensureCommercialDepositDerivation,
  type CommercialDepositDerivationRecord,
} from "../src/commercial-deposit.ts";
import {
  readAccountingIntent,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import { taxForSubtotal } from "../src/native-final-invoice-producer.ts";
import {
  derivePhase,
  depositIntentIsReconciled,
  selectPhaseWorkPackage,
} from "../src/commercial-job-phase.ts";
import { recordLegacyGateStates } from "./production-gate-ledger-fixture.ts";

const TENANT = "ironwrap";
const PUBLIC_ORIGIN = "https://app.example.invalid";
const OWNER_ID = "appu_owner_0001";
const OPS_ID = "appu_ops_0001";
const OTHER_OPS_ID = "appu_ops_0002";
const ACCOUNTANT_ID = "appu_accounting_0001";
const SECOND_ACCOUNTANT_ID = "appu_accounting_0002";
const CUSTOMER_EMAIL = "customer@example.invalid";
const CUSTOMER_PHONE = "+14035550101";
const QB_REALM_ID = "1234567890";
const QB_WEBHOOK_TOKEN = "iro250-synthetic-webhook-verifier-token";
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
    // A truncated chain still has to be WRITABLE by the shipped intake path, and
    // `insertEnvelope` writes `envelopes.release_smoke` (0133, IRO-264). The column
    // is unrelated to whatever upgrade a truncated chain is proving, so it is
    // carried forward rather than making the writer tolerate a missing column.
    if (lastMigration && lastMigration < "0133") {
      this.raw.exec(readFileSync(new URL("0133_envelope_release_smoke.sql", directory), "utf8"));
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
    insert.run(ACCOUNTANT_ID, TENANT, "accounting@example.invalid", "Accounting", "ops", "accounting", "accounting@example.invalid", now, now);
    insert.run(SECOND_ACCOUNTANT_ID, TENANT, "second-accounting@example.invalid", "Second Accounting", "ops", "accounting", "second-accounting@example.invalid", now, now);
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
  readonly quickBooksCalls: Array<{
    method: string;
    url: string;
    authorization: string | null;
  }> = [];
  readonly providerInvoices = new Map<string, Record<string, unknown>>();
  readonly providerPayments = new Map<string, Record<string, unknown>>();
  private readonly invoiceByRequestId = new Map<string, string>();
  private loseNextInvoiceResponse = false;
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
    if (url.hostname === "sandbox-quickbooks.api.intuit.com") {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      this.quickBooksCalls.push({ method, url: url.href, authorization: headers.get("authorization") });
    }
    if (
      url.hostname === "sandbox-quickbooks.api.intuit.com" &&
      method === "POST" &&
      /\/v3\/company\/[^/]+\/invoice$/u.test(url.pathname)
    ) {
      const requestId = url.searchParams.get("requestid");
      if (!requestId) return Response.json({ Fault: { Error: [{ code: "400" }] } }, { status: 400 });
      let invoiceId = this.invoiceByRequestId.get(requestId);
      if (!invoiceId) {
        invoiceId = String(900 + this.providerInvoices.size + 1);
        const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const total = String(payload.TotalAmt ?? "0.00");
        this.providerInvoices.set(invoiceId, {
          ...structuredClone(payload),
          Id: invoiceId,
          Balance: total,
          LinkedTxn: [],
        });
        this.invoiceByRequestId.set(requestId, invoiceId);
      }
      if (this.loseNextInvoiceResponse) {
        this.loseNextInvoiceResponse = false;
        throw new Error("synthetic_provider_response_lost_after_commit");
      }
      return Response.json({ Invoice: this.providerInvoices.get(invoiceId) });
    }
    if (url.hostname === "sandbox-quickbooks.api.intuit.com" && method === "GET") {
      const transactionMatch = url.pathname.match(/\/(invoice|payment)\/([^/]+)$/u);
      if (transactionMatch) {
        const entityName = transactionMatch[1] === "invoice" ? "Invoice" : "Payment";
        const entity = entityName === "Invoice"
          ? this.providerInvoices.get(transactionMatch[2]!)
          : this.providerPayments.get(transactionMatch[2]!);
        return entity
          ? Response.json({ [entityName]: structuredClone(entity) })
          : Response.json({ Fault: { Error: [{ code: "610" }] } }, { status: 404 });
      }
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

  loseNextProviderInvoiceResponse(): void {
    this.loseNextInvoiceResponse = true;
  }

  settleInvoice(invoiceId: string): string {
    const invoice = this.providerInvoices.get(invoiceId);
    if (!invoice) throw new Error("synthetic_invoice_missing");
    const paymentId = "902";
    const total = String(invoice.TotalAmt);
    this.providerPayments.set(paymentId, {
      Id: paymentId,
      CustomerRef: structuredClone(invoice.CustomerRef),
      CurrencyRef: structuredClone(invoice.CurrencyRef),
      TxnDate: invoice.TxnDate,
      TotalAmt: total,
      UnappliedAmt: "0.00",
      Line: [{
        Amount: total,
        LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
      }],
    });
    this.providerInvoices.set(invoiceId, {
      ...invoice,
      Balance: "0.00",
      LinkedTxn: [{ TxnId: paymentId, TxnType: "Payment" }],
    });
    return paymentId;
  }

  /** Section 18.2 amount mismatch: the posted total moves, the customer does not. */
  restateInvoiceTotal(invoiceId: string, total: string): void {
    const invoice = this.providerInvoices.get(invoiceId);
    if (!invoice) throw new Error("synthetic_invoice_missing");
    this.providerInvoices.set(invoiceId, { ...invoice, TotalAmt: total, Balance: total });
  }

  /** Section 18.2 entity mismatch: the provider answers the read with a different transaction identity. */
  misidentifyInvoice(invoiceId: string, observedId: string): void {
    const invoice = this.providerInvoices.get(invoiceId);
    if (!invoice) throw new Error("synthetic_invoice_missing");
    this.providerInvoices.set(invoiceId, { ...invoice, Id: observedId });
  }

  contradictInvoice(invoiceId: string): void {
    const invoice = this.providerInvoices.get(invoiceId);
    if (!invoice) throw new Error("synthetic_invoice_missing");
    this.providerInvoices.set(invoiceId, {
      ...invoice,
      CustomerRef: { value: "provider-customer-mismatch" },
    });
  }
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
    QB_WEBHOOK_TOKEN: QB_WEBHOOK_TOKEN,
    QB_EXPECTED_REALM_ID: QB_REALM_ID,
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
      email_normalized: userId === OTHER_OPS_ID
        ? "other-ops@example.invalid"
        : userId === SECOND_ACCOUNTANT_ID
          ? "second-accounting@example.invalid"
          : `${role}@example.invalid`,
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
    name: "Ada Customer", email: CUSTOMER_EMAIL, phone: CUSTOMER_PHONE,
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
  transition: { version: number; state: "published" | "withdrawn" } = { version: 1, state: "published" },
): Promise<void> {
  const action = transition.state === "published" ? "proposal.publish" : "proposal.withdraw";
  const expected = {
    proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
    proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
    publication_version: transition.version,
    state: transition.state,
  };
  await runExternalEffect(
    h.env,
    {
      effectId, tenantId: TENANT, actor: { type: "worker", id: OPS_ID }, taskId: `task:${effectId}`,
      authority: {
        permitRef: String(permit.permit_id), policyRef: String(permit.policy_ref), policyVersion: String(permit.policy_version),
        tenantId: TENANT, actorType: "worker", actorId: OPS_ID, expiresAt: String(permit.expires_at),
        allowedActions: [action],
      },
      aggregate: { type: "proposal_publication", id: expected.proposal_pack_id, version: transition.version },
      intentId: expected.proposal_revision_id, action, request: expected,
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

/** Resolve the portal link and request the e-mail challenge; returns the single-use challenge token. */
async function requestAcceptanceChallenge(h: Harness, token: string): Promise<string> {
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
  return challengeToken;
}

function confirmAcceptance(
  h: Harness,
  challengeToken: string,
  idempotencyKey: string,
  signerName = "Ada Customer",
): Promise<Response> {
  return worker.fetch(
    publicRequest(
      "/api/v1/customer-portal/acceptance/confirm",
      { token: challengeToken, signer_name: signerName, accepted: true },
      idempotencyKey,
    ),
    h.env as never,
    {} as never,
  );
}

async function acceptPublicContract(h: Harness, token: string): Promise<string> {
  const challengeToken = await requestAcceptanceChallenge(h, token);
  h.db.throwNextBatchAfterCommit = true;
  const confirmed = await confirmAcceptance(h, challengeToken, "iro208-acceptance-0001");
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
  callback.searchParams.set("realmId", QB_REALM_ID);
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

function r2Snapshot(raw: MemoryR2): Array<[string, string, string]> {
  return [...raw.objects.entries()]
    .map(([key, value]) => [
      key,
      value.body,
      Buffer.from(
        ((value.object.checksums as { sha256: ArrayBuffer }).sha256),
      ).toString("hex"),
    ] as [string, string, string])
    .sort(([left], [right]) => left.localeCompare(right));
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

interface AcceptedDepositJourney {
  ids: Identities;
  acceptanceId: string;
  intentId: string;
}

async function deriveAcceptedDeposit(
  h: Harness,
  label: string,
): Promise<AcceptedDepositJourney> {
  const ids = await intakeAndMaterialize(h);
  await publishSyntheticContract(h, ids, TERMS, label);
  const acceptanceId = await acceptPublicContract(h, await issuePortalLink(h, ids));
  await configureDepositAccounting(h, ids, label);
  const derived = await handleAuthenticatedRoute(
    request(
      "/api/v1/commercial/deposit-intents/reconcile",
      { acceptance_id: acceptanceId },
      `iro208b-${label}-derive-0001`,
    ),
    h.env,
    auth("accounting", ACCOUNTANT_ID),
  );
  assert.equal(derived.status, 200, await derived.clone().text());
  const body = await derived.json() as {
    request: { state: string };
    derivation: { state: string; intent_id: string | null };
    intent: { intent_id: string } | null;
  };
  assert.equal(body.request.state, "derived");
  assert.equal(body.derivation.state, "derived");
  assert.ok(body.intent?.intent_id);
  assert.equal(body.derivation.intent_id, body.intent!.intent_id);

  const requestActor = h.db.raw.prepare(
    `SELECT actor_user_id FROM commercial_deposit_derivation_requests
      WHERE tenant_id = ? AND acceptance_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(TENANT, acceptanceId) as { actor_user_id: string };
  assert.equal(requestActor.actor_user_id, ACCOUNTANT_ID);
  assert.deepEqual(
    { ...h.db.raw.prepare(
      `SELECT exclusion.actor_user_id, exclusion.intent_id
         FROM commercial_deposit_approval_exclusions AS exclusion
         JOIN commercial_deposit_derivation_requests AS request
           ON request.request_id = exclusion.request_id
          AND request.tenant_id = exclusion.tenant_id
        WHERE request.acceptance_id = ? AND exclusion.tenant_id = ?`,
    ).get(acceptanceId, TENANT) },
    { actor_user_id: ACCOUNTANT_ID, intent_id: body.intent!.intent_id },
  );
  return { ids, acceptanceId, intentId: body.intent!.intent_id };
}

async function approveAcceptedDeposit(
  h: Harness,
  intentId: string,
  label: string,
): Promise<void> {
  const intent = await readAccountingIntent(h.env, TENANT, intentId);
  assert.equal(intent?.state, "pending_review");
  assert.equal(intent?.derived_by_actor_kind, "agent");
  assert.equal(intent?.derived_by_user_id, null);

  const denied = await handleAuthenticatedRoute(
    request(
      `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
      { version: intent!.version },
      `iro208b-${label}-approve-denied-0001`,
    ),
    h.env,
    auth("ops"),
  );
  assert.equal(denied.status, 403);

  const requesterDenied = await handleAuthenticatedRoute(
    request(
      `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
      { version: intent!.version },
      `iro208b-${label}-approve-requester-denied-0001`,
    ),
    h.env,
    auth("accounting", ACCOUNTANT_ID),
  );
  assert.equal(requesterDenied.status, 409);
  assert.deepEqual(await requesterDenied.json(), {
    error: "accounting_intent_separation_of_duty",
  });
  assert.equal((await readAccountingIntent(h.env, TENANT, intentId))?.state, "pending_review");
  assert.equal(
    h.db.raw.prepare(
      `SELECT COUNT(*) AS count FROM accounting_intent_command_receipts
        WHERE tenant_id = ? AND intent_id = ? AND operation = 'approve'`,
    ).get(TENANT, intentId)!.count,
    0,
  );

  const approved = await handleAuthenticatedRoute(
    request(
      `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
      { version: intent!.version },
      `iro208b-${label}-approve-0001`,
    ),
    h.env,
    auth("accounting", SECOND_ACCOUNTANT_ID),
  );
  assert.equal(approved.status, 202, await approved.clone().text());
  assert.equal((await readAccountingIntent(h.env, TENANT, intentId))?.state, "submission_pending");
  const approval = h.db.raw.prepare(
    `SELECT actor_user_id FROM accounting_intent_command_receipts
      WHERE tenant_id = ? AND intent_id = ? AND operation = 'approve' LIMIT 1`,
  ).get(TENANT, intentId) as { actor_user_id: string };
  assert.equal(approval.actor_user_id, SECOND_ACCOUNTANT_ID);
  assert.notEqual(approval.actor_user_id, ACCOUNTANT_ID);
}

/** The shared commercial context, read as sales — the role that writes to customers. */
async function commercialContext(h: Harness, jobId: string): Promise<CommercialContextReadModel> {
  const response = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(jobId)}/commercial-context`),
    h.env,
    auth("sales"),
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return await response.json() as CommercialContextReadModel;
}

async function jobPhase(h: Harness, jobId: string): Promise<{
  phase: string;
  facts: {
    production: { all_required_gates_ready: boolean };
    accounting: { deposit_reconciled: boolean };
  };
}> {
  const response = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(jobId)}/phase`),
    h.env,
    auth("owner"),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as {
    phase: string;
    facts: {
      production: { all_required_gates_ready: boolean };
      accounting: { deposit_reconciled: boolean };
    };
  };
}

/** A signed-in person's own cookie session, authenticated the way the router authenticates it. */
async function personAuth(h: Harness, userId: string): Promise<AuthContext> {
  const token = randomToken();
  const now = Date.now();
  h.db.raw.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    await sessionHashFor(h.env, token),
    userId,
    TENANT,
    new Date(now - 60_000).toISOString(),
    new Date(now + 3_600_000).toISOString(),
    new Date(now).toISOString(),
    "d".repeat(64),
    "e".repeat(64),
  );
  const outcome = await authenticateAppRequest(
    new Request(`${PUBLIC_ORIGIN}/api/v1/session`, {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    h.env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** Gate writes are people-only (migration 0153): a real cookie session and its own CSRF token. */
async function clearProductionGate(
  h: Harness,
  jobId: string,
  gate: string,
  body: Record<string, unknown>,
  decisionId: string,
  role: AppRole = "owner",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const person = await personAuth(h, role === "owner" ? OWNER_ID : role === "ops" ? OPS_ID : `appu_${role}_0001`);
  const response = await handleAuthenticatedRoute(
    new Request(
      `${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(jobId)}/gates/${encodeURIComponent(gate)}/clearance`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json", "idempotency-key": decisionId,
          "x-csrf-token": person.csrfToken, origin: PUBLIC_ORIGIN, "cf-connecting-ip": "203.0.113.20",
        },
        body: JSON.stringify(body),
      },
    ),
    h.env,
    person,
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Drive the same non-daily Worker entrypoint Wrangler invokes and await its whole lifetime. */
async function runFrequentCron(h: Harness, scheduledTime: number): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron: "*/5 * * * *", scheduledTime, noRetry() {} } as never,
    h.env as never,
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as never,
  );
  assert.equal(pending.length, 1, "the frequent cron owns one composed waitUntil lifetime");
  await Promise.all(pending);
}

test("IRO-208B closes the no-seed commercial path through reconciled deposit and production admission", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "commercial-closure");
    assert.equal((await jobPhase(h, journey.ids.jobId)).phase, "deposit_pending");
    assert.equal(
      h.db.raw.prepare(
        `SELECT COUNT(*) AS count FROM accounting_intents
          WHERE tenant_id = ? AND roof_job_id = ? AND kind = 'deposit_invoice'`,
      ).get(TENANT, journey.ids.jobId)!.count,
      1,
    );
    await approveAcceptedDeposit(h, journey.intentId, "commercial-closure");

    const preSettlement = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Deposit",
      { basis: "deposit_settlement" },
      "iro208b-deposit-pre-settlement-0001",
    );
    assert.equal(preSettlement.status, 409);
    assert.equal(preSettlement.body.error, "deposit_settlement_not_observed");

    await runFrequentCron(h, clockStart);
    const open = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(open?.state, "partially_settled");
    assert.equal(open?.settled_amount, "0.00");
    assert.equal(open?.provider_reconciled_at, null);
    const invoiceId = open?.provider_entity_id;
    assert.ok(invoiceId);
    assert.equal(h.fake.providerInvoices.size, 1);
    const providerInvoice = h.fake.providerInvoices.get(invoiceId!);
    assert.ok(providerInvoice);
    assert.equal((providerInvoice.CustomerRef as { value: string }).value, "501");
    assert.equal(String(providerInvoice.TotalAmt), "262.50");
    const createCall = h.fake.quickBooksCalls.find(({ method, url }) =>
      method === "POST" && new URL(url).pathname.endsWith("/invoice")
    );
    assert.ok(createCall);
    assert.equal(
      new URL(createCall.url).searchParams.get("requestid"),
      open?.provider_request_id,
    );

    const partialGateBefore = h.db.raw.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id,
              cleared_by_user_id, evidence_refs_json
         FROM operating_production_gates
        WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
    ).get(TENANT, journey.ids.jobId);
    const partialR2Before = r2Snapshot(h.raw);
    const partialRefusal = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Deposit",
      { basis: "deposit_settlement" },
      "iro208b-deposit-partial-settlement-0001",
    );
    assert.equal(partialRefusal.status, 409);
    assert.equal(partialRefusal.body.error, "deposit_settlement_not_observed");
    assert.deepEqual(r2Snapshot(h.raw), partialR2Before);
    assert.deepEqual(
      h.db.raw.prepare(
        `SELECT state, version, clearance_basis, clearance_decision_id,
                cleared_by_user_id, evidence_refs_json
           FROM operating_production_gates
          WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
      ).get(TENANT, journey.ids.jobId),
      partialGateBefore,
    );

    t.mock.timers.setTime(clockStart + 5 * 60_000);
    await runFrequentCron(h, Date.now());
    assert.equal(h.fake.providerInvoices.size, 1);
    assert.equal(
      h.fake.quickBooksCalls.filter(({ method, url }) =>
        method === "POST" && new URL(url).pathname.endsWith("/invoice")
      ).length,
      1,
    );

    const effect = h.db.raw.prepare(
      `SELECT state, attempt_count, provider_external_id, idempotency_key
         FROM external_effects WHERE tenant_id = ? AND intent_id = ?`,
    ).get(TENANT, journey.intentId) as {
      state: string;
      attempt_count: number;
      provider_external_id: string;
      idempotency_key: string;
    };
    assert.equal(effect.state, "succeeded");
    assert.equal(effect.attempt_count, 1);
    assert.equal(effect.provider_external_id, invoiceId);
    assert.match(effect.idempotency_key, /^acct:commercial-deposit:/);
    assert.equal((await jobPhase(h, journey.ids.jobId)).phase, "deposit_pending");

    const refreshTickMs = clockStart + 24 * 60 * 60_000 + 10 * 60_000;
    t.mock.timers.setTime(refreshTickMs);
    await runFrequentCron(h, Date.now());
    const refreshPending = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(refreshPending?.state, "partially_settled");
    assert.equal(refreshPending?.provider_reconciled_at, null);
    assert.deepEqual(
      { ...h.db.raw.prepare(
        `SELECT state, bundle_version, refresh_lease_id, refresh_lease_expires_at
           FROM quickbooks_connections
          WHERE tenant_id = ? ORDER BY connected_at DESC LIMIT 1`,
      ).get(TENANT) as Record<string, unknown> },
      {
        state: "connected",
        bundle_version: 2,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
      },
    );

    const paymentId = h.fake.settleInvoice(invoiceId!);
    const reconciledAtMs = refreshTickMs + 5 * 60_000;
    t.mock.timers.setTime(reconciledAtMs);
    await runFrequentCron(h, Date.now());
    assert.ok(h.fake.quickBooksCalls.some(({ method, url }) =>
      method === "GET" && new URL(url).pathname.endsWith(`/invoice/${invoiceId}`)
    ));
    assert.ok(h.fake.quickBooksCalls.some(({ method, url }) =>
      method === "GET" && new URL(url).pathname.endsWith(`/payment/${paymentId}`)
    ));
    const reconciled = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(reconciled?.state, "reconciled");
    assert.equal(reconciled?.settled_amount, reconciled?.total_amount);
    assert.equal(reconciled?.provider_reconciled_at, new Date(reconciledAtMs).toISOString());
    const paymentObservation = h.db.raw.prepare(
      `SELECT entity_id, intent_id, source FROM accounting_observations
        WHERE tenant_id = ? AND entity_type = 'Payment' AND entity_id = ?`,
    ).get(TENANT, paymentId) as { entity_id: string; intent_id: string | null; source: string };
    assert.deepEqual({ ...paymentObservation }, {
      entity_id: paymentId,
      intent_id: null,
      source: "sweep",
    });
    const linked = h.db.raw.prepare(
      `SELECT linked_txn_type, linked_txn_id, amount_cents
         FROM accounting_observation_links
        WHERE tenant_id = ? AND linked_txn_type = 'Invoice' AND linked_txn_id = ?`,
    ).get(TENANT, invoiceId) as {
      linked_txn_type: string;
      linked_txn_id: string;
      amount_cents: number;
    };
    assert.equal(linked.amount_cents, 26_250);

    const blocked = await jobPhase(h, journey.ids.jobId);
    assert.equal(blocked.phase, "production_blocked");
    assert.equal(blocked.facts.accounting.deposit_reconciled, true);
    assert.equal(blocked.facts.production.all_required_gates_ready, false);

    const forbiddenWaiver = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Materials",
      { basis: "office_waiver", reason: "Synthetic materials waiver for repository proof only." },
      "iro208b-materials-forbidden-0001",
      "ops",
    );
    assert.equal(forbiddenWaiver.status, 403);
    assert.equal(forbiddenWaiver.body.error, "production_gate_clearance_forbidden");

    const depositDecision = "iro208b-deposit-settlement-0001";
    const deposit = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Deposit",
      { basis: "deposit_settlement" },
      depositDecision,
    );
    assert.equal(deposit.status, 200);
    assert.equal(deposit.body.clearance, "verified");
    const depositGateEvidence = h.db.raw.prepare(
      `SELECT evidence_refs_json
         FROM operating_production_gates
        WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
    ).get(TENANT, journey.ids.jobId) as { evidence_refs_json: string };
    const receiptKey = (
      JSON.parse(depositGateEvidence.evidence_refs_json) as { r2_key: string }
    ).r2_key;
    assert.match(receiptKey, /^production-gate-clearance\/v1\/[a-f0-9]{64}\.json$/);
    const receipt = h.raw.objects.get(receiptKey);
    assert.ok(receipt);
    const receiptBody = JSON.parse(receipt!.body) as {
      basis: string;
      settlement_observed_at: string;
      money_intent: { intent_id: string; provider_entity_id: string; state: string };
    };
    assert.equal(receiptBody.basis, "deposit_settlement");
    assert.equal(receiptBody.settlement_observed_at, new Date(reconciledAtMs).toISOString());
    assert.equal(receiptBody.money_intent.intent_id, journey.intentId);
    assert.equal(receiptBody.money_intent.provider_entity_id, invoiceId);
    assert.equal(receiptBody.money_intent.state, "reconciled");

    // The owner is this tenant's only holder of the waiving set, so their Materials and Access
    // waivers are self-approved with a reason (owner ruling D-08).
    const waiverReasons: Record<string, string> = {
      Materials: "Synthetic materials readiness waived for repository composition proof.",
      Access: "Synthetic site access waived for repository composition proof.",
    };
    for (const [gate, reason] of Object.entries(waiverReasons)) {
      const decisionId = `iro208b-${gate.toLowerCase()}-waiver-0001`;
      const cleared = await clearProductionGate(
        h,
        journey.ids.jobId,
        gate,
        { basis: "office_waiver", reason },
        decisionId,
      );
      assert.equal(cleared.status, 200, `${gate}: ${JSON.stringify(cleared.body)}`);
      assert.equal(cleared.body.clearance, "waived");
      const replayed = await clearProductionGate(
        h,
        journey.ids.jobId,
        gate,
        { basis: "office_waiver", reason },
        decisionId,
      );
      assert.equal(replayed.status, 200);
      assert.equal(replayed.body.replayed, true);
    }
    // Safety and Weather are never waivable and Crew has no waiver, so no person can clear them
    // on this route and production stays blocked.
    for (const gate of ["Safety", "Weather", "Crew"]) {
      const refused = await clearProductionGate(
        h,
        journey.ids.jobId,
        gate,
        { basis: "office_waiver", reason: `Synthetic ${gate.toLowerCase()} waiver attempt for repository proof.` },
        `iro208b-${gate.toLowerCase()}-waiver-0001`,
      );
      assert.equal(refused.status, 409, gate);
      assert.equal(refused.body.error, "production_gate_not_waivable");
    }
    const stillBlocked = await jobPhase(h, journey.ids.jobId);
    assert.equal(stillBlocked.phase, "production_blocked");
    assert.equal(stillBlocked.facts.production.all_required_gates_ready, false);
    const depositReplay = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Deposit",
      { basis: "deposit_settlement" },
      depositDecision,
    );
    assert.equal(depositReplay.status, 200);
    assert.equal(depositReplay.body.replayed, true);
    assert.equal(h.raw.objects.get(receiptKey)!.body, receipt!.body);

    const receiptChecksumBefore = Buffer.from(
      ((receipt!.object.checksums as { sha256: ArrayBuffer }).sha256),
    ).toString("hex");
    const depositGateBeforeConflict = h.db.raw.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id,
              cleared_by_user_id, evidence_refs_json
         FROM operating_production_gates
        WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
    ).get(TENANT, journey.ids.jobId);
    const conflictingReplay = await clearProductionGate(
      h,
      journey.ids.jobId,
      "Deposit",
      {
        basis: "office_waiver",
        reason: "A conflicting governed waiver must not replace the settlement decision.",
      },
      depositDecision,
    );
    assert.equal(conflictingReplay.status, 409);
    assert.equal(conflictingReplay.body.error, "production_gate_clearance_replay_conflict");
    const receiptAfterConflict = h.raw.objects.get(receiptKey)!;
    assert.equal(receiptAfterConflict.body, receipt!.body);
    assert.equal(
      Buffer.from(
        ((receiptAfterConflict.object.checksums as { sha256: ArrayBuffer }).sha256),
      ).toString("hex"),
      receiptChecksumBefore,
    );
    assert.deepEqual(
      h.db.raw.prepare(
        `SELECT state, version, clearance_basis, clearance_decision_id,
                cleared_by_user_id, evidence_refs_json
           FROM operating_production_gates
          WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
      ).get(TENANT, journey.ids.jobId),
      depositGateBeforeConflict,
    );

    // Attestation and Crew-by-policy entries do not exist yet, so the journey records Safety,
    // Weather and Crew the way 0153 backfills gates cleared before the ledger, and proves the
    // phase then admits the job.
    recordLegacyGateStates(h.db.raw, {
      tenantId: TENANT,
      roofJobId: journey.ids.jobId,
      gates: ["Safety", "Weather", "Crew"],
    });
    const ready = await jobPhase(h, journey.ids.jobId);
    assert.equal(ready.phase, "production_ready");
    assert.equal(ready.facts.accounting.deposit_reconciled, true);
    assert.equal(ready.facts.production.all_required_gates_ready, true);
    assert.equal(h.fake.providerInvoices.size, 1);
    assert.ok(h.fake.quickBooksCalls.every(({ authorization }) => authorization?.startsWith("Bearer ")));
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

test("IRO-208B keeps a lost provider create response uncertain and never duplicates the invoice", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "lost-provider-response");
    await approveAcceptedDeposit(h, journey.intentId, "lost-provider-response");
    h.fake.loseNextProviderInvoiceResponse();
    await runFrequentCron(h, clockStart);
    const uncertain = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(uncertain?.state, "uncertain");
    assert.equal(uncertain?.provider_entity_id, null);
    assert.equal(h.fake.providerInvoices.size, 1, "the provider committed exactly one invoice");

    t.mock.timers.setTime(clockStart + 5 * 60_000);
    await runFrequentCron(h, Date.now());
    assert.equal(h.fake.providerInvoices.size, 1);
    assert.equal(
      h.fake.quickBooksCalls.filter(({ method, url }) =>
        method === "POST" && new URL(url).pathname.endsWith("/invoice")
      ).length,
      1,
    );
    assert.deepEqual(
      { ...h.db.raw.prepare(
        `SELECT state, attempt_count, provider_external_id FROM external_effects
          WHERE tenant_id = ? AND intent_id = ?`,
      ).get(TENANT, journey.intentId) },
      { state: "unknown", attempt_count: 1, provider_external_id: null },
    );
    assert.equal((await readAccountingIntent(h.env, TENANT, journey.intentId))?.provider_reconciled_at, null);
    assert.equal(
      h.db.raw.prepare(
        `SELECT COUNT(*) AS count FROM accounting_intents
          WHERE tenant_id = ? AND roof_job_id = ? AND kind = 'deposit_invoice'`,
      ).get(TENANT, journey.ids.jobId)!.count,
      1,
    );
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

test("IRO-208B records a contradictory provider readback as mismatch without reconciliation", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "provider-contradiction");
    await approveAcceptedDeposit(h, journey.intentId, "provider-contradiction");
    await runFrequentCron(h, clockStart);
    const partial = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(partial?.state, "partially_settled");
    const invoiceId = partial?.provider_entity_id;
    assert.ok(invoiceId);
    h.fake.contradictInvoice(invoiceId!);

    const staleTick = clockStart + 24 * 60 * 60_000 + 10 * 60_000;
    t.mock.timers.setTime(staleTick);
    await runFrequentCron(h, Date.now());
    assert.equal(
      (await readAccountingIntent(h.env, TENANT, journey.intentId))?.state,
      "partially_settled",
      "an unavailable refresh-race read is not accounting evidence",
    );
    const connection = h.db.raw.prepare(
      `SELECT state, bundle_version, refresh_lease_id, refresh_lease_expires_at
         FROM quickbooks_connections
        WHERE tenant_id = ? ORDER BY connected_at DESC LIMIT 1`,
    ).get(TENANT) as Record<string, unknown>;
    assert.deepEqual({ ...connection }, {
      state: "connected",
      bundle_version: 2,
      refresh_lease_id: null,
      refresh_lease_expires_at: null,
    });

    t.mock.timers.setTime(staleTick + 5 * 60_000);
    await runFrequentCron(h, Date.now());
    const mismatched = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(mismatched?.state, "mismatch");
    assert.equal(mismatched?.provider_reconciled_at, null);
    assert.equal(
      h.db.raw.prepare(
        `SELECT reason_code FROM accounting_exceptions
          WHERE tenant_id = ? AND intent_id = ? AND status = 'open'`,
      ).get(TENANT, journey.intentId)!.reason_code,
      "expected_observed_mismatch",
    );
    assert.equal(h.fake.providerInvoices.size, 1);
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

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
    // The commercial context follows the same records at every step below, and its source binding
    // names exactly what moved — which is what makes a decision about a follow-up go stale.
    const atIntake = await commercialContext(h, ids.jobId);
    assert.equal(atIntake.offer.state, "no_quote");
    assert.equal(atIntake.contact.email?.address, CUSTOMER_EMAIL);
    // An office intake records no consent row; only the public estimator writes one.
    assert.equal(atIntake.contact.consent, null);
    assert.deepEqual(atIntake.follow_up.blockers, ["consent_missing"]);
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
    const afterQuote = await commercialContext(h, ids.jobId);
    assert.equal(afterQuote.offer.state, "proposal_missing");
    assert.equal(afterQuote.offer.quote_head?.status, "approved");
    assert.deepEqual(sourceBindingChanges(atIntake.source_binding, afterQuote.source_binding), ["lead", "offer", "quote"]);
    const proposalInput = proposalBody(ids, new Date().toISOString());
    const proposal = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", proposalInput, "iro208-proposal-0001"),
      h.env, auth("ops"),
    );
    assert.equal(proposal.status, 201, await proposal.clone().text());
    const afterProposal = await commercialContext(h, ids.jobId);
    assert.equal(afterProposal.offer.state, "not_published");
    assert.deepEqual(sourceBindingChanges(afterQuote.source_binding, afterProposal.source_binding), ["offer", "proposal"]);
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
    // The unknown settlement above named an effect that never ran, so its permit is still live and
    // unused; a second live permit for the same version is refused, so the refused send uses it.
    const secondLivePermit = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", {
        proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
        proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
        publication_version: 1, previous_state: "draft", state: "published",
        facts_observed_at: new Date().toISOString(), evidence: EVIDENCE,
      }, "iro208-publication-prepare-second-live-0001"),
      h.env, auth("ops"),
    );
    assert.equal(secondLivePermit.status, 409);
    assert.equal(
      (await secondLivePermit.json() as { error: string }).error,
      "proposal_publication_permit_outstanding",
    );
    const refusedPermit = unknownPermit;
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
    // A lost send is not confirmed delivered, so the proposal is not sent again until someone
    // checks delivery; here the check finds it was not delivered.
    const resendBeforeCheck = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", {
        proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
        proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
        publication_version: 1, previous_state: "draft", state: "published",
        facts_observed_at: new Date().toISOString(), evidence: EVIDENCE,
      }, "iro208-publication-prepare-before-check-0001"),
      h.env, auth("ops"),
    );
    assert.equal(resendBeforeCheck.status, 409);
    assert.equal((await resendBeforeCheck.json() as { error: string }).error, "proposal_delivery_unconfirmed");
    await reconcileExternalEffect(h.env as never, "effect:iro208:lost", {
      outcome: "not_executed",
      evidence: { checked: "provider has no publication for this proposal revision" },
    });
    const mismatchPermit = await preparePublication(h, ids, "iro208-publication-prepare-mismatch-0001");
    await runPublicationEffect(h, mismatchPermit, ids, "effect:iro208:mismatch", "mismatch");
    const mismatch = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", { ...unknownSettlementBody, permit_id: mismatchPermit.permit_id, external_effect_id: "effect:iro208:mismatch" }, "iro208-publication-mismatch-0001"), h.env, auth("ops"),
    );
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: "commercial_publication_effect_mismatch" });
    // The provider showed something other than what was sent, so delivery is not confirmed and a
    // person must record what they found before the proposal goes again.
    const resendAfterMismatch = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", {
        proposal_revision_id: `proposal-revision:iro208:${ids.leadId}`,
        proposal_pack_id: `proposal-pack:iro208:${ids.leadId}`,
        publication_version: 1, previous_state: "draft", state: "published",
        facts_observed_at: new Date().toISOString(), evidence: EVIDENCE,
      }, "iro208-publication-prepare-after-mismatch-0001"),
      h.env, auth("ops"),
    );
    assert.equal(resendAfterMismatch.status, 409);
    assert.equal(
      (await resendAfterMismatch.json() as { next_step: string }).next_step,
      "confirm_delivery_by_hand",
    );
    h.db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const confirmed = await recordProposalDeliveryConfirmation(h.env as never, {
      tenantId: TENANT,
      effectId: "effect:iro208:mismatch",
      outcome: "not_delivered",
      note: "Checked with the customer: no proposal reached them.",
      actorUserId: OPS_ID,
      actorRole: "ops",
      idempotencyKey: "iro208-delivery-confirmation-0001",
    });
    assert.equal(confirmed.effectState, "reconciled");
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
    const afterPublication = await commercialContext(h, ids.jobId);
    assert.equal(afterPublication.offer.state, "published");
    // A refused, lost or mismatched publication attempt above moved nothing; only the settled one did.
    assert.deepEqual(
      sourceBindingChanges(afterProposal.source_binding, afterPublication.source_binding),
      ["offer", "publication"],
    );

    const portalToken = await issuePortalLink(h, ids);
    const acceptanceId = await acceptPublicContract(h, portalToken);
    const afterAcceptance = await commercialContext(h, ids.jobId);
    assert.equal(afterAcceptance.offer.state, "accepted");
    assert.equal(afterAcceptance.offer.acceptance?.acceptance_id, acceptanceId);
    assert.ok(
      sourceBindingChanges(afterPublication.source_binding, afterAcceptance.source_binding).includes("acceptance"),
    );
    assert.notEqual(afterAcceptance.source_binding_sha256, afterPublication.source_binding_sha256);
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
        idempotencyKey: "iro208-deposit-reserved-evidence-0001",
        policyVersion: "policy-v1",
        evidenceRefs: [`evidence-upload://evu_${"a".repeat(64)}`],
      }),
      /commercial_deposit_reconcile_evidence_invalid/,
    );
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
    const ambiguousProposal = await commercialContext(h, ids.jobId);
    assert.equal(ambiguousProposal.offer.state, "proposal_ambiguous");
    assert.ok(ambiguousProposal.follow_up.blockers.includes("commercial_facts_ambiguous"));

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
    const ambiguousQuote = await commercialContext(h, ids.jobId);
    assert.equal(ambiguousQuote.offer.state, "quote_ambiguous");
    assert.equal(ambiguousQuote.offer.quote_head, null);
    assert.ok(ambiguousQuote.follow_up.blockers.includes("commercial_facts_ambiguous"));
  } finally {
    h.restore();
  }
});

test("a quote cannot be valid until a day that does not exist", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "high",
        category: "replacement", summary: "Synthetic qualified lead.", next_action: "Quote it.",
      }, "iro208-impossible-date-triage-0001"), h.env, auth("ops"),
    );
    assert.equal(triage.status, 201, await triage.clone().text());
    // Date.parse would accept this and roll it to 2 March; the stored date would not be the one sent.
    const refused = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/quote-revisions",
        { ...quoteBody(ids, new Date().toISOString()), valid_until: "2026-02-30" },
        "iro208-impossible-date-quote-0001",
      ),
      h.env,
      auth("ops"),
    );
    assert.equal(refused.status, 400, await refused.clone().text());
    assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_quote_revisions").get()!.count, 0);
  } finally {
    h.restore();
  }
});

test("commercial context tells a draft quote from no quote on real records", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: ids.leadId, expected_lead_version: 1, lifecycle_status: "qualified", priority: "high",
        category: "replacement", summary: "Synthetic qualified lead.", next_action: "Prepare a draft quote.",
      }, "iro208-draft-quote-triage-0001"), h.env, auth("ops"),
    );
    assert.equal(triage.status, 201, await triage.clone().text());
    const draft = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/quote-revisions",
        { ...quoteBody(ids, new Date().toISOString()), status: "draft" },
        "iro208-draft-quote-0001",
      ),
      h.env,
      auth("ops"),
    );
    assert.equal(draft.status, 201, await draft.clone().text());
    // The phase reader admits only an approved head as `quote`; the context must still see this one.
    const model = await commercialContext(h, ids.jobId);
    assert.equal(model.offer.state, "quote_not_approved");
    assert.equal(model.offer.quote, null);
    assert.equal(model.offer.quote_head?.status, "draft");
    assert.ok(model.stale_reasons.includes("commercial.quote_head_not_approved"));
    assert.ok(!model.stale_reasons.includes("commercial.quote_head_missing"));
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

// ---------------------------------------------------------------------------------------------
// IRO-250 / G2.6: the section 18.2 commercial negative scenarios, driven from the same empty D1.
// "Decision-maker without authority" is deliberately absent: it waits on the G2.4 authority
// contract and is not counted as covered here.

/** Move a pack's publication through one more versioned transition by the same permit → effect → settle spine. */
async function transitionPublication(
  h: Harness,
  ids: Identities,
  transition: { version: number; previousState: "published" | "withdrawn"; state: "published" | "withdrawn" },
  label: string,
): Promise<string> {
  const proposalRevisionId = `proposal-revision:iro208:${ids.leadId}`;
  const proposalPackId = `proposal-pack:iro208:${ids.leadId}`;
  const prepared = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-publications/prepare", {
      proposal_revision_id: proposalRevisionId, proposal_pack_id: proposalPackId,
      publication_version: transition.version, previous_state: transition.previousState, state: transition.state,
      facts_observed_at: new Date().toISOString(), evidence: EVIDENCE,
    }, `iro250-${label}-prepare-000${transition.version}`), h.env, auth("ops"),
  );
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const permit = (await prepared.json() as { permit: Record<string, unknown> }).permit;
  const effectId = `effect:iro250:${label}:v${transition.version}`;
  await runPublicationEffect(h, permit, ids, effectId, "success", { version: transition.version, state: transition.state });
  // Publication events are strictly ordered by occurred_at; keep two settles out of one millisecond.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const settled = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-publications", {
      proposal_revision_id: proposalRevisionId, proposal_pack_id: proposalPackId,
      publication_version: transition.version, previous_state: transition.previousState, state: transition.state,
      permit_id: permit.permit_id, external_effect_id: effectId,
    }, `iro250-${label}-settle-000${transition.version}`), h.env, auth("ops"),
  );
  assert.equal(settled.status, 201, await settled.clone().text());
  return (await settled.json() as { publication: { publication_event_id: string } }).publication.publication_event_id;
}

function commercialMoneyCounts(h: Harness, jobId: string): { bindings: number; derivations: number; intents: number } {
  const count = (sql: string) => Number((h.db.raw.prepare(sql).get(TENANT, jobId) as { count: number }).count);
  return {
    bindings: count("SELECT COUNT(*) AS count FROM commercial_acceptance_bindings WHERE tenant_id = ? AND roof_job_id = ?"),
    derivations: count("SELECT COUNT(*) AS count FROM commercial_deposit_derivations WHERE tenant_id = ? AND roof_job_id = ?"),
    intents: count("SELECT COUNT(*) AS count FROM accounting_intents WHERE tenant_id = ? AND roof_job_id = ?"),
  };
}

/** A signed Intuit notification carrying identity only, exactly as `/webhook/quickbooks` receives it. */
function quickBooksWebhook(entities: Array<{ name: string; id: string; operation: string }>): Request {
  const body = JSON.stringify({
    eventNotifications: [{ realmId: QB_REALM_ID, dataChangeEvent: { entities } }],
  });
  return new Request(`${PUBLIC_ORIGIN}/webhook/quickbooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "intuit-signature": createHmac("sha256", QB_WEBHOOK_TOKEN).update(body).digest("base64"),
    },
    body,
  });
}

async function postWebhook(h: Harness, req: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(req.clone(), h.env as never, {} as never);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function projectionOutbox(h: Harness): Array<Record<string, unknown>> {
  return h.db.raw.prepare(
    `SELECT payload_hash, entity_type, entity_id, projection_status, attempt_count, last_error,
            next_attempt_at, projected_at
       FROM quickbooks_projection_outbox ORDER BY payload_hash, event_index`,
  ).all() as Array<Record<string, unknown>>;
}

function webhookReceipts(h: Harness): Array<{ payload_hash: string; first_seen_at: string; replay_count: number; events_count: number }> {
  return h.db.raw.prepare(
    "SELECT payload_hash, first_seen_at, replay_count, events_count FROM quickbooks_webhook_receipts ORDER BY first_seen_at",
  ).all() as Array<{ payload_hash: string; first_seen_at: string; replay_count: number; events_count: number }>;
}

test("IRO-250 acceptance against a superseded publication is rejected and binds nothing", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, TERMS, "superseded-publication");
    const displayedPublication = h.db.raw.prepare(
      `SELECT publication_event_id FROM commercial_proposal_publication_events
        WHERE tenant_id = ? AND publication_version = 1`,
    ).get(TENANT) as { publication_event_id: string };
    const token = await issuePortalLink(h, ids);
    // The customer resolves and is challenged against publication v1 ...
    const staleChallenge = await requestAcceptanceChallenge(h, token);
    // ... and the office supersedes it before the decision lands: withdrawn (v2), republished (v3).
    await transitionPublication(h, ids, { version: 2, previousState: "published", state: "withdrawn" }, "superseded");
    const currentPublication = await transitionPublication(
      h, ids, { version: 3, previousState: "withdrawn", state: "published" }, "superseded",
    );
    assert.notEqual(currentPublication, displayedPublication.publication_event_id);

    const rejected = await confirmAcceptance(h, staleChallenge, "iro250-superseded-confirm-0001");
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: "acceptance_rejected" });
    const intent = h.db.raw.prepare(
      "SELECT state, error_code FROM customer_portal_acceptance_intents WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(TENANT) as { state: string; error_code: string };
    assert.deepEqual({ ...intent }, { state: "rejected", error_code: "native_contract_changed" });
    assert.deepEqual(commercialMoneyCounts(h, ids.jobId), { bindings: 0, derivations: 0, intents: 0 });

    // A replay of the rejected decision stays rejected; the challenge is spent, not reusable.
    const replay = await confirmAcceptance(h, staleChallenge, "iro250-superseded-confirm-0001");
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: "acceptance_rejected" });
    assert.deepEqual(commercialMoneyCounts(h, ids.jobId), { bindings: 0, derivations: 0, intents: 0 });

    // Only a fresh challenge issued against the current publication can bind, and it binds to v3.
    const freshChallenge = await requestAcceptanceChallenge(h, token);
    const accepted = await confirmAcceptance(h, freshChallenge, "iro250-superseded-confirm-0002");
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const acceptanceId = (await accepted.json() as { acceptance_id: string }).acceptance_id;
    assert.deepEqual(commercialMoneyCounts(h, ids.jobId), { bindings: 1, derivations: 1, intents: 0 });
    const derivation = h.db.raw.prepare(
      "SELECT publication_event_id, publication_version FROM commercial_deposit_derivations WHERE acceptance_id = ?",
    ).get(acceptanceId) as { publication_event_id: string; publication_version: number };
    assert.deepEqual({ ...derivation }, { publication_event_id: currentPublication, publication_version: 3 });
  } finally {
    h.restore();
  }
});

test("IRO-250 duplicate acceptance with a repeated idempotency key replays without a second binding, derivation or intent", async () => {
  const h = setup();
  try {
    const ids = await intakeAndMaterialize(h);
    await publishSyntheticContract(h, ids, TERMS, "duplicate-acceptance");
    const challengeToken = await requestAcceptanceChallenge(h, await issuePortalLink(h, ids));
    const first = await confirmAcceptance(h, challengeToken, "iro250-duplicate-acceptance-0001");
    assert.equal(first.status, 200, await first.clone().text());
    const accepted = await first.json() as { status: string; acceptance_id: string };
    assert.equal(accepted.status, "accepted");
    await configureDepositAccounting(h, ids, "duplicate-acceptance");
    const derived = await handleAuthenticatedRoute(
      request("/api/v1/commercial/deposit-intents/reconcile", { acceptance_id: accepted.acceptance_id }, "iro250-duplicate-acceptance-derive-0001"),
      h.env, auth("owner"),
    );
    assert.equal(derived.status, 200, await derived.clone().text());
    const before = commercialMoneyCounts(h, ids.jobId);
    assert.deepEqual(before, { bindings: 1, derivations: 1, intents: 1 });
    const receiptsBefore = r2Snapshot(h.raw);

    // Same key, same body: the stored terminal answer, byte for byte.
    const replay = await confirmAcceptance(h, challengeToken, "iro250-duplicate-acceptance-0001");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), accepted);
    // Same key, different signer: an idempotency conflict, not a second acceptance.
    const conflict = await confirmAcceptance(h, challengeToken, "iro250-duplicate-acceptance-0001", "Someone Else");
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "acceptance_idempotency_conflict" });
    // Fresh key on a spent challenge: refused.
    const spent = await confirmAcceptance(h, challengeToken, "iro250-duplicate-acceptance-0002");
    assert.equal(spent.status, 409);
    assert.deepEqual(await spent.json(), { error: "acceptance_challenge_used" });

    assert.deepEqual(commercialMoneyCounts(h, ids.jobId), before);
    assert.deepEqual(r2Snapshot(h.raw), receiptsBefore);
    assert.equal(
      h.db.raw.prepare("SELECT COUNT(*) AS count FROM customer_portal_acceptance_intents WHERE tenant_id = ?")
        .get(TENANT)!.count,
      1,
    );
  } finally {
    h.restore();
  }
});

test("IRO-250 a QuickBooks webhook arriving before readback stays unbound and pending until the cron reads the invoice back", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "webhook-before-readback");
    await approveAcceptedDeposit(h, journey.intentId, "webhook-before-readback");
    assert.equal((await readAccountingIntent(h.env, TENANT, journey.intentId))?.provider_entity_id, null);

    // Intuit announces the invoice IronWrap is about to create, before any effect has settled.
    const early = quickBooksWebhook([{ name: "Invoice", id: "901", operation: "Create" }]);
    const first = await postWebhook(h, early);
    assert.equal(first.status, 503);
    assert.equal(first.body.error, "quickbooks_projection_pending");
    assert.equal(first.body.replay, false);
    assert.deepEqual(projectionOutbox(h).map(({ projection_status, attempt_count, last_error }) => ({ projection_status, attempt_count, last_error })), [
      { projection_status: "pending", attempt_count: 1, last_error: "quickbooks_native_provider_identity_unbound" },
    ]);
    const untouched = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(untouched?.state, "submission_pending");
    assert.equal(untouched?.provider_entity_id, null);
    assert.equal(h.fake.providerInvoices.size, 0, "a webhook never creates provider state");

    // The same signed body redelivered while still unbound is a replay, not a second receipt.
    const replayed = await postWebhook(h, early);
    assert.equal(replayed.status, 503);
    assert.equal(replayed.body.replay, true);
    assert.deepEqual(webhookReceipts(h).map(({ replay_count, events_count }) => ({ replay_count, events_count })), [
      { replay_count: 1, events_count: 1 },
    ]);
    assert.equal(projectionOutbox(h).length, 1);

    // Dispatch settles the invoice; the pending projection is then recovered by the frequent cron.
    t.mock.timers.setTime(clockStart + 30_000);
    await runFrequentCron(h, Date.now());
    const settled = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(settled?.provider_entity_id, "901");
    let outbox = projectionOutbox(h)[0]!;
    for (let tick = 1; tick <= 3 && outbox.projection_status !== "projected"; tick += 1) {
      t.mock.timers.setTime(clockStart + tick * 5 * 60_000);
      await runFrequentCron(h, Date.now());
      outbox = projectionOutbox(h)[0]!;
    }
    assert.equal(outbox.projection_status, "projected");
    assert.ok(Number(outbox.attempt_count) >= 2, "the projection needed at least one retry");
    const effectSettled = h.db.raw.prepare(
      "SELECT updated_at FROM external_effects WHERE tenant_id = ? AND intent_id = ? AND state = 'succeeded'",
    ).get(TENANT, journey.intentId) as { updated_at: string };
    assert.ok(
      String(outbox.projected_at) > effectSettled.updated_at && effectSettled.updated_at > webhookReceipts(h)[0]!.first_seen_at,
      "ordering: webhook receipt, then the effect settled, then the projection re-read",
    );
    const reobserved = h.db.raw.prepare(
      `SELECT source, read_at FROM accounting_observations
        WHERE tenant_id = ? AND entity_type = 'Invoice' AND entity_id = '901' AND source = 'webhook_triggered_read'`,
    ).get(TENANT) as { source: string; read_at: string } | undefined;
    assert.ok(reobserved, "the recovered projection re-read the invoice with the webhook-triggered source");
    assert.equal((await readAccountingIntent(h.env, TENANT, journey.intentId))?.state, "partially_settled");
    assert.equal(h.fake.providerInvoices.size, 1);
    assert.equal(
      h.db.raw.prepare(
        `SELECT COUNT(*) AS count FROM audit_log WHERE automation = 'quickbooks_accounting'
          AND trigger = 'scheduled' AND action = 'authenticated_reobservation'`,
      ).get()!.count,
      1,
    );
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

test("IRO-250 a QuickBooks webhook arriving after readback re-observes and reconciles, and its replay projects nothing twice", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "webhook-after-readback");
    await approveAcceptedDeposit(h, journey.intentId, "webhook-after-readback");
    await runFrequentCron(h, clockStart);
    const posted = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(posted?.state, "partially_settled");
    const invoiceId = posted!.provider_entity_id!;
    const paymentId = h.fake.settleInvoice(invoiceId);

    t.mock.timers.setTime(clockStart + 60_000);
    const notification = quickBooksWebhook([{ name: "Payment", id: paymentId, operation: "Create" }]);
    const projected = await postWebhook(h, notification);
    assert.equal(projected.status, 200, JSON.stringify(projected.body));
    assert.equal(projected.body.replay, false);
    assert.equal(projected.body.provider_truth_reconciled, false, "transport success is never business completion");
    assert.deepEqual(projected.body.native_accounting_intent_ids, [journey.intentId]);
    const reconciled = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(reconciled?.state, "reconciled");
    assert.equal(reconciled?.provider_reconciled_at, new Date(clockStart + 60_000).toISOString());
    const paymentObservation = h.db.raw.prepare(
      `SELECT source FROM accounting_observations WHERE tenant_id = ? AND entity_type = 'Payment' AND entity_id = ?`,
    ).all(TENANT, paymentId) as Array<{ source: string }>;
    assert.deepEqual(paymentObservation.map((row) => ({ ...row })), [{ source: "webhook_triggered_read" }]);
    const callsAfterProjection = h.fake.quickBooksCalls.length;
    const observationsAfterProjection = h.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_observations").get()!.count;
    const reconciliationsAfterProjection = h.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_reconciliations").get()!.count;

    t.mock.timers.setTime(clockStart + 120_000);
    const replay = await postWebhook(h, notification);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.native_accounting_intent_ids, []);
    assert.deepEqual(webhookReceipts(h).map(({ replay_count }) => replay_count), [1]);
    assert.deepEqual(projectionOutbox(h).map(({ projection_status }) => projection_status), ["projected"]);
    assert.equal(h.fake.quickBooksCalls.length, callsAfterProjection, "a replay reads nothing from the provider");
    assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_observations").get()!.count, observationsAfterProjection);
    assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_reconciliations").get()!.count, reconciliationsAfterProjection);
    const afterReplay = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(afterReplay?.version, reconciled?.version);
    assert.equal(afterReplay?.provider_reconciled_at, reconciled?.provider_reconciled_at);
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

async function judgeAfterProviderChange(
  h: Harness,
  t: Parameters<Parameters<typeof test>[1]>[0],
  clockStart: number,
  intentId: string,
): Promise<void> {
  // First stale tick races the daily token refresh and is not evidence; the next tick judges.
  const staleTick = clockStart + 24 * 60 * 60_000 + 10 * 60_000;
  t.mock.timers.setTime(staleTick);
  await runFrequentCron(h, Date.now());
  assert.equal((await readAccountingIntent(h.env, TENANT, intentId))?.state, "partially_settled");
  t.mock.timers.setTime(staleTick + 5 * 60_000);
  await runFrequentCron(h, Date.now());
}

test("IRO-250 an amount mismatch on readback is a mismatch exception carrying the observed amount", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "amount-mismatch");
    await approveAcceptedDeposit(h, journey.intentId, "amount-mismatch");
    await runFrequentCron(h, clockStart);
    const posted = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(posted?.total_amount, "262.50");
    h.fake.restateInvoiceTotal(posted!.provider_entity_id!, "300.00");
    await judgeAfterProviderChange(h, t, clockStart, journey.intentId);

    const judged = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(judged?.state, "mismatch");
    assert.equal(judged?.provider_reconciled_at, null);
    const exception = h.db.raw.prepare(
      `SELECT reason_code, detail_json FROM accounting_exceptions WHERE tenant_id = ? AND intent_id = ? AND status = 'open'`,
    ).get(TENANT, journey.intentId) as { reason_code: string; detail_json: string };
    assert.equal(exception.reason_code, "expected_observed_mismatch");
    const detail = JSON.parse(exception.detail_json) as { entityId: string; expectedSha256: string; observedSha256: string };
    assert.equal(detail.entityId, posted!.provider_entity_id);
    assert.notEqual(detail.expectedSha256, detail.observedSha256);
    const observed = h.db.raw.prepare(
      `SELECT total_amount_cents FROM accounting_observations
        WHERE tenant_id = ? AND intent_id = ? ORDER BY observation_seq DESC LIMIT 1`,
    ).get(TENANT, journey.intentId) as { total_amount_cents: number };
    assert.equal(observed.total_amount_cents, 30_000, "the observation records the provider's restated amount");
    assert.equal(h.fake.providerInvoices.size, 1);
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

test("IRO-250 an entity identity mismatch on readback is an identity conflict, judged before any amount", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "entity-mismatch");
    await approveAcceptedDeposit(h, journey.intentId, "entity-mismatch");
    await runFrequentCron(h, clockStart);
    const posted = await readAccountingIntent(h.env, TENANT, journey.intentId);
    const invoiceId = posted!.provider_entity_id!;
    h.fake.misidentifyInvoice(invoiceId, "999");
    await judgeAfterProviderChange(h, t, clockStart, journey.intentId);

    const judged = await readAccountingIntent(h.env, TENANT, journey.intentId);
    assert.equal(judged?.provider_reconciled_at, null);
    const exception = h.db.raw.prepare(
      `SELECT reason_code, detail_json FROM accounting_exceptions WHERE tenant_id = ? AND intent_id = ? AND status = 'open'`,
    ).get(TENANT, journey.intentId) as { reason_code: string; detail_json: string };
    assert.equal(exception.reason_code, "provider_identity_conflict");
    const detail = JSON.parse(exception.detail_json) as {
      expected: { entityId: string; realmId: string };
      observed: { entityId: string; realmId: string };
    };
    assert.deepEqual(detail.expected, { realmId: QB_REALM_ID, entityType: "Invoice", entityId: invoiceId } as never);
    assert.equal(detail.observed.entityId, "999");
    assert.equal(
      h.db.raw.prepare(
        `SELECT verdict FROM accounting_reconciliations WHERE tenant_id = ? AND intent_id = ? ORDER BY rowid DESC LIMIT 1`,
      ).get(TENANT, journey.intentId)!.verdict,
      "identity_conflict",
    );
    assert.equal(h.fake.providerInvoices.size, 1);
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});

test("IRO-250 secrets, tokens and customer PII never land in money-plane events, exceptions, dead letters, audit or outboxes", async (t) => {
  const clockStart = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(clockStart) });
  const h = setup();
  try {
    const journey = await deriveAcceptedDeposit(h, "redaction");
    await approveAcceptedDeposit(h, journey.intentId, "redaction");
    await runFrequentCron(h, clockStart);
    const posted = await readAccountingIntent(h.env, TENANT, journey.intentId);
    const paymentId = h.fake.settleInvoice(posted!.provider_entity_id!);
    t.mock.timers.setTime(clockStart + 60_000);
    assert.equal((await postWebhook(h, quickBooksWebhook([{ name: "Payment", id: paymentId, operation: "Create" }]))).status, 200);
    assert.equal((await readAccountingIntent(h.env, TENANT, journey.intentId))?.state, "reconciled");
    const portalToken = (h.fake.sentEmails.at(-1) ?? "").match(/contract-accept#token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(portalToken);

    const needles: Record<string, string> = {
      qb_access_token: "synthetic-access-token",
      qb_refresh_token: "synthetic-refresh-token",
      qb_client_secret: "synthetic-client-secret",
      qb_oauth_code: "synthetic-oauth-code",
      qb_webhook_token: QB_WEBHOOK_TOKEN,
      gmail_token: "synthetic-gmail-token",
      auth_pepper: String(h.env.APP_AUTH_PEPPER),
      acceptance_challenge_token: portalToken,
      customer_email: CUSTOMER_EMAIL,
      customer_phone: CUSTOMER_PHONE.replace("+", ""),
    };
    const tables = (h.db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND (
         name LIKE '%|_events' ESCAPE '|' OR name LIKE '%|_exceptions' ESCAPE '|' OR name LIKE '%|_outbox' ESCAPE '|'
         OR name LIKE '%|_receipts' ESCAPE '|' OR name LIKE '%audit%' OR name = 'dead_letter'
         OR name IN ('external_effects', 'external_effect_attempts', 'accounting_reconciliations', 'accounting_intents')
       ) ORDER BY name`,
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    assert.ok(tables.includes("accounting_exceptions") && tables.includes("dead_letter") && tables.includes("audit_log"));
    const leaks: string[] = [];
    let scannedRows = 0;
    for (const table of tables) {
      for (const row of h.db.raw.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>) {
        scannedRows += 1;
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? value : JSON.stringify(value);
          for (const [label, needle] of Object.entries(needles)) {
            if (text?.includes(needle)) leaks.push(`${table}.${column}:${label}`);
          }
        }
      }
    }
    // R2 money-plane objects: receipts and the signed webhook raw. The intake envelopes under
    // `raw/<date>/` are the lead's own immutable contact record and are out of this plane.
    const moneyPlaneKeys = r2Snapshot(h.raw).filter(([key]) => !/^raw\/\d{4}-\d{2}-\d{2}\//.test(key));
    assert.ok(moneyPlaneKeys.some(([key]) => key.startsWith("raw/quickbooks/")));
    assert.ok(moneyPlaneKeys.some(([key]) => key.startsWith("customer-contract-acceptance/")));
    for (const [key, body] of moneyPlaneKeys) {
      for (const [label, needle] of Object.entries(needles)) {
        if (body.includes(needle)) leaks.push(`r2:${key.replace(/[0-9a-f-]{36}|acceptance_[0-9a-f-]+/g, "*")}:${label}`);
      }
    }
    assert.ok(scannedRows > 50, `expected a populated money plane, scanned ${scannedRows} rows`);
    assert.ok(tables.filter((table) => Number(h.db.raw.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()!.count) > 0).length >= 10);

    // The IRO-250 / ELEC-257 finding (a governed Gmail send keyed its effect on
    // `gmail:<recipient>:<hash>`, writing the customer's address into the effect ledger) is
    // closed by #367's `gmail:<hash>` key, so no clear-text address may remain anywhere.
    const distinct = [...new Set(leaks)].sort();
    assert.deepEqual(distinct, []);
    const keyedOnAddress = h.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM external_effects WHERE tenant_id = ? AND intent_id LIKE ?",
    ).get(TENANT, `gmail:${CUSTOMER_EMAIL}:%`) as { count: number };
    assert.equal(Number(keyedOnAddress.count), 0);
    const emailEffect = h.db.raw.prepare(
      "SELECT provider, action FROM external_effects WHERE tenant_id = ? AND provider = 'gmail' AND action = 'customer.email.send'",
    ).all(TENANT) as Array<{ provider: string; action: string }>;
    // Both governed sends to this customer (portal link, acceptance challenge) still run through
    // the ledger; the opaque key no longer reveals the recipient, so count every customer send.
    assert.ok(emailEffect.length >= 2, `expected at least two governed customer sends, found ${emailEffect.length}`);
    assert.deepEqual([...new Set(emailEffect.map((row) => `${row.provider}:${row.action}`))], ["gmail:customer.email.send"]);
  } finally {
    t.mock.timers.reset();
    h.restore();
  }
});
