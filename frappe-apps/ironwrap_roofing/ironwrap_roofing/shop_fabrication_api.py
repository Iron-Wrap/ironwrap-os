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
HANDOVER_EVIDENCE_TYPES = frozenset({"Photo", "Signed Document"})

APPROVE_CONTROLLED_ITEM_TOOL = "request_approve_controlled_item"
RECEIVE_MATERIAL_LOT_TOOL = "request_receive_material_lot"
RELEASE_SHOP_ORDER_TOOL = "request_release_shop_order"
RESERVE_SHOP_ORDER_TOOL = "request_reserve_shop_order_materials"
ADVANCE_SHOP_ORDER_SETUP_TOOL = "request_advance_shop_order_setup"
RECORD_FIRST_PIECE_OUTCOME_TOOL = "request_record_first_piece_outcome"
RECORD_FINAL_SHOP_QUALITY_TOOL = "request_record_final_shop_quality"
RECORD_SHOP_HANDOVER_TOOL = "request_record_shop_handover"
RECORD_SHOP_BILLING_BASIS_TOOL = "request_record_shop_billing_basis"

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
    ADVANCE_SHOP_ORDER_SETUP_TOOL: frozenset(
        {"Owner Operator", "Production Controller"}
    ),
    RECORD_FIRST_PIECE_OUTCOME_TOOL: frozenset(
        {"Owner Operator", "Production Controller"}
    ),
    RECORD_FINAL_SHOP_QUALITY_TOOL: frozenset(
        {"Owner Operator", "Production Controller"}
    ),
    RECORD_SHOP_HANDOVER_TOOL: frozenset({"Owner Operator", "Production Controller"}),
    RECORD_SHOP_BILLING_BASIS_TOOL: frozenset(
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
        _fail(
            "shop_command_invalid_approval_args", f"{field} contains control characters"
        )
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
            "final_quality_payload_json",
            "handover_payload_json",
            "billing_basis_payload_json",
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


def _assert_post_and_permissions(*, doctype: str, allowed_roles: frozenset[str]) -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "shop_command_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
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
        _fail(
            "shop_command_hermes_run_identity_mismatch", "locked run identity differs"
        )
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
        _fail(
            "shop_command_tool_mismatch", "Hermes Run does not authorize this command"
        )
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
        _fail(
            "shop_command_target_mismatch", "Hermes Run target does not match command"
        )
    if run.get("mutation_applied") in {1, "1", True}:
        _fail(
            "shop_command_run_already_consumed", "Hermes Run already applied a mutation"
        )
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


def _assert_record_identity(
    document: Any, *, id_field: str, record_id: str, label: str
) -> None:
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
        _fail(
            "shop_command_invalid_approval_args", f"{field} must be greater than zero"
        )
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


def _parse_setup_payload(
    order: Any, raw: str
) -> tuple[str, list[dict[str, Any]] | None, str | None]:
    payload = _parse_json(raw, field="setup_payload_json")
    if not isinstance(payload, Mapping):
        _fail(
            "shop_command_invalid_approval_args", "setup_payload_json must be an object"
        )
    action = payload.get("action")
    status = order.get("status")
    has_operations = bool(order.get("operations") or [])
    if action == "begin_setup":
        if status != "Reserved":
            _fail(
                "shop_command_order_not_setup_advanceable",
                "Shop Order must be Reserved",
            )
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
            None
            if has_operations
            else _parse_setup_route_rows(payload.get("operations"))
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


def _parse_final_quality_inspection(raw: Any) -> dict[str, Any]:
    expected_fields = {
        "line_no",
        "allocation_id",
        "operation_sequence",
        "measured_value",
        "measurement_unit",
        "evidence_item",
    }
    if not isinstance(raw, Mapping) or set(raw) != expected_fields:
        _fail(
            "shop_command_invalid_approval_args",
            "final-quality inspection has an unsupported shape",
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
        "measured_value": _canonical_decimal(
            raw.get("measured_value"), "measured_value", allow_zero=True
        ),
        "measurement_unit": _clean_identifier(
            raw.get("measurement_unit"), "measurement_unit"
        ),
        "evidence_item": _clean_identifier(raw.get("evidence_item"), "evidence_item"),
    }


def _parse_final_quality_yield(raw: Any) -> dict[str, Any]:
    expected_fields = {
        "allocation_id",
        "operation_sequence",
        "input_quantity",
        "finished_quantity",
        "remnant_quantity",
        "scrap_quantity",
        "scrap_disposition",
        "evidence_item",
    }
    if not isinstance(raw, Mapping) or set(raw) != expected_fields:
        _fail(
            "shop_command_invalid_approval_args", "shop yield has an unsupported shape"
        )
    operation_sequence = _positive_decimal(
        raw.get("operation_sequence"), "operation_sequence"
    )
    if operation_sequence != operation_sequence.to_integral_value():
        _fail(
            "shop_command_invalid_approval_args",
            "operation_sequence must be an integer",
        )
    result = {
        "allocation_id": _clean_identifier(raw.get("allocation_id"), "allocation_id"),
        "operation_sequence": int(operation_sequence),
        "input_quantity": _canonical_decimal(
            raw.get("input_quantity"), "input_quantity", allow_zero=False
        ),
        "finished_quantity": _canonical_decimal(
            raw.get("finished_quantity"), "finished_quantity", allow_zero=True
        ),
        "remnant_quantity": _canonical_decimal(
            raw.get("remnant_quantity"), "remnant_quantity", allow_zero=True
        ),
        "scrap_quantity": _canonical_decimal(
            raw.get("scrap_quantity"), "scrap_quantity", allow_zero=True
        ),
    }
    if result["scrap_quantity"] > 0:
        result["scrap_disposition"] = _clean_request_text(
            raw.get("scrap_disposition"), field="scrap_disposition"
        )
        result["evidence_item"] = _clean_identifier(
            raw.get("evidence_item"), "evidence_item"
        )
    elif raw.get("scrap_disposition") == "" and raw.get("evidence_item") == "":
        result["scrap_disposition"] = ""
        result["evidence_item"] = ""
    else:
        _fail(
            "shop_command_invalid_approval_args",
            "zero scrap requires blank scrap disposition and evidence",
        )
    return result


def _parse_final_quality_bundle(raw: Any) -> dict[str, Any]:
    expected_fields = {
        "bundle_id",
        "line_no",
        "material_lot",
        "piece_identity",
        "accepted_quantity",
        "unit",
        "label_text",
        "condition",
    }
    if not isinstance(raw, Mapping) or set(raw) != expected_fields:
        _fail(
            "shop_command_invalid_approval_args", "shop bundle has an unsupported shape"
        )
    line_no = _positive_decimal(raw.get("line_no"), "line_no")
    if line_no != line_no.to_integral_value():
        _fail("shop_command_invalid_approval_args", "line_no must be an integer")
    return {
        "bundle_id": _clean_identifier(raw.get("bundle_id"), "bundle_id"),
        "line_no": int(line_no),
        "material_lot": _clean_identifier(raw.get("material_lot"), "material_lot"),
        "piece_identity": _clean_identifier(
            raw.get("piece_identity"), "piece_identity"
        ),
        "accepted_quantity": _canonical_decimal(
            raw.get("accepted_quantity"), "accepted_quantity", allow_zero=False
        ),
        "unit": _clean_identifier(raw.get("unit"), "unit"),
        "label_text": _clean_request_text(raw.get("label_text"), field="label_text"),
        "condition": _clean_request_text(raw.get("condition"), field="condition"),
    }


def _parse_final_quality_payload(
    order: Any, raw: str
) -> tuple[
    str, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str | None
]:
    payload = _parse_json(raw, field="final_quality_payload_json")
    if not isinstance(payload, Mapping):
        _fail(
            "shop_command_invalid_approval_args",
            "final_quality_payload_json must be an object",
        )
    if order.get("status") != "In Fabrication":
        _fail(
            "shop_command_order_not_final_quality_ready",
            "Shop Order must be in In Fabrication",
        )
    action = payload.get("action")
    if action == "pass_to_ready":
        if set(payload) != {"action", "inspections", "yields", "bundles"}:
            _fail(
                "shop_command_invalid_approval_args",
                "pass_to_ready requires only action, inspections, yields, and bundles",
            )
        raw_inspections = payload.get("inspections")
        raw_yields = payload.get("yields")
        raw_bundles = payload.get("bundles")
        if not isinstance(raw_inspections, list) or not raw_inspections:
            _fail(
                "shop_command_invalid_approval_args",
                "pass_to_ready requires final inspections",
            )
        if not isinstance(raw_yields, list) or not raw_yields:
            _fail(
                "shop_command_invalid_approval_args",
                "pass_to_ready requires shop yields",
            )
        if not isinstance(raw_bundles, list) or not raw_bundles:
            _fail(
                "shop_command_invalid_approval_args", "pass_to_ready requires bundles"
            )
        inspections = [_parse_final_quality_inspection(row) for row in raw_inspections]
        yields = [_parse_final_quality_yield(row) for row in raw_yields]
        bundles = [_parse_final_quality_bundle(row) for row in raw_bundles]
        if len({row["line_no"] for row in inspections}) != len(inspections):
            _fail(
                "shop_command_invalid_approval_args",
                "final inspections must have unique lines",
            )
        if len({row["allocation_id"] for row in inspections}) != len(inspections):
            _fail(
                "shop_command_invalid_approval_args",
                "final inspections must have unique allocations",
            )
        if len({row["allocation_id"] for row in yields}) != len(yields):
            _fail(
                "shop_command_invalid_approval_args",
                "shop yields must have unique allocations",
            )
        if len({row["bundle_id"] for row in bundles}) != len(bundles):
            _fail(
                "shop_command_invalid_approval_args",
                "shop bundles must have unique IDs",
            )
        return action, inspections, yields, bundles, None
    if action == "fail_to_quality_hold":
        if set(payload) != {"action", "inspection", "reason"}:
            _fail(
                "shop_command_invalid_approval_args",
                "fail_to_quality_hold requires only action, inspection, and reason",
            )
        return (
            action,
            [_parse_final_quality_inspection(payload.get("inspection"))],
            [],
            [],
            _clean_request_text(payload.get("reason"), field="reason"),
        )
    _fail("shop_command_invalid_approval_args", "unsupported final-quality action")
    raise AssertionError("frappe.throw must raise")  # pragma: no cover


def _parse_handover_payload(raw: str) -> dict[str, str]:
    payload = _parse_json(raw, field="handover_payload_json")
    if not isinstance(payload, Mapping) or set(payload) != {
        "handed_over_to",
        "handoff_evidence",
    }:
        _fail(
            "shop_command_invalid_approval_args",
            "handover_payload_json must contain only handed_over_to and handoff_evidence",
        )
    return {
        "handed_over_to": _clean_request_text(
            payload.get("handed_over_to"), field="handed_over_to"
        ),
        "handoff_evidence": _clean_identifier(
            payload.get("handoff_evidence"), "handoff_evidence"
        ),
    }


def _parse_billing_basis_payload(raw: str) -> dict[str, str]:
    payload = _parse_json(raw, field="billing_basis_payload_json")
    if not isinstance(payload, Mapping) or set(payload) != {"payment_milestone_id"}:
        _fail(
            "shop_command_invalid_approval_args",
            "billing_basis_payload_json must contain only payment_milestone_id",
        )
    return {
        "payment_milestone_id": _clean_identifier(
            payload.get("payment_milestone_id"), "payment_milestone_id"
        )
    }


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


def _lock_handover_evidence(evidence_id: str, *, roof_job: str) -> dict[str, Any]:
    evidence = _lock_row(
        "Evidence Item",
        evidence_id,
        fields=(
            "name, evidence_id, roof_job, evidence_type, proof_slot, source_system, "
            "r2_key, content_checksum, checksum_algorithm, content_type, content_length, "
            "captured_at, sync_state, verified_at, verification_source, device_action_id, modified"
        ),
        not_found_code="shop_command_evidence_not_found",
    )
    if evidence.get("roof_job") != roof_job:
        _fail(
            "shop_command_handover_evidence_job_mismatch",
            "handover evidence must belong to the same Roof Job",
        )
    if (
        evidence.get("proof_slot") != "Production"
        or evidence.get("evidence_type") not in HANDOVER_EVIDENCE_TYPES
    ):
        _fail(
            "shop_command_handover_evidence_semantic_invalid",
            "handover evidence must be a Production Photo or Signed Document",
        )
    if evidence.get("sync_state") != "Verified":
        _fail(
            "shop_command_handover_evidence_unverified",
            "handover evidence must be verified",
        )
    if evidence.get("source_system") != "ironwrap-pwa" or not evidence.get(
        "device_action_id"
    ):
        _fail(
            "shop_command_handover_evidence_provenance_invalid",
            "handover evidence must originate from an identified IronWrap PWA action",
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
            "shop_command_handover_evidence_provenance_invalid",
            "handover evidence is missing immutable capture or verification provenance",
        )
    if evidence.get("checksum_algorithm") != "SHA-256" or not re.fullmatch(
        r"[0-9a-f]{64}", str(evidence.get("content_checksum") or "")
    ):
        _fail(
            "shop_command_handover_evidence_provenance_invalid",
            "handover evidence must retain a SHA-256 checksum",
        )
    try:
        content_length = int(evidence.get("content_length"))
    except (TypeError, ValueError):
        content_length = 0
    if content_length <= 0:
        _fail(
            "shop_command_handover_evidence_provenance_invalid",
            "handover evidence content length must be positive",
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
    if (
        evidence.get("proof_slot") != "Production"
        or evidence.get("evidence_type") not in FIRST_PIECE_EVIDENCE_TYPES
    ):
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


def _lock_payment_milestone(payment_milestone_id: str) -> Any:
    document = _lock_document(
        "Payment Milestone",
        payment_milestone_id,
        fields=(
            "name, payment_milestone_id, roof_job, shop_order, milestone_type, status, "
            "qb_entity_type, qb_entity_id, raw_key, modified"
        ),
        not_found_code="shop_command_payment_milestone_not_found",
    )
    _assert_record_identity(
        document,
        id_field="payment_milestone_id",
        record_id=payment_milestone_id,
        label="Payment Milestone",
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


def _first_piece_inspector_authority_snapshot(
    inspector_authority: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "authenticated_user": _snapshot_text(inspector_authority["authenticated_user"]),
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
    snapshot["inspector_authority"] = _first_piece_inspector_authority_snapshot(
        inspector_authority
    )
    return snapshot


def _shop_order_final_quality_snapshot(
    order: Any,
    lots: list[Any],
    evidence: list[Mapping[str, Any]],
    sources: Mapping[str, Mapping[str, Any]],
    inspector_authority: Mapping[str, Any],
) -> dict[str, Any]:
    snapshot = _shop_order_first_piece_snapshot(
        order, lots, evidence, sources, inspector_authority
    )
    snapshot["shop_order"].update(
        _snapshot_values(
            order,
            (
                "ready_at",
                "handed_over_to",
                "handed_over_at",
                "handoff_evidence",
                "invoice_payment_milestone",
                "invoice_ready_at",
            ),
        )
    )
    snapshot["yields"] = [
        _snapshot_values(
            row,
            (
                "allocation_id",
                "operation_sequence",
                "input_quantity",
                "finished_quantity",
                "remnant_quantity",
                "remnant_lot",
                "scrap_quantity",
                "scrap_disposition",
                "evidence_item",
            ),
        )
        for row in order.get("yields") or []
    ]
    snapshot["bundles"] = [
        _snapshot_values(
            row,
            (
                "bundle_id",
                "line_no",
                "material_lot",
                "piece_identity",
                "accepted_quantity",
                "unit",
                "label_text",
                "handoff_status",
                "handed_over_to",
                "handed_over_at",
                "handoff_evidence",
                "condition",
                "needs_review",
            ),
        )
        for row in order.get("bundles") or []
    ]
    return snapshot


def _shop_order_handover_snapshot(
    order: Any,
    evidence: list[Mapping[str, Any]],
    sources: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    snapshot = _shop_order_snapshot(order)
    snapshot["shop_order"].update(
        _snapshot_values(
            order,
            (
                "ready_at",
                "handed_over_to",
                "handed_over_at",
                "handoff_evidence",
                "invoice_payment_milestone",
                "invoice_ready_at",
            ),
        )
    )
    snapshot["bundles"] = [
        _snapshot_values(
            row,
            (
                "bundle_id",
                "line_no",
                "material_lot",
                "piece_identity",
                "accepted_quantity",
                "unit",
                "label_text",
                "handoff_status",
                "handed_over_to",
                "handed_over_at",
                "handoff_evidence",
                "condition",
                "needs_review",
            ),
        )
        for row in order.get("bundles") or []
    ]
    snapshot["evidence"] = [
        _snapshot_values(
            item,
            ("name", "evidence_id", "roof_job", "sync_state", "modified"),
        )
        for item in evidence
    ]
    snapshot["source_records"] = {
        field: _snapshot_values(source, ("name", "roof_job", "status", "modified"))
        for field, source in sources.items()
    }
    return snapshot


def _payment_milestone_snapshot(payment_milestone: Mapping[str, Any]) -> dict[str, Any]:
    return _snapshot_values(
        payment_milestone,
        (
            "name",
            "payment_milestone_id",
            "roof_job",
            "shop_order",
            "milestone_type",
            "status",
            "qb_entity_type",
            "qb_entity_id",
            "raw_key",
            "modified",
        ),
    )


def _shop_order_billing_basis_snapshot(
    order: Any,
    payment_milestone: Mapping[str, Any],
    handoff_evidence: Mapping[str, Any],
    sources: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    snapshot = _shop_order_handover_snapshot(order, [handoff_evidence], sources)
    snapshot["payment_milestone"] = _payment_milestone_snapshot(payment_milestone)
    return snapshot


def _first_piece_ncr_id(hermes_run_id: str) -> str:
    digest = hashlib.sha256(f"first-piece:{hermes_run_id}".encode("utf-8")).hexdigest()
    return f"ncr:first-piece:{digest[:32]}"


def _final_quality_ncr_id(hermes_run_id: str) -> str:
    digest = hashlib.sha256(
        f"final-quality:{hermes_run_id}".encode("utf-8")
    ).hexdigest()
    return f"ncr:final-quality:{digest[:32]}"


def _shop_remnant_lot_id(hermes_run_id: str, allocation_id: str) -> str:
    digest = hashlib.sha256(
        f"shop-remnant:{hermes_run_id}:{allocation_id}".encode("utf-8")
    ).hexdigest()
    return f"lot:remnant:{digest[:32]}"


@frappe.whitelist()
def preview_first_piece_authority(shop_order_id: str) -> dict[str, Any]:
    """Return the current authority snapshot required for a first-piece preview."""

    authenticated_user = _assert_post_and_permissions(
        doctype="Shop Order", allowed_roles=SHOP_ROLES
    )
    shop_order_id = _clean_identifier(shop_order_id, "shop_order_id")
    order = _lock_shop_order(shop_order_id)
    _lock_shop_sources(order)
    inspector_authority = _lock_first_piece_inspector_authority(
        order, authenticated_user=authenticated_user
    )
    preview = _first_piece_inspector_authority_snapshot(inspector_authority)
    preview["work_package"] = _snapshot_values(
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
    )
    return preview


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
        _fail(
            "shop_command_item_not_approved", "Material Lot requires an Approved item"
        )
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
        if source.get("roof_job") != lot.get("roof_job") or source.get(
            "status"
        ) not in {"Partially Received", "Received"}:
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
        if source.get("roof_job") != lot.get("roof_job") or source.get(
            "status"
        ) not in {"Ready", "Handed Over", "Invoice Ready", "Closed"}:
            _fail(
                "shop_command_source_not_ready",
                "shop remnant must be linked to a final source Shop Order on this Roof Job",
            )
    received_quantity = _positive_decimal(
        lot.get("received_quantity"), "received_quantity"
    )
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
        available = _positive_decimal(
            lot.get("available_quantity"), "available_quantity"
        )
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
        available = _positive_decimal(
            lot.get("available_quantity"), "available_quantity"
        )
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
    lines = {int(line.get("line_no")): line for line in order.get("lines") or []}
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
        if (
            _nonnegative_decimal(allocation.get("issued_quantity"), "issued_quantity")
            != 0
        ):
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
        if operation.get("status") not in {
            "In Progress",
            "Complete",
        } or not operation.get("started_at"):
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
        available = _nonnegative_decimal(
            lot.get("available_quantity"), "available_quantity"
        )
        reserved = _positive_decimal(lot.get("reserved_quantity"), "reserved_quantity")
        consumed = _nonnegative_decimal(
            lot.get("consumed_quantity"), "consumed_quantity"
        )
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
        failed_lot = lots_by_id[
            str(allocations[failed["allocation_id"]].get("material_lot"))
        ]
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


@frappe.whitelist()
def record_shop_handover(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Record one evidence-backed custody handover for every prepared bundle."""

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
        tool_name=RECORD_SHOP_HANDOVER_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"handover_payload_json"}),
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    payload = _parse_handover_payload(args["handover_payload_json"])
    if order.get("status") != "Ready":
        _fail(
            "shop_command_order_not_ready_for_handover",
            "Shop Order must be Ready before custody handover",
        )
    bundles = list(order.get("bundles") or [])
    if not bundles or any(
        bundle.get("handoff_status") != "Prepared"
        or any(
            bundle.get(field)
            for field in ("handed_over_to", "handed_over_at", "handoff_evidence")
        )
        for bundle in bundles
    ):
        _fail(
            "shop_command_handover_bundle_state_invalid",
            "every shop bundle must be prepared and unhanded before handover",
        )
    if any(
        order.get(field)
        for field in ("handed_over_to", "handed_over_at", "handoff_evidence")
    ):
        _fail(
            "shop_command_handover_already_recorded",
            "Shop Order already has custody handover metadata",
        )
    sources = _lock_shop_sources(order)
    handoff_evidence = _lock_handover_evidence(
        payload["handoff_evidence"], roof_job=order.get("roof_job")
    )
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_handover_snapshot(order, [handoff_evidence], sources),
    )
    handed_over_at = str(frappe.utils.now_datetime())
    order.status = "Handed Over"
    order.handed_over_to = payload["handed_over_to"]
    order.handed_over_at = handed_over_at
    order.handoff_evidence = handoff_evidence["name"]
    for bundle in bundles:
        bundle["handoff_status"] = "Handed Over"
        bundle["handed_over_to"] = payload["handed_over_to"]
        bundle["handed_over_at"] = handed_over_at
        bundle["handoff_evidence"] = handoff_evidence["name"]
    with shop_order_transition_context(order):
        order.save()
    return {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "handed_over_to": order.get("handed_over_to"),
            "handed_over_at": str(order.get("handed_over_at")),
            "handoff_evidence": order.get("handoff_evidence"),
            "bundle_count": len(bundles),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def record_shop_billing_basis(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Bind a handed-over Shop Order to one existing QuickBooks Invoice mirror."""

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
        tool_name=RECORD_SHOP_BILLING_BASIS_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"billing_basis_payload_json"}),
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    payload = _parse_billing_basis_payload(args["billing_basis_payload_json"])
    if order.get("status") != "Handed Over":
        _fail(
            "shop_command_order_not_ready_for_billing_basis",
            "Shop Order must be Handed Over before billing readiness",
        )
    if order.get("invoice_payment_milestone") or order.get("invoice_ready_at"):
        _fail(
            "shop_command_billing_basis_already_recorded",
            "Shop Order already has a billing basis",
        )
    sources = _lock_shop_sources(order)
    handoff_evidence = _lock_handover_evidence(
        _clean_identifier(order.get("handoff_evidence"), "handoff_evidence"),
        roof_job=order.get("roof_job"),
    )
    payment_milestone = _lock_payment_milestone(payload["payment_milestone_id"])
    if payment_milestone.get("roof_job") != order.get("roof_job") or str(
        payment_milestone.get("shop_order")
    ) != str(order.get("shop_order_id")):
        _fail(
            "shop_command_billing_basis_lineage_mismatch",
            "Payment Milestone must be pre-linked to this Shop Order and Roof Job",
        )
    if payment_milestone.get("status") not in {
        "Webhook Seen",
        "Needs Review",
        "Matched",
    }:
        _fail(
            "shop_command_billing_basis_unverified",
            "Payment Milestone must be a current provider mirror",
        )
    if (
        payment_milestone.get("milestone_type") != "Invoice"
        or payment_milestone.get("qb_entity_type") != "Invoice"
        or not payment_milestone.get("qb_entity_id")
        or not payment_milestone.get("raw_key")
    ):
        _fail(
            "shop_command_billing_basis_unverified",
            "billing readiness requires a raw-backed QuickBooks Invoice mirror",
        )
    _assert_current_snapshot(
        args["expected_snapshot_sha256"],
        _shop_order_billing_basis_snapshot(
            order, payment_milestone, handoff_evidence, sources
        ),
    )
    order.status = "Invoice Ready"
    order.invoice_payment_milestone = payment_milestone.get("name")
    order.invoice_ready_at = str(frappe.utils.now_datetime())
    with shop_order_transition_context(order):
        order.save()
    return {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "invoice_payment_milestone": order.get("invoice_payment_milestone"),
            "invoice_ready_at": str(order.get("invoice_ready_at")),
        },
        "payment_milestone": {
            "name": payment_milestone.get("name"),
            "payment_milestone_id": payment_milestone.get("payment_milestone_id"),
            "qb_entity_id": payment_milestone.get("qb_entity_id"),
            "status": payment_milestone.get("status"),
        },
        "hermes_run_id": hermes_run_id,
    }


@frappe.whitelist()
def record_final_shop_quality(
    shop_order_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Record signed final QC and reconcile the finished shop output to Ready."""

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
        tool_name=RECORD_FINAL_SHOP_QUALITY_TOOL,
        target_doctype="Shop Order",
        target_name=shop_order_id,
        target_field="shop_order_id",
        extra_fields=frozenset({"final_quality_payload_json"}),
    )
    order = _lock_shop_order(shop_order_id)
    _assert_run_roof_job(run, order)
    sources = _lock_shop_sources(order)
    action, inspections, yields, bundles, hold_reason = _parse_final_quality_payload(
        order, args["final_quality_payload_json"]
    )
    lines = {int(line.get("line_no")): line for line in order.get("lines") or []}
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
            "shop_command_final_quality_context_missing",
            "Shop Order requires lines, material allocations, and a shop route",
        )
    if (
        order.get("yields")
        or order.get("bundles")
        or any(
            inspection.get("inspection_type") == "Final"
            for inspection in order.get("inspections") or []
        )
    ):
        _fail(
            "shop_command_final_quality_already_recorded",
            "Shop Order already has final inspection, yield, or bundle output",
        )
    lot_ids = sorted(
        {
            _clean_identifier(allocation.get("material_lot"), "material_lot")
            for allocation in allocations.values()
        }
    )
    lots = [_lock_material_lot(material_lot_id) for material_lot_id in lot_ids]
    evidence_ids = sorted(
        {inspection["evidence_item"] for inspection in inspections}
        | {row["evidence_item"] for row in yields if row["scrap_quantity"] > 0}
    )
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
        _shop_order_final_quality_snapshot(
            order, lots, evidence, sources, inspector_authority
        ),
    )
    lots_by_id = {str(lot.get("material_lot_id")): lot for lot in lots}
    allocation_lots_by_line: defaultdict[int, set[str]] = defaultdict(set)
    for allocation in allocations.values():
        line_no = int(allocation.get("line_no"))
        line = lines.get(line_no)
        lot = lots_by_id.get(str(allocation.get("material_lot")))
        issued_quantity = _nonnegative_decimal(
            allocation.get("issued_quantity"), "issued_quantity"
        )
        reserved_quantity = _positive_decimal(
            allocation.get("reserved_quantity"), "reserved_quantity"
        )
        if (
            line is None
            or lot is None
            or allocation.get("status") != "Issued"
            or issued_quantity <= 0
            or issued_quantity > reserved_quantity
            or lot.get("status") not in {"Reserved", "Available", "Consumed"}
            or lot.get("roof_job") != order.get("roof_job")
            or lot.get("controlled_item") != line.get("controlled_item")
            or allocation.get("unit") != line.get("unit")
            or lot.get("unit") != line.get("unit")
        ):
            _fail(
                "shop_command_invalid_final_quality_allocation",
                "final quality requires current issued material lineage",
            )
        allocation_lots_by_line[line_no].add(str(allocation.get("material_lot")))
    first_piece_passes = {
        int(inspection.get("line_no"))
        for inspection in order.get("inspections") or []
        if inspection.get("inspection_type") == "First Piece"
        and inspection.get("result") == "Pass"
    }
    if set(lines) - first_piece_passes:
        _fail(
            "shop_command_missing_first_piece_pass",
            "every Shop Order line needs a passed First Piece inspection",
        )
    inspections_by_line: dict[int, dict[str, Any]] = {}
    for inspection in inspections:
        allocation = allocations.get(inspection["allocation_id"])
        operation = operations.get(inspection["operation_sequence"])
        if (
            allocation is None
            or operation is None
            or inspection["line_no"] not in lines
            or int(allocation.get("line_no")) != inspection["line_no"]
        ):
            _fail(
                "shop_command_invalid_final_quality_reference",
                "inspection must reference the current line, allocation, and operation",
            )
        if operation.get("status") != "Complete" or not operation.get("completed_at"):
            _fail(
                "shop_command_final_quality_operation_incomplete",
                "final quality requires a completed inspection operation",
            )
        if operation.get("operator") == authenticated_user:
            _fail(
                "shop_command_non_independent_inspection",
                "the operation fabricator cannot inspect its own final work",
                permission=True,
            )
        measurement = _first_piece_measurement_spec(lines[inspection["line_no"]])
        if inspection["measurement_unit"].lower() != measurement["measurement_unit"]:
            _fail(
                "shop_command_final_quality_measurement_unit_mismatch",
                "final measurement unit must match the controlled line",
            )
        within_tolerance = (
            abs(inspection["measured_value"] - measurement["nominal_value"])
            <= measurement["tolerance_value"]
        )
        if (action == "pass_to_ready") != within_tolerance:
            _fail(
                "shop_command_final_quality_tolerance_result_mismatch",
                "final-quality action must match the measured tolerance result",
            )
        inspection["nominal_value"] = measurement["nominal_value"]
        inspection["tolerance_value"] = measurement["tolerance_value"]
        inspection["measurement_unit"] = measurement["measurement_unit"]
        inspection["measured_result"] = (
            f"{_decimal_text(inspection['measured_value'])} {measurement['measurement_unit']}; "
            f"nominal {_decimal_text(measurement['nominal_value'])} +/- "
            f"{_decimal_text(measurement['tolerance_value'])} {measurement['measurement_unit']}"
        )
        inspections_by_line[inspection["line_no"]] = inspection
    if action == "pass_to_ready" and set(inspections_by_line) != set(lines):
        _fail(
            "shop_command_missing_final_quality_pass",
            "every Shop Order line needs one passed Final inspection",
        )
    issue_delta_by_lot: defaultdict[str, Decimal] = defaultdict(Decimal)
    yields_by_allocation: dict[str, dict[str, Any]] = {}
    finished_by_line: defaultdict[int, Decimal] = defaultdict(Decimal)
    remnant_specs: list[tuple[dict[str, Any], Any]] = []
    if action == "pass_to_ready":
        if any(
            operation.get("status") != "Complete" or not operation.get("completed_at")
            for operation in operations.values()
        ):
            _fail(
                "shop_command_final_quality_operation_incomplete",
                "every shop route operation must be completed before Ready",
            )
        if {row["allocation_id"] for row in yields} != set(allocations):
            _fail(
                "shop_command_final_quality_yields_incomplete",
                "every material allocation needs one final yield",
            )
        for row in yields:
            allocation = allocations.get(row["allocation_id"])
            operation = operations.get(row["operation_sequence"])
            if allocation is None or operation is None:
                _fail(
                    "shop_command_invalid_final_quality_reference",
                    "yield must reference the current allocation and operation",
                )
            if operation.get("status") != "Complete" or not operation.get(
                "completed_at"
            ):
                _fail(
                    "shop_command_final_quality_operation_incomplete",
                    "final yield requires a completed shop operation",
                )
            if abs(
                row["input_quantity"]
                - (
                    row["finished_quantity"]
                    + row["remnant_quantity"]
                    + row["scrap_quantity"]
                )
            ) > Decimal("0.01"):
                _fail(
                    "shop_command_final_quality_yield_mismatch",
                    "input quantity must equal finished plus remnant plus scrap",
                )
            reserved_quantity = _positive_decimal(
                allocation.get("reserved_quantity"), "reserved_quantity"
            )
            issued_quantity = _nonnegative_decimal(
                allocation.get("issued_quantity"), "issued_quantity"
            )
            if (
                row["input_quantity"] != reserved_quantity
                or issued_quantity > row["input_quantity"]
            ):
                _fail(
                    "shop_command_final_quality_yield_mismatch",
                    "final yield must reconcile the full approved allocation",
                )
            line_no = int(allocation.get("line_no"))
            finished_by_line[line_no] += row["finished_quantity"]
            issue_delta_by_lot[str(allocation.get("material_lot"))] += (
                row["input_quantity"] - issued_quantity
            )
            row["remnant_lot"] = (
                _shop_remnant_lot_id(hermes_run_id, row["allocation_id"])
                if row["remnant_quantity"] > 0
                else ""
            )
            yields_by_allocation[row["allocation_id"]] = row
            if row["remnant_quantity"] > 0:
                remnant_specs.append((row, allocation))
        for material_lot_id, issue_delta in issue_delta_by_lot.items():
            lot = lots_by_id[material_lot_id]
            if issue_delta > _nonnegative_decimal(
                lot.get("reserved_quantity"), "reserved_quantity"
            ):
                _fail(
                    "shop_command_final_quality_issue_exceeds_reservation",
                    "final yield exceeds the locked Material Lot reservation",
                )
        bundled_by_line: defaultdict[int, Decimal] = defaultdict(Decimal)
        for bundle in bundles:
            line = lines.get(bundle["line_no"])
            if (
                line is None
                or bundle["material_lot"]
                not in allocation_lots_by_line[bundle["line_no"]]
                or bundle["unit"] != line.get("unit")
            ):
                _fail(
                    "shop_command_invalid_final_quality_bundle",
                    "bundle must use its line's allocated lot and unit",
                )
            bundled_by_line[bundle["line_no"]] += bundle["accepted_quantity"]
        for line_no, line in lines.items():
            accepted_quantity = _positive_decimal(
                line.get("accepted_quantity"), "accepted_quantity"
            )
            if finished_by_line[line_no] != accepted_quantity:
                _fail(
                    "shop_command_final_quality_finished_mismatch",
                    "finished yield must equal the accepted line quantity",
                )
            if bundled_by_line[line_no] != accepted_quantity:
                _fail(
                    "shop_command_final_quality_bundle_mismatch",
                    "prepared bundles must equal the accepted line quantity",
                )
    inspected_at = str(frappe.utils.now_datetime())
    existing_inspections = list(order.get("inspections") or [])
    result = "Pass" if action == "pass_to_ready" else "Fail"
    existing_inspections.extend(
        {
            "inspection_type": "Final",
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
    nonconformance = None
    failed_lot = None
    remnant_lots: list[Any] = []
    if action == "pass_to_ready":
        for allocation_id, row in yields_by_allocation.items():
            allocation = allocations[allocation_id]
            allocation["issued_quantity"] = _decimal_text(row["input_quantity"])
            allocation["status"] = "Issued"
        for material_lot_id, issue_delta in issue_delta_by_lot.items():
            lot = lots_by_id[material_lot_id]
            available = _nonnegative_decimal(
                lot.get("available_quantity"), "available_quantity"
            )
            reserved = _nonnegative_decimal(
                lot.get("reserved_quantity"), "reserved_quantity"
            )
            consumed = _nonnegative_decimal(
                lot.get("consumed_quantity"), "consumed_quantity"
            )
            received = _positive_decimal(
                lot.get("received_quantity"), "received_quantity"
            )
            next_reserved = reserved - issue_delta
            next_consumed = consumed + issue_delta
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
                    "shop_command_final_quality_lot_balance_invalid",
                    "Material Lot balances cannot classify the final issue state",
                )
        _set(
            order,
            "yields",
            [
                {
                    "allocation_id": row["allocation_id"],
                    "operation_sequence": row["operation_sequence"],
                    "input_quantity": _decimal_text(row["input_quantity"]),
                    "finished_quantity": _decimal_text(row["finished_quantity"]),
                    "remnant_quantity": _decimal_text(row["remnant_quantity"]),
                    "remnant_lot": row["remnant_lot"],
                    "scrap_quantity": _decimal_text(row["scrap_quantity"]),
                    "scrap_disposition": row["scrap_disposition"],
                    "evidence_item": row["evidence_item"],
                }
                for row in yields
            ],
        )
        _set(
            order,
            "bundles",
            [
                {
                    "bundle_id": bundle["bundle_id"],
                    "line_no": bundle["line_no"],
                    "material_lot": bundle["material_lot"],
                    "piece_identity": bundle["piece_identity"],
                    "accepted_quantity": _decimal_text(bundle["accepted_quantity"]),
                    "unit": bundle["unit"],
                    "label_text": bundle["label_text"],
                    "handoff_status": "Prepared",
                    "handed_over_to": "",
                    "handed_over_at": "",
                    "handoff_evidence": "",
                    "condition": bundle["condition"],
                    "needs_review": 0,
                }
                for bundle in bundles
            ],
        )
        for row, allocation in remnant_specs:
            line_no = int(allocation.get("line_no"))
            remnant_lot_id = row["remnant_lot"]
            remnant_lots.append(
                frappe.get_doc(
                    {
                        "doctype": "Material Lot",
                        "name": remnant_lot_id,
                        "material_lot_id": remnant_lot_id,
                        "roof_job": order.get("roof_job"),
                        "controlled_item": lines[line_no].get("controlled_item"),
                        "source_kind": "Shop Remnant",
                        "supplier_order": "",
                        "source_shop_order": order.get("name"),
                        "source_evidence": inspections_by_line[line_no][
                            "evidence_item"
                        ],
                        "lot_number": remnant_lot_id,
                        "certificate_reference": "",
                        "condition_status": "Accepted",
                        "received_quantity": _decimal_text(row["remnant_quantity"]),
                        "available_quantity": _decimal_text(row["remnant_quantity"]),
                        "reserved_quantity": "0",
                        "consumed_quantity": "0",
                        "unit": lines[line_no].get("unit"),
                        "received_at": inspected_at,
                        "status": "Available",
                    }
                )
            )
        order.status = "Ready"
        order.ready_at = inspected_at
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
        failed = inspections[0]
        failed_lot = lots_by_id[
            str(allocations[failed["allocation_id"]].get("material_lot"))
        ]
        failed_lot.status = "Quarantined"
        order.status = "Quality Hold"
        order.quality_hold_reason = hold_reason
        nonconformance = frappe.get_doc(
            {
                "doctype": "Nonconformance",
                "name": _final_quality_ncr_id(hermes_run_id),
                "nonconformance_id": _final_quality_ncr_id(hermes_run_id),
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
    for remnant_lot in remnant_lots:
        with material_lot_transition_context(remnant_lot):
            remnant_lot.insert()
    response = {
        "shop_order": {
            "name": order.get("name"),
            "shop_order_id": order.get("shop_order_id"),
            "roof_job": order.get("roof_job"),
            "status": order.get("status"),
            "ready_at": str(order.get("ready_at") or ""),
            "quality_hold_reason": order.get("quality_hold_reason") or "",
            "final_inspection_count": len(
                [
                    inspection
                    for inspection in order.get("inspections") or []
                    if inspection.get("inspection_type") == "Final"
                ]
            ),
            "yield_count": len(order.get("yields") or []),
            "bundle_count": len(order.get("bundles") or []),
        },
        "hermes_run_id": hermes_run_id,
    }
    if remnant_lots:
        response["remnant_lots"] = [
            {
                "name": lot.get("name"),
                "material_lot_id": lot.get("material_lot_id"),
                "available_quantity": lot.get("available_quantity"),
                "unit": lot.get("unit"),
                "status": lot.get("status"),
            }
            for lot in remnant_lots
        ]
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
