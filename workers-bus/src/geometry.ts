// geometry.ts - first-principles roof geometry engine for AppliCad XML exports.
//
// The format is points in space, lines between points (typed RIDGE/FASCIA/GABLE/
// VALLEY/HIP/EAVE/STEP/TUCK-UNDER), and facets as rings of lines with declared
// sizes. Because coordinates carry z, every declared number is RECOMPUTABLE:
// line lengths from 3D distance, facet areas from the ordered ring via Newell's
// method. That recomputation IS the verification system: any deviation beyond
// tolerance flags needs_review instead of silently trusting the export. This is
// what lets the takeoff pipeline bypass AppliCad-the-application: the geometry
// truth is in the file, not the vendor UI.
//
// Pure, zero-dep, Workers-safe (no DOMParser; the flat attribute grammar is
// parsed directly). ESX (Xactimate) is a zip wrapper around XML: esx.ts opens
// the wrapper and routes any recognized XML payload here.

export interface GeoPoint { id: string; x: number; y: number; z: number }
export interface GeoLine {
  id: string;
  from: string;
  to: string;
  type: string;
  lengthDeclared: number | null;
  lengthComputed: number | null;
  deviation: number | null; // relative, vs declared
}
export type GeoTopologyIssue =
  | "missing_edge"
  | "duplicate_edge"
  | "degenerate_edge"
  | "open"
  | "branching"
  | "disconnected";
export interface GeoContour {
  role: "outer" | "hole";
  lineIds: string[];
  pointIds: string[] | null;
  topologyIssues: GeoTopologyIssue[];
}
export interface GeoFacet {
  id: string;
  lineIds: string[];
  /** Closed representation: AppliCad v1 supplies one outer contour and no identifiable holes. */
  contours: { outer: GeoContour; holes: GeoContour[] };
  areaDeclared: number | null;
  areaComputed: number | null;
  deviation: number | null; // relative, vs declared
  /** Source-declared pitch/orientation remain comparison evidence. */
  pitch: number | null;
  orientation: number | null;
  pitchComputed: number | null;
  orientationComputed: number | null;
  planarityResidual: number | null;
  material: string | null;
  type: string;
  ringClosed: boolean;
}
export interface GeoCheck { check: string; target: string; ok: boolean; detail: string }
export interface GeometryModel {
  points: GeoPoint[];
  lines: GeoLine[];
  facets: GeoFacet[];
  checks: GeoCheck[];
  needsReview: boolean;
  /** Flat pipeline-compatible metric map (roof_area, ridge_length, ...). */
  measurements: Record<string, number>;
  /** metric -> where it came from in the file (evidence-graph source refs). */
  sourceRefs: Record<string, string>;
}

/**
 * Conservative v1 verification limits. These are fixed for deterministic
 * replay and intentionally not tenant-tunable. Calibrate against approved
 * real-job exports before changing them; a tolerance change is a contract change.
 */
export const GEOMETRY_TOLERANCES = Object.freeze({
  lengthRelative: 0.02,
  areaRelative: 0.03,
  planarityResidualFt: 1 / 96, // 1/8 inch
  pitchPer12: 0.1,
  orientationDegrees: 1,
  numericEpsilon: 1e-8,
});

/** Parse `key="value"` attributes, tolerant of spaces around `=` (AppliCad emits `size = "..."`). */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function relDev(declared: number | null, computed: number | null): number | null {
  if (declared === null || computed === null) return null;
  if (declared === 0) return computed === 0 ? 0 : 1;
  return Math.abs(declared - computed) / Math.abs(declared);
}

function analyzeContour(
  role: GeoContour["role"],
  lineIds: string[],
  lines: Map<string, GeoLine>,
): GeoContour {
  const issues = new Set<GeoTopologyIssue>();
  const seenIds = new Set<string>();
  const seenEndpoints = new Set<string>();
  const edges: GeoLine[] = [];

  for (const id of lineIds) {
    if (seenIds.has(id)) {
      issues.add("duplicate_edge");
      continue;
    }
    seenIds.add(id);
    const line = lines.get(id);
    if (!line) {
      issues.add("missing_edge");
      continue;
    }
    if (line.from === line.to) {
      issues.add("degenerate_edge");
      continue;
    }
    const endpointKey = [line.from, line.to].sort().join("\u0000");
    if (seenEndpoints.has(endpointKey)) {
      issues.add("duplicate_edge");
      continue;
    }
    seenEndpoints.add(endpointKey);
    edges.push(line);
  }

  const adjacency = new Map<string, Array<{ edgeId: string; other: string }>>();
  for (const line of edges) {
    const from = adjacency.get(line.from) ?? [];
    from.push({ edgeId: line.id, other: line.to });
    adjacency.set(line.from, from);
    const to = adjacency.get(line.to) ?? [];
    to.push({ edgeId: line.id, other: line.from });
    adjacency.set(line.to, to);
  }
  if (edges.length < 3 || [...adjacency.values()].some((neighbors) => neighbors.length < 2)) {
    issues.add("open");
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.length > 2)) {
    issues.add("branching");
  }

  if (adjacency.size) {
    const start = [...adjacency.keys()].sort()[0];
    const visited = new Set([start]);
    const pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      for (const { other } of adjacency.get(current) ?? []) {
        if (visited.has(other)) continue;
        visited.add(other);
        pending.push(other);
      }
    }
    if (visited.size !== adjacency.size) issues.add("disconnected");
  }

  let pointIds: string[] | null = null;
  if (issues.size === 0) {
    const start = [...adjacency.keys()].sort()[0];
    const used = new Set<string>();
    const ordered = [start];
    let current = start;
    while (used.size < edges.length) {
      const next = [...(adjacency.get(current) ?? [])]
        .filter(({ edgeId }) => !used.has(edgeId))
        .sort((left, right) => left.edgeId.localeCompare(right.edgeId))[0];
      if (!next) break;
      used.add(next.edgeId);
      current = next.other;
      if (current !== start) ordered.push(current);
    }
    if (used.size === edges.length && current === start && ordered.length === edges.length) {
      pointIds = ordered;
    } else {
      issues.add("open");
    }
  }

  return { role, lineIds: [...lineIds], pointIds, topologyIssues: [...issues] };
}

/** Chain only a single, connected, non-branching cycle; ambiguous topology returns null. */
export function chainRing(lineIds: string[], lines: Map<string, GeoLine>): string[] | null {
  return analyzeContour("outer", lineIds, lines).pointIds;
}

/** Unnormalized Newell plane normal of an ordered 3D ring; null on missing points. */
export function newellNormal(ring: string[], points: Map<string, GeoPoint>): [number, number, number] | null {
  if (ring.length < 3) return null;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = points.get(ring[i]);
    const b = points.get(ring[(i + 1) % ring.length]);
    if (!a || !b) return null;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return [nx, ny, nz];
}

/** True 3D planar polygon area via Newell's method (works at any pitch/orientation). */
export function newellArea(ring: string[], points: Map<string, GeoPoint>): number | null {
  const n = newellNormal(ring, points);
  return n ? Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) / 2 : null;
}

interface FacetDerivation {
  pitch: number | null;
  orientation: number | null;
  planarityResidual: number | null;
}

function deriveFacetPlane(ring: string[], points: Map<string, GeoPoint>): FacetDerivation {
  const vertices = ring.map((id) => points.get(id));
  if (vertices.some((point) => !point)) {
    return { pitch: null, orientation: null, planarityResidual: null };
  }
  const normal = newellNormal(ring, points);
  const magnitude = normal ? Math.hypot(...normal) : 0;
  if (!normal || magnitude <= GEOMETRY_TOLERANCES.numericEpsilon) {
    return { pitch: null, orientation: null, planarityResidual: null };
  }
  let [nx, ny, nz] = normal.map((value) => value / magnitude) as [number, number, number];
  if (nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
  const concrete = vertices as GeoPoint[];
  const centroid = concrete.reduce(
    (sum, point) => [sum[0] + point.x, sum[1] + point.y, sum[2] + point.z],
    [0, 0, 0],
  ).map((value) => value / concrete.length) as [number, number, number];
  const planarityResidual = concrete.reduce((max, point) => Math.max(
    max,
    Math.abs(
      nx * (point.x - centroid[0]) +
      ny * (point.y - centroid[1]) +
      nz * (point.z - centroid[2]),
    ),
  ), 0);
  const horizontal = Math.hypot(nx, ny);
  return {
    pitch: Math.abs(nz) > GEOMETRY_TOLERANCES.numericEpsilon
      ? 12 * horizontal / Math.abs(nz)
      : null,
    // AppliCad orientation is the compass bearing of the downhill normal:
    // north=0, east=90, south=180, west=270.
    orientation: horizontal > GEOMETRY_TOLERANCES.numericEpsilon
      ? (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360
      : null,
    planarityResidual,
  };
}

type Point2 = [number, number];

function projectedRing(ring: string[], points: Map<string, GeoPoint>): Point2[] | null {
  const vertices = ring.map((id) => points.get(id));
  if (vertices.some((point) => !point)) return null;
  const concrete = vertices as GeoPoint[];
  const normal = newellNormal(ring, points);
  const magnitude = normal ? Math.hypot(...normal) : 0;
  let drop: 0 | 1 | 2;
  if (normal && magnitude > GEOMETRY_TOLERANCES.numericEpsilon) {
    const absolute = normal.map(Math.abs);
    drop = absolute[0] >= absolute[1] && absolute[0] >= absolute[2]
      ? 0
      : absolute[1] >= absolute[2] ? 1 : 2;
  } else {
    const ranges = (["x", "y", "z"] as const).map((axis) => {
      const values = concrete.map((point) => point[axis]);
      return Math.max(...values) - Math.min(...values);
    });
    drop = ranges[0] <= ranges[1] && ranges[0] <= ranges[2]
      ? 0
      : ranges[1] <= ranges[2] ? 1 : 2;
  }
  return concrete.map((point) => drop === 0
    ? [point.y, point.z]
    : drop === 1 ? [point.x, point.z] : [point.x, point.y]);
}

function cross2(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Point2, b: Point2, point: Point2): boolean {
  const epsilon = GEOMETRY_TOLERANCES.numericEpsilon;
  return Math.abs(cross2(a, b, point)) <= epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const epsilon = GEOMETRY_TOLERANCES.numericEpsilon;
  const abC = cross2(a, b, c), abD = cross2(a, b, d);
  const cdA = cross2(c, d, a), cdB = cross2(c, d, b);
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
      ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function hasSelfIntersection(ring: string[], points: Map<string, GeoPoint>): boolean {
  const projected = projectedRing(ring, points);
  if (!projected) return false;
  // ponytail: O(n²) is the simplest exact check for roof contours; replace with
  // a sweep-line algorithm only if measured imports contain thousands of edges.
  for (let left = 0; left < projected.length; left++) {
    const leftNext = (left + 1) % projected.length;
    for (let right = left + 1; right < projected.length; right++) {
      const rightNext = (right + 1) % projected.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(projected[left], projected[leftNext], projected[right], projected[rightNext])) {
        return true;
      }
    }
  }
  return false;
}

function angularDifference(left: number, right: number): number {
  const normalized = Math.abs(((left - right) % 360 + 360) % 360);
  return Math.min(normalized, 360 - normalized);
}

/** Detect an AppliCad geometry export. Pure. */
export function isAppliCadXml(text: string): boolean {
  return text.includes("<APPLICAD_EXPORT");
}

/** Parse + verify an AppliCad XML export from first principles. Returns null if not parseable. */
export function parseAppliCadGeometry(xml: string): GeometryModel | null {
  if (!isAppliCadXml(xml)) return null;

  const points = new Map<string, GeoPoint>();
  for (const m of xml.matchAll(/<POINT\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    const [x, y, z] = (a.data ?? "").split(",").map(parseFloat);
    if (a.id && [x, y, z].every(Number.isFinite)) points.set(a.id, { id: a.id, x, y, z });
  }

  const lines = new Map<string, GeoLine>();
  for (const m of xml.matchAll(/<LINE\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    const [from, to] = (a.path ?? "").split(",").map((s) => s.trim());
    if (!a.id || !from || !to) continue;
    const p1 = points.get(from), p2 = points.get(to);
    const lengthComputed = p1 && p2
      ? Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2)
      : null;
    const lengthDeclared = num(a.length);
    lines.set(a.id, {
      id: a.id, from, to,
      type: (a.type ?? "UNKNOWN").toUpperCase(),
      lengthDeclared, lengthComputed,
      deviation: relDev(lengthDeclared, lengthComputed),
    });
  }

  const facets: GeoFacet[] = [];
  for (const m of xml.matchAll(/<POLYGON\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    const lineIds = (a.path ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const outer = analyzeContour("outer", lineIds, lines);
    const ring = outer.pointIds;
    const areaComputed = ring ? newellArea(ring, points) : null;
    const areaDeclared = num(a.size);
    const plane = ring
      ? deriveFacetPlane(ring, points)
      : { pitch: null, orientation: null, planarityResidual: null };
    facets.push({
      id: a.id ?? `P${facets.length + 1}`,
      lineIds,
      contours: { outer, holes: [] },
      areaDeclared, areaComputed,
      deviation: relDev(areaDeclared, areaComputed),
      pitch: num(a.pitch),
      orientation: num(a.orientation),
      pitchComputed: plane.pitch,
      orientationComputed: plane.orientation,
      planarityResidual: plane.planarityResidual,
      material: a.mat ?? null,
      type: a.type ?? "Roof",
      ringClosed: ring !== null,
    });
  }

  // A real export always carries points and lines; refuse degenerate parses
  // (e.g. the marker appearing inside an escaped/JSON-encoded string).
  if (points.size === 0 || lines.size === 0) return null;

  // ---- verification: every declared number is cross-checked ----
  const checks: GeoCheck[] = [];
  for (const l of lines.values()) {
    if (!points.has(l.from) || !points.has(l.to)) {
      checks.push({ check: "line_point_refs", target: l.id, ok: false, detail: `missing endpoint ${!points.has(l.from) ? l.from : l.to}` });
    }
    if (l.deviation !== null && l.deviation > GEOMETRY_TOLERANCES.lengthRelative) {
      checks.push({ check: "line_length_recompute", target: l.id, ok: false,
        detail: `declared ${l.lengthDeclared} vs computed ${l.lengthComputed?.toFixed(4)} (${(l.deviation * 100).toFixed(1)}%)` });
    }
  }
  for (const f of facets) {
    for (const id of f.lineIds) {
      if (!lines.has(id)) checks.push({ check: "facet_line_refs", target: f.id, ok: false, detail: `missing line ${id}` });
    }
    if (!f.ringClosed) {
      checks.push({ check: "facet_ring_closure", target: f.id, ok: false, detail: "perimeter lines do not close a ring" });
    }
    for (const issue of f.contours.outer.topologyIssues) {
      const check = issue === "duplicate_edge"
        ? "facet_topology_duplicate"
        : issue === "branching"
          ? "facet_topology_branching"
          : issue === "open"
            ? "facet_topology_open"
            : issue === "disconnected"
              ? "facet_topology_disconnected"
              : issue === "degenerate_edge"
                ? "facet_topology_degenerate"
                : "facet_topology_missing_edge";
      checks.push({ check, target: f.id, ok: false, detail: `${issue} outer contour` });
    }
    if (f.ringClosed && f.deviation !== null && f.deviation > GEOMETRY_TOLERANCES.areaRelative) {
      checks.push({ check: "facet_area_recompute", target: f.id, ok: false,
        detail: `declared ${f.areaDeclared} sf vs computed ${f.areaComputed?.toFixed(2)} sf (${(f.deviation * 100).toFixed(1)}%)` });
    }
    const ring = f.contours.outer.pointIds;
    if (ring && hasSelfIntersection(ring, points)) {
      checks.push({ check: "facet_self_intersection", target: f.id, ok: false,
        detail: "outer contour has intersecting non-adjacent edges" });
    }
    if (ring && f.planarityResidual === null) {
      checks.push({ check: "facet_plane_degenerate", target: f.id, ok: false,
        detail: "cannot derive a stable plane normal" });
    } else if (
      f.planarityResidual !== null &&
      f.planarityResidual > GEOMETRY_TOLERANCES.planarityResidualFt
    ) {
      checks.push({ check: "facet_planarity", target: f.id, ok: false,
        detail: `max residual ${f.planarityResidual.toFixed(6)}ft exceeds ${GEOMETRY_TOLERANCES.planarityResidualFt.toFixed(6)}ft` });
    }
    if (f.pitch !== null) {
      if (f.pitchComputed === null) {
        checks.push({ check: "facet_pitch_recompute", target: f.id, ok: false,
          detail: `declared ${f.pitch}/12 but a normal-derived pitch is unavailable` });
      } else if (Math.abs(f.pitch - f.pitchComputed) > GEOMETRY_TOLERANCES.pitchPer12) {
        checks.push({ check: "facet_pitch_recompute", target: f.id, ok: false,
          detail: `declared ${f.pitch}/12 vs computed ${f.pitchComputed.toFixed(4)}/12` });
      }
    }
    if (
      f.orientation !== null &&
      f.orientationComputed !== null &&
      angularDifference(f.orientation, f.orientationComputed) > GEOMETRY_TOLERANCES.orientationDegrees
    ) {
      checks.push({ check: "facet_orientation_recompute", target: f.id, ok: false,
        detail: `declared ${f.orientation}deg vs computed ${f.orientationComputed.toFixed(4)}deg` });
    }
  }

  // ---- pipeline-compatible metric map with source refs ----
  const measurements: Record<string, number> = {};
  const sourceRefs: Record<string, string> = {};
  const roofFacets = facets.filter((f) => f.type.toLowerCase() === "roof");
  if (roofFacets.length && roofFacets.every((facet) => facet.areaComputed !== null)) {
    const total = roofFacets.reduce((sum, facet) => sum + facet.areaComputed!, 0);
    measurements.roof_area = Math.round(total * 100) / 100;
    sourceRefs.roof_area = `sum(Newell outer contour area) over ${roofFacets.length} POLYGON[type=Roof] facets`;
  }
  if (roofFacets.length) {
    measurements.facet_count = roofFacets.length;
    sourceRefs.facet_count = "count(POLYGON[type=Roof])";
    const pitches = roofFacets.map((facet) => facet.pitchComputed);
    if (pitches.every((pitch): pitch is number => pitch !== null)) {
      const min = Math.min(...pitches), max = Math.max(...pitches);
      if (max - min <= GEOMETRY_TOLERANCES.pitchPer12) {
        measurements.pitch = Math.round((pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length) * 100) / 100;
        sourceRefs.pitch = `mean(normal-derived rise/run x 12) over ${roofFacets.length} uniform roof facets`;
      }
    }
  }
  const byType = new Map<string, { total: number; count: number; complete: boolean }>();
  for (const l of lines.values()) {
    const t = byType.get(l.type) ?? { total: 0, count: 0, complete: true };
    t.count++;
    if (l.lengthComputed === null) t.complete = false;
    else t.total += l.lengthComputed;
    byType.set(l.type, t);
  }
  for (const [type, { total, count, complete }] of byType) {
    if (!complete) continue;
    const key = `${type.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_length`;
    measurements[key] = Math.round(total * 100) / 100;
    sourceRefs[key] = `sum(distance(POINT[from], POINT[to])) over ${count} LINE[type=${type}] edges`;
  }
  const vol = xml.match(/<VOLUME\s+([^>]*?)\/>/);
  if (vol) {
    const v = num(attrs(vol[1]).vol);
    if (v !== null) { measurements.volume_cuft = v; sourceRefs.volume_cuft = "VOLUME[vol]"; }
  }

  return {
    points: [...points.values()],
    lines: [...lines.values()],
    facets,
    checks,
    needsReview: checks.some((c) => !c.ok),
    measurements,
    sourceRefs,
  };
}
