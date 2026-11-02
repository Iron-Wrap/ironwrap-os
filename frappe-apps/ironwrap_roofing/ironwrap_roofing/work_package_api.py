"""Bounded, audited Work Package lifecycle commands.

The Field Companion never receives generic Work Package write authority.  Its
Worker integration principal may acknowledge, start, stop, submit hold-point
evidence, and carry a separately authorized production completion request only
after this module locks the exact package and Production assignment, proves
the actor and immutable evidence facts, and writes a deterministic append-only
event. Releases stay an online, identity-checked supervisory action; a worker
can never release their own blocker or hold-point evidence.
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
from ironwrap_roofing.domain_policy import (
    WORK_PACKAGE_EVENT_TYPES,
    WORK_PACKAGE_HOLD_RELEASE_PHASES,
)


ISSUER_CONFIG_KEY = "ironwrap_work_package_issuer_user"
MAX_IDENTIFIER_LENGTH = 140
MAX_ROLE_LENGTH = 140
MAX_BLOCKER_REASON_LENGTH = 2_000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ACTIVE_PRODUCTION_ASSIGNMENT_STATUSES = frozenset(
    ("Assigned", "Accepted", "In Progress")
)
GENERIC_PHYSICAL_ASSIGNMENT_TYPES = frozenset(
    ("Field", "Service", "Shop", "Warehouse", "Delivery", "Fleet", "Facility")
)
EVENT_MATCH_FIELDS = (
    "work_package_event_id",
    "event_type",
    "work_package",
    "roof_job",
    "job_assignment",
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
    "work_package_version",
    "release_attempt_id",
    "actor_user",
    "actor_role",
    "device_action_id",
    "payload_hash",
    "hold_point_sequence",
    "evidence_item",
    "blocker_reason",
    "evidence_slot_id",
    "evidence_requirement",
    "evidence_source",
    "evidence_device_id",
    "evidence_captured_at",
    "evidence_freshness",
    "evidence_conflict_state",
    "evidence_correction_of",
    "evidence_item_correction_of",
    "evidence_review_of",
    "evidence_verification",
    "evidence_disposition",
    "correction_reason",
)
PACKAGE_RESPONSE_FIELDS = (
    "name",
    "work_package_id",
    "roof_job",
    "job_assignment",
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
    "status",
    "version",
    "release_attempt_id",
    "expires_at",
    "acknowledged_by",
    "acknowledged_at",
    "acknowledgement_device_action_id",
    "started_at",
    "completed_at",
    "blocked_by",
    "blocked_at",
    "blocked_device_action_id",
    "blocker_reason",
)
EVENT_RESPONSE_FIELDS = (
    "name",
    "event_type",
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
    "device_action_id",
    "actor_user",
    "release_attempt_id",
)
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


def _clean_version(value: Any) -> int:
    if isinstance(value, bool):
        _fail("work_package_invalid_input", "work_package_version must be an integer")
    if isinstance(value, int):
        version = value
    elif isinstance(value, str) and value.strip().isdigit():
        version = int(value.strip())
    else:
        _fail("work_package_invalid_input", "work_package_version must be an integer")
    if version < 1:
        _fail("work_package_invalid_input", "work_package_version must be positive")
    return version


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


def _package_parent_context(package: Any) -> dict[str, str]:
    """Return the explicit parent/context envelope or the legacy roof adapter."""

    fields = (
        "work_object_type",
        "work_object_id",
        "physical_context_type",
        "physical_context_id",
    )
    values = {
        field: _clean_optional(_value(package, field), field, maximum=MAX_IDENTIFIER_LENGTH)
        for field in fields
    }
    if not any(values.values()):
        roof_job = _clean_optional(
            _value(package, "roof_job"), "roof_job", maximum=MAX_IDENTIFIER_LENGTH
        )
        if not roof_job:
            _fail(
                "work_package_parent_context_missing",
                "a Work Package requires exactly one parent work object and physical context",
            )
        return {
            "work_object_type": "Roof Job",
            "work_object_id": roof_job,
            "physical_context_type": "Roof Site",
            "physical_context_id": roof_job,
        }
    if not all(values.values()):
        _fail(
            "work_package_parent_context_incomplete",
            "work_object_type/id and physical_context_type/id must be supplied together",
        )
    return {field: str(values[field]) for field in fields}


def _normalize_package_scope(
    package: Any,
    supplied_scope: Any,
    *,
    supplied_work_object_type: Any = None,
    supplied_work_object_id: Any = None,
    supplied_physical_context_type: Any = None,
    supplied_physical_context_id: Any = None,
) -> str | None:
    """Canonicalize the legacy Roof Job argument or generic work-object scope.

    The public argument remains named ``roof_job_id`` for old Worker clients,
    but a non-roof package carries its own typed parent/context envelope.  The
    supplied value is only compared to that immutable envelope; it is never
    dereferenced as a Roof Job.  This keeps old clients safe while allowing a
    real Field/Service/Shop/etc. adapter to execute without a fake Roof Job.
    """

    supplied = _clean_optional(
        supplied_scope,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    context = _package_parent_context(package)
    supplied_context = {
        "work_object_type": _clean_optional(
            supplied_work_object_type,
            "work_object_type",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
        "work_object_id": _clean_optional(
            supplied_work_object_id,
            "work_object_id",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
        "physical_context_type": _clean_optional(
            supplied_physical_context_type,
            "physical_context_type",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
        "physical_context_id": _clean_optional(
            supplied_physical_context_id,
            "physical_context_id",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
    }
    if any(supplied_context.values()):
        if not all(supplied_context.values()) or any(
            supplied_context[field] != context[field] for field in supplied_context
        ):
            _fail(
                "work_package_context_mismatch",
                "the supplied typed work-object/context envelope does not match the immutable package",
            )
        if supplied and supplied != context["work_object_id"]:
            _fail(
                "work_package_context_mismatch",
                "the supplied work scope does not match the frozen parent work object",
            )
        return context["work_object_id"] if context["work_object_type"] == "Roof Job" else None
    package_roof_job = _clean_optional(
        _value(package, "roof_job"),
        "roof_job",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if context["work_object_type"] == "Roof Job":
        if (
            not package_roof_job
            or context["work_object_id"] != package_roof_job
            or context["physical_context_type"] != "Roof Site"
            or (supplied and supplied != package_roof_job)
        ):
            _fail(
                "work_package_context_adapter_unavailable",
                "the Roof Job/Roof Site adapter requires one matching Roof Job scope",
            )
        return package_roof_job
    if package_roof_job:
        _fail(
            "work_package_context_adapter_unavailable",
            "a non-roof physical adapter cannot carry a Roof Job parent",
        )
    if supplied and supplied != context["work_object_id"]:
        _fail(
            "work_package_context_mismatch",
            "the supplied work scope does not match the frozen parent work object",
        )
    return None


def _lock_assignment(
    package: Any,
    roof_job_id: str | None,
    job_assignment_id: str,
) -> dict[str, Any]:
    rows = _sql_locked(
        """
        SELECT name, assignment_id, roof_job, assignment_type, status,
               crew_profile, assigned_user, assigned_by, assigned_at,
               authority_user, authority_role,
               work_object_type, work_object_id,
               physical_context_type, physical_context_id,
               scheduled_start, supersedes
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
    context = _package_parent_context(package)
    if (
        _value(package, "job_assignment") not in references
        or job_assignment_id not in references
    ):
        _fail(
            "work_package_assignment_mismatch",
            "Work Package and Job Assignment must match exactly",
        )
    assignment_context = {
        field: _clean_optional(
            assignment.get(field),
            field,
            maximum=MAX_IDENTIFIER_LENGTH,
        )
        for field in (
            "work_object_type",
            "work_object_id",
            "physical_context_type",
            "physical_context_id",
        )
    }
    if context["work_object_type"] == "Roof Job":
        if (
            not roof_job_id
            or _value(package, "roof_job") != roof_job_id
            or assignment.get("roof_job") != roof_job_id
        ):
            _fail(
                "work_package_assignment_mismatch",
                "Roof Job, Work Package, and Job Assignment must match exactly",
            )
    elif (
        assignment.get("roof_job")
        or any(assignment_context[field] != context[field] for field in assignment_context)
    ):
        _fail(
            "work_package_assignment_mismatch",
            "the physical assignment must read back the exact Work Package parent/context",
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

    if context["work_object_type"] != "Roof Job":
        assignment_type = _clean_required(
            assignment.get("assignment_type"),
            "assignment_type",
            maximum=MAX_ROLE_LENGTH,
        )
        if assignment_type not in GENERIC_PHYSICAL_ASSIGNMENT_TYPES:
            _fail(
                "work_package_context_adapter_unavailable",
                "the non-roof assignment type has no canonical physical-work adapter",
            )
        if not assignment.get("authority_user") or not assignment.get("authority_role"):
            _fail(
                "work_package_assignment_authority_missing",
                "a non-roof assignment must read back an explicit authority user and role",
            )
        return assignment

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


def _lock_roof_job_production_assignment(
    package: Any,
    roof_job_id: str,
    job_assignment_id: str,
) -> dict[str, Any]:
    """Lock either the Roof Job adapter or one typed physical-work adapter."""

    scope = _normalize_package_scope(package, roof_job_id)
    assignment = _lock_assignment(package, scope, job_assignment_id)
    if _package_parent_context(package)["work_object_type"] == "Roof Job" and assignment.get("assignment_type") != "Production":
        _fail(
            "work_package_assignment_not_production",
            "the Roof Job adapter requires a Production Job Assignment",
        )
    return assignment


def _assert_physical_assignment_authority(
    package: Any,
    assignment: Mapping[str, Any],
    actor_user: str,
) -> str | None:
    if _package_parent_context(package)["work_object_type"] == "Roof Job":
        return None
    authority_user = str(assignment.get("authority_user") or "")
    if actor_user.casefold() != authority_user.casefold():
        _fail(
            "work_package_assignment_authority_mismatch",
            "the actor must match the immutable physical assignment authority",
            permission=True,
        )
    authority_role = str(assignment.get("authority_role") or "")
    if (
        authority_role not in {"IronWrap Owner", "IronWrap Production"}
        or authority_role not in set(frappe.get_roles(actor_user))
    ):
        _fail(
            "work_package_assignment_authority_role_mismatch",
            "the immutable physical assignment authority role must match the actor's current Owner or Production role",
            permission=True,
        )
    return authority_role


def _assert_package_current_and_unexpired(package: Any) -> None:
    package_references = {
        value
        for value in (_value(package, "name"), _value(package, "work_package_id"))
        if value
    }
    context = _package_parent_context(package)
    if context["work_object_type"] == "Roof Job":
        query = """
            SELECT name, work_package_id, supersedes
            FROM `tabWork Package`
            WHERE roof_job = %s
            FOR UPDATE
        """
        values = (context["work_object_id"],)
    else:
        query = """
            SELECT name, work_package_id, supersedes
            FROM `tabWork Package`
            WHERE work_object_type = %s
              AND work_object_id = %s
            FOR UPDATE
        """
        values = (context["work_object_type"], context["work_object_id"])
    rows = _sql_locked(query, values)
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
    declared_workers = assignment.get("assigned_workers")
    if isinstance(declared_workers, (list, tuple)):
        for member in declared_workers:
            if (
                _clean_optional(
                    _value(member, "worker_user"),
                    "worker_user",
                    maximum=MAX_IDENTIFIER_LENGTH,
                )
                == actor_user
            ):
                return _clean_required(
                    _value(member, "worker_role"),
                    "worker_role",
                    maximum=MAX_ROLE_LENGTH,
                )
    if (
        assignment.get("name")
        and assignment.get("assignment_type") in GENERIC_PHYSICAL_ASSIGNMENT_TYPES
    ):
        members = _sql_locked(
            """
            SELECT parent, worker_user, worker_role, required
            FROM `tabWork Package Worker`
            WHERE parent = %s
              AND parenttype = 'Job Assignment'
              AND worker_user = %s
            FOR UPDATE
            """,
            (assignment.get("name"), actor_user),
        )
        if len(members) == 1:
            return _clean_required(
                members[0].get("worker_role"),
                "worker_role",
                maximum=MAX_ROLE_LENGTH,
            )
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
    # The frozen roster stores the crew's declared role verbatim.  Persist the
    # same identity on every worker event so the read model can bind the event
    # to the exact roster row instead of comparing two different labels.
    return crew_role


def _event_id(device_action_id: str) -> str:
    digest = hashlib.sha256(device_action_id.encode("utf-8")).hexdigest()
    return f"wpe_{digest[:32]}"


def _current_release_attempt(package: Any) -> str:
    """Return the package's exact immutable Released event identity."""

    release_attempt = _clean_optional(
        _value(package, "release_attempt_id"),
        "release_attempt_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if not release_attempt:
        _fail(
            "work_package_release_attempt_missing",
            "the current Work Package release attempt is unknown; refresh or issue a superseding package",
        )
    rows = _sql_locked(
        """
        SELECT name, work_package_event_id, event_type, work_package,
               roof_job, job_assignment, work_package_version,
               work_object_type, work_object_id,
               physical_context_type, physical_context_id
        FROM `tabWork Package Event`
        WHERE name = %s OR work_package_event_id = %s
        FOR UPDATE
        """,
        (release_attempt, release_attempt),
    )
    if len(rows) != 1:
        _fail(
            "work_package_release_attempt_missing",
            "the current Work Package release attempt cannot be verified",
        )
    event = rows[0]
    context = _package_parent_context(package)
    typed_context_mismatch = context["work_object_type"] != "Roof Job" and any(
        event.get(field) != context[field]
        for field in (
            "work_object_type",
            "work_object_id",
            "physical_context_type",
            "physical_context_id",
        )
    )
    if (
        event.get("event_type") != "Released"
        or event.get("work_package") != _value(package, "name")
        or event.get("roof_job") != _value(package, "roof_job")
        or typed_context_mismatch
        or event.get("job_assignment") not in {_value(package, "job_assignment")}
        or str(event.get("work_package_version")) != str(_value(package, "version"))
        or release_attempt not in {event.get("name"), event.get("work_package_event_id")}
    ):
        _fail(
            "work_package_release_attempt_conflict",
            "the current release attempt is not bound to this exact Work Package",
        )
    return str(event.get("name") or release_attempt)


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
    evidence_slot_id: str | None = None,
    evidence_requirement: str | None = None,
    evidence_source: str | None = None,
    evidence_device_id: str | None = None,
    evidence_captured_at: str | None = None,
    evidence_freshness: str | None = None,
    evidence_conflict_state: str | None = None,
    evidence_correction_of: str | None = None,
    evidence_item_correction_of: str | None = None,
    evidence_review_of: str | None = None,
    evidence_verification: str | None = None,
    evidence_disposition: str | None = None,
    correction_reason: str | None = None,
    release_attempt_id: str | None = None,
) -> dict[str, Any]:
    if event_type not in WORK_PACKAGE_EVENT_TYPES:
        _fail("work_package_event_type_invalid", "unsupported Work Package event")
    payload = {
        "event_type": event_type,
        "work_package": _value(package, "name"),
        "work_package_id": _value(package, "work_package_id"),
        "roof_job": _value(package, "roof_job"),
        "job_assignment": _value(package, "job_assignment"),
        "work_object_type": _value(package, "work_object_type"),
        "work_object_id": _value(package, "work_object_id"),
        "physical_context_type": _value(package, "physical_context_type"),
        "physical_context_id": _value(package, "physical_context_id"),
        "work_package_version": int(_value(package, "version")),
        "release_attempt_id": release_attempt_id or _value(package, "release_attempt_id"),
        "actor_user": actor_user,
        "actor_role": actor_role,
        "device_action_id": device_action_id,
        "hold_point_sequence": hold_point_sequence,
        "evidence_item": evidence_item,
        "blocker_reason": blocker_reason,
        "evidence_slot_id": evidence_slot_id,
        "evidence_requirement": evidence_requirement,
        "evidence_source": evidence_source,
        "evidence_device_id": evidence_device_id,
        "evidence_captured_at": evidence_captured_at,
        "evidence_freshness": evidence_freshness,
        "evidence_conflict_state": evidence_conflict_state,
        "evidence_correction_of": evidence_correction_of,
        "evidence_item_correction_of": evidence_item_correction_of,
        "evidence_review_of": evidence_review_of,
        "evidence_verification": evidence_verification,
        "evidence_disposition": evidence_disposition,
        "correction_reason": correction_reason,
    }
    return {
        "doctype": "Work Package Event",
        "work_package_event_id": _event_id(device_action_id),
        "event_type": event_type,
        "work_package": _value(package, "name"),
        "roof_job": _value(package, "roof_job"),
        "job_assignment": _value(package, "job_assignment"),
        "work_object_type": _value(package, "work_object_type"),
        "work_object_id": _value(package, "work_object_id"),
        "physical_context_type": _value(package, "physical_context_type"),
        "physical_context_id": _value(package, "physical_context_id"),
        "work_package_version": int(_value(package, "version")),
        "release_attempt_id": release_attempt_id or _value(package, "release_attempt_id"),
        "actor_user": actor_user,
        "actor_role": actor_role,
        "device_action_id": device_action_id,
        "occurred_at": str(frappe.utils.now_datetime()),
        "payload_hash": _payload_hash(payload),
        "hold_point_sequence": hold_point_sequence,
        "evidence_item": evidence_item,
        "blocker_reason": blocker_reason,
        "evidence_slot_id": evidence_slot_id,
        "evidence_requirement": evidence_requirement,
        "evidence_source": evidence_source,
        "evidence_device_id": evidence_device_id,
        "evidence_captured_at": evidence_captured_at,
        "evidence_freshness": evidence_freshness,
        "evidence_conflict_state": evidence_conflict_state,
        "evidence_correction_of": evidence_correction_of,
        "evidence_item_correction_of": evidence_item_correction_of,
        "evidence_review_of": evidence_review_of,
        "evidence_verification": evidence_verification,
        "evidence_disposition": evidence_disposition,
        "correction_reason": correction_reason,
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


def _assert_worker_replay_matches_request(
    event: Mapping[str, Any],
    package: Any,
    *,
    event_type: str,
    roof_job: str,
    assignment_id: str,
    actor: str,
    device_action: str,
    version: int,
    blocker_reason: str | None,
    release_attempt_id: str | None,
) -> None:
    context = _package_parent_context(package)
    typed_context_mismatch = context["work_object_type"] != "Roof Job" and any(
        event.get(field) != context[field]
        for field in (
            "work_object_type",
            "work_object_id",
            "physical_context_type",
            "physical_context_id",
        )
    )
    if (
        event.get("event_type") != event_type
        or event.get("work_package") != _value(package, "name")
        or event.get("roof_job") != roof_job
        or event.get("job_assignment") != assignment_id
        or str(event.get("work_package_version")) != str(version)
        or event.get("actor_user") != actor
        or event.get("device_action_id") != device_action
        or typed_context_mismatch
        or not _same_value(event.get("blocker_reason"), blocker_reason)
        or (release_attempt_id is not None and not _same_value(
            event.get("release_attempt_id"), release_attempt_id
        ))
    ):
        _fail(
            "work_package_event_replay_conflict",
            "device_action_id is already bound to different immutable facts",
        )


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
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    event_type: str,
    blocker_reason: Any = None,
    require_release_attempt: bool = False,
    require_frozen_roster: bool = False,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> tuple[Any, dict[str, Any], str, str, str, dict[str, Any] | None]:
    _assert_worker_issuer()
    package_id = _clean_required(work_package_id, "work_package_id")
    requested_scope = _clean_optional(
        roof_job_id,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    reason = _clean_optional(
        blocker_reason, "blocker_reason", maximum=MAX_BLOCKER_REASON_LENGTH
    )
    package = _lock_work_package(package_id)
    roof_job = _normalize_package_scope(
        package,
        requested_scope,
        supplied_work_object_type=work_object_type,
        supplied_work_object_id=work_object_id,
        supplied_physical_context_type=physical_context_type,
        supplied_physical_context_id=physical_context_id,
    )
    version = _clean_version(work_package_version)
    requested_release_attempt = _clean_optional(
        release_attempt_id,
        "release_attempt_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if require_release_attempt and (
            not requested_release_attempt
            or existing_event.get("release_attempt_id") != requested_release_attempt
        ):
            _fail(
                "work_package_release_attempt_conflict",
                "the replay targets a different or missing Work Package release attempt",
            )
        _assert_worker_replay_matches_request(
            existing_event,
            package,
            event_type=event_type,
            roof_job=roof_job,
            assignment_id=assignment_id,
            actor=actor,
            device_action=device_action,
            version=version,
            blocker_reason=reason,
            release_attempt_id=requested_release_attempt,
        )
        return (
            package,
            {},
            actor,
            str(existing_event.get("actor_role") or ""),
            reason or "",
            existing_event,
        )
    if version != int(_value(package, "version")):
        _fail(
            "work_package_version_conflict",
            "the requested action targets a stale Work Package version",
        )
    if require_release_attempt:
        if not requested_release_attempt:
            _fail(
                "work_package_release_attempt_missing",
                "acknowledge and start actions require the current release attempt",
            )
        current_release_attempt = _current_release_attempt(package)
        if requested_release_attempt not in {current_release_attempt}:
            _fail(
                "work_package_release_attempt_conflict",
                "the action targets a stale Work Package release attempt",
            )
    assignment = _lock_roof_job_production_assignment(package, roof_job, assignment_id)
    if require_frozen_roster:
        _assert_frozen_worker_roster_matches_assignment(package, assignment)
    actor_role = _assert_actor_is_assigned(assignment, actor)
    _assert_package_current_and_unexpired(package)
    expected_event = _event_document(
        package=package,
        event_type=event_type,
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        blocker_reason=reason,
        release_attempt_id=requested_release_attempt,
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


def _assignment_worker_roster(assignment: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Snapshot the active assignment roster for release-time package binding."""

    roster: list[dict[str, Any]] = []
    declared_workers = assignment.get("assigned_workers")
    if isinstance(declared_workers, (list, tuple)):
        for member in declared_workers:
            user = _clean_optional(
                _value(member, "worker_user"),
                "worker_user",
                maximum=MAX_IDENTIFIER_LENGTH,
            )
            if not user or not _enabled(_value(member, "active", 1)):
                continue
            roster.append({
                "worker_user": user,
                "worker_role": _clean_required(
                    _value(member, "worker_role"),
                    "worker_role",
                    maximum=MAX_ROLE_LENGTH,
                ),
                "required": 1 if _enabled(_value(member, "required", 1)) else 0,
            })
    if not roster and assignment.get("name") and assignment.get("assignment_type") in GENERIC_PHYSICAL_ASSIGNMENT_TYPES:
        members = _sql_locked(
            """
            SELECT parent, worker_user, worker_role, required
            FROM `tabWork Package Worker`
            WHERE parent = %s
              AND parenttype = 'Job Assignment'
            FOR UPDATE
            """,
            (assignment.get("name"),),
        )
        for member in members:
            user = _clean_optional(
                member.get("worker_user"),
                "worker_user",
                maximum=MAX_IDENTIFIER_LENGTH,
            )
            if user and _enabled(member.get("active", 1)):
                roster.append({
                    "worker_user": user,
                    "worker_role": _clean_required(
                        member.get("worker_role"),
                        "worker_role",
                        maximum=MAX_ROLE_LENGTH,
                    ),
                    "required": 1 if _enabled(member.get("required", 1)) else 0,
                })
    direct = _clean_optional(
        assignment.get("assigned_user"),
        "assigned_user",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if direct and not roster:
        roster.append(
            {
                "worker_user": direct,
                "worker_role": "Production direct assignment",
                "required": 1,
            }
        )
    crew_profile = _clean_optional(
        assignment.get("crew_profile"),
        "crew_profile",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    if crew_profile:
        members = _sql_locked(
            """
            SELECT parent, crew_user, crew_role, active
            FROM `tabCrew Member`
            WHERE parent = %s
              AND active = 1
            FOR UPDATE
            """,
            (crew_profile,),
        )
        for member in members:
            user = _clean_optional(
                member.get("crew_user"),
                "crew_user",
                maximum=MAX_IDENTIFIER_LENGTH,
            )
            if user and _enabled(member.get("active")):
                roster.append({
                    "worker_user": user,
                    "worker_role": _clean_required(
                        member.get("crew_role"),
                        "crew_role",
                        maximum=MAX_ROLE_LENGTH,
                    ),
                    "required": 1,
                })
    unique: dict[str, dict[str, Any]] = {}
    for row in roster:
        unique.setdefault(str(row["worker_user"]), row)
    ordered = sorted(unique.values(), key=lambda row: str(row["worker_user"]))
    if not ordered:
        _fail(
            "work_package_worker_roster_missing",
            "the active Production assignment has no worker roster",
        )
    return [
        {
            "doctype": "Work Package Worker",
            "sequence": index,
            **row,
            "required": row.get("required", 1),
        }
        for index, row in enumerate(ordered, start=1)
    ]


def _package_worker_users(package: Any, assignment: Mapping[str, Any]) -> set[str]:
    rows = _value(package, "assigned_workers")
    if not isinstance(rows, (list, tuple)) or not rows:
        _fail(
            "work_package_worker_roster_missing",
            "the released Work Package has no frozen assigned_workers roster",
        )
    roster = _frozen_worker_roster(package)
    return {
        user
        for user, _role, required in roster
        if required
    }


def _frozen_worker_roster(package: Any) -> set[tuple[str, str, bool]]:
    rows = _value(package, "assigned_workers")
    if not isinstance(rows, (list, tuple)) or not rows:
        _fail(
            "work_package_worker_roster_missing",
            "the released Work Package has no frozen assigned_workers roster",
        )
    roster: set[tuple[str, str, bool]] = set()
    users: set[str] = set()
    for row in rows:
        user = _clean_required(
            _value(row, "worker_user"),
            "worker_user",
            maximum=MAX_IDENTIFIER_LENGTH,
        )
        role = _clean_required(
            _value(row, "worker_role"),
            "worker_role",
            maximum=MAX_ROLE_LENGTH,
        )
        required = _enabled(_value(row, "required", 1))
        if user in users:
            _fail(
                "work_package_worker_roster_invalid",
                "frozen assigned_workers must contain each worker exactly once",
            )
        users.add(user)
        roster.add((user, role, required))
    if not any(required for _user, _role, required in roster):
        _fail(
            "work_package_worker_roster_invalid",
            "frozen assigned_workers must contain at least one required user",
        )
    return roster


def _assert_frozen_worker_roster_matches_assignment(
    package: Any, assignment: Mapping[str, Any]
) -> None:
    frozen = _frozen_worker_roster(package)
    live = {
        (
            str(row["worker_user"]),
            str(row["worker_role"]),
            bool(row.get("required")),
        )
        for row in _assignment_worker_roster(assignment)
    }
    if frozen != live:
        _fail(
            "work_package_worker_roster_drift",
            "the active assignment roster no longer matches the frozen Work Package roster; issue a superseding package",
        )


def _lock_acknowledged_worker_users(
    package: Any, assignment: Mapping[str, Any]
) -> set[str]:
    """Read acknowledgements bound to the exact current release attempt."""

    required = _package_worker_users(package, assignment)
    release_attempt = _current_release_attempt(package)
    rows = _sql_locked(
        """
        SELECT actor_user, release_attempt_id
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND work_package_version = %s
          AND event_type = 'Acknowledged'
        FOR UPDATE
        """,
        (_value(package, "name"), int(_value(package, "version"))),
    )
    acknowledged: set[str] = set()
    for row in rows:
        actor = _clean_optional(
            row.get("actor_user"),
            "actor_user",
            maximum=MAX_IDENTIFIER_LENGTH,
        )
        if (
            actor
            and actor in required
            and row.get("release_attempt_id") == release_attempt
        ):
            acknowledged.add(actor)
    return acknowledged


def _assert_all_workers_acknowledged(
    package: Any, assignment: Mapping[str, Any]
) -> None:
    required = _package_worker_users(package, assignment)
    acknowledged = _lock_acknowledged_worker_users(package, assignment)
    if required != acknowledged:
        missing = ", ".join(sorted(required - acknowledged))
        _fail(
            "work_package_workers_pending",
            f"every assigned worker must acknowledge this exact package version; missing: {missing}",
        )


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
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Acknowledge one exact package version for one assigned worker.

    The legacy package-level acknowledgement fields are retained as a
    compatibility summary.  The append-only Acknowledged event is the
    authoritative per-worker fact used by the start gate.
    """

    package, _assignment, actor, actor_role, _reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        work_package_version=work_package_version,
        release_attempt_id=release_attempt_id,
        event_type="Acknowledged",
        require_release_attempt=True,
        require_frozen_roster=True,
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Released", "Acknowledged")
    acknowledged_users = _lock_acknowledged_worker_users(package, _assignment)
    if actor in acknowledged_users:
        _fail(
            "work_package_acknowledgement_conflict",
            "this worker already acknowledged the current package execution",
        )
    occurred_at = str(frappe.utils.now_datetime())
    if _value(package, "status") == "Released":
        package.set("status", "Acknowledged")
    if not _value(package, "acknowledged_by"):
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
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Start work online only after every assigned worker acknowledged."""

    package, assignment, actor, actor_role, _reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        work_package_version=work_package_version,
        release_attempt_id=release_attempt_id,
        event_type="Started",
        require_release_attempt=True,
        require_frozen_roster=True,
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Acknowledged")
    _assert_all_workers_acknowledged(package, assignment)
    if not _value(package, "acknowledgement_device_action_id"):
        _fail("work_package_acknowledgement_missing", "at least one worker acknowledgement is required before start")
    _assert_all_hold_points_released(package, {"Pre-start"})
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
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    blocker_reason: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Record a worker stop/make-safe decision and durable blocker attribution."""

    package, _assignment, actor, actor_role, reason, replay = _worker_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        work_package_version=work_package_version,
        release_attempt_id=release_attempt_id,
        event_type="Stop Work",
        blocker_reason=blocker_reason,
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
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


def _assert_direct_release_actor(
    package: Any,
    actor_user: Any,
    *,
    allow_worker_issuer: bool = False,
) -> tuple[str, str]:
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
    configured_issuer = _clean_optional(
        getattr(frappe, "conf", {}).get(ISSUER_CONFIG_KEY),
        ISSUER_CONFIG_KEY,
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    worker_issuer_request = (
        allow_worker_issuer
        and configured_issuer
        and session_user == configured_issuer
        and session_user != actor
    )
    if actor == "Guest" or (session_user != actor and not worker_issuer_request):
        _fail(
            "work_package_direct_actor_mismatch",
            "release requires the acting Frappe user to match actor_user",
            permission=True,
        )
    if worker_issuer_request:
        _assert_worker_issuer()
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
    release_roles = ("IronWrap Owner", "IronWrap Production")
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
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    event_type: str,
    blocker_reason: str | None = None,
    hold_point_sequence: int | None = None,
    evidence_item: str | None = None,
    normalize_evidence_item: bool = False,
    require_release_attempt: bool = False,
    allow_worker_issuer: bool = False,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> tuple[Any, str, str, dict[str, Any] | None, str | None]:
    package_id = _clean_required(work_package_id, "work_package_id")
    requested_scope = _clean_optional(
        roof_job_id,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    package = _lock_work_package(package_id)
    roof_job = _normalize_package_scope(
        package,
        requested_scope,
        supplied_work_object_type=work_object_type,
        supplied_work_object_id=work_object_id,
        supplied_physical_context_type=physical_context_type,
        supplied_physical_context_id=physical_context_id,
    )
    version = _clean_version(work_package_version)
    requested_release_attempt = _clean_optional(
        release_attempt_id,
        "release_attempt_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    normalized_evidence_item = evidence_item
    if normalize_evidence_item:
        if evidence_item is None:
            _fail("work_package_invalid_input", "evidence_item_id is required")
        # Identity lookup is safe before present-day authority checks: it only
        # canonicalizes the immutable Evidence Item reference used by replay.
        normalized_evidence_item = _lock_evidence_identity(evidence_item)
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if require_release_attempt and (
            not requested_release_attempt
            or existing_event.get("release_attempt_id") != requested_release_attempt
        ):
            _fail(
                "work_package_release_attempt_conflict",
                "the replay targets a different or missing Work Package release attempt",
            )
        _assert_worker_replay_matches_request(
            existing_event,
            package,
            event_type=event_type,
            roof_job=roof_job,
            assignment_id=assignment_id,
            actor=_clean_required(actor_user, "actor_user"),
            device_action=device_action,
            version=version,
            blocker_reason=blocker_reason,
            release_attempt_id=requested_release_attempt,
        )
        if (
            existing_event.get("hold_point_sequence") != hold_point_sequence
            or existing_event.get("evidence_item") != normalized_evidence_item
        ):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable hold-point facts",
            )
        return (
            package,
            str(existing_event.get("actor_user") or actor_user),
            str(existing_event.get("actor_role") or ""),
            existing_event,
            normalized_evidence_item,
        )
    if version != int(_value(package, "version")):
        _fail(
            "work_package_version_conflict",
            "the requested action targets a stale Work Package version",
        )
    if require_release_attempt:
        if not requested_release_attempt:
            _fail(
                "work_package_release_attempt_missing",
                "the action requires the current Work Package release attempt",
            )
        current_release_attempt = _current_release_attempt(package)
        if requested_release_attempt != current_release_attempt:
            _fail(
                "work_package_release_attempt_conflict",
                "the action targets a stale Work Package release attempt",
            )
    actor, actor_role = _assert_direct_release_actor(
        package,
        actor_user,
        allow_worker_issuer=allow_worker_issuer,
    )
    assignment = _lock_roof_job_production_assignment(package, roof_job, assignment_id)
    physical_authority_role = _assert_physical_assignment_authority(
        package, assignment, actor
    )
    if physical_authority_role is not None:
        actor_role = physical_authority_role
    if require_release_attempt:
        _assert_frozen_worker_roster_matches_assignment(package, assignment)
    _assert_package_current_and_unexpired(package)
    if normalize_evidence_item:
        normalized_evidence_item, _capture_actor = _lock_releasable_evidence(
            normalized_evidence_item,
            roof_job,
        )
    expected_event = _event_document(
        package=package,
        event_type=event_type,
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        blocker_reason=blocker_reason,
        hold_point_sequence=hold_point_sequence,
        evidence_item=normalized_evidence_item,
        release_attempt_id=requested_release_attempt,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not _same_event(existing_event, expected_event):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable facts",
            )
        return package, actor, actor_role, existing_event, normalized_evidence_item
    return package, actor, actor_role, None, normalized_evidence_item


@frappe.whitelist()
def complete_work_package(
    work_package_id: Any,
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Complete one current package only after all physical-work gates pass.

    Completion is an online independent-authority transition.  The exact
    device action is replayable before present-day status/expiry checks, while
    a first execution requires the current release attempt, frozen roster,
    acknowledgements, phased holds, and an accepted typed-evidence ledger.
    External signoff, NCR, and incident predicates remain adapter-owned for a
    later closeout slice; this command never invents those facts.
    """

    package, actor, actor_role, replay, _evidence_item = _direct_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        work_package_version=work_package_version,
        release_attempt_id=release_attempt_id,
        event_type="Completed",
        require_release_attempt=True,
        allow_worker_issuer=True,
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "In Progress")
    _assert_completion_actor_independent(package, actor)
    assignment = _lock_roof_job_production_assignment(
        package,
        _normalize_package_scope(
            package,
            roof_job_id,
            supplied_work_object_type=work_object_type,
            supplied_work_object_id=work_object_id,
            supplied_physical_context_type=physical_context_type,
            supplied_physical_context_id=physical_context_id,
        ),
        _clean_required(job_assignment_id, "job_assignment_id"),
    )
    _assert_frozen_worker_roster_matches_assignment(package, assignment)
    _assert_all_workers_acknowledged(package, assignment)
    _assert_all_hold_points_released(package)
    _assert_completed_evidence_slots(package)
    if any(
        _value(package, field)
        for field in ("blocked_by", "blocked_at", "blocked_device_action_id", "blocker_reason")
    ):
        _fail(
            "work_package_blocker_unresolved",
            "a Work Package with unresolved blocker attribution cannot be completed",
        )
    completed_at = str(frappe.utils.now_datetime())
    package.set("status", "Completed")
    package.set("completed_at", completed_at)
    _save_transition(package)
    event = _insert_event(
        _event_document(
            package=package,
            event_type="Completed",
            actor_user=actor,
            actor_role=actor_role,
            device_action_id=_clean_required(
                device_action_id, "device_action_id", minimum=8
            ),
            release_attempt_id=_value(package, "release_attempt_id"),
        )
    )
    return _result(package, event, False)


@frappe.whitelist()
def release_work_package(
    work_package_id: Any,
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Release a Draft or independently resume a Blocked Work Package online."""

    package, actor, actor_role, replay, _evidence_item = _direct_action(
        work_package_id=work_package_id,
        roof_job_id=roof_job_id,
        job_assignment_id=job_assignment_id,
        actor_user=actor_user,
        device_action_id=device_action_id,
        work_package_version=work_package_version,
        event_type="Released",
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
    )
    if replay:
        return _result(package, replay, True)
    _require_status(package, "Draft", "Blocked")
    assignment = _lock_roof_job_production_assignment(
        package,
        _normalize_package_scope(
            package,
            roof_job_id,
            supplied_work_object_type=work_object_type,
            supplied_work_object_id=work_object_id,
            supplied_physical_context_type=physical_context_type,
            supplied_physical_context_id=physical_context_id,
        ),
        job_assignment_id,
    )
    # The first Draft release derives authority from the locked live
    # assignment, never from pre-authored child rows. A legacy Blocked package
    # without a frozen roster cannot be safely resumed: mutable live assignment
    # data must not be retroactively presented as reviewed worker authority.
    if _value(package, "status") == "Draft":
        package.set("assigned_workers", _assignment_worker_roster(assignment))
    elif not _value(package, "assigned_workers"):
        _fail(
            "work_package_worker_roster_missing",
            "a Blocked Work Package without a frozen roster requires a superseding package",
        )
    _assert_frozen_worker_roster_matches_assignment(package, assignment)
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
    release_attempt = _event_id(
        _clean_required(device_action_id, "device_action_id", minimum=8)
    )
    package.set("release_attempt_id", release_attempt)
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
            release_attempt_id=release_attempt,
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


def _hold_point_release_phase(hold_point: Any) -> str:
    phase = _clean_optional(
        _value(hold_point, "release_phase"),
        "release_phase",
        maximum=32,
    ) or "Pre-start"
    if phase not in WORK_PACKAGE_HOLD_RELEASE_PHASES:
        _fail(
            "work_package_hold_point_phase_invalid",
            "hold point release_phase must be Pre-start, In-process, or Completion",
        )
    return phase


def _hold_point_sequences(
    package: Any,
    phases: set[str] | frozenset[str] | None = None,
) -> set[int]:
    rows = _value(package, "hold_points") or []
    if not rows:
        _fail(
            "work_package_hold_point_integrity",
            "Work Package must declare hold points",
        )
    selected_rows = [
        row
        for row in rows
        if phases is None or _hold_point_release_phase(row) in phases
    ]
    sequences = {_clean_sequence(_value(row, "sequence")) for row in selected_rows}
    if len(sequences) != len(selected_rows):
        _fail(
            "work_package_hold_point_integrity",
            "Work Package hold points must have unique sequences",
        )
    return sequences


def _lock_released_hold_point_sequences(
    package: Any,
    phases: set[str] | frozenset[str] | None = None,
) -> set[int]:
    current_attempt = _current_release_attempt(package)
    rows = _sql_locked(
        """
        SELECT hold_point_sequence
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND work_package_version = %s
          AND event_type = 'Hold Point Released'
          AND release_attempt_id = %s
        FOR UPDATE
        """,
        (_value(package, "name"), int(_value(package, "version")), current_attempt),
    )
    required = _hold_point_sequences(package, phases)
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


def _assert_all_hold_points_released(
    package: Any,
    phases: set[str] | frozenset[str] | None = None,
) -> None:
    required = _hold_point_sequences(package, phases)
    if required != _lock_released_hold_point_sequences(package, phases):
        _fail(
            "work_package_hold_points_pending",
            "the required Work Package hold points require independent release before this transition",
        )


def _required_evidence_slots(package: Any) -> dict[str, str]:
    slots: dict[str, str] = {}
    for prefix, field in (("step", "steps"), ("hold", "hold_points")):
        for row in _value(package, field) or []:
            sequence = _clean_sequence(_value(row, "sequence"))
            requirement = _clean_required(
                _value(row, "required_evidence"),
                "required_evidence",
                maximum=2_000,
            )
            slot_id = f"{prefix}:{sequence}"
            if slot_id in slots:
                _fail(
                    "work_package_evidence_slot_integrity",
                    "Work Package evidence slots must have unique identities",
                )
            slots[slot_id] = requirement
    if not slots:
        _fail(
            "work_package_evidence_pending",
            "a Work Package must declare required evidence slots before completion",
        )
    return slots


def _lock_completion_evidence_item(
    package: Any,
    capture: Mapping[str, Any],
    prior_item: Mapping[str, Any] | None = None,
) -> None:
    item_id = _clean_required(capture.get("evidence_item"), "evidence_item")
    rows = _sql_locked(
        """
        SELECT name, evidence_id, roof_job, work_package, work_package_version,
               work_package_release_attempt_id, evidence_slot_id, capture_actor,
               sync_state, evidence_verification, evidence_disposition,
               evidence_freshness, evidence_conflict_state, correction_of
        FROM `tabEvidence Item`
        WHERE name = %s OR evidence_id = %s
        FOR UPDATE
        """,
        (item_id, item_id),
    )
    if len(rows) != 1:
        _fail(
            "work_package_evidence_pending",
            "every completion evidence event must identify one immutable Evidence Item",
        )
    item = rows[0]
    package_refs = {_value(package, "name"), _value(package, "work_package_id")}
    if (
        item.get("roof_job") != _value(package, "roof_job")
        or item.get("work_package") not in package_refs
        or str(item.get("work_package_version")) != str(_value(package, "version"))
        or item.get("work_package_release_attempt_id") != _value(package, "release_attempt_id")
        or item.get("evidence_slot_id") != capture.get("evidence_slot_id")
        or item.get("capture_actor") != capture.get("actor_user")
        or item.get("sync_state") != "Verified"
        or item.get("evidence_verification") != "Verified"
        or item.get("evidence_freshness") != capture.get("evidence_freshness")
        or item.get("evidence_conflict_state") != capture.get("evidence_conflict_state")
        or item.get("evidence_disposition") == "Superseded"
        or item.get("correction_of") != capture.get("evidence_item_correction_of")
    ):
        _fail(
            "work_package_evidence_pending",
            "completion evidence must remain bound to the verified immutable Evidence Item",
        )
    if prior_item is not None and item.get("correction_of") != prior_item.get("evidence_item"):
        _fail(
            "work_package_evidence_correction_mismatch",
            "completion evidence correction must preserve the exact Evidence Item lineage",
        )


def _assert_completed_evidence_slots(package: Any) -> None:
    """Require one independently accepted, current evidence instance per slot.

    This command deliberately replays the immutable event envelope instead of
    trusting a mutable summary field.  Any malformed, stale, conflicted,
    unreviewed, duplicate, or cross-paired correction leaves completion closed.
    """

    required = _required_evidence_slots(package)
    current_attempt = _current_release_attempt(package)
    rows = _sql_locked(
        """
        SELECT name, event_type, work_package, roof_job, job_assignment,
               work_object_type, work_object_id, physical_context_type,
               physical_context_id,
               work_package_version, release_attempt_id, actor_user, actor_role,
               device_action_id, occurred_at, evidence_item, evidence_slot_id,
               evidence_requirement, evidence_source, evidence_device_id,
               evidence_captured_at, evidence_freshness, evidence_conflict_state,
               evidence_correction_of, evidence_item_correction_of,
               evidence_review_of, evidence_verification, evidence_disposition,
               correction_reason
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND work_package_version = %s
          AND release_attempt_id = %s
          AND event_type IN ('Evidence Captured', 'Evidence Reviewed')
        FOR UPDATE
        """,
        (_value(package, "name"), int(_value(package, "version")), current_attempt),
    )
    if not rows:
        _fail(
            "work_package_evidence_pending",
            "every required evidence slot must be captured and independently reviewed before completion",
        )
    roster = {
        user: role
        for user, role, _required in _frozen_worker_roster(package)
    }
    captures: dict[str, dict[str, Any]] = {}
    reviews: dict[str, dict[str, Any]] = {}
    event_ids: set[str] = set()
    device_ids: set[str] = set()
    allowed_review_roles = frozenset(("IronWrap Owner", "IronWrap Production", "System Manager"))
    for row in rows:
        event_id = _clean_required(row.get("name"), "work_package_event_id")
        device_id = _clean_required(row.get("device_action_id"), "device_action_id")
        if event_id in event_ids or device_id in device_ids:
            _fail(
                "work_package_evidence_integrity",
                "completion evidence ledger contains a duplicate event or device identity",
            )
        event_ids.add(event_id)
        device_ids.add(device_id)
        context = _package_parent_context(package)
        context_mismatch = (
            row.get("work_object_type") != context["work_object_type"]
            or row.get("work_object_id") != context["work_object_id"]
            or row.get("physical_context_type") != context["physical_context_type"]
            or row.get("physical_context_id") != context["physical_context_id"]
        ) if context["work_object_type"] != "Roof Job" else False
        if (
            row.get("work_package") != _value(package, "name")
            or row.get("roof_job") != _value(package, "roof_job")
            or context_mismatch
            or row.get("job_assignment") != _value(package, "job_assignment")
            or str(row.get("work_package_version")) != str(_value(package, "version"))
            or row.get("release_attempt_id") != current_attempt
            or not _clean_required(row.get("actor_user"), "actor_user")
            or not _clean_required(row.get("actor_role"), "actor_role")
            or not _clean_required(row.get("occurred_at"), "occurred_at")
        ):
            _fail(
                "work_package_evidence_integrity",
                "completion evidence ledger facts do not bind to the current package attempt",
            )
        if row.get("event_type") == "Evidence Captured":
            slot_id = _clean_required(row.get("evidence_slot_id"), "evidence_slot_id")
            requirement = _clean_required(
                row.get("evidence_requirement"),
                "evidence_requirement",
                maximum=2_000,
            )
            if required.get(slot_id) != requirement:
                _fail(
                    "work_package_evidence_requirement_conflict",
                    "completion evidence requirement must match the frozen package slot",
                )
            actor = _clean_required(row.get("actor_user"), "actor_user")
            role = _clean_required(row.get("actor_role"), "actor_role")
            if roster.get(actor) != role:
                _fail(
                    "work_package_evidence_actor_unassigned",
                    "completion evidence must be captured by a frozen assigned worker",
                )
            if (
                not _clean_required(row.get("evidence_item"), "evidence_item")
                or not _clean_required(row.get("evidence_source"), "evidence_source")
                or not _clean_required(row.get("evidence_device_id"), "evidence_device_id")
                or not _clean_required(row.get("evidence_captured_at"), "evidence_captured_at")
                or row.get("evidence_verification") != "Verified"
                or row.get("evidence_disposition") != "Open"
                or row.get("evidence_freshness") != "Current"
                or row.get("evidence_conflict_state") not in {"None", "Resolved"}
                or bool(row.get("evidence_correction_of")) != bool(row.get("evidence_item_correction_of"))
                or bool(row.get("evidence_correction_of")) != bool(row.get("correction_reason"))
            ):
                _fail(
                    "work_package_evidence_pending",
                    "completion requires current, verified, non-conflicted Open evidence before review",
                )
            captures[event_id] = row
        elif row.get("event_type") == "Evidence Reviewed":
            target = _clean_required(row.get("evidence_review_of"), "evidence_review_of")
            disposition = _clean_required(row.get("evidence_disposition"), "evidence_disposition")
            if (
                target in reviews
                or disposition not in {"Accepted", "Needs Correction"}
                or disposition == "Needs Correction"
                or not _clean_required(row.get("evidence_item"), "evidence_item")
                or not _clean_required(row.get("evidence_slot_id"), "evidence_slot_id")
                or row.get("actor_role") not in allowed_review_roles
            ):
                _fail(
                    "work_package_evidence_review_pending",
                    "every completion evidence slot requires one authorized Accepted review",
                )
            review_actor = _clean_required(row.get("actor_user"), "actor_user")
            if row.get("actor_role") not in set(frappe.get_roles(review_actor)):
                _fail(
                    "work_package_evidence_review_pending",
                    "the review actor's current role no longer authorizes completion review",
                )
            reviews[target] = row
        else:
            _fail(
                "work_package_evidence_integrity",
                "completion evidence ledger contains an unsupported event type",
            )
    superseded: set[str] = set()
    for event_id, capture in captures.items():
        correction_of = _clean_optional(
            capture.get("evidence_correction_of"),
            "evidence_correction_of",
            maximum=MAX_IDENTIFIER_LENGTH,
        )
        if not correction_of:
            continue
        prior = captures.get(correction_of)
        if (
            prior is None
            or prior.get("evidence_slot_id") != capture.get("evidence_slot_id")
            or prior.get("actor_user") != capture.get("actor_user")
            or capture.get("evidence_item_correction_of")
            not in {prior.get("name"), prior.get("evidence_item")}
        ):
            _fail(
                "work_package_evidence_correction_mismatch",
                "completion evidence correction must bind one exact prior event and Evidence Item",
            )
        _lock_completion_evidence_item(package, prior)
        _lock_completion_evidence_item(package, capture, prior)
        if correction_of in superseded:
            _fail(
                "work_package_evidence_correction_conflict",
                "one evidence event can have only one immutable replacement",
            )
        superseded.add(correction_of)
    for event_id, capture in captures.items():
        if event_id in superseded:
            continue
        _lock_completion_evidence_item(package, capture)
        review = reviews.get(event_id)
        if (
            review is None
            or review.get("evidence_item") != capture.get("evidence_item")
            or review.get("evidence_slot_id") != capture.get("evidence_slot_id")
            or review.get("actor_user") == capture.get("actor_user")
        ):
            _fail(
                "work_package_evidence_review_pending",
                "every current evidence slot requires an independent review",
            )
    latest_by_slot: dict[str, str] = {}
    for event_id, capture in captures.items():
        if event_id in superseded:
            continue
        slot_id = str(capture.get("evidence_slot_id"))
        if slot_id in latest_by_slot:
            _fail(
                "work_package_evidence_conflict",
                "completion cannot choose between multiple current evidence items for one slot",
            )
        latest_by_slot[slot_id] = event_id
        if reviews[event_id].get("evidence_disposition") != "Accepted":
            _fail(
                "work_package_evidence_review_pending",
                "every required evidence slot must have an Accepted review",
            )
    if set(latest_by_slot) != set(required):
        _fail(
            "work_package_evidence_pending",
            "every declared step and hold point evidence slot must be accepted before completion",
        )


def _assert_completion_actor_independent(package: Any, actor_user: str) -> None:
    actor_key = actor_user.lower()
    if any(user.lower() == actor_key for user, _role, _required in _frozen_worker_roster(package)):
        _fail(
            "work_package_completion_independence_required",
            "completion authority must be independent of the assigned field worker roster",
            permission=True,
        )


def _lock_releasable_evidence(
    evidence_item_id: str, roof_job_id: str
) -> tuple[str, str | None]:
    rows = _sql_locked(
        """
        SELECT name, evidence_id, roof_job, work_package, work_package_version,
               evidence_slot_id, evidence_device_id, evidence_verification,
               evidence_disposition, sync_state, capture_actor
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
        or evidence.get("evidence_verification") != "Verified"
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
    evidence_item_id: str,
    roof_job_id: str,
    actor_user: str,
    *,
    package: Any | None = None,
    evidence_slot_id: str | None = None,
    evidence_requirement: str | None = None,
    evidence_source: str | None = None,
    evidence_device_id: str | None = None,
    evidence_captured_at: str | None = None,
    evidence_freshness: str | None = None,
    evidence_conflict_state: str | None = None,
    evidence_item_correction_of: str | None = None,
    release_attempt_id: str | None = None,
) -> str:
    evidence_name, capture_actor = _lock_releasable_evidence(
        evidence_item_id, roof_job_id
    )
    if capture_actor != actor_user:
        _fail(
            "work_package_evidence_mismatch",
            "hold-point evidence must be captured by actor_user",
        )
    if package is not None:
        rows = _sql_locked(
            """
            SELECT name, work_package, work_package_version, evidence_slot_id,
                   evidence_requirement, evidence_source, evidence_device_id,
                   captured_at, evidence_freshness, evidence_conflict_state,
                   evidence_verification, evidence_disposition, correction_of,
                   work_package_release_attempt_id
            FROM `tabEvidence Item`
            WHERE name = %s
            FOR UPDATE
            """,
            (evidence_name,),
        )
        if len(rows) != 1:
            _fail("work_package_evidence_not_found", "Evidence Item disappeared while locked")
        evidence = rows[0]
        package_references = {
            _value(package, "name"),
            _value(package, "work_package_id"),
        }
        if (
            evidence.get("work_package") not in package_references
            or str(evidence.get("work_package_version")) != str(_value(package, "version"))
            or evidence.get("evidence_slot_id") != evidence_slot_id
            or (
                evidence_requirement is not None
                and evidence.get("evidence_requirement") != evidence_requirement
            )
            or (
                evidence_source is not None
                and evidence.get("evidence_source") != evidence_source
            )
            or (evidence_device_id is not None and evidence.get("evidence_device_id") != evidence_device_id)
            or (
                evidence_captured_at is not None
                and str(evidence.get("captured_at")) != str(evidence_captured_at)
            )
            or (
                evidence_freshness is not None
                and evidence.get("evidence_freshness") != evidence_freshness
            )
            or (
                evidence_conflict_state is not None
                and evidence.get("evidence_conflict_state") != evidence_conflict_state
            )
            or evidence.get("evidence_verification") != "Verified"
            or evidence.get("evidence_disposition") == "Superseded"
            or (release_attempt_id is not None and evidence.get("work_package_release_attempt_id") != release_attempt_id)
            or evidence.get("correction_of") != evidence_item_correction_of
        ):
            _fail(
                "work_package_evidence_mismatch",
                "Evidence Item must bind to the exact Work Package version and evidence slot",
            )
    return evidence_name


def _lock_evidence_identity(evidence_item_id: str) -> str:
    rows = _sql_locked(
        """
        SELECT name, evidence_id
        FROM `tabEvidence Item`
        WHERE name = %s OR evidence_id = %s
        FOR UPDATE
        """,
        (evidence_item_id, evidence_item_id),
    )
    if len(rows) != 1:
        _fail("work_package_evidence_not_found", "evidence_item_id must identify exactly one Evidence Item")
    return _clean_required(rows[0].get("name"), "evidence_item_name")


@frappe.whitelist()
def submit_hold_point_evidence(
    work_package_id: Any,
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    hold_point_sequence: Any = None,
    evidence_item_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Append worker-submitted evidence; it never releases the hold point."""

    _assert_worker_issuer()
    package_id = _clean_required(work_package_id, "work_package_id")
    requested_scope = _clean_optional(
        roof_job_id,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(
        device_action_id, "device_action_id", minimum=8
    )
    sequence = _clean_sequence(hold_point_sequence)
    evidence_id = _clean_required(evidence_item_id, "evidence_item_id")
    package = _lock_work_package(package_id)
    roof_job = _normalize_package_scope(
        package,
        requested_scope,
        supplied_work_object_type=work_object_type,
        supplied_work_object_id=work_object_id,
        supplied_physical_context_type=physical_context_type,
        supplied_physical_context_id=physical_context_id,
    )
    version = _clean_version(work_package_version)
    requested_release_attempt = _clean_optional(
        release_attempt_id,
        "release_attempt_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not requested_release_attempt or existing_event.get("release_attempt_id") != requested_release_attempt:
            _fail(
                "work_package_release_attempt_conflict",
                "the replay targets a different or missing Work Package release attempt",
            )
        _assert_worker_replay_matches_request(
            existing_event,
            package,
            event_type="Hold Point Evidence",
            roof_job=roof_job,
            assignment_id=assignment_id,
            actor=actor,
            device_action=device_action,
            version=version,
            blocker_reason=None,
            release_attempt_id=requested_release_attempt,
        )
        canonical_evidence = _lock_evidence_identity(evidence_id)
        if (
            existing_event.get("hold_point_sequence") != sequence
            or existing_event.get("evidence_item") != canonical_evidence
        ):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable hold-point facts",
            )
        return _result(package, existing_event, True)
    if version != int(_value(package, "version")):
        _fail(
            "work_package_version_conflict",
            "the requested action targets a stale Work Package version",
        )
    assignment = _lock_roof_job_production_assignment(package, roof_job, assignment_id)
    _assert_frozen_worker_roster_matches_assignment(package, assignment)
    current_release_attempt = _current_release_attempt(package)
    if requested_release_attempt != current_release_attempt:
        _fail(
            "work_package_release_attempt_conflict",
            "hold evidence targets a stale Work Package release attempt",
        )
    actor_role = _assert_actor_is_assigned(assignment, actor)
    _assert_package_current_and_unexpired(package)
    _require_status(package, "Acknowledged", "In Progress")
    _find_hold_point(package, sequence)
    evidence_name = _lock_verified_evidence(
        evidence_id,
        roof_job,
        actor,
        package=package,
        evidence_slot_id=f"hold:{sequence}",
        release_attempt_id=current_release_attempt,
    )
    expected_event = _event_document(
        package=package,
        event_type="Hold Point Evidence",
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        hold_point_sequence=sequence,
        evidence_item=evidence_name,
        release_attempt_id=current_release_attempt,
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


@frappe.whitelist()
def review_work_package_evidence(
    work_package_id: Any,
    work_package_version: Any,
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    evidence_event_id: Any = None,
    evidence_item_id: Any = None,
    evidence_slot_id: Any = None,
    disposition: Any = None,
    review_reason: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Append one role-controlled semantic review without mutating evidence bytes."""

    package_id = _clean_required(work_package_id, "work_package_id")
    requested_scope = _clean_optional(
        roof_job_id,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(device_action_id, "device_action_id", minimum=8)
    event_id = _clean_required(evidence_event_id, "evidence_event_id")
    evidence_id = _clean_required(evidence_item_id, "evidence_item_id")
    slot_id = _clean_required(evidence_slot_id, "evidence_slot_id")
    review_disposition = _clean_required(disposition, "disposition", maximum=32)
    reason = _clean_optional(review_reason, "review_reason", maximum=2_000)
    if review_disposition not in {"Accepted", "Needs Correction"}:
        _fail("work_package_evidence_review_invalid", "disposition must be Accepted or Needs Correction")
    if review_disposition == "Needs Correction" and not reason:
        _fail("work_package_evidence_review_invalid", "Needs Correction requires review_reason")
    package = _lock_work_package(package_id)
    roof_job = _normalize_package_scope(
        package,
        requested_scope,
        supplied_work_object_type=work_object_type,
        supplied_work_object_id=work_object_id,
        supplied_physical_context_type=physical_context_type,
        supplied_physical_context_id=physical_context_id,
    )
    version = _clean_version(work_package_version)
    if version != int(_value(package, "version")):
        _fail("work_package_version_conflict", "the review targets a stale Work Package version")
    existing = _lock_existing_event(device_action)
    if existing:
        _assert_worker_replay_matches_request(
            existing,
            package,
            event_type="Evidence Reviewed",
            roof_job=roof_job,
            assignment_id=assignment_id,
            actor=actor,
            device_action=device_action,
            version=version,
            blocker_reason=None,
            release_attempt_id=_value(package, "release_attempt_id"),
        )
        if (
            existing.get("evidence_review_of") != event_id
            or existing.get("evidence_item") != evidence_id
            or existing.get("evidence_slot_id") != slot_id
            or existing.get("evidence_disposition") != review_disposition
            or not _same_value(existing.get("correction_reason"), reason)
        ):
            _fail("work_package_event_replay_conflict", "device_action_id is already bound to different review facts")
        return _result(package, existing, True)
    actor, actor_role = _assert_direct_release_actor(package, actor)
    assignment = _lock_roof_job_production_assignment(package, roof_job, assignment_id)
    _assert_physical_assignment_authority(package, assignment, actor)
    _assert_frozen_worker_roster_matches_assignment(package, assignment)
    current_attempt = _current_release_attempt(package)
    _assert_package_current_and_unexpired(package)
    _require_status(package, "Released", "Acknowledged", "In Progress")
    target_rows = _sql_locked(
        """
        SELECT name, work_package, work_package_version, event_type,
               evidence_item, evidence_slot_id, release_attempt_id,
               evidence_disposition, actor_user
        FROM `tabWork Package Event`
        WHERE name = %s OR work_package_event_id = %s
        FOR UPDATE
        """,
        (event_id, event_id),
    )
    if len(target_rows) != 1:
        _fail("work_package_evidence_review_not_found", "evidence_event_id must identify one prior evidence event")
    target = target_rows[0]
    if (
        target.get("work_package") != _value(package, "name")
        or str(target.get("work_package_version")) != str(version)
        or target.get("event_type") != "Evidence Captured"
        or target.get("evidence_item") != evidence_id
        or target.get("evidence_slot_id") != slot_id
        or target.get("release_attempt_id") != current_attempt
        or target.get("evidence_disposition") == "Superseded"
    ):
        _fail("work_package_evidence_review_mismatch", "review must target the exact current evidence event")
    if target.get("actor_user") == actor:
        _fail(
            "work_package_evidence_review_independence_required",
            "evidence review must be performed by an actor other than the capture actor",
            permission=True,
        )
    prior_reviews = _sql_locked(
        """
        SELECT name
        FROM `tabWork Package Event`
        WHERE event_type = 'Evidence Reviewed'
          AND evidence_review_of = %s
        FOR UPDATE
        """,
        (target.get("name"),),
    )
    if prior_reviews:
        _fail("work_package_evidence_review_conflict", "one evidence event can have only one immutable review")
    expected_event = _event_document(
        package=package,
        event_type="Evidence Reviewed",
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        evidence_item=evidence_id,
        evidence_slot_id=slot_id,
        evidence_disposition=review_disposition,
        correction_reason=reason,
        release_attempt_id=current_attempt,
        evidence_review_of=str(target.get("name") or event_id),
    )
    event = _insert_event(expected_event)
    return _result(package, event, False)


def _lock_evidence_correction_target(
    package: Any,
    slot_id: str,
    correction_of: str,
    actor_user: str,
    release_attempt_id: str,
) -> dict[str, Any]:
    rows = _sql_locked(
        """
        SELECT name, work_package, work_package_version, release_attempt_id,
               event_type, evidence_item, evidence_slot_id,
               evidence_disposition, actor_user
        FROM `tabWork Package Event`
        WHERE name = %s OR work_package_event_id = %s
        FOR UPDATE
        """,
        (correction_of, correction_of),
    )
    if len(rows) != 1:
        _fail(
            "work_package_evidence_correction_not_found",
            "evidence_correction_of must identify exactly one prior evidence event",
        )
    target = rows[0]
    if (
        target.get("work_package") != _value(package, "name")
        or str(target.get("work_package_version")) != str(_value(package, "version"))
        or target.get("release_attempt_id") != release_attempt_id
        or target.get("event_type") != "Evidence Captured"
        or target.get("evidence_slot_id") != slot_id
        or target.get("actor_user") != actor_user
        or target.get("evidence_disposition") == "Superseded"
    ):
        _fail(
            "work_package_evidence_correction_mismatch",
            "evidence correction must target the same current package/version/slot",
        )
    replacements = _sql_locked(
        """
        SELECT name
        FROM `tabWork Package Event`
        WHERE work_package = %s
          AND work_package_version = %s
          AND event_type = 'Evidence Captured'
          AND evidence_correction_of = %s
        FOR UPDATE
        """,
        (_value(package, "name"), int(_value(package, "version")), correction_of),
    )
    if replacements:
        _fail(
            "work_package_evidence_correction_conflict",
            "one evidence event can have only one immutable replacement",
        )
    return target


def _lock_evidence_item_correction_target(
    package: Any,
    slot_id: str,
    correction_of: str | None,
    actor_user: str,
    release_attempt_id: str,
) -> dict[str, Any]:
    if not correction_of:
        _fail(
            "work_package_evidence_correction_not_found",
            "evidence_item_correction_of is required for an evidence correction",
        )
    rows = _sql_locked(
        """
        SELECT name, evidence_id, roof_job, work_package, work_package_version,
               work_package_release_attempt_id, evidence_slot_id, capture_actor,
               sync_state, evidence_disposition
        FROM `tabEvidence Item`
        WHERE name = %s OR evidence_id = %s
        FOR UPDATE
        """,
        (correction_of, correction_of),
    )
    if len(rows) != 1:
        _fail(
            "work_package_evidence_correction_not_found",
            "evidence_item_correction_of must identify exactly one prior Evidence Item",
        )
    target = rows[0]
    package_refs = {_value(package, "name"), _value(package, "work_package_id")}
    if (
        target.get("roof_job") != _value(package, "roof_job")
        or target.get("work_package") not in package_refs
        or str(target.get("work_package_version")) != str(_value(package, "version"))
        or target.get("work_package_release_attempt_id") != release_attempt_id
        or target.get("evidence_slot_id") != slot_id
        or target.get("sync_state") != "Verified"
        or target.get("capture_actor") != actor_user
        or target.get("evidence_disposition") == "Superseded"
        or not target.get("capture_actor")
        or correction_of not in {target.get("name"), target.get("evidence_id")}
    ):
        _fail(
            "work_package_evidence_correction_mismatch",
            "Evidence Item correction must target the same current Work Package version and slot",
        )
    return target


def _assert_evidence_slot_matches_package(
    package: Any,
    slot_id: str,
    requirement: str,
) -> None:
    prefix, separator, raw_sequence = slot_id.partition(":")
    if not separator or prefix not in {"step", "hold"}:
        _fail(
            "work_package_evidence_slot_invalid",
            "evidence_slot_id must identify a declared step or hold point",
        )
    sequence = _clean_sequence(raw_sequence)
    rows = _value(package, "steps" if prefix == "step" else "hold_points") or []
    for row in rows:
        if _clean_sequence(_value(row, "sequence")) != sequence:
            continue
        field = "required_evidence"
        declared = _clean_required(
            _value(row, field),
            field,
            maximum=2_000,
        )
        if declared != requirement:
            _fail(
                "work_package_evidence_requirement_conflict",
                "evidence requirement must match the frozen package slot",
            )
        return
    _fail(
        "work_package_evidence_slot_not_found",
        "evidence_slot_id must identify a slot declared by this Work Package",
    )


@frappe.whitelist()
def capture_work_package_evidence(
    work_package_id: Any,
    work_package_version: Any,
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    evidence_slot_id: Any = None,
    evidence_requirement: Any = None,
    evidence_source: Any = None,
    evidence_item_id: Any = None,
    evidence_device_id: Any = None,
    evidence_captured_at: Any = None,
    evidence_freshness: Any = "Current",
    evidence_conflict_state: Any = "None",
    evidence_correction_of: Any = None,
    evidence_item_correction_of: Any = None,
    release_attempt_id: Any = None,
    correction_reason: Any = None,
    evidence_verification: Any = "Verified",
    evidence_disposition: Any = "Open",
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
) -> dict[str, Any]:
    """Append one typed evidence-slot instance without rewriting prior evidence.

    The Evidence Item proves the bytes and actor.  This immutable event binds
    that item to the exact package version and slot lifecycle, including
    freshness, conflict, correction, verification, and disposition.
    """

    _assert_worker_issuer()
    package_id = _clean_required(work_package_id, "work_package_id")
    requested_scope = _clean_optional(
        roof_job_id,
        "roof_job_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    assignment_id = _clean_required(job_assignment_id, "job_assignment_id")
    actor = _clean_required(actor_user, "actor_user")
    device_action = _clean_required(device_action_id, "device_action_id", minimum=8)
    slot_id = _clean_required(evidence_slot_id, "evidence_slot_id", maximum=MAX_IDENTIFIER_LENGTH)
    requirement = _clean_required(
        evidence_requirement,
        "evidence_requirement",
        maximum=2_000,
    )
    source = _clean_required(evidence_source, "evidence_source", maximum=MAX_IDENTIFIER_LENGTH)
    evidence_id = _clean_required(evidence_item_id, "evidence_item_id")
    evidence_device = _clean_required(
        evidence_device_id,
        "evidence_device_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    captured_at = _clean_required(
        evidence_captured_at,
        "evidence_captured_at",
        maximum=80,
    )
    freshness = _clean_required(evidence_freshness, "evidence_freshness", maximum=16)
    conflict_state = _clean_required(
        evidence_conflict_state,
        "evidence_conflict_state",
        maximum=16,
    )
    verification = _clean_required(
        evidence_verification,
        "evidence_verification",
        maximum=16,
    )
    disposition = _clean_required(
        evidence_disposition,
        "evidence_disposition",
        maximum=32,
    )
    if freshness not in {"Current", "Stale", "Unknown"}:
        _fail("work_package_invalid_input", "evidence_freshness is unsupported")
    if conflict_state not in {"None", "Detected", "Resolved"}:
        _fail("work_package_invalid_input", "evidence_conflict_state is unsupported")
    if verification not in {"Pending", "Verified", "Rejected"}:
        _fail("work_package_invalid_input", "evidence_verification is unsupported")
    if verification != "Verified":
        _fail(
            "work_package_evidence_verification_forbidden",
            "technical evidence verification is derived from the verified Evidence Item",
        )
    if disposition not in {"Open", "Accepted", "Needs Correction", "Superseded"}:
        _fail("work_package_invalid_input", "evidence_disposition is unsupported")
    if disposition != "Open":
        _fail(
            "work_package_evidence_disposition_forbidden",
            "field evidence starts Open; an authorized review command must set business disposition",
        )
    correction = _clean_optional(
        evidence_correction_of,
        "evidence_correction_of",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    item_correction = _clean_optional(
        evidence_item_correction_of,
        "evidence_item_correction_of",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    release_attempt = _clean_optional(
        release_attempt_id,
        "release_attempt_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    reason = _clean_optional(correction_reason, "correction_reason", maximum=2_000)
    if bool(correction) != bool(reason) or bool(correction) != bool(item_correction):
        _fail(
            "work_package_invalid_input",
            "event and Evidence Item correction identities and correction_reason must be provided together",
        )
    package = _lock_work_package(package_id)
    roof_job = _normalize_package_scope(
        package,
        requested_scope,
        supplied_work_object_type=work_object_type,
        supplied_work_object_id=work_object_id,
        supplied_physical_context_type=physical_context_type,
        supplied_physical_context_id=physical_context_id,
    )
    requested_version = _clean_version(work_package_version)
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        canonical_evidence = _lock_evidence_identity(evidence_id)
        _assert_worker_replay_matches_request(
            existing_event,
            package,
            event_type="Evidence Captured",
            roof_job=roof_job,
            assignment_id=assignment_id,
            actor=actor,
            device_action=device_action,
            version=requested_version,
            blocker_reason=None,
            release_attempt_id=release_attempt,
        )
        if (
            release_attempt != existing_event.get("release_attempt_id")
            or existing_event.get("evidence_item") != canonical_evidence
            or existing_event.get("evidence_slot_id") != slot_id
            or existing_event.get("evidence_requirement") != requirement
            or existing_event.get("evidence_source") != source
            or existing_event.get("evidence_device_id") != evidence_device
            or str(existing_event.get("evidence_captured_at")) != str(captured_at)
            or existing_event.get("evidence_freshness") != freshness
            or existing_event.get("evidence_conflict_state") != conflict_state
            or existing_event.get("evidence_correction_of") != correction
            or existing_event.get("evidence_item_correction_of") != item_correction
            or existing_event.get("evidence_verification") != verification
            or existing_event.get("evidence_disposition") != disposition
            or not _same_value(existing_event.get("correction_reason"), reason)
        ):
            _fail("work_package_event_replay_conflict", "device_action_id is already bound to different immutable evidence facts")
        return _result(package, existing_event, True)
    if requested_version != int(_value(package, "version")):
        _fail(
            "work_package_version_conflict",
            "evidence must target the current Work Package version",
        )
    assignment = _lock_roof_job_production_assignment(package, roof_job, assignment_id)
    _assert_frozen_worker_roster_matches_assignment(package, assignment)
    current_release_attempt = _current_release_attempt(package)
    if release_attempt != current_release_attempt:
        _fail(
            "work_package_release_attempt_conflict",
            "evidence targets a stale Work Package release attempt",
        )
    actor_role = _assert_actor_is_assigned(assignment, actor)
    _assert_package_current_and_unexpired(package)
    # Evidence may be captured as soon as the exact released package is on
    # site. Acknowledgements still gate Start Work; requiring them here would
    # leave the evidence-slot controls visible in the PWA but unusable during
    # the normal Released -> Acknowledged sequence.
    _require_status(package, "Released", "Acknowledged", "In Progress")
    _assert_evidence_slot_matches_package(package, slot_id, requirement)
    evidence_name = _lock_verified_evidence(
        evidence_id,
        roof_job,
        actor,
        package=package,
        evidence_slot_id=slot_id,
        evidence_requirement=requirement,
        evidence_source=source,
        evidence_device_id=evidence_device,
        evidence_captured_at=captured_at,
        evidence_freshness=freshness,
        evidence_conflict_state=conflict_state,
        evidence_item_correction_of=item_correction,
        release_attempt_id=current_release_attempt,
    )
    if correction:
        event_correction_target = _lock_evidence_correction_target(
            package, slot_id, correction, actor, current_release_attempt
        )
        item_correction_target = _lock_evidence_item_correction_target(
            package,
            slot_id,
            item_correction,
            actor,
            current_release_attempt,
        )
        if event_correction_target.get("evidence_item") not in {
            item_correction_target.get("name"),
            item_correction_target.get("evidence_id"),
        }:
            _fail(
                "work_package_evidence_correction_mismatch",
                "event and Evidence Item correction identities must describe the same prior evidence",
            )
    expected_event = _event_document(
        package=package,
        event_type="Evidence Captured",
        actor_user=actor,
        actor_role=actor_role,
        device_action_id=device_action,
        evidence_item=evidence_name,
        evidence_slot_id=slot_id,
        evidence_requirement=requirement,
        evidence_source=source,
        evidence_device_id=evidence_device,
        evidence_captured_at=captured_at,
        evidence_freshness=freshness,
        evidence_conflict_state=conflict_state,
        evidence_correction_of=correction,
        evidence_item_correction_of=item_correction,
        evidence_verification=verification,
        evidence_disposition=disposition,
        correction_reason=reason,
        release_attempt_id=current_release_attempt,
    )
    existing_event = _lock_existing_event(device_action)
    if existing_event:
        if not _same_event(existing_event, expected_event):
            _fail(
                "work_package_event_replay_conflict",
                "device_action_id is already bound to different immutable evidence facts",
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
    roof_job_id: Any = None,
    job_assignment_id: Any = None,
    actor_user: Any = None,
    device_action_id: Any = None,
    hold_point_sequence: Any = None,
    evidence_item_id: Any = None,
    work_package_version: Any = None,
    release_attempt_id: Any = None,
    work_object_type: Any = None,
    work_object_id: Any = None,
    physical_context_type: Any = None,
    physical_context_id: Any = None,
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
        work_package_version=work_package_version,
        release_attempt_id=release_attempt_id,
        event_type="Hold Point Released",
        hold_point_sequence=sequence,
        evidence_item=evidence_id,
        normalize_evidence_item=True,
        require_release_attempt=True,
        work_object_type=work_object_type,
        work_object_id=work_object_id,
        physical_context_type=physical_context_type,
        physical_context_id=physical_context_id,
    )
    if replay:
        return _result(package, replay, True)
    evidence_name = _clean_required(evidence_name, "evidence_item_name")
    hold_point = _find_hold_point(package, sequence)
    phase = _hold_point_release_phase(hold_point)
    if phase == "Pre-start":
        _require_status(package, "Acknowledged", "In Progress")
    else:
        _require_status(package, "In Progress")
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
            release_attempt_id=_value(package, "release_attempt_id"),
        )
    )
    return _result(package, event, False)
