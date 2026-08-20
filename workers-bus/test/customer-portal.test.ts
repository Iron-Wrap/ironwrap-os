import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, mock, test } from "node:test";

import worker from "../src/index.ts";
import { handleCustomerPortalLinks } from "../src/customer-portal.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";

const NOW = "2026-07-16T10:00:00.000Z";

mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
after(() => mock.timers.reset());

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(
      readFileSync(
        new URL("../migrations/0011_app_bff_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    this.raw.exec(
      readFileSync(
        new URL(
          "../migrations/0018_customer_portal_links.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.raw
      .prepare(
        `INSERT INTO app_users (
         user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
         active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'owner', ?, 1, 'seed', ?, ?)`,
      )
      .run(
        "appu_owner_0001",
        "ironwrap",
        "owner@example.com",
        "Owner",
        "owner@example.com",
        NOW,
        NOW,
      );
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args),
    };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return result;
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

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

function env(db: SqliteD1): AppEnv {
  return {
    DB: db as never,
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "https://app.example.com",
    APP_ALLOWED_ORIGINS: "https://app.example.com",
    APP_AUTH_PEPPER:
      "customer-portal-test-pepper-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    FROM_EMAIL: "portal@example.com",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-read-key",
    ERPNEXT_API_SECRET: "frappe-read-secret",
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "true",
    APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: "acceptance-frappe-key",
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET: "acceptance-frappe-secret",
  } as AppEnv;
}

function owner(): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "customer-portal-csrf",
    permissions: ["session:read", "jobs:read:any"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW,
      session_expires_at: "2026-07-17T10:00:00.000Z",
      revoked_at: null,
      user_id: "appu_owner_0001",
      tenant_id: "ironwrap",
      email_normalized: "owner@example.com",
      display_name: "Owner",
      role: "owner",
      frappe_user_id: "owner@example.com",
      active: 1,
      created_by: "seed",
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

const ISSUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUE_EXPIRES_AT = new Date(
  new Date(NOW).getTime() + ISSUE_TTL_MS,
).toISOString();

function issueRequest(
  expiresAt = ISSUE_EXPIRES_AT,
): Request {
  return new Request("https://app.example.com/api/v1/customer-portal/links", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.com",
      "x-csrf-token": "customer-portal-csrf",
    },
    body: JSON.stringify({ roof_job_id: "JOB-A", expires_at: expiresAt }),
  });
}

function resolveRequest(
  token: string,
  origin = "https://app.example.com",
): Request {
  return new Request("https://app.example.com/api/v1/customer-portal/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
}

function installFrappeMock() {
  const requests: Array<{
    doctype: string;
    fields: string[];
    filters: unknown[];
  }> = [];
  const rows: Record<string, Array<Record<string, unknown>>> = {
    "Roof Job": [
      {
        name: "JOB-A",
        roof_job_id: "job:lead-a",
        job_number: "IW-2026-100",
        brand: "ironwrap",
        service_type: "Roofing",
        job_status: "In Production",
        customer: "CUSTOMER-A",
        quotation: "QUOTE-A",
        modified: NOW,
        qb_invoice_ref: "never-customer-visible",
      },
    ],
    "Customer Quote": [
      {
        name: "QUOTE-A",
        customer_quote_id: "quote-a",
        roof_job: "JOB-A",
        customer: "CUSTOMER-A",
        quote_version: 2,
        status: "Approved",
        quote_total: 14_750,
        currency: "CAD",
        deposit_amount: 2_000,
        amount_due: 14_750,
        amount_paid: 0,
        balance_due: 14_750,
        payment_status: "Deposit Due",
        payment_due_date: "2026-07-20",
        valid_until: "2026-07-31",
        approved_at: NOW,
        accepted_at: null,
        scope_summary: "Install the approved roofing system.",
        assumptions: "Access remains clear.",
        exclusions: "Hidden substrate repairs need approval.",
        price_rule_snapshot_json: "internal-price-rule",
        notes: "internal-sales-note",
        modified: NOW,
      },
      {
        name: "QUOTE-DRAFT",
        customer_quote_id: "quote-draft",
        roof_job: "JOB-A",
        customer: "CUSTOMER-A",
        quote_version: 3,
        status: "Draft",
        quote_total: 999_999,
        currency: "CAD",
        modified: NOW,
      },
    ],
    "Proposal Evidence Pack": [
      {
        name: "PACK-A",
        pack_id: "pack-a",
        roof_job: "JOB-A",
        quotation: "QUOTE-A",
        status: "Sent",
        prepared_at: NOW,
        approved_at: NOW,
        signed_at: null,
        customer_message: "<script>private</script>",
        modified: NOW,
      },
    ],
    "Scope Clause": [
      {
        name: "SCOPE-A",
        scope_clause_id: "scope-a",
        roof_job: "JOB-A",
        customer_quote: "QUOTE-A",
        clause_type: "Included",
        title: "Approved roofing scope",
        clause_text: "Install approved roofing system.",
        version: "2",
        status: "Approved",
        customer_visible: 1,
        source_ref: "internal-source",
        modified: NOW,
      },
      {
        name: "SCOPE-HIDDEN",
        scope_clause_id: "scope-hidden",
        roof_job: "JOB-A",
        clause_type: "Internal",
        title: "Internal note",
        clause_text: "Never send this.",
        version: "1",
        status: "Approved",
        customer_visible: 0,
        modified: NOW,
      },
    ],
    "Evidence Item": [
      {
        name: "EVID-SAFE",
        evidence_id: "evidence-safe",
        roof_job: "JOB-A",
        evidence_type: "Photo",
        proof_slot: "Production",
        captured_at: NOW,
        customer_safe: 1,
        summary: "Roofing installation progress verified.",
        sync_state: "Verified",
        r2_key: "raw/private-photo",
        source_uri: "private://source",
        capture_actor: "crew@example.com",
        modified: NOW,
      },
      {
        name: "EVID-UNSAFE",
        evidence_id: "evidence-unsafe",
        roof_job: "JOB-A",
        evidence_type: "Photo",
        proof_slot: "Safety",
        captured_at: NOW,
        customer_safe: 0,
        summary: "Internal safety record.",
        sync_state: "Verified",
        modified: NOW,
      },
      {
        name: "EVID-UNVERIFIED",
        evidence_id: "evidence-unverified",
        roof_job: "JOB-A",
        evidence_type: "Photo",
        proof_slot: "Production",
        captured_at: NOW,
        customer_safe: 1,
        summary: "Not verified yet.",
        sync_state: "Queued",
        modified: NOW,
      },
    ],
    "Completion Packet": [
      {
        name: "COMPLETE-A",
        completion_packet_id: "completion-a",
        roof_job: "JOB-A",
        status: "Approved",
        approved_at: NOW,
        warranty_ready: 1,
        deficiency_list: "internal",
        modified: NOW,
      },
    ],
    "Warranty Packet": [
      {
        name: "WARRANTY-A",
        warranty_packet_id: "warranty-a",
        roof_job: "JOB-A",
        status: "Issued",
        material_system: "IronWrap Metal",
        warranty_terms: "Manufacturer and workmanship coverage.",
        coverage_start: "2026-07-16",
        coverage_years: 25,
        exclusions: "As stated in the approved warranty.",
        issued_at: NOW,
        notes: "internal closeout note",
        modified: NOW,
      },
    ],
    "Option Package": [
      {
        name: "OPT-BETTER",
        option_package_id: "opt-better",
        roof_job: "JOB-A",
        package_name: "Charcoal standing seam",
        tier: "Better",
        status: "Approved",
        material_system: "26ga standing seam steel",
        price_delta: 2_400,
        currency: "CAD",
        options_json: '{"colour":"Charcoal","panel_profile":"1.5in nail strip"}',
        warranty_summary: "40-year finish warranty",
        payment_assumptions: "internal payment assumption",
        approval_note: "internal approval note",
        scope_clause_ids_json: '["internal"]',
        notes: "internal estimator note",
        modified: NOW,
      },
      {
        name: "OPT-GOOD",
        option_package_id: "opt-good",
        roof_job: "JOB-A",
        package_name: "Weathered slate asphalt",
        tier: "Good",
        status: "Approved",
        material_system: "Architectural asphalt",
        price_delta: 0,
        currency: "CAD",
        options_json: "not json at all",
        warranty_summary: null,
        modified: NOW,
      },
      {
        name: "OPT-DRAFT",
        option_package_id: "opt-draft",
        roof_job: "JOB-A",
        package_name: "Copper accent (in progress)",
        tier: "Custom",
        status: "Draft",
        material_system: "Copper",
        price_delta: 41_000,
        currency: "CAD",
        options_json: "{}",
        modified: NOW,
      },
      {
        name: "OPT-OTHER-JOB",
        option_package_id: "opt-other-job",
        roof_job: "JOB-B",
        package_name: "Another customer's option",
        tier: "Best",
        status: "Approved",
        material_system: "Not this job",
        price_delta: 9_999,
        currency: "CAD",
        options_json: "{}",
        modified: NOW,
      },
    ],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const fields = JSON.parse(
      url.searchParams.get("fields") ?? "[]",
    ) as string[];
    const filters = JSON.parse(
      url.searchParams.get("filters") ?? "[]",
    ) as unknown[];
    requests.push({ doctype, fields, filters });
    const data = (rows[doctype] ?? [])
      .filter((row) => filters.every((filter) => matchesFilter(row, filter)))
      .map((row) =>
        Object.fromEntries(fields.map((field) => [field, row[field]])),
      );
    return Response.json({ data });
  };
  return {
    rows,
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function matchesFilter(row: Record<string, unknown>, filter: unknown): boolean {
  if (!Array.isArray(filter)) return false;
  const [, field, operator, value] = filter;
  return (
    operator === "=" && String(row[String(field)] ?? "") === String(value ?? "")
  );
}

test("customer portal is fragment-only, revocable, and projects no internal fields", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(
      issueRequest(),
      appEnv,
      owner(),
    );
    assert.equal(issued.status, 200);
    const issueBody = (await issued.json()) as {
      portal_url: string;
      link: { id: string };
    };
    const link = new URL(issueBody.portal_url);
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    assert.equal(link.pathname, "/portal");
    assert.equal(link.search, "");
    assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issueBody.portal_url.includes(`/portal/${token}`), false);

    const stored = db.raw
      .prepare(
        "SELECT token_hash, customer_id, issued_ip_hash, issued_user_agent_hash FROM customer_portal_links",
      )
      .get() as Record<string, string>;
    assert.notEqual(stored.token_hash, token);
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes(token!), false);
    assert.equal(stored.customer_id, "CUSTOMER-A");

    const scanner = await worker.fetch(
      new Request(
        "https://app.example.com/api/v1/customer-portal/resolve?token=never-use-query",
      ),
      appEnv as never,
      {} as never,
    );
    assert.equal(scanner.status, 404);

    const resolved = await worker.fetch(
      resolveRequest(token!),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get("cache-control"), "private, no-store");
    assert.equal(resolved.headers.get("referrer-policy"), "no-referrer");
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.deepEqual(
      (model.scope as Array<{ id: string }>).map((row) => row.id),
      ["scope-a"],
    );
    assert.deepEqual(
      (model.progress as Array<{ id: string }>).map((row) => row.id),
      ["evidence-safe"],
    );
    assert.equal(
      (model.job as { job_number: string }).job_number,
      "IW-2026-100",
    );
    assert.equal(
      (model.warranty as { coverage_years: number }).coverage_years,
      25,
    );
    assert.equal(model.brand, "IronWrap Exteriors");
    assert.equal(model.contract_acceptance_available, true);
    const serialised = JSON.stringify(model);
    for (const forbidden of [
      "raw/private-photo",
      "private://source",
      "crew@example.com",
      "internal-price-rule",
      "internal-sales-note",
      "<script>",
      "Never send this.",
      "internal closeout note",
      "999999",
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `leaked ${forbidden}`,
      );
    }
    const allFields = frappe.requests.flatMap((request) => request.fields);
    for (const forbiddenField of [
      "r2_key",
      "source_uri",
      "capture_actor",
      "price_rule_snapshot_json",
      "notes",
      "customer_message",
    ]) {
      assert.equal(
        allFields.includes(forbiddenField),
        false,
        `requested ${forbiddenField}`,
      );
    }

    const revoked = await handleCustomerPortalLinks(
      new Request(
        `https://app.example.com/api/v1/customer-portal/links/${issueBody.link.id}/revoke`,
        {
          method: "POST",
          headers: {
            origin: "https://app.example.com",
            "x-csrf-token": "customer-portal-csrf",
          },
        },
      ),
      appEnv,
      owner(),
    );
    assert.equal(revoked.status, 200);
    const afterRevoke = await worker.fetch(
      resolveRequest(token!),
      appEnv as never,
      {} as never,
    );
    assert.equal(afterRevoke.status, 404);
  } finally {
    frappe.restore();
  }
});

test("customer portal never projects quote terms before matching proposal publication", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const published = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const publishedModel = (await published.json()) as {
      proposal: { quote: { total: number } | null } | null;
      scope: Array<{ id: string }>;
    };
    assert.equal(published.status, 200);
    assert.equal(publishedModel.proposal?.quote?.total, 14_750);
    assert.deepEqual(
      publishedModel.scope.map((row) => row.id),
      ["scope-a"],
    );

    frappe.rows["Proposal Evidence Pack"][0].status = "Signed";
    const signed = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const signedModel = (await signed.json()) as {
      proposal: { quote: { total: number } | null } | null;
      scope: Array<{ id: string }>;
    };
    assert.equal(signedModel.proposal?.quote?.total, 14_750);
    assert.deepEqual(signedModel.scope.map((row) => row.id), ["scope-a"]);

    frappe.rows["Proposal Evidence Pack"][0].status = "Approved";
    frappe.rows["Scope Clause"][0].customer_quote = "QUOTE-OTHER";
    const wrongScopeQuote = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const wrongScopeQuoteModel = (await wrongScopeQuote.json()) as {
      proposal: { quote: { total: number } | null } | null;
      scope: unknown[];
    };
    assert.equal(wrongScopeQuoteModel.proposal?.quote?.total, 14_750);
    assert.deepEqual(wrongScopeQuoteModel.scope, []);

    frappe.rows["Scope Clause"][0].customer_quote = "QUOTE-A";
    frappe.rows["Proposal Evidence Pack"][0].status = "Draft";
    const unpublished = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const unpublishedModel = (await unpublished.json()) as Record<string, unknown>;
    assert.equal(unpublished.status, 200);
    assert.equal(unpublishedModel.proposal, null);
    assert.deepEqual(unpublishedModel.scope, []);
    assert.equal(JSON.stringify(unpublishedModel).includes("14750"), false);
    assert.equal(
      JSON.stringify(unpublishedModel).includes("Install the approved roofing system."),
      false,
    );

    frappe.rows["Proposal Evidence Pack"][0].status = "Approved";
    frappe.rows["Proposal Evidence Pack"][0].quotation = "QUOTE-OTHER";
    const wrongQuote = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const wrongQuoteModel = (await wrongQuote.json()) as Record<string, unknown>;
    assert.equal(wrongQuoteModel.proposal, null);
    assert.deepEqual(wrongQuoteModel.scope, []);
  } finally {
    frappe.restore();
  }
});

test("customer portal fails closed for an untrusted origin, customer reassignment, and a saturated IP window", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(
      issueRequest(),
      appEnv,
      owner(),
    );
    const { portal_url: portalUrl } = (await issued.json()) as {
      portal_url: string;
    };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get(
      "token",
    )!;

    const untrusted = await worker.fetch(
      resolveRequest(token, "https://attacker.example"),
      appEnv as never,
      {} as never,
    );
    assert.equal(untrusted.status, 404);

    frappe.rows["Roof Job"][0].customer = "CUSTOMER-B";
    const reassigned = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(reassigned.status, 404);

    frappe.rows["Roof Job"][0].customer = "CUSTOMER-A";
    const ipHash = (
      db.raw
        .prepare("SELECT issued_ip_hash FROM customer_portal_links")
        .get() as { issued_ip_hash: string }
    ).issued_ip_hash;
    db.raw
      .prepare(
        `UPDATE customer_portal_access_throttles
       SET window_started_at = ?, window_expires_at = ?, attempts = ?, updated_at = ?
       WHERE tenant_id = ? AND ip_hash = ?`,
      )
      .run(
        "2026-07-16T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        120,
        NOW,
        "ironwrap",
        ipHash,
      );
    const throttled = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(throttled.status, 404);
  } finally {
    frappe.restore();
  }
});

test("customer portal fails closed when its revocation control plane is unavailable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(
      issueRequest(),
      appEnv,
      owner(),
    );
    const { portal_url: portalUrl } = (await issued.json()) as {
      portal_url: string;
    };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get(
      "token",
    )!;

    appEnv.APP_BFF_ENABLED = "false";
    const disabled = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(disabled.status, 503);

    appEnv.APP_BFF_ENABLED = "true";
    appEnv.FROM_EMAIL = "";
    const misconfigured = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(misconfigured.status, 503);
  } finally {
    frappe.restore();
  }
});


test("customer portal projects iRoof branding from the job record", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  frappe.rows["Roof Job"][0] = {
    ...frappe.rows["Roof Job"][0],
    brand: "iroof",
    job_number: "IR-2026-100",
  };
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.brand, "iRoof Alberta");
  } finally {
    frappe.restore();
  }
});

test("customer portal withholds contract acceptance when the backend flow is disabled", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "false",
  } as AppEnv;
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, false);
  } finally {
    frappe.restore();
  }
});


test("customer portal withholds contract acceptance when the backend flow is misconfigured", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: "",
  } as AppEnv;
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, false);
  } finally {
    frappe.restore();
  }
});


test("customer portal withholds contract acceptance when the HMAC secret is too short", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: "short-hmac-secret",
  } as AppEnv;
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, false);
  } finally {
    frappe.restore();
  }
});


test("customer portal projects only approved option packages for this job, with internals stripped", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as {
      option_packages: Array<Record<string, unknown>>;
    };

    // Good sorts before Better by the DocType's own tier order, not alphabetically.
    assert.deepEqual(
      model.option_packages.map((option) => option.id),
      ["opt-good", "opt-better"],
    );
    assert.deepEqual(model.option_packages[1], {
      id: "opt-better",
      package_name: "Charcoal standing seam",
      tier: "Better",
      material_system: "26ga standing seam steel",
      price_delta: 2_400,
      currency: "CAD",
      options: { colour: "Charcoal", panel_profile: "1.5in nail strip" },
      warranty_summary: "40-year finish warranty",
    });
    // Unparseable office JSON degrades to no detail list rather than failing the whole read.
    assert.equal(model.option_packages[0]!.options, null);

    const projected = JSON.stringify(model.option_packages);
    for (const internal of [
      "internal payment assumption",
      "internal approval note",
      "internal estimator note",
      "Copper accent (in progress)",
      "Another customer's option",
    ]) {
      assert.equal(projected.includes(internal), false, `leaked: ${internal}`);
    }

    // The customer read contract asked Frappe for the Approved filter too: a Draft package is
    // never fetched, not merely dropped after the fact.
    const optionRequest = frappe.requests.find(
      (request) => request.doctype === "Option Package",
    );
    assert.ok(optionRequest);
    assert.deepEqual(optionRequest.filters, [
      ["Option Package", "roof_job", "=", "JOB-A"],
      ["Option Package", "status", "=", "Approved"],
    ]);
    for (const field of ["approval_note", "payment_assumptions", "notes", "scope_clause_ids_json"]) {
      assert.equal(optionRequest.fields.includes(field), false, `requested: ${field}`);
    }
  } finally {
    frappe.restore();
  }
});


test("customer portal stays silent about materials when no option package is approved", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const frappe = installFrappeMock();
  frappe.rows["Option Package"] = [];
  try {
    const issued = await handleCustomerPortalLinks(issueRequest(), appEnv, owner());
    const { portal_url: portalUrl } = (await issued.json()) as { portal_url: string };
    const token = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get("token")!;

    const resolved = await worker.fetch(resolveRequest(token), appEnv as never, {} as never);
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.deepEqual(model.option_packages, []);
    // No decision credentials in this env, so the write half must advertise itself as unavailable.
    assert.equal(model.material_decision_available, false);
  } finally {
    frappe.restore();
  }
});
