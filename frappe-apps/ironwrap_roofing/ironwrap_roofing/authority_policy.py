"""Pure, tenant-bound policy for individual and external authority records.

The existing Crew Profile and Job Compliance Record summaries remain valid
projections during migration.  This module is the stricter source for new
release consumers: an authority is usable only when one exact current,
verified, in-scope version can be resolved.
"""

from __future__ import annotations

import json
import hashlib
import re
from datetime import datetime
from typing import Any, Mapping, Sequence


AUTHORITY_KINDS = frozenset(
    {
        "Worker Competency",
        "Trade Licence",
        "WCB Clearance",
        "Insurance Certificate",
        "Permit",
        "Inspection",
        "Manufacturer Certification",
        "Manufacturer Bulletin",
    }
)
AUTHORITY_SUBJECT_TYPES = frozenset({"Person", "Organization"})
AUTHORITY_SUBJECT_ROLES = frozenset({"Worker", "Subcontractor"})
AUTHORITY_SCOPE_TYPES = frozenset(
    {"Tenant", "Roof Job", "Assignment", "Work Package", "Shop", "Field", "Trade", "Manufacturer System"}
)
AUTHORITY_STATUSES = frozenset(
    {"Unverified", "Verified", "Contradictory", "Expired", "Revoked", "Superseded"}
)
AUTHORITY_VERIFICATION_STATUSES = frozenset({"Verified"})
AUTHORITY_VERIFICATION_METHODS = frozenset(
    {
        "Internal Competency Assessment",
        "Issuer Portal Readback",
        "Signed Issuer Record",
        "Regulator Readback",
        "Manufacturer Portal Readback",
    }
)
EXTERNAL_AUTHORITY_KINDS = frozenset(
    {
        "Trade Licence",
        "WCB Clearance",
        "Insurance Certificate",
        "Permit",
        "Inspection",
        "Manufacturer Certification",
        "Manufacturer Bulletin",
    }
)
EXTERNAL_VERIFICATION_METHODS = frozenset(
    {
        "Issuer Portal Readback",
        "Signed Issuer Record",
        "Regulator Readback",
        "Manufacturer Portal Readback",
    }
)
AUTHORITY_REQUIRED_FIELDS = (
    "authority_record_id",
    "tenant",
    "subject_type",
    "subject_role",
    "authority_kind",
    "authority_scope",
    "scope_type",
    "scope_ref",
    "issuer_name",
    "issuer_jurisdiction",
    "issuer_reference",
    "source_version",
    "evidence_refs_json",
    "evidence_sha256",
    "effective_from",
    "expires_at",
    "status",
    "version",
)
AUTHORITY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{2,159}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


class AuthorityPolicyViolation(ValueError):
    """A fail-closed authority validation or resolution failure."""

    def __init__(self, code: str, message: str, field: str | None = None):
        self.code = code
        self.field = field
        super().__init__(f"{code}: {message}" + (f" [{field}]" if field else ""))


def _get(record: Any, field: str, default: Any = None) -> Any:
    getter = getattr(record, "get", None)
    if callable(getter):
        return getter(field, default)
    return getattr(record, field, default)


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _require(record: Any, *fields: str) -> None:
    for field in fields:
        if _blank(_get(record, field)):
            raise AuthorityPolicyViolation("required_field", "is required", field)


def _date(record: Any, field: str) -> str:
    value = str(_get(record, field) or "").strip()
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise AuthorityPolicyViolation("invalid_date", "must be YYYY-MM-DD", field) from exc
    if parsed.strftime("%Y-%m-%d") != value:
        raise AuthorityPolicyViolation("invalid_date", "must be YYYY-MM-DD", field)
    return value


def _json_object(value: Any, field: str) -> Any:
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise AuthorityPolicyViolation("invalid_json", "must contain valid JSON", field) from exc
    if not isinstance(parsed, (dict, list)) or not parsed:
        raise AuthorityPolicyViolation("invalid_json", "must be a non-empty JSON object or list", field)
    return parsed


def _evidence_refs(value: Any) -> list[dict[str, str]]:
    parsed = _json_object(value, "evidence_refs_json")
    if not isinstance(parsed, list) or not parsed:
        raise AuthorityPolicyViolation(
            "invalid_evidence_refs", "must be a non-empty list of reference/hash pairs", "evidence_refs_json"
        )
    result: list[dict[str, str]] = []
    for index, row in enumerate(parsed):
        if not isinstance(row, Mapping):
            raise AuthorityPolicyViolation("invalid_evidence_ref", "must be an object", "evidence_refs_json")
        ref = row.get("ref")
        digest = row.get("sha256")
        if not isinstance(ref, str) or not 1 <= len(ref.strip()) <= 512:
            raise AuthorityPolicyViolation("invalid_evidence_ref", "ref must be bounded text", "evidence_refs_json")
        if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
            raise AuthorityPolicyViolation(
                "invalid_evidence_hash", f"entry {index} must carry a SHA-256 digest", "evidence_refs_json"
            )
        result.append({"ref": ref.strip(), "sha256": digest.lower()})
    return result


def _identity(record: Any) -> tuple[str, str, str, str, str, str]:
    return (
        str(_get(record, "tenant") or ""),
        str(_get(record, "subject_type") or ""),
        str(_get(record, "person_user") or _get(record, "organization") or ""),
        str(_get(record, "authority_kind") or ""),
        str(_get(record, "scope_type") or ""),
        str(_get(record, "scope_ref") or ""),
    )


def _record_refs(record: Any) -> set[str]:
    return {
        str(value)
        for value in (_get(record, "name"), _get(record, "authority_record_id"))
        if not _blank(value)
    }


def authority_state_digest(record: Any) -> str:
    """Hash the exact version and lifecycle facts gates must snapshot."""

    payload = {
        field: _get(record, field) or ""
        for field in (
            "authority_record_id",
            "tenant",
            "subject_type",
            "subject_role",
            "person_user",
            "organization",
            "authority_kind",
            "authority_scope",
            "scope_type",
            "scope_ref",
            "roof_job",
            "scope_json",
            "issuer_name",
            "issuer_jurisdiction",
            "issuer_reference",
            "source_version",
            "evidence_refs_json",
            "evidence_sha256",
            "effective_from",
            "expires_at",
            "version",
            "status",
            "verification_method",
            "verified_at",
            "verification_reference",
            "verified_by",
            "revoked_at",
            "revocation_reference",
            "revoked_by",
            "supersedes",
            "correction_reason",
            "exception_status",
            "exception_reason",
        )
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _current_records(records: Sequence[Any]) -> list[Any]:
    superseded = {
        str(_get(row, "supersedes"))
        for row in records
        if not _blank(_get(row, "supersedes"))
    }
    return [row for row in records if _record_refs(row).isdisjoint(superseded)]


def validate_authority_record(
    record: Any,
    *,
    previous: Any | None = None,
    context: Mapping[str, Any] | None = None,
) -> None:
    """Validate one append-only authority version.

    ``context`` may carry the verified ``superseded_record``, all
    ``existing_records``, the reference ``today``, and a narrow command name.
    No status is trusted merely because an agent supplied it.
    """

    for field in AUTHORITY_REQUIRED_FIELDS:
        _require(record, field)
    record_id = str(_get(record, "authority_record_id"))
    if not AUTHORITY_ID_PATTERN.fullmatch(record_id):
        raise AuthorityPolicyViolation("invalid_authority_record_id", "must be a bounded stable identifier", "authority_record_id")
    tenant = str(_get(record, "tenant"))
    if not AUTHORITY_ID_PATTERN.fullmatch(tenant):
        raise AuthorityPolicyViolation("invalid_tenant", "must be a bounded stable identifier", "tenant")
    subject_type = _get(record, "subject_type")
    subject_role = _get(record, "subject_role")
    if subject_type not in AUTHORITY_SUBJECT_TYPES:
        raise AuthorityPolicyViolation("invalid_subject_type", "must be Person or Organization", "subject_type")
    if subject_role not in AUTHORITY_SUBJECT_ROLES:
        raise AuthorityPolicyViolation("invalid_subject_role", "must be Worker or Subcontractor", "subject_role")
    if subject_type == "Person":
        _require(record, "person_user")
        if not _blank(_get(record, "organization")):
            raise AuthorityPolicyViolation("ambiguous_subject", "a Person cannot also name an organization", "organization")
    else:
        _require(record, "organization")
        if not _blank(_get(record, "person_user")):
            raise AuthorityPolicyViolation("ambiguous_subject", "an Organization cannot also name a person", "person_user")
    if subject_type == "Person" and subject_role == "Subcontractor":
        raise AuthorityPolicyViolation("invalid_subject_role", "a subcontractor authority must bind an Organization", "subject_role")
    if subject_type == "Organization" and subject_role == "Worker":
        raise AuthorityPolicyViolation("invalid_subject_role", "a worker authority must bind a Person", "subject_role")

    authority_kind = _get(record, "authority_kind")
    if authority_kind not in AUTHORITY_KINDS:
        raise AuthorityPolicyViolation("invalid_authority_kind", "unsupported authority kind", "authority_kind")
    scope_type = _get(record, "scope_type")
    if scope_type not in AUTHORITY_SCOPE_TYPES:
        raise AuthorityPolicyViolation("invalid_scope_type", "unsupported authority scope", "scope_type")
    _require(record, "authority_scope", "scope_ref")
    if scope_type in {"Roof Job", "Assignment", "Work Package"}:
        _require(record, "roof_job")
    scope = _json_object(_get(record, "scope_json"), "scope_json") if not _blank(_get(record, "scope_json")) else None
    if scope is not None and not isinstance(scope, dict):
        raise AuthorityPolicyViolation("invalid_scope_json", "must be a JSON object", "scope_json")
    _require(record, "issuer_name", "issuer_jurisdiction", "issuer_reference", "source_version")
    evidence = _evidence_refs(_get(record, "evidence_refs_json"))
    evidence_digest = str(_get(record, "evidence_sha256"))
    if not SHA256_PATTERN.fullmatch(evidence_digest):
        raise AuthorityPolicyViolation("invalid_evidence_hash", "must be a SHA-256 digest", "evidence_sha256")
    supplied_state_digest = _get(record, "state_digest_sha256")
    if supplied_state_digest:
        if not SHA256_PATTERN.fullmatch(str(supplied_state_digest)):
            raise AuthorityPolicyViolation("invalid_state_digest", "must be a SHA-256 digest", "state_digest_sha256")
        if str(supplied_state_digest).lower() != authority_state_digest(record):
            raise AuthorityPolicyViolation("state_digest_mismatch", "must hash the exact authority version and lifecycle state", "state_digest_sha256")
    effective = _date(record, "effective_from")
    expiry = _date(record, "expires_at")
    if effective > expiry:
        raise AuthorityPolicyViolation("invalid_authority_window", "effective date must not follow expiry", "effective_from")
    status = _get(record, "status")
    if status not in AUTHORITY_STATUSES:
        raise AuthorityPolicyViolation("invalid_authority_status", "unsupported lifecycle status", "status")
    try:
        version = int(_get(record, "version"))
    except (TypeError, ValueError) as exc:
        raise AuthorityPolicyViolation("invalid_authority_version", "must be a positive integer", "version") from exc
    if version < 1:
        raise AuthorityPolicyViolation("invalid_authority_version", "must be a positive integer", "version")

    if status == "Verified":
        _require(record, "verification_method", "verified_at", "verification_reference", "verified_by")
        verification_method = str(_get(record, "verification_method"))
        if verification_method not in AUTHORITY_VERIFICATION_METHODS:
            raise AuthorityPolicyViolation(
                "invalid_verification_method",
                "must identify a governed internal assessment or issuer readback method",
                "verification_method",
            )
        if authority_kind in EXTERNAL_AUTHORITY_KINDS and verification_method not in EXTERNAL_VERIFICATION_METHODS:
            raise AuthorityPolicyViolation(
                "external_authority_requires_issuer",
                "external, legal, and professional authority must be verified by a genuine issuer readback",
                "verification_method",
            )
    elif any(not _blank(_get(record, field)) for field in ("verified_at", "verification_reference", "verified_by")):
        raise AuthorityPolicyViolation("stale_verification", "verification facts require Verified status", "status")
    if status == "Revoked":
        _require(record, "revoked_at", "revocation_reference", "revoked_by", "supersedes")
    elif any(not _blank(_get(record, field)) for field in ("revoked_at", "revocation_reference", "revoked_by")):
        raise AuthorityPolicyViolation("stale_revocation", "revocation facts require Revoked status", "status")
    if status == "Superseded":
        _require(record, "supersedes", "correction_reason")
    if status == "Contradictory":
        _require(record, "exception_reason")
    if _get(record, "exception_status") == "Open":
        _require(record, "exception_reason")
    elif not _blank(_get(record, "exception_reason")) and _get(record, "exception_status") != "Open":
        raise AuthorityPolicyViolation("stale_exception", "an exception reason requires an Open exception", "exception_status")

    policy_context = dict(context or {})
    if (
        status in {"Verified", "Revoked", "Contradictory"}
        and authority_kind in EXTERNAL_AUTHORITY_KINDS
        and policy_context.get("require_issuer_readback")
    ):
        require_issuer_readback(record, policy_context.get("issuer_readback"))
    supersedes = _get(record, "supersedes")
    if supersedes:
        prior = policy_context.get("superseded_record")
        if prior is None:
            raise AuthorityPolicyViolation("unverified_supersession", "the superseded version could not be verified", "supersedes")
        if _identity(record) != _identity(prior):
            raise AuthorityPolicyViolation("cross_scope_supersession", "supersession must retain tenant, subject, kind, and scope", "supersedes")
        try:
            prior_version = int(_get(prior, "version"))
        except (TypeError, ValueError) as exc:
            raise AuthorityPolicyViolation("invalid_superseded_version", "the superseded version is invalid", "supersedes") from exc
        if version != prior_version + 1:
            raise AuthorityPolicyViolation("stale_authority_version", "a superseding record must increment version by one", "version")
    elif version != 1:
        raise AuthorityPolicyViolation("missing_supersession", "versions above one must name the superseded record", "supersedes")

    if previous is not None:
        for field in (
            "authority_record_id", "tenant", "subject_type", "subject_role", "person_user", "organization",
            "authority_kind", "authority_scope", "scope_type", "scope_ref", "roof_job", "issuer_name",
            "issuer_jurisdiction", "issuer_reference", "source_version", "evidence_refs_json", "evidence_sha256",
            "effective_from", "expires_at", "version", "supersedes",
        ):
            if _get(previous, field) != _get(record, field):
                raise AuthorityPolicyViolation("immutable_authority_field", "cannot change after insert", field)
        command = policy_context.get("command")
        if command not in {"verify", "revoke"} and _get(previous, "status") != _get(record, "status"):
            raise AuthorityPolicyViolation("unbounded_authority_transition", "use a governed command or superseding version", "status")

    existing = list(policy_context.get("existing_records") or ())
    if existing:
        candidate_identity = _identity(record)
        current = [row for row in _current_records(existing) if _identity(row) == candidate_identity]
        candidate_refs = _record_refs(record)
        current = [row for row in current if _record_refs(row).isdisjoint(candidate_refs)]
        if supersedes:
            current = [row for row in current if _record_refs(row).isdisjoint({str(supersedes)})]
        if status in {"Verified", "Revoked", "Contradictory", "Superseded"} and current:
            raise AuthorityPolicyViolation(
                "contradictory_current_authority",
                "one current authority version is required for an identity and scope",
                "status",
            )
    # Keep the local variable intentional: parsing all refs is part of validation,
    # even though the digest is supplied by the evidence issuer.
    _ = evidence


def _readback_value(readback: Any, field: str) -> Any:
    return _get(readback, field)


def require_issuer_readback(record: Any, readback: Any) -> None:
    """Bind an authority version to an immutable readback from its issuer.

    The readback is deliberately compared field-for-field.  A local actor may
    record or verify a readback, but cannot change its issuer, jurisdiction,
    source version, evidence digest, or authority version while doing so.
    """

    if readback is None:
        raise AuthorityPolicyViolation(
            "missing_issuer_readback",
            "an external authority requires a readback from its genuine issuer",
            "verification_reference",
        )
    expected = {
        "tenant": _get(record, "tenant"),
        "authority_record_id": _get(record, "authority_record_id") or _get(record, "name"),
        "authority_version": int(_get(record, "version") or 0),
        "issuer_name": _get(record, "issuer_name"),
        "issuer_jurisdiction": _get(record, "issuer_jurisdiction"),
        "issuer_reference": _get(record, "issuer_reference"),
        "source_version": _get(record, "source_version"),
        "evidence_sha256": str(_get(record, "evidence_sha256") or "").lower(),
    }
    try:
        expected_evidence_refs = _evidence_refs(_get(record, "evidence_refs_json"))
        observed_evidence_refs = _evidence_refs(_get(readback, "evidence_refs_json"))
    except AuthorityPolicyViolation as exc:
        raise AuthorityPolicyViolation(
            "issuer_readback_mismatch",
            "issuer readback evidence references are invalid or unavailable",
            "evidence_refs_json",
        ) from exc
    if observed_evidence_refs != expected_evidence_refs:
        raise AuthorityPolicyViolation(
            "issuer_readback_mismatch",
            "issuer readback does not match the exact evidence references",
            "evidence_refs_json",
        )
    expected_state_digest = str(
        _get(record, "state_digest_sha256") or authority_state_digest(record)
    ).lower()
    observed_state_digest = _readback_value(readback, "state_digest_sha256")
    if _blank(observed_state_digest):
        observed_state_digest = _readback_value(readback, "authority_state_digest_sha256")
    if str(observed_state_digest or "").lower() != expected_state_digest:
        raise AuthorityPolicyViolation(
            "issuer_readback_mismatch",
            "issuer readback does not match the exact authority state digest",
            "state_digest_sha256",
        )
    for field, value in expected.items():
        observed_field = field
        if field == "source_version":
            observed_field = "issuer_source_version"
        observed = _readback_value(readback, observed_field)
        if field == "evidence_sha256":
            observed = str(observed or "").lower()
        try:
            if field == "authority_version":
                observed = int(observed or 0)
        except (TypeError, ValueError) as exc:
            raise AuthorityPolicyViolation(
                "issuer_readback_mismatch",
                "issuer readback version is invalid",
                observed_field,
            ) from exc
        if observed != value:
            raise AuthorityPolicyViolation(
                "issuer_readback_mismatch",
                f"issuer readback does not match authority {field}",
                observed_field,
            )
    expected_state = {
        "Verified": "verified",
        "Revoked": "revoked",
        "Contradictory": "contradictory",
    }.get(str(_get(record, "status")), "verified")
    if str(_readback_value(readback, "verification_state") or "").lower() != expected_state:
        raise AuthorityPolicyViolation(
            "issuer_readback_unverified",
            "issuer readback state does not match the authority lifecycle state",
            "verification_state",
        )


def _requirement_rows(requirements: Any) -> list[Mapping[str, Any]]:
    parsed = requirements
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError as exc:
            raise AuthorityPolicyViolation(
                "invalid_authority_requirements",
                "must contain valid JSON",
                "authority_requirements_json",
            ) from exc
    if not isinstance(parsed, list) or not parsed:
        raise AuthorityPolicyViolation(
            "missing_authority_requirements",
            "at least one exact authority requirement is required",
            "authority_requirements_json",
        )
    required = ("subject_type", "subject_ref", "authority_kind", "scope_type", "scope_ref")
    optional = (
        "authority_record_id",
        "subject_role",
        "authority_scope",
        "issuer_name",
        "issuer_jurisdiction",
        "issuer_reference",
        "source_version",
        "version",
        "state_digest_sha256",
    )
    result: list[Mapping[str, Any]] = []
    for index, requirement in enumerate(parsed):
        if not isinstance(requirement, Mapping):
            raise AuthorityPolicyViolation(
                "invalid_authority_requirement",
                f"requirement {index} must be an object",
                "authority_requirements_json",
            )
        missing = [field for field in required if _blank(requirement.get(field))]
        if missing:
            raise AuthorityPolicyViolation(
                "invalid_authority_requirement",
                f"requirement {index} is missing {', '.join(missing)}",
                "authority_requirements_json",
            )
        if requirement["subject_type"] not in AUTHORITY_SUBJECT_TYPES:
            raise AuthorityPolicyViolation(
                "invalid_authority_requirement",
                f"requirement {index} has an unsupported subject type",
                "authority_requirements_json",
            )
        if requirement["authority_kind"] not in AUTHORITY_KINDS:
            raise AuthorityPolicyViolation(
                "invalid_authority_requirement",
                f"requirement {index} has an unsupported authority kind",
                "authority_requirements_json",
            )
        if requirement["scope_type"] not in AUTHORITY_SCOPE_TYPES:
            raise AuthorityPolicyViolation(
                "invalid_authority_requirement",
                f"requirement {index} has an unsupported scope type",
                "authority_requirements_json",
            )
        for field in optional:
            value = requirement.get(field)
            if value is None:
                continue
            if field == "version":
                try:
                    if int(value) < 1:
                        raise ValueError
                except (TypeError, ValueError) as exc:
                    raise AuthorityPolicyViolation(
                        "invalid_authority_requirement",
                        f"requirement {index} version must be a positive integer",
                        "authority_requirements_json",
                    ) from exc
                continue
            if not isinstance(value, str) or not value.strip():
                raise AuthorityPolicyViolation(
                    "invalid_authority_requirement",
                    f"requirement {index} {field} must be bounded text",
                    "authority_requirements_json",
                )
            if field == "subject_role" and value not in AUTHORITY_SUBJECT_ROLES:
                raise AuthorityPolicyViolation(
                    "invalid_authority_requirement",
                    f"requirement {index} has an unsupported subject role",
                    "authority_requirements_json",
                )
            if field == "state_digest_sha256" and not SHA256_PATTERN.fullmatch(value):
                raise AuthorityPolicyViolation(
                    "invalid_authority_requirement",
                    f"requirement {index} state digest must be a SHA-256 digest",
                    "authority_requirements_json",
                )
        result.append(requirement)
    return result


def validate_authority_requirements(requirements: Any) -> list[Mapping[str, Any]]:
    """Validate the exact identity/scope requirements embedded in a gate."""

    return _requirement_rows(requirements)


def authority_identity(record: Any) -> dict[str, Any]:
    """Return the exact version/state identity a release gate must snapshot."""

    return {
        "authority_record_id": str(_get(record, "authority_record_id") or _get(record, "name") or ""),
        "tenant": str(_get(record, "tenant") or ""),
        "subject_type": str(_get(record, "subject_type") or ""),
        "subject_role": str(_get(record, "subject_role") or ""),
        "subject_ref": str(_get(record, "person_user") or _get(record, "organization") or ""),
        "authority_kind": str(_get(record, "authority_kind") or ""),
        "authority_scope": str(_get(record, "authority_scope") or ""),
        "scope_type": str(_get(record, "scope_type") or ""),
        "scope_ref": str(_get(record, "scope_ref") or ""),
        "issuer_name": str(_get(record, "issuer_name") or ""),
        "issuer_jurisdiction": str(_get(record, "issuer_jurisdiction") or ""),
        "issuer_reference": str(_get(record, "issuer_reference") or ""),
        "version": int(_get(record, "version") or 0),
        "status": str(_get(record, "status") or ""),
        "source_version": str(_get(record, "source_version") or ""),
        "effective_from": str(_get(record, "effective_from") or ""),
        "expires_at": str(_get(record, "expires_at") or ""),
        "exception_status": str(_get(record, "exception_status") or ""),
        "evidence_refs_json": str(_get(record, "evidence_refs_json") or ""),
        "evidence_sha256": str(_get(record, "evidence_sha256") or "").lower(),
        "state_digest_sha256": str(_get(record, "state_digest_sha256") or authority_state_digest(record)).lower(),
    }


def resolve_current_authority(
    records: Sequence[Any],
    *,
    tenant: str,
    subject_type: str,
    subject_ref: str,
    authority_kind: str,
    scope_type: str,
    scope_ref: str,
    reference_date: str,
) -> dict[str, Any]:
    """Resolve exactly one usable authority or raise a default-deny error."""

    reference_date = reference_date.strip()
    try:
        datetime.strptime(reference_date, "%Y-%m-%d")
    except ValueError as exc:
        raise AuthorityPolicyViolation("invalid_reference_date", "must be YYYY-MM-DD") from exc
    matching = [
        row
        for row in _current_records(records)
        if _get(row, "tenant") == tenant
        and _get(row, "subject_type") == subject_type
        and (_get(row, "person_user") or _get(row, "organization")) == subject_ref
        and _get(row, "authority_kind") == authority_kind
        and _get(row, "scope_type") == scope_type
        and _get(row, "scope_ref") == scope_ref
    ]
    if not matching:
        raise AuthorityPolicyViolation("missing_current_authority", "no current authority matches the exact tenant, subject, kind, and scope")
    if len(matching) != 1:
        raise AuthorityPolicyViolation("ambiguous_current_authority", "exactly one current authority version is required")
    row = matching[0]
    if _get(row, "exception_status") == "Open" or _get(row, "status") in {"Revoked", "Contradictory", "Expired", "Superseded"}:
        raise AuthorityPolicyViolation("authority_blocked", "revoked, contradictory, expired, or superseded authority cannot release work", "status")
    if _get(row, "status") != "Verified":
        raise AuthorityPolicyViolation("authority_not_verified", "authority is not currently verified", "status")
    # A release consumer must not trust a row merely because it has a Verified
    # status.  Re-validate the complete immutable record (including issuer,
    # evidence, dates, and state digest) at the point of resolution so a
    # forged or partially-read snapshot fails closed.  A superseding version
    # is validated against the prior row from the same locked snapshot.
    prior = None
    supersedes = _get(row, "supersedes")
    if supersedes:
        prior = next(
            (
                candidate
                for candidate in records
                if str(supersedes) in _record_refs(candidate)
            ),
            None,
        )
    validate_authority_record(row, context={"superseded_record": prior})
    effective = str(_get(row, "effective_from") or "")[:10]
    expiry = str(_get(row, "expires_at") or "")[:10]
    if not effective or effective > reference_date:
        raise AuthorityPolicyViolation("authority_not_effective", "authority is not effective for the release date", "effective_from")
    if not expiry or expiry < reference_date:
        raise AuthorityPolicyViolation("authority_expired", "authority expires before the release date", "expires_at")
    return authority_identity(row)


def resolve_authority_record(
    records: Sequence[Any],
    *,
    tenant: str,
    authority_record_id: str,
    reference_date: str,
) -> dict[str, Any]:
    """Resolve one exact authority-record reference for a gate.

    A link to a record is not sufficient by itself: the record must still be
    the current version for the tenant and pass the same verified/effective
    checks as subject-based resolution.  This closes replay and cross-tenant
    link mistakes at consumers that store a direct record reference.
    """

    matching = [
        row
        for row in _current_records(records)
        if _get(row, "tenant") == tenant
        and authority_record_id in _record_refs(row)
    ]
    if not matching:
        raise AuthorityPolicyViolation(
            "missing_current_authority",
            "the authority record reference is not current for this tenant",
            "authority_record",
        )
    if len(matching) != 1:
        raise AuthorityPolicyViolation(
            "ambiguous_current_authority",
            "exactly one current authority record reference is required",
            "authority_record",
        )
    row = matching[0]
    return resolve_current_authority(
        # Keep the entire locked snapshot here.  A current v2 record must be
        # validated against the predecessor it supersedes; reducing the
        # snapshot to [row] makes a valid direct-id lookup fail closed with
        # unverified_supersession.
        records,
        tenant=tenant,
        subject_type=str(_get(row, "subject_type") or ""),
        subject_ref=str(_get(row, "person_user") or _get(row, "organization") or ""),
        authority_kind=str(_get(row, "authority_kind") or ""),
        scope_type=str(_get(row, "scope_type") or ""),
        scope_ref=str(_get(row, "scope_ref") or ""),
        reference_date=reference_date,
    )


def require_authority_gate(
    records: Sequence[Any],
    requirements: Sequence[Mapping[str, Any]],
    *,
    tenant: str,
    reference_date: str,
) -> list[dict[str, Any]]:
    """Resolve every requirement for a release gate; one failure blocks all."""

    validated = _requirement_rows(requirements)
    snapshots: list[dict[str, Any]] = []
    for requirement in validated:
        authority_record_id = requirement.get("authority_record_id")
        snapshot = (
            resolve_authority_record(
                records,
                tenant=tenant,
                authority_record_id=str(authority_record_id),
                reference_date=reference_date,
            )
            if authority_record_id
            else resolve_current_authority(
                records,
                tenant=tenant,
                subject_type=requirement["subject_type"],
                subject_ref=requirement["subject_ref"],
                authority_kind=requirement["authority_kind"],
                scope_type=requirement["scope_type"],
                scope_ref=requirement["scope_ref"],
                reference_date=reference_date,
            )
        )
        for requirement_field, snapshot_field in (
            ("subject_type", "subject_type"),
            ("subject_ref", "subject_ref"),
            ("authority_kind", "authority_kind"),
            ("scope_type", "scope_type"),
            ("scope_ref", "scope_ref"),
            ("subject_role", "subject_role"),
            ("authority_scope", "authority_scope"),
            ("issuer_name", "issuer_name"),
            ("issuer_jurisdiction", "issuer_jurisdiction"),
            ("issuer_reference", "issuer_reference"),
            ("source_version", "source_version"),
        ):
            expected = requirement.get(requirement_field)
            if expected and snapshot[snapshot_field] != expected:
                raise AuthorityPolicyViolation(
                    "authority_requirement_mismatch",
                    f"the resolved authority does not match {requirement_field}",
                    requirement_field,
                )
        if requirement.get("version") is not None:
            try:
                expected_version = int(requirement["version"])
            except (TypeError, ValueError) as exc:
                raise AuthorityPolicyViolation(
                    "invalid_authority_requirement",
                    "version must be a positive integer",
                    "authority_requirements_json",
                ) from exc
            if snapshot["version"] != expected_version:
                raise AuthorityPolicyViolation(
                    "authority_requirement_mismatch",
                    "the resolved authority does not match version",
                    "version",
                )
        if requirement.get("state_digest_sha256") and snapshot["state_digest_sha256"] != str(
            requirement["state_digest_sha256"]
        ).lower():
            raise AuthorityPolicyViolation(
                "authority_requirement_mismatch",
                "the resolved authority does not match state digest",
                "state_digest_sha256",
            )
        snapshots.append(snapshot)
    return snapshots
