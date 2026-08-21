import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, mock, test } from "node:test";

import worker from "../src/index.ts";
import { handleCustomerPortalLinks } from "../src/customer-portal.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";

const NOW = "2026-07-16T10:00:00.000Z";
const NATIVE_TERMS_JSON = JSON.stringify({
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
});
const NATIVE_TERMS_HASH = createHash("sha256")
  .update(NATIVE_TERMS_JSON)
  .digest("hex");

mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
after(() => mock.timers.reset());

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor(nativeChains: 0 | 1 | 2 = 1) {
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
    installNativePortalSchema(this.raw);
    seedNativePortal(this.raw);
    if (nativeChains === 0) {
      this.raw.exec(`
        DELETE FROM commercial_proposal_publication_events;
        DELETE FROM commercial_proposal_revisions;
        DELETE FROM commercial_quote_revisions;
      `);
    }
    if (nativeChains === 2) seedNativeAcceptanceChain(this.raw, "alternate");
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
    RAW: {
      async head() {
        return null;
      },
      async put() {
        return {};
      },
    } as never,
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
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "true",
  } as AppEnv;
}

function seedNativeAcceptanceChain(db: DatabaseSync, suffix: string): void {
  const quoteRevisionId = `quote-revision:${suffix}:1`;
  const quoteId = `customer-quote:${suffix}`;
  const proposalRevisionId = `proposal-revision:${suffix}:1`;
  const proposalPackId = `proposal-pack:${suffix}`;
  const createdAt = "2026-07-16T09:00:00.000Z";
  db.prepare(
    `INSERT INTO commercial_quote_revisions
       (quote_revision_id, tenant_id, customer_quote_id, revision_number,
        roof_job_id, customer_id, status, currency, valid_until, total_cents,
        terms_json, terms_hash, created_at)
     VALUES (?, 'ironwrap', ?, 1, 'JOB-A', 'CUSTOMER-A', 'approved',
             'CAD', '2099-12-31', 1000000, ?, ?, ?)`,
  ).run(
    quoteRevisionId,
    quoteId,
    NATIVE_TERMS_JSON,
    NATIVE_TERMS_HASH,
    createdAt,
  );
  db.prepare(
    `INSERT INTO commercial_proposal_revisions
       (proposal_revision_id, tenant_id, proposal_pack_id, revision_number,
        quote_revision_id, roof_job_id, customer_id, title, summary, terms_json,
        terms_hash, created_at)
     VALUES (?, 'ironwrap', ?, 1, ?, 'JOB-A', 'CUSTOMER-A',
             'Alternate roof', 'Alternate published proposal', ?, ?, ?)`,
  ).run(
    proposalRevisionId,
    proposalPackId,
    quoteRevisionId,
    NATIVE_TERMS_JSON,
    NATIVE_TERMS_HASH,
    createdAt,
  );
  db.prepare(
    `INSERT INTO commercial_proposal_publication_events
       (publication_event_id, tenant_id, proposal_revision_id,
        proposal_pack_id, publication_version, state, occurred_at)
     VALUES (?, 'ironwrap', ?, ?, 1, 'published', ?)`,
  ).run(
    `publication-event:${suffix}:1`,
    proposalRevisionId,
    proposalPackId,
    createdAt,
  );
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

function issueRequest(expiresAt = ISSUE_EXPIRES_AT): Request {
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

function installNetworkGuard() {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("customer_portal_network_read_forbidden");
  };
  return {
    requests: () => requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installNativePortalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE operating_roof_jobs (
      roof_job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      property_id TEXT, brand TEXT, job_number TEXT, service_type TEXT NOT NULL,
      job_status TEXT, current_gate_state TEXT NOT NULL, version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE operating_customers (
      customer_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT,
      contact_email TEXT, contact_phone TEXT, lifecycle_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE operating_properties (
      property_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, address_line1 TEXT,
      city TEXT, province TEXT, postal_code TEXT, country TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE commercial_quote_revisions (
      quote_revision_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_quote_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, roof_job_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      status TEXT NOT NULL, currency TEXT NOT NULL, valid_until TEXT NOT NULL,
      total_cents INTEGER NOT NULL, terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE commercial_proposal_revisions (
      proposal_revision_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, proposal_pack_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, quote_revision_id TEXT NOT NULL, roof_job_id TEXT NOT NULL,
      customer_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE commercial_proposal_publication_events (
      publication_event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      proposal_revision_id TEXT NOT NULL, proposal_pack_id TEXT NOT NULL,
      publication_version INTEGER NOT NULL, state TEXT NOT NULL, occurred_at TEXT NOT NULL
    );
    CREATE TABLE commercial_acceptance_bindings (
      acceptance_binding_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      quote_revision_id TEXT NOT NULL, proposal_revision_id TEXT NOT NULL,
      roof_job_id TEXT NOT NULL, customer_id TEXT NOT NULL, terms_hash TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    );
  `);
}

function seedNativePortal(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, display_name, contact_email, contact_phone,
        lifecycle_status, updated_at)
     VALUES ('CUSTOMER-A', 'ironwrap', 'Customer A', 'customer@example.com',
             '4035550100', 'active', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, customer_id, property_id, brand, job_number,
        service_type, job_status, current_gate_state, version, updated_at)
     VALUES ('JOB-A', 'ironwrap', 'CUSTOMER-A', NULL, 'ironwrap', 'IW-2026-100',
             'Roofing', 'in_progress', 'materials_ready', 1, ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO commercial_quote_revisions
       (quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
        customer_id, status, currency, valid_until, total_cents, terms_json, terms_hash, created_at)
     VALUES ('QUOTE-REV-A-1', 'ironwrap', 'QUOTE-A', 2, 'JOB-A', 'CUSTOMER-A',
             'approved', 'CAD', '2026-07-31', 1475000, ?, ?, ?)`,
  ).run(
    NATIVE_TERMS_JSON,
    NATIVE_TERMS_HASH,
    NOW,
  );
  db.prepare(
    `INSERT INTO commercial_proposal_revisions
       (proposal_revision_id, tenant_id, proposal_pack_id, revision_number,
        quote_revision_id, roof_job_id, customer_id, title, summary, terms_json,
        terms_hash, created_at)
     VALUES ('PROPOSAL-REV-A', 'ironwrap', 'PACK-A', 1, 'QUOTE-REV-A-1', 'JOB-A',
             'CUSTOMER-A', 'Roof replacement', 'Published customer proposal', ?, ?, ?)`,
  ).run(
    NATIVE_TERMS_JSON,
    NATIVE_TERMS_HASH,
    NOW,
  );
  db.prepare(
    `INSERT INTO commercial_proposal_publication_events
       (publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
        publication_version, state, occurred_at)
     VALUES ('PUBLICATION-EVENT-A-0001', 'ironwrap', 'PROPOSAL-REV-A', 'PACK-A',
             1, 'published', ?)`,
  ).run(NOW);
}

test("customer portal is fragment-only, revocable, and projects no internal fields", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
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
    assert.deepEqual(model.scope, []);
    assert.deepEqual(model.progress, []);
    assert.equal(
      (model.job as { job_number: string }).job_number,
      "IW-2026-100",
    );
    assert.equal(
      (model.proposal as { quote: { total: number } }).quote.total,
      14_750,
    );
    assert.equal(model.closeout, null);
    assert.equal(model.warranty, null);
    assert.equal(model.brand, "IronWrap Exteriors");
    assert.equal(model.contract_acceptance_available, true);
    assert.equal(model.material_decision_available, false);
    assert.deepEqual(model.option_packages, []);
    const serialised = JSON.stringify(model);
    for (const forbidden of [
      "never-customer-visible",
      "private://proposal-source",
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `leaked ${forbidden}`,
      );
    }
    assert.equal(network.requests(), 0);

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
    network.restore();
  }
});

test("customer portal offers contract acceptance only for one exact native chain", async () => {
  for (const nativeChains of [0, 1, 2] as const) {
    const db = new SqliteD1(nativeChains);
    const appEnv = env(db);
    const network = installNetworkGuard();
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

      const resolved = await worker.fetch(
        resolveRequest(token),
        appEnv as never,
        {} as never,
      );
      assert.equal(resolved.status, 200, `nativeChains=${nativeChains}`);
      const model = (await resolved.json()) as Record<string, unknown>;
      assert.equal(
        model.contract_acceptance_available,
        nativeChains === 1,
        `nativeChains=${nativeChains}`,
      );
    } finally {
      network.restore();
    }
  }
});

test("customer portal reveals only the exact currently published native proposal", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
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

    db.raw.exec("DELETE FROM commercial_proposal_publication_events");
    const unpublished = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const unpublishedModel = (await unpublished.json()) as Record<
      string,
      unknown
    >;
    assert.equal(unpublished.status, 200);
    assert.equal(unpublishedModel.proposal, null);
    assert.equal(JSON.stringify(unpublishedModel).includes("14750"), false);

    db.raw
      .prepare(
        `INSERT INTO commercial_proposal_publication_events
         (publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
          publication_version, state, occurred_at)
       VALUES ('PUBLICATION-EVENT-A-0001', 'ironwrap', 'PROPOSAL-REV-A', 'PACK-A',
               1, 'published', ?)`,
      )
      .run(NOW);
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
    assert.deepEqual(publishedModel.scope, []);

    db.raw
      .prepare(
        `INSERT INTO commercial_proposal_publication_events
         (publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
          publication_version, state, occurred_at)
       VALUES ('PUBLICATION-EVENT-A-0002', 'ironwrap', 'PROPOSAL-REV-A', 'PACK-A',
               2, 'withdrawn', '2026-07-16T10:01:00.000Z')`,
      )
      .run();
    const withdrawn = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    const withdrawnModel = (await withdrawn.json()) as Record<string, unknown>;
    assert.equal(withdrawnModel.proposal, null);
    assert.equal(JSON.stringify(withdrawnModel).includes("14750"), false);
    assert.equal(network.requests(), 0);
  } finally {
    network.restore();
  }
});

test("customer portal withholds ambiguous simultaneously published proposal packs", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
  try {
    db.raw
      .prepare(
        `INSERT INTO commercial_quote_revisions
         (quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
          customer_id, status, currency, valid_until, total_cents, terms_json, terms_hash, created_at)
       VALUES ('QUOTE-REV-B', 'ironwrap', 'QUOTE-B', 1, 'JOB-A', 'CUSTOMER-A',
               'approved', 'CAD', '2026-08-31', 2000000, ?, ?, '2026-07-16T10:02:00.000Z')`,
      )
      .run(JSON.stringify({ version: "b" }), "b".repeat(64));
    db.raw
      .prepare(
        `INSERT INTO commercial_proposal_revisions
         (proposal_revision_id, tenant_id, proposal_pack_id, revision_number,
          quote_revision_id, roof_job_id, customer_id, title, summary, terms_json,
          terms_hash, created_at)
       VALUES ('PROPOSAL-REV-B', 'ironwrap', 'PACK-B', 1, 'QUOTE-REV-B', 'JOB-A',
               'CUSTOMER-A', 'Alternate roof', 'Second published proposal', ?, ?,
               '2026-07-16T10:03:00.000Z')`,
      )
      .run(JSON.stringify({ version: "b" }), "b".repeat(64));
    db.raw
      .prepare(
        `INSERT INTO commercial_proposal_publication_events
         (publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
          publication_version, state, occurred_at)
       VALUES ('PUBLICATION-EVENT-B-0001', 'ironwrap', 'PROPOSAL-REV-B', 'PACK-B',
               1, 'published', '2026-07-16T10:04:00.000Z')`,
      )
      .run();

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
    const resolved = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    assert.equal(
      ((await resolved.json()) as { proposal: unknown }).proposal,
      null,
    );
    assert.equal(network.requests(), 0);
  } finally {
    network.restore();
  }
});

test("customer portal fails closed for an untrusted origin, customer reassignment, and a saturated IP window", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
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

    db.raw
      .prepare("UPDATE operating_roof_jobs SET customer_id = 'CUSTOMER-B'")
      .run();
    const reassigned = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(reassigned.status, 404);

    db.raw
      .prepare("UPDATE operating_roof_jobs SET customer_id = 'CUSTOMER-A'")
      .run();
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
    network.restore();
  }
});

test("customer portal fails closed when its revocation control plane is unavailable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
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
    network.restore();
  }
});

test("customer portal projects iRoof branding from the job record", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const network = installNetworkGuard();
  db.raw
    .prepare(
      "UPDATE operating_roof_jobs SET brand = 'iroof', job_number = 'IR-2026-100'",
    )
    .run();
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

    const resolved = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.brand, "iRoof Alberta");
  } finally {
    network.restore();
  }
});

test("customer portal withholds contract acceptance when the backend flow is disabled", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "false",
  } as AppEnv;
  const network = installNetworkGuard();
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

    const resolved = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, false);
  } finally {
    network.restore();
  }
});

test("customer portal ignores retired dedicated Frappe acceptance credentials", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: "",
  } as AppEnv;
  const network = installNetworkGuard();
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

    const resolved = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, true);
  } finally {
    network.restore();
  }
});

test("customer portal ignores the retired acceptance HMAC secret", async () => {
  const db = new SqliteD1();
  const appEnv = {
    ...env(db),
    APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: "short-hmac-secret",
  } as AppEnv;
  const network = installNetworkGuard();
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

    const resolved = await worker.fetch(
      resolveRequest(token),
      appEnv as never,
      {} as never,
    );
    assert.equal(resolved.status, 200);
    const model = (await resolved.json()) as Record<string, unknown>;
    assert.equal(model.contract_acceptance_available, true);
  } finally {
    network.restore();
  }
});
