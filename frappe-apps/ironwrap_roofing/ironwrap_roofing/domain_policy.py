"""Fail-closed IronWrap OS business rules with no Frappe dependency.

The functions in this module operate on mappings (or mapping-like Frappe
documents) so the policy boundary can be tested without a bench.  Frappe
controllers call :func:`validate_record` through ``document_validation``.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence


MAX_JSON_BYTES = 1_000_000
PRODUCTION_GATES = ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
SCHEDULABLE_PRODUCTION_GATE_STATES = frozenset(("Ready", "Done", "Waived"))
CLOSEOUT_PRODUCTION_GATE_STATES = frozenset(("Done", "Waived"))
ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES = frozenset(
    ("Assigned", "Accepted", "In Progress", "Blocked")
)
RELEASABLE_WORK_PACKAGE_ASSIGNMENT_STATUSES = frozenset(
    ("Assigned", "Accepted", "In Progress")
)
ACTIVE_SUPPLIER_ORDER_EXCEPTION_STATUSES = frozenset(("Needs Review", "Shortage"))
SUPPLIER_ORDER_STATUSES = frozenset(
    (
        "Draft",
        "Needs Review",
        "Approved",
        "Ordered",
        "Partially Received",
        "Received",
        "Shortage",
        "Cancelled",
    )
)
SUPPLIER_ORDER_POST_APPROVAL_STATUSES = frozenset(
    ("Approved", "Ordered", "Partially Received", "Received", "Shortage")
)
SUPPLIER_ORDER_RECEIPT_STATUSES = frozenset(
    ("Partially Received", "Received", "Shortage")
)
SUPPLIER_ORDER_FINAL_STATUSES = frozenset(("Received", "Shortage", "Cancelled"))
SUPPLIER_ORDER_FROZEN_FIELDS = (
    "roof_job",
    "material_takeoff",
    "source_quote",
    "supplier",
    "prepared_at",
    "approved_by",
    "approved_at",
    "requested_delivery_date",
    "order_summary_json",
    "assumptions",
    "exclusions",
    "delivery_notes",
)
SUPPLIER_ORDER_ITEM_FROZEN_FIELDS = (
    "category",
    "item_name",
    "quantity",
    "unit",
    "source_ref",
    "substitution_notes",
    "needs_review",
)
CREW_AUTHORITY_COMPLIANCE_GATES = frozenset(("Crew", "Safety", "Access"))
CURRENT_AUTHORITY_STATUSES = frozenset(("Approved", "Passed", "Waived"))
CURRENT_COMPLIANCE_GATE_STATES = frozenset(("Ready", "Done", "Waived"))
WORK_PACKAGE_RELEASE_STATUSES = frozenset(("Released", "Acknowledged", "In Progress"))
WORK_PACKAGE_FROZEN_FIELDS = (
    "roof_job",
    "job_assignment",
    "safety_plan",
    "version",
    "title",
    "objective",
    "boundaries",
    "prerequisites",
    "expected_result",
    "stop_conditions",
    "make_safe_procedure",
    "issued_at",
    "expires_at",
    "released_by",
    "released_at",
    "supersedes",
    "correction_reason",
    "steps",
    "hold_points",
)
WORK_PACKAGE_EVENT_TYPES = frozenset(
    (
        "Acknowledged",
        "Started",
        "Stop Work",
        "Released",
        "Hold Point Evidence",
        "Hold Point Released",
    )
)
SHOP_ORDER_RELEASED_STATUSES = frozenset(
    (
        "Released",
        "Reserved",
        "Setup / First Piece",
        "In Fabrication",
        "Quality Hold",
        "Ready",
        "Handed Over",
        "Invoice Ready",
        "Closed",
    )
)
SHOP_ORDER_FINAL_STATUSES = frozenset(
    ("Ready", "Handed Over", "Invoice Ready", "Closed")
)


class PolicyViolation(ValueError):
    """A deterministic business-policy rejection safe to show to operators."""

    def __init__(self, code: str, message: str, field: str | None = None):
        self.code = code
        self.field = field
        prefix = f"[{code}]"
        if field:
            prefix += f" {field}:"
        super().__init__(f"{prefix} {message}")


def _get(record: Any, field: str, default: Any = None) -> Any:
    if record is None:
        return default
    if isinstance(record, Mapping):
        return record.get(field, default)
    getter = getattr(record, "get", None)
    if callable(getter):
        return getter(field, default)
    return getattr(record, field, default)


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def require_fields(record: Any, *fields: str) -> None:
    missing = [field for field in fields if _blank(_get(record, field))]
    if missing:
        raise PolicyViolation("required_fields", f"required: {', '.join(missing)}")


def _unique_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PolicyViolation("invalid_json", f"duplicate key {key!r}")
        result[key] = value
    return result


def require_sha256(record: Any, *fields: str) -> None:
    """Require canonical lowercase SHA-256 hex for durable evidence identities."""

    for field in fields:
        value = _get(record, field)
        normalized = value.strip() if isinstance(value, str) else ""
        if len(normalized) != 64 or any(
            character not in "0123456789abcdef" for character in normalized
        ):
            raise PolicyViolation(
                "invalid_sha256", "must be 64 lowercase hexadecimal characters", field
            )


def _reject_json_constant(value: str) -> None:
    raise PolicyViolation(
        "invalid_json", f"non-finite number {value!r} is not valid JSON"
    )


def parse_json_field(
    record: Any,
    field: str,
    *,
    required: bool = False,
    container_types: tuple[type, ...] = (dict, list),
    non_empty: bool = False,
) -> Any:
    """Parse a Code/JSON contract strictly and reject scalars or duplicate keys."""

    raw = _get(record, field)
    if _blank(raw):
        if required:
            raise PolicyViolation("required_json", "a JSON contract is required", field)
        return None
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > MAX_JSON_BYTES:
            raise PolicyViolation("json_too_large", "JSON contract exceeds 1 MB", field)
        try:
            value = json.loads(
                raw,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_json_constant,
            )
        except PolicyViolation:
            raise
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise PolicyViolation("invalid_json", str(exc), field) from exc
    else:
        value = raw
    if not isinstance(value, container_types):
        allowed = " or ".join(item.__name__ for item in container_types)
        raise PolicyViolation("invalid_json_shape", f"expected {allowed}", field)
    if non_empty and not value:
        raise PolicyViolation("empty_json_contract", "must not be empty", field)
    return value


def _decimal(record: Any, field: str, *, required: bool = False) -> Decimal | None:
    value = _get(record, field)
    if _blank(value):
        if required:
            raise PolicyViolation(
                "required_number", "a numeric value is required", field
            )
        return None
    if isinstance(value, bool):
        raise PolicyViolation("invalid_number", "boolean is not a number", field)
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise PolicyViolation("invalid_number", "must be numeric", field) from exc
    if not math.isfinite(float(number)):
        raise PolicyViolation("invalid_number", "must be finite", field)
    return number


def require_nonnegative(record: Any, *fields: str, required: bool = False) -> None:
    for field in fields:
        number = _decimal(record, field, required=required)
        if number is not None and number < 0:
            raise PolicyViolation("negative_value", "must be nonnegative", field)


def require_between(
    record: Any,
    field: str,
    minimum: Decimal | int,
    maximum: Decimal | int,
    *,
    required: bool = False,
) -> None:
    number = _decimal(record, field, required=required)
    if number is not None and not Decimal(str(minimum)) <= number <= Decimal(
        str(maximum)
    ):
        raise PolicyViolation(
            "value_out_of_range", f"must be between {minimum} and {maximum}", field
        )


def enforce_immutable(record: Any, previous: Any, *fields: str) -> None:
    if previous is None:
        return
    for field in fields:
        before = _get(previous, field)
        after = _get(record, field)
        if before != after:
            raise PolicyViolation(
                "immutable_field", "cannot change after insert", field
            )


def enforce_write_once(record: Any, previous: Any, *fields: str) -> None:
    if previous is None:
        return
    for field in fields:
        before = _get(previous, field)
        after = _get(record, field)
        # Compare normalized text: MariaDB returns datetimes as datetime objects
        # while writers re-send the same fact as a string. Representation must
        # not matter; only a real value change or clear is a violation.
        if not _blank(before) and str(before) != str(after):
            raise PolicyViolation(
                "write_once_field", "cannot change or clear once set", field
            )


def enforce_truthy_once(record: Any, previous: Any, *fields: str) -> None:
    """Prevent an established true audit fact from being cleared."""

    if previous is None:
        return
    for field in fields:
        if bool(_get(previous, field)) and not bool(_get(record, field)):
            raise PolicyViolation("truthy_once_field", "cannot clear once true", field)


def require_approval(
    record: Any,
    *,
    actor: str = "approved_by",
    timestamp: str = "approved_at",
    note: str | None = None,
) -> None:
    fields = [actor, timestamp]
    if note:
        fields.append(note)
    require_fields(record, *fields)


IDENTITY_FIELDS: dict[str, tuple[str, ...]] = {
    "appointment_request": ("appointment_request_id",),
    "automation_incident": ("incident_id",),
    "change_order": ("change_order_id",),
    "communication_event": ("communication_event_id",),
    "communication_consent": ("consent_id",),
    "completion_packet": ("completion_packet_id",),
    "contract_acceptance": ("acceptance_id",),
    "controlled_item": ("controlled_item_id",),
    "crew_profile": ("crew_profile_id",),
    "customer_decision": ("decision_id",),
    "customer_quote": ("customer_quote_id",),
    "evidence_item": ("evidence_id",),
    "field_check_in": ("checkin_id",),
    "hermes_run": ("run_id",),
    "instant_estimate_session": ("estimate_session_id",),
    "integration_reconciliation": ("reconciliation_id",),
    "insurance_supplement": ("insurance_supplement_id",),
    "job_assignment": ("assignment_id",),
    "job_compliance_record": ("compliance_record_id",),
    "lead_envelope": ("envelope_id",),
    "material_lot": ("material_lot_id",),
    "market_watch_item": ("watch_id",),
    "material_takeoff": ("takeoff_id",),
    "measurement_report": ("measurement_id",),
    "nonconformance": ("nonconformance_id",),
    "option_package": ("option_package_id",),
    "payment_milestone": ("payment_milestone_id",),
    "price_book_rule": ("price_rule_id",),
    "production_gate_state": ("gate_id",),
    "proposal_evidence_pack": ("pack_id",),
    "reception_session": ("session_id",),
    "review_request": ("review_request_id",),
    "roof_area": ("roof_area_id",),
    "roof_job": ("roof_job_id",),
    "roofing_customer": ("customer_id",),
    "roofing_property": ("property_key",),
    "safety_plan": ("safety_plan_id",),
    "shop_order": ("shop_order_id",),
    "scope_clause": ("scope_clause_id",),
    "supplier_order": ("supplier_order_id",),
    "supplier_profile": ("supplier_id",),
    "supplier_quote": ("supplier_quote_id",),
    "tenant_export_run": ("export_run_id",),
    "visual_property_model": ("visual_model_id",),
    "warranty_packet": ("warranty_packet_id",),
    "white_label_tenant": ("tenant_id",),
    "work_package": ("work_package_id",),
    "work_package_event": ("work_package_event_id",),
}

QUICKBOOKS_FINANCE_ENTITY_TYPES = frozenset({"Invoice", "Payment", "CreditMemo", "RefundReceipt"})
QUICKBOOKS_MILESTONE_TYPES = {
    "Invoice": "Invoice",
    "Payment": "Payment",
    "CreditMemo": "Credit",
    "RefundReceipt": "Refund",
}
QUICKBOOKS_FINANCE_OPERATIONS = frozenset({"Create", "Update", "Delete", "Void"})


WRITE_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "appointment_request": (
        "reception_session",
        "lead_envelope",
        "roof_job",
        "booking_mode",
        "provider",
        "requested_at",
        "confirmed_external_id",
    ),
    "change_order": (
        "roof_job",
        "customer_quote",
        "change_number",
        "version",
        "requested_by",
        "requested_at",
        "supersedes",
    ),
    "communication_event": ("provider_message_id",),
    "communication_consent": (
        "customer",
        "lead_envelope",
        "roof_job",
        "channel",
        "purpose",
        "status",
        "jurisdiction",
        "consent_basis",
        "source_system",
        "source_reference",
        "captured_by",
        "captured_at",
        "effective_from",
        "expires_at",
        "proof_evidence",
        "revoked_at",
        "supersedes",
        "correction_reason",
    ),
    "contract_acceptance": (
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
    ),
    "customer_decision": (
        "roof_job",
        "customer",
        "decision_type",
        "status",
        "decision_value",
        "decision_summary",
        "source_channel",
        "decided_at",
        "captured_by",
        "evidence_item",
        "option_package",
        "change_order",
        "supersedes",
        "correction_reason",
    ),
    "customer_quote": (
        "roof_job",
        "customer",
        "quote_version",
        "price_rule_snapshot_json",
        "supersedes",
    ),
    "evidence_item": (
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
        "verified_at",
        "verification_source",
        "correction_of",
        "correction_reason",
    ),
    "field_check_in": (
        "device_action_id",
        "roof_job",
        "job_assignment",
        "crew_profile",
        "source_system",
        "capture_actor",
        "capture_started_at",
        "capture_completed_at",
        "submitted_at",
        "raw_key",
        "correction_of",
        "correction_reason",
    ),
    "hermes_run": (
        "run_ts",
        "agent_role",
        "requested_by",
        "request_text",
        "target_doctype",
        "target_name",
        "capability_level",
        "tool_name",
        "tool_args_json",
        "dry_run_json",
        "policy_check_json",
        "policy_checked_at",
        "policy_checked_by",
        "approved_by",
        "approved_at",
        "audit_event_id",
        "audit_incident_id",
        "request_correlation_id",
        "before_target_ids",
        "after_target_ids",
        "result_json",
        "error",
        "completed_at",
    ),
    "lead_envelope": (
        "source",
        "event_ts",
        "raw_key",
        # Bridge identifiers are unknown on owned-first intake. Allow their
        # first verified JobNimbus value, then freeze it permanently.
        "jobnimbus_contact_id",
        "jobnimbus_job_id",
    ),
    "measurement_report": ("provider", "source_file", "raw_key"),
    "integration_reconciliation": (
        "system_name",
        "entity_type",
        "external_entity_id",
        "local_doctype",
        "local_name",
        "direction",
        "detected_at",
        "raw_key",
        "source_payload_hash",
        "local_payload_hash",
        "supersedes",
    ),
    "insurance_supplement": (
        "roof_job",
        "customer_quote",
        "change_order",
        "version",
        "supersedes",
        "evidence_manifest_json",
    ),
    "job_assignment": (
        "roof_job",
        "assignment_type",
        "crew_profile",
        "assigned_user",
        "assigned_by",
        "assigned_at",
        "supersedes",
    ),
    "job_compliance_record": (
        "roof_job",
        "jurisdiction",
        "record_type",
        "authority_name",
        "required_before_gate",
        "supersedes",
    ),
    "payment_milestone": (
        "roof_job",
        "milestone_type",
        "milestone_version",
        "qb_entity_type",
        "qb_entity_id",
        "realm_id",
        "raw_key",
        "raw_payload_hash",
        "supersedes",
    ),
    # A gate's job/gate identity is fixed. Letting either move would bypass the
    # per-job scheduling lock and corrupt the gate lineage.
    "production_gate_state": ("roof_job", "gate"),
    "reception_session": (
        "provider",
        "provider_project_id",
        "provider_agent_id",
        "provider_user_actor_id",
        "provider_conversation_id",
        "channel",
        "direction",
        "lead_envelope",
        "roofing_property",
        "roof_job",
    ),
    "roof_job": (
        "workflow_profile",
        "locale_policy_version",
        "locale_policy_snapshot_json",
        # A JobNimbus mapping is attached after bridge creation, not at owned
        # Roof Job creation; it is therefore write-once rather than immutable.
        "jobnimbus_contact_id",
        "jobnimbus_job_id",
        "qb_invoice_ref",
    ),
    # A customer-visible clause is quote-owned. Once an operator associates it with a job/quote,
    # it must not be silently repointed to a later commercial revision.
    "scope_clause": ("roof_job", "customer_quote"),
    "supplier_order": (
        "internal_transmission_id",
        "internal_transmitted_at",
        "supplier_acknowledgement_id",
        "supplier_acknowledged_at",
        "supplier_acknowledgement_evidence",
        "received_at",
    ),
    "safety_plan": ("roof_job", "version", "prepared_by", "prepared_at", "supersedes"),
    "tenant_export_run": ("tenant", "requested_by", "requested_at", "scope_json", "supersedes"),
    "visual_property_model": ("provider", "provider_model_id", "model_uri", "raw_key"),
    "white_label_tenant": ("site_hostname",),
    "work_package_event": (
        "work_package",
        "roof_job",
        "job_assignment",
        "work_package_version",
        "event_type",
        "actor_user",
        "actor_role",
        "device_action_id",
        "occurred_at",
        "payload_hash",
        "hold_point_sequence",
        "evidence_item",
        "blocker_reason",
    ),
}

TRUTHY_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "hermes_run": ("mutation_applied",),
}

JSON_FIELDS: dict[str, tuple[str, ...]] = {
    "appointment_request": ("preferred_windows_json",),
    "change_order": ("tax_policy_snapshot_json",),
    "communication_event": ("policy_reasons_json",),
    "completion_packet": ("photo_evidence_json", "evidence_summary_json"),
    "contract_acceptance": ("terms_snapshot_json",),
    "customer_quote": (
        "quote_summary_json",
        "tax_policy_snapshot_json",
        "price_rule_snapshot_json",
    ),
    "field_check_in": ("evidence_ids_json",),
    "hermes_run": (
        "tool_args_json",
        "dry_run_json",
        "policy_check_json",
        "result_json",
    ),
    "instant_estimate_session": (
        "selected_services_json",
        "material_choices_json",
        "payload_json",
    ),
    "lead_envelope": ("payload_json",),
    "integration_reconciliation": ("diff_json",),
    "insurance_supplement": ("evidence_manifest_json",),
    "material_takeoff": ("source_measurements_json",),
    "measurement_report": ("roof_graph_json",),
    "option_package": ("options_json", "scope_clause_ids_json"),
    "payment_milestone": ("tax_policy_snapshot_json",),
    "price_book_rule": ("rule_json",),
    "proposal_evidence_pack": ("evidence_summary_json",),
    "reception_session": ("structured_json",),
    "review_request": ("stop_conditions_json",),
    "roof_job": ("locale_policy_snapshot_json",),
    "supplier_order": ("order_summary_json", "receipt_evidence_json"),
    "supplier_quote": ("quote_summary_json",),
    "tenant_export_run": ("scope_json",),
    "visual_property_model": ("screenshots_json", "measurements_json"),
    "warranty_packet": ("evidence_summary_json",),
    "white_label_tenant": (
        "brand_config_json",
        "namespace_config_json",
        "policy_config_json",
    ),
}


def _rows(record: Any, field: str) -> list[Any]:
    value = _get(record, field, [])
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise PolicyViolation("invalid_rows", "must be a child-record list", field)
    return list(value)


def _require_clean_rows(
    record: Any, field: str, *, quantity_field: str | None = None
) -> list[Any]:
    rows = _rows(record, field)
    if not rows:
        raise PolicyViolation(
            "missing_evidence_rows", "at least one row is required", field
        )
    for index, row in enumerate(rows, start=1):
        if bool(_get(row, "needs_review")):
            raise PolicyViolation(
                "unresolved_review", f"row {index} still needs review", field
            )
        if quantity_field:
            number = _decimal(row, quantity_field, required=True)
            if number is not None and number < 0:
                raise PolicyViolation(
                    "negative_value", f"row {index} must be nonnegative", quantity_field
                )
    return rows


def _context_status(context: Mapping[str, Any], key: str) -> str | None:
    value = context.get(key)
    return None if _blank(value) else str(value)


def _require_one_of(record: Any, *fields: str) -> None:
    if not any(not _blank(_get(record, field)) for field in fields):
        raise PolicyViolation(
            "required_reference", f"one of {', '.join(fields)} is required"
        )


def _require_amount_equation(
    record: Any, total_field: str, *part_fields: str
) -> None:
    total = _decimal(record, total_field, required=True)
    parts = [_decimal(record, field, required=True) for field in part_fields]
    if total is None or any(part is None for part in parts):
        return
    expected = sum((part for part in parts if part is not None), Decimal("0"))
    if abs(total - expected) > Decimal("0.01"):
        raise PolicyViolation(
            "amount_mismatch",
            f"must equal {' + '.join(part_fields)}",
            total_field,
        )


def _validate_location(record: Any) -> None:
    latitude = _decimal(record, "latitude")
    longitude = _decimal(record, "longitude")
    if (latitude is None) != (longitude is None):
        raise PolicyViolation(
            "incomplete_location", "latitude and longitude must be captured together"
        )
    if latitude is not None and not Decimal("-90") <= latitude <= Decimal("90"):
        raise PolicyViolation("invalid_location", "must be between -90 and 90", "latitude")
    if longitude is not None and not Decimal("-180") <= longitude <= Decimal("180"):
        raise PolicyViolation(
            "invalid_location", "must be between -180 and 180", "longitude"
        )
    require_nonnegative(record, "location_accuracy_m")


def _validate_correction(
    record: Any,
    context: Mapping[str, Any],
    *,
    link_field: str = "supersedes",
    version_field: str | None = None,
) -> None:
    corrected = _get(record, link_field)
    if _blank(corrected):
        return
    require_fields(record, "correction_reason")
    if corrected in {_get(record, "name"), *_get_identity_values(record)}:
        raise PolicyViolation("self_correction", "a record cannot correct itself", link_field)
    prior = context.get("superseded_record")
    if prior is None:
        raise PolicyViolation(
            "unverified_correction", "the superseded record could not be verified", link_field
        )
    current_job = _get(record, "roof_job")
    prior_job = _get(prior, "roof_job")
    if current_job and prior_job and current_job != prior_job:
        raise PolicyViolation(
            "cross_job_correction", "corrections must remain on the same Roof Job", link_field
        )
    if version_field:
        current_version = _decimal(record, version_field, required=True)
        prior_version = _decimal(prior, version_field, required=True)
        if current_version is not None and prior_version is not None and current_version <= prior_version:
            raise PolicyViolation(
                "stale_version", "correction version must exceed the superseded version", version_field
            )


def _get_identity_values(record: Any) -> set[Any]:
    values = {_get(record, "name")}
    for fields in IDENTITY_FIELDS.values():
        values.update(_get(record, field) for field in fields)
    return {value for value in values if not _blank(value)}


def _lock_after_status(
    record: Any, context: Mapping[str, Any], statuses: set[str], *fields: str
) -> None:
    previous = context.get("_previous")
    if previous is not None and _get(previous, "status") in statuses:
        enforce_immutable(record, previous, *fields)


def _enforce_state_transition(
    record: Any,
    context: Mapping[str, Any],
    field: str,
    allowed: Mapping[str, set[str]],
) -> None:
    previous = context.get("_previous")
    if previous is None:
        return
    before = _get(previous, field)
    after = _get(record, field)
    if before == after:
        return
    if after not in allowed.get(str(before), set()):
        raise PolicyViolation(
            "invalid_state_transition", f"cannot move from {before!r} to {after!r}", field
        )


def _validate_evidence(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "content_length")
    _validate_location(record)
    _enforce_state_transition(
        record,
        context,
        "sync_state",
        {
            "Local": {"Queued", "Rejected", "Superseded"},
            "Queued": {"Uploaded", "Rejected", "Superseded"},
            "Uploaded": {"Verified", "Rejected", "Superseded"},
            "Verified": {"Superseded"},
            "Rejected": {"Queued", "Superseded"},
            "Superseded": set(),
        },
    )
    if _get(record, "sync_state") == "Verified":
        require_fields(
            record,
            "content_checksum",
            "checksum_algorithm",
            "content_type",
            "content_length",
            "capture_actor",
            "captured_at",
            "proof_owner",
            "proof_slot",
            "verified_at",
            "verification_source",
        )
        if _get(record, "checksum_algorithm") != "SHA-256":
            raise PolicyViolation(
                "unsupported_checksum", "verified evidence must use SHA-256", "checksum_algorithm"
            )
        require_sha256(record, "content_checksum")
        _require_one_of(record, "source_uri", "r2_key", "drive_file_id")
    _validate_correction(record, context, link_field="correction_of")


def _validate_field_checkin(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "photo_count")
    _validate_location(record)
    _enforce_state_transition(
        record,
        context,
        "sync_state",
        {
            "Local": {"Queued", "Rejected", "Superseded"},
            "Queued": {"Uploaded", "Rejected", "Superseded"},
            "Uploaded": {"Verified", "Rejected", "Superseded"},
            "Verified": {"Superseded"},
            "Rejected": {"Queued", "Superseded"},
            "Superseded": set(),
        },
    )
    started = _get(record, "capture_started_at")
    completed = _get(record, "capture_completed_at")
    if started and completed and str(started) > str(completed):
        raise PolicyViolation("invalid_capture_window", "capture start must precede completion")
    if _get(record, "status") != "Draft":
        require_fields(record, "roof_job", "device_action_id", "capture_actor", "submitted_at")
    if _get(record, "sync_state") == "Verified":
        require_fields(record, "verified_at", "evidence_ids_json")
        parse_json_field(record, "evidence_ids_json", required=True, container_types=(list,), non_empty=True)
    if bool(_get(record, "blocker_flag")):
        require_fields(record, "blocker_category", "blocker_summary")
    elif any(not _blank(_get(record, field)) for field in ("blocker_category", "blocker_summary")):
        raise PolicyViolation("stale_blocker", "blocker details require blocker_flag")
    _validate_correction(record, context, link_field="correction_of")


def _validate_crew_profile(record: Any, _context: Mapping[str, Any]) -> None:
    if _get(record, "status") == "Active":
        require_fields(record, "crew_name", "primary_lead", "home_region", "timezone")
        rows = _rows(record, "members")
        if not rows:
            raise PolicyViolation("missing_crew_members", "an active crew requires members")
        active_users = [_get(row, "crew_user") for row in rows if bool(_get(row, "active"))]
        if not active_users or any(_blank(user) for user in active_users):
            raise PolicyViolation("missing_active_member", "active crew members require a user")
        if len(active_users) != len(set(active_users)):
            raise PolicyViolation("duplicate_crew_member", "active crew users must be unique")
        if _get(record, "primary_lead") not in active_users:
            raise PolicyViolation("invalid_crew_lead", "primary lead must be an active member")
        require_fields(
            record,
            "competency_status",
            "competency_checked_at",
            "competency_expiry",
            "equipment_status",
            "equipment_checked_at",
            "equipment_expiry",
        )
        if _get(record, "crew_type") in {"Subcontractor", "Mixed"}:
            require_fields(record, "wcb_status", "wcb_checked_at", "wcb_expiry")
        if bool(_get(record, "active_stop")):
            require_fields(record, "active_stop_at", "active_stop_reason")
        elif any(
            not _blank(_get(record, field))
            for field in ("active_stop_at", "active_stop_reason")
        ):
            raise PolicyViolation(
                "stale_active_stop",
                "active stop details are valid only while the stop is active",
                "active_stop_reason",
            )


def _current_rows(rows: Sequence[Any], *, identity_field: str) -> list[Any]:
    superseded = {
        str(_get(row, "supersedes"))
        for row in rows
        if not _blank(_get(row, "supersedes"))
    }
    return [
        row
        for row in rows
        if _record_references(row, identity_field).isdisjoint(superseded)
    ]


def _reference_date(value: Any) -> str | None:
    if _blank(value):
        return None
    return str(value).strip()[:10]


def _require_future_or_present(
    record: Any, field: str, reference_date: str, code: str, message: str
) -> None:
    value = _reference_date(_get(record, field))
    if not value or value < reference_date:
        raise PolicyViolation(code, message, field)


def _require_effective_on_or_before(
    record: Any, field: str, reference_date: str, code: str, message: str
) -> None:
    value = _reference_date(_get(record, field))
    if not value or value > reference_date:
        raise PolicyViolation(code, message, field)


def _require_crew_authority_ready(
    crew: Any | None, reference_date: str, *, field: str = "crew_profile"
) -> None:
    if crew is None:
        raise PolicyViolation(
            "unverified_assignment_crew_profile",
            "the linked Crew Profile could not be verified",
            field,
        )
    if _get(crew, "status") != "Active":
        raise PolicyViolation(
            "inactive_assignment_crew_profile",
            "the linked Crew Profile must be Active",
            field,
        )
    if _get(crew, "competency_status") != "Current":
        raise PolicyViolation(
            "crew_competency_not_current",
            "the linked Crew Profile does not have current competency authority",
            field,
        )
    if _get(crew, "equipment_status") != "Safe":
        raise PolicyViolation(
            "unsafe_crew_equipment",
            "the linked Crew Profile does not have safe inspected equipment authority",
            field,
        )
    if bool(_get(crew, "active_stop")):
        raise PolicyViolation(
            "active_crew_stop",
            "the linked Crew Profile has an active stop and cannot be scheduled or released",
            field,
        )
    if _get(crew, "crew_type") in {"Subcontractor", "Mixed"}:
        if _get(crew, "wcb_status") != "Current":
            raise PolicyViolation(
                "crew_wcb_not_current",
                "the linked Crew Profile does not have current WCB authority",
                field,
            )
        _require_future_or_present(
            crew,
            "wcb_expiry",
            reference_date,
            "crew_wcb_expired",
            "the linked Crew Profile WCB authority expires before the scheduled or released work",
        )
    _require_future_or_present(
        crew,
        "competency_expiry",
        reference_date,
        "crew_competency_expired",
        "the linked Crew Profile competency expires before the scheduled or released work",
    )
    _require_future_or_present(
        crew,
        "equipment_expiry",
        reference_date,
        "crew_equipment_inspection_expired",
        "the linked Crew Profile equipment inspection expires before the scheduled or released work",
    )


def _require_current_compliance_authority(
    rows: Sequence[Any], reference_date: str, gates: Sequence[Any]
) -> None:
    required_gates = {
        str(_get(gate, "gate"))
        for gate in gates
        if _get(gate, "gate") in CREW_AUTHORITY_COMPLIANCE_GATES
        and _get(gate, "state") in CURRENT_COMPLIANCE_GATE_STATES
    }
    current_rows = _current_rows(rows, identity_field="compliance_record_id")
    for gate in sorted(required_gates):
        matching_rows = [
            row
            for row in current_rows
            if _get(row, "required_before_gate") == gate
        ]
        if not matching_rows:
            raise PolicyViolation(
                "missing_compliance_authority",
                f"a current {gate} compliance authority is required before scheduling or release",
                "required_before_gate",
            )
        if len(matching_rows) != 1:
            raise PolicyViolation(
                "ambiguous_compliance_authority",
                f"exactly one current {gate} compliance authority is required before scheduling or release",
                "required_before_gate",
            )
        row = matching_rows[0]
        if _get(row, "status") not in CURRENT_AUTHORITY_STATUSES:
            raise PolicyViolation(
                "compliance_gate_block",
                "current Crew/Safety/Access compliance authority is required before scheduling or release",
                "required_before_gate",
            )
        _require_effective_on_or_before(
            row,
            "effective_date",
            reference_date,
            "compliance_authority_not_effective",
            "a current Crew/Safety/Access compliance authority is not effective for the scheduled or released work",
        )
        _require_future_or_present(
            row,
            "expiry_date",
            reference_date,
            "expired_compliance_authority",
            "a current Crew/Safety/Access compliance authority expires before the scheduled or released work",
        )


def _assignment_references(record: Any) -> set[str]:
    return {
        str(value)
        for value in (_get(record, "name"), _get(record, "assignment_id"))
        if not _blank(value)
    }


def _logical_current_scheduled_production_assignments(
    rows: Sequence[Any],
) -> list[Any]:
    superseded = {
        str(_get(row, "supersedes"))
        for row in rows
        if not _blank(_get(row, "supersedes"))
    }
    return [
        row
        for row in rows
        if _get(row, "assignment_type") == "Production"
        and not _blank(_get(row, "scheduled_start"))
        and _get(row, "status") in ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES
        and _assignment_references(row).isdisjoint(superseded)
    ]


def _validate_scheduled_production_execution_fences(
    record: Any, context: Mapping[str, Any]
) -> None:
    """Apply the locked, same-job execution facts supplied by the Frappe adapter."""

    if not (
        _get(record, "assignment_type") == "Production"
        and not _blank(_get(record, "scheduled_start"))
        and _get(record, "status")
        in ACTIVE_SCHEDULED_PRODUCTION_ASSIGNMENT_STATUSES
    ):
        return

    if any(
        _get(row, "status") in ACTIVE_SUPPLIER_ORDER_EXCEPTION_STATUSES
        for row in context.get("supplier_order_exception_rows", ())
    ):
        raise PolicyViolation(
            "material_exception_blocks_production_schedule",
            "resolve Supplier Order Needs Review or Shortage exceptions before scheduling production",
        )

    rows = tuple(context.get("job_assignment_rows", ()))
    current_rows = _logical_current_scheduled_production_assignments(rows)
    self_references = _assignment_references(record)
    other_current_rows = [
        row
        for row in current_rows
        if self_references.isdisjoint(_assignment_references(row))
    ]
    supersedes = _get(record, "supersedes")
    previous = context.get("_previous")

    if _blank(supersedes):
        if other_current_rows:
            raise PolicyViolation(
                "duplicate_current_production_assignment",
                "only one current active scheduled Production assignment may exist per Roof Job",
            )
        return

    # An existing correction is revalidated during lifecycle updates. Its source is
    # intentionally absent from the logical-current set because this record supersedes it.
    if previous is not None and _get(previous, "supersedes") == supersedes:
        if other_current_rows:
            raise PolicyViolation(
                "duplicate_current_production_assignment",
                "only one current active scheduled Production assignment may exist per Roof Job",
            )
        return

    if len(current_rows) > 1:
        raise PolicyViolation(
            "duplicate_current_production_assignment",
            "only one current active scheduled Production assignment may exist per Roof Job",
        )
    if any(str(supersedes) in _assignment_references(row) for row in current_rows):
        return
    if any(str(supersedes) in _assignment_references(row) for row in rows):
        raise PolicyViolation(
            "stale_production_assignment_correction",
            "a schedule correction must supersede the current active Production assignment",
            "supersedes",
        )
    raise PolicyViolation(
        "invalid_production_assignment_correction",
        "a schedule correction must supersede the current active Production assignment",
        "supersedes",
    )


def _validate_job_assignment(record: Any, context: Mapping[str, Any]) -> None:
    has_crew = not _blank(_get(record, "crew_profile"))
    has_user = not _blank(_get(record, "assigned_user"))
    if has_crew == has_user:
        raise PolicyViolation("assignment_target", "assign exactly one crew or user")
    if _get(record, "assignment_type") == "Production" and has_user:
        raise PolicyViolation(
            "production_assignment_requires_crew_profile",
            "a Production assignment must target a Crew Profile with current authority",
            "crew_profile",
        )
    start = _get(record, "scheduled_start")
    end = _get(record, "scheduled_end")
    if not _blank(end) and _blank(start):
        raise PolicyViolation(
            "scheduled_end_requires_start",
            "scheduled end requires a scheduled start",
            "scheduled_end",
        )
    if start and end and str(start) >= str(end):
        raise PolicyViolation("invalid_assignment_window", "scheduled start must precede end")
    if _get(record, "assignment_type") == "Production" and not _blank(start):
        _require_production_gate_states(
            context.get("gates", ()),
            SCHEDULABLE_PRODUCTION_GATE_STATES,
            "production_schedule_gate_block",
            context,
        )
        if has_crew:
            reference_date = _reference_date(start)
            if reference_date:
                _require_crew_authority_ready(
                    context.get("scheduled_assignment_crew_profile"),
                    reference_date,
                )
                _require_current_compliance_authority(
                    context.get("job_compliance_rows", ()),
                    reference_date,
                    context.get("gates", ()),
                )
    status = _get(record, "status")
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Proposed": {"Assigned", "Cancelled", "Superseded"},
            "Assigned": {"Accepted", "Blocked", "Cancelled", "Superseded"},
            "Accepted": {"In Progress", "Blocked", "Cancelled", "Superseded"},
            "In Progress": {"Blocked", "Completed", "Superseded"},
            "Blocked": {"Assigned", "Accepted", "In Progress", "Cancelled", "Superseded"},
            "Completed": {"Superseded"},
            "Cancelled": {"Superseded"},
            "Superseded": set(),
        },
    )
    if status in {"Assigned", "Accepted", "In Progress", "Completed", "Blocked"}:
        require_fields(record, "assigned_by", "assigned_at")
    if status in {"Accepted", "In Progress", "Completed"}:
        require_fields(record, "accepted_at")
    if status in {"In Progress", "Completed"}:
        require_fields(record, "started_at")
    if status == "Completed":
        require_fields(record, "completed_at")
    if status == "Blocked":
        require_fields(record, "blocker_reason")
    _validate_correction(record, context)
    _validate_scheduled_production_execution_fences(record, context)


def _record_references(record: Any, identity_field: str) -> set[str]:
    return {
        str(value)
        for value in (_get(record, "name"), _get(record, identity_field))
        if not _blank(value)
    }


def _is_current_record(
    record: Any,
    rows: Sequence[Any],
    *,
    identity_field: str,
) -> bool:
    references = _record_references(record, identity_field)
    superseded = {
        str(_get(row, "supersedes"))
        for row in rows
        if not _blank(_get(row, "supersedes"))
    }
    return references.isdisjoint(superseded)


def _validate_ordered_work_package_rows(
    record: Any,
    field: str,
    *,
    row_label: str,
    required_fields: tuple[str, ...],
) -> None:
    rows = _rows(record, field)
    if not rows:
        raise PolicyViolation(
            "missing_work_package_rows",
            f"a released Work Package requires at least one {row_label}",
            field,
        )
    for expected_sequence, row in enumerate(rows, start=1):
        sequence = _decimal(row, "sequence", required=True)
        if sequence != expected_sequence:
            raise PolicyViolation(
                "invalid_work_package_sequence",
                f"{row_label} sequence must be contiguous and start at 1",
                field,
            )
        require_fields(row, *required_fields)


def _validate_work_package_release_context(
    record: Any, context: Mapping[str, Any]
) -> None:
    assignment = context.get("work_package_assignment")
    if assignment is None:
        raise PolicyViolation(
            "unverified_work_package_assignment",
            "the linked Job Assignment could not be verified",
            "job_assignment",
        )
    if _get(assignment, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_work_package_assignment",
            "the linked Job Assignment must belong to the Work Package Roof Job",
            "job_assignment",
        )
    if _get(assignment, "assignment_type") != "Production":
        raise PolicyViolation(
            "invalid_work_package_assignment",
            "a Work Package release requires a Production Job Assignment",
            "job_assignment",
        )
    if (
        _get(assignment, "status")
        not in RELEASABLE_WORK_PACKAGE_ASSIGNMENT_STATUSES
    ):
        raise PolicyViolation(
            "inactive_work_package_assignment",
            "the linked Job Assignment must be active before release",
            "job_assignment",
        )
    if _blank(_get(assignment, "scheduled_start")):
        raise PolicyViolation(
            "unscheduled_work_package_assignment",
            "the linked Production Job Assignment must be scheduled before release",
            "job_assignment",
        )
    if not _is_current_record(
        assignment,
        context.get("job_assignment_rows", ()),
        identity_field="assignment_id",
    ):
        raise PolicyViolation(
            "stale_work_package_assignment",
            "the linked Job Assignment has been superseded",
            "job_assignment",
        )
    if _blank(_get(assignment, "crew_profile")):
        raise PolicyViolation(
            "work_package_crew_authority_required",
            "a released Work Package requires a Crew Profile with current authority",
            "job_assignment",
        )
    reference_date = _reference_date(
        context.get("now") or _get(record, "released_at") or _get(record, "issued_at")
    )
    if reference_date:
        _require_crew_authority_ready(
            context.get("work_package_crew_profile"),
            reference_date,
            field="job_assignment",
        )
        _require_current_compliance_authority(
            context.get("job_compliance_rows", ()),
            reference_date,
            context.get("gates", ()),
        )

    safety_plan = context.get("work_package_safety_plan")
    if safety_plan is None:
        raise PolicyViolation(
            "unverified_work_package_safety_plan",
            "the linked Safety Plan could not be verified",
            "safety_plan",
        )
    if _get(safety_plan, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_work_package_safety_plan",
            "the linked Safety Plan must belong to the Work Package Roof Job",
            "safety_plan",
        )
    if _get(safety_plan, "status") != "Acknowledged":
        raise PolicyViolation(
            "unacknowledged_work_package_safety_plan",
            "the linked Safety Plan must be Acknowledged before release",
            "safety_plan",
        )
    if not _is_current_record(
        safety_plan,
        context.get("safety_plan_rows", ()),
        identity_field="safety_plan_id",
    ):
        raise PolicyViolation(
            "stale_work_package_safety_plan",
            "the linked Safety Plan has been superseded",
            "safety_plan",
        )

    _require_production_gate_states(
        context.get("gates", ()),
        SCHEDULABLE_PRODUCTION_GATE_STATES,
        "work_package_production_gate_block",
        context,
    )


def _validate_work_package(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    require_fields(record, "roof_job", "job_assignment", "safety_plan", "version", "status")
    version = _decimal(record, "version", required=True)
    if version is not None and version < 1:
        raise PolicyViolation(
            "invalid_work_package_version",
            "version must be at least 1",
            "version",
        )
    if context.get("_previous") is None and status not in {"Draft", "Released"}:
        raise PolicyViolation(
            "invalid_work_package_initial_state",
            "a Work Package must start as Draft or be released with current controls",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Released", "Superseded"},
            "Released": {"Acknowledged", "Blocked", "Superseded"},
            "Acknowledged": {"In Progress", "Blocked", "Superseded"},
            "In Progress": {"Blocked", "Completed", "Superseded"},
            "Blocked": {"Released", "Superseded"},
            "Completed": {"Superseded"},
            "Superseded": set(),
        },
    )
    if status in WORK_PACKAGE_RELEASE_STATUSES:
        require_fields(
            record,
            "roof_job",
            "job_assignment",
            "safety_plan",
            "version",
            "title",
            "objective",
            "boundaries",
            "prerequisites",
            "expected_result",
            "stop_conditions",
            "make_safe_procedure",
            "issued_at",
            "expires_at",
            "released_by",
            "released_at",
        )
        issued_at = _get(record, "issued_at")
        expires_at = _get(record, "expires_at")
        released_at = _get(record, "released_at")
        if str(issued_at) >= str(expires_at) or str(released_at) >= str(expires_at):
            raise PolicyViolation(
                "invalid_work_package_expiry",
                "issue and release times must precede expiry",
                "expires_at",
            )
        now = context.get("now")
        if now is not None and str(now) >= str(expires_at):
            raise PolicyViolation(
                "expired_work_package",
                "an expired Work Package cannot be released or resumed",
                "expires_at",
            )
        _validate_ordered_work_package_rows(
            record,
            "steps",
            row_label="step",
            required_fields=("instruction", "required_evidence", "acceptance_criteria"),
        )
        _validate_ordered_work_package_rows(
            record,
            "hold_points",
            row_label="hold point",
            required_fields=(
                "hold_point",
                "release_authority",
                "required_evidence",
                "acceptance_criteria",
            ),
        )
        if not _is_current_record(
            record,
            context.get("work_package_rows", ()),
            identity_field="work_package_id",
        ):
            raise PolicyViolation(
                "stale_work_package",
                "a superseded Work Package cannot be released or resumed",
            )
        _validate_work_package_release_context(record, context)
    if status == "Acknowledged":
        require_fields(
            record,
            "acknowledged_by",
            "acknowledged_at",
            "acknowledgement_device_action_id",
        )
    if status == "In Progress":
        require_fields(
            record,
            "acknowledged_by",
            "acknowledged_at",
            "acknowledgement_device_action_id",
            "started_at",
        )
    if status == "Blocked":
        require_fields(
            record,
            "blocked_by",
            "blocked_at",
            "blocked_device_action_id",
            "blocker_reason",
        )
    if status == "Completed":
        require_fields(
            record,
            "acknowledged_by",
            "acknowledged_at",
            "acknowledgement_device_action_id",
            "started_at",
            "completed_at",
        )
    if status == "Superseded" and context.get("superseding_work_package") is None:
        raise PolicyViolation(
            "unverified_work_package_supersession",
            "a superseded Work Package must have a verified replacement",
        )
    _lock_after_status(
        record,
        context,
        set(WORK_PACKAGE_RELEASE_STATUSES) | {"Blocked", "Completed", "Superseded"},
        *WORK_PACKAGE_FROZEN_FIELDS,
    )
    _validate_correction(record, context, version_field="version")


def _validate_work_package_event(record: Any, _context: Mapping[str, Any]) -> None:
    """Validate one immutable runtime fact about a Work Package.

    The command layer owns relation, actor, and transition checks.  This pure
    policy keeps the append-only event itself well-formed even when it is
    inspected or restored without a live Frappe request.
    """

    require_fields(
        record,
        "work_package",
        "roof_job",
        "job_assignment",
        "work_package_version",
        "event_type",
        "actor_user",
        "actor_role",
        "device_action_id",
        "occurred_at",
        "payload_hash",
    )
    event_type = _get(record, "event_type")
    if event_type not in WORK_PACKAGE_EVENT_TYPES:
        raise PolicyViolation(
            "invalid_work_package_event_type",
            "event_type must be a defined Work Package runtime event",
            "event_type",
        )
    version = _decimal(record, "work_package_version", required=True)
    if version is not None and version < 1:
        raise PolicyViolation(
            "invalid_work_package_event_version",
            "work_package_version must be at least 1",
            "work_package_version",
        )
    require_sha256(record, "payload_hash")
    hold_point_sequence = _decimal(record, "hold_point_sequence")
    if event_type in {"Hold Point Evidence", "Hold Point Released"}:
        require_fields(record, "hold_point_sequence", "evidence_item")
        if hold_point_sequence is not None and hold_point_sequence < 1:
            raise PolicyViolation(
                "invalid_hold_point_sequence",
                "hold_point_sequence must be at least 1",
                "hold_point_sequence",
            )
    elif hold_point_sequence is not None or not _blank(_get(record, "evidence_item")):
        raise PolicyViolation(
            "stale_hold_point_event_fields",
            "hold-point fields are only valid for hold-point events",
        )
    if event_type == "Stop Work":
        require_fields(record, "blocker_reason")
    elif not _blank(_get(record, "blocker_reason")):
        raise PolicyViolation(
            "stale_work_package_blocker",
            "blocker_reason is only valid for a Stop Work event",
        )


def _validate_lead_envelope(record: Any, context: Mapping[str, Any]) -> None:
    """Keep business triage distinct from the immutable intake transport facts."""

    triage_status = _get(record, "triage_status")
    # Existing envelopes predate the triage fields. Treat their absent/blank value as
    # Unknown so the schema migration does not turn ordinary updates into rejections.
    if _blank(triage_status):
        triage_status = "Unknown"
    if triage_status not in {"Unknown", "Untriaged", "Triaged"}:
        raise PolicyViolation(
            "invalid_triage_status",
            "must be Unknown, Untriaged, or Triaged",
            "triage_status",
        )

    triage_fields = ("triaged_by", "triaged_at", "triage_summary")
    if triage_status == "Triaged":
        require_fields(record, *triage_fields)
    elif any(not _blank(_get(record, field)) for field in triage_fields):
        raise PolicyViolation(
            "stale_triage_details",
            "triage details require a Triaged status",
            "triage_status",
        )

    previous = context.get("_previous")
    if previous is not None:
        previous_status = _get(previous, "triage_status")
        if _blank(previous_status):
            previous_status = "Unknown"
        if previous_status == "Triaged" and triage_status != "Triaged":
            raise PolicyViolation(
                "invalid_state_transition",
                "cannot move away from Triaged",
                "triage_status",
            )


INSURANCE_SUPPLEMENT_STATUSES = {
    "Draft",
    "Needs Evidence",
    "Ready for Human Review",
    "Approved for Submission",
    "Submitted",
    "Carrier Response Recorded",
    "Closed",
    "Superseded",
}
INSURANCE_EVIDENCE_TYPES = {
    "Carrier Scope": {"PDF", "Email", "Signed Document"},
    "Code/Manufacturer": {"PDF", "Email", "Signed Document"},
    "Photo": {"Photo"},
    "Invoice": {"Invoice"},
    "Submission": {"PDF", "Email", "Signed Document"},
    "Carrier Response": {"PDF", "Email", "Signed Document"},
}
INSURANCE_REVIEW_REQUIRED_ROLES = {
    "Carrier Scope",
    "Code/Manufacturer",
    "Photo",
}
INSURANCE_SUBMISSION_LOCKED_STATUSES = {
    "Approved for Submission",
    "Submitted",
    "Carrier Response Recorded",
    "Closed",
}


def _insurance_evidence_sources(
    record: Any, context: Mapping[str, Any]
) -> list[tuple[str, str, Any]]:
    sources = context.get("insurance_evidence")
    if not isinstance(sources, Mapping):
        sources = {}
    roof_job = _get(record, "roof_job")
    rows = _rows(record, "evidence")
    if len(rows) > 50:
        raise PolicyViolation(
            "insurance_evidence_window_exceeded",
            "insurance supplement source verification is limited to fifty evidence records",
            "evidence",
        )
    evidence_ids: set[str] = set()
    verified_rows: list[tuple[str, str, Any]] = []
    for index, row in enumerate(rows, start=1):
        require_fields(row, "evidence_item", "evidence_role")
        evidence_id = str(_get(row, "evidence_item"))
        role = str(_get(row, "evidence_role"))
        if role not in INSURANCE_EVIDENCE_TYPES:
            raise PolicyViolation(
                "invalid_insurance_evidence_role",
                f"row {index} has an unsupported evidence role",
                "evidence",
            )
        if evidence_id in evidence_ids:
            raise PolicyViolation(
                "duplicate_insurance_evidence",
                f"row {index} repeats an evidence item",
                "evidence",
            )
        evidence_ids.add(evidence_id)
        source = sources.get(evidence_id)
        if source is None:
            raise PolicyViolation(
                "unverified_insurance_evidence",
                f"row {index} evidence source could not be verified",
                "evidence",
            )
        if _get(source, "roof_job") != roof_job:
            raise PolicyViolation(
                "cross_job_insurance_evidence",
                f"row {index} evidence belongs to another Roof Job",
                "evidence",
            )
        if _get(source, "sync_state") != "Verified":
            raise PolicyViolation(
                "unverified_insurance_evidence",
                f"row {index} evidence must be verified",
                "evidence",
            )
        if _get(source, "checksum_algorithm") != "SHA-256":
            raise PolicyViolation(
                "unsupported_checksum",
                f"row {index} evidence must use SHA-256",
                "evidence",
            )
        require_fields(source, "content_checksum", "verified_at", "verification_source")
        require_sha256(source, "content_checksum")
        if not any(
            not _blank(_get(source, field))
            for field in ("source_uri", "r2_key", "drive_file_id")
        ):
            raise PolicyViolation(
                "unverified_insurance_evidence",
                f"row {index} evidence has no durable source pointer",
                "evidence",
            )
        if _get(source, "evidence_type") not in INSURANCE_EVIDENCE_TYPES[role]:
            raise PolicyViolation(
                "invalid_insurance_evidence_type",
                f"row {index} evidence type is not valid for {role}",
                "evidence",
            )
        verified_rows.append((evidence_id, role, source))
    return verified_rows


def _expected_insurance_manifest(
    record: Any, evidence_rows: Sequence[tuple[str, str, Any]]
) -> dict[str, Any]:
    return {
        "roof_job": _get(record, "roof_job"),
        "measurement_report": _get(record, "measurement_report"),
        "evidence": [
            {
                "evidence_item_id": evidence_id,
                "evidence_role": role,
                "evidence_type": _get(source, "evidence_type"),
                "content_checksum": _get(source, "content_checksum"),
                "checksum_algorithm": _get(source, "checksum_algorithm"),
                "verified_at": _get(source, "verified_at"),
                "verification_source": _get(source, "verification_source"),
            }
            for evidence_id, role, source in sorted(
                evidence_rows, key=lambda value: (value[1], value[0])
            )
        ],
    }


def _validate_insurance_manifest(
    record: Any, evidence_rows: Sequence[tuple[str, str, Any]]
) -> None:
    manifest = parse_json_field(
        record,
        "evidence_manifest_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    expected = _expected_insurance_manifest(record, evidence_rows)
    if set(manifest) != set(expected) or manifest != expected:
        raise PolicyViolation(
            "insurance_evidence_manifest_mismatch",
            "must exactly match the currently verified insurance evidence sources",
            "evidence_manifest_json",
        )


def _validate_insurance_supplement(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in INSURANCE_SUPPLEMENT_STATUSES:
        raise PolicyViolation(
            "invalid_insurance_supplement_status",
            "must use a supported internal insurance evidence state",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Needs Evidence", "Ready for Human Review", "Superseded"},
            "Needs Evidence": {"Draft", "Ready for Human Review", "Superseded"},
            "Ready for Human Review": {
                "Needs Evidence",
                "Approved for Submission",
                "Superseded",
            },
            "Approved for Submission": {"Submitted", "Superseded"},
            "Submitted": {"Carrier Response Recorded", "Closed", "Superseded"},
            "Carrier Response Recorded": {"Closed", "Superseded"},
            "Closed": {"Superseded"},
            "Superseded": set(),
        },
    )

    roof_job = _get(record, "roof_job")
    for source_key, link_field, error_code in (
        ("insurance_customer_quote", "customer_quote", "unverified_insurance_quote"),
        ("insurance_change_order", "change_order", "unverified_insurance_change_order"),
    ):
        target = _get(record, link_field)
        if _blank(target):
            continue
        source = context.get(source_key)
        if source is None:
            raise PolicyViolation(error_code, "linked record could not be verified", link_field)
        if _get(source, "roof_job") != roof_job:
            raise PolicyViolation(
                "cross_job_insurance_link",
                "linked record belongs to another Roof Job",
                link_field,
            )

    measurement = context.get("insurance_measurement")
    measurement_id = _get(record, "measurement_report")
    if not _blank(measurement_id):
        if measurement is None:
            raise PolicyViolation(
                "unverified_insurance_measurement",
                "measurement report could not be verified",
                "measurement_report",
            )
        if _get(measurement, "roof_job") != roof_job:
            raise PolicyViolation(
                "cross_job_insurance_measurement",
                "measurement report belongs to another Roof Job",
                "measurement_report",
            )

    evidence_rows = _insurance_evidence_sources(record, context)
    roles = {role for _, role, _ in evidence_rows}
    review_or_later = {
        "Ready for Human Review",
        *INSURANCE_SUBMISSION_LOCKED_STATUSES,
    }
    if status in review_or_later:
        require_fields(
            record,
            "carrier_name",
            "claim_reference",
            "policy_reference",
            "date_of_loss",
            "adjuster_reference",
            "supplement_basis",
            "measurement_report",
        )
        if measurement is None or _get(measurement, "review_status") != "Approved":
            raise PolicyViolation(
                "insurance_measurement_not_approved",
                "ready insurance evidence requires an approved Measurement Report",
                "measurement_report",
            )
        missing_roles = INSURANCE_REVIEW_REQUIRED_ROLES - roles
        if missing_roles:
            raise PolicyViolation(
                "missing_insurance_evidence",
                f"missing required evidence roles: {', '.join(sorted(missing_roles))}",
                "evidence",
            )

    invoice_required = _get(record, "invoice_required") not in {False, 0, "0", "", None}
    invoice_exception = _get(record, "invoice_exception_reason")
    if invoice_required and not _blank(invoice_exception):
        raise PolicyViolation(
            "stale_invoice_exception",
            "invoice exception requires invoice_required to be disabled",
            "invoice_exception_reason",
        )
    if status in review_or_later:
        if invoice_required and "Invoice" not in roles:
            raise PolicyViolation(
                "missing_insurance_invoice",
                "an invoice is required or the reviewer must record a not-applicable reason",
                "evidence",
            )
        if not invoice_required:
            require_fields(record, "invoice_exception_reason")

    if status in INSURANCE_SUBMISSION_LOCKED_STATUSES:
        require_approval(record)
        _validate_insurance_manifest(record, evidence_rows)
    elif not _blank(_get(record, "evidence_manifest_json")):
        raise PolicyViolation(
            "premature_insurance_evidence_manifest",
            "evidence manifest is created only with human approval for submission",
            "evidence_manifest_json",
        )
    elif any(
        not _blank(_get(record, field)) for field in ("approved_by", "approved_at")
    ):
        raise PolicyViolation(
            "stale_insurance_approval",
            "approval metadata requires Approved for Submission or a later state",
            "status",
        )

    if status in {"Submitted", "Carrier Response Recorded", "Closed"}:
        require_fields(record, "submitted_at")
        if "Submission" not in roles:
            raise PolicyViolation(
                "missing_submission_evidence",
                "submitted evidence must record a human submission artifact",
                "evidence",
            )
    if status == "Carrier Response Recorded":
        require_fields(record, "carrier_response_at")
        if "Carrier Response" not in roles:
            raise PolicyViolation(
                "missing_carrier_response_evidence",
                "carrier response state requires a verified response artifact",
                "evidence",
            )
    if status == "Closed":
        require_fields(record, "closed_at", "resolution_summary")

    _lock_after_status(
        record,
        context,
        INSURANCE_SUBMISSION_LOCKED_STATUSES,
        "customer_quote",
        "change_order",
        "carrier_name",
        "claim_reference",
        "policy_reference",
        "date_of_loss",
        "adjuster_reference",
        "supplement_basis",
        "measurement_report",
        "invoice_required",
        "invoice_exception_reason",
        "evidence",
        "evidence_manifest_json",
    )
    _validate_correction(record, context, version_field="version")


def _validate_change_order(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "subtotal", "tax_amount", "total_amount", required=True)
    _require_amount_equation(record, "total_amount", "subtotal", "tax_amount")
    rows = _rows(record, "items")
    for index, row in enumerate(rows, start=1):
        require_fields(row, "item_type", "description", "quantity", "unit", "unit_price", "line_total")
        require_nonnegative(row, "quantity", "unit_price", "line_total", required=True)
        quantity = _decimal(row, "quantity", required=True)
        price = _decimal(row, "unit_price", required=True)
        line_total = _decimal(row, "line_total", required=True)
        if quantity is not None and price is not None and line_total is not None and abs(line_total - quantity * price) > Decimal("0.01"):
            raise PolicyViolation("amount_mismatch", f"item {index} line_total must equal quantity x unit_price", "items")
    status = _get(record, "status")
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Needs Review", "Rejected", "Superseded"},
            "Needs Review": {"Draft", "Approved", "Rejected", "Superseded"},
            "Approved": {"Presented", "Rejected", "Superseded"},
            "Presented": {"Accepted", "Rejected", "Superseded"},
            "Accepted": {"Superseded"},
            "Rejected": {"Superseded"},
            "Superseded": set(),
        },
    )
    if status in {"Approved", "Presented", "Accepted"}:
        if not rows:
            raise PolicyViolation("missing_change_items", "approved change order requires items")
        require_approval(record)
        parse_json_field(record, "tax_policy_snapshot_json", required=True, container_types=(dict,), non_empty=True)
    if status == "Accepted":
        require_fields(record, "contract_acceptance", "accepted_at")
    _lock_after_status(record, context, {"Approved", "Presented", "Accepted"}, "currency", "subtotal", "tax_amount", "total_amount", "price_book_version", "tax_policy_snapshot_json", "items")
    _validate_correction(record, context, version_field="version")


def _validate_safety_plan(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status in {"Ready", "Acknowledged"}:
        require_fields(record, "effective_date", "evidence_item", "approved_by", "approved_at")
    acknowledgements = _rows(record, "acknowledgements")
    users = [_get(row, "acknowledged_by") for row in acknowledgements]
    if any(_blank(user) for user in users) or len(users) != len(set(users)):
        raise PolicyViolation("invalid_safety_acknowledgement", "acknowledging users must be present and unique")
    for row in acknowledgements:
        require_fields(row, "acknowledged_at", "acknowledgement_method", "device_action_id", "evidence_item")
    if status == "Acknowledged" and not acknowledgements:
        raise PolicyViolation("missing_safety_acknowledgement", "acknowledged plan requires crew acknowledgements")
    _validate_correction(record, context, version_field="version")


def _validate_compliance(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status == "Applied":
        require_fields(record, "applied_at")
    if status in {"Approved", "Passed", "Failed", "Expired"}:
        require_fields(record, "external_reference", "evidence_item")
    if status in {"Passed", "Failed"}:
        require_fields(record, "inspected_at")
    if status in CURRENT_AUTHORITY_STATUSES:
        require_fields(record, "effective_date", "expiry_date")
    if status == "Waived":
        require_fields(record, "waived_by", "waived_at", "waiver_reason")
    elif any(not _blank(_get(record, field)) for field in ("waived_by", "waived_at", "waiver_reason")):
        raise PolicyViolation("stale_waiver", "waiver metadata is only valid for Waived records")
    _validate_correction(record, context)


def _validate_consent(record: Any, context: Mapping[str, Any]) -> None:
    _require_one_of(record, "customer", "lead_envelope", "roof_job")
    status = _get(record, "status")
    if status == "Granted":
        require_fields(record, "proof_evidence")
    if status == "Revoked":
        require_fields(record, "revoked_at", "supersedes", "correction_reason")
    _validate_correction(record, context)


def _validate_customer_decision(record: Any, context: Mapping[str, Any]) -> None:
    if _get(record, "decision_type") == "Option Selection":
        require_fields(record, "option_package")
    if _get(record, "decision_type") == "Change Order":
        require_fields(record, "change_order")
    if _get(record, "status") in {"Withdrawn", "Superseded"}:
        require_fields(record, "supersedes", "correction_reason")
    _validate_correction(record, context)


def _validate_contract_acceptance(record: Any, context: Mapping[str, Any]) -> None:
    has_quote = not _blank(_get(record, "customer_quote"))
    has_change = not _blank(_get(record, "change_order"))
    if has_quote == has_change:
        raise PolicyViolation("contract_target", "acceptance must target exactly one quote or change order")
    method = _get(record, "acceptance_method")
    allowed_methods = {
        "Click to Accept",
        "E-signature Provider",
        "In Person",
        "Imported Signed Contract",
    }
    if method not in allowed_methods:
        raise PolicyViolation(
            "invalid_acceptance_method",
            "binding acceptance must use an evidenced written or electronic method",
            "acceptance_method",
        )
    if _get(record, "status") == "Accepted":
        require_fields(record, "accepted_at")
        if method == "Click to Accept":
            require_fields(record, "signer_ip")
        if _get(record, "source_system") == "ironwrap-customer-portal":
            require_fields(record, "proposal_evidence_pack", "terms_snapshot_json")
            parse_json_field(
                record,
                "terms_snapshot_json",
                required=True,
                container_types=(dict,),
                non_empty=True,
            )
    require_sha256(record, "terms_hash", "document_checksum")
    _validate_correction(record, context)


def _validate_reconciliation(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "attempt_count")
    status = _get(record, "status")
    system_name = _get(record, "system_name")
    quickbooks = isinstance(system_name, str) and system_name.strip().casefold() == "quickbooks"
    previous = context.get("_previous")
    # A webhook is only a provider identity signal. It may open Pending work,
    # but cannot assert that provider and local accounting truth are matched or
    # resolved until a future authenticated provider-side resolver exists.
    if quickbooks and previous is None and status != "Pending":
        raise PolicyViolation(
            "quickbooks_initial_status_must_be_pending",
            "QuickBooks reconciliation must begin Pending",
            "status",
        )
    if quickbooks and status in {"Matched", "Resolved"}:
        raise PolicyViolation(
            "quickbooks_provider_truth_unavailable",
            "QuickBooks Matched and Resolved states require an authenticated provider-side resolver",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Pending": {"Matched", "Mismatch", "Ignored", "Superseded"},
            "Mismatch": {"Resolved", "Ignored", "Superseded"},
            "Matched": {"Superseded"},
            "Resolved": {"Superseded"},
            "Ignored": {"Superseded"},
            "Superseded": set(),
        },
    )
    if status == "Mismatch":
        parse_json_field(record, "diff_json", required=True, container_types=(dict,), non_empty=True)
    if status == "Matched":
        require_fields(record, "source_payload_hash", "local_payload_hash")
        require_sha256(record, "source_payload_hash", "local_payload_hash")
        if _get(record, "source_payload_hash") != _get(record, "local_payload_hash"):
            raise PolicyViolation("unmatched_payload", "matched payload hashes must agree")
        source_amount = _decimal(record, "source_amount")
        local_amount = _decimal(record, "local_amount")
        if source_amount is not None and local_amount is not None and abs(source_amount - local_amount) > Decimal("0.01"):
            raise PolicyViolation("unmatched_amount", "matched monetary values must agree")
    if status in {"Resolved", "Ignored"}:
        require_fields(record, "resolution_action", "resolved_by", "resolved_at", "resolution_evidence")
    if quickbooks:
        require_fields(
            record,
            "entity_type",
            "external_entity_id",
            "local_doctype",
            "local_name",
            "direction",
            "status",
            "detected_at",
            "source_version",
            "raw_key",
            "source_payload_hash",
            "local_payload_hash",
        )
        if _get(record, "entity_type") not in QUICKBOOKS_FINANCE_ENTITY_TYPES:
            raise PolicyViolation(
                "unsupported_quickbooks_entity",
                "QuickBooks reconciliation accepts only invoice, payment, credit, or refund entities",
                "entity_type",
            )
        if _get(record, "direction") != "Inbound":
            raise PolicyViolation(
                "invalid_quickbooks_reconciliation_direction",
                "QuickBooks webhook reconciliation must be inbound",
                "direction",
            )
        if _get(record, "source_version") not in QUICKBOOKS_FINANCE_OPERATIONS:
            raise PolicyViolation(
                "invalid_quickbooks_operation",
                "QuickBooks webhook operation is unsupported",
                "source_version",
            )
        if not str(_get(record, "raw_key") or "").startswith("raw/quickbooks/"):
            raise PolicyViolation(
                "invalid_quickbooks_raw_key",
                "QuickBooks reconciliation must point to immutable raw webhook evidence",
                "raw_key",
            )
        require_sha256(record, "source_payload_hash", "local_payload_hash")
        if status == "Pending":
            if _get(record, "source_payload_hash") == _get(record, "local_payload_hash"):
                raise PolicyViolation(
                    "premature_quickbooks_reconciliation",
                    "a raw webhook receipt cannot reconcile itself without provider detail",
                    "local_payload_hash",
                )
            if _blank(_get(record, "roof_job")):
                if _get(record, "local_doctype") != "Unresolved QuickBooks Event":
                    raise PolicyViolation(
                        "quickbooks_unresolved_linkage",
                        "missing exact job linkage must remain an unresolved QuickBooks event",
                        "local_doctype",
                    )
            elif _get(record, "local_doctype") != "Payment Milestone":
                raise PolicyViolation(
                    "quickbooks_linked_doctype_mismatch",
                    "linked QuickBooks finance reconciliation must point to a Payment Milestone",
                    "local_doctype",
                )
        if status == "Matched":
            require_fields(record, "roof_job")
            if _get(record, "local_doctype") != "Payment Milestone":
                raise PolicyViolation(
                    "quickbooks_matched_linkage_missing",
                    "matched QuickBooks finance reconciliation requires an exact Payment Milestone linkage",
                    "local_doctype",
                )
    _validate_correction(record, context)


def _validate_tenant_export(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "record_count", "evidence_count", "byte_count")
    parse_json_field(record, "scope_json", required=True, container_types=(dict,), non_empty=True)
    status = _get(record, "status")
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Requested": {"Running", "Failed", "Superseded"},
            "Running": {"Completed", "Failed", "Superseded"},
            "Completed": {"Superseded"},
            "Failed": {"Superseded"},
            "Superseded": set(),
        },
    )
    if status in {"Running", "Completed", "Failed"}:
        require_fields(record, "started_at")
    if status == "Completed":
        require_fields(record, "completed_at", "manifest_key", "manifest_checksum", "archive_key", "archive_checksum", "encryption_key_ref")
        require_sha256(record, "manifest_checksum", "archive_checksum")
    if status == "Failed":
        require_fields(record, "completed_at", "failure_reason")
    _validate_correction(record, context)


def _validate_instant_estimate(record: Any, _context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "range_low", "range_high", "estimate_total")
    low = _decimal(record, "range_low")
    high = _decimal(record, "range_high")
    if low is not None and high is not None and low > high:
        raise PolicyViolation(
            "invalid_estimate_range", "range_low must be <= range_high"
        )
    status = _get(record, "status")
    if status in {"Needs Review", "Approved"}:
        require_fields(record, "range_low", "range_high", "assumptions", "exclusions")
        parse_json_field(
            record, "selected_services_json", required=True, non_empty=True
        )
    if status == "Needs Review" and not bool(_get(record, "review_required")):
        raise PolicyViolation(
            "review_gate", "Needs Review must keep review_required enabled"
        )
    if status in {"Approved", "Rejected"}:
        require_fields(record, "reviewed_by", "reviewed_at", "review_notes")
    if status == "Approved":
        if bool(_get(record, "review_required")):
            raise PolicyViolation(
                "review_gate", "Approved estimate cannot still require review"
            )
        require_approval(record)


def _validate_roof_graph(record: Any) -> None:
    """Keep a persisted roof graph bound to its immutable raw evidence."""

    roof_graph = parse_json_field(record, "roof_graph_json")
    if roof_graph is None:
        return
    if not isinstance(roof_graph, dict):
        raise PolicyViolation(
            "invalid_roof_graph", "roof graph must be an object", "roof_graph_json"
        )
    if roof_graph.get("schema_version") != "roof_graph/v1":
        raise PolicyViolation(
            "unsupported_roof_graph",
            "expected schema_version roof_graph/v1",
            "roof_graph_json",
        )

    revision = roof_graph.get("revision")
    if not isinstance(revision, str) or _blank(revision):
        raise PolicyViolation(
            "invalid_roof_graph", "roof graph needs a revision", "roof_graph_json"
        )
    require_sha256(roof_graph, "revision")
    require_fields(record, "roof_graph_revision")
    if revision != _get(record, "roof_graph_revision"):
        raise PolicyViolation(
            "roof_graph_revision_mismatch",
            "roof graph revision must match roof_graph_revision",
            "roof_graph_json",
        )

    source = roof_graph.get("source")
    if not isinstance(source, dict):
        raise PolicyViolation(
            "invalid_roof_graph", "roof graph needs source provenance", "roof_graph_json"
        )
    for field in ("raw_key", "raw_sha256", "provider", "ingested_at", "capture"):
        if _blank(source.get(field)):
            raise PolicyViolation(
                "invalid_roof_graph", f"roof graph source lacks {field}", "roof_graph_json"
            )
    require_sha256(source, "raw_sha256")
    if source["raw_sha256"] != revision:
        raise PolicyViolation(
            "roof_graph_revision_mismatch",
            "roof graph revision must be its raw evidence hash",
            "roof_graph_json",
        )
    capture = source.get("capture")
    if not isinstance(capture, dict) or _blank(capture.get("provenance")):
        raise PolicyViolation(
            "invalid_roof_graph", "roof graph capture provenance is required", "roof_graph_json"
        )
    raw_key = _get(record, "raw_key")
    if not _blank(raw_key) and source["raw_key"] != raw_key:
        raise PolicyViolation(
            "roof_graph_source_mismatch",
            "roof graph raw key must match Measurement Report raw_key",
            "roof_graph_json",
        )
    provider = _get(record, "provider")
    if not _blank(provider) and source["provider"] != provider:
        raise PolicyViolation(
            "roof_graph_source_mismatch",
            "roof graph provider must match Measurement Report provider",
            "roof_graph_json",
        )

    coordinate_system = roof_graph.get("coordinate_system")
    if not isinstance(coordinate_system, dict) or _blank(
        coordinate_system.get("kind")
    ):
        raise PolicyViolation(
            "invalid_roof_graph", "roof graph coordinate system is required", "roof_graph_json"
        )
    for field in ("points", "edges", "facets", "checks"):
        if not isinstance(roof_graph.get(field), list):
            raise PolicyViolation(
                "invalid_roof_graph", f"roof graph {field} must be a list", "roof_graph_json"
            )
    if not isinstance(roof_graph.get("measurements"), dict) or not isinstance(
        roof_graph.get("source_refs"), dict
    ):
        raise PolicyViolation(
            "invalid_roof_graph",
            "roof graph measurements and source_refs must be maps",
            "roof_graph_json",
        )


def _validate_measurement(record: Any, _context: Mapping[str, Any]) -> None:
    _validate_roof_graph(record)
    if _get(record, "review_status") != "Approved":
        return
    require_fields(record, "roof_job", "approved_by", "approved_at", "approval_note")
    if not any(
        not _blank(_get(record, field))
        for field in ("source_file", "report_url", "raw_key")
    ):
        raise PolicyViolation(
            "missing_source_evidence",
            "approved measurement requires a source file, URL, or raw key",
        )
    rows = _require_clean_rows(record, "measurements", quantity_field="value")
    for index, row in enumerate(rows, start=1):
        if any(_blank(_get(row, field)) for field in ("metric", "unit", "source_ref")):
            raise PolicyViolation(
                "incomplete_measurement",
                f"measurement row {index} lacks metric, unit, or source_ref",
            )


def _validate_takeoff(record: Any, context: Mapping[str, Any]) -> None:
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record, "roof_job", "measurement_report", "assumptions", "exclusions"
    )
    require_approval(record, note="approval_note")
    if _context_status(context, "measurement_status") != "Approved":
        raise PolicyViolation(
            "unapproved_measurement", "linked Measurement Report must be Approved"
        )
    parse_json_field(record, "source_measurements_json", required=True, non_empty=True)
    _require_clean_rows(record, "items", quantity_field="quantity")


def _validate_supplier_quote(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "quote_total")
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record,
        "roof_job",
        "material_takeoff",
        "supplier",
        "valid_until",
        "assumptions",
        "exclusions",
    )
    require_approval(record)
    if _context_status(context, "takeoff_status") != "Approved":
        raise PolicyViolation(
            "unapproved_takeoff", "linked Material Takeoff must be Approved"
        )
    parse_json_field(record, "quote_summary_json", required=True, non_empty=True)
    rows = _require_clean_rows(record, "items", quantity_field="quantity")
    for row in rows:
        require_nonnegative(row, "unit_price", "line_total", required=True)


def _validate_supplier_order(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in SUPPLIER_ORDER_STATUSES:
        raise PolicyViolation(
            "invalid_supplier_order_status", "unsupported supplier order status", "status"
        )

    previous = context.get("_previous")
    if previous is None and status not in {"Draft", "Needs Review"}:
        raise PolicyViolation(
            "invalid_supplier_order_initial_state",
            "a Supplier Order must begin in Draft or Needs Review",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Needs Review", "Cancelled"},
            "Needs Review": {"Draft", "Approved", "Cancelled"},
            "Approved": {"Ordered", "Cancelled"},
            "Ordered": {"Partially Received", "Received", "Shortage", "Cancelled"},
            "Partially Received": {"Received", "Shortage"},
            "Received": set(),
            "Shortage": set(),
            "Cancelled": set(),
        },
    )

    if status in {"Draft", "Needs Review", "Approved"} and any(
        not _blank(_get(record, field))
        for field in ("internal_transmission_id", "internal_transmitted_at")
    ):
        raise PolicyViolation(
            "supplier_order_transmission_before_ordered",
            "internal transmission facts require the Ordered state",
            "internal_transmission_id",
        )

    if status in {"Draft", "Needs Review", "Approved", "Ordered", "Cancelled"} and any(
        not _blank(_get(record, field))
        for field in ("received_at", "receipt_evidence_json")
    ):
        raise PolicyViolation(
            "supplier_order_receipt_facts_before_receiving",
            "receipt timestamp and evidence require a receipt or shortage state",
            "received_at",
        )

    if status in SUPPLIER_ORDER_POST_APPROVAL_STATUSES:
        require_fields(record, "roof_job", "material_takeoff", "supplier", "source_quote")
        require_approval(record)
        if _context_status(context, "takeoff_status") != "Approved":
            raise PolicyViolation(
                "unapproved_takeoff", "linked Material Takeoff must be Approved"
            )
        if _context_status(context, "supplier_quote_status") != "Approved":
            raise PolicyViolation(
                "unapproved_supplier_quote", "linked Supplier Quote must be Approved"
            )
        parse_json_field(record, "order_summary_json", required=True, non_empty=True)

    rows = (
        _require_clean_rows(record, "items", quantity_field="quantity")
        if status in SUPPLIER_ORDER_POST_APPROVAL_STATUSES
        else _rows(record, "items")
    )
    _lock_after_status(
        record,
        context,
        set(SUPPLIER_ORDER_POST_APPROVAL_STATUSES | SUPPLIER_ORDER_FINAL_STATUSES),
        *SUPPLIER_ORDER_FROZEN_FIELDS,
    )
    _lock_supplier_order_items(record, previous)

    if status in {"Draft", "Needs Review", "Approved", "Ordered"}:
        for index, row in enumerate(rows, start=1):
            received = _decimal(row, "received_qty", required=True)
            shortage = _decimal(row, "shortage_qty", required=True)
            if received != Decimal("0") or shortage != Decimal("0"):
                raise PolicyViolation(
                    "supplier_order_receipt_before_receiving",
                    "receipt quantities require a receipt or shortage state",
                    f"items[{index}]",
                )

    if status in {"Ordered", *SUPPLIER_ORDER_RECEIPT_STATUSES}:
        require_fields(record, "internal_transmission_id", "internal_transmitted_at")

    _validate_supplier_order_acknowledgement(record, context, status)

    if status in SUPPLIER_ORDER_RECEIPT_STATUSES:
        require_fields(record, "received_at")
        evidence_ids = _supplier_order_receipt_evidence_ids(record)
        _require_supplier_order_evidence(
            record,
            context,
            evidence_ids,
            "receipt_evidence_json",
        )
        if previous is not None and _get(previous, "status") in SUPPLIER_ORDER_RECEIPT_STATUSES:
            prior_ids = _supplier_order_receipt_evidence_ids(previous)
            if not set(prior_ids).issubset(evidence_ids):
                raise PolicyViolation(
                    "supplier_order_receipt_evidence_not_append_only",
                    "receipt evidence cannot be removed after receiving begins",
                    "receipt_evidence_json",
                )
        _validate_supplier_order_receipts(rows, status)


def _lock_supplier_order_items(record: Any, previous: Any) -> None:
    if previous is None:
        return
    previous_status = _get(previous, "status")
    if previous_status not in (
        SUPPLIER_ORDER_POST_APPROVAL_STATUSES | SUPPLIER_ORDER_FINAL_STATUSES
    ):
        return
    previous_rows = _rows(previous, "items")
    current_rows = _rows(record, "items")
    if len(previous_rows) != len(current_rows):
        raise PolicyViolation(
            "supplier_order_items_immutable",
            "approved Supplier Order items cannot be added, removed, or reordered",
            "items",
        )
    for index, (before, after) in enumerate(zip(previous_rows, current_rows), start=1):
        try:
            enforce_immutable(after, before, *SUPPLIER_ORDER_ITEM_FROZEN_FIELDS)
        except PolicyViolation as exc:
            raise PolicyViolation(
                "supplier_order_items_immutable",
                "approved Supplier Order source item facts cannot change",
                f"items[{index}]",
            ) from exc
        if previous_status in SUPPLIER_ORDER_FINAL_STATUSES:
            try:
                enforce_immutable(after, before, "status", "received_qty", "shortage_qty")
            except PolicyViolation as exc:
                raise PolicyViolation(
                    "supplier_order_receipts_finalized",
                    "final Supplier Order receipt quantities cannot change",
                    f"items[{index}]",
                ) from exc


def _supplier_order_receipt_evidence_ids(record: Any) -> tuple[str, ...]:
    contract = parse_json_field(
        record,
        "receipt_evidence_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    if set(contract) != {"evidence_item_ids"}:
        raise PolicyViolation(
            "invalid_supplier_order_receipt_evidence",
            "receipt evidence must contain exactly evidence_item_ids",
            "receipt_evidence_json",
        )
    evidence_ids = contract.get("evidence_item_ids")
    if not isinstance(evidence_ids, list) or not 1 <= len(evidence_ids) <= 50:
        raise PolicyViolation(
            "invalid_supplier_order_receipt_evidence",
            "receipt evidence requires 1 to 50 Evidence Item IDs",
            "receipt_evidence_json",
        )
    normalized = tuple(
        value.strip() if isinstance(value, str) else "" for value in evidence_ids
    )
    if (
        any(not value or len(value) > 140 for value in normalized)
        or len(set(normalized)) != len(normalized)
    ):
        raise PolicyViolation(
            "invalid_supplier_order_receipt_evidence",
            "receipt Evidence Item IDs must be unique bounded values",
            "receipt_evidence_json",
        )
    return normalized


def _require_supplier_order_evidence(
    record: Any,
    context: Mapping[str, Any],
    evidence_ids: tuple[str, ...],
    field: str,
) -> None:
    evidence = context.get("supplier_order_evidence", {})
    if not isinstance(evidence, Mapping):
        evidence = {}
    for evidence_id in evidence_ids:
        source = evidence.get(evidence_id)
        if not isinstance(source, Mapping) or _get(source, "roof_job") != _get(record, "roof_job"):
            raise PolicyViolation(
                "supplier_order_evidence_missing",
                "supplier order evidence must resolve to the same Roof Job",
                field,
            )
        if (
            _get(source, "proof_slot") != "Materials"
            or _get(source, "sync_state") != "Verified"
            or _get(source, "checksum_algorithm") != "SHA-256"
            or _blank(_get(source, "verified_at"))
            or _blank(_get(source, "verification_source"))
            or not any(
                not _blank(_get(source, pointer))
                for pointer in ("source_uri", "r2_key", "drive_file_id")
            )
        ):
            raise PolicyViolation(
                "unverified_supplier_order_evidence",
                "supplier order evidence must be verified Materials evidence with durable provenance",
                field,
            )
        require_sha256(source, "content_checksum")


def _validate_supplier_order_acknowledgement(
    record: Any, context: Mapping[str, Any], status: str
) -> None:
    acknowledgement_fields = (
        "supplier_acknowledgement_id",
        "supplier_acknowledged_at",
        "supplier_acknowledgement_evidence",
    )
    if not any(not _blank(_get(record, field)) for field in acknowledgement_fields):
        return
    if status not in {"Ordered", *SUPPLIER_ORDER_RECEIPT_STATUSES}:
        raise PolicyViolation(
            "supplier_order_acknowledgement_before_transmission",
            "supplier acknowledgement requires an internally transmitted order",
            "supplier_acknowledgement_id",
        )
    require_fields(record, "internal_transmission_id", "internal_transmitted_at")
    require_fields(record, *acknowledgement_fields)
    _require_supplier_order_evidence(
        record,
        context,
        (str(_get(record, "supplier_acknowledgement_evidence")),),
        "supplier_acknowledgement_evidence",
    )


def _validate_supplier_order_receipts(rows: list[Any], status: str) -> None:
    total_received = Decimal("0")
    total_shortage = Decimal("0")
    all_accounted_for = True
    for index, row in enumerate(rows, start=1):
        ordered = _decimal(row, "quantity", required=True)
        received = _decimal(row, "received_qty", required=True)
        shortage = _decimal(row, "shortage_qty", required=True)
        if ordered is None or ordered <= Decimal("0"):
            raise PolicyViolation(
                "invalid_supplier_order_quantity",
                "ordered quantity must be greater than zero",
                f"items[{index}]",
            )
        if received is None or shortage is None:
            raise PolicyViolation(
                "required_number",
                "received and shortage quantities are required",
                f"items[{index}]",
            )
        if received < Decimal("0") or shortage < Decimal("0"):
            raise PolicyViolation(
                "negative_value",
                "received and shortage quantities must be nonnegative",
                f"items[{index}]",
            )
        accounted_for = received + shortage
        if accounted_for > ordered:
            raise PolicyViolation(
                "supplier_order_quantity_overage",
                "received plus shortage quantity cannot exceed the ordered quantity",
                f"items[{index}]",
            )
        all_accounted_for = all_accounted_for and accounted_for == ordered
        total_received += received
        total_shortage += shortage
        expected_item_status = (
            "Shortage"
            if shortage > Decimal("0")
            else "Received"
            if received == ordered
            else "Ordered"
        )
        if _get(row, "status") != expected_item_status:
            raise PolicyViolation(
                "supplier_order_item_receipt_status",
                "item status must match its received and shortage quantities",
                f"items[{index}]",
            )

    if status == "Partially Received":
        if total_received <= Decimal("0") or all_accounted_for:
            raise PolicyViolation(
                "supplier_order_partial_receipt_invalid",
                "partial receipt needs received quantity and an outstanding item balance",
                "status",
            )
    elif status == "Received":
        if not all_accounted_for or total_shortage != Decimal("0"):
            raise PolicyViolation(
                "supplier_order_received_quantity_mismatch",
                "Received requires every ordered quantity to be received with no shortage",
                "status",
            )
    elif status == "Shortage" and (
        not all_accounted_for or total_shortage <= Decimal("0")
    ):
        raise PolicyViolation(
            "supplier_order_shortage_quantity_mismatch",
            "Shortage requires every ordered quantity to be received or short with a positive shortage",
            "status",
        )


def _validate_controlled_item(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {"Draft", "Approved", "Retired"}:
        raise PolicyViolation("invalid_controlled_item_status", "unsupported item status", "status")
    require_fields(
        record,
        "status",
        "revision",
        "item_kind",
        "unit",
        "profile",
        "gauge",
        "coating",
        "colour",
        "dimension_spec",
        "tolerance",
        "source_ref",
    )
    revision = _decimal(record, "revision", required=True)
    if revision is not None and revision < 1:
        raise PolicyViolation(
            "invalid_controlled_item_revision",
            "revision must be at least 1",
            "revision",
        )
    if _get(record, "item_kind") not in {"Raw Material", "Finished Product"}:
        raise PolicyViolation("invalid_controlled_item_kind", "unsupported item kind", "item_kind")
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Approved", "Retired"},
            "Approved": {"Retired"},
            "Retired": set(),
        },
    )
    if status == "Approved":
        require_approval(record, note="approval_note")
    _lock_after_status(
        record,
        context,
        {"Approved", "Retired"},
        "revision",
        "item_kind",
        "unit",
        "profile",
        "gauge",
        "coating",
        "colour",
        "dimension_spec",
        "tolerance",
        "lot_required",
        "certificate_required",
        "source_ref",
    )


def _validate_material_lot(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {
        "Draft",
        "Available",
        "Reserved",
        "Quarantined",
        "Consumed",
        "Exhausted",
    }:
        raise PolicyViolation("invalid_material_lot_status", "unsupported lot status", "status")
    require_fields(
        record,
        "roof_job",
        "controlled_item",
        "source_kind",
        "lot_number",
        "condition_status",
        "received_quantity",
        "unit",
        "status",
    )
    require_nonnegative(record, "received_quantity", required=True)
    received = _decimal(record, "received_quantity", required=True)
    if received is not None and received <= 0:
        raise PolicyViolation(
            "invalid_material_lot_quantity",
            "received quantity must be greater than zero",
            "received_quantity",
        )
    if status != "Draft":
        controlled_item = context.get("controlled_item")
        if not isinstance(controlled_item, Mapping):
            raise PolicyViolation(
                "unverified_material_lot_item",
                "a released Material Lot requires its Controlled Item",
                "controlled_item",
            )
        if _get(controlled_item, "status") != "Approved":
            raise PolicyViolation(
                "unapproved_material_lot_item",
                "a released Material Lot requires an Approved Controlled Item",
                "controlled_item",
            )
    source_kind = _get(record, "source_kind")
    if source_kind == "Supplier Receipt":
        require_fields(record, "supplier_order", "source_evidence")
        supplier_order = context.get("supplier_order")
        if not isinstance(supplier_order, Mapping):
            raise PolicyViolation(
                "unverified_material_lot_supplier_order",
                "a supplier Material Lot requires its source Supplier Order",
                "supplier_order",
            )
        if _get(supplier_order, "roof_job") != _get(record, "roof_job"):
            raise PolicyViolation(
                "cross_job_material_lot_supplier_order",
                "a supplier Material Lot must remain on its Supplier Order's Roof Job",
                "supplier_order",
            )
        if _get(supplier_order, "status") not in {
            "Partially Received",
            "Received",
        }:
            raise PolicyViolation(
                "unreceived_supplier_order",
                "a supplier lot requires a received source Supplier Order",
                "supplier_order",
            )
    elif source_kind == "Customer Stock":
        require_fields(record, "source_evidence")
    elif source_kind == "Shop Remnant":
        require_fields(record, "source_shop_order", "source_evidence")
        if status != "Draft":
            source_shop_order = context.get("source_shop_order")
            if not isinstance(source_shop_order, Mapping):
                raise PolicyViolation(
                    "unverified_shop_remnant_source",
                    "a released remnant lot requires its source Shop Order",
                    "source_shop_order",
                )
            if _get(source_shop_order, "roof_job") != _get(record, "roof_job"):
                raise PolicyViolation(
                    "cross_job_shop_remnant",
                    "a remnant lot must remain on its source Shop Order's Roof Job",
                    "source_shop_order",
                )
            if _get(source_shop_order, "status") not in SHOP_ORDER_FINAL_STATUSES:
                raise PolicyViolation(
                    "unfinalized_shop_remnant",
                    "a remnant lot can only be released from a Ready or later Shop Order",
                    "source_shop_order",
                )
    else:
        raise PolicyViolation("invalid_material_lot_source", "unsupported lot source", "source_kind")
    if _get(record, "condition_status") not in {"Accepted", "Damaged", "Quarantined"}:
        raise PolicyViolation(
            "invalid_material_lot_condition",
            "unsupported receiving condition",
            "condition_status",
        )
    if _get(record, "condition_status") == "Quarantined" and status != "Quarantined":
        raise PolicyViolation(
            "quarantined_lot_status",
            "a quarantined receiving condition requires Quarantined status",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Available", "Quarantined"},
            "Available": {"Reserved", "Quarantined", "Exhausted"},
            "Reserved": {"Available", "Consumed", "Exhausted", "Quarantined"},
            "Quarantined": {"Available", "Reserved", "Exhausted"},
            "Consumed": {"Exhausted"},
            "Exhausted": set(),
        },
    )
    if status != "Draft":
        require_fields(
            record,
            "received_at",
            "source_evidence",
            "available_quantity",
            "reserved_quantity",
            "consumed_quantity",
        )
        require_nonnegative(
            record,
            "available_quantity",
            "reserved_quantity",
            "consumed_quantity",
            required=True,
        )
        available = _decimal(record, "available_quantity", required=True)
        reserved = _decimal(record, "reserved_quantity", required=True)
        consumed = _decimal(record, "consumed_quantity", required=True)
        if (
            received is None
            or available is None
            or reserved is None
            or consumed is None
        ):
            return
        if abs(received - (available + reserved + consumed)) > Decimal("0.01"):
            raise PolicyViolation(
                "material_lot_balance_mismatch",
                "received quantity must equal available plus reserved plus consumed quantity",
                "received_quantity",
            )
        if status == "Available" and (available <= 0 or reserved != 0):
            raise PolicyViolation(
                "invalid_available_material_lot",
                "an Available Material Lot must have stock and no active reservation",
                "status",
            )
        if status == "Reserved" and reserved <= 0:
            raise PolicyViolation(
                "invalid_reserved_material_lot",
                "a Reserved Material Lot must have an active reserved quantity",
                "status",
            )
        if status in {"Consumed", "Exhausted"} and (
            available != 0 or reserved != 0 or consumed != received
        ):
            raise PolicyViolation(
                "invalid_consumed_material_lot",
                "a consumed or exhausted Material Lot must have no available or reserved quantity",
                "status",
            )
    _lock_after_status(
        record,
        context,
        {"Available", "Reserved", "Quarantined", "Consumed", "Exhausted"},
        "roof_job",
        "controlled_item",
        "source_kind",
        "supplier_order",
        "source_shop_order",
        "source_evidence",
        "lot_number",
        "certificate_reference",
        "condition_status",
        "received_quantity",
        "unit",
        "received_at",
    )


def _shop_lines(record: Any, *, require_output: bool) -> dict[int, Any]:
    rows = _require_clean_rows(record, "lines", quantity_field="requested_quantity")
    lines: dict[int, Any] = {}
    for expected, row in enumerate(rows, start=1):
        line_no = _decimal(row, "line_no", required=True)
        if line_no != expected:
            raise PolicyViolation(
                "invalid_shop_line_sequence",
                "line numbers must be contiguous and start at 1",
                "lines",
            )
        require_fields(
            row,
            "controlled_item",
            "unit",
            "dimensions",
            "tolerance",
            "orientation",
            "invoice_basis",
        )
        requested = _decimal(row, "requested_quantity", required=True)
        if requested is not None and requested <= 0:
            raise PolicyViolation(
                "invalid_shop_line_quantity",
                "requested quantity must be greater than zero",
                "lines",
            )
        if require_output:
            require_nonnegative(row, "accepted_quantity", "billable_quantity", required=True)
            accepted = _decimal(row, "accepted_quantity", required=True)
            billable = _decimal(row, "billable_quantity", required=True)
            if accepted is not None and accepted <= 0:
                raise PolicyViolation(
                    "invalid_shop_accepted_quantity",
                    "accepted quantity must be greater than zero",
                    "lines",
                )
            if accepted is not None and billable is not None and billable != accepted:
                raise PolicyViolation(
                    "shop_billable_quantity_mismatch",
                    "billable quantity must equal accepted quantity for this supply-only slice",
                    "lines",
                )
        lines[int(line_no)] = row
    return lines


def _shop_allocations(
    record: Any, lines: Mapping[int, Any], context: Mapping[str, Any]
) -> dict[str, Any]:
    rows = _require_clean_rows(
        record, "material_allocations", quantity_field="reserved_quantity"
    )
    allocations: dict[str, Any] = {}
    reserved_by_lot: dict[str, Decimal] = {}
    material_lots = context.get("material_lots")
    if not isinstance(material_lots, Mapping):
        raise PolicyViolation(
            "unverified_shop_material_lots",
            "Shop Order material allocations require locked Material Lot context",
            "material_allocations",
        )
    for row in rows:
        require_fields(row, "allocation_id", "line_no", "material_lot", "unit", "status")
        allocation_id = str(_get(row, "allocation_id"))
        if allocation_id in allocations:
            raise PolicyViolation(
                "duplicate_shop_allocation", "allocation IDs must be unique", "material_allocations"
            )
        line_no = _decimal(row, "line_no", required=True)
        if line_no is None or int(line_no) not in lines:
            raise PolicyViolation(
                "unknown_shop_allocation_line",
                "allocation must reference a Shop Order line",
                "material_allocations",
            )
        material_lot_id = str(_get(row, "material_lot"))
        material_lot = material_lots.get(material_lot_id)
        if not isinstance(material_lot, Mapping):
            raise PolicyViolation(
                "unverified_shop_material_lot",
                "allocation must reference a verified Material Lot",
                "material_allocations",
            )
        line = lines[int(line_no)]
        if _get(material_lot, "roof_job") != _get(record, "roof_job"):
            raise PolicyViolation(
                "shop_allocation_roof_job_mismatch",
                "allocation Material Lot must belong to this Roof Job",
                "material_allocations",
            )
        if _get(material_lot, "controlled_item") != _get(line, "controlled_item"):
            raise PolicyViolation(
                "shop_allocation_item_mismatch",
                "allocation Material Lot must match its Shop Order line item",
                "material_allocations",
            )
        if _get(row, "unit") != _get(line, "unit") or _get(material_lot, "unit") != _get(
            line, "unit"
        ):
            raise PolicyViolation(
                "shop_allocation_unit_mismatch",
                "allocation, Material Lot, and Shop Order line must share a unit",
                "material_allocations",
            )
        allowed_lot_statuses = {"Available", "Reserved", "Consumed"}
        if _get(record, "status") == "Quality Hold":
            allowed_lot_statuses.add("Quarantined")
        if _get(material_lot, "status") not in allowed_lot_statuses:
            raise PolicyViolation(
                "shop_allocation_lot_unavailable",
                "allocation Material Lot is not available for this shop flow",
                "material_allocations",
            )
        require_nonnegative(row, "issued_quantity", required=True)
        reserved = _decimal(row, "reserved_quantity", required=True)
        issued = _decimal(row, "issued_quantity", required=True)
        if reserved is not None and reserved <= 0:
            raise PolicyViolation(
                "invalid_shop_reservation_quantity",
                "reserved quantity must be greater than zero",
                "material_allocations",
            )
        if reserved is not None and issued is not None and issued > reserved:
            raise PolicyViolation(
                "shop_issue_exceeds_reservation",
                "issued quantity cannot exceed the reservation",
                "material_allocations",
            )
        if reserved is not None:
            reserved_by_lot[material_lot_id] = (
                reserved_by_lot.get(material_lot_id, Decimal("0")) + reserved
            )
        if _get(row, "status") not in {"Planned", "Reserved", "Issued", "Released"}:
            raise PolicyViolation(
                "invalid_shop_allocation_status",
                "unsupported allocation status",
                "material_allocations",
            )
        allocations[allocation_id] = row
    for material_lot_id, reserved in reserved_by_lot.items():
        received = _decimal(
            material_lots[material_lot_id], "received_quantity", required=True
        )
        if received is None:
            raise PolicyViolation(
                "unverified_shop_material_lot",
                "allocation Material Lot must include its received quantity",
                "material_allocations",
            )
        if reserved > received:
            raise PolicyViolation(
                "shop_allocation_quantity_exceeds_lot",
                "allocation reservations cannot exceed the Material Lot quantity",
                "material_allocations",
            )
    return allocations


def _shop_operations(record: Any) -> dict[int, Any]:
    rows = _rows(record, "operations")
    if not rows:
        raise PolicyViolation("missing_shop_operations", "a shop route is required", "operations")
    operations: dict[int, Any] = {}
    for expected, row in enumerate(rows, start=1):
        sequence = _decimal(row, "sequence", required=True)
        if sequence != expected:
            raise PolicyViolation(
                "invalid_shop_operation_sequence",
                "operation sequence must be contiguous and start at 1",
                "operations",
            )
        require_fields(row, "operation", "machine_tooling", "operator", "status")
        if _get(row, "status") not in {
            "Planned",
            "Ready",
            "In Progress",
            "Complete",
            "Blocked",
        }:
            raise PolicyViolation(
                "invalid_shop_operation_status",
                "unsupported operation status",
                "operations",
            )
        operations[int(sequence)] = row
    return operations


def _shop_inspections(
    record: Any,
    lines: Mapping[int, Any],
    allocations: Mapping[str, Any],
    operations: Mapping[int, Any],
    *,
    require_first_piece: bool,
    require_final: bool,
) -> None:
    rows = _rows(record, "inspections")
    first_piece_passes: set[int] = set()
    final_passes: set[int] = set()
    for row in rows:
        require_fields(
            row,
            "inspection_type",
            "line_no",
            "allocation_id",
            "operation_sequence",
            "result",
            "measured_result",
            "inspected_by",
            "inspected_at",
            "evidence_item",
        )
        inspection_type = _get(row, "inspection_type")
        if inspection_type not in {"Incoming", "First Piece", "Final"}:
            raise PolicyViolation(
                "invalid_shop_inspection_type",
                "unsupported inspection type",
                "inspections",
            )
        line_no = _decimal(row, "line_no", required=True)
        allocation_id = str(_get(row, "allocation_id"))
        if line_no is None or int(line_no) not in lines or allocation_id not in allocations:
            raise PolicyViolation(
                "invalid_shop_inspection_reference",
                "inspection must reference a current line and allocation",
                "inspections",
            )
        allocation_line = _decimal(allocations[allocation_id], "line_no", required=True)
        if allocation_line is None or int(allocation_line) != int(line_no):
            raise PolicyViolation(
                "cross_line_shop_inspection",
                "inspection allocation must belong to its line",
                "inspections",
            )
        operation_sequence = _decimal(row, "operation_sequence", required=True)
        if operation_sequence is None or int(operation_sequence) not in operations:
            raise PolicyViolation(
                "invalid_shop_inspection_operation",
                "inspection must reference a current shop operation",
                "inspections",
            )
        if (
            inspection_type in {"First Piece", "Final"}
            and _get(row, "inspected_by")
            == _get(operations[int(operation_sequence)], "operator")
        ):
            raise PolicyViolation(
                "non_independent_shop_inspection",
                "First Piece and Final inspections must be independent of the operation's fabricator",
                "inspections",
            )
        if inspection_type == "First Piece":
            require_fields(
                row,
                "nominal_value",
                "measured_value",
                "tolerance_value",
                "measurement_unit",
            )
            require_nonnegative(row, "measured_value", required=True)
            nominal = _decimal(row, "nominal_value", required=True)
            measured = _decimal(row, "measured_value", required=True)
            tolerance = _decimal(row, "tolerance_value", required=True)
            if nominal is None or nominal <= 0 or tolerance is None or tolerance <= 0:
                raise PolicyViolation(
                    "invalid_first_piece_measurement",
                    "first-piece nominal and tolerance values must be greater than zero",
                    "inspections",
                )
            if measured is None or _blank(_get(row, "measurement_unit")):
                raise PolicyViolation(
                    "invalid_first_piece_measurement",
                    "first-piece measurement requires a value and unit",
                    "inspections",
                )
            if (
                _get(operations[int(operation_sequence)], "status")
                not in {"In Progress", "Complete"}
                or _blank(_get(operations[int(operation_sequence)], "started_at"))
            ):
                raise PolicyViolation(
                    "first_piece_operation_not_started",
                    "a first-piece inspection requires a started in-progress or completed operation",
                    "inspections",
                )
        result = _get(row, "result")
        if result not in {"Pass", "Fail"}:
            raise PolicyViolation(
                "invalid_shop_inspection_result",
                "inspection result must be Pass or Fail",
                "inspections",
            )
        if inspection_type == "First Piece":
            within_tolerance = abs(measured - nominal) <= tolerance
            if (result == "Pass") != within_tolerance:
                raise PolicyViolation(
                    "first_piece_tolerance_result_mismatch",
                    "first-piece result must match the recorded measurement tolerance",
                    "inspections",
                )
            expected_needs_review = 0 if result == "Pass" else 1
            if _get(row, "needs_review") not in {expected_needs_review, bool(expected_needs_review)}:
                raise PolicyViolation(
                    "first_piece_review_state_mismatch",
                    "first-piece review state must match its result",
                    "inspections",
                )
        if result == "Pass" and inspection_type == "First Piece":
            first_piece_passes.add(int(line_no))
        if result == "Pass" and inspection_type == "Final":
            final_passes.add(int(line_no))
    if require_first_piece and set(lines) - first_piece_passes:
        raise PolicyViolation(
            "missing_first_piece_pass",
            "every Shop Order line needs a passed First Piece inspection",
            "inspections",
        )
    if require_final and set(lines) - final_passes:
        raise PolicyViolation(
            "missing_final_shop_inspection",
            "every Shop Order line needs a passed Final inspection",
            "inspections",
        )


def _shop_yield_and_bundles(
    record: Any,
    lines: Mapping[int, Any],
    allocations: Mapping[str, Any],
    operations: Mapping[int, Any],
    *,
    require_handover: bool,
) -> None:
    yields = _rows(record, "yields")
    used_by_allocation: dict[str, Decimal] = {}
    finished_by_line: dict[int, Decimal] = {}
    for row in yields:
        require_fields(
            row,
            "allocation_id",
            "operation_sequence",
            "input_quantity",
            "finished_quantity",
            "remnant_quantity",
            "scrap_quantity",
        )
        allocation_id = str(_get(row, "allocation_id"))
        operation_sequence = _decimal(row, "operation_sequence", required=True)
        if (
            allocation_id not in allocations
            or operation_sequence is None
            or int(operation_sequence) not in operations
        ):
            raise PolicyViolation(
                "invalid_shop_yield_reference",
                "yield must reference a current allocation and operation",
                "yields",
            )
        require_nonnegative(
            row,
            "input_quantity",
            "finished_quantity",
            "remnant_quantity",
            "scrap_quantity",
            required=True,
        )
        input_quantity = _decimal(row, "input_quantity", required=True)
        finished = _decimal(row, "finished_quantity", required=True)
        remnant = _decimal(row, "remnant_quantity", required=True)
        scrap = _decimal(row, "scrap_quantity", required=True)
        if input_quantity is None or finished is None or remnant is None or scrap is None:
            continue
        if abs(input_quantity - (finished + remnant + scrap)) > Decimal("0.01"):
            raise PolicyViolation(
                "shop_yield_conservation_mismatch",
                "input quantity must equal finished plus remnant plus scrap",
                "yields",
            )
        if remnant > 0:
            require_fields(row, "remnant_lot")
        elif not _blank(_get(row, "remnant_lot")):
            raise PolicyViolation(
                "stale_shop_remnant_lot",
                "remnant lot is only valid when remnant quantity is positive",
                "yields",
            )
        if scrap > 0:
            require_fields(row, "scrap_disposition", "evidence_item")
        elif any(
            not _blank(_get(row, field)) for field in ("scrap_disposition", "evidence_item")
        ):
            raise PolicyViolation(
                "stale_shop_scrap_metadata",
                "scrap metadata is only valid when scrap quantity is positive",
                "yields",
            )
        used_by_allocation[allocation_id] = used_by_allocation.get(
            allocation_id, Decimal("0")
        ) + input_quantity
        allocation_line = _decimal(allocations[allocation_id], "line_no", required=True)
        if allocation_line is not None:
            line_no = int(allocation_line)
            finished_by_line[line_no] = finished_by_line.get(
                line_no, Decimal("0")
            ) + finished

    for allocation_id, allocation in allocations.items():
        issued = _decimal(allocation, "issued_quantity", required=True)
        used = used_by_allocation.get(allocation_id, Decimal("0"))
        if issued is not None and used != issued:
            raise PolicyViolation(
                "shop_issue_yield_mismatch",
                "every issued quantity must reconcile to yield rows",
                "yields",
            )

    bundles = _require_clean_rows(record, "bundles", quantity_field="accepted_quantity")
    bundle_ids: set[str] = set()
    bundled_by_line: dict[int, Decimal] = {}
    allocation_lots = {str(_get(row, "material_lot")) for row in allocations.values()}
    for row in bundles:
        require_fields(
            row,
            "bundle_id",
            "line_no",
            "material_lot",
            "piece_identity",
            "accepted_quantity",
            "unit",
            "label_text",
            "handoff_status",
            "condition",
        )
        bundle_id = str(_get(row, "bundle_id"))
        if bundle_id in bundle_ids:
            raise PolicyViolation("duplicate_shop_bundle", "bundle IDs must be unique", "bundles")
        bundle_ids.add(bundle_id)
        line_no = _decimal(row, "line_no", required=True)
        quantity = _decimal(row, "accepted_quantity", required=True)
        if line_no is None or int(line_no) not in lines:
            raise PolicyViolation(
                "unknown_shop_bundle_line",
                "bundle must reference a Shop Order line",
                "bundles",
            )
        if str(_get(row, "material_lot")) not in allocation_lots:
            raise PolicyViolation(
                "unknown_shop_bundle_lot",
                "bundle must use an allocated Material Lot",
                "bundles",
            )
        if quantity is None or quantity <= 0:
            raise PolicyViolation(
                "invalid_shop_bundle_quantity",
                "bundle quantity must be greater than zero",
                "bundles",
            )
        if _get(row, "unit") != _get(lines[int(line_no)], "unit"):
            raise PolicyViolation(
                "shop_bundle_unit_mismatch",
                "bundle unit must match its Shop Order line",
                "bundles",
            )
        handoff_status = _get(row, "handoff_status")
        if handoff_status not in {"Prepared", "Handed Over"}:
            raise PolicyViolation(
                "invalid_shop_bundle_handoff_status",
                "unsupported bundle handoff status",
                "bundles",
            )
        if handoff_status == "Handed Over":
            require_fields(row, "handed_over_to", "handed_over_at", "handoff_evidence")
        elif any(
            not _blank(_get(row, field))
            for field in ("handed_over_to", "handed_over_at", "handoff_evidence")
        ):
            raise PolicyViolation(
                "stale_shop_bundle_handoff",
                "handoff metadata is only valid after handover",
                "bundles",
            )
        bundled_by_line[int(line_no)] = bundled_by_line.get(
            int(line_no), Decimal("0")
        ) + quantity

    for line_no, line in lines.items():
        accepted = _decimal(line, "accepted_quantity", required=True)
        if finished_by_line.get(line_no, Decimal("0")) != accepted:
            raise PolicyViolation(
                "shop_finished_quantity_mismatch",
                "finished yield must equal the accepted line quantity",
                "yields",
            )
        if bundled_by_line.get(line_no, Decimal("0")) != accepted:
            raise PolicyViolation(
                "shop_bundle_quantity_mismatch",
                "labeled bundles must equal the accepted line quantity",
                "bundles",
            )
    if require_handover and any(
        _get(row, "handoff_status") != "Handed Over" for row in bundles
    ):
        raise PolicyViolation(
            "unhanded_shop_bundle",
            "every bundle must be handed over before order handoff",
            "bundles",
        )


def _validate_shop_order(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {"Draft", *SHOP_ORDER_RELEASED_STATUSES}:
        raise PolicyViolation("invalid_shop_order_status", "unsupported shop status", "status")
    require_fields(
        record,
        "roof_job",
        "material_takeoff",
        "supplier_order",
        "work_package",
        "status",
    )
    if context.get("_previous") is None and status != "Draft":
        raise PolicyViolation(
            "invalid_shop_order_initial_state",
            "a Shop Order must begin in Draft",
            "status",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Released"},
            "Released": {"Reserved"},
            "Reserved": {"Setup / First Piece", "Quality Hold"},
            "Setup / First Piece": {"In Fabrication", "Quality Hold"},
            "In Fabrication": {"Quality Hold", "Ready"},
            "Quality Hold": {"Setup / First Piece", "In Fabrication"},
            "Ready": {"Quality Hold", "Handed Over"},
            "Handed Over": {"Invoice Ready", "Quality Hold"},
            "Invoice Ready": {"Closed", "Quality Hold"},
            "Closed": set(),
        },
    )
    if status == "Draft":
        return
    lines = _shop_lines(record, require_output=status in SHOP_ORDER_FINAL_STATUSES)
    material_takeoff = context.get("material_takeoff")
    if not isinstance(material_takeoff, Mapping):
        raise PolicyViolation(
            "unverified_shop_takeoff",
            "Shop Order release requires its Material Takeoff",
            "material_takeoff",
        )
    if _get(material_takeoff, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_shop_takeoff",
            "Shop Order Material Takeoff must share its Roof Job",
            "material_takeoff",
        )
    if _get(material_takeoff, "status") != "Approved":
        raise PolicyViolation(
            "unapproved_shop_takeoff",
            "Shop Order release requires an Approved Material Takeoff",
            "material_takeoff",
        )
    supplier_order = context.get("supplier_order")
    if not isinstance(supplier_order, Mapping):
        raise PolicyViolation(
            "unverified_shop_supplier_order",
            "Shop Order release requires its Supplier Order",
            "supplier_order",
        )
    if _get(supplier_order, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_shop_supplier_order",
            "Shop Order Supplier Order must share its Roof Job",
            "supplier_order",
        )
    if _get(supplier_order, "status") not in {
        "Partially Received",
        "Received",
    }:
        raise PolicyViolation(
            "unreceived_shop_supplier_order",
            "Shop Order release requires a received Supplier Order",
            "supplier_order",
        )
    work_package = context.get("work_package")
    if not isinstance(work_package, Mapping):
        raise PolicyViolation(
            "unverified_shop_work_package",
            "Shop Order release requires its Work Package",
            "work_package",
        )
    if _get(work_package, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_shop_work_package",
            "Shop Order Work Package must share its Roof Job",
            "work_package",
        )
    if _get(work_package, "status") not in {
        "Released",
        "Acknowledged",
        "In Progress",
    }:
        raise PolicyViolation(
            "unreleased_shop_work_package",
            "Shop Order release requires a released Work Package",
            "work_package",
        )
    if status == "Released":
        require_fields(record, "released_by", "released_at")
    allocations = (
        _shop_allocations(record, lines, context)
        if status in SHOP_ORDER_RELEASED_STATUSES - {"Released"}
        else {}
    )
    operations = (
        _shop_operations(record)
        if status in {"Setup / First Piece", "In Fabrication", *SHOP_ORDER_FINAL_STATUSES}
        or (status == "Quality Hold" and _rows(record, "operations"))
        else {}
    )
    if status == "Reserved":
        require_fields(record, "reserved_at")
    if status == "Setup / First Piece":
        require_fields(record, "setup_started_at")
    if status in {"In Fabrication", *SHOP_ORDER_FINAL_STATUSES}:
        _shop_inspections(
            record,
            lines,
            allocations,
            operations,
            require_first_piece=True,
            require_final=status in SHOP_ORDER_FINAL_STATUSES,
        )
    elif status == "Quality Hold" and operations:
        _shop_inspections(
            record,
            lines,
            allocations,
            operations,
            require_first_piece=False,
            require_final=False,
        )
    if status == "In Fabrication":
        require_fields(record, "fabrication_started_at")
    if status == "Quality Hold":
        require_fields(record, "quality_hold_reason")
    if status in SHOP_ORDER_FINAL_STATUSES:
        if context.get("open_nonconformance_count") is None:
            raise PolicyViolation(
                "unverified_shop_nonconformance_state",
                "Shop Order readiness requires a locked nonconformance check",
            )
        if int(context["open_nonconformance_count"] or 0) > 0:
            raise PolicyViolation(
                "open_shop_nonconformance",
                "an unresolved Nonconformance blocks shop readiness",
            )
        _shop_yield_and_bundles(
            record,
            lines,
            allocations,
            operations,
            require_handover=status in {"Handed Over", "Invoice Ready", "Closed"},
        )
    if status == "Ready":
        require_fields(record, "ready_at")
    if status in {"Handed Over", "Invoice Ready", "Closed"}:
        require_fields(record, "handed_over_to", "handed_over_at", "handoff_evidence")
    if status in {"Invoice Ready", "Closed"}:
        require_fields(record, "invoice_payment_milestone", "invoice_ready_at")
        payment_milestone = context.get("invoice_payment_milestone")
        if not isinstance(payment_milestone, Mapping):
            raise PolicyViolation(
                "unverified_shop_invoice_basis",
                "Invoice Ready requires its Payment Milestone",
                "invoice_payment_milestone",
            )
        if _get(payment_milestone, "roof_job") != _get(record, "roof_job"):
            raise PolicyViolation(
                "cross_job_shop_invoice_basis",
                "Payment Milestone must share the Shop Order Roof Job",
                "invoice_payment_milestone",
            )
        if str(_get(payment_milestone, "shop_order")) != str(
            _get(record, "shop_order_id")
        ):
            raise PolicyViolation(
                "shop_invoice_basis_mismatch",
                "Payment Milestone must be linked to this Shop Order",
                "invoice_payment_milestone",
            )
        if _get(payment_milestone, "status") not in {
            "Webhook Seen",
            "Needs Review",
            "Matched",
        }:
            raise PolicyViolation(
                "unverified_shop_invoice_basis",
                "Invoice Ready requires a linked payment milestone",
                "invoice_payment_milestone",
            )
    if status == "Closed":
        require_fields(record, "closed_at")
        if _get(context["invoice_payment_milestone"], "status") != "Matched":
            raise PolicyViolation(
                "unmatched_shop_payment",
                "Shop Order close requires a Matched payment milestone",
                "invoice_payment_milestone",
            )
    _lock_after_status(
        record,
        context,
        SHOP_ORDER_RELEASED_STATUSES,
        "roof_job",
        "material_takeoff",
        "supplier_order",
        "work_package",
        "lines",
    )


def _validate_nonconformance(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {"Draft", "Open", "Contained", "Dispositioned", "Closed"}:
        raise PolicyViolation(
            "invalid_nonconformance_status", "unsupported nonconformance status", "status"
        )
    require_fields(record, "shop_order", "material_lot", "status")
    shop_order = context.get("shop_order")
    material_lot = context.get("material_lot")
    if not isinstance(shop_order, Mapping) or not isinstance(material_lot, Mapping):
        raise PolicyViolation(
            "unverified_nonconformance_lineage",
            "Nonconformance requires its Shop Order and Material Lot lineage",
        )
    if _get(shop_order, "roof_job") != _get(material_lot, "roof_job"):
        raise PolicyViolation(
            "nonconformance_roof_job_mismatch",
            "Nonconformance Shop Order and Material Lot must share a Roof Job",
        )
    allocation_lot_ids = context.get("shop_order_allocation_lot_ids")
    if not isinstance(allocation_lot_ids, (set, frozenset, tuple, list)):
        raise PolicyViolation(
            "unverified_nonconformance_allocation",
            "Nonconformance requires the Shop Order allocation lineage",
        )
    material_lot_ids = {
        str(value)
        for value in (_get(material_lot, "name"), _get(material_lot, "material_lot_id"))
        if not _blank(value)
    }
    if not material_lot_ids & {str(value) for value in allocation_lot_ids}:
        raise PolicyViolation(
            "nonconformance_unallocated_lot",
            "Nonconformance Material Lot must be allocated to its Shop Order",
            "material_lot",
        )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Open"},
            "Open": {"Contained"},
            "Contained": {"Dispositioned"},
            "Dispositioned": {"Closed"},
            "Closed": set(),
        },
    )
    if status in {"Open", "Contained", "Dispositioned", "Closed"}:
        require_fields(record, "detected_at", "reported_by", "description", "evidence_item")
    if status in {"Contained", "Dispositioned", "Closed"}:
        require_fields(record, "containment")
    if status in {"Dispositioned", "Closed"}:
        require_fields(record, "disposition", "disposition_by", "disposition_at")
    if status == "Closed":
        require_fields(record, "closed_by", "closed_at", "closure_evidence")
    _lock_after_status(
        record,
        context,
        {"Open", "Contained", "Dispositioned", "Closed"},
        "shop_order",
        "material_lot",
        "detected_at",
        "reported_by",
        "description",
        "evidence_item",
    )


def _validate_customer_quote_correction(record: Any, context: Mapping[str, Any]) -> None:
    """Keep quote correction lineage internal until a new commercial review completes.

    An Accepted Customer Quote is contract evidence, not a repricing source. Any change after
    acceptance must enter the separately evidenced Change Order flow. This applies equally to
    direct Frappe writes and Hermes commands.
    """

    if _blank(_get(record, "supersedes")):
        return
    require_fields(record, "roof_job", "customer", "quote_version", "correction_reason")
    _validate_correction(record, context, version_field="quote_version")
    prior = context.get("superseded_record")
    if prior is None:
        return
    if (
        _get(prior, "status") == "Accepted"
        or not _blank(_get(prior, "contract_acceptance"))
        or not _blank(_get(prior, "accepted_at"))
    ):
        raise PolicyViolation(
            "accepted_quote_revision_requires_change_order",
            "accepted quotes must be changed through an evidenced Change Order",
            "supersedes",
        )
    prior_customer = _get(prior, "customer")
    if _blank(prior_customer):
        raise PolicyViolation(
            "unverified_correction_customer",
            "the superseded quote customer could not be verified",
            "supersedes",
        )
    if _get(record, "customer") != prior_customer:
        raise PolicyViolation(
            "cross_customer_correction",
            "quote revisions must remain with the same customer",
            "customer",
        )


def _validate_customer_quote(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(
        record,
        "subtotal",
        "tax_amount",
        "quote_total",
        "deposit_amount",
        "amount_due",
        "amount_paid",
        "balance_due",
    )
    status = _get(record, "status")
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Draft": {"Needs Review", "Rejected", "Expired"},
            "Needs Review": {"Draft", "Approved", "Rejected", "Expired"},
            "Approved": {"Accepted", "Rejected", "Expired"},
            "Accepted": set(),
            "Rejected": set(),
            "Expired": set(),
        },
    )
    price_rule_snapshot = parse_json_field(
        record,
        "price_rule_snapshot_json",
        container_types=(dict,),
        non_empty=True,
    )
    if price_rule_snapshot is not None:
        _validate_quote_price_rule_snapshot(record, price_rule_snapshot, context)
    if status not in {"Approved", "Accepted"}:
        _validate_customer_quote_correction(record, context)
        return
    require_fields(
        record,
        "roof_job",
        "customer",
        "quote_version",
        "price_book_version",
        "pricing_effective_at",
        "price_rule_snapshot_json",
        "subtotal",
        "tax_amount",
        "tax_code",
        "tax_rate",
        "quote_total",
        "currency",
        "amount_due",
        "amount_paid",
        "balance_due",
        "payment_status",
        "payment_truth_source",
        "payment_truth_at",
        "scope_summary",
        "assumptions",
        "exclusions",
    )
    _require_amount_equation(record, "quote_total", "subtotal", "tax_amount")
    quote_total = _decimal(record, "quote_total", required=True)
    amount_paid = _decimal(record, "amount_paid", required=True)
    balance_due = _decimal(record, "balance_due", required=True)
    if quote_total is not None and amount_paid is not None and balance_due is not None and abs(balance_due - (quote_total - amount_paid)) > Decimal("0.01"):
        raise PolicyViolation("amount_mismatch", "must equal quote_total - amount_paid", "balance_due")
    require_approval(record)
    parse_json_field(record, "quote_summary_json", required=True, non_empty=True)
    parse_json_field(record, "tax_policy_snapshot_json", required=True, container_types=(dict,), non_empty=True)
    _lock_after_status(
        record,
        context,
        {"Approved", "Accepted"},
        "quote_version",
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
        "scope_summary",
        "assumptions",
        "exclusions",
        "quote_summary_json",
    )
    if status == "Accepted":
        require_fields(
            record, "acceptance_evidence", "contract_acceptance", "accepted_at"
        )
    _validate_customer_quote_correction(record, context)


def _validate_quote_price_rule_snapshot(
    record: Any, snapshot: Mapping[str, Any], context: Mapping[str, Any]
) -> None:
    """Keep quote price provenance append-only and tied to live rule identities."""

    if set(snapshot) != {"quote", "captured_at", "rules"}:
        raise PolicyViolation(
            "invalid_price_rule_snapshot",
            "must contain quote, captured_at, and rules only",
            "price_rule_snapshot_json",
        )
    quote = snapshot["quote"]
    if not isinstance(quote, Mapping) or set(quote) != {
        "customer_quote_id",
        "quote_version",
        "price_book_version",
        "pricing_effective_at",
    }:
        raise PolicyViolation(
            "invalid_price_rule_snapshot",
            "quote identity must use the canonical snapshot shape",
            "price_rule_snapshot_json",
        )
    if (
        quote["customer_quote_id"] != _get(record, "customer_quote_id")
        or quote["quote_version"] != _get(record, "quote_version")
        or quote["price_book_version"] != _get(record, "price_book_version")
        or quote["pricing_effective_at"] != _get(record, "pricing_effective_at")
        or not _safe_positive_int(quote["quote_version"])
        or _blank(quote["price_book_version"])
        or not _safe_iso_timestamp(quote["pricing_effective_at"])
        or not _safe_iso_timestamp(snapshot["captured_at"])
    ):
        raise PolicyViolation(
            "price_rule_snapshot_quote_mismatch",
            "snapshot quote identity must match the Customer Quote",
            "price_rule_snapshot_json",
        )
    rules = snapshot["rules"]
    if not isinstance(rules, list) or not 1 <= len(rules) <= 50:
        raise PolicyViolation(
            "invalid_price_rule_snapshot",
            "must contain one to fifty price rules",
            "price_rule_snapshot_json",
        )
    if len({row.get("price_rule_id") for row in rules if isinstance(row, Mapping)}) != len(rules):
        raise PolicyViolation(
            "duplicate_price_rule_snapshot",
            "price rule identities must be unique",
            "price_rule_snapshot_json",
        )

    sources = context.get("price_rule_snapshot_rules")
    if not isinstance(sources, Mapping):
        raise PolicyViolation(
            "unverified_price_rule_snapshot",
            "price rule sources could not be verified",
            "price_rule_snapshot_json",
        )
    previous = context.get("_previous")
    binding = previous is None or _blank(_get(previous, "price_rule_snapshot_json"))
    if binding and _get(record, "status") not in {"Draft", "Needs Review"}:
        raise PolicyViolation(
            "price_rule_snapshot_bind_state",
            "a snapshot can only be first bound while the quote is Draft or Needs Review",
            "price_rule_snapshot_json",
        )
    effective_date = str(quote["pricing_effective_at"])[:10]
    fields = {
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
        "effective_from",
        "effective_to",
        "assumptions",
        "exclusions",
        "approved_by",
        "approved_at",
        "rule_json",
    }
    source_scalar_fields = fields - {"price_rule_id", "rule_json", "status"}
    for rule in rules:
        if (
            not isinstance(rule, Mapping)
            or set(rule) != fields
            or rule.get("status") != "Approved"
            or not _safe_proposal_summary_label(rule.get("price_rule_id"))
            or not all(isinstance(rule.get(field), str) for field in source_scalar_fields)
            or not isinstance(rule.get("rule_json"), dict)
            or not rule["rule_json"]
        ):
            raise PolicyViolation(
                "invalid_price_rule_snapshot",
                "rules must use the canonical frozen source shape",
                "price_rule_snapshot_json",
            )
        source = sources.get(rule["price_rule_id"])
        if not isinstance(source, Mapping) or source.get("price_rule_id") != rule["price_rule_id"]:
            raise PolicyViolation(
                "unverified_price_rule_snapshot",
                "each rule must resolve to its live source record",
                "price_rule_snapshot_json",
            )
        source_status = source.get("status")
        if source_status not in ({"Approved"} if binding else {"Approved", "Retired"}):
            raise PolicyViolation(
                "unapproved_price_rule_snapshot",
                "a snapshot can only bind approved price rules",
                "price_rule_snapshot_json",
            )
        source_from = str(source.get("effective_from") or "")[:10]
        source_to = str(source.get("effective_to") or "")[:10]
        if binding and (not source_from or effective_date < source_from or (source_to and effective_date > source_to)):
            raise PolicyViolation(
                "price_rule_effective_window_mismatch",
                "each bound rule must be effective at the quote pricing timestamp",
                "price_rule_snapshot_json",
            )
        source_rule_json = parse_json_field(
            source,
            "rule_json",
            required=True,
            container_types=(dict,),
            non_empty=True,
        )
        if rule["rule_json"] != source_rule_json or any(
            str(source.get(field) or "") != rule[field]
            for field in source_scalar_fields
        ):
            raise PolicyViolation(
                "price_rule_snapshot_source_mismatch",
                "frozen rule fields must match their verified source records",
                "price_rule_snapshot_json",
            )


def _validate_payment_milestone(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(
        record,
        "subtotal",
        "tax_amount",
        "total_amount",
        "amount_due",
        "amount_paid",
        "balance_due",
    )
    _enforce_state_transition(
        record,
        context,
        "status",
        {
            "Webhook Seen": {"Needs Review", "Ignored"},
            "Needs Review": {"Matched", "Ignored"},
            "Matched": set(),
            "Ignored": set(),
        },
    )
    if _get(record, "status") == "Webhook Seen":
        require_fields(
            record,
            "roof_job",
            "milestone_type",
            "milestone_version",
            "qb_entity_type",
            "qb_entity_id",
            "qb_operation",
            "realm_id",
            "event_ts",
            "raw_key",
            "raw_payload_hash",
        )
        entity_type = _get(record, "qb_entity_type")
        if entity_type not in QUICKBOOKS_FINANCE_ENTITY_TYPES:
            raise PolicyViolation(
                "unsupported_quickbooks_entity",
                "Webhook Seen milestones accept only supported QuickBooks finance entities",
                "qb_entity_type",
            )
        if _get(record, "milestone_type") != QUICKBOOKS_MILESTONE_TYPES[entity_type]:
            raise PolicyViolation(
                "quickbooks_milestone_type_mismatch",
                "milestone type must match the immutable QuickBooks entity type",
                "milestone_type",
            )
        if _get(record, "qb_operation") not in QUICKBOOKS_FINANCE_OPERATIONS:
            raise PolicyViolation(
                "invalid_quickbooks_operation",
                "Webhook Seen milestones require a supported QuickBooks operation",
                "qb_operation",
            )
        if not str(_get(record, "raw_key") or "").startswith("raw/quickbooks/"):
            raise PolicyViolation(
                "invalid_quickbooks_raw_key",
                "Webhook Seen milestones must point to immutable raw webhook evidence",
                "raw_key",
            )
        require_sha256(record, "raw_payload_hash")
        if _get(record, "payment_status") not in {None, "", "Not Due"} or not _blank(_get(record, "truth_source")) or not _blank(_get(record, "truth_at")):
            raise PolicyViolation(
                "webhook_payment_milestone_provider_truth_unavailable",
                "a webhook receipt cannot establish payment status or provider truth",
                "payment_status",
            )
        for field in ("subtotal", "tax_amount", "total_amount", "amount_due", "amount_paid", "balance_due"):
            value = _decimal(record, field)
            if value is not None and value != Decimal("0"):
                raise PolicyViolation(
                    "webhook_payment_milestone_provider_truth_unavailable",
                    "a webhook receipt cannot establish financial amounts",
                    field,
                )
    if _get(record, "status") == "Matched":
        require_fields(
            record,
            "roof_job",
            "milestone_version",
            "currency",
            "subtotal",
            "tax_amount",
            "total_amount",
            "amount_due",
            "amount_paid",
            "balance_due",
            "payment_status",
            "tax_code",
            "tax_rate",
            "truth_source",
            "truth_at",
        )
        _require_amount_equation(record, "total_amount", "subtotal", "tax_amount")
        total = _decimal(record, "total_amount", required=True)
        paid = _decimal(record, "amount_paid", required=True)
        balance = _decimal(record, "balance_due", required=True)
        if total is not None and paid is not None and balance is not None and abs(balance - (total - paid)) > Decimal("0.01"):
            raise PolicyViolation("amount_mismatch", "must equal total_amount - amount_paid", "balance_due")
        parse_json_field(record, "tax_policy_snapshot_json", required=True, container_types=(dict,), non_empty=True)
    _lock_after_status(
        record,
        context,
        {"Matched"},
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
    )
    _validate_correction(record, context, version_field="milestone_version")


def _validate_proposal(record: Any, context: Mapping[str, Any]) -> None:
    """Keep every proposal evidence pack anchored to one approved quote.

    A Draft pack is already a durable, customer-adjacent evidence artifact.  It
    must therefore carry a verified quote anchor and a nonempty evidence
    summary; otherwise a later status transition could make an unrelated or
    unanchored pack appear customer-ready.  The anchor is immutable after
    insert so quote revisions receive their own evidence pack rather than
    rewriting the prior version's proof.
    """

    require_fields(record, "roof_job", "quotation")
    enforce_immutable(record, context.get("_previous"), "roof_job", "quotation")
    if _get(record, "pack_id") != f"proposal:{_get(record, 'quotation')}":
        raise PolicyViolation(
            "proposal_pack_id_mismatch",
            "must be derived from the linked Customer Quote",
            "pack_id",
        )
    status = _get(record, "status")
    if status == "Draft":
        pass
    elif status == "Approved" and _is_approved_proposal_publication(record, context):
        require_approval(record)
    else:
        raise PolicyViolation(
            "proposal_pack_draft_only",
            "status changes require a dedicated receipt-verifying delivery command",
            "status",
        )
    quote_status = _context_status(context, "quote_status")
    if quote_status not in {"Approved", "Accepted"}:
        raise PolicyViolation(
            "unapproved_quote",
            "linked Customer Quote must be Approved or Accepted",
            "quotation",
        )

    quote_roof_job = _context_status(context, "quote_roof_job")
    if quote_roof_job is None:
        raise PolicyViolation(
            "unverified_proposal_quote",
            "linked Customer Quote roof job could not be verified",
            "quotation",
        )
    if quote_roof_job != str(_get(record, "roof_job")):
        raise PolicyViolation(
            "cross_job_proposal_quote",
            "linked Customer Quote must belong to the same Roof Job",
            "quotation",
        )
    if not context.get("quote_price_rule_snapshot_bound"):
        raise PolicyViolation(
            "unbound_quote_price_rules",
            "linked Customer Quote must carry an immutable Price Book Rule snapshot",
            "quotation",
        )
    summary = parse_json_field(
        record,
        "evidence_summary_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    _validate_proposal_evidence_summary(record, summary, context)
    if not _blank(_get(record, "customer_message")):
        raise PolicyViolation(
            "proposal_customer_message_forbidden",
            "customer messages require a dedicated approved delivery workflow",
            "customer_message",
        )
    _lock_after_status(
        record,
        context,
        {"Approved"},
        "pack_id",
        "roof_job",
        "quotation",
        "prepared_at",
        "approved_by",
        "approved_at",
        "evidence_summary_json",
        "assumptions",
        "exclusions",
        "signed_evidence",
        "signed_at",
        "customer_message",
    )


def _is_approved_proposal_publication(
    record: Any, context: Mapping[str, Any]
) -> bool:
    """Accept only the exact private Draft-to-Approved command context.

    ``domain_policy`` stays independently useful for contract validation, so it
    cannot import request-local Frappe state.  The document adapter injects this
    small, server-derived context only while the receipt-verifying command holds
    its private ContextVar; every other non-Draft proposal state remains invalid.
    """

    publication = context.get("proposal_publication")
    previous = context.get("_previous")
    if not isinstance(publication, Mapping) or previous is None:
        return False
    approved_by = _get(record, "approved_by")
    approved_at = _get(record, "approved_at")
    return (
        _get(previous, "status") == "Draft"
        and _get(record, "name") == publication.get("proposal_evidence_pack_id")
        and isinstance(publication.get("hermes_run_id"), str)
        and not _blank(publication.get("hermes_run_id"))
        and approved_by == publication.get("approved_by")
        and approved_at == publication.get("approved_at")
        and not _blank(approved_by)
        and _safe_iso_timestamp(approved_at)
    )


def _validate_proposal_evidence_summary(
    record: Any, summary: Mapping[str, Any], context: Mapping[str, Any]
) -> None:
    """Allow only the redacted, quote-bound evidence summary emitted by Hermes."""

    required = {
        "roof_job",
        "quotation",
        "quote_version",
        "counts",
        "measurement_reports",
        "eligible_evidence",
        "withheld_evidence",
    }
    allowed = required | {"generated_at"}
    if set(summary) - allowed or required - set(summary):
        raise PolicyViolation(
            "invalid_proposal_evidence_summary",
            "must use the redacted proposal evidence summary shape",
            "evidence_summary_json",
        )
    if summary["roof_job"] != _get(record, "roof_job") or summary["quotation"] != _get(
        record, "quotation"
    ):
        raise PolicyViolation(
            "proposal_evidence_anchor_mismatch",
            "summary roof job and quotation must match the pack",
            "evidence_summary_json",
        )
    if not _safe_positive_int(summary["quote_version"]) or (
        "generated_at" in summary
        and not _safe_iso_timestamp(summary["generated_at"])
    ):
        raise PolicyViolation(
            "invalid_proposal_evidence_summary",
            "quote version and generation time must be safe scalar values",
            "evidence_summary_json",
        )
    if summary["quote_version"] != context.get("quote_version"):
        raise PolicyViolation(
            "proposal_quote_version_mismatch",
            "summary quote version must match the linked Customer Quote",
            "evidence_summary_json",
        )

    counts = summary["counts"]
    measurement_reports = summary["measurement_reports"]
    eligible_evidence = summary["eligible_evidence"]
    withheld_evidence = summary["withheld_evidence"]
    count_keys = {"measurement_reports", "eligible_evidence", "withheld_evidence"}
    withheld_keys = {
        "not_customer_safe",
        "unverified_or_incomplete",
        "identity_missing",
    }
    if (
        not isinstance(counts, dict)
        or set(counts) != count_keys
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in counts.values()
        )
        or not isinstance(measurement_reports, list)
        or not isinstance(eligible_evidence, list)
        or not isinstance(withheld_evidence, dict)
        or set(withheld_evidence) != withheld_keys
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in withheld_evidence.values()
        )
    ):
        raise PolicyViolation(
            "invalid_proposal_evidence_summary",
            "counts and withheld evidence must be complete nonnegative integers",
            "evidence_summary_json",
        )
    if (
        not measurement_reports
        or not eligible_evidence
        or counts["measurement_reports"] != len(measurement_reports)
        or counts["eligible_evidence"] != len(eligible_evidence)
        or counts["withheld_evidence"] != sum(withheld_evidence.values())
    ):
        raise PolicyViolation(
            "proposal_evidence_count_mismatch",
            "counts must match approved measurements and verified eligible evidence",
            "evidence_summary_json",
        )
    if (
        len(
            {
                row.get("measurement_id")
                for row in measurement_reports
                if isinstance(row, Mapping)
            }
        )
        != len(measurement_reports)
        or len(
            {
                row.get("evidence_id")
                for row in eligible_evidence
                if isinstance(row, Mapping)
            }
        )
        != len(eligible_evidence)
    ):
        raise PolicyViolation(
            "duplicate_proposal_evidence",
            "measurement and evidence identities must be unique",
            "evidence_summary_json",
        )

    source_measurements = context.get("proposal_measurements")
    source_evidence = context.get("proposal_evidence")
    if not isinstance(source_measurements, Mapping) or not isinstance(
        source_evidence, Mapping
    ):
        raise PolicyViolation(
            "unverified_proposal_evidence",
            "proposal source records could not be verified",
            "evidence_summary_json",
        )

    for measurement in measurement_reports:
        if (
            not isinstance(measurement, dict)
            or set(measurement)
            != {"measurement_id", "provider", "review_status", "approved_at"}
            or measurement.get("review_status") != "Approved"
            or not all(
                _safe_proposal_summary_label(measurement.get(field))
                for field in ("measurement_id", "provider")
            )
            or not _safe_iso_timestamp(measurement.get("approved_at"))
        ):
            raise PolicyViolation(
                "invalid_proposal_evidence_summary",
                "measurements must contain only approved redacted provenance",
                "evidence_summary_json",
            )
        source = source_measurements.get(measurement["measurement_id"])
        if (
            not isinstance(source, Mapping)
            or source.get("roof_job") != _get(record, "roof_job")
            or source.get("review_status") != "Approved"
            or _blank(source.get("approved_by"))
            or source.get("provider") != measurement["provider"]
            or source.get("approved_at") != measurement["approved_at"]
        ):
            raise PolicyViolation(
                "unverified_proposal_measurement",
                "measurement must resolve to an approved same-job source record",
                "evidence_summary_json",
            )
    for evidence in eligible_evidence:
        if (
            not isinstance(evidence, dict)
            or set(evidence) != {"evidence_id", "evidence_type", "proof_slot"}
            or not all(
                _safe_proposal_summary_label(evidence.get(field)) for field in evidence
            )
        ):
            raise PolicyViolation(
                "invalid_proposal_evidence_summary",
                "eligible evidence must contain only safe identifiers and labels",
                "evidence_summary_json",
            )
        source = source_evidence.get(evidence["evidence_id"])
        checksum = (
            str(source.get("content_checksum") or "")
            if isinstance(source, Mapping)
            else ""
        )
        if (
            not isinstance(source, Mapping)
            or source.get("roof_job") != _get(record, "roof_job")
            or source.get("evidence_type") != evidence["evidence_type"]
            or source.get("proof_slot") != evidence["proof_slot"]
            or source.get("customer_safe") not in {True, 1, "1"}
            or source.get("sync_state") != "Verified"
            or source.get("checksum_algorithm") != "SHA-256"
            or len(checksum) != 64
            or any(character not in "0123456789abcdef" for character in checksum)
            or _blank(source.get("verified_at"))
            or _blank(source.get("verification_source"))
            or not any(
                not _blank(source.get(field))
                for field in ("source_uri", "r2_key", "drive_file_id")
            )
        ):
            raise PolicyViolation(
                "unverified_proposal_evidence",
                "evidence must resolve to verified same-job customer-safe proof",
                "evidence_summary_json",
            )


def _safe_proposal_summary_label(value: Any) -> bool:
    normalized = value.strip() if isinstance(value, str) else ""
    return bool(normalized) and len(normalized) <= 140 and not any(
        marker in normalized.lower()
        for marker in ("://", "r2:", "s3:", "/", "\\\\", "\n", "\r")
    )


def _safe_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _safe_iso_timestamp(value: Any) -> bool:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized or len(normalized) > 64:
        return False
    try:
        datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _validate_completion(record: Any, _context: Mapping[str, Any]) -> None:
    if _get(record, "status") != "Approved":
        return
    require_fields(record, "roof_job", "customer_signoff_ref", "completion_evidence")
    require_approval(record)
    parse_json_field(record, "photo_evidence_json", required=True, non_empty=True)
    parse_json_field(record, "evidence_summary_json", required=True, non_empty=True)
    if not bool(_get(record, "warranty_ready")):
        raise PolicyViolation(
            "warranty_not_ready",
            "completion cannot be approved until warranty is ready",
        )
    if not bool(_get(record, "deficiencies_resolved")):
        raise PolicyViolation(
            "open_deficiencies",
            "completion cannot be approved with unresolved deficiencies",
        )


def _validate_warranty(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {"Approved", "Issued"}:
        return
    require_fields(
        record,
        "roof_job",
        "completion_packet",
        "material_system",
        "warranty_terms",
        "coverage_start",
        "coverage_years",
        "exclusions",
    )
    require_nonnegative(record, "coverage_years", required=True)
    if _decimal(record, "coverage_years", required=True) == 0:
        raise PolicyViolation(
            "invalid_warranty_term", "coverage_years must be greater than zero"
        )
    require_approval(record)
    if _context_status(context, "completion_status") != "Approved":
        raise PolicyViolation(
            "unapproved_completion", "linked Completion Packet must be Approved"
        )
    parse_json_field(record, "evidence_summary_json", required=True, non_empty=True)
    if status == "Issued":
        require_fields(record, "issued_at", "issued_evidence")


def _validate_gate_evidence(record: Any, context: Mapping[str, Any]) -> None:
    evidence_id = _get(record, "evidence_item")
    sources = context.get("gate_evidence")
    source = sources.get(str(evidence_id)) if isinstance(sources, Mapping) else None
    if not isinstance(source, Mapping):
        raise PolicyViolation(
            "unverified_gate_evidence",
            "Ready or Done gate evidence could not be verified",
            "evidence_item",
        )
    if _get(source, "roof_job") != _get(record, "roof_job"):
        raise PolicyViolation(
            "cross_job_gate_evidence",
            "Ready or Done gate evidence must belong to the same Roof Job",
            "evidence_item",
        )
    if _get(source, "sync_state") != "Verified":
        raise PolicyViolation(
            "unverified_gate_evidence",
            "Ready or Done gate evidence must be verified",
            "evidence_item",
        )
    if _get(source, "checksum_algorithm") != "SHA-256":
        raise PolicyViolation(
            "unsupported_checksum",
            "Ready or Done gate evidence must use SHA-256",
            "evidence_item",
        )
    require_sha256(source, "content_checksum")
    if (
        _blank(_get(source, "verified_at"))
        or _blank(_get(source, "verification_source"))
        or not any(
            not _blank(_get(source, field))
            for field in ("source_uri", "r2_key", "drive_file_id")
        )
    ):
        raise PolicyViolation(
            "unverified_gate_evidence",
            "Ready or Done gate evidence must retain verification and source proof",
            "evidence_item",
        )


def _validate_gate(record: Any, context: Mapping[str, Any]) -> None:
    state = _get(record, "state")
    require_fields(record, "owner_user", "assigned_at")
    if state == "Blocked":
        require_fields(record, "blocker_reason", "due_at")
    elif state == "Waived":
        require_fields(record, "waived_by", "waived_at", "waiver_reason")
    elif state in {"Ready", "Done"}:
        require_fields(record, "evidence_item")
        _validate_gate_evidence(record, context)
        if state == "Ready":
            require_fields(record, "due_at")
        if any(
            not _blank(_get(record, field))
            for field in ("waived_by", "waived_at", "waiver_reason")
        ):
            raise PolicyViolation(
                "stale_waiver", "non-waived gate cannot retain waiver metadata"
            )


def _gate_map(gates: Sequence[Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for gate in gates:
        gate_name = _get(gate, "gate")
        if _blank(gate_name):
            continue
        if gate_name in result:
            raise PolicyViolation(
                "ambiguous_gate", f"multiple current records exist for {gate_name}"
            )
        result[str(gate_name)] = gate
    return result


def _require_production_gate_states(
    gate_rows: Sequence[Any],
    allowed_states: frozenset[str],
    violation_code: str,
    context: Mapping[str, Any],
) -> dict[str, Any]:
    gates = _gate_map(gate_rows)
    for gate_name in PRODUCTION_GATES:
        gate = gates.get(gate_name)
        if gate is None or _get(gate, "state") not in allowed_states:
            raise PolicyViolation(
                violation_code,
                f"{gate_name} gate must be one of {sorted(allowed_states)}",
            )
        _validate_gate(gate, context)
    return gates


def _validate_roof_job(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "job_status")
    if status in {"Won", "In Production", "Completed", "Closed"}:
        require_fields(
            record,
            "workflow_profile",
            "locale_policy_version",
            "locale_policy_snapshot_json",
        )
        parse_json_field(
            record,
            "locale_policy_snapshot_json",
            required=True,
            container_types=(dict,),
            non_empty=True,
        )
    if status not in {"In Production", "Closed"}:
        return
    allowed = (
        SCHEDULABLE_PRODUCTION_GATE_STATES
        if status == "In Production"
        else CLOSEOUT_PRODUCTION_GATE_STATES
    )
    gates = _require_production_gate_states(
        context.get("gates", ()), allowed, "production_gate_block", context
    )
    if status == "Closed":
        completion_gate = gates.get("Completion")
        if completion_gate is None or _get(completion_gate, "state") not in {
            "Done",
            "Waived",
        }:
            raise PolicyViolation(
                "closeout_gate_block",
                "Completion gate must be Done or explicitly Waived",
            )
        _validate_gate(completion_gate, context)
        completion_statuses = {
            _get(row, "status") for row in context.get("completion_packets", [])
        }
        warranty_statuses = {
            _get(row, "status") for row in context.get("warranty_packets", [])
        }
        payment_statuses = {
            _get(row, "status") for row in context.get("payment_milestones", [])
        }
        if "Approved" not in completion_statuses:
            raise PolicyViolation(
                "missing_closeout_proof", "an Approved Completion Packet is required"
            )
        if not warranty_statuses.intersection({"Approved", "Issued"}):
            raise PolicyViolation(
                "missing_warranty_proof",
                "an Approved or Issued Warranty Packet is required",
            )
        if "Matched" not in payment_statuses:
            raise PolicyViolation(
                "missing_payment_proof",
                "a Matched payment/invoice milestone is required",
            )


def _has_stop_conditions(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, list):
        return any(bool(item) for item in value)
    if not isinstance(value, dict):
        return True
    if not value:
        return True
    for key in ("blocking", "blocked_by", "reasons", "stop_conditions"):
        if key in value and bool(value[key]):
            return True
    if (
        value.get("blocked") is True
        or value.get("eligible") is False
        or value.get("clear") is False
    ):
        return True
    recognized = {
        "blocking",
        "blocked_by",
        "reasons",
        "stop_conditions",
        "blocked",
        "eligible",
        "clear",
    }
    has_explicit_decision = any(key in value for key in recognized)
    return not has_explicit_decision or any(
        bool(item) for key, item in value.items() if key not in recognized
    )


def _validate_review_request(record: Any, context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    if status not in {"Eligible", "Approved", "Sent"}:
        return
    require_fields(
        record,
        "roof_job",
        "completion_packet",
        "review_link",
        "consent_basis",
        "eligibility_checked_by",
        "eligibility_checked_at",
    )
    if not bool(_get(record, "quiet_hours_ok")):
        raise PolicyViolation(
            "quiet_hours_block",
            "review outreach is not allowed in the current quiet-hours window",
        )
    conditions = parse_json_field(record, "stop_conditions_json", required=True)
    if _has_stop_conditions(conditions):
        raise PolicyViolation(
            "review_stop_condition", "review request has unresolved stop conditions"
        )
    if _context_status(context, "completion_status") != "Approved":
        raise PolicyViolation(
            "unapproved_completion",
            "review eligibility requires an Approved Completion Packet",
        )
    if status in {"Approved", "Sent"}:
        require_approval(record)
    if status == "Sent":
        require_fields(record, "sent_at")


def _validate_communication(record: Any, _context: Mapping[str, Any]) -> None:
    if _get(record, "direction") != "Outbound":
        return
    policy_result = _get(record, "policy_result")
    if policy_result == "Blocked":
        parse_json_field(record, "policy_reasons_json", required=True, non_empty=True)
        if _get(record, "status") in {"Approved", "Sent"}:
            raise PolicyViolation(
                "communication_blocked",
                "blocked communication cannot be Approved or Sent",
            )
        return
    require_fields(record, "consent_basis", "policy_checked_by", "policy_checked_at")
    if not bool(_get(record, "quiet_hours_ok")):
        raise PolicyViolation(
            "quiet_hours_block", "outbound communication is outside permitted hours"
        )
    if policy_result != "Allowed":
        raise PolicyViolation(
            "consent_policy_block",
            "outbound communication must have an explicit Allowed policy result",
        )
    if _get(record, "status") in {"Approved", "Sent"}:
        require_approval(record)
    if _get(record, "status") == "Sent":
        require_fields(record, "sent_at", "provider_message_id")


def _validate_hermes_run(record: Any, _context: Mapping[str, Any]) -> None:
    capability = _get(record, "capability_level")
    approval = _get(record, "approval_status")
    result = _get(record, "result_status")
    mutated = bool(_get(record, "mutation_applied"))
    if capability == "Approved-write":
        require_fields(record, "target_doctype", "target_name", "tool_name")
        parse_json_field(record, "tool_args_json", required=True)
        parse_json_field(record, "dry_run_json", required=True, non_empty=True)
        if approval in {"Approved", "Executed", "Audit Failed"}:
            policy = parse_json_field(
                record,
                "policy_check_json",
                required=True,
                container_types=(dict,),
                non_empty=True,
            )
            if policy.get("allowed") is not True:
                raise PolicyViolation(
                    "policy_check_block",
                    "approved write requires policy_check_json.allowed=true",
                )
            require_fields(
                record,
                "policy_checked_by",
                "policy_checked_at",
                "dry_run_receipt",
                "approval_receipt",
            )
            require_approval(record)
        if approval == "Executed":
            require_fields(
                record,
                "audit_event_id",
                "request_correlation_id",
                "completed_at",
                "before_target_ids",
                "after_target_ids",
            )
            if result != "OK" or not mutated:
                raise PolicyViolation(
                    "audit_state_mismatch",
                    "Executed write requires result_status=OK and mutation_applied",
                )
            parse_json_field(record, "result_json", required=True)
        elif approval == "Audit Failed":
            require_fields(
                record,
                "audit_incident_id",
                "request_correlation_id",
                "completed_at",
                "before_target_ids",
                "after_target_ids",
                "error",
            )
            if result != "Error" or not mutated:
                raise PolicyViolation(
                    "audit_state_mismatch",
                    "Audit Failed requires result_status=Error and mutation_applied",
                )
            parse_json_field(record, "result_json", required=True, non_empty=True)
        elif mutated:
            raise PolicyViolation(
                "audit_state_mismatch",
                "mutation_applied is only valid when approval_status is Executed or Audit Failed",
            )
    elif mutated or approval in {"Executed", "Audit Failed"}:
        raise PolicyViolation(
            "capability_escalation", "read/draft/denied run cannot record a mutation"
        )
    if result == "Error":
        require_fields(record, "error", "completed_at")
    if result == "OK" and approval not in {"Pending", "Blocked", "Denied"}:
        parse_json_field(record, "result_json", required=True)


def _validate_price_rule(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "unit_cost", "unit_price", "minimum_quantity")
    start = _get(record, "effective_from")
    end = _get(record, "effective_to")
    if start and end and str(start) > str(end):
        raise PolicyViolation(
            "invalid_effective_window",
            "effective_from must be on or before effective_to",
        )
    if _get(record, "status") == "Approved":
        require_fields(
            record,
            "rule_name",
            "rule_type",
            "unit",
            "source_ref",
            "effective_from",
            "assumptions",
            "exclusions",
        )
        require_approval(record, note="approval_note")
        parse_json_field(
            record, "rule_json", required=True, container_types=(dict,), non_empty=True
        )
    previous = context.get("_previous")
    if previous is None:
        return
    previous_status = _get(previous, "status")
    status = _get(record, "status")
    if previous_status == "Retired" and status != "Retired":
        raise PolicyViolation(
            "invalid_state_transition",
            "a retired Price Book Rule cannot be reactivated",
            "status",
        )
    if previous_status == "Approved" and status not in {"Approved", "Retired"}:
        raise PolicyViolation(
            "invalid_state_transition",
            "an approved Price Book Rule can only remain Approved or be Retired",
            "status",
        )
    if previous_status in {"Approved", "Retired"}:
        enforce_immutable(
            record,
            previous,
            "rule_name",
            "rule_type",
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
            "approval_note",
        )


def _validate_visual_model(record: Any, _context: Mapping[str, Any]) -> None:
    require_between(record, "confidence", 0, 100)
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record,
        "roof_job",
        "roofing_property",
        "provider",
        "model_uri",
        "confidence",
        "source_evidence",
    )
    require_approval(record, note="approval_note")
    if bool(_get(record, "needs_review")):
        raise PolicyViolation("unresolved_review", "visual model still needs review")
    parse_json_field(record, "measurements_json", required=True, non_empty=True)


def _validate_roof_area(record: Any, _context: Mapping[str, Any]) -> None:
    require_nonnegative(
        record,
        "area_sqft",
        "pitch",
        "facet_count",
        "penetration_count",
        "edge_length_ft",
    )
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record, "roof_job", "roofing_property", "area_name", "area_sqft", "source_ref"
    )
    if not any(
        not _blank(_get(record, field))
        for field in ("measurement_report", "visual_model")
    ):
        raise PolicyViolation(
            "missing_source_evidence",
            "approved Roof Area needs a measurement report or visual model",
        )
    if bool(_get(record, "needs_review")):
        raise PolicyViolation("unresolved_review", "roof area still needs review")
    require_approval(record, note="approval_note")


def _validate_option_package(record: Any, _context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "price_delta")
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record,
        "package_name",
        "tier",
        "material_system",
        "warranty_summary",
        "payment_assumptions",
        "assumptions",
        "exclusions",
    )
    require_approval(record, note="approval_note")
    parse_json_field(record, "options_json", required=True, non_empty=True)
    parse_json_field(
        record,
        "scope_clause_ids_json",
        required=True,
        container_types=(list,),
        non_empty=True,
    )


def _validate_scope_clause(record: Any, context: Mapping[str, Any]) -> None:
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record, "clause_type", "title", "clause_text", "version", "source_ref"
    )
    require_approval(record, note="approval_note")
    if _get(record, "customer_visible") in (True, 1, "1"):
        require_fields(record, "roof_job", "customer_quote")
        quote = context.get("scope_clause_quote")
        if not isinstance(quote, Mapping):
            raise PolicyViolation(
                "scope_clause_quote_missing",
                "customer-visible scope clause needs an existing Customer Quote",
                "customer_quote",
            )
        if quote.get("roof_job") != _get(record, "roof_job"):
            raise PolicyViolation(
                "scope_clause_quote_mismatch",
                "customer-visible scope clause must belong to the same Roof Job as its Customer Quote",
                "customer_quote",
            )


def _validate_incident(record: Any, _context: Mapping[str, Any]) -> None:
    status = _get(record, "status")
    require_nonnegative(record, "retry_count")
    if status in {"Open", "Acknowledged", "Resolved", "Closed"}:
        require_fields(
            record, "severity", "source_system", "category", "summary", "detected_at"
        )
    if status == "Acknowledged":
        require_fields(record, "assigned_to", "acknowledged_at")
    if status in {"Resolved", "Closed"}:
        require_fields(record, "resolution_notes", "resolved_by", "resolved_at")


def _validate_reception_session(record: Any, _context: Mapping[str, Any]) -> None:
    require_fields(
        record,
        "provider",
        "channel",
        "direction",
        "session_status",
        "urgency",
        "raw_key",
        "payload_hash",
        "structured_json",
        "provider_updated_at",
    )
    require_sha256(record, "payload_hash")
    require_between(record, "duration_seconds", 0, 86400)
    raw_key = str(_get(record, "raw_key") or "")
    if not raw_key.startswith("raw/newo/"):
        raise PolicyViolation(
            "invalid_newo_raw_key", "must point to the raw/newo/ R2 namespace", "raw_key"
        )
    if _get(record, "recording_pointer") and not bool(
        _get(record, "recording_disclosed")
    ):
        raise PolicyViolation(
            "recording_without_disclosure",
            "a recording pointer requires recorded disclosure",
            "recording_pointer",
        )
    if _get(record, "session_status") in {
        "active",
        "handoff_requested",
        "ended",
        "appointment_requested",
        "appointment_cancelled",
    } and not bool(_get(record, "ai_disclosed")):
        raise PolicyViolation(
            "ai_disclosure_required",
            "answered receptionist sessions require AI disclosure",
            "ai_disclosed",
        )
    event = parse_json_field(
        record,
        "structured_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    expected_keys = {
        "schema_version",
        "event_id",
        "session_id",
        "event_type",
        "occurred_at",
        "provider",
        "channel",
        "direction",
        "contact",
        "intent",
        "consent",
        "appointment",
        "outcome",
        "handoff_summary",
    }
    if set(event) != expected_keys:
        raise PolicyViolation(
            "invalid_reception_contract",
            "structured event keys do not match the versioned receptionist contract",
            "structured_json",
        )
    if event.get("session_id") != _get(record, "session_id"):
        raise PolicyViolation(
            "reception_session_mismatch",
            "structured session_id must match the owned record",
            "structured_json",
        )
    outcome = event.get("outcome")
    if not isinstance(outcome, dict) or "transcript" in outcome or "recording" in outcome:
        raise PolicyViolation(
            "provider_content_not_allowed",
            "transcript text and recording bodies cannot be copied into Frappe",
            "structured_json",
        )


def _validate_appointment_request(record: Any, context: Mapping[str, Any]) -> None:
    require_fields(
        record,
        "reception_session",
        "request_status",
        "booking_mode",
        "provider",
        "preferred_windows_json",
        "timezone",
        "requested_at",
        "raw_key",
        "payload_hash",
    )
    require_sha256(record, "payload_hash")
    windows = parse_json_field(
        record,
        "preferred_windows_json",
        required=True,
        container_types=(list,),
        non_empty=True,
    )
    if len(windows) > 10 or any(
        not isinstance(window, dict)
        or set(window) != {"start", "end"}
        or _blank(window.get("start"))
        for window in windows
    ):
        raise PolicyViolation(
            "invalid_preferred_windows",
            "requires 1 to 10 exact start/end window objects",
            "preferred_windows_json",
        )
    status = _get(record, "request_status")
    if status == "Confirmed":
        if _get(record, "booking_mode") != "Confirmed":
            raise PolicyViolation(
                "request_only_confirmation",
                "request-only appointments cannot be marked confirmed",
                "request_status",
            )
        require_fields(
            record,
            "confirmed_external_id",
            "confirmed_start",
            "confirmed_end",
            "decision_by",
            "decision_at",
            "decision_notes",
        )
    if status in {"Approved", "Declined", "Confirmed", "Failed"}:
        require_fields(record, "decision_by", "decision_at", "decision_notes")
    if status == "Cancelled":
        require_fields(record, "cancelled_at")
    _enforce_state_transition(
        record,
        context,
        "request_status",
        {
            "Pending": {"Under Review", "Approved", "Declined", "Cancelled", "Failed"},
            "Under Review": {"Approved", "Declined", "Cancelled", "Failed"},
            "Approved": {"Confirmed", "Cancelled", "Failed"},
            "Confirmed": {"Cancelled"},
            "Declined": set(),
            "Cancelled": set(),
            "Failed": {"Under Review", "Cancelled"},
        },
    )


def _validate_tenant(record: Any, context: Mapping[str, Any]) -> None:
    if _get(record, "isolation_model") != "Site per Tenant":
        raise PolicyViolation(
            "tenant_isolation", "only Site per Tenant isolation is supported"
        )
    if _get(record, "status") != "Active":
        return
    require_fields(
        record,
        "site_hostname",
        "legal_name",
        "primary_brand",
        "owner_user",
        "data_residency",
        "activated_at",
    )
    require_approval(record, note="approval_note")
    parse_json_field(
        record,
        "brand_config_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    parse_json_field(
        record,
        "namespace_config_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    parse_json_field(
        record,
        "policy_config_json",
        required=True,
        container_types=(dict,),
        non_empty=True,
    )
    if int(context.get("other_active_tenants", 0) or 0) > 0:
        raise PolicyViolation(
            "tenant_isolation",
            "a Frappe site may contain only one Active White-Label Tenant",
        )


VALIDATORS = {
    "appointment_request": _validate_appointment_request,
    "change_order": _validate_change_order,
    "communication_consent": _validate_consent,
    "communication_event": _validate_communication,
    "completion_packet": _validate_completion,
    "contract_acceptance": _validate_contract_acceptance,
    "controlled_item": _validate_controlled_item,
    "crew_profile": _validate_crew_profile,
    "customer_decision": _validate_customer_decision,
    "customer_quote": _validate_customer_quote,
    "evidence_item": _validate_evidence,
    "field_check_in": _validate_field_checkin,
    "hermes_run": _validate_hermes_run,
    "instant_estimate_session": _validate_instant_estimate,
    "integration_reconciliation": _validate_reconciliation,
    "insurance_supplement": _validate_insurance_supplement,
    "job_assignment": _validate_job_assignment,
    "job_compliance_record": _validate_compliance,
    "lead_envelope": _validate_lead_envelope,
    "material_lot": _validate_material_lot,
    "material_takeoff": _validate_takeoff,
    "measurement_report": _validate_measurement,
    "nonconformance": _validate_nonconformance,
    "option_package": _validate_option_package,
    "payment_milestone": _validate_payment_milestone,
    "price_book_rule": _validate_price_rule,
    "production_gate_state": _validate_gate,
    "proposal_evidence_pack": _validate_proposal,
    "reception_session": _validate_reception_session,
    "review_request": _validate_review_request,
    "roof_area": _validate_roof_area,
    "roof_job": _validate_roof_job,
    "safety_plan": _validate_safety_plan,
    "shop_order": _validate_shop_order,
    "scope_clause": _validate_scope_clause,
    "supplier_order": _validate_supplier_order,
    "supplier_quote": _validate_supplier_quote,
    "tenant_export_run": _validate_tenant_export,
    "visual_property_model": _validate_visual_model,
    "warranty_packet": _validate_warranty,
    "white_label_tenant": _validate_tenant,
    "work_package": _validate_work_package,
    "work_package_event": _validate_work_package_event,
    "automation_incident": _validate_incident,
}


def validate_record(
    kind: str,
    record: Any,
    *,
    previous: Any = None,
    context: Mapping[str, Any] | None = None,
) -> None:
    """Validate one business record and raise :class:`PolicyViolation` on failure."""

    if kind not in IDENTITY_FIELDS:
        raise PolicyViolation(
            "unknown_record_kind", f"no policy registered for {kind!r}"
        )
    require_fields(record, *IDENTITY_FIELDS[kind])
    enforce_immutable(record, previous, *IDENTITY_FIELDS[kind])
    enforce_write_once(record, previous, *WRITE_ONCE_FIELDS.get(kind, ()))
    enforce_truthy_once(record, previous, *TRUTHY_ONCE_FIELDS.get(kind, ()))
    for field in JSON_FIELDS.get(kind, ()):
        parse_json_field(record, field)
    policy_context = dict(context or {})
    policy_context["_previous"] = previous
    validator = VALIDATORS.get(kind)
    if validator:
        validator(record, policy_context)
