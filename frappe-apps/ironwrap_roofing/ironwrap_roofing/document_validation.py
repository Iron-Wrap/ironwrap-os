"""Thin Frappe adapter for the pure IronWrap domain policy."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
from typing import Any

import frappe

from ironwrap_roofing.access_control import (
    CUSTOMER_ACCEPTANCE_SERVICE_ROLE,
    CUSTOMER_DECISION_SERVICE_ROLE,
    FACET_DESIGN_PROJECTION_SERVICE_ROLE,
)
from ironwrap_roofing.domain_policy import PolicyViolation, validate_record
from ironwrap_roofing.domain_policy import (
    ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES,
    CARGO_LOAD_RELEASE_FENCE_STATUSES,
    JOB_COST_EVENT_SOURCE_DOCTYPES,
    OPEN_OUT_OF_SERVICE_DEFECT_STATUSES,
    SHOP_ORDER_FINAL_STATUSES,
    parse_json_field,
)


CORRECTION_TARGETS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "asset_custody_event": ("supersedes", "Asset Custody Event", ("fleet_asset",)),
    "asset_inspection": ("supersedes", "Asset Inspection", ("fleet_asset", "roof_job")),
    "asset_usage_log": ("supersedes", "Asset Usage Log", ("fleet_asset", "roof_job")),
    "cargo_load": ("supersedes", "Cargo Load", ("roof_job", "version")),
    "change_order": ("supersedes", "Change Order", ("roof_job", "version")),
    "communication_consent": ("supersedes", "Communication Consent", ("roof_job",)),
    "contract_acceptance": ("supersedes", "Contract Acceptance", ("roof_job",)),
    "customer_decision": ("supersedes", "Customer Decision", ("roof_job",)),
    "customer_quote": (
        "supersedes",
        "Customer Quote",
        ("roof_job", "customer", "quote_version", "status", "contract_acceptance", "accepted_at"),
    ),
    "driver_authority": ("supersedes", "Driver Authority", ("driver_user", "version")),
    "evidence_item": ("correction_of", "Evidence Item", ("roof_job",)),
    "fleet_asset": ("supersedes", "Fleet Asset", ("asset_kind", "version")),
    "field_check_in": ("correction_of", "Field Check-in", ("roof_job",)),
    "integration_reconciliation": (
        "supersedes",
        "Integration Reconciliation",
        ("roof_job",),
    ),
    "insurance_supplement": (
        "supersedes",
        "Insurance Supplement",
        ("roof_job", "version"),
    ),
    "job_assignment": ("supersedes", "Job Assignment", ("roof_job",)),
    "job_compliance_record": (
        "supersedes",
        "Job Compliance Record",
        ("roof_job",),
    ),
    "payment_milestone": (
        "supersedes",
        "Payment Milestone",
        ("roof_job", "milestone_version"),
    ),
    "safety_plan": ("supersedes", "Safety Plan", ("roof_job", "version")),
    "tenant_export_run": ("supersedes", "Tenant Export Run", ("tenant",)),
    "work_package": ("supersedes", "Work Package", ("roof_job", "version")),
}

SAFETY_ACKNOWLEDGEMENT_FIELDS = (
    "acknowledged_by",
    "acknowledged_at",
    "acknowledgement_method",
    "device_action_id",
    "evidence_item",
    "role_on_job",
    "notes",
)
SAFETY_ACKNOWLEDGEMENT_DEVICE_ACTION_INDEX = SAFETY_ACKNOWLEDGEMENT_FIELDS.index(
    "device_action_id"
)
SAFETY_PLAN_FROZEN_FIELDS = (
    "safety_plan_id",
    "roof_job",
    "version",
    "effective_date",
    "prepared_by",
    "prepared_at",
    "hazard_summary",
    "controls",
    "emergency_plan",
    "ppe_requirements",
    "weather_limits",
    "evidence_item",
    "approved_by",
    "approved_at",
    "supersedes",
    "correction_reason",
    "notes",
)
LEAD_TRIAGE_FIELDS = (
    "triage_status",
    "triaged_by",
    "triaged_at",
    "triage_summary",
)
PRODUCTION_GATE_CONTEXT_FIELDS = (
    "roof_job",
    "gate",
    "state",
    "owner_user",
    "assigned_at",
    "due_at",
    "blocker_reason",
    "evidence_item",
    "waived_by",
    "waived_at",
    "waiver_reason",
)
_PRODUCTION_GATE_CONTEXT_SELECT = ", ".join(PRODUCTION_GATE_CONTEXT_FIELDS)
GATE_EVIDENCE_CONTEXT_FIELDS = (
    "name",
    "roof_job",
    "sync_state",
    "content_checksum",
    "checksum_algorithm",
    "verified_at",
    "verification_source",
    "source_uri",
    "r2_key",
    "drive_file_id",
)
_GATE_EVIDENCE_CONTEXT_SELECT = ", ".join(GATE_EVIDENCE_CONTEXT_FIELDS)
JOB_ASSIGNMENT_SCHEDULE_CONTEXT_FIELDS = (
    "name",
    "assignment_id",
    "roof_job",
    "assignment_type",
    "status",
    "crew_profile",
    "assigned_user",
    "assigned_by",
    "assigned_at",
    "authority_user",
    "authority_role",
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
    "authority_requirements_json",
    "scheduled_start",
    "scheduled_end",
    "supersedes",
)
_JOB_ASSIGNMENT_SCHEDULE_CONTEXT_SELECT = ", ".join(
    JOB_ASSIGNMENT_SCHEDULE_CONTEXT_FIELDS
)
CREW_PROFILE_CONTEXT_FIELDS = (
    "name",
    "crew_profile_id",
    "status",
    "crew_type",
    "competency_status",
    "competency_checked_at",
    "competency_expiry",
    "equipment_status",
    "equipment_checked_at",
    "equipment_expiry",
    "wcb_status",
    "wcb_checked_at",
    "wcb_expiry",
    "active_stop",
    "active_stop_at",
    "active_stop_reason",
)
_CREW_PROFILE_CONTEXT_SELECT = ", ".join(CREW_PROFILE_CONTEXT_FIELDS)
JOB_COMPLIANCE_CONTEXT_FIELDS = (
    "name",
    "compliance_record_id",
    "roof_job",
    "required_before_gate",
    "status",
    "effective_date",
    "expiry_date",
    "supersedes",
    "authority_record",
)
_JOB_COMPLIANCE_CONTEXT_SELECT = ", ".join(JOB_COMPLIANCE_CONTEXT_FIELDS)
SAFETY_PLAN_CONTEXT_FIELDS = (
    "name",
    "safety_plan_id",
    "roof_job",
    "version",
    "status",
    "supersedes",
)
_SAFETY_PLAN_CONTEXT_SELECT = ", ".join(SAFETY_PLAN_CONTEXT_FIELDS)
WORK_PACKAGE_CONTEXT_FIELDS = (
    "name",
    "work_package_id",
    "roof_job",
    "job_assignment",
    "safety_plan",
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
    "version",
    "status",
    "authority_requirements_json",
    "supersedes",
)
_WORK_PACKAGE_CONTEXT_SELECT = ", ".join(WORK_PACKAGE_CONTEXT_FIELDS)
AUTHORITY_RECORD_CONTEXT_FIELDS = (
    "name",
    "authority_record_id",
    "tenant",
    "subject_type",
    "subject_role",
    "person_user",
    "organization",
    "authority_kind",
    "authority_scope",
    "scope_type",
    "scope_ref",
    "roof_job",
    "scope_json",
    "issuer_name",
    "issuer_jurisdiction",
    "issuer_reference",
    "source_version",
    "evidence_refs_json",
    "evidence_sha256",
    "issuer_readback_json",
    "effective_from",
    "expires_at",
    "version",
    "status",
    "state_digest_sha256",
    "verification_method",
    "verified_at",
    "verification_reference",
    "verified_by",
    "revoked_at",
    "revocation_reference",
    "revoked_by",
    "supersedes",
    "correction_reason",
    "exception_status",
    "exception_reason",
)
_AUTHORITY_RECORD_CONTEXT_SELECT = ", ".join(AUTHORITY_RECORD_CONTEXT_FIELDS)
SUPPLIER_ORDER_EXCEPTION_CONTEXT_FIELDS = (
    "name",
    "supplier_order_id",
    "roof_job",
    "status",
)
_SUPPLIER_ORDER_EXCEPTION_CONTEXT_SELECT = ", ".join(
    SUPPLIER_ORDER_EXCEPTION_CONTEXT_FIELDS
)
FLEET_ASSET_CONTEXT_FIELDS = (
    "name",
    "fleet_asset_id",
    "asset_kind",
    "status",
    "required_licence_class",
    "payload_capacity_kg",
    "gvwr_kg",
    "meter_kind",
    "inspection_authority_source",
    "next_inspection_due",
    "next_service_due_date",
    "calibration_required",
    "next_calibration_due",
    "registration_expiry",
    "insurance_expiry",
    "custody_holder_type",
    "custody_crew_profile",
    "custody_user",
)
_FLEET_ASSET_CONTEXT_SELECT = ", ".join(FLEET_ASSET_CONTEXT_FIELDS)
DRIVER_AUTHORITY_CONTEXT_FIELDS = (
    "name",
    "driver_authority_id",
    "driver_user",
    "status",
    "authority_source",
    "licence_class",
    "licence_expiry",
    "medical_expiry",
)
_DRIVER_AUTHORITY_CONTEXT_SELECT = ", ".join(DRIVER_AUTHORITY_CONTEXT_FIELDS)
CARGO_LOAD_CONTEXT_FIELDS = (
    "name",
    "cargo_load_id",
    "roof_job",
    "fleet_asset",
    "trailer_asset",
    "job_assignment",
    "driver_authority",
    "driver_user",
    "status",
    "loaded_weight_kg",
    "custody_holder_type",
    "custody_crew_profile",
    "custody_user",
)
_CARGO_LOAD_CONTEXT_SELECT = ", ".join(CARGO_LOAD_CONTEXT_FIELDS)
_CARGO_LOAD_FENCE_STATUSES = tuple(sorted(CARGO_LOAD_RELEASE_FENCE_STATUSES))
_CARGO_LOAD_FENCE_STATUS_PLACEHOLDERS = ", ".join(
    "%s" for _ in _CARGO_LOAD_FENCE_STATUSES
)
ASSET_INSPECTION_CONTEXT_FIELDS = (
    "name",
    "asset_inspection_id",
    "fleet_asset",
    "inspection_type",
    "status",
    "result",
    "performed_at",
)
ASSET_INSPECTION_RUNTIME_FIELDS = (
    "status",
    "result",
    "performed_by",
    "performed_at",
    "defect_count",
    "sync_state",
    "verified_at",
    "evidence_item",
)
CARGO_LOAD_RUNTIME_FIELDS = (
    "status",
    "loaded_by",
    "loaded_at",
    "loaded_weight_kg",
    "departed_at",
    "delivered_at",
    "delivery_evidence",
    "returned_at",
    "return_evidence",
    "reconciled_by",
    "reconciled_at",
    "lines",
)
SUPPLIER_ORDER_EVIDENCE_CONTEXT_FIELDS = (
    "name",
    "roof_job",
    "proof_slot",
    "sync_state",
    "content_checksum",
    "checksum_algorithm",
    "verified_at",
    "verification_source",
    "source_uri",
    "r2_key",
    "drive_file_id",
)
_ATOMIC_SAFETY_ACKNOWLEDGEMENT_APPEND: ContextVar[tuple[str, str] | None] = ContextVar(
    "ironwrap_atomic_safety_acknowledgement_append",
    default=None,
)
_APPROVED_LEAD_TRIAGE_TRANSITION: ContextVar[
    tuple[str, str, str, str, str] | None
] = ContextVar(
    "ironwrap_approved_lead_triage_transition",
    default=None,
)
_APPROVED_PROPOSAL_PUBLICATION: ContextVar[
    tuple[str, str, str, str] | None
] = ContextVar(
    "ironwrap_approved_proposal_publication",
    default=None,
)
_TRUSTED_FIELD_EVIDENCE_ISSUANCE: ContextVar[
    tuple[tuple[str, str], ...] | None
] = ContextVar(
    "ironwrap_trusted_field_evidence_issuance",
    default=None,
)
_TRUSTED_QUICKBOOKS_RECONCILIATION_ISSUANCE: ContextVar[
    tuple[tuple[str, str], ...] | None
] = ContextVar(
    "ironwrap_trusted_quickbooks_reconciliation_issuance",
    default=None,
)
_TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_quickbooks_final_invoice_bind", default=None)
_TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_quickbooks_final_invoice_resolver", default=None)
_TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE: ContextVar[Any | None] = ContextVar(
    "ironwrap_trusted_customer_contract_acceptance",
    default=None,
)
# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era. The Won
# transition moves to the D1-native acceptance path once IRO-195 defines a
# Won-equivalent stage in `operating_roof_jobs.job_status`; delete this ContextVar,
# `customer_contract_job_transition_context`, the CUSTOMER_CONTRACT_JOB_* field tuples
# and `validate_customer_contract_job_transition_mutation` together when Frappe stops
# being written for new jobs.
_TRUSTED_CUSTOMER_CONTRACT_JOB_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar(
    "ironwrap_trusted_customer_contract_job_transition",
    default=None,
)
_TRUSTED_FACET_DESIGN_PROJECTION: ContextVar[Any | None] = ContextVar(
    "ironwrap_trusted_facet_design_projection",
    default=None,
)
_TRUSTED_CUSTOMER_DECISION: ContextVar[Any | None] = ContextVar(
    "ironwrap_trusted_customer_decision",
    default=None,
)
# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded by
# IRO-195's D1-native production-gate state; delete this ContextVar,
# `PRODUCTION_GATE_CLEARANCE_EVIDENCE_FIELDS`,
# `_production_gate_clearance_evidence_snapshot`, `production_gate_clearance_context`,
# `_production_gate_clearance_waiver_actor` and their two call sites below together
# with `production_gate_api`, when the runway's gate rows stop living in Frappe.
#
# What one bounded production-gate clearance is allowed to do: `(gate_name,
# waiver_actor, evidence_snapshot)`.  It never widens gate authority - that already
# belongs to IronWrap Owner and IronWrap Production in `access_control` - it only
# names the one gate, the one Evidence Item minted from the Worker's stored receipt,
# and the one human a waiver is attributed to.
_TRUSTED_PRODUCTION_GATE_CLEARANCE: ContextVar[
    tuple[str, str | None, tuple[tuple[str, str], ...] | None] | None
] = ContextVar("ironwrap_trusted_production_gate_clearance", default=None)
_TRUSTED_WORK_PACKAGE_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar(
    "ironwrap_trusted_work_package_transition",
    default=None,
)
_TRUSTED_WORK_PACKAGE_EVENT_ISSUANCE: ContextVar[
    tuple[tuple[str, str], ...] | None
] = ContextVar(
    "ironwrap_trusted_work_package_event_issuance",
    default=None,
)
_TRUSTED_CONTROLLED_ITEM_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_controlled_item_transition", default=None)
_TRUSTED_MATERIAL_LOT_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_material_lot_transition", default=None)
_TRUSTED_NONCONFORMANCE_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_nonconformance_transition", default=None)
_TRUSTED_ASSET_INSPECTION_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_asset_inspection_transition", default=None)
_TRUSTED_CARGO_LOAD_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_cargo_load_transition", default=None)
_TRUSTED_SHOP_ORDER_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_shop_order_transition", default=None)

# A Field Companion verification is a service fact, not a value a Desk/REST
# caller may write into an Evidence Item.  The narrow issuer command builds
# this exact snapshot after it has authenticated the dedicated Worker user.
# Keep it separate from the pure domain policy: that policy intentionally
# remains usable for offline contract validation without a Frappe request.
FIELD_EVIDENCE_ISSUANCE_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "work_package",
    "work_package_version",
    "work_package_release_attempt_id",
    "evidence_slot_id",
    "evidence_requirement",
    "evidence_source",
    "evidence_device_id",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "source_uri",
    "r2_key",
    "drive_file_id",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "latitude",
    "longitude",
    "location_accuracy_m",
    "sync_state",
    "verified_at",
    "verification_source",
    "evidence_freshness",
    "evidence_conflict_state",
    "evidence_verification",
    "evidence_disposition",
    "correction_of",
    "correction_reason",
    "customer_safe",
    "summary",
)
QUICKBOOKS_RECONCILIATION_ISSUANCE_FIELDS = (
    "reconciliation_id",
    "roof_job",
    "system_name",
    "entity_type",
    "external_entity_id",
    "realm_id",
    "local_doctype",
    "local_name",
    "direction",
    "status",
    "detected_at",
    "raw_key",
    "source_version",
    "source_payload_hash",
    "local_payload_hash",
    "attempt_count",
    "notes",
)
QUICKBOOKS_FINAL_INVOICE_FIELDS = (
    "status",
    "roof_job",
    "shop_order",
    "milestone_type",
    "milestone_version",
    "currency",
    "subtotal",
    "tax_amount",
    "total_amount",
    "amount_due",
    "amount_paid",
    "balance_due",
    "due_date",
    "payment_status",
    "price_book_version",
    "tax_code",
    "tax_rate",
    "tax_policy_snapshot_json",
    "truth_source",
    "truth_at",
    "qb_entity_type",
    "qb_entity_id",
    "qb_operation",
    "realm_id",
    "invoice_intent_id",
    "billing_basis_sha256",
    "billing_basis_json",
    "provider_request_sha256",
    "provider_create_response_sha256",
    "provider_created_at",
    "provider_readback_sha256",
    "provider_facts_sha256",
    "provider_read_at",
    "system_name",
    "entity_type",
    "external_entity_id",
    "local_doctype",
    "local_name",
    "direction",
    "detected_at",
    "raw_key",
    "source_version",
    "source_amount",
    "local_amount",
    "diff_json",
    "source_payload_hash",
    "local_payload_hash",
    "last_attempt_at",
    "attempt_count",
    "resolution_action",
    "notes",
)
CUSTOMER_CONTRACT_EVIDENCE_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "sync_state",
    "verified_at",
    "verification_source",
    "customer_safe",
    "summary",
)
CUSTOMER_CONTRACT_ACCEPTANCE_FIELDS = (
    "acceptance_id",
    "roof_job",
    "customer",
    "customer_quote",
    "proposal_evidence_pack",
    "change_order",
    "contract_version",
    "status",
    "signer_name",
    "signer_email",
    "signer_ip",
    "accepted_at",
    "acceptance_method",
    "evidence_item",
    "terms_hash",
    "terms_snapshot_json",
    "document_checksum",
    "source_system",
    "provider_reference",
    "captured_by",
    "supersedes",
    "correction_reason",
    "notes",
)
CUSTOMER_QUOTE_ACCEPTANCE_FIELDS = (
    "status",
    "acceptance_evidence",
    "contract_acceptance",
    "accepted_at",
)
# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded by
# IRO-195's D1-native acceptance transition; delete with the guard below when Frappe
# stops being written for new jobs.
#
# The only Roof Job fields the bounded acceptance command may move, and every other
# field it must leave exactly as it found them.  Split rather than merged so a field
# added to Roof Job later cannot silently join the mutable set: `test_document_validation`
# asserts the two tuples together cover every Roof Job data field.
CUSTOMER_CONTRACT_JOB_TRANSITION_FIELDS = (
    "job_status",
    "workflow_profile",
    "locale_policy_version",
    "locale_policy_snapshot_json",
)
CUSTOMER_CONTRACT_JOB_LINEAGE_FIELDS = (
    "roof_job_id",
    "job_number",
    "brand",
    "service_type",
    "lead_envelope",
    "roofing_property",
    "customer",
    "quotation",
    "current_gate_state",
    "jobnimbus_contact_id",
    "jobnimbus_job_id",
    "qb_realm_id",
    "qb_invoice_ref",
)
# The statuses a job may still be in when its customer signs.  A job already at Won or
# past it (or explicitly Lost) is left alone: its later lifecycle belongs to production
# and closeout, not to the acceptance command.
CUSTOMER_CONTRACT_JOB_TENTATIVE_STATUSES = frozenset(
    {"Qualified", "Measurement", "Proposal"}
)
# Every durable fact the bounded portal-decision command derives for its receipt. Kept
# as its own tuple rather than shared with the acceptance lane: the two identities are
# deliberately separate, and a field one lane later adds must not silently widen the other.
CUSTOMER_DECISION_EVIDENCE_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "sync_state",
    "verified_at",
    "verification_source",
    "customer_safe",
    "summary",
)
# The four Select fields Frappe fills from their own defaults during `insert()` -
# `evidence_freshness`, `evidence_conflict_state`, `evidence_verification` and
# `evidence_disposition` - are deliberately absent, exactly as they are from the
# contract-acceptance and portal-decision receipt tuples above: the snapshot is
# taken before the insert, so including a field the framework is about to fill
# would make every legitimate issuance look like drift (ELEC-117 finding 1).
# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era.  The receipt
# this tuple describes is minted Worker-side and stored in R2 before Frappe is called;
# only the Evidence Item projection of it retires with the gate rows.
PRODUCTION_GATE_CLEARANCE_EVIDENCE_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "sync_state",
    "verified_at",
    "verification_source",
    "customer_safe",
    "summary",
)
FACET_DESIGN_PROJECTION_EVIDENCE_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "lead_envelope",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "source_uri",
    "r2_key",
    "drive_file_id",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "latitude",
    "longitude",
    "location_accuracy_m",
    "sync_state",
    "verified_at",
    "verification_source",
    "correction_of",
    "correction_reason",
    "customer_safe",
    "summary",
)
FACET_DESIGN_PROJECTION_RECONCILIATION_FIELDS = (
    "reconciliation_id",
    "roof_job",
    "system_name",
    "entity_type",
    "external_entity_id",
    "local_doctype",
    "local_name",
    "direction",
    "status",
    "detected_at",
    "raw_key",
    "source_version",
    "source_amount",
    "local_amount",
    "currency",
    "source_payload_hash",
    "local_payload_hash",
    "last_attempt_at",
    "attempt_count",
    "resolution_action",
    "resolved_by",
    "resolved_at",
    "resolution_evidence",
    "automation_incident",
    "supersedes",
    "correction_reason",
    "notes",
    "diff_json",
)
FACET_DESIGN_PROJECTION_QUOTE_FIELDS = (
    "customer_quote_id",
    "roof_job",
    "customer",
    "quote_version",
    "status",
    "price_book_version",
    "pricing_effective_at",
    "price_rule_snapshot_json",
    "subtotal",
    "tax_amount",
    "tax_code",
    "tax_rate",
    "tax_policy_snapshot_json",
    "quote_total",
    "currency",
    "deposit_amount",
    "amount_due",
    "amount_paid",
    "balance_due",
    "payment_status",
    "payment_due_date",
    "payment_truth_source",
    "payment_truth_at",
    "qb_item_ref",
    "qb_tax_code_ref",
    "qb_terms_ref",
    "qb_terms_due_days",
    "valid_until",
    "prepared_at",
    "approved_by",
    "approved_at",
    "acceptance_evidence",
    "contract_acceptance",
    "accepted_at",
    "scope_summary",
    "assumptions",
    "exclusions",
    "quote_summary_json",
    "supersedes",
    "correction_reason",
    "notes",
)
# A projection's source/quote binding is immutable, but its reconciliation is
# still a governed workflow.  Keep the two concerns separate so a human can
# resolve the pending discrepancy without rewriting the evidence it is about.
FACET_DESIGN_PROJECTION_RECONCILIATION_LIFECYCLE_FIELDS = (
    "status",
    "resolution_action",
    "resolved_by",
    "resolved_at",
    "resolution_evidence",
    "automation_incident",
    "supersedes",
    "correction_reason",
)
FACET_DESIGN_PROJECTION_RECONCILIATION_ANCHOR_FIELDS = tuple(
    field
    for field in FACET_DESIGN_PROJECTION_RECONCILIATION_FIELDS
    if field not in FACET_DESIGN_PROJECTION_RECONCILIATION_LIFECYCLE_FIELDS
)
FACET_DESIGN_PROJECTION_SOURCE_SYSTEM = "ironwrap-facet-design"
FACET_DESIGN_PROJECTION_VERIFICATION_SOURCE = "ironwrap-worker-r2-facet-design-projection"
WORK_PACKAGE_RUNTIME_FIELDS = (
    "status",
    "released_by",
    "released_at",
    "release_attempt_id",
    "acknowledged_by",
    "acknowledged_at",
    "acknowledgement_device_action_id",
    "started_at",
    "blocked_by",
    "blocked_at",
    "blocked_device_action_id",
    "blocker_reason",
    "completed_at",
)
WORK_PACKAGE_EVENT_ISSUANCE_FIELDS = (
    "work_package_event_id",
    "event_type",
    "work_package",
    "roof_job",
    "job_assignment",
    "work_package_version",
    "release_attempt_id",
    "actor_user",
    "actor_role",
    "device_action_id",
    "occurred_at",
    "payload_hash",
    "hold_point_sequence",
    "evidence_item",
    "blocker_reason",
    "evidence_slot_id",
    "evidence_requirement",
    "evidence_source",
    "evidence_device_id",
    "evidence_captured_at",
    "evidence_freshness",
    "evidence_conflict_state",
    "evidence_correction_of",
    "evidence_item_correction_of",
    "evidence_review_of",
    "evidence_verification",
    "evidence_disposition",
    "correction_reason",
)
CONTROLLED_ITEM_RUNTIME_FIELDS = (
    "status",
    "approved_by",
    "approved_at",
    "approval_note",
)
MATERIAL_LOT_RUNTIME_FIELDS = (
    "status",
    "available_quantity",
    "reserved_quantity",
    "consumed_quantity",
)
NONCONFORMANCE_RUNTIME_FIELDS = (
    "status",
    "containment",
    "disposition",
    "disposition_by",
    "disposition_at",
    "closed_by",
    "closed_at",
    "closure_evidence",
)
SHOP_ORDER_RUNTIME_FIELDS = (
    "status",
    "released_by",
    "released_at",
    "reserved_at",
    "setup_started_at",
    "fabrication_started_at",
    "quality_hold_reason",
    "ready_at",
    "handed_over_to",
    "handed_over_at",
    "handoff_evidence",
    "invoice_payment_milestone",
    "invoice_ready_at",
    "closed_at",
    "lines",
    "material_allocations",
    "operations",
    "yields",
    "inspections",
    "bundles",
)
SHOP_ORDER_LIFECYCLE_FIELDS = SHOP_ORDER_RUNTIME_FIELDS[:14]
PRICE_POLICY_APPROVER_ROLES = frozenset(("IronWrap Owner", "System Manager"))


def _as_dict(document: Any) -> Any:
    if document is None:
        return None
    converter = getattr(document, "as_dict", None)
    return converter() if callable(converter) else document


def _previous(document: Any) -> Any:
    getter = getattr(document, "get_doc_before_save", None)
    return _as_dict(getter()) if callable(getter) else None


def _set_document_value(document: Any, field: str, value: Any) -> None:
    setter = getattr(document, "set", None)
    if callable(setter):
        setter(field, value)
    else:
        document[field] = value


def _server_approval_utc_timestamp() -> str:
    """Return the canonical UTC value stored in Frappe's timezone-free Datetime."""

    return datetime.now(timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def _valid_frappe_approver(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 254:
        return False
    if value == "Administrator":
        return True
    if any(character.isspace() for character in value) or value.count("@") != 1:
        return False
    local, domain = value.split("@", 1)
    return bool(local and domain and "." in domain and not domain.startswith(".") and not domain.endswith("."))


def validate_price_policy_approval_mutation(document: Any) -> None:
    """Make the composite pricing-policy approval transition server-owned."""

    if document.get("rule_type") != "Pricing Policy":
        return
    previous = _previous(document)
    previous_status = previous.get("status") if previous is not None else None
    status = document.get("status")

    if status == "Approved" and previous_status != "Approved":
        actor = getattr(getattr(frappe, "session", None), "user", None)
        if not _valid_frappe_approver(actor):
            frappe.throw(
                "Pricing Policy approval requires a current authenticated Frappe user.",
                exc=frappe.PermissionError,
            )
        if not PRICE_POLICY_APPROVER_ROLES.intersection(frappe.get_roles(actor)):
            frappe.throw(
                "Pricing Policy approval requires an IronWrap Owner or System Manager role.",
                exc=frappe.PermissionError,
            )
        if not isinstance(document.get("source_ref"), str) or not document.get(
            "source_ref"
        ).strip():
            frappe.throw(
                "Pricing Policy approval requires an explicit source reference.",
                exc=frappe.ValidationError,
            )
        if not isinstance(document.get("approval_note"), str) or not document.get(
            "approval_note"
        ).strip():
            frappe.throw(
                "Pricing Policy approval requires an explicit approval note.",
                exc=frappe.ValidationError,
            )
        _set_document_value(document, "approved_by", actor)
        _set_document_value(document, "approved_at", _server_approval_utc_timestamp())
        return

    if status == "Retired" and previous_status not in {"Approved", "Retired"}:
        frappe.throw(
            "A Pricing Policy can be retired only after approval.",
            exc=frappe.ValidationError,
        )
    if previous_status not in {"Approved", "Retired"} and any(
        document.get(field) for field in ("approved_by", "approved_at")
    ):
        frappe.throw(
            "Pricing Policy approval attribution is server-owned.",
            exc=frappe.ValidationError,
        )


def _acknowledgement_snapshot(document: Any) -> tuple[tuple[str, ...], ...]:
    rows = document.get("acknowledgements") or []
    return tuple(
        tuple(
            "" if row.get(field) is None else str(row.get(field))
            for field in SAFETY_ACKNOWLEDGEMENT_FIELDS
        )
        for row in rows
    )


def _safety_plan_content_snapshot(document: Any) -> tuple[str, ...]:
    return tuple(
        "" if document.get(field) is None else str(document.get(field))
        for field in SAFETY_PLAN_FROZEN_FIELDS
    )


def _lead_triage_snapshot(document: Any) -> tuple[str, str, str, str]:
    """Normalize the four locally-owned triage fields for mutation checks."""

    status = document.get("triage_status") or "Unknown"
    return (
        str(status),
        "" if document.get("triaged_by") is None else str(document.get("triaged_by")),
        "" if document.get("triaged_at") is None else str(document.get("triaged_at")),
        "" if document.get("triage_summary") is None else str(document.get("triage_summary")),
    )


def _proposal_publication_snapshot(document: Any) -> tuple[str, str, str]:
    """Normalize the server-owned proposal publication facts for mutation checks."""

    return (
        "" if document.get("status") is None else str(document.get("status")),
        "" if document.get("approved_by") is None else str(document.get("approved_by")),
        "" if document.get("approved_at") is None else str(document.get("approved_at")),
    )


def _field_evidence_issuance_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    """Canonicalize the service-owned Evidence Item facts for ContextVar matching."""

    return tuple(
        (
            field,
            "" if document.get(field) is None else str(document.get(field)),
        )
        for field in FIELD_EVIDENCE_ISSUANCE_FIELDS
    )


def _quickbooks_reconciliation_issuance_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    """Canonicalize the exact Pending reconciliation inserted by the issuer."""

    return _runtime_snapshot(document, QUICKBOOKS_RECONCILIATION_ISSUANCE_FIELDS)


def _quickbooks_final_invoice_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, QUICKBOOKS_FINAL_INVOICE_FIELDS)


def _customer_contract_evidence_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, CUSTOMER_CONTRACT_EVIDENCE_FIELDS)


def _customer_contract_acceptance_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, CUSTOMER_CONTRACT_ACCEPTANCE_FIELDS)


def _customer_quote_acceptance_snapshot(
    document: Any,
) -> tuple[str, tuple[tuple[str, str], ...]]:
    return (
        str(document.get("name") or ""),
        _runtime_snapshot(document, CUSTOMER_QUOTE_ACCEPTANCE_FIELDS),
    )


def _customer_contract_job_transition_snapshot(
    document: Any,
) -> tuple[str, tuple[tuple[str, str], ...]]:
    """Canonicalize the exact Roof Job Won transition the acceptance command derived."""

    return (
        str(document.get("name") or ""),
        _runtime_snapshot(document, CUSTOMER_CONTRACT_JOB_TRANSITION_FIELDS),
    )


def _customer_contract_job_transition_allows(
    document: Any, previous_document: Any
) -> bool:
    """Allow exactly one tentative-to-Won move that touches no other job fact."""

    if (
        str(previous_document.get("job_status") or "")
        not in CUSTOMER_CONTRACT_JOB_TENTATIVE_STATUSES
    ):
        return False
    if str(document.get("job_status") or "") != "Won":
        return False
    return _runtime_snapshot(
        document, CUSTOMER_CONTRACT_JOB_LINEAGE_FIELDS
    ) == _runtime_snapshot(previous_document, CUSTOMER_CONTRACT_JOB_LINEAGE_FIELDS)


def _customer_decision_evidence_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, CUSTOMER_DECISION_EVIDENCE_FIELDS)


def _production_gate_clearance_evidence_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    # RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    # by IRO-195's D1-native production-gate state.
    return _runtime_snapshot(document, PRODUCTION_GATE_CLEARANCE_EVIDENCE_FIELDS)


def _facet_design_projection_evidence_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, FACET_DESIGN_PROJECTION_EVIDENCE_FIELDS)


def _facet_design_projection_reconciliation_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, FACET_DESIGN_PROJECTION_RECONCILIATION_FIELDS)


def _facet_design_projection_quote_snapshot(
    document: Any,
) -> tuple[str, tuple[tuple[str, str], ...]]:
    return (
        str(document.get("name") or document.get("customer_quote_id") or ""),
        _runtime_snapshot(document, FACET_DESIGN_PROJECTION_QUOTE_FIELDS),
    )


def _facet_design_projection_reconciliation_anchor_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, FACET_DESIGN_PROJECTION_RECONCILIATION_ANCHOR_FIELDS)


def _facet_design_projection_reconciliation_allows_lifecycle_transition(
    document: Any, previous_document: Any
) -> bool:
    """Allow only the ordinary reconciliation resolution fields to move with state."""

    current_status = str(document.get("status") or "")
    previous_status = str(previous_document.get("status") or "")
    if current_status == previous_status:
        return False

    mutable_fields = {"status"}
    if current_status in {"Resolved", "Ignored"}:
        mutable_fields.update(
            {
                "resolution_action",
                "resolved_by",
                "resolved_at",
                "resolution_evidence",
                "automation_incident",
            }
        )
    elif current_status == "Superseded":
        mutable_fields.update({"supersedes", "correction_reason"})

    protected_fields = tuple(
        field
        for field in FACET_DESIGN_PROJECTION_RECONCILIATION_LIFECYCLE_FIELDS
        if field not in mutable_fields
    )
    return _runtime_snapshot(document, protected_fields) == _runtime_snapshot(
        previous_document, protected_fields
    )


def _quote_acceptance_status(
    snapshot: tuple[str, tuple[tuple[str, str], ...]],
) -> str:
    return dict(snapshot[1])["status"]


def _is_customer_acceptance_service_actor() -> bool:
    actor = getattr(getattr(frappe, "session", None), "user", None)
    if not isinstance(actor, str) or not actor:
        return False
    return CUSTOMER_ACCEPTANCE_SERVICE_ROLE in {
        str(role) for role in frappe.get_roles(actor)
    }


def _reject_customer_acceptance_service_generic_write() -> None:
    frappe.throw(
        "Customer acceptance service users may only mutate records through the bounded customer contract command.",
        exc=frappe.PermissionError,
    )


def _is_customer_decision_service_actor() -> bool:
    actor = getattr(getattr(frappe, "session", None), "user", None)
    if not isinstance(actor, str) or not actor:
        return False
    return CUSTOMER_DECISION_SERVICE_ROLE in {
        str(role) for role in frappe.get_roles(actor)
    }


def _reject_customer_decision_service_generic_write() -> None:
    frappe.throw(
        "Customer decision service users may only mutate records through the bounded customer portal decision command.",
        exc=frappe.PermissionError,
    )


def _is_facet_design_projection_service_actor() -> bool:
    actor = getattr(getattr(frappe, "session", None), "user", None)
    if not isinstance(actor, str) or not actor:
        return False
    return FACET_DESIGN_PROJECTION_SERVICE_ROLE in {
        str(role) for role in frappe.get_roles(actor)
    }


def _reject_facet_design_projection_service_generic_write() -> None:
    frappe.throw(
        "Facet design projection service users may only mutate records through the bounded projection command.",
        exc=frappe.PermissionError,
    )


def _work_package_runtime_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    """Canonicalize lifecycle facts that only narrow commands may mutate."""

    return tuple(
        (
            field,
            "" if document.get(field) is None else str(document.get(field)),
        )
        for field in WORK_PACKAGE_RUNTIME_FIELDS
    )


def _work_package_event_issuance_snapshot(
    document: Any,
) -> tuple[tuple[str, str], ...]:
    """Canonicalize one immutable Work Package event for context matching."""

    return tuple(
        (
            field,
            "" if document.get(field) is None else str(document.get(field)),
        )
        for field in WORK_PACKAGE_EVENT_ISSUANCE_FIELDS
    )


def _runtime_snapshot(
    document: Any, fields: tuple[str, ...]
) -> tuple[tuple[str, str], ...]:
    return tuple(
        (field, "" if document.get(field) is None else str(document.get(field)))
        for field in fields
    )


def _material_lot_runtime_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, MATERIAL_LOT_RUNTIME_FIELDS)


def _controlled_item_runtime_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, CONTROLLED_ITEM_RUNTIME_FIELDS)


def _nonconformance_runtime_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, NONCONFORMANCE_RUNTIME_FIELDS)


def _shop_order_runtime_snapshot(document: Any) -> tuple[tuple[str, str], ...]:
    return _runtime_snapshot(document, SHOP_ORDER_RUNTIME_FIELDS)


@contextmanager
def safety_acknowledgement_append_context(safety_plan_id: str, device_action_id: str):
    """Authorize exactly one server-side acknowledgement append for one save.

    This ContextVar is never populated from the request payload, so a generic
    REST/Desk document update cannot opt into the child-table mutation path.
    """

    token = _ATOMIC_SAFETY_ACKNOWLEDGEMENT_APPEND.set(
        (safety_plan_id, device_action_id)
    )
    try:
        yield
    finally:
        _ATOMIC_SAFETY_ACKNOWLEDGEMENT_APPEND.reset(token)


@contextmanager
def lead_triage_transition_context(
    lead_envelope_id: str,
    hermes_run_id: str,
    triaged_by: str,
    triaged_at: str,
    triage_summary: str,
):
    """Authorize one exact Lead Envelope triage transition for one save.

    The context is created only after the narrow server command has locked and
    validated the approved Hermes Run.  It is intentionally not populated from
    a Desk/REST document payload, so ordinary Lead Envelope write permission
    cannot opt into the Triaged transition.
    """

    token = _APPROVED_LEAD_TRIAGE_TRANSITION.set(
        (
            lead_envelope_id,
            hermes_run_id,
            triaged_by,
            triaged_at,
            triage_summary,
        )
    )
    try:
        yield
    finally:
        _APPROVED_LEAD_TRIAGE_TRANSITION.reset(token)


@contextmanager
def proposal_publication_context(
    proposal_evidence_pack_id: str,
    hermes_run_id: str,
    approved_by: str,
    approved_at: str,
):
    """Authorize exactly one Draft-to-Approved proposal publication save.

    The narrow Frappe command sets this private context only after it locks and
    validates the signed, approved Hermes Run.  Proposal Evidence Pack write
    permission alone must never be enough to expose a pack through the customer
    portal, so Desk/REST payloads cannot populate this ContextVar.
    """

    token = _APPROVED_PROPOSAL_PUBLICATION.set(
        (proposal_evidence_pack_id, hermes_run_id, approved_by, approved_at)
    )
    try:
        yield
    finally:
        _APPROVED_PROPOSAL_PUBLICATION.reset(token)


@contextmanager
def field_evidence_issuance_context(document: Any):
    """Authorize one exact service-issued verified Field Companion evidence save.

    The ContextVar is set only inside ``field_evidence_api`` after the
    configured Worker integration principal is authenticated.  A generic
    Desk/REST update cannot provide or recreate this private execution state.
    """

    token = _TRUSTED_FIELD_EVIDENCE_ISSUANCE.set(
        _field_evidence_issuance_snapshot(document)
    )
    try:
        yield
    finally:
        _TRUSTED_FIELD_EVIDENCE_ISSUANCE.reset(token)


@contextmanager
def quickbooks_reconciliation_issuance_context(document: Any):
    """Authorize one exact Pending QuickBooks reconciliation insert.

    Only the bounded issuer command opens this ContextVar after authenticating
    the configured Worker principal. Generic Desk/REST resource creation cannot
    manufacture this process-local authorization state.
    """

    token = _TRUSTED_QUICKBOOKS_RECONCILIATION_ISSUANCE.set(
        _quickbooks_reconciliation_issuance_snapshot(document)
    )
    try:
        yield
    finally:
        _TRUSTED_QUICKBOOKS_RECONCILIATION_ISSUANCE.reset(token)


@contextmanager
def quickbooks_final_invoice_bind_context(document: Any):
    """Authorize one exact identity/basis bind from the configured service."""

    if str(document.get("doctype") or "") == "Roof Job":
        snapshot = (
            ("name", str(document.get("name") or document.get("roof_job_id") or "")),
            ("qb_realm_id", str(document.get("qb_realm_id") or "")),
            ("qb_invoice_ref", str(document.get("qb_invoice_ref") or "")),
        )
    else:
        snapshot = _quickbooks_final_invoice_snapshot(document)
    token = _TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND.set(
        (str(document.get("doctype") or ""), snapshot)
    )
    try:
        yield
    finally:
        _TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND.reset(token)


@contextmanager
def quickbooks_final_invoice_resolver_context(document: Any):
    """Authorize one exact provider-GET reconciliation mutation."""

    if str(document.get("doctype") or "") == "Roof Job":
        snapshot = (
            ("name", str(document.get("name") or document.get("roof_job_id") or "")),
            ("qb_realm_id", str(document.get("qb_realm_id") or "")),
            ("qb_invoice_ref", str(document.get("qb_invoice_ref") or "")),
        )
    else:
        snapshot = _quickbooks_final_invoice_snapshot(document)
    token = _TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER.set(
        (str(document.get("doctype") or ""), snapshot)
    )
    try:
        yield
    finally:
        _TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER.reset(token)


@contextmanager
def customer_contract_acceptance_issuance_context(
    evidence: Any, acceptance: Any, quote: Any
):
    """Authorize one exact evidence, acceptance, and quote transition.

    This private state is created only by the service/HMAC-checked customer
    contract command. Generic Desk and REST document writes cannot supply it.
    """

    token = _TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE.set(
        (
            _customer_contract_evidence_snapshot(evidence),
            _customer_contract_acceptance_snapshot(acceptance),
            _customer_quote_acceptance_snapshot(quote),
        )
    )
    try:
        yield
    finally:
        _TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE.reset(token)


@contextmanager
def customer_contract_job_transition_context(job: Any):
    """Authorize one exact Roof Job tentative-to-Won transition.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native acceptance transition; delete when Frappe stops being
    written for new jobs.

    Deliberately its own context rather than a fourth slot on the acceptance
    context above: the acceptance context authorizes the receipt lineage a fresh
    acceptance issues, while this one also has to cover the replay branch, where no
    evidence, acceptance or quote is written at all.  Each context still authorizes
    exactly one document and nothing else.
    """

    token = _TRUSTED_CUSTOMER_CONTRACT_JOB_TRANSITION.set(
        _customer_contract_job_transition_snapshot(job)
    )
    try:
        yield
    finally:
        _TRUSTED_CUSTOMER_CONTRACT_JOB_TRANSITION.reset(token)


@contextmanager
def production_gate_clearance_context(
    gate: Any, evidence: Any = None, waiver_actor: Any = None
):
    """Authorize exactly one bounded production-gate clearance.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with `production_gate_api`.
    Both bindings below exist only because a Frappe write arrives carrying the bus
    principal rather than the person: a D1-native clearance is written by the Worker
    route that already holds the session, so there is nothing left to re-attribute.

    Two things need naming, and each is scoped to this one gate row.

    A **verified** clearance mints exactly one Evidence Item, and it must be bound
    to the same Roof Job and filed in the same gate's proof slot as the row being
    cleared - otherwise this command would be a way to attach any receipt to any
    gate.

    A **waiver** mints nothing but has to name the human who made it.  The waiver
    rule in `validate_business_document` predates every bounded command and reads
    the attribution off `frappe.session.user`, which for a Worker-issued command is
    the integration principal rather than the person who decided.  Naming the actor
    here keeps that rule's meaning exactly - a waiver is attributed to a real
    owner-level human, and that human's roles are what the rule checks - instead of
    either attributing the decision to the bus or dropping the check.
    """

    if evidence is not None:
        if str(evidence.get("roof_job") or "") != str(gate.get("roof_job") or ""):
            frappe.throw(
                "A production-gate clearance receipt must belong to the gate's own Roof Job.",
                exc=frappe.ValidationError,
            )
        if str(evidence.get("proof_slot") or "") != str(gate.get("gate") or ""):
            frappe.throw(
                "A production-gate clearance receipt must be filed in its own gate's proof slot.",
                exc=frappe.ValidationError,
            )
    token = _TRUSTED_PRODUCTION_GATE_CLEARANCE.set(
        (
            str(gate.get("name") or ""),
            None if waiver_actor is None else str(waiver_actor),
            None
            if evidence is None
            else _production_gate_clearance_evidence_snapshot(evidence),
        )
    )
    try:
        yield
    finally:
        _TRUSTED_PRODUCTION_GATE_CLEARANCE.reset(token)


def _production_gate_clearance_waiver_actor(document: Any) -> str | None:
    """The human this bounded command attributed a waiver of THIS gate to.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with
    `production_gate_clearance_context`.
    """

    context = _TRUSTED_PRODUCTION_GATE_CLEARANCE.get()
    if context is None or context[1] is None:
        return None
    return context[1] if context[0] == str(document.get("name") or "") else None


@contextmanager
def customer_decision_issuance_context(evidence: Any):
    """Authorize one exact portal-decision receipt Evidence Item.

    Created only by the service/HMAC-checked customer portal decision command,
    after it has pinned the dedicated service user and re-locked the
    job/customer/package lineage itself. It authorizes the single receipt that
    command derived and nothing else: no Customer Quote, no acceptance, no
    second Evidence Item.
    """

    token = _TRUSTED_CUSTOMER_DECISION.set(
        (_customer_decision_evidence_snapshot(evidence),)
    )
    try:
        yield
    finally:
        _TRUSTED_CUSTOMER_DECISION.reset(token)


@contextmanager
def facet_design_projection_issuance_context(
    evidence: Any,
    reconciliation: Any,
    quote: Any | None = None,
    invalidated_quote: Any | None = None,
):
    """Authorize exact Facet evidence/reconciliation and bounded quote changes.

    The bounded Worker command creates this private context only after it has
    authenticated the dedicated service user, verified its independent HMAC,
    and locked the explicit Roof Job/Customer Quote association. It grants no
    authority to populate commercial fields or publish a proposal.
    """

    token = _TRUSTED_FACET_DESIGN_PROJECTION.set(
        (
            _facet_design_projection_evidence_snapshot(evidence),
            _facet_design_projection_reconciliation_snapshot(reconciliation),
            _facet_design_projection_quote_snapshot(quote) if quote is not None else None,
            (
                _facet_design_projection_quote_snapshot(invalidated_quote)
                if invalidated_quote is not None
                else None
            ),
        )
    )
    try:
        yield
    finally:
        _TRUSTED_FACET_DESIGN_PROJECTION.reset(token)


@contextmanager
def work_package_transition_context(document: Any):
    """Authorize one exact Work Package lifecycle save from a narrow command.

    Work Package content stays editable while it is a Draft, but all released
    lifecycle facts are operational evidence.  This private context is set only
    after the API has locked the package, assignment, and actor relationship;
    generic Desk/REST writes cannot manufacture it from request input.
    """

    token = _TRUSTED_WORK_PACKAGE_TRANSITION.set(
        (str(document.get("name") or ""), _work_package_runtime_snapshot(document))
    )
    try:
        yield
    finally:
        _TRUSTED_WORK_PACKAGE_TRANSITION.reset(token)


@contextmanager
def controlled_item_transition_context(document: Any):
    """Authorize one exact Controlled Item approval or retirement command."""

    token = _TRUSTED_CONTROLLED_ITEM_TRANSITION.set(
        (str(document.get("name") or ""), _controlled_item_runtime_snapshot(document))
    )
    try:
        yield
    finally:
        _TRUSTED_CONTROLLED_ITEM_TRANSITION.reset(token)


@contextmanager
def material_lot_transition_context(document: Any):
    """Authorize one exact inventory-lot lifecycle mutation from a bounded command."""

    token = _TRUSTED_MATERIAL_LOT_TRANSITION.set(
        (str(document.get("name") or ""), _material_lot_runtime_snapshot(document))
    )
    try:
        yield
    finally:
        _TRUSTED_MATERIAL_LOT_TRANSITION.reset(token)


@contextmanager
def nonconformance_transition_context(document: Any):
    """Authorize one exact NCR lifecycle mutation from a bounded command."""

    token = _TRUSTED_NONCONFORMANCE_TRANSITION.set(
        (str(document.get("name") or ""), _nonconformance_runtime_snapshot(document))
    )
    try:
        yield
    finally:
        _TRUSTED_NONCONFORMANCE_TRANSITION.reset(token)


@contextmanager
def asset_inspection_transition_context(document: Any):
    """Authorize one exact inspection submit or verification from a bounded command."""

    token = _TRUSTED_ASSET_INSPECTION_TRANSITION.set(
        (
            str(document.get("name") or ""),
            _runtime_snapshot(document, ASSET_INSPECTION_RUNTIME_FIELDS),
        )
    )
    try:
        yield
    finally:
        _TRUSTED_ASSET_INSPECTION_TRANSITION.reset(token)


@contextmanager
def cargo_load_transition_context(document: Any):
    """Authorize one exact cargo loading, delivery, or reconciliation mutation."""

    token = _TRUSTED_CARGO_LOAD_TRANSITION.set(
        (
            str(document.get("name") or ""),
            _runtime_snapshot(document, CARGO_LOAD_RUNTIME_FIELDS),
        )
    )
    try:
        yield
    finally:
        _TRUSTED_CARGO_LOAD_TRANSITION.reset(token)


@contextmanager
def shop_order_transition_context(document: Any):
    """Authorize one exact Shop Order lifecycle mutation from a bounded command."""

    token = _TRUSTED_SHOP_ORDER_TRANSITION.set(
        (str(document.get("name") or ""), _shop_order_runtime_snapshot(document))
    )
    try:
        yield
    finally:
        _TRUSTED_SHOP_ORDER_TRANSITION.reset(token)


@contextmanager
def work_package_event_issuance_context(document: Any):
    """Authorize one append-only Work Package event issued by the bounded API."""

    token = _TRUSTED_WORK_PACKAGE_EVENT_ISSUANCE.set(
        _work_package_event_issuance_snapshot(document)
    )
    try:
        yield
    finally:
        _TRUSTED_WORK_PACKAGE_EVENT_ISSUANCE.reset(token)


def validate_evidence_verification_mutation(document: Any) -> None:
    """Keep generic document writes from creating or promoting verified evidence."""

    customer_contract_context = _TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE.get()
    facet_projection_context = _TRUSTED_FACET_DESIGN_PROJECTION.get()
    customer_decision_context = _TRUSTED_CUSTOMER_DECISION.get()
    if _is_customer_acceptance_service_actor():
        if (
            customer_contract_context is not None
            and customer_contract_context[0]
            == _customer_contract_evidence_snapshot(document)
        ):
            return
        _reject_customer_acceptance_service_generic_write()
    if _is_facet_design_projection_service_actor():
        if (
            facet_projection_context is not None
            and facet_projection_context[0]
            == _facet_design_projection_evidence_snapshot(document)
        ):
            return
        _reject_facet_design_projection_service_generic_write()
    if _is_customer_decision_service_actor():
        if (
            customer_decision_context is not None
            and customer_decision_context[0]
            == _customer_decision_evidence_snapshot(document)
        ):
            return
        _reject_customer_decision_service_generic_write()
    previous = _previous(document)
    if previous is not None and previous.get("sync_state") == "Verified":
        if _field_evidence_issuance_snapshot(document) != _field_evidence_issuance_snapshot(previous):
            frappe.throw(
                "Verified Evidence Item identity, content, binding, and lifecycle facts are immutable; issue a correction instead.",
                exc=frappe.ValidationError,
            )
        return
    if document.get("sync_state") != "Verified":
        return
    if _TRUSTED_FIELD_EVIDENCE_ISSUANCE.get() == _field_evidence_issuance_snapshot(
        document
    ):
        return
    if (
        customer_contract_context is not None
        and customer_contract_context[0] == _customer_contract_evidence_snapshot(document)
    ):
        return
    # RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era; this
    # branch goes with `production_gate_api` and its context manager.
    production_gate_context = _TRUSTED_PRODUCTION_GATE_CLEARANCE.get()
    if (
        production_gate_context is not None
        and production_gate_context[2]
        == _production_gate_clearance_evidence_snapshot(document)
    ):
        return
    frappe.throw(
        "Evidence Item verification can only be issued by the dedicated Worker command.",
        exc=frappe.ValidationError,
    )


def validate_quickbooks_reconciliation_issuance(document: Any) -> None:
    """Keep QuickBooks reconciliation creation on the bounded Worker path."""

    system_name = document.get("system_name")
    is_quickbooks = isinstance(system_name, str) and system_name.strip().casefold() == "quickbooks"
    if not is_quickbooks or _previous(document) is not None:
        return
    if _TRUSTED_QUICKBOOKS_RECONCILIATION_ISSUANCE.get() == (
        _quickbooks_reconciliation_issuance_snapshot(document)
    ):
        return
    frappe.throw(
        "QuickBooks reconciliations can only be issued by the dedicated Worker command.",
        exc=frappe.PermissionError,
    )


def _quickbooks_final_invoice_context_matches(
    document: Any,
    trusted: ContextVar[tuple[str, tuple[tuple[str, str], ...]] | None],
) -> bool:
    context = trusted.get()
    return context == (
        str(document.get("doctype") or ""),
        _quickbooks_final_invoice_snapshot(document),
    )


def _quickbooks_final_invoice_roof_job_context_matches(document: Any) -> bool:
    name = str(document.get("name") or document.get("roof_job_id") or "")
    realm = str(document.get("qb_realm_id") or "")
    invoice = str(document.get("qb_invoice_ref") or "")
    return any(
        context is not None
        and context
        == (
            "Roof Job",
            (("name", name), ("qb_realm_id", realm), ("qb_invoice_ref", invoice)),
        )
        for context in (
            _TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND.get(),
            _TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER.get(),
        )
    )


def validate_quickbooks_final_invoice_mutation(document: Any) -> None:
    """Keep final-invoice identity and provider truth off generic REST paths."""

    previous = _previous(document)
    doctype = str(document.get("doctype") or "")
    current_intent = str(document.get("invoice_intent_id") or "")
    previous_intent = str(previous.get("invoice_intent_id") or "") if previous else ""
    sensitive = False
    if doctype == "Roof Job":
        sensitive = (
            any(document.get(field) not in {None, ""} for field in ("qb_realm_id", "qb_invoice_ref"))
            if previous is None
            else any(
                str(document.get(field) or "") != str(previous.get(field) or "")
                for field in ("qb_realm_id", "qb_invoice_ref")
            )
        )
    elif doctype in {"Payment Milestone", "Integration Reconciliation"}:
        sensitive = bool(current_intent or previous_intent)
    if not sensitive:
        return
    if doctype == "Roof Job" and _quickbooks_final_invoice_roof_job_context_matches(document):
        return
    if _quickbooks_final_invoice_context_matches(
        document, _TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND
    ) or _quickbooks_final_invoice_context_matches(
        document, _TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER
    ):
        return
    frappe.throw(
        "QuickBooks final-invoice basis and provider truth can only be changed by the bounded service commands.",
        exc=frappe.PermissionError,
    )


def validate_facet_design_projection_evidence_mutation(document: Any) -> None:
    """Freeze a projected design revision even for non-service Frappe users."""

    previous_document = _previous(document)
    previous_is_projection = previous_document is not None and (
        previous_document.get("source_system") == FACET_DESIGN_PROJECTION_SOURCE_SYSTEM
        or previous_document.get("verification_source")
        == FACET_DESIGN_PROJECTION_VERIFICATION_SOURCE
    )
    current_is_projection = (
        document.get("source_system") == FACET_DESIGN_PROJECTION_SOURCE_SYSTEM
        or document.get("verification_source") == FACET_DESIGN_PROJECTION_VERIFICATION_SOURCE
    )
    if not previous_is_projection and not current_is_projection:
        return
    current = _facet_design_projection_evidence_snapshot(document)
    context = _TRUSTED_FACET_DESIGN_PROJECTION.get()
    if (
        previous_document is None
        and context is not None
        and context[0] == current
    ):
        return
    if previous_document is not None and current == _facet_design_projection_evidence_snapshot(
        previous_document
    ):
        return
    frappe.throw(
        "Projected Facet design evidence is immutable and can only be corrected by a new design revision.",
        exc=frappe.ValidationError,
    )


def validate_facet_design_projection_reconciliation_mutation(document: Any) -> None:
    """Freeze a Facet source binding while permitting a governed resolution transition."""

    previous_document = _previous(document)
    previous_is_projection = previous_document is not None and str(
        previous_document.get("reconciliation_id") or ""
    ).startswith("facet-design-projection:")
    current_is_projection = str(document.get("reconciliation_id") or "").startswith(
        "facet-design-projection:"
    )
    if not previous_is_projection and not current_is_projection:
        return
    current = _facet_design_projection_reconciliation_snapshot(document)
    context = _TRUSTED_FACET_DESIGN_PROJECTION.get()
    if (
        previous_document is None
        and context is not None
        and context[1] == current
    ):
        return
    if previous_document is not None:
        if (
            _facet_design_projection_reconciliation_anchor_snapshot(document)
            == _facet_design_projection_reconciliation_anchor_snapshot(previous_document)
            and _facet_design_projection_reconciliation_allows_lifecycle_transition(
                document, previous_document
            )
        ):
            return
    frappe.throw(
        "Projected Facet design reconciliation keeps its source binding immutable and must use a governed lifecycle transition.",
        exc=frappe.ValidationError,
    )


def validate_contract_acceptance_mutation(document: Any) -> None:
    """Reject generic creation or mutation of an accepted customer contract."""

    current = _customer_contract_acceptance_snapshot(document)
    previous_document = _previous(document)
    customer_contract_context = _TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE.get()
    if _is_customer_acceptance_service_actor():
        if (
            previous_document is None
            and customer_contract_context is not None
            and customer_contract_context[1] == current
        ):
            return
        _reject_customer_acceptance_service_generic_write()
    if previous_document is not None:
        previous = _customer_contract_acceptance_snapshot(previous_document)
        if current == previous:
            return
    if document.get("status") != "Accepted":
        return
    if (
        previous_document is None
        and customer_contract_context is not None
        and customer_contract_context[1] == current
    ):
        return
    frappe.throw(
        "Contract Acceptance can only be issued by the bounded customer contract command.",
        exc=frappe.ValidationError,
    )


def validate_customer_contract_job_transition_mutation(document: Any) -> None:
    """Keep the acceptance service identity to one governed Roof Job Won transition.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native acceptance transition; delete when Frappe stops being
    written for new jobs.

    The acceptance service holds `write_existing` on Roof Job so the bounded command
    can record that a signed contract won the job.  That grant is scoped here and
    nowhere else: through this command, that identity may move a still-tentative job
    to Won and stamp the locale-policy facts the Won invariant requires, and may not
    touch a single other job fact, reach a job that already left the tentative set, or
    write a Roof Job through Desk or REST at all.  Human roles keep the job lifecycle
    they already had; this guard says nothing about them.
    """

    if not _is_customer_acceptance_service_actor():
        return
    previous_document = _previous(document)
    transition_context = _TRUSTED_CUSTOMER_CONTRACT_JOB_TRANSITION.get()
    if (
        previous_document is not None
        and transition_context is not None
        and transition_context == _customer_contract_job_transition_snapshot(document)
        and _customer_contract_job_transition_allows(document, previous_document)
    ):
        return
    _reject_customer_acceptance_service_generic_write()


def validate_customer_quote_acceptance_mutation(document: Any) -> None:
    """Keep accepted quote links and timestamps private-command owned."""

    current = _customer_quote_acceptance_snapshot(document)
    previous_document = _previous(document)
    customer_contract_context = _TRUSTED_CUSTOMER_CONTRACT_ACCEPTANCE.get()
    facet_projection_context = _TRUSTED_FACET_DESIGN_PROJECTION.get()
    if _is_facet_design_projection_service_actor():
        if facet_projection_context is not None and (
            (
                previous_document is None
                and facet_projection_context[2]
                == _facet_design_projection_quote_snapshot(document)
            )
            or (
                previous_document is not None
                and facet_projection_context[3]
                == _facet_design_projection_quote_snapshot(document)
            )
        ):
            return
        _reject_facet_design_projection_service_generic_write()
    if _is_customer_acceptance_service_actor():
        if previous_document is not None:
            previous = _customer_quote_acceptance_snapshot(previous_document)
            if (
                _quote_acceptance_status(previous) == "Approved"
                and customer_contract_context is not None
                and customer_contract_context[2] == current
            ):
                return
        _reject_customer_acceptance_service_generic_write()
    if previous_document is None:
        if document.get("status") != "Accepted" and not any(value for _, value in current[1][1:]):
            return
        previous = None
    else:
        previous = _customer_quote_acceptance_snapshot(previous_document)
        if current == previous:
            return
    if (
        previous is not None
        and _quote_acceptance_status(previous) == "Approved"
        and customer_contract_context is not None
        and customer_contract_context[2] == current
    ):
        return
    if (
        document.get("status") == "Accepted"
        or (previous is not None and _quote_acceptance_status(previous) == "Accepted")
        or any(value for _, value in current[1][1:])
    ):
        frappe.throw(
            "Customer Quote acceptance can only be issued by the bounded customer contract command.",
            exc=frappe.ValidationError,
        )


def validate_work_package_runtime_mutation(document: Any) -> None:
    """Reject generic lifecycle writes while permitting ordinary Draft editing."""

    current = _work_package_runtime_snapshot(document)
    previous_document = _previous(document)
    if previous_document is None:
        # A newly created package is an authoring artifact.  Its first release
        # must nevertheless use the same bounded command as a resume.
        if document.get("status") != "Draft" or any(
            value for field, value in current if field != "status"
        ):
            frappe.throw(
                "Work Package lifecycle can only be changed through the bounded Work Package commands.",
                exc=frappe.ValidationError,
            )
        return

    previous = _work_package_runtime_snapshot(previous_document)
    if current == previous:
        return
    if _TRUSTED_WORK_PACKAGE_TRANSITION.get() == (
        str(document.get("name") or ""),
        current,
    ):
        return
    frappe.throw(
        "Work Package lifecycle can only be changed through the bounded Work Package commands.",
        exc=frappe.ValidationError,
    )


def _validate_draft_only_runtime_mutation(
    document: Any,
    *,
    fields: tuple[str, ...],
    trusted: ContextVar[tuple[str, tuple[tuple[str, str], ...]] | None],
    label: str,
) -> None:
    current = _runtime_snapshot(document, fields)
    previous_document = _previous(document)
    if previous_document is None:
        if document.get("status") == "Draft" and all(
            not value for field, value in current if field != "status"
        ):
            return
    elif _runtime_snapshot(previous_document, fields) == current:
        return
    if trusted.get() == (str(document.get("name") or ""), current):
        return
    frappe.throw(
        f"{label} lifecycle can only be changed through bounded Shop commands.",
        exc=frappe.ValidationError,
    )


def validate_asset_inspection_runtime_mutation(document: Any) -> None:
    """Keep submitted and verified inspection facts command-owned.

    A pre/post-trip inspection is a physical safety observation that gates
    scheduling and release.  Drafting stays open to the Desk, but every
    submitted or verified fact must arrive through the bounded field command
    that authenticated the inspector and stored the evidence.
    """

    _validate_draft_only_runtime_mutation(
        document,
        fields=ASSET_INSPECTION_RUNTIME_FIELDS,
        trusted=_TRUSTED_ASSET_INSPECTION_TRANSITION,
        label="Asset Inspection",
    )


def validate_cargo_load_runtime_mutation(document: Any) -> None:
    """Keep loading, delivery, return, and reconciliation facts command-owned."""

    _validate_draft_only_runtime_mutation(
        document,
        fields=CARGO_LOAD_RUNTIME_FIELDS,
        trusted=_TRUSTED_CARGO_LOAD_TRANSITION,
        label="Cargo Load",
    )


def validate_material_lot_runtime_mutation(document: Any) -> None:
    """Keep lot receipt, reservation, and quarantine states command-owned."""

    _validate_draft_only_runtime_mutation(
        document,
        fields=MATERIAL_LOT_RUNTIME_FIELDS,
        trusted=_TRUSTED_MATERIAL_LOT_TRANSITION,
        label="Material Lot",
    )


def validate_controlled_item_runtime_mutation(document: Any) -> None:
    """Keep Controlled Item approval facts command-owned after drafting."""

    _validate_draft_only_runtime_mutation(
        document,
        fields=CONTROLLED_ITEM_RUNTIME_FIELDS,
        trusted=_TRUSTED_CONTROLLED_ITEM_TRANSITION,
        label="Controlled Item",
    )


def validate_nonconformance_runtime_mutation(document: Any) -> None:
    """Keep NCR containment and disposition states command-owned."""

    _validate_draft_only_runtime_mutation(
        document,
        fields=NONCONFORMANCE_RUNTIME_FIELDS,
        trusted=_TRUSTED_NONCONFORMANCE_TRANSITION,
        label="Nonconformance",
    )


def validate_shop_order_runtime_mutation(document: Any) -> None:
    """Permit drafting, but require a private context for every released mutation."""

    current = _shop_order_runtime_snapshot(document)
    previous_document = _previous(document)
    if previous_document is None:
        lifecycle = _runtime_snapshot(document, SHOP_ORDER_LIFECYCLE_FIELDS)
        if document.get("status") == "Draft" and all(
            not value for field, value in lifecycle if field != "status"
        ):
            return
    elif (
        previous_document.get("status") == "Draft"
        and document.get("status") == "Draft"
    ):
        return
    elif _shop_order_runtime_snapshot(previous_document) == current:
        return
    if _TRUSTED_SHOP_ORDER_TRANSITION.get() == (
        str(document.get("name") or ""),
        current,
    ):
        return
    frappe.throw(
        "Shop Order lifecycle can only be changed through bounded Shop commands.",
        exc=frappe.ValidationError,
    )


def validate_work_package_event_mutation(document: Any) -> None:
    """Keep Work Package events immutable and API-issued only."""

    if _previous(document) is not None:
        frappe.throw(
            "Work Package Events are append-only and cannot be changed.",
            exc=frappe.ValidationError,
        )
    if _TRUSTED_WORK_PACKAGE_EVENT_ISSUANCE.get() == _work_package_event_issuance_snapshot(
        document
    ):
        return
    frappe.throw(
        "Work Package Events can only be issued by the bounded Work Package commands.",
        exc=frappe.ValidationError,
    )


def validate_lead_envelope_triage_mutation(document: Any) -> None:
    """Keep generic Desk/REST writes from creating or changing a triage fact."""

    current = _lead_triage_snapshot(document)
    previous_document = _previous(document)
    if previous_document is None:
        # Workers create initial envelopes as Unknown/Untriaged.  A new record
        # must not arrive pre-triaged through the generic resource endpoint.
        if current[0] == "Triaged" or any(current[1:]):
            frappe.throw(
                "Lead Envelope triage can only be changed through the approved Hermes command.",
                exc=frappe.ValidationError,
            )
        return

    previous = _lead_triage_snapshot(previous_document)
    if current == previous:
        # Bus transport-only updates preserve these four fields and remain valid.
        return

    context = _APPROVED_LEAD_TRIAGE_TRANSITION.get()
    if not context:
        frappe.throw(
            "Lead Envelope triage can only be changed through the approved Hermes command.",
            exc=frappe.ValidationError,
        )
    lead_envelope_id, _hermes_run_id, triaged_by, triaged_at, triage_summary = context
    expected = ("Triaged", triaged_by, triaged_at, triage_summary)
    if (
        document.get("name") != lead_envelope_id
        or previous[0] == "Triaged"
        or current != expected
    ):
        frappe.throw(
            "Lead Envelope triage mutation did not match the approved Hermes command.",
            exc=frappe.ValidationError,
        )


def validate_proposal_publication_mutation(document: Any) -> None:
    """Keep generic Desk/REST writes from publishing a Proposal Evidence Pack."""

    current = _proposal_publication_snapshot(document)
    previous_document = _previous(document)
    if previous_document is None:
        # The regular draft builder may create a Draft pack, but a new document
        # can never arrive already customer-portal-visible through a generic
        # resource write.  The pure policy also rejects this state independently.
        if current[0] == "Approved":
            frappe.throw(
                "Proposal Evidence Pack publication can only be changed through the approved Hermes command.",
                exc=frappe.ValidationError,
            )
        return

    previous = _proposal_publication_snapshot(previous_document)
    if current == previous:
        return

    publication = _APPROVED_PROPOSAL_PUBLICATION.get()
    if not publication:
        frappe.throw(
            "Proposal Evidence Pack publication can only be changed through the approved Hermes command.",
            exc=frappe.ValidationError,
        )
    proposal_evidence_pack_id, _hermes_run_id, approved_by, approved_at = publication
    expected = ("Approved", approved_by, approved_at)
    if (
        document.get("name") != proposal_evidence_pack_id
        or previous[0] != "Draft"
        or current != expected
    ):
        frappe.throw(
            "Proposal Evidence Pack publication did not match the approved Hermes command.",
            exc=frappe.ValidationError,
        )


def validate_safety_acknowledgement_mutation(document: Any) -> None:
    """Permit only the atomic RPC to append one immutable acknowledgement row."""

    current = _acknowledgement_snapshot(document)
    previous_document = _previous(document)
    previous = (
        _acknowledgement_snapshot(previous_document)
        if previous_document is not None
        else ()
    )
    if current == previous:
        return
    if previous_document is None:
        frappe.throw(
            "Safety Plan acknowledgements can only be appended through the atomic safety acknowledgement command.",
            exc=frappe.ValidationError,
        )
    context = _ATOMIC_SAFETY_ACKNOWLEDGEMENT_APPEND.get()
    if not context:
        frappe.throw(
            "Safety Plan acknowledgements can only be appended through the atomic safety acknowledgement command.",
            exc=frappe.ValidationError,
        )
    safety_plan_id, device_action_id = context
    if (
        document.get("name") != safety_plan_id
        or len(current) != len(previous) + 1
        or current[: len(previous)] != previous
        or current[-1][SAFETY_ACKNOWLEDGEMENT_DEVICE_ACTION_INDEX] != device_action_id
    ):
        frappe.throw(
            "Safety Plan acknowledgement mutation did not match the authorized atomic append.",
            exc=frappe.ValidationError,
        )


def validate_safety_plan_frozen_content(document: Any) -> None:
    """Prevent generic REST/Desk rewrites once a Safety Plan is ready to use.

    A Ready/Acknowledged plan is an auditable safety artifact.  Corrections use
    a new plan with ``supersedes``; the sole in-place transition is the atomic
    command's Ready -> Acknowledged acknowledgement append.
    """

    previous_document = _previous(document)
    if previous_document is None:
        return
    previous_status = previous_document.get("status")
    current_status = document.get("status")
    if previous_status not in {"Ready", "Acknowledged"}:
        return
    if _safety_plan_content_snapshot(document) != _safety_plan_content_snapshot(
        previous_document
    ):
        frappe.throw(
            "Ready or Acknowledged Safety Plan content is immutable; create a superseding plan instead.",
            exc=frappe.ValidationError,
        )
    if current_status == previous_status:
        return
    context = _ATOMIC_SAFETY_ACKNOWLEDGEMENT_APPEND.get()
    if (
        context
        and context[0] == document.get("name")
        and previous_status == "Ready"
        and current_status == "Acknowledged"
    ):
        return
    frappe.throw(
        "Ready or Acknowledged Safety Plan status is immutable; create a superseding plan instead.",
        exc=frappe.ValidationError,
    )


def _value(doctype: str, name: str | None, field: str) -> Any:
    if not name:
        return None
    return frappe.db.get_value(doctype, name, field)


def _lock_roof_job(roof_job: Any) -> str:
    """Serialize gate changes and schedule writes for one existing Roof Job."""

    rows = frappe.db.sql(
        """
        SELECT name
        FROM `tabRoof Job`
        WHERE name = %s
        FOR UPDATE
        """,
        (roof_job,),
        as_dict=True,
    )
    if len(rows) != 1:
        raise PolicyViolation(
            "roof_job_lock_not_found", "the referenced Roof Job does not exist"
        )
    return str(rows[0]["name"])


def _locked_gate_evidence(evidence_ids: list[Any]) -> dict[str, dict[str, Any]]:
    names = tuple(
        sorted(
            {
                evidence_id.strip()
                for evidence_id in evidence_ids
                if isinstance(evidence_id, str) and evidence_id.strip()
            }
        )
    )
    if not names:
        return {}
    placeholders = ", ".join("%s" for _ in names)
    rows = frappe.db.sql(
        f"""
        SELECT {_GATE_EVIDENCE_CONTEXT_SELECT}
        FROM `tabEvidence Item`
        WHERE name IN ({placeholders})
        FOR UPDATE
        """,
        names,
        as_dict=True,
    )
    return {str(row["name"]): dict(row) for row in rows if row.get("name")}


def _locked_production_gates(
    roof_job: Any,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Read the gate set under the same transaction locks as the schedule write."""

    _lock_roof_job(roof_job)
    gates = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_PRODUCTION_GATE_CONTEXT_SELECT}
            FROM `tabProduction Gate State`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    return gates, _locked_gate_evidence([gate.get("evidence_item") for gate in gates])


def _parse_authority_readback(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return dict(parsed) if isinstance(parsed, dict) else None


def _authority_readbacks(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    readbacks: dict[str, dict[str, Any]] = {}
    for row in records:
        authority_id = row.get("authority_record_id") or row.get("name")
        readback = _parse_authority_readback(row.get("issuer_readback_json"))
        if authority_id and readback is not None:
            readbacks[str(authority_id)] = readback
    return readbacks


def _locked_authority_records() -> tuple[str | None, list[dict[str, Any]]]:
    """Lock the single active tenant and its complete authority snapshot."""

    active_tenants = frappe.db.sql(
        """
        SELECT tenant_id
        FROM `tabWhite-Label Tenant`
        WHERE status = %s
        FOR UPDATE
        """,
        ("Active",),
        as_dict=True,
    )
    if not active_tenants:
        # Production release consumers must never silently fall back to Crew
        # Profile or legacy compliance summaries. A pure unit-test adapter may
        # opt in explicitly through frappe.flags; absence alone is not an
        # authority context.
        if getattr(getattr(frappe, "flags", None), "allow_legacy_authority_context", False):
            return None, []
        raise PolicyViolation(
            "authority_tenant_unavailable",
            "an active white-label tenant is required for authority resolution",
            "tenant",
        )
    if len(active_tenants) != 1 or not active_tenants[0].get("tenant_id"):
        raise PolicyViolation(
            "authority_tenant_ambiguous",
            "exactly one active white-label tenant is required for authority resolution",
        )
    tenant = str(active_tenants[0]["tenant_id"])
    rows = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_AUTHORITY_RECORD_CONTEXT_SELECT}
            FROM `tabAuthority Record`
            WHERE tenant = %s
            FOR UPDATE
            """,
            (tenant,),
            as_dict=True,
        )
    ]
    return str(tenant), rows


def _locked_scheduled_production_context(
    roof_job: Any, crew_profile: Any | None = None
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Load every scheduling fence only after the parent Roof Job is locked."""

    gates, gate_evidence = _locked_production_gates(roof_job)
    roof_job_assignments = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_JOB_ASSIGNMENT_SCHEDULE_CONTEXT_SELECT}
            FROM `tabJob Assignment`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    supplier_order_exceptions = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_SUPPLIER_ORDER_EXCEPTION_CONTEXT_SELECT}
            FROM `tabSupplier Order`
            WHERE roof_job = %s
              AND status IN ('Needs Review', 'Shortage')
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    crew_profile_names = sorted(
        {
            str(row.get("crew_profile"))
            for row in roof_job_assignments
            if row.get("crew_profile")
        }
        | ({str(crew_profile)} if crew_profile else set())
    )
    crew_profiles = (
        [
            dict(row)
            for row in frappe.db.sql(
                f"""
                SELECT {_CREW_PROFILE_CONTEXT_SELECT}
                FROM `tabCrew Profile`
                WHERE name IN ({", ".join("%s" for _ in crew_profile_names)})
                FOR UPDATE
                """,
                tuple(crew_profile_names),
                as_dict=True,
            )
        ]
        if crew_profile_names
        else []
    )
    crew_window_assignments = (
        [
            dict(row)
            for row in frappe.db.sql(
                f"""
                SELECT {_JOB_ASSIGNMENT_SCHEDULE_CONTEXT_SELECT}
                FROM `tabJob Assignment`
                WHERE assignment_type = 'Production'
                  AND scheduled_start IS NOT NULL
                  AND crew_profile IN ({", ".join("%s" for _ in crew_profile_names)})
                  AND status IN ({", ".join("%s" for _ in ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES)})
                FOR UPDATE
                """,
                tuple(crew_profile_names)
                + tuple(sorted(ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES)),
                as_dict=True,
            )
        ]
        if crew_profile_names
        else []
    )
    assignments: list[dict[str, Any]] = []
    seen_assignments: set[str] = set()
    for row in [*roof_job_assignments, *crew_window_assignments]:
        keys = tuple(
            str(value)
            for value in (row.get("name"), row.get("assignment_id"))
            if value
        )
        if keys and any(key in seen_assignments for key in keys):
            continue
        assignments.append(row)
        seen_assignments.update(keys)
    compliance_rows = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_JOB_COMPLIANCE_CONTEXT_SELECT}
            FROM `tabJob Compliance Record`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    return (
        gates,
        gate_evidence,
        assignments,
        supplier_order_exceptions,
        crew_profiles,
        compliance_rows,
    )


def _locked_work_package_context(
    roof_job: Any,
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Lock the package's job-scoped release facts in one transaction."""

    gates, gate_evidence = _locked_production_gates(roof_job)
    assignments = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_JOB_ASSIGNMENT_SCHEDULE_CONTEXT_SELECT}
            FROM `tabJob Assignment`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    safety_plans = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_SAFETY_PLAN_CONTEXT_SELECT}
            FROM `tabSafety Plan`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    work_packages = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_WORK_PACKAGE_CONTEXT_SELECT}
            FROM `tabWork Package`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    crew_profile_names = sorted(
        {
            str(row.get("crew_profile"))
            for row in assignments
            if row.get("crew_profile")
        }
    )
    crew_profiles = (
        [
            dict(row)
            for row in frappe.db.sql(
                f"""
                SELECT {_CREW_PROFILE_CONTEXT_SELECT}
                FROM `tabCrew Profile`
                WHERE name IN ({", ".join("%s" for _ in crew_profile_names)})
                FOR UPDATE
                """,
                tuple(crew_profile_names),
                as_dict=True,
            )
        ]
        if crew_profile_names
        else []
    )
    compliance_rows = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_JOB_COMPLIANCE_CONTEXT_SELECT}
            FROM `tabJob Compliance Record`
            WHERE roof_job = %s
            FOR UPDATE
            """,
            (roof_job,),
            as_dict=True,
        )
    ]
    return (
        gates,
        gate_evidence,
        assignments,
        safety_plans,
        work_packages,
        crew_profiles,
        compliance_rows,
    )


def _locked_generic_work_package_context(
    work_object_type: Any,
    work_object_id: Any,
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Lock the bounded parent/context adapter for non-roof physical work.

    Generic packages deliberately do not acquire Roof Job gates, Safety Plans,
    Crew Profiles, or compliance rows.  Their adapter authority is the exact
    typed parent/context plus a Job Assignment with an explicit child roster.
    Unknown context types are rejected by the pure domain policy after this
    readback; this helper must never reinterpret them as a Roof Job.
    """

    assignments = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_JOB_ASSIGNMENT_SCHEDULE_CONTEXT_SELECT}
            FROM `tabJob Assignment`
            WHERE work_object_type = %s
              AND work_object_id = %s
            FOR UPDATE
            """,
            (work_object_type, work_object_id),
            as_dict=True,
        )
    ]
    for assignment in assignments:
        worker_rows = [
            dict(row)
            for row in frappe.db.sql(
                """
                SELECT parent, sequence, worker_user, worker_role, required
                FROM `tabWork Package Worker`
                WHERE parent = %s
                  AND parenttype = 'Job Assignment'
                ORDER BY sequence ASC
                FOR UPDATE
                """,
                (assignment.get("name"),),
                as_dict=True,
            )
        ]
        assignment["assigned_workers"] = worker_rows
    work_packages = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_WORK_PACKAGE_CONTEXT_SELECT}
            FROM `tabWork Package`
            WHERE work_object_type = %s
              AND work_object_id = %s
            FOR UPDATE
            """,
            (work_object_type, work_object_id),
            as_dict=True,
        )
    ]
    return ([], {}, assignments, [], work_packages, [], [])


def _locked_fleet_release_context(
    roof_job: Any,
) -> tuple[
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, int],
]:
    """Lock the job's open cargo custody and its asset/driver authority facts.

    The rows are read under the same Roof Job lock as the schedule or release
    write, so an inspection, defect, or custody change cannot commit between
    the readiness snapshot and the write it authorized.  The out-of-service
    defect rows are locked here too, so a Desk-created defect -- which takes no
    Fleet Asset lock of its own -- cannot commit between the count and the
    release it would have blocked.
    """

    loads = [
        dict(row)
        for row in frappe.db.sql(
            f"""
            SELECT {_CARGO_LOAD_CONTEXT_SELECT}
            FROM `tabCargo Load`
            WHERE roof_job = %s
              AND status IN ({_CARGO_LOAD_FENCE_STATUS_PLACEHOLDERS})
            FOR UPDATE
            """,
            (roof_job, *_CARGO_LOAD_FENCE_STATUSES),
            as_dict=True,
        )
    ]
    asset_names = sorted(
        {str(row.get("fleet_asset")) for row in loads if row.get("fleet_asset")}
        | {str(row.get("trailer_asset")) for row in loads if row.get("trailer_asset")}
    )
    driver_names = sorted(
        {str(row.get("driver_authority")) for row in loads if row.get("driver_authority")}
    )
    assets = (
        {
            str(row["name"]): dict(row)
            for row in frappe.db.sql(
                f"""
                SELECT {_FLEET_ASSET_CONTEXT_SELECT}
                FROM `tabFleet Asset`
                WHERE name IN ({", ".join("%s" for _ in asset_names)})
                FOR UPDATE
                """,
                tuple(asset_names),
                as_dict=True,
            )
        }
        if asset_names
        else {}
    )
    drivers = (
        {
            str(row["name"]): dict(row)
            for row in frappe.db.sql(
                f"""
                SELECT {_DRIVER_AUTHORITY_CONTEXT_SELECT}
                FROM `tabDriver Authority`
                WHERE name IN ({", ".join("%s" for _ in driver_names)})
                FOR UPDATE
                """,
                tuple(driver_names),
                as_dict=True,
            )
        }
        if driver_names
        else {}
    )
    defect_counts: dict[str, int] = {name: 0 for name in asset_names}
    if asset_names:
        # Counted from rows locked in this transaction rather than through an
        # unlocked frappe.db.count: a Desk-created Asset Defect takes no Fleet
        # Asset lock, so an unlocked count could miss one committing right now.
        for row in frappe.db.sql(
            f"""
            SELECT fleet_asset
            FROM `tabAsset Defect`
            WHERE fleet_asset IN ({", ".join("%s" for _ in asset_names)})
              AND out_of_service = 1
              AND status IN ({", ".join("%s" for _ in OPEN_OUT_OF_SERVICE_DEFECT_STATUSES)})
            FOR UPDATE
            """,
            (*asset_names, *OPEN_OUT_OF_SERVICE_DEFECT_STATUSES),
            as_dict=True,
        ):
            name = str(row.get("fleet_asset") or "")
            if name:
                defect_counts[name] = defect_counts.get(name, 0) + 1
    return loads, assets, drivers, defect_counts


def _assert_unique_production_gate(document: Any) -> None:
    """Keep one current gate record per Roof Job/gate pair under the parent lock."""

    roof_job = document.get("roof_job")
    gate = document.get("gate")
    _lock_roof_job(roof_job)
    rows = frappe.db.sql(
        """
        SELECT name
        FROM `tabProduction Gate State`
        WHERE roof_job = %s
          AND gate = %s
          AND name != %s
        FOR UPDATE
        """,
        (roof_job, gate, document.get("name") or ""),
        as_dict=True,
    )
    if rows:
        raise PolicyViolation(
            "duplicate_production_gate",
            "only one current gate record may exist for a Roof Job/gate pair",
        )


def _context(document: Any, kind: str) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if _quickbooks_final_invoice_context_matches(
        document, _TRUSTED_QUICKBOOKS_FINAL_INVOICE_BIND
    ):
        context["quickbooks_final_invoice_bind"] = True
    if _quickbooks_final_invoice_context_matches(
        document, _TRUSTED_QUICKBOOKS_FINAL_INVOICE_RESOLVER
    ):
        context["quickbooks_final_invoice_provider_resolver"] = True
    scheduled_production_assignment = (
        kind == "job_assignment"
        and document.get("assignment_type") == "Production"
        and document.get("scheduled_start")
    )
    work_package_requires_context = (
        kind == "work_package" and document.get("status") != "Draft"
    )
    # Supplier Order status changes and scheduled Production assignments share
    # this parent lock. Without it, a Shortage could commit after scheduling
    # has read its exception set but before the assignment commits.
    if kind == "supplier_order" and document.get("roof_job"):
        _lock_roof_job(document.get("roof_job"))
    correction = CORRECTION_TARGETS.get(kind)
    if correction and not scheduled_production_assignment:
        link_field, doctype, fields = correction
        target = document.get(link_field)
        if target:
            context["superseded_record"] = frappe.db.get_value(
                doctype, target, fields, as_dict=True
            )
    if kind == "job_cost_event":
        _lock_roof_job(document.get("roof_job"))
        source_doctype = document.get("source_doctype")
        source_name = document.get("source_name")
        if source_doctype in JOB_COST_EVENT_SOURCE_DOCTYPES and source_name:
            context["cost_source_record"] = frappe.db.get_value(
                source_doctype,
                source_name,
                ("name", "roof_job"),
                as_dict=True,
            )
        reversal_of = document.get("reversal_of")
        if reversal_of:
            context["reversal_target"] = frappe.db.get_value(
                "Job Cost Event",
                reversal_of,
                (
                    "name",
                    "event_kind",
                    "tenant",
                    "roof_job",
                    "category",
                    "quantity",
                    "unit",
                    "amount_cents",
                    "amount_basis",
                    "currency",
                    "source_doctype",
                    "source_name",
                    "source_digest",
                    "source_evidence",
                ),
                as_dict=True,
            )
            filters: dict[str, Any] = {"reversal_of": reversal_of}
            if document.get("name"):
                filters["name"] = ["!=", document.get("name")]
            context["existing_reversal_count"] = frappe.db.count(
                "Job Cost Event", filters=filters
            )
        source_evidence = document.get("source_evidence")
        if source_evidence:
            context["source_evidence"] = frappe.db.get_value(
                "Evidence Item",
                source_evidence,
                (
                    "name",
                    "evidence_id",
                    "roof_job",
                    "sync_state",
                    "content_checksum",
                    "checksum_algorithm",
                    "verified_at",
                    "verification_source",
                ),
                as_dict=True,
            )
        tenant = document.get("tenant")
        if tenant:
            context["tenant_record"] = frappe.db.get_value(
                "White-Label Tenant",
                tenant,
                ("name", "tenant_id", "status"),
                as_dict=True,
            )
        reconciliation = document.get("reconciliation")
        if reconciliation:
            context["accounting_reconciliation"] = frappe.db.get_value(
                "Integration Reconciliation",
                reconciliation,
                (
                    "name",
                    "reconciliation_id",
                    "roof_job",
                    "system_name",
                    "entity_type",
                    "external_entity_id",
                    "local_doctype",
                    "local_name",
                    "status",
                    "currency",
                    "source_payload_hash",
                    "detected_at",
                ),
                as_dict=True,
            )
    if kind == "payment_milestone":
        _lock_roof_job(document.get("roof_job"))
        recognition_reconciliation = document.get("recognition_reconciliation")
        if recognition_reconciliation:
            context["recognition_reconciliation"] = frappe.db.get_value(
                "Integration Reconciliation",
                recognition_reconciliation,
                (
                    "name",
                    "reconciliation_id",
                    "roof_job",
                    "system_name",
                    "entity_type",
                    "external_entity_id",
                    "local_doctype",
                    "local_name",
                    "status",
                    "currency",
                    "source_payload_hash",
                    "detected_at",
                ),
                as_dict=True,
            )
    if kind == "customer_quote":
        snapshot = parse_json_field(
            document,
            "price_rule_snapshot_json",
            container_types=(dict,),
            non_empty=True,
        )
        context["price_rule_snapshot_rules"] = {}
        if snapshot is not None:
            rules = snapshot.get("rules")
            if isinstance(rules, list) and len(rules) > 50:
                raise PolicyViolation(
                    "price_rule_snapshot_window_exceeded",
                    "price rule source verification is limited to fifty rules",
                    "price_rule_snapshot_json",
                )
            rule_ids = [
                row.get("price_rule_id")
                for row in (rules if isinstance(rules, list) else [])
                if isinstance(row, dict)
                and isinstance(row.get("price_rule_id"), str)
            ]
            if rule_ids:
                context["price_rule_snapshot_rules"] = {
                    row["name"]: row
                    for row in frappe.get_all(
                        "Price Book Rule",
                        filters={"name": ["in", rule_ids]},
                        fields=[
                            "name",
                            "price_rule_id",
                            "rule_name",
                            "rule_type",
                            "status",
                            "service_type",
                            "material_system",
                            "unit",
                            "unit_cost",
                            "unit_price",
                            "minimum_quantity",
                            "currency",
                            "source_ref",
                            "rule_json",
                            "effective_from",
                            "effective_to",
                            "assumptions",
                            "exclusions",
                            "approved_by",
                            "approved_at",
                        ],
                    )
                }
    elif kind == "scope_clause":
        customer_quote = document.get("customer_quote")
        context["scope_clause_quote"] = (
            frappe.db.get_value(
                "Customer Quote", customer_quote, ("roof_job",), as_dict=True
            )
            if customer_quote
            else None
        )
    elif kind == "material_takeoff_policy":
        context["tenant_record"] = frappe.db.get_value(
            "White-Label Tenant",
            document.get("tenant"),
            ("tenant_id", "status"),
            as_dict=True,
        )
        context["policy_evidence"] = frappe.db.get_value(
            "Evidence Item",
            document.get("source_evidence"),
            (
                "name",
                "sync_state",
                "checksum_algorithm",
                "content_checksum",
                "verified_at",
                "verification_source",
            ),
            as_dict=True,
        )
    elif kind == "material_takeoff":
        context["measurement"] = frappe.db.get_value(
            "Measurement Report",
            document.get("measurement_report"),
            (
                "name",
                "measurement_id",
                "roof_job",
                "review_status",
                "roof_graph_revision",
                "raw_key",
            ),
            as_dict=True,
        )
        context["takeoff_policy"] = frappe.db.get_value(
            "Material Takeoff Policy",
            document.get("takeoff_policy"),
            (
                "name",
                "policy_id",
                "tenant",
                "brand",
                "service_type",
                "material_system",
                "policy_version",
                "status",
                "effective_from",
                "effective_to",
                "policy_json",
                "source_evidence",
                "approved_by",
                "approved_at",
                "approval_note",
            ),
            as_dict=True,
        )
        context["tenant_record"] = frappe.db.get_value(
            "White-Label Tenant",
            document.get("tenant"),
            ("tenant_id", "status"),
            as_dict=True,
        )
        context["policy_evidence"] = frappe.db.get_value(
            "Evidence Item",
            document.get("policy_source_evidence"),
            (
                "name",
                "sync_state",
                "checksum_algorithm",
                "content_checksum",
                "verified_at",
                "verification_source",
            ),
            as_dict=True,
        )
        context["roof_job_record"] = frappe.db.get_value(
            "Roof Job",
            document.get("roof_job"),
            ("name", "roof_job_id", "brand", "service_type"),
            as_dict=True,
        )
    elif kind in {"supplier_quote", "supplier_order"}:
        context["takeoff_status"] = _value(
            "Material Takeoff", document.get("material_takeoff"), "status"
        )
        if kind == "supplier_quote":
            context["validation_date"] = str(frappe.utils.now_datetime())[:10]
        if kind == "supplier_order":
            context["supplier_quote_status"] = _value(
                "Supplier Quote", document.get("source_quote"), "status"
            )
            evidence_ids = set()
            acknowledgement_evidence = document.get(
                "supplier_acknowledgement_evidence"
            )
            if acknowledgement_evidence:
                evidence_ids.add(acknowledgement_evidence)
            receipt_evidence = parse_json_field(
                document,
                "receipt_evidence_json",
                container_types=(dict,),
            )
            if isinstance(receipt_evidence, dict):
                receipt_ids = receipt_evidence.get("evidence_item_ids")
                if isinstance(receipt_ids, list):
                    evidence_ids.update(
                        evidence_id
                        for evidence_id in receipt_ids
                        if isinstance(evidence_id, str) and evidence_id
                    )
            context["supplier_order_evidence"] = (
                {
                    row["name"]: row
                    for row in frappe.get_all(
                        "Evidence Item",
                        filters={"name": ["in", sorted(evidence_ids)]},
                        fields=list(SUPPLIER_ORDER_EVIDENCE_CONTEXT_FIELDS),
                    )
                }
                if evidence_ids
                else {}
            )
    elif kind == "fleet_asset":
        context["now"] = frappe.utils.now_datetime()
    elif kind == "asset_inspection":
        context["inspection_fleet_asset"] = frappe.db.get_value(
            "Fleet Asset",
            document.get("fleet_asset"),
            ("name", "fleet_asset_id", "asset_kind", "status", "meter_kind"),
            as_dict=True,
        )
    elif kind == "asset_defect":
        context["defect_maintenance_order"] = (
            frappe.db.get_value(
                "Maintenance Order",
                document.get("maintenance_order"),
                ("name", "fleet_asset", "order_kind", "status"),
                as_dict=True,
            )
            if document.get("maintenance_order")
            else None
        )
        context["defect_return_to_service_inspection"] = (
            frappe.db.get_value(
                "Asset Inspection",
                document.get("return_to_service_inspection"),
                list(ASSET_INSPECTION_CONTEXT_FIELDS),
                as_dict=True,
            )
            if document.get("return_to_service_inspection")
            else None
        )
    elif kind == "maintenance_order":
        context["maintenance_asset_defect"] = (
            frappe.db.get_value(
                "Asset Defect",
                document.get("asset_defect"),
                ("name", "fleet_asset", "severity", "out_of_service", "status"),
                as_dict=True,
            )
            if document.get("asset_defect")
            else None
        )
    elif kind == "asset_usage_log":
        context["usage_fleet_asset"] = frappe.db.get_value(
            "Fleet Asset",
            document.get("fleet_asset"),
            ("name", "fleet_asset_id", "asset_kind", "status", "meter_kind"),
            as_dict=True,
        )
    elif kind == "asset_custody_event":
        context["custody_fleet_asset"] = frappe.db.get_value(
            "Fleet Asset",
            document.get("fleet_asset"),
            list(FLEET_ASSET_CONTEXT_FIELDS),
            as_dict=True,
        )
    elif kind == "cargo_load":
        # The carrier, trailer, driver, and trip inspections are locked in one
        # statement each so a concurrent out-of-service or licence change
        # cannot land between this snapshot and the load write it authorizes.
        context["now"] = frappe.utils.now_datetime()
        context["cargo_carrier_asset"] = frappe.db.get_value(
            "Fleet Asset",
            document.get("fleet_asset"),
            list(FLEET_ASSET_CONTEXT_FIELDS),
            as_dict=True,
        )
        context["cargo_trailer_asset"] = (
            frappe.db.get_value(
                "Fleet Asset",
                document.get("trailer_asset"),
                list(FLEET_ASSET_CONTEXT_FIELDS),
                as_dict=True,
            )
            if document.get("trailer_asset")
            else None
        )
        context["cargo_driver_authority"] = (
            frappe.db.get_value(
                "Driver Authority",
                document.get("driver_authority"),
                list(DRIVER_AUTHORITY_CONTEXT_FIELDS),
                as_dict=True,
            )
            if document.get("driver_authority")
            else None
        )
        context["cargo_pre_trip_inspection"] = (
            frappe.db.get_value(
                "Asset Inspection",
                document.get("pre_trip_inspection"),
                list(ASSET_INSPECTION_CONTEXT_FIELDS),
                as_dict=True,
            )
            if document.get("pre_trip_inspection")
            else None
        )
        context["cargo_post_trip_inspection"] = (
            frappe.db.get_value(
                "Asset Inspection",
                document.get("post_trip_inspection"),
                list(ASSET_INSPECTION_CONTEXT_FIELDS),
                as_dict=True,
            )
            if document.get("post_trip_inspection")
            else None
        )
    elif kind == "material_lot":
        context["controlled_item"] = frappe.db.get_value(
            "Controlled Item",
            document.get("controlled_item"),
            ("name", "status"),
            as_dict=True,
        )
        context["supplier_order"] = frappe.db.get_value(
            "Supplier Order",
            document.get("supplier_order"),
            ("name", "roof_job", "status"),
            as_dict=True,
        )
        if document.get("source_kind") == "Shop Remnant":
            context["source_shop_order"] = frappe.db.get_value(
                "Shop Order",
                document.get("source_shop_order"),
                ("name", "roof_job", "status"),
                as_dict=True,
            )
    elif kind == "nonconformance":
        context["shop_order"] = frappe.db.get_value(
            "Shop Order",
            document.get("shop_order"),
            ("name", "shop_order_id", "roof_job", "status"),
            as_dict=True,
        )
        context["material_lot"] = frappe.db.get_value(
            "Material Lot",
            document.get("material_lot"),
            ("name", "material_lot_id", "roof_job", "controlled_item", "unit", "status"),
            as_dict=True,
        )
        shop_order = context["shop_order"]
        if isinstance(shop_order, dict) and shop_order.get("name"):
            context["shop_order_allocation_lot_ids"] = {
                str(row["material_lot"])
                for row in frappe.get_all(
                    "Shop Material Allocation",
                    filters={"parent": shop_order["name"]},
                    fields=("material_lot",),
                )
                if row.get("material_lot")
            }
    elif kind == "shop_order":
        context["material_takeoff"] = frappe.db.get_value(
            "Material Takeoff",
            document.get("material_takeoff"),
            ("name", "roof_job", "status"),
            as_dict=True,
        )
        context["supplier_order"] = frappe.db.get_value(
            "Supplier Order",
            document.get("supplier_order"),
            ("name", "roof_job", "status"),
            as_dict=True,
        )
        context["work_package"] = frappe.db.get_value(
            "Work Package",
            document.get("work_package"),
            ("name", "roof_job", "status"),
            as_dict=True,
        )
        payment_milestone = document.get("invoice_payment_milestone")
        context["invoice_payment_milestone"] = frappe.db.get_value(
            "Payment Milestone",
            payment_milestone,
            ("name", "roof_job", "shop_order", "status"),
            as_dict=True,
        )
        material_lot_ids = sorted(
            {
                str(row.get("material_lot"))
                for row in (document.get("material_allocations") or [])
                if row.get("material_lot")
            }
        )
        context["material_lots"] = {
            material_lot_id: frappe.db.get_value(
                "Material Lot",
                material_lot_id,
                (
                    "name",
                    "material_lot_id",
                    "roof_job",
                    "controlled_item",
                    "unit",
                    "received_quantity",
                    "available_quantity",
                    "reserved_quantity",
                    "consumed_quantity",
                    "status",
                ),
                as_dict=True,
            )
            for material_lot_id in material_lot_ids
        }
        if document.get("status") in SHOP_ORDER_FINAL_STATUSES:
            context["open_nonconformance_count"] = frappe.db.count(
                "Nonconformance",
                filters={
                    "shop_order": document.get("name") or document.get("shop_order_id"),
                    "status": ["in", ["Open", "Contained", "Dispositioned"]],
                },
            )
    elif kind == "proposal_evidence_pack":
        publication = _APPROVED_PROPOSAL_PUBLICATION.get()
        if publication:
            proposal_evidence_pack_id, hermes_run_id, approved_by, approved_at = (
                publication
            )
            if (
                document.get("name") == proposal_evidence_pack_id
                and _proposal_publication_snapshot(document)
                == ("Approved", approved_by, approved_at)
            ):
                context["proposal_publication"] = {
                    "proposal_evidence_pack_id": proposal_evidence_pack_id,
                    "hermes_run_id": hermes_run_id,
                    "approved_by": approved_by,
                    "approved_at": approved_at,
                }
        quotation = document.get("quotation")
        quote = (
            frappe.db.get_value(
                "Customer Quote",
                quotation,
                ("roof_job", "status", "quote_version", "price_rule_snapshot_json"),
                as_dict=True,
            )
            if quotation
            else None
        )
        context["quote_status"] = quote.get("status") if quote else None
        context["quote_roof_job"] = quote.get("roof_job") if quote else None
        context["quote_version"] = quote.get("quote_version") if quote else None
        context["quote_price_rule_snapshot_bound"] = bool(
            quote and quote.get("price_rule_snapshot_json")
        )
        summary = parse_json_field(
            document,
            "evidence_summary_json",
            required=True,
            container_types=(dict,),
            non_empty=True,
        )
        measurement_rows = summary.get("measurement_reports")
        evidence_rows = summary.get("eligible_evidence")
        if (
            isinstance(measurement_rows, list)
            and len(measurement_rows) > 100
        ) or (isinstance(evidence_rows, list) and len(evidence_rows) > 100):
            raise PolicyViolation(
                "proposal_evidence_window_exceeded",
                "proposal source verification is limited to 100 records per type",
                "evidence_summary_json",
            )
        measurement_ids = [
            row.get("measurement_id")
            for row in (measurement_rows if isinstance(measurement_rows, list) else [])
            if isinstance(row, dict)
            and isinstance(row.get("measurement_id"), str)
        ]
        evidence_ids = [
            row.get("evidence_id")
            for row in (evidence_rows if isinstance(evidence_rows, list) else [])
            if isinstance(row, dict)
            and isinstance(row.get("evidence_id"), str)
        ]
        roof_job = document.get("roof_job")
        context["proposal_measurements"] = (
            {
                row["name"]: row
                for row in frappe.get_all(
                    "Measurement Report",
                    filters={"name": ["in", measurement_ids], "roof_job": roof_job},
                    fields=[
                        "name",
                        "roof_job",
                        "provider",
                        "review_status",
                        "approved_by",
                        "approved_at",
                    ],
                )
            }
            if measurement_ids
            else {}
        )
        context["proposal_evidence"] = (
            {
                row["name"]: row
                for row in frappe.get_all(
                    "Evidence Item",
                    filters={"name": ["in", evidence_ids], "roof_job": roof_job},
                    fields=[
                        "name",
                        "roof_job",
                        "evidence_type",
                        "proof_slot",
                        "customer_safe",
                        "sync_state",
                        "content_checksum",
                        "checksum_algorithm",
                        "verified_at",
                        "verification_source",
                        "source_uri",
                        "r2_key",
                        "drive_file_id",
                    ],
                )
            }
            if evidence_ids
            else {}
        )
    elif kind == "insurance_supplement":
        roof_job = document.get("roof_job")
        customer_quote = document.get("customer_quote")
        change_order = document.get("change_order")
        measurement_report = document.get("measurement_report")
        context["insurance_customer_quote"] = (
            frappe.db.get_value(
                "Customer Quote", customer_quote, ("roof_job",), as_dict=True
            )
            if customer_quote
            else None
        )
        context["insurance_change_order"] = (
            frappe.db.get_value(
                "Change Order", change_order, ("roof_job",), as_dict=True
            )
            if change_order
            else None
        )
        context["insurance_measurement"] = (
            frappe.db.get_value(
                "Measurement Report",
                measurement_report,
                ("roof_job", "review_status", "approved_by", "approved_at"),
                as_dict=True,
            )
            if measurement_report
            else None
        )
        evidence_rows = document.get("evidence") or []
        if len(evidence_rows) > 50:
            raise PolicyViolation(
                "insurance_evidence_window_exceeded",
                "insurance supplement source verification is limited to fifty evidence records",
                "evidence",
            )
        evidence_ids = [
            row.get("evidence_item")
            for row in evidence_rows
            if isinstance(row.get("evidence_item"), str) and row.get("evidence_item")
        ]
        context["insurance_evidence"] = (
            {
                row["name"]: row
                for row in frappe.get_all(
                    "Evidence Item",
                    filters={"name": ["in", evidence_ids], "roof_job": roof_job},
                    fields=[
                        "name",
                        "roof_job",
                        "evidence_type",
                        "sync_state",
                        "content_checksum",
                        "checksum_algorithm",
                        "verified_at",
                        "verification_source",
                        "source_uri",
                        "r2_key",
                        "drive_file_id",
                    ],
                )
            }
            if evidence_ids
            else {}
        )
    elif kind in {"warranty_packet", "review_request"}:
        context["completion_status"] = _value(
            "Completion Packet", document.get("completion_packet"), "status"
        )
    elif kind == "roof_job" and document.get("job_status") in {
        "In Production",
        "Closed",
    }:
        roof_job = document.get("name") or document.get("roof_job_id")
        context["gates"], context["gate_evidence"] = _locked_production_gates(roof_job)
        if document.get("job_status") == "Closed":
            context["completion_packets"] = frappe.get_all(
                "Completion Packet", filters={"roof_job": roof_job}, fields=["status"]
            )
            context["warranty_packets"] = frappe.get_all(
                "Warranty Packet", filters={"roof_job": roof_job}, fields=["status"]
            )
            context["payment_milestones"] = frappe.get_all(
                "Payment Milestone", filters={"roof_job": roof_job}, fields=["status"]
            )
    elif scheduled_production_assignment:
        (
            context["gates"],
            context["gate_evidence"],
            context["job_assignment_rows"],
            context["supplier_order_exception_rows"],
            context["crew_profile_rows"],
            context["job_compliance_rows"],
        ) = _locked_scheduled_production_context(
            document.get("roof_job"), document.get("crew_profile")
        )
        authority_tenant, authority_records = _locked_authority_records()
        if authority_tenant:
            context["authority_tenant"] = authority_tenant
            context["authority_records"] = authority_records
            context["authority_readbacks"] = _authority_readbacks(authority_records)
        else:
            context["legacy_authority_context"] = True
        crew_profile = document.get("crew_profile")
        context["scheduled_assignment_crew_profile"] = next(
            (
                row
                for row in context["crew_profile_rows"]
                if crew_profile in {row.get("name"), row.get("crew_profile_id")}
            ),
            None,
        )
        target = document.get("supersedes")
        if target:
            context["superseded_record"] = next(
                (
                    row
                    for row in context["job_assignment_rows"]
                    if target in {row.get("name"), row.get("assignment_id")}
                ),
                None,
            )
        (
            context["fleet_cargo_load_rows"],
            context["fleet_asset_rows"],
            context["driver_authority_rows"],
            context["fleet_out_of_service_defect_counts"],
        ) = _locked_fleet_release_context(document.get("roof_job"))
    elif work_package_requires_context:
        (
            context["gates"],
            context["gate_evidence"],
            context["job_assignment_rows"],
            context["safety_plan_rows"],
            context["work_package_rows"],
            context["crew_profile_rows"],
            context["job_compliance_rows"],
        ) = (
            _locked_generic_work_package_context(
                document.get("work_object_type"),
                document.get("work_object_id"),
            )
            if document.get("work_object_type")
            and document.get("work_object_type") != "Roof Job"
            else _locked_work_package_context(document.get("roof_job"))
        )
        authority_tenant, authority_records = _locked_authority_records()
        if authority_tenant:
            context["authority_tenant"] = authority_tenant
            context["authority_records"] = authority_records
            context["authority_readbacks"] = _authority_readbacks(authority_records)
        else:
            context["legacy_authority_context"] = True
        assignment = document.get("job_assignment")
        context["work_package_assignment"] = next(
            (
                row
                for row in context["job_assignment_rows"]
                if assignment in {row.get("name"), row.get("assignment_id")}
            ),
            None,
        )
        crew_profile = (
            context["work_package_assignment"].get("crew_profile")
            if context.get("work_package_assignment")
            else None
        )
        context["work_package_crew_profile"] = next(
            (
                row
                for row in context["crew_profile_rows"]
                if crew_profile in {row.get("name"), row.get("crew_profile_id")}
            ),
            None,
        )
        safety_plan = document.get("safety_plan")
        context["work_package_safety_plan"] = next(
            (
                row
                for row in context["safety_plan_rows"]
                if safety_plan in {row.get("name"), row.get("safety_plan_id")}
            ),
            None,
        )
        work_package_references = {
            value
            for value in (document.get("name"), document.get("work_package_id"))
            if value
        }
        context["superseding_work_package"] = next(
            (
                row
                for row in context["work_package_rows"]
                if row.get("supersedes") in work_package_references
            ),
            None,
        )
        (
            context["fleet_cargo_load_rows"],
            context["fleet_asset_rows"],
            context["driver_authority_rows"],
            context["fleet_out_of_service_defect_counts"],
        ) = _locked_fleet_release_context(document.get("roof_job"))
        if document.get("status") in {"Released", "Acknowledged", "In Progress"}:
            context["now"] = frappe.utils.now_datetime()
    elif kind == "production_gate_state":
        # Gate creates and updates take the same per-job lock as scheduling, so
        # a validation snapshot cannot race a gate transition into a commit.
        _assert_unique_production_gate(document)
        if document.get("state") in {"Ready", "Done"}:
            context["gate_evidence"] = _locked_gate_evidence([document.get("evidence_item")])
    elif kind == "white_label_tenant" and document.get("status") == "Active":
        filters: dict[str, Any] = {"status": "Active"}
        if document.get("name"):
            filters["name"] = ["!=", document.get("name")]
        context["other_active_tenants"] = frappe.db.count(
            "White-Label Tenant", filters=filters
        )
    return context


def validate_business_document(document: Any, kind: str) -> None:
    if kind == "authority_record":
        from ironwrap_roofing.authority_policy import (
            AuthorityPolicyViolation,
            validate_authority_record,
        )

        previous = _previous(document)
        superseded = (
            frappe.db.get_value(
                "Authority Record",
                document.get("supersedes"),
                (
                    "name, authority_record_id, tenant, subject_type, subject_role, person_user, organization, "
                    "authority_kind, authority_scope, scope_type, scope_ref, roof_job, scope_json, issuer_name, "
                    "issuer_jurisdiction, issuer_reference, source_version, evidence_refs_json, evidence_sha256, "
                    "issuer_readback_json, "
                    "effective_from, expires_at, version, status, state_digest_sha256, verification_method, "
                    "verified_at, verification_reference, verified_by, revoked_at, revocation_reference, revoked_by, "
                    "supersedes, correction_reason, exception_status, exception_reason"
                ),
                as_dict=True,
            )
            if document.get("supersedes")
            else None
        )
        existing = frappe.get_all(
            "Authority Record",
            filters={"tenant": document.get("tenant")},
            fields=[
                "name", "authority_record_id", "tenant", "subject_type", "subject_role", "person_user", "organization",
                "authority_kind", "authority_scope", "scope_type", "scope_ref", "roof_job", "scope_json", "issuer_name",
                "issuer_jurisdiction", "issuer_reference", "source_version", "evidence_refs_json", "evidence_sha256",
                "issuer_readback_json",
                "effective_from", "expires_at", "version", "status", "state_digest_sha256", "verification_method",
                "verified_at", "verification_reference", "verified_by", "revoked_at", "revocation_reference", "revoked_by",
                "supersedes", "correction_reason", "exception_status", "exception_reason",
            ],
            limit_page_length=500,
        )
        command = None
        if previous and previous.get("status") != document.get("status"):
            if document.get("status") == "Verified":
                command = "verify"
            elif document.get("status") == "Revoked":
                command = "revoke"
        try:
            validate_authority_record(
                _as_dict(document),
                previous=_as_dict(previous) if previous else None,
                context={
                    "superseded_record": superseded,
                    "existing_records": existing,
                    "command": command,
                    "require_issuer_readback": document.get("status") in {
                        "Verified", "Revoked", "Contradictory"
                    } and document.get("authority_kind") in {
                        "Trade Licence", "WCB Clearance", "Insurance Certificate", "Permit",
                        "Inspection", "Manufacturer Certification", "Manufacturer Bulletin",
                    },
                    "issuer_readback": _parse_authority_readback(document.get("issuer_readback_json")),
                },
            )
        except AuthorityPolicyViolation as exc:
            frappe.throw(str(exc), exc=frappe.ValidationError)
        return
    if kind == "price_book_rule":
        validate_price_policy_approval_mutation(document)
    if kind == "integration_reconciliation":
        validate_quickbooks_reconciliation_issuance(document)
    if kind in {"job_compliance_record", "production_gate_state"} and document.get(
        "status" if kind == "job_compliance_record" else "state"
    ) == "Waived":
        # RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era - the
        # `_production_gate_clearance_waiver_actor(document) or` prefix below, not the
        # rule.  The rule itself is the business bar and survives the cutover; only
        # the bounded command's re-attribution retires with `production_gate_api`.
        #
        # A Desk waiver is made by whoever is signed in.  A waiver made through the
        # bounded production-gate clearance command is made by the actor that command
        # authorized and the Worker integration principal only carries it, so the
        # attribution and the role bar below both apply to that actor.  Either way the
        # rule is unchanged: a waiver names one owner-level human who made it.
        actor = _production_gate_clearance_waiver_actor(document) or getattr(
            getattr(frappe, "session", None), "user", None
        )
        if not actor or actor == "Guest" or document.get("waived_by") != actor:
            frappe.throw(
                "a waiver must be attributed to the current owner-level actor",
                exc=frappe.PermissionError,
            )
        if not {"IronWrap Owner", "System Manager"}.intersection(
            frappe.get_roles(actor)
        ):
            frappe.throw(
                "a waiver requires an IronWrap Owner or System Manager role",
                exc=frappe.PermissionError,
            )
    if kind == "material_takeoff_policy" and document.get("status") == "Approved":
        actor = getattr(getattr(frappe, "session", None), "user", None)
        if (
            not actor
            or actor == "Guest"
            or document.get("approved_by") != actor
            or not frappe.db.exists("User", actor)
        ):
            frappe.throw(
                "a Material Takeoff Policy approval must name the current existing Frappe user",
                exc=frappe.PermissionError,
            )
        if not {"IronWrap Owner", "System Manager"}.intersection(
            frappe.get_roles(actor)
        ):
            frappe.throw(
                "a Material Takeoff Policy approval requires an IronWrap Owner or System Manager role",
                exc=frappe.PermissionError,
            )
    if kind == "job_cost_event":
        actor = getattr(getattr(frappe, "session", None), "user", None)
        if (
            not actor
            or actor == "Guest"
            or document.get("approved_by") != actor
            or not frappe.db.exists("User", actor)
        ):
            frappe.throw(
                "a Job Cost Event must be approved by the current existing Frappe user",
                exc=frappe.PermissionError,
            )
        if not {"IronWrap Finance", "IronWrap Owner", "System Manager"}.intersection(
            frappe.get_roles(actor)
        ):
            frappe.throw(
                "a Job Cost Event requires an IronWrap Finance, Owner, or System Manager approver",
                exc=frappe.PermissionError,
            )
    try:
        validate_record(
            kind,
            _as_dict(document),
            previous=_previous(document),
            context=_context(document, kind),
        )
    except PolicyViolation as exc:
        frappe.throw(str(exc), exc=frappe.ValidationError)


def deny_business_document_delete(_document: Any, _method: str | None = None) -> None:
    """Keep operational facts auditable; corrections must create a new record."""

    frappe.throw(
        "IronWrap business records are append-only and cannot be deleted; create a correction or superseding record.",
        exc=frappe.ValidationError,
    )
