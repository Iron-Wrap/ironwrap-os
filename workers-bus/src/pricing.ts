// pricing.ts - price a verified takeoff into an order-ready line-item estimate.
//
// The takeoff already carries structural quantities (panel feet, trim sticks,
// fastener counts) with source refs; pricing multiplies them by a tenant price
// list and never invents quantities of its own. Discipline mirrors the rest of
// the pipeline: a needs_review takeoff prices into a needs_review estimate,
// unpriced trim profiles are surfaced (an order missing a profile is not
// complete), and every line keeps a source ref back to the takeoff quantity it
// priced. Money is rounded per line to cents; totals sum the rounded lines so
// the printed document always adds up.
//
// ponytail: price lists are data (tenant config or Frappe), not code; the
//   DEFAULT rates deliberately do not exist. Labor is a flat rate per square -
//   pitch/storey multipliers belong in the price list layer when they matter.

import type { TakeoffModel } from "./takeoff.ts";

export interface PriceLine {
  kind: "panel" | "trim" | "fastener" | "labor";
  sku: string;
  description: string;
  qty: number;
  unit: string;
  rate: number;
  amount: number;
  sourceRef: string;
}

export interface PriceList {
  currency: string;
  panel: {
    sku: string;
    description?: string;
    /** Price panels by linear foot (cut list) or by square foot (coverage). */
    unit: "lf" | "sqft";
    rate: number;
  };
  /** Trim profile name (takeoff's) -> pricing. Missing profiles flag the estimate. */
  trims: Record<string, { sku: string; description?: string; unit?: "stick" | "lf"; rate: number }>;
  fasteners?: Partial<Record<"clips" | "clipScrews" | "trimScrews", { sku: string; description?: string; rate: number; per?: number }>>;
  labor?: { sku: string; description?: string; ratePerSquare: number };
  /** Applied on the subtotal, in order: markup first, then tax. */
  markupPct?: number;
  taxPct?: number;
}

export interface PricedEstimate {
  currency: string;
  lines: PriceLine[];
  subtotal: number;
  markup: number;
  tax: number;
  total: number;
  /** Trim profiles present in the takeoff but absent from the price list. */
  unpricedProfiles: string[];
  needsReview: boolean;
  sourceRefs: Record<string, string>;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Multiply verified takeoff quantities by a tenant price list. Pure. */
export function priceTakeoff(takeoff: TakeoffModel, list: PriceList): PricedEstimate {
  const lines: PriceLine[] = [];
  const sourceRefs: Record<string, string> = {};

  const panelQty = list.panel.unit === "lf" ? takeoff.totals.panelFt : takeoff.totals.panelAreaSqft;
  lines.push({
    kind: "panel",
    sku: list.panel.sku,
    description: list.panel.description ?? "Roof panels",
    qty: panelQty,
    unit: list.panel.unit,
    rate: list.panel.rate,
    amount: round2(panelQty * list.panel.rate),
    sourceRef: list.panel.unit === "lf" ? "takeoff.totals.panelFt" : "takeoff.totals.panelAreaSqft",
  });

  const unpricedProfiles: string[] = [];
  for (const trim of takeoff.trims) {
    const priced = list.trims[trim.profile];
    if (!priced) {
      unpricedProfiles.push(trim.profile);
      continue;
    }
    const unit = priced.unit ?? "stick";
    const qty = unit === "stick" ? trim.sticks : trim.totalFt;
    lines.push({
      kind: "trim",
      sku: priced.sku,
      description: priced.description ?? `${trim.profile} trim`,
      qty,
      unit,
      rate: priced.rate,
      amount: round2(qty * priced.rate),
      sourceRef: `takeoff.trims[${trim.profile}].${unit === "stick" ? "sticks" : "totalFt"}`,
    });
  }

  for (const key of ["clips", "clipScrews", "trimScrews"] as const) {
    const priced = list.fasteners?.[key];
    if (!priced) continue;
    const count = takeoff.fasteners[key];
    const per = priced.per ?? 1;
    const qty = Math.ceil(count / per);
    lines.push({
      kind: "fastener",
      sku: priced.sku,
      description: priced.description ?? key,
      qty,
      unit: per === 1 ? "ea" : `pack of ${per}`,
      rate: priced.rate,
      amount: round2(qty * priced.rate),
      sourceRef: `takeoff.fasteners.${key}`,
    });
  }

  if (list.labor) {
    const squares = round2(takeoff.totals.panelAreaSqft / 100);
    lines.push({
      kind: "labor",
      sku: list.labor.sku,
      description: list.labor.description ?? "Install labor",
      qty: squares,
      unit: "square",
      rate: list.labor.ratePerSquare,
      amount: round2(squares * list.labor.ratePerSquare),
      sourceRef: "takeoff.totals.panelAreaSqft / 100",
    });
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const markup = round2(subtotal * ((list.markupPct ?? 0) / 100));
  const tax = round2((subtotal + markup) * ((list.taxPct ?? 0) / 100));
  const total = round2(subtotal + markup + tax);

  sourceRefs.subtotal = `sum(${lines.length} line amounts)`;
  if (list.markupPct) sourceRefs.markup = `subtotal x ${list.markupPct}%`;
  if (list.taxPct) sourceRefs.tax = `(subtotal + markup) x ${list.taxPct}%`;

  return {
    currency: list.currency,
    lines,
    subtotal,
    markup,
    tax,
    total,
    unpricedProfiles,
    // An estimate is reviewable if the takeoff was, or if any profile has no price.
    needsReview: takeoff.needsReview || unpricedProfiles.length > 0,
    sourceRefs,
  };
}
