#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parseAppliCadGeometry } from "../workers-bus/src/geometry.ts";

const file =
  process.argv.find((arg) => arg.endsWith(".xml")) ??
  "tools/fixtures/synthetic-applicad-roof.xml";
const xml = readFileSync(file, "utf8");

function round(n) {
  return Math.round(n * 100) / 100;
}

function requireGeometry(sourceXml) {
  const geometry = parseAppliCadGeometry(sourceXml);
  assert.ok(geometry, "source must be a parseable AppliCad geometry export");
  return geometry;
}

function buildProof(sourceXml, sourceFile) {
  const geometry = requireGeometry(sourceXml);
  const measurementNames = Object.keys(geometry.measurements)
    .filter((name) => name === "roof_area" || name.endsWith("_length"))
    .sort((left, right) => {
      if (left === "roof_area") return -1;
      if (right === "roof_area") return 1;
      return left.localeCompare(right);
    });
  const measurements = measurementNames.map((name) => ({
    name,
    value: geometry.measurements[name],
    unit: name === "roof_area" ? "sf" : "lf",
    source_ref: `${basename(sourceFile)}:${geometry.sourceRefs[name]}`,
    confidence: "deterministic",
  }));

  return {
    geometry,
    result: {
      source_file: sourceFile,
      measurements,
      declared_comparisons: {
        roof_facets: geometry.facets
          .filter((facet) => facet.type.toLowerCase() === "roof")
          .map((facet) => ({
            id: facet.id,
            declared_sf: facet.areaDeclared,
            computed_sf: facet.areaComputed,
            relative_deviation: facet.deviation,
          })),
        classified_lines: geometry.lines.map((line) => ({
          id: line.id,
          type: line.type,
          declared_lf: line.lengthDeclared,
          computed_lf: line.lengthComputed,
          relative_deviation: line.deviation,
        })),
      },
      checks: geometry.checks,
      needs_review: geometry.needsReview,
    },
  };
}

function measurement(result, name) {
  return result.measurements.find((entry) => entry.name === name)?.value;
}

function computedRoofArea(geometry) {
  const roofFacets = geometry.facets.filter(
    (facet) => facet.type.toLowerCase() === "roof",
  );
  assert.ok(roofFacets.length > 0, "proof fixture must contain roof facets");
  assert.ok(
    roofFacets.every((facet) => facet.areaComputed !== null),
    "every roof facet must have a computable outer contour",
  );
  return round(roofFacets.reduce((sum, facet) => sum + facet.areaComputed, 0));
}

function computedLength(geometry, type) {
  const lines = geometry.lines.filter((line) => line.type === type);
  assert.ok(lines.length > 0, `proof fixture must contain ${type} lines`);
  assert.ok(
    lines.every((line) => line.lengthComputed !== null),
    `every ${type} line must have computable endpoints`,
  );
  return round(lines.reduce((sum, line) => sum + line.lengthComputed, 0));
}

const { geometry, result } = buildProof(xml, file);

if (process.argv.includes("--check")) {
  // Canonical summaries must equal independently aggregated computed geometry.
  assert.equal(measurement(result, "roof_area"), computedRoofArea(geometry));
  for (const type of new Set(geometry.lines.map((line) => line.type))) {
    const name = `${type.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_length`;
    assert.equal(measurement(result, name), computedLength(geometry, type));
  }
  assert.equal(measurement(result, "roof_area"), 1942.69);
  assert.equal(measurement(result, "ridge_length"), 89);
  assert.equal(measurement(result, "valley_length"), 24.7);
  assert.match(
    result.measurements.find((entry) => entry.name === "roof_area")
      ?.source_ref ?? "",
    /Newell outer contour area/,
  );
  assert.match(
    result.measurements.find((entry) => entry.name === "ridge_length")
      ?.source_ref ?? "",
    /distance\(POINT\[from\], POINT\[to\]\)/,
  );
  assert.equal(
    round(
      result.declared_comparisons.roof_facets.reduce(
        (sum, facet) => sum + facet.declared_sf,
        0,
      ),
    ),
    1942.68,
  );
  assert.equal(result.needs_review, false);

  // Declared values remain evidence only: changing them must not change canonical totals.
  const declarationTamperedXml = xml
    .replace('size = "957.64"', 'size = "1148.00"')
    .replace('length="79.000000"', 'length="100.000000"');
  assert.notEqual(
    declarationTamperedXml,
    xml,
    "declaration tamper must alter the fixture",
  );
  const declarationTampered = buildProof(declarationTamperedXml, file).result;
  assert.equal(
    measurement(declarationTampered, "roof_area"),
    measurement(result, "roof_area"),
  );
  assert.equal(
    measurement(declarationTampered, "fascia_length"),
    measurement(result, "fascia_length"),
  );
  assert.equal(
    declarationTampered.declared_comparisons.roof_facets.find(
      (facet) => facet.id === "P1",
    )?.declared_sf,
    1148,
  );
  assert.equal(
    declarationTampered.declared_comparisons.classified_lines.find(
      (line) => line.id === "L24",
    )?.declared_lf,
    100,
  );
  assert.equal(declarationTampered.needs_review, true);

  // Coordinate changes are geometry changes: they must alter canonical truth and fail closed.
  const geometryTamperedXml = xml.replace(
    'id="C5" data="-31.988958,-14.055638,3.833333"',
    'id="C5" data="-31.988958,-14.055638,4.833333"',
  );
  assert.notEqual(
    geometryTamperedXml,
    xml,
    "geometry tamper must alter the fixture",
  );
  const geometryTampered = buildProof(geometryTamperedXml, file).result;
  assert.notEqual(
    measurement(geometryTampered, "roof_area"),
    measurement(result, "roof_area"),
  );
  assert.notEqual(
    measurement(geometryTampered, "ridge_length"),
    measurement(result, "ridge_length"),
  );
  assert.equal(
    geometryTampered.declared_comparisons.roof_facets.find(
      (facet) => facet.id === "P1",
    )?.declared_sf,
    957.64,
  );
  assert.equal(
    geometryTampered.declared_comparisons.classified_lines.find(
      (line) => line.id === "L28",
    )?.declared_lf,
    79,
  );
  assert.equal(geometryTampered.needs_review, true);
  assert.ok(
    geometryTampered.checks.some(
      (check) => check.check === "facet_planarity" && check.ok === false,
    ),
    "geometry tamper must produce a planarity review check",
  );
} else {
  console.log(JSON.stringify(result, null, 2));
}
