"""Approval-bound commands for the governed shop-fabrication flow.

The public methods in this module take only a record identifier and a Hermes
Run identifier.  Everything that changes a protected record is derived from
the locked, signed run.  Generic Desk and REST writes remain unable to create
these lifecycle states because each controller requires its matching private
validation context.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Mapping
from contextlib import ExitStack
from decimal import Decimal, InvalidOperation
from typing import Any

import frappe

from ironwrap_roofing.approval_receipt import (
    ApprovalReceiptError,
    assert_approved_hermes_run_receipt,
)
from ironwrap_roofing.document_validation import (
    controlled_item_transition_context,
    material_lot_transition_context,
    nonconformance_transition_context,
    shop_order_transition_context,
    validate_business_document,
)
from ironwrap_roofing.work_package_api import (
    _assert_actor_is_assigned,
    _assert_package_current_and_unexpired,
    _lock_assignment,
)


MAX_IDENTIFIER_LENGTH = 140
MAX_REQUEST_TEXT_LENGTH = 4_000
SHA256_HEX_LENGTH = 64
CANONICAL_DECIMAL_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")
FIRST_PIECE_DIMENSION_RE = re.compile(
    r"^(?P<nominal>[0-9]+(?:\.[0-9]+)?) (?P<unit>[A-Za-z][A-Za-z0-9/_-]{0,31})$"
)
FIRST_PIECE_TOLERANCE_RE = re.compile(
    r"^(?:±|\+/-) (?P<tolerance>[0-9]+(?:\.[0-9]+)?) (?P<unit>[A-Za-z][A-Za-z0-9/_-]{0,31})$"
)
FIRST_PIECE_EVIDENCE_TYPES = frozenset({"Photo", "Measurement Report"})

APPROVE_CONTROLLED_ITEM_TOOL = "request_approve_controlled_item"
RECEIVE_MATERIAL_LOT_TOOL = "request_receive_material_lot"
RELEASE_SHOP_ORDER_TOOL = "request_release_shop_order"
RESERVE_SHOP_ORDER_TOOL = "request_reserve_shop_order_materials"
ADVANCE_SHOP_ORDER_SETUP_TOOL = "request_advance_shop_order_setup"
RECORD_FIRST_PIECE_OUTCOME_TOOL = "request_record_first_piece_outcome"

OWNER_ROLES = frozenset({"System Manager", "IronWrap Owner"})
SHOP_ROLES = OWNER_ROLES | {"IronWrap Production"}
COMMON_APPROVAL_ARGUMENTS = frozenset(
    {"request_text", "approved_by", "run_id", "expected_snapshot_sha256"}
)
SHOP_TOOL_AGENT_ROLES = {
    APPROVE_CONTROLLED_ITEM_TOOL: frozenset({"Owner Operator"}),
    RECEIVE_MATERIAL_LOT_TOOL: frozenset({"Owner Operator", "Production Controller"}),
    RELEASE_SHOP_ORDER_TOOL: frozenset({"Owner Operator", "Production Controller"}),
    RESERVE_SHOP_ORDER_TOOL: frozenset({"Owner Operator", "Production Controller"}),
    ADVANCE_SHOP_ORDER_SETUP_TOOL: frozenset({"Owner Operator", "Production Controller"}),
    RECORD_FIRST_PIECE_OUTCOME_TOOL: frozenset(
        {"Owner Operator", "Production Controller"}
    ),
}


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str):
        _fail("shop_command_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= MAX_IDENTIFIER_LENGTH):
        _fail(
            "shop_command_invalid_input",
            f"{field} must be 1-{MAX_IDENTIFIER_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("shop_command_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_request_text(value: Any, *, field: str = "request_text") -> str:
    if not isinstance(value, str):
        _fail("shop_command_invalid_approval_args", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > MAX_REQUEST_TEXT_LENGTH:
        _fail(
            "shop_command_invalid_approval_args",
            f"{field} must be 1-{MAX_REQUEST_TEXT_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("shop_command_invalid_approval_args", f"{field} contains control characters")
    return cleaned


def _clean_snapshot_hash(value: Any) -> str:
    cleaned = _clean_identifier(value, "expected_snapshot_sha256").lower()
    if len(cleaned) != SHA256_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in cleaned
    ):
        _fail(
            "shop_command_invalid_approval_args",
            "expected_snapshot_sha256 must be a SHA-256 hex digest",
        )
    return cleaned


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(
                "shop_command_invalid_approval_args",
                "JSON payload contains a duplicate key",
            )
        result[key] = value
    return result


def _parse_json(value: Any, *, field: str) -> Any:
    if not isinstance(value, str) or not value:
        _fail("shop_command_invalid_approval_args", f"{field} must be non-empty JSON")
    try:
        return json.loads(value, object_pairs_hook=_no_duplicate_object)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _fail("shop_command_invalid_approval_args", f"{field} is invalid: {exc}")
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover


def _parse_approved_arguments(
    raw: Any,
    *,
    target_field: str,
    extra_fields: frozenset[str] = frozenset(),
) -> dict[str, str]:
    parsed = _parse_json(raw, field="tool_args_json")
    expected_fields = COMMON_APPROVAL_ARGUMENTS | {target_field} | extra_fields
    if not isinstance(parsed, Mapping) or set(parsed) != expected_fields:
        _fail(
            "shop_command_invalid_approval_args",
            "tool_args_json does not match this bounded shop command",
        )
    result = {
        target_field: _clean_identifier(parsed.get(target_field), target_field),
        "request_text": _clean_request_text(parsed.get("request_text")),
        "approved_by": _clean_identifier(parsed.get("approved_by"), "approved_by"),
        "run_id": _clean_identifier(parsed.get("run_id"), "run_id"),
        "expected_snapshot_sha256": _clean_snapshot_hash(
            parsed.get("expected_snapshot_sha256")
        ),
    }
    for field in extra_fields:
        if field in {
            "allocations_json",
            "setup_payload_json",
            "first_piece_payload_json",
        }:
            value = parsed.get(field)
            if not isinstance(value, str) or not value:
                _fail(
                    "shop_command_invalid_approval_args",
                    f"{field} must be non-empty JSON text",
                )
            # Parse now so malformed or duplicate-key payloads fail before any
            # protected row is locked or changed. Preserve the exact signed text
            # for receipt verification below.
            _parse_json(value, field=field)
            result[field] = value
        else:  # pragma: no cover - the command map currently has one payload kind
            _fail("shop_command_invalid_approval_args", f"unsupported field {field}")
    return result


def _assert_post_and_permissions(
    *, doctype: str, allowed_roles: frozenset[str]
) -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail("shop_command_post_required", "this mutation accepts POST only", permission=True)
    authenticated_user = _clean_identifier(
        getattr(frappe.session, "user", None), "session_user"
    )
    if authenticated_user == "Guest":
        _fail(
            "shop_command_authenticated_user_required",
            "an authenticated Frappe principal is required",
            permission=True,
        )
    roles = {str(role) for role in frappe.get_roles(authenticated_user)}
    if not roles & allowed_roles:
        _fail(
            "shop_command_role_denied",
            "the authenticated principal does not hold the required shop role",
            permission=True,
        )
    if not frappe.has_permission(doctype, ptype="write", user=authenticated_user):
        _fail(
            "shop_command_permission_denied",
            f"the authenticated principal cannot write {doctype}",
            permission=True,
        )
    return authenticated_user


def _locked_one(query: str, values: tuple[Any, ...], code: str) -> dict[str, Any]:
    rows = frappe.db.sql(query, values, as_dict=True)
    if len(rows) != 1:
        _fail(code, "the requested record does not exist")
    return dict(rows[0])


def _lock_hermes_run(hermes_run_id: str) -> dict[str, Any]:
    return _locked_one(
        """
        SELECT name, run_id, agent_role, requested_by, target_doctype, target_name, roof_job,
               capability_level, tool_name, tool_args_json, dry_run_receipt,
               approval_receipt, policy_check_json, approval_status, approved_by,
               approved_at, mutation_applied
        FROM `tabHermes Run`
        WHERE name = %s
        FOR UPDATE
        """,
        (hermes_run_id,),
        "shop_command_hermes_run_not_found",
    )


def _lock_row(
    doctype: str,
    record_id: str,
    *,
    fields: str,
    not_found_code: str,
) -> dict[str, Any]:
    return _locked_one(
        f"""
        SELECT {fields}
        FROM `tab{doctype}`
        WHERE name = %s
        FOR UPDATE
        """,
        (record_id,),
        not_found_code,
    )


def _lock_document(
    doctype: str,
    record_id: str,
    *,
    fields: str,
    not_found_code: str,
) -> Any:
    _lock_row(doctype, record_id, fields=fields, not_found_code=not_found_code)
    return frappe.get_doc(doctype, record_id)


def _parse_allowed_policy(
    raw: Any,
    *,
    target_doctype: str,
    target_name: str,
) -> None:
    policy = _parse_json(raw, field="policy_check_json")
    target = policy.get("target") if isinstance(policy, Mapping) else None
    if (
        not isinstance(policy, Mapping)
        or policy.get("allowed") is not True
        or target != {"doctype": target_doctype, "name": target_name}
    ):
        _fail(
            "shop_command_policy_check_invalid",
            "policy_check_json must allow this exact command target",
        )


def _assert_approved_run(
    run: Mapping[str, Any],
    *,
    hermes_run_id: str,
    authenticated_user: str,
    tool_name: str,
    target_doctype: str,
    target_name: str,
    target_field: str,
    extra_fields: frozenset[str] = frozenset(),
) -> dict[str, str]:
    if run.get("name") != hermes_run_id or run.get("run_id") != hermes_run_id:
        _fail("shop_command_hermes_run_identity_mismatch", "locked run identity differs")
    if run.get("capability_level") != "Approved-write":
        _fail("shop_command_approval_required", "Hermes Run must be Approved-write")
    if run.get("requested_by") != authenticated_user:
        _fail(
            "shop_command_requester_mismatch",
            "the authenticated principal is not the Hermes Run requester",
            permission=True,
        )
    if run.get("approval_status") != "Approved" or not run.get("approved_at"):
        _fail("shop_command_approval_required", "Hermes Run must be Approved")
    if run.get("tool_name") != tool_name:
        _fail("shop_command_tool_mismatch", "Hermes Run does not authorize this command")
    allowed_agent_roles = SHOP_TOOL_AGENT_ROLES.get(tool_name)
    if not allowed_agent_roles or run.get("agent_role") not in allowed_agent_roles:
        _fail(
            "shop_command_agent_role_denied",
            "the Hermes Run agent role cannot execute this shop command",
            permission=True,
        )
    if (
        run.get("target_doctype") != target_doctype
        or run.get("target_name") != target_name
    ):
        _fail("shop_command_target_mismatch", "Hermes Run target does not match command")
    if run.get("mutation_applied") in {1, "1", True}:
        _fail("shop_command_run_already_consumed", "Hermes Run already applied a mutation")
    approved_by = _clean_identifier(run.get("approved_by"), "approved_by")
    args = _parse_approved_arguments(
        run.get("tool_args_json"),
        target_field=target_field,
        extra_fields=extra_fields,
    )
    if (
        args["run_id"] != hermes_run_id
        or args[target_field] != target_name
        or args["approved_by"] != approved_by
    ):
        _fail(
            "shop_command_approved_args_mismatch",
            "tool_args_json does not match the approved Hermes Run identity",
        )
    try:
        assert_approved_hermes_run_receipt(
            run,
            write_tool=tool_name,
            approved_args=args,
        )
    except ApprovalReceiptError as exc:
        _fail(
            f"shop_command_approval_receipt_{exc.code}",
            "Hermes Run lacks a current signed approval capability for this exact command",
        )
    _parse_allowed_policy(
        run.get("policy_check_json"),
        target_doctype=target_doctype,
        target_name=target_name,
    )
    return args


def _snapshot_hash(snapshot: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        snapshot,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _snapshot_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (Decimal, float)):
        try:
            normalized = Decimal(str(value))
        except (InvalidOperation, ValueError):
            return str(value)
        if normalized.is_finite():
            return _decimal_text(normalized)
    return str(value)


def _snapshot_values(document: Any, fields: tuple[str, ...]) -> dict[str, str]:
    return {field: _snapshot_text(document.get(field)) for field in fields}


def _assert_current_snapshot(expected: str, snapshot: Mapping[str, Any]) -> None:
    if _snapshot_hash(snapshot) != expected:
        _fail(
            "shop_command_stale_snapshot",
            "the signed preview no longer matches the locked records",
        )


def _assert_record_identity(document: Any, *, id_field: str, record_id: str, label: str) -> None:
    if document.get("name") != record_id or document.get(id_field) != record_id:
        _fail(
            "shop_command_record_identity_mismatch",
            f"{label} identity does not match the approved target",
        )


def _assert_run_roof_job(run: Mapping[str, Any], document: Any) -> None:
    if run.get("roof_job") != document.get("roof_job"):
        _fail(
            "shop_command_roof_job_mismatch",
            "Hermes Run roof job does not match the locked record",
        )


def _positive_decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool):
        _fail("shop_command_invalid_approval_args", f"{field} must be numeric")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        _fail("shop_command_invalid_approval_args", f"{field} must be numeric")
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    if not result.is_finite() or result <= 0:
        _fail("shop_command_invalid_approval_args", f"{field} must be greater than zero")
    return result


def _nonnegative_decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool):
        _fail("shop_command_invalid_approval_args", f"{field} must be numeric")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        _fail("shop_command_invalid_approval_args", f"{field} must be numeric")
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    if not result.is_finite() or result < 0:
        _fail("shop_command_invalid_approval_args", f"{field} must be nonnegative")
    return result


def _canonical_decimal(value: Any, field: str, *, allow_zero: bool) -> Decimal:
    if not isinstance(value, str) or not CANONICAL_DECIMAL_RE.fullmatch(value):
        _fail(
            "shop_command_invalid_approval_args",
            f"{field} must be canonical decimal text",
        )
    result = Decimal(value)
    if (allow_zero and result < 0) or (not allow_zero and result <= 0):
        comparison = "nonnegative" if allow_zero else "greater than zero"
        _fail("shop_command_invalid_approval_args", f"{field} must be {comparison}")
    return result


def _decimal_text(value: Decimal) -> str:
    rendered = format(value, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _parse_allocations(raw: str) -> list[dict[str, Any]]:
    parsed = _parse_json(raw, field="allocations_json")
    if not isinstance(parsed, list) or not parsed:
        _fail(
            "shop_command_invalid_approval_args",
            "allocations_json must contain at least one allocation",
        )
    expected_fields = {
        "allocation_id",
        "line_no",
        "material_lot",
        "reserved_quantity",
        "unit",
    }
    seen_allocations: set[str] = set()
    rows: list[dict[str, Any]] = []
    for index, raw_row in enumerate(parsed, start=1):
        if not isinstance(raw_row, Mapping) or set(raw_row) != expected_fields:
            _fail(
                "shop_command_invalid_approval_args",
                f"allocation {index} has an unsupported shape",
            )
        allocation_id = _clean_identifier(raw_row.get("allocation_id"), "allocation_id")
        if allocation_id in seen_allocations:
            _fail(
                "shop_command_invalid_approval_args",
                "allocation IDs must be unique",
            )
        seen_allocations.add(allocation_id)
        line_no = _positive_decimal(raw_row.get("line_no"), "line_no")
        if line_no != line_no.to_integral_value():
            _fail("shop_command_invalid_approval_args", "line_no must be an integer")
        rows.append(
            {
                "allocation_id": allocation_id,
                "line_no": int(line_no),
                "material_lot": _clean_identifier(
                    raw_row.get("material_lot"), "material_lot"
                ),
                "reserved_quantity": _positive_decimal(
                    raw_row.get("reserved_quantity"), "reserved_quantity"
                ),
                "unit": _clean_identifier(raw_row.get("unit"), "unit"),
            }
        )
    return rows


def _parse_setup_route_rows(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        _fail(
            "shop_command_invalid_approval_args",
            "operations must contain at least one route row",
        )
    expected_fields = {"sequence", "operation", "machine_tooling", "operator"}
    rows: list[dict[str, Any]] = []
    for expected_sequence, raw_row in enumerate(raw, start=1):
        if not isinstance(raw_row, Mapping) or set(raw_row) != expected_fields:
            _fail(
                "shop_command_invalid_approval_args",
                f"operation {expected_sequence} has an unsupported shape",
            )
        sequence = _positive_decimal(raw_row.get("sequence"), "sequence")
        if sequence != expected_sequence:
            _fail(
                "shop_command_invalid_approval_args",
                "operation sequences must be contiguous and start at one",
            )
        rows.append(
            {
                "sequence": expected_sequence,
                "operation": _clean_identifier(raw_row.get("operation"), "operation"),
                "machine_tooling": _clean_request_text(
                    raw_row.get("machine_tooling"), field="machine_tooling"
                ),
                "operator": _clean_identifier(raw_row.get("operator"), "operator"),
                "status": "Ready",
            }
        )
    return rows


def _parse_setup_payload(order: Any, raw: str) -> tuple[str, list[dict[str, Any]] | None, str | None]:
    payload = _parse_json(raw, field="setup_payload_json")
    if not isinstance(payload, Mapping):
        _fail("shop_command_invalid_approval_args", "setup_payload_json must be an object")
    action = payload.get("action")
    status = order.get("status")
    has_operations = bool(order.get("operations") or [])
    if action == "begin_setup":
        if status != "Reserved":
            _fail("shop_command_order_not_setup_advanceable", "Shop Order must be Reserved")
        if has_operations:
            _fail(
                "shop_command_invalid_approval_args",
                "begin_setup cannot replace an existing shop route",
            )
        if set(payload) != {"action", "operations"}:
            _fail(
                "shop_command_invalid_approval_args",
                "begin_setup requires only action and operations",
            )
        return action, _parse_setup_route_rows(payload.get("operations")), None
    if action == "place_quality_hold":
        if status not in {"Reserved", "Setup / First Piece"}:
            _fail(
                "shop_command_order_not_setup_advanceable",
                "Shop Order must be Reserved or Setup / First Piece",
            )
        if set(payload) != {"action", "reason"}:
            _fail(
                "shop_command_invalid_approval_args",
                "place_quality_hold requires only action and reason",
            )
        return action, None, _clean_request_text(payload.get("reason"), field="reason")
    if action == "resume_setup":
        if status != "Quality Hold":
            _fail(
                "shop_command_order_not_setup_advanceable",
                "Shop Order must be on Quality Hold",
            )
        expected_fields = {"action"} if has_operations else {"action", "operations"}
        if set(payload) != expected_fields:
            _fail(
                "shop_command_invalid_approval_args",
                "resume_setup must preserve an existing route or provide a new one",
            )
        operations = (
            None if has_operations else _parse_setup_route_rows(payload.get("operations"))
        )
        return action, operations, None
    _fail("shop_command_invalid_approval_args", "unsupported setup action")
    raise AssertionError("frappe.throw must raise")  # pragma: no cover


def _parse_first_piece_inspection(raw: Any) -> dict[str, Any]:
    expected_fields = {
        "line_no",
        "allocation_id",
        "operation_sequence",
        "issued_quantity",
        "measured_value",
        "measurement_unit",
        "evidence_item",
    }
    if not isinstance(raw, Mapping) or set(raw) != expected_fields:
        _fail(
            "shop_command_invalid_approval_args",
            "first-piece inspection has an unsupported shape",
        )
    line_no = _positive_decimal(raw.get("line_no"), "line_no")
    operation_sequence = _positive_decimal(
        raw.get("operation_sequence"), "operation_sequence"
    )
    if line_no != line_no.to_integral_value():
        _fail("shop_command_invalid_approval_args", "line_no must be an integer")
    if operation_sequence != operation_sequence.to_integral_value():
        _fail(
            "shop_command_invalid_approval_args",
            "operation_sequence must be an integer",
        )
    return {
        "line_no": int(line_no),
        "allocation_id": _clean_identifier(raw.get("allocation_id"), "allocation_id"),
        "operation_sequence": int(operation_sequence),
        "issued_quantity": _canonical_decimal(
            raw.get("issued_quantity"), "issued_quantity", allow_zero=False
        ),
        "measured_value": _canonical_decimal(
            raw.get("measured_value"), "measured_value", allow_zero=True
        ),
        "measurement_unit": _clean_identifier(
            raw.get("measurement_unit"), "measurement_unit"
        ),
        "evidence_item": _clean_identifier(raw.get("evidence_item"), "evidence_item"),
    }


def _parse_first_piece_payload(
    order: Any, raw: str
) -> tuple[str, list[dict[str, Any]], str | None]:
    payload = _parse_json(raw, field="first_piece_payload_json")
    if not isinstance(payload, Mapping):
        _fail(
            "shop_command_invalid_approval_args",
            "first_piece_payload_json must be an object",
        )
    if order.get("status") != "Setup / First Piece":
        _fail(
            "shop_command_order_not_first_piece_ready",
            "Shop Order must be in Setup / First Piece",
        )
    action = payload.get("action")
    if action == "pass_to_fabrication":
        if set(payload) != {"action", "inspections"}:
            _fail(
                "shop_command_invalid_approval_args",
                "pass_to_fabrication requires only action and inspections",
            )
        raw_inspections = payload.get("inspections")
        if not isinstance(raw_inspections, list) or not raw_inspections:
            _fail(
                "shop_command_invalid_approval_args",
                "pass_to_fabrication requires at least one inspection",
            )
        inspections = [_parse_first_piece_inspection(row) for row in raw_inspections]
        if len({row["line_no"] for row in inspections}) != len(inspections):
            _fail(
                "shop_command_invalid_approval_args",
                "first-piece inspections must have unique lines",
            )
        if len({row["allocation_id"] for row in inspections}) != len(inspections):
            _fail(
                "shop_command_invalid_approval_args",
                "first-piece inspections must have unique allocations",
            )
        return action, inspections, None
    if action == "fail_to_quality_hold":
        if set(payload) != {"action", "inspection", "reason"}:
            _fail(
                "shop_command_invalid_approval_args",
                "fail_to_quality_hold requires only action, inspection, and reason",
            )
        return (
            action,
            [_parse_first_piece_inspection(payload.get("inspection"))],
            _clean_request_text(payload.get("reason"), field="reason"),
        )
    _fail("shop_command_invalid_approval_args", "unsupported first-piece action")
    raise AssertionError("frappe.throw must raise")  # pragma: no cover


def _lock_evidence(evidence_id: str, *, roof_job: str) -> dict[str, Any]:
    evidence = _lock_row(
        "Evidence Item",
        evidence_id,
        fields="name, evidence_id, roof_job, sync_state, modified",
        not_found_code="shop_command_evidence_not_found",
    )
    if evidence.get("roof_job") != roof_job or evidence.get("sync_state") != "Verified":
        _fail(
            "shop_command_evidence_unverified",
            "shop evidence must be verified and belong to the same Roof Job",
        )
    return evidence


def _lock_first_piece_evidence(
    evidence_id: str,
    *,
    roof_job: str,
    inspector: str,
) -> dict[str, Any]:
    evidence = _lock_row(
        "Evidence Item",
        evidence_id,
        fields=(
            "name, evidence_id, roof_job, evidence_type, proof_owner, proof_slot, "
            "source_system, r2_key, content_checksum, checksum_algorithm, content_type, "
            "content_length, capture_actor, captured_at, sync_state, verified_at, "
            "verification_source, device_action_id, modified"
        ),
        not_found_code="shop_command_evidence_not_found",
    )
    if evidence.get("roof_job") != roof_job:
        _fail(
            "shop_command_evidence_job_mismatch",
            "first-piece evidence must belong to the same Roof Job",
        )
    if evidence.get("proof_slot") != "Production" or evidence.get(
        "evidence_type"
    ) not in FIRST_PIECE_EVIDENCE_TYPES:
        _fail(
            "shop_command_first_piece_evidence_semantic_invalid",
            "first-piece evidence must be a Production Photo or Measurement Report",
        )
    if evidence.get("sync_state") != "Verified":
        _fail(
            "shop_command_first_piece_evidence_unverified",
            "first-piece evidence must be verified",
        )
    if (
        evidence.get("capture_actor") != inspector
        or evidence.get("proof_owner") != inspector
    ):
        _fail(
            "shop_command_first_piece_evidence_actor_mismatch",
            "first-piece evidence must be captured and owned by the independent inspector",
            permission=True,
        )
    if evidence.get("source_system") != "ironwrap-pwa" or not evidence.get(
        "device_action_id"
    ):
        _fail(
            "shop_command_first_piece_evidence_provenance_invalid",
            "first-piece evidence must originate from an identified IronWrap PWA action",
        )
    if not all(
        evidence.get(field)
        for field in (
            "r2_key",
            "captured_at",
            "verified_at",
            "verification_source",
            "content_type",
        )
    ):
        _fail(
            "shop_command_first_piece_evidence_provenance_invalid",
            "first-piece evidence is missing immutable capture or verification provenance",
        )
    if evidence.get("checksum_algorithm") != "SHA-256" or not re.fullmatch(
        r"[0-9a-f]{64}", str(evidence.get("content_checksum") or "")
    ):
        _fail(
            "shop_command_first_piece_evidence_provenance_invalid",
            "first-piece evidence must retain a SHA-256 checksum",
        )
    try:
        content_length = int(evidence.get("content_length"))
    except (TypeError, ValueError):
        content_length = 0
    if content_length <= 0:
        _fail(
            "shop_command_first_piece_evidence_provenance_invalid",
            "first-piece evidence content length must be positive",
        )
    return evidence


def _lock_controlled_item(controlled_item_id: str) -> Any:
    document = _lock_document(
        "Controlled Item",
        controlled_item_id,
        fields="name, controlled_item_id, status, modified",
        not_found_code="shop_command_controlled_item_not_found",
    )
    _assert_record_identity(
        document,
        id_field="controlled_item_id",
        record_id=controlled_item_id,
        label="Controlled Item",
    )
    return document


def _lock_material_lot(material_lot_id: str) -> Any:
    document = _lock_document(
        "Material Lot",
        material_lot_id,
        fields=(
            "name, material_lot_id, roof_job, controlled_item, source_kind, supplier_order, "
            "source_shop_order, source_evidence, status, available_quantity, reserved_quantity, "
            "consumed_quantity, received_quantity, unit, modified"
        ),
        not_found_code="shop_command_material_lot_not_found",
    )
    _assert_record_identity(
        document,
        id_field="material_lot_id",
        record_id=material_lot_id,
        label="Material Lot",
    )
    return document


def _lock_shop_order(shop_order_id: str) -> Any:
    document = _lock_document(
        "Shop Order",
        shop_order_id,
        fields=(
            "name, shop_order_id, roof_job, material_takeoff, supplier_order, work_package, "
            "status, setup_started_at, fabrication_started_at, quality_hold_reason, modified"
        ),
        not_found_code="shop_command_shop_order_not_found",
    )
    _assert_record_identity(
        document,
        id_field="shop_order_id",
        record_id=shop_order_id,
        label="Shop Order",
    )
    return document


def _lock_shop_sources(order: Any) -> dict[str, dict[str, Any]]:
    source_specs = (
        ("Material Takeoff", "material_takeoff", {"Approved"}),
        ("Supplier Order", "supplier_order", {"Partially Received", "Received"}),
        ("Work Package", "work_package", {"Released", "Acknowledged", "In Progress"}),
    )
    sources: dict[str, dict[str, Any]] = {}
    for doctype, field, allowed_statuses in source_specs:
        source_id = _clean_identifier(order.get(field), field)
        source = _lock_row(
            doctype,
            source_id,
            fields="name, roof_job, status, modified",
            not_found_code="shop_command_source_not_found",
        )
        if (
            source.get("roof_job") != order.get("roof_job")
            or source.get("status") not in allowed_statuses
        ):
            _fail(
                "shop_command_source_not_ready",
                "Shop Order source records must be current and on the same Roof Job",
            )
        sources[field] = source
    for row in order.get("lines") or []:
        controlled_item_id = _clean_identifier(
            row.get("controlled_item"), "controlled_item"
        )
        item = _lock_controlled_item(controlled_item_id)
        if item.get("status") != "Approved":
            _fail(
                "shop_command_item_not_approved",
                "Shop Order lines require Approved Controlled Items",
            )
    return sources


def _lock_first_piece_inspector_authority(
    order: Any,
    *,
    authenticated_user: str,
) -> dict[str, Any]:
    package = _lock_document(
        "Work Package",
        _clean_identifier(order.get("work_package"), "work_package"),
        fields=(
            "name, work_package_id, roof_job, job_assignment, safety_plan, version, status, "
            "expires_at, acknowledged_by, acknowledged_at, started_at, modified"
        ),
        not_found_code="shop_command_work_package_not_found",
    )
    if package.get("name") != order.get("work_package") or package.get(
        "roof_job"
    ) != order.get("roof_job"):
        _fail(
            "shop_command_work_package_mismatch",
            "Shop Order Work Package no longer matches the locked Roof Job",
        )
    # This is the shared current-authority proof: it locks and reevaluates the
    # package's crew, compliance, safety-plan, gate, expiry, and supersession
    # state rather than duplicating a drifting subset in the shop command.
    validate_business_document(package, "work_package")
    assignment = _lock_assignment(
        package,
        str(order.get("roof_job")),
        _clean_identifier(package.get("job_assignment"), "job_assignment"),
    )
    _assert_package_current_and_unexpired(package)
    assignment_role = _assert_actor_is_assigned(assignment, authenticated_user)
    assignment_snapshot = _lock_row(
        "Job Assignment",
        _clean_identifier(assignment.get("name"), "job_assignment"),
        fields=(
            "name, assignment_id, roof_job, assignment_type, status, crew_profile, "
            "assigned_user, scheduled_start, supersedes, modified"
        ),
        not_found_code="shop_command_job_assignment_not_found",
    )
    crew_profile = _lock_row(
        "Crew Profile",
        _clean_identifier(assignment.get("crew_profile"), "crew_profile"),
        fields=(
            "name, crew_profile_id, status, crew_type, competency_status, "
            "competency_checked_at, competency_expiry, equipment_status, "
            "equipment_checked_at, equipment_expiry, wcb_status, wcb_checked_at, "
            "wcb_expiry, active_stop, active_stop_at, active_stop_reason, modified"
        ),
        not_found_code="shop_command_crew_profile_not_found",
    )
    return {
        "work_package": package,
        "job_assignment": assignment_snapshot,
        "crew_profile": crew_profile,
        "authenticated_user": authenticated_user,
        "assignment_role": assignment_role,
    }


def _first_piece_measurement_spec(line: Mapping[str, Any]) -> dict[str, Decimal | str]:
    dimensions = line.get("dimensions")
    tolerance = line.get("tolerance")
    dimension_match = (
        FIRST_PIECE_DIMENSION_RE.fullmatch(dimensions)
        if isinstance(dimensions, str)
        else None
    )
    tolerance_match = (
        FIRST_PIECE_TOLERANCE_RE.fullmatch(tolerance)
        if isinstance(tolerance, str)
        else None
    )
    if not dimension_match or not tolerance_match:
        _fail(
            "shop_command_first_piece_measurement_spec_invalid",
            "first-piece lines require canonical dimension and tolerance text",
        )
    nominal = _canonical_decimal(
        dimension_match.group("nominal"), "dimensions", allow_zero=False
    )
    allowed_tolerance = _canonical_decimal(
        tolerance_match.group("tolerance"), "tolerance", allow_zero=False
    )
    dimension_unit = dimension_match.group("unit").lower()
    if dimension_unit != tolerance_match.group("unit").lower():
        _fail(
            "shop_command_first_piece_measurement_spec_invalid",
            "first-piece dimension and tolerance units must match",
        )
    return {
        "nominal_value": nominal,
        "tolerance_value": allowed_tolerance,
        "measurement_unit": dimension_unit,
    }


def _controlled_item_snapshot(document: Any) -> dict[str, Any]:
    return {
        "controlled_item": _snapshot_values(
            document,
            ("name", "controlled_item_id", "status", "modified"),
        )
    }


def _material_lot_snapshot(document: Any) -> dict[str, Any]:
    return {
        "material_lot": _snapshot_values(
            document,
            (
                "name",
                "material_lot_id",
                "roof_job",
                "controlled_item",
                "source_kind",
                "supplier_order",
                "source_shop_order",
                "source_evidence",
                "condition_status",
                "received_quantity",
                "unit",
                "status",
                "available_quantity",
                "reserved_quantity",
                "consumed_quantity",
                "modified",
            ),
        )
    }


def _shop_order_snapshot(order: Any, lots: list[Any] | None = None) -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "shop_order": _snapshot_values(
            order,
            (
                "name",
                "shop_order_id",
                "roof_job",
                "material_takeoff",
                "supplier_order",
                "work_package",
                "status",
                "modified",
            ),
        )
    }
    if lots is not None:
        snapshot["material_lots"] = [
            _snapshot_values(
                lot,
                (
                    "name",
                    "material_lot_id",
                    "roof_job",
                    "controlled_item",
                    "unit",
                    "status",
                    "available_quantity",
                    "reserved_quantity",
                    "consumed_quantity",
                    "modified",
                ),
            )
            for lot in lots
        ]
    return snapshot


def _shop_order_setup_snapshot(order: Any) -> dict[str, Any]:
    snapshot = _shop_order_snapshot(order)
    snapshot["shop_order"].update(
        _snapshot_values(
            order,
            ("setup_started_at", "fabrication_started_at", "quality_hold_reason"),
        )
    )
    snapshot["operations"] = [
        _snapshot_values(
            operation,
            (
                "sequence",
                "operation",
                "machine_tooling",
                "operator",
                "status",
                "started_at",
                "completed_at",
                "notes",
            ),
        )
        for operation in order.get("operations") or []
    ]
    return snapshot


def _shop_order_first_piece_snapshot(
    order: Any,
    lots: list[Any],
    evidence: list[Mapping[str, Any]],
    sources: Mapping[str, Mapping[str, Any]],
    inspector_authority: Mapping[str, Any],
) -> dict[str, Any]:
    snapshot = _shop_order_setup_snapshot(order)
    snapshot["lines"] = [
        _snapshot_values(
            line,
            (
                "line_no",
                "controlled_item",
                "requested_quantity",
                "accepted_quantity",
                "billable_quantity",
                "unit",
                "dimensions",
                "tolerance",
                "orientation",
                "invoice_basis",
                "needs_review",
            ),
        )
        for line in order.get("lines") or []
    ]
    snapshot["material_allocations"] = [
        _snapshot_values(
            allocation,
            (
                "allocation_id",
                "line_no",
                "material_lot",
                "reserved_quantity",
                "issued_quantity",
                "unit",
                "status",
                "needs_review",
            ),
        )
        for allocation in order.get("material_allocations") or []
    ]
    snapshot["inspections"] = [
        _snapshot_values(
            inspection,
            (
                "inspection_type",
                "line_no",
                "allocation_id",
                "operation_sequence",
                "result",
                "nominal_value",
                "measured_value",
                "tolerance_value",
                "measurement_unit",
                "measured_result",
                "inspected_by",
                "inspected_at",
                "evidence_item",
                "needs_review",
            ),
        )
        for inspection in order.get("inspections") or []
    ]
    snapshot["material_lots"] = [
        _snapshot_values(
            lot,
            (
                "name",
                "material_lot_id",
                "roof_job",
                "controlled_item",
                "unit",
                "status",
                "available_quantity",
                "reserved_quantity",
                "consumed_quantity",
                "modified",
            ),
        )
        for lot in lots
    ]
    snapshot["evidence"] = [
        _snapshot_values(
            item,
            (
                "name",
                "evidence_id",
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
                "device_action_id",
                "modified",
            ),
        )
        for item in evidence
    ]
    snapshot["source_records"] = {
        "material_takeoff": _snapshot_values(
            sources["material_takeoff"], ("name", "roof_job", "status", "modified")
        ),
        "supplier_order": _snapshot_values(
            sources["supplier_order"], ("name", "roof_job", "status", "modified")
        ),
        "work_package": _snapshot_values(
            inspector_authority["work_package"],
            (
                "name",
                "work_package_id",
                "roof_job",
                "job_assignment",
                "safety_plan",
                "version",
                "status",
                "expires_at",
                "acknowledged_by",
                "acknowledged_at",
                "started_at",
                "modified",
            ),
        ),
    }
    snapshot["inspector_authority"] = {
        "authenticated_user": _snapshot_text(
            inspector_authority["authenticated_user"]
        ),
        "job_assignment": _snapshot_values(
            inspector_authority["job_assignment"],
            (
                "name",
                "assignment_id",
                "roof_job",
                "assignment_type",
                "status",
                "crew_profile",
                "assigned_user",
                "scheduled_start",
                "supersedes",
                "modified",
            ),
        ),
        "crew_profile": _snapshot_values(
            inspector_authority["crew_profile"],
            (
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
                "modified",
            ),
        ),
        "assignment_role": _snapshot_text(inspector_authority["assignment_role"]),
    }
    return snapshot


def _first_piece_ncr_id(hermes_run_id: str) -> str:
    digest = hashlib.sha256(f"first-piece:{hermes_run_id}".encode("utf-8")).hexdigest()
    return f"ncr:first-piece:{digest[:32]}"


def _set(document: Any, field: str, value: Any) -> None:
    setter = getattr(document, "set", None)
    if callable(setter):
        setter(field, value)
    else:  # pragma: no cover - Frappe Documents provide set; helps isolated adapters
        setattr(document, field, value)


@frappe.whitelist()
def approve_controlled_item(
    controlled_item_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Approve one locked Draft Controlled Item from a signed Hermes Run."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Controlled Item", allowed_roles=OWNER_ROLES
    )
    controlled_item_id = _clean_identifier(controlled_item_id, "controlled_item_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=APPROVE_CONTROLLED_ITEM_TOOL,
        target_doctype="Controlled Item",
        target_name=controlled_item_id,
        target_field="controlled_item_id",
    )
    item = _lock_controlled_item(controlled_item_id)
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _controlled_item_snapshot(item),
    )
    if item.get("status") != "Draft":
        _fail("shop_command_item_not_preparable", "Controlled Item must be Draft")
    approved_at = str(frappe.utils.now_datetime())
    item.status = "Approved"
    item.approved_by = args["approved_by"]
    item.approved_at = approved_at
    item.approval_note = args["request_text"]
    with controlled_item_transition_context(item):
        item.save()
    return {
        "controlled_item": {
            "name": item.get("name"),
            "controlled_item_id": item.get("controlled_item_id"),
            "status": item.get("status"),
            "approved_by": item.get("approved_by"),
            "approved_at": str(item.get("approved_at")),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def receive_material_lot(
    material_lot_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Record a verified receiving event for one Draft Material Lot."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Material Lot", allowed_roles=SHOP_ROLES
    )
    material_lot_id = _clean_identifier(material_lot_id, "material_lot_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=RECEIVE_MATERIAL_LOT_TOOL,
        target_doctype="Material Lot",
        target_name=material_lot_id,
        target_field="material_lot_id",
    )
    lot = _lock_material_lot(material_lot_id)
    _assert_run_roof_job(run, lot)
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _material_lot_snapshot(lot),
    )
    if lot.get("status") != "Draft":
        _fail("shop_command_lot_not_receivable", "Material Lot must be Draft")
    item = _lock_controlled_item(
        _clean_identifier(lot.get("controlled_item"), "controlled_item")
    )
    if item.get("status") != "Approved":
        _fail("shop_command_item_not_approved", "Material Lot requires an Approved item")
    _lock_evidence(
        _clean_identifier(lot.get("source_evidence"), "source_evidence"),
        roof_job=lot.get("roof_job"),
    )
    if lot.get("source_kind") == "Supplier Receipt":
        source = _lock_row(
            "Supplier Order",
            _clean_identifier(lot.get("supplier_order"), "supplier_order"),
            fields="name, roof_job, status",
            not_found_code="shop_command_source_not_found",
        )
        if (
            source.get("roof_job") != lot.get("roof_job")
            or source.get("status") not in {"Partially Received", "Received"}
        ):
            _fail(
                "shop_command_source_not_ready",
                "supplier receipt must be linked to a received Supplier Order on this Roof Job",
            )
    elif lot.get("source_kind") == "Shop Remnant":
        source = _lock_row(
            "Shop Order",
            _clean_identifier(lot.get("source_shop_order"), "source_shop_order"),
            fields="name, roof_job, status",
            not_found_code="shop_command_source_not_found",
        )
        if (
            source.get("roof_job") != lot.get("roof_job")
            or source.get("status")
            not in {"Ready", "Handed Over", "Invoice Ready", "Closed"}
        ):
            _fail(
                "shop_command_source_not_ready",
                "shop remnant must be linked to a final source Shop Order on this Roof Job",
            )
    received_quantity = _positive_decimal(lot.get("received_quantity"), "received_quantity")
    received_at = str(frappe.utils.now_datetime())
    lot.received_at = received_at
    lot.reserved_quantity = "0"
    lot.consumed_quantity = "0"
    if lot.get("condition_status") == "Quarantined":
        lot.status = "Quarantined"
        lot.available_quantity = "0"
    else:
        lot.status = "Available"
        lot.available_quantity = _decimal_text(received_quantity)
    with material_lot_transition_context(lot):
        lot.save()
    return {
        "material_lot": {
            "name": lot.get("name"),
            "material_lot_id": lot.get("material_lot_id"),
            "roof_job": lot.get("roof_job"),
            "status": lot.get("status"),
            "available_quantity": lot.get("available_quantity"),
            "reserved_quantity": lot.get("reserved_quantity"),
            "consumed_quantity": lot.get("consumed_quantity"),
            "received_at": str(lot.get("received_at")),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def release_shop_order(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Release one complete Draft Shop Order after source anchors are locked."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Shop Order", allowed_roles=SHOP_ROLES
    )
    shop_order_id = _clean_identifier(shop_order_id, "shop_order_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=RELEASE_SHOP_ORDER_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_snapshot(order),
    )
    if order.get("status") != "Draft":
        _fail("shop_command_order_not_releasable", "Shop Order must be Draft")
    _lock_shop_sources(order)
    released_at = str(frappe.utils.now_datetime())
    order.status = "Released"
    order.released_by = args["approved_by"]
    order.released_at = released_at
    with shop_order_transition_context(order):
        order.save()
    return {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "released_by": order.get("released_by"),
            "released_at": str(order.get("released_at")),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def reserve_shop_order_materials(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Reserve exact approved Material Lot quantities for one released Shop Order."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Shop Order", allowed_roles=SHOP_ROLES
    )
    shop_order_id = _clean_identifier(shop_order_id, "shop_order_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=RESERVE_SHOP_ORDER_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"allocations_json"}),
    )
    allocations = _parse_allocations(args["allocations_json"])
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    if order.get("status") != "Released":
        _fail("shop_command_order_not_reservable", "Shop Order must be Released")
    _lock_shop_sources(order)
    requested_by_lot: defaultdict[str, Decimal] = defaultdict(Decimal)
    for allocation in allocations:
        requested_by_lot[allocation["material_lot"]] += allocation["reserved_quantity"]
    lots = [
        _lock_material_lot(material_lot_id)
        for material_lot_id in sorted(requested_by_lot)
    ]
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_snapshot(order, lots),
    )
    lots_by_id = {str(lot.get("material_lot_id")): lot for lot in lots}
    for lot_id, requested in requested_by_lot.items():
        lot = lots_by_id[lot_id]
        if lot.get("roof_job") != order.get("roof_job"):
            _fail(
                "shop_command_lot_roof_job_mismatch",
                "Material Lot must belong to the Shop Order Roof Job",
            )
        if lot.get("status") != "Available":
            _fail(
                "shop_command_lot_not_available",
                "Material Lot must be Available before reservation",
            )
        available = _positive_decimal(lot.get("available_quantity"), "available_quantity")
        if requested > available:
            _fail(
                "shop_command_insufficient_lot_quantity",
                "requested reservations exceed the locked Material Lot balance",
            )
    rows = [
        {
            "allocation_id": allocation["allocation_id"],
            "line_no": allocation["line_no"],
            "material_lot": allocation["material_lot"],
            "reserved_quantity": _decimal_text(allocation["reserved_quantity"]),
            "issued_quantity": "0",
            "unit": allocation["unit"],
            "status": "Reserved",
            "needs_review": 0,
        }
        for allocation in allocations
    ]
    reserved_at = str(frappe.utils.now_datetime())
    for lot_id, requested in requested_by_lot.items():
        lot = lots_by_id[lot_id]
        available = _positive_decimal(lot.get("available_quantity"), "available_quantity")
        current_reserved = Decimal(str(lot.get("reserved_quantity") or "0"))
        lot.available_quantity = _decimal_text(available - requested)
        lot.reserved_quantity = _decimal_text(current_reserved + requested)
        lot.status = "Reserved"
    _set(order, "material_allocations", rows)
    order.status = "Reserved"
    order.reserved_at = reserved_at
    with ExitStack() as stack:
        for lot in lots:
            stack.enter_context(material_lot_transition_context(lot))
        stack.enter_context(shop_order_transition_context(order))
        for lot in lots:
            lot.save()
        order.save()
    return {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "reserved_at": str(order.get("reserved_at")),
            "material_allocation_count": len(rows),
        },
        "material_lots": [
            {
                "material_lot_id": lot.get("material_lot_id"),
                "status": lot.get("status"),
                "available_quantity": lot.get("available_quantity"),
                "reserved_quantity": lot.get("reserved_quantity"),
            }
            for lot in lots
        ],
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def advance_shop_order_setup(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Advance one Shop Order through setup using only a signed route payload."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Shop Order", allowed_roles=SHOP_ROLES
    )
    shop_order_id = _clean_identifier(shop_order_id, "shop_order_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=ADVANCE_SHOP_ORDER_SETUP_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"setup_payload_json"}),
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    _lock_shop_sources(order)
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_setup_snapshot(order),
    )
    action, operations, hold_reason = _parse_setup_payload(
        order,
        args["setup_payload_json"],
    )
    if action == "place_quality_hold":
        order.status = "Quality Hold"
        order.quality_hold_reason = hold_reason
    else:
        if operations is not None:
            _set(order, "operations", operations)
            order.setup_started_at = str(frappe.utils.now_datetime())
        order.status = "Setup / First Piece"
        order.quality_hold_reason = ""
    with shop_order_transition_context(order):
        order.save()
    return {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "setup_started_at": str(order.get("setup_started_at") or ""),
            "quality_hold_reason": order.get("quality_hold_reason") or "",
            "operation_count": len(order.get("operations") or []),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def record_first_piece_outcome(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Record a signed first-piece pass or hold before shop fabrication starts."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Shop Order", allowed_roles=SHOP_ROLES
    )
    shop_order_id = _clean_identifier(shop_order_id, "shop_order_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        authenticated_user=authenticated_user,
        tool_name=RECORD_FIRST_PIECE_OUTCOME_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"first_piece_payload_json"}),
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    sources = _lock_shop_sources(order)
    action, inspections, hold_reason = _parse_first_piece_payload(
        order,
        args["first_piece_payload_json"],
    )
    lines = {
        int(line.get("line_no")): line for line in order.get("lines") or []
    }
    allocations = {
        str(allocation.get("allocation_id")): allocation
        for allocation in order.get("material_allocations") or []
    }
    operations = {
        int(operation.get("sequence")): operation
        for operation in order.get("operations") or []
    }
    if not lines or not allocations or not operations:
        _fail(
            "shop_command_first_piece_context_missing",
            "Shop Order requires lines, reservations, and a shop route",
        )
    lot_ids = sorted(
        {
            _clean_identifier(allocation.get("material_lot"), "material_lot")
            for allocation in allocations.values()
        }
    )
    lots = [_lock_material_lot(material_lot_id) for material_lot_id in lot_ids]
    evidence_ids = sorted({inspection["evidence_item"] for inspection in inspections})
    evidence = [
        _lock_first_piece_evidence(
            evidence_id,
            roof_job=order.get("roof_job"),
            inspector=authenticated_user,
        )
        for evidence_id in evidence_ids
    ]
    inspector_authority = _lock_first_piece_inspector_authority(
        order, authenticated_user=authenticated_user
    )
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_first_piece_snapshot(
            order, lots, evidence, sources, inspector_authority
        ),
    )
    lots_by_id = {str(lot.get("material_lot_id")): lot for lot in lots}
    for allocation in allocations.values():
        line = lines.get(int(allocation.get("line_no")))
        lot = lots_by_id.get(str(allocation.get("material_lot")))
        if (
            line is None
            or lot is None
            or allocation.get("status") != "Reserved"
            or lot.get("status") != "Reserved"
            or lot.get("roof_job") != order.get("roof_job")
            or lot.get("controlled_item") != line.get("controlled_item")
            or allocation.get("unit") != line.get("unit")
            or lot.get("unit") != line.get("unit")
        ):
            _fail(
                "shop_command_invalid_first_piece_allocation",
                "first-piece inspection requires current reserved material lineage",
            )
        if _nonnegative_decimal(
            allocation.get("issued_quantity"), "issued_quantity"
        ) != 0:
            _fail(
                "shop_command_first_piece_allocation_already_issued",
                "first-piece inspection requires an unissued material allocation",
            )
    inspected_lines = {inspection["line_no"] for inspection in inspections}
    if action == "pass_to_fabrication" and inspected_lines != set(lines):
        _fail(
            "shop_command_missing_first_piece_pass",
            "every Shop Order line needs one passed First Piece inspection",
        )
    issue_by_lot: defaultdict[str, Decimal] = defaultdict(Decimal)
    for inspection in inspections:
        allocation = allocations.get(inspection["allocation_id"])
        operation = operations.get(inspection["operation_sequence"])
        if (
            inspection["line_no"] not in lines
            or allocation is None
            or operation is None
            or int(allocation.get("line_no")) != inspection["line_no"]
        ):
            _fail(
                "shop_command_invalid_first_piece_reference",
                "inspection must reference the current line, allocation, and operation",
            )
        if operation.get("status") not in {"In Progress", "Complete"} or not operation.get(
            "started_at"
        ):
            _fail(
                "shop_command_first_piece_operation_not_started",
                "first-piece inspection requires a started in-progress or completed operation",
            )
        if operation.get("operator") == authenticated_user:
            _fail(
                "shop_command_non_independent_inspection",
                "the operation fabricator cannot inspect its own first piece",
                permission=True,
            )
        measurement = _first_piece_measurement_spec(lines[inspection["line_no"]])
        if inspection["measurement_unit"].lower() != measurement["measurement_unit"]:
            _fail(
                "shop_command_first_piece_measurement_unit_mismatch",
                "first-piece measurement unit must match the controlled line",
            )
        within_tolerance = (
            abs(inspection["measured_value"] - measurement["nominal_value"])
            <= measurement["tolerance_value"]
        )
        if (action == "pass_to_fabrication") != within_tolerance:
            _fail(
                "shop_command_first_piece_tolerance_result_mismatch",
                "first-piece action must match the measured tolerance result",
            )
        inspection["nominal_value"] = measurement["nominal_value"]
        inspection["tolerance_value"] = measurement["tolerance_value"]
        inspection["measurement_unit"] = measurement["measurement_unit"]
        inspection["measured_result"] = (
            f"{_decimal_text(inspection['measured_value'])} {measurement['measurement_unit']}; "
            f"nominal {_decimal_text(measurement['nominal_value'])} +/- "
            f"{_decimal_text(measurement['tolerance_value'])} {measurement['measurement_unit']}"
        )
        remaining = _positive_decimal(
            allocation.get("reserved_quantity"), "reserved_quantity"
        )
        if inspection["issued_quantity"] > remaining:
            _fail(
                "shop_command_first_piece_issue_exceeds_reservation",
                "first-piece issue exceeds the approved material allocation",
            )
        issue_by_lot[str(allocation.get("material_lot"))] += inspection[
            "issued_quantity"
        ]
    for material_lot_id, issued_quantity in issue_by_lot.items():
        lot = lots_by_id[material_lot_id]
        if issued_quantity > _positive_decimal(
            lot.get("reserved_quantity"), "reserved_quantity"
        ):
            _fail(
                "shop_command_first_piece_issue_exceeds_lot_reservation",
                "first-piece issue exceeds the locked Material Lot reservation",
            )
    inspected_at = str(frappe.utils.now_datetime())
    for inspection in inspections:
        allocation = allocations[inspection["allocation_id"]]
        allocation["issued_quantity"] = _decimal_text(inspection["issued_quantity"])
        allocation["status"] = "Issued"
    for material_lot_id, issued_quantity in issue_by_lot.items():
        lot = lots_by_id[material_lot_id]
        available = _nonnegative_decimal(lot.get("available_quantity"), "available_quantity")
        reserved = _positive_decimal(lot.get("reserved_quantity"), "reserved_quantity")
        consumed = _nonnegative_decimal(lot.get("consumed_quantity"), "consumed_quantity")
        received = _positive_decimal(lot.get("received_quantity"), "received_quantity")
        next_reserved = reserved - issued_quantity
        next_consumed = consumed + issued_quantity
        lot.reserved_quantity = _decimal_text(next_reserved)
        lot.consumed_quantity = _decimal_text(next_consumed)
        if next_reserved > 0:
            lot.status = "Reserved"
        elif available > 0:
            lot.status = "Available"
        elif next_consumed == received:
            lot.status = "Consumed"
        else:
            _fail(
                "shop_command_first_piece_lot_balance_invalid",
                "Material Lot balances cannot classify the issued first-piece state",
            )
    existing_inspections = list(order.get("inspections") or [])
    result = "Pass" if action == "pass_to_fabrication" else "Fail"
    existing_inspections.extend(
        {
            "inspection_type": "First Piece",
            "line_no": inspection["line_no"],
            "allocation_id": inspection["allocation_id"],
            "operation_sequence": inspection["operation_sequence"],
            "result": result,
            "nominal_value": _decimal_text(inspection["nominal_value"]),
            "measured_value": _decimal_text(inspection["measured_value"]),
            "tolerance_value": _decimal_text(inspection["tolerance_value"]),
            "measurement_unit": inspection["measurement_unit"],
            "measured_result": inspection["measured_result"],
            "inspected_by": authenticated_user,
            "inspected_at": inspected_at,
            "evidence_item": inspection["evidence_item"],
            "needs_review": 0 if result == "Pass" else 1,
        }
        for inspection in inspections
    )
    _set(order, "inspections", existing_inspections)
    if action == "pass_to_fabrication":
        order.status = "In Fabrication"
        order.fabrication_started_at = inspected_at
        order.quality_hold_reason = ""
    else:
        if not frappe.has_permission(
            "Nonconformance", ptype="create", user=authenticated_user
        ):
            _fail(
                "shop_command_nonconformance_permission_denied",
                "the authenticated principal cannot create the required Nonconformance",
                permission=True,
            )
        order.status = "Quality Hold"
        order.quality_hold_reason = hold_reason
    nonconformance = None
    failed_lot = None
    if action == "fail_to_quality_hold":
        failed = inspections[0]
        failed_lot = lots_by_id[str(allocations[failed["allocation_id"]].get("material_lot"))]
        failed_lot.status = "Quarantined"
        nonconformance = frappe.get_doc(
            {
                "doctype": "Nonconformance",
                "name": _first_piece_ncr_id(hermes_run_id),
                "nonconformance_id": _first_piece_ncr_id(hermes_run_id),
                "shop_order": order.get("name"),
                "material_lot": failed_lot.get("name"),
                "status": "Contained",
                "detected_at": inspected_at,
                "reported_by": authenticated_user,
                "description": hold_reason,
                "evidence_item": failed["evidence_item"],
                "containment": (
                    f"Material Lot {failed_lot.get('material_lot_id')} quarantined; "
                    "Shop Order placed on Quality Hold."
                ),
            }
        )
    with ExitStack() as stack:
        for lot in lots:
            stack.enter_context(material_lot_transition_context(lot))
        if nonconformance is not None:
            stack.enter_context(nonconformance_transition_context(nonconformance))
        stack.enter_context(shop_order_transition_context(order))
        if nonconformance is not None:
            nonconformance.insert()
        for lot in lots:
            lot.save()
        order.save()
    response = {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "fabrication_started_at": str(order.get("fabrication_started_at") or ""),
            "quality_hold_reason": order.get("quality_hold_reason") or "",
            "first_piece_inspection_count": len(
                [
                    inspection
                    for inspection in order.get("inspections") or []
                    if inspection.get("inspection_type") == "First Piece"
                ]
            ),
        },
        "hermes_run_id": hermes_run_id,
    }
    if failed_lot is not None and nonconformance is not None:
        response["material_lot"] = {
            "name": failed_lot.get("name"),
            "material_lot_id": failed_lot.get("material_lot_id"),
            "status": failed_lot.get("status"),
        }
        response["nonconformance"] = {
            "name": nonconformance.get("name"),
            "nonconformance_id": nonconformance.get("nonconformance_id"),
            "status": nonconformance.get("status"),
            "shop_order": nonconformance.get("shop_order"),
            "material_lot": nonconformance.get("material_lot"),
            "evidence_item": nonconformance.get("evidence_item"),
        }
    return response
