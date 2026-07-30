import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseAppliCadGeometry } from "../src/geometry.ts";
import { deriveRoofGraph, ROOF_GRAPH_SCHEMA_VERSION } from "../src/roof-graph.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

test("deriveRoofGraph: preserves verified AppliCad geometry and marks unknown provenance explicitly", () => {
  const geometry = parseAppliCadGeometry(SAMPLE)!;
  const rawSha256 = "a".repeat(64);
  const graph = deriveRoofGraph({
    geometry,
    rawKey: `raw/measurements/${rawSha256}.json`,
    rawSha256,
    provider: "AppliCad",
    ingestedAt: "2026-07-18T10:00:00.000Z",
  });

  assert.equal(graph.schema_version, ROOF_GRAPH_SCHEMA_VERSION);
  assert.equal(graph.revision, rawSha256);
  assert.deepEqual(graph.source, {
    raw_key: `raw/measurements/${rawSha256}.json`,
    raw_sha256: rawSha256,
    provider: "AppliCad",
    ingested_at: "2026-07-18T10:00:00.000Z",
    capture: { captured_at: null, provenance: "not_supplied" },
  });
  assert.deepEqual(graph.coordinate_system, {
    kind: "local_3d",
    crs: null,
    transform: null,
    provenance: "not_declared_by_source",
  });
  assert.deepEqual(graph.points, geometry.points);
  assert.deepEqual(graph.edges, geometry.lines);
  assert.deepEqual(graph.facets, geometry.facets);
  assert.deepEqual(graph.checks, geometry.checks);
  assert.deepEqual(graph.measurements, geometry.measurements);
  assert.deepEqual(graph.source_refs, geometry.sourceRefs);
});
