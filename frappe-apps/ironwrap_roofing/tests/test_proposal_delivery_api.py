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
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "proposal_delivery_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDoc(dict):
    def __init__(self, values: dict) -> None:
        super().__init__(values)
        object.__setattr__(self, "save_count", 0)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name == "save_count":
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def save(self) -> None:
        self.save_count += 1


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabHermes Run`" in normalized:
            run = self.fixtures["run"]
            return [dict(run)] if run.get("name") == values[0] else []
        if "`tabProposal Evidence Pack`" in normalized:
            pack = self.fixtures["pack"]
            return [{"name": pack["name"]}] if pack["name"] == values[0] else []
        raise AssertionError(f"unexpected SQL: {normalized}")


class ProposalDeliveryApiTests(unittest.TestCase):
    def fixture_data(self) -> dict:
        return {
            "pack": FakeDoc(
                {
                    "name": "proposal:cq-1",
                    "pack_id": "proposal:cq-1",
                    "roof_job": "job-1",
                    "quotation": "cq-1",
                    "status": "Draft",
                    "approved_by": "",
                    "approved_at": "",
                    "customer_message": "must remain untouched",
                }
            ),
            "run": {
                "name": "run-proposal-publication-0001",
                "run_id": "run-proposal-publication-0001",
                "agent_role": "Owner Operator",
                "requested_by": "owner@example.com",
                "target_doctype": "Proposal Evidence Pack",
                "target_name": "proposal:cq-1",
                "roof_job": "job-1",
                "capability_level": "Approved-write",
                "tool_name": "request_publish_proposal_evidence_pack",
                "tool_args_json": json.dumps(
                    {
                        "proposal_evidence_pack_id": "proposal:cq-1",
                        "request_text": "Publish the reviewed proposal evidence pack to the private portal.",
                        "approved_by": "owner@example.com",
                        "run_id": "run-proposal-publication-0001",
                    }
                ),
                "dry_run_receipt": "signed-dry-run-receipt",
                "approval_receipt": "signed-approval-receipt",
                "policy_check_json": json.dumps(
                    {
                        "allowed": True,
                        "target": {
                            "doctype": "Proposal Evidence Pack",
                            "name": "proposal:cq-1",
                        },
                    }
                ),
                "approval_status": "Approved",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-17 10:00:00",
                "mutation_applied": 0,
            },
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "owner@example.com",
        request_method: str = "POST",
        can_write: bool = True,
    ):
        fixtures = fixtures or self.fixture_data()
        db = FakeDb(fixtures)
        context_calls: list[tuple[str, str, str, str]] = []

        @contextmanager
        def proposal_publication_context(*args):
            context_calls.append(args)
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.proposal_publication_context = proposal_publication_context
        approval_module = types.ModuleType("ironwrap_roofing.approval_receipt")

        class FakeApprovalReceiptError(Exception):
            def __init__(self, code: str) -> None:
                self.code = code
                super().__init__(code)

        def assert_approved_hermes_run_receipt(run, **_kwargs) -> None:
            if run.get("receipt_error"):
                raise FakeApprovalReceiptError(run["receipt_error"])

        approval_module.ApprovalReceiptError = FakeApprovalReceiptError
        approval_module.assert_approved_hermes_run_receipt = (
            assert_approved_hermes_run_receipt
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-17 10:01:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_write
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.get_doc = lambda doctype, name: (
            fixtures["pack"]
            if doctype == "Proposal Evidence Pack" and name == fixtures["pack"]["name"]
            else (_ for _ in ()).throw(
                AssertionError(f"unexpected get_doc: {doctype} {name}")
            )
        )

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_proposal_delivery_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                "frappe": frappe_module,
                "ironwrap_roofing.approval_receipt": approval_module,
                "ironwrap_roofing.document_validation": validation_module,
            },
        ):
            spec.loader.exec_module(module)
        return module, fixtures, db, context_calls

    def call(self, api, **overrides):
        values = {
            "proposal_evidence_pack_id": "proposal:cq-1",
            "hermes_run_id": "run-proposal-publication-0001",
        }
        values.update(overrides)
        return api.publish_proposal_evidence_pack(**values)

    def test_command_locks_and_derives_the_exact_approved_publication(self) -> None:
        api, fixtures, db, context_calls = self.load_api()

        result = self.call(api)

        pack = fixtures["pack"]
        self.assertEqual(result["hermes_run_id"], "run-proposal-publication-0001")
        self.assertEqual(result["proposal_evidence_pack"]["status"], "Approved")
        self.assertEqual(result["proposal_evidence_pack"]["approved_by"], "owner@example.com")
        self.assertEqual(result["proposal_evidence_pack"]["approved_at"], "2026-07-17 10:01:00")
        self.assertEqual(pack["quotation"], "cq-1")
        self.assertEqual(pack["customer_message"], "must remain untouched")
        self.assertEqual(pack.save_count, 1)
        self.assertEqual(
            context_calls,
            [
                (
                    "proposal:cq-1",
                    "run-proposal-publication-0001",
                    "owner@example.com",
                    "2026-07-17 10:01:00",
                )
            ],
        )
        self.assertTrue(any("`tabHermes Run`" in query for query in db.lock_queries))
        self.assertTrue(
            any("`tabProposal Evidence Pack`" in query for query in db.lock_queries)
        )

    def test_command_rejects_wrong_requester_or_signed_args(self) -> None:
        api, fixtures, _, _ = self.load_api(session_user="support@example.com")
        with self.assertRaisesRegex(FakePermissionError, "requester_mismatch"):
            self.call(api)
        self.assertEqual(fixtures["pack"].save_count, 0)

    def test_command_rejects_missing_expired_or_mismatched_signed_capability(self) -> None:
        fixtures = self.fixture_data()
        fixtures["run"]["receipt_error"] = "expired"
        api, fixtures, _, _ = self.load_api(fixtures)

        with self.assertRaisesRegex(FakeValidationError, "approval_receipt_expired"):
            self.call(api)
        self.assertEqual(fixtures["pack"].save_count, 0)

        fixtures = self.fixture_data()
        approved_args = json.loads(fixtures["run"]["tool_args_json"])
        approved_args["proposal_evidence_pack_id"] = "proposal:other"
        fixtures["run"]["tool_args_json"] = json.dumps(approved_args)
        api, fixtures, _, _ = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "approved_args_mismatch"):
            self.call(api)
        self.assertEqual(fixtures["pack"].save_count, 0)

    def test_command_requires_post_permissions_and_exact_draft_state(self) -> None:
        api, fixtures, _, _ = self.load_api(request_method="GET")
        with self.assertRaisesRegex(FakePermissionError, "post_required"):
            self.call(api)
        self.assertEqual(fixtures["pack"].save_count, 0)

        api, fixtures, _, _ = self.load_api(can_write=False)
        with self.assertRaisesRegex(FakePermissionError, "permission_denied"):
            self.call(api)
        self.assertEqual(fixtures["pack"].save_count, 0)

        for status in (None, "", "Ready", "Approved", "Sent", "Signed"):
            with self.subTest(status=status):
                fixtures = self.fixture_data()
                fixtures["pack"]["status"] = status
                api, fixtures, _, context_calls = self.load_api(fixtures)
                with self.assertRaisesRegex(
                    FakeValidationError, "proposal_publication_not_preparable"
                ):
                    self.call(api)
                self.assertEqual(fixtures["pack"].save_count, 0)
                self.assertEqual(context_calls, [])


if __name__ == "__main__":
    unittest.main()
