import { useState } from "react";
import { Ruler } from "lucide-react";

import { cn } from "../lib/cn";
import type { EstimatorWorkbenchResponse } from "./estimator-contracts";

type RoofGraph = NonNullable<
  NonNullable<EstimatorWorkbenchResponse["measurements"]["selected"]>["roof_graph"]
>;
type RoofGraphPoint = RoofGraph["points"][number];
type RoofGraphFacet = RoofGraph["facets"][number];

type RenderableFacet = {
  facet: RoofGraphFacet;
  path: string;
};

type RenderableGraph = {
  edges: Array<{ id: string; start: RoofGraphPoint; end: RoofGraphPoint }>;
  facets: RenderableFacet[];
  viewBox: string;
  strokeWidth: number;
};

export function RoofGraphEvidence({
  roofGraph,
  locale,
}: {
  roofGraph: RoofGraph | null;
  locale: string;
}) {
  const preferredFacet = roofGraph?.facets.find((facet) => facet.review_status === "Needs Review");
  const [selectedFacetId, setSelectedFacetId] = useState<string | null>(
    preferredFacet?.id ?? roofGraph?.facets[0]?.id ?? null,
  );

  if (!roofGraph) return null;

  const graph = createRenderableGraph(roofGraph);
  const selectedFacet =
    graph?.facets.find(({ facet }) => facet.id === selectedFacetId) ?? graph?.facets[0] ?? null;
  const graphState = graphStateMeta(roofGraph.state);

  return (
    <section
      className="rounded-xl border border-border bg-surface"
      aria-labelledby="roof-graph-heading"
    >
      <div className="px-5 py-6 sm:px-6 sm:py-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2
              id="roof-graph-heading"
              className="flex items-center gap-2 text-xl font-black tracking-[-0.025em] text-foreground sm:text-2xl"
            >
              <Ruler className="size-5 text-accent" aria-hidden="true" />
              Roof graph evidence
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
              A read-only 2D view of the returned roof geometry. Select a facet to inspect its
              source state.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end" aria-label="Roof graph status">
            <GraphChip label={graphState.label} tone={graphState.tone} />
            <GraphChip label={roofGraph.review_status} tone={reviewTone(roofGraph.review_status)} />
          </div>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
            {graph && roofGraph.state !== "unavailable" ? (
              <figure>
                <svg
                  viewBox={graph.viewBox}
                  role="group"
                  aria-labelledby="roof-graph-svg-title"
                  aria-describedby="roof-graph-svg-description"
                  className="aspect-[16/10] w-full bg-surface-muted/45 p-4 sm:p-6"
                >
                  <title id="roof-graph-svg-title">Roof graph evidence</title>
                  <desc id="roof-graph-svg-description">
                    Source-derived roof facets. Selecting a facet only changes the evidence focus.
                  </desc>
                  <g aria-hidden="true">
                    {graph.edges.map((edge) => (
                      <line
                        key={edge.id}
                        x1={edge.start.x}
                        y1={edge.start.y}
                        x2={edge.end.x}
                        y2={edge.end.y}
                        stroke="var(--border)"
                        strokeWidth={graph.strokeWidth}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                  <g>
                    {graph.facets.map(({ facet, path }) => {
                      const selected = facet.id === selectedFacet?.facet.id;
                      const paint = facetPaint(facet.review_status);
                      return (
                        <path
                          key={facet.id}
                          d={path}
                          role="button"
                          tabIndex={0}
                          aria-label={`Select facet ${facet.label ?? facet.id}, ${facet.review_status}`}
                          aria-pressed={selected}
                          fill={paint.fill}
                          fillOpacity={selected ? 0.9 : 0.55}
                          stroke={selected ? "var(--foreground)" : paint.stroke}
                          strokeWidth={selected ? graph.strokeWidth * 1.75 : graph.strokeWidth}
                          vectorEffect="non-scaling-stroke"
                          className="cursor-pointer outline-none focus-visible:stroke-foreground"
                          onClick={() => setSelectedFacetId(facet.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedFacetId(facet.id);
                            }
                          }}
                        />
                      );
                    })}
                  </g>
                </svg>
                <figcaption className="border-t border-border px-4 py-3 text-xs leading-5 text-muted">
                  Facet outlines are derived from the returned graph. They are not a field-verified
                  roof plan.
                </figcaption>
              </figure>
            ) : (
              <div className="flex min-h-56 flex-col justify-center px-5 py-6">
                <p className="font-bold text-foreground">No renderable roof graph</p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
                  The returned source did not include complete, reviewable facet geometry.
                </p>
              </div>
            )}
          </div>

          <dl className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-2 xl:grid-cols-1">
            <GraphFact label="Source" value={roofGraph.source ?? "Not recorded"} />
            <GraphFact label="Revision" value={roofGraph.revision ?? "Not recorded"} bordered />
            <GraphFact label="Provider" value={roofGraph.provider ?? "Not recorded"} bordered />
            <GraphFact
              label="Confidence"
              value={formatConfidence(roofGraph.confidence, locale)}
              bordered
            />
            <GraphFact
              label="Captured"
              value={formatDate(roofGraph.captured_at, locale) ?? "Not recorded"}
              bordered
            />
            <GraphFact label="Units" value={roofGraph.units ?? "Not recorded"} bordered />
          </dl>
        </div>

        <dl className="mt-5 grid overflow-hidden rounded-lg border border-border sm:grid-cols-3">
          <GraphFact label="Facets" value={String(roofGraph.facets.length)} />
          <GraphFact label="Graph checks" value={String(roofGraph.check_count)} bordered />
          <GraphFact
            label="Failed checks"
            value={String(roofGraph.failed_check_count)}
            bordered
            danger={roofGraph.failed_check_count > 0}
          />
        </dl>

        {selectedFacet ? (
          <section
            className="mt-5 rounded-lg border border-border bg-surface-raised px-4 py-4"
            aria-live="polite"
            aria-labelledby="selected-roof-facet-heading"
          >
            <p id="selected-roof-facet-heading" className="text-sm font-black text-foreground">
              Selected facet: {selectedFacet.facet.label ?? selectedFacet.facet.id}
            </p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <GraphDetail label="Facet ID" value={selectedFacet.facet.id} />
              <GraphDetail label="Review" value={selectedFacet.facet.review_status} />
              <GraphDetail
                label="Confidence"
                value={formatConfidence(selectedFacet.facet.confidence, locale)}
              />
            </dl>
          </section>
        ) : null}

        <p className="mt-5 border-l-2 border-warning bg-warning-soft/40 px-4 py-3 text-sm leading-6 text-foreground">
          Graph evidence is a transcription of the captured source model. It is not field
          verification and does not confirm site dimensions, material condition, access, or final
          scope.
        </p>
      </div>
    </section>
  );
}

function createRenderableGraph(roofGraph: RoofGraph): RenderableGraph | null {
  if (roofGraph.points.length === 0) return null;

  const pointById = new Map(roofGraph.points.map((point) => [point.id, point]));
  const minX = Math.min(...roofGraph.points.map((point) => point.x));
  const maxX = Math.max(...roofGraph.points.map((point) => point.x));
  const minY = Math.min(...roofGraph.points.map((point) => point.y));
  const maxY = Math.max(...roofGraph.points.map((point) => point.y));
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const padding = span * 0.08;

  const edges = roofGraph.edges.flatMap((edge) => {
    const start = pointById.get(edge.start_point_id);
    const end = pointById.get(edge.end_point_id);
    return start && end ? [{ id: edge.id, start, end }] : [];
  });
  const facets = roofGraph.facets.flatMap((facet) => {
    const points = facet.point_ids.map((id) => pointById.get(id));
    if (points.some((point) => !point)) return [];
    const outline = points as RoofGraphPoint[];
    return outline.length >= 3
      ? [
          {
            facet,
            path: `M ${outline.map(({ x, y }) => `${x} ${y}`).join(" L ")} Z`,
          },
        ]
      : [];
  });

  if (facets.length === 0) return null;

  return {
    edges,
    facets,
    viewBox: `${minX - padding} ${minY - padding} ${maxX - minX + padding * 2} ${maxY - minY + padding * 2}`,
    strokeWidth: span * 0.006,
  };
}

function GraphChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={cn("inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold", tone)}
    >
      {label}
    </span>
  );
}

function GraphFact({
  label,
  value,
  bordered = false,
  danger = false,
}: {
  label: string;
  value: string;
  bordered?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-3 py-3 sm:px-4 lg:py-2",
        bordered && "border-l border-border lg:border-l-0 lg:border-t",
      )}
    >
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-lg font-black tabular-nums",
          danger ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function GraphDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function graphStateMeta(state: RoofGraph["state"]): { label: string; tone: string } {
  if (state === "available") return { label: "Graph available", tone: "bg-ok-soft text-ok" };
  if (state === "needs_review")
    return { label: "Graph needs review", tone: "bg-warning-soft text-warning" };
  return { label: "Graph unavailable", tone: "bg-surface-muted text-muted" };
}

function reviewTone(status: RoofGraph["review_status"]): string {
  if (status === "Approved") return "bg-ok-soft text-ok";
  if (status === "Needs Review") return "bg-warning-soft text-warning";
  if (status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function facetPaint(status: RoofGraphFacet["review_status"]): { fill: string; stroke: string } {
  if (status === "Approved") return { fill: "var(--ok-soft)", stroke: "var(--ok)" };
  if (status === "Needs Review") return { fill: "var(--warning-soft)", stroke: "var(--warning)" };
  if (status === "Rejected") return { fill: "var(--danger-soft)", stroke: "var(--danger)" };
  return { fill: "var(--surface-muted)", stroke: "var(--muted)" };
}

function formatConfidence(value: number | null, locale: string): string {
  if (value === null) return "Not recorded";
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
      value / 100,
    );
  } catch {
    return `${value}%`;
  }
}

function formatDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      date,
    );
  } catch {
    return date.toLocaleString();
  }
}
