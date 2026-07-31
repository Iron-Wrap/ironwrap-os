// takeoff.ts - first-principles metal takeoff over verified roof geometry.
//
// AppliCad's defensible core is not measurement (the export file already carries
// the geometry) but the simulation of LAYING material: panels stripped across
// each facet, cut lists, offcut reuse, trim and fastener counts. This module
// reproduces that core directly from the verified GeometryModel, so the pipeline
// goes measurement file -> checked geometry -> order-ready takeoff without a
// human re-modelling the roof in a desktop CAD.
//
// Method: each roof facet ring is projected onto an orthonormal in-plane basis
// (u along the horizontal eave direction, v up the slope), panels are vertical
// strips of coverage width, and each strip's cut length is the exact v-extent of
// the facet polygon clipped to that strip (Sutherland-Hodgman against the two
// strip bounds). Because the basis is orthonormal inside the facet plane, strip
// extents ARE true 3D lengths. Cuts are then nested: coil mode (cut-to-length
// roll forming, the standing-seam default) or stock mode (best-fit-decreasing
// into stock lengths, reusing offcuts). Trims split into stock sticks; fastener
// counts derive from panel seams and trim runs.
//
// Verification propagates: needs_review geometry never silently becomes an
// order (needsReview is OR-ed through), every total carries a source ref, and
// per-facet overage vs the RECOMPUTED Newell area is reported, so waste is a
// verifiable number instead of a vendor "allowance".
//
// Pure, zero-dep, Workers-safe. Ceilings, named:
// ponytail: per-strip extent assumes one span per strip; deeply concave facets
//   overstate (conservative: orders more, never less).
// ponytail: no cross-facet block cutting (hip offcut reused on the mirrored
//   valley); add via roof-graph adjacency when metal volume justifies it.
// ponytail: trim profile map and fastener rates are defaults; calibrate per
//   assembly spec before quoting from them.

import type { GeoCheck, GeometryModel, GeoPoint } from "./geometry.ts";
import { chainRing, newellNormal } from "./geometry.ts";

export interface TakeoffOptions {
  /** Panel coverage width, ft (default 16in). */
  coverageWidthFt?: number;
  /** Cut-length order increment, ft (default 1in). */
  lengthIncrementFt?: number;
  /** Roll-former / shipping limit; longer cuts flag needs_review. null = unlimited. */
  maxPanelLengthFt?: number | null;
  /** Stock lengths to nest panel cuts into; null = coil (cut-to-length). */
  stockLengthsFt?: number[] | null;
  /** Offcut counted as reusable in the summary when at least this long, ft. */
  minReusableOffcutFt?: number;
  /** Trim stick length, ft (default 10). */
  trimStockFt?: number;
  /** Lap consumed per field splice on runs longer than one stick, ft. */
  trimLapFt?: number;
  /** LINE type -> trim profile name; unmapped types keep their lowercased type. */
  trimProfiles?: Record<string, string>;
  /** Concealed clip spacing along each seam, ft. */
  clipSpacingFt?: number;
  screwsPerClip?: number;
  /** Trim fastener spacing, ft. */
  trimScrewSpacingFt?: number;
}

export interface PanelCut { facetId: string; seam: number; lengthFt: number; widthFt: number }
export interface FacetLayout {
  facetId: string;
  panels: PanelCut[];
  panelAreaSqft: number;
  areaComputed: number | null;
  /** panelAreaSqft / areaComputed: the verifiable waste-vs-geometry ratio. */
  overage: number | null;
  skipped?: string;
}
export interface NestPiece { stockFt: number; cuts: number[]; offcutFt: number }
export interface NestSummary {
  mode: "coil" | "stock";
  pieces: NestPiece[];
  stockFt: number;
  cutFt: number;
  wastePct: number;
  /** Cuts placed into an already-open piece (offcut reuse events). */
  reusedCuts: number;
  reusableOffcuts: number;
  unplaced: number[];
}
export interface TrimLine {
  profile: string;
  lineTypes: string[];
  runs: number;
  totalFt: number;
  sticks: number;
  stockFt: number;
  wastePct: number;
}
export interface TakeoffModel {
  layouts: FacetLayout[];
  panelNest: NestSummary;
  trims: TrimLine[];
  fasteners: { clips: number; clipScrews: number; trimScrews: number };
  totals: {
    panelCount: number;
    panelFt: number;
    panelAreaSqft: number;
    roofAreaComputedSqft: number;
    overage: number | null;
    skippedFacets: number;
  };
  checks: GeoCheck[];
  needsReview: boolean;
  sourceRefs: Record<string, string>;
}

export const DEFAULT_TRIM_PROFILES: Record<string, string> = {
  RIDGE: "ridge_cap",
  MONORIDGE: "ridge_cap",
  HIP: "hip_cap",
  VALLEY: "valley_pan",
  EAVE: "eave_drip",
  FASCIA: "eave_drip",
  "FASCIA-ONLY": "eave_drip",
  "GUTTER-ONLY": "gutter",
  GABLE: "gable_rake",
  "BARGE-ONLY": "gable_rake",
  "FASCIA-BARGE": "gable_rake",
  STEP: "step_flashing",
  APRON: "apron_flashing",
  "TUCK-UNDER": "tuck_under_flashing",
  "BOX-GUTTER": "box_gutter",
};

// Line types that are geometry aids or wall openings, not roof trim runs.
const NON_TRIM = /^(NONE|UNKNOWN|DRAWING|WALL|WINDOW|DOOR)/;

const EPS = 1e-6;
type V3 = [number, number, number];
type P2 = [number, number];

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const roundUpTo = (v: number, inc: number): number => Math.ceil(v / inc - EPS) * inc;

/** Sutherland-Hodgman clip of a polygon against u >= bound (keepGE) or u <= bound. */
function clipU(poly: P2[], bound: number, keepGE: boolean): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % poly.length];
    const inCur = keepGE ? cur[0] >= bound - EPS : cur[0] <= bound + EPS;
    const inNxt = keepGE ? nxt[0] >= bound - EPS : nxt[0] <= bound + EPS;
    if (inCur) out.push(cur);
    if (inCur !== inNxt) {
      const t = (bound - cur[0]) / (nxt[0] - cur[0]);
      out.push([bound, cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

/** Best-fit-decreasing nesting of cut lengths into stock lengths with offcut reuse. */
export function nestLengths(cuts: number[], stockLengthsFt: number[], minReusableOffcutFt: number): NestSummary {
  const sorted = [...cuts].sort((a, b) => b - a);
  const stocks = [...stockLengthsFt].sort((a, b) => a - b);
  const open: { stockFt: number; cuts: number[]; rem: number }[] = [];
  const unplaced: number[] = [];
  let reusedCuts = 0;
  for (const c of sorted) {
    let best = -1, bestRem = Infinity;
    for (let i = 0; i < open.length; i++) {
      if (open[i].rem >= c - EPS && open[i].rem < bestRem) { best = i; bestRem = open[i].rem; }
    }
    if (best >= 0) {
      open[best].cuts.push(c);
      open[best].rem = Math.max(0, open[best].rem - c);
      reusedCuts++;
      continue;
    }
    const stock = stocks.find((s) => s >= c - EPS);
    if (stock === undefined) { unplaced.push(c); continue; }
    open.push({ stockFt: stock, cuts: [c], rem: Math.max(0, stock - c) });
  }
  const pieces: NestPiece[] = open.map((p) => ({ stockFt: p.stockFt, cuts: p.cuts, offcutFt: round(p.rem, 4) }));
  const stockFt = pieces.reduce((s, p) => s + p.stockFt, 0);
  const cutFt = pieces.reduce((s, p) => s + p.cuts.reduce((a, c) => a + c, 0), 0);
  return {
    mode: "stock",
    pieces,
    stockFt: round(stockFt, 2),
    cutFt: round(cutFt, 2),
    wastePct: stockFt > 0 ? round(1 - cutFt / stockFt, 4) : 0,
    reusedCuts,
    reusableOffcuts: pieces.filter((p) => p.offcutFt >= minReusableOffcutFt).length,
    unplaced,
  };
}

/** Simulate laying panels and trim over verified geometry. Pure. */
export function takeoffFromGeometry(model: GeometryModel, opts: TakeoffOptions = {}): TakeoffModel {
  const o = {
    coverageWidthFt: 16 / 12,
    lengthIncrementFt: 1 / 12,
    maxPanelLengthFt: null as number | null,
    stockLengthsFt: null as number[] | null,
    minReusableOffcutFt: 2,
    trimStockFt: 10,
    trimLapFt: 0,
    trimProfiles: DEFAULT_TRIM_PROFILES,
    clipSpacingFt: 2,
    screwsPerClip: 1,
    trimScrewSpacingFt: 1.5,
    ...opts,
  };
  const points = new Map<string, GeoPoint>(model.points.map((p) => [p.id, p]));
  const lines = new Map(model.lines.map((l) => [l.id, l]));
  const checks: GeoCheck[] = [];
  const layouts: FacetLayout[] = [];

  // ---- panels: strip every roof facet in its own plane basis ----
  for (const f of model.facets) {
    if (f.type.toLowerCase() !== "roof") continue;
    const skip = (reason: string) => {
      layouts.push({ facetId: f.id, panels: [], panelAreaSqft: 0, areaComputed: f.areaComputed, overage: null, skipped: reason });
      checks.push({ check: "takeoff_facet_skipped", target: f.id, ok: false, detail: reason });
    };
    const ring = chainRing(f.lineIds, lines);
    if (!ring) { skip("ring_open"); continue; }
    const pts = ring.map((id) => points.get(id));
    if (pts.some((p) => !p)) { skip("missing_points"); continue; }
    const n = newellNormal(ring, points);
    const nLen = n ? Math.hypot(n[0], n[1], n[2]) : 0;
    if (!n || nLen < EPS) { skip("degenerate_plane"); continue; }
    const nh: V3 = [n[0] / nLen, n[1] / nLen, n[2] / nLen];
    // u = n x z-hat: horizontal AND in-plane (the eave direction). Flat facets fall back to x/y.
    const hLen = Math.hypot(nh[1], -nh[0]);
    let u: V3, d: V3;
    if (hLen < EPS) {
      u = [1, 0, 0]; d = [0, 1, 0];
    } else {
      u = [nh[1] / hLen, -nh[0] / hLen, 0];
      // d = u x n-hat: unit, in-plane, perpendicular to u; sign chosen up-slope.
      d = [u[1] * nh[2] - u[2] * nh[1], u[2] * nh[0] - u[0] * nh[2], u[0] * nh[1] - u[1] * nh[0]];
      if (d[2] < 0) d = [-d[0], -d[1], -d[2]];
    }
    const poly: P2[] = (pts as GeoPoint[]).map((p) => [
      p.x * u[0] + p.y * u[1] + p.z * u[2],
      p.x * d[0] + p.y * d[1] + p.z * d[2],
    ]);
    let uMin = Infinity, uMax = -Infinity;
    for (const [pu] of poly) { uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu); }
    const strips = Math.max(1, Math.ceil((uMax - uMin) / o.coverageWidthFt - EPS));
    const panels: PanelCut[] = [];
    for (let k = 0; k < strips; k++) {
      const a = uMin + k * o.coverageWidthFt;
      const clipped = clipU(clipU(poly, a, true), a + o.coverageWidthFt, false);
      if (clipped.length < 3) continue;
      let vMin = Infinity, vMax = -Infinity;
      for (const [, pv] of clipped) { vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv); }
      if (vMax - vMin < EPS) continue;
      const lengthFt = round(roundUpTo(vMax - vMin, o.lengthIncrementFt), 6);
      if (o.maxPanelLengthFt !== null && lengthFt > o.maxPanelLengthFt + EPS) {
        checks.push({ check: "panel_exceeds_max_length", target: `${f.id}#${k}`, ok: false,
          detail: `${lengthFt}ft > max ${o.maxPanelLengthFt}ft (splice or coil decision required)` });
      }
      panels.push({ facetId: f.id, seam: k, lengthFt, widthFt: o.coverageWidthFt });
    }
    const panelAreaSqft = panels.reduce((s, p) => s + p.lengthFt * p.widthFt, 0);
    layouts.push({
      facetId: f.id,
      panels,
      panelAreaSqft: round(panelAreaSqft, 2),
      areaComputed: f.areaComputed,
      overage: f.areaComputed ? round(panelAreaSqft / f.areaComputed, 4) : null,
    });
  }

  const allCuts = layouts.flatMap((l) => l.panels.map((p) => p.lengthFt));
  const panelFt = allCuts.reduce((s, c) => s + c, 0);
  const panelNest: NestSummary = o.stockLengthsFt
    ? nestLengths(allCuts, o.stockLengthsFt, o.minReusableOffcutFt)
    : {
      mode: "coil",
      pieces: allCuts.map((c) => ({ stockFt: c, cuts: [c], offcutFt: 0 })),
      stockFt: round(panelFt, 2), cutFt: round(panelFt, 2), wastePct: 0,
      reusedCuts: 0, reusableOffcuts: 0, unplaced: [],
    };
  for (const c of panelNest.unplaced) {
    checks.push({ check: "nest_unplaced_cut", target: "panels", ok: false, detail: `${c}ft cut fits no stock length` });
  }

  // ---- trims: computed-length runs grouped by profile, split into sticks ----
  const byProfile = new Map<string, { lineTypes: Set<string>; runs: number[] }>();
  for (const l of lines.values()) {
    if (NON_TRIM.test(l.type)) continue;
    const len = l.lengthComputed ?? l.lengthDeclared;
    if (len === null || len < EPS) continue;
    const profile = o.trimProfiles[l.type] ?? l.type.toLowerCase();
    const agg = byProfile.get(profile) ?? { lineTypes: new Set<string>(), runs: [] };
    agg.lineTypes.add(l.type);
    agg.runs.push(len);
    byProfile.set(profile, agg);
  }
  const trims: TrimLine[] = [...byProfile.entries()].map(([profile, { lineTypes, runs }]) => {
    const usable = o.trimStockFt - o.trimLapFt;
    let fullSticks = 0;
    const tails: number[] = [];
    for (let rem of runs) {
      while (rem > o.trimStockFt + EPS) { fullSticks++; rem -= usable; }
      tails.push(rem);
    }
    const tailNest = nestLengths(tails, [o.trimStockFt], o.minReusableOffcutFt);
    const sticks = fullSticks + tailNest.pieces.length;
    const totalFt = runs.reduce((s, r) => s + r, 0);
    const stockFt = sticks * o.trimStockFt;
    return {
      profile,
      lineTypes: [...lineTypes].sort(),
      runs: runs.length,
      totalFt: round(totalFt, 2),
      sticks,
      stockFt: round(stockFt, 2),
      wastePct: stockFt > 0 ? round(1 - totalFt / stockFt, 4) : 0,
    };
  }).sort((a, b) => a.profile.localeCompare(b.profile));

  // ---- fasteners from seams and trim runs ----
  const clips = layouts.reduce(
    (s, l) => s + l.panels.reduce((c, p) => c + Math.ceil(p.lengthFt / o.clipSpacingFt - EPS) + 1, 0), 0);
  const trimScrews = trims.reduce((s, t) => s + Math.ceil(t.totalFt / o.trimScrewSpacingFt - EPS), 0);

  const laidOut = layouts.filter((l) => !l.skipped);
  const roofAreaComputedSqft = laidOut.reduce((s, l) => s + (l.areaComputed ?? 0), 0);
  const panelAreaSqft = laidOut.reduce((s, l) => s + l.panelAreaSqft, 0);

  const sourceRefs: Record<string, string> = {
    panel_count: `strips(coverage=${round(o.coverageWidthFt, 4)}ft) over ${laidOut.length} roof facet rings`,
    panel_total_ft: `sum(strip v-extent rounded up to ${round(o.lengthIncrementFt, 4)}ft)`,
    panel_area_sqft: "sum(panel length x coverage width)",
    roof_area_computed_sqft: `sum(newell(ring)) over ${laidOut.length} facets`,
    clips: `ceil(length/${o.clipSpacingFt}ft)+1 per seam`,
    trim_screws: `ceil(profile total/${o.trimScrewSpacingFt}ft)`,
  };
  for (const t of trims) sourceRefs[`trim_${t.profile}_ft`] = `LINE[type in ${t.lineTypes.join("|")}] sum(computed length) over ${t.runs} runs`;

  return {
    layouts,
    panelNest,
    trims,
    fasteners: { clips, clipScrews: clips * o.screwsPerClip, trimScrews },
    totals: {
      panelCount: allCuts.length,
      panelFt: round(panelFt, 2),
      panelAreaSqft: round(panelAreaSqft, 2),
      roofAreaComputedSqft: round(roofAreaComputedSqft, 2),
      overage: roofAreaComputedSqft > 0 ? round(panelAreaSqft / roofAreaComputedSqft, 4) : null,
      skippedFacets: layouts.length - laidOut.length,
    },
    checks,
    // Unverified geometry never silently becomes an order.
    needsReview: model.needsReview || checks.some((c) => !c.ok),
    sourceRefs,
  };
}
