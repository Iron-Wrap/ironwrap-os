"""Bounded, audited Work Package lifecycle commands.

The Field Companion never receives generic Work Package write authority.  Its
Worker integration principal may acknowledge, start, stop, and submit hold
point evidence only after this module locks the exact package and Production
assignment, proves the field actor is still enabled and assigned, and writes a
deterministic append-only event.  Releases stay an online, identity-checked
supervisory action; a worker can never release their own blocker or hold-point
evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.document_validation import (
    work_package_event_issuance_context,
    work_package_transition_context,
)
from ironwrap_roofing.domain_policy import WORK_PACKAGE_EVENT_TYPES


ISSUER_CONFIG_KEY = "ironwrap_work_package_issuer_user"
MAX_IDENTIFIER_LENGTH = 140
MAX_ROLE_LENGTH = 140
MAX_BLOCKER_REASON_LENGTH = 2_000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ACTIVE_PRODUCTION_ASSIGNMENT_STATUSES = frozenset(
    ("Assigned", "Accepted", "In Progress")
)
EVENT_MATCH_FIELDS = (
    "work_package_event_id",
    "event_type",
    "work_package",
    "roof_job",
    "job_assignment",
    "work_package_version",
    "actor_user",
    "actor_role",
    "device_action_id",
    "payload_hash",
    "hold_point_sequence",
    "evidence_item",
    "blocker_reason",
)
PACKAGE_RESPONSE_FIELDS = (
    "name",
    "work_package_id",
    "roof_job",
    "job_assignment",
    "status",
    "version",
    "expires_at",
    "acknowledged_by",
    "acknowledged_at",
    "acknowledgement_device_action_id",
    "started_at",
    "blocked_by",
    "blocked_at",
    "blocked_device_action_id",
    "blocker_reason",
)
EVENT_RESPONSE_FIELDS = ("name", "event_type", "device_action_id", "actor_user")
_EVENT_SELECT = ", ".join(("name", *EVENT_MATCH_FIELDS, "occurred_at"))


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
        _fail("work_package_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not minimum <= len(cleaned) <= maximum:
        _fail(
            "work_package_invalid_input",
            f"{field} must be {minimum}-{maximum} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("work_package_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail("work_package_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("work_package_invalid_input", f"{field} is invalid")
    return cleaned


def _clean_sequence(value: Any) -> int:
    if isinstance(value, bool):
        _fail("work_package_invalid_input", "hold_point_sequence must be an integer")
    if isinstance(value, int):
        sequence = value
    elif isinstance(value, str) and value.strip().isdigit():
        sequence = int(value.strip())
    else:
        _fail("work_package_invalid_input", "hold_point_sequence must be an integer")
    if not 1 <= sequence <= 100:
        _fail("work_package_invalid_input", "hold_point_sequence is out of range")
    return sequence


def _enabled(value: Any) -> bool:
    return value in (True, 1, "1")


def _sql_locked(query: str, values: tuple[Any, ...]) -> list[dict[str, Any]]:
    rows = frappe.db.sql(query, values, as_dict=True)
    return [dict(row) for row in rows]


def _assert_worker_issuer() -> None:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "work_package_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
    configured = _clean_optional(
        getattr(frappe, "conf", {}).get(ISSUER_CONFIG_KEY),
        ISSUER_CONFIG_KEY,
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if not configured:
        _fail(
            "work_package_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    principal = _clean_required(getattr(frappe.session, "user", None), "session_user")
    if principal == "Guest" or principal != configured:
        _fail(
            "work_package_issuer_auth_mismatch",
            "only the configured Worker integration user may issue Field actions",
            permission=True,
        )
    if not frappe.has_permission("Work Package", ptype="read", user=principal):
        _fail(
            "work_package_issuer_permission_denied",
            "the configured Worker integration user cannot read Work Package",
            permission=True,
        )
    if not frappe.has_permission("Work Package Event", ptype="create", user=principal):
        _fail(
            "work_package_issuer_permission_denied",
            "the configured Worker integration user cannot create Work Package Event",
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
            "work_package_actor_not_enabled",
            "actor_user must be an enabled User",
            permission=True,
        )


def _lock_work_package(work_package_id: str) -> Any:
    rows = _sql_locked(
        """
        SELECT name, work_package_id
        FROM `tabWork Package`
        WHERE work_package_id = %s
        FOR UPDATE
        """,
        (work_package_id,),
    )
    if len(rows) != 1:
        _fail(
            "work_package_not_found",
            "work_package_id must identify exactly one Work Package",
        )
    package = frappe.get_doc("Work Package", rows[0]["name"])
    if _value(package, "work_package_id") != work_package_id:
        _fail("work_package_identity_conflict", "locked Work Package identity changed")
    return package


def _lock_assignment(
    package: Any,
    roof_job_id: str,
    job_assignment_id: str,
) -> dict[str, Any]:
    rows = _sql_locked(
        """
        SELECT name, assignment_id, roof_job, assignment_type, status,
               crew_profile, assigned_user, scheduled_start, supersedes
        FROM `tabJob Assignment`
        WHERE name = %s OR assignment_id = %s
        FOR UPDATE
        """,
        (job_assignment_id, job_assignment_id),
    )
    if len(rows) != 1:
        _fail(
            "work_package_assignment_not_found",
            "job_assignment_id must identify exactly one Job Assignment",
        )
    assignment = rows[0]
    references = {assignment.get("name"), assignment.get("assignment_id")}
    if (
        _value(package, "roof_job") != roof_job_id
        or assignment.get("roof_job") != roof_job_id
        or _value(package, "job_assignment") not in references
        or job_assignment_id not in references
    ):
        _fail(
            "work_package_assignment_mismatch",
            "Work Package, Roof Job, and Job Assignment must match exactly",
        )
    if assignment.get("assignment_type") != "Production":
        _fail(
            "work_package_assignment_not_production",
            "Work Package actions require a Production Job Assignment",
        )
    if assignment.get("status") not in ACTIVE_PRODUCTION_ASSIGNMENT_STATUSES:
        _fail(
            "work_package_assignment_inactive",
            "the Production Job Assignment is not active",
        )
    if not assignment.get("scheduled_start"):
        _fail(
            "work_package_assignment_unscheduled",
            "the Production Job Assignment must be scheduled",
        )

    scoped_rows = _sql_locked(
        """
        SELECT name, assignment_id, supersedes
        FROM `tabJob Assignment`
        WHERE roof_job = %s
        FOR UPDATE
        """,
        (roof_job_id,),
    )
    if any(row.get("supersedes") in references for row in scoped_rows):
        _fail(
            "work_package_assignment_superseded",
            "the Production Job Assignment has been superseded",
        )
    return assignment


def _assert_package_current_and_unexpired(package: Any) -> None:
    package_references = {
        value
        for value in (_value(package, "name"), _value(package, "work_package_id"))
        if value
    }
    rows = _sql_locked(
        """
        SELECT name, work_package_id, supersedes
        FROM `tabWork Package`
        WHERE roof_job = %s
        FOR UPDATE
        """,
        (_value(package, "roof_job"),),
    )
    if any(row.get("supersedes") in package_references for row in rows):
        _fail(
            "work_package_superseded",
            "a superseded Work Package cannot receive Field actions",
        )
    expires_at = _value(package, "expires_at")
    if not expires_at:
        _fail("work_package_invalid_expiry", "Work Package expires_at is required")
    if str(frappe.utils.now_datetime()) >= str(expires_at):
        _fail(
            "work_package_expired",
            "an expired Work Package cannot receive Field actions",
        )


def _assert_actor_is_assigned(
    assignment: Mapping[str, Any], actor_user: str
) -> str:
    _lock_enabled_user(actor_user)
    if assignment.get("assigned_user") == actor_user:
        return "Production direct assignment"

    crew_profile = assignment.get("crew_profile")
    if not crew_profile:
        _fail(
            "work_package_actor_not_assigned",
            "actor_user is not directly assigned and no active crew is assigned",
            permission=True,
        )
    crews = _sql_locked(
        """
        SELECT name, status
        FROM `tabCrew Profile`
        WHERE name = %s
        FOR UPDATE
        """,
        (crew_profile,),
    )
    if len(crews) != 1 or crews[0].get("status") != "Active":
        _fail(
            "work_package_crew_inactive",
            "the assigned Crew Profile is not active",
            permission=True,
        )
    members = _sql_locked(
        """
        SELECT parent, crew_user, crew_role, active
        FROM `tabCrew Member`
        WHERE parent = %s
          AND crew_user = %s
          AND active = 1
        FOR UPDATE
        """,
        (crew_profile, actor_user),
    )
    if len(members) != 1 or not _enabled(members[0].get("active")):
        _fail(
            "work_package_actor_not_assigned",
            "actor_user is not an active member of the assigned crew",
            permission=True,
        )
    crew_role = _clean_required(
        members[0].get("crew_role"), "crew_role", maximum=MAX_ROLE_LENGTH
    )
    return f"Production crew assignment ({crew_role})"


def _event_id(device_action_id: str) -> str:
    digest = hashlib.sha256(device_action_id.encode("utf-8")).hexdigest()
    return f"wpe_{digest[:32]}"


def _payload_hash(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _event_document(
    *,
    package: Any,
    event_type: str,
    actor_user: str,
    actor_role: str,
    device_action_id: str,
    blocker_reason: str | None = None,
    hold_point_sequence: int | None = None,
    evidence_item: str | None = None,
) -> dict[str, Any]:
    if event_type not in WORK_PACKAGE_EVENT_TYPES:
        _fail("work_package_event_type_invalid", "unsupported Work Package event")
    payload = {
        "event_type": event_type,
        "work_package": _value(package, "name"),
        "work_package_id": _value(package, "work_package_id"),
        "roof_job": _value(package, "roof_job"),
        "job_assignment": _value(package, "job_assignment"),
        "work_package_version": int(_value(package, "version")),
        "actor_user": actor_user,
        "actor_role": actor_role,
        "device_action_id": device_action_id,
        "hold_point_sequence": hold_point_sequence,
        "evidence_item": evidence_item,
        "blocker_reason": blocker_reason,
    }
    return {
        "doctype": "Work Package Event",
        "work_package_event_id": _event_id(device_action_id),
        "event_type": event_type,
        "work_package": _value(package, "name"),
        "roof_job": _value(package, "roof_job"),
        "job_assignment": _value(package, "job_assignment"),
        "work_package_version": int(_value(package, "version")),
        "actor_user": actor_user,
        "actor_role": actor_role,
        "device_action_id": device_action_id,
        "occurred_at": str(frappe.utils.now_datetime()),
        "payload_hash": _payload_hash(payload),
        "hold_point_sequence": hold_point_sequence,
        "evidence_item": evidence_item,
        "blocker_reason": blocker_reason,
    }


def _lock_existing_event(device_action_id: str) -> dict[str, Any] | None:
    rows = _sql_locked(
        f"""
        SELECT {_EVENT_SELECT}
        FROM `tabWork Package Event`
        WHERE device_action_id = %s
        FOR UPDATE
        """,
        (device_action_id,),
    )
    if len(rows) > 1:
        _fail(
            "work_package_event_identity_conflict",
            "device_action_id is not unique",
        )
    return rows[0] if rows else None


def _same_value(left: Any, right: Any) -> bool:
    if left is None or left == "":
        return right is None or right == ""
    if right is None or right == "":
        return left is None or left == ""
    return str(left) == str(right)


def _same_event(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    payload_hash = existing.get("payload_hash")
    return (
        isinstance(payload_hash, str)
        and SHA256_RE.fullmatch(payload_hash) is not None
        and all(
            _same_value(existing.get(field), expected.get(field))
            for field in EVENT_MATCH_FIELDS
        )
    )


def _insert_event(values: Mapping[str, Any]) -> Any:
    event = frappe.get_doc(dict(values))
    with work_package_event_issuance_context(event):
        # The integration user still needs its narrow create grant.  The
        # ContextVar prevents this grant from becoming a generic event writer.
        event.insert()
    return event


def _save_transition(package: Any) -> None:
    with work_package_transition_context(package):
        # Field actors deliberately do not receive generic Work Package write
        # permission.  The preceding lock, authorization, and private context
        # make this one exact server-side lifecycle mutation safe.
        package.save(ignore_permissions=True)


def _package_response(package: Any) -> dict[str, Any]:
    return {field: _value(package, field) for field in PACKAGE_RESPONSE_FIELDS}


def _event_response(event: Mapping[str, Any] | Any) -> dict[str, Any]:
    return {field: _value(event, field) for field in EVENT_RESPONSE_FIELDS}


def _result(package: Any, event: Mapping[str, Any] | Any, replay: bool) -> dict[str, Any]:
    return {
        "work_package": _package_response(package),
        "event": _event_response(event),
        "idempotent_replay": replay,
    }


def _worker_action(
    *,
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
    event_type: str,
    blocker_reason: Any = None,
) -> tuple[Any, dict[str, Any], str, str, str, dict[str, Any] | None]:
    _assert_worker_issuer()
    package_id = _clean_required(work_package_id, "work_package_id")
    roof_job = _clean_required(roof_job_id, "roof_job_id")
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    reason = _clean_optional(
        blocker_reason, "blocker_reason", maximum=MAX_BLOCKER_REASON_LENGTH
    )
    package = _lock_work_package(package_id)
    assignment = _lock_assignment(package, roof_job, assignment_id)
    actor_role = _assert_actor_is_assigned(assignment, actor)
    _assert_package_current_and_unexpired(package)
    expected_event = _event_document(
        package=package,
        event_type=event_type,
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        blocker_reason=reason,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not _same_event(existing_event, expected_event):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable facts",
            )
        return package, assignment, actor, actor_role, reason or "", existing_event
    return package, assignment, actor, actor_role, reason or "", None


def _require_status(package: Any, *allowed: str) -> None:
    status = _value(package, "status")
    if status not in allowed:
        _fail(
            "work_package_transition_conflict",
            f"expected status {', '.join(allowed)}; found {status or 'missing'}",
        )


@frappe.whitelist()
def acknowledge_work_package(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
) -> dict[str, Any]:
    """Acknowledge one current, unexpired released Work Package."""

    package, _assignment, actor, actor_role, _reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        event_type="Acknowledged",
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Released")
    if any(
        _value(package, field)
        for field in (
            "acknowledged_by",
            "acknowledged_at",
            "acknowledgement_device_action_id",
        )
    ):
        _fail(
            "work_package_acknowledgement_conflict",
            "Released Work Package already has acknowledgement attribution",
        )
    occurred_at = str(frappe.utils.now_datetime())
    package.set("status", "Acknowledged")
    package.set("acknowledged_by", actor)
    package.set("acknowledged_at", occurred_at)
    package.set("acknowledgement_device_action_id", _clean_required(
        device_action_id, "device_action_id", minimum=8
    ))
    _save_transition(package)
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Acknowledged",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=_clean_required(
                device_action_id, "device_action_id", minimum=8
            ),
        )
    )
    return _result(package, event, False)


@frappe.whitelist()
def start_work(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
) -> dict[str, Any]:
    """Start work online after the same field actor acknowledged the package."""

    package, _assignment, actor, actor_role, _reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        event_type="Started",
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Acknowledged")
    if _value(package, "acknowledged_by") != actor:
        _fail(
            "work_package_acknowledgement_actor_mismatch",
            "only the acknowledging field actor may start this Work Package",
            permission=True,
        )
    if not _value(package, "acknowledgement_device_action_id"):
        _fail(
            "work_package_acknowledgement_missing",
            "acknowledgement attribution is required before start",
        )
    _assert_all_hold_points_released(package)
    package.set("status", "In Progress")
    package.set("started_at", str(frappe.utils.now_datetime()))
    _save_transition(package)
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Started",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=_clean_required(
                device_action_id, "device_action_id", minimum=8
            ),
        )
    )
    return _result(package, event, False)


@frappe.whitelist()
def stop_work(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
    blocker_reason: Any,
) -> dict[str, Any]:
    """Record a worker stop/make-safe decision and durable blocker attribution."""

    package, _assignment, actor, actor_role, reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        event_type="Stop Work",
        blocker_reason=blocker_reason,
    )
    if replay:
        return _result(package, replay, True)
    if not reason:
        _fail("work_package_invalid_input", "blocker_reason is required")
    _require_status(package, "Released", "Acknowledged", "In Progress")
    if any(
        _value(package, field)
        for field in ("blocked_by", "blocked_at", "blocked_device_action_id")
    ):
        _fail(
            "work_package_stop_conflict",
            "Work Package already has blocker attribution",
        )
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    package.set("status", "Blocked")
    package.set("blocked_by", actor)
    package.set("blocked_at", str(frappe.utils.now_datetime()))
    package.set("blocked_device_action_id", device_action)
    package.set("blocker_reason", reason)
    _save_transition(package)
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Stop Work",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=device_action,
            blocker_reason=reason,
        )
    )
    return _result(package, event, False)


def _assert_direct_release_actor(package: Any, actor_user: Any) -> tuple[str, str]:
    """Require an online Production/Owner identity for an independent release."""

    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "work_package_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
    actor = _clean_required(actor_user, "actor_user")
    session_user = _clean_required(
        getattr(frappe.session, "user", None), "session_user"
    )
    if actor == "Guest" or session_user != actor:
        _fail(
            "work_package_direct_actor_mismatch",
            "release requires the acting Frappe user to match actor_user",
            permission=True,
        )
    _lock_enabled_user(actor)
    if not frappe.has_permission(
        "Work Package", ptype="write", user=actor, doc=package
    ):
        _fail(
            "work_package_release_permission_denied",
            "actor_user cannot write this Work Package",
            permission=True,
        )
    if not frappe.has_permission("Work Package Event", ptype="create", user=actor):
        _fail(
            "work_package_release_permission_denied",
            "actor_user cannot append Work Package Events",
            permission=True,
        )
    roles = set(frappe.get_roles(actor))
    release_roles = ("IronWrap Owner", "IronWrap Production", "System Manager")
    role = next((candidate for candidate in release_roles if candidate in roles), None)
    if role is None:
        _fail(
            "work_package_release_role_denied",
            "release requires an IronWrap Owner or Production role",
            permission=True,
        )
    return actor, role


def _direct_action(
    *,
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
    event_type: str,
    blocker_reason: str | None = None,
    hold_point_sequence: int | None = None,
    evidence_item: str | None = None,
    normalize_evidence_item: bool = False,
) -> tuple[Any, str, str, dict[str, Any] | None, str | None]:
    package_id = _clean_required(work_package_id, "work_package_id")
    roof_job = _clean_required(roof_job_id, "roof_job_id")
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    package = _lock_work_package(package_id)
    actor, actor_role = _assert_direct_release_actor(package, actor_user)
    _lock_assignment(package, roof_job, assignment_id)
    _assert_package_current_and_unexpired(package)
    if normalize_evidence_item:
        if evidence_item is None:
            _fail("work_package_invalid_input", "evidence_item_id is required")
        evidence_item, _capture_actor = _lock_releasable_evidence(
            evidence_item, roof_job
        )
    expected_event = _event_document(
        package=package,
        event_type=event_type,
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        blocker_reason=blocker_reason,
        hold_point_sequence=hold_point_sequence,
        evidence_item=evidence_item,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not _same_event(existing_event, expected_event):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable facts",
            )
        return package, actor, actor_role, existing_event, evidence_item
    return package, actor, actor_role, None, evidence_item


@frappe.whitelist()
def release_work_package(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
) -> dict[str, Any]:
    """Release a Draft or independently resume a Blocked Work Package online."""

    package, actor, actor_role, replay, _evidence_item = _direct_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        event_type="Released",
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Draft", "Blocked")
    if _value(package, "status") == "Blocked":
        blocked_by = _value(package, "blocked_by")
        if not blocked_by:
            _fail(
                "work_package_blocker_attribution_missing",
                "Blocked Work Package must identify its field actor",
            )
        if blocked_by == actor:
            _fail(
                "work_package_independent_release_required",
                "the actor who stopped work cannot release that Work Package",
                permission=True,
            )
        # The immutable events retain the previous execution attempt.  A
        # release creates a fresh field acknowledgement/start/stop cycle.
        for field in (
            "acknowledged_by",
            "acknowledged_at",
            "acknowledgement_device_action_id",
            "started_at",
            "blocked_by",
            "blocked_at",
            "blocked_device_action_id",
            "blocker_reason",
        ):
            package.set(field, None)
    else:
        if _value(package, "released_by") or _value(package, "released_at"):
            _fail(
                "work_package_release_conflict",
                "Draft Work Package already has release attribution",
            )
        package.set("released_by", actor)
        package.set("released_at", str(frappe.utils.now_datetime()))
    package.set("status", "Released")
    _save_transition(package)
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Released",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=_clean_required(
                device_action_id, "device_action_id", minimum=8
            ),
        )
    )
    return _result(package, event, False)


def _find_hold_point(package: Any, sequence: int) -> Any:
    for row in _value(package, "hold_points") or []:
        value = _value(row, "sequence")
        try:
            row_sequence = int(value)
        except (TypeError, ValueError):
            continue
        if row_sequence == sequence:
            return row
    _fail(
        "work_package_hold_point_not_found",
        "hold_point_sequence does not belong to this Work Package",
    )


def _hold_point_sequences(package: Any) -> set[int]:
    rows = _value(package, "hold_points") or []
    sequences = {_clean_sequence(_value(row, "sequence")) for row in rows}
    if not rows or len(sequences) != len(rows):
        _fail(
            "work_package_hold_point_integrity",
            "Work Package hold points must have unique sequences",
        )
    return sequences


def _lock_released_hold_point_sequences(package: Any) -> set[int]:
    rows = _sql_locked(
        """
        SELECT hold_point_sequence
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND work_package_version = %s
          AND event_type = 'Hold Point Released'
        FOR UPDATE
        """,
        (_value(package, "name"), int(_value(package, "version"))),
    )
    required = _hold_point_sequences(package)
    released: set[int] = set()
    for row in rows:
        sequence = _clean_sequence(row.get("hold_point_sequence"))
        if sequence not in required or sequence in released:
            _fail(
                "work_package_hold_point_release_integrity",
                "hold point release events must map once to this Work Package",
            )
        released.add(sequence)
    return released


def _assert_all_hold_points_released(package: Any) -> None:
    if _hold_point_sequences(package) != _lock_released_hold_point_sequences(package):
        _fail(
            "work_package_hold_points_pending",
            "all Work Package hold points require independent release before start",
        )


def _lock_releasable_evidence(
    evidence_item_id: str, roof_job_id: str
) -> tuple[str, str | None]:
    rows = _sql_locked(
        """
        SELECT name, evidence_id, roof_job, sync_state, capture_actor
        FROM `tabEvidence Item`
        WHERE name = %s OR evidence_id = %s
        FOR UPDATE
        """,
        (evidence_item_id, evidence_item_id),
    )
    if len(rows) != 1:
        _fail(
            "work_package_evidence_not_found",
            "evidence_item_id must identify exactly one Evidence Item",
        )
    evidence = rows[0]
    if (
        evidence.get("roof_job") != roof_job_id
        or evidence.get("sync_state") != "Verified"
    ):
        _fail(
            "work_package_evidence_mismatch",
            "hold-point evidence must be verified and bound to the Work Package job",
        )
    return (
        _clean_required(evidence.get("name"), "evidence_item_name"),
        _clean_optional(
            evidence.get("capture_actor"),
            "capture_actor",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
    )


def _lock_verified_evidence(
    evidence_item_id: str, roof_job_id: str, actor_user: str
) -> str:
    evidence_name, capture_actor = _lock_releasable_evidence(
        evidence_item_id, roof_job_id
    )
    if capture_actor != actor_user:
        _fail(
            "work_package_evidence_mismatch",
            "hold-point evidence must be captured by actor_user",
        )
    return evidence_name


@frappe.whitelist()
def submit_hold_point_evidence(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
    hold_point_sequence: Any,
    evidence_item_id: Any,
) -> dict[str, Any]:
    """Append worker-submitted evidence; it never releases the hold point."""

    _assert_worker_issuer()
    package_id = _clean_required(work_package_id, "work_package_id")
    roof_job = _clean_required(roof_job_id, "roof_job_id")
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    sequence = _clean_sequence(hold_point_sequence)
    evidence_id = _clean_required(evidence_item_id, "evidence_item_id")
    package = _lock_work_package(package_id)
    assignment = _lock_assignment(package, roof_job, assignment_id)
    actor_role = _assert_actor_is_assigned(assignment, actor)
    _assert_package_current_and_unexpired(package)
    _require_status(package, "Acknowledged", "In Progress")
    _find_hold_point(package, sequence)
    evidence_name = _lock_verified_evidence(evidence_id, roof_job, actor)
    expected_event = _event_document(
        package=package,
        event_type="Hold Point Evidence",
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        hold_point_sequence=sequence,
        evidence_item=evidence_name,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not _same_event(existing_event, expected_event):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable facts",
            )
        return _result(package, existing_event, True)
    event = _insert_event(expected_event)
    return _result(package, event, False)


def _assert_hold_point_release_authority(hold_point: Any, actor_user: str) -> None:
    authority = _clean_required(
        _value(hold_point, "release_authority"),
        "release_authority",
        maximum=MAX_ROLE_LENGTH,
    )
    if authority == actor_user:
        return
    if authority in set(frappe.get_roles(actor_user)):
        return
    _fail(
        "work_package_hold_point_authority_denied",
        "actor_user does not hold this hold point's release authority",
        permission=True,
    )


def _lock_hold_evidence_events(
    package: Any, sequence: int, evidence_item: str
) -> list[dict[str, Any]]:
    rows = _sql_locked(
        """
        SELECT name, actor_user, evidence_item
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND event_type = 'Hold Point Evidence'
          AND hold_point_sequence = %s
        FOR UPDATE
        """,
        (_value(package, "name"), sequence),
    )
    return [row for row in rows if row.get("evidence_item") == evidence_item]


@frappe.whitelist()
def release_hold_point(
    work_package_id: Any,
    roof_job_id: Any,
    job_assignment_id: Any,
    actor_user: Any,
    device_action_id: Any,
    hold_point_sequence: Any,
    evidence_item_id: Any,
) -> dict[str, Any]:
    """Independently release a hold point after a worker submitted evidence."""

    sequence = _clean_sequence(hold_point_sequence)
    evidence_id = _clean_required(evidence_item_id, "evidence_item_id")
    package, actor, actor_role, replay, evidence_name = _direct_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        event_type="Hold Point Released",
        hold_point_sequence=sequence,
        evidence_item=evidence_id,
        normalize_evidence_item=True,
    )
    if replay:
        return _result(package, replay, True)
    evidence_name = _clean_required(evidence_name, "evidence_item_name")
    _require_status(package, "Acknowledged", "In Progress")
    hold_point = _find_hold_point(package, sequence)
    _assert_hold_point_release_authority(hold_point, actor)
    if sequence in _lock_released_hold_point_sequences(package):
        _fail(
            "work_package_hold_point_already_released",
            "that hold point already has an independent release",
        )
    evidence_rows = _lock_hold_evidence_events(package, sequence, evidence_name)
    if not any(row.get("actor_user") != actor for row in evidence_rows):
        _fail(
            "work_package_independent_release_required",
            "hold point release requires evidence submitted by another field actor",
            permission=True,
        )
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Hold Point Released",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=_clean_required(
                device_action_id, "device_action_id", minimum=8
            ),
            hold_point_sequence=sequence,
            evidence_item=evidence_name,
        )
    )
    return _result(package, event, False)
