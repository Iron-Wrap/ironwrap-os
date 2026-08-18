from __future__ import annotations

import frappe
from frappe.model.document import Document

from ironwrap_roofing.authority_policy import authority_state_digest
from ironwrap_roofing.document_validation import validate_business_document


AUTHORITY_CONTEXT_FIELDS = (
    "name",
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
    # The issuer receipt is immutable material readback, not part of the
    # authority state digest (including it would create a circular digest).
    "issuer_readback_json",
    "effective_from",
    "expires_at",
    "version",
    "status",
    "state_digest_sha256",
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
BUSINESS_AUTHORITY_ROLES = {"IronWrap Owner", "IronWrap Production"}


def _actor_is_business_authority() -> bool:
    actor = getattr(getattr(frappe, "session", None), "user", None)
    if not actor or actor == "Guest":
        return False
    return bool(BUSINESS_AUTHORITY_ROLES.intersection(set(frappe.get_roles(actor))))


class AuthorityRecord(Document):
    def validate(self) -> None:
        self.state_digest_sha256 = authority_state_digest(self.as_dict())
        status = self.get("status")
        if status in {"Verified", "Revoked", "Contradictory", "Superseded"} and not _actor_is_business_authority():
            frappe.throw(
                "Authority lifecycle changes require an IronWrap Owner or Production authority; System Manager alone is not business authority.",
                exc=frappe.PermissionError,
            )
        validate_business_document(self, "authority_record")
