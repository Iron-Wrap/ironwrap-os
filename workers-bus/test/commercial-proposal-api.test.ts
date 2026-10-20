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

      const recorded = await confirm(`delivery-confirm-${outcome}`, confirmation);
      assert.equal(recorded.status, 201, await recorded.clone().text());
      const expectedState = outcome === "delivered" ? "succeeded" : "reconciled";
      assert.equal((await recorded.json() as { effect: { state: string } }).effect.state, expectedState);
      assert.equal(effectState(), expectedState);
      assert.equal(
        (db.raw.prepare("SELECT count(*) AS n FROM audit_log WHERE automation = 'proposal_delivery'").get() as { n: number }).n,
        1,
        "one audit row per confirmation",
      );
      assert.equal(
        (db.raw.prepare("SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'open'")
          .get(effectId) as { n: number }).n,
        0,
        "the exception the send opened is resolved by the confirmation",
      );
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
      if (outcome === "not_delivered") {
        assert.equal(next.status, 201, "not delivered: the proposal may be sent again");
      } else {
        // Delivered: record that send as the publication instead of sending it a second time.
        assert.equal(next.status, 409);
        assert.deepEqual(await next.json(), {
          error: "proposal_delivery_not_recorded",
          delivery_state: "succeeded",
          external_effect_id: effectId,
          next_step: "record_publication",
        });
      }
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

    // The service-token claim path never passes through prepare; D1 refuses the second send itself.
    const second = effectRequest(permit, "effect:single-flight:second");
    const claim = await handleExternalEffectClaim(
      new Request("https://worker.example.com/admin/effects/claim", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
        body: JSON.stringify({ effect: second, authority: second.authority }),
      }),
      env,
    );
    assert.equal(claim.status, 409, await claim.clone().text());
    assert.deepEqual(await claim.json(), { error: "proposal_delivery_unconfirmed" });
    assert.equal(
      (db.raw.prepare("SELECT count(*) AS n FROM external_effects WHERE action = 'proposal.publish'").get() as { n: number }).n,
      1,
    );

    // A caller-supplied compensation link is no exemption: a "compensation" that is itself a
    // publish of the same revision is a second send.
    const disguised = effectRequest(permit, "effect:single-flight:disguised");
    const disguisedClaim = await handleExternalEffectClaim(
      new Request("https://worker.example.com/admin/effects/claim", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
        body: JSON.stringify({
          effect: { ...disguised, compensatesEffectId: "effect:single-flight:unknown" },
          authority: disguised.authority,
        }),
      }),
      env,
    );
    assert.equal(disguisedClaim.status, 409, await disguisedClaim.clone().text());
    assert.deepEqual(await disguisedClaim.json(), { error: "proposal_delivery_unconfirmed" });
    assert.equal(
      (db.raw.prepare("SELECT count(*) AS n FROM external_effects WHERE action = 'proposal.publish'").get() as { n: number }).n,
      1,
      "no second publish effect exists",
    );
    // The claim runs on the server's clock: a backdated `now` cannot make a lapsed deadline current.
    const backdated = effectRequest(permit, "effect:single-flight:backdated", new Date(Date.now() - 60_000).toISOString());
    const backdatedClaim = await handleExternalEffectClaim(
      new Request("https://worker.example.com/admin/effects/claim", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
        body: JSON.stringify({
          effect: { ...backdated, now: new Date(Date.now() - 120_000).toISOString() },
          authority: backdated.authority,
        }),
      }),
      env,
    );
    assert.equal(backdatedClaim.status, 422, await backdatedClaim.clone().text());
    assert.deepEqual(await backdatedClaim.json(), { error: "effect_deadline_invalid" });

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
    const confirmed = await personPost(env, ops, CONFIRM_PATH, "ledger-confirm", {
      external_effect_id: "effect:ledger:conflict",
      outcome: "not_delivered",
      note: "The customer has not received anything.",
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

    // A send that succeeded is recorded by another commercial person, with no hand confirmation.
    const { reconcileExternalEffect } = await import("../src/effect-runtime.ts");
    await reconcileExternalEffect(env, "effect:versions:unknown", {
      outcome: "executed",
      evidence: { provider: "late answer: delivered" },
    });
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

// ---------------------------------------------------------------------------------------------
// #15b-1 (0161): corrections as superseding rows, the late-answer wait in D1 with a window per
// provider, server time on the settle and reconcile admin routes, and who recorded a publication.

const CORRECT_PATH = "/api/v1/commercial/proposal-publications/delivery-corrections";

type Correction = {
  correction_id: string;
  supersedes_confirmation_id: string | null;
  supersedes_correction_id: string | null;
  outcome: string;
};

function effectState(db: SqliteD1, effectId: string): { state: string; updated_at: string; result_code: string | null } {
  return db.raw.prepare("SELECT state, updated_at, result_code FROM external_effects WHERE effect_id = ?")
    .get(effectId) as { state: string; updated_at: string; result_code: string | null };
}

test("a correction supersedes the newest answer, moves the send between delivered and not delivered, and is audited", async () => {
  const { db, env, prepare } = await publicationReady("correction-chain");
  const effectId = "effect:correction:conflict";
  try {
    const prepared = await prepare("correction-chain-prepare-1");
    assert.equal(prepared.status, 201);
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "conflict");
    const ops = await personSession(db, env, OPS_ID, "ops");
    const other = await personSession(db, env, OTHER_OPS_ID, "sales");

    // Nothing was recorded by hand yet, so there is nothing to change.
    const tooEarly = await personPost(env, ops, CORRECT_PATH, "correction-chain-too-early", {
      external_effect_id: effectId,
      supersedes_id: "delivery-confirmation:not-recorded-0001",
      outcome: "not_delivered",
      note: "Nothing was recorded for this send yet.",
    });
    assert.equal(tooEarly.status, 409);
    assert.deepEqual(await tooEarly.json(), {
      error: "proposal_delivery_nothing_recorded",
      delivery_state: "manual_exception",
    });

    const first = await personPost(env, ops, CONFIRM_PATH, "correction-chain-confirm", {
      external_effect_id: effectId,
      outcome: "delivered",
      note: "Called the customer; the email is in their inbox.",
    });
    assert.equal(first.status, 201, await first.clone().text());
    const confirmationId = (await first.json() as { confirmation: { confirmation_id: string } })
      .confirmation.confirmation_id;
    assert.equal(effectState(db, effectId).state, "succeeded");

    // A malformed body is refused before anything is read.
    const malformed = await personPost(env, ops, CORRECT_PATH, "correction-chain-malformed", {
      external_effect_id: effectId,
      supersedes_id: confirmationId,
      outcome: "not_delivered",
      note: "short",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_proposal_delivery_correction" });

    const toNotDelivered = {
      external_effect_id: effectId,
      supersedes_id: confirmationId,
      outcome: "not_delivered",
      note: "They called back: that was an older email, not this proposal.",
    };
    const corrected = await personPost(env, ops, CORRECT_PATH, "correction-chain-1", toNotDelivered);
    assert.equal(corrected.status, 201, await corrected.clone().text());
    const firstCorrection = await corrected.json() as {
      correction: Correction;
      effect: { external_effect_id: string; state: string };
      replayed: boolean;
    };
    assert.deepEqual(firstCorrection.effect, { external_effect_id: effectId, state: "reconciled" });
    assert.equal(firstCorrection.correction.supersedes_confirmation_id, confirmationId);
    assert.equal(firstCorrection.correction.supersedes_correction_id, null);
    assert.equal(effectState(db, effectId).state, "reconciled");
    assert.equal(effectState(db, effectId).result_code, "reconciled_not_executed");

    // The same key and request replays; the same key with another request conflicts.
    const replay = await personPost(env, ops, CORRECT_PATH, "correction-chain-1", toNotDelivered);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    const conflicting = await personPost(env, ops, CORRECT_PATH, "correction-chain-1", {
      ...toNotDelivered,
      note: "Another note under the same key.",
    });
    assert.equal(conflicting.status, 409);
    assert.deepEqual(await conflicting.json(), { error: "proposal_delivery_correction_replay_conflict" });

    // Correcting the first answer again would fork the history: only the newest is corrected.
    const fork = await personPost(env, other, CORRECT_PATH, "correction-chain-fork", {
      ...toNotDelivered,
      outcome: "delivered",
      note: "Correcting the answer someone already corrected.",
    });
    assert.equal(fork.status, 409);
    assert.deepEqual(await fork.json(), {
      error: "proposal_delivery_correction_not_latest",
      latest_answer_id: firstCorrection.correction.correction_id,
    });

    const back = await personPost(env, other, CORRECT_PATH, "correction-chain-2", {
      external_effect_id: effectId,
      supersedes_id: firstCorrection.correction.correction_id,
      outcome: "delivered",
      note: "Found it in their spam folder after all.",
    });
    assert.equal(back.status, 201, await back.clone().text());
    const secondCorrection = (await back.json() as { correction: Correction }).correction;
    assert.equal(secondCorrection.supersedes_correction_id, firstCorrection.correction.correction_id);
    assert.equal(secondCorrection.supersedes_confirmation_id, null);
    assert.equal(effectState(db, effectId).state, "succeeded");
    assert.equal(effectState(db, effectId).result_code, "delivery_confirmed_by_hand");

    // Restating the same outcome with a new note is a record only; the send stays where it is.
    const stateBefore = effectState(db, effectId);
    const restated = await personPost(env, ops, CORRECT_PATH, "correction-chain-3", {
      external_effect_id: effectId,
      supersedes_id: secondCorrection.correction_id,
      outcome: "delivered",
      note: "Checked again with the customer; they have it.",
    });
    assert.equal(restated.status, 201, await restated.clone().text());
    assert.deepEqual(effectState(db, effectId), stateBefore);

    // The history: the first answer is unchanged and each correction names the one before it.
    assert.deepEqual(
      { ...db.raw.prepare("SELECT outcome, note FROM proposal_delivery_confirmations WHERE confirmation_id = ?").get(confirmationId) },
      { outcome: "delivered", note: "Called the customer; the email is in their inbox." },
    );
    assert.deepEqual(
      (db.raw.prepare(
        `SELECT outcome, corrected_by_user_id, corrected_by_role FROM proposal_delivery_corrections
          WHERE effect_id = ? ORDER BY created_at, correction_id`,
      ).all(effectId) as Array<Record<string, string>>).map((row) => ({ ...row })),
      [
        { outcome: "not_delivered", corrected_by_user_id: OPS_ID, corrected_by_role: "ops" },
        { outcome: "delivered", corrected_by_user_id: OTHER_OPS_ID, corrected_by_role: "sales" },
        { outcome: "delivered", corrected_by_user_id: OPS_ID, corrected_by_role: "ops" },
      ],
    );
    // One audit row per answer, written by the insert's own statement.
    assert.deepEqual(
      (db.raw.prepare(
        `SELECT action, approved_by FROM audit_log WHERE automation = 'proposal_delivery'
          ORDER BY rowid`,
      ).all() as Array<Record<string, string>>).map((row) => ({ ...row })),
      [
        { action: "proposal_delivery_delivered", approved_by: OPS_ID },
        { action: "proposal_delivery_correction_not_delivered", approved_by: OPS_ID },
        { action: "proposal_delivery_correction_delivered", approved_by: OTHER_OPS_ID },
        { action: "proposal_delivery_correction_delivered", approved_by: OPS_ID },
      ],
    );

    // A caller that is not a person's own session is refused, as for the first answer.
    const notPerson = await handleAuthenticatedRoute(
      request(CORRECT_PATH, toNotDelivered, "correction-chain-not-person"),
      env,
      auth("ops"),
    );
    assert.equal(notPerson.status, 403);
    assert.deepEqual(await notPerson.json(), { error: "person_session_required" });
  } finally {
    db.close();
  }
});

test("D1 holds the correction chain: one successor per answer, moves only with their correction, append-only", async () => {
  const { claimExternalEffect, retryExternalEffect, settleExternalEffect } = await import("../src/effect-runtime.ts");
  const { recordProposalDeliveryConfirmation, recordProposalDeliveryCorrection } = await import("../src/commercial-store.ts");
  const { db, env, prepare } = await publicationReady("correction-d1");
  const effectId = "effect:correction-d1:conflict";
  try {
    const prepared = await prepare("correction-d1-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    // One retry allowed, so the send can move on after "not delivered".
    await runExternalEffect(env, { ...effectRequest(permit, effectId), retryLimit: 1 }, {
      async dispatch() {
        return {
          outcome: "accepted" as const,
          value: { published: true },
          providerExternalId: `provider:${effectId}`,
          providerResponse: { id: `provider:${effectId}` },
          readback: {
            status: "match" as const,
            providerExternalId: `provider:${effectId}`,
            observed: { ...READBACK, state: "withdrawn" },
          },
        };
      },
      async replay() {
        return { published: false };
      },
    }).catch(() => undefined);
    assert.equal(effectState(db, effectId).state, "manual_exception");
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const person = { actorUserId: OPS_ID, actorRole: "ops" };
    const { confirmation } = await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "delivered", note: "The customer has the email.",
      idempotencyKey: "correction-d1-confirm", ...person,
    });
    const first = await recordProposalDeliveryCorrection(env, {
      tenantId: TENANT, effectId, supersedesId: confirmation.confirmation_id, outcome: "not_delivered",
      note: "It was an older email after all.", idempotencyKey: "correction-d1-1", ...person,
    });
    assert.equal(first.effectState, "reconciled");

    const direct = (correctionId: string, supersedes: { confirmation?: string; correction?: string }, outcome: string) =>
      db.raw.prepare(
        `INSERT INTO proposal_delivery_corrections
           (correction_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id,
            supersedes_confirmation_id, supersedes_correction_id, outcome, note, corrected_by_user_id,
            corrected_by_role, idempotency_key_hash, request_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Direct insert attempt', ?, 'ops', ?, ?, ?)`,
      ).run(
        correctionId, TENANT, effectId, PACK, REVISION, supersedes.confirmation ?? null,
        supersedes.correction ?? null, outcome, OPS_ID,
        correctionId.slice(-1).repeat(64), "f".repeat(64), new Date().toISOString(),
      );
    // A second successor of the confirmation is a fork.
    assert.throws(
      () => direct("delivery-correction:direct-fork-a", { confirmation: confirmation.confirmation_id }, "delivered"),
      /proposal_delivery_correction_not_latest/,
    );
    // An answer that is not about this send cannot be superseded.
    assert.throws(
      () => direct("delivery-correction:direct-orphan-b", { correction: "delivery-correction:no-such-answer" }, "delivered"),
      /proposal_delivery_correction_chain_invalid/,
    );
    // The send cannot leave "not delivered" by a plain update, only by a correction that says so.
    assert.throws(
      () => db.raw.prepare(
        "UPDATE external_effects SET state = 'succeeded', updated_at = ? WHERE effect_id = ?",
      ).run(new Date().toISOString(), effectId),
      /external_effect_invalid_transition/,
    );
    assert.equal(effectState(db, effectId).state, "reconciled");

    // The next send closes the record: here the same send is tried again and goes out.
    await retryExternalEffect(env, effectId);
    const { attempt } = await claimExternalEffect(env, effectId, new Date());
    await settleExternalEffect(env, effectId, {
      attemptId: attempt.attempt_id,
      outcome: "accepted",
      providerExternalId: `provider:${effectId}:retry`,
      readback: { status: "match", providerExternalId: `provider:${effectId}:retry`, observed: READBACK },
    });
    assert.equal(effectState(db, effectId).state, "succeeded");
    await assert.rejects(
      recordProposalDeliveryCorrection(env, {
        tenantId: TENANT, effectId, supersedesId: first.correction.correction_id, outcome: "delivered",
        note: "Trying to change it after the next send.", idempotencyKey: "correction-d1-after-send", ...person,
      }),
      { code: "proposal_delivery_correction_closed" },
    );
    // The old "not delivered" cannot be replayed onto the sent message, even at its own time.
    assert.throws(
      () => db.raw.prepare(
        "UPDATE external_effects SET state = 'reconciled', updated_at = ? WHERE effect_id = ?",
      ).run(first.correction.created_at, effectId),
      /external_effect_invalid_transition/,
    );

    // Append-only.
    assert.throws(
      () => db.raw.prepare("UPDATE proposal_delivery_corrections SET note = 'Rewritten note text'").run(),
      /proposal_delivery_corrections_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM proposal_delivery_corrections").run(),
      /proposal_delivery_corrections_append_only/,
    );
  } finally {
    db.close();
  }
});

test("a correction is closed once the customer has decided on the proposal", async () => {
  const { recordProposalDeliveryConfirmation, recordProposalDeliveryCorrection } = await import("../src/commercial-store.ts");
  const { db, env, prepare } = await publicationReady("correction-decided");
  const effectId = "effect:correction-decided:conflict";
  try {
    const prepared = await prepare("correction-decided-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "conflict");
    db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = ?").run(OPS_ID);
    const person = { actorUserId: OPS_ID, actorRole: "ops" };
    const { confirmation } = await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "delivered", note: "The customer has the email.",
      idempotencyKey: "correction-decided-confirm", ...person,
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
      recordProposalDeliveryCorrection(env, {
        tenantId: TENANT, effectId, supersedesId: confirmation.confirmation_id, outcome: "not_delivered",
        note: "Changing it after the customer accepted.", idempotencyKey: "correction-decided-1", ...person,
      }),
      { code: "proposal_delivery_correction_closed" },
    );
    assert.equal(effectState(db, effectId).state, "succeeded");
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
      const unknown = effectState(db, effectId);
      assert.equal(unknown.state, "unknown");
      const after = (ms: number) => new Date(Date.parse(unknown.updated_at) + ms).toISOString();
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
      assert.equal(effectState(db, effectId).state, "unknown");
      // Once the window has passed, the answer is recorded.
      direct("delivery-confirmation:direct-after-3", after(windowMs + 1_000));
      assert.equal(effectState(db, effectId).state, "reconciled");
    } finally {
      db.close();
    }
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
  const adminPost = (path: string, body: Record<string, unknown>) =>
    new Request(`https://worker.example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${EFFECT_TOKEN}` },
      body: JSON.stringify(body),
    });
  try {
    const prepared = await prepare("server-time-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    const send = effectRequest(permit, effectId);
    const claimed = await handleExternalEffectClaim(adminPost("/admin/effects/claim", {
      effect: send,
      authority: send.authority,
    }), env);
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
    }), env);
    assert.equal(settled.status, 200, await settled.clone().text());
    const afterSettle = Date.now();
    const unknown = effectState(db, effectId);
    assert.equal(unknown.state, "unknown");
    assert.ok(
      Date.parse(unknown.updated_at) >= beforeSettle && Date.parse(unknown.updated_at) <= afterSettle,
      `settled at ${unknown.updated_at}, not at the caller's time`,
    );
    const ended = db.raw.prepare("SELECT ended_at FROM external_effect_attempts WHERE attempt_id = ?")
      .get(attempt.attempt_id) as { ended_at: string };
    assert.equal(ended.ended_at, unknown.updated_at);

    // Likewise a reconciliation dated far ahead is recorded now.
    const beforeReconcile = Date.now();
    const reconciled = await handleExternalEffectReconciliation(adminPost("/admin/effects/reconcile", {
      effectId,
      outcome: "executed",
      evidence: { provider: "late answer: delivered" },
      now: "2099-01-01T00:00:00.000Z",
    }), env);
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    const afterReconcile = Date.now();
    const executed = effectState(db, effectId);
    assert.equal(executed.state, "succeeded");
    assert.ok(
      Date.parse(executed.updated_at) >= beforeReconcile && Date.parse(executed.updated_at) <= afterReconcile,
      `reconciled at ${executed.updated_at}, not at the caller's time`,
    );
  } finally {
    db.close();
  }
});

test("every new publication names the active person who recorded it, and D1 holds that rule", async () => {
  const { db, env, prepare } = await publicationReady("recorded-by");
  const effectId = "effect:recorded-by:success";
  try {
    const prepared = await prepare("recorded-by-prepare-1");
    const { permit } = await prepared.json() as { permit: Permit };
    await runSend(env, permit, effectId, "success");
    assert.equal(effectState(db, effectId).state, "succeeded");

    // Without the person who recorded it, D1 refuses the publication event itself.
    const stored = db.raw.prepare(
      "SELECT command_fingerprint, evidence_digest FROM commercial_authority_permits WHERE permit_id = ?",
    ).get(permit.permit_id) as { command_fingerprint: string; evidence_digest: string };
    const eventId = "commercial-publication:direct-0161-recorder";
    const occurredAt = new Date().toISOString();
    const insertEvent = () => db.raw.prepare(
      `INSERT INTO commercial_proposal_publication_events (
         publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
         publication_version, previous_state, state, policy_permit_id,
         proposal_publication_approval_id, external_effect_id, command_fingerprint,
         idempotency_key_hash, evidence_digest, occurred_at
       ) VALUES (?, ?, ?, ?, 1, 'draft', 'published', ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(eventId, TENANT, REVISION, PACK, permit.permit_id, effectId, stored.command_fingerprint,
      "9".repeat(64), stored.evidence_digest, occurredAt);
    assert.throws(insertEvent, /commercial_publication_recorder_required/);
    const insertRecorder = (publicationEventId: string, userId: string, recordedAt: string) =>
      db.raw.prepare(
        `INSERT INTO commercial_proposal_publication_recorders
           (publication_event_id, tenant_id, recorded_by_user_id, recorded_at) VALUES (?, ?, ?, ?)`,
      ).run(publicationEventId, TENANT, userId, recordedAt);
    // Only an active person of this tenant may be named.
    assert.throws(
      () => insertRecorder("commercial-publication:direct-0161-unknown", "appu_unknown_0161", occurredAt),
      /commercial_publication_recorder_invalid/,
    );
    db.raw.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(OTHER_OPS_ID);
    assert.throws(
      () => insertRecorder("commercial-publication:direct-0161-inactive", OTHER_OPS_ID, occurredAt),
      /commercial_publication_recorder_invalid/,
    );
    db.raw.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(OTHER_OPS_ID);

    // Through the route, the person recording it is named, at the event's own time.
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
      publication: { publication_event_id: string; occurred_at: string; recorded_by_user_id: string };
    };
    assert.equal(publication.recorded_by_user_id, OTHER_OPS_ID);
    assert.deepEqual(
      { ...db.raw.prepare(
        "SELECT recorded_by_user_id, recorded_at FROM commercial_proposal_publication_recorders WHERE publication_event_id = ?",
      ).get(publication.publication_event_id) },
      { recorded_by_user_id: OTHER_OPS_ID, recorded_at: publication.occurred_at },
    );
    const replay = await personPost(env, other, "/api/v1/commercial/proposal-publications", "recorded-by-record", settlement);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { publication: { recorded_by_user_id: string } }).publication.recorded_by_user_id, OTHER_OPS_ID);

    // A recorder cannot be added to an event already recorded, and recorders are append-only.
    assert.throws(
      () => insertRecorder(publication.publication_event_id, OPS_ID, publication.occurred_at),
      /commercial_publication_recorder_after_event/,
    );
    assert.throws(
      () => db.raw.prepare("UPDATE commercial_proposal_publication_recorders SET recorded_by_user_id = ?").run(OPS_ID),
      /commercial_proposal_publication_recorders_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM commercial_proposal_publication_recorders").run(),
      /commercial_proposal_publication_recorders_append_only/,
    );
  } finally {
    db.close();
  }
});

test("0161 re-creates the 0156 triggers with every 0156 line kept in order and each addition marked", () => {
  const db = new SqliteD1();
  try {
    const migration0156 = readFileSync(
      new URL("../migrations/0156_proposal_delivery_confirmations.sql", import.meta.url),
      "utf8",
    );
    for (const name of ["proposal_delivery_confirmations_validate_insert", "external_effect_binding_guard"]) {
      const start = migration0156.search(new RegExp(`CREATE TRIGGER (?:IF NOT EXISTS )?${name}\\n`));
      assert.ok(start >= 0, `0156 declares ${name}`);
      const end = migration0156.indexOf("\nEND;", start);
      // Body lines only: the CREATE line is normalized by SQLite, and the stored text ends at END.
      const lines0156 = migration0156.slice(start, end).split("\n").slice(1).map((line) => line.trim()).concat("END");
      const stored = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(name) as { sql: string }).sql;
      const finalLines = stored.split("\n").slice(1).map((line) => line.trim());
      let next = 0;
      for (const line of finalLines) {
        if (next < lines0156.length && line === lines0156[next]) next += 1;
        else assert.match(line, /\[0161\]/, `${name}: a line that is not from 0156 must be marked [0161]: ${line}`);
      }
      assert.equal(next, lines0156.length, `${name}: every 0156 line is kept, in order`);
      assert.ok(finalLines.some((line) => line.includes("[0161]")), `${name}: 0161 adds to it`);
    }
  } finally {
    db.close();
  }
});
