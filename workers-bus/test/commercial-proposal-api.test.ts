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
