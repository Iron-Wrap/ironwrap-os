// First-principles geometry engine tests against a sanitized AppliCad fixture
// (node --test, type-stripped — no install). The engine must reproduce the
// known proof values AND independently re-derive them from raw coordinates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAppliCadXml, parseAppliCadGeometry } from "../src/geometry.ts";
import { extractGeometry } from "../src/measurements.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

test("parseAppliCadGeometry: parses the synthetic fixture completely", () => {
  const g = parseAppliCadGeometry(SAMPLE)!;
  assert.equal(g.points.length, 29);
  assert.equal(g.lines.length, 35);
  assert.equal(g.facets.length, 7);
  // The known proof values (tools/applicad-xml-proof.mjs) reproduced exactly.
  assert.equal(g.measurements.roof_area, 1942.68);
  assert.equal(g.measurements.fascia_length, 147);
  assert.equal(g.measurements.gable_length, 80.11);
  assert.equal(g.measurements.ridge_length, 89);
  assert.equal(g.measurements.step_length, 13.7);
  assert.equal(g.measurements.tuck_under_length, 3);
  assert.equal(g.measurements.valley_length, 24.7);
  assert.equal(g.measurements.facet_count, 7);
  assert.equal(g.measurements.pitch, 4);
  assert.equal(g.measurements.volume_cuft, 3571.486086);
  // Every metric carries an in-file source ref for the evidence graph.
  for (const key of Object.keys(g.measurements)) assert.ok(g.sourceRefs[key], `missing source ref: ${key}`);
});

test("parseAppliCadGeometry: independently re-derives every declared number", () => {
  const g = parseAppliCadGeometry(SAMPLE)!;
  // Zero failed checks on a known-good file: all 35 line lengths match the 3D
  // point distances and all 7 facet areas match the Newell recomputation.
  assert.deepEqual(g.checks.filter((c) => !c.ok), []);
  assert.equal(g.needsReview, false);
  for (const f of g.facets) {
    assert.ok(f.ringClosed, `${f.id} ring must close`);
    assert.ok(f.deviation !== null && f.deviation < 0.03, `${f.id} area deviation ${f.deviation}`);
  }
  const computedTotal = g.facets.reduce((s, f) => s + (f.areaComputed ?? 0), 0);
  assert.ok(Math.abs(computedTotal - 1942.68) < 1, `computed total ${computedTotal}`);
});

test("parseAppliCadGeometry: verification catches tampered declared values", () => {
  // Inflate one declared facet size by 20%: the recomputation must flag it.
  const tamperedSize = SAMPLE.replace('size = "957.64"', 'size = "1148.00"');
  const g1 = parseAppliCadGeometry(tamperedSize)!;
  assert.equal(g1.needsReview, true);
  assert.ok(g1.checks.some((c) => c.check === "facet_area_recompute" && c.target === "P1"));

  // Move one point 5 feet: dependent line-length recomputes must flag it.
  const tamperedPoint = SAMPLE.replace('data="9.511042,-24.555638,-0.000000"', 'data="14.511042,-24.555638,-0.000000"');
  const g2 = parseAppliCadGeometry(tamperedPoint)!;
  assert.equal(g2.needsReview, true);
  assert.ok(g2.checks.some((c) => c.check === "line_length_recompute"));
});

test("parseAppliCadGeometry: broken ring and non-XML are handled", () => {
  // Remove one line from a polygon path: the ring cannot close.
  const broken = SAMPLE.replace('path="L24,L12,L28,L11"', 'path="L24,L12,L28"');
  const g = parseAppliCadGeometry(broken)!;
  assert.ok(g.checks.some((c) => c.check === "facet_ring_closure" && c.target === "P1"));
  assert.equal(g.needsReview, true);

  assert.equal(parseAppliCadGeometry("{}"), null);
  assert.equal(isAppliCadXml("<APPLICAD_EXPORT>"), true);
  assert.equal(isAppliCadXml("<html>"), false);
});

test("extractGeometry: finds XML in the raw body or embedded in a field", () => {
  assert.ok(extractGeometry(SAMPLE, {}));
  assert.ok(extractGeometry("{}", { job_number: "J1", xml: SAMPLE }));
  assert.equal(extractGeometry("{}", { job_number: "J1" }), null);
});
