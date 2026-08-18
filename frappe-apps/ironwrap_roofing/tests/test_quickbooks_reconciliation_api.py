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
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "quickbooks_reconciliation_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


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
        self["name"] = self["reconciliation_id"]
        self._on_insert(self)


class FakeDb:
    def __init__(self, fixtures: list[dict]) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []
        self.read_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "`tabIntegration Reconciliation`" not in normalized:
            raise AssertionError(f"unexpected SQL: {normalized}")
        if "FOR UPDATE" in normalized:
            self.lock_queries.append(normalized)
        else:
            self.read_queries.append(normalized)
        return [
            dict(row)
            for row in self.fixtures
            if row.get("reconciliation_id") == values[0]
        ]


class QuickBooksReconciliationApiTests(unittest.TestCase):
    def payload(self) -> dict:
        return {
            "reconciliation_id": f"qbr:{'a' * 64}:0",
            "system_name": "QuickBooks",
            "entity_type": "Payment",
            "external_entity_id": "7",
            "local_doctype": "Unresolved QuickBooks Event",
            "local_name": f"qbr:{'a' * 64}:0",
            "direction": "Inbound",
            "status": "Pending",
            "detected_at": "2026-07-31 10:00:00",
            "raw_key": "raw/quickbooks/2026-07-31/ow_test.json",
            "source_version": "Create",
            "source_payload_hash": "a" * 64,
            "local_payload_hash": "b" * 64,
            "attempt_count": 0,
        }

    def load_api(
        self,
        fixtures: list[dict] | None = None,
        *,
        session_user: str = "worker@ironwrapexteriors.com",
        request_method: str = "POST",
        can_create: bool = True,
        configured_issuer: str | None = "worker@ironwrapexteriors.com",
        roles: list[str] | None = None,
    ):
        db = FakeDb(fixtures or [])
        issuance_calls: list[dict] = []

        @contextmanager
        def quickbooks_reconciliation_issuance_context(document):
            issuance_calls.append(dict(document))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.quickbooks_reconciliation_issuance_context = (
            quickbooks_reconciliation_issuance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
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
        frappe_module.get_doc = lambda values: FakeDocument(
            values, lambda _document: None
        )
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(
            exc(message)
        )
        spec = importlib.util.spec_from_file_location(
            "ironwrap_quickbooks_reconciliation_api_under_test", API_PATH
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
        module._test_frappe = frappe_module
        return module, db, issuance_calls

    def issue(self, api, payload: dict) -> dict:
        return api.issue_pending_reconciliation(json.dumps(payload))

    def test_issues_only_pending_work_through_private_context(self) -> None:
        api, db, issuance_calls = self.load_api()
        result = self.issue(api, self.payload())

        self.assertEqual(result["name"], self.payload()["reconciliation_id"])
        self.assertFalse(result["idempotent_replay"])
        self.assertEqual(len(issuance_calls), 1)
        self.assertEqual(issuance_calls[0]["status"], "Pending")
        self.assertEqual(issuance_calls[0]["notes"], api.PENDING_NOTES)
        self.assertEqual(len(db.lock_queries), 1)

    def test_rejects_unconfigured_or_non_worker_issuer_before_document_creation(self) -> None:
        for kwargs, code in [
            ({"configured_issuer": None}, "quickbooks_reconciliation_issuer_not_configured"),
            ({"session_user": "support@example.com"}, "quickbooks_reconciliation_issuer_auth_mismatch"),
            ({"roles": ["IronWrap Finance"]}, "quickbooks_reconciliation_issuer_role_missing"),
            ({"can_create": False}, "quickbooks_reconciliation_issuer_permission_denied"),
            ({"request_method": "GET"}, "quickbooks_reconciliation_post_required"),
        ]:
            with self.subTest(code=code):
                api, _db, issuance_calls = self.load_api(**kwargs)
                with self.assertRaisesRegex(FakePermissionError, code):
                    self.issue(api, self.payload())
                self.assertEqual(issuance_calls, [])

    def test_rejects_matched_or_provider_truth_payloads_at_the_issuer_boundary(self) -> None:
        api, _db, issuance_calls = self.load_api()
        forged = {**self.payload(), "status": "Matched"}
        with self.assertRaisesRegex(FakeValidationError, "quickbooks_initial_status_must_be_pending"):
            self.issue(api, forged)
        self.assertEqual(issuance_calls, [])

    def test_readiness_requires_the_same_authenticated_dedicated_issuer(self) -> None:
        api, _db, _issuance_calls = self.load_api()
        self.assertEqual(
            api.check_issuer_readiness(),
            {"ready": True, "issuer": "worker@ironwrapexteriors.com"},
        )
        unconfigured, _db, _issuance_calls = self.load_api(configured_issuer=None)
        with self.assertRaisesRegex(
            FakePermissionError, "quickbooks_reconciliation_issuer_not_configured"
        ):
            unconfigured.check_issuer_readiness()

    def test_readback_is_bounded_and_does_not_require_generic_create_permission(self) -> None:
        payload = self.payload()
        api, db, _issuance_calls = self.load_api(
            [{
                "name": payload["reconciliation_id"],
                **payload,
                "notes": "Webhook identity captured. Provider amount, status, posting, and reconciliation facts require an authenticated QuickBooks read.",
            }],
            can_create=False,
        )
        result = api.read_pending_reconciliation(payload["reconciliation_id"])

        self.assertTrue(result["found"])
        self.assertEqual(result["reconciliation"]["name"], payload["reconciliation_id"])
        self.assertEqual(result["reconciliation"]["status"], "Pending")
        self.assertEqual(db.lock_queries, [])
        self.assertEqual(len(db.read_queries), 1)

        missing = api.read_pending_reconciliation(f"qbr:{'b' * 64}:0")
        self.assertEqual(missing, {"found": False, "reconciliation_id": f"qbr:{'b' * 64}:0"})

    def test_rejects_caller_supplied_notes_and_sets_the_stable_conflict_status(self) -> None:
        api, _db, issuance_calls = self.load_api()
        with self.assertRaisesRegex(
            FakeValidationError, "quickbooks_reconciliation_invalid_input"
        ):
            self.issue(api, {**self.payload(), "notes": "forged upstream note"})
        self.assertEqual(issuance_calls, [])

        payload = self.payload()
        conflict, _db, _issuance_calls = self.load_api(
            [{"name": payload["reconciliation_id"], **payload, "notes": api.PENDING_NOTES}]
        )
        with self.assertRaisesRegex(
            FakeValidationError, "quickbooks_reconciliation_identity_conflict"
        ):
            self.issue(conflict, {**payload, "local_payload_hash": "c" * 64})
        self.assertEqual(conflict._test_frappe.local.response["http_status_code"], 409)

    def test_exact_pending_replay_is_idempotent_but_conflicting_identity_is_rejected(self) -> None:
        payload = self.payload()
        api, _db, issuance_calls = self.load_api(
            [
                {
                    "name": payload["reconciliation_id"],
                    **payload,
                    "notes": "Webhook identity captured. Provider amount, status, posting, and reconciliation facts require an authenticated QuickBooks read.",
                }
            ]
        )
        replay = self.issue(api, payload)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(issuance_calls, [])

        with self.assertRaisesRegex(
            FakeValidationError, "quickbooks_reconciliation_identity_conflict"
        ):
            self.issue(api, {**payload, "local_payload_hash": "c" * 64})


if __name__ == "__main__":
    unittest.main()
