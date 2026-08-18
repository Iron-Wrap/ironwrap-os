// Pricing tests: exact money over the closed-form gable takeoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import { takeoffFromGeometry, type TakeoffModel } from "../src/takeoff.ts";
import {
  approvedPricingPolicySnapshot,
  priceTakeoff,
  verifyPricingAuthority,
  type ApprovedPricingPolicyV1,
  type PriceList,
  type PricingAuthorityRule,
  type PricingContext,
} from "../src/pricing.ts";

// Same synthetic gable as takeoff.test.ts: 30 panels x 10ft, 400 sf coverage,
// trims eave 4 sticks / ridge 2 / rake 4, clips 180.
const GABLE = `<APPLICAD_EXPORT>
<POINT id="P1" data="0,0,0"/>
<POINT id="P2" data="20,0,0"/>
<POINT id="P3" data="20,8,6"/>
<POINT id="P4" data="0,8,6"/>
<POINT id="P5" data="0,16,0"/>
<POINT id="P6" data="20,16,0"/>
<LINE id="L1" path="P1,P2" type="FASCIA" length="20"/>
<LINE id="L2" path="P2,P3" type="GABLE" length="10"/>
<LINE id="L3" path="P3,P4" type="RIDGE" length="20"/>
<LINE id="L4" path="P4,P1" type="GABLE" length="10"/>
<LINE id="L5" path="P5,P6" type="FASCIA" length="20"/>
<LINE id="L6" path="P6,P3" type="GABLE" length="10"/>
<LINE id="L7" path="P4,P5" type="GABLE" length="10"/>
<POLYGON id="F1" path="L1,L2,L3,L4" size = "200" pitch="9" type="Roof"/>
<POLYGON id="F2" path="L5,L6,L3,L7" size = "200" pitch="9" type="Roof"/>
</APPLICAD_EXPORT>`;

const PRICED_AT = "2026-08-13T12:00:00.000Z";

const POLICY: ApprovedPricingPolicyV1 = {
  schemaVersion: "ironwrap.pricing-policy.v1",
  tenantId: "ironwrap",
  policyId: "retail-metal",
  revision: 1,
  effectiveAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-31T23:59:59.999Z",
  pricing: { method: "markup", rateBps: 1_000 },
  freightCents: 0,
  contingencyRateBps: 0,
  minimumChargeCents: 0,
  taxRateBps: 500,
};

async function approvedContext(
  list: PriceList,
  ruleOverrides: Partial<PricingAuthorityRule> = {},
  pricedAt = PRICED_AT,
): Promise<PricingContext> {
  const snapshot = await approvedPricingPolicySnapshot(list, pricedAt);
  const policy = list.approvedPolicy!;
  const rule: PricingAuthorityRule = {
    name: "POLICY-ANCHOR-1",
    status: "Approved",
    rule_type: "Pricing Policy",
    currency: list.currency,
    source_ref: "owner-approved-policy:retail-metal:1",
    rule_json: '{"operation":"bind_canonical_pricing_snapshot","schema_version":"ironwrap.price-policy-authority.v1"}',
    effective_from: policy.effectiveAt.slice(0, 10),
    effective_to: policy.expiresAt.slice(0, 10),
    approved_by: "owner@example.com",
    approved_at: "2026-07-31 12:00:00",
    pricing_policy_id: policy.policyId,
    pricing_policy_revision: policy.revision,
    pricing_policy_snapshot_json: snapshot.canonicalSnapshot,
    pricing_policy_snapshot_sha256: snapshot.snapshotSha256,
    ...ruleOverrides,
  };
  const authority = await verifyPricingAuthority(
    list,
    [rule],
    { pricedAt, tenantId: policy.tenantId },
  );
  assert.ok(authority, "fixture authority should verify");
  return { pricedAt, authority };
}

const LIST: PriceList = {
  currency: "CAD",
  panel: { sku: "PNL-26G", unit: "lf", rateCents: 500, sourceRef: "price-book:panel" },
  trims: {
    eave_drip: { sku: "TRM-EAVE", rateCents: 2_000, sourceRef: "price-book:eave" },
    ridge_cap: { sku: "TRM-RIDGE", rateCents: 3_000, sourceRef: "price-book:ridge" },
    gable_rake: { sku: "TRM-RAKE", rateCents: 2_500, sourceRef: "price-book:rake" },
  },
  fasteners: {
    clips: { sku: "CLP-100", rateCents: 4_000, per: 100, sourceRef: "price-book:clips" },
    clipScrews: { sku: "SCR-CLIP", rateCents: 0, sourceRef: "assembly:included" },
    trimScrews: { sku: "SCR-TRIM", rateCents: 0, sourceRef: "assembly:included" },
  },
  labor: { sku: "LAB-INST", ratePerSquareCents: 25_000, sourceRef: "labor-book:install" },
  approvedPolicy: POLICY,
};

function simpleTakeoff(panelFt: number): TakeoffModel {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  return {
    ...takeoff,
    trims: [],
    fasteners: { clips: 0, clipScrews: 0, trimScrews: 0 },
    totals: { ...takeoff.totals, panelFt, panelAreaSqft: 0 },
  };
}

function simpleList(
  rateCents: number,
  policyOverrides: Partial<ApprovedPricingPolicyV1> = {},
): PriceList {
  return {
    currency: "CAD",
    panel: { sku: "PANEL", unit: "lf", rateCents, sourceRef: "price-book:panel" },
    trims: {},
    approvedPolicy: { ...POLICY, taxRateBps: 0, ...policyOverrides },
  };
}

test("pricing: gable takeoff prices to exact, source-referenced money", async () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const estimate = priceTakeoff(takeoff, LIST, await approvedContext(LIST));

  // panels 300 lf x 5 = 1500; trims 4x20 + 2x30 + 4x25 = 240;
  // clips ceil(180/100)=2 packs x 40 = 80; labor 4 squares x 250 = 1000.
  const byKind = Object.fromEntries(estimate.lines.map((l) => [`${l.kind}:${l.sku}`, l]));
  assert.equal(byKind["panel:PNL-26G"].amount, 1500);
  assert.equal(byKind["trim:TRM-EAVE"].amount, 80);
  assert.equal(byKind["trim:TRM-RIDGE"].amount, 60);
  assert.equal(byKind["trim:TRM-RAKE"].amount, 100);
  assert.equal(byKind["fastener:CLP-100"].qty, 2);
  assert.equal(byKind["fastener:CLP-100"].amount, 80);
  assert.equal(byKind["labor:LAB-INST"].amount, 1000);

  assert.equal(estimate.subtotal, 2820);
  assert.equal(estimate.markup, 282);      // 10%
  assert.equal(estimate.tax, 155.1);       // 5% of 3102
  assert.equal(estimate.total, 3257.1);
  assert.equal(estimate.cost, 2820);
  assert.equal(estimate.markupRatePct, 10);
  assert.equal(estimate.grossMarginRatePct, 9.09);
  assert.equal(estimate.taxBase, 3102);
  assert.equal(estimate.commercial.totalCents, 325710);
  assert.equal(estimate.commercial.mode, "approved_policy");
  assert.equal(estimate.currency, "CAD");
  assert.deepEqual(estimate.unpricedProfiles, []);
  assert.equal(estimate.needsReview, false);
  for (const line of estimate.lines) assert.ok(line.sourceRef, `line ${line.sku} missing source ref`);
});

test("pricing: unpriced trim profile flags a legacy estimate for review", () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const noRake: PriceList = {
    currency: "CAD",
    panel: { sku: "PANEL", unit: "lf", rate: 5 },
    trims: {
      eave_drip: { sku: "TRM-EAVE", rate: 20 },
      ridge_cap: { sku: "TRM-RIDGE", rate: 30 },
    },
  };
  const estimate = priceTakeoff(takeoff, noRake);
  assert.deepEqual(estimate.unpricedProfiles, ["gable_rake"]);
  assert.equal(estimate.needsReview, true);
});

test("pricing: approved policy rejects omitted nonzero labor and fastener categories", async () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const withoutLabor = structuredClone(LIST);
  delete withoutLabor.labor;
  const withoutLaborContext = await approvedContext(withoutLabor);
  assert.throws(
    () => priceTakeoff(takeoff, withoutLabor, withoutLaborContext),
    /priceList\.labor: approved pricing requires an explicit rate/,
  );

  const withoutClipScrews = structuredClone(LIST);
  delete withoutClipScrews.fasteners?.clipScrews;
  const withoutClipScrewsContext = await approvedContext(withoutClipScrews);
  assert.throws(
    () => priceTakeoff(takeoff, withoutClipScrews, withoutClipScrewsContext),
    /priceList\.fasteners\.clipScrews: approved pricing requires an explicit rate/,
  );
});

test("pricing: explicitly sourced zero-cent rates preserve included-cost categories", async () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const estimate = priceTakeoff(takeoff, LIST, await approvedContext(LIST));
  const included = estimate.lines.find((line) => line.sku === "SCR-CLIP");

  assert.ok(included);
  assert.ok(included.qty > 0);
  assert.equal(included.rateCents, 0);
  assert.equal(included.amountCents, 0);
  assert.equal(included.rateSourceRef, "assembly:included");
});

test("pricing: needs_review takeoff never prices into a clean estimate", async () => {
  const tampered = GABLE.replace('size = "200"', 'size = "260"');
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(tampered)!);
  assert.equal(takeoff.needsReview, true);
  assert.equal(priceTakeoff(takeoff, LIST, await approvedContext(LIST)).needsReview, true);
});

test("pricing: sqft panel pricing and lf trim pricing use the right quantities", () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const bySqft: PriceList = {
    currency: "CAD",
    panel: { sku: "PNL", unit: "sqft", rate: 4 },
    trims: { eave_drip: { sku: "TRM-EAVE", unit: "lf", rate: 2 } },
  };
  const estimate = priceTakeoff(takeoff, bySqft);
  const panel = estimate.lines.find((l) => l.kind === "panel")!;
  assert.equal(panel.qty, 400);
  assert.equal(panel.amount, 1600);
  const eave = estimate.lines.find((l) => l.sku === "TRM-EAVE")!;
  assert.equal(eave.qty, 40);
  assert.equal(eave.amount, 80);
  assert.equal(estimate.commercial.mode, "read_only_legacy");
  assert.equal(estimate.needsReview, true);
});

test("pricing: markup and gross margin are distinct deterministic policies", async () => {
  const takeoff = simpleTakeoff(1);
  const markupList = simpleList(10_000, { pricing: { method: "markup", rateBps: 1_000 } });
  const marginList = simpleList(10_000, {
    policyId: "retail-metal-margin",
    pricing: { method: "gross_margin", rateBps: 1_000 },
  });
  const markup = priceTakeoff(
    takeoff,
    markupList,
    await approvedContext(markupList),
  );
  const margin = priceTakeoff(
    takeoff,
    marginList,
    await approvedContext(marginList),
  );

  assert.equal(markup.cost, 100);
  assert.equal(markup.total, 110);
  assert.equal(markup.grossMarginRatePct, 9.09);
  assert.equal(margin.total, 111.11);
  assert.equal(margin.markup, 11.11);
  assert.equal(margin.grossMarginRatePct, 10);
});

test("pricing: multiplication rounds half-up at the cent boundary", async () => {
  const list = simpleList(1);
  const estimate = priceTakeoff(simpleTakeoff(0.5), list, await approvedContext(list));
  assert.equal(estimate.lines[0].amountCents, 1);
  assert.equal(estimate.total, 0.01);
});

test("pricing: freight, contingency, markup, minimum, and tax use the versioned order", async () => {
  const list = simpleList(10_000, {
    pricing: { method: "markup", rateBps: 1_000 },
    freightCents: 1_000,
    contingencyRateBps: 1_000,
    minimumChargeCents: 15_000,
    taxRateBps: 500,
  });
  const estimate = priceTakeoff(
    simpleTakeoff(1),
    list,
    await approvedContext(list),
  );

  assert.equal(estimate.subtotal, 100);
  assert.equal(estimate.freight, 10);
  assert.equal(estimate.contingency, 11);
  assert.equal(estimate.cost, 121);
  assert.equal(estimate.minimumChargeAdjustment, 16.9);
  assert.equal(estimate.markup, 29);
  assert.equal(estimate.taxBase, 150);
  assert.equal(estimate.tax, 7.5);
  assert.equal(estimate.total, 157.5);
});

test("pricing: approved input rejects ambiguity, unknown policy keys, and stale evaluation", () => {
  const ambiguous = simpleList(10_000);
  (ambiguous.panel as PriceList["panel"]).rate = 100;
  assert.throws(
    () => priceTakeoff(simpleTakeoff(1), ambiguous, { pricedAt: PRICED_AT }),
    /dollar and cent rates are ambiguous/,
  );

  const unknown = simpleList(10_000) as PriceList & {
    approvedPolicy: ApprovedPricingPolicyV1 & { hiddenFeeCents: number };
  };
  unknown.approvedPolicy.hiddenFeeCents = 1;
  assert.throws(
    () => priceTakeoff(simpleTakeoff(1), unknown, { pricedAt: PRICED_AT }),
    /unknown keys: hiddenFeeCents/,
  );

  assert.throws(
    () => priceTakeoff(simpleTakeoff(1), simpleList(10_000), {
      pricedAt: "2026-09-01T00:00:00.000Z",
    }),
    /not effective at this instant/,
  );
});

test("pricing: exact approved inputs replay to the exact cent ledger", async () => {
  const takeoff = simpleTakeoff(1.125);
  const list = simpleList(12_345, {
    pricing: { method: "gross_margin", rateBps: 2_500 },
    freightCents: 1_234,
    contingencyRateBps: 275,
    minimumChargeCents: 20_000,
    taxRateBps: 500,
  });
  const context = await approvedContext(list);
  const first = priceTakeoff(takeoff, list, context);
  const replay = priceTakeoff(
    structuredClone(takeoff),
    structuredClone(list),
    context,
  );
  assert.deepEqual(replay, first);
});

test("pricing: raw caller metadata cannot forge persisted approval authority", () => {
  assert.throws(
    () => priceTakeoff(simpleTakeoff(1), simpleList(10_000), {
      pricedAt: PRICED_AT,
      authority: {
        policyId: "retail-metal",
        policyRevision: 1,
        tenantId: "ironwrap",
        pricedAt: PRICED_AT,
        canonicalSnapshot: "{}",
        snapshotSha256: "a".repeat(64),
        priceRuleName: "forged",
      },
    }),
    /exact verified persisted authority/,
  );
});

test("pricing: canonical authority rejects opaque hash, tampered bytes, cross-policy, duplicate, and stale rows", async () => {
  const list = simpleList(10_000);
  const snapshot = await approvedPricingPolicySnapshot(list, PRICED_AT);
  const policy = list.approvedPolicy!;
  const base: PricingAuthorityRule = {
    name: "POLICY-ANCHOR-1",
    status: "Approved",
    rule_type: "Pricing Policy",
    currency: "CAD",
    source_ref: "owner-approved-policy:retail-metal:1",
    rule_json: '{"operation":"bind_canonical_pricing_snapshot","schema_version":"ironwrap.price-policy-authority.v1"}',
    effective_from: "2026-08-01",
    effective_to: "2026-08-31",
    approved_by: "owner@example.com",
    approved_at: "2026-07-31 12:00:00",
    pricing_policy_id: policy.policyId,
    pricing_policy_revision: policy.revision,
    pricing_policy_snapshot_json: snapshot.canonicalSnapshot,
    pricing_policy_snapshot_sha256: snapshot.snapshotSha256,
  };
  const verify = async (overrides: Partial<PricingAuthorityRule>, rules = 1) =>
    await verifyPricingAuthority(
      list,
      Array.from({ length: rules }, (_, index) => ({ ...base, name: `ANCHOR-${index}`, ...overrides })),
      { pricedAt: PRICED_AT, tenantId: "ironwrap" },
    );

  assert.equal(await verify({ pricing_policy_snapshot_json: undefined }), null);
  assert.equal(await verify({ pricing_policy_snapshot_json: `${snapshot.canonicalSnapshot} ` }), null);
  assert.equal(await verify({ pricing_policy_snapshot_sha256: "0".repeat(64) }), null);
  assert.equal(await verify({ approved_by: "not-a-frappe-user" }), null);
  assert.equal(await verify({ approved_at: "2026-07-31T12:00:00.000Z" }), null);
  assert.equal(await verify({ approved_at: "2026-08-14 12:00:00" }), null);
  assert.equal(await verify({ pricing_policy_id: "another-policy" }), null);
  assert.equal(await verify({ effective_to: "2026-08-12" }), null);
  assert.equal(await verify({}, 2), null);
  assert.equal(
    await verifyPricingAuthority(list, [base], { pricedAt: PRICED_AT, tenantId: "another-tenant" }),
    null,
  );

  const freeText = structuredClone(list);
  freeText.panel.description = "Customer-specific note must not enter approval evidence";
  await assert.rejects(
    approvedPricingPolicySnapshot(freeText, PRICED_AT),
    /priceList\.panel: unknown keys: description/,
  );
});
