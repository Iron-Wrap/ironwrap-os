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
// parsed directly). ESX (Xactimate) is a zip wrapper around XML: unzip upstream
// and feed the XML here; no zip support in v1.

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
export interface GeoFacet {
  id: string;
  lineIds: string[];
  areaDeclared: number | null;
  areaComputed: number | null;
  deviation: number | null; // relative, vs declared
  pitch: number | null;
  orientation: number | null;
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

const LENGTH_TOLERANCE = 0.02; // 2% relative
const AREA_TOLERANCE = 0.03;   // 3% relative

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

/** Chain unordered ring lines into an ordered 3D vertex loop; null if the ring does not close. */
export function chainRing(lineIds: string[], lines: Map<string, GeoLine>): string[] | null {
  const remaining = lineIds.map((id) => lines.get(id)).filter((l): l is GeoLine => !!l);
  if (remaining.length !== lineIds.length || remaining.length < 3) return null;
  const first = remaining.shift()!;
  const ring = [first.from, first.to];
  while (remaining.length) {
    const cur = ring[ring.length - 1];
    const idx = remaining.findIndex((l) => l.from === cur || l.to === cur);
    if (idx === -1) return null;
    const [next] = remaining.splice(idx, 1);
    ring.push(next.from === cur ? next.to : next.from);
  }
  // Closed ring: the walk must return to the start.
  if (ring[0] !== ring[ring.length - 1]) return null;
  return ring.slice(0, -1);
}

/** True 3D planar polygon area via Newell's method (works at any pitch/orientation). */
export function newellArea(ring: string[], points: Map<string, GeoPoint>): number | null {
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
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
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
    const ring = chainRing(lineIds, lines);
    const areaComputed = ring ? newellArea(ring, points) : null;
    const areaDeclared = num(a.size);
    facets.push({
      id: a.id ?? `P${facets.length + 1}`,
      lineIds,
      areaDeclared, areaComputed,
      deviation: relDev(areaDeclared, areaComputed),
      pitch: num(a.pitch),
      orientation: num(a.orientation),
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
    if (l.deviation !== null && l.deviation > LENGTH_TOLERANCE) {
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
    } else if (f.deviation !== null && f.deviation > AREA_TOLERANCE) {
      checks.push({ check: "facet_area_recompute", target: f.id, ok: false,
        detail: `declared ${f.areaDeclared} sf vs computed ${f.areaComputed?.toFixed(2)} sf (${(f.deviation * 100).toFixed(1)}%)` });
    }
  }

  // ---- pipeline-compatible metric map with source refs ----
  const measurements: Record<string, number> = {};
  const sourceRefs: Record<string, string> = {};
  const roofFacets = facets.filter((f) => f.type.toLowerCase() === "roof");
  if (roofFacets.length) {
    const total = roofFacets.reduce((s, f) => s + (f.areaDeclared ?? 0), 0);
    measurements.roof_area = Math.round(total * 100) / 100;
    sourceRefs.roof_area = `POLYGON[type=Roof] sum(size) over ${roofFacets.length} facets`;
    measurements.facet_count = roofFacets.length;
    sourceRefs.facet_count = "count(POLYGON[type=Roof])";
    const pitches = [...new Set(roofFacets.map((f) => f.pitch).filter((p): p is number => p !== null))];
    if (pitches.length === 1) {
      measurements.pitch = pitches[0];
      sourceRefs.pitch = "POLYGON[type=Roof] uniform pitch";
    }
  }
  const byType = new Map<string, { total: number; count: number }>();
  for (const l of lines.values()) {
    if (l.lengthDeclared === null) continue;
    const t = byType.get(l.type) ?? { total: 0, count: 0 };
    t.total += l.lengthDeclared; t.count++;
    byType.set(l.type, t);
  }
  for (const [type, { total, count }] of byType) {
    const key = `${type.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_length`;
    measurements[key] = Math.round(total * 100) / 100;
    sourceRefs[key] = `LINE[type=${type}] sum(length) over ${count} lines`;
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
