"""Fail-closed verification for Hermes approved-write capabilities.

The MCP runtime validates both receipts before it creates a ``Hermes Run``.
This module repeats the public-key check at the Frappe mutation boundary so a
principal that can edit an audit row cannot manufacture an approval by changing
mutable fields on that row.  Frappe intentionally has only the public key; the
dry-run HMAC secret and the approval private key remain outside the app.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


MAX_APPROVAL_RECEIPT_LIFETIME = timedelta(minutes=10)
MAX_APPROVAL_RECEIPT_FUTURE_ISSUANCE = timedelta(minutes=1)
MAX_PUBLIC_KEY_BYTES = 16_384
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_ROLE_SLUGS = {
    "Owner Operator": "owner-operator",
    "Lead Concierge": "lead-concierge",
    "Estimator Assistant": "estimator-assistant",
    "Production Controller": "production-controller",
    "Field Companion": "field-companion",
    "Finance Reconciler": "finance-reconciler",
    "Closeout Agent": "closeout-agent",
    "Support/Admin Agent": "support-admin-agent",
}


class ApprovalReceiptError(ValueError):
    """A stable, non-sensitive reason for rejecting a receipt."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def assert_approved_hermes_run_receipt(
    run: Mapping[str, Any],
    *,
    write_tool: str,
    approved_args: Mapping[str, str],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Verify the signed approval capability bound to one locked Hermes Run.

    ``approved_args`` must be the command's already-normalized, exact audit
    arguments.  The caller locks the Hermes Run before calling this function and
    consumes it in the same transaction, so this check also becomes a single-use
    mutation claim when paired with ``mutation_applied == 0``.
    """

    approval_receipt = _required_text(run.get("approval_receipt"), "approval_receipt_missing")
    dry_run_receipt = _required_text(run.get("dry_run_receipt"), "dry_run_receipt_missing")
    run_id = _required_text(run.get("run_id"), "run_id_missing")
    requested_by = _required_text(run.get("requested_by"), "actor_user_missing")
    approved_by = _required_text(run.get("approved_by"), "approved_by_missing")
    agent_role = _ROLE_SLUGS.get(_required_text(run.get("agent_role"), "agent_role_missing"))
    if not agent_role:
        raise ApprovalReceiptError("agent_role_invalid")

    if approved_args.get("run_id") != run_id:
        raise ApprovalReceiptError("args_run_id_mismatch")
    if approved_args.get("approved_by") != approved_by:
        raise ApprovalReceiptError("args_approved_by_mismatch")

    payload = _decode_and_verify(approval_receipt)
    current_time = now or datetime.now(UTC)
    _assert_receipt_window(payload, current_time)
    _assert_exact_payload(
        payload,
        {
            "write_tool": write_tool,
            "dry_run_receipt": dry_run_receipt,
            "agent_role": agent_role,
            "actor_user": requested_by,
            "run_id": run_id,
            "approved_by": approved_by,
            "args_digest": _digest(approved_args),
            "site_id": _expected_site_id(),
        },
    )
    return payload


def _decode_and_verify(receipt: str) -> dict[str, Any]:
    parts = receipt.split(".")
    if len(parts) != 2 or not all(_BASE64URL.fullmatch(part) for part in parts):
        raise ApprovalReceiptError("invalid")
    encoded_payload, encoded_signature = parts
    try:
        payload = json.loads(
            _base64url_decode(encoded_payload).decode("utf-8"),
            object_pairs_hook=_no_duplicate_object,
        )
        signature = _base64url_decode(encoded_signature)
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError, binascii.Error) as exc:
        raise ApprovalReceiptError("invalid") from exc
    if not isinstance(payload, dict) or len(signature) != 64:
        raise ApprovalReceiptError("invalid")
    try:
        _load_public_key().verify(signature, encoded_payload.encode("ascii"))
    except InvalidSignature as exc:
        raise ApprovalReceiptError("invalid") from exc
    if payload.get("v") != 1 or payload.get("type") != "hermes-human-approval":
        raise ApprovalReceiptError("invalid")
    return payload


def _load_public_key() -> Ed25519PublicKey:
    configured_path = os.environ.get("IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE", "").strip()
    if not configured_path:
        raise ApprovalReceiptError("public_key_missing")
    path = Path(configured_path)
    if not path.is_absolute() or path.is_symlink():
        raise ApprovalReceiptError("public_key_invalid")
    try:
        encoded_key = path.read_bytes()
    except OSError as exc:
        raise ApprovalReceiptError("public_key_unreadable") from exc
    if not encoded_key or len(encoded_key) > MAX_PUBLIC_KEY_BYTES:
        raise ApprovalReceiptError("public_key_invalid")
    try:
        public_key = serialization.load_pem_public_key(encoded_key)
    except ValueError as exc:
        raise ApprovalReceiptError("public_key_invalid") from exc
    if not isinstance(public_key, Ed25519PublicKey):
        raise ApprovalReceiptError("public_key_invalid")
    return public_key


def _expected_site_id() -> str:
    raw_base_url = _required_text(
        os.environ.get("IRONWRAP_HERMES_SITE_BASE_URL"), "site_base_url_missing"
    )
    try:
        parsed = urlsplit(raw_base_url)
    except ValueError as exc:
        raise ApprovalReceiptError("site_base_url_invalid") from exc
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ApprovalReceiptError("site_base_url_invalid")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ApprovalReceiptError("site_base_url_invalid") from exc
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    is_explicit_insecure_local = (
        scheme == "http"
        and host in {"localhost", "127.0.0.1", "::1"}
        and os.environ.get("IRONWRAP_HERMES_ALLOW_INSECURE_LOCAL") == "true"
    )
    if scheme != "https" and not is_explicit_insecure_local:
        raise ApprovalReceiptError("site_base_url_invalid")
    if not host.isascii():
        raise ApprovalReceiptError("site_base_url_invalid")
    formatted_host = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    formatted_port = f":{port}" if port and port != default_port else ""
    path = parsed.path.rstrip("/")
    canonical_base_url = f"{scheme}://{formatted_host}{formatted_port}{path}"
    return _digest({"frappe_base_url": canonical_base_url})


def _assert_receipt_window(payload: Mapping[str, Any], now: datetime) -> None:
    issued_at = _parse_iso(payload.get("issued_at"))
    expires_at = _parse_iso(payload.get("expires_at"))
    if issued_at is None or expires_at is None or expires_at <= now:
        raise ApprovalReceiptError("expired")
    if (
        issued_at > now + MAX_APPROVAL_RECEIPT_FUTURE_ISSUANCE
        or expires_at <= issued_at
        or expires_at - issued_at > MAX_APPROVAL_RECEIPT_LIFETIME
    ):
        raise ApprovalReceiptError("window_invalid")


def _assert_exact_payload(payload: Mapping[str, Any], expected: Mapping[str, str]) -> None:
    for field, value in expected.items():
        if payload.get(field) != value:
            raise ApprovalReceiptError(f"mismatch_{field}")


def _digest(value: Mapping[str, str]) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _canonical_json(value: Mapping[str, str]) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise ApprovalReceiptError("args_invalid") from exc


def _required_text(value: Any, code: str) -> str:
    if not isinstance(value, str):
        raise ApprovalReceiptError(code)
    cleaned = value.strip()
    if not cleaned:
        raise ApprovalReceiptError(code)
    return cleaned


def _base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)
