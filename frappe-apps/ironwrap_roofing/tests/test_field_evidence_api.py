from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "field_evidence_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_insert", on_insert)
        object.__setattr__(self, "insert_count", 0)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def insert(self) -> None:
        self.insert_count += 1
        self["name"] = f"EVIDENCE-{self['evidence_id']}"
        self._on_insert(self)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabWork Package`" in normalized:
            return [
                dict(row)
                for row in self.fixtures.get("work_packages", [])
                if row.get("name") in values or row.get("work_package_id") in values
            ]
        if "`tabEvidence Item`" not in normalized:
            raise AssertionError(f"unexpected SQL: {normalized}")
        return [
            dict(row)
            for row in self.fixtures["evidence"]
            if row.get("evidence_id") == values[0]
        ]


class FieldEvidenceApiTests(unittest.TestCase):
    def payload(self) -> dict:
        return {
            "evidence_id": "evi_0123456789abcdef",
            "device_action_id": "fem_0123456789abcdef",
            "roof_job": "JOB-A",
            "evidence_type": "Photo",
            "proof_slot": "Production",
            "r2_key": "field/v1/scope/checkin/media/evidence.jpg",
            "content_checksum": "a" * 64,
            "checksum_algorithm": "SHA-256",
            "content_type": "image/jpeg",
            "content_length": 1024,
            "capture_actor": "crew@example.com",
            "captured_at": "2026-07-10 10:00:00",
            "customer_safe": 0,
            "summary": "Deck complete",
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "worker@ironwrapexteriors.com",
        request_method: str = "POST",
        can_create: bool = True,
        configured_issuer: str | None = "worker@ironwrapexteriors.com",
    ):
        fixtures = fixtures or {"evidence": [], "work_packages": []}
        db = FakeDb(fixtures)
        issuance_calls: list[dict] = []

        @contextmanager
        def field_evidence_issuance_context(document):
            issuance_calls.append(dict(document))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.field_evidence_issuance_context = (
            field_evidence_issuance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = (
            {"ironwrap_field_evidence_issuer_user": configured_issuer}
            if configured_issuer is not None
            else {}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-10 10:01:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_create
        frappe_module.whitelist = lambda: lambda function: function

        def on_insert(document: FakeDocument) -> None:
            fixtures["evidence"].append(dict(document))

        frappe_module.get_doc = lambda values: FakeDocument(dict(values), on_insert)

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_field_evidence_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                "frappe": frappe_module,
                "ironwrap_roofing.document_validation": validation_module,
            },
        ):
            spec.loader.exec_module(module)
        return module, fixtures, db, issuance_calls

    def call(self, api, payload: dict | None = None):
        return api.record_verified_field_evidence(
            evidence_json=json.dumps(payload or self.payload())
        )

    def test_issuer_derives_verification_facts_locks_identity_and_replays_exactly(
        self,
    ) -> None:
        api, fixtures, db, issuance_calls = self.load_api()

        first = self.call(api)

        self.assertEqual(
            first,
            {"name": "EVIDENCE-evi_0123456789abcdef", "idempotent_replay": False},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        issued = fixtures["evidence"][0]
        self.assertEqual(issued["proof_owner"], "crew@example.com")
        self.assertEqual(issued["source_system"], "ironwrap-pwa")
        self.assertEqual(issued["sync_state"], "Verified")
        self.assertEqual(issued["verified_at"], "2026-07-10 10:01:00")
        self.assertEqual(issued["verification_source"], "ironwrap-worker-r2-frappe")
        self.assertEqual(len(issuance_calls), 1)
        self.assertEqual(issuance_calls[0]["sync_state"], "Verified")
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))

        replay = self.call(api)
        self.assertEqual(
            replay,
            {"name": "EVIDENCE-evi_0123456789abcdef", "idempotent_replay": True},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(issuance_calls), 1)

    def test_issuer_rejects_wrong_principal_method_permission_and_unconfigured_site(
        self,
    ) -> None:
        api, fixtures, _, _ = self.load_api(session_user="owner@example.com")
        with self.assertRaisesRegex(FakePermissionError, "issuer_auth_mismatch"):
            self.call(api)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _ = self.load_api(request_method="GET")
        with self.assertRaisesRegex(FakePermissionError, "post_required"):
            self.call(api)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _ = self.load_api(can_create=False)
        with self.assertRaisesRegex(FakePermissionError, "issuer_permission_denied"):
            self.call(api)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _ = self.load_api(configured_issuer=None)
        with self.assertRaisesRegex(FakePermissionError, "issuer_not_configured"):
            self.call(api)
        self.assertEqual(fixtures["evidence"], [])

    def test_issuer_rejects_payload_injection_and_conflicting_replay(self) -> None:
        api, fixtures, _, _ = self.load_api()
        with self.assertRaisesRegex(FakeValidationError, "missing or unsupported"):
            self.call(api, {**self.payload(), "verified_at": "forged"})
        self.assertEqual(fixtures["evidence"], [])
        with self.assertRaisesRegex(FakeValidationError, "evidence_type or proof_slot"):
            self.call(api, {**self.payload(), "proof_slot": "Forged Gate"})
        self.assertEqual(fixtures["evidence"], [])

        self.call(api)
        with self.assertRaisesRegex(FakeValidationError, "identity_conflict"):
            self.call(api, {**self.payload(), "content_checksum": "b" * 64})
        self.assertEqual(len(fixtures["evidence"]), 1)

    def test_issuer_derives_verified_open_lifecycle_and_rejects_forged_states(self) -> None:
        api, fixtures, _, _ = self.load_api()
        with self.assertRaisesRegex(FakeValidationError, "verification_forbidden"):
            self.call(api, {**self.payload(), "evidence_verification": "Pending"})
        with self.assertRaisesRegex(FakeValidationError, "disposition_forbidden"):
            self.call(api, {**self.payload(), "evidence_disposition": "Accepted"})
        self.assertEqual(fixtures["evidence"], [])

        fixtures["work_packages"] = [
            {
                "name": "WP-001",
                "work_package_id": "WP-001",
                "roof_job": "JOB-A",
                "version": 1,
                "status": "Released",
                "release_attempt_id": "attempt-001",
            }
        ]
        issued = self.call(
            api,
            {
                **self.payload(),
                "work_package": "WP-001",
                "work_package_version": 1,
                "work_package_release_attempt_id": "attempt-001",
                "evidence_slot_id": "step:1",
                "evidence_requirement": "One clear deck photo",
                "evidence_source": "worker-camera",
                "evidence_device_id": "paired-device-1",
                "evidence_freshness": "Current",
                "evidence_conflict_state": "None",
            },
        )
        self.assertFalse(issued["idempotent_replay"])
        self.assertEqual(fixtures["evidence"][0]["evidence_verification"], "Verified")
        self.assertEqual(fixtures["evidence"][0]["evidence_disposition"], "Open")

    def test_typed_work_package_slot_is_bound_and_replays_exactly(self) -> None:
        fixtures = {
            "evidence": [],
            "work_packages": [
                {
                    "name": "WP-001",
                    "work_package_id": "work-package:JOB-A:v3",
                    "roof_job": "JOB-A",
                    "version": 3,
                    "status": "Acknowledged",
                    "release_attempt_id": "attempt-001",
                }
            ],
        }
        api, fixtures, db, _ = self.load_api(fixtures)
        payload = {
            **self.payload(),
            "roof_job": "JOB-A",
            "work_package": "work-package:JOB-A:v3",
            "work_package_version": 3,
            "evidence_slot_id": "step:1",
            "evidence_requirement": "One clear deck photo",
            "evidence_source": "worker-camera",
            "evidence_device_id": "paired-device-1",
            "work_package_release_attempt_id": "attempt-001",
            "evidence_freshness": "Current",
            "evidence_conflict_state": "None",
            "evidence_verification": "Verified",
            "evidence_disposition": "Open",
        }

        first = self.call(api, payload)
        self.assertFalse(first["idempotent_replay"])
        issued = fixtures["evidence"][0]
        self.assertEqual(issued["work_package"], "WP-001")
        self.assertEqual(issued["work_package_version"], 3)
        self.assertEqual(issued["evidence_slot_id"], "step:1")
        self.assertEqual(issued["evidence_device_id"], "paired-device-1")
        self.assertTrue(any("tabWork Package" in query for query in db.lock_queries))

        replay = self.call(api, payload)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(len(fixtures["evidence"]), 1)

        with self.assertRaisesRegex(FakeValidationError, "work_package_conflict"):
            self.call(api, {**payload, "work_package_version": 2})

    def test_typed_fields_fail_closed_without_complete_package_binding(self) -> None:
        api, fixtures, _, _ = self.load_api()
        with self.assertRaisesRegex(FakeValidationError, "work_package and evidence_slot_id"):
            self.call(api, {**self.payload(), "evidence_slot_id": "step:1"})
        with self.assertRaisesRegex(FakeValidationError, "typed evidence slots require"):
            self.call(
                api,
                {
                    **self.payload(),
                    "work_package": "WP-001",
                    "work_package_version": 1,
                    "evidence_slot_id": "step:1",
                },
            )
        self.assertEqual(fixtures["evidence"], [])


if __name__ == "__main__":
    unittest.main()
