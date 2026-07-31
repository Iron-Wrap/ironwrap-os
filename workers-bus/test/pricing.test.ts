// Pricing tests: exact money over the closed-form gable takeoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import { takeoffFromGeometry } from "../src/takeoff.ts";
import { priceTakeoff, type PriceList } from "../src/pricing.ts";

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

const LIST: PriceList = {
  currency: "CAD",
  panel: { sku: "PNL-26G", unit: "lf", rate: 5 },
  trims: {
    eave_drip: { sku: "TRM-EAVE", rate: 20 },
    ridge_cap: { sku: "TRM-RIDGE", rate: 30 },
    gable_rake: { sku: "TRM-RAKE", rate: 25 },
  },
  fasteners: {
    clips: { sku: "CLP-100", rate: 40, per: 100 },
  },
  labor: { sku: "LAB-INST", ratePerSquare: 250 },
  markupPct: 10,
  taxPct: 5,
};

test("pricing: gable takeoff prices to exact, source-referenced money", () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const estimate = priceTakeoff(takeoff, LIST);

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
  assert.equal(estimate.currency, "CAD");
  assert.deepEqual(estimate.unpricedProfiles, []);
  assert.equal(estimate.needsReview, false);
  for (const line of estimate.lines) assert.ok(line.sourceRef, `line ${line.sku} missing source ref`);
});

test("pricing: unpriced trim profile flags the estimate for review", () => {
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(GABLE)!);
  const noRake = { ...LIST, trims: { eave_drip: LIST.trims.eave_drip, ridge_cap: LIST.trims.ridge_cap } };
  const estimate = priceTakeoff(takeoff, noRake);
  assert.deepEqual(estimate.unpricedProfiles, ["gable_rake"]);
  assert.equal(estimate.needsReview, true);
});

test("pricing: needs_review takeoff never prices into a clean estimate", () => {
  const tampered = GABLE.replace('size = "200"', 'size = "260"');
  const takeoff = takeoffFromGeometry(parseAppliCadGeometry(tampered)!);
  assert.equal(takeoff.needsReview, true);
  assert.equal(priceTakeoff(takeoff, LIST).needsReview, true);
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
});
