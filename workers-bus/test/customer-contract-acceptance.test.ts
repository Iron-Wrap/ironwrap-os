import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mock, test } from "node:test";

import worker from "../src/index.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor, sha256Hex } from "../src/app-auth.ts";
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
import { buildProductionRunwayReadModel } from "../src/app-read-models.ts";
import {
  CUSTOMER_DEPOSIT_TERMS_REFUSAL,
  recordContractDepositGate,
  sweepContractDepositGates,
} from "../src/deposit-policy.ts";
import { recordTaxPolicySnapshot } from "../src/accounting-tax-snapshots.ts";
import {
  deriveNativeFinalInvoiceForJob,
  readAcceptedCommercialPaymentTerms,
  recordNativeFinalInvoiceProviderBinding,
} from "../src/native-final-invoice-producer.ts";
import { recordDepositPolicy } from "./deposit-policy-fixture.ts";
import { recordCompletedRoofJobWork } from "./native-completion-fixture.ts";
import {
  OperatingJobAssignmentError,
  recordOperatingJobAssignment,
} from "../src/operating-job-assignment-store.ts";
import {
  calendarReading,
  cancellationWindowEndsAt,
  cancellationWindowHold,
  readCancellationWindow,
} from "../src/production-cancellation-window.ts";
import {
  attestGateInLedger,
  bindCrewInLedger,
  d1Now,
  fixtureSchedule,
  waiveGateInLedger,
} from "./production-gate-ledger-fixture.ts";

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

/**
 * A database whose clock is the test's: every `'now'` the migrations' triggers and each statement
 * read is the `Date` the test may mock, so a case can stand D1 a millisecond either side of an end.
 */
class ClockedDatabase extends DatabaseSync {
  constructor() {
    super(":memory:");
    this.function("fixture_now", () => new Date().toISOString().replace("T", " ").replace("Z", ""));
  }

  prepare(sql: string) {
    return super.prepare(sql.replaceAll("'now'", "fixture_now()"));
  }

  exec(sql: string) {
    return super.exec(sql.replaceAll("'now'", "fixture_now()"));
  }
}

class SqliteD1 {
  readonly raw: DatabaseSync;
  throwNextBatchAfterCommit = false;
  /** Runs right before the next batch, as a writer that committed just ahead of it. */
  beforeNextBatch: (() => void) | null = null;
  /** Fails the next gate ledger append, as an unavailable D1 would. */
  failNextLedgerAppend = false;
  /** Fails the next read of the tenant's deposit policy, as an unavailable D1 would. */
  failNextPolicyRead = false;
  /** Fails the next read the signed copy is built from, as an unavailable D1 would (0160). */
  failNextSignedCopyBuild = false;
  /** Fails the next this many signed-copy event writes before they run, as an unavailable D1 would. */
  failSignedCopyEvents = 0;
  /** Commits the next this many signed-copy events, then loses D1's answer. */
  loseSignedCopyEventAnswers = 0;
  /** Fails the next this many served confirmations before they run. */
  failSignedCopyConfirmations = 0;
  /** Commits the next this many served confirmations, then loses D1's answer. */
  loseSignedCopyConfirmationAnswers = 0;
  /** Runs right before each served confirmation is prepared, as time passing in between. */
  beforeConfirmation: (() => void) | null = null;
  /** Every error a batch raised, so a case can tell which writer refused. */
  readonly batchErrors: string[] = [];

  /** With `clocked`, D1's clock is the (mockable) `Date` rather than the real one. */
  constructor(clocked = false) {
    this.raw = clocked ? new ClockedDatabase() : new DatabaseSync(":memory:");
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
    if (this.failNextLedgerAppend && sql.includes("INSERT INTO production_gate_clearances")) {
      this.failNextLedgerAppend = false;
      throw new Error("simulated_d1_unavailable");
    }
    if (this.failNextPolicyRead && sql.includes("FROM tenant_deposit_policy_revisions")) {
      this.failNextPolicyRead = false;
      throw new Error("simulated_d1_unavailable");
    }
    if (this.failNextSignedCopyBuild && sql.includes("AS signed_terms_hash")) {
      this.failNextSignedCopyBuild = false;
      throw new Error("simulated_d1_unavailable");
    }
    if (sql.includes("INSERT INTO contract_signed_copy_served (")) this.beforeConfirmation?.();
    for (const [table, fail, lose] of [
      ["contract_signed_copy_events", "failSignedCopyEvents", "loseSignedCopyEventAnswers"],
      ["contract_signed_copy_served", "failSignedCopyConfirmations", "loseSignedCopyConfirmationAnswers"],
    ] as const) {
      if (!sql.includes(`INSERT INTO ${table} (`)) continue;
      if (this[fail] > 0) {
        this[fail] -= 1;
        throw new Error("simulated_d1_unavailable");
      }
      if (this[lose] > 0) {
        this[lose] -= 1;
        return new SqliteStatement(this.raw, this.raw.prepare(sql), [], true);
      }
    }
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const before = this.beforeNextBatch;
    this.beforeNextBatch = null;
    before?.();
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
      this.batchErrors.push(String((error as Error).message ?? error));
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
  /** Runs, then throws, as a D1 that committed and lost its answer. */
  private readonly loseAnswer: boolean;

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
    loseAnswer = false,
  ) {
    this.database = database;
    this.statement = statement;
    this.args = args;
    this.loseAnswer = loseAnswer;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args, this.loseAnswer);
  }

  async first<T>(): Promise<T | null> {
    const row = (this.statement.get(...this.args) ?? null) as T | null;
    if (this.loseAnswer) throw new Error("simulated_lost_d1_response");
    return row;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...this.args);
    if (this.loseAnswer) throw new Error("simulated_lost_d1_response");
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
    /** The contract's terms; 25% deposit unless a case says otherwise. */
    terms?: Record<string, unknown>;
    /** The owner's deposit-policy revision, or null for none: OD-01, the 0155 default. */
    depositPolicy?: "md13_deposit" | "od01_payment_on_completion" | null;
    /** D1's clock is the test's `Date` (`ClockedDatabase`). */
    clocked?: boolean;
  } = {},
) {
  const db = new SqliteD1(options.clocked ?? false);
  // These contracts carry a 25% deposit, so the tenant takes deposits (MD-13) unless a case says
  // otherwise: since 0155 a tenant with no revision is OD-01 and refuses a deposit contract.
  const depositPolicy = options.depositPolicy === undefined ? "md13_deposit" : options.depositPolicy;
  if (depositPolicy) {
    recordDepositPolicy(db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: depositPolicy });
  }
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
  const terms = options.terms ?? TERMS;
  const chain = contracts > 0 ? await seedNativeContract(env, "primary", terms) : null;
  if (contracts === 2) await seedNativeContract(env, "alternate", terms);
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
  terms: Record<string, unknown> = TERMS,
  /** Another job, a quote short of approval (recorded alone), or a contract recorded in the past. */
  options: {
    roofJobId?: string;
    status?: "draft" | "needs_review" | "approved" | "rejected";
    validUntil?: string;
    base?: Date;
  } = {},
): Promise<NativeChain> {
  const base = options.base ?? new Date(Date.now() - 60_000);
  const roofJobId = options.roofJobId ?? JOB_ID;
  const quoteId = `customer-quote:acceptance:${suffix}`;
  const quoteRevisionId = `quote-revision:acceptance:${suffix}:1`;
  const proposalPackId = `proposal-pack:acceptance:${suffix}`;
  const proposalRevisionId = `proposal-revision:acceptance:${suffix}:1`;
  const quote: RecordCommercialQuoteInput = {
    tenantId: TENANT,
    quoteRevisionId,
    customerQuoteId: quoteId,
    revisionNumber: 1,
    roofJobId,
    customerId: CUSTOMER_ID,
    status: options.status ?? "approved",
    currency: "CAD",
    validUntil: options.validUntil ?? QUOTE_VALID_UNTIL,
    terms,
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
  const chain = {
    quoteId,
    quoteRevisionId,
    proposalPackId,
    proposalRevisionId,
    publicationVersion: 1,
  };
  // A proposal is made only of an approved quote.
  if ((options.status ?? "approved") !== "approved") return chain;

  const proposal: RecordCommercialProposalInput = {
    tenantId: TENANT,
    proposalRevisionId,
    proposalPackId,
    revisionNumber: 1,
    quoteRevisionId,
    roofJobId,
    customerId: CUSTOMER_ID,
    title: "Complete roof replacement proposal",
    summary: "Approved scope, price, schedule assumptions, and warranty.",
    terms,
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
      retryLimit: 1,
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
     (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner', NULL, 1, 'test-seed', ?, ?)`,
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

// ------------------------------------------------------------------------------------------------
// OD-01 payment on completion and the MD-13 branch (migration 0155): the tenant's deposit policy
// decides which contract may be signed, and a contract with no deposit clears the Deposit gate by
// policy after the acceptance has committed.

const OD01_TERMS = {
  deposit_percent: 0,
  payment_schedule: ["completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const OD01_TERMS_HASH = createHash("sha256").update(JSON.stringify(OD01_TERMS)).digest("hex");
const ACCOUNTANT_ID = "appu_accounting_0001";

type Harness = Awaited<ReturnType<typeof setup>>;

/** The seven gates the operating core creates for a job, blocked at version 1. */
function seedGates(h: Harness): void {
  const now = new Date(Date.now() - 120_000).toISOString();
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"]) {
    h.db.raw.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?)`,
    ).run(
      `gate:acceptance:${gate.toLowerCase()}`, TENANT, JOB_ID, ENVELOPE_ID, gate, now, now,
      `Awaiting ${gate.toLowerCase()} readiness proof.`, now, now,
    );
  }
}

/** A challenge for the current contract, then the customer's confirmation of it. */
async function accept(h: Harness, portalToken: string, idempotencyKey: string): Promise<Response> {
  const challenge = await issueChallenge(h.env, portalToken);
  assert.equal(challenge.status, 200, await challenge.clone().text());
  return await worker.fetch(
    confirmRequest(emailChallengeToken(h.sentEmails), idempotencyKey),
    h.env as never,
    {} as never,
  );
}

function depositGate(h: Harness): Record<string, unknown> {
  return {
    ...(h.db.raw.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id
         FROM operating_production_gates
        WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
    ).get(TENANT, JOB_ID) as Record<string, unknown>),
  };
}

function depositEntries(h: Harness): Array<Record<string, any>> {
  return h.db.raw.prepare(
    `SELECT clearance_id, entry_kind, basis, to_state, from_gate_version, reverses_id, actor_kind,
            actor_user_id, actor_role, policy_version, contract_binding_id, terms_hash, reason,
            evidence_refs_json
       FROM production_gate_clearances
      WHERE tenant_id = ? AND gate = 'Deposit'
      ORDER BY from_gate_version`,
  ).all(TENANT).map((row) => ({ ...row }));
}

function count(h: Harness, table: string): number {
  return Number((h.db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function bindingFor(h: Harness, acceptanceId: string): Record<string, string> {
  return {
    ...(h.db.raw.prepare(
      "SELECT * FROM commercial_acceptance_bindings WHERE acceptance_id = ?",
    ).get(acceptanceId) as Record<string, string>),
  };
}

let ledgerCounter = 0;

/** A Deposit ledger entry written straight at D1, the way a defective writer would. */
function appendDeposit(h: Harness, overrides: Record<string, unknown>): void {
  ledgerCounter += 1;
  const gate = depositGate(h);
  const row: Record<string, unknown> = {
    clearance_id: `pgc_${ledgerCounter.toString(16).padStart(40, "a")}`,
    tenant_id: TENANT,
    gate_id: "gate:acceptance:deposit",
    roof_job_id: JOB_ID,
    gate: "Deposit",
    entry_kind: "clear",
    basis: "contract_no_deposit",
    to_state: "complete",
    from_gate_version: gate.version,
    actor_kind: "policy",
    policy_version: "ironwrap.deposit-gate.v1",
    contract_binding_id: "commercial-acceptance:not-a-signed-contract",
    terms_hash: OD01_TERMS_HASH,
    evidence_refs_json: "{}",
    request_sha256: createHash("sha256").update(`request:${ledgerCounter}`).digest("hex"),
    idempotency_key_hash: createHash("sha256").update(`direct:${ledgerCounter}`).digest("hex"),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  h.db.raw.prepare(
    `INSERT INTO production_gate_clearances (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
}

/** The deposit-terms refusals the Worker logged while `action` ran, with what the customer got. */
async function loggingRefusals<T>(
  action: () => Promise<T>,
): Promise<{ result: T; refusals: Array<Record<string, unknown>> }> {
  const refusals: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    let line: unknown = null;
    try {
      line = JSON.parse(String(args[0]));
    } catch {
      // Not a structured line.
    }
    if (isRecord(line) && line.at === "deposit_terms_refused") refusals.push(line);
    else original(...args);
  };
  try {
    return { result: await action(), refusals };
  } finally {
    console.log = original;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusedWith(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

async function jobPhase(h: Harness): Promise<Record<string, any>> {
  const response = await handleAuthenticatedRoute(
    authenticatedPhaseRequest(JOB_ID),
    h.env,
    authenticatedRouteAuth("owner"),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as Record<string, any>;
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
    await sessionHashFor(h.env, token), userId, TENANT, new Date(now - 60_000).toISOString(),
    new Date(now + 3_600_000).toISOString(), new Date(now).toISOString(), "d".repeat(64), "e".repeat(64),
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

async function clearGate(
  h: Harness,
  person: AuthContext,
  gate: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleAuthenticatedRoute(
    new Request(
      `${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates/${gate}/clearance`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-csrf-token": person.csrfToken,
        },
        body: JSON.stringify(body),
      },
    ),
    h.env,
    person,
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Quote revision 2 of the chain's customer quote, with these terms. Returns its id. */
async function reviseQuote(
  h: Harness,
  chain: NativeChain,
  terms: Record<string, unknown>,
  base: Date,
  revision = 2,
): Promise<string> {
  const suffix = chain.quoteId.split(":").at(-1)!;
  const quoteRevisionId = `quote-revision:acceptance:${suffix}:${revision}`;
  const quote: RecordCommercialQuoteInput = {
    tenantId: TENANT,
    quoteRevisionId,
    customerQuoteId: chain.quoteId,
    revisionNumber: revision,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    supersedesQuoteRevisionId: chain.quoteRevisionId,
    correctionReason: "Synthetic correction of the contract's payment terms.",
    status: "approved",
    currency: "CAD",
    validUntil: QUOTE_VALID_UNTIL,
    terms,
    evidence: EVIDENCE,
    lines: [{
      lineId: "scope:roof",
      sequence: 1,
      kind: "labour",
      description: "Install approved roofing scope",
      quantityMicros: 1_000_000,
      uom: "job",
      unitPriceCents: 100_000,
      taxCode: "GST",
      taxCents: 5_000,
    }],
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `acceptance:quote:${suffix}:${revision}`,
  };
  const preparedQuote = await prepareCommercialQuote(quote);
  const quotePermit = await admitFor(
    h.env,
    "quote.revision.record",
    { type: "customer_quote", id: chain.quoteId, version: revision },
    preparedQuote.command,
    `permit:acceptance:quote:${suffix}:${revision}`,
    base,
    preparedQuote.totalCents,
  );
  quote.authority = { kind: "policy_permit", permitId: quotePermit.permit_id };
  await recordCommercialQuoteRevision(h.env, quote, new Date(base.getTime() + 1_000));
  return quoteRevisionId;
}

/**
 * Proposal revision 2 (or `revision`) of the chain's pack, made of the given quote revision,
 * unpublished. The chain moves onto both.
 */
async function reviseProposal(
  h: Harness,
  chain: NativeChain,
  quoteRevisionId: string,
  terms: Record<string, unknown>,
  base: Date,
  revision = 2,
): Promise<void> {
  const suffix = chain.quoteId.split(":").at(-1)!;
  const proposalRevisionId = `proposal-revision:acceptance:${suffix}:${revision}`;
  const proposal: RecordCommercialProposalInput = {
    tenantId: TENANT,
    proposalRevisionId,
    proposalPackId: chain.proposalPackId,
    revisionNumber: revision,
    quoteRevisionId,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    supersedesProposalRevisionId: chain.proposalRevisionId,
    title: "Corrected roof replacement proposal",
    summary: "Corrected scope, price and payment terms.",
    terms,
    contentRef: `r2://commercial/proposals/${suffix}-corrected.pdf`,
    contentHash: "d".repeat(64),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `acceptance:proposal:${suffix}:${revision}`,
  };
  const preparedProposal = await prepareCommercialProposal(proposal);
  const proposalPermit = await admitFor(
    h.env,
    "proposal.revision.record",
    { type: "proposal", id: chain.proposalPackId, version: revision },
    preparedProposal.command,
    `permit:acceptance:proposal:${suffix}:${revision}`,
    new Date(base.getTime() + 2_000),
  );
  proposal.authority = { kind: "policy_permit", permitId: proposalPermit.permit_id };
  await recordCommercialProposalRevision(h.env, proposal, new Date(base.getTime() + 3_000));
  chain.quoteRevisionId = quoteRevisionId;
  chain.proposalRevisionId = proposalRevisionId;
}

/** Quote revision 2 (or `revision`) and its proposal, published in place of the contract before. */
async function publishCorrectedContract(
  h: Harness,
  terms: Record<string, unknown>,
  revision = 2,
): Promise<void> {
  const chain = h.chain!;
  // Each later revision's events start later, after the ones the revision before it recorded.
  const base = new Date(Date.now() - 20_000 + (revision - 2) * 10_000);
  const quoteRevisionId = await reviseQuote(h, chain, terms, base, revision);
  await reviseProposal(h, chain, quoteRevisionId, terms, base, revision);

  // The lead converted at the first acceptance, so only the correction's revision may move the
  // publication: withdraw the pack under it, then publish it.
  await recordPublicationTransition(h.env, chain, "withdrawn", new Date(base.getTime() + 4_000));
  await recordPublicationTransition(
    h.env,
    chain,
    "published",
    new Date(base.getTime() + 5_000),
    "withdrawn",
  );
}

/** The binding's derivation names its deposit invoice, as the derivation worker records it. */
function deriveDepositInvoice(h: Harness, acceptanceBindingId: string, intentId: string): void {
  h.db.raw.prepare(
    `UPDATE commercial_deposit_derivations
        SET state = 'derived', intent_id = ?, blocker_code = NULL, blocker_next_step = NULL,
            version = version + 1, updated_at = ?
      WHERE tenant_id = ? AND acceptance_binding_id = ?`,
  ).run(intentId, new Date().toISOString(), TENANT, acceptanceBindingId);
}

/**
 * A deposit invoice of this job the money lane has reconciled, unless a case overrides its state
 * (for example an invoice QuickBooks holds but nobody has paid yet).
 */
function seedReconciledDeposit(
  h: Harness,
  intentId: string,
  providerEntityId: string,
  reconciledAt = new Date().toISOString(),
  overrides: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    intent_id: intentId,
    tenant_id: TENANT,
    kind: "deposit_invoice",
    roof_job_id: JOB_ID,
    basis_json: "{}",
    basis_sha256: createHash("sha256").update(`basis:${intentId}`).digest("hex"),
    source_documents_json: "[]",
    expected_sha256: "b".repeat(64),
    tax_policy_snapshot_sha256: "e".repeat(64),
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_payload_json: "{}",
    provider_payload_sha256: "c".repeat(64),
    provider_request_id: `req:${intentId}`,
    currency: "CAD",
    subtotal: "250.00",
    tax_amount: "12.50",
    total_amount: "262.50",
    settled_amount: "262.50",
    authority_permit_ref: "permit:test",
    authority_policy_ref: "policy:test",
    authority_policy_version: "1",
    authority_max_amount: "100000.00",
    effect_id: `effect:${intentId}`,
    effect_idempotency_key: `effect-key:${intentId}`,
    state: "reconciled",
    version: 1,
    derived_by_actor_kind: "owner",
    derived_by_user_id: OWNER_ID,
    derived_at: new Date().toISOString(),
    approved_by_user_id: ACCOUNTANT_ID,
    approved_at: new Date().toISOString(),
    provider_entity_id: providerEntityId,
    observed_sha256: "b".repeat(64),
    provider_submitted_at: reconciledAt,
    provider_reconciled_at: reconciledAt,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  h.db.raw.prepare(
    `INSERT INTO accounting_intents (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
}

test("an OD-01 acceptance records Deposit as not required by the contract, by policy, with no derivation", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const response = await accept(h, portalToken, "acceptance-od01-0001");
    assert.equal(response.status, 200, await response.clone().text());
    const accepted = await response.json() as { status: string; acceptance_id: string };
    assert.equal(accepted.status, "accepted");
    const binding = bindingFor(h, accepted.acceptance_id);
    assert.equal(binding.terms_hash, OD01_TERMS_HASH);
    // No deposit, so nothing to derive, and no deposit invoice: not even the recovery pass makes
    // one. The final invoice therefore has no prior invoice to subtract (native-final-invoice-
    // producer.test.ts bills such a contract's whole total).
    assert.equal(count(h, "commercial_deposit_derivations"), 0);
    await reconcileCustomerContractAcceptanceAttempts(h.env, new Date());
    assert.equal(count(h, "commercial_deposit_derivations"), 0);
    assert.equal(count(h, "accounting_intents"), 0);

    const entries = depositEntries(h);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.deepEqual(
      {
        entry_kind: entry.entry_kind, basis: entry.basis, to_state: entry.to_state,
        from_gate_version: entry.from_gate_version, actor_kind: entry.actor_kind,
        actor_user_id: entry.actor_user_id, actor_role: entry.actor_role,
        policy_version: entry.policy_version, contract_binding_id: entry.contract_binding_id,
        terms_hash: entry.terms_hash, reason: entry.reason,
      },
      {
        entry_kind: "clear", basis: "contract_no_deposit", to_state: "complete",
        from_gate_version: 1, actor_kind: "policy", actor_user_id: null, actor_role: null,
        policy_version: "ironwrap.deposit-gate.v1",
        contract_binding_id: binding.acceptance_binding_id, terms_hash: OD01_TERMS_HASH, reason: null,
      },
    );
    // The contract version is the evidence: binding, receipt, quote revision, terms, approver, digests.
    const quote = h.db.raw.prepare(
      `SELECT revision_number, evidence_digest, policy_permit_id FROM commercial_quote_revisions
        WHERE quote_revision_id = ?`,
    ).get(binding.quote_revision_id) as Record<string, unknown>;
    const permit = h.db.raw.prepare(
      "SELECT actor_type, actor_id FROM commercial_authority_permits WHERE permit_id = ?",
    ).get(quote.policy_permit_id as string) as Record<string, unknown>;
    const proposal = h.db.raw.prepare(
      "SELECT evidence_digest FROM commercial_proposal_revisions WHERE proposal_revision_id = ?",
    ).get(binding.proposal_revision_id) as Record<string, unknown>;
    const publication = h.db.raw.prepare(
      `SELECT publication_event_id, evidence_digest FROM commercial_proposal_publication_events
        WHERE proposal_revision_id = ? AND state = 'published' ORDER BY publication_version DESC LIMIT 1`,
    ).get(binding.proposal_revision_id) as Record<string, unknown>;
    assert.deepEqual(JSON.parse(String(entry.evidence_refs_json)), {
      basis: "contract_no_deposit",
      policy_version: "ironwrap.deposit-gate.v1",
      tenant_policy: { policy: "od01_payment_on_completion", version: 0 },
      reverses: null,
      contract: {
        acceptance_binding_id: binding.acceptance_binding_id,
        acceptance_id: accepted.acceptance_id,
        receipt_hash: binding.receipt_hash,
        accepted_at: binding.accepted_at,
        quote_revision_id: binding.quote_revision_id,
        customer_quote_id: h.chain!.quoteId,
        quote_revision_number: quote.revision_number,
        terms_hash: OD01_TERMS_HASH,
        deposit_percent: 0,
        quote_approval: {
          kind: "policy_permit",
          id: quote.policy_permit_id,
          actor_type: permit.actor_type,
          actor_id: permit.actor_id,
        },
        proposal_revision_id: binding.proposal_revision_id,
        publication_event_id: publication.publication_event_id,
        quote_evidence_digest: quote.evidence_digest,
        proposal_evidence_digest: proposal.evidence_digest,
        publication_evidence_digest: publication.evidence_digest,
      },
    });
    assert.deepEqual(depositGate(h), {
      state: "complete",
      version: 2,
      clearance_basis: null,
      clearance_decision_id: entry.clearance_id,
      cleared_by_user_id: null,
    });
    assert.deepEqual(
      h.db.raw.prepare("SELECT trigger, action, approved_by FROM audit_log WHERE run_id = ?")
        .all(entry.clearance_id).map((row) => ({ ...row })),
      [{ trigger: "policy", action: "clear:contract_no_deposit", approved_by: null }],
    );

    // Read models: not required by the contract, not deposit_pending and not done.
    const phase = await jobPhase(h);
    assert.equal(phase.phase, "production_blocked");
    assert.equal(phase.facts.commercial.deposit_requirement, "no_deposit_under_contract");
    assert.equal(phase.facts.commercial.deposit_derivation, null);
    assert.deepEqual(
      (phase.stale_reasons as string[]).filter((reason) => reason.startsWith("commercial.deposit")),
      [],
    );
    assert.ok(!(phase.stale_reasons as string[]).includes("production.gate_deposit_complete"));
    const runway = await buildProductionRunwayReadModel(h.env, authenticatedRouteAuth("owner"));
    const job = runway.jobs.find((candidate) => candidate.id === JOB_ID)!;
    assert.deepEqual(
      job.scheduling_gates.find((gate) => gate.name === "Deposit"),
      { name: "Deposit", state: "No deposit under this contract" },
    );
    assert.deepEqual(job.gate_summary, { expected: 6, blocked: 5, ready: 0, waived: 0, done: 0 });

    // A replayed confirmation and the sweep find the entry recorded and add nothing.
    const replay = await worker.fetch(
      confirmRequest(emailChallengeToken(h.sentEmails), "acceptance-od01-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });
    assert.deepEqual(
      await recordContractDepositGate(h.env, {
        tenantId: TENANT,
        acceptanceBindingId: binding.acceptance_binding_id,
      }),
      { outcome: "not_applicable", reason: "deposit_gate_not_blocked" },
    );
    assert.equal(depositEntries(h).length, 1);
  } finally {
    h.restore();
  }
});

test("under OD-01 a deposit contract gets no challenge: the customer reads plain words, the log names the policy and the term", async () => {
  const h = await setup({ depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const { result: challenge, refusals } = await loggingRefusals(() => issueChallenge(h.env, portalToken));
    assert.equal(challenge.status, 409);
    // An anonymous buyer gets the code and plain words, never the policy or the field.
    assert.deepEqual(await challenge.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL);
    assert.deepEqual(Object.keys(CUSTOMER_DEPOSIT_TERMS_REFUSAL).sort(), ["error", "message"]);
    assert.doesNotMatch(CUSTOMER_DEPOSIT_TERMS_REFUSAL.message, /od01|md13|deposit_percent|payment_schedule|_/);
    assert.deepEqual(refusals, [{
      at: "deposit_terms_refused",
      stage: "challenge",
      roof_job_id: JOB_ID,
      policy: "od01_payment_on_completion",
      field: "terms.deposit_percent",
    }]);
    assert.equal(h.sentEmails.length, 0);
    assert.equal(count(h, "customer_portal_acceptance_challenges"), 0);
    assert.equal(count(h, "commercial_acceptance_bindings"), 0);
    assert.deepEqual(depositGate(h).state, "blocked");
  } finally {
    h.restore();
  }
});

test("a policy change after the challenge is refused by name at confirmation, and replays the same", async () => {
  const h = await setup();
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
    // MD-13 is turned off after the customer opened the contract.
    recordDepositPolicy(h.db.raw, {
      tenantId: TENANT,
      ownerUserId: OWNER_ID,
      policy: "od01_payment_on_completion",
    });
    const token = emailChallengeToken(h.sentEmails);
    const { refusals } = await loggingRefusals(async () => {
      const preview = await worker.fetch(previewRequest(token), h.env as never, {} as never);
      assert.equal(preview.status, 409);
      assert.deepEqual(await preview.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const confirmed = await worker.fetch(
          confirmRequest(token, "acceptance-policy-changed-0001"),
          h.env as never,
          {} as never,
        );
        assert.equal(confirmed.status, 409);
        assert.deepEqual(await confirmed.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL);
      }
    });
    // The replay answers from the stored rejection: the policy and the term are logged once each.
    assert.deepEqual(
      refusals.map(({ stage, policy, field }) => ({ stage, policy, field })),
      [
        { stage: "preview", policy: "od01_payment_on_completion", field: "terms.deposit_percent" },
        { stage: "confirm", policy: "od01_payment_on_completion", field: "terms.deposit_percent" },
      ],
    );
    assert.deepEqual(
      { ...h.db.raw.prepare("SELECT state, error_code FROM customer_portal_acceptance_intents").get() as object },
      { state: "rejected", error_code: "deposit_terms_not_allowed_by_policy" },
    );
    assert.equal(count(h, "commercial_acceptance_bindings"), 0);
    assert.equal(count(h, "commercial_deposit_derivations"), 0);
  } finally {
    h.restore();
  }
});

for (const [label, terms, from, to, field, abort] of [
  [
    "a deposit contract under OD-01", TERMS, "md13_deposit", "od01_payment_on_completion",
    "terms.deposit_percent", "deposit_terms_not_allowed_by_policy",
  ],
  [
    "a contract with no deposit under MD-13", OD01_TERMS, "od01_payment_on_completion", "md13_deposit",
    "terms.deposit_percent", "commercial_deposit_percent_invalid",
  ],
] as const) {
  test(`D1 aborts ${label} atomically when the policy changes under the commit, and the refusal is named`, async () => {
    const h = await setup({ terms, depositPolicy: from });
    try {
      seedGates(h);
      const portalToken = await seedPortalLink(h.db);
      assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
      // The owner's change commits between the Worker's check and the acceptance commit.
      h.db.beforeNextBatch = () => {
        recordDepositPolicy(h.db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: to });
      };
      const { result: confirmed, refusals } = await loggingRefusals(() => worker.fetch(
        confirmRequest(emailChallengeToken(h.sentEmails), "acceptance-policy-race-0001"),
        h.env as never,
        {} as never,
      ));
      assert.equal(confirmed.status, 409);
      assert.deepEqual(await confirmed.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL);
      assert.deepEqual(
        refusals.map(({ stage, policy, field }) => ({ stage, policy, field })),
        [{ stage: "commit", policy: to, field }],
      );
      assert.equal(h.db.beforeNextBatch, null);
      // D1 refused the binding itself; the Worker named the refusal afterwards.
      assert.ok(h.db.batchErrors.some((message) => message.includes(abort)), h.db.batchErrors.join(" | "));
      assert.equal(count(h, "commercial_acceptance_bindings"), 0);
      assert.equal(count(h, "commercial_deposit_derivations"), 0);
      assert.deepEqual(depositEntries(h), []);
      assert.equal(
        (h.db.raw.prepare("SELECT state FROM customer_portal_acceptance_intents").get() as { state: string }).state,
        "rejected",
      );
    } finally {
      h.restore();
    }
  });
}

/** A sent challenge for the current contract, written the way the challenge route writes one. */
async function seedSentChallenge(h: Harness): Promise<string> {
  const token = randomToken();
  const chain = h.chain!;
  const quote = h.db.raw.prepare(
    `SELECT customer_quote_id, revision_number, terms_hash, terms_json
       FROM commercial_quote_revisions WHERE quote_revision_id = ?`,
  ).get(chain.quoteRevisionId) as Record<string, string | number>;
  const now = new Date();
  const challengeId = `acceptance_challenge_${crypto.randomUUID()}`;
  h.db.raw.prepare(
    `INSERT INTO customer_portal_acceptance_challenges
       (challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id,
        email_hash, quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
        request_ip_hash, request_user_agent_hash, state, created_at, expires_at, sent_at,
        provider_message_id, consumed_at, invalidated_at)
     VALUES (?, ?, ?, 'portal_00000000-0000-4000-8000-000000000001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'pending_delivery', ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(
    challengeId, await sha256Hex(token), TENANT, JOB_ID, CUSTOMER_ID, EMAIL_HASH,
    quote.customer_quote_id!, quote.revision_number!, chain.proposalPackId, quote.terms_hash!,
    quote.terms_json!, "a".repeat(64), "b".repeat(64), now.toISOString(),
    new Date(now.getTime() + 15 * 60_000).toISOString(),
  );
  h.db.raw.prepare(
    `UPDATE customer_portal_acceptance_challenges
        SET state = 'sent', sent_at = ?, provider_message_id = 'gmail-direct-0001'
      WHERE challenge_id = ?`,
  ).run(now.toISOString(), challengeId);
  return token;
}

test("D1 keeps MD-13's 1-100 rule as the backstop for deposit terms the Worker would refuse", async () => {
  for (const [label, depositPercent] of [["string", "25"], ["decimal", 25.5], ["range", 101], ["zero", 0]] as const) {
    const h = await setup({ terms: { ...TERMS, deposit_percent: depositPercent } });
    try {
      seedGates(h);
      await seedPortalLink(h.db);
      // The challenge route refuses these terms by name, so the challenge is written directly, and
      // the Worker's own policy check is made unreadable: only D1 stands between them and a binding.
      const token = await seedSentChallenge(h);
      h.db.failNextPolicyRead = true;
      const { result: confirmed, refusals } = await loggingRefusals(() => worker.fetch(
        confirmRequest(token, `acceptance-md13-backstop-${label}`),
        h.env as never,
        {} as never,
      ));
      assert.equal(h.db.failNextPolicyRead, false, label);
      assert.ok(
        h.db.batchErrors.some((message) => message.includes("commercial_deposit_percent_invalid")),
        `${label}: ${h.db.batchErrors.join(" | ")}`,
      );
      assert.equal(confirmed.status, 409, label);
      assert.deepEqual(await confirmed.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL, label);
      assert.deepEqual(
        refusals.map(({ stage, policy, field }) => ({ stage, policy, field })),
        [{ stage: "commit", policy: "md13_deposit", field: "terms.deposit_percent" }],
        label,
      );
      assert.equal(count(h, "commercial_acceptance_bindings"), 0, label);
      assert.equal(count(h, "commercial_deposit_derivations"), 0, label);
      assert.deepEqual(depositEntries(h), [], label);
    } finally {
      h.restore();
    }
  }
});

test("under MD-13 a contract keeps its 1-100 deposit, enqueues its derivation, and needs no policy entry", async () => {
  const h = await setup({ terms: { ...TERMS, deposit_percent: 100 } });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const response = await accept(h, portalToken, "acceptance-md13-0001");
    assert.equal(response.status, 200, await response.clone().text());
    const accepted = await response.json() as { acceptance_id: string };
    assert.equal(
      (h.db.raw.prepare(
        "SELECT deposit_percent FROM commercial_deposit_derivations WHERE acceptance_id = ?",
      ).get(accepted.acceptance_id) as { deposit_percent: number }).deposit_percent,
      100,
    );
    assert.deepEqual(depositEntries(h), []);
    assert.equal(depositGate(h).state, "blocked");
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });
    const phase = await jobPhase(h);
    assert.equal(phase.phase, "deposit_pending");
    assert.equal(phase.facts.commercial.deposit_requirement, null);
    // A contract with no deposit is refused by name under MD-13 before it reaches the customer.
    const refused = await setup({ terms: OD01_TERMS });
    try {
      const portal = await seedPortalLink(refused.db);
      const { result: challenge, refusals } = await loggingRefusals(() => issueChallenge(refused.env, portal));
      assert.equal(challenge.status, 409);
      assert.deepEqual(await challenge.json(), CUSTOMER_DEPOSIT_TERMS_REFUSAL);
      assert.deepEqual(
        refusals.map(({ stage, policy, field }) => ({ stage, policy, field })),
        [{ stage: "challenge", policy: "md13_deposit", field: "terms.deposit_percent" }],
      );
    } finally {
      refused.restore();
    }
  } finally {
    h.restore();
  }
});

test("a later contract that carries a deposit re-blocks Deposit, which then clears only on that contract's own invoice", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    h.db.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, 'accounting@example.invalid', 'Accounting', 'ops', 'accounting', NULL, 1,
               'test-seed', ?, ?)`,
    ).run(ACCOUNTANT_ID, TENANT, new Date().toISOString(), new Date().toISOString());
    const portalToken = await seedPortalLink(h.db);
    const first = await accept(h, portalToken, "acceptance-od01-first-0001");
    assert.equal(first.status, 200, await first.clone().text());
    const noDeposit = depositEntries(h)[0]!;
    assert.equal(noDeposit.basis, "contract_no_deposit");

    // MD-13's input arrives: the owner turns OD-01 off and a corrected contract carries a deposit.
    recordDepositPolicy(h.db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: "md13_deposit" });
    await publishCorrectedContract(h, TERMS);
    // The policy's reversal does not land after this commit, so the sweep has to append it.
    h.db.failNextLedgerAppend = true;
    const second = await accept(h, portalToken, "acceptance-md13-second-0001");
    assert.equal(second.status, 200, await second.clone().text());
    const secondBinding = bindingFor(h, (await second.json() as { acceptance_id: string }).acceptance_id);
    assert.equal(depositEntries(h).length, 1);
    assert.equal(depositGate(h).state, "complete");

    // Meanwhile a person spends the key an earlier build derived for that reversal on a waiver of
    // their own. The policy's key is outside the alphabet a person's key may use, so it still lands.
    const owner = await personAuth(h, OWNER_ID);
    const waiver = await clearGate(
      h,
      owner,
      "Materials",
      { basis: "office_waiver", reason: "Synthetic waiver to occupy a policy key." },
      `ironwrap.deposit-gate.v1:contract_superseded:${secondBinding.acceptance_binding_id}`,
    );
    assert.equal(waiver.status, 200, JSON.stringify(waiver.body));
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 1, recorded: 1, refused: 0 });

    const entries = depositEntries(h);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      {
        entry_kind: entries[1]!.entry_kind, basis: entries[1]!.basis, to_state: entries[1]!.to_state,
        from_gate_version: entries[1]!.from_gate_version, reverses_id: entries[1]!.reverses_id,
        actor_kind: entries[1]!.actor_kind, actor_user_id: entries[1]!.actor_user_id,
        contract_binding_id: entries[1]!.contract_binding_id, terms_hash: entries[1]!.terms_hash,
      },
      {
        entry_kind: "reverse", basis: "contract_superseded", to_state: "blocked",
        from_gate_version: 2, reverses_id: noDeposit.clearance_id, actor_kind: "policy",
        actor_user_id: null, contract_binding_id: secondBinding.acceptance_binding_id,
        terms_hash: TERMS_HASH,
      },
    );
    assert.deepEqual(depositGate(h), {
      state: "blocked",
      version: 3,
      clearance_basis: null,
      clearance_decision_id: null,
      cleared_by_user_id: null,
    });
    assert.equal(
      h.db.raw.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE run_id = ?").get(entries[1]!.clearance_id)!.count,
      1,
    );
    const phase = await jobPhase(h);
    assert.equal(phase.phase, "deposit_pending");
    assert.equal(phase.facts.commercial.deposit_requirement, null);
    // The reversal is recorded once: the sweep finds nothing left to append.
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });

    // From then on a settlement must be the deposit invoice of the contract in force, even when
    // another deposit invoice of the job was reconciled after it.
    seedReconciledDeposit(h, "acct-intent-od01-contract-01", "2002", new Date(Date.now() - 60_000).toISOString());
    h.db.raw.prepare(
      `UPDATE commercial_deposit_derivations
          SET state = 'derived', intent_id = ?, blocker_code = NULL, blocker_next_step = NULL,
              version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND acceptance_binding_id = ?`,
    ).run("acct-intent-od01-contract-01", new Date().toISOString(), TENANT, secondBinding.acceptance_binding_id);
    seedReconciledDeposit(h, "acct-intent-od01-unrelated-01", "2001", new Date().toISOString());
    refusedWith(
      () => appendDeposit(h, {
        entry_kind: "clear",
        basis: "deposit_settlement",
        to_state: "complete",
        actor_kind: "person",
        actor_user_id: OWNER_ID,
        actor_role: "owner",
        policy_version: null,
        contract_binding_id: null,
        terms_hash: null,
        evidence_refs_json: JSON.stringify({ money_intent_id: "acct-intent-od01-unrelated-01" }),
      }),
      "deposit_settlement_not_observed",
    );
    const settled = await clearGate(h, owner, "Deposit", { basis: "deposit_settlement" }, "deposit-settlement-od01-0001");
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.clearance, "verified");
    assert.equal(depositGate(h).state, "complete");
    assert.equal(
      JSON.parse(String(depositEntries(h).at(-1)!.evidence_refs_json)).money_intent_id,
      "acct-intent-od01-contract-01",
    );
  } finally {
    h.restore();
  }
});

test("an earlier contract's paid deposit invoice never settles a later contract that carries its own deposit", async () => {
  const h = await setup();
  try {
    seedGates(h);
    h.db.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, 'accounting@example.invalid', 'Accounting', 'ops', 'accounting', NULL, 1,
               'test-seed', ?, ?)`,
    ).run(ACCOUNTANT_ID, TENANT, new Date().toISOString(), new Date().toISOString());
    const portalToken = await seedPortalLink(h.db);
    const first = await accept(h, portalToken, "acceptance-md13-first-paid-0001");
    assert.equal(first.status, 200, await first.clone().text());
    const firstBinding = bindingFor(h, (await first.json() as { acceptance_id: string }).acceptance_id);
    // Contract A's 25% deposit invoice is derived and paid.
    seedReconciledDeposit(h, "acct-intent-contract-a-paid-1", "2001", new Date(Date.now() - 60_000).toISOString());
    deriveDepositInvoice(h, firstBinding.acceptance_binding_id, "acct-intent-contract-a-paid-1");

    // Contract B replaces it with a 30% deposit of its own, before Deposit was cleared on A.
    await publishCorrectedContract(h, { ...TERMS, deposit_percent: 30 });
    const second = await accept(h, portalToken, "acceptance-md13-second-unpaid-0001");
    assert.equal(second.status, 200, await second.clone().text());
    const secondBinding = bindingFor(h, (await second.json() as { acceptance_id: string }).acceptance_id);
    assert.equal(depositGate(h).state, "blocked");
    assert.deepEqual(depositEntries(h), []);
    const owner = await personAuth(h, OWNER_ID);

    // B's invoice is not derived yet, and then derived but not paid: A's payment settles neither.
    const notDerived = await clearGate(h, owner, "Deposit", { basis: "deposit_settlement" }, "deposit-settlement-b-0001");
    assert.equal(notDerived.status, 409, JSON.stringify(notDerived.body));
    assert.deepEqual(notDerived.body, { error: "deposit_settlement_not_observed" });
    seedReconciledDeposit(h, "acct-intent-contract-b-open-1", "2002", new Date().toISOString(), {
      state: "submitted",
      settled_amount: null,
      provider_reconciled_at: null,
    });
    deriveDepositInvoice(h, secondBinding.acceptance_binding_id, "acct-intent-contract-b-open-1");
    const unpaid = await clearGate(h, owner, "Deposit", { basis: "deposit_settlement" }, "deposit-settlement-b-0002");
    assert.equal(unpaid.status, 409, JSON.stringify(unpaid.body));
    assert.deepEqual(unpaid.body, { error: "deposit_settlement_not_observed" });
    assert.equal(depositGate(h).state, "blocked");
    assert.deepEqual(depositEntries(h), []);

    // Once B's own invoice is reconciled, Deposit clears on it, and only on it.
    h.db.raw.prepare(
      `UPDATE accounting_intents
          SET state = 'reconciled', settled_amount = total_amount, provider_reconciled_at = ?,
              version = version + 1, updated_at = ?
        WHERE intent_id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), "acct-intent-contract-b-open-1");
    const settled = await clearGate(h, owner, "Deposit", { basis: "deposit_settlement" }, "deposit-settlement-b-0003");
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(depositGate(h).state, "complete");
    assert.equal(
      JSON.parse(String(depositEntries(h).at(-1)!.evidence_refs_json)).money_intent_id,
      "acct-intent-contract-b-open-1",
    );
  } finally {
    h.restore();
  }
});

test("with no signed contract Deposit stays blocked, and no person ever reverses contract_no_deposit", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    // Nothing is signed: the sweep has nothing to record, and D1 refuses an entry no contract backs.
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });
    refusedWith(() => appendDeposit(h, {}), "production_gate_contract_no_deposit_not_observed");
    // Only the policy appends it: a person entry with the same basis is outside the person matrix.
    refusedWith(
      () => appendDeposit(h, {
        actor_kind: "person", actor_user_id: OWNER_ID, actor_role: "owner",
        policy_version: null, contract_binding_id: null, terms_hash: null,
      }),
      "production_gate_clearance_basis_invalid",
    );
    assert.deepEqual(depositGate(h), {
      state: "blocked", version: 1, clearance_basis: null, clearance_decision_id: null,
      cleared_by_user_id: null,
    });

    const portalToken = await seedPortalLink(h.db);
    const response = await accept(h, portalToken, "acceptance-od01-reversal-0001");
    assert.equal(response.status, 200, await response.clone().text());
    const binding = bindingFor(h, (await response.json() as { acceptance_id: string }).acceptance_id);
    const noDeposit = depositEntries(h)[0]!;
    // A person never reverses it.
    refusedWith(
      () => appendDeposit(h, {
        entry_kind: "reverse", basis: "office_waiver", to_state: "blocked",
        reverses_id: noDeposit.clearance_id, actor_kind: "person", actor_user_id: OWNER_ID,
        actor_role: "owner", policy_version: null, contract_binding_id: null, terms_hash: null,
        evidence_refs_json: null, reason: "Synthetic attempt to reverse a contract fact.",
      }),
      "production_gate_contract_no_deposit_not_reversible",
    );
    // Nor on the reversal route (0158): the owner's own session is refused by name.
    const owner = await personAuth(h, OWNER_ID);
    const reversal = await handleAuthenticatedRoute(
      new Request(
        `${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates/Deposit/reversals`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "deposit-reversal-od01-0001",
            "x-csrf-token": owner.csrfToken,
          },
          body: JSON.stringify({
            expected_gate_version: 2,
            reverses_id: noDeposit.clearance_id,
            reason: "The owner tries to put the deposit back on a no-deposit contract.",
          }),
        },
      ),
      h.env,
      owner,
    );
    assert.deepEqual(
      [reversal.status, ((await reversal.json()) as { error: string }).error],
      [409, "production_gate_contract_no_deposit_not_reversible"],
    );
    // The policy reverses it only for a later contract that carries a deposit.
    refusedWith(
      () => appendDeposit(h, {
        entry_kind: "reverse", basis: "contract_superseded", to_state: "blocked",
        reverses_id: noDeposit.clearance_id, contract_binding_id: binding.acceptance_binding_id,
        terms_hash: OD01_TERMS_HASH,
      }),
      "production_gate_contract_superseded_not_observed",
    );
    assert.equal(depositGate(h).state, "complete");
    assert.equal(depositEntries(h).length, 1);
  } finally {
    h.restore();
  }
});

test("a Deposit entry that fails after the commit never fails the acceptance, and the sweep appends it once", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextLedgerAppend = true;
    const response = await accept(h, portalToken, "acceptance-od01-sweep-0001");
    assert.equal(response.status, 200, await response.clone().text());
    const accepted = await response.json() as { status: string; acceptance_id: string };
    assert.equal(accepted.status, "accepted");
    assert.equal(h.db.failNextLedgerAppend, false);
    assert.equal(count(h, "commercial_acceptance_bindings"), 1);
    assert.deepEqual(depositEntries(h), []);
    assert.equal(depositGate(h).state, "blocked");
    // A policy entry must name the policy version it was made under.
    const binding = bindingFor(h, accepted.acceptance_id);
    refusedWith(
      () => appendDeposit(h, {
        policy_version: null,
        contract_binding_id: binding.acceptance_binding_id,
        evidence_refs_json: JSON.stringify({ basis: "contract_no_deposit" }),
      }),
      "production_gate_clearance_basis_invalid",
    );
    // Until the policy records it, the phase names the open fact.
    const before = await jobPhase(h);
    assert.equal(before.phase, "deposit_pending");
    assert.ok((before.stale_reasons as string[]).includes("commercial.no_deposit_record_missing"));

    // The five-minute cron's sweep appends the missing entry, once.
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as never,
      h.env as never,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as never,
    );
    await Promise.all(pending.map((promise) => promise.catch(() => {})));
    const entries = depositEntries(h);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.basis, "contract_no_deposit");
    assert.equal(entries[0]!.contract_binding_id, bindingFor(h, accepted.acceptance_id).acceptance_binding_id);
    assert.equal(depositGate(h).state, "complete");
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });
    assert.equal(depositEntries(h).length, 1);
    assert.equal((await jobPhase(h)).facts.commercial.deposit_requirement, "no_deposit_under_contract");
  } finally {
    h.restore();
  }
});

test("the policy's Deposit entry takes D1's time, not the Worker's, and so do the gate and the audit row", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextLedgerAppend = true;
    const response = await accept(h, portalToken, "acceptance-od01-clock-0001");
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(depositEntries(h), []);
    // The sweep appends the entry while the Worker's clock reads a day behind D1's.
    mock.timers.enable({ apis: ["Date"], now: Date.now() - 24 * 60 * 60_000 });
    let swept: Awaited<ReturnType<typeof sweepContractDepositGates>>;
    try {
      swept = await sweepContractDepositGates(h.env);
    } finally {
      mock.timers.reset();
    }
    assert.deepEqual(swept, { candidates: 1, recorded: 1, refused: 0 });
    const entry = h.db.raw.prepare(
      "SELECT clearance_id, created_at FROM production_gate_clearances WHERE gate = 'Deposit'",
    ).get() as { clearance_id: string; created_at: string };
    assert.match(entry.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(entry.created_at) - Date.now()) < 60_000, entry.created_at);
    assert.deepEqual(
      { ...h.db.raw.prepare(
        `SELECT updated_at, cleared_at FROM operating_production_gates
          WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Deposit'`,
      ).get(TENANT, JOB_ID) as object },
      { updated_at: entry.created_at, cleared_at: entry.created_at },
    );
    assert.equal(
      (h.db.raw.prepare("SELECT ts FROM audit_log WHERE run_id = ?").get(entry.clearance_id) as { ts: string }).ts,
      entry.created_at,
    );
  } finally {
    h.restore();
  }
});


// The OD-01 pre-flight (tools/od01-preflight.sql) decides whether the production train may start,
// so a case below fails for every way it could count too few, and for every way it could count
// too many. Each case checks the count after every fixture, so two errors cannot cancel out in a
// total. The PR lists each mutant of the query and the case that catches it.
const PREFLIGHT = readFileSync(new URL("../../tools/od01-preflight.sql", import.meta.url), "utf8");

function preflight(h: Harness): Array<Record<string, unknown>> {
  return h.db.raw.prepare(PREFLIGHT).all().map((row) => ({ ...row }));
}

function counted(openQuotes: number, openProposals: number, publishedProposals: number) {
  return [{
    tenant_id: TENANT,
    open_quotes: openQuotes,
    open_proposals: openProposals,
    published_proposals: publishedProposals,
  }];
}

/** A second job of the same customer and lead, which a case can cancel. */
function seedSecondJob(h: Harness, roofJobId: string): void {
  const now = new Date(Date.now() - 120_000).toISOString();
  h.db.raw.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, service_type, job_status, current_gate_state, version,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'raw/acceptance/0001.json', 'ironwrap', 'roof_replacement',
             'qualified', 'qualification', 1, ?, ?)`,
  ).run(roofJobId, TENANT, LEAD_ID, CUSTOMER_ID, ENVELOPE_ID, now, now);
}

test("the OD-01 pre-flight counts every contract term OD-01 refuses, and never payment on completion", async () => {
  const h = await setup({ contracts: 0 });
  try {
    assert.deepEqual(preflight(h), []);
    // Payment on completion is never counted.
    await seedNativeContract(h.env, "od01", OD01_TERMS);
    assert.deepEqual(preflight(h), []);
    let refused = 0;
    for (const [suffix, terms] of [
      ["deposit", TERMS],
      ["zero-deposit-schedule", { ...OD01_TERMS, payment_schedule: ["deposit"] }],
      ["zero-mixed-schedule", { ...OD01_TERMS, payment_schedule: ["completion", "deposit"] }],
      ["deposit-on-completion", { ...OD01_TERMS, deposit_percent: 25 }],
      ["deposit-not-a-number", { ...OD01_TERMS, deposit_percent: false }],
      ["no-deposit-term", { payment_schedule: ["completion"], payment_terms_days: 30 }],
    ] as const) {
      await seedNativeContract(h.env, suffix, terms);
      refused += 1;
      assert.deepEqual(preflight(h), counted(refused, refused, refused), suffix);
    }
  } finally {
    h.restore();
  }
});

test("the OD-01 pre-flight counts drafts and quotes under review, and leaves out what no customer can accept", async () => {
  const h = await setup({ contracts: 0 });
  try {
    await seedNativeContract(h.env, "draft", TERMS, { status: "draft" });
    assert.deepEqual(preflight(h), counted(1, 0, 0));
    await seedNativeContract(h.env, "under-review", TERMS, { status: "needs_review" });
    assert.deepEqual(preflight(h), counted(2, 0, 0));
    await seedNativeContract(h.env, "declined", TERMS, { status: "rejected" });
    assert.deepEqual(preflight(h), counted(2, 0, 0));
    // Recorded a month ago and valid for five days.
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await seedNativeContract(h.env, "expired", TERMS, {
      base: monthAgo,
      validUntil: new Date(monthAgo.getTime() + 5 * 24 * 60 * 60_000).toISOString().slice(0, 10),
    });
    assert.deepEqual(preflight(h), counted(2, 0, 0));
    // Published for a job that is then cancelled.
    seedSecondJob(h, "job:acceptance:cancelled");
    await seedNativeContract(h.env, "cancelled-job", TERMS, { roofJobId: "job:acceptance:cancelled" });
    assert.deepEqual(preflight(h), counted(3, 1, 1));
    h.db.raw.prepare(
      `UPDATE operating_roof_jobs SET job_status = 'cancelled', version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND roof_job_id = ?`,
    ).run(new Date().toISOString(), TENANT, "job:acceptance:cancelled");
    assert.deepEqual(preflight(h), counted(2, 0, 0));
    // A quote revised without a new proposal: the revision is open, the proposal left on the
    // superseded quote is not.
    const revised = await seedNativeContract(h.env, "revised-quote", TERMS);
    assert.deepEqual(preflight(h), counted(3, 1, 1));
    await reviseQuote(h, revised, { ...TERMS, deposit_percent: 30 }, new Date(Date.now() - 30_000));
    assert.deepEqual(preflight(h), counted(3, 0, 0));
  } finally {
    h.restore();
  }

  // A contract the customer accepted is no longer open.
  const accepted = await setup();
  try {
    assert.deepEqual(preflight(accepted), counted(1, 1, 1));
    const response = await accept(accepted, await seedPortalLink(accepted.db), "acceptance-preflight-0001");
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(preflight(accepted), []);
  } finally {
    accepted.restore();
  }
});

test("the OD-01 pre-flight counts as published only the proposals a customer can open now", async () => {
  const h = await setup();
  try {
    assert.deepEqual(preflight(h), counted(1, 1, 1));
    // The primary contract corrected: proposal revision 2 published at version 3, after a withdrawal.
    await publishCorrectedContract(h, { ...TERMS, deposit_percent: 30 });
    assert.deepEqual(preflight(h), counted(1, 1, 1));
    // Published, then withdrawn.
    const withdrawn = await seedNativeContract(h.env, "withdrawn", TERMS);
    assert.deepEqual(preflight(h), counted(2, 2, 2));
    await recordPublicationTransition(h.env, withdrawn, "withdrawn", new Date(Date.now() - 10_000));
    assert.deepEqual(preflight(h), counted(2, 2, 1));
    // A new proposal revision of the same quote, not published yet: the pack still shows revision 1.
    const unpublished = await seedNativeContract(h.env, "unpublished-revision", TERMS);
    assert.deepEqual(preflight(h), counted(3, 3, 2));
    await reviseProposal(h, unpublished, unpublished.quoteRevisionId, TERMS, new Date(Date.now() - 20_000));
    assert.deepEqual(preflight(h), counted(3, 3, 1));
  } finally {
    h.restore();
  }
});

test("on a database built from every migration, an OD-01 contract's final invoice bills the whole contract", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const response = await accept(h, portalToken, "acceptance-od01-final-invoice-0001");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(depositGate(h).state, "complete");
    const triggers = () => h.db.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all().map((row) => ({ ...row }));
    const before = triggers();
    recordCompletedRoofJobWork(h.db.raw, { tenantId: TENANT, roofJobId: JOB_ID, assignedByUserId: OWNER_ID });
    assert.deepEqual(triggers(), before);

    // The owner's QuickBooks mapping, anchored to the contract in force, and the GST snapshot.
    const contract = await readAcceptedCommercialPaymentTerms(h.env, {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      customerId: CUSTOMER_ID,
    });
    assert.ok(contract.ok, JSON.stringify(contract));
    if (!contract.ok) return;
    const now = new Date();
    await recordTaxPolicySnapshot(
      h.env,
      {
        tenantId: TENANT,
        jurisdiction: "CA-AB",
        taxCode: "GST",
        providerTaxCodeId: "10",
        ratePercent: "5.0000",
        effectiveFrom: "2026-01-01",
        sourceRef: "CRA GST policy snapshot 2026-01-01",
      },
      now,
    );
    await recordNativeFinalInvoiceProviderBinding(
      h.env,
      {
        tenantId: TENANT,
        realmId: "4620816365000000000",
        roofJobId: JOB_ID,
        qboCustomerId: "7",
        qboItemId: "8",
        qboTaxCodeId: "10",
        qboTermsId: "9",
        jurisdiction: "CA-AB",
        taxCode: "GST",
        paymentTermsDays: contract.paymentTermsDays,
        sourceRef: "owner-approved-provider-map:od01-real-schema",
        sourceSha256: "6".repeat(64),
        commercialTermsHash: contract.termsHash,
        commercialHeadSha256: contract.commercialHeadSha256,
      },
      now,
    );

    const derived = await deriveNativeFinalInvoiceForJob(h.env, { tenantId: TENANT, roofJobId: JOB_ID }, now);
    assert.equal(derived.outcome, "intent_derived", JSON.stringify(derived));
    if (derived.outcome !== "intent_derived") return;
    const intent = h.db.raw.prepare("SELECT * FROM accounting_intents WHERE intent_id = ?")
      .get(derived.accounting_intent_id) as Record<string, string>;
    const quote = h.db.raw.prepare(
      "SELECT subtotal_cents, tax_cents, total_cents FROM commercial_quote_revisions WHERE quote_revision_id = ?",
    ).get(h.chain!.quoteRevisionId) as { subtotal_cents: number; tax_cents: number; total_cents: number };
    const dollars = (cents: number) => (cents / 100).toFixed(2);
    // The whole contract, tax included: 1000.00 + 50.00 GST = 1050.00.
    assert.deepEqual(
      {
        kind: intent.kind,
        final: intent.final_invoice_intent_id === intent.intent_id,
        subtotal: intent.subtotal,
        tax: intent.tax_amount,
        total: intent.total_amount,
      },
      {
        kind: "progress_invoice",
        final: true,
        subtotal: dollars(quote.subtotal_cents),
        tax: dollars(quote.tax_cents),
        total: dollars(quote.total_cents),
      },
    );
    assert.equal(intent.total_amount, "1050.00");
    const basis = JSON.parse(intent.basis_json) as Record<string, any>;
    assert.equal(basis.commercial.already_invoiced, "0.00");
    assert.deepEqual(basis.prior_invoices, []);
    assert.deepEqual(
      (basis.commercial.lines as Array<{ description_code: string; amount: string }>)
        .map((line) => [line.description_code, line.amount]),
      [["RESIDENTIAL_ACCEPTED_QUOTE", "1000.00"]],
    );
    assert.equal(basis.commercial_head.acceptance.id, bindingFor(h, (await response.json() as { acceptance_id: string }).acceptance_id).acceptance_binding_id);
    // No deposit invoice and no derivation exist, and the completion packet is recorded once.
    assert.deepEqual(
      (h.db.raw.prepare("SELECT kind FROM accounting_intents").all() as Array<{ kind: string }>).map((row) => row.kind),
      ["progress_invoice"],
    );
    assert.equal(count(h, "commercial_deposit_derivations"), 0);
    assert.equal(count(h, "native_completion_packets"), 1);
  } finally {
    h.restore();
  }
});

// --- A4 (0159): a schedule never rests on a superseded contract with no deposit ---------------------

/**
 * The owner attests Materials, Safety, Access and Weather (0158) and one synthetic field worker
 * forms a crew; Deposit stands on the contract. Returns a scheduler that writes the next schedule
 * revision, which binds Crew by policy (0159). With `waiveMaterials` the owner waives Materials
 * instead, which a waiver may do inside the OD-01 cancellation window (0160) without ending it.
 */
function readyToSchedule(
  h: Harness,
  options: { waiveMaterials?: boolean } = {},
): (key: string) => Promise<unknown> {
  if (options.waiveMaterials) {
    waiveGateInLedger(h.db.raw, { tenantId: TENANT, roofJobId: JOB_ID, gate: "Materials", ownerUserId: OWNER_ID });
  }
  for (const gate of ["Materials", "Safety", "Access", "Weather"] as const) {
    if (gate === "Materials" && options.waiveMaterials) continue;
    attestGateInLedger(h.db.raw, { tenantId: TENANT, roofJobId: JOB_ID, gate, actorUserId: OWNER_ID, actorRole: "owner" });
  }
  const at = new Date().toISOString();
  h.db.raw.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES ('appu_field_acceptance', ?, 'field-acceptance@example.invalid', 'Field', 'field',
             'field', 'field-acceptance@example.invalid', 1, 'test-seed', ?, ?)`,
  ).run(TENANT, at, at);
  h.db.raw.prepare(
    `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES ('crew:acceptance:0001', ?, 'Synthetic Crew', 'Active', 1, ?, ?)`,
  ).run(TENANT, at, at);
  h.db.raw.prepare(
    `INSERT INTO fleet_crew_members
       (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
     VALUES ('membership:acceptance:0001', ?, 'crew:acceptance:0001', 'appu_field_acceptance', 1, 1, ?, ?)`,
  ).run(TENANT, at, at);
  let previous: string | null = null;
  return async (key: string) => {
    const job = h.db.raw.prepare(
      "SELECT version FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?",
    ).get(TENANT, JOB_ID) as { version: number };
    const day = fixtureSchedule(1);
    const result = await recordOperatingJobAssignment(h.env, {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      expectedRoofJobVersion: Number(job.version),
      crewId: "crew:acceptance:0001",
      expectedCrewVersion: 1,
      authorityRequirements: [{
        authority_record_id: "authority:acceptance:worker",
        subject_type: "Person",
        subject_role: "Worker",
        subject_ref: "appu_field_acceptance",
        authority_kind: "Worker Competency",
        scope_type: "Roof Job",
        scope_ref: JOB_ID,
        version: 1,
        state_digest_sha256: "c".repeat(64),
      }],
      scheduledStart: day.start,
      scheduledEnd: day.end,
      supersedesAssignmentId: previous,
      correctionReason: previous ? "Synthetic schedule revision after a new contract." : null,
      actorUserId: OWNER_ID,
      idempotencyKey: key,
    });
    previous = result.assignment.assignment_id;
    return result;
  };
}

/**
 * Run `act` with the Worker's clock `days` days behind D1's, so a contract signed in it was signed
 * that long ago. Its OD-01 cancellation window (0160) can then have ended, by D1's clock, by the
 * time the job is scheduled: a person records that the customer received the signed copy eleven
 * days ago (`attestGateInLedger` on Materials does it for the fixture).
 */
async function inThePast<T>(days: number, act: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: Date.now() - days * 24 * 60 * 60_000 });
  try {
    return await act();
  } finally {
    mock.timers.reset();
  }
}

async function refusedSchedule(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    const message = error instanceof OperatingJobAssignmentError ? error.code : String((error as Error).message);
    assert.match(message, new RegExp(code));
    return true;
  });
}

test("no schedule rests on a contract with no deposit once a later contract with a deposit is signed, before or after the policy re-blocks Deposit", async () => {
  // The contracts were signed weeks ago, so their cancellation windows have ended (0160).
  const h = await inThePast(40, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(40, () => seedPortalLink(h.db));
    const first = await inThePast(40, () => accept(h, portalToken, "acceptance-od01-schedule-0001"));
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(depositEntries(h)[0]!.basis, "contract_no_deposit");
    const schedule = readyToSchedule(h);
    await schedule("schedule-acceptance-0001");

    // MD-13's input arrives and the customer signs a contract with a deposit. The policy's
    // reversal does not land after that commit, so Deposit still stands on the first contract.
    recordDepositPolicy(h.db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: "md13_deposit" });
    await inThePast(20, () => publishCorrectedContract(h, TERMS));
    h.db.failNextLedgerAppend = true;
    const second = await inThePast(20, () => accept(h, portalToken, "acceptance-md13-schedule-0001"));
    assert.equal(second.status, 200, await second.clone().text());
    assert.deepEqual({ state: depositGate(h).state, entries: depositEntries(h).length }, { state: "complete", entries: 1 });
    await refusedSchedule(schedule("schedule-acceptance-0002"), "operating_job_assignment_deposit_contract_superseded");
    // D1 holds the same line for a writer that skipped the Worker.
    const current = h.db.raw.prepare(
      `SELECT * FROM operating_job_assignments
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY assignment_version DESC LIMIT 1`,
    ).get(TENANT, JOB_ID) as Record<string, unknown>;
    refusedWith(
      () => h.db.raw.prepare(
        `INSERT INTO operating_job_assignments
           (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
            crew_version, assigned_users_json, scheduled_start, scheduled_end,
            supersedes_assignment_id, correction_reason, actor_user_id, command_fingerprint,
            idempotency_key_hash, created_at)
         VALUES ('assignment:acceptance:direct', ?, ?, 2, ?, ?, 1, ?, ?, ?, ?,
                 'Synthetic direct revision after a new contract.', ?, ?, ?, ?)`,
      ).run(
        TENANT, JOB_ID, current.roof_job_version as number, current.crew_id as string,
        current.assigned_users_json as string, current.scheduled_start as string,
        current.scheduled_end as string, current.assignment_id as string, OWNER_ID,
        "e".repeat(64), "f".repeat(64), new Date().toISOString(),
      ),
      "operating_job_assignment_deposit_contract_superseded",
    );

    // Once the sweep lands the policy's reversal, Deposit is blocked and 0098 answers.
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 1, recorded: 1, refused: 0 });
    assert.equal(depositGate(h).state, "blocked");
    await refusedSchedule(schedule("schedule-acceptance-0003"), "operating_job_assignment_gates_blocked");
  } finally {
    h.restore();
  }
});

test("a later contract that again has no deposit leaves Deposit standing, and the job schedules", async () => {
  // The contracts were signed weeks ago, so their cancellation windows have ended (0160).
  const h = await inThePast(40, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(40, () => seedPortalLink(h.db));
    const first = await inThePast(40, () => accept(h, portalToken, "acceptance-od01-again-0001"));
    assert.equal(first.status, 200, await first.clone().text());
    const schedule = readyToSchedule(h);
    await schedule("schedule-acceptance-again-0001");
    // A corrected contract with no deposit either: the policy never re-binds one contract with no
    // deposit to another, so refusing here would leave the job with no way to schedule.
    await inThePast(20, () => publishCorrectedContract(h, OD01_TERMS));
    const second = await inThePast(20, () => accept(h, portalToken, "acceptance-od01-again-0002"));
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal(depositEntries(h).length, 1);
    assert.equal(depositGate(h).state, "complete");
    await schedule("schedule-acceptance-again-0002");
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM operating_job_assignments WHERE roof_job_id = ?").get(JOB_ID) as { n: number }).n,
      2,
    );
  } finally {
    h.restore();
  }
});

test("only the job's latest contract counts: a deposit contract superseded in turn by one with no deposit leaves the job schedulable", async () => {
  // The contracts were signed weeks ago, so their cancellation windows have ended (0160).
  const h = await inThePast(40, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(40, () => seedPortalLink(h.db));
    const first = await inThePast(40, () => accept(h, portalToken, "acceptance-od01-latest-0001"));
    assert.equal(first.status, 200, await first.clone().text());
    const schedule = readyToSchedule(h);
    await schedule("schedule-acceptance-latest-0001");

    // A deposit contract under MD-13 whose policy reversal never lands...
    recordDepositPolicy(h.db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: "md13_deposit" });
    await inThePast(30, () => publishCorrectedContract(h, TERMS));
    h.db.failNextLedgerAppend = true;
    const second = await inThePast(30, () => accept(h, portalToken, "acceptance-md13-latest-0001"));
    assert.equal(second.status, 200, await second.clone().text());
    await refusedSchedule(schedule("schedule-acceptance-latest-0002"), "operating_job_assignment_deposit_contract_superseded");

    // ...then a contract with no deposit again, under OD-01. The policy acts only on the latest
    // contract, so nothing will ever reverse the first contract's entry: refusing here would hold
    // the job forever.
    recordDepositPolicy(h.db.raw, { tenantId: TENANT, ownerUserId: OWNER_ID, policy: "od01_payment_on_completion" });
    await inThePast(20, () => publishCorrectedContract(h, OD01_TERMS, 3));
    const third = await inThePast(20, () => accept(h, portalToken, "acceptance-od01-latest-0002"));
    assert.equal(third.status, 200, await third.clone().text());
    assert.deepEqual(await sweepContractDepositGates(h.env), { candidates: 0, recorded: 0, refused: 0 });
    assert.deepEqual({ state: depositGate(h).state, entries: depositEntries(h).length }, { state: "complete", entries: 1 });
    await schedule("schedule-acceptance-latest-0003");
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM operating_job_assignments WHERE roof_job_id = ?").get(JOB_ID) as { n: number }).n,
      2,
    );
  } finally {
    h.restore();
  }
});

// --- A5 (0160): the copy shown at signing starts the OD-01 cancellation window ----------------------
//
// By the owner's ruling a signed copy the portal shows at signing counts as received. A client
// that shows the copy (terms plus receipt) on its confirm screen sends `signed_copy: true`; only
// then does the answer carry the copy. The copy is recorded as shown only after the acceptance has
// committed and the copy has been built, in its own D1 statement, and only then is it served: a
// copy that is not served starts no window. Today's confirm page never sends the flag.

const ZONE = "America/Edmonton";
const MINUTE_MS = 60_000;

function confirmShowingCopyRequest(token: string, idempotencyKey: string, signedCopy: unknown = true): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/v1/customer-portal/acceptance/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PUBLIC_ORIGIN,
      "cf-connecting-ip": "203.0.113.9",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ token, signer_name: "Ada Customer", accepted: true, signed_copy: signedCopy }),
  });
}

/** A challenge for the current contract, then the customer's confirmation on a screen that shows the copy. */
async function acceptShowingCopy(h: Harness, portalToken: string, idempotencyKey: string): Promise<Response> {
  const challenge = await issueChallenge(h.env, portalToken);
  assert.equal(challenge.status, 200, await challenge.clone().text());
  return await worker.fetch(
    confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), idempotencyKey),
    h.env as never,
    {} as never,
  );
}

function shownEvents(h: Harness): Array<Record<string, string>> {
  return h.db.raw.prepare("SELECT * FROM contract_signed_copy_events ORDER BY shown_at")
    .all().map((row) => ({ ...row }) as Record<string, string>);
}

function servedCopies(h: Harness): Array<Record<string, string>> {
  return h.db.raw.prepare("SELECT * FROM contract_signed_copy_served ORDER BY served_at")
    .all().map((row) => ({ ...row }) as Record<string, string>);
}

/** An instant's local date in the business zone, as "YYYY-MM-DD". */
function localDate(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant));
}

/** The owner and ops work queue, as an owner reads it. */
async function signedCopyQueue(h: Harness): Promise<Record<string, any>> {
  const response = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/production/cancellation-window/signed-copy-missing`),
    h.env,
    await personAuth(h, OWNER_ID),
  );
  assert.equal(response.status, 200);
  return await response.json() as Record<string, any>;
}

async function recordReceivedCopy(
  h: Harness,
  person: AuthContext,
  receivedAt: string,
  idempotencyKey: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(
      `${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/cancellation-window/signed-copy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-csrf-token": person.csrfToken,
        },
        body: JSON.stringify({
          received_at: receivedAt,
          reason: "The signed copy was emailed; the delivery receipt shows it arrived.",
          evidence_ref: "Delivered email · signed copy.pdf",
        }),
      },
    ),
    h.env,
    person,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/**
 * A purchase order line for this job, placed straight in D1 as any writer places one. With
 * `beforeTheHold`, it is written as if before 0160's hold existed.
 */
function placeJobOrderLine(
  h: Harness,
  lineId = "po_line_acceptance_1",
  status = "ordered",
  beforeTheHold = false,
): void {
  const now = new Date().toISOString();
  h.db.raw.prepare(
    `INSERT OR IGNORE INTO inventory_uoms (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at)
     VALUES ('uom_acceptance_each', ?, 'EA', 'count', 0, 'active', ?, ?)`,
  ).run(TENANT, now, now);
  h.db.raw.prepare(
    `INSERT OR IGNORE INTO inventory_items
       (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale,
        lot_controlled, valuation_method, source_ref, created_at, updated_at)
     VALUES ('item_acceptance_panel', ?, 'PANEL-24', 'active', 'raw_material', 'uom_acceptance_each',
             0, 0, 'fifo', 'seed', ?, ?)`,
  ).run(TENANT, now, now);
  const hold = h.db.raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'inventory_po_lines_cancellation_window_hold'",
  ).get() as { sql: string };
  if (beforeTheHold) h.db.raw.exec("DROP TRIGGER inventory_po_lines_cancellation_window_hold");
  try {
    h.db.raw.prepare(
      `INSERT INTO inventory_po_lines
         (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id, ordered_quantity_scaled,
          unit_price_minor, line_identity_sha256, status, created_at, updated_at, roof_job_id)
       VALUES (?, ?, ?, 1, 'item_acceptance_panel', 'uom_acceptance_each', 10, 500, ?, ?, ?, ?, ?)`,
    ).run(
      lineId, TENANT, `SO-${lineId}`, createHash("sha256").update(lineId).digest("hex"), status, now, now, JOB_ID,
    );
  } finally {
    if (beforeTheHold) h.db.raw.exec(hold.sql);
  }
}

/** A Materials `clear` written straight at D1 on the gate's current version, as a defective writer would. */
function clearMaterialsInD1(h: Harness): void {
  const gate = h.db.raw.prepare(
    "SELECT gate_id, version FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Materials'",
  ).get(TENANT, JOB_ID) as { gate_id: string; version: number };
  ledgerCounter += 1;
  h.db.raw.prepare(
    `INSERT INTO production_gate_clearances
       (clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
        from_gate_version, actor_kind, actor_user_id, actor_role, attestation_json,
        evidence_refs_json, request_sha256, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, ?, 'Materials', 'clear', 'person_attestation', 'ready', ?, 'person', ?, 'owner',
             '{"reference":"DELIVERY-ACCEPTANCE-0001","source":"supplier_delivery"}', '[]', ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(
    `pgc_${ledgerCounter.toString(16).padStart(40, "b")}`, TENANT, gate.gate_id, JOB_ID, gate.version, OWNER_ID,
    createHash("sha256").update(`materials:${ledgerCounter}`).digest("hex"),
    createHash("sha256").update(`materials-key:${ledgerCounter}`).digest("hex"),
  );
}

/** A backordered purchase order line of this job, written before the window's hold existed. */
function backorderedJobLine(h: Harness): void {
  placeJobOrderLine(h, "po_line_acceptance_backordered", "backordered", true);
}

/** The schedule route, as an owner posts it for the crew `readyToSchedule` forms. */
async function scheduleJobOnRoute(h: Harness, owner: AuthContext, key: string): Promise<{ status: number; body: Record<string, any> }> {
  const day = fixtureSchedule(1, Date.now());
  const job = h.db.raw.prepare("SELECT version FROM operating_roof_jobs WHERE roof_job_id = ?").get(JOB_ID) as { version: number };
  const response = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(JOB_ID)}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": owner.csrfToken },
      body: JSON.stringify({
        expected_roof_job_version: Number(job.version),
        crew_id: "crew:acceptance:0001",
        expected_crew_version: 1,
        authority_requirements: [{
          authority_record_id: "authority:acceptance:worker",
          subject_type: "Person",
          subject_role: "Worker",
          subject_ref: "appu_field_acceptance",
          authority_kind: "Worker Competency",
          scope_type: "Roof Job",
          scope_ref: JOB_ID,
          version: 1,
          state_digest_sha256: "c".repeat(64),
        }],
        scheduled_start: day.start,
        scheduled_end: day.end,
        supersedes_assignment_id: null,
        correction_reason: null,
      }),
    }),
    h.env,
    owner,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** The Materials attestation route, as an owner posts it on the gate's current version. */
async function attestMaterialsOnRoute(h: Harness, owner: AuthContext, key: string): Promise<{ status: number; body: Record<string, any> }> {
  const gate = h.db.raw.prepare(
    "SELECT version FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Materials'",
  ).get(TENANT, JOB_ID) as { version: number };
  const response = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates/Materials/clearance`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": owner.csrfToken },
      body: JSON.stringify({
        basis: "person_attestation",
        expected_gate_version: Number(gate.version),
        attestation: { source: "supplier_delivery", reference: "DELIVERY-ACCEPTANCE-0003" },
      }),
    }),
    h.env,
    owner,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** An assignment written straight at D1 after the Crew entry that names it, as a defective writer would. */
function insertAssignmentInD1(h: Harness): void {
  const assignmentId = "assignment:acceptance:held";
  const crew = h.db.raw.prepare(
    "SELECT state FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Crew'",
  ).get(TENANT, JOB_ID) as { state: string };
  if (crew.state === "blocked") {
    bindCrewInLedger(h.db.raw, {
      tenantId: TENANT, roofJobId: JOB_ID, crewId: "crew:acceptance:0001", assignmentId, keepCancellationWindow: true,
    });
  }
  const day = fixtureSchedule(1, d1Now(h.db.raw));
  const job = h.db.raw.prepare("SELECT version FROM operating_roof_jobs WHERE roof_job_id = ?").get(JOB_ID) as { version: number };
  h.db.raw.prepare(
    `INSERT INTO operating_job_assignments
       (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
        crew_version, assigned_users_json, scheduled_start, scheduled_end, supersedes_assignment_id,
        correction_reason, actor_user_id, command_fingerprint, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, 1, ?, 'crew:acceptance:0001', 1, '["appu_field_acceptance"]', ?, ?, NULL, NULL,
             ?, ?, ?, ?)`,
  ).run(assignmentId, TENANT, JOB_ID, Number(job.version), day.start, day.end, OWNER_ID,
    "e".repeat(64), "f".repeat(64), new Date().toISOString());
}

let heldProbe = 0;

/**
 * Every hold of the job's cancellation window stands, by its code (`unknown` or `open`): the firm
 * start on the store, the route and in D1; the Materials attestation on the route and in D1; a
 * supplier order (a job's purchase order line) and a backordered line moving back to ordered in D1.
 * Nothing is written.
 */
async function assertEveryHoldStands(
  h: Harness,
  schedule: (key: string) => Promise<unknown>,
  state: "unknown" | "open",
): Promise<void> {
  heldProbe += 1;
  // The Crew entry a direct writer appends before its assignment is not a hold's write.
  const written = () => [
    count(h, "operating_job_assignments"),
    (h.db.raw.prepare("SELECT COUNT(*) AS n FROM production_gate_clearances WHERE gate = 'Materials' AND entry_kind = 'clear'")
      .get() as { n: number }).n,
    count(h, "inventory_po_lines"),
    (h.db.raw.prepare("SELECT COUNT(*) AS n FROM inventory_po_lines WHERE status = 'ordered'").get() as { n: number }).n,
  ];
  const before = written();
  const owner = await personAuth(h, OWNER_ID);
  await refusedSchedule(schedule(`schedule-a5-held-${state}-${heldProbe}`), `operating_job_assignment_cancellation_window_${state}`);
  const routed = await scheduleJobOnRoute(h, owner, `schedule-a5-route-held-${state}-${heldProbe}`);
  assert.deepEqual([routed.status, routed.body.error], [409, `operating_job_assignment_cancellation_window_${state}`]);
  refusedWith(() => insertAssignmentInD1(h), `operating_job_assignment_cancellation_window_${state}`);
  const materials = await attestMaterialsOnRoute(h, owner, `materials-a5-held-${state}-${heldProbe}`);
  assert.deepEqual([materials.status, materials.body.error], [409, `production_gate_cancellation_window_${state}`]);
  refusedWith(() => clearMaterialsInD1(h), `production_gate_cancellation_window_${state}`);
  refusedWith(() => placeJobOrderLine(h), `inventory_po_line_cancellation_window_${state}`);
  refusedWith(
    () => h.db.raw.prepare(
      "UPDATE inventory_po_lines SET status = 'ordered', version = version + 1 WHERE po_line_id = 'po_line_acceptance_backordered'",
    ).run(),
    `inventory_po_line_cancellation_window_${state}`,
  );
  assert.deepEqual(written(), before);
}

test("without signed_copy the confirm answer is unchanged and no copy is recorded as shown: the window is unknown", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // A value other than true is not a request for the copy: the body is refused unread.
    const challenge = await issueChallenge(h.env, portalToken);
    assert.equal(challenge.status, 200);
    const malformed = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-plain-0002", false),
      h.env as never,
      {} as never,
    );
    assert.equal(malformed.status, 404);
    assert.equal(count(h, "customer_portal_acceptance_intents"), 0);

    const response = await accept(h, portalToken, "acceptance-a5-plain-0001");
    assert.equal(response.status, 200);
    const text = await response.text();
    const acceptanceId = (JSON.parse(text) as { acceptance_id: string }).acceptance_id;
    // Byte for byte the answer this route always gave: its stored canonical JSON.
    assert.equal(text, JSON.stringify({ acceptance_id: acceptanceId, status: "accepted" }));
    assert.deepEqual(shownEvents(h), []);
    const binding = bindingFor(h, acceptanceId);
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.equal(window.state, "unknown");
    assert.equal(window.unknown_reason, "signed_copy_time_missing");
    assert.deepEqual(window.contract, {
      acceptance_binding_id: binding.acceptance_binding_id,
      signed_at: binding.accepted_at,
    });
  } finally {
    h.restore();
  }
});

test("with signed_copy the answer carries the signed copy, recorded as shown once it is built, and the window opens", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const response = await acceptShowingCopy(h, portalToken, "acceptance-a5-copy-0001");
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, any>;
    const binding = bindingFor(h, body.acceptance_id);
    const [event, ...more] = shownEvents(h);
    assert.ok(event);
    assert.deepEqual(more, []);
    // Confirmed served once, with D1's clock, at or just after the event: then sent.
    const [served, ...moreServed] = servedCopies(h);
    assert.ok(served);
    assert.deepEqual(moreServed, []);
    assert.deepEqual(
      { ...served, served_at: undefined },
      {
        event_id: event.event_id,
        tenant_id: TENANT,
        acceptance_binding_id: binding.acceptance_binding_id,
        roof_job_id: JOB_ID,
        served_at: undefined,
      },
    );
    assert.ok(served.served_at >= event.shown_at && Date.parse(served.served_at) - Date.parse(event.shown_at) < MINUTE_MS);
    const proposal = h.db.raw.prepare(
      "SELECT title FROM commercial_proposal_revisions WHERE proposal_revision_id = ?",
    ).get(binding.proposal_revision_id) as { title: string };
    const quote = h.db.raw.prepare(
      "SELECT revision_number, total_cents, currency FROM commercial_quote_revisions WHERE quote_revision_id = ?",
    ).get(binding.quote_revision_id) as { revision_number: number; total_cents: number; currency: string };
    assert.deepEqual(body, {
      status: "accepted",
      acceptance_id: body.acceptance_id,
      signed_copy: {
        acceptance_id: body.acceptance_id,
        quote_version: Number(quote.revision_number),
        proposal_title: proposal.title,
        total_cents: Number(quote.total_cents),
        currency: quote.currency,
        terms: OD01_TERMS,
        terms_hash: binding.terms_hash,
        signer_name: "Ada Customer",
        accepted_at: binding.accepted_at,
        receipt_sha256: binding.receipt_hash,
        // The deadline's start and end, read in the business time zone: "Signed copy received
        // {window_starts_at}. You can cancel until the end of {the day before window_ends_at}".
        window_starts_at: event.shown_at,
        shown_at: event.shown_at,
        served_at: served.served_at,
        // The deadline shown: the 10th local day after the day the copy was received.
        last_day: calendarReading(event.shown_at, ZONE).lastDay,
        // The hold that keeps it: the end of that day read across the zone's offsets.
        window_ends_at: event.window_ends_at,
        ends_on_calendar_day: true,
        time_zone: ZONE,
      },
    });
    assert.equal(event.window_ends_at, calendarReading(event.shown_at, ZONE).endsAt);
    // The copy is the contract the binding holds: the same terms hash.
    assert.equal(body.signed_copy.terms_hash, binding.terms_hash);
    assert.equal(body.signed_copy.terms_hash, OD01_TERMS_HASH);
    // D1's own time, after the contract was bound, linked to the binding, and the window's end:
    // the end of the 10th business day after the day the copy was shown (interim, pending counsel).
    assert.ok(Math.abs(Date.parse(event.shown_at) - d1Now(h.db.raw)) < MINUTE_MS, event.shown_at);
    assert.ok(event.shown_at >= binding.bound_at, `${event.shown_at} ${binding.bound_at}`);
    assert.deepEqual(
      { ...event, event_id: undefined },
      {
        event_id: undefined,
        tenant_id: TENANT,
        acceptance_binding_id: binding.acceptance_binding_id,
        roof_job_id: JOB_ID,
        contract_signed_at: binding.accepted_at,
        shown_at: event.shown_at,
        window_ends_at: cancellationWindowEndsAt(event.shown_at, ZONE),
        time_zone: ZONE,
      },
    );
    assert.deepEqual(
      h.db.raw.prepare("SELECT ts, automation, trigger, action, approved_by FROM audit_log WHERE run_id IN (?, ?) ORDER BY id")
        .all(event.event_id, `${event.event_id}:served`).map((row) => ({ ...row })),
      [{
        ts: event.shown_at,
        automation: "production_cancellation_window",
        trigger: "customer_portal",
        action: "shown:signed_copy",
        approved_by: null,
      }, {
        ts: served.served_at,
        automation: "production_cancellation_window",
        trigger: "customer_portal",
        action: "served:signed_copy",
        approved_by: null,
      }],
    );
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.equal(window.state, "open");
    assert.equal(window.started_from, "signed_copy_shown");
    assert.equal(window.starts_at, event.shown_at);
    assert.equal(window.ends_at, event.window_ends_at);
    assert.equal(window.signed_copy_shown?.id, event.event_id);
    assert.equal(window.signed_copy_shown?.served_at, served.served_at);
    // The office's gates read states the same start, and the zone to read it in.
    const gates = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates`),
      h.env,
      await personAuth(h, OWNER_ID),
    );
    assert.equal(gates.status, 200);
    const office = (await gates.json() as Record<string, any>).cancellation_window;
    assert.deepEqual(
      [office.started_from, office.starts_at, office.last_day, office.ends_at, office.ends_on_calendar_day, office.time_zone],
      [
        "signed_copy_shown", body.signed_copy.window_starts_at, body.signed_copy.last_day,
        body.signed_copy.window_ends_at, true, body.signed_copy.time_zone,
      ],
    );
    assert.deepEqual(await signedCopyQueue(h), {
      count: 0, counts: { window_unknown: 0, signed_copy_unconfirmed: 0 }, complete: true, jobs: [],
    });
    // The window it starts holds ordering in D1 at once.
    assert.throws(() => placeJobOrderLine(h), /inventory_po_line_cancellation_window_open/);

    // An exact replay answers with the same copy, and records nothing more.
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-copy-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), body);
    assert.deepEqual(shownEvents(h), [event]);
    assert.deepEqual(servedCopies(h), [served]);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).ends_at, event.window_ends_at);
    // The same key without the request for the copy is another request: a fingerprint conflict.
    const mismatch = await worker.fetch(
      confirmRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-copy-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: "acceptance_idempotency_conflict" });
    assert.deepEqual(shownEvents(h), [event]);
  } finally {
    h.restore();
  }
});

test("a rejected attempt with signed_copy records no copy as shown", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
    const challenge = h.db.raw
      .prepare("SELECT created_at FROM customer_portal_acceptance_challenges")
      .get() as { created_at: string };
    await recordPublicationTransition(h.env, h.chain!, "withdrawn", new Date(Date.parse(challenge.created_at) + 1));
    const rejected = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-rejected-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: "acceptance_rejected" });
    assert.equal(count(h, "commercial_acceptance_bindings"), 0);
    assert.deepEqual(shownEvents(h), []);
  } finally {
    h.restore();
  }
});

test("a signed copy that cannot be built is never recorded as shown: no window starts, every hold stands, and the exact replay starts it then", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextSignedCopyBuild = true;
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-unbuilt-0001");
    assert.equal(first.status, 200);
    assert.equal(h.db.failNextSignedCopyBuild, false, "the copy was being built when D1 failed");
    const text = await first.text();
    const acceptanceId = (JSON.parse(text) as { acceptance_id: string }).acceptance_id;
    // The contract is signed, but the answer is the plain accepted one: no copy, no window claimed.
    assert.equal(text, JSON.stringify({ acceptance_id: acceptanceId, status: "accepted" }));
    assert.equal(count(h, "commercial_acceptance_bindings"), 1);
    assert.deepEqual(shownEvents(h), []);
    // No window started: it is unknown, and every hold stands, on the Worker and in D1.
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual(
      [window.state, window.unknown_reason, window.starts_at, window.ends_at, window.holds.length],
      ["unknown", "signed_copy_time_missing", null, null, 3],
    );
    assert.deepEqual(await cancellationWindowHold(h.env, TENANT, JOB_ID), {
      state: "unknown",
      detail: { unknown_reason: "signed_copy_time_missing" },
    });
    const schedule = readyToSchedule(h, { waiveMaterials: true });
    backorderedJobLine(h);
    await assertEveryHoldStands(h, schedule, "unknown");
    // The work queue lists the job, so ops can record the receipt through the people-only route.
    const owner = await personAuth(h, OWNER_ID);
    const missing = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/production/cancellation-window/signed-copy-missing`),
      h.env,
      owner,
    );
    assert.equal((await missing.json() as { count: number }).count, 1);

    // The exact replay builds the copy now, records it as shown with D1's time now, and serves it:
    // the window starts at the replay, never back-dated to the first attempt.
    const afterFirst = new Date(d1Now(h.db.raw)).toISOString();
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-unbuilt-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    const body = await replay.json() as Record<string, any>;
    const [event, ...more] = shownEvents(h);
    assert.ok(event);
    assert.deepEqual(more, []);
    assert.ok(event.shown_at >= afterFirst, `${event.shown_at} is before ${afterFirst}`);
    assert.equal(body.acceptance_id, acceptanceId);
    assert.equal(body.signed_copy.shown_at, event.shown_at);
    assert.equal(body.signed_copy.window_ends_at, event.window_ends_at);
    assert.equal(event.window_ends_at, cancellationWindowEndsAt(event.shown_at, ZONE));
    const opened = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual(
      [opened.state, opened.started_from, opened.starts_at, opened.ends_at],
      ["open", "signed_copy_shown", event.shown_at, event.window_ends_at],
    );
    await assertEveryHoldStands(h, schedule, "open");
    // Replayed again: the same copy, and nothing more is written.
    const again = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-unbuilt-0001"),
      h.env as never,
      {} as never,
    );
    assert.deepEqual(await again.json(), body);
    assert.deepEqual(shownEvents(h), [event]);
  } finally {
    h.restore();
  }
});

test("a copy whose event D1 never writes claims no window: it stays unknown, and the replay starts it then", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // Every attempt fails before D1 writes the event.
    h.db.failSignedCopyEvents = 3;
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-unwritten-0001");
    assert.equal(first.status, 200);
    assert.equal(h.db.failSignedCopyEvents, 0, "the Worker tried three times");
    const text = await first.text();
    const acceptanceId = (JSON.parse(text) as { acceptance_id: string }).acceptance_id;
    assert.equal(text, JSON.stringify({ acceptance_id: acceptanceId, status: "accepted" }));
    assert.deepEqual(shownEvents(h), []);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).state, "unknown");
    assert.throws(() => placeJobOrderLine(h), /inventory_po_line_cancellation_window_unknown/);
    assert.deepEqual((await signedCopyQueue(h)).counts, { window_unknown: 1, signed_copy_unconfirmed: 0 });

    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-unwritten-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    const body = await replay.json() as Record<string, any>;
    const [event, ...more] = shownEvents(h);
    assert.ok(event);
    assert.deepEqual(more, []);
    assert.deepEqual(servedCopies(h).map((row) => row.event_id), [event.event_id]);
    assert.deepEqual(
      [body.signed_copy.shown_at, body.signed_copy.window_ends_at],
      [event.shown_at, event.window_ends_at],
    );
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).state, "open");
    assert.equal((await signedCopyQueue(h)).count, 0);
  } finally {
    h.restore();
  }
});

test("an answer D1 loses is never trusted: the retry records the copy as shown again, reads its confirmation back, and serves that", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // The first event commits and its answer is lost; the second commits, and so does its
    // confirmation, whose answer is lost too. No separate read-back stands between them.
    h.db.loseSignedCopyEventAnswers = 1;
    h.db.loseSignedCopyConfirmationAnswers = 1;
    const response = await acceptShowingCopy(h, portalToken, "acceptance-a5-lost-0001");
    assert.equal(response.status, 200);
    assert.deepEqual(
      [h.db.loseSignedCopyEventAnswers, h.db.loseSignedCopyConfirmationAnswers],
      [0, 0],
      "both answers were lost",
    );
    const body = await response.json() as Record<string, any>;
    // The lost event is never reused: a second one was appended and confirmed, and the copy carries it.
    const events = shownEvents(h);
    assert.equal(events.length, 2);
    const [served, ...moreServed] = servedCopies(h);
    assert.ok(served);
    assert.deepEqual(moreServed, []);
    const written = (h.db.raw.prepare(
      "SELECT run_id FROM audit_log WHERE action = 'shown:signed_copy' ORDER BY id",
    ).all() as Array<{ run_id: string }>).map((row) => row.run_id);
    assert.equal(written.length, 2);
    assert.equal(served.event_id, written[1], "the confirmation is of the second event");
    const lost = events.find((row) => row.event_id === written[0])!;
    const shown = events.find((row) => row.event_id === served.event_id)!;
    assert.deepEqual(
      [body.signed_copy.shown_at, body.signed_copy.served_at, body.signed_copy.window_ends_at],
      [shown.shown_at, served.served_at, shown.window_ends_at],
    );
    assert.ok(shown.window_ends_at >= lost.window_ends_at);
    // A copy of the contract is confirmed served, so the job is not on the work queue.
    assert.deepEqual(await signedCopyQueue(h), {
      count: 0, counts: { window_unknown: 0, signed_copy_unconfirmed: 0 }, complete: true, jobs: [],
    });
    // The exact replay answers with the same copy and writes nothing.
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-lost-0001"),
      h.env as never,
      {} as never,
    );
    assert.deepEqual(await replay.json(), body);
    assert.equal(shownEvents(h).length, 2);
    assert.equal(servedCopies(h).length, 1);
  } finally {
    h.restore();
  }
});

/**
 * The work queue's row for this job, while its latest contract's copy was recorded as shown at
 * `copyShownAt` and never confirmed served.
 */
function unconfirmedQueue(h: Harness, binding: Record<string, string>, copyShownAt: string): Record<string, unknown> {
  return {
    count: 1,
    counts: { window_unknown: 0, signed_copy_unconfirmed: 1 },
    complete: true,
    jobs: [{
      roof_job_id: JOB_ID,
      job_number: (h.db.raw.prepare("SELECT job_number FROM operating_roof_jobs WHERE roof_job_id = ?")
        .get(JOB_ID) as { job_number: string | null }).job_number,
      customer_display_name: (h.db.raw.prepare("SELECT display_name FROM operating_customers WHERE customer_id = ?")
        .get(CUSTOMER_ID) as { display_name: string }).display_name,
      address_line1: null,
      category: "signed_copy_unconfirmed",
      unknown_reason: "signed_copy_unconfirmed",
      copy_shown_at: copyShownAt,
      contract_on_record: true,
      contract_signed_at: binding.accepted_at,
    }],
  };
}

/** The window an unconfirmed copy leaves: unknown, every hold in place, no start and no end. */
async function assertUnconfirmedWindow(h: Harness): Promise<void> {
  const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
  assert.deepEqual(
    [window.state, window.unknown_reason, window.starts_at, window.ends_at, window.last_day, window.signed_copy_shown, window.holds.length],
    ["unknown", "signed_copy_unconfirmed", null, null, null, null, 3],
  );
  assert.deepEqual(await cancellationWindowHold(h.env, TENANT, JOB_ID), {
    state: "unknown",
    detail: { unknown_reason: "signed_copy_unconfirmed" },
  });
}

test("a copy never confirmed served starts nothing: past its own end every hold still holds, until a person records the receipt", async () => {
  // D1's clock is the test's, to stand it a millisecond past the unconfirmed copies' ends.
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // Each attempt writes its event, and D1 refuses every confirmation: no copy is confirmed served,
    // so none is sent, and none starts the window.
    h.db.failSignedCopyConfirmations = 3;
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-unconfirmed-0001");
    assert.equal(first.status, 200);
    assert.equal(h.db.failSignedCopyConfirmations, 0, "the Worker tried three times");
    const text = await first.text();
    const acceptanceId = (JSON.parse(text) as { acceptance_id: string }).acceptance_id;
    assert.equal(text, JSON.stringify({ acceptance_id: acceptanceId, status: "accepted" }));
    const unconfirmed = shownEvents(h);
    assert.equal(unconfirmed.length, 3);
    assert.deepEqual(servedCopies(h), []);
    const binding = bindingFor(h, acceptanceId);
    await assertUnconfirmedWindow(h);
    assert.deepEqual(await signedCopyQueue(h), unconfirmedQueue(h, binding, unconfirmed[0]!.shown_at));
    const schedule = readyToSchedule(h, { waiveMaterials: true });
    backorderedJobLine(h);
    await assertEveryHoldStands(h, schedule, "unknown");

    // A millisecond after the last of those copies would have ended the window, it is still unknown:
    // every hold holds, on every surface, and the job is still on the work queue.
    const lastEnd = Math.max(...unconfirmed.map((row) => Date.parse(row.window_ends_at)));
    mock.timers.enable({ apis: ["Date"], now: lastEnd + 1 });
    await assertUnconfirmedWindow(h);
    await assertEveryHoldStands(h, schedule, "unknown");
    assert.deepEqual(await signedCopyQueue(h), unconfirmedQueue(h, binding, unconfirmed[0]!.shown_at));

    // Ops records when the customer received the copy: the window opens from that time, and the job
    // leaves the work queue.
    const receivedAt = new Date(d1Now(h.db.raw) - 60 * MINUTE_MS).toISOString();
    const recorded = await recordReceivedCopy(h, await personAuth(h, OWNER_ID), receivedAt, "receipt-a5-unconfirmed-0001");
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    const opened = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual([opened.state, opened.started_from, opened.starts_at], ["open", "manual_record", receivedAt]);
    await assertEveryHoldStands(h, schedule, "open");
    assert.equal((await signedCopyQueue(h)).count, 0);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("a copy whose Worker stopped after its event starts nothing: past that event's end every hold still holds", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextSignedCopyBuild = true;
    const accepted = await acceptShowingCopy(h, portalToken, "acceptance-a5-stopped-0001");
    assert.equal(accepted.status, 200);
    const binding = bindingFor(h, (await accepted.json() as { acceptance_id: string }).acceptance_id);
    // The event a Worker leaves when it stops right after writing it: no confirmation follows.
    h.db.raw.prepare(
      `INSERT INTO contract_signed_copy_events (
         event_id, tenant_id, acceptance_binding_id, roof_job_id, contract_signed_at, shown_at,
         window_ends_at, time_zone
       ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+250 hours'), ?)`,
    ).run(`scs_${"8".repeat(40)}`, TENANT, binding.acceptance_binding_id, JOB_ID, binding.accepted_at, ZONE);
    const [stopped] = shownEvents(h);
    await assertUnconfirmedWindow(h);
    assert.deepEqual(await signedCopyQueue(h), unconfirmedQueue(h, binding, stopped!.shown_at));
    const schedule = readyToSchedule(h, { waiveMaterials: true });
    backorderedJobLine(h);
    mock.timers.enable({ apis: ["Date"], now: Date.parse(stopped!.window_ends_at) + 1 });
    await assertUnconfirmedWindow(h);
    await assertEveryHoldStands(h, schedule, "unknown");
    assert.equal((await signedCopyQueue(h)).count, 1);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("the replay after a stopped Worker serves a copy that starts then, and the unconfirmed event counts for nothing", async () => {
  // D1's clock is the test's, to stand it a millisecond past the confirmed copy's end.
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextSignedCopyBuild = true;
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-event-end-0001");
    assert.equal(first.status, 200);
    const binding = bindingFor(h, (await first.json() as { acceptance_id: string }).acceptance_id);
    // The stopped Worker's event ends at its 266th hour, later than a copy's own end would.
    h.db.raw.prepare(
      `INSERT INTO contract_signed_copy_events (
         event_id, tenant_id, acceptance_binding_id, roof_job_id, contract_signed_at, shown_at,
         window_ends_at, time_zone
       ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+266 hours'), 'Pacific/Honolulu')`,
    ).run(`scs_${"7".repeat(40)}`, TENANT, binding.acceptance_binding_id, JOB_ID, binding.accepted_at);
    const [unconfirmed] = shownEvents(h);
    await assertUnconfirmedWindow(h);
    const afterFirst = new Date(d1Now(h.db.raw)).toISOString();
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-event-end-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    const body = await replay.json() as Record<string, any>;
    const [served] = servedCopies(h);
    assert.ok(served && served.event_id !== unconfirmed!.event_id);
    const event = shownEvents(h).find((row) => row.event_id === served.event_id)!;
    // A new event with D1's time then, and its own end: the unconfirmed event's later end is not kept.
    assert.ok(event.shown_at >= afterFirst);
    assert.equal(event.window_ends_at, cancellationWindowEndsAt(event.shown_at, ZONE));
    assert.ok(event.window_ends_at < unconfirmed!.window_ends_at);
    assert.deepEqual(
      [body.signed_copy.window_starts_at, body.signed_copy.window_ends_at, body.signed_copy.ends_on_calendar_day],
      [event.shown_at, event.window_ends_at, true],
    );
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual(
      [window.state, window.starts_at, window.ends_at, window.ends_on_calendar_day, window.signed_copy_shown?.id],
      ["open", event.shown_at, event.window_ends_at, true, event.event_id],
    );
    assert.equal((await signedCopyQueue(h)).count, 0);

    // A millisecond past the confirmed copy's end, every hold lifts, in the Worker and in D1, though
    // the unconfirmed event's would-be end is still ahead.
    backorderedJobLine(h);
    mock.timers.enable({ apis: ["Date"], now: Date.parse(event.window_ends_at) + 1 });
    assert.ok(Date.now() < Date.parse(unconfirmed!.window_ends_at));
    const ended = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual([ended.state, ended.holds], ["ended", []]);
    assert.equal(await cancellationWindowHold(h.env, TENANT, JOB_ID), null);
    // Materials is attested through the ledger, the crew is scheduled, a supplier order is placed and
    // the backordered line is ordered again.
    const schedule = readyToSchedule(h);
    assert.equal(((await schedule("schedule-a5-after-confirmed-end")) as { kind: string }).kind, "created");
    placeJobOrderLine(h);
    h.db.raw.prepare(
      "UPDATE inventory_po_lines SET status = 'ordered', version = version + 1 WHERE po_line_id = 'po_line_acceptance_backordered'",
    ).run();
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM inventory_po_lines WHERE status = 'ordered'").get() as { n: number }).n,
      2,
    );
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("a double submit leaves an orphan unconfirmed event, and every read takes the confirmed one", async () => {
  // D1's clock is the test's: the first request's copy is shown a second before local midnight, and
  // the second request's orphan event a second after it.
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // The first local midnight more than an hour from now, to the millisecond.
    const from = Date.now() + 60 * MINUTE_MS;
    let midnight = from;
    while (localDate(new Date(midnight).toISOString()) === localDate(new Date(from).toISOString())) {
      midnight += MINUTE_MS;
    }
    midnight -= MINUTE_MS;
    while (localDate(new Date(midnight).toISOString()) === localDate(new Date(midnight - 1).toISOString())) {
      midnight += 1;
    }
    mock.timers.enable({ apis: ["Date"], now: midnight - 1_000 });
    // The second submit writes its event between the first's event and the first's confirmation.
    const orphanId = `scs_${"6".repeat(40)}`;
    let written = false;
    h.db.beforeConfirmation = () => {
      if (written) return;
      written = true;
      mock.timers.tick(2_000);
      h.db.raw.prepare(
        `INSERT INTO contract_signed_copy_events (
           event_id, tenant_id, acceptance_binding_id, roof_job_id, contract_signed_at, shown_at,
           window_ends_at, time_zone
         )
         SELECT ?, tenant_id, acceptance_binding_id, roof_job_id, accepted_at,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+250 hours'), ?
           FROM commercial_acceptance_bindings WHERE roof_job_id = ?`,
      ).run(orphanId, ZONE, JOB_ID);
    };
    const response = await acceptShowingCopy(h, portalToken, "acceptance-a5-double-0001");
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    const [served] = servedCopies(h);
    const events = shownEvents(h);
    assert.equal(events.length, 2);
    const confirmed = events.find((row) => row.event_id === served!.event_id)!;
    const orphan = events.find((row) => row.event_id === orphanId)!;
    assert.ok(orphan.shown_at > confirmed.shown_at, "the orphan is the later event");
    assert.notEqual(localDate(orphan.shown_at), localDate(confirmed.shown_at), "the orphan falls after local midnight");
    // The copy and both reads state the confirmed event's start and last day, never the orphan's.
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    const reading = calendarReading(confirmed.shown_at, ZONE);
    assert.deepEqual(
      [window.starts_at, window.signed_copy_shown?.id, window.last_day, window.ends_at, window.ends_on_calendar_day],
      [confirmed.shown_at, confirmed.event_id, reading.lastDay, confirmed.window_ends_at, true],
    );
    assert.deepEqual(
      [body.signed_copy.window_starts_at, body.signed_copy.last_day],
      [confirmed.shown_at, reading.lastDay],
    );
    const gates = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates`),
      h.env,
      await personAuth(h, OWNER_ID),
    );
    const office = (await gates.json() as Record<string, any>).cancellation_window;
    assert.deepEqual([office.starts_at, office.last_day], [confirmed.shown_at, reading.lastDay]);
    // A copy is confirmed served, so the job is not on the work queue.
    assert.equal((await signedCopyQueue(h)).count, 0);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("a copy recorded as shown after a person's record never ends before that record's end", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextSignedCopyBuild = true;
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-later-end-0001");
    assert.equal(first.status, 200);
    const binding = bindingFor(h, (await first.json() as { acceptance_id: string }).acceptance_id);
    assert.deepEqual(shownEvents(h), []);
    // A person's record at the signature, ending at its 266th hour, which D1 allows: later than the
    // copy's own end will be, as for a record read in a business time zone hours behind this one.
    const recordEnd = new Date(Date.parse(binding.accepted_at) + 266 * 60 * MINUTE_MS).toISOString();
    h.db.raw.prepare(
      `INSERT INTO production_cancellation_window_receipts (
         receipt_id, tenant_id, roof_job_id, received_at, window_ends_at, time_zone,
         acceptance_binding_id, contract_signed_at, reason, evidence_ref, recorded_by_user_id,
         recorded_by_role, recorded_at, request_sha256, idempotency_key_hash
       ) VALUES (?, ?, ?, ?, ?, 'Pacific/Honolulu', ?, ?, 'Synthetic direct record.', 'fixture://copy', ?,
                 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run(
      `pcw_${"6".repeat(40)}`, TENANT, JOB_ID, binding.accepted_at, recordEnd, binding.acceptance_binding_id,
      binding.accepted_at, OWNER_ID, "a".repeat(64), "6".repeat(64),
    );
    // The replay records the copy as shown now. Its own end would come sooner, so it keeps the
    // record's end, and serves it.
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-later-end-0001"),
      h.env as never,
      {} as never,
    );
    assert.equal(replay.status, 200);
    const body = await replay.json() as Record<string, any>;
    const [event] = shownEvents(h);
    assert.ok(event);
    assert.ok(cancellationWindowEndsAt(event.shown_at, ZONE) < recordEnd);
    assert.equal(event.window_ends_at, recordEnd);
    assert.equal(body.signed_copy.window_ends_at, recordEnd);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).ends_at, recordEnd);
  } finally {
    h.restore();
  }
});

test("an uncertain (202) attempt with signed_copy records no copy as shown", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await issueChallenge(h.env, portalToken)).status, 200);
    // The commit never reaches D1...
    h.db.beforeNextBatch = () => {
      throw new Error("simulated_d1_unavailable");
    };
    const lost = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-uncertain-0001"),
      h.env as never,
      {} as never,
    );
    assert.notEqual(lost.status, 200);
    assert.equal(h.db.beforeNextBatch, null, "the commit's batch was attempted");
    assert.equal(count(h, "commercial_acceptance_bindings"), 0);
    // ...and the attempt's lease has run out when the customer asks again: the outcome is uncertain.
    const attemptedAt = new Date(Date.now() - 120_000).toISOString();
    const leaseExpiredAt = new Date(Date.now() - 60_000).toISOString();
    h.db.raw.prepare(
      `UPDATE customer_portal_acceptance_intents
          SET frappe_attempted_at = ?, frappe_attempt_lease_expires_at = ?, updated_at = ?
        WHERE state = 'receipt_stored'`,
    ).run(attemptedAt, leaseExpiredAt, attemptedAt);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uncertain = await worker.fetch(
        confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-uncertain-0001"),
        h.env as never,
        {} as never,
      );
      assert.equal(uncertain.status, 202);
      assert.equal((await uncertain.json() as { status: string }).status, "uncertain");
    }
    assert.deepEqual(shownEvents(h), []);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).state, "unknown");
  } finally {
    h.restore();
  }
});

/**
 * A contract accepted on a screen that shows the copy, on a D1 whose clock the test then sets: the
 * window comes from the copy's event alone, and `end` is that event's end.
 */
async function eventSourcedWindow(key: string): Promise<{ h: Harness; end: string; endMs: number }> {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  seedGates(h);
  const portalToken = await seedPortalLink(h.db);
  const accepted = await acceptShowingCopy(h, portalToken, key);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const body = await accepted.json() as Record<string, any>;
  const [event, ...more] = shownEvents(h);
  assert.ok(event);
  assert.deepEqual(more, []);
  assert.equal(count(h, "production_cancellation_window_receipts"), 0, "no person's record: the event alone");
  assert.equal(body.signed_copy.window_ends_at, event.window_ends_at);
  return { h, end: event.window_ends_at, endMs: Date.parse(event.window_ends_at) };
}

test("a window started by the signed copy holds the firm start to its last millisecond, on the store, the route and in D1, and lifts it the millisecond after", async () => {
  const { h, end, endMs } = await eventSourcedWindow("acceptance-a5-event-firm-0001");
  try {
    // An hour before the end, every gate a schedule rests on is cleared inside the window.
    mock.timers.enable({ apis: ["Date"], now: endMs - 60 * MINUTE_MS });
    const schedule = readyToSchedule(h, { waiveMaterials: true });
    const routeBody = (supersedes: string | null = null) => {
      const day = fixtureSchedule(1, Date.now());
      const job = h.db.raw.prepare("SELECT version FROM operating_roof_jobs WHERE roof_job_id = ?").get(JOB_ID) as { version: number };
      return {
        expected_roof_job_version: Number(job.version),
        crew_id: "crew:acceptance:0001",
        expected_crew_version: 1,
        authority_requirements: [{
          authority_record_id: "authority:acceptance:worker",
          subject_type: "Person",
          subject_role: "Worker",
          subject_ref: "appu_field_acceptance",
          authority_kind: "Worker Competency",
          scope_type: "Roof Job",
          scope_ref: JOB_ID,
          version: 1,
          state_digest_sha256: "c".repeat(64),
        }],
        scheduled_start: day.start,
        scheduled_end: day.end,
        supersedes_assignment_id: supersedes,
        correction_reason: supersedes ? "Synthetic revision once the window has ended." : null,
      };
    };
    const scheduleOnRoute = async (owner: AuthContext, key: string, supersedes: string | null = null) => {
      const response = await handleAuthenticatedRoute(
        new Request(`${PUBLIC_ORIGIN}/api/v1/jobs/${encodeURIComponent(JOB_ID)}/schedule`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": owner.csrfToken },
          body: JSON.stringify(routeBody(supersedes)),
        }),
        h.env,
        owner,
      );
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const insertAssignment = () => {
      const assignmentId = "assignment:acceptance:event-window";
      const crew = h.db.raw.prepare(
        "SELECT state FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Crew'",
      ).get(TENANT, JOB_ID) as { state: string };
      if (crew.state === "blocked") {
        bindCrewInLedger(h.db.raw, {
          tenantId: TENANT, roofJobId: JOB_ID, crewId: "crew:acceptance:0001", assignmentId,
          keepCancellationWindow: true,
        });
      }
      const day = fixtureSchedule(1, d1Now(h.db.raw));
      const job = h.db.raw.prepare("SELECT version FROM operating_roof_jobs WHERE roof_job_id = ?").get(JOB_ID) as { version: number };
      h.db.raw.prepare(
        `INSERT INTO operating_job_assignments
           (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
            crew_version, assigned_users_json, scheduled_start, scheduled_end, supersedes_assignment_id,
            correction_reason, actor_user_id, command_fingerprint, idempotency_key_hash, created_at)
         VALUES (?, ?, ?, 1, ?, 'crew:acceptance:0001', 1, '["appu_field_acceptance"]', ?, ?, NULL, NULL,
                 ?, ?, ?, ?)`,
      ).run(assignmentId, TENANT, JOB_ID, Number(job.version), day.start, day.end, OWNER_ID,
        "e".repeat(64), "f".repeat(64), new Date().toISOString());
    };

    // The last millisecond: held on the store, the route and in D1, each by name with the end.
    mock.timers.setTime(endMs - 1);
    const owner = await personAuth(h, OWNER_ID);
    const open = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.deepEqual([open.state, open.ends_at, open.started_from], ["open", end, "signed_copy_shown"]);
    await assert.rejects(schedule("schedule-a5-event-held"), (error: unknown) => {
      assert.ok(error instanceof OperatingJobAssignmentError, String(error));
      assert.equal(error.code, "operating_job_assignment_cancellation_window_open");
      assert.deepEqual(error.detail, { window_ends_at: end });
      return true;
    });
    assert.deepEqual(await scheduleOnRoute(owner, "schedule-a5-event-route-held"), {
      status: 409,
      body: { window_ends_at: end, error: "operating_job_assignment_cancellation_window_open" },
    });
    refusedWith(insertAssignment, "operating_job_assignment_cancellation_window_open");
    assert.equal(count(h, "operating_job_assignments"), 0);

    // At the end itself the window has ended: the bound is exclusive.
    mock.timers.setTime(endMs);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).state, "ended");

    // The millisecond after: D1 takes the assignment written straight at it, the route writes the
    // next revision and the store the one after. Each insert passes D1's hold too.
    mock.timers.setTime(endMs + 1);
    insertAssignment();
    const routed = await scheduleOnRoute(owner, "schedule-a5-event-route-0001", "assignment:acceptance:event-window");
    assert.equal(routed.status, 201, JSON.stringify(routed.body));
    const job = h.db.raw.prepare("SELECT version FROM operating_roof_jobs WHERE roof_job_id = ?").get(JOB_ID) as { version: number };
    const day = fixtureSchedule(2, Date.now());
    const revised = await recordOperatingJobAssignment(h.env, {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      expectedRoofJobVersion: Number(job.version),
      crewId: "crew:acceptance:0001",
      expectedCrewVersion: 1,
      authorityRequirements: routeBody().authority_requirements as never,
      scheduledStart: day.start,
      scheduledEnd: day.end,
      supersedesAssignmentId: routed.body.assignment.id,
      correctionReason: "Synthetic revision once the window has ended.",
      actorUserId: OWNER_ID,
      idempotencyKey: "schedule-a5-event-store-0001",
    });
    assert.equal(revised.kind, "created");
    assert.equal(count(h, "operating_job_assignments"), 3);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("a window started by the signed copy holds Materials and ordering to its last millisecond, on the route and in D1, and lifts them the millisecond after", async () => {
  const { h, end, endMs } = await eventSourcedWindow("acceptance-a5-event-order-0001");
  try {
    backorderedJobLine(h);
    const attestMaterials = async (owner: AuthContext) => {
      const response = await handleAuthenticatedRoute(
        new Request(`${PUBLIC_ORIGIN}/api/v1/production/jobs/${encodeURIComponent(JOB_ID)}/gates/Materials/clearance`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `materials-a5-event-${Date.now()}`,
            "x-csrf-token": owner.csrfToken,
          },
          body: JSON.stringify({
            basis: "person_attestation",
            expected_gate_version: 1,
            attestation: { source: "supplier_delivery", reference: "DELIVERY-ACCEPTANCE-0002" },
          }),
        }),
        h.env,
        owner,
      );
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const reorder = () => h.db.raw.prepare(
      "UPDATE inventory_po_lines SET status = 'ordered', version = version + 1 WHERE po_line_id = 'po_line_acceptance_backordered'",
    ).run();
    const ordered = () => (h.db.raw.prepare(
      "SELECT COUNT(*) AS n FROM inventory_po_lines WHERE roof_job_id = ? AND status = 'ordered'",
    ).get(JOB_ID) as { n: number }).n;

    // The last millisecond: Materials on the route and in D1, a supplier order and a line moving back
    // to ordered in D1, each held by name with the end.
    mock.timers.enable({ apis: ["Date"], now: endMs - 1 });
    const owner = await personAuth(h, OWNER_ID);
    assert.deepEqual(await attestMaterials(owner), {
      status: 409,
      body: { window_ends_at: end, error: "production_gate_cancellation_window_open" },
    });
    refusedWith(() => clearMaterialsInD1(h), "production_gate_cancellation_window_open");
    refusedWith(() => placeJobOrderLine(h), "inventory_po_line_cancellation_window_open");
    refusedWith(reorder, "inventory_po_line_cancellation_window_open");
    assert.equal(ordered(), 0);
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM production_gate_clearances WHERE gate = 'Materials'").get() as { n: number }).n,
      0,
    );

    // The millisecond after: each is written, the Materials attestation through D1's hold as well.
    mock.timers.setTime(endMs + 1);
    const materials = await attestMaterials(owner);
    assert.equal(materials.status, 200, JSON.stringify(materials.body));
    assert.equal(materials.body.gate.state, "ready");
    placeJobOrderLine(h);
    reorder();
    assert.equal(ordered(), 2);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("a person's record after the copy was shown only moves the window later", async () => {
  // The Worker's clock runs a minute behind D1's, so the customer's signature is a minute before
  // the copy's D1 time and the two never fall in the same millisecond.
  const behind = 1 / (24 * 60);
  const h = await inThePast(behind, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(behind, () => seedPortalLink(h.db));
    const accepted = await inThePast(behind, () => acceptShowingCopy(h, portalToken, "acceptance-a5-later-0001"));
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const binding = bindingFor(h, (await accepted.json() as { acceptance_id: string }).acceptance_id);
    const [event] = shownEvents(h);
    assert.ok(Date.parse(binding.accepted_at) < Date.parse(event!.shown_at));
    const owner = await personAuth(h, OWNER_ID);

    // At the signature, the floor allows it, but it is earlier than the copy shown: refused.
    const earlier = await recordReceivedCopy(h, owner, binding.accepted_at, "receipt-a5-later-0001");
    assert.equal(earlier.status, 409);
    assert.deepEqual(earlier.body, {
      received_at: binding.accepted_at,
      recorded_received_at: event!.shown_at,
      recorded_source: "signed_copy_shown",
      window_ends_at: event!.window_ends_at,
      time_zone: ZONE,
      error: "cancellation_window_receipt_earlier_than_recorded",
    });
    // D1 holds a writer that skips the Worker to the same line, before any person's record exists.
    const direct = (receivedAt: string, windowEndsAt: string) => h.db.raw.prepare(
      `INSERT INTO production_cancellation_window_receipts (
         receipt_id, tenant_id, roof_job_id, received_at, window_ends_at, time_zone,
         acceptance_binding_id, contract_signed_at, reason, evidence_ref, recorded_by_user_id,
         recorded_by_role, recorded_at, request_sha256, idempotency_key_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Synthetic direct record.', 'fixture://copy', ?, 'owner',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run(
      `pcw_${"9".repeat(40)}`, TENANT, JOB_ID, receivedAt, windowEndsAt, ZONE,
      binding.acceptance_binding_id, binding.accepted_at, OWNER_ID, "a".repeat(64), "9".repeat(64),
    );
    assert.throws(
      () => direct(binding.accepted_at, new Date(Date.parse(binding.accepted_at) + 240 * 60 * MINUTE_MS).toISOString()),
      /cancellation_window_receipt_earlier_than_recorded/,
    );
    // The copy's own time changes nothing.
    const same = await recordReceivedCopy(h, owner, event!.shown_at, "receipt-a5-later-0002");
    assert.equal(same.status, 200);
    assert.equal(same.body.unchanged, true);
    assert.equal(count(h, "production_cancellation_window_receipts"), 0);
    // A later time moves the window later.
    while (d1Now(h.db.raw) <= Date.parse(event!.shown_at)) {
      // Wait out the millisecond the copy was shown in.
    }
    const later = new Date(d1Now(h.db.raw)).toISOString();
    const moved = await recordReceivedCopy(h, owner, later, "receipt-a5-later-0003");
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.cancellation_window.started_from, "manual_record");
    assert.equal(moved.body.cancellation_window.signed_copy_received.no_d1_contract, false);
    assert.equal(moved.body.cancellation_window.signed_copy_received.contract_signed_at, binding.accepted_at);
    assert.ok(moved.body.cancellation_window.ends_at >= event!.window_ends_at);
  } finally {
    h.restore();
  }
});

test("the floor is the contract signature: a time before it is refused with both times, the signature itself is allowed", async () => {
  // Signed a day ago, so a time a minute before the signature is in the past too.
  const h = await inThePast(1, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(1, () => seedPortalLink(h.db));
    const accepted = await inThePast(1, () => accept(h, portalToken, "acceptance-a5-floor-0001"));
    assert.equal(accepted.status, 200);
    const binding = bindingFor(h, (await accepted.json() as { acceptance_id: string }).acceptance_id);
    const owner = await personAuth(h, OWNER_ID);
    const before = new Date(Date.parse(binding.accepted_at) - MINUTE_MS).toISOString();
    const refused = await recordReceivedCopy(h, owner, before, "receipt-a5-floor-0001");
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {
      received_at: before,
      contract_signed_at: binding.accepted_at,
      time_zone: ZONE,
      error: "cancellation_window_receipt_before_contract",
    });
    assert.equal(count(h, "production_cancellation_window_receipts"), 0);
    const atSignature = await recordReceivedCopy(h, owner, binding.accepted_at, "receipt-a5-floor-0002");
    assert.equal(atSignature.status, 201, JSON.stringify(atSignature.body));
    assert.deepEqual(
      h.db.raw.prepare(
        "SELECT received_at, acceptance_binding_id, contract_signed_at FROM production_cancellation_window_receipts",
      ).all().map((row) => ({ ...row })),
      [{
        received_at: binding.accepted_at,
        acceptance_binding_id: binding.acceptance_binding_id,
        contract_signed_at: binding.accepted_at,
      }],
    );
    // D1 refuses a record that names no contract while the job has one, and one before it.
    const direct = (receivedAt: string, bindingId: string | null, signedAt: string | null, n: string) => h.db.raw.prepare(
      `INSERT INTO production_cancellation_window_receipts (
         receipt_id, tenant_id, roof_job_id, received_at, window_ends_at, time_zone,
         acceptance_binding_id, contract_signed_at, reason, evidence_ref, recorded_by_user_id,
         recorded_by_role, recorded_at, request_sha256, idempotency_key_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Synthetic direct record.', 'fixture://copy', ?, 'owner',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run(
      `pcw_${n.repeat(40)}`, TENANT, JOB_ID, receivedAt,
      new Date(Date.parse(receivedAt) + 240 * 60 * MINUTE_MS).toISOString(), ZONE, bindingId, signedAt,
      OWNER_ID, "a".repeat(64), n.repeat(64),
    );
    const later = new Date(Date.parse(binding.accepted_at) + MINUTE_MS).toISOString();
    assert.throws(() => direct(later, null, null, "7"), /cancellation_window_receipt_contract_changed/);
    assert.throws(
      () => direct(before, binding.acceptance_binding_id, binding.accepted_at, "8"),
      /cancellation_window_receipt_before_contract/,
    );
  } finally {
    h.restore();
  }
});

test("a later contract needs its own copy: the window is unknown again until it is shown or recorded", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    const first = await acceptShowingCopy(h, portalToken, "acceptance-a5-again-0001");
    assert.equal(first.status, 200);
    assert.equal((await readCancellationWindow(h.env, TENANT, JOB_ID)).state, "open");
    // A corrected contract, signed on today's page, which shows no copy.
    await publishCorrectedContract(h, OD01_TERMS);
    const second = await accept(h, portalToken, "acceptance-a5-again-0002");
    assert.equal(second.status, 200);
    const binding = bindingFor(h, (await second.json() as { acceptance_id: string }).acceptance_id);
    const window = await readCancellationWindow(h.env, TENANT, JOB_ID);
    assert.equal(window.state, "unknown");
    assert.equal(window.unknown_reason, "signed_copy_before_contract");
    assert.equal(window.contract?.acceptance_binding_id, binding.acceptance_binding_id);
    assert.throws(() => placeJobOrderLine(h), /inventory_po_line_cancellation_window_unknown/);
    // The work queue lists it: signed in D1, with no copy of this contract on record.
    const owner = await personAuth(h, OWNER_ID);
    const missing = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/production/cancellation-window/signed-copy-missing`),
      h.env,
      owner,
    );
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), {
      count: 1,
      counts: { window_unknown: 1, signed_copy_unconfirmed: 0 },
      complete: true,
      jobs: [{
        roof_job_id: JOB_ID,
        job_number: (h.db.raw.prepare("SELECT job_number FROM operating_roof_jobs WHERE roof_job_id = ?")
          .get(JOB_ID) as { job_number: string | null }).job_number,
        customer_display_name: (h.db.raw.prepare("SELECT display_name FROM operating_customers WHERE customer_id = ?")
          .get(CUSTOMER_ID) as { display_name: string }).display_name,
        address_line1: null,
        category: "window_unknown",
        unknown_reason: "signed_copy_before_contract",
        copy_shown_at: null,
        contract_on_record: true,
        contract_signed_at: binding.accepted_at,
      }],
    });
    // A person records when this copy was received: the window opens again, and the job leaves the list.
    const recorded = await recordReceivedCopy(h, owner, binding.accepted_at, "receipt-a5-again-0001");
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.cancellation_window.state, "open");
    const after = await handleAuthenticatedRoute(
      new Request(`${PUBLIC_ORIGIN}/api/v1/production/cancellation-window/signed-copy-missing`),
      h.env,
      owner,
    );
    assert.deepEqual(await after.json(), {
      count: 0, counts: { window_unknown: 0, signed_copy_unconfirmed: 0 }, complete: true, jobs: [],
    });
  } finally {
    h.restore();
  }
});

test("D1 holds a signed-copy event to its contract, its clock and its bounds, and a record to the event", async () => {
  // Signed a day ago on today's page: a contract with no copy shown.
  const h = await inThePast(1, () => setup({ terms: OD01_TERMS, depositPolicy: null }));
  try {
    seedGates(h);
    const portalToken = await inThePast(1, () => seedPortalLink(h.db));
    const accepted = await inThePast(1, () => accept(h, portalToken, "acceptance-a5-direct-0001"));
    assert.equal(accepted.status, 200);
    const binding = bindingFor(h, (await accepted.json() as { acceptance_id: string }).acceptance_id);
    const plusHours = (iso: string, hours: number) =>
      new Date(Date.parse(iso) + hours * 60 * MINUTE_MS).toISOString();
    let n = 0;
    const insertEvent = (overrides: Record<string, unknown> = {}) => {
      n += 1;
      const row: Record<string, unknown> = {
        event_id: `scs_${String(n).padStart(40, "0")}`,
        tenant_id: TENANT,
        acceptance_binding_id: binding.acceptance_binding_id,
        roof_job_id: JOB_ID,
        contract_signed_at: binding.accepted_at,
        time_zone: ZONE,
        ...overrides,
      };
      const shown = "shown_at" in row ? "?" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      const ends = "window_ends_at" in row ? "?" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+240 hours')";
      const columns = Object.keys(row).filter((column) => column !== "shown_at" && column !== "window_ends_at");
      h.db.raw.prepare(
        `INSERT INTO contract_signed_copy_events (${columns.join(", ")}, shown_at, window_ends_at)
         VALUES (${columns.map(() => "?").join(", ")}, ${shown}, ${ends})`,
      ).run(
        ...(columns.map((column) => row[column]) as never[]),
        ...(["shown_at", "window_ends_at"].filter((column) => column in row).map((column) => row[column]) as never[]),
      );
    };
    const insertReceipt = (receivedAt: string, windowEndsAt: string, contract = binding) => {
      n += 1;
      h.db.raw.prepare(
        `INSERT INTO production_cancellation_window_receipts (
           receipt_id, tenant_id, roof_job_id, received_at, window_ends_at, time_zone,
           acceptance_binding_id, contract_signed_at, reason, evidence_ref, recorded_by_user_id,
           recorded_by_role, recorded_at, request_sha256, idempotency_key_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Synthetic direct record.', 'fixture://copy', ?, 'owner',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
      ).run(
        `pcw_${String(n).padStart(40, "0")}`, TENANT, JOB_ID, receivedAt, windowEndsAt, ZONE,
        contract.acceptance_binding_id, contract.accepted_at, OWNER_ID, "a".repeat(64), String(n).padStart(64, "0"),
      );
    };
    const now = () => new Date(d1Now(h.db.raw)).toISOString();

    // The copy is of this contract, exactly as its binding holds it, shown now by D1's clock.
    assert.throws(() => insertEvent({ acceptance_binding_id: "commercial-acceptance:other" }), /contract_signed_copy_event_binding_invalid/);
    assert.throws(() => insertEvent({ roof_job_id: "job:acceptance:other" }), /contract_signed_copy_event_binding_invalid/);
    assert.throws(
      () => insertEvent({ contract_signed_at: new Date(Date.parse(binding.accepted_at) + 1).toISOString() }),
      /contract_signed_copy_event_binding_invalid/,
    );
    assert.throws(() => insertEvent({ shown_at: plusHours(now(), -24) }), /contract_signed_copy_event_shown_at_invalid/);
    const shownAt = now();
    assert.throws(
      () => insertEvent({ shown_at: shownAt, window_ends_at: new Date(Date.parse(plusHours(shownAt, 240)) - 1).toISOString() }),
      /contract_signed_copy_event_end_invalid/,
    );
    // A reading of the 10th local day's end is at most 264 hours after a start at local midnight,
    // plus a span of offsets D1 allows up to two hours: D1 refuses anything later.
    assert.throws(
      () => insertEvent({ shown_at: shownAt, window_ends_at: new Date(Date.parse(plusHours(shownAt, 266)) + 1).toISOString() }),
      /contract_signed_copy_event_end_invalid/,
    );
    assert.equal(count(h, "contract_signed_copy_events"), 0);

    // A person's record half an hour ago, ending at its 241st hour: an event ending before that
    // end is refused, and one at its own 266th hour, D1's upper bound, is written.
    const receivedAt = plusHours(now(), -0.5);
    insertReceipt(receivedAt, plusHours(receivedAt, 241));
    assert.throws(() => insertEvent(), /contract_signed_copy_event_end_invalid/);
    const firstShown = now();
    insertEvent({ shown_at: firstShown, window_ends_at: plusHours(firstShown, 266) });
    const [event] = shownEvents(h);
    assert.ok(event);
    // An event's id is never reused, and an event is never updated or deleted.
    assert.throws(
      () => insertEvent({ event_id: event.event_id, window_ends_at: plusHours(firstShown, 266) }),
      /contract_signed_copy_event_append_only/,
    );
    assert.throws(
      () => h.db.raw.prepare("UPDATE contract_signed_copy_events SET time_zone = 'UTC' WHERE event_id = ?").run(event.event_id),
      /contract_signed_copy_event_append_only/,
    );
    assert.throws(
      () => h.db.raw.prepare("DELETE FROM contract_signed_copy_events WHERE event_id = ?").run(event.event_id),
      /contract_signed_copy_event_append_only/,
    );

    // Unconfirmed, the event counts for nothing: D1 takes a record earlier than it, or at its own
    // time, against the person's record alone (each tried, then undone).
    const probe = (receivedAt: string, windowEndsAt: string) => {
      h.db.raw.exec("SAVEPOINT unconfirmed_probe");
      try {
        insertReceipt(receivedAt, windowEndsAt);
      } finally {
        h.db.raw.exec("ROLLBACK TO unconfirmed_probe");
        h.db.raw.exec("RELEASE unconfirmed_probe");
      }
    };
    const between = new Date(Math.floor((Date.parse(receivedAt) + Date.parse(event.shown_at)) / 2)).toISOString();
    probe(between, plusHours(between, 241));
    probe(event.shown_at, plusHours(event.shown_at, 241));
    // Confirmed served, it counts: both are refused.
    h.db.raw.prepare(
      `INSERT INTO contract_signed_copy_served (event_id, tenant_id, acceptance_binding_id, roof_job_id, served_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(event.event_id, TENANT, binding.acceptance_binding_id, JOB_ID);
    assert.throws(() => insertReceipt(between, plusHours(between, 241)), /cancellation_window_receipt_(earlier_than_recorded|end_invalid)/);
    // A record at the copy's own time changes nothing, and one after it never ends sooner.
    assert.throws(() => insertReceipt(event.shown_at, plusHours(event.shown_at, 240)), /cancellation_window_receipt_unchanged/);
    while (d1Now(h.db.raw) <= Date.parse(event.shown_at)) {
      // Wait out the millisecond the copy was shown in.
    }
    const later = now();
    // Ending after the earlier record's end but before the copy's end: only the copy refuses it.
    assert.throws(() => insertReceipt(later, plusHours(later, 240.75)), /cancellation_window_receipt_end_invalid/);

    // A later contract's copy never ends before the earlier copy's end either: here only the copy,
    // not the record, ends after it.
    await inThePast(0.5, () => publishCorrectedContract(h, OD01_TERMS));
    const second = await inThePast(0.5, () => accept(h, portalToken, "acceptance-a5-direct-0002"));
    assert.equal(second.status, 200);
    const secondBinding = bindingFor(h, (await second.json() as { acceptance_id: string }).acceptance_id);
    const secondShown = now();
    assert.throws(
      () => insertEvent({
        acceptance_binding_id: secondBinding.acceptance_binding_id,
        contract_signed_at: secondBinding.accepted_at,
        shown_at: secondShown,
        window_ends_at: plusHours(secondShown, 240.75),
      }),
      /contract_signed_copy_event_end_invalid/,
    );
    insertEvent({
      acceptance_binding_id: secondBinding.acceptance_binding_id,
      contract_signed_at: secondBinding.accepted_at,
      shown_at: secondShown,
      window_ends_at: event.window_ends_at,
    });
    assert.equal(count(h, "contract_signed_copy_events"), 2);
    // A record after both copies keeps their end.
    while (d1Now(h.db.raw) <= Date.parse(secondShown)) {
      // Wait out the millisecond the second copy was shown in.
    }
    insertReceipt(now(), event.window_ends_at, secondBinding);
    assert.equal(count(h, "production_cancellation_window_receipts"), 2);
  } finally {
    h.restore();
  }
});

test("D1 holds a served confirmation to its event and its clock, once per contract, and a confirmed contract to no further event", async () => {
  // D1's clock is the test's, so each rule is broken alone.
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    h.db.failNextSignedCopyBuild = true;
    const accepted = await acceptShowingCopy(h, portalToken, "acceptance-a5-confirm-0001");
    assert.equal(accepted.status, 200);
    const binding = bindingFor(h, (await accepted.json() as { acceptance_id: string }).acceptance_id);
    mock.timers.enable({ apis: ["Date"], now: Date.now() + MINUTE_MS });
    const insertEvent = (eventId: string, ago = "-0 seconds") => h.db.raw.prepare(
      `INSERT INTO contract_signed_copy_events (
         event_id, tenant_id, acceptance_binding_id, roof_job_id, contract_signed_at, shown_at,
         window_ends_at, time_zone
       ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${ago}'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${ago}', '+250 hours'), ?)`,
    ).run(eventId, TENANT, binding.acceptance_binding_id, JOB_ID, binding.accepted_at, ZONE);
    const confirm = (
      eventId: string,
      servedAt = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      overrides: Record<string, unknown> = {},
    ) => {
      const row: Record<string, unknown> = {
        event_id: eventId,
        tenant_id: TENANT,
        acceptance_binding_id: binding.acceptance_binding_id,
        roof_job_id: JOB_ID,
        ...overrides,
      };
      const columns = Object.keys(row);
      h.db.raw.prepare(
        `INSERT INTO contract_signed_copy_served (${columns.join(", ")}, served_at)
         VALUES (${columns.map(() => "?").join(", ")}, ${servedAt})`,
      ).run(...(columns.map((column) => row[column]) as never[]));
    };
    // An event 59 seconds old by D1's clock, as a writer that skips the Worker would leave it.
    const oldId = `scs_${"5".repeat(40)}`;
    insertEvent(oldId, "-59 seconds");
    const old = shownEvents(h).find((row) => row.event_id === oldId)!;
    // It confirms that event, of this contract on this job.
    refusedWith(() => confirm(`scs_${"4".repeat(40)}`), "contract_signed_copy_served_event_invalid");
    refusedWith(() => confirm(oldId, undefined, { roof_job_id: "job:acceptance:other" }), "contract_signed_copy_served_event_invalid");
    refusedWith(() => confirm(oldId, undefined, { acceptance_binding_id: "commercial-acceptance:other" }), "contract_signed_copy_served_event_invalid");
    // Never before its event (a millisecond before it, by D1's clock now).
    refusedWith(() => confirm(oldId, `strftime('%Y-%m-%dT%H:%M:%fZ', '${old.shown_at}', '-0.001 seconds')`), "contract_signed_copy_served_at_invalid");
    // Never more than a minute after it (two seconds ahead of D1's clock is 61 seconds after it).
    refusedWith(() => confirm(oldId, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 seconds')"), "contract_signed_copy_served_at_invalid");
    // Three minutes on, the event is never confirmed, not even with a time a second after it: D1's
    // clock refuses it.
    mock.timers.setTime(Date.now() + 3 * MINUTE_MS);
    refusedWith(() => confirm(oldId, `strftime('%Y-%m-%dT%H:%M:%fZ', '${old.shown_at}', '+1 seconds')`), "contract_signed_copy_served_at_invalid");
    refusedWith(() => confirm(oldId), "contract_signed_copy_served_at_invalid");
    assert.deepEqual(servedCopies(h), []);
    // A new event now is confirmed now, with its audit row.
    const newId = `scs_${"2".repeat(40)}`;
    insertEvent(newId);
    confirm(newId);
    const [served] = servedCopies(h);
    assert.ok(served && served.event_id === newId);
    assert.equal(
      (h.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE run_id = ? AND action = 'served:signed_copy'")
        .get(`${newId}:served`) as { n: number }).n,
      1,
    );
    // Once per contract, whichever event; never updated or deleted.
    refusedWith(() => confirm(newId), "contract_signed_copy_served_append_only");
    refusedWith(() => confirm(oldId), "contract_signed_copy_served_append_only");
    refusedWith(
      () => h.db.raw.prepare("UPDATE contract_signed_copy_served SET served_at = served_at WHERE event_id = ?").run(newId),
      "contract_signed_copy_served_append_only",
    );
    refusedWith(
      () => h.db.raw.prepare("DELETE FROM contract_signed_copy_served WHERE event_id = ?").run(newId),
      "contract_signed_copy_served_append_only",
    );
    // A contract whose copy is confirmed served gets no further event.
    refusedWith(() => insertEvent(`scs_${"3".repeat(40)}`), "contract_signed_copy_event_already_served");
    assert.equal(shownEvents(h).length, 2);
    // The exact replay serves that copy, with its event's times, and writes nothing.
    const replay = await worker.fetch(
      confirmShowingCopyRequest(emailChallengeToken(h.sentEmails), "acceptance-a5-confirm-0001"),
      h.env as never,
      {} as never,
    );
    const body = await replay.json() as Record<string, any>;
    const event = shownEvents(h).find((row) => row.event_id === newId)!;
    assert.deepEqual(
      [body.signed_copy.window_starts_at, body.signed_copy.served_at, body.signed_copy.window_ends_at],
      [event.shown_at, served.served_at, event.window_ends_at],
    );
    assert.equal(shownEvents(h).length, 2);
    assert.equal(servedCopies(h).length, 1);
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

test("the copy states the confirmation's own D1 time, after its event's", async () => {
  const h = await setup({ terms: OD01_TERMS, depositPolicy: null, clocked: true });
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    seedGates(h);
    const portalToken = await seedPortalLink(h.db);
    // D1's clock moves on five milliseconds between the event and its confirmation.
    h.db.beforeConfirmation = () => mock.timers.tick(5);
    const response = await acceptShowingCopy(h, portalToken, "acceptance-a5-served-at-0001");
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    const [event] = shownEvents(h);
    const [served] = servedCopies(h);
    assert.ok(event && served);
    assert.ok(served.served_at > event.shown_at, `${served.served_at} ${event.shown_at}`);
    assert.deepEqual(
      [body.signed_copy.window_starts_at, body.signed_copy.shown_at, body.signed_copy.served_at],
      [event.shown_at, event.shown_at, served.served_at],
    );
  } finally {
    mock.timers.reset();
    h.restore();
  }
});

const WINDOW_PREFLIGHT = readFileSync(new URL("../../tools/cancellation-window-preflight.sql", import.meta.url), "utf8");

test("the cancellation window pre-flight counts the open signed jobs, in D1 or outside it, and no other", async () => {
  // It runs before 0160: the chain stops at 0159.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((value) => /^\d{4}_.+\.sql$/.test(value) && value < "0160")
      .sort()) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'production_cancellation_window_receipts'").get() as { n: number }).n,
      0,
    );
    assert.deepEqual(db.prepare(WINDOW_PREFLIGHT).all(), []);
  } finally {
    db.close();
  }

  const h = await setup({ terms: OD01_TERMS, depositPolicy: null });
  try {
    const preflightRows = () => h.db.raw.prepare(WINDOW_PREFLIGHT).all().map((row) => ({ ...row }));
    seedGates(h);
    // Not signed: no contract and Deposit blocked.
    assert.deepEqual(preflightRows(), []);
    const portalToken = await seedPortalLink(h.db);
    assert.equal((await accept(h, portalToken, "acceptance-a5-preflight-0001")).status, 200);
    assert.deepEqual(preflightRows(), [{ tenant_id: TENANT, open_signed_jobs: 1, with_d1_contract: 1, signed_outside_d1: 0 }]);
    // A job signed outside D1: no contract, but its Deposit has cleared.
    seedSecondJob(h, "job:acceptance:imported");
    const now = new Date(Date.now() - 120_000).toISOString();
    for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
      h.db.raw.prepare(
        `INSERT INTO operating_production_gates
           (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
            due_at, blocker_reason, created_at, updated_at)
         VALUES (?, ?, 'job:acceptance:imported', ?, ?, 'worker', ?, ?, 'Imported.', ?, ?)`,
      ).run(`gate:imported:${gate.toLowerCase()}`, TENANT, ENVELOPE_ID, gate, now, now, now, now);
    }
    assert.deepEqual(preflightRows(), [{ tenant_id: TENANT, open_signed_jobs: 1, with_d1_contract: 1, signed_outside_d1: 0 }]);
    waiveGateInLedger(h.db.raw, {
      tenantId: TENANT, roofJobId: "job:acceptance:imported", gate: "Deposit", ownerUserId: OWNER_ID,
    });
    assert.deepEqual(preflightRows(), [{ tenant_id: TENANT, open_signed_jobs: 2, with_d1_contract: 1, signed_outside_d1: 1 }]);
    // A job no longer open is not counted.
    h.db.raw.prepare(
      `UPDATE operating_roof_jobs SET job_status = 'cancelled', version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND roof_job_id = ?`,
    ).run(new Date().toISOString(), TENANT, "job:acceptance:imported");
    assert.deepEqual(preflightRows(), [{ tenant_id: TENANT, open_signed_jobs: 1, with_d1_contract: 1, signed_outside_d1: 0 }]);
  } finally {
    h.restore();
  }
});
