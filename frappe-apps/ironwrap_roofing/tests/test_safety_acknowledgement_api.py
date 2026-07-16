from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "safety_acknowledgement_api.py"
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

    def append(self, field: str, values: dict) -> "FakeDoc":
        row = FakeDoc(values)
        self.setdefault(field, []).append(row)
        return row

    def save(self, **kwargs) -> None:
        self.save_count += 1
        self.save_kwargs.append(kwargs)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def get_value(self, doctype: str, name: str, field: str):
        if doctype == "User" and field == "enabled":
            return self.fixtures["users"].get(name)
        raise AssertionError(f"unexpected get_value: {doctype} {name} {field}")

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabUser`" in normalized:
            user = values[0]
            enabled = self.fixtures["users"].get(user)
            return [{"name": user, "enabled": enabled}] if enabled is not None else []
        if "`tabSafety Plan`" in normalized:
            name = values[0]
            plan = self.fixtures["plan"]
            return [{"name": name}] if plan.get("name") == name else []
        if "`tabEvidence Item`" in normalized:
            evidence = self.fixtures["evidence"].get(values[0])
            return [dict(evidence)] if evidence else []
        if "`tabJob Assignment`" in normalized:
            roof_job, actor_user = values
            active = {"Assigned", "Accepted", "In Progress"}
            return [
                dict(assignment)
                for assignment in self.fixtures["assignments"]
                if assignment["roof_job"] == roof_job
                and assignment["status"] in active
                and (
                    assignment.get("assigned_user") == actor_user
                    or assignment.get("crew_profile")
                )
            ]
        if "`tabCrew Profile`" in normalized:
            crew = self.fixtures["crews"].get(values[0])
            return [dict(crew)] if crew else []
        if "`tabCrew Member`" in normalized:
            crew_profile, actor_user = values
            return [
                {"crew_role": member["crew_role"]}
                for member in self.fixtures["crew_members"]
                if member["parent"] == crew_profile
                and member["crew_user"] == actor_user
                and member["active"] == 1
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class SafetyAcknowledgementApiTests(unittest.TestCase):
    def fixture_data(self) -> dict:
        plan = FakeDoc(
            {
                "name": "safety:job-1:v1",
                "safety_plan_id": "safety:job-1:v1",
                "roof_job": "job-1",
                "status": "Ready",
                "version": 1,
                "effective_date": "2026-07-10",
                "acknowledgements": [],
            }
        )
        evidence = {
            "name": "evidence:safety:crew-1",
            "evidence_id": "evidence:safety:crew-1",
            "roof_job": "job-1",
            "evidence_type": "Photo",
            "proof_owner": "crew@example.com",
            "proof_slot": "Safety",
            "source_system": "ironwrap-pwa",
            "source_uri": None,
            "r2_key": "field/v1/crew-1/photo.jpg",
            "drive_file_id": None,
            "content_checksum": "a" * 64,
            "checksum_algorithm": "SHA-256",
            "content_type": "image/jpeg",
            "content_length": 1_024,
            "capture_actor": "crew@example.com",
            "captured_at": "2026-07-10 07:30:00",
            "sync_state": "Verified",
            "verified_at": "2026-07-10 07:31:00",
            "verification_source": "ironwrap-worker-r2-frappe",
            "device_action_id": "fem_crew-field-proof-1",
        }
        return {
            "plan": plan,
            "evidence": {evidence["name"]: evidence},
            "users": {"crew@example.com": 1},
            "assignments": [
                {
                    "name": "assignment:crew-1",
                    "roof_job": "job-1",
                    "assignment_type": "Production",
                    "status": "Assigned",
                    "crew_profile": None,
                    "assigned_user": "crew@example.com",
                }
            ],
            "crews": {},
            "crew_members": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "crew@example.com",
        request_method: str = "POST",
        can_read: bool = True,
    ):
        fixtures = fixtures or self.fixture_data()
        db = FakeDb(fixtures)
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = {}
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-10 07:32:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_read
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.get_doc = lambda doctype, name: (
            fixtures["plan"]
            if doctype == "Safety Plan" and name == fixtures["plan"]["name"]
            else (_ for _ in ()).throw(
                AssertionError(f"unexpected get_doc: {doctype} {name}")
            )
        )

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_safety_acknowledgement_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module, fixtures, db

    def call(self, api, **overrides):
        values = {
            "safety_plan_id": "safety:job-1:v1",
            "roof_job_id": "job-1",
            "actor_user": "crew@example.com",
            "acknowledgement_method": "QR Device Pairing",
            "device_action_id": "field-ack-0001",
            "evidence_item_id": "evidence:safety:crew-1",
            "notes": "Crew reviewed tie-off and weather controls.",
        }
        values.update(overrides)
        return api.append_safety_acknowledgement(**values)

    def test_append_is_locked_server_derived_and_exactly_idempotent(self) -> None:
        api, fixtures, db = self.load_api()

        first = self.call(api)

        self.assertFalse(first["idempotent_replay"])
        self.assertEqual(first["safety_plan"]["status"], "Acknowledged")
        self.assertEqual(first["safety_plan"]["acknowledgement_count"], 1)
        self.assertEqual(
            first["acknowledgement"]["role_on_job"], "Direct assignment · Production"
        )
        self.assertEqual(fixtures["plan"].save_count, 1)
        self.assertEqual(fixtures["plan"].save_kwargs, [{"ignore_permissions": True}])
        self.assertTrue(any("`tabSafety Plan`" in query for query in db.lock_queries))
        self.assertTrue(any("`tabEvidence Item`" in query for query in db.lock_queries))
        self.assertTrue(
            any("`tabJob Assignment`" in query for query in db.lock_queries)
        )

        replay = self.call(api)

        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["acknowledgement"], first["acknowledgement"])
        self.assertEqual(fixtures["plan"].save_count, 1)
        self.assertEqual(len(fixtures["plan"]["acknowledgements"]), 1)

    def test_replay_conflicts_cannot_mutate_the_child_table(self) -> None:
        api, fixtures, _ = self.load_api()
        self.call(api)

        with self.assertRaisesRegex(
            FakeValidationError, "safety_acknowledgement_replay_conflict"
        ):
            self.call(api, notes="Different statement")
        with self.assertRaisesRegex(
            FakeValidationError, "safety_acknowledgement_user_conflict"
        ):
            self.call(api, device_action_id="field-ack-0002")

        self.assertEqual(fixtures["plan"].save_count, 1)
        self.assertEqual(len(fixtures["plan"]["acknowledgements"]), 1)

    def test_evidence_relationship_and_assignment_role_are_enforced(self) -> None:
        fixtures = self.fixture_data()
        fixtures["evidence"]["evidence:safety:crew-1"]["roof_job"] = "job-other"
        api, fixtures, _ = self.load_api(fixtures)
        with self.assertRaisesRegex(
            FakeValidationError, "safety_acknowledgement_evidence_job_mismatch"
        ):
            self.call(api)
        self.assertEqual(fixtures["plan"].save_count, 0)

        fixtures = self.fixture_data()
        api, fixtures, _ = self.load_api(fixtures)
        with self.assertRaisesRegex(
            FakePermissionError, "safety_acknowledgement_role_conflict"
        ):
            self.call(api, role_on_job="Installer")
        self.assertEqual(fixtures["plan"].save_count, 0)

    def test_active_crew_membership_is_accepted_and_derived(self) -> None:
        fixtures = self.fixture_data()
        fixtures["assignments"] = [
            {
                "name": "assignment:crew-a",
                "roof_job": "job-1",
                "assignment_type": "Production",
                "status": "In Progress",
                "crew_profile": "crew:calgary-a",
                "assigned_user": None,
            }
        ]
        fixtures["crews"] = {
            "crew:calgary-a": {
                "name": "crew:calgary-a",
                "crew_name": "Calgary Metal Crew",
                "status": "Active",
            }
        }
        fixtures["crew_members"] = [
            {
                "parent": "crew:calgary-a",
                "crew_user": "crew@example.com",
                "crew_role": "Installer",
                "active": 1,
            }
        ]
        api, _, _ = self.load_api(fixtures)

        result = self.call(api)

        self.assertEqual(
            result["acknowledgement"]["role_on_job"],
            "Crew assignment · Installer · Production",
        )

    def test_actor_token_binding_missing_assignment_and_get_requests_fail_closed(
        self,
    ) -> None:
        api, _, _ = self.load_api(session_user="mcp-service@example.com")
        with self.assertRaisesRegex(
            FakePermissionError, "safety_acknowledgement_actor_auth_mismatch"
        ):
            self.call(api)

        fixtures = self.fixture_data()
        fixtures["assignments"] = []
        api, _, _ = self.load_api(fixtures)
        with self.assertRaisesRegex(
            FakePermissionError, "safety_acknowledgement_assignment_required"
        ):
            self.call(api)

        api, _, _ = self.load_api(request_method="GET")
        with self.assertRaisesRegex(
            FakePermissionError, "safety_acknowledgement_post_required"
        ):
            self.call(api)


if __name__ == "__main__":
    unittest.main()
