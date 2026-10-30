import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { buildSalesReadModel } from "../src/app-read-models.ts";
import { admitCommercialPermit, type CommercialAction } from "../src/commercial-authority.ts";
import {
  prepareCommercialQuote,
  recordCommercialProposalRevision,
  recordCommercialQuoteRevision,
  type RecordCommercialQuoteInput,
} from "../src/commercial-store.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";
import worker from "../src/index.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const NOW = new Date("2026-08-20T12:00:00.000Z");
/**
 * Seeding runs at the pinned `NOW`, but the routes admit their own permits off the wall clock,
 * so the policy window has to contain both. Pinned to the calendar it would stop containing the
 * wall clock on the day it ends, and every route would answer 409 `commercial_policy_not_current`.
 */
const A_DAY = 24 * 60 * 60_000;
const POLICY_VALID_FROM = new Date(
  Math.min(Date.now(), NOW.getTime()) - A_DAY,
).toISOString();
const POLICY_VALID_UNTIL = new Date(
  Math.max(Date.now(), NOW.getTime()) + A_DAY,
).toISOString();
/** Same reason: an approved quote the routes still accept has to outlive the wall clock. */
const QUOTE_VALID_UNTIL = new Date(Math.max(Date.now(), NOW.getTime()) + A_DAY)
  .toISOString()
  .slice(0, 10);
const OWNER_ID = "appu_owner_0001";
const OPS_ID = "appu_ops_0001";
const OTHER_OPS_ID = "appu_ops_0002";
const ENVELOPE_ID = "ow_commercial_api_0001";
const LEAD_ID = "lead:commercial:api:0001";
const CUSTOMER_ID = "customer:commercial:api:0001";
const JOB_ID = "job:commercial:api:0001";
const QUOTE_REVISION_ID = "quote-revision:commercial:api:0001";
const QUOTE_ID = "customer-quote:commercial:api:0001";
const EVIDENCE = [
  {
    ref: "r2://commercial/proposals/evidence-0001.json",
    sha256: "a".repeat(64),
  },
] as const;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
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
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
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

test("commercial proposal revision route admits a permit-backed proposal and replays identically", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    await seedApprovedQuote(env);
    const observedAt = new Date().toISOString();

    const first = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        proposalBody(observedAt),
        "commercial-proposal-api-0001",
      ),
      env,
      auth("ops"),
    );
    assert.equal(first.status, 201);
    const created = await first.json() as {
      replayed: boolean;
      permit: { permit_id: string; replayed: boolean };
      proposal: Record<string, unknown>;
    };
    assert.equal(created.replayed, false);
    assert.equal(created.permit.replayed, false);
    assert.equal(created.proposal.proposal_revision_id, "proposal-revision:commercial:api:0001");
    assert.equal(created.proposal.quote_revision_id, QUOTE_REVISION_ID);
    assert.equal(Object.hasOwn(created.proposal, "terms_json"), false);
    assert.equal(Object.hasOwn(created.proposal, "authority_evidence_digest"), false);

    const replay = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        proposalBody(observedAt),
        "commercial-proposal-api-0001",
      ),
      env,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as {
      replayed: boolean;
      permit: { permit_id: string; replayed: boolean };
      proposal: Record<string, unknown>;
    };
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.permit.replayed, true);
    assert.equal(replayed.permit.permit_id, created.permit.permit_id);
    assert.equal(replayed.proposal.proposal_revision_id, created.proposal.proposal_revision_id);

    const permitCount = db.raw.prepare(
      "SELECT count(*) AS count FROM commercial_authority_permits",
    ).get() as { count: number };
    const proposalCount = db.raw.prepare(
      "SELECT count(*) AS count FROM commercial_proposal_revisions",
    ).get() as { count: number };
    assert.equal(permitCount.count, 3);
    assert.equal(proposalCount.count, 1);
  } finally {
    db.close();
  }
});

test("commercial proposal revision route rejects body drift under the same idempotency key", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    await seedApprovedQuote(env);
    const observedAt = new Date().toISOString();

    const first = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        proposalBody(observedAt),
        "commercial-proposal-api-conflict",
      ),
      env,
      auth("ops"),
    );
    assert.equal(first.status, 201);

    const drift = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", {
        ...proposalBody(observedAt),
        content_hash: "b".repeat(64),
      }, "commercial-proposal-api-conflict"),
      env,
      auth("ops"),
    );
    assert.equal(drift.status, 409);
    assert.deepEqual(
      await drift.json(),
      { error: "commercial_permit_idempotency_conflict" },
    );
  } finally {
    db.close();
  }
});

test("commercial proposal revision route requires office preparation authority", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    await seedApprovedQuote(env);
    const observedAt = new Date().toISOString();
    const response = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        proposalBody(observedAt),
        "commercial-proposal-api-denied",
      ),
      env,
      auth("production"),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(
      await response.json(),
      { error: "office_role_required" },
    );
  } finally {
    db.close();
  }
});

test("native commercial triage is idempotent and drives Sales without Frappe", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("frappe_must_not_be_called");
  };
  try {
    const body = {
      lead_id: LEAD_ID,
      expected_lead_version: 1,
      lifecycle_status: "qualified",
      priority: "high",
      category: "storm damage",
      summary: "Hail report confirmed; verify access before inspection.",
      next_action: "Confirm the access window and book inspection.",
    };
    const first = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/lead-triage-decisions",
        body,
        "commercial-triage-api-0001",
      ),
      env,
      auth("ops"),
    );
    assert.equal(first.status, 201);
    await seedApprovedQuote(env, { alreadyQualified: true });
    const created = await first.json() as {
      replayed: boolean;
      decision: { lead_id: string; lead_version: number; lifecycle_status: string };
      permit: { permit_id: string; replayed: boolean };
    };
    assert.equal(created.replayed, false);
    assert.equal(created.decision.lead_id, LEAD_ID);
    assert.equal(created.decision.lead_version, 2);
    assert.equal(created.decision.lifecycle_status, "qualified");

    const replay = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/lead-triage-decisions",
        body,
        "commercial-triage-api-0001",
      ),
      env,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ...created, replayed: true, permit: {
      permit_id: created.permit.permit_id,
      replayed: true,
    } });

    const permit = db.raw.prepare(
      `SELECT actor_type, actor_id, evidence_refs_json FROM commercial_authority_permits
        WHERE permit_id = ?`,
    ).get(created.permit.permit_id) as {
      actor_type: string;
      actor_id: string;
      evidence_refs_json: string;
    };
    assert.equal(permit.actor_type, "worker");
    assert.equal(permit.actor_id, OPS_ID);
    const evidence = JSON.parse(permit.evidence_refs_json) as Array<{
      ref: string;
      sha256: string;
    }>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.ref, `d1://operating_leads/${LEAD_ID}/v1`);
    assert.match(evidence[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);

    const model = await buildSalesReadModel(env, auth("ops"));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(model.partial_sources, []);
    assert.equal(
      model.allowed_actions.includes("commercial.lead_triage.record"),
      true,
    );
    assert.equal(model.leads[0]?.id, LEAD_ID);
    assert.deepEqual(model.leads[0]?.triage, {
      status: "Qualified",
      summary: body.summary,
      version: 2,
    });
    assert.equal(model.leads[0]?.attention.includes("triage_unresolved"), false);
    assert.equal(model.leads[0]?.quote?.id, QUOTE_ID);
    assert.equal(model.leads[0]?.quote?.quote_total, 147);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("native commercial quote route binds the active job graph and replays", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: LEAD_ID,
        expected_lead_version: 1,
        lifecycle_status: "qualified",
        priority: "normal",
        category: "replacement",
        summary: "Qualified lead for native quote.",
        next_action: "Prepare the approved quote.",
      }, "commercial-quote-api-triage"),
      env,
      auth("ops"),
    );
    assert.equal(triage.status, 201);

    const body = quoteBody(new Date().toISOString());
    const first = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", body, "commercial-quote-api-route"),
      env,
      auth("ops"),
    );
    assert.equal(first.status, 201);
    const created = await first.json() as {
      replayed: boolean;
      quote: { quote_revision_id: string; total_cents: number };
      permit: { permit_id: string; replayed: boolean };
    };
    assert.equal(created.replayed, false);
    assert.equal(created.quote.quote_revision_id, QUOTE_REVISION_ID);
    assert.equal(created.quote.total_cents, 14_700);
    assert.equal(created.permit.replayed, false);

    const replay = await handleAuthenticatedRoute(
      request("/api/v1/commercial/quote-revisions", body, "commercial-quote-api-route"),
      env,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as typeof created;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.permit.permit_id, created.permit.permit_id);

    const facts = db.raw.prepare(
      `SELECT actor_type, actor_id, evidence_refs_json
         FROM commercial_authority_permits WHERE permit_id = ?`,
    ).get(created.permit.permit_id) as {
      actor_type: string;
      actor_id: string;
      evidence_refs_json: string;
    };
    assert.equal(facts.actor_type, "worker");
    assert.equal(facts.actor_id, OPS_ID);
    assert.equal(JSON.parse(facts.evidence_refs_json).length, 2);
  } finally {
    db.close();
  }
});

test("native publication route prepares authority and refuses an unverified effect", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: LEAD_ID,
        expected_lead_version: 1,
        lifecycle_status: "qualified",
        priority: "normal",
        category: "replacement",
        summary: "Qualified lead for publication.",
        next_action: "Prepare the customer proposal.",
      }, "commercial-publication-api-triage"),
      env,
      auth("ops"),
    );
    assert.equal(triage.status, 201);
    await seedApprovedQuote(env, { alreadyQualified: true });
    const proposal = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-revisions", proposalBody(new Date().toISOString()), "commercial-publication-api-proposal"),
      env,
      auth("ops"),
    );
    assert.equal(proposal.status, 201);
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        previous_state: "draft",
        state: "published",
        facts_observed_at: new Date().toISOString(),
        evidence: EVIDENCE,
      }, "commercial-publication-api-prepare"),
      env,
      auth("ops"),
    );
    assert.equal(prepared.status, 201);
    const packet = await prepared.json() as {
      permit: {
        permit_id: string;
        policy_ref: string;
        policy_version: string;
        action: string;
        aggregate_version: number;
        expires_at: string;
      };
    };
    assert.equal(packet.permit.action, "proposal.publish");
    assert.equal(packet.permit.aggregate_version, 1);

    const settlementBody = {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        previous_state: "draft",
        state: "published",
        permit_id: packet.permit.permit_id,
        external_effect_id: "effect:publication:unknown",
      };
    const settlement = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications", settlementBody, "commercial-publication-api-settle"),
      env,
      auth("ops"),
    );
    assert.equal(settlement.status, 409);
    assert.deepEqual(await settlement.json(), { error: "commercial_publication_effect_mismatch" });
    const count = db.raw.prepare(
      "SELECT count(*) AS count FROM commercial_proposal_publication_events",
    ).get() as { count: number };
    assert.equal(count.count, 0);

    const expectedReadback = {
      proposal_revision_id: "proposal-revision:commercial:api:0001",
      proposal_pack_id: "proposal-pack:commercial:api:0001",
      publication_version: 1,
      state: "published",
    };
    const succeededEffect = await runExternalEffect(
      env,
      {
        effectId: "effect:publication:succeeded",
        tenantId: TENANT,
        actor: { type: "worker", id: OPS_ID },
        taskId: "task:commercial-publication",
        authority: {
          permitRef: packet.permit.permit_id,
          policyRef: packet.permit.policy_ref,
          policyVersion: packet.permit.policy_version,
          tenantId: TENANT,
          actorType: "worker",
          actorId: OPS_ID,
          expiresAt: packet.permit.expires_at,
          allowedActions: ["proposal.publish"],
        },
        aggregate: {
          type: "proposal_publication",
          id: "proposal-pack:commercial:api:0001",
          version: 1,
        },
        intentId: "proposal-revision:commercial:api:0001",
        action: "proposal.publish",
        request: expectedReadback,
        provider: "native-commercial-publication",
        idempotencyKey: "effect:publication:succeeded:key",
        deadlineAt: new Date(Date.parse(packet.permit.expires_at) - 1_000).toISOString(),
        expectedReadback,
        correlationId: "commercial-publication-correlation",
      },
      {
        async dispatch() {
          return {
            outcome: "accepted" as const,
            value: { published: true },
            providerExternalId: "provider-publication-0001",
            providerResponse: { id: "provider-publication-0001" },
            readback: {
              status: "match" as const,
              providerExternalId: "provider-publication-0001",
              observed: expectedReadback,
            },
          };
        },
        async replay() {
          return { published: true };
        },
      },
    );

    const otherUser = otherOpsAuth();
    const refused = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-publications",
        { ...settlementBody, external_effect_id: succeededEffect.effect.effect_id },
        "commercial-publication-api-settle-other-user",
      ),
      env,
      otherUser,
    );
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "commercial_permit_actor_mismatch" });

    const settled = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-publications",
        { ...settlementBody, external_effect_id: succeededEffect.effect.effect_id },
        "commercial-publication-api-settle-success",
      ),
      env,
      auth("ops"),
    );
    assert.equal(settled.status, 201);
    const settledBody = await settled.json() as {
      replayed: boolean;
      publication: { state: string; external_effect_id: string | null };
    };
    assert.equal(settledBody.replayed, false);
    assert.equal(settledBody.publication.state, "published");
    assert.equal(settledBody.publication.external_effect_id, succeededEffect.effect.effect_id);

    const replay = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-publications",
        { ...settlementBody, external_effect_id: succeededEffect.effect.effect_id },
        "commercial-publication-api-settle-success",
      ),
      env,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);

    const settledCount = db.raw.prepare(
      "SELECT count(*) AS count FROM commercial_proposal_publication_events",
    ).get() as { count: number };
    assert.equal(settledCount.count, 1);
  } finally {
    db.close();
  }
});

test("lower-level commercial quote and proposal seams fail closed before lead qualification", async () => {
  for (const lifecycleStatus of ["untriaged", "triaged", "disqualified"] as const) {
    const db = new SqliteD1();
    const env = commercialEnv(db);
    try {
      db.raw.prepare(
        "UPDATE operating_leads SET lifecycle_status = ?, version = version + 1 WHERE tenant_id = ? AND lead_id = ?",
      ).run(lifecycleStatus, TENANT, LEAD_ID);
      await assert.rejects(
        () => seedApprovedQuote(env, { alreadyQualified: true }),
        (error: unknown) => error instanceof Error && error.message === "commercial_lead_not_qualified",
      );
      assert.equal(
        (db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_quote_revisions").get() as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
  }

  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    await seedApprovedQuote(env);
    const mismatchedTerms = await handleAuthenticatedRoute(
      request(
        "/api/v1/commercial/proposal-revisions",
        { ...proposalBody(new Date().toISOString()), terms: { ...TERMS, deposit_percent: 50 } },
        "commercial-proposal-terms-mismatch",
      ),
      env,
      auth("ops"),
    );
    assert.equal(mismatchedTerms.status, 409);
    assert.deepEqual(await mismatchedTerms.json(), { error: "commercial_proposal_quote_mismatch" });
    db.raw.prepare(
      "UPDATE operating_leads SET lifecycle_status = 'disqualified', version = version + 1 WHERE tenant_id = ? AND lead_id = ?",
    ).run(TENANT, LEAD_ID);
    await assert.rejects(
      () => recordCommercialProposalRevision(env, {
        tenantId: TENANT,
        proposalRevisionId: "proposal-revision:commercial:api:qualification-blocked",
        proposalPackId: "proposal-pack:commercial:api:qualification-blocked",
        revisionNumber: 1,
        quoteRevisionId: QUOTE_REVISION_ID,
        roofJobId: JOB_ID,
        customerId: CUSTOMER_ID,
        title: "Blocked proposal",
        summary: "Must not persist while the lead is disqualified.",
        terms: TERMS,
        contentRef: "r2://commercial/proposals/blocked.pdf",
        contentHash: "f".repeat(64),
        evidence: EVIDENCE,
        authority: { kind: "policy_permit", permitId: "pending" },
        idempotencyKey: "commercial-proposal-qualification-blocked",
      }, NOW),
      (error: unknown) => error instanceof Error && error.message === "commercial_lead_not_qualified",
    );
    assert.equal(
      (db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_proposal_revisions").get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

function auth(role: AppRole): AuthContext {
  const now = NOW.toISOString();
  const sessionUserId = role === "ops" ? OPS_ID : OWNER_ID;
  const email = role === "ops" ? "ops@example.com" : "owner@example.com";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "c".repeat(64),
      session_created_at: now,
      session_expires_at: at(60).toISOString(),
      revoked_at: null,
      user_id: sessionUserId,
      tenant_id: TENANT,
      email_normalized: email,
      display_name: role,
      role,
      frappe_user_id: email,
      active: 1,
      created_by: "seed",
      created_at: now,
      updated_at: now,
    },
  };
}

function otherOpsAuth(): AuthContext {
  const base = auth("ops");
  return {
    ...base,
    session: {
      ...base.session,
      user_id: OTHER_OPS_ID,
      email_normalized: "other-ops@example.com",
      display_name: "Other Ops",
      frappe_user_id: "other-ops@example.com",
    },
  };
}

function request(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-csrf-token": "csrf",
    },
    body: JSON.stringify(body),
  });
}

function proposalBody(factsObservedAt: string): Record<string, unknown> {
  return {
    proposal_revision_id: "proposal-revision:commercial:api:0001",
    proposal_pack_id: "proposal-pack:commercial:api:0001",
    revision_number: 1,
    quote_revision_id: QUOTE_REVISION_ID,
    roof_job_id: JOB_ID,
    customer_id: CUSTOMER_ID,
    facts_observed_at: factsObservedAt,
    title: "Complete roof replacement proposal",
    summary: "Approved scope, price, schedule assumptions, and warranty.",
    terms: TERMS,
    content_ref: "r2://commercial/proposals/0001.pdf",
    content_hash: "f".repeat(64),
    evidence: EVIDENCE,
  };
}

function quoteBody(factsObservedAt: string): Record<string, unknown> {
  return {
    quote_revision_id: QUOTE_REVISION_ID,
    customer_quote_id: QUOTE_ID,
    revision_number: 1,
    roof_job_id: JOB_ID,
    customer_id: CUSTOMER_ID,
    facts_observed_at: factsObservedAt,
    supersedes_quote_revision_id: null,
    status: "approved",
    currency: "CAD",
    valid_until: QUOTE_VALID_UNTIL,
    terms: TERMS,
    correction_reason: null,
    lines: [
      {
        line_id: "material:shingles",
        sequence: 1,
        kind: "material",
        description: "Architectural shingles",
        quantity_micros: 1_500_000,
        uom: "square",
        unit_price_cents: 10_000,
        tax_code: "GST",
        tax_cents: 750,
      },
      {
        line_id: "discount:loyalty",
        sequence: 2,
        kind: "discount",
        description: "Loyalty discount",
        quantity_micros: 1_000_000,
        uom: "each",
        unit_price_cents: -1_000,
        tax_code: "GST",
        tax_cents: -50,
      },
    ],
    evidence: EVIDENCE,
  };
}

async function seedApprovedQuote(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
  options: { alreadyQualified?: boolean } = {},
) {
  if (!options.alreadyQualified) {
    const triage = await handleAuthenticatedRoute(
      request("/api/v1/commercial/lead-triage-decisions", {
        lead_id: LEAD_ID,
        expected_lead_version: 1,
        lifecycle_status: "qualified",
        priority: "normal",
        category: "replacement",
        summary: "Fixture lead qualified before the lower-level quote seam.",
        next_action: "Prepare the approved quote.",
      }, "commercial-quote-fixture-triage"),
      env,
      auth("ops"),
    );
    assert.equal(triage.status, 201, await triage.clone().text());
  }
  const quoteInput: RecordCommercialQuoteInput = {
    tenantId: TENANT,
    quoteRevisionId: QUOTE_REVISION_ID,
    customerQuoteId: QUOTE_ID,
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
        lineId: "material:shingles",
        sequence: 1,
        kind: "material",
        description: "Architectural shingles",
        quantityMicros: 1_500_000,
        uom: "square",
        unitPriceCents: 10_000,
        taxCode: "GST",
        taxCents: 750,
      },
      {
        lineId: "discount:loyalty",
        sequence: 2,
        kind: "discount",
        description: "Loyalty discount",
        quantityMicros: 1_000_000,
        uom: "each",
        unitPriceCents: -1_000,
        taxCode: "GST",
        taxCents: -50,
      },
    ],
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: "commercial:quote:api:0001",
  };
  const preparedQuote = await prepareCommercialQuote(quoteInput);
  const quotePermit = await admitFor(
    env,
    "quote.revision.record",
    { type: "customer_quote", id: QUOTE_ID, version: 1 },
    preparedQuote.command,
    "permit:quote:api:0001",
    preparedQuote.totalCents,
  );
  await recordCommercialQuoteRevision(env, {
    ...quoteInput,
    authority: { kind: "policy_permit", permitId: quotePermit.permit_id },
  }, at(2));
}

async function admitFor(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON?: string },
  action: CommercialAction,
  aggregate: {
    type: "lead" | "customer_quote" | "proposal" | "proposal_publication";
    id: string;
    version: number;
  },
  command: unknown,
  idempotencyKey: string,
  amountCents: number | null = null,
  now = NOW,
) {
  const result = await admitCommercialPermit(env, {
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
    factsObservedAt: NOW.toISOString(),
    evidence: EVIDENCE,
    idempotencyKey,
    expiresAt: at(10).toISOString(),
  }, now);
  return result.permit;
}

function commercialEnv(db: SqliteD1) {
  return {
    DB: db as never,
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "commercial-sales-autonomy",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: POLICY_VALID_FROM,
      valid_until: POLICY_VALID_UNTIL,
      max_fact_age_seconds: 3_600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: [
        "lead.triage.record",
        "quote.revision.record",
        "proposal.revision.record",
        "proposal.publish",
        "proposal.withdraw",
      ],
      allowed_actor_types: ["owner", "agent", "worker"],
      max_quote_total_cents: 1_000_000,
    }),
  } as AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };
}

function seedOperatingCore(db: DatabaseSync): void {
  const now = NOW.toISOString();
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, "owner@example.com", "Owner", "owner", "owner@example.com", now, now);
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
  ).run(OPS_ID, TENANT, "ops@example.com", "Ops", "ops", "ops@example.com", now, now);
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
  ).run(OTHER_OPS_ID, TENANT, "other-ops@example.com", "Other Ops", "ops", "other-ops@example.com", now, now);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', 'customer@example.invalid', '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(ENVELOPE_ID, "raw/commercial/api-0001.json", now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', 'customer@example.invalid', 'untriaged', 1, ?, ?)`,
  ).run(LEAD_ID, TENANT, ENVELOPE_ID, "raw/commercial/api-0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', 'prospect', 1, ?, ?)`,
  ).run(CUSTOMER_ID, TENANT, ENVELOPE_ID, "raw/commercial/api-0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, service_type, job_status, current_gate_state, version,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(JOB_ID, TENANT, LEAD_ID, CUSTOMER_ID, ENVELOPE_ID, "raw/commercial/api-0001.json", now, now);
}

function totalChanges(database: DatabaseSync): number {
  return (database.prepare("SELECT total_changes() AS total_changes").get() as {
    total_changes: number;
  }).total_changes;
}

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

test("a proposal is not sent again until its last send is confirmed delivered", async () => {
  for (const outcome of ["unknown", "rejected"] as const) {
    const db = new SqliteD1();
    const env = commercialEnv(db);
    try {
      const triage = await handleAuthenticatedRoute(
        request("/api/v1/commercial/lead-triage-decisions", {
          lead_id: LEAD_ID,
          expected_lead_version: 1,
          lifecycle_status: "qualified",
          priority: "normal",
          category: "replacement",
          summary: "Qualified lead for publication.",
          next_action: "Prepare the customer proposal.",
        }, `resend-guard-triage-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(triage.status, 201);
      await seedApprovedQuote(env, { alreadyQualified: true });
      const proposal = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-revisions", proposalBody(new Date().toISOString()), `resend-guard-proposal-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(proposal.status, 201);
      const prepareBody = {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        previous_state: "draft",
        state: "published",
        facts_observed_at: new Date().toISOString(),
        evidence: EVIDENCE,
      };
      const prepared = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `resend-guard-prepare-1-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(prepared.status, 201);
      const { permit } = await prepared.json() as {
        permit: { permit_id: string; policy_ref: string; policy_version: string; expires_at: string };
      };
      const expectedReadback = {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        state: "published",
      };
      // The first send leaves the provider without a confirmed answer (or a settled refusal).
      await runExternalEffect(
        env,
        {
          effectId: `effect:publication:${outcome}`,
          tenantId: TENANT,
          actor: { type: "worker", id: OPS_ID },
          taskId: "task:commercial-publication",
          authority: {
            permitRef: permit.permit_id,
            policyRef: permit.policy_ref,
            policyVersion: permit.policy_version,
            tenantId: TENANT,
            actorType: "worker",
            actorId: OPS_ID,
            expiresAt: permit.expires_at,
            allowedActions: ["proposal.publish"],
          },
          aggregate: { type: "proposal_publication", id: "proposal-pack:commercial:api:0001", version: 1 },
          intentId: "proposal-revision:commercial:api:0001",
          action: "proposal.publish",
          request: expectedReadback,
          provider: "native-commercial-publication",
          idempotencyKey: `effect:publication:${outcome}:key`,
          deadlineAt: new Date(Date.parse(permit.expires_at) - 1_000).toISOString(),
          expectedReadback,
          correlationId: "commercial-publication-correlation",
        },
        {
          async dispatch() {
            return { outcome, detailCode: `provider_${outcome}` } as never;
          },
          async replay() {
            return { published: false };
          },
        },
      ).catch(() => undefined);
      const state = (db.raw.prepare(
        "SELECT state FROM external_effects WHERE effect_id = ?",
      ).get(`effect:publication:${outcome}`) as { state: string }).state;

      const again = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `resend-guard-prepare-2-${outcome}`),
        env,
        auth("ops"),
      );
      if (outcome === "unknown") {
        assert.equal(again.status, 409, `a send in state ${state} is not confirmed delivered`);
        assert.deepEqual(await again.json(), {
          error: "proposal_delivery_unconfirmed",
          delivery_state: state,
          external_effect_id: `effect:publication:${outcome}`,
          // An unknown send is settled by a person recording what they checked.
          next_step: "confirm_delivery_by_hand",
        });
      } else {
        assert.equal(state, "failed");
        assert.equal(again.status, 201, "a settled refusal did not reach the customer; a new send may go");
      }
    } finally {
      db.close();
    }
  }
});

test("a person records whether a proposal send that could not be confirmed reached the customer", async () => {
  const { authenticateAppRequest, randomToken, sessionHashFor } = await import("../src/app-auth.ts");
  for (const outcome of ["not_delivered", "delivered"] as const) {
    const db = new SqliteD1();
    const env = {
      ...commercialEnv(db),
      APP_TENANT_ID: TENANT,
      APP_AUTH_PEPPER: "delivery-confirmation-test-pepper-0123456789abcdef",
    } as AppEnv;
    try {
      const triage = await handleAuthenticatedRoute(
        request("/api/v1/commercial/lead-triage-decisions", {
          lead_id: LEAD_ID,
          expected_lead_version: 1,
          lifecycle_status: "qualified",
          priority: "normal",
          category: "replacement",
          summary: "Qualified lead for publication.",
          next_action: "Prepare the customer proposal.",
        }, `delivery-confirm-triage-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(triage.status, 201);
      await seedApprovedQuote(env, { alreadyQualified: true });
      const proposal = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-revisions", proposalBody(new Date().toISOString()), `delivery-confirm-proposal-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(proposal.status, 201);
      const prepareBody = {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        previous_state: "draft",
        state: "published",
        facts_observed_at: new Date().toISOString(),
        evidence: EVIDENCE,
      };
      const prepared = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `delivery-confirm-prepare-1-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(prepared.status, 201);
      const { permit } = await prepared.json() as {
        permit: { permit_id: string; policy_ref: string; policy_version: string; expires_at: string };
      };
      const expectedReadback = {
        proposal_revision_id: "proposal-revision:commercial:api:0001",
        proposal_pack_id: "proposal-pack:commercial:api:0001",
        publication_version: 1,
        state: "published",
      };
      const effectId = `effect:publication:conflict:${outcome}`;
      // The provider answers, but its readback is not what was sent: a manual exception.
      await runExternalEffect(
        env,
        {
          effectId,
          tenantId: TENANT,
          actor: { type: "worker", id: OPS_ID },
          taskId: "task:commercial-publication",
          authority: {
            permitRef: permit.permit_id,
            policyRef: permit.policy_ref,
            policyVersion: permit.policy_version,
            tenantId: TENANT,
            actorType: "worker",
            actorId: OPS_ID,
            expiresAt: permit.expires_at,
            allowedActions: ["proposal.publish"],
          },
          aggregate: { type: "proposal_publication", id: "proposal-pack:commercial:api:0001", version: 1 },
          intentId: "proposal-revision:commercial:api:0001",
          action: "proposal.publish",
          request: expectedReadback,
          provider: "native-commercial-publication",
          idempotencyKey: `${effectId}:key`,
          deadlineAt: new Date(Date.parse(permit.expires_at) - 1_000).toISOString(),
          expectedReadback,
          correlationId: "commercial-publication-correlation",
        },
        {
          async dispatch() {
            return {
              outcome: "accepted" as const,
              value: { published: true },
              providerExternalId: "provider-publication-conflict",
              providerResponse: { id: "provider-publication-conflict" },
              readback: {
                status: "match" as const,
                providerExternalId: "provider-publication-conflict",
                observed: { ...expectedReadback, state: "withdrawn" },
              },
            };
          },
          async replay() {
            return { published: false };
          },
        },
      ).catch(() => undefined);
      const effectState = () => (db.raw.prepare("SELECT state FROM external_effects WHERE effect_id = ?")
        .get(effectId) as { state: string }).state;
      assert.equal(effectState(), "manual_exception");

      const blocked = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `delivery-confirm-prepare-2-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(blocked.status, 409);
      assert.deepEqual(await blocked.json(), {
        error: "proposal_delivery_unconfirmed",
        delivery_state: "manual_exception",
        external_effect_id: effectId,
        next_step: "confirm_delivery_by_hand",
      });

      const confirmation = { external_effect_id: effectId, outcome, note: "Called the customer and checked their inbox." };
      // A role without the commercial set, or a caller that is not a person's own session, is refused.
      const notPerson = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/delivery-confirmations", confirmation, `delivery-confirm-${outcome}`),
        env,
        auth("ops"),
      );
      assert.equal(notPerson.status, 403);
      assert.deepEqual(await notPerson.json(), { error: "person_session_required" });

      db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
      const token = randomToken();
      const now = new Date();
      db.raw.prepare(
        `INSERT INTO app_sessions
          (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
           created_ip_hash, created_user_agent_hash, device_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      ).run(
        await sessionHashFor(env, token), OPS_ID, TENANT, now.toISOString(),
        new Date(now.getTime() + 3_600_000).toISOString(), now.toISOString(), "d".repeat(64), "e".repeat(64),
      );
      const authenticated = await authenticateAppRequest(
        new Request("https://app.example.com/api/v1/session", { headers: { cookie: `__Host-ironwrap_session=${token}` } }),
        env,
      );
      assert.ok(authenticated.ok);
      const person = authenticated.auth;
      const confirm = (key: string, body: Record<string, unknown>) =>
        handleAuthenticatedRoute(
          new Request("https://app.example.com/api/v1/commercial/proposal-publications/delivery-confirmations", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
              "x-csrf-token": person.csrfToken,
            },
            body: JSON.stringify(body),
          }),
          env,
          person,
        );
      const tooShort = await confirm(`delivery-confirm-short-${outcome}`, { ...confirmation, note: "ok" });
      assert.equal(tooShort.status, 400);
      const audits = () =>
        (db.raw.prepare("SELECT count(*) AS n FROM audit_log WHERE automation = 'proposal_delivery'").get() as { n: number }).n;
      const openExceptions = () =>
        (db.raw.prepare("SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'open'")
          .get(effectId) as { n: number }).n;

      if (outcome === "not_delivered") {
        // The provider answered with a readback that conflicts, so it did something: a person cannot
        // record "not delivered" (0164), which would clear the way for a second send. The send stays
        // an exception, nothing is recorded, and the proposal is still not sent again.
        const refused = await confirm(`delivery-confirm-${outcome}`, confirmation);
        assert.equal(refused.status, 409, await refused.clone().text());
        assert.deepEqual(await refused.json(), {
          error: "proposal_delivery_confirmation_conflict_needs_provider_evidence",
          delivery_state: "manual_exception",
        });
        assert.equal(effectState(), "manual_exception");
        assert.equal(audits(), 0);
        assert.equal(openExceptions(), 1);
        const stillBlocked = await handleAuthenticatedRoute(
          request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `delivery-confirm-prepare-3-${outcome}`),
          env,
          auth("ops"),
        );
        assert.equal(stillBlocked.status, 409);
        assert.equal((await stillBlocked.json() as { next_step: string }).next_step, "confirm_delivery_by_hand");
        continue;
      }

      const recorded = await confirm(`delivery-confirm-${outcome}`, confirmation);
      assert.equal(recorded.status, 201, await recorded.clone().text());
      assert.equal((await recorded.json() as { effect: { state: string } }).effect.state, "succeeded");
      assert.equal(effectState(), "succeeded");
      assert.equal(audits(), 1, "one audit row per confirmation");
      assert.equal(openExceptions(), 0, "the exception the send opened is resolved by the confirmation");
      const replay = await confirm(`delivery-confirm-${outcome}`, confirmation);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
      const again = await confirm(`delivery-confirm-again-${outcome}`, confirmation);
      assert.equal(again.status, 409);
      assert.equal((await again.json() as { error: string }).error, "proposal_delivery_not_awaiting_confirmation");

      const next = await handleAuthenticatedRoute(
        request("/api/v1/commercial/proposal-publications/prepare", prepareBody, `delivery-confirm-prepare-3-${outcome}`),
        env,
        auth("ops"),
      );
      // Delivered: record that send as the publication instead of sending it a second time.
      assert.equal(next.status, 409);
      assert.deepEqual(await next.json(), {
        error: "proposal_delivery_not_recorded",
        delivery_state: "succeeded",
        external_effect_id: effectId,
        next_step: "record_publication",
      });
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Delivery guard follow-ups (review of #15): readback after a permit expires, D1 single flight,
// expired never-started sends, a person settling an unknown send, and the confirmation ledger.

const PACK = "proposal-pack:commercial:api:0001";
const REVISION = "proposal-revision:commercial:api:0001";
const EFFECT_TOKEN = "delivery-guard-effect-runtime-token-0123456789abcdef";

async function publicationReady(tag: string) {
  const db = new SqliteD1();
  const env = {
    ...commercialEnv(db),
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: "delivery-guard-test-pepper-0123456789abcdef0123",
    EFFECT_RUNTIME_ENABLED: "true",
    EFFECT_RUNTIME_TOKEN: EFFECT_TOKEN,
  } as AppEnv;
  const triage = await handleAuthenticatedRoute(
    request("/api/v1/commercial/lead-triage-decisions", {
      lead_id: LEAD_ID,
      expected_lead_version: 1,
      lifecycle_status: "qualified",
      priority: "normal",
      category: "replacement",
      summary: "Qualified lead for publication.",
      next_action: "Prepare the customer proposal.",
    }, `${tag}-triage`),
    env,
    auth("ops"),
  );
  assert.equal(triage.status, 201);
  await seedApprovedQuote(env, { alreadyQualified: true });
  const proposal = await handleAuthenticatedRoute(
    request("/api/v1/commercial/proposal-revisions", proposalBody(new Date().toISOString()), `${tag}-proposal`),
    env,
    auth("ops"),
  );
  assert.equal(proposal.status, 201);
  const prepareBody = (factsObservedAt = new Date().toISOString()) => ({
    proposal_revision_id: REVISION,
    proposal_pack_id: PACK,
    publication_version: 1,
    previous_state: "draft",
    state: "published",
    facts_observed_at: factsObservedAt,
    evidence: EVIDENCE,
  });
  const prepare = (key: string, factsObservedAt?: string) =>
    handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", prepareBody(factsObservedAt), key),
      env,
      auth("ops"),
    );
  return { db, env, prepare, prepareBody };
}

type Permit = { permit_id: string; policy_ref: string; policy_version: string; expires_at: string };

const READBACK = { proposal_revision_id: REVISION, proposal_pack_id: PACK, publication_version: 1, state: "published" };

function effectRequest(permit: Permit, effectId: string, deadlineAt?: string) {
  return {
    effectId,
    tenantId: TENANT,
    actor: { type: "worker" as const, id: OPS_ID },
    taskId: "task:commercial-publication",
    authority: {
      permitRef: permit.permit_id,
      policyRef: permit.policy_ref,
      policyVersion: permit.policy_version,
      tenantId: TENANT,
      actorType: "worker" as const,
      actorId: OPS_ID,
      expiresAt: permit.expires_at,
      allowedActions: ["proposal.publish"],
    },
    aggregate: { type: "proposal_publication", id: PACK, version: 1 },
    intentId: REVISION,
    action: "proposal.publish",
    request: READBACK,
    provider: "native-commercial-publication",
    idempotencyKey: `${effectId}:key`,
    deadlineAt: deadlineAt ?? new Date(Date.parse(permit.expires_at) - 1_000).toISOString(),
    expectedReadback: READBACK,
    correlationId: "commercial-publication-correlation",
  };
}

async function runSend(env: AppEnv, permit: Permit, effectId: string, mode: "unknown" | "conflict" | "success") {
  await runExternalEffect(env, effectRequest(permit, effectId), {
    async dispatch() {
      if (mode === "unknown") return { outcome: "unknown", detailCode: "provider_timeout" } as never;
      return {
        outcome: "accepted" as const,
        value: { published: true },
        providerExternalId: `provider:${effectId}`,
        providerResponse: { id: `provider:${effectId}` },
        readback: {
          status: "match" as const,
          providerExternalId: `provider:${effectId}`,
          observed: mode === "conflict" ? { ...READBACK, state: "withdrawn" } : READBACK,
        },
      };
    },
    async replay() {
      return { published: false };
    },
  }).catch(() => undefined);
}

async function personSession(db: SqliteD1, env: AppEnv, userId: string, role: "ops" | "owner" | "sales") {
  const { authenticateAppRequest, randomToken, sessionHashFor } = await import("../src/app-auth.ts");
  db.raw.prepare("UPDATE app_users SET access_role = ? WHERE user_id = ?").run(role, userId);
  const token = randomToken();
  const now = Date.now();
  db.raw.prepare(
    `INSERT INTO app_sessions
      (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
       created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    await sessionHashFor(env, token), userId, TENANT, new Date(now - 1_000).toISOString(),
    new Date(now + 3_600_000).toISOString(), new Date(now - 1_000).toISOString(), "d".repeat(64), "e".repeat(64),
  );
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.com/api/v1/session", { headers: { cookie: `__Host-ironwrap_session=${token}` } }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

function personPost(env: AppEnv, person: AuthContext, path: string, key: string, body: Record<string, unknown>) {
  return handleAuthenticatedRoute(
    new Request(`https://app.example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": person.csrfToken },
      body: JSON.stringify(body),
    }),
    env,
    person,
  );
}

const CONFIRM_PATH = "/api/v1/commercial/proposal-publications/delivery-confirmations";

test("a delivery confirmed by hand is recorded after the permit expired, by another commercial person", async () => {
  const { db, env, prepare } = await publicationReady("readback");
  try {
    // A permit that lives about four seconds from now (facts observed 26 seconds ago).
    const prepared = await prepare("readback-prepare-1", new Date(Date.now() - 26_000).toISOString());
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, "effect:readback:conflict", "conflict");
    const other = await personSession(db, env, OTHER_OPS_ID, "ops");
    const confirmed = await personPost(env, other, CONFIRM_PATH, "readback-confirm", {
      external_effect_id: "effect:readback:conflict",
      outcome: "delivered",
      note: "The customer confirmed they have the proposal.",
    });
    assert.equal(confirmed.status, 201, await confirmed.clone().text());
    while (Date.now() <= Date.parse(permit.expires_at) + 50) await new Promise((done) => setTimeout(done, 100));

    const blocked = await prepare("readback-prepare-2");
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { next_step: string }).next_step, "record_publication");

    // Recording what already ran is readback: the expired permit and a person other than the one
    // who prepared it still record the publication.
    const recorded = await personPost(env, other, "/api/v1/commercial/proposal-publications", "readback-record", {
      proposal_revision_id: REVISION,
      proposal_pack_id: PACK,
      publication_version: 1,
      previous_state: "draft",
      state: "published",
      permit_id: permit.permit_id,
      external_effect_id: "effect:readback:conflict",
    });
    assert.equal(recorded.status, 201, await recorded.clone().text());
    assert.equal((await recorded.json() as { publication: { state: string } }).publication.state, "published");
  } finally {
    db.close();
  }
});

test("D1 holds one proposal send in flight, the claim route included, and a person settles an unknown send", async () => {
  const { handleExternalEffectClaim } = await import("../src/effect-runtime-admin.ts");
  const { db, env, prepare } = await publicationReady("single-flight");
  try {
    const prepared = await prepare("single-flight-prepare-1");
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, "effect:single-flight:unknown", "unknown");

    // The service-token claim path never passes through prepare. On this business Worker the token
    // is refused for a proposal send before D1 (0164). The QA seed's synthetic stand-in on a
    // synthetic Worker still reaches D1, which refuses the second send itself.
    const synthetic = { ...env, AGENT_DATA_CLASS: "synthetic" } as AppEnv;
    const claimSend = (target: AppEnv, effect: Record<string, unknown>, authority: unknown) =>
      handleExternalEffectClaim(
        new Request("https://worker.example.com/admin/effects/claim", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
          body: JSON.stringify({ effect, authority }),
        }),
        target,
      );
    const publishEffects = () =>
      (db.raw.prepare("SELECT count(*) AS n FROM external_effects WHERE action = 'proposal.publish'").get() as { n: number }).n;
    const second = effectRequest(permit, "effect:single-flight:second");
    const businessClaim = await claimSend(env, second, second.authority);
    assert.equal(businessClaim.status, 403, await businessClaim.clone().text());
    assert.deepEqual(await businessClaim.json(), { error: "effect_outside_send_token_refused" });
    const businessSynthetic = await claimSend(env, { ...second, provider: "qa-synthetic-publication" }, second.authority);
    assert.equal(businessSynthetic.status, 403, await businessSynthetic.clone().text());
    assert.deepEqual(await businessSynthetic.json(), { error: "effect_provider_not_allowed" });
    const claim = await claimSend(synthetic, { ...second, provider: "qa-synthetic-publication" }, second.authority);
    assert.equal(claim.status, 409, await claim.clone().text());
    assert.deepEqual(await claim.json(), { error: "proposal_delivery_unconfirmed" });
    assert.equal(publishEffects(), 1);

    // A caller-supplied compensation link is no exemption: a "compensation" that is itself a
    // publish of the same revision is a second send.
    const disguised = { ...effectRequest(permit, "effect:single-flight:disguised"), compensatesEffectId: "effect:single-flight:unknown" };
    const businessDisguised = await claimSend(env, disguised, disguised.authority);
    assert.equal(businessDisguised.status, 403, await businessDisguised.clone().text());
    assert.deepEqual(await businessDisguised.json(), { error: "effect_outside_send_token_refused" });
    const disguisedClaim = await claimSend(synthetic, { ...disguised, provider: "qa-synthetic-publication" }, disguised.authority);
    assert.equal(disguisedClaim.status, 409, await disguisedClaim.clone().text());
    assert.deepEqual(await disguisedClaim.json(), { error: "proposal_delivery_unconfirmed" });
    assert.equal(publishEffects(), 1, "no second publish effect exists");
    // The claim runs on the server's clock: a backdated `now` cannot make a lapsed deadline current.
    const backdated = {
      ...effectRequest(permit, "effect:single-flight:backdated", new Date(Date.now() - 60_000).toISOString()),
      now: new Date(Date.now() - 120_000).toISOString(),
    };
    const businessBackdated = await claimSend(env, backdated, backdated.authority);
    assert.equal(businessBackdated.status, 403, await businessBackdated.clone().text());
    assert.deepEqual(await businessBackdated.json(), { error: "effect_outside_send_token_refused" });
    const backdatedClaim = await claimSend(synthetic, { ...backdated, provider: "qa-synthetic-publication" }, backdated.authority);
    assert.equal(backdatedClaim.status, 422, await backdatedClaim.clone().text());
    assert.deepEqual(await backdatedClaim.json(), { error: "effect_deadline_invalid" });
    assert.equal(publishEffects(), 1);

    // A person may say "not delivered" only once the provider's own answer can no longer be late.
    const ops = await personSession(db, env, OPS_ID, "ops");
    const tooEarly = await personPost(env, ops, CONFIRM_PATH, "single-flight-confirm-early", {
      external_effect_id: "effect:single-flight:unknown",
      outcome: "not_delivered",
      note: "No proposal in the customer's inbox or spam.",
    });
    assert.equal(tooEarly.status, 409);
    assert.equal((await tooEarly.json() as { error: string }).error, "proposal_delivery_answer_may_be_late");
    const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
    const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
    const settled = await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT,
      effectId: "effect:single-flight:unknown",
      outcome: "not_delivered",
      note: "No proposal in the customer's inbox or spam.",
      actorUserId: OPS_ID,
      actorRole: "ops",
      idempotencyKey: "single-flight-confirm",
      now: new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString(),
    });
    assert.equal(settled.effectState, "reconciled");
    const next = await prepare("single-flight-prepare-2");
    assert.equal(next.status, 201);
  } finally {
    db.close();
  }
});

test("a send that never started and is past its deadline does not block, and a prepare replay returns its permit", async () => {
  const { db, env, prepare } = await publicationReady("expired");
  try {
    const observedAt = new Date().toISOString();
    const prepared = await prepare("expired-prepare-1", observedAt);
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    const replay = await prepare("expired-prepare-1", observedAt);
    assert.ok(replay.status === 200 || replay.status === 201);
    assert.equal((await replay.json() as { permit: Permit }).permit.permit_id, permit.permit_id);

    const { proposeExternalEffect } = await import("../src/effect-runtime.ts");
    await proposeExternalEffect(env, {
      ...effectRequest(permit, "effect:expired:proposed", new Date(Date.now() + 300).toISOString()),
      authority: { permitRef: permit.permit_id, policyRef: permit.policy_ref, policyVersion: permit.policy_version },
    } as never);
    // While its deadline is open the proposed send blocks; a replay of the original prepare does not.
    const blocked = await prepare("expired-prepare-2");
    assert.equal(blocked.status, 409);
    const replayAfterEffect = await prepare("expired-prepare-1", observedAt);
    assert.ok(replayAfterEffect.status === 200 || replayAfterEffect.status === 201);
    assert.equal((await replayAfterEffect.json() as { permit: Permit }).permit.permit_id, permit.permit_id);

    await new Promise((done) => setTimeout(done, 400));
    const after = await prepare("expired-prepare-3");
    assert.equal(after.status, 201, "a send past its deadline that never started sent nothing");
    const { permit: fresh } = await after.json() as { permit: Permit };
    await runSend(env, fresh, "effect:expired:fresh", "success");
    assert.equal(
      (db.raw.prepare("SELECT state FROM external_effects WHERE effect_id = 'effect:expired:fresh'").get() as { state: string }).state,
      "succeeded",
    );
  } finally {
    db.close();
  }
});

test("the confirmation ledger refuses what it must, in the route and in D1", async () => {
  const { db, env, prepare } = await publicationReady("ledger");
  try {
    const prepared = await prepare("ledger-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, "effect:ledger:conflict", "conflict");
    const ops = await personSession(db, env, OPS_ID, "ops");

    // Seven characters measured as SQLite measures them: refused as input, never as a 503.
    const emoji = await personPost(env, ops, CONFIRM_PATH, "ledger-emoji", {
      external_effect_id: "effect:ledger:conflict",
      outcome: "delivered",
      note: "abc\u{1F600}def",
    });
    assert.equal(emoji.status, 400);
    assert.deepEqual(await emoji.json(), { error: "invalid_proposal_delivery_confirmation" });

    // An effect that is not a proposal send is not found, on the route and in D1.
    const { proposeExternalEffect } = await import("../src/effect-runtime.ts");
    await proposeExternalEffect(env, {
      ...effectRequest(permit, "effect:ledger:not-a-send"),
      action: "synthetic.notify",
      aggregate: { type: "synthetic_notice", id: PACK, version: 1 },
      idempotencyKey: "effect:ledger:not-a-send:key",
      // Not a commercial permit, so 0093's commercial binding guard does not apply to it.
      authority: { permitRef: "synthetic-authority:not-a-send-0001", policyRef: "synthetic", policyVersion: "v1" },
    } as never);
    const notASend = await personPost(env, ops, CONFIRM_PATH, "ledger-not-a-send", {
      external_effect_id: "effect:ledger:not-a-send",
      outcome: "delivered",
      note: "Checked with the customer by phone.",
    });
    assert.equal(notASend.status, 404);
    assert.deepEqual(await notASend.json(), { error: "proposal_delivery_effect_not_found" });
    // Another tenant's session cannot reach this tenant's send.
    const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
    await assert.rejects(
      recordProposalDeliveryConfirmation(env, {
        tenantId: "other-tenant",
        effectId: "effect:ledger:conflict",
        outcome: "delivered",
        note: "Checked with the customer by phone.",
        actorUserId: OPS_ID,
        actorRole: "ops",
        idempotencyKey: "ledger-cross-tenant",
      }),
      { code: "proposal_delivery_effect_not_found" },
    );

    // D1 itself: no exit from the exception without a confirmation, and the ledger is append-only.
    assert.throws(
      () => db.raw.prepare(
        "UPDATE external_effects SET state = 'succeeded', updated_at = ? WHERE effect_id = 'effect:ledger:conflict'",
      ).run(new Date().toISOString()),
      /external_effect_terminal/,
    );
    // A readback that conflicted means the provider answered: "not delivered" is not a person's to
    // record, on the route or in D1 (0164), and the send keeps blocking the next one.
    const notDelivered = await personPost(env, ops, CONFIRM_PATH, "ledger-not-delivered", {
      external_effect_id: "effect:ledger:conflict",
      outcome: "not_delivered",
      note: "The customer has not received anything.",
    });
    assert.equal(notDelivered.status, 409, await notDelivered.clone().text());
    assert.deepEqual(await notDelivered.json(), {
      error: "proposal_delivery_confirmation_conflict_needs_provider_evidence",
      delivery_state: "manual_exception",
    });
    assert.throws(
      () => db.raw.prepare(
        `INSERT INTO proposal_delivery_confirmations
           (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
            confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
         VALUES ('delivery-confirmation:direct-conflict-0001', ?, 'effect:ledger:conflict', ?, ?, 'not_delivered',
                 'Direct insert attempt', ?, 'ops', ?, ?, ?)`,
      ).run(TENANT, PACK, REVISION, OPS_ID, "c".repeat(64), "d".repeat(64), new Date().toISOString()),
      /proposal_delivery_confirmation_conflict_needs_provider_evidence/,
    );
    assert.equal(
      (db.raw.prepare("SELECT state FROM external_effects WHERE effect_id = 'effect:ledger:conflict'").get() as { state: string }).state,
      "manual_exception",
    );
    assert.equal((await prepare("ledger-prepare-after-refusal")).status, 409);
    const confirmed = await personPost(env, ops, CONFIRM_PATH, "ledger-confirm", {
      external_effect_id: "effect:ledger:conflict",
      outcome: "delivered",
      note: "The customer confirmed they have the proposal.",
    });
    assert.equal(confirmed.status, 201);
    assert.throws(
      () => db.raw.prepare("UPDATE proposal_delivery_confirmations SET note = 'changed note text'").run(),
      /proposal_delivery_confirmations_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM proposal_delivery_confirmations").run(),
      /proposal_delivery_confirmations_append_only/,
    );
    // A non-publish effect cannot carry a confirmation row, even inserted directly.
    assert.throws(
      () => db.raw.prepare(
        `INSERT INTO proposal_delivery_confirmations
           (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
            confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
         VALUES ('delivery-confirmation:direct-0001', ?, 'effect:ledger:not-a-send', ?, ?, 'delivered',
                 'Direct insert attempt', ?, 'ops', ?, ?, ?)`,
      ).run(TENANT, PACK, REVISION, OPS_ID, "a".repeat(64), "b".repeat(64), new Date().toISOString()),
      /proposal_delivery_confirmation_effect_invalid/,
    );
  } finally {
    db.close();
  }
});

test("single flight holds across publication versions, and any commercial person records a send that ran", async () => {
  const { db, env, prepare, prepareBody } = await publicationReady("versions");
  try {
    const first = await prepare("versions-prepare-1");
    assert.equal(first.status, 201);
    const { permit } = await first.json() as { permit: Permit };
    // A second version of the same pack cannot open a second live permit.
    const otherVersion = await handleAuthenticatedRoute(
      request("/api/v1/commercial/proposal-publications/prepare", { ...prepareBody(), publication_version: 2 }, "versions-prepare-v2"),
      env,
      auth("ops"),
    );
    assert.equal(otherVersion.status, 409);
    assert.equal((await otherVersion.json() as { error: string }).error, "proposal_publication_permit_outstanding");

    await runSend(env, permit, "effect:versions:unknown", "unknown");
    // D1 refuses a second publish of the same revision at another version too.
    const { proposeExternalEffect } = await import("../src/effect-runtime.ts");
    await assert.rejects(
      proposeExternalEffect(env, {
        ...effectRequest(permit, "effect:versions:v2"),
        aggregate: { type: "proposal_publication", id: PACK, version: 2 },
        authority: { permitRef: "synthetic-authority:v2-0001", policyRef: "synthetic", policyVersion: "v1" },
      } as never),
      { code: "effect_proposal_delivery_unconfirmed" },
    );

    // An unknown send moves on only with a person's record (0164): a reconcile that reports it
    // executed is refused in D1. Once one person confirms delivery, another commercial person
    // records the publication.
    const { reconcileExternalEffect } = await import("../src/effect-runtime.ts");
    await assert.rejects(
      reconcileExternalEffect(env, "effect:versions:unknown", {
        outcome: "executed",
        evidence: { provider: "late answer: delivered" },
      }),
      /proposal_delivery_settle_evidence_missing/,
    );
    const ops = await personSession(db, env, OPS_ID, "ops");
    const confirmed = await personPost(env, ops, CONFIRM_PATH, "versions-confirm", {
      external_effect_id: "effect:versions:unknown",
      outcome: "delivered",
      note: "The customer confirmed they have the proposal.",
    });
    assert.equal(confirmed.status, 201, await confirmed.clone().text());
    const other = await personSession(db, env, OTHER_OPS_ID, "ops");
    const recorded = await personPost(env, other, "/api/v1/commercial/proposal-publications", "versions-record", {
      proposal_revision_id: REVISION,
      proposal_pack_id: PACK,
      publication_version: 1,
      previous_state: "draft",
      state: "published",
      permit_id: permit.permit_id,
      external_effect_id: "effect:versions:unknown",
    });
    assert.equal(recorded.status, 201, await recorded.clone().text());
  } finally {
    db.close();
  }
});

test("the effect-runtime token cannot forge a proposal send: each step of the forged path is refused (0164)", async () => {
  const { db, env, prepare } = await publicationReady("forged");
  try {
    const prepared = await prepare("forged-prepare-1");
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    const bearer = (route: string, body: unknown) =>
      worker.fetch(
        new Request(`https://worker.example.com/admin/effects/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
          body: JSON.stringify(body),
        }),
        env as never,
        {} as never,
      );
    const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    const publications = () => count("SELECT count(*) AS n FROM commercial_proposal_publication_events");

    // 1. The holder claims a send against the person's live permit with its own envelope: an empty
    // expected readback, which any observed value would match. Refused before D1, so the permit
    // stays unused and no effect exists.
    const forged = { ...effectRequest(permit, "effect:forged:claim"), expectedReadback: {} };
    const claim = await bearer("claim", { effect: forged, authority: forged.authority });
    assert.equal(claim.status, 403, await claim.clone().text());
    assert.deepEqual(await claim.json(), { error: "effect_outside_send_token_refused" });
    assert.equal(count("SELECT count(*) AS n FROM external_effects"), 0);

    // 2. A send the bus itself claimed cannot be settled from outside with a reported match.
    const { authorizeExternalEffect, claimExternalEffect, proposeExternalEffect, reconcileExternalEffect, recoverExpiredExternalEffect, EFFECT_ATTEMPT_LEASE_MS } =
      await import("../src/effect-runtime.ts");
    const send = effectRequest(permit, "effect:forged:bus");
    await proposeExternalEffect(env, {
      ...send,
      authority: { permitRef: permit.permit_id, policyRef: permit.policy_ref, policyVersion: permit.policy_version },
    } as never);
    await authorizeExternalEffect(env, send.effectId, send.authority);
    const { attempt } = await claimExternalEffect(env, send.effectId);
    const row = () => ({ ...db.raw.prepare("SELECT * FROM external_effects WHERE effect_id = ?").get(send.effectId) });
    const leased = row();
    const settle = await bearer("settle", {
      effectId: send.effectId,
      settlement: { attemptId: attempt.attempt_id, outcome: "accepted", readback: { status: "match", observed: READBACK } },
    });
    assert.equal(settle.status, 403, await settle.clone().text());
    assert.deepEqual(await settle.json(), { error: "effect_outside_send_token_refused" });
    assert.deepEqual(row(), leased);
    assert.equal(leased.state, "executing");

    // 3. Nothing is "sent", so even the permit's own preparer cannot record it as the publication.
    const ops = await personSession(db, env, OPS_ID, "ops");
    const record = await personPost(env, ops, "/api/v1/commercial/proposal-publications", "forged-record", {
      proposal_revision_id: REVISION,
      proposal_pack_id: PACK,
      publication_version: 1,
      previous_state: "draft",
      state: "published",
      permit_id: permit.permit_id,
      external_effect_id: send.effectId,
    });
    assert.equal(record.status, 409, await record.clone().text());
    assert.deepEqual(await record.json(), { error: "commercial_publication_effect_mismatch" });
    assert.equal(publications(), 0);

    // 4. The lease runs out and the send is unknown. Neither the bearer nor a reconcile inside the
    // bus moves it, so L04 holds: the revision is not sent again until a person records what they
    // found.
    await recoverExpiredExternalEffect(env, send.effectId, new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString());
    const unknown = row();
    assert.equal(unknown.state, "unknown");
    for (const outcome of ["executed", "not_executed"]) {
      const reconcile = await bearer("reconcile", { effectId: send.effectId, outcome, evidence: { provider: "accepted" } });
      assert.equal(reconcile.status, 403, await reconcile.clone().text());
      assert.deepEqual(await reconcile.json(), { error: "effect_outside_send_token_refused" });
    }
    const retry = await bearer("retry", { effectId: send.effectId });
    assert.equal(retry.status, 403, await retry.clone().text());
    assert.deepEqual(await retry.json(), { error: "effect_outside_send_token_refused" });
    await assert.rejects(
      reconcileExternalEffect(env, send.effectId, { outcome: "executed", evidence: { provider: "accepted" } }),
      /proposal_delivery_settle_evidence_missing/,
    );
    assert.deepEqual(row(), unknown);
    const blocked = await prepare("forged-prepare-2");
    assert.equal(blocked.status, 409);
    assert.deepEqual(
      { ...(await blocked.json() as Record<string, unknown>) },
      { error: "proposal_delivery_unconfirmed", delivery_state: "unknown", external_effect_id: send.effectId, next_step: "confirm_delivery_by_hand" },
    );

    // The person path is the way out: a confirmed delivery is then recorded.
    const confirmed = await personPost(env, ops, CONFIRM_PATH, "forged-confirm", {
      external_effect_id: send.effectId,
      outcome: "delivered",
      note: "The customer confirmed they have the proposal.",
    });
    assert.equal(confirmed.status, 201, await confirmed.clone().text());
    const recorded = await personPost(env, ops, "/api/v1/commercial/proposal-publications", "forged-record-2", {
      proposal_revision_id: REVISION,
      proposal_pack_id: PACK,
      publication_version: 1,
      previous_state: "draft",
      state: "published",
      permit_id: permit.permit_id,
      external_effect_id: send.effectId,
    });
    assert.equal(recorded.status, 201, await recorded.clone().text());
    assert.equal(publications(), 1);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------------------------
// #15b-1 (0161): findings that never change the send, the late-answer wait in D1 with a window per
// provider, server time on the settle and reconcile admin routes, and the permit holder of a
// publication.

const FINDINGS_PATH = "/api/v1/commercial/proposal-publications/delivery-findings";

type Finding = {
  finding_id: string;
  finding: string;
  attempt_state: string;
  supersedes_finding_id: string | null;
};

function effectRow(db: SqliteD1, effectId: string): { state: string; updated_at: string; result_code: string | null } {
  return { ...(db.raw.prepare("SELECT state, updated_at, result_code FROM external_effects WHERE effect_id = ?")
    .get(effectId) as { state: string; updated_at: string; result_code: string | null }) };
}

/** When the send's last attempt ended: the late-answer window is counted from here. */
function lastAttemptEnd(db: SqliteD1, effectId: string): string {
  return (db.raw.prepare(
    `SELECT attempt.ended_at FROM external_effect_attempts attempt
       JOIN external_effects effect ON effect.effect_id = attempt.effect_id
      WHERE attempt.effect_id = ? AND attempt.attempt_number = effect.attempt_count`,
  ).get(effectId) as { ended_at: string }).ended_at;
}

function adminPost(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
    body: JSON.stringify(body),
  });
}

/** The effect routes take a proposal send only as the QA stand-in on a synthetic Worker (0164). */
function syntheticWorker(env: AppEnv): AppEnv {
  return { ...env, AGENT_DATA_CLASS: "synthetic" } as AppEnv;
}

async function unknownSendThroughRoutes(
  env: AppEnv,
  prepare: (key: string) => Promise<Response>,
  key: string,
  effectId: string,
  provider = "qa-synthetic-publication",
): Promise<void> {
  const { handleExternalEffectClaim, handleExternalEffectSettlement } = await import("../src/effect-runtime-admin.ts");
  const prepared = await prepare(key);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { permit } = await prepared.json() as { permit: Permit };
  const send = { ...effectRequest(permit, effectId), provider };
  const claimed = await handleExternalEffectClaim(adminPost("/admin/effects/claim", {
    effect: send,
    authority: send.authority,
  }), syntheticWorker(env));
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const { attempt } = await claimed.json() as { attempt: { attempt_id: string } };
  const settled = await handleExternalEffectSettlement(adminPost("/admin/effects/settle", {
    effectId,
    settlement: { attemptId: attempt.attempt_id, outcome: "unknown", detailCode: "provider_timeout" },
  }), syntheticWorker(env));
  assert.equal(settled.status, 200, await settled.clone().text());
}

function reconcileThroughRoute(env: AppEnv, effectId: string, outcome: "executed" | "not_executed" | "inconclusive") {
  return import("../src/effect-runtime-admin.ts").then(({ handleExternalEffectReconciliation }) =>
    handleExternalEffectReconciliation(adminPost("/admin/effects/reconcile", {
      effectId,
      outcome,
      evidence: { provider: `checked: ${outcome}` },
      // Ignored: the route reconciles on the server's clock.
      now: "2099-01-01T00:00:00.000Z",
    }), syntheticWorker(env)));
}

test("a person records findings about a settled send and corrects only the newest; the send never changes", async () => {
  const { db, env, prepare } = await publicationReady("findings-chain");
  const effectId = "effect:findings:conflict";
  try {
    const prepared = await prepare("findings-chain-prepare-1");
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "conflict");
    const ops = await personSession(db, env, OPS_ID, "ops");
    const other = await personSession(db, env, OTHER_OPS_ID, "sales");

    // 0156's first confirmation behaves exactly as merged: it settles the send.
    const confirmed = await personPost(env, ops, CONFIRM_PATH, "findings-chain-confirm", {
      external_effect_id: effectId,
      outcome: "delivered",
      note: "Called the customer; the email is in their inbox.",
    });
    assert.equal(confirmed.status, 201, await confirmed.clone().text());
    const settled = effectRow(db, effectId);
    assert.equal(settled.state, "succeeded");
    const stateEvents = () =>
      (db.raw.prepare("SELECT count(*) AS n FROM external_effect_events WHERE effect_id = ?").get(effectId) as { n: number }).n;
    const eventsAfterConfirmation = stateEvents();

    // "Not executed" is provider proof, never a person's finding.
    const malformed = await personPost(env, ops, FINDINGS_PATH, "findings-chain-malformed", {
      external_effect_id: effectId,
      supersedes_finding_id: null,
      finding: "not_executed",
      note: "A person cannot know nothing went out.",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_proposal_delivery_finding" });

    const firstBody = {
      external_effect_id: effectId,
      supersedes_finding_id: null,
      finding: "not_received",
      note: "They called back: it went out, but not to their inbox.",
    };
    const first = await personPost(env, ops, FINDINGS_PATH, "findings-chain-1", firstBody);
    assert.equal(first.status, 201, await first.clone().text());
    const firstFinding = await first.json() as {
      finding: Finding;
      effect: { external_effect_id: string; state: string };
      replayed: boolean;
    };
    assert.equal(firstFinding.finding.finding, "not_received");
    // The provider's readback did not match this send, so its last attempt is unknown: the answer is
    // not confirmed.
    assert.equal(firstFinding.finding.attempt_state, "unknown");
    assert.equal(firstFinding.finding.supersedes_finding_id, null);
    // A finding never changes the send: same state, result and time, and no state event.
    assert.deepEqual(firstFinding.effect, { external_effect_id: effectId, state: "succeeded" });
    assert.deepEqual(effectRow(db, effectId), settled);
    assert.equal(stateEvents(), eventsAfterConfirmation);

    const replay = await personPost(env, ops, FINDINGS_PATH, "findings-chain-1", firstBody);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    const conflicting = await personPost(env, ops, FINDINGS_PATH, "findings-chain-1", {
      ...firstBody,
      note: "Another note under the same key.",
    });
    assert.equal(conflicting.status, 409);
    assert.deepEqual(await conflicting.json(), { error: "proposal_delivery_finding_replay_conflict" });

    // A second first finding would fork the history: only the newest is corrected.
    const secondFirst = await personPost(env, other, FINDINGS_PATH, "findings-chain-second-first", {
      ...firstBody,
      finding: "delivered",
      note: "Recording a first finding again.",
    });
    assert.equal(secondFirst.status, 409);
    assert.deepEqual(await secondFirst.json(), {
      error: "proposal_delivery_finding_not_latest",
      latest_finding_id: firstFinding.finding.finding_id,
    });

    const corrected = await personPost(env, other, FINDINGS_PATH, "findings-chain-2", {
      external_effect_id: effectId,
      supersedes_finding_id: firstFinding.finding.finding_id,
      finding: "delivered",
      note: "Found it in their spam folder after all.",
    });
    assert.equal(corrected.status, 201, await corrected.clone().text());
    const secondFinding = (await corrected.json() as { finding: Finding }).finding;
    assert.equal(secondFinding.supersedes_finding_id, firstFinding.finding.finding_id);

    // Correcting the first finding again, now that it was corrected, is refused.
    const stale = await personPost(env, ops, FINDINGS_PATH, "findings-chain-stale", {
      external_effect_id: effectId,
      supersedes_finding_id: firstFinding.finding.finding_id,
      finding: "not_received",
      note: "Correcting a finding someone already corrected.",
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: "proposal_delivery_finding_not_latest",
      latest_finding_id: secondFinding.finding_id,
    });

    const third = await personPost(env, ops, FINDINGS_PATH, "findings-chain-3", {
      external_effect_id: effectId,
      supersedes_finding_id: secondFinding.finding_id,
      finding: "not_received",
      note: "They checked again: it is not in their inbox after all.",
    });
    assert.equal(third.status, 201, await third.clone().text());
    assert.deepEqual(effectRow(db, effectId), settled);
    assert.equal(stateEvents(), eventsAfterConfirmation);

    // The history keeps every finding, with who found it; the first confirmation is unchanged.
    assert.deepEqual(
      (db.raw.prepare(
        `SELECT finding, found_by_user_id, found_by_role FROM proposal_delivery_findings
          WHERE effect_id = ? ORDER BY created_at, finding_id`,
      ).all(effectId) as Array<Record<string, string>>).map((row) => ({ ...row })),
      [
        { finding: "not_received", found_by_user_id: OPS_ID, found_by_role: "ops" },
        { finding: "delivered", found_by_user_id: OTHER_OPS_ID, found_by_role: "sales" },
        { finding: "not_received", found_by_user_id: OPS_ID, found_by_role: "ops" },
      ],
    );
    assert.equal(
      (db.raw.prepare("SELECT count(*) AS n FROM proposal_delivery_confirmations WHERE effect_id = ?").get(effectId) as { n: number }).n,
      1,
    );
    assert.deepEqual(
      (db.raw.prepare(
        "SELECT action, approved_by FROM audit_log WHERE automation = 'proposal_delivery' ORDER BY rowid",
      ).all() as Array<Record<string, string>>).map((row) => ({ ...row })),
      [
        { action: "proposal_delivery_delivered", approved_by: OPS_ID },
        { action: "proposal_delivery_finding_not_received", approved_by: OPS_ID },
        { action: "proposal_delivery_finding_delivered", approved_by: OTHER_OPS_ID },
        { action: "proposal_delivery_finding_not_received", approved_by: OPS_ID },
      ],
    );

    const notPerson = await handleAuthenticatedRoute(
      request(FINDINGS_PATH, firstBody, "findings-chain-not-person"),
      env,
      auth("ops"),
    );
    assert.equal(notPerson.status, 403);
    assert.deepEqual(await notPerson.json(), { error: "person_session_required" });
  } finally {
    db.close();
  }
});

test("D1 holds the findings chain: settled sends only, one first finding, one successor each, append-only", async () => {
  const { recordProposalDeliveryFinding } = await import("../src/commercial-store.ts");
  const { db, env, prepare } = await publicationReady("findings-d1");
  const effectId = "effect:findings-d1:send";
  try {
    await unknownSendThroughRoutes(env, prepare, "findings-d1-prepare-1", effectId);
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const direct = (findingId: string, supersedes: string | null, finding = "not_received", attemptState = "unknown") =>
      db.raw.prepare(
        `INSERT INTO proposal_delivery_findings
           (finding_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, finding,
            attempt_state, supersedes_finding_id, note, found_by_user_id, found_by_role,
            idempotency_key_hash, request_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Direct insert attempt', ?, 'ops', ?, ?, ?)`,
      ).run(
        findingId, TENANT, effectId, PACK, REVISION, finding, attemptState, supersedes, OPS_ID,
        findingId.slice(-1).repeat(64), "f".repeat(64), new Date().toISOString(),
      );
    // An unknown send is not settled: a person answers it through the first confirmation (0156).
    assert.throws(() => direct("delivery-finding:direct-unsettled-a", null), /proposal_delivery_finding_effect_invalid/);
    // A reconcile is no person's record, so it cannot settle it (0164); the person's "delivered" does,
    // and the send's last attempt stays unknown.
    const executed = await reconcileThroughRoute(env, effectId, "executed");
    assert.equal(executed.status, 409, await executed.clone().text());
    assert.deepEqual(await executed.json(), { error: "effect_reconciliation_evidence_missing" });
    const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
    await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "delivered", note: "The customer has the email.",
      actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: "findings-d1-confirm",
    });
    assert.equal(effectRow(db, effectId).state, "succeeded");

    const first = await recordProposalDeliveryFinding(env, {
      tenantId: TENANT, effectId, supersedesFindingId: null, finding: "not_received",
      note: "It went out, but they cannot find it.", actorUserId: OPS_ID, actorRole: "ops",
      idempotencyKey: "findings-d1-1",
    });
    assert.equal(first.finding.attempt_state, "unknown");
    assert.throws(() => direct("delivery-finding:direct-second-root-b", null, "delivered"), /proposal_delivery_finding_not_latest/);
    // A person never records "not executed", and the attempt state is the send's own.
    assert.throws(
      () => direct("delivery-finding:direct-not-executed-5", first.finding.finding_id, "not_executed"),
      /CHECK constraint failed: finding IN/,
    );
    assert.throws(
      () => direct("delivery-finding:direct-claimed-success-6", first.finding.finding_id, "delivered", "succeeded"),
      /proposal_delivery_finding_attempt_mismatch/,
    );
    assert.throws(
      () => direct("delivery-finding:direct-orphan-c", "delivery-finding:no-such-finding", "delivered"),
      /proposal_delivery_finding_chain_invalid/,
    );
    // Only an active person of this tenant in the commercial set records a finding.
    assert.throws(
      () => db.raw.prepare(
        `INSERT INTO proposal_delivery_findings
           (finding_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, finding,
            attempt_state, supersedes_finding_id, note, found_by_user_id, found_by_role,
            idempotency_key_hash, request_sha256, created_at)
         VALUES ('delivery-finding:direct-stranger-g', ?, ?, ?, ?, 'delivered', 'unknown', ?, 'Direct insert attempt',
                 'appu_unknown_0161', 'ops', ?, ?, ?)`,
      ).run(TENANT, effectId, PACK, REVISION, first.finding.finding_id, "7".repeat(64), "f".repeat(64), new Date().toISOString()),
      /proposal_delivery_finding_actor_invalid/,
    );
    direct("delivery-finding:direct-successor-d", first.finding.finding_id, "delivered");
    assert.throws(
      () => direct("delivery-finding:direct-fork-e", first.finding.finding_id, "not_executed"),
      /proposal_delivery_finding_not_latest/,
    );
    // A replace that would drop a finding by its id is refused, as is any update or delete.
    assert.throws(
      () => db.raw.prepare(
        `INSERT OR REPLACE INTO proposal_delivery_findings
           (finding_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, finding,
            attempt_state, supersedes_finding_id, note, found_by_user_id, found_by_role,
            idempotency_key_hash, request_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, 'delivered', 'unknown', NULL, 'Replacing the first finding', ?, 'ops', ?, ?, ?)`,
      ).run(first.finding.finding_id, TENANT, effectId, PACK, REVISION, OPS_ID, "9".repeat(64), "f".repeat(64), new Date().toISOString()),
      /proposal_delivery_finding_exists/,
    );
    assert.throws(
      () => db.raw.prepare("UPDATE proposal_delivery_findings SET note = 'Rewritten note text'").run(),
      /proposal_delivery_findings_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM proposal_delivery_findings").run(),
      /proposal_delivery_findings_append_only/,
    );
    assert.equal(effectRow(db, effectId).state, "succeeded");
  } finally {
    db.close();
  }
});

test("each finding keeps whether the provider confirmed the send or its answer is not confirmed", async () => {
  const { recordProposalDeliveryFinding } = await import("../src/commercial-store.ts");
  for (const mode of ["success", "rejected"] as const) {
    const { db, env, prepare } = await publicationReady(`findings-attempt-${mode}`);
    const effectId = `effect:findings-attempt:${mode}`;
    try {
      const prepared = await prepare(`findings-attempt-${mode}-prepare`);
      const { permit } = await prepared.json() as { permit: Permit };
      if (mode === "success") {
        await runSend(env, permit, effectId, "success");
      } else {
        await runExternalEffect(env, effectRequest(permit, effectId), {
          async dispatch() {
            return { outcome: "rejected", detailCode: "provider_rejected" } as never;
          },
          async replay() {
            return { published: false };
          },
        }).catch(() => undefined);
      }
      db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
      const find = () => recordProposalDeliveryFinding(env, {
        tenantId: TENANT, effectId, supersedesFindingId: null, finding: "not_received",
        note: "They say it is not in their inbox.", actorUserId: OPS_ID, actorRole: "ops",
        idempotencyKey: `findings-attempt-${mode}-1`,
      });
      if (mode === "success") {
        // The provider confirmed the send, and the customer says they did not get it.
        const recorded = await find();
        assert.equal(recorded.finding.attempt_state, "succeeded");
        assert.equal(recorded.finding.finding, "not_received");
        assert.equal(recorded.effectState, "succeeded");
      } else {
        // A send the provider refused reached no one: there is nothing to find.
        await assert.rejects(find(), {
          code: "proposal_delivery_finding_effect_invalid",
          detail: { attempt_state: "failed" },
        });
      }
    } finally {
      db.close();
    }
  }
});

test("a finding is closed once the proposal is sent again", async () => {
  const { db, env, prepare } = await publicationReady("findings-resent");
  const firstSend = "effect:findings-resent:first";
  try {
    const prepared = await prepare("findings-resent-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    // A provider that never answered: a person may call it not delivered once its window has passed.
    // A conflicting readback could not be (0164).
    await runSend(env, permit, firstSend, "unknown");
    const ops = await personSession(db, env, OPS_ID, "ops");
    const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
    const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
    const confirmed = await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId: firstSend, outcome: "not_delivered", note: "Nothing in their inbox or spam folder.",
      actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: "findings-resent-confirm",
      now: new Date(Date.parse(lastAttemptEnd(db, firstSend)) + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString(),
    });
    assert.equal(confirmed.effectState, "reconciled");
    const found = await personPost(env, ops, FINDINGS_PATH, "findings-resent-1", {
      external_effect_id: firstSend,
      supersedes_finding_id: null,
      finding: "not_received",
      note: "It went out, but never reached them.",
    });
    assert.equal(found.status, 201, await found.clone().text());
    const findingId = (await found.json() as { finding: Finding }).finding.finding_id;

    const again = await prepare("findings-resent-prepare-2");
    assert.equal(again.status, 201, await again.clone().text());
    const { permit: second } = await again.json() as { permit: Permit };
    await runSend(env, second, "effect:findings-resent:second", "success");
    const late = await personPost(env, ops, FINDINGS_PATH, "findings-resent-2", {
      external_effect_id: firstSend,
      supersedes_finding_id: findingId,
      finding: "delivered",
      note: "They found the first email after all.",
    });
    assert.equal(late.status, 409);
    assert.deepEqual(await late.json(), { error: "proposal_delivery_finding_closed" });
  } finally {
    db.close();
  }
});

test("a finding is closed once the customer has decided on the proposal", async () => {
  const { recordProposalDeliveryConfirmation, recordProposalDeliveryFinding } = await import("../src/commercial-store.ts");
  const { db, env, prepare } = await publicationReady("findings-decided");
  const effectId = "effect:findings-decided:conflict";
  try {
    const prepared = await prepare("findings-decided-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "conflict");
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const person = { actorUserId: OPS_ID, actorRole: "ops" };
    await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "delivered", note: "The customer has the email.",
      idempotencyKey: "findings-decided-confirm", ...person,
    });
    // The customer's decision is an acceptance on this proposal pack. Its portal link and email
    // challenge are not what this rule reads, so they are left out of this synthetic row.
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const now = new Date().toISOString();
    db.raw.prepare(
      `INSERT INTO customer_portal_acceptance_intents
         (acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id, tenant_id,
          portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version,
          proposal_pack_id, terms_hash, terms_json, signer_name, signer_ip_hash, accepted_at,
          receipt_key, state, created_at, updated_at)
       VALUES ('acceptance_0161decided0001', ?, ?, 'challenge:synthetic:0161', ?, 'portal-link:synthetic:0161',
               ?, ?, ?, ?, 1, ?, ?, '{}', 'Synthetic Signer', ?, ?,
               'customer-contract-acceptance/v1/synthetic/0161-decided.json', 'receipt_pending', ?, ?)`,
    ).run(
      "1".repeat(64), "2".repeat(64), TENANT, JOB_ID, CUSTOMER_ID, "3".repeat(64), QUOTE_ID, PACK,
      "4".repeat(64), "5".repeat(64), now, now, now,
    );
    db.raw.exec("PRAGMA foreign_keys = ON");
    await assert.rejects(
      recordProposalDeliveryFinding(env, {
        tenantId: TENANT, effectId, supersedesFindingId: null, finding: "not_received",
        note: "Recording it after the customer accepted.", idempotencyKey: "findings-decided-1", ...person,
      }),
      { code: "proposal_delivery_finding_closed" },
    );
  } finally {
    db.close();
  }
});

test("D1 refuses an early 'not delivered' on an unknown send, with the window of the send's provider", async () => {
  const { proposalDeliveryLateAnswerWindowMs, recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  for (const { provider, windowMs } of [
    { provider: "native-commercial-publication", windowMs: EFFECT_ATTEMPT_LEASE_MS },
    { provider: "synthetic-slow-provider", windowMs: 600_000 },
  ]) {
    const { db, env, prepare } = await publicationReady(`late-answer-${provider}`);
    const effectId = `effect:late-answer:${provider}`;
    try {
      // 0161 records the default only; a provider with its own window adds a row with its source.
      db.raw.prepare(
        "INSERT INTO proposal_delivery_late_answer_windows (provider, window_ms, source) VALUES (?, ?, ?)",
      ).run("synthetic-slow-provider", 600_000, "Synthetic provider for this test: answers may come ten minutes late.");
      assert.equal(await proposalDeliveryLateAnswerWindowMs(env, provider), windowMs);

      const prepared = await prepare(`late-answer-${provider}-prepare`);
      const { permit } = await prepared.json() as { permit: Permit };
      await runExternalEffect(env, { ...effectRequest(permit, effectId), provider }, {
        async dispatch() {
          return { outcome: "unknown", detailCode: "provider_timeout" } as never;
        },
        async replay() {
          return { published: false };
        },
      }).catch(() => undefined);
      assert.equal(effectRow(db, effectId).state, "unknown");
      const ended = lastAttemptEnd(db, effectId);
      const after = (ms: number) => new Date(Date.parse(ended) + ms).toISOString();
      db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
      const direct = (confirmationId: string, createdAt: string) =>
        db.raw.prepare(
          `INSERT INTO proposal_delivery_confirmations
             (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
              confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
           VALUES (?, ?, ?, ?, ?, 'not_delivered', 'Nothing in their inbox or spam.', ?, 'ops', ?, ?, ?)`,
        ).run(confirmationId, TENANT, effectId, PACK, REVISION, OPS_ID,
          confirmationId.slice(-1).repeat(64), "e".repeat(64), createdAt);

      // D1 itself refuses it inside the provider's window, even past the default lease.
      assert.throws(() => direct("delivery-confirmation:direct-early-1", after(60_000)), /proposal_delivery_answer_may_be_late/);
      assert.throws(() => direct("delivery-confirmation:direct-early-2", after(windowMs - 1_000)), /proposal_delivery_answer_may_be_late/);
      // The Worker names the same moment.
      await assert.rejects(
        recordProposalDeliveryConfirmation(env, {
          tenantId: TENANT, effectId, outcome: "not_delivered", note: "Nothing in their inbox or spam.",
          actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: `late-answer-${provider}-early`,
          now: after(windowMs - 1_000),
        }),
        (error: { code?: string; detail?: { not_before?: string } }) =>
          error.code === "proposal_delivery_answer_may_be_late" && error.detail?.not_before === after(windowMs),
      );
      assert.equal(effectRow(db, effectId).state, "unknown");
      // Once the window has passed, the answer is recorded.
      direct("delivery-confirmation:direct-after-3", after(windowMs + 1_000));
      assert.equal(effectRow(db, effectId).state, "reconciled");
    } finally {
      db.close();
    }
  }
});

test("the late-answer wait also holds after an unknown send became a manual exception", async () => {
  const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  const { db, env, prepare } = await publicationReady("late-manual-exception");
  const effectId = "effect:late-manual-exception:send";
  try {
    await unknownSendThroughRoutes(env, prepare, "late-manual-exception-prepare", effectId);
    const inconclusive = await reconcileThroughRoute(env, effectId, "inconclusive");
    assert.equal(inconclusive.status, 200, await inconclusive.clone().text());
    assert.equal(effectRow(db, effectId).state, "manual_exception");
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const notBefore = new Date(Date.parse(lastAttemptEnd(db, effectId)) + EFFECT_ATTEMPT_LEASE_MS).toISOString();
    const answer = (key: string, now?: string) => recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "not_delivered", note: "Nothing in their inbox or spam.",
      actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: key, ...(now ? { now } : {}),
    });
    // An inconclusive check is not the provider's answer: "not delivered" still waits, in D1 too.
    assert.throws(
      () => db.raw.prepare(
        `INSERT INTO proposal_delivery_confirmations
           (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
            confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
         VALUES ('delivery-confirmation:direct-manual-1', ?, ?, ?, ?, 'not_delivered',
                 'Nothing in their inbox or spam.', ?, 'ops', ?, ?, ?)`,
      ).run(TENANT, effectId, PACK, REVISION, OPS_ID, "1".repeat(64), "e".repeat(64), new Date().toISOString()),
      /proposal_delivery_answer_may_be_late/,
    );
    await assert.rejects(
      answer("late-manual-exception-early"),
      (error: { code?: string; detail?: { not_before?: string } }) =>
        error.code === "proposal_delivery_answer_may_be_late" && error.detail?.not_before === notBefore,
    );
    assert.equal(effectRow(db, effectId).state, "manual_exception");
    const recorded = await answer(
      "late-manual-exception-after",
      new Date(Date.parse(notBefore) + 1_000).toISOString(),
    );
    assert.equal(recorded.effectState, "reconciled");
  } finally {
    db.close();
  }
});

test("the late-answer wait fails closed when no window row is left", async () => {
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  const { db, env, prepare } = await publicationReady("late-answer-no-window");
  const effectId = "effect:late-answer-no-window:unknown";
  try {
    // Only a schema change can remove the default row; with none left the wait is still the lease.
    db.raw.exec("DROP TRIGGER proposal_delivery_late_answer_windows_append_only_delete");
    db.raw.exec("DELETE FROM proposal_delivery_late_answer_windows");
    const prepared = await prepare("late-answer-no-window-prepare");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "unknown");
    const ended = lastAttemptEnd(db, effectId);
    // Only a person's record moves an unknown send to "not executed" (0164), so the wait is read
    // through that record: a "not delivered" row written straight to D1.
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const notDelivered = (id: string, afterMs: number) => db.raw.prepare(
      `INSERT INTO proposal_delivery_confirmations
         (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
          confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, 'not_delivered', 'Nothing in their inbox or spam.', ?, 'ops', ?, ?, ?)`,
    ).run(
      `delivery-confirmation:${id}`, TENANT, effectId, PACK, REVISION, OPS_ID, id.slice(-1).repeat(64),
      "e".repeat(64), new Date(Date.parse(ended) + afterMs).toISOString(),
    );
    assert.throws(() => notDelivered("no-window-early-1", 60_000), /proposal_delivery_answer_may_be_late/);
    assert.equal(effectRow(db, effectId).state, "unknown");
    notDelivered("no-window-after-2", EFFECT_ATTEMPT_LEASE_MS + 1_000);
    assert.equal(effectRow(db, effectId).state, "reconciled");
  } finally {
    db.close();
  }
});

test("a manual exception that came straight from reconciling is not held by the wait, and is never not delivered", async () => {
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
  const { db, env, prepare } = await publicationReady("late-answer-not-from-unknown");
  const effectId = "effect:late-answer-not-from-unknown:send";
  try {
    const prepared = await prepare("late-answer-not-from-unknown-prepare");
    const { permit } = await prepared.json() as { permit: Permit };
    // A proposal send runs once (0164), so it cannot go unknown first and conflict on a second
    // attempt; here it is answered and its readback does not match: the latest move into the
    // exception came from reconciling, not from unknown.
    await assert.rejects(
      runExternalEffect(env, { ...effectRequest(permit, "effect:late-answer-not-from-unknown:retry"), retryLimit: 1 }, {
        async dispatch() {
          return { outcome: "unknown", detailCode: "provider_timeout" } as never;
        },
        async replay() {
          return { published: false };
        },
      }),
      { code: "effect_proposal_failed" },
    );
    await runSend(env, permit, effectId, "conflict");
    assert.equal(effectRow(db, effectId).state, "manual_exception");
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const answer = (outcome: "delivered" | "not_delivered", key: string, now?: string) =>
      recordProposalDeliveryConfirmation(env, {
        tenantId: TENANT, effectId, outcome, note: "Nothing in their inbox or spam.",
        actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: key, ...(now ? { now } : {}),
      });
    // Not held by the wait: the refusal at once and after the window is the readback conflict's, not
    // a late answer's. "Not executed" needs provider evidence.
    const afterWindow = new Date(Date.parse(lastAttemptEnd(db, effectId)) + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString();
    for (const [key, now] of [["late-answer-not-from-unknown-1", undefined], ["late-answer-not-from-unknown-2", afterWindow]] as const) {
      await assert.rejects(answer("not_delivered", key, now), {
        code: "proposal_delivery_confirmation_conflict_needs_provider_evidence",
      });
    }
    assert.equal(effectRow(db, effectId).state, "manual_exception");
    // "Delivered" is recorded at once.
    assert.equal((await answer("delivered", "late-answer-not-from-unknown-3")).effectState, "succeeded");
  } finally {
    db.close();
  }
});

test("the late-answer windows are append-only and the default is the attempt lease", async () => {
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  const db = new SqliteD1();
  try {
    const rows = db.raw.prepare("SELECT provider, window_ms, source FROM proposal_delivery_late_answer_windows").all() as
      Array<{ provider: string; window_ms: number; source: string }>;
    assert.deepEqual(rows.map((row) => [row.provider, row.window_ms]), [["*", EFFECT_ATTEMPT_LEASE_MS]]);
    assert.match(rows[0]!.source, /EFFECT_ATTEMPT_LEASE_MS/);
    assert.throws(
      () => db.raw.prepare("UPDATE proposal_delivery_late_answer_windows SET window_ms = 0").run(),
      /proposal_delivery_late_answer_windows_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM proposal_delivery_late_answer_windows").run(),
      /proposal_delivery_late_answer_windows_append_only/,
    );
    assert.throws(
      () => db.raw.prepare(
        "INSERT OR REPLACE INTO proposal_delivery_late_answer_windows (provider, window_ms, source) VALUES ('*', 0, ?)",
      ).run("A replacement that would switch the wait off."),
      /proposal_delivery_late_answer_windows_append_only/,
    );
  } finally {
    db.close();
  }
});

test("the settle and reconcile admin routes date what they record by the server's clock", async () => {
  const {
    handleExternalEffectClaim,
    handleExternalEffectReconciliation,
    handleExternalEffectSettlement,
  } = await import("../src/effect-runtime-admin.ts");
  const { db, env, prepare } = await publicationReady("server-time");
  const effectId = "effect:server-time:send";
  try {
    const prepared = await prepare("server-time-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    // The routes take a proposal send only as the QA stand-in on a synthetic Worker (0164).
    const synthetic = syntheticWorker(env);
    const send = { ...effectRequest(permit, effectId), provider: "qa-synthetic-publication" };
    const claimed = await handleExternalEffectClaim(adminPost("/admin/effects/claim", {
      effect: send,
      authority: send.authority,
    }), synthetic);
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const { attempt } = await claimed.json() as { attempt: { attempt_id: string } };

    // A caller's time is ignored: a settlement dated years ago is recorded now.
    const beforeSettle = Date.now();
    const settled = await handleExternalEffectSettlement(adminPost("/admin/effects/settle", {
      effectId,
      settlement: {
        attemptId: attempt.attempt_id,
        outcome: "unknown",
        detailCode: "provider_timeout",
        now: "2020-01-01T00:00:00.000Z",
      },
    }), synthetic);
    assert.equal(settled.status, 200, await settled.clone().text());
    const afterSettle = Date.now();
    const unknown = effectRow(db, effectId);
    assert.equal(unknown.state, "unknown");
    assert.ok(
      Date.parse(unknown.updated_at) >= beforeSettle && Date.parse(unknown.updated_at) <= afterSettle,
      `settled at ${unknown.updated_at}, not at the caller's time`,
    );
    assert.equal(lastAttemptEnd(db, effectId), unknown.updated_at);

    // A reconcile is no person's record, so it cannot call the unknown send executed (0164).
    const executedClaim = await handleExternalEffectReconciliation(adminPost("/admin/effects/reconcile", {
      effectId,
      outcome: "executed",
      evidence: { provider: "late answer: delivered" },
      now: "2099-01-01T00:00:00.000Z",
    }), synthetic);
    assert.equal(executedClaim.status, 409, await executedClaim.clone().text());
    assert.deepEqual(await executedClaim.json(), { error: "effect_reconciliation_evidence_missing" });
    assert.equal(effectRow(db, effectId).state, "unknown");
    // Likewise a reconciliation dated far ahead is recorded now: an inconclusive check hands the
    // send to a person, dated by the server's clock.
    const beforeReconcile = Date.now();
    const reconciled = await handleExternalEffectReconciliation(adminPost("/admin/effects/reconcile", {
      effectId,
      outcome: "inconclusive",
      evidence: { provider: "no answer yet" },
      now: "2099-01-01T00:00:00.000Z",
    }), synthetic);
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    const afterReconcile = Date.now();
    const inconclusive = effectRow(db, effectId);
    assert.equal(inconclusive.state, "manual_exception");
    assert.ok(
      Date.parse(inconclusive.updated_at) >= beforeReconcile && Date.parse(inconclusive.updated_at) <= afterReconcile,
      `reconciled at ${inconclusive.updated_at}, not at the caller's time`,
    );
  } finally {
    db.close();
  }
});

test("D1 refuses moving an unknown send to not executed before its provider's late-answer window", async () => {
  const { EFFECT_ATTEMPT_LEASE_MS } = await import("../src/effect-runtime.ts");
  const { db, env, prepare } = await publicationReady("late-reconcile-d1");
  const effectId = "effect:late-reconcile-d1:unknown";
  try {
    const prepared = await prepare("late-reconcile-d1-prepare");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "unknown");
    assert.equal(effectRow(db, effectId).state, "unknown");
    const ended = lastAttemptEnd(db, effectId);
    const after = (ms: number) => new Date(Date.parse(ended) + ms).toISOString();
    const notExecuted = (updatedAt: string) => db.raw.prepare(
      `UPDATE external_effects SET state = 'reconciled', result_code = 'reconciled_not_executed',
         updated_at = ? WHERE effect_id = ? AND state = 'unknown'`,
    ).run(updatedAt, effectId);
    // Inside the window the move itself is refused, by the wait (0161) and, with no person's record,
    // by the evidence rule (0164) too; which of the two answers first is not part of the contract.
    assert.throws(
      () => notExecuted(after(EFFECT_ATTEMPT_LEASE_MS - 1_000)),
      /proposal_delivery_answer_may_be_late|proposal_delivery_settle_evidence_missing/,
    );
    // After the window the wait is over, but a move with no person's record is still refused (0164).
    assert.throws(() => notExecuted(after(EFFECT_ATTEMPT_LEASE_MS + 1_000)), /proposal_delivery_settle_evidence_missing/);
    assert.equal(effectRow(db, effectId).state, "unknown");
    // A person's record inside the window is refused by the wait alone, and after it the send is not
    // executed.
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const notDelivered = (id: string, createdAt: string) => db.raw.prepare(
      `INSERT INTO proposal_delivery_confirmations
         (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
          confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, 'not_delivered', 'Nothing in their inbox or spam.', ?, 'ops', ?, ?, ?)`,
    ).run(`delivery-confirmation:${id}`, TENANT, effectId, PACK, REVISION, OPS_ID, id.slice(-1).repeat(64), "e".repeat(64), createdAt);
    assert.throws(() => notDelivered("late-reconcile-d1-early-1", after(EFFECT_ATTEMPT_LEASE_MS - 1_000)), /proposal_delivery_answer_may_be_late/);
    assert.equal(effectRow(db, effectId).state, "unknown");
    notDelivered("late-reconcile-d1-after-2", after(EFFECT_ATTEMPT_LEASE_MS + 1_000));
    assert.equal(effectRow(db, effectId).state, "reconciled");
  } finally {
    db.close();
  }
});

test("the reconcile route cannot call an unknown send not executed inside its provider's window", async () => {
  const { recordProposalDeliveryConfirmation } = await import("../src/commercial-store.ts");
  // The token takes a proposal send only as the QA seed's pair on a synthetic Worker, so each run
  // gives that one stand-in a window of its own: a slow provider and an instant one.
  const provider = "qa-synthetic-publication";
  for (const { label, windowMs, early } of [
    { label: "slow", windowMs: 3_600_000, early: true },
    { label: "instant", windowMs: 0, early: false },
  ]) {
    const { db, env, prepare } = await publicationReady(`late-reconcile-route-${label}`);
    const effectId = `effect:late-reconcile-route:${label}`;
    try {
      db.raw.prepare(
        "INSERT INTO proposal_delivery_late_answer_windows (provider, window_ms, source) VALUES (?, ?, ?)",
      ).run(provider, windowMs, `Synthetic ${label} window for this test's stand-in provider.`);
      await unknownSendThroughRoutes(env, prepare, `late-reconcile-route-${label}-prepare`, effectId, provider);
      // A reconcile is no person's record, so the route never calls a proposal send not executed
      // (0164). Inside the provider's window the wait refuses it as well (0161); which of the two
      // answers first is not part of the contract.
      const reconciled = await reconcileThroughRoute(env, effectId, "not_executed");
      assert.equal(reconciled.status, 409, await reconciled.clone().text());
      const { error } = await reconciled.json() as { error: string };
      if (early) {
        assert.ok(["proposal_delivery_answer_may_be_late", "effect_reconciliation_evidence_missing"].includes(error), error);
      } else {
        assert.equal(error, "effect_reconciliation_evidence_missing");
      }
      // Nor does a provider answer that it did go out settle it: that is a person's to record.
      const executed = await reconcileThroughRoute(env, effectId, "executed");
      assert.equal(executed.status, 409, await executed.clone().text());
      assert.deepEqual(await executed.json(), { error: "effect_reconciliation_evidence_missing" });
      assert.equal(effectRow(db, effectId).state, "unknown");
      // A person's "not delivered" waits for the provider's own window, and then settles the send.
      db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
      const notDelivered = (key: string, now?: string) => recordProposalDeliveryConfirmation(env, {
        tenantId: TENANT, effectId, outcome: "not_delivered", note: "Nothing in their inbox or spam.",
        actorUserId: OPS_ID, actorRole: "ops", idempotencyKey: key, ...(now ? { now } : {}),
      });
      if (early) {
        await assert.rejects(notDelivered(`${label}-early`), { code: "proposal_delivery_answer_may_be_late" });
        assert.equal(effectRow(db, effectId).state, "unknown");
      }
      const after = new Date(Date.parse(lastAttemptEnd(db, effectId)) + windowMs + 1_000).toISOString();
      assert.equal((await notDelivered(`${label}-after`, after)).effectState, "reconciled");
    } finally {
      db.close();
    }
  }
});

test("D1 names the permit holder of every new publication, whoever records it", async () => {
  const { db, env, prepare } = await publicationReady("recorded-by");
  const effectId = "effect:recorded-by:success";
  try {
    // OPS_ID prepares, so OPS_ID holds the permit.
    const prepared = await prepare("recorded-by-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "success");
    // Another commercial person records the send that ran (readback, #15).
    const other = await personSession(db, env, OTHER_OPS_ID, "ops");
    const settlement = {
      proposal_revision_id: REVISION,
      proposal_pack_id: PACK,
      publication_version: 1,
      previous_state: "draft",
      state: "published",
      permit_id: permit.permit_id,
      external_effect_id: effectId,
    };
    const recorded = await personPost(env, other, "/api/v1/commercial/proposal-publications", "recorded-by-record", settlement);
    assert.equal(recorded.status, 201, await recorded.clone().text());
    const { publication } = await recorded.json() as {
      publication: { publication_event_id: string; occurred_at: string };
    };
    // D1 wrote the permit holder in the insert's own statement: not the person who pressed record,
    // and no Worker field supplied it.
    assert.deepEqual(
      { ...db.raw.prepare(
        "SELECT permit_holder_user_id, occurred_at FROM commercial_proposal_publication_permit_holders WHERE publication_event_id = ?",
      ).get(publication.publication_event_id) },
      { permit_holder_user_id: OPS_ID, occurred_at: publication.occurred_at },
    );

    // A permit-holder row is only ever the permit holder of an existing event; it is never rewritten.
    const insertHolder = (publicationEventId: string, userId: string, occurredAt: string) =>
      db.raw.prepare(
        `INSERT INTO commercial_proposal_publication_permit_holders
           (publication_event_id, tenant_id, permit_holder_user_id, occurred_at) VALUES (?, ?, ?, ?)`,
      ).run(publicationEventId, TENANT, userId, occurredAt);
    assert.throws(
      () => insertHolder(publication.publication_event_id, OTHER_OPS_ID, publication.occurred_at),
      /commercial_publication_permit_holder_exists/,
    );
    assert.throws(
      () => insertHolder("commercial-publication:no-such-event-0161", OPS_ID, publication.occurred_at),
      /commercial_publication_permit_holder_invalid/,
    );
    assert.throws(
      () => db.raw.prepare("UPDATE commercial_proposal_publication_permit_holders SET permit_holder_user_id = ?").run(OTHER_OPS_ID),
      /commercial_proposal_publication_permit_holders_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM commercial_proposal_publication_permit_holders").run(),
      /commercial_proposal_publication_permit_holders_append_only/,
    );
  } finally {
    db.close();
  }
});

test("0161 only adds objects: it re-creates or drops nothing an earlier migration created", () => {
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const created = (sql: string) =>
    [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi)]
      .map((match) => match[1]!.toLowerCase());
  const migration0161 = readFileSync(new URL("0161_proposal_delivery_corrections.sql", directory), "utf8");
  assert.doesNotMatch(migration0161, /\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i);
  assert.doesNotMatch(migration0161, /\bALTER\s+TABLE\b/i);
  const earlier = new Set(
    files.filter((name) => name < "0161").flatMap((name) => created(readFileSync(new URL(name, directory), "utf8"))),
  );
  const objects = created(migration0161);
  assert.deepEqual(objects.filter((name) => earlier.has(name)), []);
  assert.deepEqual(objects.sort(), [
    "commercial_proposal_publication_permit_holders",
    "commercial_proposal_publication_permit_holders_append_only_delete",
    "commercial_proposal_publication_permit_holders_append_only_update",
    "commercial_proposal_publication_permit_holders_validate_insert",
    "commercial_publication_permit_holder_from_permit",
    "external_effects_proposal_late_answer_guard",
    "idx_proposal_delivery_findings_effect",
    "proposal_delivery_findings",
    "proposal_delivery_findings_append_only_delete",
    "proposal_delivery_findings_append_only_update",
    "proposal_delivery_findings_audit",
    "proposal_delivery_findings_validate_insert",
    "proposal_delivery_late_answer_windows",
    "proposal_delivery_late_answer_windows_append_only_delete",
    "proposal_delivery_late_answer_windows_append_only_update",
    "proposal_delivery_late_answer_windows_no_insert_replace",
  ]);
});
