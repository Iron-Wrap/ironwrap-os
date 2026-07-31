"""Read-only synthetic launch-proof projection lookup.

The release runner needs a narrowly bounded way to determine whether its
synthetic estimator fixture reached Frappe.  This endpoint deliberately
accepts only the opaque correlation generated for that fixture, reads only the
derived ``Instant Estimate Session`` identity, and returns no customer,
contact, job, raw-payload, or document-name data.  It is not a general Frappe
search API and it cannot mutate any record.
"""

from __future__ import annotations

import re
from typing import Any

import frappe


READER_CONFIG_KEY = "ironwrap_launch_proof_reader_user"
MAX_IDENTIFIER_LENGTH = 140
SYNTHETIC_CORRELATION_RE = re.compile(
    r"^launch-proof:(?P<project_id>LP-(?P<timestamp>[0-9]{13})-(?P<suffix>[0-9a-f]{32}))$"
)
ESTIMATE_SESSION_PREFIX = "estimate:"


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str):
        _fail("launch_proof_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= MAX_IDENTIFIER_LENGTH):
        _fail(
            "launch_proof_invalid_input",
            f"{field} must be 1-{MAX_IDENTIFIER_LENGTH} characters",
        )
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("launch_proof_invalid_input", f"{field} contains control characters")
    return cleaned


def _assert_reader() -> str:
    request = getattr(frappe, "request", None)
    method = str(getattr(request, "method", "")).upper()
    if method != "GET":
        _fail(
            "launch_proof_get_required",
            "this read-only endpoint accepts GET only",
            permission=True,
        )

    conf = getattr(frappe, "conf", {}) or {}
    configured_raw = conf.get(READER_CONFIG_KEY)
    if not isinstance(configured_raw, str):
        _fail(
            "launch_proof_reader_user_not_configured",
            f"Frappe site config {READER_CONFIG_KEY} is required",
            permission=True,
        )
    configured = configured_raw.strip()
    if (
        not configured
        or len(configured) > MAX_IDENTIFIER_LENGTH
        or any(character in configured for character in ("\x00", "\r", "\n"))
    ):
        _fail(
            "launch_proof_reader_user_not_configured",
            f"Frappe site config {READER_CONFIG_KEY} is invalid",
            permission=True,
        )
    actor = _clean_identifier(getattr(frappe.session, "user", None), "session_user")
    if actor == "Guest" or actor != configured:
        _fail(
            "launch_proof_reader_auth_mismatch",
            "only the configured launch-proof reader may query this endpoint",
            permission=True,
        )
    if not frappe.has_permission("Instant Estimate Session", ptype="read", user=actor):
        _fail(
            "launch_proof_reader_permission_denied",
            "the configured reader cannot read Instant Estimate Session",
            permission=True,
        )
    return actor


def _correlation_id(value: Any) -> str:
    correlation_id = _clean_identifier(value, "correlation_id")
    if not SYNTHETIC_CORRELATION_RE.fullmatch(correlation_id):
        _fail(
            "launch_proof_invalid_input",
            "correlation_id must be one generated synthetic launch-proof correlation",
        )
    return correlation_id


def _expected_estimate_session_id(correlation_id: str) -> str:
    # The Worker derives this same execution-unique ID from the full Unix-millisecond
    # timestamp and 128-bit cryptographic suffix. Re-derive only the strict captured
    # project ID rather than accepting an arbitrary launch-proof prefix.
    match = SYNTHETIC_CORRELATION_RE.fullmatch(correlation_id)
    if match is None:
        _fail(
            "launch_proof_invalid_input",
            "correlation_id must be one generated synthetic launch-proof correlation",
        )
    return f"{ESTIMATE_SESSION_PREFIX}{match.group('project_id')}"


@frappe.whitelist()
def lookup_synthetic_correlation(correlation_id: str) -> dict[str, str]:
    """Return one redacted state for one synthetic launch-proof correlation.

    ``matched`` means exactly one expected synthetic estimator record was
    observed.  ``pending`` is intentionally non-success evidence.  ``mismatch``
    means the query result was structurally contradictory and must be
    reconciled by an operator.
    """

    _assert_reader()
    normalized_correlation = _correlation_id(correlation_id)
    expected_session_id = _expected_estimate_session_id(normalized_correlation)
    rows = frappe.get_list(
        "Instant Estimate Session",
        fields=["estimate_session_id"],
        filters={"estimate_session_id": expected_session_id},
        limit_page_length=2,
    )
    if not rows:
        return {
            "correlation_id": normalized_correlation,
            "observation": "pending",
        }
    if len(rows) != 1 or dict(rows[0]).get("estimate_session_id") != expected_session_id:
        return {
            "correlation_id": normalized_correlation,
            "observation": "mismatch",
        }
    return {
        "correlation_id": normalized_correlation,
        "observation": "matched",
    }
