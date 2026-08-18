"""Governed QuickBooks residential final-invoice discovery and reconciliation.

QuickBooks remains posted accounting truth.  These commands expose only an
immutable, non-PII billing basis, bind the provider identity returned by a
successful CREATE, and reconcile a later authenticated GET observation.  They
never create or modify an accounting transaction, customer, payment, or credit.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

import frappe

from ironwrap_roofing.access_control import (
    QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE,
)
from ironwrap_roofing.document_validation import (
    quickbooks_final_invoice_bind_context,
    quickbooks_final_invoice_resolver_context,
    quickbooks_reconciliation_issuance_context,
)


ISSUER_CONFIG_KEY = "ironwrap_quickbooks_reconciliation_issuer_user"
MAX_JSON_LENGTH = 65_536
MAX_IDENTIFIER_LENGTH = 160
MAX_LIST_LIMIT = 100
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
QBO_ID_RE = re.compile(r"^[1-9][0-9]{0,31}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
R2_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INTENT_PREFIX = "qbo_final:"
MONEY_QUANTUM = Decimal("0.01")
MAX_MONEY = Decimal("999999999.99")
RATE_QUANTUM = Decimal("0.0001")
PAYMENT_STATUSES = frozenset(
    {"Unverified", "Not Due", "Due", "Partially Paid", "Paid", "Overdue", "Voided"}
)
MATCHABLE_PAYMENT_STATUSES = PAYMENT_STATUSES - {"Voided"}
FINAL_INVOICE_NOTES = (
    "QuickBooks final-invoice identity bound to an immutable commercial basis. "
    "Provider truth requires a later authenticated readback."
)
RESOLVER_OWNER = "IronWrap Finance"

LIST_FIELDS = frozenset({"roof_job_id", "limit", "realm_id"})
BIND_FIELDS = frozenset(
    {
        "intent_id",
        "basis_sha256",
        "completion_packet_id",
        "completion_version",
        "completion_sha256",
        "customer_quote_id",
        "quote_version",
        "quote_sha256",
        "changes_sha256",
        "roof_job_id",
        "shop_order_id",
        "realm_id",
        "provider_invoice_id",
        "provider_request_sha256",
        "provider_create_response_sha256",
        "provider_created_at",
    }
)
READBACK_ONLY_FIELDS = frozenset(
    {
        "customer_id",
        "item_id",
        "tax_code_id",
        "terms_id",
        "currency",
        "subtotal",
        "tax_amount",
        "total_amount",
        "balance_due",
        "lines_sha256",
        "tax_rate",
        "invoice_date",
        "due_date",
        "payment_status",
        "provider_readback_sha256",
        "provider_read_at",
    }
)


class CandidateBlocked(Exception):
    """One safe, typed reason a job cannot become a candidate."""

    def __init__(
        self,
        code: str,
        message: str,
        citations: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.citations = [dict(value) for value in citations]


def _fail(code: str, message: str, *, permission: bool = False) -> None:
    exc = frappe.PermissionError if permission else frappe.ValidationError
    frappe.throw(f"{code}: {message}", exc=exc)


def _conflict(message: str) -> None:
    response = getattr(getattr(frappe, "local", None), "response", None)
    if response is not None:
        try:
            response["http_status_code"] = 409
        except (TypeError, AttributeError):
            setattr(response, "http_status_code", 409)
    _fail("quickbooks_final_invoice_identity_conflict", message)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant {value!r}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = value
    return result


def _parse_json_argument(
    raw: Any,
    argument: str,
    allowed: frozenset[str],
    *,
    required: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw or len(raw) > MAX_JSON_LENGTH:
        _fail("quickbooks_final_invoice_invalid_input", f"{argument} must be JSON text")
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _fail("quickbooks_final_invoice_invalid_input", f"{argument} must be one strict JSON object")
    if not isinstance(value, dict) or set(value) - allowed or required - set(value):
        _fail(
            "quickbooks_final_invoice_invalid_input",
            f"{argument} has missing or unsupported fields",
        )
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(value: Any) -> str:
    encoded = value if isinstance(value, str) else _canonical_json(value)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _text(value: Any, field: str, *, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    if not isinstance(value, str):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} must be text")
    cleaned = value.strip()
    if not (1 <= len(cleaned) <= maximum) or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} is invalid")
    return cleaned


def _safe_id(value: Any, field: str) -> str:
    cleaned = _text(value, field)
    if not SAFE_ID_RE.fullmatch(cleaned):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} is invalid")
    return cleaned


def _qbo_id(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=32)
    if not QBO_ID_RE.fullmatch(cleaned):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} is not an exact QuickBooks ID")
    return cleaned


def _hash(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    if not SHA256_RE.fullmatch(cleaned):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} must be lowercase SHA-256")
    return cleaned


def _timestamp(value: Any, field: str) -> str:
    cleaned = _text(value, field, maximum=64)
    try:
        datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    except ValueError:
        _fail("quickbooks_final_invoice_invalid_input", f"{field} must be ISO-8601")
    return cleaned


def _timestamp_value(value: Any, field: str) -> datetime:
    cleaned = _timestamp(value, field)
    parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        # This service treats Frappe's naive database datetimes as UTC. That
        # policy is explicit so mixed ISO offsets cannot be ordered lexically.
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _candidate_timestamp(value: Any, field: str) -> datetime:
    cleaned = str(value or "").strip()
    if not cleaned:
        raise CandidateBlocked(f"missing_{field}", f"{field} is unavailable")
    try:
        parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    except ValueError:
        raise CandidateBlocked(
            f"invalid_{field}", f"{field} is not an ISO/Frappe datetime"
        ) from None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 2_147_483_647:
        _fail("quickbooks_final_invoice_invalid_input", f"{field} must be a positive integer")
    return value


def _version_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", value):
        _fail("quickbooks_final_invoice_invalid_input", f"{field} must be a positive integer string")
    return value


def _decimal(value: Any, field: str, quantum: Decimal) -> Decimal:
    if isinstance(value, bool) or value is None or value == "":
        raise CandidateBlocked(f"missing_{field}", f"{field} is unavailable")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise CandidateBlocked(f"invalid_{field}", f"{field} is not an exact decimal") from None
    if not number.is_finite() or number < 0 or number != number.quantize(quantum):
        raise CandidateBlocked(f"invalid_{field}", f"{field} has unsupported precision")
    return number


def _money(value: Any, field: str) -> str:
    number = _decimal(value, field, MONEY_QUANTUM)
    if number > MAX_MONEY:
        raise CandidateBlocked(f"invalid_{field}", f"{field} exceeds the bounded money range")
    return f"{number.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP):.2f}"


def _rate(value: Any, field: str) -> str:
    number = _decimal(value, field, RATE_QUANTUM)
    if number > Decimal("999.9999"):
        raise CandidateBlocked(f"invalid_{field}", f"{field} exceeds the bounded rate range")
    return f"{number.quantize(RATE_QUANTUM, rounding=ROUND_HALF_UP):.4f}"


def _date(value: Any, field: str) -> str:
    cleaned = str(value or "").strip()
    if not DATE_RE.fullmatch(cleaned):
        raise CandidateBlocked(f"missing_{field}", f"{field} is unavailable or invalid")
    try:
        datetime.strptime(cleaned, "%Y-%m-%d")
    except ValueError:
        raise CandidateBlocked(f"invalid_{field}", f"{field} is not a calendar date") from None
    return cleaned


def _is_true(value: Any) -> bool:
    return value is True or value == 1 or value == "1"


def _assert_issuer(*, mutation: bool) -> str:
    request = getattr(frappe, "request", None)
    method = getattr(request, "method", None)
    if method is not None and str(method).upper() != "POST":
        _fail("quickbooks_final_invoice_post_required", "this command accepts POST only", permission=True)
    configured = getattr(frappe, "conf", {}).get(ISSUER_CONFIG_KEY)
    if not isinstance(configured, str) or not configured.strip():
        _fail(
            "quickbooks_final_invoice_issuer_not_configured",
            f"Frappe site config {ISSUER_CONFIG_KEY} is required",
            permission=True,
        )
    actor = str(getattr(getattr(frappe, "session", None), "user", "") or "")
    if actor == "Guest" or actor != configured.strip():
        _fail(
            "quickbooks_final_invoice_issuer_auth_mismatch",
            "only the configured QuickBooks service principal may call this command",
            permission=True,
        )
    roles = {str(role) for role in frappe.get_roles(actor)}
    if QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE not in roles:
        _fail(
            "quickbooks_final_invoice_issuer_role_missing",
            "the service principal lacks the dedicated QuickBooks issuer role",
            permission=True,
        )
    if mutation and not frappe.has_permission(
        "Integration Reconciliation", ptype="create", user=actor
    ):
        _fail(
            "quickbooks_final_invoice_issuer_permission_denied",
            "the service principal lacks its narrow reconciliation grant",
            permission=True,
        )
    return actor


def _dict(row: Any) -> dict[str, Any]:
    return dict(row) if isinstance(row, Mapping) else {}


def _frappe_citation(doctype: str, row: Mapping[str, Any], fields: Sequence[str]) -> dict[str, str]:
    snapshot = {field: row.get(field) for field in fields}
    return {
        "source": "Frappe",
        "doctype": doctype,
        "name": str(row.get("name") or row.get(fields[0]) or ""),
        "sha256": _sha256(snapshot),
    }


def _verified_evidence(
    evidence: Mapping[str, Mapping[str, Any]],
    evidence_id: Any,
    roof_job: str,
    code: str,
) -> list[dict[str, str]]:
    row = evidence.get(str(evidence_id or ""))
    if (
        not row
        or row.get("roof_job") != roof_job
        or row.get("sync_state") != "Verified"
        or row.get("checksum_algorithm") != "SHA-256"
        or not SHA256_RE.fullmatch(str(row.get("content_checksum") or ""))
        or not R2_KEY_RE.fullmatch(str(row.get("r2_key") or ""))
        or ".." in str(row.get("r2_key") or "")
    ):
        raise CandidateBlocked(code, "required immutable evidence is unavailable")
    frappe_citation = _frappe_citation(
        "Evidence Item",
        row,
        (
            "name",
            "roof_job",
            "evidence_type",
            "proof_slot",
            "r2_key",
            "content_checksum",
            "sync_state",
            "verified_at",
        ),
    )
    return [
        frappe_citation,
        {
            "source": "R2",
            "key": str(row["r2_key"]),
            "sha256": str(row["content_checksum"]),
        },
    ]


def _current_rows(rows: Sequence[Mapping[str, Any]], identity: str) -> list[Mapping[str, Any]]:
    superseded = {
        str(row.get("supersedes")) for row in rows if str(row.get("supersedes") or "")
    }
    return [
        row
        for row in rows
        if {str(row.get("name") or ""), str(row.get(identity) or "")}.isdisjoint(superseded)
    ]


def _terms_due_days(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= 365
    ):
        raise CandidateBlocked(
            "invalid_payment_terms",
            "accepted QuickBooks terms due days must be an integer from 0 through 365",
        )
    return value


def _accepted_terms_due_days(
    quote: Mapping[str, Any],
    acceptance: Mapping[str, Any],
    citations: Sequence[Mapping[str, Any]],
) -> int:
    raw = acceptance.get("terms_snapshot_json")
    terms_hash = str(acceptance.get("terms_hash") or "")
    if (
        not isinstance(raw, str)
        or not raw
        or not SHA256_RE.fullmatch(terms_hash)
        or _sha256(raw) != terms_hash
    ):
        raise CandidateBlocked(
            "accepted_terms_policy_missing",
            "accepted customer terms lack an immutable verified snapshot",
            citations,
        )
    try:
        terms = json.loads(
            raw,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        raise CandidateBlocked(
            "accepted_terms_policy_missing",
            "accepted customer terms snapshot is invalid",
            citations,
        ) from None
    quote_terms = terms.get("quote") if isinstance(terms, Mapping) else None
    if (
        not isinstance(terms, Mapping)
        or terms.get("schema") != "ironwrap.customer-contract-terms.v2"
        or not isinstance(quote_terms, Mapping)
    ):
        raise CandidateBlocked(
            "accepted_terms_policy_missing",
            "accepted customer terms are not the supported v2 snapshot",
            citations,
        )
    due_days = _terms_due_days(quote.get("qb_terms_due_days"))
    snapshot_due_days = _terms_due_days(quote_terms.get("qb_terms_due_days"))
    terms_ref = str(quote.get("qb_terms_ref") or "")
    if snapshot_due_days != due_days or str(quote_terms.get("qb_terms_ref") or "") != terms_ref:
        raise CandidateBlocked(
            "accepted_terms_policy_mismatch",
            "current QuickBooks terms differ from the accepted customer terms",
            citations,
        )
    return due_days


def _build_candidate(
    bundle: Mapping[str, Any], *, realm_id: str | None = None, allow_bound_intent: str | None = None
) -> dict[str, Any]:
    job = _dict(bundle.get("job"))
    roof_job_id = str(job.get("roof_job_id") or job.get("name") or "")
    job_name = str(job.get("name") or roof_job_id)
    if not SAFE_ID_RE.fullmatch(roof_job_id):
        raise CandidateBlocked("invalid_roof_job_identity", "Roof Job identity is unavailable")
    stored_realm = str(job.get("qb_realm_id") or "")
    if stored_realm and realm_id and stored_realm != realm_id:
        raise CandidateBlocked(
            "quickbooks_realm_mismatch",
            "Roof Job provenance belongs to a different QuickBooks realm",
        )
    if job.get("workflow_profile") != "Residential Retail":
        raise CandidateBlocked("unsupported_workflow_profile", "only Residential Retail final balances are supported")
    if job.get("job_status") != "Completed":
        raise CandidateBlocked("job_not_completed", "Roof Job must be exactly Completed")

    quote_rows = [_dict(row) for row in bundle.get("quotes", ())]
    current_quotes = _current_rows(quote_rows, "customer_quote_id")
    quote = next(
        (row for row in current_quotes if row.get("name") == job.get("quotation")), None
    )
    if len(current_quotes) != 1 or quote is None:
        raise CandidateBlocked("ambiguous_current_quote", "the current Customer Quote is missing or ambiguous")
    quote_citation = _frappe_citation(
        "Customer Quote",
        quote,
        (
            "name",
            "customer_quote_id",
            "roof_job",
            "customer",
            "quote_version",
            "status",
            "subtotal",
            "tax_amount",
            "tax_code",
            "tax_rate",
            "tax_policy_snapshot_json",
            "quote_total",
            "currency",
            "deposit_amount",
            "amount_paid",
            "qb_item_ref",
            "qb_tax_code_ref",
            "qb_terms_ref",
            "qb_terms_due_days",
            "approved_at",
            "accepted_at",
            "contract_acceptance",
            "acceptance_evidence",
            "supersedes",
        ),
    )
    if quote.get("status") != "Accepted":
        raise CandidateBlocked(
            "quote_not_accepted",
            "current Customer Quote must be exactly Accepted",
            [quote_citation],
        )
    if quote.get("roof_job") != job_name or quote.get("customer") != job.get("customer"):
        raise CandidateBlocked("quote_job_mismatch", "current Customer Quote linkage is inconsistent", [quote_citation])
    try:
        quote_version = int(quote.get("quote_version"))
    except (TypeError, ValueError):
        quote_version = 0
    if quote_version < 1:
        raise CandidateBlocked("invalid_quote_version", "current Customer Quote version is unavailable", [quote_citation])

    acceptances = [_dict(row) for row in bundle.get("acceptances", ())]
    quote_acceptance = [
        row
        for row in acceptances
        if row.get("customer_quote") == quote.get("name")
        and row.get("status") == "Accepted"
        and row.get("roof_job") == job_name
    ]
    if len(quote_acceptance) != 1 or quote.get("contract_acceptance") != quote_acceptance[0].get("name"):
        raise CandidateBlocked("quote_acceptance_missing", "current quote lacks exact accepted commercial evidence", [quote_citation])
    if str(quote.get("acceptance_evidence") or "") != str(
        quote_acceptance[0].get("evidence_item") or ""
    ):
        raise CandidateBlocked(
            "quote_acceptance_missing",
            "current quote acceptance evidence linkage is inconsistent",
            [quote_citation],
        )
    acceptance_citation = _frappe_citation(
        "Contract Acceptance",
        quote_acceptance[0],
        (
            "name",
            "roof_job",
            "customer_quote",
            "contract_version",
            "status",
            "accepted_at",
            "evidence_item",
            "terms_hash",
            "terms_snapshot_json",
        ),
    )
    citations: list[dict[str, str]] = [quote_citation, acceptance_citation]
    due_days = _accepted_terms_due_days(
        quote, quote_acceptance[0], [quote_citation, acceptance_citation]
    )
    citations.extend(
        _verified_evidence(
            bundle.get("evidence", {}),
            quote_acceptance[0].get("evidence_item"),
            job_name,
            "quote_acceptance_evidence_missing",
        )
    )

    quote_accepted_at = _candidate_timestamp(
        quote.get("accepted_at"), "quote_accepted_at"
    )
    acceptance_accepted_at = _candidate_timestamp(
        quote_acceptance[0].get("accepted_at"), "quote_acceptance_accepted_at"
    )
    if quote_accepted_at != acceptance_accepted_at:
        raise CandidateBlocked(
            "quote_acceptance_timestamp_mismatch",
            "quote and acceptance timestamps do not identify the same event",
            [quote_citation, acceptance_citation],
        )

    completions = [_dict(row) for row in bundle.get("completions", ())]
    if not completions:
        raise CandidateBlocked("completion_packet_missing", "Completion Packet is missing")
    valid_versions: list[tuple[int, dict[str, Any]]] = []
    for packet in completions:
        value = packet.get("packet_version")
        try:
            version = int(value)
        except (TypeError, ValueError):
            continue
        if isinstance(value, bool) or str(value) != str(version) or version < 1:
            continue
        valid_versions.append((version, packet))
    if len(valid_versions) != len(completions):
        raise CandidateBlocked("completion_version_missing", "Completion Packet lacks an explicit integral version")
    latest_version = max(version for version, _packet in valid_versions)
    latest = [packet for version, packet in valid_versions if version == latest_version]
    if len(latest) != 1:
        raise CandidateBlocked("ambiguous_completion_packet", "latest Completion Packet is ambiguous")
    completion = latest[0]
    completion_citation = _frappe_citation(
        "Completion Packet",
        completion,
        (
            "name",
            "completion_packet_id",
            "roof_job",
            "packet_version",
            "status",
            "prepared_at",
            "approved_at",
            "approved_by",
            "completion_evidence",
            "deficiencies_resolved",
            "customer_signoff_ref",
            "warranty_ready",
            "photo_evidence_json",
            "evidence_summary_json",
        ),
    )
    if completion.get("status") != "Approved":
        raise CandidateBlocked("completion_not_approved", "latest Completion Packet must be exactly Approved", [completion_citation])
    if completion.get("roof_job") != job_name:
        raise CandidateBlocked("completion_job_mismatch", "Completion Packet job linkage is inconsistent", [completion_citation])
    if not _is_true(completion.get("deficiencies_resolved")):
        raise CandidateBlocked("open_deficiencies", "all Completion Packet deficiencies must be resolved", [completion_citation])
    if not _is_true(completion.get("warranty_ready")):
        raise CandidateBlocked("warranty_not_ready", "Completion Packet warranty readiness is missing", [completion_citation])
    if not str(completion.get("customer_signoff_ref") or "").strip():
        raise CandidateBlocked("completion_signoff_missing", "Completion Packet signoff evidence is missing", [completion_citation])
    citations.append(completion_citation)
    citations.extend(
        _verified_evidence(
            bundle.get("evidence", {}),
            completion.get("completion_evidence"),
            job_name,
            "completion_evidence_missing",
        )
    )

    change_rows = [_dict(row) for row in bundle.get("changes", ())]
    current_changes = _current_rows(change_rows, "change_order_id")
    if any(row.get("status") not in {"Accepted", "Rejected"} for row in current_changes):
        raise CandidateBlocked("unresolved_change_order", "a current Change Order is not finally resolved")
    accepted_changes = [row for row in current_changes if row.get("status") == "Accepted"]
    sortable_changes: list[tuple[str, int, str, dict[str, Any]]] = []
    for change in accepted_changes:
        try:
            change_version = int(change.get("version"))
        except (TypeError, ValueError):
            raise CandidateBlocked(
                "invalid_change_version",
                "accepted Change Order version is unavailable",
            ) from None
        if isinstance(change.get("version"), bool) or change_version < 1:
            raise CandidateBlocked(
                "invalid_change_version",
                "accepted Change Order version is unavailable",
            )
        sortable_changes.append(
            (
                str(change.get("change_number") or ""),
                change_version,
                str(change.get("name") or ""),
                change,
            )
        )
    accepted_changes = [row for _number, _version, _name, row in sorted(sortable_changes)]
    quote_currency = str(quote.get("currency") or "")
    if quote_currency != "CAD":
        raise CandidateBlocked("unsupported_currency", "the scoped final-invoice currency must be CAD", [quote_citation])
    quote_tax_code = str(quote.get("tax_code") or "").strip()
    if not SAFE_ID_RE.fullmatch(quote_tax_code):
        raise CandidateBlocked("missing_tax_policy", "the quote tax code is unavailable", [quote_citation])
    quote_tax_rate = _rate(quote.get("tax_rate"), "tax_rate")
    quote_tax_policy = str(quote.get("tax_policy_snapshot_json") or "")
    if not quote_tax_policy:
        raise CandidateBlocked("missing_tax_policy", "the quote tax policy snapshot is unavailable", [quote_citation])

    quote_subtotal = _money(quote.get("subtotal"), "subtotal")
    quote_tax = _money(quote.get("tax_amount"), "tax_amount")
    quote_total = _money(quote.get("quote_total"), "quote_total")
    if Decimal(quote_subtotal) + Decimal(quote_tax) != Decimal(quote_total):
        raise CandidateBlocked("commercial_amount_mismatch", "quote subtotal plus tax does not equal total", [quote_citation])
    lines = [
        {
            "source_type": "Customer Quote",
            "source_id": str(quote.get("customer_quote_id") or quote.get("name")),
            "source_version": quote_version,
            "description_code": "RESIDENTIAL_ACCEPTED_QUOTE",
            "amount": quote_subtotal,
        }
    ]
    tax_amount = Decimal(quote_tax)
    changes_basis: list[dict[str, Any]] = []
    completion_at = _candidate_timestamp(
        completion.get("approved_at"), "completion_approved_at"
    )
    for change in accepted_changes:
        citation = _frappe_citation(
            "Change Order",
            change,
            (
                "name",
                "change_order_id",
                "roof_job",
                "customer_quote",
                "change_number",
                "version",
                "status",
                "currency",
                "subtotal",
                "tax_amount",
                "tax_code",
                "tax_rate",
                "tax_policy_snapshot_json",
                "total_amount",
                "contract_acceptance",
                "accepted_at",
                "supersedes",
            ),
        )
        if change.get("roof_job") != job_name or change.get("customer_quote") != quote.get("name"):
            raise CandidateBlocked("change_order_basis_mismatch", "accepted Change Order linkage is inconsistent", [citation])
        acceptance = [
            row
            for row in acceptances
            if row.get("change_order") == change.get("name")
            and row.get("status") == "Accepted"
            and row.get("roof_job") == job_name
        ]
        if len(acceptance) != 1 or change.get("contract_acceptance") != acceptance[0].get("name"):
            raise CandidateBlocked("change_acceptance_missing", "accepted Change Order lacks exact acceptance evidence", [citation])
        change_accepted_at = _candidate_timestamp(
            change.get("accepted_at"), "change_accepted_at"
        )
        change_acceptance_at = _candidate_timestamp(
            acceptance[0].get("accepted_at"), "change_acceptance_accepted_at"
        )
        if change_accepted_at != change_acceptance_at:
            raise CandidateBlocked(
                "change_acceptance_timestamp_mismatch",
                "Change Order and acceptance timestamps do not identify the same event",
                [citation],
            )
        if (
            change.get("currency") != quote_currency
            or str(change.get("tax_code") or "") != quote_tax_code
            or _rate(change.get("tax_rate"), "tax_rate") != quote_tax_rate
            or str(change.get("tax_policy_snapshot_json") or "") != quote_tax_policy
        ):
            raise CandidateBlocked("change_tax_policy_mismatch", "accepted Change Order tax or currency policy differs", [citation])
        change_subtotal = _money(change.get("subtotal"), "subtotal")
        change_tax = _money(change.get("tax_amount"), "tax_amount")
        change_total = _money(change.get("total_amount"), "total_amount")
        if Decimal(change_subtotal) + Decimal(change_tax) != Decimal(change_total):
            raise CandidateBlocked("commercial_amount_mismatch", "Change Order subtotal plus tax does not equal total", [citation])
        if completion_at < change_accepted_at:
            raise CandidateBlocked("stale_completion_packet", "Completion Packet predates an accepted Change Order", [completion_citation, citation])
        change_version = int(change["version"])
        lines.append(
            {
                "source_type": "Change Order",
                "source_id": str(change.get("change_order_id") or change.get("name")),
                "source_version": change_version,
                "description_code": "RESIDENTIAL_ACCEPTED_CHANGE",
                "amount": change_subtotal,
            }
        )
        tax_amount += Decimal(change_tax)
        citations.append(citation)
        citations.extend(
            _verified_evidence(
                bundle.get("evidence", {}),
                acceptance[0].get("evidence_item"),
                job_name,
                "change_acceptance_evidence_missing",
            )
        )
        changes_basis.append({"citation": citation, "acceptance": acceptance[0].get("name")})

    if completion_at < quote_accepted_at:
        raise CandidateBlocked("stale_completion_packet", "Completion Packet predates the current quote basis", [completion_citation, quote_citation])

    deposits = _money(quote.get("deposit_amount"), "deposit_amount")
    paid = _money(quote.get("amount_paid"), "amount_paid")
    active_invoices = [
        row
        for row in bundle.get("milestones", ())
        if row.get("milestone_type") == "Invoice"
        and row.get("status") != "Ignored"
        and not (
            allow_bound_intent is not None
            and row.get("invoice_intent_id") == allow_bound_intent
        )
    ]
    bound_invoice = str(job.get("qb_invoice_ref") or "")
    if (
        deposits != "0.00"
        or paid != "0.00"
        or active_invoices
        or (bound_invoice and allow_bound_intent is None)
    ):
        raise CandidateBlocked(
            "unsupported_prior_billing_basis",
            "this first final-balance slice requires exact zero prior invoices, deposits, and payments",
            [quote_citation],
        )

    shop_rows = [_dict(row) for row in bundle.get("shop_orders", ())]
    if len(shop_rows) > 1:
        raise CandidateBlocked("ambiguous_shop_order", "multiple Shop Orders are linked to the Roof Job")
    shop_order_id: str | None = None
    if shop_rows:
        shop = shop_rows[0]
        shop_order_id = str(shop.get("shop_order_id") or shop.get("name") or "")
        citation = _frappe_citation(
            "Shop Order",
            shop,
            ("name", "shop_order_id", "roof_job", "status", "handed_over_at", "handoff_evidence"),
        )
        if shop.get("status") != "Handed Over" or not shop.get("handed_over_at"):
            raise CandidateBlocked("shop_not_handed_over", "Shop Order must be exactly Handed Over", [citation])
        citations.append(citation)
        citations.extend(
            _verified_evidence(
                bundle.get("evidence", {}),
                shop.get("handoff_evidence"),
                job_name,
                "shop_handoff_evidence_missing",
            )
        )
    elif job.get("service_type") == "Metal Roofing":
        raise CandidateBlocked("shop_order_missing", "Metal Roofing requires one exact handed-over Shop Order")

    customer = _dict(bundle.get("customer"))
    mappings = {
        "realm_id": str(realm_id or job.get("qb_realm_id") or ""),
        "customer_id": str(customer.get("qb_customer_ref") or ""),
        "item_id": str(quote.get("qb_item_ref") or ""),
        "tax_code_id": str(quote.get("qb_tax_code_ref") or ""),
        "terms_id": str(quote.get("qb_terms_ref") or ""),
    }
    if any(not QBO_ID_RE.fullmatch(value) for value in mappings.values()):
        raise CandidateBlocked("missing_quickbooks_mapping", "an exact realm/customer/item/tax/terms mapping is missing", [quote_citation])
    invoice_date_value = completion_at.date()
    invoice_date = invoice_date_value.isoformat()
    due_date = (invoice_date_value + timedelta(days=due_days)).isoformat()
    subtotal = sum((Decimal(line["amount"]) for line in lines), Decimal("0"))
    total = subtotal + tax_amount
    if subtotal > MAX_MONEY or tax_amount > MAX_MONEY or total > MAX_MONEY:
        raise CandidateBlocked(
            "invalid_final_balance",
            "final-invoice aggregate exceeds the bounded money range",
            [quote_citation],
        )
    commercial = {
        "currency": "CAD",
        "subtotal": f"{subtotal:.2f}",
        "tax_amount": f"{tax_amount:.2f}",
        "total_amount": f"{total:.2f}",
        "already_invoiced": "0.00",
        "final_balance": f"{total:.2f}",
        "tax_code": quote_tax_code,
        "tax_rate": quote_tax_rate,
        "invoice_date": invoice_date,
        "due_date": due_date,
        "lines": lines,
    }
    changes_sha256 = _sha256(changes_basis)
    basis_identity = {
        "roof_job_id": roof_job_id,
        "shop_order_id": shop_order_id,
        "completion_packet_id": str(completion.get("completion_packet_id") or completion.get("name")),
        "completion_version": str(latest_version),
        "completion_sha256": completion_citation["sha256"],
        "customer_quote_id": str(quote.get("customer_quote_id") or quote.get("name")),
        "quote_version": quote_version,
        "quote_sha256": quote_citation["sha256"],
        "changes_sha256": changes_sha256,
        "qbo": mappings,
        "commercial": commercial,
        "evidence": citations,
    }
    basis_sha256 = _sha256(basis_identity)
    basis = {
        "intent_id": f"{INTENT_PREFIX}{basis_sha256}",
        "basis_sha256": basis_sha256,
        "completion_packet_id": basis_identity["completion_packet_id"],
        "completion_version": basis_identity["completion_version"],
        "completion_sha256": basis_identity["completion_sha256"],
        "customer_quote_id": basis_identity["customer_quote_id"],
        "quote_version": quote_version,
        "quote_sha256": basis_identity["quote_sha256"],
        "changes_sha256": changes_sha256,
        "evidence": citations,
    }
    candidate = {
        "roof_job_id": roof_job_id,
        "shop_order_id": shop_order_id,
        "qbo": mappings,
        "commercial": commercial,
        "basis": basis,
    }
    candidate["_basis_json"] = _canonical_json(basis_identity)
    candidate["_lines_sha256"] = _sha256(
        [
            {
                "amount": line["amount"],
                "description_code": line["description_code"],
                "item_id": mappings["item_id"],
                "tax_code_id": mappings["tax_code_id"],
            }
            for line in lines
        ]
    )
    return candidate


def _public_candidate(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return {key: candidate[key] for key in ("roof_job_id", "shop_order_id", "qbo", "commercial", "basis")}


def _select(table: str, fields: str, where: str, values: tuple[Any, ...], *, lock: bool) -> list[dict[str, Any]]:
    suffix = " FOR UPDATE" if lock else ""
    return [
        dict(row)
        for row in frappe.db.sql(
            f"SELECT {fields} FROM `tab{table}` WHERE {where}{suffix}", values, as_dict=True
        )
    ]


def _load_bundle(roof_job_id: str, *, lock: bool = False) -> dict[str, Any]:
    jobs = _select(
        "Roof Job",
        "name, roof_job_id, customer, quotation, workflow_profile, service_type, job_status, qb_realm_id, qb_invoice_ref",
        "roof_job_id = %s",
        (roof_job_id,),
        lock=lock,
    )
    if len(jobs) != 1:
        raise CandidateBlocked("roof_job_missing", "Roof Job is missing or ambiguous")
    job = jobs[0]
    job_name = job["name"]
    quotes = _select(
        "Customer Quote",
        "name, customer_quote_id, roof_job, customer, quote_version, status, subtotal, tax_amount, tax_code, tax_rate, tax_policy_snapshot_json, quote_total, currency, deposit_amount, amount_paid, qb_item_ref, qb_tax_code_ref, qb_terms_ref, qb_terms_due_days, approved_at, accepted_at, contract_acceptance, acceptance_evidence, supersedes",
        "roof_job = %s",
        (job_name,),
        lock=lock,
    )
    customers = _select(
        "Roofing Customer", "name, customer_id, qb_customer_ref", "name = %s", (job.get("customer"),), lock=lock
    ) if job.get("customer") else []
    completions = _select(
        "Completion Packet",
        "name, completion_packet_id, roof_job, packet_version, status, prepared_at, approved_at, approved_by, photo_evidence_json, completion_evidence, deficiency_list, deficiencies_resolved, customer_signoff_ref, warranty_ready, evidence_summary_json, assumptions, exclusions",
        "roof_job = %s",
        (job_name,),
        lock=lock,
    )
    changes = _select(
        "Change Order",
        "name, change_order_id, roof_job, customer_quote, change_number, version, status, currency, subtotal, tax_amount, tax_code, tax_rate, tax_policy_snapshot_json, total_amount, contract_acceptance, accepted_at, supersedes",
        "roof_job = %s",
        (job_name,),
        lock=lock,
    )
    acceptances = _select(
        "Contract Acceptance", "name, roof_job, customer_quote, change_order, contract_version, status, evidence_item, accepted_at, terms_hash, terms_snapshot_json", "roof_job = %s", (job_name,), lock=lock
    )
    shops = _select(
        "Shop Order", "name, shop_order_id, roof_job, status, handed_over_at, handoff_evidence", "roof_job = %s", (job_name,), lock=lock
    )
    milestones = _select(
        "Payment Milestone", "name, payment_milestone_id, roof_job, milestone_type, status, invoice_intent_id, qb_entity_id, realm_id", "roof_job = %s", (job_name,), lock=lock
    )
    evidence_ids = {
        str(value)
        for value in (
            [packet.get("completion_evidence") for packet in completions]
            + [shop.get("handoff_evidence") for shop in shops]
            + [acceptance.get("evidence_item") for acceptance in acceptances]
        )
        if value
    }
    evidence: dict[str, dict[str, Any]] = {}
    if evidence_ids:
        placeholders = ",".join(["%s"] * len(evidence_ids))
        rows = _select(
            "Evidence Item",
            "name, evidence_id, roof_job, evidence_type, proof_slot, r2_key, content_checksum, checksum_algorithm, sync_state, verified_at",
            f"name IN ({placeholders})",
            tuple(sorted(evidence_ids)),
            lock=lock,
        )
        evidence = {str(row["name"]): row for row in rows}
    return {
        "job": job,
        "customer": customers[0] if len(customers) == 1 else {},
        "quotes": quotes,
        "completions": completions,
        "changes": changes,
        "acceptances": acceptances,
        "shop_orders": shops,
        "milestones": milestones,
        "evidence": evidence,
    }


def _job_ids(requested: str | None, limit: int) -> list[str]:
    if requested:
        return [requested]
    rows = frappe.db.sql(
        """
        SELECT roof_job_id
        FROM `tabRoof Job`
        WHERE workflow_profile = 'Residential Retail'
          AND job_status = 'Completed'
          AND COALESCE(qb_invoice_ref, '') = ''
        ORDER BY modified DESC, roof_job_id ASC
        LIMIT %s
        """,
        (limit,),
        as_dict=True,
    )
    return [str(row["roof_job_id"]) for row in rows]


def _validate_binding(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "intent_id": _text(payload["intent_id"], "intent_id"),
        "basis_sha256": _hash(payload["basis_sha256"], "basis_sha256"),
        "completion_packet_id": _safe_id(payload["completion_packet_id"], "completion_packet_id"),
        "completion_version": _version_string(payload["completion_version"], "completion_version"),
        "completion_sha256": _hash(payload["completion_sha256"], "completion_sha256"),
        "customer_quote_id": _safe_id(payload["customer_quote_id"], "customer_quote_id"),
        "quote_version": _positive_int(payload["quote_version"], "quote_version"),
        "quote_sha256": _hash(payload["quote_sha256"], "quote_sha256"),
        "changes_sha256": _hash(payload["changes_sha256"], "changes_sha256"),
        "roof_job_id": _safe_id(payload["roof_job_id"], "roof_job_id"),
        "shop_order_id": None if payload["shop_order_id"] is None else _safe_id(payload["shop_order_id"], "shop_order_id"),
        "realm_id": _qbo_id(payload["realm_id"], "realm_id"),
        "provider_invoice_id": _qbo_id(payload["provider_invoice_id"], "provider_invoice_id"),
        "provider_request_sha256": _hash(payload["provider_request_sha256"], "provider_request_sha256"),
        "provider_create_response_sha256": _hash(payload["provider_create_response_sha256"], "provider_create_response_sha256"),
        "provider_created_at": _timestamp(payload["provider_created_at"], "provider_created_at"),
    }


def _assert_basis(candidate: Mapping[str, Any], binding: Mapping[str, Any]) -> None:
    basis = candidate["basis"]
    expected = {
        "intent_id": basis["intent_id"],
        "basis_sha256": basis["basis_sha256"],
        "completion_packet_id": basis["completion_packet_id"],
        "completion_version": basis["completion_version"],
        "completion_sha256": basis["completion_sha256"],
        "customer_quote_id": basis["customer_quote_id"],
        "quote_version": basis["quote_version"],
        "quote_sha256": basis["quote_sha256"],
        "changes_sha256": basis["changes_sha256"],
        "roof_job_id": candidate["roof_job_id"],
        "shop_order_id": candidate["shop_order_id"],
        "realm_id": candidate["qbo"]["realm_id"],
    }
    if any(binding.get(field) != value for field, value in expected.items()):
        _conflict("request identity no longer equals the current immutable Frappe basis")


def _basis_matches(candidate: Mapping[str, Any], binding: Mapping[str, Any]) -> bool:
    basis = candidate["basis"]
    return all(
        binding.get(field) == value
        for field, value in {
            "intent_id": basis["intent_id"],
            "basis_sha256": basis["basis_sha256"],
            "completion_packet_id": basis["completion_packet_id"],
            "completion_version": basis["completion_version"],
            "completion_sha256": basis["completion_sha256"],
            "customer_quote_id": basis["customer_quote_id"],
            "quote_version": basis["quote_version"],
            "quote_sha256": basis["quote_sha256"],
            "changes_sha256": basis["changes_sha256"],
            "roof_job_id": candidate["roof_job_id"],
            "shop_order_id": candidate["shop_order_id"],
            "realm_id": candidate["qbo"]["realm_id"],
        }.items()
    )


def _locked_bind_rows(binding: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    milestones = _select(
        "Payment Milestone",
        "*",
        "invoice_intent_id = %s OR (realm_id = %s AND qb_entity_id = %s)",
        (binding["intent_id"], binding["realm_id"], binding["provider_invoice_id"]),
        lock=True,
    )
    reconciliations = _select(
        "Integration Reconciliation",
        "*",
        "invoice_intent_id = %s OR (system_name = 'QuickBooks' AND entity_type = 'Invoice' AND realm_id = %s AND external_entity_id = %s)",
        (binding["intent_id"], binding["realm_id"], binding["provider_invoice_id"]),
        lock=True,
    )
    return milestones, reconciliations


def _same_bound(document: Mapping[str, Any], binding: Mapping[str, Any]) -> bool:
    common = all(
        str(document.get(field) or "") == str(value or "")
        for field, value in {
            "invoice_intent_id": binding["intent_id"],
            "billing_basis_sha256": binding["basis_sha256"],
            "realm_id": binding["realm_id"],
            "provider_request_sha256": binding["provider_request_sha256"],
            "provider_create_response_sha256": binding["provider_create_response_sha256"],
            "provider_created_at": binding["provider_created_at"],
        }.items()
    )
    doctype = str(document.get("doctype") or "")
    if doctype == "Payment Milestone" or "qb_entity_id" in document:
        provider_identity = (
            document.get("qb_entity_type") == "Invoice"
            and str(document.get("qb_entity_id") or "")
            == binding["provider_invoice_id"]
        )
    elif doctype == "Integration Reconciliation" or "external_entity_id" in document:
        provider_identity = (
            str(document.get("system_name") or "").casefold() == "quickbooks"
            and document.get("entity_type") == "Invoice"
            and str(document.get("external_entity_id") or "")
            == binding["provider_invoice_id"]
        )
    else:
        provider_identity = False
    return common and provider_identity


def _save(document: Any, context_manager: Any, *, insert: bool = False) -> None:
    with context_manager(document):
        if insert:
            document.insert(ignore_permissions=True)
        else:
            document.save(ignore_permissions=True)


@frappe.whitelist()
def list_candidates(request_json: str) -> dict[str, Any]:
    """Return bounded non-PII candidates and explicit typed blockers."""

    _assert_issuer(mutation=False)
    request = _parse_json_argument(request_json, "request_json", LIST_FIELDS)
    if "realm_id" not in request:
        _fail("quickbooks_final_invoice_invalid_input", "realm_id is required")
    realm_id = _qbo_id(request["realm_id"], "realm_id")
    roof_job_id = request.get("roof_job_id")
    if roof_job_id is not None:
        roof_job_id = _safe_id(roof_job_id, "roof_job_id")
    limit = request.get("limit", 50)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIST_LIMIT:
        _fail("quickbooks_final_invoice_invalid_input", "limit must be an integer from 1 through 100")
    candidates: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    for job_id in _job_ids(roof_job_id, limit):
        try:
            candidates.append(
                _public_candidate(
                    _build_candidate(_load_bundle(job_id), realm_id=realm_id)
                )
            )
        except CandidateBlocked as blocked:
            blockers.append(
                {
                    "roof_job_id": job_id,
                    "code": blocked.code,
                    "message": blocked.message,
                    "citations": blocked.citations,
                }
            )
    return {"candidates": candidates, "blockers": blockers}


@frappe.whitelist()
def bind_provider_invoice(binding_json: str) -> dict[str, Any]:
    """Atomically bind a successful provider CREATE identity; never Match."""

    _assert_issuer(mutation=True)
    binding = _validate_binding(
        _parse_json_argument(binding_json, "binding_json", BIND_FIELDS, required=BIND_FIELDS)
    )
    candidate = _build_candidate(
        _load_bundle(binding["roof_job_id"], lock=True),
        realm_id=binding["realm_id"],
        allow_bound_intent=binding["intent_id"],
    )
    _assert_basis(candidate, binding)
    milestones, reconciliations = _locked_bind_rows(binding)
    if len(milestones) > 1 or len(reconciliations) > 1:
        _conflict("provider identity or intent is already multiply bound")
    if milestones:
        milestone_intent = str(milestones[0].get("invoice_intent_id") or "")
        if milestone_intent and not _same_bound(milestones[0], binding):
            _conflict("intent or provider invoice is already bound to different immutable facts")
        if not milestone_intent and (
            str(milestones[0].get("realm_id") or "") != binding["realm_id"]
            or str(milestones[0].get("qb_entity_id") or "")
            != binding["provider_invoice_id"]
            or milestones[0].get("qb_entity_type") != "Invoice"
            or milestones[0].get("status") not in {"Webhook Seen", "Needs Review"}
        ):
            _conflict("unbound webhook milestone does not equal the provider identity")
    if reconciliations:
        reconciliation_intent = str(
            reconciliations[0].get("invoice_intent_id") or ""
        )
        if reconciliation_intent:
            if not _same_bound(reconciliations[0], binding):
                _conflict(
                    "reconciliation is already bound to different immutable facts"
                )
        elif not (
            str(reconciliations[0].get("system_name") or "").casefold()
            == "quickbooks"
            and reconciliations[0].get("entity_type") == "Invoice"
            and str(reconciliations[0].get("realm_id") or "")
            == binding["realm_id"]
            and str(reconciliations[0].get("external_entity_id") or "")
            == binding["provider_invoice_id"]
            and reconciliations[0].get("status") in {"Pending", "Mismatch"}
        ):
            _conflict(
                "unbound webhook reconciliation does not equal the provider identity"
            )

    synthetic_milestone_id = (
        f"qb:{binding['realm_id']}:Invoice:{binding['provider_invoice_id']}"
    )
    milestone_id = (
        str(milestones[0]["name"]) if milestones else synthetic_milestone_id
    )
    reconciliation_id = (
        str(reconciliations[0]["name"])
        if reconciliations
        else f"qfi:{binding['basis_sha256']}"
    )
    if reconciliations:
        local_doctype = str(reconciliations[0].get("local_doctype") or "")
        local_name = str(reconciliations[0].get("local_name") or "")
        if local_doctype not in {"", "Payment Milestone"} or local_name not in {
            "",
            milestone_id,
        }:
            _conflict("reconciliation local linkage differs from the provider milestone")
        if reconciliations[0].get("invoice_intent_id") and (
            local_doctype != "Payment Milestone" or local_name != milestone_id
        ):
            _conflict("bound reconciliation local linkage is incomplete or inconsistent")

    job = frappe.get_doc("Roof Job", candidate["roof_job_id"])
    existing_realm = str(job.get("qb_realm_id") or "")
    existing_invoice = str(job.get("qb_invoice_ref") or "")
    if existing_realm and existing_realm != binding["realm_id"]:
        _conflict("Roof Job is already attributed to a different QuickBooks realm")
    if existing_invoice and existing_invoice != binding["provider_invoice_id"]:
        _conflict("Roof Job is already bound to another provider invoice")
    already_bound = bool(
        (milestones and milestones[0].get("invoice_intent_id"))
        or (reconciliations and reconciliations[0].get("invoice_intent_id"))
    )
    if already_bound and (
        existing_realm != binding["realm_id"]
        or existing_invoice != binding["provider_invoice_id"]
    ):
        _conflict("bound provider identity is not linked to the exact Roof Job")

    exact_replay = bool(
        milestones
        and reconciliations
        and _same_bound(reconciliations[0], binding)
        and reconciliations[0].get("local_name") == milestone_id
        and str(candidate.get("_basis_json")) == str(milestones[0].get("billing_basis_json") or "")
    )
    if exact_replay:
        return {
            "ok": True,
            "idempotent_replay": True,
            "roof_job_id": binding["roof_job_id"],
            "shop_order_id": binding["shop_order_id"],
            "provider_invoice_id": binding["provider_invoice_id"],
            "payment_milestone_id": milestone_id,
            "reconciliation_id": reconciliation_id,
            "basis_sha256": binding["basis_sha256"],
        }

    commercial = candidate["commercial"]
    if milestones:
        milestone = frappe.get_doc("Payment Milestone", milestones[0]["name"])
        if milestone.get("status") not in {"Webhook Seen", "Needs Review"}:
            _conflict("existing provider milestone is not bindable")
        if milestone.get("status") == "Webhook Seen":
            milestone.status = "Needs Review"
    else:
        milestone = frappe.get_doc(
            {
                "doctype": "Payment Milestone",
                "payment_milestone_id": milestone_id,
                "roof_job": candidate["roof_job_id"],
                "shop_order": candidate["shop_order_id"],
                "milestone_type": "Invoice",
                "milestone_version": 1,
                "status": "Needs Review",
                "currency": commercial["currency"],
                "subtotal": commercial["subtotal"],
                "tax_amount": commercial["tax_amount"],
                "total_amount": commercial["total_amount"],
                "amount_due": commercial["final_balance"],
                "amount_paid": "0.00",
                "balance_due": commercial["final_balance"],
                "due_date": commercial["due_date"],
                "price_book_version": candidate["basis"]["quote_version"],
                "tax_code": commercial["tax_code"],
                "tax_rate": commercial["tax_rate"],
                "tax_policy_snapshot_json": _canonical_json(
                    {"basis_sha256": binding["basis_sha256"], "source": "accepted_commercial_snapshot"}
                ),
                "qb_entity_type": "Invoice",
                "qb_entity_id": binding["provider_invoice_id"],
                "qb_operation": "Create",
                "realm_id": binding["realm_id"],
                "event_ts": binding["provider_created_at"],
                "notes": FINAL_INVOICE_NOTES,
            }
        )
    for field, value in {
        "roof_job": candidate["roof_job_id"],
        "shop_order": candidate["shop_order_id"],
        "currency": commercial["currency"],
        "subtotal": commercial["subtotal"],
        "tax_amount": commercial["tax_amount"],
        "total_amount": commercial["total_amount"],
        "amount_due": commercial["final_balance"],
        "amount_paid": "0.00",
        "balance_due": commercial["final_balance"],
        "due_date": commercial["due_date"],
        "price_book_version": candidate["basis"]["quote_version"],
        "tax_code": commercial["tax_code"],
        "tax_rate": commercial["tax_rate"],
        "tax_policy_snapshot_json": _canonical_json(
            {"basis_sha256": binding["basis_sha256"], "source": "accepted_commercial_snapshot"}
        ),
        "invoice_intent_id": binding["intent_id"],
        "billing_basis_sha256": binding["basis_sha256"],
        "billing_basis_json": candidate["_basis_json"],
        "provider_request_sha256": binding["provider_request_sha256"],
        "provider_create_response_sha256": binding["provider_create_response_sha256"],
        "provider_created_at": binding["provider_created_at"],
    }.items():
        setattr(milestone, field, value)
    _save(milestone, quickbooks_final_invoice_bind_context, insert=not bool(milestones))

    local_hash = _sha256({"basis_sha256": binding["basis_sha256"], "state": "Pending"})
    if local_hash == binding["provider_create_response_sha256"]:
        local_hash = _sha256({"basis_sha256": binding["basis_sha256"], "state": "Needs Review"})
    if reconciliations:
        reconciliation = frappe.get_doc("Integration Reconciliation", reconciliations[0]["name"])
        reconciliation.roof_job = candidate["roof_job_id"]
        reconciliation.realm_id = binding["realm_id"]
        reconciliation.local_doctype = "Payment Milestone"
        reconciliation.local_name = milestone.name
        reconciliation.status = "Pending"
    else:
        reconciliation = frappe.get_doc(
            {
                "doctype": "Integration Reconciliation",
                "reconciliation_id": reconciliation_id,
                "roof_job": candidate["roof_job_id"],
                "system_name": "QuickBooks",
                "entity_type": "Invoice",
                "external_entity_id": binding["provider_invoice_id"],
                "realm_id": binding["realm_id"],
                "local_doctype": "Payment Milestone",
                "local_name": milestone.name,
                "direction": "Inbound",
                "status": "Pending",
                "detected_at": binding["provider_created_at"],
                "source_version": "Create",
                "source_payload_hash": binding["provider_create_response_sha256"],
                "local_payload_hash": local_hash,
                "attempt_count": 0,
                "notes": FINAL_INVOICE_NOTES,
            }
        )
    for field, value in {
        "invoice_intent_id": binding["intent_id"],
        "billing_basis_sha256": binding["basis_sha256"],
        "provider_request_sha256": binding["provider_request_sha256"],
        "provider_create_response_sha256": binding["provider_create_response_sha256"],
        "provider_created_at": binding["provider_created_at"],
    }.items():
        setattr(reconciliation, field, value)
    if reconciliations:
        _save(reconciliation, quickbooks_final_invoice_bind_context)
    else:
        with quickbooks_reconciliation_issuance_context(reconciliation):
            _save(reconciliation, quickbooks_final_invoice_bind_context, insert=True)

    job.qb_realm_id = binding["realm_id"]
    job.qb_invoice_ref = binding["provider_invoice_id"]
    _save(job, quickbooks_final_invoice_bind_context)
    return {
        "ok": True,
        "idempotent_replay": False,
        "roof_job_id": binding["roof_job_id"],
        "shop_order_id": binding["shop_order_id"],
        "provider_invoice_id": binding["provider_invoice_id"],
        "payment_milestone_id": milestone.name,
        "reconciliation_id": reconciliation.name,
        "basis_sha256": binding["basis_sha256"],
    }


def _readback(payload: Mapping[str, Any]) -> dict[str, Any]:
    binding = _validate_binding(payload)
    try:
        result = {
            **binding,
            "customer_id": _qbo_id(payload["customer_id"], "customer_id"),
            "item_id": _qbo_id(payload["item_id"], "item_id"),
            "tax_code_id": _qbo_id(payload["tax_code_id"], "tax_code_id"),
            "terms_id": _qbo_id(payload["terms_id"], "terms_id"),
            "currency": _text(payload["currency"], "currency", maximum=3),
            "subtotal": _money(payload["subtotal"], "subtotal"),
            "tax_amount": _money(payload["tax_amount"], "tax_amount"),
            "total_amount": _money(payload["total_amount"], "total_amount"),
            "balance_due": _money(payload["balance_due"], "balance_due"),
            "lines_sha256": _hash(payload["lines_sha256"], "lines_sha256"),
            "tax_rate": _rate(payload["tax_rate"], "tax_rate"),
            "invoice_date": _date(payload["invoice_date"], "invoice_date"),
            "due_date": _date(payload["due_date"], "due_date"),
            "payment_status": _text(
                payload["payment_status"], "payment_status", maximum=32
            ),
            "provider_readback_sha256": _hash(
                payload["provider_readback_sha256"], "provider_readback_sha256"
            ),
            "provider_read_at": _timestamp(
                payload["provider_read_at"], "provider_read_at"
            ),
        }
    except CandidateBlocked as blocked:
        _fail("quickbooks_final_invoice_invalid_input", blocked.message)
    if result["payment_status"] not in PAYMENT_STATUSES:
        _fail("quickbooks_final_invoice_invalid_input", "payment_status is not bounded provider truth")
    return result


def _resolver_response(
    outcome: str,
    milestone: Mapping[str, Any],
    reconciliation: Mapping[str, Any],
    *,
    replay: bool,
    reason: str | None,
) -> dict[str, Any]:
    return {
        "ok": True,
        "idempotent_replay": replay,
        "outcome": outcome,
        "payment_milestone_id": str(milestone.get("name") or milestone.get("payment_milestone_id")),
        "reconciliation_id": str(reconciliation.get("name") or reconciliation.get("reconciliation_id")),
        "reason_code": reason,
        "owner": None if outcome == "Matched" else RESOLVER_OWNER,
        "next_step": None if outcome == "Matched" else "reconcile_provider_invoice",
    }


@frappe.whitelist()
def resolve_provider_invoice_readback(readback_json: str) -> dict[str, Any]:
    """Reconcile only an exact, later, authenticated provider GET observation."""

    _assert_issuer(mutation=True)
    readback = _readback(
        _parse_json_argument(
            readback_json,
            "readback_json",
            BIND_FIELDS | READBACK_ONLY_FIELDS,
            required=BIND_FIELDS | READBACK_ONLY_FIELDS,
        )
    )
    milestones, reconciliations = _locked_bind_rows(readback)
    if len(milestones) != 1 or len(reconciliations) != 1:
        _conflict("provider invoice is not bound to one exact Frappe milestone and reconciliation")
    milestone_row = milestones[0]
    reconciliation_row = reconciliations[0]
    if not _same_bound(milestone_row, readback) or not _same_bound(reconciliation_row, readback):
        _conflict("provider invoice binding differs from the requested immutable basis")
    if _timestamp_value(readback["provider_read_at"], "provider_read_at") <= _timestamp_value(
        milestone_row.get("provider_created_at"), "provider_created_at"
    ):
        _fail("quickbooks_final_invoice_readback_not_later", "provider GET must be later than CREATE")

    facts = {field: readback[field] for field in sorted(READBACK_ONLY_FIELDS)}
    facts_sha256 = _sha256(facts)
    prior_read_hash = str(milestone_row.get("provider_readback_sha256") or "")
    if prior_read_hash:
        if (
            prior_read_hash != readback["provider_readback_sha256"]
            or str(milestone_row.get("provider_facts_sha256") or "") != facts_sha256
            or str(milestone_row.get("provider_read_at") or "") != readback["provider_read_at"]
        ):
            _conflict("a changed duplicate provider readback is forbidden")
        outcome = "Matched" if milestone_row.get("status") == "Matched" and reconciliation_row.get("status") == "Matched" else str(reconciliation_row.get("status") or "Pending")
        if outcome not in {"Matched", "Mismatch", "Pending"}:
            outcome = "Pending"
        reason = None if outcome == "Matched" else "provider_readback_drift"
        return _resolver_response(outcome, milestone_row, reconciliation_row, replay=True, reason=reason)

    try:
        candidate = _build_candidate(
            _load_bundle(readback["roof_job_id"], lock=True),
            realm_id=readback["realm_id"],
            allow_bound_intent=readback["intent_id"],
        )
        current_blocker: CandidateBlocked | None = (
            None
            if _basis_matches(candidate, readback)
            else CandidateBlocked(
                "stale_frappe_basis",
                "current Frappe versions or hashes differ from the bound basis",
            )
        )
    except CandidateBlocked as blocked:
        candidate = None
        current_blocker = blocked

    mismatch_fields: list[str] = []
    if candidate is not None:
        commercial = candidate["commercial"]
        expected = {
            "customer_id": candidate["qbo"]["customer_id"],
            "item_id": candidate["qbo"]["item_id"],
            "tax_code_id": candidate["qbo"]["tax_code_id"],
            "terms_id": candidate["qbo"]["terms_id"],
            "currency": commercial["currency"],
            "subtotal": commercial["subtotal"],
            "tax_amount": commercial["tax_amount"],
            "total_amount": commercial["total_amount"],
            "lines_sha256": candidate["_lines_sha256"],
            "tax_rate": commercial["tax_rate"],
            "invoice_date": commercial["invoice_date"],
            "due_date": commercial["due_date"],
        }
        mismatch_fields = [field for field, value in expected.items() if readback[field] != value]
        total = Decimal(readback["total_amount"])
        balance = Decimal(readback["balance_due"])
        status = readback["payment_status"]
        consistent = (
            (status == "Paid" and balance == 0)
            or (status == "Partially Paid" and Decimal("0") < balance < total)
            or (status in {"Unverified", "Not Due", "Due", "Overdue"} and balance == total)
        )
        if status not in MATCHABLE_PAYMENT_STATUSES or not consistent:
            mismatch_fields.append("payment_status_balance")
    outcome = "Pending" if current_blocker is not None else ("Mismatch" if mismatch_fields else "Matched")
    reason = (
        current_blocker.code
        if current_blocker is not None
        else ("provider_readback_drift" if mismatch_fields else None)
    )

    milestone = frappe.get_doc("Payment Milestone", milestone_row["name"])
    reconciliation = frappe.get_doc("Integration Reconciliation", reconciliation_row["name"])
    for document in (milestone, reconciliation):
        document.provider_readback_sha256 = readback["provider_readback_sha256"]
        document.provider_facts_sha256 = facts_sha256
        document.provider_read_at = readback["provider_read_at"]
    reconciliation.last_attempt_at = readback["provider_read_at"]
    reconciliation.attempt_count = int(reconciliation.get("attempt_count") or 0) + 1
    reconciliation.source_payload_hash = readback["provider_readback_sha256"]
    reconciliation.local_payload_hash = (
        readback["provider_readback_sha256"]
        if outcome == "Matched"
        else _sha256({"basis_sha256": readback["basis_sha256"], "fields": mismatch_fields, "reason": reason})
    )
    reconciliation.source_amount = readback["total_amount"]
    reconciliation.local_amount = candidate["commercial"]["total_amount"] if candidate is not None else milestone.get("total_amount")
    reconciliation.currency = readback["currency"]
    if outcome == "Matched":
        milestone.status = "Matched"
        milestone.currency = readback["currency"]
        milestone.subtotal = readback["subtotal"]
        milestone.tax_amount = readback["tax_amount"]
        milestone.total_amount = readback["total_amount"]
        milestone.amount_due = readback["total_amount"]
        milestone.balance_due = readback["balance_due"]
        milestone.amount_paid = f"{Decimal(readback['total_amount']) - Decimal(readback['balance_due']):.2f}"
        milestone.payment_status = readback["payment_status"]
        milestone.truth_source = "QuickBooks"
        milestone.truth_at = readback["provider_read_at"]
        reconciliation.status = "Matched"
        reconciliation.diff_json = None
        reconciliation.notes = "Exact authenticated QuickBooks GET readback matched the immutable Frappe basis."
    else:
        reconciliation.status = outcome
        reconciliation.diff_json = _canonical_json(
            {
                "basis_sha256": readback["basis_sha256"],
                "fields": sorted(set(mismatch_fields)),
                "provider_facts_sha256": facts_sha256,
                "provider_readback_sha256": readback["provider_readback_sha256"],
                "reason_code": reason,
            }
        )
        reconciliation.notes = "Provider readback requires bounded finance reconciliation."
    _save(milestone, quickbooks_final_invoice_resolver_context)
    _save(reconciliation, quickbooks_final_invoice_resolver_context)
    return _resolver_response(outcome, milestone, reconciliation, replay=False, reason=reason)
