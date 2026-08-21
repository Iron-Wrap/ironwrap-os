from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import sys
import time
from datetime import datetime
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import CUSTOMER_ACCEPTANCE_SERVICE_ROLE


ROOF_JOB_DOCTYPE_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "roof_job"
    / "roof_job.json"
)
API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "customer_contract_acceptance_api.py"
)
SERVICE_USER = "customer-acceptance@example.com"
HMAC_KEY = "test-customer-contract-hmac-key"
WORKFLOW_PROFILE = "Residential Retail"
LOCALE_POLICY_VERSION = "ca-ab-2026-01"
LOCALE_POLICY_SNAPSHOT = json.dumps({"country": "CA", "province": "AB"})


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, on_save, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_save", on_save)
        object.__setattr__(self, "_on_insert", on_insert)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def insert(self) -> None:
        if self["doctype"] == "Evidence Item":
            self["name"] = self["evidence_id"]
        elif self["doctype"] == "Contract Acceptance":
            self["name"] = self["acceptance_id"]
        else:
            raise AssertionError(f"unexpected insert: {self['doctype']}")
        self._on_insert(self)

    def save(self) -> None:
        self._on_save(self)

    def set(self, field: str, value) -> None:
        self[field] = value


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabRoof Job`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["jobs"].values()
                if row["roof_job_id"] == values[0]
            ]
        if "`tabRoofing Customer`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["customers"].values()
                if row["customer_id"] == values[0]
            ]
        if "`tabEvidence Item`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["evidence"]
                if row["evidence_id"] == values[0]
            ]
        if "`tabCustomer Quote`" in normalized:
            quote = self.fixtures["quotes"].get(values[0])
            return [dict(quote)] if quote else []
        if "`tabProposal Evidence Pack`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["packs"].values()
                if row["roof_job"] == values[0]
                and row["quotation"] == values[1]
                and row["status"] == "Approved"
            ]
        if "`tabContract Acceptance`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["acceptances"]
                if row["acceptance_id"] == values[0]
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class FakeNonceCache:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.calls: list[tuple[str, str, bool, int]] = []

    @staticmethod
    def make_key(key: str) -> str:
        return key

    def set(self, *, name: str, value: str, nx: bool, ex: int) -> bool | None:
        self.calls.append((name, value, nx, ex))
        if nx and name in self.values:
            return None
        self.values[name] = value
        return True


class CustomerContractAcceptanceApiTests(unittest.TestCase):
    def fixtures(self) -> dict:
        quote_snapshot = {
            "quote": {"customer_quote_id": "cq-1", "quote_version": 1},
            "captured_at": "2026-07-31T09:00:00Z",
            "rules": [],
        }
        return {
            "jobs": {
                "job-1": {
                    "name": "job-1",
                    "roof_job_id": "job-1",
                    "customer": "customer-1",
                    "quotation": "cq-1",
                    "job_status": "Proposal",
                    "workflow_profile": "",
                    "locale_policy_version": "",
                    "locale_policy_snapshot_json": "",
                }
            },
            "customers": {
                "customer-1": {
                    "name": "customer-1",
                    "customer_id": "customer-1",
                    "display_name": "Alex Customer",
                    "email": "alex@example.com",
                }
            },
            "quotes": {
                "cq-1": {
                    "name": "cq-1",
                    "customer_quote_id": "cq-1",
                    "roof_job": "job-1",
                    "customer": "customer-1",
                    "quote_version": 1,
                    "status": "Approved",
                    "price_book_version": "retail-2026-07",
                    "pricing_effective_at": "2026-07-31T09:00:00Z",
                    "subtotal": "1000.00",
                    "tax_amount": "50.00",
                    "tax_code": "GST",
                    "tax_rate": "5.00",
                    "tax_policy_snapshot_json": json.dumps({"code": "GST", "rate": 5}),
                    "quote_total": "1050.00",
                    "currency": "CAD",
                    "deposit_amount": "250.00",
                    "amount_due": "1050.00",
                    "qb_terms_ref": "99",
                    "qb_terms_due_days": 30,
                    "scope_summary": "Replace the main roof.",
                    "assumptions": "Clear driveway.",
                    "exclusions": "Structural repair.",
                    "quote_summary_json": json.dumps({"line_items": ["roof"]}),
                    "price_rule_snapshot_json": json.dumps(quote_snapshot),
                    "acceptance_evidence": "",
                    "contract_acceptance": "",
                    "accepted_at": "",
                }
            },
            "packs": {
                "proposal:cq-1": {
                    "name": "proposal:cq-1",
                    "pack_id": "proposal:cq-1",
                    "roof_job": "job-1",
                    "quotation": "cq-1",
                    "status": "Approved",
                    "prepared_at": "2026-07-31T09:01:00Z",
                    "approved_at": "2026-07-31T09:02:00Z",
                    "evidence_summary_json": json.dumps({"counts": {"eligible": 0}}),
                    "assumptions": "",
                    "exclusions": "",
                }
            },
            "evidence": [],
            "acceptances": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = SERVICE_USER,
        roles: list[str] | None = None,
        has_permission: bool = True,
        site_config: dict | None = None,
    ):
        fixtures = fixtures or self.fixtures()
        db = FakeDb(fixtures)
        nonce_cache = FakeNonceCache()
        issuance_calls: list[tuple[dict, dict, dict]] = []
        job_transition_calls: list[dict] = []

        @contextmanager
        def customer_contract_acceptance_issuance_context(evidence, acceptance, quote):
            issuance_calls.append((dict(evidence), dict(acceptance), dict(quote)))
            yield

        @contextmanager
        def customer_contract_job_transition_context(job):
            job_transition_calls.append(dict(job))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.customer_contract_acceptance_issuance_context = (
            customer_contract_acceptance_issuance_context
        )
        validation_module.customer_contract_job_transition_context = (
            customer_contract_job_transition_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.cache = lambda: nonce_cache
        frappe_module.conf = dict(
            site_config
            if site_config is not None
            else {
                "ironwrap_customer_acceptance_service_user": SERVICE_USER,
                "ironwrap_customer_acceptance_hmac_key": HMAC_KEY,
                "ironwrap_default_workflow_profile": WORKFLOW_PROFILE,
                "ironwrap_locale_policy_version": LOCALE_POLICY_VERSION,
                "ironwrap_locale_policy_snapshot_json": LOCALE_POLICY_SNAPSHOT,
            }
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method="POST", headers={})
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else [CUSTOMER_ACCEPTANCE_SERVICE_ROLE]
        )
        frappe_module.has_permission = lambda *args, **kwargs: has_permission
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-31 10:01:00"
        )
        frappe_module.whitelist = lambda: lambda function: function

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw

        def on_insert(document: FakeDocument) -> None:
            if document["doctype"] == "Evidence Item":
                fixtures["evidence"].append(dict(document))
            else:
                fixtures["acceptances"].append(dict(document))

        def on_save(document: FakeDocument) -> None:
            if document.get("doctype") == "Roof Job":
                fixtures["jobs"][document["name"]] = dict(document)
            else:
                fixtures["quotes"][document["name"]] = dict(document)

        def get_doc(*args):
            if len(args) == 2:
                doctype, name = args
                if doctype == "Roof Job":
                    row = dict(fixtures["jobs"][name])
                    row["doctype"] = "Roof Job"
                    return FakeDocument(row, on_save, on_insert)
                if doctype != "Customer Quote":
                    raise AssertionError(f"unexpected get_doc: {doctype}")
                return FakeDocument(dict(fixtures["quotes"][name]), on_save, on_insert)
            if len(args) == 1 and isinstance(args[0], dict):
                return FakeDocument(dict(args[0]), on_save, on_insert)
            raise AssertionError(f"unexpected get_doc args: {args}")

        frappe_module.get_doc = get_doc
        spec = importlib.util.spec_from_file_location(
            "ironwrap_customer_contract_acceptance_api_under_test", API_PATH
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
        return (
            module,
            fixtures,
            db,
            issuance_calls,
            frappe_module,
            job_transition_calls,
        )

    @staticmethod
    def canonical(payload: dict) -> str:
        return json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )

    def signed_claim(
        self,
        api,
        frappe_module,
        path: str,
        payload: dict,
        *,
        nonce: str,
        timestamp: int | None = None,
    ):
        claim_json = self.canonical(payload)
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        body_hash = hashlib.sha256(claim_json.encode("utf-8")).hexdigest()
        signed = f"POST\n{path}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
        signature = base64.urlsafe_b64encode(
            hmac.new(HMAC_KEY.encode("utf-8"), signed, hashlib.sha256).digest()
        ).rstrip(b"=").decode("ascii")
        frappe_module.request.headers = {
            "X-IronWrap-Acceptance-Timestamp": timestamp,
            "X-IronWrap-Acceptance-Nonce": nonce,
            "X-IronWrap-Acceptance-Signature": signature,
        }
        return claim_json

    def prepare_claim(self) -> dict:
        return {
            "tenant_id": "ironwrap",
            "portal_link_id": "portal-link-000001",
            "roof_job_id": "job-1",
            "customer_id": "customer-1",
            "challenge_id": "challenge-000001",
        }

    def test_prepare_reads_real_frappe_datetime_columns(self) -> None:
        """A stored Datetime arrives as ``datetime``, not as its REST string form.

        Every fixture here supplies the string, so ``_text`` on a Datetime column
        passed in this suite while refusing every real record on a live site.
        """

        api, fixtures, _db, _issuance_calls, frappe_module, _jobs = self.load_api()
        fixtures["quotes"]["cq-1"]["pricing_effective_at"] = datetime(2026, 7, 31, 9, 0)
        fixtures["packs"]["proposal:cq-1"]["prepared_at"] = datetime(2026, 7, 31, 9, 1)
        fixtures["packs"]["proposal:cq-1"]["approved_at"] = datetime(2026, 7, 31, 9, 2)

        prepared = api.prepare_customer_portal_contract_acceptance(
            self.signed_claim(
                api,
                frappe_module,
                api.PREPARE_PATH,
                self.prepare_claim(),
                nonce="prepare-nonce-datetime-1",
            )
        )

        self.assertEqual(prepared["terms"]["quote"]["pricing_effective_at"], "2026-07-31 09:00:00")
        self.assertEqual(prepared["terms"]["proposal"]["prepared_at"], "2026-07-31 09:01:00")
        self.assertEqual(prepared["terms"]["proposal"]["published_at"], "2026-07-31 09:02:00")

    def test_prepare_and_commit_lock_exact_offer_and_replay_idempotently(self) -> None:
        api, fixtures, db, issuance_calls, frappe_module, job_transitions = self.load_api()
        prepare_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce="prepare-nonce-000001",
        )

        prepared = api.prepare_customer_portal_contract_acceptance(prepare_json)

        self.assertEqual(
            set(prepared),
            {
                "email",
                "email_hash",
                "display_name",
                "roof_job_id",
                "customer_id",
                "quote_id",
                "quote_version",
                "proposal_pack_id",
                "terms",
                "terms_hash",
            },
        )
        self.assertEqual(prepared["email"], "alex@example.com")
        self.assertEqual(
            prepared["email_hash"], hashlib.sha256(b"alex@example.com").hexdigest()
        )
        self.assertEqual(prepared["proposal_pack_id"], "proposal:cq-1")
        self.assertEqual(
            prepared["terms"]["schema"], "ironwrap.customer-contract-terms.v2"
        )
        self.assertEqual(prepared["terms"]["quote"]["qb_terms_ref"], "99")
        self.assertEqual(prepared["terms"]["quote"]["qb_terms_due_days"], 30)
        self.assertEqual(
            prepared["terms_hash"],
            hashlib.sha256(self.canonical(prepared["terms"]).encode("utf-8")).hexdigest(),
        )
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))
        self.assertTrue(any("`tabRoof Job`" in query for query in db.lock_queries))
        self.assertTrue(any("`tabRoofing Customer`" in query for query in db.lock_queries))
        self.assertTrue(any("`tabCustomer Quote`" in query for query in db.lock_queries))
        self.assertTrue(any("`tabProposal Evidence Pack`" in query for query in db.lock_queries))
        self.assertEqual(len(frappe_module.cache().calls), 1)
        self.assertEqual(frappe_module.cache().calls[0][2:], (True, 300))

        with self.assertRaisesRegex(FakePermissionError, "nonce_replayed"):
            api.prepare_customer_portal_contract_acceptance(prepare_json)

        with patch.object(api.time, "time", return_value=1_700_000_000):
            future_json = self.signed_claim(
                api,
                frappe_module,
                api.PREPARE_PATH,
                self.prepare_claim(),
                nonce="prepare-nonce-future-skew",
                timestamp=1_700_000_300,
            )
            api.prepare_customer_portal_contract_acceptance(future_json)
        self.assertEqual(frappe_module.cache().calls[-1][3], 600)

        commit_claim = {
            "acceptance_id": "accept-000001",
            "challenge_id": "challenge-000001",
            "portal_link_id": "portal-link-000001",
            "tenant_id": "ironwrap",
            "roof_job_id": prepared["roof_job_id"],
            "customer_id": prepared["customer_id"],
            "quote_id": prepared["quote_id"],
            "quote_version": prepared["quote_version"],
            "proposal_pack_id": prepared["proposal_pack_id"],
            "terms_hash": prepared["terms_hash"],
            "email_hash": prepared["email_hash"],
            "signer_name": "Alex Customer",
            "accepted_at": "2026-07-31T10:00:00Z",
            "receipt_key": "customer-contract-acceptance/v1/job-1/accept-000001.json",
            "receipt_hash": "a" * 64,
            "receipt_content_type": "application/json",
            "receipt_content_length": 512,
            "receipt_captured_at": "2026-07-31T10:00:01Z",
            "signer_ip": "203.0.113.10",
        }
        commit_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            commit_claim,
            nonce="commit-nonce-000001",
        )

        self.assertEqual(
            api.record_customer_portal_contract_acceptance(commit_json),
            {"acceptance_id": "accept-000001"},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["acceptances"]), 1)
        evidence = fixtures["evidence"][0]
        acceptance = fixtures["acceptances"][0]
        quote = fixtures["quotes"]["cq-1"]
        self.assertEqual(evidence["evidence_type"], "Signed Document")
        self.assertEqual(evidence["proof_slot"], "Contract")
        self.assertEqual(evidence["sync_state"], "Verified")
        self.assertEqual(evidence["r2_key"], commit_claim["receipt_key"])
        self.assertEqual(acceptance["proposal_evidence_pack"], "proposal:cq-1")
        self.assertEqual(acceptance["terms_hash"], prepared["terms_hash"])
        self.assertEqual(acceptance["document_checksum"], "a" * 64)
        self.assertEqual(quote["status"], "Accepted")
        self.assertEqual(quote["acceptance_evidence"], evidence["name"])
        self.assertEqual(quote["contract_acceptance"], acceptance["name"])
        # The claim carries RFC 3339 text; what is stored is the Frappe datetime
        # for the same instant, because MariaDB rejects the ``Z`` form outright.
        self.assertEqual(quote["accepted_at"], "2026-07-31 10:00:00")
        self.assertEqual(acceptance["accepted_at"], "2026-07-31 10:00:00")
        self.assertEqual(evidence["captured_at"], "2026-07-31 10:00:01")
        self.assertEqual(len(issuance_calls), 1)

        replay_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            commit_claim,
            nonce="commit-nonce-000002",
        )
        self.assertEqual(
            api.record_customer_portal_contract_acceptance(replay_json),
            {"acceptance_id": "accept-000001"},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["acceptances"]), 1)

        fixtures["evidence"][0]["content_checksum"] = "b" * 64
        evidence_conflict_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            commit_claim,
            nonce="commit-nonce-000003",
        )
        with self.assertRaisesRegex(FakeValidationError, "acceptance_conflict"):
            api.record_customer_portal_contract_acceptance(evidence_conflict_json)
        self.assertEqual(len(issuance_calls), 1)

    def test_rejects_forged_hmac_missing_role_and_changed_terms(self) -> None:
        api, fixtures, _, _, _, _ = self.load_api(session_user="owner@example.com")
        with self.assertRaisesRegex(FakePermissionError, "service_user_mismatch"):
            api.prepare_customer_portal_contract_acceptance("{}")
        self.assertEqual(fixtures["evidence"], [])

        api, fixtures, _, _, _, _ = self.load_api(has_permission=False)
        with self.assertRaisesRegex(FakePermissionError, "permission_denied"):
            api.prepare_customer_portal_contract_acceptance("{}")
        self.assertEqual(fixtures["acceptances"], [])

        api, fixtures, _, _, frappe_module, _ = self.load_api()
        prepared_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce="prepare-nonce-000003",
        )
        frappe_module.request.headers["X-IronWrap-Acceptance-Signature"] = "A" * 43
        with self.assertRaisesRegex(FakePermissionError, "customer_contract_hmac_invalid"):
            api.prepare_customer_portal_contract_acceptance(prepared_json)
        self.assertEqual(fixtures["evidence"], [])

        prepared_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce="prepare-nonce-epoch-only",
        )
        frappe_module.request.headers["X-IronWrap-Acceptance-Timestamp"] = (
            "2026-07-31T10:00:00Z"
        )
        with self.assertRaisesRegex(FakePermissionError, "customer_contract_hmac_invalid"):
            api.prepare_customer_portal_contract_acceptance(prepared_json)

        api, fixtures, _, _, frappe_module, _ = self.load_api(roles=[])
        claim_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce="prepare-nonce-000004",
        )
        with self.assertRaisesRegex(FakePermissionError, "service_role_missing"):
            api.prepare_customer_portal_contract_acceptance(claim_json)
        self.assertEqual(fixtures["acceptances"], [])

        api, fixtures, _, _, frappe_module, _ = self.load_api()
        prepared_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce="prepare-nonce-000005",
        )
        prepared = api.prepare_customer_portal_contract_acceptance(prepared_json)
        tampered = {
            "acceptance_id": "accept-000002",
            "challenge_id": "challenge-000001",
            "portal_link_id": "portal-link-000001",
            "tenant_id": "ironwrap",
            "roof_job_id": prepared["roof_job_id"],
            "customer_id": prepared["customer_id"],
            "quote_id": prepared["quote_id"],
            "quote_version": prepared["quote_version"],
            "proposal_pack_id": prepared["proposal_pack_id"],
            "terms_hash": "b" * 64,
            "email_hash": hashlib.sha256(b"alex@example.com").hexdigest(),
            "signer_name": "Alex Customer",
            "accepted_at": "2026-07-31T10:00:00Z",
            "receipt_key": "customer-contract-acceptance/v1/job-1/accept-000002.json",
            "receipt_hash": "a" * 64,
            "receipt_content_type": "application/json",
            "receipt_content_length": 512,
            "receipt_captured_at": "2026-07-31T10:00:01Z",
            "signer_ip": "203.0.113.10",
        }
        tampered_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            tampered,
            nonce="commit-nonce-000003",
        )
        with self.assertRaisesRegex(FakeValidationError, "terms_mismatch"):
            api.record_customer_portal_contract_acceptance(tampered_json)
        self.assertEqual(fixtures["evidence"], [])
        self.assertEqual(fixtures["acceptances"], [])

        legacy_pack_version_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            {**tampered, "published_pack_version": 1},
            nonce="commit-nonce-legacy-pack-version",
        )
        with self.assertRaisesRegex(FakeValidationError, "claim fields are unsupported"):
            api.record_customer_portal_contract_acceptance(legacy_pack_version_json)
        self.assertEqual(fixtures["evidence"], [])
        self.assertEqual(fixtures["acceptances"], [])

        email_drift = {
            **tampered,
            "terms_hash": prepared["terms_hash"],
            "email_hash": "c" * 64,
        }
        email_drift_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            email_drift,
            nonce="commit-nonce-000004",
        )
        with self.assertRaisesRegex(FakeValidationError, "email_mismatch"):
            api.record_customer_portal_contract_acceptance(email_drift_json)
        self.assertEqual(fixtures["evidence"], [])
        self.assertEqual(fixtures["acceptances"], [])

    # ELEC-117 / ELEC-115 Path A: the Won-gate producer.  Until this shipped,
    # `job_status = "Won"` had no writer anywhere in the product, so every gate behind
    # it (production-schedule eligibility, `/today`, work packages) was correct but
    # permanently empty.  RETIREMENT: these cases go with the producer when IRO-195's
    # D1-native acceptance transition replaces it.
    def accept(
        self,
        api,
        frappe_module,
        *,
        acceptance_id: str = "accept-000001",
        nonce: str,
    ) -> dict:
        prepare_json = self.signed_claim(
            api,
            frappe_module,
            api.PREPARE_PATH,
            self.prepare_claim(),
            nonce=f"prepare-{nonce}",
        )
        prepared = api.prepare_customer_portal_contract_acceptance(prepare_json)
        commit_claim = {
            "acceptance_id": acceptance_id,
            "challenge_id": "challenge-000001",
            "portal_link_id": "portal-link-000001",
            "tenant_id": "ironwrap",
            "roof_job_id": prepared["roof_job_id"],
            "customer_id": prepared["customer_id"],
            "quote_id": prepared["quote_id"],
            "quote_version": prepared["quote_version"],
            "proposal_pack_id": prepared["proposal_pack_id"],
            "terms_hash": prepared["terms_hash"],
            "email_hash": prepared["email_hash"],
            "signer_name": "Alex Customer",
            "accepted_at": "2026-07-31T10:00:00Z",
            "receipt_key": f"customer-contract-acceptance/v1/job-1/{acceptance_id}.json",
            "receipt_hash": "a" * 64,
            "receipt_content_type": "application/json",
            "receipt_content_length": 512,
            "receipt_captured_at": "2026-07-31T10:00:01Z",
            "signer_ip": "203.0.113.10",
        }
        commit_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            commit_claim,
            nonce=f"commit-{nonce}",
        )
        api.record_customer_portal_contract_acceptance(commit_json)
        return commit_claim

    def test_acceptance_wins_the_job_and_stamps_the_won_invariant(self) -> None:
        api, fixtures, _, _, frappe_module, job_transitions = self.load_api()
        self.assertEqual(fixtures["jobs"]["job-1"]["job_status"], "Proposal")

        self.accept(api, frappe_module, nonce="won-000001")

        job = fixtures["jobs"]["job-1"]
        self.assertEqual(job["job_status"], "Won")
        self.assertEqual(job["workflow_profile"], WORKFLOW_PROFILE)
        self.assertEqual(job["locale_policy_version"], LOCALE_POLICY_VERSION)
        self.assertEqual(
            json.loads(job["locale_policy_snapshot_json"]),
            {"country": "CA", "province": "AB"},
        )
        # The job lineage the acceptance had no business touching is untouched.
        self.assertEqual(job["customer"], "customer-1")
        self.assertEqual(job["quotation"], "cq-1")
        # Exactly one governed transition, and it carried the job the command saved.
        self.assertEqual(len(job_transitions), 1)
        self.assertEqual(job_transitions[0]["job_status"], "Won")
        self.assertEqual(fixtures["quotes"]["cq-1"]["status"], "Accepted")

    def test_replay_converges_a_job_left_behind_by_an_earlier_acceptance(self) -> None:
        api, fixtures, _, _, frappe_module, job_transitions = self.load_api()
        commit_claim = self.accept(api, frappe_module, nonce="won-000002")
        # An acceptance recorded before this producer existed: receipt and quote are
        # already durable, the job never left the tentative set.
        fixtures["jobs"]["job-1"]["job_status"] = "Proposal"
        fixtures["jobs"]["job-1"]["workflow_profile"] = ""
        fixtures["jobs"]["job-1"]["locale_policy_version"] = ""
        fixtures["jobs"]["job-1"]["locale_policy_snapshot_json"] = ""

        replay_json = self.signed_claim(
            api,
            frappe_module,
            api.COMMIT_PATH,
            commit_claim,
            nonce="commit-won-000002-replay",
        )
        api.record_customer_portal_contract_acceptance(replay_json)

        self.assertEqual(fixtures["jobs"]["job-1"]["job_status"], "Won")
        self.assertEqual(
            fixtures["jobs"]["job-1"]["locale_policy_version"], LOCALE_POLICY_VERSION
        )
        self.assertEqual(len(fixtures["acceptances"]), 1)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(job_transitions), 2)

    def test_a_job_past_the_tentative_set_keeps_the_status_production_gave_it(
        self,
    ) -> None:
        for status in ("Won", "In Production", "Completed", "Closed", "Lost"):
            with self.subTest(status=status):
                fixtures = self.fixtures()
                fixtures["jobs"]["job-1"]["job_status"] = status
                api, fixtures, _, _, frappe_module, job_transitions = self.load_api(
                    fixtures
                )

                self.accept(
                    api,
                    frappe_module,
                    nonce=f"won-past-{status.replace(' ', '').lower():-<12}",
                )

                self.assertEqual(fixtures["jobs"]["job-1"]["job_status"], status)
                self.assertEqual(job_transitions, [])
                # The acceptance itself still lands: the receipt is the durable fact.
                self.assertEqual(len(fixtures["acceptances"]), 1)

    def test_won_invariant_fields_already_filled_in_are_never_overwritten(self) -> None:
        fixtures = self.fixtures()
        fixtures["jobs"]["job-1"]["workflow_profile"] = "Insurance Restoration"
        fixtures["jobs"]["job-1"]["locale_policy_version"] = "ca-ab-2025-04"
        fixtures["jobs"]["job-1"]["locale_policy_snapshot_json"] = json.dumps(
            {"country": "CA", "province": "AB", "revision": "operator"}
        )
        api, fixtures, _, _, frappe_module, _ = self.load_api(fixtures)

        self.accept(api, frappe_module, nonce="won-000003")

        job = fixtures["jobs"]["job-1"]
        self.assertEqual(job["job_status"], "Won")
        self.assertEqual(job["workflow_profile"], "Insurance Restoration")
        self.assertEqual(job["locale_policy_version"], "ca-ab-2025-04")
        self.assertEqual(
            json.loads(job["locale_policy_snapshot_json"])["revision"], "operator"
        )

    def test_an_unpinned_or_invalid_tenant_constant_fails_the_acceptance_closed(
        self,
    ) -> None:
        base = {
            "ironwrap_customer_acceptance_service_user": SERVICE_USER,
            "ironwrap_customer_acceptance_hmac_key": HMAC_KEY,
            "ironwrap_default_workflow_profile": WORKFLOW_PROFILE,
            "ironwrap_locale_policy_version": LOCALE_POLICY_VERSION,
            "ironwrap_locale_policy_snapshot_json": LOCALE_POLICY_SNAPSHOT,
        }
        cases = (
            ({"ironwrap_default_workflow_profile": None}, "workflow_profile_unconfigured"),
            (
                {"ironwrap_default_workflow_profile": "Residential"},
                "workflow_profile_unconfigured",
            ),
            ({"ironwrap_locale_policy_version": None}, "locale_policy_unconfigured"),
            ({"ironwrap_locale_policy_version": "  "}, "locale_policy_unconfigured"),
            ({"ironwrap_locale_policy_snapshot_json": None}, "locale_policy_unconfigured"),
            ({"ironwrap_locale_policy_snapshot_json": "{}"}, "locale_policy_unconfigured"),
            ({"ironwrap_locale_policy_snapshot_json": "[]"}, "locale_policy_unconfigured"),
            (
                {"ironwrap_locale_policy_snapshot_json": "not json"},
                "locale_policy_unconfigured",
            ),
        )
        for index, (override, code) in enumerate(cases):
            with self.subTest(override=override):
                api, fixtures, _, _, frappe_module, job_transitions = self.load_api(
                    site_config={**base, **override}
                )
                with self.assertRaisesRegex(FakeValidationError, code):
                    self.accept(api, frappe_module, nonce=f"won-failclosed-{index:06d}")
                self.assertEqual(fixtures["jobs"]["job-1"]["job_status"], "Proposal")
                self.assertEqual(job_transitions, [])

    def test_a_mapping_locale_snapshot_pin_is_canonicalized_not_stringified(
        self,
    ) -> None:
        api, fixtures, _, _, frappe_module, _ = self.load_api(
            site_config={
                "ironwrap_customer_acceptance_service_user": SERVICE_USER,
                "ironwrap_customer_acceptance_hmac_key": HMAC_KEY,
                "ironwrap_default_workflow_profile": WORKFLOW_PROFILE,
                "ironwrap_locale_policy_version": LOCALE_POLICY_VERSION,
                "ironwrap_locale_policy_snapshot_json": {
                    "province": "AB",
                    "country": "CA",
                },
            }
        )

        self.accept(api, frappe_module, nonce="won-000004")

        self.assertEqual(
            fixtures["jobs"]["job-1"]["locale_policy_snapshot_json"],
            '{"country":"CA","province":"AB"}',
        )

    def test_the_command_declares_the_roof_job_write_it_now_needs(self) -> None:
        api, _, _, _, _, _ = self.load_api()
        self.assertIn(("Roof Job", "write"), api.REQUIRED_PERMISSIONS)

    def test_the_pinnable_workflow_profiles_are_the_ones_roof_job_accepts(self) -> None:
        api, _, _, _, _, _ = self.load_api()
        doctype = json.loads(ROOF_JOB_DOCTYPE_PATH.read_text(encoding="utf-8"))
        options = {
            field["options"]
            for field in doctype["fields"]
            if field["fieldname"] == "workflow_profile"
        }.pop()
        # A profile pinned in a site config that Roof Job would reject is a rail that
        # fails at Won time on a real site and nowhere in CI.
        self.assertEqual(api.WORKFLOW_PROFILES, frozenset(options.split("\n")))
        self.assertIn(WORKFLOW_PROFILE, api.WORKFLOW_PROFILES)



if __name__ == "__main__":
    unittest.main()
