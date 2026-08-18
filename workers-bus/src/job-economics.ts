export type EconomicsRow = Readonly<Record<string, unknown>>;

export interface JobEconomicsInput {
  tenantId: string;
  jobId: string;
  customerQuotes: readonly EconomicsRow[];
  changeOrders: readonly EconomicsRow[];
  supplierQuotes: readonly EconomicsRow[];
  supplierOrders: readonly EconomicsRow[];
  materialLots: readonly EconomicsRow[];
  shopOrders: readonly EconomicsRow[];
  fieldCheckins: readonly EconomicsRow[];
  paymentMilestones: readonly EconomicsRow[];
  costEvents: readonly EconomicsRow[];
  accountingReconciliations: readonly EconomicsRow[];
  partialSources?: readonly string[];
}

export interface EconomicsMetric {
  /** Observed qualifying source sum; incomplete values are not a business-total claim. */
  known_cents: number | null;
  complete: boolean;
  source_count: number;
}

export interface JobEconomicsProjection {
  tenant_id: string;
  job_id: string;
  currency: string | null;
  state: "complete" | "needs_review" | "incomplete";
  metrics: {
    forecast_revenue: EconomicsMetric;
    forecast_cost: EconomicsMetric;
    committed_cost: EconomicsMetric;
    accrued_actual_cost: EconomicsMetric;
    posted_actual_cost: EconomicsMetric;
    invoiced_revenue_ex_tax: EconomicsMetric;
    cash_collected: EconomicsMetric;
    actual_profit: {
      amount_cents: null;
      state: "unavailable";
      reason: "posted_revenue_recognition_unavailable";
    };
  };
  source_coverage: {
    customer_quotes: number;
    accepted_change_orders: number;
    supplier_quotes: number;
    committed_supplier_orders: number;
    material_lots: number;
    progressed_shop_orders: number;
    verified_field_checkins: number;
    matched_payment_milestones: number;
    posted_revenue_milestones: number;
    cost_events: number;
    valid_reversals: number;
    posted_cost_events: number;
    matched_cost_reconciliations: number;
  };
  reconciliation_gaps: string[];
}

const COMMITTED_ORDER_STATUSES = new Set([
  "Approved",
  "Ordered",
  "Partially Received",
  "Received",
  "Shortage",
]);
const PROGRESSED_SHOP_STATUSES = new Set([
  "Released",
  "Reserved",
  "Setup / First Piece",
  "In Fabrication",
  "Quality Hold",
  "Ready",
  "Handed Over",
  "Invoice Ready",
  "Closed",
]);
const COST_AMOUNT_BASES = new Set([
  "Net of Recoverable Tax",
  "Includes Non-Recoverable Tax",
  "No Tax",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowId(row: EconomicsRow): string {
  return (
    text(row.name) ??
    text(row.job_cost_event_id) ??
    text(row.payment_milestone_id) ??
    "unknown"
  );
}

function safeInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function timestamp(value: unknown): number | null {
  const normalized = text(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse persisted currency decimals without binary floating-point arithmetic. */
export function currencyAmountToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number" ? String(value) : String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const cents = sign * (BigInt(match[2]!) * 100n + BigInt(fraction || "0"));
  const number = Number(cents);
  return Number.isSafeInteger(number) ? number : null;
}

function version(row: EconomicsRow): number {
  const value = Number(row.quote_version ?? row.version ?? row.milestone_version ?? 0);
  return Number.isSafeInteger(value) ? value : 0;
}

function newestVersion(rows: readonly EconomicsRow[]): EconomicsRow | null {
  return [...rows].sort(
    (left, right) =>
      version(right) - version(left) || rowId(right).localeCompare(rowId(left)),
  )[0] ?? null;
}

function terminalRows(rows: readonly EconomicsRow[], link = "supersedes"): EconomicsRow[] {
  const superseded = new Set(rows.map((row) => text(row[link])).filter(Boolean));
  return rows.filter((row) => !superseded.has(rowId(row)));
}

function sumSafe(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function sourceRows(
  rows: readonly EconomicsRow[],
  jobId: string,
  source: string,
  gaps: Set<string>,
): EconomicsRow[] {
  return rows.filter((row) => {
    if (text(row.roof_job) === jobId) return true;
    gaps.add(`${source}.job_mismatch:${rowId(row)}`);
    return false;
  });
}

function metric(
  values: readonly number[],
  complete: boolean,
  currenciesCompatible: boolean,
): EconomicsMetric {
  return {
    known_cents: currenciesCompatible ? sumSafe(values) : null,
    complete: complete && currenciesCompatible && sumSafe(values) !== null,
    source_count: values.length,
  };
}

function normalizedQuantity(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole!;
}

function sameReversalBinding(cost: EconomicsRow, reversal: EconomicsRow): boolean {
  const exactFields = [
    "tenant",
    "roof_job",
    "category",
    "unit",
    "amount_cents",
    "amount_basis",
    "currency",
    "source_doctype",
    "source_name",
    "source_digest",
    "source_evidence",
  ];
  return (
    exactFields.every((field) => String(cost[field] ?? "") === String(reversal[field] ?? "")) &&
    normalizedQuantity(cost.quantity) === normalizedQuantity(reversal.quantity)
  );
}

export function buildJobEconomicsProjection(
  input: JobEconomicsInput,
): JobEconomicsProjection {
  const gaps = new Set<string>(
    (input.partialSources ?? []).map((source) => `${source}.source_window_partial`),
  );
  const customerQuotes = terminalRows(
    sourceRows(input.customerQuotes, input.jobId, "customer_quote", gaps),
  );
  const changeOrders = terminalRows(
    sourceRows(input.changeOrders, input.jobId, "change_order", gaps),
  );
  const supplierQuotes = sourceRows(
    input.supplierQuotes,
    input.jobId,
    "supplier_quote",
    gaps,
  );
  const supplierOrders = sourceRows(
    input.supplierOrders,
    input.jobId,
    "supplier_order",
    gaps,
  );
  const materialLots = sourceRows(input.materialLots, input.jobId, "material_lot", gaps);
  const shopOrders = sourceRows(input.shopOrders, input.jobId, "shop_order", gaps);
  const fieldCheckins = sourceRows(
    input.fieldCheckins,
    input.jobId,
    "field_checkin",
    gaps,
  );
  const paymentMilestones = terminalRows(
    sourceRows(input.paymentMilestones, input.jobId, "payment_milestone", gaps),
  );
  const accountingReconciliations = terminalRows(
    sourceRows(
      input.accountingReconciliations,
      input.jobId,
      "integration_reconciliation",
      gaps,
    ),
  );
  const reconciliationById = new Map(
    accountingReconciliations.flatMap((row) => {
      const ids = [text(row.name), text(row.reconciliation_id)].filter(
        (id): id is string => Boolean(id),
      );
      return ids.map((id) => [id, row] as const);
    }),
  );

  const costEvents: EconomicsRow[] = [];
  const eventById = new Map<string, EconomicsRow>();
  let costEventsComplete = true;
  for (const row of input.costEvents) {
    const id = rowId(row);
    if (text(row.tenant) !== input.tenantId) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.tenant_mismatch:${id}`);
      continue;
    }
    if (text(row.roof_job) !== input.jobId) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.job_mismatch:${id}`);
      continue;
    }
    if (eventById.has(id)) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.duplicate_id:${id}`);
      continue;
    }
    const amount = safeInteger(row.amount_cents);
    if (!amount || amount <= 0 || amount > 2_147_483_647) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.invalid_amount_cents:${id}`);
      continue;
    }
    if (!COST_AMOUNT_BASES.has(text(row.amount_basis) ?? "")) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.amount_basis_missing:${id}`);
      continue;
    }
    eventById.set(id, row);
    costEvents.push(row);
  }

  const validReversalIds = new Set<string>();
  const reversedCostIds = new Set<string>();
  const reversalsByTarget = new Map<string, EconomicsRow[]>();
  for (const reversal of costEvents.filter((row) => text(row.event_kind) === "reversal")) {
    const id = rowId(reversal);
    const targetId = text(reversal.reversal_of);
    const target = targetId ? eventById.get(targetId) : null;
    if (!targetId || !target) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.dangling_reversal:${id}`);
      continue;
    }
    if (text(target.event_kind) !== "cost") {
      costEventsComplete = false;
      gaps.add(`job_cost_event.reversal_target_not_cost:${id}`);
      continue;
    }
    const candidates = reversalsByTarget.get(targetId) ?? [];
    candidates.push(reversal);
    reversalsByTarget.set(targetId, candidates);
  }
  for (const [targetId, reversals] of [...reversalsByTarget].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const ordered = [...reversals].sort((left, right) =>
      rowId(left).localeCompare(rowId(right))
    );
    if (ordered.length !== 1) {
      costEventsComplete = false;
      for (const reversal of ordered) {
        gaps.add(`job_cost_event.double_reversal:${rowId(reversal)}`);
      }
      continue;
    }
    const reversal = ordered[0]!;
    const id = rowId(reversal);
    const target = eventById.get(targetId)!;
    if (!sameReversalBinding(target, reversal)) {
      costEventsComplete = false;
      gaps.add(`job_cost_event.reversal_binding_mismatch:${id}`);
      continue;
    }
    reversedCostIds.add(targetId);
    validReversalIds.add(id);
  }
  for (const row of costEvents) {
    const kind = text(row.event_kind);
    if (kind !== "cost" && kind !== "reversal") {
      costEventsComplete = false;
      gaps.add(`job_cost_event.invalid_kind:${rowId(row)}`);
    }
  }
  const effectiveCostEvents = costEvents.filter(
    (row) => text(row.event_kind) === "cost" || validReversalIds.has(rowId(row)),
  );

  const selectedQuote = newestVersion(
    customerQuotes.filter((row) => ["Approved", "Accepted"].includes(text(row.status) ?? "")),
  );
  const forecastRevenueValues: number[] = [];
  let forecastRevenueComplete = Boolean(selectedQuote);
  if (selectedQuote) {
    const value = currencyAmountToCents(selectedQuote.subtotal);
    if (value === null) {
      forecastRevenueComplete = false;
      gaps.add(`customer_quote.subtotal_missing:${rowId(selectedQuote)}`);
    } else {
      forecastRevenueValues.push(value);
    }
  } else {
    gaps.add("customer_quote.approved_or_accepted_missing");
  }
  const acceptedChangeOrders = changeOrders.filter((row) => text(row.status) === "Accepted");
  for (const row of acceptedChangeOrders) {
    const value = currencyAmountToCents(row.subtotal);
    if (value === null) {
      forecastRevenueComplete = false;
      gaps.add(`change_order.subtotal_missing:${rowId(row)}`);
    } else {
      forecastRevenueValues.push(value);
    }
  }

  const approvedSupplierQuotes = supplierQuotes.filter(
    (row) => text(row.status) === "Approved",
  );
  const supplierQuoteById = new Map<string, EconomicsRow>(
    approvedSupplierQuotes.map((row) => [rowId(row), row] as const),
  );
  const committedOrders = supplierOrders.filter((row) =>
    COMMITTED_ORDER_STATUSES.has(text(row.status) ?? ""),
  );
  const selectedSupplierQuoteIds = new Set<string>();
  let committedComplete = true;
  for (const order of committedOrders) {
    const quoteId = text(order.source_quote);
    if (!quoteId || !supplierQuoteById.has(quoteId)) {
      committedComplete = false;
      gaps.add(`supplier_order.price_source_missing:${rowId(order)}`);
      continue;
    }
    if (selectedSupplierQuoteIds.has(quoteId)) {
      committedComplete = false;
      gaps.add(`supplier_order.quote_reused:${quoteId}`);
      continue;
    }
    selectedSupplierQuoteIds.add(quoteId);
  }
  const forecastSupplierQuotes: EconomicsRow[] =
    selectedSupplierQuoteIds.size > 0
      ? [...selectedSupplierQuoteIds]
          .map((id) => supplierQuoteById.get(id))
          .filter((row): row is EconomicsRow => Boolean(row))
      : approvedSupplierQuotes.length === 1
        ? approvedSupplierQuotes
        : [];
  let forecastCostComplete =
    forecastSupplierQuotes.length > 0 &&
    (committedOrders.length === 0 || committedComplete);
  if (forecastSupplierQuotes.length === 0) {
    gaps.add(
      approvedSupplierQuotes.length > 1
        ? "supplier_quote.selection_ambiguous"
        : "supplier_quote.approved_missing",
    );
    forecastCostComplete = false;
  }
  const supplierCostValues: number[] = [];
  for (const row of forecastSupplierQuotes) {
    const value = currencyAmountToCents(row.quote_total);
    if (value === null) {
      forecastCostComplete = false;
      committedComplete = false;
      gaps.add(`supplier_quote.total_missing:${rowId(row)}`);
    } else {
      supplierCostValues.push(value);
    }
    // Supplier Quote currently stores one quote_total without an explicit tax
    // basis. Keep the observed amount, but never claim complete forecast or
    // committed cost until recoverable-tax semantics are persisted.
    forecastCostComplete = false;
    if (selectedSupplierQuoteIds.has(rowId(row))) committedComplete = false;
    gaps.add(`supplier_quote.tax_basis_unverified:${rowId(row)}`);
  }
  const committedValues = [...selectedSupplierQuoteIds].flatMap((id) => {
    const row = supplierQuoteById.get(id);
    if (!row) return [];
    const value = currencyAmountToCents(row.quote_total);
    return value === null ? [] : [value];
  });

  const accrualValues: number[] = [];
  const postedValues: number[] = [];
  const validPostedEventIds = new Set<string>();
  for (const row of effectiveCostEvents) {
    const id = rowId(row);
    const kind = text(row.event_kind);
    if (kind !== "cost" && !validReversalIds.has(id)) continue;
    const amount = safeInteger(row.amount_cents);
    if (!amount) continue;
    const signed = kind === "reversal" ? -amount : amount;
    accrualValues.push(signed);
    if (text(row.accounting_state) === "Posted") {
      const reconciliationId = text(row.reconciliation);
      const reconciliation = reconciliationId
        ? reconciliationById.get(reconciliationId)
        : null;
      const occurredAt = timestamp(row.occurred_at);
      const postedAt = timestamp(row.accounting_posted_at);
      const recordedAt = timestamp(row.recorded_at);
      const detectedAt = timestamp(reconciliation?.detected_at);
      if (
        !text(row.accounting_system) ||
        !text(row.accounting_entity_type) ||
        !text(row.accounting_entity_id) ||
        !/^[a-f0-9]{64}$/.test(text(row.accounting_digest) ?? "") ||
        !text(row.accounting_posted_at) ||
        occurredAt === null ||
        postedAt === null ||
        recordedAt === null ||
        detectedAt === null ||
        occurredAt > postedAt ||
        postedAt > detectedAt ||
        detectedAt > recordedAt ||
        !reconciliationId ||
        !reconciliation ||
        !["Matched", "Resolved"].includes(text(reconciliation.status) ?? "") ||
        text(reconciliation.system_name) !== text(row.accounting_system) ||
        text(reconciliation.entity_type) !== text(row.accounting_entity_type) ||
        text(reconciliation.external_entity_id) !== text(row.accounting_entity_id) ||
        text(reconciliation.local_doctype) !== "Job Cost Event" ||
        text(reconciliation.local_name) !== rowId(row) ||
        text(reconciliation.currency) !== text(row.currency) ||
        text(reconciliation.source_payload_hash) !== text(row.accounting_digest)
      ) {
        costEventsComplete = false;
        gaps.add(`job_cost_event.posted_binding_incomplete:${id}`);
      } else {
        postedValues.push(signed);
        validPostedEventIds.add(id);
      }
    }
  }

  const activeCostSources = effectiveCostEvents.filter(
    (row) => text(row.event_kind) === "cost" && !reversedCostIds.has(rowId(row)),
  );
  const hasCostSource = (doctype: string, name: string, category: string) =>
    activeCostSources.some(
      (row) =>
        text(row.source_doctype) === doctype &&
        text(row.source_name) === name &&
        text(row.category) === category,
    );
  for (const lot of materialLots.filter((row) => text(row.status) !== "Draft")) {
    if (!hasCostSource("Material Lot", rowId(lot), "Material")) {
      costEventsComplete = false;
      gaps.add(`material_lot.actual_cost_missing:${rowId(lot)}`);
    }
  }
  const progressedShopOrders = shopOrders.filter((row) =>
    PROGRESSED_SHOP_STATUSES.has(text(row.status) ?? ""),
  );
  for (const order of progressedShopOrders) {
    for (const category of ["Labour", "Machine"]) {
      if (!hasCostSource("Shop Order", rowId(order), category)) {
        costEventsComplete = false;
        gaps.add(`shop_order.${category.toLowerCase()}_cost_missing:${rowId(order)}`);
      }
    }
  }
  const verifiedFieldCheckins = fieldCheckins.filter(
    (row) => text(row.sync_state) === "Verified",
  );
  for (const checkin of verifiedFieldCheckins) {
    if (!hasCostSource("Field Check-in", rowId(checkin), "Labour")) {
      costEventsComplete = false;
      gaps.add(`field_checkin.labour_cost_missing:${rowId(checkin)}`);
    }
  }

  const invoiceValues: number[] = [];
  const cashValues: number[] = [];
  let invoiceComplete = true;
  let cashComplete = true;
  const matchedMilestones = paymentMilestones.filter((row) => text(row.status) === "Matched");
  const validPostedRevenueMilestoneIds = new Set<string>();
  for (const row of paymentMilestones) {
    const type = text(row.milestone_type);
    if (text(row.status) !== "Matched" && ["Invoice", "Credit", "Payment", "Refund"].includes(type ?? "")) {
      if (["Invoice", "Credit"].includes(type ?? "")) invoiceComplete = false;
      if (["Payment", "Refund"].includes(type ?? "")) cashComplete = false;
      gaps.add(`payment_milestone.not_matched:${rowId(row)}`);
      continue;
    }
    if (text(row.status) !== "Matched") continue;
    if (type === "Invoice" || type === "Credit") {
      const value = currencyAmountToCents(row.subtotal);
      if (value === null) {
        invoiceComplete = false;
        gaps.add(`payment_milestone.subtotal_missing:${rowId(row)}`);
      } else {
        invoiceValues.push(type === "Credit" ? -value : value);
      }
    }
    if (type === "Payment" || type === "Refund") {
      const value = currencyAmountToCents(row.total_amount);
      if (value === null) {
        cashComplete = false;
        gaps.add(`payment_milestone.cash_amount_missing:${rowId(row)}`);
      } else {
        cashValues.push(type === "Refund" ? -value : value);
      }
    }
  }
  const revenueMilestones = matchedMilestones.filter((row) => {
    const type = text(row.milestone_type);
    return type === "Invoice" || type === "Credit";
  });
  if (revenueMilestones.length === 0) {
    gaps.add("payment_milestone.posted_revenue_missing");
  }
  for (const row of revenueMilestones) {
    const id = rowId(row);
    const value = currencyAmountToCents(row.subtotal);
    const recognitionPostedAt = timestamp(row.recognition_posted_at);
    const truthAt = timestamp(row.truth_at);
    const recognitionDigest = text(row.recognition_digest);
    const recognitionReconciliationId = text(row.recognition_reconciliation);
    const reconciliation = recognitionReconciliationId
      ? reconciliationById.get(recognitionReconciliationId)
      : null;
    const detectedAt = timestamp(reconciliation?.detected_at);
    if (
      value === null ||
      text(row.truth_source) !== "QuickBooks" ||
      !recognitionPostedAt ||
      !truthAt ||
      recognitionPostedAt > truthAt ||
      !recognitionDigest ||
      !/^[a-f0-9]{64}$/.test(recognitionDigest) ||
      !recognitionReconciliationId ||
      !reconciliation ||
      text(reconciliation.roof_job) !== input.jobId ||
      text(reconciliation.system_name) !== "QuickBooks" ||
      text(reconciliation.entity_type) !== text(row.qb_entity_type) ||
      text(reconciliation.external_entity_id) !== text(row.qb_entity_id) ||
      text(reconciliation.local_doctype) !== "Payment Milestone" ||
      text(reconciliation.local_name) !== id ||
      !["Matched", "Resolved"].includes(text(reconciliation.status) ?? "") ||
      text(reconciliation.currency) !== text(row.currency) ||
      text(reconciliation.source_payload_hash) !== recognitionDigest ||
      !detectedAt ||
      detectedAt < recognitionPostedAt ||
      detectedAt > truthAt
    ) {
      gaps.add(`payment_milestone.posted_revenue_binding_incomplete:${id}`);
      continue;
    }
    validPostedRevenueMilestoneIds.add(id);
  }

  const currencyRows: EconomicsRow[] = [
    ...(selectedQuote ? [selectedQuote] : []),
    ...acceptedChangeOrders,
    ...forecastSupplierQuotes,
    ...matchedMilestones,
    ...effectiveCostEvents,
  ];
  const currencies = new Set<string>();
  for (const row of currencyRows) {
    const currency = text(row.currency);
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      gaps.add(`${text(row.event_kind) ? "job_cost_event" : "financial_source"}.currency_missing:${rowId(row)}`);
    } else {
      currencies.add(currency);
    }
  }
  const currency = currencies.size === 1 ? [...currencies][0]! : null;
  if (currencies.size === 0) gaps.add("economics.currency_missing");
  if (currencies.size > 1) gaps.add("economics.mixed_currency");
  const compatible = currency !== null;

  const partial = (input.partialSources?.length ?? 0) > 0;
  const projection: JobEconomicsProjection = {
    tenant_id: input.tenantId,
    job_id: input.jobId,
    currency,
    state: "complete",
    metrics: {
      forecast_revenue: metric(
        forecastRevenueValues,
        forecastRevenueComplete && !partial,
        compatible,
      ),
      forecast_cost: metric(
        supplierCostValues,
        forecastCostComplete && !partial,
        compatible,
      ),
      committed_cost: metric(
        committedValues,
        committedComplete && !partial,
        compatible,
      ),
      accrued_actual_cost: metric(
        accrualValues,
        costEventsComplete && !partial,
        compatible,
      ),
      posted_actual_cost: metric(
        postedValues,
        costEventsComplete && !partial,
        compatible,
      ),
      invoiced_revenue_ex_tax: metric(
        invoiceValues,
        invoiceComplete && !partial,
        compatible,
      ),
      cash_collected: metric(cashValues, cashComplete && !partial, compatible),
      actual_profit: {
        amount_cents: null,
        state: "unavailable",
        reason: "posted_revenue_recognition_unavailable",
      },
    },
    source_coverage: {
      customer_quotes: customerQuotes.length,
      accepted_change_orders: acceptedChangeOrders.length,
      supplier_quotes: approvedSupplierQuotes.length,
      committed_supplier_orders: committedOrders.length,
      material_lots: materialLots.length,
      progressed_shop_orders: progressedShopOrders.length,
      verified_field_checkins: verifiedFieldCheckins.length,
      matched_payment_milestones: matchedMilestones.length,
      posted_revenue_milestones: validPostedRevenueMilestoneIds.size,
      cost_events: costEvents.length,
      valid_reversals: validReversalIds.size,
      posted_cost_events: validPostedEventIds.size,
      matched_cost_reconciliations: accountingReconciliations.filter((row) =>
        ["Matched", "Resolved"].includes(text(row.status) ?? ""),
      ).length,
    },
    reconciliation_gaps: [],
  };
  // QuickBooks terminal revenue recognition still lacks an authenticated
  // provider-side writer in the governed production path. Until that exists,
  // actual profit must remain fail-closed even if local data appears complete.
  if (projection.metrics.actual_profit.state === "unavailable") {
    gaps.add("actual_profit.posted_revenue_recognition_unavailable");
  }
  projection.reconciliation_gaps = [...gaps].sort();
  const coreMetrics = Object.values(projection.metrics).filter(
    (value): value is EconomicsMetric => "known_cents" in value,
  );
  projection.state =
    !compatible || coreMetrics.some((value) => value.known_cents === null)
      ? "incomplete"
      : projection.reconciliation_gaps.length > 1 ||
          coreMetrics.some((value) => !value.complete)
        ? "needs_review"
        : "complete";
  return projection;
}
