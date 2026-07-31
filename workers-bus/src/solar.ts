// solar.ts - Google Solar API as an INDEPENDENT roof-geometry source + cross-check.
//
// buildingInsights (solar.googleapis.com/v1/buildingInsights:findClosest) returns
// per-segment roof data derived from Google's aerial imagery: pitchDegrees,
// azimuthDegrees, stats.areaMeters2, plus wholeRoofStats and the imagery date.
// That is a measurement nobody in the report market sells us: a second opinion
// that costs cents. This module parses that response into the same flat
// measurement map the pipeline already speaks, and cross-checks it against a
// primary source (AppliCad/RoofRuler/EagleView) with explicit tolerances.
//
// Role discipline: Solar data VERIFIES, it never replaces the primary source.
// Google generalizes small facets, merges segments, and its imagery can be years
// old (imageryDate is surfaced as evidence for exactly that reason). So facet
// counts are not compared at all, and tolerances are wide by design: this check
// catches wrong-building, stale-roofline, and order-of-magnitude errors, not
// half-percent drift.
//
// Pure, zero-dep, Workers-safe: JSON in, model out. The HTTP fetch is
// credential-gated elsewhere (same pattern as googleConfigured) - API key and
// billing are an operator decision, not a code default.
//
// ponytail: coverage varies by region (Alberta must be probed per address);
//   a null parse or missing fields simply yields fewer comparable keys.

import type { GeoCheck } from "./geometry.ts";

export const M2_TO_SQFT = 10.763910417;

export interface SolarSegment {
  pitchDegrees: number | null;
  /** Roofer's units: rise per 12 run, from tan(pitchDegrees). */
  pitchRise12: number | null;
  azimuthDegrees: number | null;
  areaSqft: number | null;
}

export interface SolarModel {
  provider: "google_solar";
  /** Capture date of the imagery the model was built from (staleness evidence). */
  imageryDate: string | null;
  imageryQuality: string | null;
  segments: SolarSegment[];
  measurements: Record<string, number>;
  sourceRefs: Record<string, string>;
}

export interface CrossCheckResult { checks: GeoCheck[]; needsReview: boolean }

export interface CrossCheckOptions {
  /** Relative roof-area tolerance (default 10%: catches wrong building, not drift). */
  areaTolerance?: number;
  /** Absolute pitch tolerance in rise/12 units (default 1). */
  pitchTolerance?: number;
  /** Label used in check targets (default google_solar). */
  providerLabel?: string;
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a buildingInsights response into pipeline measurements. Null if not one. */
export function parseSolarBuildingInsights(json: unknown): SolarModel | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const potential = root.solarPotential as Record<string, unknown> | undefined;
  if (!potential || typeof potential !== "object") return null;

  const segments: SolarSegment[] = [];
  const rawSegments = Array.isArray(potential.roofSegmentStats) ? potential.roofSegmentStats : [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== "object") continue;
    const seg = raw as Record<string, unknown>;
    const stats = (seg.stats ?? {}) as Record<string, unknown>;
    const pitchDegrees = num(seg.pitchDegrees);
    const areaM2 = num(stats.areaMeters2);
    segments.push({
      pitchDegrees,
      pitchRise12: pitchDegrees !== null ? round(Math.tan((pitchDegrees * Math.PI) / 180) * 12, 2) : null,
      azimuthDegrees: num(seg.azimuthDegrees),
      areaSqft: areaM2 !== null ? round(areaM2 * M2_TO_SQFT, 2) : null,
    });
  }

  const wholeRoof = (potential.wholeRoofStats ?? {}) as Record<string, unknown>;
  const wholeRoofM2 = num(wholeRoof.areaMeters2);
  const segmentSqft = segments.reduce((s, x) => s + (x.areaSqft ?? 0), 0);
  if (wholeRoofM2 === null && segments.length === 0) return null;

  const measurements: Record<string, number> = {};
  const sourceRefs: Record<string, string> = {};
  if (wholeRoofM2 !== null) {
    measurements.roof_area = round(wholeRoofM2 * M2_TO_SQFT, 2);
    sourceRefs.roof_area = "solarPotential.wholeRoofStats.areaMeters2 x 10.7639";
  } else if (segmentSqft > 0) {
    measurements.roof_area = round(segmentSqft, 2);
    sourceRefs.roof_area = `sum(roofSegmentStats.stats.areaMeters2) x 10.7639 over ${segments.length} segments`;
  }
  const rises = segments.map((s) => s.pitchRise12).filter((p): p is number => p !== null);
  if (rises.length) {
    const spread = Math.max(...rises) - Math.min(...rises);
    if (spread <= 0.5) {
      measurements.pitch = round(rises.reduce((s, p) => s + p, 0) / rises.length, 1);
      sourceRefs.pitch = `tan(roofSegmentStats.pitchDegrees) x 12, uniform over ${rises.length} segments`;
    }
  }
  if (segments.length) {
    measurements.segment_count = segments.length;
    sourceRefs.segment_count = "count(roofSegmentStats) - generalized by Google, never cross-checked";
  }

  const d = root.imageryDate as Record<string, unknown> | undefined;
  const imageryDate = d && num(d.year) !== null
    ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}`
    : null;

  return {
    provider: "google_solar",
    imageryDate,
    imageryQuality: typeof root.imageryQuality === "string" ? root.imageryQuality : null,
    segments,
    measurements,
    sourceRefs,
  };
}

const SOLAR_URL = "https://solar.googleapis.com/v1/buildingInsights:findClosest";
const SOLAR_TIMEOUT_MS = 10_000;

export function solarConfigured(env: Env): boolean {
  return !!env.GOOGLE_MAPS_API_KEY;
}

/**
 * Fetch buildingInsights for a location. Returns the raw JSON, or null when
 * Google has no coverage there (404). Other failures throw; callers treat the
 * whole cross-check as best-effort and must never fail intake on it.
 */
export async function fetchBuildingInsights(env: Env, lat: number, lng: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLAR_TIMEOUT_MS);
  try {
    const url = `${SOLAR_URL}?location.latitude=${lat}&location.longitude=${lng}` +
      `&requiredQuality=MEDIUM&key=${env.GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`solar_status_${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare a primary measurement map against an independent one. Pure. */
export function crossCheckMeasurements(
  primary: Record<string, number>,
  independent: Record<string, number>,
  opts: CrossCheckOptions = {},
): CrossCheckResult {
  const areaTolerance = opts.areaTolerance ?? 0.10;
  const pitchTolerance = opts.pitchTolerance ?? 1;
  const label = opts.providerLabel ?? "google_solar";
  const checks: GeoCheck[] = [];

  if (primary.roof_area !== undefined && independent.roof_area !== undefined && primary.roof_area > 0) {
    const rel = Math.abs(primary.roof_area - independent.roof_area) / primary.roof_area;
    checks.push({
      check: "cross_source_roof_area",
      target: label,
      ok: rel <= areaTolerance,
      detail: `primary ${primary.roof_area} sf vs ${label} ${independent.roof_area} sf (${(rel * 100).toFixed(1)}%)`,
    });
  }
  if (primary.pitch !== undefined && independent.pitch !== undefined) {
    const diff = Math.abs(primary.pitch - independent.pitch);
    checks.push({
      check: "cross_source_pitch",
      target: label,
      ok: diff <= pitchTolerance,
      detail: `primary ${primary.pitch}/12 vs ${label} ${independent.pitch}/12 (diff ${round(diff, 2)})`,
    });
  }
  return { checks, needsReview: checks.some((c) => !c.ok) };
}
