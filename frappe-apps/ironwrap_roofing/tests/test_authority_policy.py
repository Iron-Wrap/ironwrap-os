from __future__ import annotations

import json
import unittest

from ironwrap_roofing.authority_policy import (
    AuthorityPolicyViolation,
    authority_state_digest,
    authority_identity,
    require_issuer_readback,
    require_authority_gate,
    resolve_authority_record,
    resolve_current_authority,
    validate_authority_record,
)


def authority(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": "auth:worker:1",
        "authority_record_id": "auth:worker:1",
        "tenant": "tenant:ironwrap",
        "subject_type": "Person",
        "subject_role": "Worker",
        "person_user": "user:worker-1",
        "organization": "",
        "authority_kind": "Worker Competency",
        "authority_scope": "roofing-installation",
        "scope_type": "Field",
        "scope_ref": "field:job-1",
        "roof_job": "job:1",
        "scope_json": json.dumps({"tasks": ["install"]}),
        "issuer_name": "IronWrap competency register",
        "issuer_jurisdiction": "Alberta",
        "issuer_reference": "competency:worker-1:2026",
        "source_version": "readback:2026-08-17T10:00:00Z",
        "evidence_refs_json": json.dumps(
            [{"ref": "r2://authority/worker-1", "sha256": "a" * 64}]
        ),
        "evidence_sha256": "b" * 64,
        "effective_from": "2026-01-01",
        "expires_at": "2026-12-31",
        "status": "Verified",
        "version": 1,
        "verification_method": "Internal Competency Assessment",
        "verified_at": "2026-08-17 10:00:00",
        "verification_reference": "wcb-readback:worker-1",
        "verified_by": "owner@example.invalid",
        "revoked_at": "",
        "revocation_reference": "",
        "revoked_by": "",
        "supersedes": "",
        "correction_reason": "",
        "exception_status": "None",
        "exception_reason": "",
        "state_digest_sha256": "c" * 64,
    }
    record.update(overrides)
    record["state_digest_sha256"] = authority_state_digest(record)
    return record


class AuthorityPolicyTests(unittest.TestCase):
    def test_person_worker_and_organization_subcontractor_are_exact_subjects(self) -> None:
        validate_authority_record(authority())
        validate_authority_record(
            authority(
                name="auth:subcontractor:wcb:1",
                authority_record_id="auth:subcontractor:wcb:1",
                subject_type="Organization",
                subject_role="Subcontractor",
                person_user="",
                organization="supplier:roof-co",
                authority_kind="WCB Clearance",
                authority_scope="subcontractor-work",
                scope_type="Roof Job",
                scope_ref="job:1",
                verification_method="Issuer Portal Readback",
            )
        )

    def test_external_authority_kinds_keep_issuer_jurisdiction_and_evidence(self) -> None:
        for kind in (
            "Trade Licence",
            "WCB Clearance",
            "Insurance Certificate",
            "Permit",
            "Inspection",
            "Manufacturer Certification",
            "Manufacturer Bulletin",
        ):
            with self.subTest(kind=kind):
                validate_authority_record(
                    authority(
                        authority_kind=kind,
                        authority_record_id=f"auth:{kind.lower().replace(' ', '-')}:1",
                        name=f"auth:{kind.lower().replace(' ', '-')}:1",
                        verification_method="Issuer Portal Readback",
                    )
                )

    def test_external_authority_cannot_be_verified_by_internal_attestation(self) -> None:
        with self.assertRaisesRegex(AuthorityPolicyViolation, "external_authority_requires_issuer"):
            validate_authority_record(authority(authority_kind="WCB Clearance"))

    def test_direct_record_reference_is_tenant_bound_and_current(self) -> None:
        snapshot = resolve_authority_record(
            [authority()],
            tenant="tenant:ironwrap",
            authority_record_id="auth:worker:1",
            reference_date="2026-08-17",
        )
        self.assertEqual(snapshot["authority_record_id"], "auth:worker:1")
        with self.assertRaisesRegex(AuthorityPolicyViolation, "missing_current_authority"):
            resolve_authority_record(
                [authority()],
                tenant="tenant:other",
                authority_record_id="auth:worker:1",
                reference_date="2026-08-17",
            )

    def test_direct_current_v2_reference_validates_its_superseded_predecessor(self) -> None:
        prior = authority()
        renewed = authority(
            name="auth:worker:2",
            authority_record_id="auth:worker:2",
            version=2,
            supersedes="auth:worker:1",
            source_version="readback:2026-12-01T10:00:00Z",
            verified_at="2026-12-01 10:00:00",
            expires_at="2027-12-31",
        )
        resolved = resolve_authority_record(
            [prior, renewed],
            tenant="tenant:ironwrap",
            authority_record_id="auth:worker:2",
            reference_date="2026-12-15",
        )
        self.assertEqual(resolved["authority_record_id"], "auth:worker:2")
        self.assertEqual(resolved["version"], 2)

    def test_issuer_readback_must_match_record_identity_and_verified_state(self) -> None:
        record = authority(
            authority_kind="WCB Clearance",
            verification_method="Issuer Portal Readback",
        )
        readback = {
            "tenant": record["tenant"],
            "authority_record_id": record["authority_record_id"],
            "authority_version": record["version"],
            "issuer_name": record["issuer_name"],
            "issuer_jurisdiction": record["issuer_jurisdiction"],
            "issuer_reference": record["issuer_reference"],
            "issuer_source_version": record["source_version"],
            "evidence_refs_json": record["evidence_refs_json"],
            "evidence_sha256": record["evidence_sha256"],
            "state_digest_sha256": authority_state_digest(record),
            "verification_state": "verified",
        }
        require_issuer_readback(record, readback)
        with self.assertRaisesRegex(AuthorityPolicyViolation, "issuer_readback_mismatch"):
            require_issuer_readback(record, {**readback, "issuer_jurisdiction": "forged"})
        with self.assertRaisesRegex(AuthorityPolicyViolation, "issuer_readback_mismatch"):
            require_issuer_readback(
                record,
                {
                    **readback,
                    "evidence_refs_json": json.dumps(
                        [{"ref": "r2://authority/forged", "sha256": "a" * 64}]
                    ),
                },
            )

    def test_expiry_is_inclusive_at_boundary_and_blocks_after(self) -> None:
        record = authority()
        resolved = resolve_current_authority(
            [record],
            tenant="tenant:ironwrap",
            subject_type="Person",
            subject_ref="user:worker-1",
            authority_kind="Worker Competency",
            scope_type="Field",
            scope_ref="field:job-1",
            reference_date="2026-12-31",
        )
        self.assertEqual(resolved["authority_record_id"], "auth:worker:1")
        with self.assertRaisesRegex(AuthorityPolicyViolation, "authority_expired"):
            resolve_current_authority(
                [record],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2027-01-01",
            )

    def test_renewal_supersession_replaces_exact_current_version(self) -> None:
        prior = authority()
        renewed = authority(
            name="auth:worker:2",
            authority_record_id="auth:worker:2",
            version=2,
            supersedes="auth:worker:1",
            source_version="readback:2026-12-01T10:00:00Z",
            verified_at="2026-12-01 10:00:00",
            expires_at="2027-12-31",
        )
        validate_authority_record(
            renewed,
            context={"superseded_record": prior, "existing_records": [prior]},
        )
        self.assertEqual(
            resolve_current_authority(
                [prior, renewed],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2027-01-01",
            )["version"],
            2,
        )

    def test_revocation_race_default_deny(self) -> None:
        first = authority()
        second = authority(
            name="auth:worker:racing",
            authority_record_id="auth:worker:racing",
            issuer_reference="competency:worker-1:racing",
        )
        with self.assertRaisesRegex(AuthorityPolicyViolation, "ambiguous_current_authority"):
            resolve_current_authority(
                [first, second],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )

    def test_revocation_and_contradiction_versions_default_deny(self) -> None:
        prior = authority()
        revoked = authority(
            name="auth:worker:revoked",
            authority_record_id="auth:worker:revoked",
            version=2,
            supersedes="auth:worker:1",
            status="Revoked",
            verified_at="",
            verification_reference="",
            verified_by="",
            revoked_at="2026-08-17 11:00:00",
            revocation_reference="issuer:revocation:1",
            revoked_by="owner@example.invalid",
        )
        validate_authority_record(
            revoked,
            context={"superseded_record": prior, "existing_records": [prior]},
        )
        with self.assertRaisesRegex(AuthorityPolicyViolation, "authority_blocked"):
            resolve_current_authority(
                [prior, revoked],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )

        contradictory = authority(
            name="auth:worker:contradictory",
            authority_record_id="auth:worker:contradictory",
            version=2,
            supersedes="auth:worker:1",
            status="Contradictory",
            verified_at="",
            verification_reference="",
            verified_by="",
            exception_status="Open",
            exception_reason="issuer supplied conflicting source versions",
            correction_reason="issuer supplied conflicting source versions",
        )
        validate_authority_record(
            contradictory,
            context={"superseded_record": prior, "existing_records": [prior]},
        )
        with self.assertRaisesRegex(AuthorityPolicyViolation, "authority_blocked"):
            resolve_current_authority(
                [prior, contradictory],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )

    def test_forged_verified_snapshot_is_rejected_at_resolution(self) -> None:
        record = authority()
        record["issuer_name"] = "forged issuer"
        with self.assertRaisesRegex(AuthorityPolicyViolation, "state_digest_mismatch"):
            resolve_current_authority(
                [record],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )

    def test_wrong_tenant_and_missing_or_expired_authority_are_denied(self) -> None:
        with self.assertRaisesRegex(AuthorityPolicyViolation, "missing_current_authority"):
            resolve_current_authority(
                [authority()],
                tenant="tenant:other",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )
        with self.assertRaisesRegex(AuthorityPolicyViolation, "missing_current_authority"):
            resolve_current_authority(
                [],
                tenant="tenant:ironwrap",
                subject_type="Person",
                subject_ref="user:worker-1",
                authority_kind="Worker Competency",
                scope_type="Field",
                scope_ref="field:job-1",
                reference_date="2026-08-17",
            )

    def test_shop_and_field_work_package_requirements_return_exact_snapshots(self) -> None:
        shop = authority(
            authority_record_id="auth:shop:1",
            name="auth:shop:1",
            authority_kind="Manufacturer Certification",
            authority_scope="roll-former-setup",
            scope_type="Shop",
            scope_ref="shop:edmonton",
            verification_method="Manufacturer Portal Readback",
        )
        field = authority(
            authority_record_id="auth:field:1",
            name="auth:field:1",
            authority_kind="Trade Licence",
            authority_scope="sheet-metal-installation",
            scope_type="Work Package",
            scope_ref="wp:job-1:v1",
            verification_method="Issuer Portal Readback",
        )
        snapshots = require_authority_gate(
            [shop, field],
            [
                {
                    "subject_type": "Person",
                    "subject_ref": "user:worker-1",
                    "authority_kind": "Manufacturer Certification",
                    "scope_type": "Shop",
                    "scope_ref": "shop:edmonton",
                },
                {
                    "subject_type": "Person",
                    "subject_ref": "user:worker-1",
                    "authority_kind": "Trade Licence",
                    "scope_type": "Work Package",
                    "scope_ref": "wp:job-1:v1",
                },
            ],
            tenant="tenant:ironwrap",
            reference_date="2026-08-17",
        )
        self.assertEqual([row["version"] for row in snapshots], [1, 1])
        self.assertEqual(authority_identity(field)["state_digest_sha256"], authority_state_digest(field))

    def test_requirement_can_pin_issuer_jurisdiction_version_and_digest(self) -> None:
        record = authority(issuer_jurisdiction="Alberta")
        requirement = {
            "subject_type": "Person",
            "subject_role": "Worker",
            "subject_ref": "user:worker-1",
            "authority_kind": "Worker Competency",
            "scope_type": "Field",
            "scope_ref": "field:job-1",
            "issuer_jurisdiction": "Alberta",
            "version": 1,
            "state_digest_sha256": record["state_digest_sha256"],
        }
        snapshots = require_authority_gate(
            [record],
            [requirement],
            tenant="tenant:ironwrap",
            reference_date="2026-08-17",
        )
        self.assertEqual(snapshots[0]["issuer_jurisdiction"], "Alberta")
        with self.assertRaisesRegex(AuthorityPolicyViolation, "authority_requirement_mismatch"):
            require_authority_gate(
                [record],
                [{**requirement, "issuer_jurisdiction": "British Columbia"}],
                tenant="tenant:ironwrap",
                reference_date="2026-08-17",
            )

        with self.assertRaisesRegex(AuthorityPolicyViolation, "authority_requirement_mismatch"):
            require_authority_gate(
                [record],
                [{**requirement, "authority_record_id": "auth:worker:1", "subject_ref": "user:other"}],
                tenant="tenant:ironwrap",
                reference_date="2026-08-17",
            )


if __name__ == "__main__":
    unittest.main()
