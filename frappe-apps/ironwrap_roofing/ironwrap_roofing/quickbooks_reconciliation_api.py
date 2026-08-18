"""Bounded issuer for Pending QuickBooks reconciliation work.

An Intuit webhook establishes only an entity identity.  The Worker may record
that identity as a Pending reconciliation through this narrow, configured
integration-user command; ordinary Desk and REST resource creation cannot
create QuickBooks records or assert provider reconciliation truth.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

import frappe

from ironwrap_roofing.access_control import (
    QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE,
)
from ironwrap_roofing.document_validation import (
    quickbooks_reconciliation_issuance_context,
)


ISSUER_CONFIG_KEY = "ironwrap_quickbooks_reconciliation_issuer_user"
MAX_JSON_LENGTH = 16_384
MAX_IDENTIFIER_LENGTH = 140
MAX_DATETIME_LENGTH = 40
MAX_RAW_KEY_LENGTH = 500
MAX_NOTES_LENGTH = 2_000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
QBO_ID_RE = re.compile(r"^[1-9][0-9]{0,31}$")
RECONCILIATION_ID_RE = re.compile(r"^qbr:[0-9a-f]{64}:[0-9]+$")
QUICKBOOKS_ENTITY_TYPES = {"Invoice", "Payment", "CreditMemo", "RefundReceipt"}
QUICKBOOKS_OPERATIONS = {"Create", "Update", "Delete", "Void"}
PENDING_NOTES = (
    "Webhook identity captured. Provider amount, status, posting, and "
    "reconciliation facts require an authenticated QuickBooks read."
)

REQUIRED_INPUT_FIELDS = frozenset(
    {
        "reconciliation_id",
        "system_name",
        "entity_type",
        "external_entity_id",
        "local_doctype",
        "local_name",
        "direction",
        "status",
        "detected_at",
        "raw_key",
        "source_version",
        "source_payload_hash",
        "local_payload_hash",
        "attempt_count",
    }
)
OPTIONAL_INPUT_FIELDS = frozenset({"roof_job", "realm_id"})
ALLOWED_INPUT_FIELDS = REQUIRED_INPUT_FIELDS | OPTIONAL_INPUT_FIELDS
REPLAY_FIELDS = (
    "reconciliation_id",
    "roof_job",
    "system_name",
    "entity_type",
    "external_entity_id",
    "realm_id",
    "local_doctype",
    "local_name",
    "direction",
    "status",
    "detected_at",
    "raw_key",
    "source_version",
    "source_payload_hash",
    "local_payload_hash",
    "attempt_count",
    "notes",
)
_REPLAY_SELECT = ", ".join(("name", *REPLAY_FIELDS))


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _nonretryable_identity_conflict(message: str) -> None:
    """Expose the one stable terminal outcome the Worker may safely reject.

    Auth, permission, routing, and ordinary validation failures remain
    retryable because an operator deployment repair can resolve them. Only an
    immutable identity already bound to different evidence is a durable
    business conflict. The Worker recognizes this exact code plus HTTP 409.
    """

    response = getattr(getattr(frappe, "local", None), "response", None)
    if response is not None:
        try:
            response["http_status_code"] = 409
        except (TypeError, AttributeError):
            setattr(response, "http_status_code", 409)
    _fail("quickbooks_reconciliation_identity_conflict", message)


def _clean_required(value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    if not isinstance(value, str):
        _fail("quickbooks_reconciliation_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= maximum) or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("quickbooks_reconciliation_invalid_input", f"{field} is invalid")
    return cleaned


def _clean_optional(value: Any, field: str, *, maximum: int) -> str | None:
    if value is None:
        return None
    return _clean_required(value, field, maximum=maximum)


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(
                "quickbooks_reconciliation_invalid_input",
                "reconciliation_json contains a duplicate key",
            )
        result[key] = value
    return result


def _parse_reconciliation_json(reconciliation_json: Any) -> dict[str, Any]:
    if (
        not isinstance(reconciliation_json, str)
        or not reconciliation_json
        or len(reconciliation_json) > MAX_JSON_LENGTH
    ):
        _fail(
            "quickbooks_reconciliation_invalid_input",
            "reconciliation_json must be nonempty JSON text",
        )
    try:
        payload = json.loads(reconciliation_json, object_pairs_hook=_parse_object)
    except (json.JSONDecodeError, TypeError):
        _fail(
            "quickbooks_reconciliation_invalid_input",
            "reconciliation_json must be one JSON object",
        )
    if not isinstance(payload, dict):
        _fail(
            "quickbooks_reconciliation_invalid_input",
            "reconciliation_json must be one JSON object",
        )
    missing = REQUIRED_INPUT_FIELDS - set(payload)
    unknown = set(payload) - ALLOWED_INPUT_FIELDS
    if missing or unknown:
        _fail(
            "quickbooks_reconciliation_invalid_input",
            "reconciliation_json has missing or unsupported fields",
        )
    return payload


def _assert_issuer(*, require_create: bool = True) -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail(
            "quickbooks_reconciliation_post_required",
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
            "quickbooks_reconciliation_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    actor = _clean_required(getattr(frappe.session, "user", None), "session_user")
    if actor == "Guest" or actor != configured:
        _fail(
            "quickbooks_reconciliation_issuer_auth_mismatch",
            "only the configured Worker integration user may issue Pending QuickBooks work",
            permission=True,
        )
    if QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE not in {
        str(role) for role in frappe.get_roles(actor)
    }:
        _fail(
            "quickbooks_reconciliation_issuer_role_missing",
            "the configured Worker user lacks the dedicated QuickBooks issuer role",
            permission=True,
        )
    if require_create and not frappe.has_permission("Integration Reconciliation", ptype="create", user=actor):
        _fail(
            "quickbooks_reconciliation_issuer_permission_denied",
            "the configured Worker integration user cannot create Integration Reconciliation",
            permission=True,
        )
    return actor


def _issued_document(payload: Mapping[str, Any]) -> dict[str, Any]:
    reconciliation_id = _clean_reconciliation_id(payload["reconciliation_id"])
    if _clean_required(payload["system_name"], "system_name") != "QuickBooks":
        _fail("quickbooks_reconciliation_invalid_input", "system_name must be QuickBooks")
    entity_type = _clean_required(payload["entity_type"], "entity_type")
    external_entity_id = _clean_required(payload["external_entity_id"], "external_entity_id")
    realm_id = _clean_optional(payload.get("realm_id"), "realm_id", maximum=32)
    source_version = _clean_required(payload["source_version"], "source_version")
    if entity_type not in QUICKBOOKS_ENTITY_TYPES or not QBO_ID_RE.fullmatch(external_entity_id):
        _fail("quickbooks_reconciliation_invalid_input", "QuickBooks entity identity is unsupported")
    if realm_id is not None and not QBO_ID_RE.fullmatch(realm_id):
        _fail("quickbooks_reconciliation_invalid_input", "QuickBooks realm identity is unsupported")
    if source_version not in QUICKBOOKS_OPERATIONS:
        _fail("quickbooks_reconciliation_invalid_input", "QuickBooks operation is unsupported")
    if _clean_required(payload["direction"], "direction") != "Inbound":
        _fail("quickbooks_reconciliation_invalid_input", "direction must be Inbound")
    if _clean_required(payload["status"], "status") != "Pending":
        _fail("quickbooks_initial_status_must_be_pending", "QuickBooks work must begin Pending")
    attempt_count = payload["attempt_count"]
    if isinstance(attempt_count, bool) or not isinstance(attempt_count, int) or attempt_count != 0:
        _fail("quickbooks_reconciliation_invalid_input", "attempt_count must begin at zero")
    source_payload_hash = _clean_required(payload["source_payload_hash"], "source_payload_hash", maximum=64)
    local_payload_hash = _clean_required(payload["local_payload_hash"], "local_payload_hash", maximum=64)
    if not SHA256_RE.fullmatch(source_payload_hash) or not SHA256_RE.fullmatch(local_payload_hash):
        _fail("quickbooks_reconciliation_invalid_input", "payload hashes must be lowercase SHA-256")
    if source_payload_hash == local_payload_hash:
        _fail(
            "premature_quickbooks_reconciliation",
            "a raw webhook receipt cannot reconcile itself without provider detail",
        )
    raw_key = _clean_required(payload["raw_key"], "raw_key", maximum=MAX_RAW_KEY_LENGTH)
    if not raw_key.startswith("raw/quickbooks/") or ".." in raw_key:
        _fail("quickbooks_reconciliation_invalid_input", "raw_key must be immutable QuickBooks evidence")
    roof_job = _clean_optional(payload.get("roof_job"), "roof_job", maximum=MAX_IDENTIFIER_LENGTH)
    local_doctype = _clean_required(payload["local_doctype"], "local_doctype")
    if (roof_job and local_doctype != "Payment Milestone") or (
        not roof_job and local_doctype != "Unresolved QuickBooks Event"
    ):
        _fail("quickbooks_reconciliation_invalid_input", "local linkage does not match verified job linkage")
    return {
        "reconciliation_id": reconciliation_id,
        "roof_job": roof_job,
        "system_name": "QuickBooks",
        "entity_type": entity_type,
        "external_entity_id": external_entity_id,
        "realm_id": realm_id,
        "local_doctype": local_doctype,
        "local_name": _clean_required(payload["local_name"], "local_name"),
        "direction": "Inbound",
        "status": "Pending",
        "detected_at": _clean_required(payload["detected_at"], "detected_at", maximum=MAX_DATETIME_LENGTH),
        "raw_key": raw_key,
        "source_version": source_version,
        "source_payload_hash": source_payload_hash,
        "local_payload_hash": local_payload_hash,
        "attempt_count": 0,
        "notes": PENDING_NOTES,
    }


def _lock_existing(reconciliation_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        f"""
        SELECT {_REPLAY_SELECT}
        FROM `tabIntegration Reconciliation`
        WHERE reconciliation_id = %s
        FOR UPDATE
        """,
        (reconciliation_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _nonretryable_identity_conflict("reconciliation_id is not unique")
    return dict(rows[0]) if rows else None


def _read_existing(reconciliation_id: str) -> dict[str, Any] | None:
    """Read one issuer-scoped record without granting generic REST access."""

    rows = frappe.db.sql(
        f"""
        SELECT {_REPLAY_SELECT}
        FROM `tabIntegration Reconciliation`
        WHERE reconciliation_id = %s
        """,
        (reconciliation_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _nonretryable_identity_conflict("reconciliation_id is not unique")
    return dict(rows[0]) if rows else None


def _clean_reconciliation_id(value: Any) -> str:
    reconciliation_id = _clean_required(value, "reconciliation_id")
    if not RECONCILIATION_ID_RE.fullmatch(reconciliation_id):
        _fail("quickbooks_reconciliation_invalid_input", "reconciliation_id is invalid")
    return reconciliation_id


def _readback_fields(existing: Mapping[str, Any]) -> dict[str, Any]:
    return {field: existing.get(field) for field in ("name", *REPLAY_FIELDS)}


def _same_value(left: Any, right: Any) -> bool:
    if left is None or left == "":
        return right is None or right == ""
    if right is None or right == "":
        return left is None or left == ""
    return str(left) == str(right)


def _same_issued_reconciliation(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    return existing.get("status") == "Pending" and all(
        _same_value(existing.get(field), expected.get(field)) for field in REPLAY_FIELDS
    )


@frappe.whitelist()
def issue_pending_reconciliation(reconciliation_json: str) -> dict[str, Any]:
    """Create one Pending reconciliation or return its exact immutable replay."""

    _assert_issuer()
    issued = _issued_document(_parse_reconciliation_json(reconciliation_json))
    existing = _lock_existing(issued["reconciliation_id"])
    if existing:
        if not _same_issued_reconciliation(existing, issued):
            _nonretryable_identity_conflict(
                "reconciliation_id is already bound to different immutable facts"
            )
        return {"name": existing["name"], "idempotent_replay": True}

    document = frappe.get_doc({"doctype": "Integration Reconciliation", **issued})
    with quickbooks_reconciliation_issuance_context(document):
        # Do not use ignore_permissions: the configured Worker principal must
        # retain its narrow create grant on this DocType.
        document.insert()
    return {"name": document.name, "idempotent_replay": False}


@frappe.whitelist()
def read_pending_reconciliation(reconciliation_id: str) -> dict[str, Any]:
    """Return bounded provider readback for one issuer-created reconciliation."""

    _assert_issuer(require_create=False)
    cleaned_id = _clean_reconciliation_id(reconciliation_id)
    existing = _read_existing(cleaned_id)
    if not existing:
        return {"found": False, "reconciliation_id": cleaned_id}
    return {"found": True, "reconciliation": _readback_fields(existing)}


@frappe.whitelist()
def check_issuer_readiness() -> dict[str, Any]:
    """Authenticated, non-mutating readiness probe used before new receipt acceptance."""

    return {"ready": True, "issuer": _assert_issuer()}
