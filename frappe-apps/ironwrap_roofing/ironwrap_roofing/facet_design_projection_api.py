"""Bounded Worker projection of an already-durable Facet design receipt.

The Worker may submit only D1/R2 anchors and an explicit deployment-controlled
job/quote association.  This command independently authenticates the service
principal, validates a separate HMAC, locks both local records, and creates
review-only evidence.  It never creates or mutates a quote, price, contract,
acceptance, or Proposal Evidence Pack.
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
from ironwrap_roofing.document_validation import facet_design_projection_issuance_context


SERVICE_USER_CONFIG_KEY = "ironwrap_facet_design_projection_service_user"
HMAC_CONFIG_KEY = "ironwrap_facet_design_projection_hmac_key"
SOURCE_SYSTEM = "ironwrap-facet-design"
VERIFICATION_SOURCE = "ironwrap-worker-r2-facet-design-projection"
LEGACY_EVENT_TYPE = "facet.design.approved.v1"
LEGACY_EVENT_SCHEMA_VERSION = 1
CUSTOMER_APPROVAL_EVENT_TYPE = "facet.design.customer_approved.v2"
CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION = 2
CUSTOMER_APPROVAL_ACTOR_TYPE = "customer_capability"
CUSTOMER_APPROVAL_IDENTITY_ASSURANCE = "bearer_capability_only"
RECEIPT_SCHEMA = "ironwrap.facet-design-projection-receipt.v1"
# Receipt signature input is exactly:
#   ironwrap.facet-design-projection.receipt.v1\n<sha256(canonical receipt JSON)>
RECEIPT_SIGNATURE_CONTEXT = "ironwrap.facet-design-projection.receipt.v1"
COMMAND_PATH = (
    "/api/method/ironwrap_roofing.facet_design_projection_api."
    "record_facet_design_proposal_evidence"
)
MAX_CLAIM_BYTES = 32_768
MAX_IDENTIFIER_LENGTH = 140
MAX_ANCHOR_ID_LENGTH = 160
MAX_R2_KEY_LENGTH = 500
MAX_CONTENT_LENGTH = 524_288
MAX_SIGNATURE_AGE_SECONDS = 300
NONCE_CACHE_PREFIX = "ironwrap:facet-design-projection:nonce:"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$")
TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,140}$")
SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{10,12}$")

LEGACY_CLAIM_FIELDS = frozenset(
    {
        "event_id",
        "tenant_id",
        "facet_project_id",
        "design_revision_id",
        "design_revision_sha256",
        "frozen_evidence_sha256",
        "raw_key",
        "raw_sha256",
        "raw_content_length",
        "occurred_at",
        "received_at",
        "roof_job_id",
        "customer_quote_id",
    }
)
CUSTOMER_APPROVAL_CLAIM_FIELDS = LEGACY_CLAIM_FIELDS | {
    "event_type",
    "schema_version",
    "brand_id",
    "approval_actor_type",
    "capability_fingerprint",
    "identity_assurance",
}
REQUIRED_PERMISSIONS = (
    ("Roof Job", "read"),
    ("Customer Quote", "read"),
    ("Evidence Item", "create"),
    ("Integration Reconciliation", "create"),
)
# A replay verifies durable provenance, not later human resolution state.
# `last_attempt_at` changes for every command invocation, so it is not an
# incoming claim anchor.
RECONCILIATION_REPLAY_ANCHOR_FIELDS = (
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


def _text(value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    if not isinstance(value, str):
        _fail("facet_design_projection_invalid_claim", f"{field} must be text")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > maximum or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("facet_design_projection_invalid_claim", f"{field} is invalid")
    return cleaned


def _opaque_id(value: Any, field: str, *, maximum: int = MAX_ANCHOR_ID_LENGTH) -> str:
    cleaned = _text(value, field, maximum=maximum)
    if not IDENTIFIER_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} is not a safe opaque identifier")
    return cleaned


def _tenant_id(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    if not TENANT_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} is not a local tenant identifier")
    return cleaned


def _brand_id(value: Any) -> str:
    cleaned = _text(value, "brand_id", maximum=32)
    if not TENANT_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", "brand_id is invalid")
    return cleaned


def _sha256(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    if not SHA256_RE.fullmatch(cleaned):
        _fail("facet_design_projection_invalid_claim", f"{field} must be lowercase SHA-256")
    return cleaned


def _timestamp(value: Any, field: str) -> str:
    timestamp = _text(value, field, maximum=64)
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        _fail("facet_design_projection_invalid_claim", f"{field} must be an ISO timestamp")
    return timestamp


def _positive_length(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 2 <= value <= MAX_CONTENT_LENGTH:
        _fail("facet_design_projection_invalid_claim", "raw_content_length is invalid")
    return value


def _parse_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("facet_design_projection_invalid_claim", "claim has a duplicate key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    _fail("facet_design_projection_invalid_claim", f"claim has invalid JSON number {value}")


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
        _fail("facet_design_projection_invalid_claim", "claim cannot be canonicalized")
        raise AssertionError from exc


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
    if not isinstance(claim, dict):
        _fail("facet_design_projection_invalid_claim", "claim fields are unsupported")
    claim_fields = set(claim)
    if claim_fields == LEGACY_CLAIM_FIELDS:
        event_type = LEGACY_EVENT_TYPE
        schema_version = LEGACY_EVENT_SCHEMA_VERSION
    elif claim_fields == CUSTOMER_APPROVAL_CLAIM_FIELDS:
        event_type = _text(claim["event_type"], "event_type")
        schema_version = claim["schema_version"]
        if (
            event_type != CUSTOMER_APPROVAL_EVENT_TYPE
            or isinstance(schema_version, bool)
            or schema_version != CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION
        ):
            _fail(
                "facet_design_projection_event_version_mismatch",
                "customer approval event type and schema version are not paired",
            )
    else:
        _fail("facet_design_projection_invalid_claim", "claim fields are unsupported")
    if _canonical_json(claim) != facet_claim_json:
        _fail("facet_design_projection_invalid_claim", "facet_claim_json must be canonical")
    result = {
        "event_type": event_type,
        "schema_version": schema_version,
        "event_id": _opaque_id(claim["event_id"], "event_id"),
        "tenant_id": _tenant_id(claim["tenant_id"], "tenant_id"),
        "facet_project_id": _opaque_id(claim["facet_project_id"], "facet_project_id"),
        "design_revision_id": _opaque_id(
            claim["design_revision_id"], "design_revision_id"
        ),
        "design_revision_sha256": _sha256(
            claim["design_revision_sha256"], "design_revision_sha256"
        ),
        "frozen_evidence_sha256": _sha256(
            claim["frozen_evidence_sha256"], "frozen_evidence_sha256"
        ),
        "raw_key": _text(claim["raw_key"], "raw_key", maximum=MAX_R2_KEY_LENGTH),
        "raw_sha256": _sha256(claim["raw_sha256"], "raw_sha256"),
        "raw_content_length": _positive_length(claim["raw_content_length"]),
        "occurred_at": _timestamp(claim["occurred_at"], "occurred_at"),
        "received_at": _timestamp(claim["received_at"], "received_at"),
        "roof_job_id": _opaque_id(claim["roof_job_id"], "roof_job_id", maximum=140),
        "customer_quote_id": _opaque_id(
            claim["customer_quote_id"], "customer_quote_id", maximum=140
        ),
        "brand_id": None,
        "approval_actor_type": None,
        "capability_fingerprint": None,
        "identity_assurance": None,
    }
    if schema_version == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION:
        result.update(
            {
                "brand_id": _brand_id(claim["brand_id"]),
                "approval_actor_type": _text(
                    claim["approval_actor_type"], "approval_actor_type"
                ),
                "capability_fingerprint": _sha256(
                    claim["capability_fingerprint"], "capability_fingerprint"
                ),
                "identity_assurance": _text(
                    claim["identity_assurance"], "identity_assurance"
                ),
            }
        )
        if result["approval_actor_type"] != CUSTOMER_APPROVAL_ACTOR_TYPE:
            _fail(
                "facet_design_projection_invalid_claim",
                "approval_actor_type is unsupported",
            )
        if result["identity_assurance"] != CUSTOMER_APPROVAL_IDENTITY_ASSURANCE:
            _fail(
                "facet_design_projection_identity_assurance_mismatch",
                "customer capability possession is the only supported identity assurance",
            )
    if result["design_revision_id"] != f"facet-json-v1:{result['design_revision_sha256']}":
        _fail(
            "facet_design_projection_revision_mismatch",
            "design_revision_id is not bound to design_revision_sha256",
        )
    if result["raw_key"] != (
        f"facet-design/v{result['schema_version']}/{result['event_id']}.json"
    ):
        _fail("facet_design_projection_raw_key_mismatch", "raw_key is not bound to event_id")
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


def _consume_nonce(path: str, nonce: str, *, expires_in_seconds: int) -> None:
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
            "facet_design_projection_nonce_unavailable",
            "nonce replay protection is unavailable",
            permission=True,
        )
    if not reserved:
        _fail(
            "facet_design_projection_nonce_replayed",
            "signed request nonce was already consumed",
            permission=True,
        )


def _assert_service_claim(facet_claim_json: str) -> tuple[str, str]:
    request = getattr(frappe, "request", None)
    if getattr(request, "method", "").upper() != "POST":
        _fail("facet_design_projection_post_required", "this command accepts POST only", permission=True)
    configured_user = _text(
        _site_config(SERVICE_USER_CONFIG_KEY), SERVICE_USER_CONFIG_KEY
    )
    actor = _text(
        getattr(getattr(frappe, "session", None), "user", None), "session_user"
    )
    if actor == "Guest" or actor != configured_user:
        _fail(
            "facet_design_projection_service_user_mismatch",
            "only the configured Facet projection service user may call this command",
            permission=True,
        )
    roles = {str(role) for role in frappe.get_roles(actor)}
    if FACET_DESIGN_PROJECTION_SERVICE_ROLE not in roles:
        _fail(
            "facet_design_projection_service_role_missing",
            "the configured service user must hold the dedicated Facet projection role",
            permission=True,
        )
    for doctype, permission in REQUIRED_PERMISSIONS:
        if not frappe.has_permission(doctype, ptype=permission, user=actor):
            _fail(
                "facet_design_projection_permission_denied",
                f"the service user lacks {permission} on {doctype}",
                permission=True,
            )
    key = _text(_site_config(HMAC_CONFIG_KEY), HMAC_CONFIG_KEY, maximum=4096)
    if len(key.encode("utf-8")) < 32:
        _fail(
            "facet_design_projection_hmac_key_invalid",
            "the projection HMAC key must be at least 32 bytes",
            permission=True,
        )
    timestamp = _request_header("X-IronWrap-Facet-Projection-Timestamp")
    nonce = _request_header("X-IronWrap-Facet-Projection-Nonce")
    signature = _request_header("X-IronWrap-Facet-Projection-Signature")
    if not timestamp or not TIMESTAMP_RE.fullmatch(timestamp):
        _fail("facet_design_projection_hmac_invalid", "timestamp header is invalid", permission=True)
    if not nonce or not NONCE_RE.fullmatch(nonce):
        _fail("facet_design_projection_hmac_invalid", "nonce header is invalid", permission=True)
    if not signature or not SIGNATURE_RE.fullmatch(signature):
        _fail("facet_design_projection_hmac_invalid", "signature header is invalid", permission=True)
    now = time.time()
    signed_at = int(timestamp)
    if abs(now - signed_at) > MAX_SIGNATURE_AGE_SECONDS:
        _fail("facet_design_projection_hmac_expired", "signed Facet claim is expired", permission=True)
    body_hash = hashlib.sha256(facet_claim_json.encode("utf-8")).hexdigest()
    signed = f"POST\n{COMMAND_PATH}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
    expected = base64.urlsafe_b64encode(
        hmac.new(key.encode("utf-8"), signed, hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(signature, expected):
        _fail("facet_design_projection_hmac_invalid", "signature does not match", permission=True)
    _consume_nonce(
        COMMAND_PATH,
        nonce,
        expires_in_seconds=max(1, math.ceil(signed_at + MAX_SIGNATURE_AGE_SECONDS - now)),
    )
    return actor, key


def _one_locked(rows: list[Mapping[str, Any]], code: str) -> dict[str, Any]:
    if len(rows) != 1:
        _fail(code, "current record was not uniquely available")
    return dict(rows[0])


def _locked_anchors(claim: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    job = _one_locked(
        frappe.db.sql(
            """
            SELECT name, roof_job_id, brand, quotation
            FROM `tabRoof Job`
            WHERE roof_job_id = %s
            FOR UPDATE
            """,
            (claim["roof_job_id"],),
            as_dict=True,
        ),
        "facet_design_projection_job_missing",
    )
    quote = _one_locked(
        frappe.db.sql(
            """
            SELECT name, customer_quote_id, roof_job, status
            FROM `tabCustomer Quote`
            WHERE customer_quote_id = %s
            FOR UPDATE
            """,
            (claim["customer_quote_id"],),
            as_dict=True,
        ),
        "facet_design_projection_quote_missing",
    )
    if quote.get("roof_job") != job.get("name"):
        _fail(
            "facet_design_projection_quote_job_mismatch",
            "Customer Quote is not linked to the explicit Roof Job",
        )
    if job.get("quotation") != quote.get("name"):
        _fail(
            "facet_design_projection_quote_not_current",
            "Customer Quote is not the Roof Job's current quote",
        )
    if (
        claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION
        and job.get("brand") != claim["brand_id"]
    ):
        _fail(
            "facet_design_projection_brand_mismatch",
            "customer approval brand is not the Roof Job brand",
        )
    if quote.get("status") != "Approved":
        _fail(
            "facet_design_projection_quote_not_reviewable",
            "Customer Quote must already be Approved for evidence reconciliation",
        )
    return {"job": job, "quote": quote}


def _locked_existing_evidence(evidence_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        """
        SELECT name, evidence_id, device_action_id, roof_job, evidence_type, proof_owner,
               proof_slot, source_system, r2_key, content_checksum, checksum_algorithm,
               content_type, content_length, capture_actor, captured_at, sync_state,
               verified_at, verification_source, customer_safe, summary
        FROM `tabEvidence Item`
        WHERE evidence_id = %s
        FOR UPDATE
        """,
        (evidence_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("facet_design_projection_conflict", "evidence identity is not unique")
    return dict(rows[0]) if rows else None


def _locked_existing_reconciliation(reconciliation_id: str) -> dict[str, Any] | None:
    rows = frappe.db.sql(
        """
        SELECT name, reconciliation_id, roof_job, system_name, entity_type,
               external_entity_id, local_doctype, local_name, direction, status,
               detected_at, raw_key, source_version, source_amount, local_amount, currency,
               source_payload_hash, local_payload_hash, last_attempt_at, attempt_count,
               resolution_action, resolved_by, resolved_at, resolution_evidence,
               automation_incident, supersedes, correction_reason, notes, diff_json
        FROM `tabIntegration Reconciliation`
        WHERE reconciliation_id = %s
        FOR UPDATE
        """,
        (reconciliation_id,),
        as_dict=True,
    )
    if len(rows) > 1:
        _fail("facet_design_projection_conflict", "reconciliation identity is not unique")
    return dict(rows[0]) if rows else None


def _same(left: Any, right: Any) -> bool:
    if left in {None, ""} and right in {None, ""}:
        return True
    return str(left) == str(right)


def _assert_replay(existing: Mapping[str, Any], expected: Mapping[str, Any], code: str) -> None:
    if not all(_same(existing.get(field), expected.get(field)) for field in expected):
        _fail(code, "immutable identity is bound to different facts")


def _assert_reconciliation_replay(
    existing: Mapping[str, Any], expected: Mapping[str, Any], code: str
) -> None:
    _assert_replay(
        existing,
        {field: expected.get(field) for field in RECONCILIATION_REPLAY_ANCHOR_FIELDS},
        code,
    )


def _projection_ids(event_id: str) -> tuple[str, str, str]:
    event_hash = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
    return (
        f"facet-design:{event_hash}",
        f"facet-design-projection:{event_hash}",
        f"facet-event:{event_hash}",
    )


def _local_payload_hash(claim: Mapping[str, Any], anchors: Mapping[str, Mapping[str, Any]]) -> str:
    payload = {
        "schema": (
            "ironwrap.facet-design-projection.v2"
            if claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION
            else "ironwrap.facet-design-projection.v1"
        ),
        "event_id": claim["event_id"],
        "tenant_id": claim["tenant_id"],
        "facet_project_id": claim["facet_project_id"],
        "design_revision_id": claim["design_revision_id"],
        "design_revision_sha256": claim["design_revision_sha256"],
        "frozen_evidence_sha256": claim["frozen_evidence_sha256"],
        "raw_key": claim["raw_key"],
        "raw_sha256": claim["raw_sha256"],
        "roof_job_id": claim["roof_job_id"],
        "customer_quote_id": claim["customer_quote_id"],
        "roof_job": anchors["job"]["name"],
        "customer_quote": anchors["quote"]["name"],
    }
    if claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION:
        payload.update(
            {
                "event_type": claim["event_type"],
                "schema_version": claim["schema_version"],
                "brand_id": claim["brand_id"],
                "approval_actor_type": claim["approval_actor_type"],
                "capability_fingerprint": claim["capability_fingerprint"],
                "identity_assurance": claim["identity_assurance"],
                "roof_job_brand": anchors["job"]["brand"],
            }
        )
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _reconciliation_diff(claim: Mapping[str, Any]) -> str:
    diff = {
        "schema": "ironwrap.facet-design-projection.v1",
        "state": "pending_estimator_reconciliation",
        "customer_safe": False,
        "commercial_state": "none",
        "event_id": claim["event_id"],
        "tenant_id": claim["tenant_id"],
        "facet_project_id": claim["facet_project_id"],
        "design_revision_id": claim["design_revision_id"],
        "design_revision_sha256": claim["design_revision_sha256"],
        "frozen_evidence_sha256": claim["frozen_evidence_sha256"],
        "raw_key": claim["raw_key"],
        "raw_sha256": claim["raw_sha256"],
    }
    if claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION:
        diff.update(
            {
                "schema": "ironwrap.facet-design-projection.v2",
                "source_event": {
                    "event_type": claim["event_type"],
                    "schema_version": claim["schema_version"],
                },
                "provenance": {
                    "status": "customer_approved",
                    "brand_id": claim["brand_id"],
                    "approval_actor_type": claim["approval_actor_type"],
                    "capability_fingerprint": claim["capability_fingerprint"],
                    "identity_assurance": claim["identity_assurance"],
                },
            }
        )
    return _canonical_json(diff)


def _evidence_summary(claim: Mapping[str, Any]) -> str:
    if claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION:
        return (
            "Facet customer-approved design evidence; estimator reconciliation "
            "required before any commercial use."
        )
    return "Facet design revision evidence; estimator reconciliation required before commercial use."


def _projection_response(
    *,
    claim_json: str,
    claim: Mapping[str, Any],
    anchors: Mapping[str, Mapping[str, Any]],
    evidence_id: str,
    reconciliation_id: str,
    local_payload_hash: str,
    idempotent_replay: bool,
    hmac_key: str,
) -> dict[str, Any]:
    provenance = (
        {
            "status": "customer_approved",
            "brand_id": claim["brand_id"],
            "approval_actor_type": claim["approval_actor_type"],
            "capability_fingerprint": claim["capability_fingerprint"],
            "identity_assurance": claim["identity_assurance"],
        }
        if claim["schema_version"] == CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION
        else {"status": "provenance_unknown"}
    )
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "claim_sha256": hashlib.sha256(claim_json.encode("utf-8")).hexdigest(),
        "event_id": claim["event_id"],
        "event_type": claim["event_type"],
        "schema_version": claim["schema_version"],
        "tenant_id": claim["tenant_id"],
        "facet_project_id": claim["facet_project_id"],
        "design_revision_id": claim["design_revision_id"],
        "design_revision_sha256": claim["design_revision_sha256"],
        "frozen_evidence_sha256": claim["frozen_evidence_sha256"],
        "raw_key": claim["raw_key"],
        "raw_sha256": claim["raw_sha256"],
        "raw_content_length": claim["raw_content_length"],
        "occurred_at": claim["occurred_at"],
        "received_at": claim["received_at"],
        "roof_job_id": claim["roof_job_id"],
        "customer_quote_id": claim["customer_quote_id"],
        "roof_job": anchors["job"]["name"],
        "roof_job_brand": anchors["job"].get("brand"),
        "roof_job_current_quote": anchors["job"]["quotation"],
        "customer_quote": anchors["quote"]["name"],
        "customer_quote_status": anchors["quote"]["status"],
        "evidence_id": evidence_id,
        "reconciliation_id": reconciliation_id,
        "local_payload_hash": local_payload_hash,
        "provenance": provenance,
        "commercial_state": "none",
        "customer_safe": False,
        "idempotent_replay": idempotent_replay,
    }
    receipt_sha256 = hashlib.sha256(
        _canonical_json(receipt).encode("utf-8")
    ).hexdigest()
    receipt_signature = base64.urlsafe_b64encode(
        hmac.new(
            hmac_key.encode("utf-8"),
            f"{RECEIPT_SIGNATURE_CONTEXT}\n{receipt_sha256}".encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).rstrip(b"=").decode("ascii")
    return {
        "event_id": claim["event_id"],
        "evidence_id": evidence_id,
        "reconciliation_id": reconciliation_id,
        "idempotent_replay": idempotent_replay,
        "receipt": receipt,
        "receipt_sha256": receipt_sha256,
        "receipt_signature_algorithm": "HMAC-SHA256",
        "receipt_signature": receipt_signature,
    }


@frappe.whitelist()
def record_facet_design_proposal_evidence(facet_claim_json: str) -> dict[str, Any]:
    """Create only replay-safe, review-only Facet evidence for one locked quote association."""

    actor, receipt_hmac_key = _assert_service_claim(facet_claim_json)
    claim = _parse_claim(facet_claim_json)
    anchors = _locked_anchors(claim)
    evidence_id, reconciliation_id, external_entity_id = _projection_ids(claim["event_id"])
    now = str(frappe.utils.now_datetime())
    evidence = {
        "doctype": "Evidence Item",
        "evidence_id": evidence_id,
        "device_action_id": f"facet-projection:{hashlib.sha256(claim['event_id'].encode('utf-8')).hexdigest()}",
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
        "summary": _evidence_summary(claim),
    }
    reconciliation = {
        "doctype": "Integration Reconciliation",
        "reconciliation_id": reconciliation_id,
        "roof_job": anchors["job"]["name"],
        "system_name": "Facet",
        "entity_type": "Design Revision",
        "external_entity_id": external_entity_id,
        "local_doctype": "Customer Quote",
        "local_name": anchors["quote"]["name"],
        "direction": "Inbound",
        "status": "Pending",
        "detected_at": claim["received_at"],
        "raw_key": claim["raw_key"],
        "source_version": claim["design_revision_id"],
        "source_amount": None,
        "local_amount": None,
        "currency": None,
        "source_payload_hash": claim["frozen_evidence_sha256"],
        "local_payload_hash": _local_payload_hash(claim, anchors),
        "last_attempt_at": now,
        "attempt_count": 1,
        "resolution_action": None,
        "resolved_by": None,
        "resolved_at": None,
        "resolution_evidence": None,
        "automation_incident": None,
        "supersedes": None,
        "correction_reason": None,
        "notes": None,
        "diff_json": _reconciliation_diff(claim),
    }
    existing_evidence = _locked_existing_evidence(evidence_id)
    existing_reconciliation = _locked_existing_reconciliation(reconciliation_id)
    if existing_evidence or existing_reconciliation:
        if existing_evidence is None or existing_reconciliation is None:
            _fail(
                "facet_design_projection_conflict",
                "existing projection is missing its paired evidence or reconciliation record",
            )
        _assert_replay(
            existing_evidence,
            {field: value for field, value in evidence.items() if field not in {"doctype", "verified_at"}},
            "facet_design_projection_conflict",
        )
        if (
            existing_evidence.get("sync_state") != "Verified"
            or existing_evidence.get("verification_source") != VERIFICATION_SOURCE
            or not existing_evidence.get("verified_at")
        ):
            _fail("facet_design_projection_conflict", "existing evidence is not verified by this Worker")
        _assert_reconciliation_replay(
            existing_reconciliation,
            reconciliation,
            "facet_design_projection_conflict",
        )
        return _projection_response(
            claim_json=facet_claim_json,
            claim=claim,
            anchors=anchors,
            evidence_id=evidence_id,
            reconciliation_id=reconciliation_id,
            local_payload_hash=reconciliation["local_payload_hash"],
            idempotent_replay=True,
            hmac_key=receipt_hmac_key,
        )
    evidence_document = frappe.get_doc(evidence)
    reconciliation_document = frappe.get_doc(reconciliation)
    with facet_design_projection_issuance_context(evidence_document, reconciliation_document):
        evidence_document.insert()
        reconciliation_document.insert()
    return _projection_response(
        claim_json=facet_claim_json,
        claim=claim,
        anchors=anchors,
        evidence_id=evidence_id,
        reconciliation_id=reconciliation_id,
        local_payload_hash=reconciliation["local_payload_hash"],
        idempotent_replay=False,
        hmac_key=receipt_hmac_key,
    )
