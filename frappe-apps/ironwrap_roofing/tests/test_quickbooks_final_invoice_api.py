from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "quickbooks_final_invoice_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, save_log: list[tuple[str, dict]]) -> None:
        super().__init__(values)
        object.__setattr__(self, "_save_log", save_log)
        if "name" not in self:
            if self.get("doctype") == "Payment Milestone":
                self["name"] = self["payment_milestone_id"]
            elif self.get("doctype") == "Integration Reconciliation":
                self["name"] = self["reconciliation_id"]
            elif self.get("doctype") == "Roof Job":
                self["name"] = self["roof_job_id"]

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value):
        self[name] = value

    def get(self, key: str, default=None):
        return super().get(key, default)

    def insert(self, ignore_permissions: bool = False) -> None:
        self._save_log.append(("insert", dict(self)))

    def save(self, ignore_permissions: bool = False) -> None:
        self._save_log.append(("save", dict(self)))


class QuickBooksFinalInvoiceApiTests(unittest.TestCase):
    maxDiff = None

    def binding_payload(self) -> dict:
        return {
            "intent_id": f"qbo_final:{'a' * 64}",
            "basis_sha256": "a" * 64,
            "completion_packet_id": "cp-1",
            "completion_version": "2",
            "completion_sha256": "b" * 64,
            "customer_quote_id": "cq-1",
            "quote_version": 3,
            "quote_sha256": "c" * 64,
            "changes_sha256": "d" * 64,
            "roof_job_id": "job-1",
            "shop_order_id": None,
            "realm_id": "9130358252511540",
            "provider_invoice_id": "801",
            "provider_request_sha256": "e" * 64,
            "provider_create_response_sha256": "6" * 64,
            "provider_created_at": "2026-08-13T10:00:00Z",
        }

    def candidate(self, binding: dict) -> dict:
        return {
            "roof_job_id": binding["roof_job_id"],
            "shop_order_id": binding["shop_order_id"],
            "qbo": {
                "realm_id": binding["realm_id"],
                "customer_id": "77",
                "item_id": "88",
                "tax_code_id": "2",
                "terms_id": "99",
            },
            "commercial": {
                "currency": "CAD",
                "subtotal": "100.00",
                "tax_amount": "5.00",
                "total_amount": "105.00",
                "already_invoiced": "0.00",
                "final_balance": "105.00",
                "tax_code": "GST",
                "tax_rate": "5.0000",
                "invoice_date": "2026-08-13",
                "due_date": "2026-08-20",
                "lines": [
                    {
                        "source_type": "Customer Quote",
                        "source_id": binding["customer_quote_id"],
                        "source_version": binding["quote_version"],
                        "description_code": "RESIDENTIAL_ACCEPTED_QUOTE",
                        "amount": "100.00",
                    }
                ],
            },
            "basis": {
                "intent_id": binding["intent_id"],
                "basis_sha256": binding["basis_sha256"],
                "completion_packet_id": binding["completion_packet_id"],
                "completion_version": binding["completion_version"],
                "completion_sha256": binding["completion_sha256"],
                "customer_quote_id": binding["customer_quote_id"],
                "quote_version": binding["quote_version"],
                "quote_sha256": binding["quote_sha256"],
                "changes_sha256": binding["changes_sha256"],
                "evidence": [
                    {
                        "source": "Frappe",
                        "doctype": "Customer Quote",
                        "name": "CQ-0001",
                        "sha256": "1" * 64,
                    },
                    {
                        "source": "R2",
                        "key": "raw/contracts/cq-0001.json",
                        "sha256": "2" * 64,
                    },
                ],
            },
            "_basis_json": json.dumps(
                {"basis_sha256": binding["basis_sha256"], "intent_id": binding["intent_id"]},
                sort_keys=True,
                separators=(",", ":"),
            ),
            "_lines_sha256": "f" * 64,
        }

    def existing_records(self, binding: dict, candidate: dict) -> tuple[dict, dict]:
        milestone_id = f"qb:{binding['realm_id']}:Invoice:{binding['provider_invoice_id']}"
        milestone = {
            "doctype": "Payment Milestone",
            "name": milestone_id,
            "payment_milestone_id": milestone_id,
            "roof_job": binding["roof_job_id"],
            "shop_order": binding["shop_order_id"],
            "status": "Needs Review",
            "invoice_intent_id": binding["intent_id"],
            "billing_basis_sha256": binding["basis_sha256"],
            "billing_basis_json": candidate["_basis_json"],
            "realm_id": binding["realm_id"],
            "qb_entity_type": "Invoice",
            "qb_entity_id": binding["provider_invoice_id"],
            "provider_request_sha256": binding["provider_request_sha256"],
            "provider_create_response_sha256": binding["provider_create_response_sha256"],
            "provider_created_at": binding["provider_created_at"],
            "total_amount": candidate["commercial"]["total_amount"],
        }
        reconciliation_id = f"qfi:{binding['basis_sha256']}"
        reconciliation = {
            "doctype": "Integration Reconciliation",
            "name": reconciliation_id,
            "reconciliation_id": reconciliation_id,
            "invoice_intent_id": binding["intent_id"],
            "billing_basis_sha256": binding["basis_sha256"],
            "system_name": "QuickBooks",
            "entity_type": "Invoice",
            "realm_id": binding["realm_id"],
            "external_entity_id": binding["provider_invoice_id"],
            "provider_request_sha256": binding["provider_request_sha256"],
            "provider_create_response_sha256": binding["provider_create_response_sha256"],
            "provider_created_at": binding["provider_created_at"],
            "local_doctype": "Payment Milestone",
            "local_name": milestone_id,
            "status": "Pending",
        }
        return milestone, reconciliation

    def candidate_bundle(self) -> dict:
        terms_snapshot_json = json.dumps(
            {
                "schema": "ironwrap.customer-contract-terms.v2",
                "quote": {"qb_terms_ref": "99", "qb_terms_due_days": 7},
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        evidence = {
            name: {
                "name": name,
                "roof_job": "job-1",
                "evidence_type": "Signed Document",
                "proof_slot": "Contract" if name == "ev-accept" else "Completion",
                "r2_key": f"evidence/job-1/{name}.json",
                "content_checksum": character * 64,
                "checksum_algorithm": "SHA-256",
                "sync_state": "Verified",
                "verified_at": "2026-08-13T09:00:00Z",
            }
            for name, character in (("ev-accept", "1"), ("ev-complete", "2"))
        }
        return {
            "job": {
                "name": "job-1",
                "roof_job_id": "job-1",
                "customer": "customer-1",
                "quotation": "quote-1",
                "workflow_profile": "Residential Retail",
                "service_type": "Roofing",
                "job_status": "Completed",
                "qb_realm_id": None,
                "qb_invoice_ref": None,
            },
            "customer": {"name": "customer-1", "qb_customer_ref": "77"},
            "quotes": [
                {
                    "name": "quote-1",
                    "customer_quote_id": "cq-1",
                    "roof_job": "job-1",
                    "customer": "customer-1",
                    "quote_version": 3,
                    "status": "Accepted",
                    "subtotal": "100.00",
                    "tax_amount": "5.00",
                    "tax_code": "GST",
                    "tax_rate": "5.0000",
                    "tax_policy_snapshot_json": '{"province":"AB","rate":"5.0000"}',
                    "quote_total": "105.00",
                    "currency": "CAD",
                    "deposit_amount": "0.00",
                    "amount_paid": "0.00",
                    "qb_item_ref": "88",
                    "qb_tax_code_ref": "2",
                    "qb_terms_ref": "99",
                    "qb_terms_due_days": 7,
                    "approved_at": "2026-08-12T08:00:00Z",
                    "accepted_at": "2026-08-12T09:00:00Z",
                    "contract_acceptance": "accept-1",
                    "acceptance_evidence": "ev-accept",
                    "supersedes": None,
                }
            ],
            "acceptances": [
                {
                    "name": "accept-1",
                    "roof_job": "job-1",
                    "customer_quote": "quote-1",
                    "change_order": None,
                    "status": "Accepted",
                    "evidence_item": "ev-accept",
                    "accepted_at": "2026-08-12T09:00:00Z",
                    "contract_version": "cq-1:v3",
                    "terms_hash": hashlib.sha256(
                        terms_snapshot_json.encode("utf-8")
                    ).hexdigest(),
                    "terms_snapshot_json": terms_snapshot_json,
                }
            ],
            "completions": [
                {
                    "name": "completion-1",
                    "completion_packet_id": "cp-1",
                    "roof_job": "job-1",
                    "packet_version": 2,
                    "status": "Approved",
                    "prepared_at": "2026-08-13T08:00:00Z",
                    "approved_at": "2026-08-13T10:00:00Z",
                    "approved_by": "owner@example.invalid",
                    "photo_evidence_json": '["ev-complete"]',
                    "completion_evidence": "ev-complete",
                    "deficiency_list": "",
                    "deficiencies_resolved": 1,
                    "customer_signoff_ref": "signoff-1",
                    "warranty_ready": 1,
                    "evidence_summary_json": '{"completion":"ev-complete"}',
                }
            ],
            "changes": [],
            "shop_orders": [],
            "milestones": [],
            "evidence": evidence,
        }

    def load_api(
        self,
        *,
        session_user: str = "worker@ironwrapexteriors.com",
        request_method: str = "POST",
        can_create: bool = True,
        configured_issuer: str | None = "worker@ironwrapexteriors.com",
        roles: list[str] | None = None,
    ):
        save_log: list[tuple[str, dict]] = []
        docs: dict[tuple[str, str], dict] = {}
        issuance_snapshots: list[tuple[str, dict]] = []
        bind_snapshots: list[tuple[str, dict]] = []
        resolver_snapshots: list[tuple[str, dict]] = []

        @contextmanager
        def quickbooks_reconciliation_issuance_context(document):
            issuance_snapshots.append((str(document.get("doctype")), dict(document)))
            yield

        @contextmanager
        def quickbooks_final_invoice_bind_context(document):
            bind_snapshots.append((str(document.get("doctype")), dict(document)))
            yield

        @contextmanager
        def quickbooks_final_invoice_resolver_context(document):
            resolver_snapshots.append((str(document.get("doctype")), dict(document)))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.quickbooks_reconciliation_issuance_context = (
            quickbooks_reconciliation_issuance_context
        )
        validation_module.quickbooks_final_invoice_bind_context = (
            quickbooks_final_invoice_bind_context
        )
        validation_module.quickbooks_final_invoice_resolver_context = (
            quickbooks_final_invoice_resolver_context
        )
        access_module = types.ModuleType("ironwrap_roofing.access_control")
        access_module.QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE = (
            "IronWrap QuickBooks Reconciliation Issuer"
        )

        def get_doc(arg1, arg2=None):
            if isinstance(arg1, dict):
                doc = FakeDocument(arg1, save_log)
                docs[(str(doc.get("doctype")), str(doc["name"]))] = doc
                return doc
            key = (str(arg1), str(arg2))
            stored = docs.get(key)
            if stored is None:
                raise AssertionError(f"missing doc {key}")
            return FakeDocument(dict(stored), save_log)

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = types.SimpleNamespace(sql=lambda *args, **kwargs: [])
        frappe_module.conf = (
            {"ironwrap_quickbooks_reconciliation_issuer_user": configured_issuer}
            if configured_issuer is not None
            else {}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.local = types.SimpleNamespace(response={})
        frappe_module.has_permission = lambda *args, **kwargs: can_create
        frappe_module.get_roles = lambda _actor: (
            roles
            if roles is not None
            else ["IronWrap QuickBooks Reconciliation Issuer"]
        )
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.get_doc = get_doc
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))

        spec = importlib.util.spec_from_file_location(
            "ironwrap_quickbooks_final_invoice_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                "frappe": frappe_module,
                "ironwrap_roofing.document_validation": validation_module,
                "ironwrap_roofing.access_control": access_module,
            },
        ):
            assert spec.loader is not None
            spec.loader.exec_module(module)
        module._test_docs = docs
        module._test_save_log = save_log
        module._test_bind_snapshots = bind_snapshots
        module._test_resolver_snapshots = resolver_snapshots
        module._test_issuance_snapshots = issuance_snapshots
        module._test_frappe = frappe_module
        return module

    def assert_blocked(self, api, bundle: dict, code: str) -> None:
        with self.assertRaises(api.CandidateBlocked) as caught:
            api._build_candidate(bundle, realm_id="9130358252511540")
        self.assertEqual(caught.exception.code, code)

    def test_candidate_is_exact_non_pii_zero_prior_balance(self) -> None:
        api = self.load_api()
        candidate = api._build_candidate(
            self.candidate_bundle(), realm_id="9130358252511540"
        )

        self.assertEqual(candidate["qbo"]["realm_id"], "9130358252511540")
        self.assertEqual(candidate["commercial"]["subtotal"], "100.00")
        self.assertEqual(candidate["commercial"]["tax_amount"], "5.00")
        self.assertEqual(candidate["commercial"]["total_amount"], "105.00")
        self.assertEqual(candidate["commercial"]["already_invoiced"], "0.00")
        self.assertEqual(candidate["commercial"]["final_balance"], "105.00")
        self.assertEqual(candidate["commercial"]["invoice_date"], "2026-08-13")
        serialized = json.dumps(api._public_candidate(candidate)).lower()
        for pii in ("display_name", "address", "email", "notes", "owner@example.invalid"):
            self.assertNotIn(pii, serialized)
        self.assertTrue(
            any(
                citation.get("doctype") == "Customer Quote"
                for citation in candidate["basis"]["evidence"]
            )
        )

    def test_candidate_blocks_unaccepted_quote_even_with_acceptance_row(self) -> None:
        api = self.load_api()
        bundle = self.candidate_bundle()
        bundle["quotes"][0]["status"] = "Approved"
        self.assert_blocked(api, bundle, "quote_not_accepted")

    def test_candidate_blocks_prior_billing_and_missing_mapping(self) -> None:
        api = self.load_api()
        for mutate in (
            lambda bundle: bundle["quotes"][0].__setitem__("deposit_amount", "1.00"),
            lambda bundle: bundle["quotes"][0].__setitem__("amount_paid", "1.00"),
            lambda bundle: bundle["milestones"].append(
                {"milestone_type": "Invoice", "status": "Needs Review", "invoice_intent_id": "other"}
            ),
        ):
            with self.subTest(mutate=mutate):
                bundle = self.candidate_bundle()
                mutate(bundle)
                self.assert_blocked(api, bundle, "unsupported_prior_billing_basis")
        bundle = self.candidate_bundle()
        bundle["quotes"][0]["qb_tax_code_ref"] = None
        self.assert_blocked(api, bundle, "missing_quickbooks_mapping")

    def test_candidate_blocks_legacy_or_stale_completion_and_change_ambiguity(self) -> None:
        api = self.load_api()
        bundle = self.candidate_bundle()
        bundle["completions"][0]["packet_version"] = None
        self.assert_blocked(api, bundle, "completion_version_missing")

        bundle = self.candidate_bundle()
        bundle["changes"] = [
            {
                "name": "change-1",
                "change_order_id": "co-1",
                "roof_job": "job-1",
                "customer_quote": "quote-1",
                "change_number": "1",
                "version": 1,
                "status": "Accepted",
                "currency": "CAD",
                "subtotal": "10.00",
                "tax_amount": "0.50",
                "tax_code": "GST",
                "tax_rate": "5.0000",
                "tax_policy_snapshot_json": '{"province":"AB","rate":"5.0000"}',
                "total_amount": "10.50",
                "contract_acceptance": "accept-change-1",
                "accepted_at": "2026-08-14T09:00:00Z",
                "supersedes": None,
            }
        ]
        bundle["acceptances"].append(
            {
                "name": "accept-change-1",
                "roof_job": "job-1",
                "customer_quote": None,
                "change_order": "change-1",
                "status": "Accepted",
                "evidence_item": "ev-accept",
                "accepted_at": "2026-08-14T09:00:00Z",
            }
        )
        self.assert_blocked(api, bundle, "stale_completion_packet")

        bundle = self.candidate_bundle()
        bundle["changes"] = [{"name": "change-1", "change_order_id": "co-1", "version": "not-int", "status": "Accepted"}]
        self.assert_blocked(api, bundle, "invalid_change_version")

    def test_candidate_requires_exact_handed_over_shop_evidence(self) -> None:
        api = self.load_api()
        bundle = self.candidate_bundle()
        bundle["job"]["service_type"] = "Metal Roofing"
        self.assert_blocked(api, bundle, "shop_order_missing")
        bundle["shop_orders"] = [
            {
                "name": "shop-1",
                "shop_order_id": "shop-1",
                "roof_job": "job-1",
                "status": "Ready",
                "handed_over_at": None,
                "handoff_evidence": None,
            }
        ]
        self.assert_blocked(api, bundle, "shop_not_handed_over")

    def test_list_requires_service_post_role_permission_and_active_realm(self) -> None:
        cases = [
            ({"session_user": "human@example.invalid"}, "issuer_auth_mismatch"),
            ({"request_method": "GET"}, "post_required"),
            ({"roles": ["IronWrap Finance"]}, "issuer_role_missing"),
        ]
        for kwargs, code in cases:
            with self.subTest(code=code):
                api = self.load_api(**kwargs)
                with self.assertRaisesRegex(FakePermissionError, code):
                    api.list_candidates(json.dumps({"limit": 1, "realm_id": "9130358252511540"}))
        api = self.load_api()
        with self.assertRaisesRegex(FakeValidationError, "realm_id is required"):
            api.list_candidates(json.dumps({"limit": 1}))

    def test_bind_replay_allows_current_intent_and_returns_idempotent_replay(self) -> None:
        api = self.load_api()
        binding = self.binding_payload()
        candidate = self.candidate(binding)
        milestone, reconciliation = self.existing_records(binding, candidate)
        api._load_bundle = lambda roof_job_id, lock=False: {"roof_job_id": roof_job_id, "lock": lock}
        seen_allow_bound: list[str | None] = []

        def fake_build_candidate(bundle, *, realm_id=None, allow_bound_intent=None):
            seen_allow_bound.append(allow_bound_intent)
            self.assertTrue(bundle["lock"])
            self.assertEqual(realm_id, binding["realm_id"])
            if allow_bound_intent != binding["intent_id"]:
                raise api.CandidateBlocked(
                    "unsupported_prior_billing_basis",
                    "already bound invoice should be replay-safe",
                )
            return candidate

        api._build_candidate = fake_build_candidate
        api._locked_bind_rows = lambda _binding: ([milestone], [reconciliation])
        api._test_docs[("Roof Job", "job-1")] = FakeDocument(
            {
                "doctype": "Roof Job",
                "name": "job-1",
                "roof_job_id": "job-1",
                "qb_realm_id": binding["realm_id"],
                "qb_invoice_ref": binding["provider_invoice_id"],
            },
            api._test_save_log,
        )

        result = api.bind_provider_invoice(json.dumps(binding))

        self.assertEqual(seen_allow_bound, [binding["intent_id"]])
        self.assertTrue(result["idempotent_replay"])
        self.assertEqual(result["payment_milestone_id"], milestone["payment_milestone_id"])
        self.assertEqual(api._test_save_log, [])

    def test_bind_creates_milestone_reconciliation_and_job_in_bounded_contexts(self) -> None:
        api = self.load_api()
        bundle = self.candidate_bundle()
        candidate = api._build_candidate(bundle, realm_id="9130358252511540")
        binding = {
            "intent_id": candidate["basis"]["intent_id"],
            "basis_sha256": candidate["basis"]["basis_sha256"],
            "completion_packet_id": candidate["basis"]["completion_packet_id"],
            "completion_version": candidate["basis"]["completion_version"],
            "completion_sha256": candidate["basis"]["completion_sha256"],
            "customer_quote_id": candidate["basis"]["customer_quote_id"],
            "quote_version": candidate["basis"]["quote_version"],
            "quote_sha256": candidate["basis"]["quote_sha256"],
            "changes_sha256": candidate["basis"]["changes_sha256"],
            "roof_job_id": "job-1",
            "shop_order_id": None,
            "realm_id": "9130358252511540",
            "provider_invoice_id": "801",
            "provider_request_sha256": "3" * 64,
            "provider_create_response_sha256": "4" * 64,
            "provider_created_at": "2026-08-13T11:00:00Z",
        }
        api._load_bundle = lambda roof_job_id, lock=False: bundle
        api._locked_bind_rows = lambda _binding: ([], [])
        api._test_docs[("Roof Job", "job-1")] = FakeDocument(
            {"doctype": "Roof Job", "name": "job-1", "roof_job_id": "job-1", "qb_realm_id": None, "qb_invoice_ref": None},
            api._test_save_log,
        )

        result = api.bind_provider_invoice(json.dumps(binding))

        self.assertFalse(result["idempotent_replay"])
        self.assertEqual([action for action, _doc in api._test_save_log], ["insert", "insert", "save"])
        self.assertEqual(
            [doctype for doctype, _snapshot in api._test_bind_snapshots],
            ["Payment Milestone", "Integration Reconciliation", "Roof Job"],
        )
        self.assertEqual(len(api._test_issuance_snapshots), 1)
        milestone = api._test_save_log[0][1]
        reconciliation = api._test_save_log[1][1]
        job = api._test_save_log[2][1]
        self.assertEqual(milestone["status"], "Needs Review")
        self.assertEqual(reconciliation["status"], "Pending")
        self.assertEqual(job["qb_invoice_ref"], "801")
        self.assertEqual(job["qb_realm_id"], "9130358252511540")

    def test_bind_changed_identity_is_conflict_before_writes(self) -> None:
        api = self.load_api()
        binding = self.binding_payload()
        candidate = self.candidate(binding)
        milestone, reconciliation = self.existing_records(binding, candidate)
        milestone["provider_create_response_sha256"] = "7" * 64
        api._load_bundle = lambda roof_job_id, lock=False: {}
        api._build_candidate = lambda bundle, *, realm_id=None, allow_bound_intent=None: candidate
        api._locked_bind_rows = lambda _binding: ([milestone], [reconciliation])

        with self.assertRaisesRegex(FakeValidationError, "identity_conflict"):
            api.bind_provider_invoice(json.dumps(binding))
        self.assertEqual(api._test_frappe.local.response["http_status_code"], 409)
        self.assertEqual(api._test_save_log, [])

    def resolver_fixture(self, api, *, status: str = "Unverified", balance: str = "105.00"):
        binding = self.binding_payload()
        candidate = self.candidate(binding)
        milestone, reconciliation = self.existing_records(binding, candidate)
        api._test_docs[("Payment Milestone", milestone["name"])] = FakeDocument(
            milestone, api._test_save_log
        )
        api._test_docs[("Integration Reconciliation", reconciliation["name"])] = FakeDocument(
            reconciliation, api._test_save_log
        )
        api._locked_bind_rows = lambda _binding: ([milestone], [reconciliation])
        api._build_candidate = lambda bundle, *, realm_id=None, allow_bound_intent=None: candidate
        api._load_bundle = lambda roof_job_id, lock=False: {}
        readback = {
            **binding,
            "customer_id": candidate["qbo"]["customer_id"],
            "item_id": candidate["qbo"]["item_id"],
            "tax_code_id": candidate["qbo"]["tax_code_id"],
            "terms_id": candidate["qbo"]["terms_id"],
            "currency": candidate["commercial"]["currency"],
            "subtotal": candidate["commercial"]["subtotal"],
            "tax_amount": candidate["commercial"]["tax_amount"],
            "total_amount": candidate["commercial"]["total_amount"],
            "balance_due": balance,
            "lines_sha256": candidate["_lines_sha256"],
            "tax_rate": candidate["commercial"]["tax_rate"],
            "invoice_date": candidate["commercial"]["invoice_date"],
            "due_date": candidate["commercial"]["due_date"],
            "payment_status": status,
            "provider_readback_sha256": "9" * 64,
            "provider_read_at": "2026-08-13T11:00:00Z",
        }
        return candidate, milestone, reconciliation, readback

    def test_resolver_matches_exact_paid_partial_and_unverified_observations(self) -> None:
        for status, balance, paid in (
            ("Unverified", "105.00", "0.00"),
            ("Partially Paid", "40.00", "65.00"),
            ("Paid", "0.00", "105.00"),
        ):
            with self.subTest(status=status):
                api = self.load_api()
                _candidate, _milestone, _reconciliation, readback = self.resolver_fixture(
                    api, status=status, balance=balance
                )
                result = api.resolve_provider_invoice_readback(json.dumps(readback))
                self.assertEqual(result["outcome"], "Matched")
                self.assertEqual(api._test_save_log[0][1]["amount_paid"], paid)
                self.assertEqual(api._test_save_log[0][1]["truth_source"], "QuickBooks")
                self.assertEqual(api._test_save_log[1][1]["status"], "Matched")
                self.assertEqual(
                    [doctype for doctype, _snapshot in api._test_resolver_snapshots],
                    ["Payment Milestone", "Integration Reconciliation"],
                )

    def test_resolver_drift_and_invalid_settlement_never_match(self) -> None:
        variants = (
            ("terms_id", "100", "Mismatch"),
            ("tax_amount", "5.01", "Mismatch"),
            ("total_amount", "105.01", "Mismatch"),
            ("lines_sha256", "7" * 64, "Mismatch"),
            ("tax_rate", "5.0001", "Mismatch"),
            ("invoice_date", "2026-08-12", "Mismatch"),
            ("due_date", "2026-08-21", "Mismatch"),
            ("payment_status", "Voided", "Mismatch"),
        )
        for field, value, outcome in variants:
            with self.subTest(field=field):
                api = self.load_api()
                _candidate, _milestone, _reconciliation, readback = self.resolver_fixture(api)
                readback[field] = value
                result = api.resolve_provider_invoice_readback(json.dumps(readback))
                self.assertEqual(result["outcome"], outcome)
                self.assertNotEqual(api._test_save_log[0][1]["status"], "Matched")
                self.assertEqual(api._test_save_log[1][1]["status"], "Mismatch")

        api = self.load_api()
        _candidate, _milestone, _reconciliation, readback = self.resolver_fixture(
            api, status="Paid", balance="1.00"
        )
        self.assertEqual(
            api.resolve_provider_invoice_readback(json.dumps(readback))["outcome"],
            "Mismatch",
        )

        api = self.load_api()
        _candidate, _milestone, _reconciliation, readback = self.resolver_fixture(api)
        readback["payment_status"] = "UNKNOWN_PROVIDER_VALUE"
        with self.assertRaisesRegex(FakeValidationError, "payment_status"):
            api.resolve_provider_invoice_readback(json.dumps(readback))
        self.assertEqual(api._test_save_log, [])

    def test_resolver_stale_current_basis_stays_pending(self) -> None:
        api = self.load_api()
        candidate, _milestone, _reconciliation, readback = self.resolver_fixture(api)
        stale = {**candidate, "basis": {**candidate["basis"], "quote_version": 4}}
        api._build_candidate = lambda bundle, *, realm_id=None, allow_bound_intent=None: stale

        result = api.resolve_provider_invoice_readback(json.dumps(readback))

        self.assertEqual(result["outcome"], "Pending")
        self.assertEqual(result["reason_code"], "stale_frappe_basis")
        self.assertNotEqual(api._test_save_log[0][1]["status"], "Matched")

    def test_resolver_changed_duplicate_timestamp_or_hash_conflicts(self) -> None:
        api = self.load_api()
        candidate, milestone, reconciliation, readback = self.resolver_fixture(
            api, status="Paid", balance="0.00"
        )
        facts = {field: readback[field] for field in sorted(api.READBACK_ONLY_FIELDS)}
        milestone.update(
            {
                "status": "Matched",
                "provider_readback_sha256": readback["provider_readback_sha256"],
                "provider_facts_sha256": api._sha256(facts),
                "provider_read_at": readback["provider_read_at"],
            }
        )
        reconciliation.update(
            {
                "status": "Matched",
                "provider_readback_sha256": readback["provider_readback_sha256"],
                "provider_facts_sha256": api._sha256(facts),
                "provider_read_at": readback["provider_read_at"],
            }
        )
        api._locked_bind_rows = lambda _binding: ([milestone], [reconciliation])
        replay = api.resolve_provider_invoice_readback(json.dumps(readback))
        self.assertTrue(replay["idempotent_replay"])

        for field, value in (
            ("provider_read_at", "2026-08-13T11:00:01Z"),
            ("provider_readback_sha256", "7" * 64),
        ):
            with self.subTest(field=field):
                changed = {**readback, field: value}
                with self.assertRaisesRegex(FakeValidationError, "changed duplicate"):
                    api.resolve_provider_invoice_readback(json.dumps(changed))

    def test_resolve_replay_reuses_prior_matched_outcome_without_mutation(self) -> None:
        api = self.load_api()
        binding = self.binding_payload()
        candidate = self.candidate(binding)
        milestone, reconciliation = self.existing_records(binding, candidate)
        milestone.update(
            {
                "status": "Matched",
                "provider_readback_sha256": "9" * 64,
                "provider_facts_sha256": "8" * 64,
                "provider_read_at": "2026-08-13T11:00:00Z",
            }
        )
        reconciliation.update(
            {
                "status": "Matched",
                "provider_readback_sha256": "9" * 64,
                "provider_facts_sha256": "8" * 64,
                "provider_read_at": "2026-08-13T11:00:00Z",
            }
        )
        api._locked_bind_rows = lambda _binding: ([milestone], [reconciliation])
        api._build_candidate = lambda bundle, *, realm_id=None, allow_bound_intent=None: candidate
        api._load_bundle = lambda roof_job_id, lock=False: {"roof_job_id": roof_job_id, "lock": lock}
        api._sha256 = lambda value: "8" * 64 if value == {field: readback[field] for field in sorted(api.READBACK_ONLY_FIELDS)} else "unreachable"

        readback = {
            **binding,
            "customer_id": candidate["qbo"]["customer_id"],
            "item_id": candidate["qbo"]["item_id"],
            "tax_code_id": candidate["qbo"]["tax_code_id"],
            "terms_id": candidate["qbo"]["terms_id"],
            "currency": candidate["commercial"]["currency"],
            "subtotal": candidate["commercial"]["subtotal"],
            "tax_amount": candidate["commercial"]["tax_amount"],
            "total_amount": candidate["commercial"]["total_amount"],
            "balance_due": "0.00",
            "lines_sha256": candidate["_lines_sha256"],
            "tax_rate": candidate["commercial"]["tax_rate"],
            "invoice_date": candidate["commercial"]["invoice_date"],
            "due_date": candidate["commercial"]["due_date"],
            "payment_status": "Paid",
            "provider_readback_sha256": "9" * 64,
            "provider_read_at": "2026-08-13T11:00:00Z",
        }

        result = api.resolve_provider_invoice_readback(json.dumps(readback))

        self.assertEqual(result["outcome"], "Matched")
        self.assertTrue(result["idempotent_replay"])
        self.assertEqual(api._test_save_log, [])


if __name__ == "__main__":
    unittest.main()
