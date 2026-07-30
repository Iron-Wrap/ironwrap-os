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
    shop_order_transition_context,
)


MAX_IDENTIFIER_LENGTH = 140
MAX_REQUEST_TEXT_LENGTH = 4_000
SHA256_HEX_LENGTH = 64

APPROVE_CONTROLLED_ITEM_TOOL = "request_approve_controlled_item"
RECEIVE_MATERIAL_LOT_TOOL = "request_receive_material_lot"
RELEASE_SHOP_ORDER_TOOL = "request_release_shop_order"
RESERVE_SHOP_ORDER_TOOL = "request_reserve_shop_order_materials"

OWNER_ROLES = frozenset({"System Manager", "IronWrap Owner"})
SHOP_ROLES = OWNER_ROLES | {"IronWrap Production"}
COMMON_APPROVAL_ARGUMENTS = frozenset(
    {"request_text", "approved_by", "run_id", "expected_snapshot_sha256"}
)


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


def _clean_request_text(value: Any) -> str:
    if not isinstance(value, str):
        _fail("shop_command_invalid_approval_args", "request_text must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > MAX_REQUEST_TEXT_LENGTH:
        _fail(
            "shop_command_invalid_approval_args",
            f"request_text must be 1-{MAX_REQUEST_TEXT_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("shop_command_invalid_approval_args", "request_text contains control characters")
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
        if field == "allocations_json":
            value = parsed.get(field)
            if not isinstance(value, str) or not value:
                _fail(
                    "shop_command_invalid_approval_args",
                    "allocations_json must be non-empty JSON text",
                )
            # Parse now so malformed or duplicate-key payloads fail before any
            # inventory row is locked or changed. Preserve the exact signed text
            # for receipt verification below.
            _parse_json(value, field="allocations_json")
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
    for protected_doctype in (doctype, "Hermes Run"):
        if not frappe.has_permission(
            protected_doctype, ptype="write", user=authenticated_user
        ):
            _fail(
                "shop_command_permission_denied",
                f"the authenticated principal cannot write {protected_doctype}",
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


def _lock_evidence(evidence_id: str, *, roof_job: str) -> None:
    evidence = _lock_row(
        "Evidence Item",
        evidence_id,
        fields="name, roof_job, sync_state",
        not_found_code="shop_command_evidence_not_found",
    )
    if evidence.get("roof_job") != roof_job or evidence.get("sync_state") != "Verified":
        _fail(
            "shop_command_evidence_unverified",
            "shop evidence must be verified and belong to the same Roof Job",
        )


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
            "status, modified"
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


def _lock_shop_sources(order: Any) -> None:
    source_specs = (
        ("Material Takeoff", "material_takeoff", {"Approved"}),
        ("Supplier Order", "supplier_order", {"Partially Received", "Received"}),
        ("Work Package", "work_package", {"Released", "Acknowledged", "In Progress"}),
    )
    for doctype, field, allowed_statuses in source_specs:
        source_id = _clean_identifier(order.get(field), field)
        source = _lock_row(
            doctype,
            source_id,
            fields="name, roof_job, status",
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
