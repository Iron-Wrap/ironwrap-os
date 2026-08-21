import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { buildEstimatorWorkbenchReadModel } from "../src/app-read-models.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import {
  canonicalJson as facetCanonicalJson,
  type FacetV2CustomerDecisionEvent,
} from "../src/facet-design-v2-protocol.ts";
import { importEstimatorEvidenceFromNativeSources } from "../src/estimator-native.ts";
import { canonicalJson } from "../src/newo-hash.ts";
import type { PriceList } from "../src/pricing.ts";

const NOW = new Date("2026-08-21T10:00:00.000Z");
const TENANT = "ironwrap";
const JOB_ID = "job:estimator:0001";
const JOB_NUMBER = "IW-EST-0001";
const OWNER_ID = "appu_owner_0001";
const OPS_ID = "appu_ops_0001";
const CUSTOMER_ID = "customer:estimator:0001";
const QUOTE_ID = "customer-quote:estimator:0001";
const QUOTE_REVISION_ID = "quote-revision:estimator:0001";
const RECEIPT_ID = `measurement_${"a".repeat(64)}`;
const MEASUREMENT_ID = `measurement:${"f".repeat(64)}`;
const FACET_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const GEOMETRY_XML = [
  "<APPLICAD_EXPORT>",
  '<POINT id="P1" data="0,0,0"/>',
  '<POINT id="P2" data="10,0,0"/>',
  '<POINT id="P3" data="10,10,0"/>',
  '<POINT id="P4" data="0,10,0"/>',
  '<LINE id="L1" path="P1,P2" type="EAVE" length="10"/>',
  '<LINE id="L2" path="P2,P3" type="RIDGE" length="10"/>',
  '<LINE id="L3" path="P3,P4" type="EAVE" length="10"/>',
  '<LINE id="L4" path="P4,P1" type="EAVE" length="10"/>',
  '<POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/>',
  "</APPLICAD_EXPORT>",
].join("");

const PRICE_LIST: PriceList = {
  currency: "CAD",
  panel: {
    sku: "PNL-26G",
    unit: "lf",
    rateCents: 500,
    sourceRef: "inventory:item:panel-26g",
  },
  trims: {
    eave_drip: {
      sku: "TRM-EAVE",
      unit: "stick",
      rateCents: 2_000,
      sourceRef: "inventory:item:eave",
    },
    ridge_cap: {
      sku: "TRM-RIDGE",
      unit: "stick",
      rateCents: 3_000,
      sourceRef: "inventory:item:ridge",
    },
  },
  fasteners: {
    clips: { sku: "CLIP", rateCents: 100, sourceRef: "inventory:item:clip" },
    clipScrews: {
      sku: "SCREW-CLIP",
      rateCents: 20,
      sourceRef: "inventory:item:clip-screw",
    },
    trimScrews: {
      sku: "SCREW-TRIM",
      rateCents: 25,
      sourceRef: "inventory:item:trim-screw",
    },
  },
  labor: {
    sku: "LABOR-INSTALL",
    ratePerSquareCents: 45_000,
    sourceRef: "pricing:labour:install",
  },
  approvedPolicy: {
    schemaVersion: "ironwrap.pricing-policy.v1",
    tenantId: TENANT,
    policyId: "retail-metal",
    revision: 3,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-31T23:59:59.999Z",
    pricing: { method: "markup", rateBps: 1_000 },
    freightCents: 15_000,
    contingencyRateBps: 250,
    minimumChargeCents: 100_000,
    taxRateBps: 500,
  },
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
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
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

interface Fixture {
  db: SqliteD1;
  env: AppEnv;
  objects: Map<string, string>;
  measurementRawKey: string;
  facetRawKey: string;
}

async function fixture(
  options: {
    importEvidence?: boolean;
    includeFacet?: boolean;
    includeCommercial?: boolean;
    includeExtensions?: boolean;
    priceList?: boolean;
  } = {},
): Promise<Fixture> {
  const db = new SqliteD1();
  seedOperatingCore(db.raw);
  seedAccountingEvidence(db.raw);
  const measurementRaw = JSON.stringify({
    job_number: JOB_NUMBER,
    source_xml: GEOMETRY_XML,
    private_provider_note: "never expose this source byte",
    ...(options.includeExtensions === false
      ? {}
      : {
          ironwrap_estimator: {
            scope_clauses: [
              {
                scope_clause_id: "scope-clause:deck",
                clause_type: "Risk",
                title: "Deck condition",
                clause_text:
                  "Hidden deck conditions require an evidence-bound scope correction.",
                version: "1",
                status: "Approved",
                source_ref: "measurement:scope-clause:1",
                customer_visible: true,
                approved_at: NOW.toISOString(),
              },
            ],
            insurance_supplements: [
              {
                name: "insurance:estimator:1",
                version: 1,
                status: "Ready for Human Review",
                invoice_required: true,
                evidence: [
                  {
                    evidence_role: "Carrier Scope",
                    source_ref: "r2:carrier-scope",
                  },
                  { evidence_role: "Code/Manufacturer", source_ref: "r2:code" },
                  { evidence_role: "Photo", source_ref: "r2:photo" },
                  { evidence_role: "Invoice", source_ref: "r2:invoice" },
                ],
              },
            ],
          },
        }),
  });
  const measurementSha = sha256(measurementRaw);
  const measurementRawKey = `raw/measurements/${measurementSha}.json`;
  seedMeasurement(db.raw, measurementSha, measurementRawKey);
  if (options.includeCommercial !== false) seedCommercial(db.raw);
  const objects = new Map([[measurementRawKey, measurementRaw]]);
  let facetRawKey = "";
  if (options.includeFacet !== false) {
    const facet = seedFacet(db.raw);
    facetRawKey = facet.rawKey;
    objects.set(facet.rawKey, facet.raw);
  }
  const env = {
    DB: db as never,
    RAW: {
      get: async (key: string) => {
        const source = objects.get(key);
        return source === undefined
          ? null
          : {
              size: new TextEncoder().encode(source).byteLength,
              text: async () => source,
            };
      },
    },
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    APP_PUBLIC_ORIGIN: "https://app.example.invalid",
    APP_ALLOWED_ORIGINS: "https://app.example.invalid",
    ...(options.priceList === false
      ? {}
      : { ESTIMATOR_PRICE_LIST_JSON: JSON.stringify(PRICE_LIST) }),
  } as unknown as AppEnv;
  if (options.importEvidence !== false) {
    await importEstimatorEvidenceFromNativeSources(
      env,
      {
        tenantId: TENANT,
        roofJobId: JOB_ID,
        measurementReceiptId: RECEIPT_ID,
        facetEventId: options.includeFacet === false ? null : FACET_EVENT_ID,
        commercialQuoteRevisionId:
          options.includeCommercial === false ? null : QUOTE_REVISION_ID,
        revisionNumber: 1,
        importedByUserId: OWNER_ID,
        idempotencyKey: "estimator-native-workbench-import-0001",
      },
      NOW,
    );
  }
  return { db, env, objects, measurementRawKey, facetRawKey };
}

test("native Estimator workbench is fully populated without Frappe or HTTP", async () => {
  const setup = await fixture();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network_not_allowed");
  };
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      setup.env,
      auth("owner"),
      JOB_ID,
      NOW,
    );
    assert.ok(model);
    assert.equal(model.job.id, JOB_ID);
    assert.equal(model.measurements.reports.length, 1);
    assert.equal(model.measurements.selected?.geometry.state, "recomputed");
    assert.equal(
      model.measurements.selected?.roof_graph?.state,
      "needs_review",
    );
    assert.equal(
      model.measurements.selected?.computed_takeoff.state,
      "computed",
    );
    assert.equal(
      model.measurements.selected?.computed_estimate.state,
      "priced",
    );
    assert.equal(
      model.measurements.selected?.computed_estimate.policy_id,
      "retail-metal",
    );
    assert.ok((model.takeoffs.selected?.items.length ?? 0) >= 4);
    assert.equal(model.visual_model?.provider, "Facet");
    assert.equal(model.visual_model?.model_state, "approved");
    assert.equal(model.visual_model?.measurement_link, "selected_measurement");
    assert.equal(model.quote?.id, QUOTE_ID);
    assert.equal(model.proposal?.quote_id, QUOTE_REVISION_ID);
    assert.equal(
      model.economics.metrics.invoiced_revenue_ex_tax.known_cents,
      1_250_000,
    );
    assert.equal(model.economics.source_coverage.matched_payment_milestones, 1);
    assert.equal(model.economics.source_coverage.posted_revenue_milestones, 1);
    assert.equal(model.scope_clauses[0]?.id, "scope-clause:deck");
    assert.equal(model.insurance_supplements.length, 1);
    assert.ok(model.allowed_actions.includes("estimator.import"));
    assert.equal(networkCalls, 0);
    const serialized = JSON.stringify(model);
    assert.doesNotMatch(
      serialized,
      /private_provider_note|raw\/measurements|source byte/,
    );
    assert.doesNotMatch(serialized, /frappe/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing native authority remains visible and importable instead of falling back", async () => {
  const setup = await fixture({ importEvidence: false });
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("owner"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.deepEqual(model.measurements.reports, []);
  assert.ok(model.stale_fields.includes("estimator_evidence.missing"));
  assert.equal(model.proposal_readiness.state, "unavailable");
  assert.ok(model.allowed_actions.includes("estimator.import"));
});

test("R2 drift withholds every derived Estimator fact", async () => {
  const setup = await fixture();
  setup.objects.set(
    setup.measurementRawKey,
    setup.objects.get(setup.measurementRawKey)!.replace("Metal", "Altered"),
  );
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("owner"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.equal(model.measurements.selected, null);
  assert.equal(model.takeoffs.selected, null);
  assert.ok(
    model.stale_fields.includes("estimator_evidence.measurement_source_drift"),
  );
  assert.equal(model.proposal_readiness.state, "unavailable");
});

test("competing Estimator heads fail closed and stay explicit", async () => {
  const setup = await fixture();
  const first = setup.db.raw
    .prepare("SELECT * FROM estimator_evidence_revisions WHERE tenant_id = ?")
    .get(TENANT) as Record<string, unknown>;
  setup.db.raw
    .prepare(
      `INSERT INTO estimator_evidence_revisions
       SELECT 'estimator:${"b".repeat(64)}', tenant_id, roof_job_id, operating_job_version,
              2, estimator_revision_id, measurement_receipt_id, measurement_raw_key,
              measurement_raw_sha256, facet_event_id, facet_raw_key, facet_raw_sha256,
              facet_design_revision_id, facet_design_revision_sha256,
              facet_frozen_evidence_sha256, commercial_quote_revision_id, payload_json,
              payload_sha256, evidence_refs_json, evidence_digest, ?, ?,
              'First correction branch', imported_by_user_id, ?
         FROM estimator_evidence_revisions WHERE estimator_revision_id = ?`,
    )
    .run(
      "c".repeat(64),
      "d".repeat(64),
      NOW.toISOString(),
      first.estimator_revision_id,
    );
  setup.db.raw
    .prepare(
      `INSERT INTO estimator_evidence_revisions
       SELECT 'estimator:${"e".repeat(64)}', tenant_id, roof_job_id, operating_job_version,
              3, ?, measurement_receipt_id, measurement_raw_key,
              measurement_raw_sha256, facet_event_id, facet_raw_key, facet_raw_sha256,
              facet_design_revision_id, facet_design_revision_sha256,
              facet_frozen_evidence_sha256, commercial_quote_revision_id, payload_json,
              payload_sha256, evidence_refs_json, evidence_digest, ?, ?,
              'Competing correction branch', imported_by_user_id, ?
         FROM estimator_evidence_revisions WHERE estimator_revision_id = ?`,
    )
    .run(
      first.estimator_revision_id,
      "f".repeat(64),
      "1".repeat(64),
      new Date(NOW.getTime() + 1_000).toISOString(),
      first.estimator_revision_id,
    );
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("owner"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.equal(model.measurements.selected, null);
  assert.ok(model.partial_sources.includes("estimator_evidence_revisions"));
  assert.ok(
    model.stale_fields.includes("estimator_evidence.authority_ambiguous"),
  );
});

test("ambiguous native commercial heads block import and quote selection", async () => {
  const setup = await fixture({ importEvidence: false });
  seedCompetingCommercialQuote(setup.db.raw);
  await assert.rejects(
    importEstimatorEvidenceFromNativeSources(
      setup.env,
      {
        tenantId: TENANT,
        roofJobId: JOB_ID,
        measurementReceiptId: RECEIPT_ID,
        facetEventId: null,
        commercialQuoteRevisionId: QUOTE_REVISION_ID,
        revisionNumber: 1,
        importedByUserId: OWNER_ID,
        idempotencyKey: "estimator-ambiguous-commercial-0001",
      },
      NOW,
    ),
    /estimator_quote_head_mismatch/,
  );
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("owner"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.equal(model.quote, null);
  assert.equal(model.proposal, null);
  assert.ok(
    model.stale_fields.includes("commercial_quote.authority_ambiguous"),
  );
});

test("commercial ambiguity introduced after import invalidates the workbench", async () => {
  const setup = await fixture();
  seedCompetingCommercialQuote(setup.db.raw);
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("owner"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.equal(model.measurements.selected, null);
  assert.equal(model.takeoffs.selected, null);
  assert.equal(model.quote, null);
  assert.equal(model.proposal, null);
  assert.ok(
    model.stale_fields.includes("estimator_evidence.commercial_quote_drift"),
  );
  assert.ok(
    model.stale_fields.includes("commercial_quote.authority_ambiguous"),
  );
});

test("native ops role sees Estimator insurance without Frappe identity config", async () => {
  const setup = await fixture();
  const model = await buildEstimatorWorkbenchReadModel(
    setup.env,
    auth("ops"),
    JOB_ID,
    NOW,
  );
  assert.ok(model);
  assert.equal(model.insurance_supplements.length, 1);
  assert.equal(
    model.insurance_supplements[0]?.status,
    "Ready for Human Review",
  );
  assert.equal(model.allowed_actions.includes("estimator.import"), false);
});

test("Estimator GET and import routes are private, CSRF-bound, and replay-safe", async () => {
  const setup = await fixture({ importEvidence: false });
  const owner = auth("owner");
  const get = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/estimator/jobs/${encodeURIComponent(JOB_ID)}`,
    ),
    setup.env,
    owner,
  );
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "private, no-store");

  const body = JSON.stringify({
    measurement_receipt_id: RECEIPT_ID,
    facet_event_id: FACET_EVENT_ID,
    commercial_quote_revision_id: QUOTE_REVISION_ID,
    revision_number: 1,
  });
  const url = `https://app.example.invalid/api/v1/estimator/jobs/${encodeURIComponent(JOB_ID)}/evidence-imports`;
  const withoutCsrf = await handleAuthenticatedRoute(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "route-import-key-0001",
      },
      body,
    }),
    setup.env,
    owner,
  );
  assert.equal(withoutCsrf.status, 403);

  const request = () =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "route-import-key-0001",
        "x-csrf-token": owner.csrfToken,
      },
      body,
    });
  const created = await handleAuthenticatedRoute(request(), setup.env, owner);
  assert.equal(created.status, 201);
  assert.equal(
    ((await created.json()) as { replayed: boolean }).replayed,
    false,
  );
  const replay = await handleAuthenticatedRoute(request(), setup.env, owner);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);

  const forbidden = await handleAuthenticatedRoute(
    request(),
    setup.env,
    auth("ops"),
  );
  assert.equal(forbidden.status, 403);
});

test("Estimator source and route remain tenant-isolated", async () => {
  const setup = await fixture();
  const wrongTenant = auth("owner", "iroof");
  assert.equal(
    await buildEstimatorWorkbenchReadModel(setup.env, wrongTenant, JOB_ID, NOW),
    null,
  );
  const response = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/estimator/jobs/${encodeURIComponent(JOB_ID)}`,
    ),
    setup.env,
    wrongTenant,
  );
  assert.equal(response.status, 404);
});

function auth(role: AppRole, tenantId = TENANT): AuthContext {
  const owner = role === "owner";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "estimator-native-csrf",
    permissions: [
      "session:read",
      "jobs:read:any",
      "estimator:read",
      ...(owner ? ["facet:launch"] : []),
    ],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2026-08-21T22:00:00.000Z",
      revoked_at: null,
      user_id: owner ? OWNER_ID : OPS_ID,
      tenant_id: tenantId,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: "seed",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  };
}

function seedOperatingCore(db: DatabaseSync): void {
  const now = NOW.toISOString();
  const envelopeId = "ow_estimator_0001";
  const leadId = "lead:estimator:0001";
  for (const [userId, role] of [
    [OWNER_ID, "owner"],
    [OPS_ID, "ops"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, 'seed', ?, ?)`,
    ).run(userId, TENANT, `${role}@example.invalid`, role, role, now, now);
  }
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', 'customer@example.invalid', '{}', ?, ?,
             'reconciled', ?, ?)`,
  ).run(envelopeId, "raw/estimator/lead.json", now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', 'customer@example.invalid',
             'qualified', 1, ?, ?)`,
  ).run(leadId, TENANT, envelopeId, "raw/estimator/lead.json", now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', 'active', 1, ?, ?)`,
  ).run(CUSTOMER_ID, TENANT, envelopeId, "raw/estimator/lead.json", now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, job_number, service_type, job_status, current_gate_state,
      version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    JOB_ID,
    TENANT,
    leadId,
    CUSTOMER_ID,
    envelopeId,
    "raw/estimator/lead.json",
    JOB_NUMBER,
    now,
    now,
  );
}

function seedMeasurement(
  db: DatabaseSync,
  payloadHash: string,
  rawKey: string,
): void {
  const now = NOW.toISOString();
  db.prepare(
    `INSERT INTO measurement_intake_receipts
     (receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id,
      provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at,
      attempts, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'payload_hash', ?, 'AppliCad', ?, ?, 'application/json',
             'matched', NULL, NULL, 1, ?, ?, ?)`,
  ).run(
    RECEIPT_ID,
    "e".repeat(64),
    payloadHash,
    MEASUREMENT_ID,
    JOB_NUMBER,
    rawKey,
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO measurement_deltas
     (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
      ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at,
      tenant_id, error_kind, signed_error)
     VALUES (?, ?, ?, 'AppliCad', 'google_solar', 'solar_area', 'roof_area',
             1, 100, 100, 0, NULL, 'within tolerance', ?, ?,
             'relative_fraction', 0)`,
  ).run(RECEIPT_ID, MEASUREMENT_ID, JOB_NUMBER, now, TENANT);
}

function seedAccountingEvidence(db: DatabaseSync): void {
  const expected = "7".repeat(64);
  const submittedAt = new Date(NOW.getTime() - 2_000).toISOString();
  const decidedAt = new Date(NOW.getTime() - 1_000).toISOString();
  const intent: Record<string, unknown> = {
    intent_id: "acct-intent:estimator:invoice:0001",
    tenant_id: TENANT,
    kind: "deposit_invoice",
    roof_job_id: JOB_ID,
    basis_json: "{}",
    basis_sha256: "1".repeat(64),
    source_documents_json: "[]",
    expected_sha256: expected,
    tax_policy_snapshot_sha256: "2".repeat(64),
    provider: "quickbooks",
    realm_id: "123456789",
    provider_entity_type: "Invoice",
    provider_payload_json: "{}",
    provider_payload_sha256: "3".repeat(64),
    provider_request_id: "estimator-invoice-0001",
    currency: "CAD",
    subtotal: "12500.00",
    tax_amount: "625.00",
    total_amount: "13125.00",
    settled_amount: "0.00",
    authority_permit_ref: "permit:estimator:invoice",
    authority_policy_ref: "policy:accounting:invoice.create",
    authority_policy_version: "v1",
    authority_max_amount: "20000.00",
    effect_id: "effect:estimator:invoice:0001",
    effect_idempotency_key: "effect-key:estimator:invoice:0001",
    compensates_effect_id: null,
    final_invoice_intent_id: null,
    compensates_intent_id: null,
    state: "reconciled",
    version: 1,
    blocker_code: null,
    blocker_next_step: null,
    reason_code: null,
    error_code: null,
    derived_by_actor_kind: "agent",
    derived_by_user_id: null,
    derived_at: NOW.toISOString(),
    approved_by_user_id: OWNER_ID,
    approved_at: NOW.toISOString(),
    approval_idempotency_sha256: "4".repeat(64),
    approval_fingerprint_sha256: "5".repeat(64),
    rejected_by_user_id: null,
    rejected_at: null,
    rejection_idempotency_sha256: null,
    rejection_fingerprint_sha256: null,
    provider_entity_id: "2001",
    observed_sha256: expected,
    provider_submitted_at: submittedAt,
    provider_reconciled_at: submittedAt,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const columns = Object.keys(intent);
  db.prepare(
    `INSERT INTO accounting_intents (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => intent[column] as null));
  const observationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.prepare(
    `INSERT INTO accounting_observations
     (observation_id, tenant_id, realm_id, entity_type, entity_id, intent_id,
      facts_json, observed_sha256, total_amount_cents, balance_cents,
      unapplied_amount_cents, read_at, effect_attempt_id, source, created_at)
     VALUES (?, ?, '123456789', 'Invoice', '2001', ?, '{}', ?, 1312500, 0,
             NULL, ?, NULL, 'dispatch_readback', ?)`,
  ).run(
    observationId,
    TENANT,
    intent.intent_id,
    expected,
    submittedAt,
    submittedAt,
  );
  db.prepare(
    `INSERT INTO accounting_reconciliations
     (reconciliation_id, tenant_id, intent_id, observation_id, expected_sha256,
      observed_sha256, verdict, reason_code, settled_amount,
      resolved_by_user_id, decided_at)
     VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ?, ?, ?, ?, ?,
             'reconciled', NULL, '0.00', ?, ?)`,
  ).run(
    TENANT,
    intent.intent_id,
    observationId,
    expected,
    expected,
    OWNER_ID,
    decidedAt,
  );
}

function seedCommercial(db: DatabaseSync): void {
  const terms = canonicalJson({
    schema_version: "ironwrap.customer-terms.v1",
    scope: "Standing seam roof replacement",
  });
  const evidence = "[]";
  const evidenceDigest = sha256(evidence);
  const quotePermit = "commercial-permit:quote:estimator:0001";
  const proposalPermit = "commercial-permit:proposal:estimator:0001";
  for (const permit of [
    {
      id: quotePermit,
      action: "quote.revision.record",
      type: "customer_quote",
      aggregate: QUOTE_ID,
      amount: 1_312_500,
      suffix: "1",
      commandFingerprint: "b".repeat(64),
    },
    {
      id: proposalPermit,
      action: "proposal.revision.record",
      type: "proposal",
      aggregate: "proposal-pack:estimator:0001",
      amount: null,
      suffix: "2",
      commandFingerprint: "f".repeat(64),
    },
  ]) {
    db.prepare(
      `INSERT INTO commercial_authority_permits
       (permit_id, tenant_id, policy_id, policy_version, policy_digest,
        policy_snapshot_json, action, actor_type, actor_id, aggregate_type,
        aggregate_id, aggregate_version, amount_cents, command_fingerprint,
        facts_digest, evidence_refs_json, evidence_digest, idempotency_key_hash,
        request_fingerprint, issued_at, expires_at)
       VALUES (?, ?, 'estimator-test-policy', 'v1', ?, '{}', ?, 'owner', ?, ?, ?,
               1, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    ).run(
      permit.id,
      TENANT,
      permit.suffix.repeat(64),
      permit.action,
      OWNER_ID,
      permit.type,
      permit.aggregate,
      permit.amount,
      permit.commandFingerprint,
      (Number(permit.suffix) + 4).toString().repeat(64),
      evidenceDigest,
      (Number(permit.suffix) + 6).toString().repeat(64),
      (Number(permit.suffix) + 7).toString().repeat(64),
      new Date(NOW.getTime() - 60_000).toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
  }
  db.prepare(
    `INSERT INTO commercial_quote_revisions
     (quote_revision_id, tenant_id, customer_quote_id, revision_number,
      roof_job_id, customer_id, status, currency, valid_until, subtotal_cents,
      tax_cents, total_cents, terms_json, terms_hash, evidence_refs_json,
      evidence_digest, policy_permit_id, authority_evidence_digest,
      command_fingerprint, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 'approved', 'CAD', '2026-08-31', 1250000,
             62500, 1312500, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    QUOTE_REVISION_ID,
    TENANT,
    QUOTE_ID,
    JOB_ID,
    CUSTOMER_ID,
    terms,
    sha256(terms),
    evidence,
    evidenceDigest,
    quotePermit,
    evidenceDigest,
    "b".repeat(64),
    "c".repeat(64),
    NOW.toISOString(),
  );
  db.prepare(
    `INSERT INTO commercial_proposal_revisions
     (proposal_revision_id, tenant_id, proposal_pack_id, revision_number,
      quote_revision_id, roof_job_id, customer_id, title, summary, terms_json,
      terms_hash, content_ref, content_hash, evidence_refs_json, evidence_digest,
      policy_permit_id, authority_evidence_digest, command_fingerprint,
      idempotency_key_hash, created_at)
     VALUES ('proposal-revision:estimator:0001', ?, 'proposal-pack:estimator:0001',
             1, ?, ?, ?, 'Roof replacement', 'Evidence-bound proposal', ?, ?,
             'r2/proposals/estimator-0001.json', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TENANT,
    QUOTE_REVISION_ID,
    JOB_ID,
    CUSTOMER_ID,
    terms,
    sha256(terms),
    "d".repeat(64),
    evidence,
    evidenceDigest,
    proposalPermit,
    evidenceDigest,
    "f".repeat(64),
    "0".repeat(64),
    NOW.toISOString(),
  );
}

function seedCompetingCommercialQuote(db: DatabaseSync): void {
  const permitId = "commercial-permit:quote:estimator:competing";
  const quoteId = "customer-quote:estimator:competing";
  const revisionId = "quote-revision:estimator:competing";
  const commandFingerprint = "3".repeat(64);
  db.prepare(
    `INSERT INTO commercial_authority_permits
     SELECT ?, tenant_id, policy_id, policy_version, policy_digest,
            policy_snapshot_json, action, actor_type, actor_id, aggregate_type,
            ?, aggregate_version, amount_cents, ?, facts_digest,
            evidence_refs_json, evidence_digest, ?, ?, issued_at, expires_at
       FROM commercial_authority_permits
      WHERE permit_id = 'commercial-permit:quote:estimator:0001'`,
  ).run(permitId, quoteId, commandFingerprint, "4".repeat(64), "5".repeat(64));
  db.prepare(
    `INSERT INTO commercial_quote_revisions
     SELECT ?, tenant_id, ?, 1, roof_job_id, customer_id, NULL, status,
            currency, valid_until, subtotal_cents, tax_cents, total_cents,
            terms_json, terms_hash, evidence_refs_json, evidence_digest, NULL,
            ?, NULL, authority_evidence_digest, ?, ?, created_at
       FROM commercial_quote_revisions WHERE quote_revision_id = ?`,
  ).run(
    revisionId,
    quoteId,
    permitId,
    commandFingerprint,
    "6".repeat(64),
    QUOTE_REVISION_ID,
  );
}

function seedFacet(db: DatabaseSync): { rawKey: string; raw: string } {
  const sourceTenant = "22222222-2222-4222-8222-222222222222";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const producerLink = `ironwrap-identity-v1:${"1".repeat(64)}`;
  const projectLink = `ironwrap-project-v1:${"2".repeat(64)}`;
  const customerLink = `facet-customer-oidc-v1:${"3".repeat(64)}`;
  const association = "4".repeat(64);
  const design = {
    brandId: "ironwrap",
    catalogRevision: {
      schema: "facet.catalog-selection-identities.v1",
      sha256: "5".repeat(64),
    },
    facetOverrides: [],
    layers: [
      {
        id: "roof-layer-1",
        visible: true,
        xmlSha256: "6".repeat(64),
        xmlUtf8Bytes: 4096,
      },
    ],
    roof: { colorId: "roof-charcoal", productId: "roof-standing-seam" },
    schema: "facet.selection-evidence.v2",
    trimAccents: [],
    uniformFinish: true,
    wall: { colorId: null, productId: null },
  };
  const frozenEvidence = {
    approval: {
      approved_at: NOW.toISOString(),
      client_revision: { roofColorId: "roof-charcoal", wallColorId: null },
    },
    design,
  };
  const designSha = sha256(facetCanonicalJson(design));
  const frozenSha = sha256(facetCanonicalJson(frozenEvidence));
  const event: FacetV2CustomerDecisionEvent = {
    approval: {
      actor: {
        customer_party_ref: "7".repeat(64),
        external_identity_link_id: customerLink,
        identity_assurance: "oidc",
        oidc_issuer: "https://accounts.google.com",
        oidc_subject_sha256: "8".repeat(64),
      },
      attestation_version: "facet-customer-approval-v1",
      decision: "approved",
      manifest_sha256: frozenSha,
      previous_event_id: null,
      reason_sha256: null,
      receipt_id: "33333333-3333-4333-8333-333333333333",
      receipt_sha256: "9".repeat(64),
    },
    brand_id: "ironwrap",
    design_revision: { id: `facet-json-v1:${designSha}`, sha256: designSha },
    destination: { tenant_id: TENANT },
    event_id: FACET_EVENT_ID,
    event_type: "facet.design.customer_approved.v2",
    facet_project_id: projectId,
    frozen_evidence: frozenEvidence,
    occurred_at: NOW.toISOString(),
    project_link: {
      external_project_link_id: projectLink,
      producer_identity_link_id: producerLink,
    },
    schema_version: 2,
    source: {
      environment: "production",
      issuer: "facet",
      product: "facet",
      tenant_id: sourceTenant,
    },
  };
  const raw = facetCanonicalJson(event);
  const rawSha = sha256(raw);
  const rawKey = `facet-design/v2/raw/${FACET_EVENT_ID}.json`;
  db.prepare(
    `INSERT INTO facet_v2_producer_identity_links
     (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
      source_product, source_environment, proof_sha256, created_from_project_id, created_at)
     VALUES (?, ?, ?, 'facet', 'facet', 'production', ?, ?, ?)`,
  ).run(
    producerLink,
    TENANT,
    sourceTenant,
    "a".repeat(64),
    projectId,
    NOW.toISOString(),
  );
  db.prepare(
    `INSERT INTO facet_v2_project_links
     (external_project_link_id, producer_identity_link_id, destination_tenant_id,
      source_tenant_id, brand_id, facet_project_id, customer_party_ref,
      external_customer_identity_link_id, roof_job_id, customer_quote_id,
      project_claim_sha256, association_sha256, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, 'ironwrap', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectLink,
    producerLink,
    TENANT,
    sourceTenant,
    projectId,
    "7".repeat(64),
    customerLink,
    JOB_ID,
    QUOTE_ID,
    "b".repeat(64),
    association,
    OWNER_ID,
    NOW.toISOString(),
  );
  db.prepare(
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
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, 'facet', 'facet',
             'production', ?, ?, 'ironwrap', ?, ?, ?, ?, ?, ?, ?, ?,
             'https://accounts.google.com', ?, 'oidc', 'facet-customer-approval-v1',
             'approved', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    FACET_EVENT_ID,
    rawSha,
    sourceTenant,
    TENANT,
    projectId,
    projectLink,
    producerLink,
    association,
    JOB_ID,
    QUOTE_ID,
    "7".repeat(64),
    customerLink,
    "8".repeat(64),
    event.approval.receipt_id,
    event.approval.receipt_sha256,
    event.design_revision.id,
    designSha,
    frozenSha,
    rawKey,
    rawSha,
    new TextEncoder().encode(raw).byteLength,
    NOW.toISOString(),
    NOW.toISOString(),
  );
  return { rawKey, raw };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
