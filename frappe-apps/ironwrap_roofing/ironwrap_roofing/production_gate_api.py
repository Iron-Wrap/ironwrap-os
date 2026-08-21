"""Bounded, audited production-gate clearing commands.

The six scheduling gates (Deposit, Materials, Safety, Access, Weather, Crew) are
what stands between a Won job and a dispatched crew.  Every one of them was
created ``Blocked`` by transport (``erpnext.ts`` ``ensureInitialProductionGates``)
and, until this module, nothing in the product could move one: the validators and
the scheduling fence were real, the producers were missing, so
``production-schedule-approvals`` could never legitimately reach ``202``
(ELEC-120 finding 3).

Two clearing shapes, and the difference between them is deliberate:

* **Waived** - a governed office decision.  The gate's own validator asks for
  ``waived_by``, ``waived_at`` and ``waiver_reason``, and that is exactly what a
  clearance without a product evidence source honestly is: a named person said
  so, for a stated reason, at a recorded time.  This is the v1 for Materials,
  Access, Weather and Crew, whose readiness proof has no product rail yet, and it
  stays the right shape afterwards for the genuine business waiver ("insurance
  restoration, no deposit collected").
* **Ready** - an evidence-linked clearance.  The gate carries an Evidence Item the
  Worker minted from a real observed event and stored immutably in R2 first, and
  ``domain_policy._validate_gate_evidence`` then re-checks that evidence against
  the same Roof Job.  The Deposit gate uses this path off the money lane's own
  settlement record; nothing here derives a settlement, it only records the one
  the Worker read.

Neither shape gives the caller a raw field write.  The Worker integration
principal may only ask for one clearance of one gate of one job; the authority of
record is the ``actor_user``, an enabled user with real write permission on the
gate row.  The two clearances do not share a role bar, and neither bar is invented
here.  Recording that a requirement was met takes IronWrap Owner or IronWrap
Production, the two roles ``access_control.DOCTYPE_ROLE_MATRIX`` already grants
gate authority to.  Waiving takes IronWrap Owner alone - a deliberately *narrower*
bar than the Desk rule it feeds, which
``document_validation.validate_business_document`` states as IronWrap Owner **or**
System Manager (ELEC-123 nit).  Narrower, not different: every waiver this command
produces still satisfies that rule, which re-checks it on the way in regardless.
The excluded role is Frappe's platform-administration role, blanket-granted write
on every DocType by ``access_control.expected_permissions`` so a site can be
operated at all; it carries no IronWrap business meaning, and no app session can
reach this command through it either - ``production:clear_gate`` is granted only to
the ``owner`` and ``production`` app roles (``app-types.ts``).  Widening this tuple
to match the Desk rule would hand a business decision to whoever administers the
site, so the bar stays where the business put it.

Re-blocking a cleared gate is deliberately absent: this lane opens the gates that
had no producer at all, and taking readiness back is a supervisory correction
with its own audit question.  A gate that is already cleared refuses a differing
clearance rather than silently overwriting one.

RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era.  This whole
module exists because `Production Gate State` is a Frappe row today, so the only
place a clearance can be made durable and re-validated is inside a Frappe
transaction.  Its D1-native successor is the gate state IRO-195 moves onto the
Worker side: `workers-bus/src/production-gate-clearance.ts` already owns the
authority check, the idempotency key, the immutable R2 receipt and the tenant
scoping, and keeps all of them - what it loses is the `frappeProductionGateWriter`
hop, writing the cleared state straight to D1 instead.  Delete this module, its
site-config issuer pin (`ironwrap_production_gate_issuer_user`), and the
`document_validation` hooks listed below together on that cutover; nothing else
in the product calls them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.document_validation import (
    production_gate_clearance_context,
)


# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
# by IRO-195's D1-native production-gate state.  The issuer pin only exists because
# a Frappe write needs a Frappe principal to make it; a D1-native clearance is
# already authenticated by the app session the Worker route checked.
ISSUER_CONFIG_KEY = "ironwrap_production_gate_issuer_user"
# Exactly `domain_policy.PRODUCTION_GATES` - the scheduling locks, asserted equal
# in `test_production_gate_api`. The DocType's `gate` Select carries a seventh
# option, Completion, which `_validate_roof_job` consults at closeout rather than
# before scheduling; clearing it is a different decision with a different reviewer,
# so it is deliberately not reachable from this rail.
# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era.  This tuple
# is duplicated Worker-side as `production-gate-clearance.ts`
# `CLEARABLE_PRODUCTION_GATES`; that copy is the one that survives the cutover.
CLEARABLE_GATES = ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
CLEARANCES = ("waived", "verified")
# Read off `access_control.DOCTYPE_ROLE_MATRIX["Production Gate State"]` plus the
# blanket IronWrap Owner grant `expected_permissions` applies to every DocType.
CLEARANCE_ROLES = ("IronWrap Owner", "IronWrap Production")
# Skipping a readiness requirement outranks recording that one was met, so the two
# clearances do not share a bar. This one is narrower than BOTH inputs on purpose:
# `document_validation.validate_business_document` accepts IronWrap Owner or System
# Manager for a waiver, and this command accepts only the first (ELEC-123 nit -
# judged, not an oversight). It fails closed against that rule, never against it:
# System Manager is the platform-administration role `access_control` blanket-grants
# on every DocType, not an IronWrap business authority, and no app session carries
# `production:clear_gate` through it. See the module docstring.
WAIVER_ROLES = ("IronWrap Owner",)
# A gate is a scheduling lock, so it may only be cleared while the job is one a
# crew could actually be dispatched to. A tentative job has not been won yet and a
# closed one is finished; neither has a schedule to unlock.
CLEARABLE_JOB_STATUSES = frozenset(("Won", "In Production"))
CLEARANCE_SOURCE_SYSTEM = "ironwrap-production-gate-clearance"
VERIFICATION_SOURCE = "ironwrap-worker-r2-production-gate-clearance"
MAX_IDENTIFIER_LENGTH = 140
MAX_REASON_LENGTH = 1_000
MIN_REASON_LENGTH = 8
MAX_R2_KEY_LENGTH = 500
MAX_CONTENT_TYPE_LENGTH = 255
MAX_SUMMARY_LENGTH = 500
MAX_CONTENT_LENGTH = 2_147_483_647
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")
EVIDENCE_FIELDS = frozenset(
    {
        "r2_key",
        "content_checksum",
        "content_type",
        "content_length",
        "captured_at",
        "summary",
    }
)
GATE_RESPONSE_FIELDS = (
    "name",
    "gate_id",
    "roof_job",
    "gate",
    "state",
    "owner_user",
    "assigned_at",
    "due_at",
    "blocker_reason",
    "evidence_item",
    "waived_by",
    "waived_at",
    "waiver_reason",
)


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
        _fail("production_gate_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not minimum <= len(cleaned) <= maximum:
        _fail(
            "production_gate_invalid_input",
            f"{field} must be {minimum}-{maximum} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r")):
        _fail("production_gate_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail("production_gate_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r")
    ):
        _fail("production_gate_invalid_input", f"{field} is invalid")
    return cleaned


def _clean_single_line(value: Any, field: str, *, maximum: int) -> str:
    cleaned = _clean_required(value, field, maximum=maximum)
    if "\n" in cleaned:
        _fail("production_gate_invalid_input", f"{field} must be a single line")
    return cleaned


def _clean_timestamp(value: Any, field: str) -> str:
    cleaned = _clean_single_line(value, field, maximum=40)
    if not TIMESTAMP_RE.match(cleaned):
        _fail(
            "production_gate_invalid_input",
            f"{field} must be a UTC ISO-8601 timestamp",
        )
    return cleaned.replace("T", " ").replace("Z", "").split(".")[0]


def _enabled(value: Any) -> bool:
    return value in (True, 1, "1")


def _rows(query: str, values: tuple[Any, ...]) -> list[dict[str, Any]]:
    return [dict(row) for row in frappe.db.sql(query, values, as_dict=True)]


def _assert_worker_issuer() -> None:
    """Pin the caller to the site's configured Worker integration principal.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with the module.  A
    D1-native clearance has no second principal to pin - the Worker route is the
    only writer, and it has already authenticated the app session.
    """

    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "production_gate_post_required",
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
            "production_gate_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    principal = _clean_required(getattr(frappe.session, "user", None), "session_user")
    if principal == "Guest" or principal != configured:
        _fail(
            "production_gate_issuer_auth_mismatch",
            "only the configured Worker integration user may clear a production gate",
            permission=True,
        )
    if not frappe.has_permission("Production Gate State", ptype="write", user=principal):
        _fail(
            "production_gate_issuer_permission_denied",
            "the configured Worker integration user cannot write Production Gate State",
            permission=True,
        )


def _assert_actor(actor_user: str, gate_name: str, *, clearance: str) -> str:
    """Prove the human this clearance is attributed to may actually make it.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state.  This function is the part with a
    real successor rather than a deletion: the role bar and the enabled-user check
    move to the Worker's own authority model (`mayClearProductionGate`, already
    enforcing `production:clear_gate` on the session), and the two
    `frappe.has_permission` probes go away with the DocType rows they interrogate.
    """

    rows = _rows(
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
            "production_gate_actor_not_enabled",
            "actor_user must be an enabled User",
            permission=True,
        )
    roles = set(frappe.get_roles(actor_user))
    allowed = WAIVER_ROLES if clearance == "waived" else CLEARANCE_ROLES
    role = next((candidate for candidate in allowed if candidate in roles), None)
    if role is None:
        _fail(
            "production_gate_actor_role_denied",
            f"this clearance requires one of {list(allowed)}",
            permission=True,
        )
    if not frappe.has_permission(
        "Production Gate State", ptype="write", user=actor_user, doc=gate_name
    ):
        _fail(
            "production_gate_actor_permission_denied",
            "actor_user cannot write this Production Gate State",
            permission=True,
        )
    if clearance == "verified" and not frappe.has_permission(
        "Evidence Item", ptype="create", user=actor_user
    ):
        _fail(
            "production_gate_actor_permission_denied",
            "actor_user cannot create the clearance Evidence Item",
            permission=True,
        )
    return str(role)


def _lock_roof_job(roof_job_id: str) -> dict[str, Any]:
    """Serialize this clearance against every other write on the same job.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with the module.  `SELECT
    ... FOR UPDATE` is MariaDB-shaped and does not survive to D1, where the same
    serialization is the Worker's own transaction plus the route's idempotency key.
    """

    rows = _rows(
        """
        SELECT name, roof_job_id, job_status
        FROM `tabRoof Job`
        WHERE name = %s OR roof_job_id = %s
        FOR UPDATE
        """,
        (roof_job_id, roof_job_id),
    )
    if len(rows) != 1:
        _fail(
            "production_gate_roof_job_not_found",
            "roof_job_id must identify exactly one Roof Job",
        )
    job = rows[0]
    if str(job.get("job_status") or "") not in CLEARABLE_JOB_STATUSES:
        _fail(
            "production_gate_job_not_clearable",
            "only a Won or In Production job has a schedule a gate can unlock",
        )
    return job


# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
# by IRO-195's D1-native production-gate state; delete with `_lock_roof_job` and the
# rest of the module - same MariaDB row-lock note as above.
def _lock_gate(roof_job: str, gate: str) -> dict[str, Any]:
    rows = _rows(
        """
        SELECT name, gate_id, gate, state, owner_user, assigned_at, due_at,
               blocker_reason, evidence_item, waived_by, waived_at, waiver_reason
        FROM `tabProduction Gate State`
        WHERE roof_job = %s AND gate = %s
        FOR UPDATE
        """,
        (roof_job, gate),
    )
    if len(rows) != 1:
        _fail(
            "production_gate_not_found"
            if not rows
            else "production_gate_ambiguous",
            f"exactly one current {gate} gate is required for this Roof Job",
        )
    return rows[0]


def _clearance_evidence(
    evidence: Any,
    *,
    decision_id: str,
    roof_job: str,
    gate: str,
    actor_user: str,
    reason: str,
) -> dict[str, Any]:
    """Shape the one Evidence Item this clearance is allowed to mint.

    The Worker stores the receipt in R2 and hashes it before it calls; this side
    re-derives nothing about the artifact and invents no source.  It binds the
    receipt to the job and gate it was read for, and `domain_policy` then holds
    the result to the same verified-evidence bar as any field capture.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with the module.  What
    retires is the Evidence Item *projection*, not the proof: the R2 object and its
    checksum are already the durable record and are minted Worker-side
    (`depositSettlementReceipt`), so a D1-native gate binds the same receipt without
    a Frappe row standing in for it.
    """

    if not isinstance(evidence, Mapping):
        _fail(
            "production_gate_evidence_required",
            "a verified clearance requires the Worker's stored receipt facts",
        )
    unexpected = set(evidence.keys()) - EVIDENCE_FIELDS
    if unexpected:
        _fail(
            "production_gate_invalid_input",
            f"evidence carries unexpected fields: {sorted(unexpected)}",
        )
    content_length = evidence.get("content_length")
    if isinstance(content_length, bool) or not isinstance(content_length, int):
        _fail("production_gate_invalid_input", "evidence.content_length must be an integer")
    if not 1 <= content_length <= MAX_CONTENT_LENGTH:
        _fail("production_gate_invalid_input", "evidence.content_length is out of range")
    checksum = _clean_single_line(
        evidence.get("content_checksum"), "evidence.content_checksum", maximum=64
    )
    if not SHA256_RE.match(checksum):
        _fail(
            "production_gate_invalid_input",
            "evidence.content_checksum must be a lowercase SHA-256 digest",
        )
    return {
        "doctype": "Evidence Item",
        "evidence_id": f"gate-clearance:{decision_id}",
        "device_action_id": decision_id,
        "roof_job": roof_job,
        # No option in the Evidence Item vocabulary names a machine-read receipt,
        # and dressing one up as a Signed Document or a Measurement Report would
        # be a worse lie than the honest catch-all.
        "evidence_type": "Other",
        "proof_owner": actor_user,
        # The Evidence Item `proof_slot` vocabulary already carries every gate
        # name, so the receipt lands in the slot the gate itself is named for.
        "proof_slot": gate,
        "source_system": CLEARANCE_SOURCE_SYSTEM,
        "r2_key": _clean_single_line(
            evidence.get("r2_key"), "evidence.r2_key", maximum=MAX_R2_KEY_LENGTH
        ),
        "content_checksum": checksum,
        "checksum_algorithm": "SHA-256",
        "content_type": _clean_single_line(
            evidence.get("content_type"),
            "evidence.content_type",
            maximum=MAX_CONTENT_TYPE_LENGTH,
        ),
        "content_length": content_length,
        "capture_actor": actor_user,
        "captured_at": _clean_timestamp(evidence.get("captured_at"), "evidence.captured_at"),
        "sync_state": "Verified",
        "verified_at": str(frappe.utils.now_datetime()),
        "verification_source": VERIFICATION_SOURCE,
        # A gate receipt records an internal readiness decision; nothing here is
        # published to a customer portal.
        "customer_safe": 0,
        "summary": _clean_optional(
            evidence.get("summary"), "evidence.summary", maximum=MAX_SUMMARY_LENGTH
        )
        or reason[:MAX_SUMMARY_LENGTH],
    }


# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
# by IRO-195's D1-native production-gate state; delete with the module.  The response
# shape survives it - `GATE_RESPONSE_FIELDS` is what
# `production-gate-clearance-contracts.ts` parses, so the D1-native writer returns the
# same object without reading it back out of Frappe.
def _gate_response(gate_name: str) -> dict[str, Any]:
    document = frappe.get_doc("Production Gate State", gate_name)
    return {field: document.get(field) for field in GATE_RESPONSE_FIELDS}


def _replayed(
    existing: Mapping[str, Any],
    *,
    clearance: str,
    actor_user: str,
    reason: str,
    evidence_id: str | None,
) -> bool:
    """Answer whether this exact clearance is already recorded on the gate.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded
    by IRO-195's D1-native production-gate state; delete with the module.  Replay
    convergence itself survives - it is what makes the Worker's idempotency key
    honest across a retry - it just stops needing a round trip to decide.


    Convergence rather than a decision ledger: the durable record of the
    clearance is the gate row itself, so a retried call that would write the
    same three facts is a replay, and one that would write different facts is a
    conflict.  Nothing is silently overwritten either way.
    """

    if clearance == "waived":
        return (
            str(existing.get("state") or "") == "Waived"
            and str(existing.get("waived_by") or "") == actor_user
            and str(existing.get("waiver_reason") or "") == reason
        )
    return (
        str(existing.get("state") or "") == "Ready"
        and str(existing.get("evidence_item") or "") == (evidence_id or "")
    )


@frappe.whitelist()
def record_production_gate_clearance(
    roof_job_id: Any = None,
    gate: Any = None,
    clearance: Any = None,
    actor_user: Any = None,
    decision_id: Any = None,
    reason: Any = None,
    evidence: Any = None,
) -> dict[str, Any]:
    """Clear exactly one scheduling gate of one Roof Job, on one actor's authority.

    RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era.  This is
    the whitelisted seam itself: `frappeProductionGateWriter`
    (`workers-bus/src/production-gate-clearance.ts`) is its only caller, and IRO-195's
    D1-native production-gate state replaces the call, not the behaviour.  Delete this
    endpoint, `_assert_worker_issuer`'s site-config pin and the
    `document_validation.production_gate_clearance_context` hook together when the
    runway's gate rows stop living in Frappe.
    """

    _assert_worker_issuer()
    roof_job_id = _clean_required(roof_job_id, "roof_job_id")
    gate_name = _clean_required(gate, "gate", maximum=40)
    if gate_name not in CLEARABLE_GATES:
        _fail(
            "production_gate_not_clearable",
            f"gate must be one of {list(CLEARABLE_GATES)}",
        )
    requested = _clean_required(clearance, "clearance", maximum=20)
    if requested not in CLEARANCES:
        _fail("production_gate_invalid_input", f"clearance must be one of {list(CLEARANCES)}")
    actor = _clean_required(actor_user, "actor_user")
    decision = _clean_single_line(decision_id, "decision_id", maximum=MAX_IDENTIFIER_LENGTH)
    reason_text = _clean_required(
        reason, "reason", maximum=MAX_REASON_LENGTH, minimum=MIN_REASON_LENGTH
    )

    job = _lock_roof_job(roof_job_id)
    gate_row = _lock_gate(str(job["name"]), gate_name)
    role = _assert_actor(actor, str(gate_row["name"]), clearance=requested)
    evidence_payload = (
        _clearance_evidence(
            evidence,
            decision_id=decision,
            roof_job=str(job["name"]),
            gate=gate_name,
            actor_user=actor,
            reason=reason_text,
        )
        if requested == "verified"
        else None
    )
    evidence_id = evidence_payload["evidence_id"] if evidence_payload else None

    if _replayed(
        gate_row,
        clearance=requested,
        actor_user=actor,
        reason=reason_text,
        evidence_id=evidence_id,
    ):
        return {
            "gate": _gate_response(str(gate_row["name"])),
            "evidence_item": evidence_id,
            "actor_role": role,
            "replayed": True,
        }
    if str(gate_row.get("state") or "") != "Blocked":
        _fail(
            "production_gate_already_cleared",
            "this gate already carries a different clearance; supersede it deliberately",
        )
    # `Ready` is the only non-blocking state `domain_policy._validate_gate` asks a
    # due date of, and inventing one here would be inventing the readiness
    # deadline the office set.
    if requested == "verified" and not gate_row.get("due_at"):
        _fail(
            "production_gate_due_at_missing",
            "a verified clearance keeps the gate's own due date; this gate has none",
        )

    document = frappe.get_doc("Production Gate State", str(gate_row["name"]))
    evidence_document = frappe.get_doc(evidence_payload) if evidence_payload else None
    if requested == "waived":
        document.state = "Waived"
        document.waived_by = actor
        document.waived_at = str(frappe.utils.now_datetime())
        document.waiver_reason = reason_text
    else:
        document.state = "Ready"
        document.evidence_item = evidence_id
        # `_validate_gate` refuses a non-waived gate that kept waiver metadata, and
        # it is right to: a gate cleared on evidence was not waived by anyone.
        document.waived_by = None
        document.waived_at = None
        document.waiver_reason = None
    # The blocker was the reason the gate was shut. It is answered now, and a
    # cleared gate that still reads "Awaiting deposit readiness proof." tells the
    # runway a stale story.
    document.blocker_reason = None

    with production_gate_clearance_context(
        document,
        evidence_document,
        waiver_actor=actor if requested == "waived" else None,
    ):
        if evidence_document is not None:
            evidence_document.insert()
        document.save()
    return {
        "gate": _gate_response(str(document.name)),
        "evidence_item": evidence_id,
        "actor_role": role,
        "replayed": False,
    }
