// stage-map.ts - source board column -> our pipeline stage key, with the capping discipline.
//
// The map itself is data: a `StagePlacementMap` is an ordered stage contract plus alias rules, and
// nothing in this file knows about roofing or about any particular CRM. `SEEDED_SALES_PIPELINE` is
// the one map M1 ships, describing the stakeholder's seeded Sales board; another vertical adds a
// second constant, not a second code path.
//
// Capping doctrine, inherited verbatim from docs/JOBNIMBUS-MIGRATION-MAP.md rather than reinvented:
// where a source stage asserts something our system would need real evidence to back, the row is
// imported into the furthest stage the evidence honestly supports and a `stage_capped` ledger entry
// carries the true source stage. A migration never fabricates the evidence.

import type { PlacementVerdict, StagePlacement } from "./contracts.ts";

export interface StageContract {
  readonly key: string;
  readonly label: string;
  /** Board flags the pipeline owns (PO decision D3). Recorded here only so the map can be read. */
  readonly isWon?: boolean;
}

export interface StageAlias {
  /** Source labels, matched case- and punctuation-insensitively. */
  readonly match: readonly string[];
  readonly stageKey: string;
  readonly verdict: PlacementVerdict;
  /** Required for a capped alias: what we could not honestly back. */
  readonly reason?: string;
}

export interface StagePlacementMap {
  readonly pipelineKey: string;
  readonly pipelineLabel: string;
  readonly stages: readonly StageContract[];
  readonly aliases: readonly StageAlias[];
  /** Where a row lands when the export names a stage we do not recognize, or names none. */
  readonly fallbackStageKey: string;
}

/**
 * The stakeholder's seeded Sales pipeline. Stage keys are the slugified seed labels
 * (`New Lead` -> `new_lead`); the board owns the stage rows themselves and this module only
 * writes the key it placed a card under.
 */
export const SEEDED_SALES_PIPELINE: StagePlacementMap = {
  pipelineKey: "sales",
  pipelineLabel: "Sales",
  stages: [
    { key: "new_lead", label: "New Lead" },
    { key: "visit_booked", label: "Visit Booked" },
    { key: "need_quote", label: "Need Quote" },
    { key: "quote_sent", label: "Quote Sent" },
    // D3: `is_won` sits on Contract signed. Deposit and Materials in prod are post-sale
    // fulfilment stages that happen to share the board.
    { key: "contract_signed", label: "Contract signed", isWon: true },
    { key: "deposit", label: "Deposit" },
    { key: "materials_in_prod", label: "Materials in prod" },
  ],
  aliases: [
    { match: ["new lead", "new leads", "lead", "new"], stageKey: "new_lead", verdict: "direct" },
    {
      match: ["visit booked", "appointment booked", "inspection booked", "visit scheduled"],
      stageKey: "visit_booked",
      verdict: "direct",
    },
    {
      match: ["need quote", "needs quote", "quote needed", "estimating"],
      stageKey: "need_quote",
      verdict: "direct",
    },
    {
      match: ["quote sent", "proposal sent", "estimate sent", "quoted"],
      stageKey: "quote_sent",
      verdict: "direct",
    },
    {
      match: ["contract signed", "signed", "sold", "won", "closed won"],
      stageKey: "contract_signed",
      verdict: "direct",
    },
    // Capped: a deposit stage asserts money received. QuickBooks remains posted accounting truth
    // and an export carries no payment record, so the card lands on the last stage the source
    // itself proves - the signed contract - and the true stage rides the ledger.
    {
      match: ["deposit", "deposit received", "deposit paid"],
      stageKey: "contract_signed",
      verdict: "capped",
      reason:
        "Deposit asserts a received payment. QuickBooks is posted accounting truth and the export "
        + "carries no payment evidence, so the card is placed on Contract signed with the true "
        + "source stage recorded.",
    },
    // Capped: production stages require real operating_production_gates evidence, exactly as
    // JobNimbus `In Production` / `Closed` do in docs/JOBNIMBUS-MIGRATION-MAP.md.
    {
      match: [
        "materials in prod",
        "materials in production",
        "in production",
        "production",
        "materials ordered",
      ],
      stageKey: "contract_signed",
      verdict: "capped",
      reason:
        "Production stages require real production-gate evidence, which a migration must never "
        + "fabricate. The card is placed on Contract signed with the true source stage recorded.",
    },
  ],
  fallbackStageKey: "new_lead",
};

const NORMALIZE = /[^a-z0-9]+/g;

function normalize(label: string): string {
  return label.toLowerCase().replace(NORMALIZE, " ").trim();
}

export function stageLabel(map: StagePlacementMap, stageKey: string): string {
  return map.stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
}

export function stageRank(map: StagePlacementMap, stageKey: string): number {
  return map.stages.findIndex((stage) => stage.key === stageKey);
}

/** Resolve one source stage label. Never throws: an unknown label is a reported verdict, not a crash. */
export function placeStage(map: StagePlacementMap, sourceStage: string | null): StagePlacement {
  const raw = (sourceStage ?? "").trim();
  const normalized = normalize(raw);
  const alias = normalized
    ? map.aliases.find((rule) => rule.match.some((candidate) => normalize(candidate) === normalized))
    : undefined;

  if (!alias) {
    return {
      stageKey: map.fallbackStageKey,
      stageLabel: stageLabel(map, map.fallbackStageKey),
      verdict: "unmapped_default",
      reason: raw
        ? `Source stage "${raw}" is not in the ${map.pipelineLabel} map; placed on `
          + `${stageLabel(map, map.fallbackStageKey)} so no card is lost.`
        : `The export names no stage; placed on ${stageLabel(map, map.fallbackStageKey)}.`,
      cappedFrom: raw || null,
    };
  }

  return {
    stageKey: alias.stageKey,
    stageLabel: stageLabel(map, alias.stageKey),
    verdict: alias.verdict,
    reason: alias.verdict === "direct" ? null : (alias.reason ?? null),
    cappedFrom: alias.verdict === "capped" ? raw : null,
  };
}

/**
 * The first stage at which a deal value is backed by something our system can hold. Before it,
 * there is no estimate or quote to attach money to (PO decision D4), so a source value is archived
 * rather than materialized as an estimate the customer never received.
 */
export const VALUE_BEARING_STAGE_KEY = "need_quote";

export function valueFitsStage(map: StagePlacementMap, stageKey: string): boolean {
  const threshold = stageRank(map, VALUE_BEARING_STAGE_KEY);
  const rank = stageRank(map, stageKey);
  return threshold >= 0 && rank >= threshold;
}

export const PLACEMENT_MAPS: Readonly<Record<string, StagePlacementMap>> = {
  [SEEDED_SALES_PIPELINE.pipelineKey]: SEEDED_SALES_PIPELINE,
};

export function resolvePlacementMap(pipelineKey: string): StagePlacementMap | null {
  return PLACEMENT_MAPS[pipelineKey] ?? null;
}
