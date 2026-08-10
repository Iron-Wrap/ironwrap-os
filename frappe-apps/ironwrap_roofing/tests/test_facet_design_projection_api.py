from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import sys
import time
import types
import unittest
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import FACET_DESIGN_PROJECTION_SERVICE_ROLE


API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "facet_design_projection_api.py"
)
SERVICE_USER = "facet-projection@example.invalid"
HMAC_KEY = "facet-projection-test-secret-longer-than-thirty-two-characters"


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeNonceCache:
    def __init__(self) -> None:
        self.values: set[str] = set()

    @staticmethod
    def make_key(value: str) -> str:
        return value

    def set(self, *, name: str, value: str, nx: bool, ex: int) -> bool:
        del value, ex
        if not nx or name in self.values:
            return False
        self.values.add(name)
        return True


class FakeDocument(dict):
    def __init__(self, values: dict, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_insert", on_insert)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def insert(self) -> None:
        identity = self.get("evidence_id") or self.get("reconciliation_id")
        self["name"] = identity
        self._on_insert(self)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        del as_dict
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        value = values[0]
        if "`tabRoof Job`" in normalized:
            job = self.fixtures["job"]
            return [dict(job)] if job.get("roof_job_id") == value else []
        if "`tabCustomer Quote`" in normalized:
            quote = self.fixtures["quote"]
            return [dict(quote)] if quote.get("customer_quote_id") == value else []
        if "`tabEvidence Item`" in normalized:
            return [
                dict(item)
                for item in self.fixtures["evidence"]
                if item.get("evidence_id") == value
            ]
        if "`tabIntegration Reconciliation`" in normalized:
            return [
                dict(item)
                for item in self.fixtures["reconciliations"]
                if item.get("reconciliation_id") == value
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class FacetDesignProjectionApiTests(unittest.TestCase):
    @staticmethod
    def fixture_claim() -> dict:
        return {
            "event_id": "facet-event-0001",
            "tenant_id": "ironwrap",
            "facet_project_id": "facet-project-0001",
            "design_revision_id": f"facet-json-v1:{'a' * 64}",
            "design_revision_sha256": "a" * 64,
            "frozen_evidence_sha256": "b" * 64,
            "raw_key": "facet-design/v1/facet-event-0001.json",
            "raw_sha256": "c" * 64,
            "raw_content_length": 512,
            "occurred_at": "2026-07-31T12:00:00.000Z",
            "received_at": "2026-07-31T12:01:00.000Z",
            "roof_job_id": "roof-job-0001",
            "customer_quote_id": "customer-quote-0001",
        }

    @classmethod
    def customer_approval_claim(cls) -> dict:
        return {
            **cls.fixture_claim(),
            "event_type": "facet.design.customer_approved.v2",
            "schema_version": 2,
            "brand_id": "ironwrap",
            "approval_actor_type": "customer_capability",
            "capability_fingerprint": "d" * 64,
            "identity_assurance": "bearer_capability_only",
            "raw_key": "facet-design/v2/facet-event-0001.json",
        }

    @staticmethod
    def fixtures() -> dict:
        return {
            "job": {
                "name": "JOB-001",
                "roof_job_id": "roof-job-0001",
                "brand": "ironwrap",
                "quotation": "QUOTE-001",
            },
            "quote": {
                "name": "QUOTE-001",
                "customer_quote_id": "customer-quote-0001",
                "roof_job": "JOB-001",
                "status": "Approved",
                "price_book_version": "not-read-by-projection",
                "quote_total": "not-read-by-projection",
            },
            "evidence": [],
            "reconciliations": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = SERVICE_USER,
        roles: list[str] | None = None,
        has_permission: bool = True,
        request_method: str = "POST",
        configured_user: str | None = SERVICE_USER,
        configured_hmac_key: str = HMAC_KEY,
    ):
        fixtures = fixtures or self.fixtures()
        db = FakeDb(fixtures)
        cache = FakeNonceCache()
        issuance_calls: list[tuple[dict, dict]] = []

        @contextmanager
        def facet_design_projection_issuance_context(evidence, reconciliation):
            issuance_calls.append((dict(evidence), dict(reconciliation)))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.facet_design_projection_issuance_context = (
            facet_design_projection_issuance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.cache = lambda: cache
        frappe_module.conf = {
            "ironwrap_facet_design_projection_service_user": configured_user,
            "ironwrap_facet_design_projection_hmac_key": configured_hmac_key,
        }
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method, headers={})
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else [FACET_DESIGN_PROJECTION_SERVICE_ROLE]
        )
        frappe_module.has_permission = lambda *args, **kwargs: has_permission
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-31 12:02:00"
        )
        frappe_module.whitelist = lambda: lambda function: function

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw

        def on_insert(document: FakeDocument) -> None:
            if document["doctype"] == "Evidence Item":
                fixtures["evidence"].append(dict(document))
            elif document["doctype"] == "Integration Reconciliation":
                fixtures["reconciliations"].append(dict(document))
            else:
                raise AssertionError(f"unexpected document: {document['doctype']}")

        frappe_module.get_doc = lambda values: FakeDocument(dict(values), on_insert)
        spec = importlib.util.spec_from_file_location(
            "ironwrap_facet_design_projection_api_under_test", API_PATH
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
        return module, fixtures, db, issuance_calls, frappe_module

    @staticmethod
    def canonical(payload: dict) -> str:
        return json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )

    def call(self, api, frappe_module, claim: dict | None = None, *, nonce: str) -> dict:
        raw_claim = self.canonical(claim or self.fixture_claim())
        timestamp = str(int(time.time()))
        body_hash = hashlib.sha256(raw_claim.encode("utf-8")).hexdigest()
        signed = f"POST\n{api.COMMAND_PATH}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
        signature = base64.urlsafe_b64encode(
            hmac.new(HMAC_KEY.encode("utf-8"), signed, hashlib.sha256).digest()
        ).rstrip(b"=").decode("ascii")
        frappe_module.request.headers = {
            "x-ironwrap-facet-projection-timestamp": timestamp,
            "x-ironwrap-facet-projection-nonce": nonce,
            "x-ironwrap-facet-projection-signature": signature,
        }
        return api.record_facet_design_proposal_evidence(raw_claim)

    def assert_signed_receipt(
        self,
        api,
        response: dict,
        claim: dict,
        *,
        idempotent_replay: bool,
    ) -> None:
        receipt_json = self.canonical(response["receipt"])
        receipt_sha256 = hashlib.sha256(receipt_json.encode("utf-8")).hexdigest()
        expected_signature = base64.urlsafe_b64encode(
            hmac.new(
                HMAC_KEY.encode("utf-8"),
                f"{api.RECEIPT_SIGNATURE_CONTEXT}\n{receipt_sha256}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
        ).rstrip(b"=").decode("ascii")
        self.assertEqual(response["receipt_sha256"], receipt_sha256)
        self.assertEqual(response["receipt_signature_algorithm"], "HMAC-SHA256")
        self.assertEqual(response["receipt_signature"], expected_signature)
        receipt = response["receipt"]
        self.assertEqual(receipt["event_id"], claim["event_id"])
        self.assertEqual(receipt["roof_job_id"], claim["roof_job_id"])
        self.assertEqual(receipt["customer_quote_id"], claim["customer_quote_id"])
        self.assertEqual(receipt["raw_sha256"], claim["raw_sha256"])
        self.assertEqual(
            receipt["frozen_evidence_sha256"], claim["frozen_evidence_sha256"]
        )
        self.assertEqual(
            receipt["claim_sha256"],
            hashlib.sha256(self.canonical(claim).encode("utf-8")).hexdigest(),
        )
        self.assertEqual(receipt["idempotent_replay"], idempotent_replay)
        self.assertEqual(receipt["commercial_state"], "none")

    def test_projection_locks_exact_job_quote_creates_review_evidence_and_replays(self) -> None:
        api, fixtures, db, issuance_calls, frappe_module = self.load_api()
        before_quote = deepcopy(fixtures["quote"])

        first = self.call(api, frappe_module, nonce="a" * 32)

        event_hash = hashlib.sha256(b"facet-event-0001").hexdigest()
        self.assertEqual(
            {
                key: first[key]
                for key in (
                    "event_id",
                    "evidence_id",
                    "reconciliation_id",
                    "idempotent_replay",
                )
            },
            {
                "event_id": "facet-event-0001",
                "evidence_id": f"facet-design:{event_hash}",
                "reconciliation_id": f"facet-design-projection:{event_hash}",
                "idempotent_replay": False,
            },
        )
        self.assert_signed_receipt(
            api,
            first,
            self.fixture_claim(),
            idempotent_replay=False,
        )
        self.assertEqual(first["receipt"]["provenance"], {"status": "provenance_unknown"})
        self.assertEqual(fixtures["quote"], before_quote, "projection must not mutate the quote")
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        evidence = fixtures["evidence"][0]
        reconciliation = fixtures["reconciliations"][0]
        self.assertEqual(evidence["sync_state"], "Verified")
        self.assertEqual(evidence["verification_source"], api.VERIFICATION_SOURCE)
        self.assertEqual(evidence["customer_safe"], 0)
        self.assertEqual(evidence["r2_key"], "facet-design/v1/facet-event-0001.json")
        for field in (
            "lead_envelope",
            "source_uri",
            "drive_file_id",
            "latitude",
            "longitude",
            "location_accuracy_m",
            "correction_of",
            "correction_reason",
        ):
            self.assertIsNone(evidence[field], f"projected evidence must leave {field} empty")
        self.assertEqual(reconciliation["status"], "Pending")
        self.assertEqual(reconciliation["local_doctype"], "Customer Quote")
        self.assertEqual(reconciliation["local_name"], "QUOTE-001")
        self.assertEqual(reconciliation["raw_key"], "facet-design/v1/facet-event-0001.json")
        self.assertIsNone(reconciliation["resolution_evidence"])
        for field in (
            "source_amount",
            "local_amount",
            "currency",
            "resolution_action",
            "resolved_by",
            "resolved_at",
            "automation_incident",
            "supersedes",
            "correction_reason",
            "notes",
        ):
            self.assertIsNone(
                reconciliation[field],
                f"pending projection reconciliation must leave {field} empty",
            )
        self.assertIn('"commercial_state":"none"', reconciliation["diff_json"])
        self.assertNotIn('"provenance"', reconciliation["diff_json"])
        self.assertEqual(len(issuance_calls), 1)
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))
        self.assertNotIn("price_book_version", " ".join(db.lock_queries))
        self.assertNotIn("quote_total", " ".join(db.lock_queries))

        reconciliation.update(
            {
                "status": "Resolved",
                "resolution_action": "Estimator confirmed the approved design revision.",
                "resolved_by": "owner@example.invalid",
                "resolved_at": "2026-07-31 12:05:00",
                "resolution_evidence": "facet-resolution-evidence-1",
            }
        )
        frappe_module.utils.now_datetime = lambda: "2026-07-31 12:07:00"
        replay = self.call(api, frappe_module, nonce="b" * 32)
        self.assertEqual(replay["idempotent_replay"], True)
        self.assert_signed_receipt(
            api,
            replay,
            self.fixture_claim(),
            idempotent_replay=True,
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        self.assertEqual(len(issuance_calls), 1)

    def test_customer_approval_v2_persists_provenance_and_exact_brand_anchor(self) -> None:
        api, fixtures, _, issuance_calls, frappe_module = self.load_api()

        result = self.call(
            api,
            frappe_module,
            self.customer_approval_claim(),
            nonce="m" * 32,
        )

        self.assertEqual(result["event_id"], "facet-event-0001")
        self.assert_signed_receipt(
            api,
            result,
            self.customer_approval_claim(),
            idempotent_replay=False,
        )
        self.assertEqual(
            result["receipt"]["provenance"],
            {
                "status": "customer_approved",
                "brand_id": "ironwrap",
                "approval_actor_type": "customer_capability",
                "capability_fingerprint": "d" * 64,
                "identity_assurance": "bearer_capability_only",
            },
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        self.assertEqual(len(issuance_calls), 1)
        evidence = fixtures["evidence"][0]
        reconciliation = fixtures["reconciliations"][0]
        self.assertEqual(evidence["r2_key"], "facet-design/v2/facet-event-0001.json")
        self.assertEqual(evidence["customer_safe"], 0)
        self.assertIn("commercial use", evidence["summary"])
        diff = json.loads(reconciliation["diff_json"])
        self.assertEqual(diff["schema"], "ironwrap.facet-design-projection.v2")
        self.assertEqual(
            diff["source_event"],
            {
                "event_type": "facet.design.customer_approved.v2",
                "schema_version": 2,
            },
        )
        self.assertEqual(
            diff["provenance"],
            {
                "status": "customer_approved",
                "brand_id": "ironwrap",
                "approval_actor_type": "customer_capability",
                "capability_fingerprint": "d" * 64,
                "identity_assurance": "bearer_capability_only",
            },
        )
        self.assertEqual(diff["commercial_state"], "none")

        tampered = {
            **self.customer_approval_claim(),
            "capability_fingerprint": "e" * 64,
        }
        with self.assertRaisesRegex(FakeValidationError, "facet_design_projection_conflict"):
            self.call(api, frappe_module, tampered, nonce="t" * 32)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        self.assertEqual(len(issuance_calls), 1)

    def test_customer_approval_v2_rejects_contract_and_brand_mismatches(self) -> None:
        fixtures = self.fixtures()
        fixtures["job"]["brand"] = "iroof"
        api, fixtures, _, _, frappe_module = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "brand_mismatch"):
            self.call(
                api,
                frappe_module,
                self.customer_approval_claim(),
                nonce="n" * 32,
            )
        self.assertEqual(fixtures["evidence"], [])

        invalid_claims = (
            (
                {**self.customer_approval_claim(), "schema_version": 1},
                "event_version_mismatch",
            ),
            (
                {
                    **self.customer_approval_claim(),
                    "event_type": "facet.design.approved.v1",
                },
                "event_version_mismatch",
            ),
            (
                {
                    **self.customer_approval_claim(),
                    "raw_key": "facet-design/v1/facet-event-0001.json",
                },
                "raw_key_mismatch",
            ),
            (
                {**self.customer_approval_claim(), "capability_fingerprint": "not-a-hash"},
                "invalid_claim",
            ),
            (
                {**self.customer_approval_claim(), "identity_assurance": "verified_identity"},
                "identity_assurance_mismatch",
            ),
        )
        for index, (claim, expected_code) in enumerate(invalid_claims):
            with self.subTest(expected_code=expected_code):
                api, fixtures, _, _, frappe_module = self.load_api()
                with self.assertRaisesRegex(FakeValidationError, expected_code):
                    self.call(
                        api,
                        frappe_module,
                        claim,
                        nonce=chr(ord("o") + index) * 32,
                    )
                self.assertEqual(fixtures["evidence"], [])

    def test_projection_rejects_wrong_service_principal_role_permission_and_hmac(self) -> None:
        api, fixtures, _, _, frappe_module = self.load_api(session_user="owner@example.invalid")
        with self.assertRaisesRegex(FakePermissionError, "service_user_mismatch"):
            self.call(api, frappe_module, nonce="c" * 32)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, frappe_module = self.load_api(roles=[])
        with self.assertRaisesRegex(FakePermissionError, "service_role_missing"):
            self.call(api, frappe_module, nonce="d" * 32)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, frappe_module = self.load_api(has_permission=False)
        with self.assertRaisesRegex(FakePermissionError, "permission_denied"):
            self.call(api, frappe_module, nonce="e" * 32)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, frappe_module = self.load_api(request_method="GET")
        with self.assertRaisesRegex(FakePermissionError, "post_required"):
            self.call(api, frappe_module, nonce="f" * 32)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, frappe_module = self.load_api(configured_hmac_key="short")
        with self.assertRaisesRegex(FakePermissionError, "hmac_key_invalid"):
            self.call(api, frappe_module, nonce="s" * 32)
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, frappe_module = self.load_api()
        raw_claim = self.canonical(self.fixture_claim())
        frappe_module.request.headers = {
            "x-ironwrap-facet-projection-timestamp": str(int(time.time())),
            "x-ironwrap-facet-projection-nonce": "g" * 32,
            "x-ironwrap-facet-projection-signature": "z" * 43,
        }
        with self.assertRaisesRegex(FakePermissionError, "hmac_invalid"):
            api.record_facet_design_proposal_evidence(raw_claim)
        self.assertEqual(fixtures["evidence"], [])

    def test_projection_rejects_cross_job_stale_or_nonreviewable_quote_before_insert(self) -> None:
        fixtures = self.fixtures()
        fixtures["quote"]["roof_job"] = "JOB-OTHER"
        api, fixtures, _, _, frappe_module = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "quote_job_mismatch"):
            self.call(api, frappe_module, nonce="h" * 32)
        self.assertEqual(fixtures["evidence"], [])

        fixtures = self.fixtures()
        fixtures["job"]["quotation"] = "QUOTE-OTHER"
        api, fixtures, _, _, frappe_module = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "quote_not_current"):
            self.call(api, frappe_module, nonce="i" * 32)
        self.assertEqual(fixtures["reconciliations"], [])

        fixtures = self.fixtures()
        fixtures["quote"]["status"] = "Accepted"
        api, fixtures, _, _, frappe_module = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "quote_not_reviewable"):
            self.call(api, frappe_module, nonce="j" * 32)
        self.assertEqual(fixtures["evidence"], [])

    def test_projection_rejects_tampered_replay_and_never_has_a_commercial_write_path(self) -> None:
        api, fixtures, _, _, frappe_module = self.load_api()
        self.call(api, frappe_module, nonce="k" * 32)
        tampered = {**self.fixture_claim(), "raw_sha256": "d" * 64}
        with self.assertRaisesRegex(FakeValidationError, "facet_design_projection_conflict"):
            self.call(api, frappe_module, tampered, nonce="l" * 32)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)

        source = API_PATH.read_text(encoding="utf-8")
        self.assertNotIn("quote_document.save", source)
        self.assertNotIn("Contract Acceptance", source)
        self.assertNotIn("proposal_evidence_pack", source)
        self.assertNotIn("quote_total", source)


if __name__ == "__main__":
    unittest.main()
