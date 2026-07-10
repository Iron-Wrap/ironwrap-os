"""Atomic, evidence-backed Safety Plan acknowledgement command.

This is deliberately a narrow RPC command rather than a generic ``Safety Plan``
``PUT``.  A generic update serializes the complete child table and can drop a
second crew member's acknowledgement when two devices submit at the same time.
The parent row is locked before it is read, then exactly one acknowledgement is
appended within Frappe's request transaction.  Frappe commits a successful POST
request and rolls it back when this function raises; do not add an explicit
``frappe.db.commit`` here.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.document_validation import safety_acknowledgement_append_context


ACKNOWLEDGEMENT_METHODS = {
    "QR Device Pairing": {"Photo", "Voice Note", "Field Note"},
    "E-signature": {"Signed Document"},
    "In Person": {"Photo", "Field Note", "PDF", "Signed Document"},
}
MAX_IDENTIFIER_LENGTH = 140
MAX_NOTES_LENGTH = 2_000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    """Fail closed with stable, operator-readable error codes."""

    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_required(value: Any, field: str, *, minimum: int = 1) -> str:
    if not isinstance(value, str):
        _fail("safety_acknowledgement_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (minimum <= len(cleaned) <= MAX_IDENTIFIER_LENGTH):
        _fail(
            "safety_acknowledgement_invalid_input",
            f"{field} must be {minimum}-{MAX_IDENTIFIER_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail(
            "safety_acknowledgement_invalid_input",
            f"{field} contains control characters",
        )
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        _fail("safety_acknowledgement_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if len(cleaned) > maximum:
        _fail(
            "safety_acknowledgement_invalid_input",
            f"{field} cannot exceed {maximum} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail(
            "safety_acknowledgement_invalid_input",
            f"{field} contains control characters",
        )
    return cleaned


def _assert_authenticated_actor(actor_user: str) -> None:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "safety_acknowledgement_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
    authenticated_user = _clean_required(
        getattr(frappe.session, "user", None), "session_user"
    )
    if authenticated_user == "Guest" or authenticated_user != actor_user:
        _fail(
            "safety_acknowledgement_actor_auth_mismatch",
            "actor_user must exactly match the authenticated Frappe API principal",
            permission=True,
        )
    if not frappe.has_permission("Safety Plan", ptype="read", user=authenticated_user):
        _fail(
            "safety_acknowledgement_actor_permission_denied",
            "the authenticated actor cannot read Safety Plan",
            permission=True,
        )


def _locked_one(query: str, values: tuple[Any, ...], code: str) -> dict[str, Any]:
    rows = frappe.db.sql(query, values, as_dict=True)
    if len(rows) != 1:
        _fail(code, "the requested record does not exist")
    return dict(rows[0])


def _lock_safety_plan(safety_plan_id: str) -> Any:
    _locked_one(
        """
        SELECT name
        FROM `tabSafety Plan`
        WHERE name = %s
        FOR UPDATE
        """,
        (safety_plan_id,),
        "safety_acknowledgement_safety_plan_not_found",
    )
    return frappe.get_doc("Safety Plan", safety_plan_id)


def _lock_evidence(evidence_item_id: str) -> dict[str, Any]:
    return _locked_one(
        """
        SELECT name, evidence_id, roof_job, evidence_type, proof_owner, proof_slot,
               source_system, source_uri, r2_key, drive_file_id, content_checksum,
               checksum_algorithm, content_type, content_length, capture_actor,
               captured_at, sync_state, verified_at, verification_source,
               device_action_id
        FROM `tabEvidence Item`
        WHERE name = %s
        FOR UPDATE
        """,
        (evidence_item_id,),
        "safety_acknowledgement_evidence_not_found",
    )


def _assert_enabled_actor(user: str) -> None:
    actor = _locked_one(
        """
        SELECT name, enabled
        FROM `tabUser`
        WHERE name = %s
        FOR UPDATE
        """,
        (user,),
        "safety_acknowledgement_actor_not_found",
    )
    if actor.get("enabled") not in {1, "1", True}:
        _fail(
            "safety_acknowledgement_actor_inactive",
            "the acknowledged user is not an enabled Frappe user",
            permission=True,
        )


def _active_assignment_rows(roof_job: str, actor_user: str) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in frappe.db.sql(
            """
            SELECT name, assignment_type, status, crew_profile, assigned_user
            FROM `tabJob Assignment`
            WHERE roof_job = %s
              AND status IN ('Assigned', 'Accepted', 'In Progress')
              AND (assigned_user = %s OR crew_profile IS NOT NULL)
            ORDER BY modified DESC, name ASC
            FOR UPDATE
            """,
            (roof_job, actor_user),
            as_dict=True,
        )
    ]


def _crew_membership_role(
    crew_profile: str, actor_user: str, assignment_type: str
) -> str | None:
    crew = _locked_one(
        """
        SELECT name, crew_name, status
        FROM `tabCrew Profile`
        WHERE name = %s
        FOR UPDATE
        """,
        (crew_profile,),
        "safety_acknowledgement_crew_not_found",
    )
    if crew.get("status") != "Active":
        return None
    members = frappe.db.sql(
        """
        SELECT crew_role
        FROM `tabCrew Member`
        WHERE parent = %s
          AND parenttype = 'Crew Profile'
          AND parentfield = 'members'
          AND crew_user = %s
          AND active = 1
        FOR UPDATE
        """,
        (crew_profile, actor_user),
        as_dict=True,
    )
    if len(members) != 1:
        return None
    _clean_required(crew.get("crew_name"), "crew_name")
    crew_role = _clean_required(dict(members[0]).get("crew_role"), "crew_role")
    # Keep the child-row value bounded even when a human-assigned crew name is
    # long; the exact Crew Profile remains available from the locked assignment.
    return f"Crew assignment · {crew_role} · {assignment_type}"


def _resolve_active_assignment_role(roof_job: str, actor_user: str) -> str:
    _assert_enabled_actor(actor_user)
    assignments = _active_assignment_rows(roof_job, actor_user)
    for assignment in assignments:
        assignment_type = _clean_required(
            assignment.get("assignment_type"), "assignment_type"
        )
        if assignment.get("assigned_user") == actor_user:
            return f"Direct assignment · {assignment_type}"
    for assignment in assignments:
        crew_profile = assignment.get("crew_profile")
        if not crew_profile:
            continue
        role = _crew_membership_role(
            _clean_required(crew_profile, "crew_profile"),
            actor_user,
            _clean_required(assignment.get("assignment_type"), "assignment_type"),
        )
        if role:
            return role
    _fail(
        "safety_acknowledgement_assignment_required",
        "the actor has no active direct or active-crew assignment for this roof job",
        permission=True,
    )
    raise AssertionError("frappe.throw must raise")  # pragma: no cover


def _assert_safety_evidence(
    evidence: Mapping[str, Any],
    *,
    roof_job: str,
    actor_user: str,
    acknowledgement_method: str,
) -> None:
    if evidence.get("roof_job") != roof_job:
        _fail(
            "safety_acknowledgement_evidence_job_mismatch",
            "evidence must belong to the same roof job as the safety plan",
        )
    if evidence.get("proof_slot") != "Safety":
        _fail(
            "safety_acknowledgement_evidence_semantic_invalid",
            "evidence proof_slot must be Safety",
        )
    allowed_types = ACKNOWLEDGEMENT_METHODS[acknowledgement_method]
    if evidence.get("evidence_type") not in allowed_types:
        _fail(
            "safety_acknowledgement_evidence_semantic_invalid",
            f"{acknowledgement_method} requires one of: {', '.join(sorted(allowed_types))}",
        )
    if evidence.get("sync_state") != "Verified":
        _fail(
            "safety_acknowledgement_evidence_unverified",
            "safety acknowledgement evidence must be verified",
        )
    if (
        evidence.get("capture_actor") != actor_user
        or evidence.get("proof_owner") != actor_user
    ):
        _fail(
            "safety_acknowledgement_evidence_actor_mismatch",
            "evidence capture actor and proof owner must be the acknowledged actor",
            permission=True,
        )
    if not all(
        evidence.get(field)
        for field in (
            "source_system",
            "captured_at",
            "verified_at",
            "verification_source",
            "content_type",
        )
    ):
        _fail(
            "safety_acknowledgement_evidence_provenance_invalid",
            "evidence is missing required capture or verification provenance",
        )
    if not any(
        evidence.get(field) for field in ("source_uri", "r2_key", "drive_file_id")
    ):
        _fail(
            "safety_acknowledgement_evidence_provenance_invalid",
            "evidence must retain a durable source reference",
        )
    if evidence.get("checksum_algorithm") != "SHA-256" or not SHA256_RE.fullmatch(
        str(evidence.get("content_checksum") or "").lower()
    ):
        _fail(
            "safety_acknowledgement_evidence_provenance_invalid",
            "evidence must retain a SHA-256 checksum",
        )
    try:
        content_length = int(evidence.get("content_length"))
    except (TypeError, ValueError):
        content_length = 0
    if content_length <= 0:
        _fail(
            "safety_acknowledgement_evidence_provenance_invalid",
            "evidence content length must be positive",
        )
    if acknowledgement_method == "QR Device Pairing":
        if evidence.get("source_system") != "ironwrap-pwa" or not evidence.get(
            "device_action_id"
        ):
            _fail(
                "safety_acknowledgement_qr_provenance_invalid",
                "QR acknowledgement requires verified IronWrap PWA evidence with a device action",
            )


def _acknowledgement_rows(plan: Any) -> list[Any]:
    return list(plan.get("acknowledgements") or [])


def _same_acknowledgement(
    row: Any,
    *,
    actor_user: str,
    acknowledgement_method: str,
    device_action_id: str,
    evidence_item_id: str,
    notes: str,
    requested_role: str,
) -> bool:
    if row.get("acknowledged_by") != actor_user:
        return False
    if row.get("device_action_id") != device_action_id:
        return False
    if row.get("evidence_item") != evidence_item_id:
        return False
    if row.get("acknowledgement_method") != acknowledgement_method:
        return False
    if (row.get("notes") or "") != notes:
        return False
    return not requested_role or row.get("role_on_job") == requested_role


def _summary(plan: Any, acknowledgement: Any, *, replayed: bool) -> dict[str, Any]:
    rows = _acknowledgement_rows(plan)
    return {
        "safety_plan": {
            "name": plan.get("name"),
            "safety_plan_id": plan.get("safety_plan_id"),
            "roof_job": plan.get("roof_job"),
            "status": plan.get("status"),
            "version": plan.get("version"),
            "effective_date": plan.get("effective_date"),
            "acknowledgement_count": len(rows),
        },
        "acknowledgement": {
            "acknowledged_by": acknowledgement.get("acknowledged_by"),
            "acknowledged_at": str(acknowledgement.get("acknowledged_at")),
            "acknowledgement_method": acknowledgement.get("acknowledgement_method"),
            "device_action_id": acknowledgement.get("device_action_id"),
            "evidence_item": acknowledgement.get("evidence_item"),
            "role_on_job": acknowledgement.get("role_on_job"),
            "notes": acknowledgement.get("notes") or "",
        },
        "idempotent_replay": replayed,
    }


@frappe.whitelist()
def append_safety_acknowledgement(
    safety_plan_id: str,
    roof_job_id: str,
    actor_user: str,
    acknowledgement_method: str,
    device_action_id: str,
    evidence_item_id: str,
    role_on_job: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    """Append one field actor's acknowledgement under a parent-row transaction lock.

    ``actor_user`` is the only user identity accepted by this command and must
    exactly equal Frappe's authenticated API principal. The caller cannot
    submit ``acknowledged_by`` or a client timestamp, and a shared service
    token cannot attest acknowledgements for other users.
    """

    safety_plan_id = _clean_required(safety_plan_id, "safety_plan_id")
    roof_job_id = _clean_required(roof_job_id, "roof_job_id")
    actor_user = _clean_required(actor_user, "actor_user")
    _assert_authenticated_actor(actor_user)
    acknowledgement_method = _clean_required(
        acknowledgement_method, "acknowledgement_method"
    )
    if acknowledgement_method not in ACKNOWLEDGEMENT_METHODS:
        _fail(
            "safety_acknowledgement_method_invalid",
            "acknowledgement_method must be QR Device Pairing, E-signature, or In Person",
        )
    device_action_id = _clean_required(device_action_id, "device_action_id", minimum=8)
    evidence_item_id = _clean_required(evidence_item_id, "evidence_item_id")
    requested_role = _clean_optional(
        role_on_job, "role_on_job", maximum=MAX_IDENTIFIER_LENGTH
    )
    notes = _clean_optional(notes, "notes", maximum=MAX_NOTES_LENGTH)

    # This lock and the implicit Frappe POST transaction make the child-table
    # append serializable.  Do not replace ``acknowledgements`` from client data.
    plan = _lock_safety_plan(safety_plan_id)
    if plan.get("roof_job") != roof_job_id:
        _fail(
            "safety_acknowledgement_plan_job_mismatch",
            "safety plan does not belong to the requested roof job",
        )

    rows = _acknowledgement_rows(plan)
    existing_by_device = next(
        (row for row in rows if row.get("device_action_id") == device_action_id),
        None,
    )
    existing_by_user = next(
        (row for row in rows if row.get("acknowledged_by") == actor_user),
        None,
    )
    if existing_by_device or existing_by_user:
        if (
            existing_by_device
            and existing_by_user
            and existing_by_device is not existing_by_user
        ):
            _fail(
                "safety_acknowledgement_identity_conflict",
                "device action and acknowledged user are already bound to different records",
            )
        if (
            existing_by_user
            and existing_by_device
            and _same_acknowledgement(
                existing_by_user,
                actor_user=actor_user,
                acknowledgement_method=acknowledgement_method,
                device_action_id=device_action_id,
                evidence_item_id=evidence_item_id,
                notes=notes,
                requested_role=requested_role,
            )
        ):
            return _summary(plan, existing_by_user, replayed=True)
        if existing_by_user and not existing_by_device:
            _fail(
                "safety_acknowledgement_user_conflict",
                "this actor already acknowledged this safety plan with a different device action",
            )
        if existing_by_device and not existing_by_user:
            _fail(
                "safety_acknowledgement_device_conflict",
                "this device action is already bound to another acknowledged actor",
            )
        _fail(
            "safety_acknowledgement_replay_conflict",
            "the same actor or device action was submitted with different safety evidence",
        )

    if plan.get("status") not in {"Ready", "Acknowledged"}:
        _fail(
            "safety_plan_ready_required",
            "new acknowledgements require a Ready safety plan",
        )
    evidence = _lock_evidence(evidence_item_id)
    _assert_safety_evidence(
        evidence,
        roof_job=roof_job_id,
        actor_user=actor_user,
        acknowledgement_method=acknowledgement_method,
    )
    canonical_role = _resolve_active_assignment_role(roof_job_id, actor_user)
    if requested_role and requested_role != canonical_role:
        _fail(
            "safety_acknowledgement_role_conflict",
            "role_on_job is server-derived from the active assignment and cannot be forged",
            permission=True,
        )

    with safety_acknowledgement_append_context(safety_plan_id, device_action_id):
        acknowledgement = plan.append(
            "acknowledgements",
            {
                "acknowledged_by": actor_user,
                "acknowledged_at": frappe.utils.now_datetime(),
                "acknowledgement_method": acknowledgement_method,
                "device_action_id": device_action_id,
                "evidence_item": evidence_item_id,
                "role_on_job": canonical_role,
                "notes": notes,
            },
        )
        plan.status = "Acknowledged"
        # Field users receive a narrow, assignment-scoped command rather than
        # generic Safety Plan write permission. The controller accepts this
        # save only while the private atomic append context is active.
        plan.save(ignore_permissions=True)
    return _summary(plan, acknowledgement, replayed=False)
