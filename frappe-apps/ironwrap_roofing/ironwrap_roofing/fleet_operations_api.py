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
    FLEET_ROAD_ASSET_KINDS,
    OPEN_OUT_OF_SERVICE_DEFECT_STATUSES,
    fleet_release_blockers,
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
    "evidence_item",
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
REFERENCE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# One driver's own fleet is small. The cap keeps a compromised or buggy caller
# from turning the panel into a fleet-wide scan, and keeps the phone's payload
# bounded.
PANEL_ASSET_LIMIT = 25
PANEL_ASSET_FIELDS = (
    "name",
    "fleet_asset_id",
    "asset_kind",
    "status",
    "display_name",
    "unit_number",
    "licence_plate",
    "meter_kind",
    "current_meter",
    "required_licence_class",
    "inspection_authority_source",
    "last_inspection_at",
    "next_inspection_due",
    "next_service_due_date",
    "calibration_required",
    "next_calibration_due",
    "registration_expiry",
    "insurance_expiry",
    "out_of_service_reason",
)
# What the driver's phone is allowed to see. The fence needs more fields than a
# screen does, so the readiness columns above stay on this side of the wire.
PANEL_RESPONSE_FIELDS = (
    "name",
    "fleet_asset_id",
    "asset_kind",
    "status",
    "display_name",
    "unit_number",
    "licence_plate",
    "meter_kind",
    "current_meter",
    "last_inspection_at",
    "next_inspection_due",
    "out_of_service_reason",
)


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
    # `Asset Inspection` autonames from `asset_inspection_id`, so the row's own
    # name is knowable before the insert.  Pin it here: the trust context below
    # stamps the name it can see, `insert()` names the document before
    # `validate` runs, and a context opened against an unnamed document would
    # authorize nothing -- the guard would refuse the very bounded command it
    # exists to admit.  Same pinning as the bounded Shop commands use.
    inspection_id = f"inspection:{device_action}"
    document = frappe.get_doc(
        {
            "doctype": "Asset Inspection",
            "name": inspection_id,
            "asset_inspection_id": inspection_id,
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

    photo_refs = _parse_defect_photo_refs(defect)
    evidence_id = (
        f"fleet-photo:{device_action}:{photo_refs[0]['sha256'][:16]}"
        if photo_refs
        else None
    )
    expected = {
        "fleet_asset": _value(asset, "name"),
        "severity": severity,
        "detected_at": detected_at,
        "reported_by": actor,
        "device_action_id": device_action,
        "raw_key": raw_key,
        "description": description,
    }
    if evidence_id is not None:
        expected["evidence_item"] = evidence_id
    existing = _locked_replay("Asset Defect", ("name", *expected.keys()), device_action)
    if existing:
        _assert_same_replay(existing, expected, tuple(expected.keys()))
        return {
            "record": {"name": _value(existing, "name")}
            | {field: _value(existing, field) for field in expected},
            "fleet_asset": _asset_response(asset),
            "idempotent_replay": True,
        }

    # Evidence Item is named from the device action + photo digest, so a retry
    # after a lost response replays the same row instead of inventing a second.
    if photo_refs:
        _ensure_defect_photo_evidence(
            photo_refs,
            evidence_id=evidence_id,
            actor=actor,
            device_action=device_action,
            detected_at=detected_at,
        )

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


PHOTO_CONTENT_TYPES = frozenset(
    ("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif")
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _parse_defect_photo_refs(defect: Mapping[str, Any]) -> list[dict[str, str]]:
    """Parse optional fleet photo refs before any write.

    Asset Defect.evidence_item is a single Link. Extra photos stay on the
    Worker manifest. A capture without photos still records the defect.
    """

    photos = defect.get("photo_evidence")
    if photos is None:
        return []
    if not isinstance(photos, list) or not 1 <= len(photos) <= 4:
        _fail("fleet_invalid_input", "photo_evidence must be 1 to 4 objects")
    return [_clean_photo_ref(row) for row in photos]


def _ensure_defect_photo_evidence(
    photo_refs: list[dict[str, str]],
    *,
    evidence_id: str,
    actor: str,
    device_action: str,
    detected_at: str,
) -> str:
    """Create or replay the Evidence Item named by evidence_id."""

    primary = photo_refs[0]
    expected = {
        "evidence_id": evidence_id,
        "device_action_id": device_action,
        "evidence_type": "Photo",
        "sync_state": "Uploaded",
        "source_system": CAPTURE_SOURCE_SYSTEM,
        "r2_key": primary["r2_key"],
        "content_checksum": primary["sha256"],
        "checksum_algorithm": "SHA-256",
        "content_type": primary["content_type"],
        "capture_actor": actor,
        "captured_at": detected_at,
        "proof_slot": "Other",
        "summary": f"{len(photo_refs)} fleet photo(s)",
    }
    existing = _locked_evidence_item(evidence_id)
    if existing:
        _assert_same_replay(existing, expected, tuple(expected.keys()))
        return _value(existing, "name") or evidence_id

    document = frappe.get_doc({"doctype": "Evidence Item", **expected})
    document.insert(ignore_permissions=True)
    return _value(document, "name") or evidence_id


def _locked_evidence_item(evidence_id: str) -> dict[str, Any] | None:
    rows = _sql_locked(
        """
        SELECT
            name, evidence_id, device_action_id, evidence_type, sync_state,
            source_system, r2_key, content_checksum, checksum_algorithm,
            content_type, capture_actor, captured_at, proof_slot, summary
        FROM `tabEvidence Item`
        WHERE evidence_id = %s
        FOR UPDATE
        """,
        (evidence_id,),
    )
    if not rows:
        return None
    if len(rows) != 1:
        _fail(
            "fleet_replay_ambiguous",
            "evidence_id must identify at most one Evidence Item",
        )
    return rows[0]


def _clean_photo_ref(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        _fail("fleet_invalid_input", "photo_evidence entries must be objects")
    attachment_id = _clean_required(value.get("attachment_id"), "attachment_id", maximum=80)
    file_name = _clean_required(value.get("file_name"), "file_name", maximum=180)
    content_type = _clean_required(value.get("content_type"), "content_type", maximum=40).lower()
    if content_type not in PHOTO_CONTENT_TYPES:
        _fail("fleet_invalid_input", "unsupported fleet photo type")
    sha256 = _clean_required(value.get("sha256"), "sha256", maximum=64, minimum=64)
    if not SHA256_RE.match(sha256):
        _fail("fleet_invalid_input", "photo sha256 must be lowercase hex")
    r2_key = _clean_required(value.get("r2_key"), "r2_key", maximum=240)
    if not r2_key.startswith("fleet/v1/") or "/photo/" not in r2_key:
        _fail("fleet_invalid_input", "photo r2_key is not a fleet photo object")
    return {
        "attachment_id": attachment_id,
        "file_name": file_name,
        "content_type": content_type,
        "sha256": sha256,
        "r2_key": r2_key,
    }


def _assert_worker_reader() -> None:
    """Admit the Worker integration principal to the read-only panel.

    Deliberately not ``_assert_worker_issuer``: reading a driver's own assets
    needs no authority to create an inspection or a defect, and demanding one
    would make a read fail for a principal correctly holding read-only grants.
    """

    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail("fleet_post_required", "this read accepts POST only", permission=True)
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
            "only the configured Worker integration user may read the fleet panel",
            permission=True,
        )
    if not frappe.has_permission("Fleet Asset", ptype="read", user=principal):
        _fail(
            "fleet_issuer_permission_denied",
            "the configured Worker integration user cannot read Fleet Asset",
            permission=True,
        )


def _panel_reference_date(value: Any) -> str:
    if value is None:
        return str(frappe.utils.now_datetime())[:10]
    cleaned = _clean_required(value, "reference_date", maximum=10, minimum=10)
    if not REFERENCE_DATE_RE.match(cleaned):
        _fail("fleet_invalid_input", "reference_date must be an ISO-8601 date")
    return cleaned


def _panel_asset_relationships(actor: str) -> dict[str, str]:
    """Every asset this actor may capture against, and how they reach it.

    The three bindings are exactly the ones ``_require_actor_asset_relationship``
    accepts one asset at a time -- custody as the named user, custody through an
    active crew membership, or driving an open Cargo Load.  Custody wins over
    driving when both hold, because custody is the stronger claim and it is what
    the release fence compares against the load.
    """

    statuses = tuple(sorted(CARGO_LOAD_RELEASE_FENCE_STATUSES))
    load_placeholders = ", ".join("%s" for _ in statuses)
    relationships: dict[str, str] = {}
    for row in _sql_rows(
        f"""
        SELECT cargo.fleet_asset, cargo.trailer_asset
        FROM `tabCargo Load` AS cargo
        LEFT JOIN `tabDriver Authority` AS authority
          ON authority.name = cargo.driver_authority
        WHERE cargo.status IN ({load_placeholders})
          AND (cargo.driver_user = %s OR authority.driver_user = %s)
        LIMIT %s
        """,
        (*statuses, actor, actor, PANEL_ASSET_LIMIT),
    ):
        for field in ("fleet_asset", "trailer_asset"):
            name = str(row.get(field) or "")
            if name:
                relationships[name] = "driver"
    for row in _sql_rows(
        """
        SELECT name
        FROM `tabFleet Asset`
        WHERE custody_holder_type = 'User'
          AND custody_user = %s
          AND status != 'Retired'
        LIMIT %s
        """,
        (actor, PANEL_ASSET_LIMIT),
    ):
        name = str(row.get("name") or "")
        if name:
            relationships[name] = "custody"
    for row in _sql_rows(
        """
        SELECT asset.name
        FROM `tabFleet Asset` AS asset
        JOIN `tabCrew Member` AS member
          ON member.parenttype = 'Crew Profile'
         AND member.parentfield = 'members'
         AND member.parent = asset.custody_crew_profile
        WHERE asset.custody_holder_type = 'Crew'
          AND asset.status != 'Retired'
          AND member.crew_user = %s
          AND member.active = 1
        LIMIT %s
        """,
        (actor, PANEL_ASSET_LIMIT),
    ):
        name = str(row.get("name") or "")
        if name:
            relationships[name] = "custody"
    return relationships


def _panel_assets(names: Sequence[str]) -> dict[str, dict[str, Any]]:
    placeholders = ", ".join("%s" for _ in names)
    columns = ", ".join(PANEL_ASSET_FIELDS)
    return {
        str(row["name"]): dict(row)
        for row in _sql_rows(
            f"""
            SELECT {columns}
            FROM `tabFleet Asset`
            WHERE name IN ({placeholders})
              AND status != 'Retired'
            """,
            tuple(names),
        )
        if row.get("name")
    }


def _panel_open_out_of_service_defects(names: Sequence[str]) -> dict[str, int]:
    placeholders = ", ".join("%s" for _ in names)
    status_placeholders = ", ".join("%s" for _ in OPEN_OUT_OF_SERVICE_DEFECT_STATUSES)
    counts: dict[str, int] = {name: 0 for name in names}
    for row in _sql_rows(
        f"""
        SELECT fleet_asset
        FROM `tabAsset Defect`
        WHERE fleet_asset IN ({placeholders})
          AND out_of_service = 1
          AND status IN ({status_placeholders})
        """,
        (*names, *OPEN_OUT_OF_SERVICE_DEFECT_STATUSES),
    ):
        name = str(row.get("fleet_asset") or "")
        if name in counts:
            counts[name] += 1
    return counts


def _panel_recent_inspections(names: Sequence[str]) -> dict[tuple[str, str], str]:
    """The newest pre/post-trip capture per asset, whoever recorded it.

    Currency is a property of the vehicle, not of the driver looking at it: a
    pre-trip another crew member recorded this morning is the one the fence
    reads, so the screen must show that instead of inviting a duplicate.
    """

    placeholders = ", ".join("%s" for _ in names)
    newest: dict[tuple[str, str], str] = {}
    for row in _sql_rows(
        f"""
        SELECT fleet_asset, inspection_type, performed_at, result
        FROM `tabAsset Inspection`
        WHERE fleet_asset IN ({placeholders})
          AND inspection_type IN ('Pre-Trip', 'Post-Trip')
          AND status != 'Superseded'
        """,
        tuple(names),
    ):
        asset = str(row.get("fleet_asset") or "")
        kind = str(row.get("inspection_type") or "")
        performed_at = str(row.get("performed_at") or "")
        if not asset or not kind or not performed_at:
            continue
        key = (asset, kind)
        if performed_at > newest.get(key, ""):
            newest[key] = performed_at
    return newest


def _panel_driver_authority(actor: str) -> dict[str, Any] | None:
    """The actor's own Driver Authority, preferring the one the fence accepts.

    A field user with no authority row at all is not necessarily a driver -- a
    crew member holding custody of a trailer is not -- so the panel reports no
    driver blocker for them rather than accusing every asset of an unverified
    driver.
    """

    rows = _sql_rows(
        """
        SELECT name, driver_user, status, authority_source, licence_class,
               licence_expiry, medical_expiry
        FROM `tabDriver Authority`
        WHERE driver_user = %s
        LIMIT %s
        """,
        (actor, PANEL_ASSET_LIMIT),
    )
    if not rows:
        return None
    return next((row for row in rows if row.get("status") == "Active"), rows[0])


@frappe.whitelist()
def read_driver_fleet_panel(actor_user: Any, reference_date: Any = None) -> dict[str, Any]:
    """Read one field actor's own fleet assets, with the fence's own verdict.

    This is the read side of the capture rail.  Without it the Field Companion
    can post a pre-trip but cannot tell a driver which vehicle to post it
    against, nor why dispatch will refuse the one they are standing next to.

    The scope is the actor's own assets and nothing else -- same three bindings
    the capture command proves before any write -- so the panel can no more be
    used to enumerate the fleet than the capture route can.  Readiness is not
    recomputed here: ``fleet_release_blockers`` calls the release fence itself,
    so a reason shown on a phone is the reason the schedule would give.
    """

    _assert_worker_reader()
    actor = _clean_required(actor_user, "actor_user")
    today = _panel_reference_date(reference_date)
    relationships = _panel_asset_relationships(actor)
    if not relationships:
        return {"reference_date": today, "assets": []}
    names = sorted(relationships)[:PANEL_ASSET_LIMIT]
    assets = _panel_assets(names)
    present = [name for name in names if name in assets]
    if not present:
        return {"reference_date": today, "assets": []}
    defects = _panel_open_out_of_service_defects(present)
    inspections = _panel_recent_inspections(present)
    authority = _panel_driver_authority(actor)

    panel_assets: list[dict[str, Any]] = []
    for name in present:
        asset = assets[name]
        relationship = relationships.get(name, "driver")
        # A road asset is the only kind a Driver Authority says anything about,
        # and only when this actor holds one at all.
        driver = (
            authority
            if authority is not None and asset.get("asset_kind") in FLEET_ROAD_ASSET_KINDS
            else None
        )
        blockers = fleet_release_blockers(
            asset,
            today,
            open_out_of_service_defects=defects.get(name, 0),
            driver=driver,
        )
        panel_assets.append(
            {
                **{field: asset.get(field) for field in PANEL_RESPONSE_FIELDS},
                "relationship": relationship,
                "open_out_of_service_defects": defects.get(name, 0),
                "last_pre_trip_at": inspections.get((name, "Pre-Trip")),
                "last_post_trip_at": inspections.get((name, "Post-Trip")),
                "blockers": [
                    {
                        "code": violation.code,
                        "field": violation.field,
                        "message": str(violation),
                    }
                    for violation in blockers
                ],
            }
        )
    return {"reference_date": today, "assets": panel_assets}
