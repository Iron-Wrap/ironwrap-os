"""Narrow, approval-bound Proposal Evidence Pack publication command.

An Approved pack becomes visible through the existing private customer portal,
but publication itself does not issue a portal link, send a message, render a
PDF, accept a contract, or mutate a quote.  Generic Proposal Evidence Pack
writes cannot create this state: the controller accepts it only while this
command's private validation context is active.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.approval_receipt import (
    ApprovalReceiptError,
    assert_approved_hermes_run_receipt,
)
from ironwrap_roofing.document_validation import proposal_publication_context


MAX_IDENTIFIER_LENGTH = 140
MAX_REQUEST_TEXT_LENGTH = 4_000
PROPOSAL_PUBLICATION_TOOL_NAME = "request_publish_proposal_evidence_pack"
PROPOSAL_PUBLICATION_TOOL_ARG_KEYS = {
    "proposal_evidence_pack_id",
    "request_text",
    "approved_by",
    "run_id",
}


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str):
        _fail("proposal_publication_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= MAX_IDENTIFIER_LENGTH):
        _fail(
            "proposal_publication_invalid_input",
            f"{field} must be 1-{MAX_IDENTIFIER_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail(
            "proposal_publication_invalid_input", f"{field} contains control characters"
        )
    return cleaned


def _clean_request_text(value: Any) -> str:
    if not isinstance(value, str):
        _fail("proposal_publication_invalid_approval_args", "request_text must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > MAX_REQUEST_TEXT_LENGTH:
        _fail(
            "proposal_publication_invalid_approval_args",
            f"request_text must be 1-{MAX_REQUEST_TEXT_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail(
            "proposal_publication_invalid_approval_args",
            "request_text contains control characters",
        )
    return cleaned


def _assert_post_and_permissions() -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "proposal_publication_post_required",
            "this mutation accepts POST only",
            permission=True,
        )
    authenticated_user = _clean_identifier(
        getattr(frappe.session, "user", None), "session_user"
    )
    if authenticated_user == "Guest":
        _fail(
            "proposal_publication_authenticated_user_required",
            "an authenticated Frappe principal is required",
            permission=True,
        )
    for doctype in ("Proposal Evidence Pack", "Hermes Run"):
        if not frappe.has_permission(doctype, ptype="write", user=authenticated_user):
            _fail(
                "proposal_publication_command_permission_denied",
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
        "proposal_publication_hermes_run_not_found",
    )


def _lock_proposal_evidence_pack(proposal_evidence_pack_id: str) -> Any:
    _locked_one(
        """
        SELECT name
        FROM `tabProposal Evidence Pack`
        WHERE name = %s
        FOR UPDATE
        """,
        (proposal_evidence_pack_id,),
        "proposal_publication_pack_not_found",
    )
    return frappe.get_doc("Proposal Evidence Pack", proposal_evidence_pack_id)


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(
                "proposal_publication_invalid_approval_args",
                "tool_args_json contains a duplicate key",
            )
        result[key] = value
    return result


def _parse_approved_tool_args(raw: Any) -> dict[str, str]:
    if not isinstance(raw, str) or not raw:
        _fail(
            "proposal_publication_invalid_approval_args",
            "Hermes Run requires tool_args_json",
        )
    try:
        parsed = json.loads(raw, object_pairs_hook=_no_duplicate_object)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _fail("proposal_publication_invalid_approval_args", str(exc))
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    if not isinstance(parsed, Mapping) or set(parsed) != PROPOSAL_PUBLICATION_TOOL_ARG_KEYS:
        _fail(
            "proposal_publication_invalid_approval_args",
            "tool_args_json must contain exactly the approved proposal-publication arguments",
        )
    proposal_evidence_pack_id = _clean_identifier(
        parsed.get("proposal_evidence_pack_id"),
        "tool_args_json.proposal_evidence_pack_id",
    )
    run_id = _clean_identifier(parsed.get("run_id"), "tool_args_json.run_id")
    approved_by = _clean_identifier(
        parsed.get("approved_by"), "tool_args_json.approved_by"
    )
    request_text = _clean_request_text(parsed.get("request_text"))
    return {
        "proposal_evidence_pack_id": proposal_evidence_pack_id,
        "run_id": run_id,
        "approved_by": approved_by,
        "request_text": request_text,
    }


def _parse_allowed_policy(raw: Any, *, proposal_evidence_pack_id: str) -> None:
    if not isinstance(raw, str) or not raw:
        _fail(
            "proposal_publication_policy_check_missing",
            "approved Hermes Run requires policy_check_json",
        )
    try:
        policy = json.loads(raw, object_pairs_hook=_no_duplicate_object)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _fail("proposal_publication_policy_check_invalid", str(exc))
        raise AssertionError("frappe.throw must raise") from exc  # pragma: no cover
    target = policy.get("target") if isinstance(policy, Mapping) else None
    if (
        not isinstance(policy, Mapping)
        or policy.get("allowed") is not True
        or target
        != {"doctype": "Proposal Evidence Pack", "name": proposal_evidence_pack_id}
    ):
        _fail(
            "proposal_publication_policy_check_invalid",
            "policy_check_json must allow this exact Proposal Evidence Pack target",
        )


def _assert_signed_approval_capability(
    run: Mapping[str, Any], *, approved_args: Mapping[str, str]
) -> None:
    try:
        assert_approved_hermes_run_receipt(
            run,
            write_tool=PROPOSAL_PUBLICATION_TOOL_NAME,
            approved_args=approved_args,
        )
    except ApprovalReceiptError as exc:
        _fail(
            f"proposal_publication_approval_receipt_{exc.code}",
            "Hermes Run does not contain a current signed approval capability for this exact publication",
        )


def _assert_approved_run(
    run: Mapping[str, Any],
    *,
    hermes_run_id: str,
    proposal_evidence_pack_id: str,
    authenticated_user: str,
) -> dict[str, str]:
    if run.get("name") != hermes_run_id or run.get("run_id") != hermes_run_id:
        _fail(
            "proposal_publication_hermes_run_identity_mismatch",
            "locked Hermes Run identity does not match the command",
        )
    if run.get("capability_level") != "Approved-write":
        _fail(
            "proposal_publication_approval_required",
            "Hermes Run must be an Approved-write capability",
        )
    if run.get("requested_by") != authenticated_user:
        _fail(
            "proposal_publication_requester_mismatch",
            "the authenticated principal is not the Hermes Run requester",
            permission=True,
        )
    if run.get("approval_status") != "Approved":
        _fail(
            "proposal_publication_approval_required",
            "Hermes Run must be Approved before publication",
        )
    if run.get("tool_name") != PROPOSAL_PUBLICATION_TOOL_NAME:
        _fail(
            "proposal_publication_tool_mismatch",
            "Hermes Run is not for request_publish_proposal_evidence_pack",
        )
    if (
        run.get("target_doctype") != "Proposal Evidence Pack"
        or run.get("target_name") != proposal_evidence_pack_id
    ):
        _fail(
            "proposal_publication_target_mismatch",
            "Hermes Run target does not match the requested Proposal Evidence Pack",
        )
    if run.get("mutation_applied") in {1, "1", True}:
        _fail(
            "proposal_publication_run_already_consumed",
            "Hermes Run already records an applied mutation",
        )
    approved_by = _clean_identifier(run.get("approved_by"), "approved_by")
    if not run.get("approved_at"):
        _fail(
            "proposal_publication_approval_required",
            "Hermes Run requires approved_at",
        )
    args = _parse_approved_tool_args(run.get("tool_args_json"))
    if (
        args["run_id"] != hermes_run_id
        or args["proposal_evidence_pack_id"] != proposal_evidence_pack_id
        or args["approved_by"] != approved_by
    ):
        _fail(
            "proposal_publication_approved_args_mismatch",
            "tool_args_json does not match the approved Hermes Run identity",
        )
    _assert_signed_approval_capability(run, approved_args=args)
    _parse_allowed_policy(
        run.get("policy_check_json"),
        proposal_evidence_pack_id=proposal_evidence_pack_id,
    )
    return args


@frappe.whitelist()
def publish_proposal_evidence_pack(
    proposal_evidence_pack_id: str,
    hermes_run_id: str,
) -> dict[str, Any]:
    """Publish one reviewed Draft pack to the existing private portal surface.

    The caller supplies identifiers only.  The command derives the approver from
    the locked Approved Hermes Run and the publication timestamp from Frappe.
    It changes only the pack's status and approval facts; it cannot send a
    customer message, issue a portal link, render a PDF, or create acceptance.
    """

    authenticated_user = _assert_post_and_permissions()
    proposal_evidence_pack_id = _clean_identifier(
        proposal_evidence_pack_id, "proposal_evidence_pack_id"
    )
    hermes_run_id = _clean_identifier(hermes_run_id, "hermes_run_id")
    run = _lock_hermes_run(hermes_run_id)
    approved_args = _assert_approved_run(
        run,
        hermes_run_id=hermes_run_id,
        proposal_evidence_pack_id=proposal_evidence_pack_id,
        authenticated_user=authenticated_user,
    )
    pack = _lock_proposal_evidence_pack(proposal_evidence_pack_id)
    if (
        pack.get("name") != proposal_evidence_pack_id
        or pack.get("pack_id") != proposal_evidence_pack_id
    ):
        _fail(
            "proposal_publication_pack_identity_mismatch",
            "Proposal Evidence Pack identity does not match the approved target",
        )
    if pack.get("status") != "Draft":
        _fail(
            "proposal_publication_not_preparable",
            "Proposal Evidence Pack must be exactly Draft before approved publication",
        )
    if not pack.get("roof_job") or not pack.get("quotation"):
        _fail(
            "proposal_publication_pack_anchor_missing",
            "Proposal Evidence Pack requires its Roof Job and Customer Quote anchors",
        )
    if run.get("roof_job") != pack.get("roof_job"):
        _fail(
            "proposal_publication_roof_job_mismatch",
            "Hermes Run roof job does not match the Proposal Evidence Pack",
        )

    approved_at = str(frappe.utils.now_datetime())
    with proposal_publication_context(
        proposal_evidence_pack_id,
        hermes_run_id,
        approved_args["approved_by"],
        approved_at,
    ):
        pack.status = "Approved"
        pack.approved_by = approved_args["approved_by"]
        pack.approved_at = approved_at
        # The controller verifies the exact private context before accepting
        # this save. Do not use db.set_value, which would bypass that boundary.
        pack.save()

    return {
        "proposal_evidence_pack": {
            "name": pack.get("name"),
            "pack_id": pack.get("pack_id"),
            "roof_job": pack.get("roof_job"),
            "quotation": pack.get("quotation"),
            "status": pack.get("status"),
            "approved_by": pack.get("approved_by"),
            "approved_at": str(pack.get("approved_at")),
        },
        "hermes_run_id": hermes_run_id,
    }
