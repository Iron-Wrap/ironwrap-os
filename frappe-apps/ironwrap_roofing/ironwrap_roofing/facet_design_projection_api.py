"""Project one signed Facet v2 decision into evidence and a blank quote revision.

The Worker has already preserved and verified the event. This command independently
authenticates a dedicated service principal and HMAC, locks the exact job/source quote,
and appends only immutable evidence, reconciliation, and an empty Draft Customer Quote.
It never copies or invents pricing, tax, scope, payment, approval, acceptance, or terms.
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

from ironwrap_roofing.access_control import FACET_DESIGN_PROJECTION_SERVICE_ROLE
from ironwrap_roofing.document_validation import (
    facet_design_projection_issuance_context,
)


SERVICE_USER_CONFIG_KEY = "ironwrap_facet_design_projection_service_user"
HMAC_CONFIG_KEY = "ironwrap_facet_design_projection_hmac_key"
SOURCE_SYSTEM = "ironwrap-facet-design"
VERIFICATION_SOURCE = "ironwrap-worker-r2-facet-design-projection"
EVENT_TYPE = "facet.design.customer_approved.v2"
EVENT_SCHEMA_VERSION = 2
IDENTITY_ASSURANCE = "oidc"
RECEIPT_SCHEMA = "ironwrap.facet-design-projection-receipt.v2"
RECEIPT_SIGNATURE_CONTEXT = "ironwrap.facet-design-projection.receipt.v2"
COMMAND_PATH = (
    "/api/method/ironwrap_roofing.facet_design_projection_api."
    "record_facet_design_proposal_evidence"
)
MAX_CLAIM_BYTES = 32_768
MAX_SIGNATURE_AGE_SECONDS = 300
MAX_CONTENT_LENGTH = 524_288
NONCE_CACHE_PREFIX = "ironwrap:facet-design-projection:nonce:"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$")
TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,140}$")
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{10,12}$")
PROJECT_LINK_RE = re.compile(r"^ironwrap-project-v1:[0-9a-f]{64}$")
PRODUCER_LINK_RE = re.compile(r"^ironwrap-identity-v1:[0-9a-f]{64}$")
CUSTOMER_LINK_RE = re.compile(r"^facet-customer-oidc-v1:[0-9a-f]{64}$")
OIDC_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
DECISIONS = {"approved", "corrected", "superseded", "withdrawn"}
ACTIVE_DECISIONS = {"approved", "corrected"}

CLAIM_FIELDS = frozenset(
    {
        "approval_receipt_id",
        "approval_receipt_sha256",
        "association_sha256",
        "brand_id",
        "customer_party_ref",
        "customer_quote_id",
        "decision_kind",
        "design_revision_id",
        "design_revision_sha256",
        "destination_tenant_id",
        "event_id",
        "event_type",
        "external_customer_identity_link_id",
        "external_project_link_id",
        "facet_project_id",
        "frozen_evidence_sha256",
        "identity_assurance",
        "occurred_at",
        "oidc_issuer",
        "oidc_subject_sha256",
        "previous_event_id",
        "producer_identity_link_id",
        "raw_content_length",
        "raw_key",
        "raw_sha256",
        "reason_sha256",
        "received_at",
        "roof_job_id",
        "schema_version",
        "source_environment",
        "source_issuer",
        "source_tenant_id",
    }
)
REQUIRED_PERMISSIONS = (
    ("Roof Job", "read"),
    ("Customer Quote", "read"),
    ("Customer Quote", "create"),
    ("Customer Quote", "write"),
    ("Evidence Item", "create"),
    ("Integration Reconciliation", "create"),
)
BLANK_QUOTE_FIELDS = (
    "price_book_version",
    "pricing_effective_at",
    "price_rule_snapshot_json",
    "subtotal",
    "tax_amount",
    "tax_code",
    "tax_rate",
    "tax_policy_snapshot_json",
    "quote_total",
    "currency",
    "deposit_amount",
    "amount_due",
    "amount_paid",
    "balance_due",
    "payment_status",
    "payment_due_date",
    "payment_truth_source",
    "payment_truth_at",
    "qb_item_ref",
    "qb_tax_code_ref",
    "qb_terms_ref",
    "qb_terms_due_days",
    "valid_until",
    "approved_by",
    "approved_at",
    "acceptance_evidence",
    "contract_acceptance",
    "accepted_at",
    "scope_summary",
    "assumptions",
    "exclusions",
    "quote_summary_json",
    "notes",
)
RECONCILIATION_REPLAY_FIELDS = (
    "reconciliation_id",
    "roof_job",
    "system_name",
    "entity_type",
    "external_entity_id",
    "local_doctype",
    "local_name",
    "direction",
    "detected_at",
    "raw_key",
    "source_version",
    "source_amount",
    "local_amount",
    "currency",
    "source_payload_hash",
    "local_payload_hash",
    "attempt_count",
    "notes",
    "diff_json",
)


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _text(value: Any, field: str, *, maximum: int = 160) -> str:
    if not isinstance(value, str):
        _fail("facet_design_projection_invalid_claim", f"{field} must be text")
    cleaned = value.strip()
    if (
        not cleaned
        or len(cleaned) > maximum
        or any(character in cleaned for character in ("\x00", "\r", "\n"))
    ):
        _fail("facet_design_projection_invalid_claim", f"{field} is invalid")
    return cleaned


def _opaque(value: Any, field: str, *, maximum: int = 160) -> str:
    cleaned = _text(value, field, maximum=maximum)
    if not IDENTIFIER_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} is not a safe identifier")
    return cleaned


def _sha256(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    if not SHA256_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} must be SHA-256")
    return cleaned


def _uuid(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=36)
    if not UUID_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} must be UUID")
    return cleaned


def _timestamp(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    try:
        parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    except ValueError:
        _fail("facet_design_projection_invalid_claim", f"{field} must be ISO time")
    if parsed.tzinfo is None:
        _fail("facet_design_projection_invalid_claim", f"{field} must include timezone")
    return cleaned


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError):
        _fail("facet_design_projection_invalid_claim", "claim cannot be canonicalized")
    raise AssertionError("unreachable")


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("facet_design_projection_invalid_claim", "claim has duplicate key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    _fail("facet_design_projection_invalid_claim", f"invalid JSON number {value}")


def _parse_claim(facet_claim_json: Any) -> dict[str, Any]:
    if (
        not isinstance(facet_claim_json, str)
        or not facet_claim_json
        or len(facet_claim_json.encode("utf-8")) > MAX_CLAIM_BYTES
    ):
        _fail("facet_design_projection_invalid_claim", "facet_claim_json is invalid")
    try:
        claim = json.loads(
            facet_claim_json,
            object_pairs_hook=_parse_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail("facet_design_projection_invalid_claim", "facet_claim_json must be one object")
    if not isinstance(claim, dict) or set(claim) != CLAIM_FIELDS:
        _fail("facet_design_projection_invalid_claim", "only the exact signed v2 claim is supported")
    if _canonical_json(claim) != facet_claim_json:
        _fail("facet_design_projection_invalid_claim", "facet_claim_json must be canonical")
    if claim["event_type"] != EVENT_TYPE or claim["schema_version"] != EVENT_SCHEMA_VERSION:
        _fail("facet_design_projection_event_version_mismatch", "legacy events are quarantined")
    result = {
        "approval_receipt_id": _uuid(claim["approval_receipt_id"], "approval_receipt_id"),
        "approval_receipt_sha256": _sha256(
            claim["approval_receipt_sha256"], "approval_receipt_sha256"
        ),
        "association_sha256": _sha256(claim["association_sha256"], "association_sha256"),
        "brand_id": _text(claim["brand_id"], "brand_id", maximum=64),
        "customer_party_ref": _sha256(claim["customer_party_ref"], "customer_party_ref"),
        "customer_quote_id": _opaque(claim["customer_quote_id"], "customer_quote_id"),
        "decision_kind": _text(claim["decision_kind"], "decision_kind", maximum=16),
        "design_revision_id": _opaque(claim["design_revision_id"], "design_revision_id"),
        "design_revision_sha256": _sha256(
            claim["design_revision_sha256"], "design_revision_sha256"
        ),
        "destination_tenant_id": _text(
            claim["destination_tenant_id"], "destination_tenant_id", maximum=64
        ),
        "event_id": _uuid(claim["event_id"], "event_id"),
        "event_type": EVENT_TYPE,
        "external_customer_identity_link_id": _text(
            claim["external_customer_identity_link_id"],
            "external_customer_identity_link_id",
        ),
        "external_project_link_id": _text(
            claim["external_project_link_id"], "external_project_link_id"
        ),
        "facet_project_id": _uuid(claim["facet_project_id"], "facet_project_id"),
        "frozen_evidence_sha256": _sha256(
            claim["frozen_evidence_sha256"], "frozen_evidence_sha256"
        ),
        "identity_assurance": _text(claim["identity_assurance"], "identity_assurance"),
        "occurred_at": _timestamp(claim["occurred_at"], "occurred_at"),
        "oidc_issuer": _text(claim["oidc_issuer"], "oidc_issuer"),
        "oidc_subject_sha256": _sha256(
            claim["oidc_subject_sha256"], "oidc_subject_sha256"
        ),
        "previous_event_id": claim["previous_event_id"],
        "producer_identity_link_id": _text(
            claim["producer_identity_link_id"], "producer_identity_link_id"
        ),
        "raw_content_length": claim["raw_content_length"],
        "raw_key": _text(claim["raw_key"], "raw_key", maximum=500),
        "raw_sha256": _sha256(claim["raw_sha256"], "raw_sha256"),
        "reason_sha256": claim["reason_sha256"],
        "received_at": _timestamp(claim["received_at"], "received_at"),
        "roof_job_id": _opaque(claim["roof_job_id"], "roof_job_id"),
        "schema_version": EVENT_SCHEMA_VERSION,
        "source_environment": _opaque(claim["source_environment"], "source_environment"),
        "source_issuer": _opaque(claim["source_issuer"], "source_issuer"),
        "source_tenant_id": _uuid(claim["source_tenant_id"], "source_tenant_id"),
    }
    if not TENANT_RE.fullmatch(result["destination_tenant_id"]):
        _fail("facet_design_projection_invalid_claim", "destination tenant is invalid")
    if result["source_issuer"] != "facet" or result["identity_assurance"] != IDENTITY_ASSURANCE:
        _fail("facet_design_projection_identity_assurance_mismatch", "OIDC v2 is required")
    if result["decision_kind"] not in DECISIONS:
        _fail("facet_design_projection_decision_not_projectable", "decision cannot create a Draft")
    if not PROJECT_LINK_RE.fullmatch(result["external_project_link_id"]):
        _fail("facet_design_projection_invalid_claim", "project link is invalid")
    if not PRODUCER_LINK_RE.fullmatch(result["producer_identity_link_id"]):
        _fail("facet_design_projection_invalid_claim", "producer link is invalid")
    if not CUSTOMER_LINK_RE.fullmatch(result["external_customer_identity_link_id"]):
        _fail("facet_design_projection_invalid_claim", "customer link is invalid")
    if result["oidc_issuer"] not in OIDC_ISSUERS:
        _fail("facet_design_projection_identity_assurance_mismatch", "OIDC issuer is unsupported")
    if result["design_revision_id"] != f"facet-json-v1:{result['design_revision_sha256']}":
        _fail("facet_design_projection_revision_mismatch", "design revision hash drifted")
    if (
        isinstance(result["raw_content_length"], bool)
        or not isinstance(result["raw_content_length"], int)
        or not 2 <= result["raw_content_length"] <= MAX_CONTENT_LENGTH
    ):
        _fail("facet_design_projection_invalid_claim", "raw_content_length is invalid")
    if result["raw_key"] != f"facet-design/v2/raw/{result['raw_sha256']}.json":
        _fail("facet_design_projection_raw_key_mismatch", "raw key is not hash-bound")
    previous = result["previous_event_id"]
    reason = result["reason_sha256"]
    if result["decision_kind"] == "approved":
        if previous is not None or reason is not None:
            _fail("facet_design_projection_invalid_claim", "initial decision has predecessor")
    else:
        result["previous_event_id"] = _uuid(previous, "previous_event_id")
        result["reason_sha256"] = _sha256(reason, "reason_sha256")
    expected_association = hashlib.sha256(
        _canonical_json(
            {
                "brand_id": result["brand_id"],
                "customer_party_ref": result["customer_party_ref"],
                "customer_quote_id": result["customer_quote_id"],
                "destination_tenant_id": result["destination_tenant_id"],
                "external_customer_identity_link_id": result[
                    "external_customer_identity_link_id"
                ],
                "external_project_link_id": result["external_project_link_id"],
                "facet_project_id": result["facet_project_id"],
                "producer_identity_link_id": result["producer_identity_link_id"],
                "roof_job_id": result["roof_job_id"],
                "source_tenant_id": result["source_tenant_id"],
            }
        ).encode("utf-8")
    ).hexdigest()
    if not hmac.compare_digest(expected_association, result["association_sha256"]):
        _fail("facet_design_projection_association_mismatch", "association digest drifted")
    return result


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


def _assert_service_claim(facet_claim_json: str) -> tuple[str, str]:
    if getattr(getattr(frappe, "request", None), "method", "").upper() != "POST":
        _fail("facet_design_projection_post_required", "POST is required", permission=True)
    configured_user = _text(_site_config(SERVICE_USER_CONFIG_KEY), SERVICE_USER_CONFIG_KEY)
    actor = _text(getattr(getattr(frappe, "session", None), "user", None), "session_user")
    if actor == "Guest" or actor != configured_user:
        _fail("facet_design_projection_service_user_mismatch", "service user mismatch", permission=True)
    roles = {str(role) for role in frappe.get_roles(actor)}
    if FACET_DESIGN_PROJECTION_SERVICE_ROLE not in roles:
        _fail("facet_design_projection_service_role_missing", "service role missing", permission=True)
    for doctype, permission in REQUIRED_PERMISSIONS:
        if not frappe.has_permission(doctype, ptype=permission, user=actor):
            _fail(
                "facet_design_projection_permission_denied",
                f"service user lacks {permission} on {doctype}",
                permission=True,
            )
    key = _text(_site_config(HMAC_CONFIG_KEY), HMAC_CONFIG_KEY, maximum=4096)
    if len(key.encode("utf-8")) < 32:
        _fail("facet_design_projection_hmac_key_invalid", "HMAC key is too short", permission=True)
    timestamp = _request_header("X-IronWrap-Facet-Projection-Timestamp")
    nonce = _request_header("X-IronWrap-Facet-Projection-Nonce")
    signature = _request_header("X-IronWrap-Facet-Projection-Signature")
    if not timestamp or not TIMESTAMP_RE.fullmatch(timestamp):
        _fail("facet_design_projection_hmac_invalid", "timestamp is invalid", permission=True)
    if not nonce or not NONCE_RE.fullmatch(nonce):
        _fail("facet_design_projection_hmac_invalid", "nonce is invalid", permission=True)
    if not signature or not SIGNATURE_RE.fullmatch(signature):
        _fail("facet_design_projection_hmac_invalid", "signature is invalid", permission=True)
    now = time.time()
    signed_at = int(timestamp)
    if abs(now - signed_at) > MAX_SIGNATURE_AGE_SECONDS:
        _fail("facet_design_projection_hmac_expired", "signature expired", permission=True)
    body_hash = hashlib.sha256(facet_claim_json.encode("utf-8")).hexdigest()
    signed = f"POST\n{COMMAND_PATH}\n{timestamp}\n{nonce}\n{body_hash}".encode()
    expected = base64.urlsafe_b64encode(
        hmac.new(key.encode(), signed, hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(signature, expected):
        _fail("facet_design_projection_hmac_invalid", "signature mismatch", permission=True)
    nonce_hash = hashlib.sha256(f"{COMMAND_PATH}\n{nonce}".encode()).hexdigest()
    try:
        cache = frappe.cache()
        reserved = cache.set(
            name=cache.make_key(f"{NONCE_CACHE_PREFIX}{nonce_hash}"),
            value="1",
            nx=True,
            ex=max(1, math.ceil(signed_at + MAX_SIGNATURE_AGE_SECONDS - now)),
        )
    except Exception:
        _fail("facet_design_projection_nonce_unavailable", "nonce store unavailable", permission=True)
    if not reserved:
        _fail("facet_design_projection_nonce_replayed", "nonce already consumed", permission=True)
    return actor, key


def _projection_ids(event_id: str) -> tuple[str, str, str, str]:
    event_hash = hashlib.sha256(event_id.encode()).hexdigest()
    return (
        f"facet-design:{event_hash}",
        f"facet-design-projection:{event_hash}",
        f"facet-event:{event_hash}",
        f"facet-quote-revision:{event_hash}",
    )


def _one(rows: list[Mapping[str, Any]], code: str) -> dict[str, Any]:
    if len(rows) != 1:
        _fail(code, "record was not uniquely available")
    return dict(rows[0])


def _locked_anchors(claim: Mapping[str, Any], draft_id: str) -> dict[str, Any]:
    job = _one(
        frappe.db.sql(
            """SELECT name, roof_job_id, brand, quotation
                 FROM `tabRoof Job` WHERE roof_job_id = %s FOR UPDATE""",
            (claim["roof_job_id"],),
            as_dict=True,
        ),
        "facet_design_projection_job_missing",
    )
    quote_fields = ", ".join(
        (
            "name",
            "customer_quote_id",
            "roof_job",
            "customer",
            "quote_version",
            "status",
            "supersedes",
            "correction_reason",
            "prepared_at",
            "contract_acceptance",
            "accepted_at",
            *BLANK_QUOTE_FIELDS,
        )
    )
    quotes = [
        dict(row)
        for row in frappe.db.sql(
            f"SELECT {quote_fields} FROM `tabCustomer Quote` WHERE roof_job = %s FOR UPDATE",
            (job["name"],),
            as_dict=True,
        )
    ]
    source = [quote for quote in quotes if quote.get("customer_quote_id") == claim["customer_quote_id"]]
    source_quote = _one(source, "facet_design_projection_quote_missing")
    if source_quote.get("roof_job") != job.get("name") or job.get("quotation") != source_quote.get("name"):
        _fail("facet_design_projection_quote_job_mismatch", "source quote is not current for job")
    if job.get("brand") != claim["brand_id"]:
        _fail("facet_design_projection_brand_mismatch", "brand does not match job")
    if (
        source_quote.get("status") != "Approved"
        or source_quote.get("contract_acceptance")
        or source_quote.get("accepted_at")
    ):
        _fail("facet_design_projection_quote_not_reviewable", "source quote is not Approved")
    if not source_quote.get("customer"):
        _fail("facet_design_projection_quote_customer_missing", "source customer is unavailable")
    versions: list[int] = []
    for quote in quotes:
        version = quote.get("quote_version")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            _fail("facet_design_projection_quote_version_invalid", "quote version is invalid")
        versions.append(version)
    existing = [quote for quote in quotes if quote.get("customer_quote_id") == draft_id]
    if len(existing) > 1:
        _fail("facet_design_projection_conflict", "Draft identity is not unique")
    previous_draft = None
    if claim["previous_event_id"] is not None:
        previous_draft_id = _projection_ids(claim["previous_event_id"])[3]
        previous_draft = _one(
            [
                quote
                for quote in quotes
                if quote.get("customer_quote_id") == previous_draft_id
            ],
            "facet_design_projection_predecessor_draft_missing",
        )
    draft_version = (
        existing[0]["quote_version"]
        if existing
        else (
            max(versions) + 1
            if claim["decision_kind"] in ACTIVE_DECISIONS
            else previous_draft["quote_version"]
        )
    )
    return {
        "job": job,
        "source_quote": source_quote,
        "existing_draft": existing[0] if existing else None,
        "previous_draft": previous_draft,
        "draft_version": draft_version,
    }


def _locked_existing(doctype: str, identity_field: str, identity: str) -> dict[str, Any] | None:
    fields = (
        "name, evidence_id, device_action_id, roof_job, evidence_type, proof_owner, "
        "proof_slot, source_system, r2_key, content_checksum, checksum_algorithm, "
        "content_type, content_length, capture_actor, captured_at, sync_state, verified_at, "
        "verification_source, customer_safe, summary"
        if doctype == "Evidence Item"
        else "name, reconciliation_id, roof_job, system_name, entity_type, external_entity_id, "
        "local_doctype, local_name, direction, status, detected_at, raw_key, source_version, "
        "source_amount, local_amount, currency, source_payload_hash, local_payload_hash, "
        "last_attempt_at, attempt_count, resolution_action, resolved_by, resolved_at, "
        "resolution_evidence, automation_incident, supersedes, correction_reason, notes, diff_json"
    )
    rows = frappe.db.sql(
        f"SELECT {fields} FROM `tab{doctype}` WHERE {identity_field} = %s FOR UPDATE",
        (identity,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("facet_design_projection_conflict", f"{doctype} identity is not unique")
    return dict(rows[0]) if rows else None


def _same(left: Any, right: Any) -> bool:
    return (left in {None, ""} and right in {None, ""}) or str(left) == str(right)


def _assert_replay(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    if not all(_same(existing.get(field), value) for field, value in expected.items()):
        _fail("facet_design_projection_conflict", "immutable projection facts drifted")


def _chain_identity(claim: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "association_sha256": claim["association_sha256"],
        "customer_party_ref": claim["customer_party_ref"],
        "destination_tenant_id": claim["destination_tenant_id"],
        "external_customer_identity_link_id": claim[
            "external_customer_identity_link_id"
        ],
        "external_project_link_id": claim["external_project_link_id"],
        "facet_project_id": claim["facet_project_id"],
        "oidc_issuer": claim["oidc_issuer"],
        "oidc_subject_sha256": claim["oidc_subject_sha256"],
        "producer_identity_link_id": claim["producer_identity_link_id"],
        "source_tenant_id": claim["source_tenant_id"],
    }


def _canonical_object(value: Any, code: str) -> dict[str, Any]:
    if not isinstance(value, str):
        _fail(code, "stored projection authority is unavailable")
    try:
        parsed = json.loads(
            value,
            object_pairs_hook=_parse_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail(code, "stored projection authority is invalid")
    if not isinstance(parsed, dict) or _canonical_json(parsed) != value:
        _fail(code, "stored projection authority is not canonical")
    return parsed


def _assert_predecessor_projection(
    claim: Mapping[str, Any], anchors: Mapping[str, Any]
) -> None:
    previous_event_id = claim["previous_event_id"]
    if previous_event_id is None:
        return
    (
        previous_evidence_id,
        previous_reconciliation_id,
        previous_external_id,
        previous_draft_id,
    ) = _projection_ids(previous_event_id)
    evidence = _locked_existing("Evidence Item", "evidence_id", previous_evidence_id)
    reconciliation = _locked_existing(
        "Integration Reconciliation", "reconciliation_id", previous_reconciliation_id
    )
    if not evidence or not reconciliation or not anchors.get("previous_draft"):
        _fail(
            "facet_design_projection_predecessor_missing",
            "the exact prior Facet projection trio is unavailable",
        )
    _assert_replay(
        evidence,
        {
            "evidence_id": previous_evidence_id,
            "roof_job": anchors["job"]["name"],
            "source_system": SOURCE_SYSTEM,
            "sync_state": "Verified",
            "verification_source": VERIFICATION_SOURCE,
            "customer_safe": 0,
        },
    )
    _assert_replay(
        reconciliation,
        {
            "reconciliation_id": previous_reconciliation_id,
            "roof_job": anchors["job"]["name"],
            "system_name": "Facet",
            "entity_type": "Design Revision",
            "external_entity_id": previous_external_id,
            "local_doctype": "Customer Quote",
            "local_name": previous_draft_id,
            "direction": "Inbound",
        },
    )
    diff = _canonical_object(
        reconciliation.get("diff_json"),
        "facet_design_projection_predecessor_authority_invalid",
    )
    expected = {
        **_chain_identity(claim),
        "event_id": previous_event_id,
        "draft_customer_quote_id": previous_draft_id,
    }
    if not all(_same(diff.get(field), value) for field, value in expected.items()):
        _fail(
            "facet_design_projection_predecessor_authority_mismatch",
            "customer, OIDC subject, project, or tenant authority drifted",
        )
    if diff.get("decision_kind") not in ACTIVE_DECISIONS:
        _fail(
            "facet_design_projection_predecessor_terminal",
            "a terminal Facet decision cannot be reopened",
        )


def _blank_draft(
    claim: Mapping[str, Any], anchors: Mapping[str, Any], draft_id: str, now: str
) -> dict[str, Any]:
    draft = {
        "doctype": "Customer Quote",
        "customer_quote_id": draft_id,
        "roof_job": anchors["job"]["name"],
        "customer": anchors["source_quote"]["customer"],
        "quote_version": anchors["draft_version"],
        "status": "Draft",
        "supersedes": (
            anchors["previous_draft"]["name"]
            if claim["decision_kind"] == "corrected"
            else anchors["source_quote"]["name"]
        ),
        "correction_reason": (
            f"Facet customer decision {claim['event_id']} requires estimator rebuild from current evidence."
        ),
        "prepared_at": now,
    }
    draft.update({field: None for field in BLANK_QUOTE_FIELDS})
    return draft


def _assert_blank_draft(existing: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    compared = {
        key: value
        for key, value in expected.items()
        if key not in {"doctype", "prepared_at"}
    }
    _assert_replay(existing, compared)
    if any(existing.get(field) not in {None, ""} for field in BLANK_QUOTE_FIELDS):
        _fail("facet_design_projection_conflict", "Draft contains commercial data")


def _assert_rejected_predecessor(
    existing: Mapping[str, Any], expected: Mapping[str, Any]
) -> None:
    _assert_replay(
        existing,
        {
            "customer_quote_id": expected["customer_quote_id"],
            "roof_job": expected["roof_job"],
            "customer": expected["customer"],
            "quote_version": expected["quote_version"],
            "status": "Rejected",
        },
    )


def _projection_documents(
    claim: Mapping[str, Any],
    anchors: Mapping[str, Any],
    actor: str,
    evidence_id: str,
    reconciliation_id: str,
    external_entity_id: str,
    draft_id: str,
    now: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    active = claim["decision_kind"] in ACTIVE_DECISIONS
    draft = (
        _blank_draft(claim, anchors, draft_id, now)
        if active
        else {**anchors["previous_draft"], "status": "Rejected"}
    )
    target_quote_id = draft["customer_quote_id"]
    evidence = {
        "doctype": "Evidence Item",
        "evidence_id": evidence_id,
        "device_action_id": f"facet-v2-projection:{hashlib.sha256(claim['event_id'].encode()).hexdigest()}",
        "roof_job": anchors["job"]["name"],
        "lead_envelope": None,
        "evidence_type": "Other",
        "proof_owner": actor,
        "proof_slot": "Estimate",
        "source_system": SOURCE_SYSTEM,
        "source_uri": None,
        "r2_key": claim["raw_key"],
        "drive_file_id": None,
        "content_checksum": claim["raw_sha256"],
        "checksum_algorithm": "SHA-256",
        "content_type": "application/json",
        "content_length": claim["raw_content_length"],
        "capture_actor": actor,
        "captured_at": claim["received_at"],
        "latitude": None,
        "longitude": None,
        "location_accuracy_m": None,
        "sync_state": "Verified",
        "verified_at": now,
        "verification_source": VERIFICATION_SOURCE,
        "correction_of": None,
        "correction_reason": None,
        "customer_safe": 0,
        "summary": "OIDC-assured Facet v2 decision; estimator must rebuild every commercial field.",
    }
    local_payload_hash = hashlib.sha256(
        _canonical_json(
            {
                "association_sha256": claim["association_sha256"],
                "draft_customer_quote_id": target_quote_id,
                "event_id": claim["event_id"],
                "roof_job": anchors["job"]["name"],
                "source_customer_quote_id": claim["customer_quote_id"],
            }
        ).encode()
    ).hexdigest()
    reconciliation = {
        "doctype": "Integration Reconciliation",
        "reconciliation_id": reconciliation_id,
        "roof_job": anchors["job"]["name"],
        "system_name": "Facet",
        "entity_type": "Design Revision",
        "external_entity_id": external_entity_id,
        "local_doctype": "Customer Quote",
        "local_name": target_quote_id,
        "direction": "Inbound",
        "status": "Pending" if active else "Superseded",
        "detected_at": claim["received_at"],
        "raw_key": claim["raw_key"],
        "source_version": claim["design_revision_id"],
        "source_amount": None,
        "local_amount": None,
        "currency": None,
        "source_payload_hash": claim["frozen_evidence_sha256"],
        "local_payload_hash": local_payload_hash,
        "last_attempt_at": now,
        "attempt_count": 1,
        "resolution_action": None,
        "resolved_by": None,
        "resolved_at": None,
        "resolution_evidence": None,
        "automation_incident": None,
        "supersedes": (
            _projection_ids(claim["previous_event_id"])[1]
            if claim["previous_event_id"] is not None
            else None
        ),
        "correction_reason": (
            f"Facet {claim['decision_kind']} reason SHA-256: {claim['reason_sha256']}"
            if claim["reason_sha256"] is not None
            else None
        ),
        "notes": None,
        "diff_json": _canonical_json(
            {
                **_chain_identity(claim),
                "blank_commercial_revision": active,
                "customer_safe": False,
                "decision_kind": claim["decision_kind"],
                "draft_customer_quote_id": target_quote_id,
                "event_id": claim["event_id"],
                "identity_assurance": "oidc",
                "previous_draft_customer_quote_id": (
                    anchors["previous_draft"]["customer_quote_id"]
                    if anchors["previous_draft"] is not None
                    else None
                ),
                "previous_event_id": claim["previous_event_id"],
                "schema": "ironwrap.facet-design-projection.v2",
                "state": (
                    "pending_estimator_rebuild"
                    if active
                    else (
                        "customer_withdrew_design"
                        if claim["decision_kind"] == "withdrawn"
                        else "customer_superseded_design"
                    )
                ),
            }
        ),
    }
    return draft, evidence, reconciliation


def _projection_response(
    *,
    claim_json: str,
    claim: Mapping[str, Any],
    draft: Mapping[str, Any],
    evidence_id: str,
    reconciliation_id: str,
    idempotent_replay: bool,
    hmac_key: str,
) -> dict[str, Any]:
    receipt = {
        "actor_identity_assurance": "oidc",
        "approval_receipt_sha256": claim["approval_receipt_sha256"],
        "association_sha256": claim["association_sha256"],
        "blank_commercial_revision": claim["decision_kind"] in ACTIVE_DECISIONS,
        "claim_sha256": hashlib.sha256(claim_json.encode()).hexdigest(),
        "customer_safe": False,
        "decision_kind": claim["decision_kind"],
        "design_revision_id": claim["design_revision_id"],
        "design_revision_sha256": claim["design_revision_sha256"],
        "destination_tenant_id": claim["destination_tenant_id"],
        "draft_customer_quote_id": draft["customer_quote_id"],
        "draft_quote_status": draft["status"],
        "draft_quote_version": draft["quote_version"],
        "event_id": claim["event_id"],
        "event_type": EVENT_TYPE,
        "evidence_id": evidence_id,
        "facet_project_id": claim["facet_project_id"],
        "frozen_evidence_sha256": claim["frozen_evidence_sha256"],
        "idempotent_replay": idempotent_replay,
        "occurred_at": claim["occurred_at"],
        "raw_content_length": claim["raw_content_length"],
        "raw_key": claim["raw_key"],
        "raw_sha256": claim["raw_sha256"],
        "received_at": claim["received_at"],
        "reconciliation_id": reconciliation_id,
        "roof_job_id": claim["roof_job_id"],
        "schema": RECEIPT_SCHEMA,
        "schema_version": EVENT_SCHEMA_VERSION,
        "source_customer_quote_id": claim["customer_quote_id"],
    }
    receipt_sha256 = hashlib.sha256(_canonical_json(receipt).encode()).hexdigest()
    signature = base64.urlsafe_b64encode(
        hmac.new(
            hmac_key.encode(),
            f"{RECEIPT_SIGNATURE_CONTEXT}\n{receipt_sha256}".encode(),
            hashlib.sha256,
        ).digest()
    ).rstrip(b"=").decode()
    return {
        "draft_customer_quote_id": draft["customer_quote_id"],
        "draft_quote_version": draft["quote_version"],
        "event_id": claim["event_id"],
        "evidence_id": evidence_id,
        "idempotent_replay": idempotent_replay,
        "receipt": receipt,
        "receipt_sha256": receipt_sha256,
        "receipt_signature": signature,
        "receipt_signature_algorithm": "HMAC-SHA256",
        "reconciliation_id": reconciliation_id,
    }


@frappe.whitelist()
def record_facet_design_proposal_evidence(facet_claim_json: str) -> dict[str, Any]:
    """Append exact v2 evidence and enforce the current Facet quote-chain head."""

    actor, receipt_hmac_key = _assert_service_claim(facet_claim_json)
    claim = _parse_claim(facet_claim_json)
    evidence_id, reconciliation_id, external_entity_id, draft_id = _projection_ids(
        claim["event_id"]
    )
    anchors = _locked_anchors(claim, draft_id)
    _assert_predecessor_projection(claim, anchors)
    now = str(frappe.utils.now_datetime())
    draft, evidence, reconciliation = _projection_documents(
        claim,
        anchors,
        actor,
        evidence_id,
        reconciliation_id,
        external_entity_id,
        draft_id,
        now,
    )
    existing_evidence = _locked_existing("Evidence Item", "evidence_id", evidence_id)
    existing_reconciliation = _locked_existing(
        "Integration Reconciliation", "reconciliation_id", reconciliation_id
    )
    active = claim["decision_kind"] in ACTIVE_DECISIONS
    target_quote = anchors["existing_draft"] if active else anchors["previous_draft"]
    if existing_evidence or existing_reconciliation:
        if not existing_evidence or not existing_reconciliation or not target_quote:
            _fail("facet_design_projection_conflict", "projection trio is incomplete")
        _assert_replay(
            existing_evidence,
            {
                field: value
                for field, value in evidence.items()
                if field not in {"doctype", "verified_at"}
            },
        )
        _assert_replay(
            existing_reconciliation,
            {field: reconciliation.get(field) for field in RECONCILIATION_REPLAY_FIELDS},
        )
        if active:
            _assert_blank_draft(target_quote, draft)
        else:
            _assert_rejected_predecessor(target_quote, draft)
        return _projection_response(
            claim_json=facet_claim_json,
            claim=claim,
            draft=target_quote,
            evidence_id=evidence_id,
            reconciliation_id=reconciliation_id,
            idempotent_replay=True,
            hmac_key=receipt_hmac_key,
        )
    if active and target_quote:
        _fail("facet_design_projection_conflict", "projection trio is incomplete")
    previous_quote_document = None
    if claim["previous_event_id"] is not None:
        previous = anchors["previous_draft"]
        if previous["status"] not in {"Draft", "Needs Review", "Approved"}:
            _fail(
                "facet_design_projection_predecessor_not_invalidateable",
                "the prior Facet quote revision cannot be advanced or invalidated",
            )
        previous_quote_document = frappe.get_doc("Customer Quote", previous["name"])
        previous_quote_document.status = "Rejected"
    draft_document = frappe.get_doc(draft) if active else None
    evidence_document = frappe.get_doc(evidence)
    reconciliation_document = frappe.get_doc(reconciliation)
    with facet_design_projection_issuance_context(
        evidence_document,
        reconciliation_document,
        draft_document,
        previous_quote_document,
    ):
        if previous_quote_document is not None:
            previous_quote_document.save()
        if draft_document is not None:
            draft_document.insert()
        evidence_document.insert()
        reconciliation_document.insert()
    return _projection_response(
        claim_json=facet_claim_json,
        claim=claim,
        draft=draft,
        evidence_id=evidence_id,
        reconciliation_id=reconciliation_id,
        idempotent_replay=False,
        hmac_key=receipt_hmac_key,
    )
