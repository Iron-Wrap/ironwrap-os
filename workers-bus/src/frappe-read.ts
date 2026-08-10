import type { AppEnv } from "./app-types.ts";

export type FrappeDocType = keyof typeof FRAPPE_READ_FIELDS;
export type OfficeProductionDocType =
  keyof typeof OFFICE_PRODUCTION_READ_FIELDS;
export type OfficeSalesDocType = keyof typeof OFFICE_SALES_READ_FIELDS;
export type OfficeEstimatorDocType = keyof typeof OFFICE_ESTIMATOR_READ_FIELDS;
export type OfficeEstimatorDetailDocType =
  keyof typeof OFFICE_ESTIMATOR_DETAIL_READ;
export type CustomerPortalDocType = keyof typeof CUSTOMER_PORTAL_READ_FIELDS;
export type ReceptionLookupDocType = keyof typeof RECEPTION_LOOKUP_READ_FIELDS;
export type FrappeFilter = readonly [
  doctype: FrappeDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type OfficeProductionFrappeFilter = readonly [
  doctype: OfficeProductionDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type OfficeSalesFrappeFilter = readonly [
  doctype: OfficeSalesDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type OfficeEstimatorFrappeFilter = readonly [
  doctype: OfficeEstimatorDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type CustomerPortalFrappeFilter = readonly [
  doctype: CustomerPortalDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type ReceptionLookupFrappeFilter = readonly [
  doctype: ReceptionLookupDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type FrappeRow = Record<string, unknown>;

/**
 * The only DocTypes and fields the PWA BFF may ask the privileged Frappe integration user for.
 * Standard `modified` supports freshness metadata. Field authorization comes only from the
 * explicit Job Assignment domain record; Frappe's generic `_assign` field is intentionally absent.
 */
export const FRAPPE_READ_FIELDS = {
  "Roof Job": [
    "name",
    "roof_job_id",
    "job_number",
    "brand",
    "service_type",
    "job_status",
    "roofing_property",
    "customer",
    "current_gate_state",
    "modified",
  ],
  "Job Assignment": [
    "name",
    "assignment_id",
    "roof_job",
    "assignment_type",
    "status",
    "crew_profile",
    "assigned_user",
    "scheduled_start",
    "scheduled_end",
    "blocker_reason",
    "modified",
  ],
  "Crew Member": [
    "name",
    "parent",
    "parenttype",
    "parentfield",
    "crew_user",
    "crew_role",
    "active",
    "joined_on",
    "left_on",
    "modified",
  ],
  "Roofing Property": [
    "name",
    "address_line1",
    "city",
    "province",
    "postal_code",
    "country",
    "modified",
  ],
  "Roofing Customer": ["name", "display_name", "phone", "modified"],
  "Production Gate State": [
    "name",
    "gate_id",
    "roof_job",
    "gate",
    "state",
    "owner_user",
    "assigned_at",
    "due_at",
    "blocker_reason",
    "modified",
  ],
  "Evidence Item": [
    "name",
    "evidence_id",
    "device_action_id",
    "roof_job",
    "evidence_type",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "customer_safe",
    "correction_of",
    "summary",
    "sync_state",
    "modified",
  ],
  "Field Check-in": [
    "name",
    "checkin_id",
    "device_action_id",
    "roof_job",
    "job_assignment",
    "source_system",
    "capture_actor",
    "submitted_at",
    "status",
    "sync_state",
    "photo_count",
    "blocker_flag",
    "blocker_category",
    "blocker_summary",
    "evidence_ids_json",
    "correction_of",
    "notes",
    "raw_key",
    "modified",
  ],
  "Scope Clause": [
    "name",
    "scope_clause_id",
    "roof_job",
    "clause_type",
    "title",
    "clause_text",
    "version",
    "status",
    "customer_visible",
    "modified",
  ],
  "Measurement Report": [
    "name",
    "measurement_id",
    "roof_job",
    "provider",
    "review_status",
    "parsed_at",
    "modified",
  ],
  "Material Takeoff": [
    "name",
    "takeoff_id",
    "roof_job",
    "measurement_report",
    "status",
    "prepared_at",
    "modified",
  ],
  "Change Order": [
    "name",
    "change_order_id",
    "roof_job",
    "change_number",
    "version",
    "status",
    "title",
    "reason",
    "scope_delta",
    "accepted_at",
    "modified",
  ],
  "Safety Plan": [
    "name",
    "safety_plan_id",
    "roof_job",
    "version",
    "status",
    "effective_date",
    "hazard_summary",
    "controls",
    "emergency_plan",
    "ppe_requirements",
    "weather_limits",
    "modified",
  ],
  "Automation Incident": [
    "name",
    "incident_id",
    "status",
    "severity",
    "category",
    "summary",
    "roof_job",
    "detected_at",
    "modified",
  ],
  "Payment Milestone": [
    "name",
    "payment_milestone_id",
    "roof_job",
    "milestone_type",
    "status",
    "due_date",
    "event_ts",
    "notes",
    "modified",
  ],
  "Lead Envelope": [
    "name",
    "envelope_id",
    "source",
    "event_ts",
    "status",
    "intent_queue",
    "triage_status",
    "contact_name",
    "job_ref",
    "modified",
  ],
  "Supplier Order": [
    "name",
    "supplier_order_id",
    "roof_job",
    "status",
    "prepared_at",
    "requested_delivery_date",
    "delivery_notes",
    "modified",
  ],
} as const;

/**
 * Production runway is a separate office projection. It cannot receive contact links, field
 * blocker text, staff identities, or supplier delivery notes simply because another office read
 * model needs them.
 */
export const OFFICE_PRODUCTION_READ_FIELDS = {
  "Roof Job": [
    "name",
    "job_number",
    "brand",
    "service_type",
    "job_status",
    "modified",
  ],
  "Job Assignment": [
    "name",
    "roof_job",
    "assignment_type",
    "status",
    "scheduled_start",
    "scheduled_end",
    "modified",
  ],
  "Production Gate State": ["name", "roof_job", "gate", "state", "modified"],
  "Supplier Order": [
    "name",
    "roof_job",
    "status",
    "requested_delivery_date",
    "modified",
  ],
  // A schedule request may select only an active crew profile. Individual
  // members, contacts, coverage, and notes stay out of this browser contract.
  "Crew Profile": [
    "name",
    "crew_profile_id",
    "crew_name",
    "status",
    "modified",
  ],
} as const;

/**
 * Sales is the only browser surface allowed to receive office contact and commercial context.
 * It has its own static allowlist so Owner Now and Field Companion never fetch this data just
 * because they happen to use the same Frappe integration credential.
 */
export const OFFICE_SALES_READ_FIELDS = {
  "Lead Envelope": [
    "name",
    "envelope_id",
    "source",
    "event_ts",
    "status",
    "intent_queue",
    "triage_status",
    "triage_summary",
    "contact_name",
    "contact_phone",
    "contact_email",
    "job_ref",
    "modified",
  ],
  "Roof Job": [
    "name",
    "roof_job_id",
    "job_number",
    "brand",
    "service_type",
    "job_status",
    "workflow_profile",
    "lead_envelope",
    "customer",
    "quotation",
    "modified",
  ],
  "Instant Estimate Session": [
    "name",
    "estimate_session_id",
    "lead_envelope",
    "roof_job",
    "source",
    "service_type",
    "status",
    "range_low",
    "range_high",
    "estimate_total",
    "confidence",
    "review_required",
    "reviewed_at",
    "approved_at",
    "assumptions",
    "exclusions",
    "modified",
  ],
  "Customer Quote": [
    "name",
    "customer_quote_id",
    "roof_job",
    "quote_version",
    "status",
    "quote_total",
    "currency",
    "valid_until",
    "payment_status",
    "prepared_at",
    "approved_at",
    "accepted_at",
    "scope_summary",
    "modified",
  ],
  "Proposal Evidence Pack": [
    "name",
    "pack_id",
    "roof_job",
    "quotation",
    "status",
    "prepared_at",
    "approved_at",
    "signed_at",
    "modified",
  ],
  "Communication Consent": [
    "name",
    "consent_id",
    "customer",
    "lead_envelope",
    "roof_job",
    "channel",
    "purpose",
    "status",
    "jurisdiction",
    "consent_basis",
    "captured_at",
    "effective_from",
    "expires_at",
    "revoked_at",
    "modified",
  ],
} as const;

/**
 * Estimator work is commercial and source-sensitive, so it has a separate static contract from
 * both the field packet and Sales Desk. Raw report locations and unbounded evidence JSON never
 * cross the BFF boundary; the fixed direct document readers below use those fields only to derive
 * a safe, bounded workbench projection.
 */
export const OFFICE_ESTIMATOR_READ_FIELDS = {
  "Roof Job": [
    "name",
    "roof_job_id",
    "job_number",
    "brand",
    "service_type",
    "job_status",
    "workflow_profile",
    "quotation",
    "modified",
  ],
  "Measurement Report": [
    "name",
    "measurement_id",
    "roof_job",
    "provider",
    "review_status",
    "parsed_at",
    "approved_at",
    "modified",
  ],
  "Visual Property Model": [
    "name",
    "roof_job",
    "provider",
    "status",
    "confidence",
    "needs_review",
    "captured_at",
    "approved_at",
    "modified",
  ],
  "Roof Area": [
    "name",
    "roof_job",
    "visual_model",
    "measurement_report",
    "modified",
  ],
  "Material Takeoff": [
    "name",
    "takeoff_id",
    "roof_job",
    "measurement_report",
    "status",
    "prepared_at",
    "approved_at",
    "modified",
  ],
  "Customer Quote": [
    "name",
    "customer_quote_id",
    "roof_job",
    "quote_version",
    "status",
    "price_book_version",
    "pricing_effective_at",
    "subtotal",
    "tax_amount",
    "tax_code",
    "tax_rate",
    "quote_total",
    "currency",
    "deposit_amount",
    "amount_due",
    "amount_paid",
    "balance_due",
    "payment_status",
    "payment_due_date",
    "valid_until",
    "prepared_at",
    "approved_at",
    "accepted_at",
    "scope_summary",
    "assumptions",
    "exclusions",
    "supersedes",
    "correction_reason",
    "modified",
  ],
  "Proposal Evidence Pack": [
    "name",
    "pack_id",
    "roof_job",
    "quotation",
    "status",
    "prepared_at",
    "approved_at",
    "signed_at",
    "assumptions",
    "exclusions",
    "modified",
  ],
  "Change Order": [
    "name",
    "change_order_id",
    "roof_job",
    "customer_quote",
    "change_number",
    "version",
    "status",
    "title",
    "reason",
    "scope_delta",
    "currency",
    "subtotal",
    "tax_amount",
    "total_amount",
    "price_book_version",
    "requested_at",
    "approved_at",
    "accepted_at",
    "supersedes",
    "correction_reason",
    "modified",
  ],
  "Insurance Supplement": [
    "name",
    "roof_job",
    "version",
    "status",
    "measurement_report",
    "invoice_required",
    "approved_at",
    "submitted_at",
    "carrier_response_at",
    "closed_at",
    "modified",
  ],
  "Scope Clause": [
    "name",
    "scope_clause_id",
    "roof_job",
    "clause_type",
    "title",
    "clause_text",
    "version",
    "status",
    "source_ref",
    "customer_visible",
    "approved_at",
    "modified",
  ],
} as const;

/**
 * Customer capability links deliberately use a fourth Frappe contract. This is not a filtered
 * version of the office/field contracts: raw storage locations, source systems, internal notes,
 * operator identities, pricing snapshots, and rich proposal content are absent at the boundary.
 * The customer-portal projector applies the publication-state predicates again before returning
 * any record to a browser.
 */
export const CUSTOMER_PORTAL_READ_FIELDS = {
  "Roof Job": [
    "name",
    "roof_job_id",
    "job_number",
    "brand",
    "service_type",
    "job_status",
    "customer",
    "quotation",
    "modified",
  ],
  "Customer Quote": [
    "name",
    "customer_quote_id",
    "roof_job",
    "customer",
    "quote_version",
    "status",
    "quote_total",
    "currency",
    "deposit_amount",
    "amount_due",
    "amount_paid",
    "balance_due",
    "payment_status",
    "payment_due_date",
    "valid_until",
    "approved_at",
    "accepted_at",
    "scope_summary",
    "assumptions",
    "exclusions",
    "modified",
  ],
  "Proposal Evidence Pack": [
    "name",
    "pack_id",
    "roof_job",
    "quotation",
    "status",
    "prepared_at",
    "approved_at",
    "signed_at",
    "modified",
  ],
  "Scope Clause": [
    "name",
    "scope_clause_id",
    "roof_job",
    "customer_quote",
    "clause_type",
    "title",
    "clause_text",
    "version",
    "status",
    "customer_visible",
    "modified",
  ],
  "Evidence Item": [
    "name",
    "evidence_id",
    "roof_job",
    "evidence_type",
    "proof_slot",
    "captured_at",
    "customer_safe",
    "summary",
    "sync_state",
    "modified",
  ],
  "Completion Packet": [
    "name",
    "completion_packet_id",
    "roof_job",
    "status",
    "approved_at",
    "warranty_ready",
    "modified",
  ],
  "Warranty Packet": [
    "name",
    "warranty_packet_id",
    "roof_job",
    "status",
    "material_system",
    "warranty_terms",
    "coverage_start",
    "coverage_years",
    "exclusions",
    "issued_at",
    "modified",
  ],
} as const;

/** Fixed receptionist verification contract. Financials, notes, disputes, and evidence are absent. */
export const RECEPTION_LOOKUP_READ_FIELDS = {
  "Roofing Customer": [
    "name",
    "customer_id",
    "display_name",
    "phone",
    "modified",
  ],
  "Roof Job": [
    "name",
    "roof_job_id",
    "job_status",
    "service_type",
    "roofing_property",
    "customer",
    "modified",
  ],
  "Roofing Property": [
    "name",
    "property_key",
    "address_line1",
    "city",
    "province",
    "postal_code",
    "modified",
  ],
} as const;

/**
 * Frappe's direct-document endpoint returns complete records, including child tables. Only these
 * fixed records need detail reads, and every parent/child field is projected before the
 * result is returned to an app read model.
 */
const OFFICE_ESTIMATOR_DETAIL_READ = {
  "Measurement Report": {
    fields: [
      "name",
      "measurement_id",
      "roof_job",
      "provider",
      "raw_key",
      "roof_graph_revision",
      "roof_graph_json",
      "review_status",
      "parsed_at",
      "approved_at",
      "modified",
    ],
    children: {
      measurements: [
        "metric",
        "value",
        "unit",
        "confidence",
        "source_ref",
        "needs_review",
      ],
    },
  },
  "Visual Property Model": {
    fields: [
      "name",
      "roof_job",
      "provider",
      "status",
      "confidence",
      "needs_review",
      "roof_graph_measurement",
      "roof_graph_revision",
      "screenshots_json",
      "captured_at",
      "approved_at",
      "modified",
    ],
    children: {},
  },
  "Material Takeoff": {
    fields: [
      "name",
      "takeoff_id",
      "roof_job",
      "measurement_report",
      "status",
      "prepared_at",
      "approved_at",
      "assumptions",
      "exclusions",
      "modified",
    ],
    children: {
      items: [
        "category",
        "item_name",
        "quantity",
        "unit",
        "waste_factor",
        "source_ref",
        "confidence",
        "needs_review",
      ],
    },
  },
  "Insurance Supplement": {
    fields: [
      "name",
      "roof_job",
      "version",
      "status",
      "measurement_report",
      "invoice_required",
      "approved_at",
      "submitted_at",
      "carrier_response_at",
      "closed_at",
      "modified",
    ],
    children: {
      evidence: ["evidence_role"],
    },
  },
} as const;

/**
 * The field packet can read one exact Work Package after assignment-scoped selection. This is
 * deliberately a fixed projection: internal release decisions, notes, raw evidence pointers,
 * and every mutable field absent from the worker contract stay server-side. A hold's displayed
 * release-authority label is included only so field users know that the app cannot self-release it.
 */
export const FIELD_WORK_PACKAGE_CURRENT_STATUSES = [
  "Released",
  "Acknowledged",
  "In Progress",
] as const;

const FIELD_WORK_PACKAGE_LIST_READ = {
  "Work Package": [
    "name",
    "work_package_id",
    "roof_job",
    "job_assignment",
    "status",
    "modified",
  ],
} as const;

/**
 * The release ledger is read only to derive a boolean per declared hold point.
 * Event identities, actors, timestamps, payload hashes, and raw evidence locations
 * deliberately never leave this Worker-side verification contract.
 */
const FIELD_WORK_PACKAGE_HOLD_RELEASE_READ = {
  "Work Package Event": [
    "event_type",
    "work_package",
    "roof_job",
    "job_assignment",
    "work_package_version",
    "hold_point_sequence",
    "evidence_item",
  ],
} as const;

const FIELD_WORK_PACKAGE_DETAIL_READ = {
  "Work Package": {
    fields: [
      "name",
      "work_package_id",
      "roof_job",
      "job_assignment",
      "version",
      "status",
      "title",
      "objective",
      "boundaries",
      "prerequisites",
      "expected_result",
      "stop_conditions",
      "make_safe_procedure",
      "issued_at",
      "expires_at",
      "released_at",
      "acknowledged_by",
      "acknowledged_at",
      "modified",
    ],
    children: {
      steps: [
        "sequence",
        "instruction",
        "required_evidence",
        "acceptance_criteria",
      ],
      hold_points: [
        "sequence",
        "hold_point",
        "release_authority",
        "required_evidence",
        "acceptance_criteria",
      ],
    },
  },
} as const;

export function frappeReadConfigured(env: AppEnv): boolean {
  if (!env.ERPNEXT_API_KEY?.trim() || !env.ERPNEXT_API_SECRET?.trim())
    return false;
  try {
    frappeBaseUrl(env);
    return true;
  } catch {
    return false;
  }
}

const FILTER_FIELDS: Readonly<Record<FrappeDocType, ReadonlySet<string>>> = {
  "Roof Job": new Set(["name", "job_status"]),
  "Job Assignment": new Set([
    "name",
    "roof_job",
    "status",
    "assigned_user",
    "crew_profile",
  ]),
  "Crew Member": new Set(["parent", "crew_user", "active"]),
  "Roofing Property": new Set(["name"]),
  "Roofing Customer": new Set(["name"]),
  "Production Gate State": new Set(["roof_job", "state"]),
  "Evidence Item": new Set([
    "name",
    "roof_job",
    "evidence_id",
    "device_action_id",
  ]),
  "Field Check-in": new Set([
    "name",
    "roof_job",
    "checkin_id",
    "device_action_id",
    "blocker_flag",
    "status",
    "sync_state",
  ]),
  "Scope Clause": new Set(["roof_job", "status"]),
  "Measurement Report": new Set(["roof_job", "review_status"]),
  "Material Takeoff": new Set(["roof_job", "status"]),
  "Change Order": new Set(["roof_job", "status"]),
  "Safety Plan": new Set(["roof_job", "status"]),
  "Automation Incident": new Set(["status"]),
  "Payment Milestone": new Set(["status"]),
  "Lead Envelope": new Set(["status", "triage_status"]),
  "Supplier Order": new Set(["roof_job", "status"]),
};

const OFFICE_PRODUCTION_FILTER_FIELDS: Readonly<
  Record<OfficeProductionDocType, ReadonlySet<string>>
> = {
  "Roof Job": new Set(["name", "job_status"]),
  "Job Assignment": new Set(["roof_job", "assignment_type", "status"]),
  "Production Gate State": new Set(["roof_job", "state"]),
  "Supplier Order": new Set(["roof_job", "status"]),
  "Crew Profile": new Set(["status"]),
};

const OFFICE_SALES_FILTER_FIELDS: Readonly<
  Record<OfficeSalesDocType, ReadonlySet<string>>
> = {
  "Lead Envelope": new Set(["name", "triage_status", "status"]),
  "Roof Job": new Set(["name", "lead_envelope"]),
  "Instant Estimate Session": new Set(["lead_envelope", "roof_job", "status"]),
  "Customer Quote": new Set(["roof_job", "status"]),
  "Proposal Evidence Pack": new Set(["roof_job", "quotation", "status"]),
  "Communication Consent": new Set([
    "lead_envelope",
    "roof_job",
    "customer",
    "status",
  ]),
};

const OFFICE_ESTIMATOR_FILTER_FIELDS: Readonly<
  Record<OfficeEstimatorDocType, ReadonlySet<string>>
> = {
  "Roof Job": new Set(["name", "roof_job_id"]),
  "Measurement Report": new Set(["roof_job", "review_status"]),
  "Visual Property Model": new Set(["roof_job", "status"]),
  "Roof Area": new Set([
    "roof_job",
    "visual_model",
    "measurement_report",
    "status",
  ]),
  "Material Takeoff": new Set(["roof_job", "measurement_report", "status"]),
  "Customer Quote": new Set(["roof_job", "status"]),
  "Proposal Evidence Pack": new Set(["roof_job", "quotation", "status"]),
  "Change Order": new Set(["roof_job", "customer_quote", "status"]),
  "Insurance Supplement": new Set(["roof_job", "status"]),
  "Scope Clause": new Set(["roof_job", "status"]),
};

const CUSTOMER_PORTAL_FILTER_FIELDS: Readonly<
  Record<CustomerPortalDocType, ReadonlySet<string>>
> = {
  "Roof Job": new Set(["name"]),
  "Customer Quote": new Set(["roof_job", "status"]),
  "Proposal Evidence Pack": new Set(["roof_job", "quotation", "status"]),
  "Scope Clause": new Set(["roof_job", "status", "customer_visible"]),
  "Evidence Item": new Set(["roof_job", "customer_safe", "sync_state"]),
  "Completion Packet": new Set(["roof_job", "status"]),
  "Warranty Packet": new Set(["roof_job", "status"]),
};

const RECEPTION_LOOKUP_FILTER_FIELDS: Readonly<
  Record<ReceptionLookupDocType, ReadonlySet<string>>
> = {
  "Roofing Customer": new Set(["phone"]),
  "Roof Job": new Set(["customer"]),
  "Roofing Property": new Set(["name"]),
};

const FIELD_WORK_PACKAGE_FILTER_FIELDS: Readonly<
  Record<keyof typeof FIELD_WORK_PACKAGE_LIST_READ, ReadonlySet<string>>
> = {
  "Work Package": new Set(["roof_job", "job_assignment", "status"]),
};

const FIELD_WORK_PACKAGE_HOLD_RELEASE_FILTER_FIELDS: Readonly<
  Record<keyof typeof FIELD_WORK_PACKAGE_HOLD_RELEASE_READ, ReadonlySet<string>>
> = {
  "Work Package Event": new Set([
    "work_package",
    "roof_job",
    "job_assignment",
    "work_package_version",
    "event_type",
  ]),
};

const FILTER_OPERATORS = new Set(["=", "in", "like"]);
const MAX_FRAPPE_READ_RESPONSE_BYTES = 768 * 1024;
const MAX_ESTIMATOR_DETAIL_CHILD_ROWS = 300;

export async function listFrappeResource(
  env: AppEnv,
  doctype: FrappeDocType,
  filters: readonly FrappeFilter[] = [],
  limit = 50,
  parentDoctype?: string,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePage(
    env,
    doctype,
    filters,
    limit,
    0,
    parentDoctype,
  );
}

export async function listFrappeResourcePage(
  env: AppEnv,
  doctype: FrappeDocType,
  filters: readonly FrappeFilter[] = [],
  limit = 50,
  offset = 0,
  parentDoctype?: string,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    offset,
    FRAPPE_READ_FIELDS,
    FILTER_FIELDS,
    parentDoctype,
  );
}

/**
 * Dedicated office-only production runway lookup. Keep this projection separate from the broader
 * field packet contract so production planning cannot accidentally acquire customer or free text.
 */
export async function listOfficeProductionFrappeResource(
  env: AppEnv,
  doctype: OfficeProductionDocType,
  filters: readonly OfficeProductionFrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    0,
    OFFICE_PRODUCTION_READ_FIELDS,
    OFFICE_PRODUCTION_FILTER_FIELDS,
  );
}

/**
 * Deliberately narrow office-only lookup. This is not a generic field selector or an escape hatch
 * around the field/owner read allowlist above.
 */
export async function listOfficeSalesFrappeResource(
  env: AppEnv,
  doctype: OfficeSalesDocType,
  filters: readonly OfficeSalesFrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    0,
    OFFICE_SALES_READ_FIELDS,
    OFFICE_SALES_FILTER_FIELDS,
  );
}

/**
 * Deliberately narrow estimator-only lookup. It cannot request arbitrary Frappe DocTypes,
 * fields, filters, or pagination and therefore cannot widen the Sales/field contracts by accident.
 */
export async function listOfficeEstimatorFrappeResource(
  env: AppEnv,
  doctype: OfficeEstimatorDocType,
  filters: readonly OfficeEstimatorFrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    0,
    OFFICE_ESTIMATOR_READ_FIELDS,
    OFFICE_ESTIMATOR_FILTER_FIELDS,
  );
}

/**
 * Dedicated customer-capability lookup. Callers cannot ask for an office field, arbitrary
 * DocType, or arbitrary filter through this function.
 */
export async function listCustomerPortalFrappeResource(
  env: AppEnv,
  doctype: CustomerPortalDocType,
  filters: readonly CustomerPortalFrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    0,
    CUSTOMER_PORTAL_READ_FIELDS,
    CUSTOMER_PORTAL_FILTER_FIELDS,
  );
}

export async function listReceptionLookupFrappeResource(
  env: AppEnv,
  doctype: ReceptionLookupDocType,
  filters: readonly ReceptionLookupFrappeFilter[],
  limit = 10,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    doctype,
    filters,
    limit,
    0,
    RECEPTION_LOOKUP_READ_FIELDS,
    RECEPTION_LOOKUP_FILTER_FIELDS,
  );
}

/**
 * Read a single, fixed estimator document and project its allowed child-table fields. `raw_key`
 * is intentionally available to the Worker read model only; no caller should expose this row
 * directly to the browser.
 */
export async function readOfficeEstimatorFrappeResource(
  env: AppEnv,
  doctype: OfficeEstimatorDetailDocType,
  name: string,
): Promise<FrappeRow | null> {
  if (!validFrappeDocumentName(name))
    throw new Error("frappe_read_invalid_name");
  const contract = OFFICE_ESTIMATOR_DETAIL_READ[doctype];
  return await readFrappeDocumentForContract(
    env,
    doctype,
    name,
    contract.fields,
    contract.children,
  );
}

/** Read one assignment-selected Work Package through its fixed field packet contract. */
export async function readFieldWorkPackageFrappeResource(
  env: AppEnv,
  name: string,
): Promise<FrappeRow | null> {
  if (!validFrappeDocumentName(name))
    throw new Error("frappe_read_invalid_name");
  const contract = FIELD_WORK_PACKAGE_DETAIL_READ["Work Package"];
  return await readFrappeDocumentForContract(
    env,
    "Work Package",
    name,
    contract.fields,
    contract.children,
  );
}

/**
 * The only list operation for Field Work Packages. It is bound to one
 * assignment and the current status set before any direct detail read.
 */
export async function listFieldWorkPackagesForAssignment(
  env: AppEnv,
  jobId: string,
  assignmentId: string,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePageForContract(
    env,
    "Work Package",
    [
      ["Work Package", "roof_job", "=", jobId],
      ["Work Package", "job_assignment", "=", assignmentId],
      [
        "Work Package",
        "status",
        "in",
        [...FIELD_WORK_PACKAGE_CURRENT_STATUSES],
      ],
    ],
    2,
    0,
    FIELD_WORK_PACKAGE_LIST_READ,
    FIELD_WORK_PACKAGE_FILTER_FIELDS,
  );
}

/**
 * Read only the independently released hold ledger for one already-selected
 * package. A second one-row read detects a response truncated at the maximum
 * number of legal hold points, so an extra event cannot silently look valid.
 */
export async function listFieldWorkPackageHoldReleases(
  env: AppEnv,
  workPackageName: string,
  jobId: string,
  assignmentId: string,
  version: number,
): Promise<FrappeRow[]> {
  const filters = [
    ["Work Package Event", "work_package", "=", workPackageName],
    ["Work Package Event", "roof_job", "=", jobId],
    ["Work Package Event", "job_assignment", "=", assignmentId],
    ["Work Package Event", "work_package_version", "=", version],
    ["Work Package Event", "event_type", "=", "Hold Point Released"],
  ] as const;
  const releases = await listFrappeResourcePageForContract(
    env,
    "Work Package Event",
    filters,
    100,
    0,
    FIELD_WORK_PACKAGE_HOLD_RELEASE_READ,
    FIELD_WORK_PACKAGE_HOLD_RELEASE_FILTER_FIELDS,
  );
  if (releases.length < 100) return releases;
  const extra = await listFrappeResourcePageForContract(
    env,
    "Work Package Event",
    filters,
    1,
    100,
    FIELD_WORK_PACKAGE_HOLD_RELEASE_READ,
    FIELD_WORK_PACKAGE_HOLD_RELEASE_FILTER_FIELDS,
  );
  return extra.length === 0 ? releases : [...releases, ...extra];
}

async function listFrappeResourcePageForContract(
  env: AppEnv,
  doctype: string,
  filters: readonly (readonly [string, string, string, unknown])[],
  limit: number,
  offset: number,
  fieldsByDocType: Readonly<Record<string, readonly string[]>>,
  filterFieldsByDocType: Readonly<Record<string, ReadonlySet<string>>>,
  parentDoctype?: string,
): Promise<FrappeRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("frappe_read_invalid_limit");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
    throw new Error("frappe_read_invalid_offset");
  const fields = fieldsByDocType[doctype];
  const filterFields = filterFieldsByDocType[doctype];
  if (!fields || !filterFields)
    throw new Error("frappe_read_doctype_not_allowed");
  for (const filter of filters) {
    if (
      filter[0] !== doctype ||
      !filterFields.has(filter[1]) ||
      !FILTER_OPERATORS.has(filter[2])
    ) {
      throw new Error("frappe_read_filter_not_allowed");
    }
  }

  const base = frappeBaseUrl(env);
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)
    throw new Error("frappe_read_not_configured");
  const params = new URLSearchParams({
    fields: JSON.stringify(fields),
    filters: JSON.stringify(filters),
    order_by: "modified desc, name desc",
    limit_page_length: String(limit),
    limit_start: String(offset),
  });
  // Frappe refuses child-table reads without the parent doctype as permission
  // context (check_parent_permission); only Crew Member currently needs it.
  if (parentDoctype) params.set("parent", parentDoctype);
  const url = `${base}/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
  const timeout = frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
        "user-agent": "ironwrap-bff/1.0",
      },
    });
    if (!response.ok) throw new Error(`frappe_read_http_${response.status}`);
    const decoded = await boundedFrappeJson(
      response,
      MAX_FRAPPE_READ_RESPONSE_BYTES,
    );
    const data =
      decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as { data?: unknown }).data
        : null;
    if (!Array.isArray(data)) throw new Error("frappe_read_invalid_shape");
    return data
      .slice(0, limit)
      .filter(isRecord)
      .map((row) => projectRow(fields, row));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("frappe_read_timeout");
    if (error instanceof Error && error.message.startsWith("frappe_read_"))
      throw error;
    throw new Error("frappe_read_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function readFrappeDocumentForContract(
  env: AppEnv,
  doctype: string,
  name: string,
  fields: readonly string[],
  children: Readonly<Record<string, readonly string[]>>,
): Promise<FrappeRow | null> {
  const base = frappeBaseUrl(env);
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)
    throw new Error("frappe_read_not_configured");
  const url = `${base}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
  const timeout = frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
        "user-agent": "ironwrap-bff/1.0",
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`frappe_read_http_${response.status}`);
    const decoded = await boundedFrappeJson(
      response,
      MAX_FRAPPE_READ_RESPONSE_BYTES,
    );
    const data =
      decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as { data?: unknown }).data
        : null;
    if (!isRecord(data)) throw new Error("frappe_read_invalid_shape");
    return projectDetailRow(fields, children, data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("frappe_read_timeout");
    if (error instanceof Error && error.message.startsWith("frappe_read_"))
      throw error;
    throw new Error("frappe_read_network_error");
  } finally {
    clearTimeout(timer);
  }
}

export function publicFrappeRow(row: FrappeRow): FrappeRow {
  return { ...row };
}

function projectRow(fields: readonly string[], row: FrappeRow): FrappeRow {
  const allowed = new Set<string>(fields);
  const projected: FrappeRow = {};
  for (const [key, value] of Object.entries(row))
    if (allowed.has(key)) projected[key] = value;
  return projected;
}

function projectDetailRow(
  fields: readonly string[],
  children: Readonly<Record<string, readonly string[]>>,
  row: FrappeRow,
): FrappeRow {
  const projected = projectRow(fields, row);
  for (const [field, childFields] of Object.entries(children)) {
    const value = row[field];
    if (!Array.isArray(value)) continue;
    const children: FrappeRow[] = [];
    for (const child of value) {
      if (!isRecord(child)) continue;
      children.push(projectRow(childFields, child));
      if (children.length === MAX_ESTIMATOR_DETAIL_CHILD_ROWS) break;
    }
    projected[field] = children;
    if (value.length > children.length)
      projected[`__ironwrap_truncated_${field}`] = true;
  }
  return projected;
}

async function boundedFrappeJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // A malformed upstream stream must not turn an over-limit response into a different error.
    }
    throw new Error("frappe_read_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("frappe_read_invalid_json");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already over the boundary; cancellation failure must not mask that fact.
        }
        throw new Error("frappe_read_response_too_large");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("frappe_read_"))
      throw error;
    throw new Error("frappe_read_network_error");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("frappe_read_invalid_json");
  }
}

function validFrappeDocumentName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _.#:()\-]{0,139}$/.test(value);
}

export function frappeBaseUrl(env: AppEnv): string {
  if (!env.ERPNEXT_BASE_URL) throw new Error("frappe_read_not_configured");
  let url: URL;
  try {
    url = new URL(env.ERPNEXT_BASE_URL);
  } catch {
    throw new Error("frappe_read_bad_base_url");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "https:" &&
    !(
      String(env.APP_ALLOW_INSECURE_LOCAL) === "true" &&
      local &&
      url.protocol === "http:"
    )
  ) {
    throw new Error("frappe_read_bad_base_url");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("frappe_read_bad_base_url");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function frappeRequestTimeout(raw: string | undefined): number {
  const parsed = Number(raw ?? "8000");
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 20_000
    ? parsed
    : 8_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
