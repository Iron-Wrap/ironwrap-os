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
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "lead_triage_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDoc(dict):
    def __init__(self, values: dict) -> None:
        super().__init__(values)
        object.__setattr__(self, "save_count", 0)
        object.__setattr__(self, "save_kwargs", [])

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name in {"save_count", "save_kwargs"}:
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def save(self, **kwargs) -> None:
        self.save_count += 1
        self.save_kwargs.append(kwargs)


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
        if "`tabLead Envelope`" in normalized:
            envelope = self.fixtures["envelope"]
            return [{"name": envelope["name"]}] if envelope["name"] == values[0] else []
        raise AssertionError(f"unexpected SQL: {normalized}")


class LeadTriageApiTests(unittest.TestCase):
    def fixture_data(self) -> dict:
        return {
            "envelope": FakeDoc(
                {
                    "name": "lead:1",
                    "envelope_id": "lead:1",
                    "status": "pushed",
                    "triage_status": "Untriaged",
                    "triaged_by": "",
                    "triaged_at": "",
                    "triage_summary": "",
                }
            ),
            "run": {
                "name": "run-lead-triage-0001",
                "run_id": "run-lead-triage-0001",
                "agent_role": "Lead Concierge",
                "requested_by": "concierge@example.com",
                "target_doctype": "Lead Envelope",
                "target_name": "lead:1",
                "lead_envelope": "lead:1",
                "capability_level": "Approved-write",
                "tool_name": "request_mark_lead_triaged",
                "tool_args_json": json.dumps(
                    {
                        "lead_envelope_id": "lead:1",
                        "triage_summary": "Urgent active leak; verify address before outreach.",
                        "request_text": "Approve the completed lead qualification.",
                        "approved_by": "owner@example.com",
                        "run_id": "run-lead-triage-0001",
                    }
                ),
                "dry_run_json": "{}",
                "policy_check_json": json.dumps(
                    {
                        "allowed": True,
                        "target": {"doctype": "Lead Envelope", "name": "lead:1"},
                    }
                ),
                "approval_status": "Approved",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-10 18:00:00",
                "mutation_applied": 0,
                "result_status": "",
            },
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "concierge@example.com",
        request_method: str = "POST",
        can_write: bool = True,
    ):
        fixtures = fixtures or self.fixture_data()
        db = FakeDb(fixtures)
        context_calls: list[tuple[str, str, str, str, str]] = []

        @contextmanager
        def lead_triage_transition_context(*args):
            context_calls.append(args)
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.lead_triage_transition_context = (
            lead_triage_transition_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-10 18:01:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_write
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.get_doc = lambda doctype, name: (
            fixtures["envelope"]
            if doctype == "Lead Envelope" and name == fixtures["envelope"]["name"]
            else (_ for _ in ()).throw(
                AssertionError(f"unexpected get_doc: {doctype} {name}")
            )
        )

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_lead_triage_api_under_test", API_PATH
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
        return module, fixtures, db, context_calls

    def call(self, api, **overrides):
        values = {
            "lead_envelope_id": "lead:1",
            "hermes_run_id": "run-lead-triage-0001",
        }
        values.update(overrides)
        return api.mark_lead_triaged(**values)

    def test_command_locks_and_derives_the_exact_approved_triage(self) -> None:
        api, fixtures, db, context_calls = self.load_api()

        result = self.call(api)

        envelope = fixtures["envelope"]
        self.assertEqual(result["hermes_run_id"], "run-lead-triage-0001")
        self.assertEqual(result["lead_envelope"]["triage_status"], "Triaged")
        self.assertEqual(result["lead_envelope"]["triaged_by"], "owner@example.com")
        self.assertEqual(result["lead_envelope"]["triaged_at"], "2026-07-10 18:01:00")
        self.assertEqual(
            result["lead_envelope"]["triage_summary"],
            "Urgent active leak; verify address before outreach.",
        )
        self.assertEqual(envelope.save_count, 1)
        self.assertEqual(envelope.save_kwargs, [{}])
        self.assertEqual(
            context_calls,
            [
                (
                    "lead:1",
                    "run-lead-triage-0001",
                    "owner@example.com",
                    "2026-07-10 18:01:00",
                    "Urgent active leak; verify address before outreach.",
                )
            ],
        )
        self.assertTrue(any("`tabHermes Run`" in query for query in db.lock_queries))
        self.assertTrue(any("`tabLead Envelope`" in query for query in db.lock_queries))

    def test_command_rejects_other_user_or_nonmatching_approved_run(self) -> None:
        api, fixtures, _, _ = self.load_api(session_user="support@example.com")
        with self.assertRaisesRegex(FakePermissionError, "requester_mismatch"):
            self.call(api)
        self.assertEqual(fixtures["envelope"].save_count, 0)

        fixtures = self.fixture_data()
        fixtures["run"]["tool_args_json"] = json.dumps(
            {
                "lead_envelope_id": "lead:other",
                "triage_summary": "Urgent active leak; verify address before outreach.",
                "request_text": "Approve the completed lead qualification.",
                "approved_by": "owner@example.com",
                "run_id": "run-lead-triage-0001",
            }
        )
        api, fixtures, _, _ = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "approved_args_mismatch"):
            self.call(api)
        self.assertEqual(fixtures["envelope"].save_count, 0)

    def test_command_requires_post_and_both_write_permissions(self) -> None:
        api, fixtures, _, _ = self.load_api(request_method="GET")
        with self.assertRaisesRegex(FakePermissionError, "post_required"):
            self.call(api)
        self.assertEqual(fixtures["envelope"].save_count, 0)

        api, fixtures, _, _ = self.load_api(can_write=False)
        with self.assertRaisesRegex(FakePermissionError, "permission_denied"):
            self.call(api)
        self.assertEqual(fixtures["envelope"].save_count, 0)


if __name__ == "__main__":
    unittest.main()
