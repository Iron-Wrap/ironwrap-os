"""Thin Frappe adapter for the pure IronWrap domain policy."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import frappe

from ironwrap_roofing.domain_policy import PolicyViolation, validate_record
from ironwrap_roofing.domain_policy import parse_json_field


CORRECTION_TARGETS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "change_order": ("supersedes", "Change Order", ("roof_job", "version")),
    "communication_consent": ("supersedes", "Communication Consent", ("roof_job",)),
    "contract_acceptance": ("supersedes", "Contract Acceptance", ("roof_job",)),
    "customer_decision": ("supersedes", "Customer Decision", ("roof_job",)),
    "customer_quote": (
        "supersedes",
        "Customer Quote",
        ("roof_job", "customer", "quote_version", "status", "contract_acceptance", "accepted_at"),
    ),
    "evidence_item": ("correction_of", "Evidence Item", ("roof_job",)),
    "field_check_in": ("correction_of", "Field Check-in", ("roof_job",)),
    "integration_reconciliation": (
        "supersedes",
        "Integration Reconciliation",
        ("roof_job",),
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


def _as_dict(document: Any) -> Any:
    if document is None:
        return None
    converter = getattr(document, "as_dict", None)
    return converter() if callable(converter) else document


def _previous(document: Any) -> Any:
    getter = getattr(document, "get_doc_before_save", None)
    return _as_dict(getter()) if callable(getter) else None


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


def _context(document: Any, kind: str) -> dict[str, Any]:
    context: dict[str, Any] = {}
    correction = CORRECTION_TARGETS.get(kind)
    if correction:
        link_field, doctype, fields = correction
        target = document.get(link_field)
        if target:
            context["superseded_record"] = frappe.db.get_value(
                doctype, target, fields, as_dict=True
            )
    if kind == "material_takeoff":
        context["measurement_status"] = _value(
            "Measurement Report", document.get("measurement_report"), "review_status"
        )
    elif kind in {"supplier_quote", "supplier_order"}:
        context["takeoff_status"] = _value(
            "Material Takeoff", document.get("material_takeoff"), "status"
        )
        if kind == "supplier_order":
            context["supplier_quote_status"] = _value(
                "Supplier Quote", document.get("source_quote"), "status"
            )
    elif kind == "proposal_evidence_pack":
        quotation = document.get("quotation")
        quote = (
            frappe.db.get_value(
                "Customer Quote",
                quotation,
                ("roof_job", "status", "quote_version"),
                as_dict=True,
            )
            if quotation
            else None
        )
        context["quote_status"] = quote.get("status") if quote else None
        context["quote_roof_job"] = quote.get("roof_job") if quote else None
        context["quote_version"] = quote.get("quote_version") if quote else None
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
    elif kind in {"warranty_packet", "review_request"}:
        context["completion_status"] = _value(
            "Completion Packet", document.get("completion_packet"), "status"
        )
    elif kind == "roof_job" and document.get("job_status") in {
        "In Production",
        "Closed",
    }:
        roof_job = document.get("name") or document.get("roof_job_id")
        context["gates"] = frappe.get_all(
            "Production Gate State",
            filters={"roof_job": roof_job},
            fields=[
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
            ],
        )
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
    elif kind == "white_label_tenant" and document.get("status") == "Active":
        filters: dict[str, Any] = {"status": "Active"}
        if document.get("name"):
            filters["name"] = ["!=", document.get("name")]
        context["other_active_tenants"] = frappe.db.count(
            "White-Label Tenant", filters=filters
        )
    return context


def validate_business_document(document: Any, kind: str) -> None:
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
