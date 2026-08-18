// Takeoff engine tests: exact panel math on synthetic roofs with known closed-form
// answers, then end-to-end over the sanitized AppliCad fixture. Fixtures are
// synthetic by construction (node --test, type-stripped, no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import {
  GOVERNED_TAKEOFF_CALCULATION_VERSION,
  nestLengths,
  takeoffFromGeometry,
  takeoffFromGeometryWithPolicy,
  type GovernedTakeoffOptions,
} from "../src/takeoff.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

// Symmetric gable: two 20ft x 10ft-slope rectangles (rise 6 on run 8 -> slope 10).
// Every declared number matches its recomputation, so needsReview stays false.
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

// Single hip trapezoid: eave 30, ridge 14, slope height 10, hips sqrt(164).
const HIP = `<APPLICAD_EXPORT>
<POINT id="P1" data="0,0,0"/>
<POINT id="P2" data="30,0,0"/>
<POINT id="P3" data="22,8,6"/>
<POINT id="P4" data="8,8,6"/>
<LINE id="L1" path="P1,P2" type="FASCIA" length="30"/>
<LINE id="L2" path="P2,P3" type="HIP" length="12.806248"/>
<LINE id="L3" path="P3,P4" type="RIDGE" length="14"/>
<LINE id="L4" path="P4,P1" type="HIP" length="12.806248"/>
<POLYGON id="F1" path="L1,L2,L3,L4" size = "220" pitch="9" type="Roof"/>
</APPLICAD_EXPORT>`;

test("takeoff: gable resolves to the exact closed-form panel schedule", () => {
  const g = parseAppliCadGeometry(GABLE)!;
  assert.equal(g.needsReview, false);
  const t = takeoffFromGeometry(g);

  // ceil(20 / (16/12)) = 15 panels per facet, every one exactly the 10ft slope.
  assert.equal(t.layouts.length, 2);
  for (const layout of t.layouts) {
    assert.equal(layout.panels.length, 15);
    for (const p of layout.panels) assert.equal(p.lengthFt, 10);
    assert.equal(layout.overage, 1); // 15 x 10 x 4/3 = 200 sf = the Newell area
  }
  assert.equal(t.totals.panelCount, 30);
  assert.equal(t.totals.panelFt, 300);
  assert.equal(t.totals.panelAreaSqft, 400);
  assert.ok(Math.abs((t.totals.overage ?? 0) - 1) < 1e-3);

  // Coil mode: cut-to-length, zero nesting waste.
  assert.equal(t.panelNest.mode, "coil");
  assert.equal(t.panelNest.wastePct, 0);

  // Trim sticks at 10ft stock: eave 40ft -> 4, ridge 20ft -> 2, rake 4x10ft -> 4.
  const byProfile = Object.fromEntries(t.trims.map((x) => [x.profile, x]));
  assert.equal(byProfile.eave_drip.totalFt, 40);
  assert.equal(byProfile.eave_drip.sticks, 4);
  assert.equal(byProfile.ridge_cap.sticks, 2);
  assert.equal(byProfile.gable_rake.totalFt, 40);
  assert.equal(byProfile.gable_rake.sticks, 4);

  // Clips: ceil(10/2)+1 = 6 per seam x 30 seams.
  assert.equal(t.fasteners.clips, 180);

  assert.equal(t.needsReview, false);
  for (const key of ["panel_count", "panel_total_ft", "roof_area_computed_sqft"]) {
    assert.ok(t.sourceRefs[key], `missing source ref: ${key}`);
  }
});

const governedCoilPolicy = (): GovernedTakeoffOptions => ({
  panelProfileId: "standing_seam_16in",
  coverageWidthFt: 16 / 12,
  lengthIncrementFt: 1 / 12,
  maxPanelLengthFt: 40,
  mode: "coil",
  stockLengthsFt: [],
  minReusableOffcutFt: 2,
  coilSetupAllowanceFt: 5,
  coilTailAllowanceFt: 3,
  coilScrapFactor: 0.02,
  trimStockFt: 10,
  trimLapFt: 0.5,
  trimProfiles: {
    FASCIA: "eave_drip",
    GABLE: "gable_rake",
    RIDGE: "ridge_cap",
  },
  clipSpacingFt: 2,
  screwsPerClip: 1,
  trimScrewSpacingFt: 1.5,
  fastenerItemIds: {
    clip: "standing_seam_clip",
    clipScrew: "clip_screw",
    trimScrew: "trim_screw",
  },
});

test("governed takeoff accepts only a complete policy and prices coil waste explicitly", () => {
  const g = parseAppliCadGeometry(GABLE)!;
  const t = takeoffFromGeometryWithPolicy(g, governedCoilPolicy());

  assert.equal(GOVERNED_TAKEOFF_CALCULATION_VERSION, "material_takeoff/v1");
  assert.equal(t.panelNest.mode, "coil");
  assert.equal(t.panelNest.cutFt, 300);
  assert.equal(t.panelNest.stockFt, 314);
  assert.equal(t.panelNest.wastePct, round4(1 - 300 / 314));
  assert.match(t.sourceRefs.panel_stock_ft, /setup=5ft/);
  assert.match(t.sourceRefs.panel_stock_ft, /scrap=0.02/);
  assert.equal(t.needsReview, false);
});

test("governed takeoff fails closed instead of inheriting calculator defaults", () => {
  const g = parseAppliCadGeometry(GABLE)!;
  const partial = { ...governedCoilPolicy() } as Record<string, unknown>;
  delete partial.coverageWidthFt;
  assert.throws(
    () => takeoffFromGeometryWithPolicy(g, partial as unknown as GovernedTakeoffOptions),
    /takeoff_policy_coverage_width_ft_required/,
  );

  assert.throws(
    () => takeoffFromGeometryWithPolicy(g, {
      ...governedCoilPolicy(),
      coilSetupAllowanceFt: 0,
      coilTailAllowanceFt: 0,
      coilScrapFactor: 0,
    }),
    /takeoff_policy_coil_allowance_required/,
  );

  const missingTrim = governedCoilPolicy();
  delete missingTrim.trimProfiles.GABLE;
  assert.throws(
    () => takeoffFromGeometryWithPolicy(g, missingTrim),
    /takeoff_policy_trim_profile_missing:GABLE/,
  );
});

test("governed stock takeoff requires declared stock lengths and never applies coil allowances", () => {
  const g = parseAppliCadGeometry(GABLE)!;
  const policy: GovernedTakeoffOptions = {
    ...governedCoilPolicy(),
    mode: "stock",
    stockLengthsFt: [20],
    coilSetupAllowanceFt: 0,
    coilTailAllowanceFt: 0,
    coilScrapFactor: 0,
  };
  const t = takeoffFromGeometryWithPolicy(g, policy);
  assert.equal(t.panelNest.mode, "stock");
  assert.equal(t.panelNest.stockFt, 300);
  assert.equal(t.panelNest.wastePct, 0);

  assert.throws(
    () => takeoffFromGeometryWithPolicy(g, { ...policy, stockLengthsFt: [] }),
    /takeoff_policy_stock_lengths_required/,
  );
});

test("takeoff: stock nesting pairs cuts and reuses offcuts", () => {
  const g = parseAppliCadGeometry(GABLE)!;
  const t = takeoffFromGeometry(g, { stockLengthsFt: [20] });
  // 30 x 10ft cuts into 20ft stock: 15 pieces, two cuts each, zero waste.
  assert.equal(t.panelNest.mode, "stock");
  assert.equal(t.panelNest.pieces.length, 15);
  assert.equal(t.panelNest.reusedCuts, 15);
  assert.ok(t.panelNest.wastePct < 1e-9);
  assert.equal(t.panelNest.unplaced.length, 0);
});

test("takeoff: hip facet produces short starter panels and bounded overage", () => {
  const g = parseAppliCadGeometry(HIP)!;
  assert.equal(g.needsReview, false);
  const t = takeoffFromGeometry(g);
  const panels = t.layouts[0].panels;
  assert.equal(panels.length, Math.ceil(30 / (16 / 12))); // 23 seams
  // Raked ends start short and grow toward the full slope at mid-facet.
  assert.ok(panels[0].lengthFt < panels[11].lengthFt);
  assert.ok(panels[panels.length - 1].lengthFt < panels[11].lengthFt);
  assert.equal(panels[11].lengthFt, 10);
  // Rectangles over a trapezoid: overage strictly above 1, but bounded.
  assert.ok((t.totals.overage ?? 0) > 1 && (t.totals.overage ?? 0) < 1.2, `overage ${t.totals.overage}`);
});

test("takeoff: cuts that fit no stock are flagged, never silently dropped", () => {
  const g = parseAppliCadGeometry(HIP)!;
  const t = takeoffFromGeometry(g, { stockLengthsFt: [8] });
  assert.ok(t.panelNest.unplaced.length > 0);
  assert.ok(t.checks.some((c) => c.check === "nest_unplaced_cut" && !c.ok));
  assert.equal(t.needsReview, true);
});

test("takeoff: tampered geometry propagates needs_review into the takeoff", () => {
  const tampered = GABLE.replace('size = "200"', 'size = "260"');
  const g = parseAppliCadGeometry(tampered)!;
  assert.equal(g.needsReview, true);
  assert.equal(takeoffFromGeometry(g).needsReview, true);
});

test("takeoff: full synthetic fixture goes end-to-end order-ready", () => {
  const g = parseAppliCadGeometry(SAMPLE)!;
  const t = takeoffFromGeometry(g);
  assert.equal(t.needsReview, false);
  assert.equal(t.totals.skippedFacets, 0);
  assert.equal(t.layouts.length, 7);
  assert.ok(t.totals.panelCount > 0);
  // Panel material stays within a sane bound of the recomputed roof area.
  assert.ok(Math.abs(t.totals.roofAreaComputedSqft - 1942.68) < 2);
  assert.ok((t.totals.overage ?? 0) > 1 && (t.totals.overage ?? 0) < 1.3, `overage ${t.totals.overage}`);
  // Every trim family present in the file materializes as an orderable profile.
  const profiles = new Set(t.trims.map((x) => x.profile));
  for (const p of ["eave_drip", "gable_rake", "ridge_cap", "valley_pan", "step_flashing", "tuck_under_flashing"]) {
    assert.ok(profiles.has(p), `missing trim profile ${p}`);
  }
  assert.ok(t.fasteners.clips > 0 && t.fasteners.trimScrews > 0);
});

test("nestLengths: best-fit-decreasing places into the tightest open offcut", () => {
  const n = nestLengths([6, 4, 4, 3], [10], 2);
  // 6+4 fills one stick exactly; 4+3 leaves a 3ft reusable offcut.
  assert.equal(n.pieces.length, 2);
  assert.equal(n.wastePct, round4(1 - 17 / 20));
  assert.equal(n.reusedCuts, 2);
  assert.equal(n.reusableOffcuts, 1);
});

const round4 = (v: number) => Math.round(v * 10000) / 10000;
