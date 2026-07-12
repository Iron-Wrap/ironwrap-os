import { z } from "zod";

const nullableText = z.string().min(1).nullable();
const nullableNumber = z.number().finite().nullable();

const envelopeSchema = z
  .object({
    version: z.literal(1),
    source_updated_at: nullableText,
    read_model_generated_at: z.string().min(1),
    stale_fields: z.array(z.string()),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
  })
  .strict();

const geometrySchema = z
  .object({
    state: z.enum(["recomputed", "needs_review", "unavailable"]),
    reason: nullableText,
    check_count: z.number().int().nonnegative(),
    failed_check_count: z.number().int().nonnegative(),
    checks_truncated: z.boolean(),
    facet_count: z.number().int().nonnegative(),
    facets_truncated: z.boolean(),
    metrics_truncated: z.boolean(),
    checks: z.array(
      z
        .object({
          check: z.string().min(1),
          target: z.string().min(1),
          ok: z.boolean(),
          detail: z.string().min(1),
        })
        .strict(),
    ),
    facets: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.string().min(1),
          material: nullableText,
          pitch: nullableNumber,
          orientation: nullableNumber,
          declared_area: nullableNumber,
          computed_area: nullableNumber,
          deviation: nullableNumber,
          ring_closed: z.boolean(),
        })
        .strict(),
    ),
    metrics: z.array(
      z
        .object({
          metric: z.string().min(1),
          value: z.number().finite(),
          source_ref: nullableText,
        })
        .strict(),
    ),
  })
  .strict();

const measurementReportSchema = z
  .object({
    id: z.string().min(1),
    provider: nullableText,
    review_status: nullableText,
    parsed_at: nullableText,
    approved_at: nullableText,
  })
  .strict();

const selectedMeasurementSchema = measurementReportSchema
  .extend({
    metrics: z.array(
      z
        .object({
          metric: z.string().min(1),
          value: nullableNumber,
          unit: nullableText,
          confidence: nullableText,
          source_ref: nullableText,
          needs_review: z.boolean(),
        })
        .strict(),
    ),
    metrics_truncated: z.boolean(),
    geometry: geometrySchema,
  })
  .strict();

const takeoffSummarySchema = z
  .object({
    id: z.string().min(1),
    measurement_report_id: nullableText,
    status: nullableText,
    prepared_at: nullableText,
    approved_at: nullableText,
  })
  .strict();

const selectedTakeoffSchema = takeoffSummarySchema
  .extend({
    assumptions: nullableText,
    exclusions: nullableText,
    items: z.array(
      z
        .object({
          category: nullableText,
          item_name: nullableText,
          quantity: nullableNumber,
          unit: nullableText,
          waste_factor: nullableNumber,
          source_ref: nullableText,
          confidence: nullableText,
          needs_review: z.boolean(),
        })
        .strict(),
    ),
    items_truncated: z.boolean(),
  })
  .strict();

const quoteSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().nonnegative().nullable(),
    status: nullableText,
    price_book_version: nullableText,
    pricing_effective_at: nullableText,
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    tax_code: nullableText,
    tax_rate: nullableNumber,
    quote_total: nullableNumber,
    currency: nullableText,
    deposit_amount: nullableNumber,
    amount_due: nullableNumber,
    amount_paid: nullableNumber,
    balance_due: nullableNumber,
    payment_status: nullableText,
    payment_due_date: nullableText,
    valid_until: nullableText,
    prepared_at: nullableText,
    approved_at: nullableText,
    accepted_at: nullableText,
    scope_summary: nullableText,
    assumptions: nullableText,
    exclusions: nullableText,
    supersedes: nullableText,
    correction_reason: nullableText,
  })
  .strict();

const proposalSchema = z
  .object({
    id: z.string().min(1),
    quote_id: nullableText,
    status: nullableText,
    prepared_at: nullableText,
    approved_at: nullableText,
    signed_at: nullableText,
    assumptions: nullableText,
    exclusions: nullableText,
  })
  .strict();

const pricingSnapshotSchema = z
  .object({
    state: z.enum(["recorded", "review_required", "expired", "incomplete", "unavailable"]),
    quote_id: nullableText,
    quote_version: z.number().int().nonnegative().nullable(),
    price_book_version: nullableText,
    pricing_effective_at: nullableText,
    valid_until: nullableText,
  })
  .strict();

const quoteRevisionDeltaSchema = z
  .object({
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    quote_total: nullableNumber,
    deposit_amount: nullableNumber,
    amount_due: nullableNumber,
    balance_due: nullableNumber,
    price_book_version_changed: z.boolean(),
    pricing_effective_at_changed: z.boolean(),
    tax_code_changed: z.boolean(),
    tax_rate_changed: z.boolean(),
    currency_changed: z.boolean(),
    scope_summary_changed: z.boolean(),
    assumptions_changed: z.boolean(),
    exclusions_changed: z.boolean(),
  })
  .strict();

const quoteRevisionSchema = z
  .object({
    state: z.enum([
      "no_quote",
      "not_revised",
      "compared",
      "prior_quote_missing",
      "history_incomplete",
      "unlinked_revision",
      "invalid_lineage",
    ]),
    prior_quote: quoteSchema.nullable(),
    delta: quoteRevisionDeltaSchema.nullable(),
  })
  .strict();

const scopeChangeSchema = z
  .object({
    id: z.string().min(1),
    number: nullableText,
    version: z.number().int().nonnegative().nullable(),
    status: nullableText,
    title: nullableText,
    reason: nullableText,
    scope_delta: nullableText,
    quote_link: z.enum(["selected_quote", "other_quote", "quote_unavailable", "no_quote"]),
    currency: nullableText,
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    total_amount: nullableNumber,
    price_book_version: nullableText,
    requested_at: nullableText,
    approved_at: nullableText,
    accepted_at: nullableText,
    correction_reason: nullableText,
  })
  .strict();

const insuranceSupplementSchema = z
  .object({
    presentation_key: z.string().min(1),
    version: z.number().int().nonnegative().nullable(),
    status: nullableText,
    measurement_state: z.enum(["approved", "missing", "review_required", "unavailable"]),
    evidence_roles: z.array(
      z.enum([
        "Carrier Scope",
        "Code/Manufacturer",
        "Photo",
        "Invoice",
        "Submission",
        "Carrier Response",
      ]),
    ),
    missing_requirements: z.array(
      z.enum([
        "approved_measurement",
        "carrier_scope",
        "code_or_manufacturer",
        "photo",
        "invoice_or_exception",
        "submission_artifact",
        "carrier_response_artifact",
        "source_detail_unavailable",
      ]),
    ),
    invoice_state: z.enum(["recorded", "required", "not_required", "unavailable"]),
    approval_recorded: z.boolean(),
    submission_recorded: z.boolean(),
    carrier_response_recorded: z.boolean(),
    closed_recorded: z.boolean(),
  })
  .strict();

const proposalReadinessSchema = z
  .object({
    state: z.enum(["ready", "review_required", "blocked", "unavailable"]),
    reasons: z.array(
      z.enum([
        "measurement_missing",
        "measurement_source_review_required",
        "takeoff_link_missing",
        "takeoff_not_approved",
        "quote_missing",
        "quote_snapshot_incomplete",
        "quote_not_approved",
        "scope_change_unresolved",
        "proposal_link_mismatch",
        "source_window_partial",
        "stale_source_detail",
      ]),
    ),
  })
  .strict();

const scopeClauseSchema = z
  .object({
    id: z.string().min(1),
    type: nullableText,
    title: nullableText,
    text: nullableText,
    version: nullableText,
    status: nullableText,
    source_ref: nullableText,
    customer_visible: z.boolean(),
    approved_at: nullableText,
  })
  .strict();

export const estimatorWorkbenchResponseSchema = envelopeSchema
  .extend({
    partial_sources: z.array(z.string()),
    job: z
      .object({
        id: z.string().min(1),
        roof_job_id: nullableText,
        job_number: nullableText,
        brand: nullableText,
        service_type: nullableText,
        status: nullableText,
        workflow_profile: nullableText,
      })
      .strict(),
    lineage: z
      .object({
        measurement_to_takeoff: z.enum([
          "linked",
          "no_measurement",
          "no_takeoff",
          "mismatch",
          "unknown",
        ]),
        quote_to_proposal: z.enum(["linked", "no_quote", "no_proposal", "mismatch", "unknown"]),
      })
      .strict(),
    measurements: z
      .object({
        reports: z.array(measurementReportSchema),
        selected: selectedMeasurementSchema.nullable(),
      })
      .strict(),
    takeoffs: z
      .object({
        records: z.array(takeoffSummarySchema),
        selected: selectedTakeoffSchema.nullable(),
      })
      .strict(),
    quote: quoteSchema.nullable(),
    pricing_snapshot: pricingSnapshotSchema,
    quote_revision: quoteRevisionSchema,
    proposal: proposalSchema.nullable(),
    scope_changes: z.array(scopeChangeSchema),
    insurance_supplements: z.array(insuranceSupplementSchema),
    proposal_readiness: proposalReadinessSchema,
    scope_clauses: z.array(scopeClauseSchema),
  })
  .strict();

export type EstimatorWorkbenchResponse = z.infer<typeof estimatorWorkbenchResponseSchema>;
export type EstimatorGeometry = z.infer<typeof geometrySchema>;
