// Canonical, evidence-first roof geometry derived from a verified source export.

import type { GeoCheck, GeoFacet, GeoLine, GeoPoint, GeometryModel } from "./geometry.ts";

export const ROOF_GRAPH_SCHEMA_VERSION = "roof_graph/v1" as const;

export interface RoofGraphV1 {
  schema_version: typeof ROOF_GRAPH_SCHEMA_VERSION;
  /** Immutable revision of the raw source artifact, not a human approval revision. */
  revision: string;
  source: {
    raw_key: string;
    raw_sha256: string;
    provider: string;
    ingested_at: string;
    capture: {
      captured_at: null;
      provenance: "not_supplied";
    };
  };
  coordinate_system: {
    kind: "local_3d";
    crs: null;
    transform: null;
    provenance: "not_declared_by_source";
  };
  points: GeoPoint[];
  edges: GeoLine[];
  facets: GeoFacet[];
  checks: GeoCheck[];
  needs_review: boolean;
  measurements: Record<string, number>;
  source_refs: Record<string, string>;
}

/**
 * Preserve the parser's exact source-derived model.  Unknown capture/CRS values
 * remain explicit nulls so later capture systems cannot be mistaken for verified input.
 */
export function deriveRoofGraph(input: {
  geometry: GeometryModel;
  rawKey: string;
  rawSha256: string;
  provider: string;
  ingestedAt: string;
}): RoofGraphV1 {
  return {
    schema_version: ROOF_GRAPH_SCHEMA_VERSION,
    revision: input.rawSha256,
    source: {
      raw_key: input.rawKey,
      raw_sha256: input.rawSha256,
      provider: input.provider,
      ingested_at: input.ingestedAt,
      capture: { captured_at: null, provenance: "not_supplied" },
    },
    coordinate_system: {
      kind: "local_3d",
      crs: null,
      transform: null,
      provenance: "not_declared_by_source",
    },
    points: input.geometry.points,
    edges: input.geometry.lines,
    facets: input.geometry.facets,
    checks: input.geometry.checks,
    needs_review: input.geometry.needsReview,
    measurements: input.geometry.measurements,
    source_refs: input.geometry.sourceRefs,
  };
}
