import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { issueFacetLaunch } from "../src/facet-launch.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-user-0001";
const KEY_BYTES = Buffer.from("synthetic-facet-launch-key-32bytes!", "utf8");
const KEY = KEY_BYTES.toString("base64url");
const NOW = new Date("2027-01-15T08:00:00.000Z");
const LAUNCH_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/facet-v2-launch-roundtrip.json", import.meta.url),
    "utf8",
  ),
) as {
  key_base64url: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  expected: {
    token: string;
    envelope_sha256: string;
    producer_identity_link_id: string;
    external_project_link_id: string;
  };
};
const ROUTE = {
  version: 1,
  issuer: "facet",
  source_product: "facet",
  source_environment: "production",
  source_tenant_id: SOURCE,
  destination_tenant_id: TENANT,
  destination_url: "https://bus.example.invalid/ingest/facet-design",
};

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
          "../migrations/0043_facet_v2_signed_identity.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.raw
      .prepare(
        `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, 'owner@example.invalid', 'Synthetic Owner', 'owner',
               'owner@example.invalid', 1, 'test-fixture', ?, ?)`,
      )
      .run(OWNER, TENANT, NOW.toISOString(), NOW.toISOString());
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }

  async batch(statements: SqliteStatement[]) {
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

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return {
      success: true as const,
      meta: { changes: Number(result.changes) },
    };
  }
}

function env(db: SqliteD1): AppEnv {
  return {
    DB: db as never,
    APP_FACET_LAUNCH_ENABLED: "true",
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE,
    FACET_LAUNCH_HMAC_KEY: KEY,
    FACET_V2_ROUTES_JSON: JSON.stringify([ROUTE]),
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "5000",
  } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2027-01-15T20:00:00.000Z",
      revoked_at: null,
      user_id: role === "owner" ? OWNER : `${role}-user-0001`,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "test-fixture",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function installFrappeMock() {
  const original = globalThis.fetch;
  let quoteVersion = 3;
  let quoteCustomer = "CUSTOMER-1";
  let brandId = "ironwrap";
  let email: string | null = "customer@example.invalid";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const doctype = decodeURIComponent(
      new URL(request.url).pathname.split("/").at(-1) ?? "",
    );
    if (doctype === "Roof Job")
      return Response.json({
        data: [
          {
            name: "ROOF-JOB-DOC-1",
            roof_job_id: "roof-job-1",
            brand: brandId,
            customer: "CUSTOMER-1",
            quotation: "QUOTE-DOC-1",
            modified: NOW.toISOString(),
          },
        ],
      });
    if (doctype === "Customer Quote")
      return Response.json({
        data: [
          {
            name: "QUOTE-DOC-1",
            customer_quote_id: "customer-quote-1",
            roof_job: "ROOF-JOB-DOC-1",
            customer: quoteCustomer,
            quote_version: quoteVersion,
            status: "Approved",
            approved_at: "2027-01-15T07:00:00.000Z",
            modified: NOW.toISOString(),
          },
        ],
      });
    if (doctype === "Roofing Customer")
      return Response.json({
        data: email
          ? [
              {
                name: "CUSTOMER-1",
                email,
                modified: NOW.toISOString(),
              },
            ]
          : [],
      });
    return Response.json({ data: [] });
  };
  return {
    setBrand(value: string) {
      brandId = value;
    },
    setQuoteVersion(value: number) {
      quoteVersion = value;
    },
    setQuoteCustomer(value: string) {
      quoteCustomer = value;
    },
    clearEmail() {
      email = null;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function tokenFrom(
  result: Awaited<ReturnType<typeof issueFacetLaunch>>,
): string {
  assert.notEqual(result.kind, "rejected");
  if (result.kind === "rejected") throw new Error("launch rejected");
  return new URL(result.launch.launch_url).hash.slice("#iwlaunch=".length);
}

function decoded(token: string, part: number): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[part]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

test("signed launch creates one exact durable authority and deterministic private replay", async () => {
  const db = new SqliteD1();
  const mock = installFrappeMock();
  try {
    const first = await issueFacetLaunch(env(db), {
      tenantId: TENANT,
      jobName: "ROOF-JOB-DOC-1",
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0001",
      now: NOW,
      projectId: PROJECT,
    });
    assert.equal(first.kind, "created");
    const token = tokenFrom(first);
    assert.equal(KEY, LAUNCH_FIXTURE.key_base64url);
    assert.equal(token, LAUNCH_FIXTURE.expected.token);
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    assert.deepEqual(decoded(token, 0), LAUNCH_FIXTURE.header);
    const email = "customer@example.invalid";
    const customerPartyRef = sha256(
      `ironwrap.customer-party.email.v1\n${email}`,
    );
    const externalIdentity = `facet-customer-oidc-v1:${sha256(`facet.customer-oidc-email.v1\n${email}`)}`;
    assert.deepEqual(decoded(token, 1), LAUNCH_FIXTURE.payload);
    assert.equal(
      signature,
      createHmac("sha256", KEY_BYTES)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64url"),
    );
    const envelopeSha256 = sha256(token);
    assert.equal(envelopeSha256, LAUNCH_FIXTURE.expected.envelope_sha256);
    const identity = db.raw
      .prepare(
        `SELECT producer_identity_link_id, destination_tenant_id, source_tenant_id,
              issuer, source_environment, proof_sha256
         FROM facet_v2_producer_identity_links`,
      )
      .get();
    assert.deepEqual(
      { ...identity! },
      {
        producer_identity_link_id:
          LAUNCH_FIXTURE.expected.producer_identity_link_id,
        destination_tenant_id: TENANT,
        source_tenant_id: SOURCE,
        issuer: "facet",
        source_environment: "production",
        proof_sha256: envelopeSha256,
      },
    );
    const project = db.raw
      .prepare(
        `SELECT external_project_link_id, customer_party_ref,
              external_customer_identity_link_id, roof_job_id,
              customer_quote_id, project_claim_sha256 FROM facet_v2_project_links`,
      )
      .get();
    assert.deepEqual(
      { ...project! },
      {
        external_project_link_id:
          LAUNCH_FIXTURE.expected.external_project_link_id,
        customer_party_ref: customerPartyRef,
        external_customer_identity_link_id: externalIdentity,
        roof_job_id: "roof-job-1",
        customer_quote_id: "customer-quote-1",
        project_claim_sha256: envelopeSha256,
      },
    );
    const persisted = JSON.stringify({
      identity,
      project,
      launch: db.raw.prepare("SELECT * FROM facet_v2_project_launches").get(),
    });
    assert.equal(persisted.includes(email), false);
    assert.equal(persisted.includes(token), false);

    const replay = await issueFacetLaunch(env(db), {
      tenantId: TENANT,
      jobName: "ROOF-JOB-DOC-1",
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0001",
    });
    assert.equal(replay.kind, "replayed");
    assert.equal(tokenFrom(replay), token);

    mock.setBrand("iroof");
    const secondBrandProject = "33333333-3333-4333-8333-333333333333";
    const secondBrand = await issueFacetLaunch(env(db), {
      tenantId: TENANT,
      jobName: "ROOF-JOB-DOC-1",
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-iroof-0001",
      now: NOW,
      projectId: secondBrandProject,
    });
    assert.equal(secondBrand.kind, "created");
    assert.equal(decoded(tokenFrom(secondBrand), 1).brand_id, "iroof");
    assert.equal(
      Number(
        (
          db.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM facet_v2_producer_identity_links",
            )
            .get() as { count: number }
        ).count,
      ),
      1,
    );
    const brandProjects = db.raw
      .prepare(
        "SELECT brand_id FROM facet_v2_project_links ORDER BY facet_project_id",
      )
      .all() as Array<{ brand_id: string }>;
    assert.deepEqual(brandProjects.map((row) => row.brand_id).sort(), [
      "ironwrap",
      "iroof",
    ]);
    mock.setBrand("ironwrap");

    mock.setQuoteVersion(4);
    assert.deepEqual(
      await issueFacetLaunch(env(db), {
        tenantId: TENANT,
        jobName: "ROOF-JOB-DOC-1",
        actorUserId: OWNER,
        actorRole: "owner",
        idempotencyKey: "facet-launch:test-0001",
      }),
      {
        kind: "rejected",
        code: "facet_launch_idempotency_conflict",
        status: 409,
      },
    );
    mock.setQuoteVersion(3);

    const before = Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM facet_v2_project_launches")
          .get() as { count: number }
      ).count,
    );
    const collision = await issueFacetLaunch(env(db), {
      tenantId: TENANT,
      jobName: "ROOF-JOB-DOC-1",
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0002",
      now: NOW,
      projectId: PROJECT,
    });
    assert.deepEqual(collision, {
      kind: "rejected",
      code: "facet_launch_authority_collision",
      status: 409,
    });
    assert.equal(
      Number(
        (
          db.raw
            .prepare("SELECT COUNT(*) AS count FROM facet_v2_project_launches")
            .get() as { count: number }
        ).count,
      ),
      before,
    );

    const links = db.raw
      .prepare(
        "SELECT external_project_link_id, producer_identity_link_id, external_customer_identity_link_id FROM facet_v2_project_links",
      )
      .get() as Record<string, string>;
    db.raw
      .prepare(
        `INSERT INTO facet_v2_link_revocations
       (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
        destination_tenant_id, revoked_at)
       VALUES ('revoke-launch-0001', 'project', ?, 'test_revocation', ?, ?, ?)`,
      )
      .run(
        links.external_project_link_id,
        OWNER,
        TENANT,
        "2027-01-15T08:01:00.000Z",
      );
    assert.deepEqual(
      await issueFacetLaunch(env(db), {
        tenantId: TENANT,
        jobName: "ROOF-JOB-DOC-1",
        actorUserId: OWNER,
        actorRole: "owner",
        idempotencyKey: "facet-launch:test-0001",
      }),
      {
        kind: "rejected",
        code: "facet_launch_authority_collision",
        status: 409,
      },
    );
  } finally {
    mock.restore();
  }
});

test("launch fails closed on role, route, customer, and quote identity drift", async () => {
  const db = new SqliteD1();
  const mock = installFrappeMock();
  try {
    const base = {
      tenantId: TENANT,
      jobName: "ROOF-JOB-DOC-1",
      actorUserId: OWNER,
      idempotencyKey: "facet-launch:negative-0001",
      now: NOW,
      projectId: PROJECT,
    };
    assert.deepEqual(
      await issueFacetLaunch(env(db), { ...base, actorRole: "ops" }),
      {
        kind: "rejected",
        code: "facet_launch_owner_required",
        status: 403,
      },
    );
    assert.deepEqual(
      await issueFacetLaunch(
        {
          ...env(db),
          APP_FACET_LAUNCH_SOURCE_TENANT_ID:
            "33333333-3333-4333-8333-333333333333",
        },
        { ...base, actorRole: "owner" },
      ),
      {
        kind: "rejected",
        code: "facet_launch_not_configured",
        status: 503,
      },
    );
    mock.setQuoteCustomer("OTHER-CUSTOMER");
    assert.deepEqual(
      await issueFacetLaunch(env(db), { ...base, actorRole: "owner" }),
      {
        kind: "rejected",
        code: "facet_design_current_approved_quote_required",
        status: 409,
      },
    );
    mock.setQuoteCustomer("CUSTOMER-1");
    mock.clearEmail();
    assert.deepEqual(
      await issueFacetLaunch(env(db), { ...base, actorRole: "owner" }),
      {
        kind: "rejected",
        code: "facet_launch_customer_identity_required",
        status: 409,
      },
    );
  } finally {
    mock.restore();
  }
});

test("owner BFF launch route requires CSRF, exact empty body, and stable idempotency", async () => {
  const db = new SqliteD1();
  const mock = installFrappeMock();
  try {
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(
        "https://app.example.invalid/api/v1/estimator/jobs/ROOF-JOB-DOC-1/facet-launches",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            {},
            {
              "x-csrf-token": "csrf",
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          env(db),
          auth("ops"),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            {},
            {
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          env(db),
          auth("owner"),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            { extra: true },
            {
              "x-csrf-token": "csrf",
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          env(db),
          auth("owner"),
        )
      ).status,
      400,
    );
    const created = await handleAuthenticatedRoute(
      request(
        {},
        {
          "x-csrf-token": "csrf",
          "idempotency-key": "facet-launch:api-0001",
        },
      ),
      env(db),
      auth("owner"),
    );
    assert.equal(created.status, 201);
    const payload = (await created.json()) as Record<string, unknown>;
    assert.deepEqual(payload.allowed_actions, ["facet_launch.create"]);
    assert.equal((payload.launch as Record<string, unknown>).state, "issued");
    const replay = await handleAuthenticatedRoute(
      request(
        {},
        {
          "x-csrf-token": "csrf",
          "idempotency-key": "facet-launch:api-0001",
        },
      ),
      env(db),
      auth("owner"),
    );
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as Record<string, unknown>).replayed,
      true,
    );
  } finally {
    mock.restore();
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
