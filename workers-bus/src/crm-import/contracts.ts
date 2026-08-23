// contracts.ts - the canonical, provider-agnostic shape of a CRM import.
//
// Everything downstream of `CanonicalRow` is provider-agnostic: the planner, the placement map,
// the report and the store never learn which CRM the rows came from. Provider knowledge lives in
// one adapter file and nowhere else (ELEC-166 constraint: provider-agnostic at the core,
// provider-specific only at the adapter).

/** One raw record as it appears in the customer's export, before any mapping. */
export type SourceRecord = Readonly<Record<string, string>>;

/** The documented import format, after an adapter has mapped a source record onto it. */
export interface CanonicalRow {
  /** Provider-scoped natural key. Null when the export carries no id; the planner derives one. */
  readonly externalId: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  /** Ordered; `services[0]` is the primary service. Multi-service jobs are M5 (PO decision D5). */
  readonly services: readonly string[];
  /** Deal value in cents, as the source states it. Never inferred. */
  readonly valueCents: number | null;
  /** The source board column, verbatim. Null when the export omits it. */
  readonly sourceStage: string | null;
  /** The customer's human lead code (`26-225-CR ...`). Carried as data, never invented (D6). */
  readonly leadNumber: string | null;
  readonly jobNumber: string | null;
  /** Per-card engagement counters. No rollup exists on our side; archived, never fabricated. */
  readonly activity: Readonly<Record<string, string>>;
  /** Source columns with no mapped home. Archived verbatim rather than dropped. */
  readonly extras: Readonly<Record<string, string>>;
}

/** Which provider column populated which canonical field, so the report can name real columns. */
export type ColumnAliases = Readonly<Record<string, readonly string[]>>;

export interface CrmImportAdapter {
  readonly id: string;
  readonly label: string;
  /** Canonical field -> the source column names this adapter accepts for it, best match first. */
  readonly aliases: ColumnAliases;
  /** Source column names this adapter reads as engagement counters. */
  readonly activityColumns: readonly string[];
  readonly normalize: (record: SourceRecord) => CanonicalRow;
}

export type PlacementVerdict = "direct" | "capped" | "unmapped_default";
export type ValueDisposition = "placed" | "archived" | "absent";

export interface StagePlacement {
  readonly stageKey: string;
  readonly stageLabel: string;
  readonly verdict: PlacementVerdict;
  /** Present when `verdict` is not `direct`: why the honest target differs from the source. */
  readonly reason: string | null;
  /** The source stage that was capped away, kept so the ledger can show what was really there. */
  readonly cappedFrom: string | null;
}

export interface PlannedRow {
  readonly index: number;
  readonly importKey: string | null;
  /** Deterministic seed hashed into an import key when the export carries no id. */
  readonly naturalKeySeed: string;
  readonly row: CanonicalRow;
  readonly placement: StagePlacement;
  readonly valueDisposition: ValueDisposition;
  readonly valueCents: number | null;
  /** The envelope payload this row would materialize, minus the fields the store fills in. */
  readonly payload: Record<string, unknown>;
}

export interface RowError {
  readonly index: number;
  readonly importKey: string | null;
  readonly reason: string;
}

export interface StageTotals {
  readonly stageKey: string;
  readonly stageLabel: string;
  readonly cards: number;
  readonly valuePlacedCents: number;
  readonly valueArchivedCents: number;
  readonly sourceStages: readonly string[];
}

export interface SourceStageTotals {
  readonly sourceStage: string;
  readonly cards: number;
  readonly valueCents: number;
  readonly stageKey: string;
  readonly verdict: PlacementVerdict;
}

export interface FieldDisposition {
  readonly field: string;
  /** Where the value lands, or the archive it lands in. */
  readonly home: string;
  readonly rowsPresent: number;
  readonly placed: number;
  readonly archived: number;
  readonly dropped: number;
  readonly reason: string;
}

export interface Reconciliation {
  readonly sourceRows: number;
  readonly plannedRows: number;
  readonly erroredRows: number;
  readonly sourceValueCents: number;
  readonly placedValueCents: number;
  readonly archivedValueCents: number;
  /** True when every source row and every source cent is accounted for by a planned disposition. */
  readonly balanced: boolean;
}

export interface CrmImportReport {
  readonly runId: string | null;
  readonly mode: "dry_run" | "execute";
  readonly adapter: string;
  readonly adapterLabel: string;
  readonly pipelineKey: string;
  readonly sourceLabel: string | null;
  readonly generatedAt: string;
  readonly reconciliation: Reconciliation;
  readonly stages: readonly StageTotals[];
  readonly sourceStages: readonly SourceStageTotals[];
  readonly capped: readonly {
    readonly importKey: string | null;
    readonly sourceStage: string;
    readonly placedStageKey: string;
    readonly reason: string;
  }[];
  readonly unmappedStages: readonly { readonly sourceStage: string; readonly rows: number }[];
  readonly fieldDispositions: readonly FieldDisposition[];
  readonly rowErrors: readonly RowError[];
  /** Populated on execute: what the run actually did. Null on a dry run, which writes nothing. */
  readonly applied: {
    readonly created: number;
    readonly adopted: number;
    readonly failed: number;
  } | null;
}

export interface CrmImportPlan {
  readonly adapter: CrmImportAdapter;
  readonly pipelineKey: string;
  readonly rows: readonly PlannedRow[];
  readonly errors: readonly RowError[];
  readonly report: CrmImportReport;
}
