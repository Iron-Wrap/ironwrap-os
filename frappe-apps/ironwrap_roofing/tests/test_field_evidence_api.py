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
        fixtures = fixtures or {"evidence": []}
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


if __name__ == "__main__":
    unittest.main()
