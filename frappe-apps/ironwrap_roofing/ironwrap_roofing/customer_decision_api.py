"""Bounded customer-portal material-decision command.

The Worker resolves the customer's portal capability, confirms the chosen Option
Package is Approved and belongs to the job, writes an immutable R2 receipt, and
signs a compact claim.  Frappe independently pins that Worker service user,
verifies the HMAC, re-locks the job/customer/package lineage, and derives every
durable fact itself.

What this command deliberately does not do is move money or scope.  A portal
selection is a *provisional* signal: it records what the customer prefers and
the evidence that they said so.  Reconciling that preference into a Customer
Quote stays an estimator's action, matching the product's human-verification
rule, and matching the fact that Customer Decision carries no approval state of
its own.  No Hermes approval receipt participates in this path.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import time
from collections.abc import Mapping
from datetime import datetime
from typing import Any

import frappe

from ironwrap_roofing.access_control import CUSTOMER_DECISION_SERVICE_ROLE


SERVICE_USER_CONFIG_KEY = "ironwrap_customer_decision_service_user"
HMAC_CONFIG_KEY = "ironwrap_customer_decision_hmac_key"
SOURCE_SYSTEM = "ironwrap-customer-portal"
SOURCE_CHANNEL = "customer_portal"
VERIFICATION_SOURCE = "ironwrap-worker-r2-customer-portal-decision"
RECORD_PATH = (
    "/api/method/ironwrap_roofing.customer_decision_api."
    "record_customer_portal_material_decision"
)
MAX_CLAIM_BYTES = 8_192
MAX_IDENTIFIER_LENGTH = 140
MAX_LABEL_LENGTH = 200
MAX_R2_KEY_LENGTH = 500
MAX_CONTENT_TYPE_LENGTH = 255
MAX_SIGNATURE_AGE_SECONDS = 300
MAX_CONTENT_LENGTH = 2_147_483_647
NONCE_CACHE_PREFIX = "ironwrap:customer-portal-decision:nonce:"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,140}$")
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{10,12}$")
DECISION_ID_RE = re.compile(r"^decision_[0-9a-f][0-9a-f-]{15,99}$")

RECORD_FIELDS = frozenset(
    {
        "decision_id",
        "portal_link_id",
        "tenant_id",
        "roof_job_id",
        "customer_id",
        "option_package_id",
        "option_label",
        "selected_at",
        "receipt_key",
        "receipt_hash",
        "receipt_content_type",
        "receipt_content_length",
        "receipt_captured_at",
    }
)
REQUIRED_PERMISSIONS = (
    ("Roof Job", "read"),
    ("Roofing Customer", "read"),
    ("Option Package", "read"),
    ("Evidence Item", "create"),
    ("Customer Decision", "create"),
)


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _text(value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    if not isinstance(value, str):
        _fail("customer_decision_invalid_claim", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("customer_decision_invalid_claim", f"{field} is invalid")
    return cleaned


def _timestamp(value: Any, field: str) -> str:
    timestamp = _text(value, field, maximum=64)
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        _fail("customer_decision_invalid_claim", f"{field} must be an ISO timestamp")
    return timestamp


def _sha256(value: Any, field: str) -> str:
    digest = _text(value, field, maximum=64)
    if not SHA256_RE.fullmatch(digest):
        _fail("customer_decision_invalid_claim", f"{field} must be a sha256 hex digest")
    return digest


def _content_length(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not (
        0 < value <= MAX_CONTENT_LENGTH
    ):
        _fail("customer_decision_invalid_claim", f"{field} must be a positive integer")
    return value


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate keys so a signed claim has exactly one reading."""

    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            _fail("customer_decision_invalid_claim", "claim has a duplicate key")
        seen[key] = value
    return seen


def _reject_json_constant(value: str) -> None:
    _fail("customer_decision_invalid_claim", f"claim may not contain {value}")


def _canonical_json(value: Any) -> str:
    if isinstance(value, dict):
        body = ",".join(
            f"{json.dumps(key)}:{_canonical_json(value[key])}"
            for key in sorted(value)
        )
        return f"{{{body}}}"
    if isinstance(value, list):
        return f"[{','.join(_canonical_json(item) for item in value)}]"
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        _fail("customer_decision_invalid_claim", "claim may not contain a non-finite number")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _parse_claim(customer_claim_json: Any) -> dict[str, Any]:
    if (
        not isinstance(customer_claim_json, str)
        or not customer_claim_json
        or len(customer_claim_json.encode("utf-8")) > MAX_CLAIM_BYTES
    ):
        _fail("customer_decision_invalid_claim", "customer_claim_json is invalid")
    try:
        claim = json.loads(
            customer_claim_json,
            object_pairs_hook=_parse_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail("customer_decision_invalid_claim", "customer_claim_json must be one object")
    if not isinstance(claim, dict) or set(claim) != RECORD_FIELDS:
        _fail("customer_decision_invalid_claim", "claim fields are unsupported")
    if _canonical_json(claim) != customer_claim_json:
        _fail("customer_decision_invalid_claim", "customer_claim_json must be canonical")
    decision_id = _text(claim["decision_id"], "decision_id", maximum=100)
    if not DECISION_ID_RE.fullmatch(decision_id):
        _fail("customer_decision_invalid_claim", "decision_id is invalid")
    return {
        "decision_id": decision_id,
        "portal_link_id": _text(claim["portal_link_id"], "portal_link_id"),
        "tenant_id": _text(claim["tenant_id"], "tenant_id", maximum=64),
        "roof_job_id": _text(claim["roof_job_id"], "roof_job_id"),
        "customer_id": _text(claim["customer_id"], "customer_id"),
        "option_package_id": _text(claim["option_package_id"], "option_package_id"),
        "option_label": _text(claim["option_label"], "option_label", maximum=MAX_LABEL_LENGTH),
        "selected_at": _timestamp(claim["selected_at"], "selected_at"),
        "receipt_key": _text(claim["receipt_key"], "receipt_key", maximum=MAX_R2_KEY_LENGTH),
        "receipt_hash": _sha256(claim["receipt_hash"], "receipt_hash"),
        "receipt_content_type": _text(
            claim["receipt_content_type"],
            "receipt_content_type",
            maximum=MAX_CONTENT_TYPE_LENGTH,
        ),
        "receipt_content_length": _content_length(
            claim["receipt_content_length"], "receipt_content_length"
        ),
        "receipt_captured_at": _timestamp(claim["receipt_captured_at"], "receipt_captured_at"),
    }


def _request_header(name: str) -> str | None:
    headers = getattr(getattr(frappe, "request", None), "headers", None)
    getter = getattr(headers, "get", None)
    value = getter(name) if callable(getter) else None
    if value is None and isinstance(headers, Mapping):
        value = headers.get(name.lower())
    return value if isinstance(value, str) else None


def _site_config(key: str) -> Any:
    configuration = getattr(frappe, "conf", {})
    getter = getattr(configuration, "get", None)
    return getter(key) if callable(getter) else None


def _consume_nonce(path: str, nonce: str, *, expires_in_seconds: int) -> None:
    """Atomically reserve one signed request nonce for its full HMAC lifetime."""

    nonce_hash = hashlib.sha256(f"{path}\n{nonce}".encode("utf-8")).hexdigest()
    try:
        cache = frappe.cache()
        cache_key = cache.make_key(f"{NONCE_CACHE_PREFIX}{nonce_hash}")
        reserved = cache.set(name=cache_key, value="1", nx=True, ex=expires_in_seconds)
    except Exception:
        _fail(
            "customer_decision_nonce_unavailable",
            "nonce replay protection is unavailable",
            permission=True,
        )
    if not reserved:
        _fail(
            "customer_decision_nonce_replayed",
            "signed request nonce was already consumed",
            permission=True,
        )


def _assert_service_claim(customer_claim_json: str) -> str:
    request = getattr(frappe, "request", None)
    if getattr(request, "method", "").upper() != "POST":
        _fail("customer_decision_post_required", "this command accepts POST only", permission=True)
    configured_user = _text(_site_config(SERVICE_USER_CONFIG_KEY), SERVICE_USER_CONFIG_KEY)
    actor = _text(getattr(getattr(frappe, "session", None), "user", None), "session_user")
    if actor == "Guest" or actor != configured_user:
        _fail(
            "customer_decision_service_user_mismatch",
            "only the configured customer decision service user may call this command",
            permission=True,
        )
    roles = {str(role) for role in frappe.get_roles(actor)}
    if CUSTOMER_DECISION_SERVICE_ROLE not in roles:
        _fail(
            "customer_decision_service_role_missing",
            "the configured service user must hold the dedicated customer decision role",
            permission=True,
        )
    for doctype, permission in REQUIRED_PERMISSIONS:
        if not frappe.has_permission(doctype, ptype=permission, user=actor):
            _fail(
                "customer_decision_permission_denied",
                f"the service user lacks {permission} on {doctype}",
                permission=True,
            )
    key = _text(_site_config(HMAC_CONFIG_KEY), HMAC_CONFIG_KEY, maximum=4096)
    timestamp = _request_header("X-IronWrap-Decision-Timestamp")
    nonce = _request_header("X-IronWrap-Decision-Nonce")
    signature = _request_header("X-IronWrap-Decision-Signature")
    if not timestamp or not TIMESTAMP_RE.fullmatch(timestamp):
        _fail("customer_decision_hmac_invalid", "timestamp header is invalid", permission=True)
    if not nonce or not NONCE_RE.fullmatch(nonce):
        _fail("customer_decision_hmac_invalid", "nonce header is invalid", permission=True)
    if not signature or not SIGNATURE_RE.fullmatch(signature):
        _fail("customer_decision_hmac_invalid", "signature header is invalid", permission=True)
    now = time.time()
    signed_at = int(timestamp)
    if abs(now - signed_at) > MAX_SIGNATURE_AGE_SECONDS:
        _fail("customer_decision_hmac_expired", "signed customer claim is expired", permission=True)
    body_hash = hashlib.sha256(customer_claim_json.encode("utf-8")).hexdigest()
    signed = f"POST\n{RECORD_PATH}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
    expected = base64.urlsafe_b64encode(
        hmac.new(key.encode("utf-8"), signed, hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(signature, expected):
        _fail("customer_decision_hmac_invalid", "signature does not match", permission=True)
    _consume_nonce(
        RECORD_PATH,
        nonce,
        expires_in_seconds=max(1, math.ceil(signed_at + MAX_SIGNATURE_AGE_SECONDS - now)),
    )
    return actor


def _one_locked(rows: list[Mapping[str, Any]], code: str) -> dict[str, Any]:
    if len(rows) != 1:
        _fail(code, "current record was not uniquely available")
    return dict(rows[0])


def _locked_anchors(claim: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Re-derive the job/customer/package lineage under row locks.

    The Worker already checked all three, but it checked them through a read
    contract and a moment earlier.  Frappe owns the record, so Frappe re-checks:
    a package retired between the customer's tap and this call must not land.
    """

    job = _one_locked(
        frappe.db.sql(
            """
            SELECT name, roof_job_id, customer
            FROM `tabRoof Job`
            WHERE roof_job_id = %s
            FOR UPDATE
            """,
            (claim["roof_job_id"],),
            as_dict=True,
        ),
        "customer_decision_job_missing",
    )
    customer = _one_locked(
        frappe.db.sql(
            """
            SELECT name, customer_id, display_name
            FROM `tabRoofing Customer`
            WHERE customer_id = %s
            FOR UPDATE
            """,
            (claim["customer_id"],),
            as_dict=True,
        ),
        "customer_decision_customer_missing",
    )
    if job.get("customer") != customer.get("name"):
        _fail("customer_decision_customer_mismatch", "customer is not linked to the Roof Job")
    package = _one_locked(
        frappe.db.sql(
            """
            SELECT name, option_package_id, roof_job, package_name, tier, status
            FROM `tabOption Package`
            WHERE option_package_id = %s
            FOR UPDATE
            """,
            (claim["option_package_id"],),
            as_dict=True,
        ),
        "customer_decision_option_package_missing",
    )
    if package.get("roof_job") != job.get("name"):
        _fail(
            "customer_decision_option_package_mismatch",
            "option package does not belong to this Roof Job",
        )
    if package.get("status") != "Approved":
        _fail(
            "customer_decision_option_package_not_selectable",
            "only an Approved option package may be selected by a customer",
        )
    return {"job": job, "customer": customer, "package": package}


def _locked_existing_decision(decision_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        """
        SELECT name, decision_id, roof_job, customer, decision_type, status,
               decision_value, decision_summary, source_channel, decided_at,
               captured_by, evidence_item, option_package
        FROM `tabCustomer Decision`
        WHERE decision_id = %s
        FOR UPDATE
        """,
        (decision_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("customer_decision_conflict", "decision id is not unique")
    return dict(rows[0]) if rows else None


def _locked_existing_evidence(evidence_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        """
        SELECT name, evidence_id, device_action_id, roof_job, evidence_type,
               proof_owner, proof_slot, source_system, r2_key, content_checksum,
               checksum_algorithm, content_type, content_length, capture_actor,
               captured_at, sync_state, verified_at, verification_source,
               customer_safe, summary
        FROM `tabEvidence Item`
        WHERE evidence_id = %s
        FOR UPDATE
        """,
        (evidence_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("customer_decision_conflict", "evidence id is not unique")
    return dict(rows[0]) if rows else None


def _same(left: Any, right: Any) -> bool:
    if left in {None, ""} and right in {None, ""}:
        return True
    return str(left) == str(right)


def _assert_replay(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    if not all(_same(existing.get(field), expected.get(field)) for field in expected):
        _fail("customer_decision_conflict", "decision id is bound to different facts")


@frappe.whitelist()
def record_customer_portal_material_decision(
    customer_claim_json: str,
) -> dict[str, str]:
    """Record one provisional customer material selection and its R2 receipt evidence."""

    actor = _assert_service_claim(customer_claim_json)
    claim = _parse_claim(customer_claim_json)
    anchors = _locked_anchors(claim)
    job = anchors["job"]
    customer = anchors["customer"]
    package = anchors["package"]

    evidence_id = f"decision-receipt:{claim['decision_id']}"
    package_label = (
        package.get("package_name") or package.get("tier") or claim["option_package_id"]
    )
    tier = package.get("tier")
    summary = (
        f"Customer selected option package {package_label}"
        + (f" ({tier})" if tier else "")
        + " in the project portal. Provisional until an estimator confirms it."
    )
    evidence = {
        "doctype": "Evidence Item",
        "evidence_id": evidence_id,
        "device_action_id": claim["decision_id"],
        "roof_job": job["name"],
        # Evidence Item's evidence_type Select has no customer-interaction member, and adding one
        # would edit a shipped DocType for a receipt that is genuinely "Other". proof_slot
        # "Communication" plus the dedicated source_system is what identifies this record.
        "evidence_type": "Other",
        "proof_owner": actor,
        "proof_slot": "Communication",
        "source_system": SOURCE_SYSTEM,
        "r2_key": claim["receipt_key"],
        "content_checksum": claim["receipt_hash"],
        "checksum_algorithm": "SHA-256",
        "content_type": claim["receipt_content_type"],
        "content_length": claim["receipt_content_length"],
        "capture_actor": actor,
        "captured_at": claim["receipt_captured_at"],
        "sync_state": "Verified",
        "verified_at": str(frappe.utils.now_datetime()),
        "verification_source": VERIFICATION_SOURCE,
        # The customer already knows what they picked; showing them their own receipt in the
        # progress feed would be noise, not proof.
        "customer_safe": 0,
        "summary": summary,
    }
    decision = {
        "doctype": "Customer Decision",
        "decision_id": claim["decision_id"],
        "roof_job": job["name"],
        "customer": customer["name"],
        "decision_type": "Material Selection",
        "status": "Recorded",
        "decision_value": claim["option_label"],
        "decision_summary": summary,
        "source_channel": SOURCE_CHANNEL,
        "decided_at": claim["selected_at"],
        "captured_by": actor,
        "evidence_item": evidence_id,
        "option_package": package["name"],
    }

    existing = _locked_existing_decision(claim["decision_id"])
    if existing:
        _assert_replay(
            existing,
            {field: value for field, value in decision.items() if field != "doctype"},
        )
        existing_evidence = _locked_existing_evidence(evidence_id)
        if existing_evidence is None:
            _fail(
                "customer_decision_conflict",
                "existing decision is missing its receipt evidence",
            )
        _assert_replay(
            existing_evidence,
            {field: value for field, value in evidence.items() if field != "doctype"},
        )
        return {"decision_id": claim["decision_id"]}

    frappe.get_doc(evidence).insert()
    frappe.get_doc(decision).insert()
    return {"decision_id": claim["decision_id"]}
