"""Narrow issuer for verified Field Companion evidence.

An Evidence Item can be created through the ordinary Desk/REST document
surface, but only the Worker integration principal can issue the ``Verified``
state that makes evidence eligible for a production gate.  The command derives
the verification timestamp and source server-side, locks the evidence identity
for idempotency, and opens a private validation context for exactly one insert.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.document_validation import field_evidence_issuance_context


ISSUER_CONFIG_KEY = "ironwrap_field_evidence_issuer_user"
FIELD_SOURCE_SYSTEM = "ironwrap-pwa"
VERIFICATION_SOURCE = "ironwrap-worker-r2-frappe"
MAX_IDENTIFIER_LENGTH = 140
MAX_CONTENT_TYPE_LENGTH = 255
MAX_SUMMARY_LENGTH = 2_000
MAX_R2_KEY_LENGTH = 500
MAX_CONTENT_LENGTH = 2_147_483_647
MAX_EVIDENCE_JSON_LENGTH = 16_384
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EVIDENCE_TYPES = {
    "Photo",
    "Measurement Report",
    "XML",
    "PDF",
    "Voice Note",
    "Email",
    "Signed Document",
    "Invoice",
    "Field Note",
    "Other",
}
PROOF_SLOTS = {
    "Lead",
    "Measurement",
    "Estimate",
    "Contract",
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
    "Production",
    "Change Order",
    "Completion",
    "Warranty",
    "Payment",
    "Communication",
    "Other",
}
REQUIRED_INPUT_FIELDS = frozenset(
    {
        "evidence_id",
        "device_action_id",
        "roof_job",
        "evidence_type",
        "proof_slot",
        "r2_key",
        "content_checksum",
        "checksum_algorithm",
        "content_type",
        "content_length",
        "capture_actor",
        "captured_at",
        "customer_safe",
    }
)
OPTIONAL_INPUT_FIELDS = frozenset(
    {
        "latitude",
        "longitude",
        "location_accuracy_m",
        "correction_of",
        "correction_reason",
        "summary",
    }
)
ALLOWED_INPUT_FIELDS = REQUIRED_INPUT_FIELDS | OPTIONAL_INPUT_FIELDS
REPLAY_FIELDS = (
    "evidence_id",
    "device_action_id",
    "roof_job",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "latitude",
    "longitude",
    "location_accuracy_m",
    "correction_of",
    "correction_reason",
    "customer_safe",
    "summary",
)
_REPLAY_SELECT = ", ".join(
    ("name", *REPLAY_FIELDS, "sync_state", "verified_at", "verification_source")
)


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _clean_required(
    value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH
) -> str:
    if not isinstance(value, str):
        _fail("field_evidence_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= maximum):
        _fail("field_evidence_invalid_input", f"{field} must be 1-{maximum} characters")
    if any(character in cleaned for character in ("\x00", "\r", "\n")):
        _fail("field_evidence_invalid_input", f"{field} contains control characters")
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail("field_evidence_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("field_evidence_invalid_input", f"{field} is invalid")
    return cleaned


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(
                "field_evidence_invalid_input", "evidence_json contains a duplicate key"
            )
        result[key] = value
    return result


def _parse_evidence_json(evidence_json: Any) -> dict[str, Any]:
    if (
        not isinstance(evidence_json, str)
        or not evidence_json
        or len(evidence_json) > MAX_EVIDENCE_JSON_LENGTH
    ):
        _fail(
            "field_evidence_invalid_input", "evidence_json must be nonempty JSON text"
        )
    try:
        payload = json.loads(evidence_json, object_pairs_hook=_parse_object)
    except (json.JSONDecodeError, TypeError):
        _fail("field_evidence_invalid_input", "evidence_json must be one JSON object")
    if not isinstance(payload, dict):
        _fail("field_evidence_invalid_input", "evidence_json must be one JSON object")
    missing = REQUIRED_INPUT_FIELDS - set(payload)
    unknown = set(payload) - ALLOWED_INPUT_FIELDS
    if missing or unknown:
        _fail(
            "field_evidence_invalid_input",
            "evidence_json has missing or unsupported fields",
        )
    return payload


def _optional_number(value: Any, field: str) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("field_evidence_invalid_input", f"{field} must be numeric")
    return value


def _customer_safe(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in {0, 1}:
        return value
    _fail("field_evidence_invalid_input", "customer_safe must be a boolean")


def _assert_issuer() -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "field_evidence_post_required",
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
            "field_evidence_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    actor = _clean_required(getattr(frappe.session, "user", None), "session_user")
    if actor == "Guest" or actor != configured:
        _fail(
            "field_evidence_issuer_auth_mismatch",
            "only the configured Worker integration user may issue verified evidence",
            permission=True,
        )
    if not frappe.has_permission("Evidence Item", ptype="create", user=actor):
        _fail(
            "field_evidence_issuer_permission_denied",
            "the configured Worker integration user cannot create Evidence Item",
            permission=True,
        )
    return actor


def _issued_document(payload: Mapping[str, Any]) -> dict[str, Any]:
    checksum = _clean_required(
        payload["content_checksum"], "content_checksum", maximum=64
    )
    if not SHA256_RE.fullmatch(checksum):
        _fail(
            "field_evidence_invalid_input", "content_checksum must be lowercase SHA-256"
        )
    if payload["checksum_algorithm"] != "SHA-256":
        _fail("field_evidence_invalid_input", "checksum_algorithm must be SHA-256")
    content_length = payload["content_length"]
    if (
        isinstance(content_length, bool)
        or not isinstance(content_length, int)
        or not 0 <= content_length <= MAX_CONTENT_LENGTH
    ):
        _fail("field_evidence_invalid_input", "content_length is out of range")
    r2_key = _clean_required(payload["r2_key"], "r2_key", maximum=MAX_R2_KEY_LENGTH)
    if not r2_key.startswith("field/v1/") or ".." in r2_key:
        _fail(
            "field_evidence_invalid_input",
            "r2_key must be a Field Companion object key",
        )
    correction_of = _clean_optional(
        payload.get("correction_of"), "correction_of", maximum=MAX_IDENTIFIER_LENGTH
    )
    correction_reason = _clean_optional(
        payload.get("correction_reason"),
        "correction_reason",
        maximum=MAX_SUMMARY_LENGTH,
    )
    if bool(correction_of) != bool(correction_reason):
        _fail(
            "field_evidence_invalid_input",
            "correction_of and correction_reason must be provided together",
        )
    capture_actor = _clean_required(payload["capture_actor"], "capture_actor")
    evidence_type = _clean_required(payload["evidence_type"], "evidence_type")
    proof_slot = _clean_required(payload["proof_slot"], "proof_slot")
    if evidence_type not in EVIDENCE_TYPES or proof_slot not in PROOF_SLOTS:
        _fail(
            "field_evidence_invalid_input", "evidence_type or proof_slot is unsupported"
        )
    return {
        "evidence_id": _clean_required(payload["evidence_id"], "evidence_id"),
        "device_action_id": _clean_required(
            payload["device_action_id"], "device_action_id"
        ),
        "roof_job": _clean_required(payload["roof_job"], "roof_job"),
        "evidence_type": evidence_type,
        "proof_owner": capture_actor,
        "proof_slot": proof_slot,
        "source_system": FIELD_SOURCE_SYSTEM,
        "r2_key": r2_key,
        "content_checksum": checksum,
        "checksum_algorithm": "SHA-256",
        "content_type": _clean_required(
            payload["content_type"], "content_type", maximum=MAX_CONTENT_TYPE_LENGTH
        ),
        "content_length": content_length,
        "capture_actor": capture_actor,
        "captured_at": _clean_required(payload["captured_at"], "captured_at"),
        "latitude": _optional_number(payload.get("latitude"), "latitude"),
        "longitude": _optional_number(payload.get("longitude"), "longitude"),
        "location_accuracy_m": _optional_number(
            payload.get("location_accuracy_m"), "location_accuracy_m"
        ),
        "sync_state": "Verified",
        "verified_at": str(frappe.utils.now_datetime()),
        "verification_source": VERIFICATION_SOURCE,
        "correction_of": correction_of,
        "correction_reason": correction_reason,
        "customer_safe": _customer_safe(payload["customer_safe"]),
        "summary": _clean_optional(
            payload.get("summary"), "summary", maximum=MAX_SUMMARY_LENGTH
        ),
    }


def _lock_existing(evidence_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        f"""
        SELECT {_REPLAY_SELECT}
        FROM `tabEvidence Item`
        WHERE evidence_id = %s
        FOR UPDATE
        """,
        (evidence_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("field_evidence_identity_conflict", "evidence_id is not unique")
    return dict(rows[0]) if rows else None


def _same_value(left: Any, right: Any) -> bool:
    if left is None or left == "":
        return right is None or right == ""
    if right is None or right == "":
        return left is None or left == ""
    return str(left) == str(right)


def _same_issued_evidence(
    existing: Mapping[str, Any], expected: Mapping[str, Any]
) -> bool:
    return (
        existing.get("sync_state") == "Verified"
        and existing.get("verification_source") == VERIFICATION_SOURCE
        and bool(existing.get("verified_at"))
        and all(
            _same_value(existing.get(field), expected.get(field))
            for field in REPLAY_FIELDS
        )
    )


@frappe.whitelist()
def record_verified_field_evidence(evidence_json: str) -> dict[str, Any]:
    """Create one verified Field Companion Evidence Item or return its exact replay."""

    _assert_issuer()
    issued = _issued_document(_parse_evidence_json(evidence_json))
    existing = _lock_existing(issued["evidence_id"])
    if existing:
        if not _same_issued_evidence(existing, issued):
            _fail(
                "field_evidence_identity_conflict",
                "evidence_id is already bound to different immutable facts",
            )
        return {"name": existing["name"], "idempotent_replay": True}

    document = frappe.get_doc({"doctype": "Evidence Item", **issued})
    with field_evidence_issuance_context(document):
        # Do not use ignore_permissions: the configured integration principal
        # needs its own narrowly scoped create grant on this DocType.
        document.insert()
    return {"name": document.name, "idempotent_replay": False}
