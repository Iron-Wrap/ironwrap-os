"""Narrow, approval-bound Lead Envelope triage command.

Lead triage is an operating decision, not a bus transport update.  The normal
``Lead Envelope`` resource endpoint intentionally cannot make that decision:
the controller accepts a transition to ``Triaged`` only while this command's
private context is active.  This command locks both the prior Hermes Run and
the Lead Envelope in the same request transaction, then derives every triage
field from the immutable approved tool arguments already recorded in Frappe.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.document_validation import lead_triage_transition_context


MAX_IDENTIFIER_LENGTH = 140
MAX_REQUEST_TEXT_LENGTH = 4_000
MAX_TRIAGE_SUMMARY_LENGTH = 2_000
TRIAGE_TOOL_NAME = "request_mark_lead_triaged"
TRIAGE_TOOL_ARG_KEYS = {
    "lead_envelope_id",
    "triage_summary",
    "request_text",
    "approved_by",
    "run_id",
}


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str):
        _fail("lead_triage_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= MAX_IDENTIFIER_LENGTH):
        _fail(
            "lead_triage_invalid_input",
            f"{field} must be 1-{MAX_IDENTIFIER_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("lead_triage_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_text(value: Any, field: str, *, maximum: int) -> str:
    if not isinstance(value, str):
        _fail("lead_triage_invalid_approval_args", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > maximum:
        _fail(
            "lead_triage_invalid_approval_args",
            f"{field} must be 1-{maximum} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail(
            "lead_triage_invalid_approval_args",
            f"{field} contains control characters",
        )
    return cleaned


def _assert_post_and_permissions() -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "lead_triage_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
    authenticated_user = _clean_identifier(
        getattr(frappe.session, "user", None), "session_user"
    )
    if authenticated_user == "Guest":
        _fail(
            "lead_triage_authenticated_user_required",
            "an authenticated Frappe principal is required",
            permission=True,
        )
    for doctype in ("Lead Envelope", "Hermes Run"):
        if not frappe.has_permission(doctype, ptype="write", user=authenticated_user):
            _fail(
                "lead_triage_command_permission_denied",
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
        SELECT name, run_id, agent_role, requested_by, target_doctype, target_name,
               lead_envelope, capability_level, tool_name, tool_args_json,
               dry_run_json, policy_check_json, approval_status, approved_by,
               approved_at, mutation_applied, result_status
        FROM `tabHermes Run`
        WHERE name = %s
        FOR UPDATE
        """,
        (hermes_run_id,),
        "lead_triage_hermes_run_not_found",
    )


def _lock_lead_envelope(lead_envelope_id: str) -> Any:
    _locked_one(
        """
        SELECT name
        FROM `tabLead Envelope`
        WHERE name = %s
        FOR UPDATE
        """,
        (lead_envelope_id,),
        "lead_triage_lead_envelope_not_found",
    )
    return frappe.get_doc("Lead Envelope", lead_envelope_id)


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(
                "lead_triage_invalid_approval_args",
                "tool_args_json contains a duplicate key",
            )
        result[key] = value
    return result


def _parse_approved_tool_args(raw: Any) -> dict[str, str]:
    if not isinstance(raw, str) or not raw:
        _fail(
            "lead_triage_invalid_approval_args",
            "Hermes Run requires tool_args_json",
        )
    try:
        parsed = json.loads(raw, object_pairs_hook=_no_duplicate_object)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _fail("lead_triage_invalid_approval_args", str(exc))
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    if not isinstance(parsed, Mapping) or set(parsed) != TRIAGE_TOOL_ARG_KEYS:
        _fail(
            "lead_triage_invalid_approval_args",
            "tool_args_json must contain exactly the approved lead-triage arguments",
        )
    lead_envelope_id = _clean_identifier(
        parsed.get("lead_envelope_id"), "tool_args_json.lead_envelope_id"
    )
    run_id = _clean_identifier(parsed.get("run_id"), "tool_args_json.run_id")
    approved_by = _clean_identifier(
        parsed.get("approved_by"), "tool_args_json.approved_by"
    )
    request_text = _clean_text(
        parsed.get("request_text"),
        "tool_args_json.request_text",
        maximum=MAX_REQUEST_TEXT_LENGTH,
    )
    triage_summary = _clean_text(
        parsed.get("triage_summary"),
        "tool_args_json.triage_summary",
        maximum=MAX_TRIAGE_SUMMARY_LENGTH,
    )
    # The MCP triage schema canonicalizes its summary before signed approval.
    # Refuse a noncanonical summary rather than silently changing the decision
    # at execution time. Request text is retained as audit context only and
    # intentionally has no bearing on the derived mutation.
    if parsed.get("triage_summary") != triage_summary:
        _fail(
            "lead_triage_invalid_approval_args",
            "tool_args_json must use canonical trimmed text",
        )
    return {
        "lead_envelope_id": lead_envelope_id,
        "run_id": run_id,
        "approved_by": approved_by,
        "request_text": request_text,
        "triage_summary": triage_summary,
    }


def _parse_allowed_policy(raw: Any, *, lead_envelope_id: str) -> None:
    if not isinstance(raw, str) or not raw:
        _fail(
            "lead_triage_policy_check_missing",
            "approved Hermes Run requires policy_check_json",
        )
    try:
        policy = json.loads(raw, object_pairs_hook=_no_duplicate_object)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _fail("lead_triage_policy_check_invalid", str(exc))
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    target = policy.get("target") if isinstance(policy, Mapping) else None
    if (
        not isinstance(policy, Mapping)
        or policy.get("allowed") is not True
        or target != {"doctype": "Lead Envelope", "name": lead_envelope_id}
    ):
        _fail(
            "lead_triage_policy_check_invalid",
            "policy_check_json must allow this exact Lead Envelope target",
        )


def _assert_approved_run(
    run: Mapping[str, Any],
    *,
    hermes_run_id: str,
    lead_envelope_id: str,
    authenticated_user: str,
) -> dict[str, str]:
    if run.get("name") != hermes_run_id or run.get("run_id") != hermes_run_id:
        _fail(
            "lead_triage_hermes_run_identity_mismatch",
            "locked Hermes Run identity does not match the command",
        )
    if run.get("capability_level") != "Approved-write":
        _fail(
            "lead_triage_approval_required",
            "Hermes Run must be an Approved-write capability",
        )
    if run.get("requested_by") != authenticated_user:
        _fail(
            "lead_triage_requester_mismatch",
            "the authenticated principal is not the Hermes Run requester",
            permission=True,
        )
    if run.get("approval_status") != "Approved":
        _fail(
            "lead_triage_approval_required",
            "Hermes Run must be Approved before triage",
        )
    if run.get("tool_name") != TRIAGE_TOOL_NAME:
        _fail(
            "lead_triage_tool_mismatch",
            "Hermes Run is not for request_mark_lead_triaged",
        )
    if (
        run.get("target_doctype") != "Lead Envelope"
        or run.get("target_name") != lead_envelope_id
        or run.get("lead_envelope") != lead_envelope_id
    ):
        _fail(
            "lead_triage_target_mismatch",
            "Hermes Run target does not match the requested Lead Envelope",
        )
    if run.get("mutation_applied") in {1, "1", True}:
        _fail(
            "lead_triage_run_already_consumed",
            "Hermes Run already records an applied mutation",
        )
    approved_by = _clean_identifier(run.get("approved_by"), "approved_by")
    if not run.get("approved_at"):
        _fail(
            "lead_triage_approval_required",
            "Hermes Run requires approved_at",
        )
    args = _parse_approved_tool_args(run.get("tool_args_json"))
    if (
        args["run_id"] != hermes_run_id
        or args["lead_envelope_id"] != lead_envelope_id
        or args["approved_by"] != approved_by
    ):
        _fail(
            "lead_triage_approved_args_mismatch",
            "tool_args_json does not match the approved Hermes Run identity",
        )
    _parse_allowed_policy(
        run.get("policy_check_json"), lead_envelope_id=lead_envelope_id
    )
    return args


@frappe.whitelist()
def mark_lead_triaged(
    lead_envelope_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Apply exactly one approved Lead Envelope triage decision.

    The caller supplies identifiers only.  The command derives the human
    approver and triage summary from the locked Approved Hermes Run, and the
    event time from the Frappe server.  This prevents direct REST/Desk writes
    from forging a triage decision while allowing bus transport-only updates.
    """

    authenticated_user = _assert_post_and_permissions()
    lead_envelope_id = _clean_identifier(lead_envelope_id, "lead_envelope_id")
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    approved_args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        lead_envelope_id=lead_envelope_id,
        authenticated_user=authenticated_user,
    )
    envelope = _lock_lead_envelope(lead_envelope_id)
    if envelope.get("triage_status") != "Untriaged":
        _fail(
            "lead_triage_not_preparable",
            "Lead Envelope must be exactly Untriaged before an approved triage can be applied",
        )

    triaged_at = str(frappe.utils.now_datetime())
    with lead_triage_transition_context(
        lead_envelope_id,
        hermes_run_id,
        approved_args["approved_by"],
        triaged_at,
        approved_args["triage_summary"],
    ):
        envelope.triage_status = "Triaged"
        envelope.triaged_by = approved_args["approved_by"]
        envelope.triaged_at = triaged_at
        envelope.triage_summary = approved_args["triage_summary"]
        # The controller verifies the exact private context before accepting
        # this save. Do not use db.set_value, which would bypass that boundary.
        envelope.save()

    return {
        "lead_envelope": {
            "name": envelope.get("name"),
            "envelope_id": envelope.get("envelope_id"),
            "triage_status": envelope.get("triage_status"),
            "triaged_by": envelope.get("triaged_by"),
            "triaged_at": str(envelope.get("triaged_at")),
            "triage_summary": envelope.get("triage_summary"),
        },
        "hermes_run_id": hermes_run_id,
    }
