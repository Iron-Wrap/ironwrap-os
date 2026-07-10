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
    "communication_event": ("communication_event_id",),
    "completion_packet": ("completion_packet_id",),
    "customer_quote": ("customer_quote_id",),
    "evidence_item": ("evidence_id",),
    "field_check_in": ("checkin_id",),
    "hermes_run": ("run_id",),
    "instant_estimate_session": ("estimate_session_id",),
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
    "scope_clause": ("scope_clause_id",),
    "supplier_order": ("supplier_order_id",),
    "supplier_profile": ("supplier_id",),
    "supplier_quote": ("supplier_quote_id",),
    "visual_property_model": ("visual_model_id",),
    "warranty_packet": ("warranty_packet_id",),
    "white_label_tenant": ("tenant_id",),
}

WRITE_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "communication_event": ("provider_message_id",),
    "evidence_item": ("source_system", "source_uri", "r2_key", "drive_file_id"),
    "field_check_in": ("source_system", "raw_key"),
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
    "payment_milestone": ("qb_entity_type", "qb_entity_id", "realm_id", "raw_key"),
    "roof_job": ("jobnimbus_contact_id", "jobnimbus_job_id", "qb_invoice_ref"),
    "visual_property_model": ("provider", "provider_model_id", "model_uri", "raw_key"),
    "white_label_tenant": ("site_hostname",),
}

TRUTHY_ONCE_FIELDS: dict[str, tuple[str, ...]] = {
    "hermes_run": ("mutation_applied",),
}

JSON_FIELDS: dict[str, tuple[str, ...]] = {
    "communication_event": ("policy_reasons_json",),
    "completion_packet": ("photo_evidence_json", "evidence_summary_json"),
    "customer_quote": ("quote_summary_json",),
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
    "material_takeoff": ("source_measurements_json",),
    "option_package": ("options_json", "scope_clause_ids_json"),
    "price_book_rule": ("rule_json",),
    "proposal_evidence_pack": ("evidence_summary_json",),
    "review_request": ("stop_conditions_json",),
    "supplier_order": ("order_summary_json", "receipt_evidence_json"),
    "supplier_quote": ("quote_summary_json",),
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


def _validate_customer_quote(record: Any, _context: Mapping[str, Any]) -> None:
    require_nonnegative(record, "quote_total")
    status = _get(record, "status")
    if status not in {"Approved", "Accepted"}:
        return
    require_fields(
        record, "roof_job", "customer", "scope_summary", "assumptions", "exclusions"
    )
    require_approval(record)
    parse_json_field(record, "quote_summary_json", required=True, non_empty=True)
    if status == "Accepted":
        require_fields(record, "acceptance_evidence", "accepted_at")


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
    if state == "Blocked":
        require_fields(record, "blocker_reason")
    elif state == "Waived":
        require_fields(record, "waived_by", "waived_at", "waiver_reason")
    elif state in {"Ready", "Done"}:
        require_fields(record, "evidence_item")
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
    "communication_event": _validate_communication,
    "completion_packet": _validate_completion,
    "customer_quote": _validate_customer_quote,
    "hermes_run": _validate_hermes_run,
    "instant_estimate_session": _validate_instant_estimate,
    "material_takeoff": _validate_takeoff,
    "measurement_report": _validate_measurement,
    "option_package": _validate_option_package,
    "price_book_rule": _validate_price_rule,
    "production_gate_state": _validate_gate,
    "proposal_evidence_pack": _validate_proposal,
    "review_request": _validate_review_request,
    "roof_area": _validate_roof_area,
    "roof_job": _validate_roof_job,
    "scope_clause": _validate_scope_clause,
    "supplier_order": _validate_supplier_order,
    "supplier_quote": _validate_supplier_quote,
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
    validator = VALIDATORS.get(kind)
    if validator:
        validator(record, context or {})
