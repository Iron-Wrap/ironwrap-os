"""Thin Frappe adapter for the pure IronWrap domain policy."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import frappe

from ironwrap_roofing.domain_policy import PolicyViolation, validate_record
from ironwrap_roofing.domain_policy import SHOP_ORDER_FINAL_STATUSES, parse_json_field


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
    "scheduled_start",
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
    "version",
    "status",
    "supersedes",
)
_WORK_PACKAGE_CONTEXT_SELECT = ", ".join(WORK_PACKAGE_CONTEXT_FIELDS)
SUPPLIER_ORDER_EXCEPTION_CONTEXT_FIELDS = (
    "name",
    "supplier_order_id",
    "roof_job",
    "status",
)
_SUPPLIER_ORDER_EXCEPTION_CONTEXT_SELECT = ", ".join(
    SUPPLIER_ORDER_EXCEPTION_CONTEXT_FIELDS
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
_TRUSTED_MATERIAL_LOT_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_material_lot_transition", default=None)
_TRUSTED_NONCONFORMANCE_TRANSITION: ContextVar[
    tuple[str, tuple[tuple[str, str], ...]] | None
] = ContextVar("ironwrap_trusted_nonconformance_transition", default=None)
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
WORK_PACKAGE_RUNTIME_FIELDS = (
    "status",
    "released_by",
    "released_at",
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
    "actor_user",
    "actor_role",
    "device_action_id",
    "occurred_at",
    "payload_hash",
    "hold_point_sequence",
    "evidence_item",
    "blocker_reason",
)
MATERIAL_LOT_RUNTIME_FIELDS = ("status",)
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

    if document.get("sync_state") != "Verified":
        return
    previous = _previous(document)
    if previous is not None and previous.get("sync_state") == "Verified":
        return
    if _TRUSTED_FIELD_EVIDENCE_ISSUANCE.get() == _field_evidence_issuance_snapshot(
        document
    ):
        return
    frappe.throw(
        "Evidence Item verification can only be issued by the dedicated Worker command.",
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


def validate_material_lot_runtime_mutation(document: Any) -> None:
    """Keep lot receipt, reservation, and quarantine states command-owned."""

    _validate_draft_only_runtime_mutation(
        document,
        fields=MATERIAL_LOT_RUNTIME_FIELDS,
        trusted=_TRUSTED_MATERIAL_LOT_TRANSITION,
        label="Material Lot",
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
            for row in assignments
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
    elif kind == "material_takeoff":
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
    elif kind == "material_lot":
        context["supplier_order_status"] = _value(
            "Supplier Order", document.get("supplier_order"), "status"
        )
    elif kind == "shop_order":
        context["takeoff_status"] = _value(
            "Material Takeoff", document.get("material_takeoff"), "status"
        )
        context["supplier_order_status"] = _value(
            "Supplier Order", document.get("supplier_order"), "status"
        )
        context["work_package_status"] = _value(
            "Work Package", document.get("work_package"), "status"
        )
        payment_milestone = document.get("invoice_payment_milestone")
        context["invoice_payment_milestone_status"] = _value(
            "Payment Milestone", payment_milestone, "status"
        )
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
    elif work_package_requires_context:
        (
            context["gates"],
            context["gate_evidence"],
            context["job_assignment_rows"],
            context["safety_plan_rows"],
            context["work_package_rows"],
            context["crew_profile_rows"],
            context["job_compliance_rows"],
        ) = _locked_work_package_context(document.get("roof_job"))
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
    if kind in {"job_compliance_record", "production_gate_state"} and document.get(
        "status" if kind == "job_compliance_record" else "state"
    ) == "Waived":
        actor = getattr(getattr(frappe, "session", None), "user", None)
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
