"""Bounded customer-portal contract acceptance command.

The Worker verifies the customer portal challenge and signs a compact claim.
Frappe independently pins that Worker service user, verifies the HMAC, locks
the current offer lineage, and derives every durable acceptance fact itself.
No Hermes approval receipt participates in this customer acceptance path.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import math
import re
import time
from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import frappe

from ironwrap_roofing.access_control import CUSTOMER_ACCEPTANCE_SERVICE_ROLE
from ironwrap_roofing.document_validation import (
    customer_contract_acceptance_issuance_context,
)


SERVICE_USER_CONFIG_KEY = "ironwrap_customer_acceptance_service_user"
HMAC_CONFIG_KEY = "ironwrap_customer_acceptance_hmac_key"
SOURCE_SYSTEM = "ironwrap-customer-portal"
VERIFICATION_SOURCE = "ironwrap-worker-r2-customer-contract-acceptance"
PREPARE_PATH = (
    "/api/method/ironwrap_roofing.customer_contract_acceptance_api."
    "prepare_customer_portal_contract_acceptance"
)
COMMIT_PATH = (
    "/api/method/ironwrap_roofing.customer_contract_acceptance_api."
    "record_customer_portal_contract_acceptance"
)
MAX_CLAIM_BYTES = 32_768
MAX_IDENTIFIER_LENGTH = 140
MAX_R2_KEY_LENGTH = 500
MAX_CONTENT_TYPE_LENGTH = 255
MAX_SIGNER_NAME_LENGTH = 140
MAX_SIGNATURE_AGE_SECONDS = 300
MAX_CONTENT_LENGTH = 2_147_483_647
NONCE_CACHE_PREFIX = "ironwrap:customer-contract-acceptance:nonce:"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,140}$")
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{10,12}$")
QBO_ID_RE = re.compile(r"^[1-9][0-9]{0,31}$")

PREPARE_FIELDS = frozenset(
    {"tenant_id", "portal_link_id", "roof_job_id", "customer_id", "challenge_id"}
)
COMMIT_FIELDS = frozenset(
    {
        "acceptance_id",
        "challenge_id",
        "portal_link_id",
        "tenant_id",
        "roof_job_id",
        "customer_id",
        "quote_id",
        "quote_version",
        "proposal_pack_id",
        "terms_hash",
        "email_hash",
        "signer_name",
        "accepted_at",
        "receipt_key",
        "receipt_hash",
        "receipt_content_type",
        "receipt_content_length",
        "receipt_captured_at",
        "signer_ip",
    }
)
REQUIRED_PERMISSIONS = (
    ("Roof Job", "read"),
    ("Roofing Customer", "read"),
    ("Customer Quote", "read"),
    ("Customer Quote", "write"),
    ("Proposal Evidence Pack", "read"),
    ("Evidence Item", "create"),
    ("Contract Acceptance", "create"),
)


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _text(value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    if not isinstance(value, str):
        _fail("customer_contract_invalid_claim", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("customer_contract_invalid_claim", f"{field} is invalid")
    return cleaned


def _normalized_email_hash(value: Any) -> tuple[str, str]:
    """Return the challenge anchor: sha256(lowercase(trim(email)) encoded as UTF-8)."""

    email = _text(value, "customer.email", maximum=255)
    return email, hashlib.sha256(email.lower().encode("utf-8")).hexdigest()


def _optional_text(value: Any, field: str, *, maximum: int) -> str:
    if value is None or value == "":
        return ""
    return _text(value, field, maximum=maximum)


def _timestamp(value: Any, field: str) -> str:
    timestamp = _text(value, field, maximum=64)
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        _fail("customer_contract_invalid_claim", f"{field} must be an ISO timestamp")
    return timestamp


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        _fail("customer_contract_invalid_claim", f"{field} must be a positive integer")
    return value


def _terms_due_days(value: Any, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= 365
    ):
        _fail(
            "customer_contract_terms_unavailable",
            f"{field} must be an integer from 0 through 365",
        )
    return value


def _quickbooks_id(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=32)
    if not QBO_ID_RE.fullmatch(cleaned):
        _fail(
            "customer_contract_terms_unavailable",
            f"{field} must be an exact QuickBooks ID",
        )
    return cleaned


def _sha256(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    if not SHA256_RE.fullmatch(cleaned):
        _fail("customer_contract_invalid_claim", f"{field} must be lowercase SHA-256")
    return cleaned


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("customer_contract_invalid_claim", "claim has a duplicate key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    _fail("customer_contract_invalid_claim", f"claim has invalid JSON number {value}")


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        _fail("customer_contract_invalid_claim", "claim cannot be canonicalized")
        raise AssertionError from exc


def _parse_claim(customer_claim_json: Any, required_fields: frozenset[str]) -> dict[str, Any]:
    if (
        not isinstance(customer_claim_json, str)
        or not customer_claim_json
        or len(customer_claim_json.encode("utf-8")) > MAX_CLAIM_BYTES
    ):
        _fail("customer_contract_invalid_claim", "customer_claim_json is invalid")
    try:
        claim = json.loads(
            customer_claim_json,
            object_pairs_hook=_parse_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail("customer_contract_invalid_claim", "customer_claim_json must be one object")
    if not isinstance(claim, dict) or set(claim) != required_fields:
        _fail("customer_contract_invalid_claim", "claim fields are unsupported")
    if _canonical_json(claim) != customer_claim_json:
        _fail("customer_contract_invalid_claim", "customer_claim_json must be canonical")
    return claim


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
        reserved = cache.set(
            name=cache_key,
            value="1",
            nx=True,
            ex=expires_in_seconds,
        )
    except Exception:
        _fail(
            "customer_contract_nonce_unavailable",
            "nonce replay protection is unavailable",
            permission=True,
        )
    if not reserved:
        _fail(
            "customer_contract_nonce_replayed",
            "signed request nonce was already consumed",
            permission=True,
        )


def _assert_service_claim(customer_claim_json: str, path: str) -> str:
    request = getattr(frappe, "request", None)
    if getattr(request, "method", "").upper() != "POST":
        _fail("customer_contract_post_required", "this command accepts POST only", permission=True)
    configured_user = _text(
        _site_config(SERVICE_USER_CONFIG_KEY), SERVICE_USER_CONFIG_KEY
    )
    actor = _text(
        getattr(getattr(frappe, "session", None), "user", None), "session_user"
    )
    if actor == "Guest" or actor != configured_user:
        _fail(
            "customer_contract_service_user_mismatch",
            "only the configured customer acceptance service user may call this command",
            permission=True,
        )
    roles = {str(role) for role in frappe.get_roles(actor)}
    if CUSTOMER_ACCEPTANCE_SERVICE_ROLE not in roles:
        _fail(
            "customer_contract_service_role_missing",
            "the configured service user must hold the dedicated customer acceptance role",
            permission=True,
        )
    for doctype, permission in REQUIRED_PERMISSIONS:
        if not frappe.has_permission(doctype, ptype=permission, user=actor):
            _fail(
                "customer_contract_permission_denied",
                f"the service user lacks {permission} on {doctype}",
                permission=True,
            )
    key = _text(_site_config(HMAC_CONFIG_KEY), HMAC_CONFIG_KEY, maximum=4096)
    timestamp = _request_header("X-IronWrap-Acceptance-Timestamp")
    nonce = _request_header("X-IronWrap-Acceptance-Nonce")
    signature = _request_header("X-IronWrap-Acceptance-Signature")
    if not timestamp or not TIMESTAMP_RE.fullmatch(timestamp):
        _fail("customer_contract_hmac_invalid", "timestamp header is invalid", permission=True)
    if not nonce or not NONCE_RE.fullmatch(nonce):
        _fail("customer_contract_hmac_invalid", "nonce header is invalid", permission=True)
    if not signature or not SIGNATURE_RE.fullmatch(signature):
        _fail("customer_contract_hmac_invalid", "signature header is invalid", permission=True)
    now = time.time()
    signed_at = int(timestamp)
    if abs(now - signed_at) > MAX_SIGNATURE_AGE_SECONDS:
        _fail("customer_contract_hmac_expired", "signed customer claim is expired", permission=True)
    body_hash = hashlib.sha256(customer_claim_json.encode("utf-8")).hexdigest()
    signed = f"POST\n{path}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
    expected = base64.urlsafe_b64encode(
        hmac.new(key.encode("utf-8"), signed, hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(signature, expected):
        _fail("customer_contract_hmac_invalid", "signature does not match", permission=True)
    _consume_nonce(
        path,
        nonce,
        expires_in_seconds=max(
            1, math.ceil(signed_at + MAX_SIGNATURE_AGE_SECONDS - now)
        ),
    )
    return actor


def _one_locked(rows: list[Mapping[str, Any]], code: str) -> dict[str, Any]:
    if len(rows) != 1:
        _fail(code, "current record was not uniquely available")
    return dict(rows[0])


def _locked_anchors(roof_job_id: str, customer_id: str) -> dict[str, dict[str, Any]]:
    job = _one_locked(
        frappe.db.sql(
            """
            SELECT name, roof_job_id, customer, quotation
            FROM `tabRoof Job`
            WHERE roof_job_id = %s
            FOR UPDATE
            """,
            (roof_job_id,),
            as_dict=True,
        ),
        "customer_contract_job_missing",
    )
    customer = _one_locked(
        frappe.db.sql(
            """
            SELECT name, customer_id, display_name, email
            FROM `tabRoofing Customer`
            WHERE customer_id = %s
            FOR UPDATE
            """,
            (customer_id,),
            as_dict=True,
        ),
        "customer_contract_customer_missing",
    )
    if job.get("customer") != customer.get("name"):
        _fail("customer_contract_customer_mismatch", "customer is not linked to the Roof Job")
    quote_name = _text(job.get("quotation"), "job.quotation")
    quote = _one_locked(
        frappe.db.sql(
            """
            SELECT name, customer_quote_id, roof_job, customer, quote_version, status,
                   price_book_version, pricing_effective_at, subtotal, tax_amount,
                   tax_code, tax_rate, tax_policy_snapshot_json, quote_total, currency,
                   deposit_amount, amount_due, scope_summary, assumptions, exclusions,
                   quote_summary_json, price_rule_snapshot_json, acceptance_evidence,
                   contract_acceptance, accepted_at, qb_terms_ref, qb_terms_due_days
            FROM `tabCustomer Quote`
            WHERE name = %s
            FOR UPDATE
            """,
            (quote_name,),
            as_dict=True,
        ),
        "customer_contract_quote_missing",
    )
    if (
        quote.get("roof_job") != job.get("name")
        or quote.get("customer") != customer.get("name")
    ):
        _fail("customer_contract_quote_mismatch", "quote is not the current customer offer")
    packs = frappe.db.sql(
        """
        SELECT name, pack_id, roof_job, quotation, status, prepared_at, approved_at,
               evidence_summary_json, assumptions, exclusions
        FROM `tabProposal Evidence Pack`
        WHERE roof_job = %s AND quotation = %s AND status = 'Approved'
        FOR UPDATE
        """,
        (job["name"], quote["name"]),
        as_dict=True,
    )
    pack = _one_locked(packs, "customer_contract_published_pack_missing")
    if pack.get("roof_job") != job.get("name") or pack.get("quotation") != quote.get("name"):
        _fail("customer_contract_pack_mismatch", "published pack is not the current quote pack")
    return {"job": job, "customer": customer, "quote": quote, "pack": pack}


def _read_json(value: Any, field: str) -> Any:
    if not isinstance(value, str) or not value:
        _fail("customer_contract_terms_unavailable", f"{field} is unavailable")
    try:
        return json.loads(
            value, object_pairs_hook=_parse_object, parse_constant=_reject_json_constant
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail("customer_contract_terms_unavailable", f"{field} is not valid JSON")


def _money(value: Any, field: str, *, required: bool = True) -> str | None:
    if value is None or value == "":
        if required:
            _fail("customer_contract_terms_unavailable", f"{field} is unavailable")
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        _fail("customer_contract_terms_unavailable", f"{field} is invalid")
    if not amount.is_finite():
        _fail("customer_contract_terms_unavailable", f"{field} is invalid")
    normalized = amount.normalize()
    return (
        format(normalized, "f")
        if normalized != normalized.to_integral()
        else str(int(normalized))
    )


def _terms_snapshot(anchors: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    job = anchors["job"]
    customer = anchors["customer"]
    quote = anchors["quote"]
    pack = anchors["pack"]
    quote_version = _positive_int(quote.get("quote_version"), "quote.quote_version")
    return {
        "schema": "ironwrap.customer-contract-terms.v2",
        "anchor": {
            "roof_job_id": _text(job.get("roof_job_id"), "job.roof_job_id"),
            "customer_id": _text(customer.get("customer_id"), "customer.customer_id"),
            "quote_id": _text(quote.get("customer_quote_id"), "quote.customer_quote_id"),
            "quote_version": quote_version,
            "proposal_pack_id": _text(pack.get("pack_id"), "pack.pack_id"),
        },
        "quote": {
            "price_book_version": _text(
                quote.get("price_book_version"), "quote.price_book_version"
            ),
            "pricing_effective_at": _text(
                quote.get("pricing_effective_at"), "quote.pricing_effective_at"
            ),
            "currency": _text(quote.get("currency"), "quote.currency"),
            "subtotal": _money(quote.get("subtotal"), "quote.subtotal"),
            "tax_amount": _money(quote.get("tax_amount"), "quote.tax_amount"),
            "tax_code": _text(quote.get("tax_code"), "quote.tax_code"),
            "tax_rate": _money(quote.get("tax_rate"), "quote.tax_rate"),
            "quote_total": _money(quote.get("quote_total"), "quote.quote_total"),
            "deposit_amount": _money(
                quote.get("deposit_amount"), "quote.deposit_amount", required=False
            ),
            "amount_due": _money(quote.get("amount_due"), "quote.amount_due"),
            "qb_terms_ref": _quickbooks_id(
                quote.get("qb_terms_ref"), "quote.qb_terms_ref"
            ),
            "qb_terms_due_days": _terms_due_days(
                quote.get("qb_terms_due_days"), "quote.qb_terms_due_days"
            ),
            "scope_summary": _text(
                quote.get("scope_summary"), "quote.scope_summary", maximum=10_000
            ),
            "assumptions": _text(
                quote.get("assumptions"), "quote.assumptions", maximum=10_000
            ),
            "exclusions": _text(
                quote.get("exclusions"), "quote.exclusions", maximum=10_000
            ),
            "quote_summary": _read_json(
                quote.get("quote_summary_json"), "quote.quote_summary_json"
            ),
            "tax_policy_snapshot": _read_json(
                quote.get("tax_policy_snapshot_json"), "quote.tax_policy_snapshot_json"
            ),
            "price_rule_snapshot": _read_json(
                quote.get("price_rule_snapshot_json"), "quote.price_rule_snapshot_json"
            ),
        },
        "proposal": {
            "prepared_at": _text(pack.get("prepared_at"), "pack.prepared_at"),
            "published_at": _text(pack.get("approved_at"), "pack.approved_at"),
            "assumptions": _optional_text(
                pack.get("assumptions"), "pack.assumptions", maximum=10_000
            ),
            "exclusions": _optional_text(
                pack.get("exclusions"), "pack.exclusions", maximum=10_000
            ),
            "evidence_summary": _read_json(
                pack.get("evidence_summary_json"), "pack.evidence_summary_json"
            ),
        },
    }


def _prepare_claim(customer_claim_json: str) -> dict[str, Any]:
    claim = _parse_claim(customer_claim_json, PREPARE_FIELDS)
    return {field: _text(claim[field], field) for field in PREPARE_FIELDS}


def _commit_claim(customer_claim_json: str) -> dict[str, Any]:
    claim = _parse_claim(customer_claim_json, COMMIT_FIELDS)
    text_fields = COMMIT_FIELDS - {
        "quote_version",
        "receipt_content_length",
        "terms_hash",
        "email_hash",
        "receipt_hash",
        "receipt_key",
        "receipt_content_type",
        "signer_name",
        "signer_ip",
        "accepted_at",
        "receipt_captured_at",
    }
    values = {field: _text(claim[field], field) for field in text_fields}
    values.update(
        {
            "quote_version": _positive_int(claim["quote_version"], "quote_version"),
            "terms_hash": _sha256(claim["terms_hash"], "terms_hash"),
            "email_hash": _sha256(claim["email_hash"], "email_hash"),
            "receipt_hash": _sha256(claim["receipt_hash"], "receipt_hash"),
            "receipt_key": _text(
                claim["receipt_key"], "receipt_key", maximum=MAX_R2_KEY_LENGTH
            ),
            "receipt_content_type": _text(
                claim["receipt_content_type"],
                "receipt_content_type",
                maximum=MAX_CONTENT_TYPE_LENGTH,
            ),
            "signer_name": _text(
                claim["signer_name"], "signer_name", maximum=MAX_SIGNER_NAME_LENGTH
            ),
            "accepted_at": _timestamp(claim["accepted_at"], "accepted_at"),
            "receipt_captured_at": _timestamp(
                claim["receipt_captured_at"], "receipt_captured_at"
            ),
        }
    )
    content_length = claim["receipt_content_length"]
    if (
        isinstance(content_length, bool)
        or not isinstance(content_length, int)
        or not 1 <= content_length <= MAX_CONTENT_LENGTH
    ):
        _fail("customer_contract_invalid_claim", "receipt_content_length is invalid")
    values["receipt_content_length"] = content_length
    if (
        not values["receipt_key"].startswith("customer-contract-acceptance/v1/")
        or ".." in values["receipt_key"]
    ):
        _fail("customer_contract_invalid_claim", "receipt_key is not an acceptance receipt")
    try:
        values["signer_ip"] = str(
            ipaddress.ip_address(_text(claim["signer_ip"], "signer_ip", maximum=64))
        )
    except ValueError:
        _fail("customer_contract_invalid_claim", "signer_ip is invalid")
    return values


def _assert_claim_anchors(claim: Mapping[str, Any], terms: Mapping[str, Any]) -> None:
    anchor = terms["anchor"]
    for field in (
        "roof_job_id",
        "customer_id",
        "quote_id",
        "quote_version",
        "proposal_pack_id",
    ):
        if claim.get(field) != anchor.get(field):
            _fail(
                "customer_contract_anchor_mismatch",
                f"{field} no longer matches the prepared offer",
            )


def _locked_existing_acceptance(acceptance_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        """
        SELECT name, acceptance_id, roof_job, customer, customer_quote,
               proposal_evidence_pack, contract_version, status, signer_name,
               signer_email, signer_ip, accepted_at, acceptance_method,
               evidence_item, terms_hash, terms_snapshot_json, document_checksum,
               source_system, provider_reference, captured_by
        FROM `tabContract Acceptance`
        WHERE acceptance_id = %s
        FOR UPDATE
        """,
        (acceptance_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("customer_contract_acceptance_conflict", "acceptance id is not unique")
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
        _fail("customer_contract_acceptance_conflict", "evidence id is not unique")
    return dict(rows[0]) if rows else None


def _same(left: Any, right: Any) -> bool:
    if left in {None, ""} and right in {None, ""}:
        return True
    return str(left) == str(right)


def _assert_replay(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    if not all(_same(existing.get(field), expected.get(field)) for field in expected):
        _fail("customer_contract_acceptance_conflict", "acceptance id is bound to different facts")


def _assert_evidence_replay(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    if (
        existing.get("sync_state") != "Verified"
        or existing.get("verification_source") != VERIFICATION_SOURCE
        or not existing.get("verified_at")
    ):
        _fail(
            "customer_contract_acceptance_conflict",
            "receipt evidence is not verified by the customer acceptance Worker",
        )
    _assert_replay(
        existing,
        {
            field: value
            for field, value in expected.items()
            if field not in {"doctype", "verified_at"}
        },
    )


@frappe.whitelist()
def prepare_customer_portal_contract_acceptance(customer_claim_json: str) -> dict[str, Any]:
    """Return the exact currently published customer offer after HMAC verification."""

    _assert_service_claim(customer_claim_json, PREPARE_PATH)
    claim = _prepare_claim(customer_claim_json)
    anchors = _locked_anchors(claim["roof_job_id"], claim["customer_id"])
    quote = anchors["quote"]
    if quote.get("status") != "Approved":
        _fail("customer_contract_quote_not_preparable", "current quote is not Approved")
    terms = _terms_snapshot(anchors)
    terms_hash = hashlib.sha256(_canonical_json(terms).encode("utf-8")).hexdigest()
    customer = anchors["customer"]
    email, email_hash = _normalized_email_hash(customer.get("email"))
    return {
        "email": email,
        "email_hash": email_hash,
        "display_name": _text(customer.get("display_name"), "customer.display_name"),
        "roof_job_id": terms["anchor"]["roof_job_id"],
        "customer_id": terms["anchor"]["customer_id"],
        "quote_id": terms["anchor"]["quote_id"],
        "quote_version": terms["anchor"]["quote_version"],
        "proposal_pack_id": terms["anchor"]["proposal_pack_id"],
        "terms": terms,
        "terms_hash": terms_hash,
    }


@frappe.whitelist()
def record_customer_portal_contract_acceptance(
    customer_claim_json: str,
) -> dict[str, str]:
    """Issue one immutable acceptance and its verified Worker R2 receipt evidence."""

    actor = _assert_service_claim(customer_claim_json, COMMIT_PATH)
    claim = _commit_claim(customer_claim_json)
    anchors = _locked_anchors(claim["roof_job_id"], claim["customer_id"])
    terms = _terms_snapshot(anchors)
    terms_json = _canonical_json(terms)
    terms_hash = hashlib.sha256(terms_json.encode("utf-8")).hexdigest()
    _assert_claim_anchors(claim, terms)
    if claim["terms_hash"] != terms_hash:
        _fail(
            "customer_contract_terms_mismatch",
            "terms hash no longer matches the published offer",
        )
    quote = anchors["quote"]
    pack = anchors["pack"]
    customer = anchors["customer"]
    customer_email, customer_email_hash = _normalized_email_hash(customer.get("email"))
    if claim["email_hash"] != customer_email_hash:
        _fail(
            "customer_contract_email_mismatch",
            "challenge email no longer matches the locked customer",
        )
    evidence_id = f"contract-receipt:{claim['acceptance_id']}"
    contract_version = f"{quote['customer_quote_id']}:v{claim['quote_version']}"
    evidence = {
        "doctype": "Evidence Item",
        "evidence_id": evidence_id,
        "device_action_id": claim["acceptance_id"],
        "roof_job": anchors["job"]["name"],
        "evidence_type": "Signed Document",
        "proof_owner": actor,
        "proof_slot": "Contract",
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
        "customer_safe": 0,
        "summary": "Customer portal contract acceptance receipt",
    }
    acceptance = {
        "doctype": "Contract Acceptance",
        "acceptance_id": claim["acceptance_id"],
        "roof_job": anchors["job"]["name"],
        "customer": customer["name"],
        "customer_quote": quote["name"],
        "proposal_evidence_pack": pack["name"],
        "contract_version": contract_version,
        "status": "Accepted",
        "signer_name": claim["signer_name"],
        "signer_email": customer_email,
        "signer_ip": claim["signer_ip"],
        "accepted_at": claim["accepted_at"],
        "acceptance_method": "Click to Accept",
        "evidence_item": evidence_id,
        "terms_hash": terms_hash,
        "terms_snapshot_json": terms_json,
        "document_checksum": claim["receipt_hash"],
        "source_system": SOURCE_SYSTEM,
        "provider_reference": claim["challenge_id"],
        "captured_by": actor,
    }
    existing = _locked_existing_acceptance(claim["acceptance_id"])
    if existing:
        _assert_replay(
            existing, {field: value for field, value in acceptance.items() if field != "doctype"}
        )
        existing_evidence = _locked_existing_evidence(evidence_id)
        if existing_evidence is None:
            _fail(
                "customer_contract_acceptance_conflict",
                "existing acceptance is missing its receipt evidence",
            )
        _assert_evidence_replay(existing_evidence, evidence)
        if (
            quote.get("status") != "Accepted"
            or quote.get("contract_acceptance") != existing.get("name")
            or quote.get("acceptance_evidence") != existing_evidence.get("name")
        ):
            _fail(
                "customer_contract_acceptance_conflict",
                "quote is not linked to the existing acceptance",
            )
        return {"acceptance_id": claim["acceptance_id"]}
    if quote.get("status") != "Approved" or any(
        quote.get(field)
        for field in ("acceptance_evidence", "contract_acceptance", "accepted_at")
    ):
        _fail(
            "customer_contract_quote_not_preparable",
            "quote has already left the acceptance-ready state",
        )
    evidence_document = frappe.get_doc(evidence)
    acceptance_document = frappe.get_doc(acceptance)
    quote_document = frappe.get_doc("Customer Quote", quote["name"])
    quote_document.status = "Accepted"
    quote_document.acceptance_evidence = evidence_id
    quote_document.contract_acceptance = claim["acceptance_id"]
    quote_document.accepted_at = claim["accepted_at"]
    with customer_contract_acceptance_issuance_context(
        evidence_document, acceptance_document, quote_document
    ):
        evidence_document.insert()
        acceptance_document.insert()
        quote_document.save()
    return {"acceptance_id": claim["acceptance_id"]}
