// Solar cross-check tests: a synthetic buildingInsights response for "the same
// building" as the AppliCad fixture must agree; divergent responses must flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import {
  assessSolarEvidence,
  crossCheckMeasurements,
  parseSolarBuildingInsights,
  parseSolarBuildingInsightsResult,
} from "../src/solar.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

// 180.481 m2 = 1942.68 sf; pitchDegrees atan(1/3) = 4/12 exactly.
const SOLAR_MATCHING = {
  imageryDate: { year: 2025, month: 6, day: 14 },
  imageryProcessedDate: { year: 2025, month: 6, day: 20 },
  imageryQuality: "HIGH",
  solarPotential: {
    wholeRoofStats: { areaMeters2: 180.481, groundAreaMeters2: 168.2 },
    roofSegmentStats: [
      { pitchDegrees: 18.434949, azimuthDegrees: 180, stats: { areaMeters2: 100.2 } },
      { pitchDegrees: 18.434949, azimuthDegrees: 0, stats: { areaMeters2: 80.281 } },
    ],
  },
};

test("solar: buildingInsights parses into pipeline measurements with source refs", () => {
  const s = parseSolarBuildingInsights(SOLAR_MATCHING)!;
  assert.equal(s.provider, "google_solar");
  assert.equal(s.imageryDate, "2025-06-14");
  assert.equal(s.imageryProcessedDate, "2025-06-20");
  assert.equal(s.imageryQuality, "HIGH");
  assert.equal(s.measurements.roof_area, 1942.68);
  assert.equal(s.measurements.pitch, 4);
  assert.equal(s.measurements.azimuth, 180);
  assert.equal(s.measurements.segment_count, 2);
  assert.equal(s.segments[0].pitchRise12, 4);
  assert.equal(s.segments[0].areaMeters2, 100.2);
  assert.deepEqual(s.confidence, {
    state: "unavailable",
    reason: "google_solar_building_insights_does_not_publish_statistical_confidence",
  });
  assert.deepEqual(s.segmentCorrespondence, {
    state: "unavailable",
    reason: "no_stable_cross_source_segment_identifier",
  });
  for (const key of Object.keys(s.measurements)) assert.ok(s.sourceRefs[key], `missing source ref: ${key}`);
});

test("solar: independent source agrees with the verified AppliCad fixture", () => {
  const primary = parseAppliCadGeometry(SAMPLE)!.measurements;
  const solar = parseSolarBuildingInsights(SOLAR_MATCHING)!.measurements;
  const r = crossCheckMeasurements(primary, solar);
  assert.equal(r.checks.length, 2); // roof_area + pitch; segment_count never compared
  assert.deepEqual(r.checks.filter((c) => !c.ok), []);
  assert.equal(r.needsReview, false);
});

test("solar: wrong-building area diverges beyond tolerance and flags", () => {
  const primary = parseAppliCadGeometry(SAMPLE)!.measurements;
  const wrong = parseSolarBuildingInsights({
    solarPotential: { wholeRoofStats: { areaMeters2: 150 } },
  })!.measurements;
  const r = crossCheckMeasurements(primary, wrong);
  assert.equal(r.needsReview, true);
  const area = r.checks.find((c) => c.check === "cross_source_roof_area")!;
  assert.equal(area.ok, false);
  assert.match(area.detail, /%/);
});

test("solar: pitch disagreement flags at rise/12 units", () => {
  const primary = parseAppliCadGeometry(SAMPLE)!.measurements; // pitch 4
  const steep = parseSolarBuildingInsights({
    solarPotential: {
      wholeRoofStats: { areaMeters2: 180.481 },
      roofSegmentStats: [{ pitchDegrees: 26.565051, stats: { areaMeters2: 180.481 } }], // 6/12
    },
  })!.measurements;
  const r = crossCheckMeasurements(primary, steep);
  const pitch = r.checks.find((c) => c.check === "cross_source_pitch")!;
  assert.equal(pitch.ok, false);
  assert.equal(r.needsReview, true);
});

test("solar: mixed-pitch aggregate is weighted by actual segment area", () => {
  const mixed = parseSolarBuildingInsights({
    solarPotential: {
      wholeRoofStats: { areaMeters2: 400 },
      roofSegmentStats: [
        { pitchDegrees: 14.036243, azimuthDegrees: 90, stats: { areaMeters2: 100 } }, // 3/12
        { pitchDegrees: 36.869898, azimuthDegrees: 90, stats: { areaMeters2: 300 } }, // 9/12
      ],
    },
  })!;
  // Independent expected result: (100 sf-equivalent * 3/12 + 300 * 9/12) / 400 = 7.5/12.
  assert.equal(mixed.measurements.pitch, 7.5);
  assert.match(mixed.sourceRefs.pitch, /area-weighted/);
});

test("solar: circular aggregate refuses an exactly ambiguous opposing roof", () => {
  const model = parseSolarBuildingInsights({
    solarPotential: {
      wholeRoofStats: { areaMeters2: 200 },
      roofSegmentStats: [
        { pitchDegrees: 18.434949, azimuthDegrees: 0, stats: { areaMeters2: 100 } },
        { pitchDegrees: 18.434949, azimuthDegrees: 180, stats: { areaMeters2: 100 } },
      ],
    },
  })!;
  assert.equal(model.measurements.azimuth, undefined);
  assert.ok(model.evidenceIssues.includes("azimuth_aggregate_ambiguous"));
});

test("solar: azimuth comparison uses circular angular distance", () => {
  const passing = crossCheckMeasurements(
    { azimuth: 359 },
    { azimuth: 1 },
    { azimuthTolerance: 2 },
  );
  assert.equal(passing.comparisons[0].absDiff, 2);
  assert.equal(passing.comparisons[0].ok, true);

  const failing = crossCheckMeasurements(
    { azimuth: 359 },
    { azimuth: 1 },
    { azimuthTolerance: 1 },
  );
  assert.equal(failing.comparisons[0].absDiff, 2);
  assert.equal(failing.needsReview, true);
});

test("solar: invalid provider units and bounds are explicit and never aggregated", () => {
  const model = parseSolarBuildingInsights({
    imageryDate: { year: 2025, month: 2, day: 29 },
    imageryProcessedDate: { year: 2025, month: 13, day: 1 },
    imageryQuality: "ULTRA",
    solarPotential: {
      wholeRoofStats: { areaMeters2: -1 },
      roofSegmentStats: [
        { pitchDegrees: 90, azimuthDegrees: 360, stats: { areaMeters2: Number.POSITIVE_INFINITY } },
      ],
    },
  })!;
  assert.equal(model.imageryDate, null);
  assert.equal(model.imageryProcessedDate, null);
  assert.equal(model.imageryQuality, null);
  assert.deepEqual(model.measurements, { segment_count: 1 });
  assert.ok(model.evidenceIssues.includes("whole_roof_area_m2_invalid"));
  assert.ok(model.evidenceIssues.includes("segment_0_pitch_degrees_invalid"));
  assert.ok(model.evidenceIssues.includes("segment_0_azimuth_degrees_invalid"));
  assert.ok(model.evidenceIssues.includes("segment_0_area_m2_invalid"));
  assert.ok(model.evidenceIssues.includes("imagery_date_invalid"));
  assert.ok(model.evidenceIssues.includes("imagery_quality_invalid"));
});

test("solar: truncated provider diagnostics fail closed", () => {
  const model = parseSolarBuildingInsights({
    imageryDate: { year: 2026, month: 8, day: 1 },
    imageryQuality: "HIGH",
    solarPotential: {
      wholeRoofStats: { areaMeters2: 100 },
      roofSegmentStats: Array.from({ length: 10 }, () => ({
        pitchDegrees: 90,
        azimuthDegrees: 360,
        stats: { areaMeters2: -1 },
      })),
    },
  })!;
  assert.ok(model.evidenceIssues.includes("additional_provider_evidence_issues_truncated"));
  const assessment = assessSolarEvidence(model, new Date("2026-08-13T00:00:00.000Z"));
  assert.equal(assessment.usable, false);
  assert.equal(
    assessment.checks.find((check) => check.check === "cross_source_provider_evidence")?.ok,
    false,
  );
});

test("solar: stale or missing imagery is explicit and cannot confirm a cross-check", () => {
  const stale = parseSolarBuildingInsights({
    imageryDate: { year: 2018, month: 1, day: 1 },
    imageryQuality: "HIGH",
    solarPotential: { wholeRoofStats: { areaMeters2: 100 } },
  })!;
  const staleAssessment = assessSolarEvidence(stale, new Date("2026-08-13T00:00:00.000Z"), {
    maxImageryAgeDays: 1_826,
    minimumImageryQuality: "MEDIUM",
  });
  assert.equal(staleAssessment.usable, false);
  assert.equal(staleAssessment.checks.find((check) => check.check === "cross_source_imagery")?.ok, false);
  assert.match(
    staleAssessment.checks.find((check) => check.check === "cross_source_imagery")?.detail ?? "",
    /stale/,
  );

  const missing = parseSolarBuildingInsights({
    solarPotential: { wholeRoofStats: { areaMeters2: 100 } },
  })!;
  const missingAssessment = assessSolarEvidence(missing, new Date("2026-08-13T00:00:00.000Z"), {
    maxImageryAgeDays: 1_826,
    minimumImageryQuality: "MEDIUM",
  });
  assert.equal(missingAssessment.usable, false);
  assert.match(
    missingAssessment.checks.find((check) => check.check === "cross_source_imagery")?.detail ?? "",
    /date unavailable.*quality unavailable/,
  );
  assert.match(
    missingAssessment.checks.find((check) => check.check === "cross_source_confidence_availability")?.detail ?? "",
    /unavailable/,
  );
  assert.match(
    missingAssessment.checks.find((check) => check.check === "cross_source_segment_correspondence")?.detail ?? "",
    /unavailable/,
  );

  const lowQuality = parseSolarBuildingInsights({
    imageryDate: { year: 2026, month: 8, day: 1 },
    imageryQuality: "LOW",
    solarPotential: { wholeRoofStats: { areaMeters2: 100 } },
  })!;
  assert.equal(
    assessSolarEvidence(lowQuality, new Date("2026-08-13T00:00:00.000Z"), {
      maxImageryAgeDays: 1_826,
      minimumImageryQuality: "MEDIUM",
    }).usable,
    false,
  );
});

test("solar: invalid comparison policy fails closed", () => {
  assert.throws(
    () => crossCheckMeasurements({ roof_area: 100 }, { roof_area: 100 }, { areaTolerance: -0.1 }),
    /solar_invalid_area_tolerance/,
  );
  assert.throws(
    () => crossCheckMeasurements({ azimuth: 0 }, { azimuth: 0 }, { azimuthTolerance: 181 }),
    /solar_invalid_azimuth_tolerance/,
  );
});

test("solar: non-buildingInsights payloads parse to null", () => {
  assert.equal(parseSolarBuildingInsights(null), null);
  assert.equal(parseSolarBuildingInsights({ foo: 1 }), null);
  assert.equal(parseSolarBuildingInsights({ solarPotential: {} }), null);
  assert.equal(parseSolarBuildingInsightsResult(null).state, "unavailable");
  assert.deepEqual(parseSolarBuildingInsightsResult({ solarPotential: {} }), {
    state: "unavailable",
    reason: "roof_evidence_unavailable",
  });
});
