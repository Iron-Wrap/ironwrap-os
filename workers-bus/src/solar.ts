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
const MAX_ROOF_AREA_M2 = 1_000_000;
const MAX_SOLAR_SEGMENTS = 10_000;
const MAX_EVIDENCE_ISSUES = 24;
const MAX_PITCH_RISE_12 = 120;
const MIN_AZIMUTH_CONCENTRATION = 1e-9;

export type SolarImageryQuality = "HIGH" | "MEDIUM" | "LOW";

export const SOLAR_CROSS_CHECK_POLICY = Object.freeze({
  areaTolerance: 0.10,
  pitchTolerance: 1,
  azimuthTolerance: 15,
  maxImageryAgeDays: 1_826,
  minimumImageryQuality: "MEDIUM" as SolarImageryQuality,
  automaticTolerancePromotion: false,
});

export interface SolarSegment {
  pitchDegrees: number | null;
  /** Roofer's units: rise per 12 run, from tan(pitchDegrees). */
  pitchRise12: number | null;
  azimuthDegrees: number | null;
  areaMeters2: number | null;
  areaSqft: number | null;
}

export interface SolarModel {
  provider: "google_solar";
  /** Capture date of the imagery the model was built from (staleness evidence). */
  imageryDate: string | null;
  imageryProcessedDate: string | null;
  imageryQuality: SolarImageryQuality | null;
  confidence: {
    state: "unavailable";
    reason: "google_solar_building_insights_does_not_publish_statistical_confidence";
  };
  segmentCorrespondence: {
    state: "unavailable";
    reason: "no_stable_cross_source_segment_identifier";
  };
  /** Invalid or insufficient provider facts retained as explicit evidence state. */
  evidenceIssues: string[];
  segments: SolarSegment[];
  measurements: Record<string, number>;
  sourceRefs: Record<string, string>;
}

export type SolarParseResult =
  | { state: "available"; model: SolarModel }
  | {
    state: "unavailable";
    reason: "payload_not_object" | "solar_potential_unavailable" | "roof_evidence_unavailable" | "segment_limit_exceeded";
  };

export interface CrossCheckComparison {
  metric: string;
  primary: number;
  independent: number;
  /** Relative difference for area-like metrics; null when absolute is the unit. */
  relDiff: number | null;
  /** Absolute difference for pitch/azimuth metrics; null when relative is the unit. */
  absDiff: number | null;
  ok: boolean;
}

export interface CrossCheckResult {
  checks: GeoCheck[];
  needsReview: boolean;
  /** Structured rows for the measurement-delta ledger (same facts as checks). */
  comparisons: CrossCheckComparison[];
}

export interface CrossCheckOptions {
  /** Relative roof-area tolerance (default 10%: catches wrong building, not drift). */
  areaTolerance?: number;
  /** Absolute pitch tolerance in rise/12 units (default 1). */
  pitchTolerance?: number;
  /** Absolute circular azimuth tolerance in degrees (default 15). */
  azimuthTolerance?: number;
  /** Label used in check targets (default google_solar). */
  providerLabel?: string;
}

export interface SolarEvidenceOptions {
  maxImageryAgeDays?: number;
  minimumImageryQuality?: SolarImageryQuality;
}

export interface SolarEvidenceAssessment {
  usable: boolean;
  imageryAgeDays: number | null;
  checks: GeoCheck[];
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const boundedNumber = (v: unknown, min: number, max: number, maxInclusive = true): number | null => {
  const n = num(v);
  return n !== null && n >= min && (maxInclusive ? n <= max : n < max) ? n : null;
};

const googleDate = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const year = boundedNumber(raw.year, 1900, 9_999);
  const month = boundedNumber(raw.month, 1, 12);
  const day = boundedNumber(raw.day, 1, 31);
  if (![year, month, day].every((part) => part !== null && Number.isInteger(part))) return null;
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const imageryQuality = (value: unknown): SolarImageryQuality | null =>
  value === "HIGH" || value === "MEDIUM" || value === "LOW" ? value : null;

const circularDifference = (left: number, right: number): number => {
  const normalized = Math.abs(((left - right) % 360 + 360) % 360);
  return Math.min(normalized, 360 - normalized);
};

const weightedCircularMean = (
  entries: ReadonlyArray<{ angle: number; weight: number }>,
): { angle: number | null; concentration: number } => {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return { angle: null, concentration: 0 };
  const x = entries.reduce((sum, entry) => sum + Math.sin(entry.angle * Math.PI / 180) * entry.weight, 0);
  const y = entries.reduce((sum, entry) => sum + Math.cos(entry.angle * Math.PI / 180) * entry.weight, 0);
  const concentration = Math.hypot(x, y) / total;
  if (concentration <= MIN_AZIMUTH_CONCENTRATION) return { angle: null, concentration };
  return { angle: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360, concentration };
};

/** Parse a buildingInsights response while preserving why provider evidence is unavailable. */
export function parseSolarBuildingInsightsResult(json: unknown): SolarParseResult {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { state: "unavailable", reason: "payload_not_object" };
  }
  const root = json as Record<string, unknown>;
  const potential = root.solarPotential as Record<string, unknown> | undefined;
  if (!potential || typeof potential !== "object" || Array.isArray(potential)) {
    return { state: "unavailable", reason: "solar_potential_unavailable" };
  }

  const evidenceIssues: string[] = [];
  const addIssue = (issue: string) => {
    if (evidenceIssues.length < MAX_EVIDENCE_ISSUES - 1) evidenceIssues.push(issue);
    else if (evidenceIssues.at(-1) !== "additional_provider_evidence_issues_truncated") {
      evidenceIssues.push("additional_provider_evidence_issues_truncated");
    }
  };
  const segments: SolarSegment[] = [];
  if (potential.roofSegmentStats !== undefined && !Array.isArray(potential.roofSegmentStats)) {
    addIssue("roof_segments_invalid");
  }
  const rawSegments = Array.isArray(potential.roofSegmentStats) ? potential.roofSegmentStats : [];
  if (rawSegments.length > MAX_SOLAR_SEGMENTS) {
    return { state: "unavailable", reason: "segment_limit_exceeded" };
  }
  for (const [index, raw] of rawSegments.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      addIssue(`segment_${index}_invalid`);
      continue;
    }
    const seg = raw as Record<string, unknown>;
    const stats = seg.stats && typeof seg.stats === "object" && !Array.isArray(seg.stats)
      ? seg.stats as Record<string, unknown>
      : {};
    const pitchDegrees = boundedNumber(seg.pitchDegrees, 0, 90, false);
    const azimuthDegrees = boundedNumber(seg.azimuthDegrees, 0, 360, false);
    const areaM2 = boundedNumber(stats.areaMeters2, Number.MIN_VALUE, MAX_ROOF_AREA_M2);
    if (seg.pitchDegrees !== undefined && pitchDegrees === null) addIssue(`segment_${index}_pitch_degrees_invalid`);
    if (seg.azimuthDegrees !== undefined && azimuthDegrees === null) addIssue(`segment_${index}_azimuth_degrees_invalid`);
    if (stats.areaMeters2 !== undefined && areaM2 === null) addIssue(`segment_${index}_area_m2_invalid`);
    segments.push({
      pitchDegrees,
      pitchRise12: pitchDegrees !== null ? round(Math.tan((pitchDegrees * Math.PI) / 180) * 12, 2) : null,
      azimuthDegrees,
      areaMeters2: areaM2,
      areaSqft: areaM2 !== null ? round(areaM2 * M2_TO_SQFT, 2) : null,
    });
  }

  const wholeRoof = potential.wholeRoofStats && typeof potential.wholeRoofStats === "object" && !Array.isArray(potential.wholeRoofStats)
    ? potential.wholeRoofStats as Record<string, unknown>
    : {};
  const wholeRoofM2 = boundedNumber(wholeRoof.areaMeters2, Number.MIN_VALUE, MAX_ROOF_AREA_M2);
  if (wholeRoof.areaMeters2 !== undefined && wholeRoofM2 === null) addIssue("whole_roof_area_m2_invalid");
  const segmentM2 = segments.reduce((sum, segment) => sum + (segment.areaMeters2 ?? 0), 0);
  if (segmentM2 > MAX_ROOF_AREA_M2) addIssue("segment_roof_area_total_invalid");
  if (wholeRoofM2 === null && segments.length === 0) {
    return { state: "unavailable", reason: "roof_evidence_unavailable" };
  }

  const measurements: Record<string, number> = {};
  const sourceRefs: Record<string, string> = {};
  if (wholeRoofM2 !== null) {
    measurements.roof_area = round(wholeRoofM2 * M2_TO_SQFT, 2);
    sourceRefs.roof_area = "solarPotential.wholeRoofStats.areaMeters2 x 10.7639";
  } else if (segmentM2 > 0 && segmentM2 <= MAX_ROOF_AREA_M2) {
    measurements.roof_area = round(segmentM2 * M2_TO_SQFT, 2);
    sourceRefs.roof_area = `sum(roofSegmentStats.stats.areaMeters2) x 10.7639 over ${segments.length} segments`;
  }
  if (segments.length && segments.every((segment) => segment.pitchDegrees !== null && segment.areaMeters2 !== null)) {
    const weight = segments.reduce((sum, segment) => sum + segment.areaMeters2!, 0);
    measurements.pitch = round(
      segments.reduce(
        (sum, segment) => sum + Math.tan(segment.pitchDegrees! * Math.PI / 180) * 12 * segment.areaMeters2!,
        0,
      ) / weight,
      2,
    );
    sourceRefs.pitch = `area-weighted mean(tan(roofSegmentStats.pitchDegrees) x 12) over ${segments.length} segments`;
  } else if (segments.some((segment) => segment.pitchRise12 !== null)) {
    addIssue("pitch_aggregate_insufficient_segment_area_or_pitch");
  }
  const directional = segments.filter((segment) => segment.pitchDegrees !== null && segment.pitchDegrees > 0.1);
  if (directional.length && directional.every((segment) => segment.azimuthDegrees !== null && segment.areaMeters2 !== null)) {
    const aggregate = weightedCircularMean(directional.map((segment) => ({
      angle: segment.azimuthDegrees!,
      weight: segment.areaMeters2!,
    })));
    if (aggregate.angle === null) {
      addIssue("azimuth_aggregate_ambiguous");
    } else {
      measurements.azimuth = round(aggregate.angle, 2);
      sourceRefs.azimuth = `area-weighted circular mean(roofSegmentStats.azimuthDegrees) over ${directional.length} non-flat segments`;
    }
  } else if (directional.length) {
    addIssue("azimuth_aggregate_insufficient_segment_area_or_azimuth");
  } else if (segments.length) {
    addIssue("azimuth_aggregate_unavailable_flat_or_pitchless_roof");
  }
  if (segments.length) {
    measurements.segment_count = segments.length;
    sourceRefs.segment_count = "count(roofSegmentStats) - generalized by Google, never cross-checked";
  }

  const parsedImageryDate = googleDate(root.imageryDate);
  const parsedProcessedDate = googleDate(root.imageryProcessedDate);
  const parsedImageryQuality = imageryQuality(root.imageryQuality);
  if (root.imageryDate !== undefined && parsedImageryDate === null) addIssue("imagery_date_invalid");
  if (root.imageryProcessedDate !== undefined && parsedProcessedDate === null) addIssue("imagery_processed_date_invalid");
  if (root.imageryQuality !== undefined && parsedImageryQuality === null) addIssue("imagery_quality_invalid");

  return { state: "available", model: {
    provider: "google_solar",
    imageryDate: parsedImageryDate,
    imageryProcessedDate: parsedProcessedDate,
    imageryQuality: parsedImageryQuality,
    confidence: {
      state: "unavailable",
      reason: "google_solar_building_insights_does_not_publish_statistical_confidence",
    },
    segmentCorrespondence: {
      state: "unavailable",
      reason: "no_stable_cross_source_segment_identifier",
    },
    evidenceIssues,
    segments,
    measurements,
    sourceRefs,
  } };
}

/** Compatibility projection for existing consumers. */
export function parseSolarBuildingInsights(json: unknown): SolarModel | null {
  const result = parseSolarBuildingInsightsResult(json);
  return result.state === "available" ? result.model : null;
}

const QUALITY_RANK: Readonly<Record<SolarImageryQuality, number>> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export function assessSolarEvidence(
  model: SolarModel,
  now: Date = new Date(),
  opts: SolarEvidenceOptions = {},
): SolarEvidenceAssessment {
  const maxAge = opts.maxImageryAgeDays ?? SOLAR_CROSS_CHECK_POLICY.maxImageryAgeDays;
  const minimumQuality = opts.minimumImageryQuality ?? SOLAR_CROSS_CHECK_POLICY.minimumImageryQuality;
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 36_525) throw new Error("solar_invalid_max_imagery_age_days");
  if (!Object.prototype.hasOwnProperty.call(QUALITY_RANK, minimumQuality)) throw new Error("solar_invalid_minimum_imagery_quality");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("solar_invalid_evidence_as_of");

  const capturedMs = model.imageryDate === null ? Number.NaN : Date.parse(`${model.imageryDate}T00:00:00.000Z`);
  const imageryAgeDays = Number.isFinite(capturedMs) ? Math.floor((nowMs - capturedMs) / 86_400_000) : null;
  const dateOk = imageryAgeDays !== null && imageryAgeDays >= 0 && imageryAgeDays <= maxAge;
  const qualityOk = model.imageryQuality !== null && QUALITY_RANK[model.imageryQuality] >= QUALITY_RANK[minimumQuality];
  const dateDetail = imageryAgeDays === null
    ? "date unavailable"
    : imageryAgeDays < 0
      ? `date ${model.imageryDate} is in the future`
      : imageryAgeDays > maxAge
        ? `date ${model.imageryDate} age ${imageryAgeDays}d is stale (>${maxAge}d)`
        : `date ${model.imageryDate} age ${imageryAgeDays}d`;
  const qualityDetail = model.imageryQuality === null
    ? "quality unavailable"
    : qualityOk
      ? `quality ${model.imageryQuality} meets ${minimumQuality}`
      : `quality ${model.imageryQuality} is below ${minimumQuality}`;
  const invalidFacts = model.evidenceIssues.filter(
    (issue) => issue.endsWith("_invalid") || issue === "additional_provider_evidence_issues_truncated",
  );
  const usable = dateOk && qualityOk && invalidFacts.length === 0;
  const checks: GeoCheck[] = [
    {
      check: "cross_source_imagery",
      target: "google_solar",
      ok: dateOk && qualityOk,
      detail: `imagery ${dateDetail}; ${qualityDetail}`,
    },
    {
      check: "cross_source_confidence_availability",
      target: "google_solar",
      ok: true,
      detail: `statistical confidence unavailable: ${model.confidence.reason}; never inferred`,
    },
    {
      check: "cross_source_segment_correspondence",
      target: "google_solar",
      ok: true,
      detail: `facet-to-segment correspondence unavailable: ${model.segmentCorrespondence.reason}; no matching inferred`,
    },
  ];
  if (model.evidenceIssues.length) {
    checks.push({
      check: "cross_source_provider_evidence",
      target: "google_solar",
      ok: invalidFacts.length === 0,
      detail: model.evidenceIssues.join(", "),
    });
  }
  return { usable, imageryAgeDays, checks };
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
  const areaTolerance = opts.areaTolerance ?? SOLAR_CROSS_CHECK_POLICY.areaTolerance;
  const pitchTolerance = opts.pitchTolerance ?? SOLAR_CROSS_CHECK_POLICY.pitchTolerance;
  const azimuthTolerance = opts.azimuthTolerance ?? SOLAR_CROSS_CHECK_POLICY.azimuthTolerance;
  if (!Number.isFinite(areaTolerance) || areaTolerance < 0 || areaTolerance > 1) throw new Error("solar_invalid_area_tolerance");
  if (!Number.isFinite(pitchTolerance) || pitchTolerance < 0 || pitchTolerance > MAX_PITCH_RISE_12) throw new Error("solar_invalid_pitch_tolerance");
  if (!Number.isFinite(azimuthTolerance) || azimuthTolerance < 0 || azimuthTolerance > 180) throw new Error("solar_invalid_azimuth_tolerance");
  const label = opts.providerLabel ?? "google_solar";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(label)) throw new Error("solar_invalid_provider_label");
  const checks: GeoCheck[] = [];
  const comparisons: CrossCheckComparison[] = [];

  const metric = (
    source: Record<string, number>,
    key: string,
    owner: string,
    min: number,
    max: number,
    maxInclusive = true,
  ): number | null => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return null;
    const value = boundedNumber(source[key], min, max, maxInclusive);
    if (value === null) {
      checks.push({
        check: `cross_source_${key}_evidence`,
        target: label,
        ok: false,
        detail: `${owner} ${key} is non-finite or outside ${min}..${max}${maxInclusive ? "" : " (exclusive max)"}`,
      });
    }
    return value;
  };

  const primaryArea = metric(primary, "roof_area", "primary", Number.MIN_VALUE, MAX_ROOF_AREA_M2 * M2_TO_SQFT);
  const independentArea = metric(independent, "roof_area", label, Number.MIN_VALUE, MAX_ROOF_AREA_M2 * M2_TO_SQFT);
  if (primaryArea !== null && independentArea !== null) {
    const rel = Math.abs(primaryArea - independentArea) / primaryArea;
    const ok = rel <= areaTolerance;
    checks.push({
      check: "cross_source_roof_area",
      target: label,
      ok,
      detail: `primary ${primaryArea} sf vs ${label} ${independentArea} sf (${(rel * 100).toFixed(1)}%; policy <= ${(areaTolerance * 100).toFixed(1)}%)`,
    });
    comparisons.push({
      metric: "roof_area",
      primary: primaryArea,
      independent: independentArea,
      relDiff: round(rel, 6),
      absDiff: null,
      ok,
    });
  }
  const primaryPitch = metric(primary, "pitch", "primary", 0, MAX_PITCH_RISE_12);
  const independentPitch = metric(independent, "pitch", label, 0, MAX_PITCH_RISE_12);
  if (primaryPitch !== null && independentPitch !== null) {
    const diff = Math.abs(primaryPitch - independentPitch);
    const ok = diff <= pitchTolerance;
    checks.push({
      check: "cross_source_pitch",
      target: label,
      ok,
      detail: `primary ${primaryPitch}/12 vs ${label} ${independentPitch}/12 (diff ${round(diff, 2)}; policy <= ${pitchTolerance})`,
    });
    comparisons.push({
      metric: "pitch",
      primary: primaryPitch,
      independent: independentPitch,
      relDiff: null,
      absDiff: round(diff, 4),
      ok,
    });
  }
  const primaryAzimuth = metric(primary, "azimuth", "primary", 0, 360, false);
  const independentAzimuth = metric(independent, "azimuth", label, 0, 360, false);
  if (primaryAzimuth !== null && independentAzimuth !== null) {
    const diff = circularDifference(primaryAzimuth, independentAzimuth);
    const ok = diff <= azimuthTolerance;
    checks.push({
      check: "cross_source_azimuth",
      target: label,
      ok,
      detail: `primary ${primaryAzimuth}deg vs ${label} ${independentAzimuth}deg (circular diff ${round(diff, 2)}deg; policy <= ${azimuthTolerance}deg)`,
    });
    comparisons.push({
      metric: "azimuth",
      primary: primaryAzimuth,
      independent: independentAzimuth,
      relDiff: null,
      absDiff: round(diff, 4),
      ok,
    });
  }
  return { checks, needsReview: checks.some((c) => !c.ok), comparisons };
}
