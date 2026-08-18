import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  approveQuickBooksFinalInvoice,
  discoverQuickBooksFinalInvoiceCandidates,
  getQuickBooksFinalInvoice,
  handleQuickBooksOAuthCallback,
  listQuickBooksCandidateHolds,
  quickBooksConnectionEnvelope,
  quickBooksFinalInvoiceEnabled,
  quickBooksOAuthEnabled,
  recoverQuickBooksFinalInvoices,
  requestQuickBooksConnect,
  type QuickBooksCandidate,
} from "../src/quickbooks-final-invoice.ts";

const TENANT = "ironwrap";
const REALM = "1234567890";
const INTENT = "qbo-final-invoice:job-0001";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const PUBLIC_ORIGIN = "https://app.example.invalid";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  failNextBatch = false;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0030_facet_design_ingest.sql",
      "0034_facet_customer_approval_ingest.sql",
      "0035_facet_design_evidence_associations.sql",
      "0038_app_access_roles.sql",
      "0041_quickbooks_final_invoice.sql",
      "0042_external_effect_runtime.sql",
    ]) {
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
         user_id, tenant_id, email_normalized, display_name, role, access_role,
         frappe_user_id, active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    for (const role of ["owner", "accounting", "ops"] as const) {
      const storageRole = role === "accounting" ? "ops" : role;
      insert.run(
        `appu_${role}_0001`,
        TENANT,
        `${role}@example.invalid`,
        role,
        storageRole,
        role,
        `${role}@example.invalid`,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    }
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("synthetic business receipt loss");
    }
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return results;
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

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.sql, args);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.raw.prepare(this.sql).get(...this.args) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T | null;
  }

  async all<T>(): Promise<{
    success: true;
    results: T[];
    meta: { changes: number };
  }> {
    return {
      success: true,
      results: this.raw.prepare(this.sql).all(...this.args) as T[],
      meta: { changes: 0 },
    };
  }

  async run(): Promise<{
    success: true;
    results: [];
    meta: { changes: number };
  }> {
    return this.execute();
  }

  execute(): { success: true; results: []; meta: { changes: number } } {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

interface RecordedRequest {
  url: URL;
  method: string;
  body: string;
  authorization: string | null;
}

class Integrations {
  listing: { candidates: unknown[]; blockers: unknown[] } = {
    candidates: [candidate()],
    blockers: [],
  };
  tokenMode: "ok" | "reject" | "throw" = "ok";
  createMode: "ok" | "throw" = "ok";
  readback: Record<string, unknown> = quickBooksInvoice();
  resolverOutcome: "Matched" | "Mismatch" | "Pending" = "Matched";
  projectionPayload: Record<string, unknown> | null = null;
  projectionDriftField: string | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly resolverPayloads: Array<Record<string, unknown>> = [];

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    this.requests.push({
      url,
      method,
      body,
      authorization: headers.get("authorization"),
    });

    if (
      url.href === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
    ) {
      if (this.tokenMode === "throw")
        throw new Error("synthetic token response loss");
      if (this.tokenMode === "reject")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const number = this.tokenCalls;
      return Response.json({
        access_token: `access-secret-${number}`,
        refresh_token: `refresh-secret-${number}`,
        token_type: "bearer",
        expires_in: 3600,
        x_refresh_token_expires_in: 8_640_000,
      });
    }
    if (url.pathname.endsWith(".list_candidates")) {
      const request = JSON.parse(body) as { request_json: string };
      assert.equal(typeof JSON.parse(request.request_json).limit, "number");
      return Response.json({ message: this.listing });
    }
    if (url.pathname.endsWith(".bind_provider_invoice")) {
      const request = JSON.parse(body) as { binding_json: string };
      const binding = JSON.parse(request.binding_json) as Record<
        string,
        unknown
      >;
      this.projectionPayload = binding;
      return Response.json({
        message: {
          ok: true,
          idempotent_replay: false,
          roof_job_id: binding.roof_job_id,
          shop_order_id: binding.shop_order_id,
          provider_invoice_id: binding.provider_invoice_id,
          payment_milestone_id: "payment-milestone-0001",
          reconciliation_id: "reconciliation-0001",
          basis_sha256: binding.basis_sha256,
        },
      });
    }
    if (url.pathname.endsWith(".resolve_provider_invoice_readback")) {
      const request = JSON.parse(body) as { readback_json: string };
      this.resolverPayloads.push(
        JSON.parse(request.readback_json) as Record<string, unknown>,
      );
      this.projectionPayload = this.resolverPayloads.at(-1) ?? null;
      return Response.json({
        message: {
          ok: true,
          idempotent_replay: false,
          outcome: this.resolverOutcome,
          payment_milestone_id: "payment-milestone-0001",
          reconciliation_id: "reconciliation-0001",
          reason_code: null,
          owner: null,
          next_step: null,
        },
      });
    }
    if (
      url.pathname.endsWith(
        "/api/resource/Integration%20Reconciliation/reconciliation-0001",
      ) &&
      method === "GET"
    ) {
      const projection = this.projectionPayload ?? {};
      const data: Record<string, unknown> = {
        name: "reconciliation-0001",
        local_name: "payment-milestone-0001",
        invoice_intent_id: projection.intent_id,
        billing_basis_sha256: projection.basis_sha256,
        roof_job: projection.roof_job_id,
        realm_id: projection.realm_id,
        external_entity_id: projection.provider_invoice_id,
        provider_request_sha256: projection.provider_request_sha256,
        provider_create_response_sha256:
          projection.provider_create_response_sha256,
        provider_created_at: projection.provider_created_at,
        provider_readback_sha256: projection.provider_readback_sha256,
        provider_facts_sha256: projection.provider_facts_sha256,
        provider_read_at: projection.provider_read_at,
        status: this.resolverOutcome,
        diff_json:
          this.resolverOutcome === "Matched"
            ? null
            : JSON.stringify({ reason_code: "provider_readback_drift" }),
      };
      if (this.projectionDriftField)
        data[this.projectionDriftField] = "provider-drift";
      return Response.json({ data });
    }
    if (
      url.pathname.endsWith(
        "/api/resource/Payment%20Milestone/payment-milestone-0001",
      ) &&
      method === "GET"
    ) {
      const projection = this.projectionPayload ?? {};
      return Response.json({
        data: {
          name: "payment-milestone-0001",
          shop_order: projection.shop_order_id ?? null,
          billing_basis_json: JSON.stringify({
            completion_packet_id: projection.completion_packet_id,
            completion_version: projection.completion_version,
            completion_sha256: projection.completion_sha256,
            customer_quote_id: projection.customer_quote_id,
            quote_version: projection.quote_version,
            quote_sha256: projection.quote_sha256,
            changes_sha256: projection.changes_sha256,
          }),
        },
      });
    }
    if (
      url.hostname === "sandbox-quickbooks.api.intuit.com" &&
      method === "POST"
    ) {
      if (this.createMode === "throw")
        throw new Error("synthetic create response loss");
      return Response.json(
        {
          Invoice: {
            Id: "9001",
            Balance: 1050,
            MetaData: { LastUpdatedTime: NOW.toISOString() },
          },
        },
        {
          headers: { intuit_tid: "tid-create-0001" },
        },
      );
    }
    if (
      url.hostname === "sandbox-quickbooks.api.intuit.com" &&
      method === "GET"
    ) {
      return Response.json(
        { Invoice: this.readback },
        { headers: { intuit_tid: "tid-read-0001" } },
      );
    }
    throw new Error(`unexpected synthetic request: ${method} ${url}`);
  };

  get tokenCalls(): number {
    return this.requests.filter(
      (request) =>
        request.url.href ===
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    ).length;
  }

  get createCalls(): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.url.hostname === "sandbox-quickbooks.api.intuit.com" &&
        request.method === "POST",
    );
  }
}

function env(db: SqliteD1, overrides: Record<string, unknown> = {}): AppEnv {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    APP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    APP_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
    APP_ALLOW_INSECURE_LOCAL: "false",
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    QB_OAUTH_ENABLED: "true",
    QB_FINAL_INVOICE_ENABLED: "true",
    QB_API_ENVIRONMENT: "sandbox",
    QB_API_MINOR_VERSION: "75",
    QB_API_TIMEOUT_MS: "1000",
    QB_CLIENT_ID: "synthetic-client-id",
    QB_CLIENT_SECRET: "synthetic-client-secret",
    QB_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    QB_TOKEN_ENCRYPTION_KEY_VERSION: "test-v1",
    QB_FINAL_INVOICE_FRAPPE_API_KEY: "synthetic-frappe-key",
    QB_FINAL_INVOICE_FRAPPE_API_SECRET: "synthetic-frappe-secret",
    ...overrides,
  } as AppEnv;
}

function candidate(): QuickBooksCandidate {
  return {
    roof_job_id: "job-0001",
    shop_order_id: null,
    qbo: {
      realm_id: REALM,
      customer_id: "7",
      item_id: "8",
      tax_code_id: "10",
      terms_id: "9",
    },
    commercial: {
      currency: "CAD",
      subtotal: "1000.00",
      tax_amount: "50.00",
      total_amount: "1050.00",
      already_invoiced: "0.00",
      final_balance: "1050.00",
      tax_code: "GST",
      tax_rate: "5.0000",
      invoice_date: "2026-08-13",
      due_date: "2026-09-12",
      lines: [
        {
          source_type: "Customer Quote",
          source_id: "quote-0001",
          source_version: 1,
          description_code: "RESIDENTIAL_ACCEPTED_QUOTE",
          amount: "1000.00",
        },
      ],
    },
    basis: {
      intent_id: INTENT,
      basis_sha256: "a".repeat(64),
      completion_packet_id: "completion-0001",
      completion_version: "1",
      completion_sha256: "b".repeat(64),
      customer_quote_id: "quote-0001",
      quote_version: 1,
      quote_sha256: "c".repeat(64),
      changes_sha256: "d".repeat(64),
      evidence: [
        {
          source: "Frappe",
          doctype: "Completion Packet",
          name: "completion-0001",
          sha256: "b".repeat(64),
        },
        {
          source: "Frappe",
          doctype: "Customer Quote",
          name: "quote-0001",
          sha256: "c".repeat(64),
        },
      ],
    },
  };
}

function quickBooksInvoice(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Id: "9001",
    CustomerRef: { value: "7" },
    CurrencyRef: { value: "CAD" },
    SalesTermRef: { value: "9" },
    TxnDate: "2026-08-13",
    DueDate: "2026-09-12",
    TotalAmt: 1050,
    Balance: 1050,
    TxnTaxDetail: {
      TotalTax: 50,
      TaxLine: [
        {
          Amount: 50,
          DetailType: "TaxLineDetail",
          TaxLineDetail: { TaxPercent: 5 },
        },
      ],
    },
    Line: [
      {
        Amount: 1000,
        Description: "Residential roofing contract",
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: "8" },
          TaxCodeRef: { value: "10" },
        },
      },
      {
        Amount: 1000,
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
    ],
    ...overrides,
  };
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf-test-token",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "e".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2026-08-14T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}_0001`,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function commandRequest(
  path: string,
  body: unknown,
  key: string,
  csrf = true,
): Request {
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      ...(csrf ? { "x-csrf-token": "csrf-test-token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function connect(
  testEnv: AppEnv,
  fake: Integrations,
  key = "connect-quickbooks-0001",
): Promise<void> {
  const handoff = await requestQuickBooksConnect(testEnv, {
    tenantId: TENANT,
    actorUserId: "appu_owner_0001",
    returnPath: "/accounting/quickbooks",
    idempotencyKey: key,
    now: NOW,
  });
  assert.notEqual(handoff.kind, "rejected");
  if (handoff.kind === "rejected") return;
  const authorization = new URL(handoff.value.connect_url);
  const callback = new URL(handoff.value.redirect_uri);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-oauth-code");
  callback.searchParams.set("realmId", REALM);
  const response = await handleQuickBooksOAuthCallback(
    new Request(callback),
    testEnv,
    fake.fetcher,
    NOW,
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${PUBLIC_ORIGIN}/accounting/quickbooks?quickbooks=connected`,
  );
}

async function prepareApprovedInvoice(
  readback: Record<string, unknown> = quickBooksInvoice(),
): Promise<{ db: SqliteD1; testEnv: AppEnv; fake: Integrations }> {
  const db = new SqliteD1();
  const fake = new Integrations();
  fake.readback = readback;
  const testEnv = env(db);
  await connect(testEnv, fake);
  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: NOW,
    }),
    { discovered: 1, replayed: 0, blocked: 0 },
  );
  const approved = await approveQuickBooksFinalInvoice(testEnv, {
    tenantId: TENANT,
    intentId: INTENT,
    actorUserId: "appu_accounting_0001",
    actorRole: "accounting",
    expectedVersion: 1,
    idempotencyKey: "approve-final-invoice-0001",
    fetcher: fake.fetcher,
    now: NOW,
  });
  assert.equal(approved.kind, "updated", JSON.stringify(approved));
  return { db, testEnv, fake };
}

function count(db: SqliteD1, table: string): number {
  return Number(
    (
      db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

test("QuickBooks capability flags fail closed and connection actions stay role-bounded", async () => {
  const db = new SqliteD1();
  const disabled = env(db, {
    QB_OAUTH_ENABLED: "false",
    QB_FINAL_INVOICE_ENABLED: "false",
  });
  assert.equal(quickBooksOAuthEnabled(disabled), false);
  assert.equal(quickBooksFinalInvoiceEnabled(disabled), false);
  assert.deepEqual(
    await requestQuickBooksConnect(disabled, {
      tenantId: TENANT,
      actorUserId: "appu_owner_0001",
      returnPath: "/accounting/quickbooks",
      idempotencyKey: "connect-disabled-0001",
      now: NOW,
    }),
    { kind: "rejected", code: "quickbooks_oauth_disabled", status: 503 },
  );
  assert.deepEqual(await discoverQuickBooksFinalInvoiceCandidates(disabled), {
    discovered: 0,
    replayed: 0,
    blocked: 0,
  });
  assert.deepEqual(
    (await quickBooksConnectionEnvelope(disabled, TENANT, "owner"))
      .allowed_actions,
    ["refresh"],
  );
  assert.deepEqual(
    (await quickBooksConnectionEnvelope(env(db), TENANT, "owner"))
      .allowed_actions,
    ["connect", "refresh"],
  );
  assert.deepEqual(
    (await quickBooksConnectionEnvelope(env(db), TENANT, "accounting"))
      .allowed_actions,
    ["refresh"],
  );
  const missingSecret = env(db, { QB_TOKEN_ENCRYPTION_KEY: undefined });
  assert.deepEqual(
    (await quickBooksConnectionEnvelope(missingSecret, TENANT, "owner"))
      .allowed_actions,
    ["refresh"],
  );
  assert.deepEqual(
    await requestQuickBooksConnect(missingSecret, {
      tenantId: TENANT,
      actorUserId: "appu_owner_0001",
      returnPath: "/accounting/quickbooks",
      idempotencyKey: "connect-missing-config-0001",
      now: NOW,
    }),
    { kind: "rejected", code: "quickbooks_oauth_not_configured", status: 503 },
  );
});

test("QuickBooks APIs preserve connection uncertainty and block competing OAuth actions", async () => {
  const db = new SqliteD1();
  const fake = new Integrations();
  const testEnv = env(db);
  await connect(testEnv, fake);
  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: NOW,
    }),
    { discovered: 1, replayed: 0, blocked: 0 },
  );
  db.raw
    .prepare(
      `UPDATE quickbooks_connections
        SET state = 'reconciliation_required', updated_at = ?
      WHERE tenant_id = ?`,
    )
    .run(NOW.toISOString(), TENANT);

  const connection = await quickBooksConnectionEnvelope(
    testEnv,
    TENANT,
    "owner",
  );
  assert.deepEqual(connection, {
    version: 1,
    state: "reconciliation_required",
    connection_version: 1,
    realm_id: null,
    last_connected_at: null,
    allowed_actions: ["refresh"],
  });

  const connectionResponse = await handleAuthenticatedRoute(
    new Request(`${PUBLIC_ORIGIN}/api/v1/quickbooks/connection`),
    testEnv,
    auth("owner"),
  );
  assert.equal(connectionResponse.status, 200);
  assert.deepEqual(await connectionResponse.json(), connection);

  const detailResponse = await handleAuthenticatedRoute(
    new Request(
      `${PUBLIC_ORIGIN}/api/v1/quickbooks/final-invoices/${encodeURIComponent(INTENT)}`,
    ),
    testEnv,
    auth("owner"),
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    connection: { state: string };
    allowed_actions: string[];
  };
  assert.equal(detail.connection.state, "reconciliation_required");
  assert.deepEqual(detail.allowed_actions, ["refresh"]);
});

test("OAuth state is hashed, expiring, one-shot, uncertainty-terminal, and token ciphertext stays private", async () => {
  const expiredDb = new SqliteD1();
  const expiredFake = new Integrations();
  const expiredEnv = env(expiredDb);
  const expiredHandoff = await requestQuickBooksConnect(expiredEnv, {
    tenantId: TENANT,
    actorUserId: "appu_owner_0001",
    returnPath: "/accounting/quickbooks",
    idempotencyKey: "connect-expired-0001",
    now: NOW,
  });
  assert.notEqual(expiredHandoff.kind, "rejected");
  if (expiredHandoff.kind === "rejected") return;
  const expiredAuthorize = new URL(expiredHandoff.value.connect_url);
  const expiredState = expiredAuthorize.searchParams.get("state")!;
  const stored = expiredDb.raw
    .prepare(
      "SELECT state_sha256, consumed_at, outcome_code FROM quickbooks_oauth_states",
    )
    .get() as {
    state_sha256: string;
    consumed_at: string | null;
    outcome_code: string | null;
  };
  assert.equal(
    stored.state_sha256,
    createHash("sha256").update(expiredState).digest("hex"),
  );
  assert.notEqual(stored.state_sha256, expiredState);
  const expiredCallback = new URL(expiredHandoff.value.redirect_uri);
  expiredCallback.searchParams.set("state", expiredState);
  expiredCallback.searchParams.set("code", "expired-code");
  expiredCallback.searchParams.set("realmId", REALM);
  const expiredResponse = await handleQuickBooksOAuthCallback(
    new Request(expiredCallback),
    expiredEnv,
    expiredFake.fetcher,
    new Date(NOW.getTime() + 11 * 60_000),
  );
  assert.equal(
    expiredResponse.headers.get("location"),
    `${PUBLIC_ORIGIN}/accounting/quickbooks?quickbooks=error`,
  );
  assert.equal(expiredFake.tokenCalls, 0);

  const connectedDb = new SqliteD1();
  const connectedFake = new Integrations();
  const connectedEnv = env(connectedDb);
  const handoff = await requestQuickBooksConnect(connectedEnv, {
    tenantId: TENANT,
    actorUserId: "appu_owner_0001",
    returnPath: "/accounting/quickbooks",
    idempotencyKey: "connect-success-0001",
    now: NOW,
  });
  assert.notEqual(handoff.kind, "rejected");
  if (handoff.kind === "rejected") return;
  const authorization = new URL(handoff.value.connect_url);
  const callback = new URL(handoff.value.redirect_uri);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "one-shot-code");
  callback.searchParams.set("realmId", REALM);
  const wrongState = new URL(callback);
  wrongState.searchParams.set("state", "z".repeat(43));
  const rejectedState = await handleQuickBooksOAuthCallback(
    new Request(wrongState),
    connectedEnv,
    connectedFake.fetcher,
    NOW,
  );
  assert.equal(
    rejectedState.headers.get("location"),
    `${PUBLIC_ORIGIN}/accounting/quickbooks?quickbooks=error`,
  );
  assert.equal(connectedFake.tokenCalls, 0);
  const first = await handleQuickBooksOAuthCallback(
    new Request(callback),
    connectedEnv,
    connectedFake.fetcher,
    NOW,
  );
  const replay = await handleQuickBooksOAuthCallback(
    new Request(callback),
    connectedEnv,
    connectedFake.fetcher,
    NOW,
  );
  assert.equal(
    first.headers.get("location"),
    `${PUBLIC_ORIGIN}/accounting/quickbooks?quickbooks=connected`,
  );
  assert.equal(
    replay.headers.get("location"),
    `${PUBLIC_ORIGIN}/accounting/quickbooks?quickbooks=error`,
  );
  assert.equal(connectedFake.tokenCalls, 1);
  const connection = connectedDb.raw
    .prepare(
      "SELECT encrypted_bundle_b64, bundle_iv_b64, state FROM quickbooks_connections",
    )
    .get() as Record<string, unknown>;
  assert.equal(connection.state, "connected");
  assert.doesNotMatch(
    JSON.stringify(connection),
    /access-secret|refresh-secret|one-shot-code/,
  );
  assert.doesNotMatch(
    JSON.stringify(
      connectedDb.raw.prepare("SELECT * FROM quickbooks_oauth_states").all(),
    ),
    /one-shot-code/,
  );

  const uncertainDb = new SqliteD1();
  const uncertainFake = new Integrations();
  uncertainFake.tokenMode = "throw";
  const uncertainEnv = env(uncertainDb);
  const uncertainHandoff = await requestQuickBooksConnect(uncertainEnv, {
    tenantId: TENANT,
    actorUserId: "appu_owner_0001",
    returnPath: "/accounting/quickbooks",
    idempotencyKey: "connect-uncertain-0001",
    now: NOW,
  });
  assert.notEqual(uncertainHandoff.kind, "rejected");
  if (uncertainHandoff.kind === "rejected") return;
  const uncertainAuthorization = new URL(uncertainHandoff.value.connect_url);
  const uncertainCallback = new URL(uncertainHandoff.value.redirect_uri);
  uncertainCallback.searchParams.set(
    "state",
    uncertainAuthorization.searchParams.get("state")!,
  );
  uncertainCallback.searchParams.set("code", "uncertain-code");
  uncertainCallback.searchParams.set("realmId", REALM);
  await handleQuickBooksOAuthCallback(
    new Request(uncertainCallback),
    uncertainEnv,
    uncertainFake.fetcher,
    NOW,
  );
  await handleQuickBooksOAuthCallback(
    new Request(uncertainCallback),
    uncertainEnv,
    uncertainFake.fetcher,
    NOW,
  );
  assert.equal(uncertainFake.tokenCalls, 1);
  assert.equal(
    (
      uncertainDb.raw
        .prepare("SELECT outcome_code FROM quickbooks_oauth_states")
        .get() as { outcome_code: string }
    ).outcome_code,
    "exchange_uncertain",
  );
  assert.equal(count(uncertainDb, "quickbooks_connections"), 0);
  assert.equal(
    (
      await requestQuickBooksConnect(uncertainEnv, {
        tenantId: TENANT,
        actorUserId: "appu_owner_0001",
        returnPath: "/accounting/quickbooks",
        idempotencyKey: "connect-fresh-after-uncertain-0002",
        now: NOW,
      })
    ).kind,
    "created",
  );
});

test("candidate discovery persists holds, replays exactly, resolves observed holds, and rejects invalid money", async () => {
  const db = new SqliteD1();
  const fake = new Integrations();
  fake.listing = {
    candidates: [candidate()],
    blockers: [
      {
        roof_job_id: "job-hold-0001",
        code: "customer_mapping_missing",
        message: "synthetic free text must not persist",
        citations: [
          {
            source: "Frappe",
            doctype: "Roof Job",
            name: "job-hold-0001",
            sha256: "e".repeat(64),
          },
        ],
      },
    ],
  };
  const testEnv = env(db);
  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: NOW,
    }),
    { discovered: 0, replayed: 0, blocked: 0 },
  );
  assert.equal(
    fake.requests.filter((request) =>
      request.url.pathname.endsWith(".list_candidates"),
    ).length,
    0,
  );
  await connect(testEnv, fake);
  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: NOW,
    }),
    { discovered: 1, replayed: 0, blocked: 1 },
  );
  assert.equal(
    (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
    "pending_review",
  );
  assert.equal(count(db, "quickbooks_final_invoice_candidate_holds"), 1);
  assert.doesNotMatch(
    JSON.stringify(
      db.raw
        .prepare("SELECT * FROM quickbooks_final_invoice_candidate_holds")
        .all(),
    ),
    /synthetic free text/,
  );
  assert.deepEqual(
    (await listQuickBooksCandidateHolds(testEnv, TENANT))[0]?.blocker_code,
    "customer_mapping_missing",
  );

  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: new Date(NOW.getTime() + 1000),
    }),
    { discovered: 0, replayed: 1, blocked: 1 },
  );
  assert.equal(count(db, "quickbooks_final_invoice_intents"), 1);
  assert.equal(count(db, "quickbooks_final_invoice_events"), 1);

  assert.deepEqual(
    await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: new Date(NOW.getTime() + 2000),
    }),
    { discovered: 0, replayed: 1, blocked: 1 },
  );
  assert.equal(
    (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
    "pending_review",
  );
  assert.equal(count(db, "quickbooks_final_invoice_events"), 1);

  fake.listing = { candidates: [], blockers: [] };
  await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
    roofJobId: "job-hold-0001",
    fetcher: fake.fetcher,
    now: new Date(NOW.getTime() + 3000),
  });
  assert.deepEqual(await listQuickBooksCandidateHolds(testEnv, TENANT), []);
  assert.equal(count(db, "quickbooks_final_invoice_candidate_holds"), 1);

  const invalid = candidate();
  invalid.commercial.total_amount = "1050.01";
  invalid.commercial.final_balance = "1050.01";
  fake.listing = { candidates: [invalid], blockers: [] };
  await assert.rejects(
    discoverQuickBooksFinalInvoiceCandidates(testEnv, {
      fetcher: fake.fetcher,
      now: new Date(NOW.getTime() + 4000),
    }),
    /quickbooks_candidate_invalid/,
  );
  assert.equal(count(db, "quickbooks_final_invoice_intents"), 1);
});

test("accounting can approve through the API; ops, missing CSRF, and accounting OAuth connect are denied", async (t) => {
  const db = new SqliteD1();
  const fake = new Integrations();
  const testEnv = env(db);
  await connect(testEnv, fake);
  await discoverQuickBooksFinalInvoiceCandidates(testEnv, {
    fetcher: fake.fetcher,
    now: NOW,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetcher;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const path = `/api/v1/quickbooks/final-invoices/${encodeURIComponent(INTENT)}/approve`;

  const ops = await handleAuthenticatedRoute(
    commandRequest(path, { version: 1 }, "approve-as-ops-0001"),
    testEnv,
    auth("ops"),
  );
  assert.equal(ops.status, 403);
  const noCsrf = await handleAuthenticatedRoute(
    commandRequest(path, { version: 1 }, "approve-no-csrf-0001", false),
    testEnv,
    auth("accounting"),
  );
  assert.equal(noCsrf.status, 403);
  const connectAsAccounting = await handleAuthenticatedRoute(
    commandRequest(
      "/api/v1/quickbooks/connect",
      { return_path: "/accounting/quickbooks" },
      "connect-accounting-0001",
    ),
    testEnv,
    auth("accounting"),
  );
  assert.equal(connectAsAccounting.status, 403);

  const approved = await handleAuthenticatedRoute(
    commandRequest(path, { version: 1 }, "approve-accounting-0001"),
    testEnv,
    auth("accounting"),
  );
  assert.equal(approved.status, 202);
  assert.equal(
    ((await approved.json()) as { intent: { state: string } }).intent.state,
    "submission_pending",
  );
  const replay = await handleAuthenticatedRoute(
    commandRequest(path, { version: 1 }, "approve-accounting-0001"),
    testEnv,
    auth("accounting"),
  );
  assert.equal(replay.status, 202);
  assert.equal(count(db, "quickbooks_final_invoice_outbox"), 1);
  assert.deepEqual(
    {
      ...(db.raw
        .prepare(
          `SELECT actor_kind, actor_user_id FROM quickbooks_final_invoice_events
      WHERE event_type = 'approved'`,
        )
        .get() as Record<string, unknown>),
    },
    {
      actor_kind: "accounting",
      actor_user_id: "appu_accounting_0001",
    },
  );
});

test("the frozen create request records one unknown attempt and never blind-retries", async () => {
  const { db, testEnv, fake } = await prepareApprovedInvoice();
  fake.createMode = "throw";
  await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
  assert.equal(fake.createCalls.length, 1);
  const request = fake.createCalls[0]!;
  assert.equal(request.url.pathname, `/v3/company/${REALM}/invoice`);
  assert.equal(request.url.searchParams.get("minorversion"), "75");
  assert.match(
    request.url.searchParams.get("requestid") ?? "",
    /^iwfi-[a-f0-9]{43}$/,
  );
  assert.equal(request.authorization, "Bearer access-secret-1");
  assert.deepEqual(JSON.parse(request.body), {
    CustomerRef: { value: "7" },
    CurrencyRef: { value: "CAD" },
    DueDate: "2026-09-12",
    Line: [
      {
        Amount: 1000,
        Description: "Residential roofing contract",
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: "8" },
          TaxCodeRef: { value: "10" },
        },
      },
    ],
    SalesTermRef: { value: "9" },
    TxnDate: "2026-08-13",
  });
  assert.deepEqual(
    {
      ...(db.raw
        .prepare(
          "SELECT state, attempt_count, detail_code FROM quickbooks_final_invoice_outbox WHERE operation = 'submit'",
        )
        .get() as Record<string, unknown>),
    },
    {
      state: "unknown",
      attempt_count: 1,
      detail_code: "quickbooks_provider_invoice_missing",
    },
  );
  assert.equal(
    (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
    "reconciliation_required",
  );
  await recoverQuickBooksFinalInvoices(
    testEnv,
    fake.fetcher,
    new Date(NOW.getTime() + 10 * 60_000),
  );
  assert.equal(
    fake.createCalls.length,
    1,
    "an attempted provider create must never be replayed blindly",
  );
  assert.deepEqual(
    fake.createCalls.map((call) => call.url.toString()),
    [request.url.toString()],
  );
  assert.deepEqual(
    fake.createCalls.map((call) => call.body),
    [request.body],
  );
});

test("QuickBooks invoice submission records a universal effect and proves the provider invoice by readback", async () => {
  const { db, testEnv, fake } = await prepareApprovedInvoice();
  testEnv.EFFECT_RUNTIME_ENABLED = "true";
  await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
  const effect = db.raw
    .prepare(
      "SELECT state, provider, provider_external_id FROM external_effects WHERE provider = 'quickbooks'",
    )
    .get() as { state: string; provider: string; provider_external_id: string };
  assert.equal(effect.state, "succeeded");
  assert.equal(effect.provider, "quickbooks");
  assert.equal(effect.provider_external_id, "9001");
  assert.equal(fake.createCalls.length, 1);
  assert.equal(
    fake.requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname.endsWith("/invoice/9001"),
    ),
    true,
  );
  assert.equal(
    (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
    "submitted",
  );
});

test("QuickBooks to Frappe exact replay is provider-backed and rejects material drift", async (t) => {
  for (const scenario of [
    { name: "exact durable projection", driftField: null },
    {
      name: "wrong provider request hash",
      driftField: "provider_request_sha256",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { db, testEnv, fake } = await prepareApprovedInvoice();
      await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
      db.failNextBatch = true;
      await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
      assert.equal(
        (
          db.raw
            .prepare(
              "SELECT state FROM quickbooks_final_invoice_outbox WHERE operation = 'bind'",
            )
            .get() as { state: string }
        ).state,
        "pending",
      );
      const bindCalls = () =>
        fake.requests.filter(
          (request) =>
            request.method === "POST" &&
            request.url.pathname.endsWith(".bind_provider_invoice"),
        ).length;
      assert.equal(bindCalls(), 1);
      fake.projectionDriftField = scenario.driftField;

      await recoverQuickBooksFinalInvoices(
        testEnv,
        fake.fetcher,
        new Date(NOW.getTime() + 10 * 60_000),
      );
      assert.equal(
        bindCalls(),
        1,
        "exact replay must not repeat the Frappe mutation",
      );
      const bind = db.raw
        .prepare(
          "SELECT state, attempt_count, detail_code FROM quickbooks_final_invoice_outbox WHERE operation = 'bind'",
        )
        .get() as {
        state: string;
        attempt_count: number;
        detail_code: string | null;
      };
      if (scenario.driftField === null) {
        assert.equal(bind.state, "succeeded");
        assert.equal(bind.attempt_count, 2);
      } else {
        assert.equal(bind.state, "pending");
        assert.equal(bind.detail_code, "quickbooks_frappe_bind_pending");
        assert.equal(
          (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
          "reconciliation_required",
        );
      }
    });
  }
});

test("official subtotal lines and explicit settlement states reconcile; unknown status and one-cent drift do not", async (t) => {
  for (const scenario of [
    {
      name: "missing status is Unverified when the full balance remains",
      invoice: quickBooksInvoice(),
      status: "Unverified",
    },
    {
      name: "paid",
      invoice: quickBooksInvoice({
        Balance: 0,
        invoiceStatus: "PAID_NOT_DEPOSITED",
      }),
      status: "Paid",
    },
    {
      name: "partially paid",
      invoice: quickBooksInvoice({
        Balance: 500,
        invoiceStatus: "PARTIALLY_PAID",
      }),
      status: "Partially Paid",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { db, testEnv, fake } = await prepareApprovedInvoice(
        scenario.invoice,
      );
      for (let step = 0; step < 4; step += 1)
        await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
      assert.equal(
        (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
        "matched",
      );
      assert.equal(fake.resolverPayloads.length, 1);
      assert.equal(fake.resolverPayloads[0]?.payment_status, scenario.status);
      assert.equal(fake.resolverPayloads[0]?.invoice_date, "2026-08-13");
      assert.equal(fake.resolverPayloads[0]?.subtotal, "1000.00");
      assert.deepEqual(
        {
          ...(db.raw
            .prepare(
              `SELECT outcome_code, payment_status FROM quickbooks_final_invoice_observations
          ORDER BY checked_at ASC LIMIT 1`,
            )
            .get() as Record<string, unknown>),
        },
        {
          outcome_code: "exact_match",
          payment_status: scenario.status,
        },
      );
    });
  }

  for (const providerStatus of [
    "UNKNOWN_NEW_STATE",
    "FAILED",
    "DISPUTED",
    "VOIDED",
  ]) {
    await t.test(
      `${providerStatus} provider status requires reconciliation`,
      async () => {
        const { testEnv, fake } = await prepareApprovedInvoice(
          quickBooksInvoice({ invoiceStatus: providerStatus }),
        );
        for (let step = 0; step < 3; step += 1)
          await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
        assert.equal(
          (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
          "reconciliation_required",
        );
        assert.equal(fake.resolverPayloads.length, 0);
      },
    );
  }

  for (const drift of [
    {
      name: "total",
      detailCode: "quickbooks_readback_drift",
      change: (invoice: Record<string, unknown>) => {
        invoice.TotalAmt = 1050.01;
      },
    },
    {
      name: "line",
      detailCode: "quickbooks_readback_unverified",
      change: (invoice: Record<string, unknown>) => {
        (invoice.Line as Array<Record<string, unknown>>)[0]!.Amount = 999.99;
      },
    },
    {
      name: "tax",
      detailCode: "quickbooks_readback_drift",
      change: (invoice: Record<string, unknown>) => {
        (invoice.TxnTaxDetail as Record<string, unknown>).TotalTax = 50.01;
      },
    },
  ]) {
    await t.test(
      `one-cent ${drift.name} drift requires reconciliation`,
      async () => {
        const invoice = quickBooksInvoice({ invoiceStatus: "DUE_SENT" });
        drift.change(invoice);
        const { db, testEnv, fake } = await prepareApprovedInvoice(invoice);
        for (let step = 0; step < 4; step += 1)
          await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
        assert.equal(
          (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
          "reconciliation_required",
        );
        assert.equal(fake.resolverPayloads.length, 0);
        assert.deepEqual(
          {
            ...(db.raw
              .prepare(
                "SELECT state, detail_code FROM quickbooks_final_invoice_outbox WHERE operation = 'submit'",
              )
              .get() as { state: string; detail_code: string }),
          },
          {
            state: "unknown",
            detail_code: drift.detailCode,
          },
        );
        assert.equal(
          (
            db.raw
              .prepare(
                "SELECT COUNT(*) AS count FROM quickbooks_final_invoice_observations",
              )
              .get() as { count: number }
          ).count,
          0,
        );
      },
    );
  }

  for (const invalidLine of [
    {
      name: "subtotal amount",
      change: (lines: Array<Record<string, unknown>>) => {
        lines[1]!.Amount = 999.99;
      },
    },
    {
      name: "duplicate subtotal",
      change: (lines: Array<Record<string, unknown>>) => {
        lines.push({ ...lines[1]! });
      },
    },
    {
      name: "unsupported non-sales",
      change: (lines: Array<Record<string, unknown>>) => {
        lines.push({
          Amount: 0,
          DetailType: "DescriptionOnly",
          DescriptionLineDetail: {},
        });
      },
    },
  ]) {
    await t.test(
      `${invalidLine.name} line requires reconciliation`,
      async () => {
        const invoice = quickBooksInvoice({ invoiceStatus: "DUE_SENT" });
        invalidLine.change(invoice.Line as Array<Record<string, unknown>>);
        const { testEnv, fake } = await prepareApprovedInvoice(invoice);
        for (let step = 0; step < 3; step += 1)
          await recoverQuickBooksFinalInvoices(testEnv, fake.fetcher, NOW);
        assert.equal(
          (await getQuickBooksFinalInvoice(testEnv, TENANT, INTENT))?.state,
          "reconciliation_required",
        );
        assert.equal(fake.resolverPayloads.length, 0);
      },
    );
  }
});
