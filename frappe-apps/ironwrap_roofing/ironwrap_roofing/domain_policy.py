"""Fail-closed IronWrap OS business rules with no Frappe dependency.

The functions in this module operate on mappings (or mapping-like Frappe
documents) so the policy boundary can be tested without a bench.  Frappe
controllers call :func:`validate_record` through ``document_validation``.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence


MAX_JSON_BYTES = 1_000_000
PRODUCTION_GATES = ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")


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
        if not _blank(before) and before != after:
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
    "automation_incident": ("incident_id",),
    "change_order": ("change_order_id",),
    "communication_event": ("communication_event_id",),
    "communication_consent": ("consent_id",),
    "completion_packet": ("completion_packet_id",),
    "contract_acceptance": ("acceptance_id",),
    "crew_profile": ("crew_profile_id",),
    "customer_decision": ("decision_id",),
    "customer_quote": ("customer_quote_id",),
    "evidence_item": ("evidence_id",),
    "field_check_in": ("checkin_id",),
    "hermes_run": ("run_id",),
    "instant_estimate_session": ("estimate_session_id",),
    "integration_reconciliation": ("reconciliation_id",),
    "job_assignment": ("assignment_id",),
    "job_compliance_record": ("compliance_record_id",),
    "lead_envelope": ("envelope_id",),
    "market_watch_item": ("watch_id",),
    "material_takeoff": ("takeoff_id",),
    "measurement_report": ("measurement_id",),
    "option_package": ("option_package_id",),
    "payment_milestone": ("payment_milestone_id",),
    "price_book_rule": ("price_rule_id",),
    "production_gate_state": ("gate_id",),
    "proposal_evidence_pack": ("pack_id",),
    "review_request": ("review_request_id",),
    "roof_area": ("roof_area_id",),
    "roof_job": ("roof_job_id",),
    "roofing_customer": ("customer_id",),
    "roofing_property": ("property_key",),
    "safety_plan": ("safety_plan_id",),
    "scope_clause": ("scope_clause_id",),
    "supplier_order": ("supplier_order_id",),
    "supplier_profile": ("supplier_id",),
    "supplier_quote": ("supplier_quote_id",),
    "tenant_export_run": ("export_run_id",),
    "visual_property_model": ("visual_model_id",),
    "warranty_packet": ("warranty_packet_id",),
    "white_label_tenant": ("tenant_id",),
}

WRITE_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
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
    "customer_quote": ("roof_job", "customer", "quote_version", "supersedes"),
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
        "source_payload_hash",
        "local_payload_hash",
        "supersedes",
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
        "supersedes",
    ),
    "roof_job": (
        "workflow_profile",
        "locale_policy_version",
        "locale_policy_snapshot_json",
        "jobnimbus_contact_id",
        "jobnimbus_job_id",
        "qb_invoice_ref",
    ),
    "safety_plan": ("roof_job", "version", "prepared_by", "prepared_at", "supersedes"),
    "tenant_export_run": ("tenant", "requested_by", "requested_at", "scope_json", "supersedes"),
    "visual_property_model": ("provider", "provider_model_id", "model_uri", "raw_key"),
    "white_label_tenant": ("site_hostname",),
}

TRUTHY_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "hermes_run": ("mutation_applied",),
}

JSON_FIELDS: dict[str, tuple[str, ...]] = {
    "change_order": ("tax_policy_snapshot_json",),
    "communication_event": ("policy_reasons_json",),
    "completion_packet": ("photo_evidence_json", "evidence_summary_json"),
    "customer_quote": ("quote_summary_json", "tax_policy_snapshot_json"),
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
    "material_takeoff": ("source_measurements_json",),
    "option_package": ("options_json", "scope_clause_ids_json"),
    "payment_milestone": ("tax_policy_snapshot_json",),
    "price_book_rule": ("rule_json",),
    "proposal_evidence_pack": ("evidence_summary_json",),
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


def _validate_job_assignment(record: Any, context: Mapping[str, Any]) -> None:
    has_crew = not _blank(_get(record, "crew_profile"))
    has_user = not _blank(_get(record, "assigned_user"))
    if has_crew == has_user:
        raise PolicyViolation("assignment_target", "assign exactly one crew or user")
    start = _get(record, "scheduled_start")
    end = _get(record, "scheduled_end")
    if start and end and str(start) > str(end):
        raise PolicyViolation("invalid_assignment_window", "scheduled start must precede end")
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
    require_sha256(record, "terms_hash", "document_checksum")
    _validate_correction(record, context)


def _validate_reconciliation(record: Any, context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "attempt_count")
    status = _get(record, "status")
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


def _validate_measurement(record: Any, _context: Mapping[str, Any]) -> None:
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
    gated = {"Approved", "Ordered", "Partially Received", "Received", "Shortage"}
    if status not in gated:
        return
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
    rows = _require_clean_rows(record, "items", quantity_field="quantity")
    for row in rows:
        require_nonnegative(row, "received_qty", "shortage_qty")
    if status in {"Received", "Shortage"}:
        require_fields(record, "received_at")
        parse_json_field(record, "receipt_evidence_json", required=True, non_empty=True)


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
    if status not in {"Approved", "Accepted"}:
        _validate_correction(record, context, version_field="quote_version")
        return
    require_fields(
        record,
        "roof_job",
        "customer",
        "quote_version",
        "price_book_version",
        "pricing_effective_at",
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
        "subtotal",
        "tax_amount",
        "tax_code",
        "tax_rate",
        "tax_policy_snapshot_json",
        "quote_total",
        "currency",
        "scope_summary",
        "assumptions",
        "exclusions",
        "quote_summary_json",
    )
    if status == "Accepted":
        require_fields(
            record, "acceptance_evidence", "contract_acceptance", "accepted_at"
        )
    _validate_correction(record, context, version_field="quote_version")


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
            "Webhook Seen": {"Needs Review", "Matched", "Ignored"},
            "Needs Review": {"Matched", "Ignored"},
            "Matched": set(),
            "Ignored": set(),
        },
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
    status = _get(record, "status")
    if status not in {"Approved", "Sent", "Signed"}:
        return
    require_fields(record, "roof_job", "quotation", "assumptions", "exclusions")
    require_approval(record)
    if _context_status(context, "quote_status") not in {"Approved", "Accepted"}:
        raise PolicyViolation(
            "unapproved_quote", "linked Customer Quote must be Approved or Accepted"
        )
    parse_json_field(record, "evidence_summary_json", required=True, non_empty=True)
    if status == "Signed":
        require_fields(record, "signed_evidence", "signed_at")
        evidence_type = _context_status(context, "signed_evidence_type")
        if evidence_type and evidence_type != "Signed Document":
            raise PolicyViolation(
                "invalid_signed_evidence", "signed_evidence must be a Signed Document"
            )


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


def _validate_gate(record: Any, _context: Mapping[str, Any]) -> None:
    state = _get(record, "state")
    require_fields(record, "owner_user", "assigned_at")
    if state == "Blocked":
        require_fields(record, "blocker_reason", "due_at")
    elif state == "Waived":
        require_fields(record, "waived_by", "waived_at", "waiver_reason")
    elif state in {"Ready", "Done"}:
        require_fields(record, "evidence_item")
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
    gates = _gate_map(context.get("gates", []))
    allowed = (
        {"Ready", "Done", "Waived"} if status == "In Production" else {"Done", "Waived"}
    )
    for gate_name in PRODUCTION_GATES:
        gate = gates.get(gate_name)
        if gate is None or _get(gate, "state") not in allowed:
            raise PolicyViolation(
                "production_gate_block",
                f"{gate_name} gate must be one of {sorted(allowed)}",
            )
        _validate_gate(gate, {})
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
        _validate_gate(completion_gate, {})
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
            require_fields(record, "policy_checked_by", "policy_checked_at")
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


def _validate_price_rule(record: Any, _context: Mapping[str, Any]) -> None:
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


def _validate_scope_clause(record: Any, _context: Mapping[str, Any]) -> None:
    if _get(record, "status") != "Approved":
        return
    require_fields(
        record, "clause_type", "title", "clause_text", "version", "source_ref"
    )
    require_approval(record, note="approval_note")


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
    "change_order": _validate_change_order,
    "communication_consent": _validate_consent,
    "communication_event": _validate_communication,
    "completion_packet": _validate_completion,
    "contract_acceptance": _validate_contract_acceptance,
    "crew_profile": _validate_crew_profile,
    "customer_decision": _validate_customer_decision,
    "customer_quote": _validate_customer_quote,
    "evidence_item": _validate_evidence,
    "field_check_in": _validate_field_checkin,
    "hermes_run": _validate_hermes_run,
    "instant_estimate_session": _validate_instant_estimate,
    "integration_reconciliation": _validate_reconciliation,
    "job_assignment": _validate_job_assignment,
    "job_compliance_record": _validate_compliance,
    "material_takeoff": _validate_takeoff,
    "measurement_report": _validate_measurement,
    "option_package": _validate_option_package,
    "payment_milestone": _validate_payment_milestone,
    "price_book_rule": _validate_price_rule,
    "production_gate_state": _validate_gate,
    "proposal_evidence_pack": _validate_proposal,
    "review_request": _validate_review_request,
    "roof_area": _validate_roof_area,
    "roof_job": _validate_roof_job,
    "safety_plan": _validate_safety_plan,
    "scope_clause": _validate_scope_clause,
    "supplier_order": _validate_supplier_order,
    "supplier_quote": _validate_supplier_quote,
    "tenant_export_run": _validate_tenant_export,
    "visual_property_model": _validate_visual_model,
    "warranty_packet": _validate_warranty,
    "white_label_tenant": _validate_tenant,
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
