"""Bounded, audited fleet capture commands for the Field Companion.

The Field Companion never receives generic Fleet Asset, Asset Inspection, or
Asset Defect write authority.  Its Worker integration principal may record one
pre-trip inspection, one post-trip inspection, or one defect report only after
this module locks the exact asset, proves the field actor is an enabled User,
and binds the capture to the immutable R2 manifest the Worker stored first.

Two safety directions are deliberately asymmetric.  A failed inspection or an
out-of-service defect may take an asset **out** of service automatically,
because stopping unsafe equipment must never wait for an office decision.
Nothing here can put an asset **back** into service: that stays a supervised
Maintenance Order plus a Verified return-to-service inspection, enforced by
``domain_policy``.

Provider telematics may travel with a capture as a reference, but the actor is
always the authenticated physical inspector; the module never accepts a
telematics-only inspection.
"""

from __future__ import annotations

import datetime
import re
from collections.abc import Mapping, Sequence
from typing import Any

import frappe

from ironwrap_roofing.document_validation import asset_inspection_transition_context
from ironwrap_roofing.domain_policy import (
    ASSET_INSPECTION_CURRENCY_DAYS,
    ASSET_INSPECTION_PASSING_RESULTS,
    ASSET_INSPECTION_TYPES,
    CARGO_LOAD_RELEASE_FENCE_STATUSES,
    FLEET_DEFECT_SEVERITIES,
)


ISSUER_CONFIG_KEY = "ironwrap_fleet_capture_issuer_user"
MAX_IDENTIFIER_LENGTH = 140
MAX_TEXT_LENGTH = 1_200
MAX_MANIFEST_KEY_LENGTH = 512
MAX_INSPECTION_ITEMS = 60
OUT_OF_SERVICE_SEVERITY = "Out of Service"
INSPECTION_ITEM_RESULTS = frozenset(("Pass", "Fail", "Not Applicable"))
CAPTURE_SOURCE_SYSTEM = "ironwrap-worker-fleet-capture"
INSPECTION_RESPONSE_FIELDS = (
    "name",
    "asset_inspection_id",
    "fleet_asset",
    "inspection_type",
    "status",
    "result",
    "performed_by",
    "performed_at",
    "device_action_id",
    "defect_count",
    "next_inspection_due",
)
DEFECT_RESPONSE_FIELDS = (
    "name",
    "asset_defect_id",
    "fleet_asset",
    "status",
    "severity",
    "out_of_service",
    "detected_at",
    "reported_by",
    "device_action_id",
)
ASSET_RESPONSE_FIELDS = (
    "name",
    "fleet_asset_id",
    "asset_kind",
    "status",
    "last_inspection",
    "last_inspection_at",
    "next_inspection_due",
    "out_of_service_reason",
)
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")


def _value(record: Any, field: str, default: Any = None) -> Any:
    if isinstance(record, Mapping):
        return record.get(field, default)
    getter = getattr(record, "get", None)
    if callable(getter):
        return getter(field, default)
    return getattr(record, field, default)


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_required(
    value: Any,
    field: str,
    *,
    maximum: int = MAX_IDENTIFIER_LENGTH,
    minimum: int = 1,
) -> str:
    if not isinstance(value, str):
        _fail("fleet_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not minimum <= len(cleaned) <= maximum:
        _fail("fleet_invalid_input", f"{field} must be {minimum}-{maximum} characters")
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("fleet_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail("fleet_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("fleet_invalid_input", f"{field} is invalid")
    return cleaned


def _clean_timestamp(value: Any, field: str) -> str:
    cleaned = _clean_required(value, field, maximum=40, minimum=20)
    if not TIMESTAMP_RE.match(cleaned):
        _fail("fleet_invalid_input", f"{field} must be a UTC ISO-8601 timestamp")
    return cleaned.replace("T", " ").replace("Z", "").split(".")[0]


def _clean_number(value: Any, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("fleet_invalid_input", f"{field} must be a number")
    if value < 0:
        _fail("fleet_invalid_input", f"{field} must be nonnegative")
    return float(value)


def _enabled(value: Any) -> bool:
    return value in (True, 1, "1")


def _sql_rows(query: str, values: tuple[Any, ...]) -> list[dict[str, Any]]:
    """Read supporting rows without taking a lock the write does not need."""

    return [dict(row) for row in frappe.db.sql(query, values, as_dict=True)]


def _sql_locked(query: str, values: tuple[Any, ...]) -> list[dict[str, Any]]:
    """Read rows the caller is about to write against, under a row lock."""

    return _sql_rows(query, values)


def _assert_worker_issuer() -> None:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail("fleet_post_required", "this mutation accepts POST only", permission=True)
    configured = _clean_optional(
        getattr(frappe, "conf", {}).get(ISSUER_CONFIG_KEY),
        ISSUER_CONFIG_KEY,
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if not configured:
        _fail(
            "fleet_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    principal = _clean_required(getattr(frappe.session, "user", None), "session_user")
    if principal == "Guest" or principal != configured:
        _fail(
            "fleet_issuer_auth_mismatch",
            "only the configured Worker integration user may issue fleet captures",
            permission=True,
        )
    for doctype in ("Asset Inspection", "Asset Defect"):
        if not frappe.has_permission(doctype, ptype="create", user=principal):
            _fail(
                "fleet_issuer_permission_denied",
                f"the configured Worker integration user cannot create {doctype}",
                permission=True,
            )


def _lock_enabled_user(actor_user: str) -> None:
    rows = _sql_locked(
        """
        SELECT name, enabled
        FROM `tabUser`
        WHERE name = %s
        FOR UPDATE
        """,
        (actor_user,),
    )
    if len(rows) != 1 or not _enabled(rows[0].get("enabled")):
        _fail(
            "fleet_actor_not_enabled",
            "actor_user must be an enabled User",
            permission=True,
        )


def _lock_fleet_asset(fleet_asset_id: str) -> Any:
    rows = _sql_locked(
        """
        SELECT name, fleet_asset_id
        FROM `tabFleet Asset`
        WHERE name = %s OR fleet_asset_id = %s
        FOR UPDATE
        """,
        (fleet_asset_id, fleet_asset_id),
    )
    if len(rows) != 1:
        _fail(
            "fleet_asset_not_found",
            "fleet_asset_id must identify exactly one Fleet Asset",
        )
    asset = frappe.get_doc("Fleet Asset", rows[0]["name"])
    if fleet_asset_id not in {_value(asset, "name"), _value(asset, "fleet_asset_id")}:
        _fail("fleet_asset_identity_conflict", "locked Fleet Asset identity changed")
    if _value(asset, "status") == "Retired":
        _fail("fleet_asset_retired", "a Retired Fleet Asset cannot accept a capture")
    return asset


def _locked_replay(doctype: str, fields: Sequence[str], device_action_id: str) -> dict[str, Any] | None:
    columns = ", ".join(fields)
    rows = _sql_locked(
        f"""
        SELECT {columns}
        FROM `tab{doctype}`
        WHERE device_action_id = %s
        FOR UPDATE
        """,
        (device_action_id,),
    )
    if not rows:
        return None
    if len(rows) != 1:
        _fail(
            "fleet_replay_ambiguous",
            "device_action_id must identify at most one capture",
        )
    return rows[0]


def _assert_same_replay(existing: Mapping[str, Any], expected: Mapping[str, Any], fields: Sequence[str]) -> None:
    for field in fields:
        if str(_value(existing, field) or "") != str(expected.get(field) or ""):
            _fail(
                "fleet_capture_replay_conflict",
                "device_action_id is already bound to different immutable facts",
            )


def _clean_inspection_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_INSPECTION_ITEMS:
        _fail("fleet_invalid_input", "inspection items must be a bounded, non-empty list")
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(value, start=1):
        if not isinstance(row, Mapping):
            _fail("fleet_invalid_input", "each inspection item must be an object")
        if row.get("sequence") != index:
            _fail("fleet_invalid_input", "inspection item sequence must be contiguous")
        result = row.get("result")
        if result not in INSPECTION_ITEM_RESULTS:
            _fail("fleet_invalid_input", "unsupported inspection item result")
        severity = row.get("severity") or "None"
        if severity != "None" and severity not in FLEET_DEFECT_SEVERITIES:
            _fail("fleet_invalid_input", "unsupported inspection item severity")
        if (result == "Fail") != (severity != "None"):
            _fail(
                "fleet_invalid_input",
                "a failed inspection item requires a severity and a passing one carries none",
            )
        rows.append(
            {
                "doctype": "Asset Inspection Item",
                "sequence": index,
                "check_point": _clean_required(row.get("check_point"), "check_point"),
                "result": result,
                "severity": severity,
                "observation": _clean_optional(
                    row.get("observation"), "observation", maximum=MAX_TEXT_LENGTH
                ),
            }
        )
    return rows


def _inspection_result(items: Sequence[Mapping[str, Any]]) -> tuple[str, int, bool]:
    failed = [row for row in items if row.get("result") == "Fail"]
    unsafe = any(row.get("severity") in {"Major", OUT_OF_SERVICE_SEVERITY} for row in failed)
    if not failed:
        return "Pass", 0, False
    return ("Fail" if unsafe else "Pass With Defects"), len(failed), any(
        row.get("severity") == OUT_OF_SERVICE_SEVERITY for row in failed
    )


def _take_out_of_service(asset: Any, reason: str, occurred_at: str) -> None:
    """Stop an unsafe asset immediately; only supervised work restores it."""

    if _value(asset, "status") == "Out of Service":
        return
    asset.set("status", "Out of Service")
    asset.set("out_of_service_reason", reason[:MAX_TEXT_LENGTH])
    asset.set("out_of_service_at", occurred_at)


def _actor_holds_custody(asset: Any, actor: str) -> bool:
    holder_type = _value(asset, "custody_holder_type")
    if holder_type == "User":
        return str(_value(asset, "custody_user") or "") == actor
    if holder_type != "Crew":
        return False
    crew_profile = str(_value(asset, "custody_crew_profile") or "")
    if not crew_profile:
        return False
    return bool(
        _sql_rows(
            """
            SELECT name
            FROM `tabCrew Member`
            WHERE parenttype = 'Crew Profile'
              AND parentfield = 'members'
              AND parent = %s
              AND crew_user = %s
              AND active = 1
            LIMIT 1
            """,
            (crew_profile, actor),
        )
    )


def _actor_drives_asset(asset_name: str, actor: str) -> bool:
    """True when an open Cargo Load puts this actor behind this asset."""

    statuses = tuple(sorted(CARGO_LOAD_RELEASE_FENCE_STATUSES))
    placeholders = ", ".join("%s" for _ in statuses)
    return bool(
        _sql_rows(
            f"""
            SELECT cargo.name
            FROM `tabCargo Load` AS cargo
            LEFT JOIN `tabDriver Authority` AS authority
              ON authority.name = cargo.driver_authority
            WHERE (cargo.fleet_asset = %s OR cargo.trailer_asset = %s)
              AND cargo.status IN ({placeholders})
              AND (cargo.driver_user = %s OR authority.driver_user = %s)
            LIMIT 1
            """,
            (asset_name, asset_name, *statuses, actor, actor),
        )
    )


def _require_actor_asset_relationship(asset: Any, actor: str) -> None:
    """Bind the capture to an actor who actually holds or drives this asset.

    Without this fence any paired field session could POST an out-of-service
    defect against an asset it never touched and ground the fleet, or fabricate
    a passing pre-trip for one.  The relationship the fleet fence already reads
    -- Fleet Asset custody, or the driver on an open Cargo Load -- is the same
    one that authorizes the capture.

    An unrelated asset is reported exactly as a missing one, so the rail cannot
    be used to enumerate the fleet.
    """

    if _actor_holds_custody(asset, actor):
        return
    if _actor_drives_asset(str(_value(asset, "name") or ""), actor):
        return
    _fail(
        "fleet_asset_not_found",
        "fleet_asset_id must identify exactly one Fleet Asset",
    )


def _inspection_due_date(inspection_type: str, performed_at: str) -> str | None:
    """Derive the next currency date from policy, never from the device."""

    days = ASSET_INSPECTION_CURRENCY_DAYS.get(inspection_type)
    if not days:
        return None
    try:
        performed = datetime.datetime.strptime(performed_at[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return (performed.date() + datetime.timedelta(days=days)).isoformat()


def _advance_inspection_currency(
    asset: Any, document: Any, performed_at: str, next_due: str | None
) -> bool:
    """Close the safety loop a passing inspection is supposed to close.

    Reading ``next_inspection_due`` without ever writing it left the fence with
    no field-side way to clear ``overdue_fleet_inspection``: a crew could record
    a passing pre-trip every morning and still be blocked until someone edited
    the asset in the Desk.  Currency only ever moves forward here, so a short
    pre-trip cycle can never shorten a longer periodic one already recorded.
    """

    changed = False
    last_inspection_at = str(_value(asset, "last_inspection_at") or "")[:19]
    if not last_inspection_at or last_inspection_at <= performed_at[:19]:
        asset.set("last_inspection", _value(document, "name"))
        asset.set("last_inspection_at", performed_at)
        changed = True
    current_due = str(_value(asset, "next_inspection_due") or "")[:10]
    if next_due and (not current_due or current_due < next_due):
        asset.set("next_inspection_due", next_due)
        changed = True
    return changed


def _asset_response(asset: Any) -> dict[str, Any]:
    return {field: _value(asset, field) for field in ASSET_RESPONSE_FIELDS}


@frappe.whitelist()
def record_asset_inspection(
    fleet_asset_id: Any,
    actor_user: Any,
    device_action_id: Any,
    manifest_key: Any,
    inspection_type: Any,
    inspection: Any,
) -> dict[str, Any]:
    """Record one physically performed pre/post-trip or periodic inspection."""

    _assert_worker_issuer()
    asset_id = _clean_required(fleet_asset_id, "fleet_asset_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(device_action_id, "device_action_id", minimum=8)
    raw_key = _clean_required(manifest_key, "manifest_key", maximum=MAX_MANIFEST_KEY_LENGTH)
    kind = _clean_required(inspection_type, "inspection_type")
    if kind not in ASSET_INSPECTION_TYPES:
        _fail("fleet_invalid_input", "unsupported inspection_type")
    if not isinstance(inspection, Mapping):
        _fail("fleet_invalid_input", "inspection must be an object")

    _lock_enabled_user(actor)
    asset = _lock_fleet_asset(asset_id)
    _require_actor_asset_relationship(asset, actor)
    performed_at = _clean_timestamp(inspection.get("performed_at"), "performed_at")
    meter_reading = _clean_number(inspection.get("meter_reading"), "meter_reading")
    telematics_reference = _clean_optional(
        inspection.get("telematics_reference"), "telematics_reference", maximum=MAX_IDENTIFIER_LENGTH
    )
    items = _clean_inspection_items(inspection.get("items"))
    result, defect_count, out_of_service = _inspection_result(items)

    expected = {
        "fleet_asset": _value(asset, "name"),
        "inspection_type": kind,
        "performed_by": actor,
        "performed_at": performed_at,
        "device_action_id": device_action,
        "raw_key": raw_key,
        "result": result,
    }
    existing = _locked_replay(
        "Asset Inspection",
        ("name", *expected.keys()),
        device_action,
    )
    if existing:
        # A lost-connectivity retry replays the identical capture; the same id
        # bound to different facts is a conflict, never a silent overwrite.
        _assert_same_replay(existing, expected, tuple(expected.keys()))
        return {
            "record": {"name": _value(existing, "name")}
            | {field: _value(existing, field) for field in expected},
            "fleet_asset": _asset_response(asset),
            "idempotent_replay": True,
        }

    next_inspection_due = (
        _inspection_due_date(kind, performed_at)
        if result in ASSET_INSPECTION_PASSING_RESULTS
        else None
    )
    document = frappe.get_doc(
        {
            "doctype": "Asset Inspection",
            "asset_inspection_id": f"inspection:{device_action}",
            "status": "Submitted",
            "sync_state": "Uploaded",
            "capture_actor": actor,
            "source_system": CAPTURE_SOURCE_SYSTEM,
            "defect_count": defect_count,
            "meter_reading": meter_reading,
            "telematics_reference": telematics_reference,
            "telematics_observed_at": performed_at if telematics_reference else None,
            "next_inspection_due": next_inspection_due,
            "items": items,
            **expected,
        }
    )
    with asset_inspection_transition_context(document):
        # The Worker principal holds a narrow create grant only; the private
        # context is what makes this one submitted lifecycle fact legitimate.
        document.insert(ignore_permissions=True)

    if out_of_service:
        _take_out_of_service(
            asset,
            f"Out-of-service defect found on {kind} inspection {device_action}.",
            performed_at,
        )
        asset.save(ignore_permissions=True)
    elif result in ASSET_INSPECTION_PASSING_RESULTS and _advance_inspection_currency(
        asset, document, performed_at, next_inspection_due
    ):
        asset.save(ignore_permissions=True)
    return {
        "record": {field: _value(document, field) for field in INSPECTION_RESPONSE_FIELDS},
        "fleet_asset": _asset_response(asset),
        "idempotent_replay": False,
    }


@frappe.whitelist()
def record_asset_defect(
    fleet_asset_id: Any,
    actor_user: Any,
    device_action_id: Any,
    manifest_key: Any,
    defect: Any,
) -> dict[str, Any]:
    """Record one field-reported defect and stop the asset when it is unsafe."""

    _assert_worker_issuer()
    asset_id = _clean_required(fleet_asset_id, "fleet_asset_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(device_action_id, "device_action_id", minimum=8)
    raw_key = _clean_required(manifest_key, "manifest_key", maximum=MAX_MANIFEST_KEY_LENGTH)
    if not isinstance(defect, Mapping):
        _fail("fleet_invalid_input", "defect must be an object")
    severity = defect.get("severity")
    if severity not in FLEET_DEFECT_SEVERITIES:
        _fail("fleet_invalid_input", "unsupported defect severity")

    _lock_enabled_user(actor)
    asset = _lock_fleet_asset(asset_id)
    _require_actor_asset_relationship(asset, actor)
    detected_at = _clean_timestamp(defect.get("detected_at"), "detected_at")
    description = _clean_required(
        defect.get("description"), "description", maximum=MAX_TEXT_LENGTH
    )
    source_inspection = _clean_optional(
        defect.get("asset_inspection_id"), "asset_inspection_id", maximum=MAX_IDENTIFIER_LENGTH
    )
    out_of_service = severity == OUT_OF_SERVICE_SEVERITY

    expected = {
        "fleet_asset": _value(asset, "name"),
        "severity": severity,
        "detected_at": detected_at,
        "reported_by": actor,
        "device_action_id": device_action,
        "raw_key": raw_key,
        "description": description,
    }
    existing = _locked_replay("Asset Defect", ("name", *expected.keys()), device_action)
    if existing:
        _assert_same_replay(existing, expected, tuple(expected.keys()))
        return {
            "record": {"name": _value(existing, "name")}
            | {field: _value(existing, field) for field in expected},
            "fleet_asset": _asset_response(asset),
            "idempotent_replay": True,
        }

    document = frappe.get_doc(
        {
            "doctype": "Asset Defect",
            "asset_defect_id": f"defect:{device_action}",
            "status": "Open",
            "out_of_service": 1 if out_of_service else 0,
            "asset_inspection": source_inspection,
            **expected,
        }
    )
    document.insert(ignore_permissions=True)

    if out_of_service:
        _take_out_of_service(
            asset,
            f"Out-of-service defect {device_action} reported from the field.",
            detected_at,
        )
        asset.save(ignore_permissions=True)
    return {
        "record": {field: _value(document, field) for field in DEFECT_RESPONSE_FIELDS},
        "fleet_asset": _asset_response(asset),
        "idempotent_replay": False,
    }
