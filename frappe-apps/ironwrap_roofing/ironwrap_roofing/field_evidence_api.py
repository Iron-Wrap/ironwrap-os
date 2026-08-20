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
        "evidence_type",
        "proof_slot",
        "r2_key",
        "content_checksum",
        "checksum_algorithm",
        "content_type",
        "content_length",
        "capture_actor",
        "captured_at",
        "latitude",
        "longitude",
        "customer_safe",
    }
)
OPTIONAL_INPUT_FIELDS = frozenset(
    {
        # Legacy Roof Job evidence remains a valid adapter input. Non-roof
        # Work Package evidence deliberately omits this field and binds its
        # parent/context through the typed capture command instead.
        "roof_job",
        "location_accuracy_m",
        "correction_of",
        "correction_reason",
        "summary",
        "work_package",
        "work_package_version",
        "work_package_release_attempt_id",
        "evidence_slot_id",
        "evidence_requirement",
        "evidence_source",
        "evidence_device_id",
        "evidence_freshness",
        "evidence_conflict_state",
        "evidence_verification",
        "evidence_disposition",
    }
)
TYPED_INPUT_FIELDS = frozenset(
    {
        "work_package",
        "work_package_version",
        "evidence_slot_id",
        "evidence_requirement",
        "evidence_source",
        "evidence_device_id",
        "evidence_freshness",
        "evidence_conflict_state",
        "evidence_verification",
        "evidence_disposition",
        "work_package_release_attempt_id",
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
    "work_package",
    "work_package_version",
    "work_package_release_attempt_id",
    "evidence_slot_id",
    "evidence_requirement",
    "evidence_source",
    "evidence_device_id",
    "evidence_freshness",
    "evidence_conflict_state",
    "evidence_verification",
    "evidence_disposition",
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


def _required_coordinate(
    value: Any, field: str, *, minimum: float, maximum: float
) -> float:
    if value is None:
        _fail(
            "field_evidence_invalid_input",
            f"{field} is required for verified field evidence",
        )
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("field_evidence_invalid_input", f"{field} must be numeric")
    number = float(value)
    if number != number or number in {float("inf"), float("-inf")}:
        _fail("field_evidence_invalid_input", f"{field} must be a finite coordinate")
    if not minimum <= number <= maximum:
        _fail("field_evidence_invalid_input", f"{field} is out of range")
    return number


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


def _lock_work_package(
    work_package: str,
    roof_job: str | None,
    version: int,
    release_attempt: str,
) -> tuple[str, str | None]:
    rows = frappe.db.sql(
        """
        SELECT name, roof_job, work_object_type, work_object_id,
               version, status, release_attempt_id
        FROM `tabWork Package`
        WHERE name = %s OR work_package_id = %s
        FOR UPDATE
        """,
        (work_package, work_package),
        as_dict=True,
    )
    if len(rows) != 1:
        _fail(
            "field_evidence_work_package_missing",
            "typed evidence must reference one existing Work Package",
        )
    package = rows[0]
    package_roof_job = package.get("roof_job")
    package_scope = package_roof_job or package.get("work_object_id")
    if (
        package_roof_job != roof_job
        and not (
            not package_roof_job
            and roof_job == package_scope
        )
    ) or int(package.get("version") or 0) != version:
        _fail(
            "field_evidence_work_package_conflict",
            "typed evidence Work Package, Roof Job, and version must match",
        )
    if package.get("status") not in {"Released", "Acknowledged", "In Progress"}:
        _fail(
            "field_evidence_work_package_unavailable",
            "typed evidence requires a released, acknowledged, or active Work Package",
        )
    if package.get("release_attempt_id") != release_attempt:
        _fail(
            "field_evidence_release_attempt_conflict",
            "typed evidence must target the current Work Package release attempt",
        )
    return str(package["name"]), str(package_roof_job) if package_roof_job else None


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
    work_package = _clean_optional(
        payload.get("work_package"), "work_package", maximum=MAX_IDENTIFIER_LENGTH
    )
    slot_id = _clean_optional(
        payload.get("evidence_slot_id"),
        "evidence_slot_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    typed_values = (work_package, slot_id)
    if any(typed_values) and not all(typed_values):
        _fail(
            "field_evidence_invalid_input",
            "work_package and evidence_slot_id must be provided together",
        )
    work_package_version = payload.get("work_package_version")
    typed_supplied = bool(TYPED_INPUT_FIELDS & set(payload))
    if work_package is not None and (
        isinstance(work_package_version, bool)
        or not isinstance(work_package_version, int)
        or work_package_version < 1
    ):
        _fail("field_evidence_invalid_input", "work_package_version must be a positive integer")
    evidence_requirement = _clean_optional(
        payload.get("evidence_requirement"),
        "evidence_requirement",
        maximum=2_000,
    )
    evidence_source = _clean_optional(
        payload.get("evidence_source"),
        "evidence_source",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    evidence_device_id = _clean_optional(
        payload.get("evidence_device_id"),
        "evidence_device_id",
        maximum=MAX_IDENTIFIER_LENGTH,
    )
    evidence_freshness = _clean_optional(
        payload.get("evidence_freshness"),
        "evidence_freshness",
        maximum=16,
    ) or "Current"
    evidence_conflict_state = _clean_optional(
        payload.get("evidence_conflict_state"),
        "evidence_conflict_state",
        maximum=16,
    ) or "None"
    evidence_verification = _clean_optional(
        payload.get("evidence_verification"),
        "evidence_verification",
        maximum=16,
    )
    if evidence_verification not in {None, "Verified"}:
        _fail(
            "field_evidence_verification_forbidden",
            "technical evidence verification is derived by the server",
        )
    evidence_verification = "Verified"
    evidence_disposition = _clean_optional(
        payload.get("evidence_disposition"),
        "evidence_disposition",
        maximum=32,
    )
    if evidence_disposition not in {None, "Open"}:
        _fail(
            "field_evidence_disposition_forbidden",
            "Field Companion evidence starts Open; an authorized review command must set business disposition",
        )
    evidence_disposition = "Open"
    release_attempt: str | None = None
    if work_package is not None:
        if not all((evidence_requirement, evidence_source, evidence_device_id)):
            _fail(
                "field_evidence_invalid_input",
                "typed evidence slots require requirement, source, and device",
            )
        if evidence_freshness not in {"Current", "Stale", "Unknown"}:
            _fail("field_evidence_invalid_input", "evidence_freshness is unsupported")
        if evidence_conflict_state not in {"None", "Detected", "Resolved"}:
            _fail("field_evidence_invalid_input", "evidence_conflict_state is unsupported")
        release_attempt = _clean_optional(
            payload.get("work_package_release_attempt_id"),
            "work_package_release_attempt_id",
            maximum=MAX_IDENTIFIER_LENGTH,
        )
        if not release_attempt:
            _fail(
                "field_evidence_invalid_input",
                "typed evidence requires the current Work Package release attempt",
            )
        work_package, canonical_roof_job = _lock_work_package(
            work_package,
            payload.get("roof_job"),
            work_package_version,
            release_attempt,
        )
        payload = {**payload, "roof_job": canonical_roof_job}
        if correction_of:
            _lock_evidence_correction_target(
                correction_of,
                canonical_roof_job,
                work_package,
                work_package_version,
                slot_id,
                capture_actor,
                release_attempt,
            )
    else:
        if typed_supplied:
            _fail(
                "field_evidence_invalid_input",
                "typed evidence fields require work_package and evidence_slot_id",
            )
        evidence_requirement = None
        evidence_source = None
        evidence_device_id = None
        work_package_version = None
        evidence_freshness = None
        evidence_conflict_state = None
        evidence_verification = None
        evidence_disposition = None
        release_attempt = None
    return {
        "evidence_id": _clean_required(payload["evidence_id"], "evidence_id"),
        "device_action_id": _clean_required(
            payload["device_action_id"], "device_action_id"
        ),
        "roof_job": _clean_optional(
            payload.get("roof_job"),
            "roof_job",
            maximum=MAX_IDENTIFIER_LENGTH,
        ),
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
        "latitude": _required_coordinate(
            payload.get("latitude"), "latitude", minimum=-90.0, maximum=90.0
        ),
        "longitude": _required_coordinate(
            payload.get("longitude"), "longitude", minimum=-180.0, maximum=180.0
        ),
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
        "work_package": work_package,
        "work_package_version": work_package_version,
        "work_package_release_attempt_id": release_attempt,
        "evidence_slot_id": slot_id,
        "evidence_requirement": evidence_requirement,
        "evidence_source": evidence_source,
        "evidence_device_id": evidence_device_id,
        "evidence_freshness": evidence_freshness,
        "evidence_conflict_state": evidence_conflict_state,
        "evidence_verification": evidence_verification,
        "evidence_disposition": evidence_disposition,
    }


def _lock_evidence_correction_target(
    correction_of: str,
    roof_job: str | None,
    work_package: str,
    work_package_version: int,
    evidence_slot_id: str,
    capture_actor: str,
    release_attempt: str,
) -> dict[str, Any]:
    rows = frappe.db.sql(
        """
        SELECT name, evidence_id, roof_job, work_package, work_package_version,
               work_package_release_attempt_id, evidence_slot_id, capture_actor,
               sync_state, evidence_disposition
        FROM `tabEvidence Item`
        WHERE name = %s OR evidence_id = %s
        FOR UPDATE
        """,
        (correction_of, correction_of),
        as_dict=True,
    )
    if len(rows) != 1:
        _fail(
            "field_evidence_correction_not_found",
            "correction_of must identify exactly one prior Evidence Item",
        )
    target = rows[0]
    if (
        target.get("roof_job") != roof_job
        or target.get("work_package") != work_package
        or str(target.get("work_package_version")) != str(work_package_version)
        or target.get("work_package_release_attempt_id") != release_attempt
        or target.get("evidence_slot_id") != evidence_slot_id
        or target.get("capture_actor") != capture_actor
        or target.get("sync_state") != "Verified"
        or target.get("evidence_disposition") == "Superseded"
        or correction_of not in {target.get("name"), target.get("evidence_id")}
    ):
        _fail(
            "field_evidence_correction_mismatch",
            "correction_of must target the same current Work Package version and slot",
        )
    return dict(target)


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
