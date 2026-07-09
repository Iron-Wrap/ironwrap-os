#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import assert from "node:assert/strict";

const file = process.argv.find((arg) => arg.endsWith(".xml")) ?? "samples/1013 Moville St.xml";
const xml = readFileSync(file, "utf8");

function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

const polygons = [...xml.matchAll(/<POLYGON\b[^>]*>/g)].map((m) => attrs(m[0]));
const lines = [...xml.matchAll(/<LINE\b[^>]*>/g)].map((m) => attrs(m[0]));

const measurements = [];
const roofArea = round(polygons.reduce((sum, p) => sum + (p.type === "Roof" ? Number(p.size || 0) : 0), 0));
measurements.push({
  name: "roof_area",
  value: roofArea,
  unit: "sf",
  source_ref: `${basename(file)}:POLYGON[size,type=Roof]`,
  confidence: "deterministic",
});

for (const type of [...new Set(lines.map((line) => line.type))].sort()) {
  const value = round(lines.reduce((sum, line) => sum + (line.type === type ? Number(line.length || 0) : 0), 0));
  measurements.push({
    name: `${type.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_length`,
    value,
    unit: "lf",
    source_ref: `${basename(file)}:LINE[type=${type},length]`,
    confidence: "deterministic",
  });
}

const result = { source_file: file, measurements, needs_review: false };

if (process.argv.includes("--check")) {
  assert.equal(result.measurements.find((m) => m.name === "roof_area")?.value, 1942.68);
  assert.equal(result.measurements.find((m) => m.name === "ridge_length")?.value, 89);
  assert.equal(result.measurements.find((m) => m.name === "valley_length")?.value, 24.7);
} else {
  console.log(JSON.stringify(result, null, 2));
}
