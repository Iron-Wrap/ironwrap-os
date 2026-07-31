// Solar cross-check tests: a synthetic buildingInsights response for "the same
// building" as the AppliCad fixture must agree; divergent responses must flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import { crossCheckMeasurements, parseSolarBuildingInsights } from "../src/solar.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

// 180.481 m2 = 1942.68 sf; pitchDegrees atan(1/3) = 4/12 exactly.
const SOLAR_MATCHING = {
  imageryDate: { year: 2025, month: 6, day: 14 },
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
  assert.equal(s.imageryQuality, "HIGH");
  assert.equal(s.measurements.roof_area, 1942.68);
  assert.equal(s.measurements.pitch, 4);
  assert.equal(s.measurements.segment_count, 2);
  assert.equal(s.segments[0].pitchRise12, 4);
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

test("solar: mixed-pitch roofs publish no uniform pitch, so only area is compared", () => {
  const mixed = parseSolarBuildingInsights({
    solarPotential: {
      wholeRoofStats: { areaMeters2: 180.481 },
      roofSegmentStats: [
        { pitchDegrees: 18.434949, stats: { areaMeters2: 90 } },
        { pitchDegrees: 33.690068, stats: { areaMeters2: 90.481 } }, // 8/12
      ],
    },
  })!;
  assert.equal(mixed.measurements.pitch, undefined);
  const r = crossCheckMeasurements(parseAppliCadGeometry(SAMPLE)!.measurements, mixed.measurements);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].check, "cross_source_roof_area");
});

test("solar: non-buildingInsights payloads parse to null", () => {
  assert.equal(parseSolarBuildingInsights(null), null);
  assert.equal(parseSolarBuildingInsights({ foo: 1 }), null);
  assert.equal(parseSolarBuildingInsights({ solarPotential: {} }), null);
});
