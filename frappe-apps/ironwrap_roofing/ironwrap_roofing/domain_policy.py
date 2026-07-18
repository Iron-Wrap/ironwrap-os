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
ACTIVE_SUPPLIER_ORDER_EXCEPTION_STATUSES = frozenset(("Needs Review", "Shortage"))


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
    "appointment_request": ("appointment_request_id",),
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
    "insurance_supplement": ("insurance_supplement_id",),
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
    "reception_session": ("session_id",),
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
    "safety_plan": ("roof_job", "version", "prepared_by", "prepared_at", "supersedes"),
    "tenant_export_run": ("tenant", "requested_by", "requested_at", "scope_json", "supersedes"),
    "visual_property_model": ("provider", "provider_model_id", "model_uri", "raw_key"),
    "white_label_tenant": ("site_hostname",),
}

TRUTHY_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "hermes_run": ("mutation_applied",),
}

JSON_FIELDS: dict[str, tuple[str, ...]] = {
    "appointment_request": ("preferred_windows_json",),
    "change_order": ("tax_policy_snapshot_json",),
    "communication_event": ("policy_reasons_json",),
    "completion_packet": ("photo_evidence_json", "evidence_summary_json"),
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
    "material_takeoff": _validate_takeoff,
    "measurement_report": _validate_measurement,
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
