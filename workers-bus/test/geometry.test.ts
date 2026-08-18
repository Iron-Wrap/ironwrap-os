// First-principles geometry engine tests against a sanitized AppliCad fixture
// (node --test, type-stripped — no install). The engine must reproduce the
// known proof values AND independently re-derive them from raw coordinates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GEOMETRY_TOLERANCES,
  isAppliCadXml,
  parseAppliCadGeometry,
} from "../src/geometry.ts";
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
  // The computed total rounds 0.01sf above the source-declared proof value;
  // downstream truth follows the point-derived geometry.
  assert.equal(g.measurements.roof_area, 1942.69);
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
    assert.ok(
      f.planarityResidual !== null &&
        f.planarityResidual <= GEOMETRY_TOLERANCES.planarityResidualFt,
      `${f.id} planarity residual ${f.planarityResidual}`,
    );
    assert.equal(f.contours.outer.role, "outer");
    assert.deepEqual(f.contours.outer.topologyIssues, []);
    assert.deepEqual(f.contours.holes, []);
  }
  const computedTotal = g.facets.reduce((s, f) => s + (f.areaComputed ?? 0), 0);
  assert.ok(Math.abs(computedTotal - g.measurements.roof_area) <= 0.01, `computed total ${computedTotal}`);
});

test("parseAppliCadGeometry: verification catches tampered declared values", () => {
  // Inflate one declared facet size by 20%: the recomputation must flag it.
  const tamperedSize = SAMPLE.replace('size = "957.64"', 'size = "1148.00"');
  const g1 = parseAppliCadGeometry(tamperedSize)!;
  assert.equal(g1.needsReview, true);
  assert.ok(g1.checks.some((c) => c.check === "facet_area_recompute" && c.target === "P1"));
  assert.equal(g1.facets[0].areaDeclared, 1148);
  assert.equal(g1.measurements.roof_area, 1942.69);

  // Declared edge totals are comparison evidence; canonical classified totals
  // continue to come from point-to-point geometry.
  const tamperedLength = SAMPLE.replace('length="79.000000"', 'length="100.000000"');
  const declaredLine = parseAppliCadGeometry(tamperedLength)!;
  assert.equal(declaredLine.lines.find((line) => line.id === "L24")?.lengthDeclared, 100);
  assert.equal(declaredLine.measurements.fascia_length, 147);
  assert.ok(declaredLine.checks.some((c) => c.check === "line_length_recompute" && c.target === "L24"));

  // Move one point 5 feet: dependent line-length recomputes must flag it.
  const tamperedPoint = SAMPLE.replace('data="9.511042,-24.555638,-0.000000"', 'data="14.511042,-24.555638,-0.000000"');
  const g2 = parseAppliCadGeometry(tamperedPoint)!;
  assert.equal(g2.needsReview, true);
  assert.ok(g2.checks.some((c) => c.check === "line_length_recompute"));
});

test("parseAppliCadGeometry: non-planar facets fail closed with a deterministic residual", () => {
  const xml = facetXml(
    [["A", 0, 0, 0], ["B", 10, 0, 0], ["C", 10, 10, 0], ["D", 0, 10, 1]],
    [["L1", "A", "B"], ["L2", "B", "C"], ["L3", "C", "D"], ["L4", "D", "A"]],
    "L1,L2,L3,L4",
  );
  const g = parseAppliCadGeometry(xml)!;
  assert.equal(g.needsReview, true);
  assert.ok((g.facets[0].planarityResidual ?? 0) > GEOMETRY_TOLERANCES.planarityResidualFt);
  assert.ok(g.checks.some((c) => c.check === "facet_planarity" && c.target === "F1"));
});

test("parseAppliCadGeometry: a closed bow-tie contour is rejected as self-intersecting", () => {
  const xml = facetXml(
    [["A", 0, 0, 0], ["B", 10, 10, 0], ["C", 0, 10, 0], ["D", 10, 0, 0]],
    [["L1", "A", "B"], ["L2", "B", "C"], ["L3", "C", "D"], ["L4", "D", "A"]],
    "L1,L2,L3,L4",
  );
  const g = parseAppliCadGeometry(xml)!;
  assert.equal(g.facets[0].ringClosed, true);
  assert.equal(g.needsReview, true);
  assert.ok(g.checks.some((c) => c.check === "facet_self_intersection" && c.target === "F1"));
});

test("parseAppliCadGeometry: duplicate, open, and branching contours are distinct hard stops", () => {
  const squarePoints: PointTuple[] = [["A", 0, 0, 0], ["B", 10, 0, 0], ["C", 10, 10, 0], ["D", 0, 10, 0]];
  const squareLines: LineTuple[] = [["L1", "A", "B"], ["L2", "B", "C"], ["L3", "C", "D"], ["L4", "D", "A"]];

  const duplicate = parseAppliCadGeometry(facetXml(squarePoints, squareLines, "L1,L2,L3,L4,L1"))!;
  assert.ok(duplicate.checks.some((c) => c.check === "facet_topology_duplicate"));
  assert.equal(duplicate.needsReview, true);

  const open = parseAppliCadGeometry(facetXml(squarePoints, squareLines, "L1,L2,L3"))!;
  assert.ok(open.checks.some((c) => c.check === "facet_topology_open"));
  assert.equal(open.needsReview, true);

  const branching = parseAppliCadGeometry(facetXml(
    [["A", 0, 0, 0], ["B", 4, 0, 0], ["C", 2, 2, 0], ["D", -2, 2, 0], ["E", -4, 0, 0]],
    [["L1", "A", "B"], ["L2", "B", "C"], ["L3", "C", "A"], ["L4", "A", "D"], ["L5", "D", "E"], ["L6", "E", "A"]],
    "L1,L2,L3,L4,L5,L6",
  ))!;
  assert.ok(branching.checks.some((c) => c.check === "facet_topology_branching"));
  assert.equal(branching.needsReview, true);
});

test("parseAppliCadGeometry: normal-derived pitch and orientation expose declared mismatches", () => {
  const mismatched = SAMPLE
    .replace('pitch="4.00" pitchuom="slope" orientation="0.00"', 'pitch="7.00" pitchuom="slope" orientation="42.00"');
  const g = parseAppliCadGeometry(mismatched)!;
  const facet = g.facets[0];
  assert.equal(facet.pitch, 7);
  assert.equal(facet.orientation, 42);
  assert.ok(Math.abs((facet.pitchComputed ?? 0) - 4) < 0.001);
  assert.ok(Math.abs((facet.orientationComputed ?? 0) - 0) < 0.001);
  assert.equal(g.measurements.pitch, 4);
  assert.ok(g.checks.some((c) => c.check === "facet_pitch_recompute" && c.target === "P1"));
  assert.ok(g.checks.some((c) => c.check === "facet_orientation_recompute" && c.target === "P1"));
  assert.equal(g.needsReview, true);
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

type PointTuple = [id: string, x: number, y: number, z: number];
type LineTuple = [id: string, from: string, to: string];

function facetXml(points: PointTuple[], lines: LineTuple[], path: string): string {
  return [
    "<APPLICAD_EXPORT>",
    ...points.map(([id, x, y, z]) => `<POINT id="${id}" data="${x},${y},${z}"/>`),
    ...lines.map(([id, from, to]) => `<LINE id="${id}" path="${from},${to}" type="EAVE"/>`),
    `<POLYGON id="F1" path="${path}" type="Roof"/>`,
    "</APPLICAD_EXPORT>",
  ].join("");
}
