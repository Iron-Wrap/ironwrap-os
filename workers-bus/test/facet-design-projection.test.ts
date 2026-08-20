import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { canonicalJson } from "../src/facet-design-v2-protocol.ts";
import { reconcileFacetDesignFrappeProjections } from "../src/facet-design-projection.ts";
import { schemaBlankRules } from "../../tools/validate-facet-blank-quote-contract.mjs";

const HMAC_SECRET =
  "facet-projection-test-secret-longer-than-thirty-two-characters";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_LINK = `ironwrap-project-v1:${"2".repeat(64)}`;
const PRODUCER_LINK = `ironwrap-identity-v1:${"3".repeat(64)}`;
const CUSTOMER_LINK = `facet-customer-oidc-v1:${"b".repeat(64)}`;
const ASSOCIATION = {
  brand_id: "ironwrap",
  customer_party_ref: "a".repeat(64),
  customer_quote_id: "customer-quote-0001",
  destination_tenant_id: "ironwrap",
  external_customer_identity_link_id: CUSTOMER_LINK,
  external_project_link_id: PROJECT_LINK,
  facet_project_id: PROJECT_ID,
  producer_identity_link_id: PRODUCER_LINK,
  roof_job_id: "roof-job-0001",
  source_tenant_id: SOURCE_TENANT_ID,
};
const ASSOCIATION_SHA256 = sha256(canonicalJson(ASSOCIATION));
const BLANK_QUOTE_FIELDS = [
  "price_book_version",
  "pricing_effective_at",
  "price_rule_snapshot_json",
  "subtotal",
  "tax_amount",
  "tax_code",
  "tax_rate",
  "tax_policy_snapshot_json",
  "quote_total",
  "currency",
  "deposit_amount",
  "amount_due",
  "amount_paid",
  "balance_due",
  "payment_status",
  "payment_due_date",
  "payment_truth_source",
  "payment_truth_at",
  "qb_item_ref",
  "qb_tax_code_ref",
  "qb_terms_ref",
  "qb_terms_due_days",
  "valid_until",
  "approved_by",
  "approved_at",
  "acceptance_evidence",
  "contract_acceptance",
  "accepted_at",
  "scope_summary",
  "assumptions",
  "exclusions",
  "quote_summary_json",
  "notes",
] as const;

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
          "../migrations/0042_external_effect_runtime.sql",
          import.meta.url,
        ),
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
    const now = "2027-01-15T07:59:00.000Z";
    this.raw
      .prepare(
        `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, active,
        created_by, created_at, updated_at)
       VALUES ('owner-user-0001', 'ironwrap', 'owner@example.invalid', 'Owner', 'owner', 1,
               'test-fixture', ?, ?)`,
      )
      .run(now, now);
    this.raw
      .prepare(
        `INSERT INTO facet_v2_producer_identity_links
       (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
        source_product, source_environment, proof_sha256,
        created_from_project_id, created_at)
       VALUES (?, 'ironwrap', ?, 'facet', 'facet', 'production', ?, ?, ?)`,
      )
      .run(PRODUCER_LINK, SOURCE_TENANT_ID, "6".repeat(64), PROJECT_ID, now);
    this.raw
      .prepare(
        `INSERT INTO facet_v2_project_links
       (external_project_link_id, producer_identity_link_id, destination_tenant_id,
        source_tenant_id, brand_id, facet_project_id, customer_party_ref,
        external_customer_identity_link_id, roof_job_id, customer_quote_id,
        project_claim_sha256, association_sha256, created_by_user_id, created_at)
       VALUES (?, ?, 'ironwrap', ?, 'ironwrap', ?, ?, ?, 'roof-job-0001',
               'customer-quote-0001', ?, ?, 'owner-user-0001', ?)`,
      )
      .run(
        PROJECT_LINK,
        PRODUCER_LINK,
        SOURCE_TENANT_ID,
        PROJECT_ID,
        "a".repeat(64),
        CUSTOMER_LINK,
        "7".repeat(64),
        ASSOCIATION_SHA256,
        now,
      );
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
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

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  async first<T>(): Promise<T | null> {
    return (
      (this.raw.prepare(this.sql).get(...this.args) as T | undefined) ?? null
    );
  }
}

function seedDecision(
  db: SqliteD1,
  input: {
    eventId?: string;
    decision?: "approved" | "corrected" | "superseded" | "withdrawn";
    previousEventId?: string | null;
    occurredAt?: string;
  } = {},
): string {
  const eventId = input.eventId ?? EVENT_ID;
  const decision = input.decision ?? "approved";
  const previous = input.previousEventId ?? null;
  const eventHash = sha256(eventId);
  const reason = decision === "approved" ? null : "8".repeat(64);
  db.raw
    .prepare(
      `INSERT INTO facet_v2_customer_decisions
     (event_id, event_type, schema_version, event_body_sha256, issuer, source_product,
      source_environment, source_tenant_id, destination_tenant_id, brand_id,
      facet_project_id, external_project_link_id, producer_identity_link_id,
      association_sha256, roof_job_id, customer_quote_id, customer_party_ref,
      external_customer_identity_link_id, oidc_issuer, oidc_subject_sha256,
      identity_assurance, attestation_version, decision_kind, previous_event_id,
      reason_sha256, approval_receipt_id, approval_receipt_sha256, design_revision_id,
      design_revision_sha256, frozen_evidence_sha256, raw_key, raw_sha256,
      raw_content_length, occurred_at, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, 'facet', 'facet', 'production',
             ?, 'ironwrap', 'ironwrap', ?, ?, ?, ?, 'roof-job-0001',
             'customer-quote-0001', ?, ?, 'https://accounts.google.com', ?, 'oidc',
             'facet-customer-approval-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512, ?, ?)`,
    )
    .run(
      eventId,
      eventHash,
      SOURCE_TENANT_ID,
      PROJECT_ID,
      PROJECT_LINK,
      PRODUCER_LINK,
      ASSOCIATION_SHA256,
      "a".repeat(64),
      CUSTOMER_LINK,
      "b".repeat(64),
      decision,
      previous,
      reason,
      eventId,
      sha256(`approval:${eventId}`),
      `facet-json-v1:${"e".repeat(64)}`,
      "e".repeat(64),
      "c".repeat(64),
      `facet-design/v2/raw/${eventHash}.json`,
      eventHash,
      input.occurredAt ?? "2027-01-15T08:00:00.000Z",
      input.occurredAt ?? "2027-01-15T08:00:01.000Z",
    );
  return eventId;
}

function env(db: SqliteD1, effectRuntime = true): Env {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: effectRuntime ? "true" : "false",
    FACET_V2_FRAPPE_PROJECTION_ENABLED: "true",
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: HMAC_SECRET,
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: "facet-projection-key",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: "facet-projection-secret",
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
  } as Env;
}

function count(db: SqliteD1, outcome: string): number {
  return Number(
    (
      db.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM facet_v2_projection_attempts WHERE outcome = ?`,
        )
        .get(outcome) as { count: number }
    ).count,
  );
}

const CUSTOMER_QUOTE_DOCTYPE = JSON.parse(
  readFileSync(
    new URL(
      "../../frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype/customer_quote/customer_quote.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { fields: Array<Record<string, string>> };

/**
 * What a real Frappe site hands back for the blank half of a projected Draft.
 *
 * Every readback fixture in this file used to return a literal `null` for all
 * 33 fields, which is a shape no site produces: `insert()` stamps the DocType
 * defaults and Currency/Float/Int columns are NOT NULL DEFAULT 0. That fixture
 * is precisely why the readback conflict was invisible in CI and fatal on the
 * real stack (ELEC-86 §5 / ELEC-91), so the shape is derived from the shipped
 * DocType here rather than restated. `literalNull` keeps the old shape available
 * for the cases that assert the readback accepts both.
 */
function blankQuoteReadback(literalNull: boolean): Record<string, unknown> {
  const rules = schemaBlankRules(CUSTOMER_QUOTE_DOCTYPE, [...BLANK_QUOTE_FIELDS]) as Array<{
    field: string;
    schemaDefault: string | null;
    numeric: boolean;
  }>;
  if (literalNull) {
    return Object.fromEntries(rules.map((rule) => [rule.field, null]));
  }
  // What a real site returns: the DocType default where there is one, 0 for a
  // numeric column, and *nothing at all* for a field that is genuinely NULL.
  return Object.fromEntries(
    rules
      .map((rule) => [rule.field, rule.schemaDefault ?? (rule.numeric ? 0 : undefined)])
      .filter(([, value]) => value !== undefined),
  );
}

function installFrappeMock(
  input: {
    status?: number;
    tamperReceipt?: boolean;
    idempotentReplay?: boolean;
    missingEvidence?: boolean;
    mutatedReconciliationHash?: boolean;
    populatedDraft?: boolean;
    literalNullDraft?: boolean;
    driftedCurrency?: boolean;
    responseLostOnce?: boolean;
  } = {},
): {
  calls: Array<{ claim: Record<string, unknown>; headers: Headers }>;
  readbacks: string[];
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ claim: Record<string, unknown>; headers: Headers }> = [];
  const readbacks: string[] = [];
  let responseLost = false;
  globalThis.fetch = async (request, init) => {
    const url = String(request);
    if (init?.method === "GET") {
      readbacks.push(url);
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      const claim = calls.at(-1)?.claim;
      if (!claim) return Response.json({ error: "not_found" }, { status: 404 });
      const eventHash = sha256(String(claim.event_id));
      const active =
        claim.decision_kind === "approved" ||
        claim.decision_kind === "corrected";
      const previousHash = claim.previous_event_id
        ? sha256(String(claim.previous_event_id))
        : null;
      const draftId = `facet-quote-revision:${active ? eventHash : previousHash}`;
      const evidenceId = `facet-design:${eventHash}`;
      const reconciliationId = `facet-design-projection:${eventHash}`;
      const roofJob = "JOB-001";
      const diff = {
        association_sha256: claim.association_sha256,
        blank_commercial_revision: active,
        customer_party_ref: claim.customer_party_ref,
        customer_safe: false,
        decision_kind: claim.decision_kind,
        destination_tenant_id: claim.destination_tenant_id,
        draft_customer_quote_id: draftId,
        event_id: claim.event_id,
        external_customer_identity_link_id:
          claim.external_customer_identity_link_id,
        external_project_link_id: claim.external_project_link_id,
        facet_project_id: claim.facet_project_id,
        identity_assurance: "oidc",
        oidc_issuer: claim.oidc_issuer,
        oidc_subject_sha256: claim.oidc_subject_sha256,
        previous_draft_customer_quote_id: previousHash
          ? `facet-quote-revision:${previousHash}`
          : null,
        previous_event_id: claim.previous_event_id,
        producer_identity_link_id: claim.producer_identity_link_id,
        schema: "ironwrap.facet-design-projection.v2",
        source_tenant_id: claim.source_tenant_id,
        state: active
          ? "pending_estimator_rebuild"
          : claim.decision_kind === "withdrawn"
            ? "customer_withdrew_design"
            : "customer_superseded_design",
      };
      if (url.includes("Integration%20Reconciliation")) {
        const localPayloadHash = sha256(
          canonicalJson({
            association_sha256: claim.association_sha256,
            draft_customer_quote_id: draftId,
            event_id: claim.event_id,
            roof_job: roofJob,
            source_customer_quote_id: claim.customer_quote_id,
          }),
        );
        return Response.json({
          data: {
            correction_reason: claim.reason_sha256
              ? `Facet ${claim.decision_kind} reason SHA-256: ${claim.reason_sha256}`
              : null,
            diff_json: canonicalJson(diff),
            direction: "Inbound",
            entity_type: "Design Revision",
            external_entity_id: `facet-event:${eventHash}`,
            local_doctype: "Customer Quote",
            local_name: draftId,
            local_payload_hash: input.mutatedReconciliationHash
              ? "0".repeat(64)
              : localPayloadHash,
            name: id,
            reconciliation_id: id,
            raw_key: claim.raw_key,
            roof_job: roofJob,
            source_payload_hash: claim.frozen_evidence_sha256,
            source_version: claim.design_revision_id,
            status: active ? "Pending" : "Superseded",
            supersedes: previousHash
              ? `facet-design-projection:${previousHash}`
              : null,
            system_name: "Facet",
          },
        });
      }
      if (url.includes("Evidence%20Item")) {
        if (input.missingEvidence)
          return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({
          data: {
            checksum_algorithm: "SHA-256",
            content_checksum: claim.raw_sha256,
            content_length: claim.raw_content_length,
            content_type: "application/json",
            customer_safe: 0,
            device_action_id: `facet-v2-projection:${eventHash}`,
            evidence_id: evidenceId,
            evidence_type: "Other",
            name: evidenceId,
            proof_slot: "Estimate",
            r2_key: claim.raw_key,
            roof_job: roofJob,
            source_system: "ironwrap-facet-design",
            sync_state: "Verified",
            verification_source: "ironwrap-worker-r2-facet-design-projection",
          },
        });
      }
      if (url.includes("Customer%20Quote")) {
        return Response.json({
          data: {
            ...blankQuoteReadback(input.literalNullDraft === true),
            customer: "CUSTOMER-001",
            customer_quote_id: id,
            correction_reason: active
              ? `Facet customer decision ${claim.event_id} requires estimator rebuild from current evidence.`
              : `Facet customer decision ${claim.previous_event_id} requires estimator rebuild from current evidence.`,
            ...(input.driftedCurrency ? { currency: "USD" } : {}),
            ...(input.populatedDraft ? { quote_total: 1 } : {}),
            quote_version: active ? 3 : 2,
            roof_job: roofJob,
            status: active ? "Draft" : "Rejected",
            supersedes:
              claim.decision_kind === "corrected" && previousHash
                ? `facet-quote-revision:${previousHash}`
                : "QUOTE-001",
          },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as { facet_claim_json: string };
    const claim = JSON.parse(body.facet_claim_json) as Record<string, unknown>;
    calls.push({ claim, headers: new Headers(init?.headers) });
    if (input.status && input.status !== 200)
      return Response.json({ error: "rejected" }, { status: input.status });
    const eventHash = sha256(String(claim.event_id));
    const active =
      claim.decision_kind === "approved" || claim.decision_kind === "corrected";
    const targetHash = active
      ? eventHash
      : sha256(String(claim.previous_event_id));
    const evidenceId = `facet-design:${eventHash}`;
    const reconciliationId = `facet-design-projection:${eventHash}`;
    const draftId = `facet-quote-revision:${targetHash}`;
    const receipt = {
      actor_identity_assurance: "oidc",
      approval_receipt_sha256: claim.approval_receipt_sha256,
      association_sha256: claim.association_sha256,
      blank_commercial_revision: active,
      claim_sha256: sha256(body.facet_claim_json),
      customer_safe: false,
      decision_kind: claim.decision_kind,
      design_revision_id: claim.design_revision_id,
      design_revision_sha256: claim.design_revision_sha256,
      destination_tenant_id: claim.destination_tenant_id,
      draft_customer_quote_id: draftId,
      draft_quote_status: active ? "Draft" : "Rejected",
      draft_quote_version: active ? 3 : 2,
      event_id: claim.event_id,
      event_type: claim.event_type,
      evidence_id: evidenceId,
      facet_project_id: claim.facet_project_id,
      frozen_evidence_sha256: claim.frozen_evidence_sha256,
      idempotent_replay: input.idempotentReplay ?? false,
      occurred_at: claim.occurred_at,
      raw_content_length: claim.raw_content_length,
      raw_key: claim.raw_key,
      raw_sha256: claim.raw_sha256,
      received_at: claim.received_at,
      reconciliation_id: reconciliationId,
      roof_job_id: claim.roof_job_id,
      schema: "ironwrap.facet-design-projection-receipt.v2",
      schema_version: 2,
      source_customer_quote_id: claim.customer_quote_id,
    };
    if (input.tamperReceipt) receipt.draft_quote_status = "Approved";
    const receiptSha256 = sha256(canonicalJson(receipt));
    if (input.responseLostOnce && !responseLost) {
      responseLost = true;
      throw new TypeError("simulated response loss after Frappe commit");
    }
    return Response.json({
      message: {
        draft_customer_quote_id: draftId,
        draft_quote_version: active ? 3 : 2,
        event_id: claim.event_id,
        evidence_id: evidenceId,
        idempotent_replay: input.idempotentReplay ?? false,
        receipt,
        receipt_sha256: receiptSha256,
        receipt_signature: createHmac("sha256", HMAC_SECRET)
          .update(
            `ironwrap.facet-design-projection.receipt.v2\n${receiptSha256}`,
          )
          .digest("base64url"),
        receipt_signature_algorithm: "HMAC-SHA256",
        reconciliation_id: reconciliationId,
      },
    });
  };
  return {
    calls,
    readbacks,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("projects only the exact OIDC v2 chain head to a signed blank Draft receipt", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(
      env(db),
      new Date("2027-01-15T08:01:00.000Z"),
    );
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1);
  const claim = mock.calls[0]!.claim;
  assert.equal(claim.event_type, "facet.design.customer_approved.v2");
  assert.equal(claim.identity_assurance, "oidc");
  assert.equal(claim.association_sha256, ASSOCIATION_SHA256);
  assert.equal("capability_fingerprint" in claim, false);
  assert.equal(count(db, "projected_blank_draft"), 1);
  const attempt = db.raw
    .prepare(
      `SELECT draft_customer_quote_id, draft_quote_version, evidence_id, reconciliation_id
       FROM facet_v2_projection_attempts`,
    )
    .get() as Record<string, unknown>;
  const eventHash = sha256(EVENT_ID);
  assert.deepEqual(
    { ...attempt },
    {
      draft_customer_quote_id: `facet-quote-revision:${eventHash}`,
      draft_quote_version: 3,
      evidence_id: `facet-design:${eventHash}`,
      reconciliation_id: `facet-design-projection:${eventHash}`,
    },
  );
});

test("withdrawal and supersession project a terminal Frappe hold while authority revocation fails closed", async () => {
  const withdrawnDb = new SqliteD1();
  seedDecision(withdrawnDb);
  seedDecision(withdrawnDb, {
    eventId: "55555555-5555-4555-8555-555555555555",
    decision: "withdrawn",
    previousEventId: EVENT_ID,
    occurredAt: "2027-01-15T08:02:00.000Z",
  });
  const withdrawnMock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(env(withdrawnDb));
  } finally {
    withdrawnMock.restore();
  }
  assert.equal(withdrawnMock.calls.length, 1);
  assert.equal(withdrawnMock.calls[0]!.claim.decision_kind, "withdrawn");
  assert.equal(count(withdrawnDb, "projected_terminal_hold"), 1);

  const supersededDb = new SqliteD1();
  seedDecision(supersededDb);
  seedDecision(supersededDb, {
    eventId: "66666666-6666-4666-8666-666666666666",
    decision: "superseded",
    previousEventId: EVENT_ID,
    occurredAt: "2027-01-15T08:03:00.000Z",
  });
  const supersededMock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(env(supersededDb));
  } finally {
    supersededMock.restore();
  }
  assert.equal(supersededMock.calls.length, 1);
  assert.equal(supersededMock.calls[0]!.claim.decision_kind, "superseded");
  assert.equal(count(supersededDb, "projected_terminal_hold"), 1);

  const revokedDb = new SqliteD1();
  seedDecision(revokedDb);
  revokedDb.raw
    .prepare(
      `INSERT INTO facet_v2_link_revocations
     (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
      destination_tenant_id, revoked_at)
     VALUES ('revocation-0001', 'project', ?, 'customer_request', 'owner-user-0001',
             'ironwrap', '2027-01-15T08:00:30.000Z')`,
    )
    .run(PROJECT_LINK);
  const revokedMock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(env(revokedDb));
  } finally {
    revokedMock.restore();
  }
  assert.equal(revokedMock.calls.length, 0);
  assert.equal(count(revokedDb, "rejected_frappe"), 1);
});

test("a corrected chain projects only its latest immutable decision", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const correctionId = "55555555-5555-4555-8555-555555555555";
  seedDecision(db, {
    eventId: correctionId,
    decision: "corrected",
    previousEventId: EVENT_ID,
    occurredAt: "2027-01-15T08:02:00.000Z",
  });
  const mock = installFrappeMock({ idempotentReplay: true });
  try {
    await reconcileFacetDesignFrappeProjections(env(db));
  } finally {
    mock.restore();
  }
  assert.deepEqual(
    mock.calls.map((call) => call.claim.event_id),
    [correctionId],
  );
  assert.equal(count(db, "reconciled"), 1);
  assert.equal(
    db.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM facet_v2_projection_attempts WHERE event_id = ?`,
      )
      .get(EVENT_ID)?.count,
    0,
  );
});

test("signed-response tamper recovers only by exact readback and Frappe 409 is terminal rejected", async () => {
  const tamperDb = new SqliteD1();
  seedDecision(tamperDb);
  const tamper = installFrappeMock({ tamperReceipt: true });
  try {
    await reconcileFacetDesignFrappeProjections(env(tamperDb));
  } finally {
    tamper.restore();
  }
  assert.equal(tamper.readbacks.length, 3);
  assert.equal(count(tamperDb, "reconciled"), 1);
  const rejectedDb = new SqliteD1();
  seedDecision(rejectedDb);
  const rejected = installFrappeMock({ status: 409 });
  try {
    await reconcileFacetDesignFrappeProjections(env(rejectedDb));
  } finally {
    rejected.restore();
  }
  assert.equal(count(rejectedDb, "rejected_frappe"), 1);
});

test("legacy projection flag cannot enable v2 or cause a Frappe request", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const testEnv = env(db);
  testEnv.FACET_V2_FRAPPE_PROJECTION_ENABLED = "false";
  testEnv.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(testEnv);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(
    db.raw
      .prepare(`SELECT COUNT(*) AS count FROM facet_v2_projection_attempts`)
      .get()?.count,
    0,
  );
});

test("v2 projection cannot bypass a disabled shared effect runtime", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(env(db, false));
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(count(db, "uncertain"), 1);
  assert.equal(
    db.raw.prepare(`SELECT COUNT(*) AS count FROM external_effects`).get()
      ?.count,
    0,
  );
});

test("v2 projection uses the shared effect ledger and replays from provider readback", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(
      env(db, true),
      new Date("2027-01-15T08:01:00.000Z"),
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.readbacks.length, 3);
    const effect = db.raw
      .prepare(
        `SELECT state, provider_external_id, result_code
         FROM external_effects
        WHERE action = 'facet.design.v2.projection'`,
      )
      .get() as {
      state: string;
      provider_external_id: string;
      result_code: string | null;
    };
    assert.equal(effect.state, "succeeded", JSON.stringify(effect));
    assert.equal(
      effect.provider_external_id,
      `facet-design-projection:${sha256(EVENT_ID)}`,
    );

    // Model a Worker isolate ending after the effect ledger settled but before
    // the domain projection attempt was appended. Production keeps the table
    // immutable; the test removes that append-only trigger only to recreate the
    // exact interrupted boundary.
    db.raw.exec(`DROP TRIGGER facet_v2_projection_attempts_append_only_delete`);
    db.raw
      .prepare(`DELETE FROM facet_v2_projection_attempts WHERE event_id = ?`)
      .run(EVENT_ID);
    await reconcileFacetDesignFrappeProjections(
      env(db, true),
      new Date("2027-01-15T08:02:00.000Z"),
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.readbacks.length, 6);
    assert.equal(count(db, "reconciled"), 1);
  } finally {
    mock.restore();
  }
});

test("a blank Draft reads back as blank whether Frappe omits the nulls or spells them out", async () => {
  // Frappe's REST readback omits NULL fields; a fixture that returns them as
  // explicit nulls is the shape that hid this. Both must settle the effect.
  for (const literalNullDraft of [false, true]) {
    const db = new SqliteD1();
    seedDecision(db);
    const mock = installFrappeMock({ responseLostOnce: true, literalNullDraft });
    try {
      await reconcileFacetDesignFrappeProjections(
        env(db, true),
        new Date("2027-01-15T08:01:00.000Z"),
      );
    } finally {
      mock.restore();
    }
    assert.equal(count(db, "reconciled"), 1, `literalNullDraft=${literalNullDraft}`);
    assert.equal(count(db, "uncertain"), 0, `literalNullDraft=${literalNullDraft}`);
  }
});

test("response loss succeeds only after the exact Frappe projection trio reads back", async () => {
  const db = new SqliteD1();
  seedDecision(db);
  const mock = installFrappeMock({ responseLostOnce: true });
  try {
    await reconcileFacetDesignFrappeProjections(
      env(db, true),
      new Date("2027-01-15T08:01:00.000Z"),
    );
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.readbacks.length, 3);
  assert.equal(count(db, "reconciled"), 1);
  const effect = db.raw
    .prepare(
      `SELECT state, provider_external_id, result_code
       FROM external_effects
      WHERE action = 'facet.design.v2.projection'`,
    )
    .get() as {
    state: string;
    provider_external_id: string;
    result_code: string | null;
  };
  assert.equal(effect.state, "succeeded", JSON.stringify(effect));
  assert.equal(
    effect.provider_external_id,
    `facet-design-projection:${sha256(EVENT_ID)}`,
  );
});

for (const scenario of [
  { name: "missing evidence", option: { missingEvidence: true } },
  {
    name: "a mutated reconciliation hash",
    option: { mutatedReconciliationHash: true },
  },
  { name: "a populated commercial draft", option: { populatedDraft: true } },
  // Tolerating the DocType's own default must not tolerate a value that merely
  // differs from it: "USD" in a CAD-defaulted column is somebody's edit.
  { name: "a currency that is not the schema default", option: { driftedCurrency: true } },
] as const) {
  test(`response loss remains uncertain when readback has ${scenario.name}`, async () => {
    const db = new SqliteD1();
    seedDecision(db);
    const mock = installFrappeMock({
      responseLostOnce: true,
      ...scenario.option,
    });
    try {
      await reconcileFacetDesignFrappeProjections(
        env(db, true),
        new Date("2027-01-15T08:01:00.000Z"),
      );
    } finally {
      mock.restore();
    }
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.readbacks.length, 3);
    assert.equal(count(db, "uncertain"), 1);
    assert.equal(count(db, "reconciled"), 0);
    assert.equal(count(db, "projected_blank_draft"), 0);
    const effect = db.raw
      .prepare(
        `SELECT state, provider_external_id, result_code
         FROM external_effects
        WHERE action = 'facet.design.v2.projection'`,
      )
      .get() as {
      state: string;
      provider_external_id: string | null;
      result_code: string | null;
    };
    assert.notEqual(effect.state, "succeeded", JSON.stringify(effect));
  });
}
