from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "work_package_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, on_save, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_save", on_save)
        object.__setattr__(self, "_on_insert", on_insert)
        object.__setattr__(self, "save_count", 0)
        object.__setattr__(self, "insert_count", 0)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def set(self, field: str, value) -> None:
        self[field] = value

    def save(self, *, ignore_permissions: bool) -> None:
        if not ignore_permissions:
            raise AssertionError("bounded package transition must not use generic writes")
        self.save_count += 1
        self._on_save(self)

    def insert(self) -> None:
        self.insert_count += 1
        self["name"] = self["work_package_event_id"]
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

        if "`tabWork Package Event`" in normalized:
            if "device_action_id = %s" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("device_action_id") == values[0]
                ]
            if "event_type = 'Hold Point Released'" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("event_type") == "Hold Point Released"
                ]
            return [
                dict(row)
                for row in self.fixtures["events"]
                if row.get("work_package") == values[0]
                and row.get("event_type") == "Hold Point Evidence"
                and str(row.get("hold_point_sequence")) == str(values[1])
            ]
        if "`tabWork Package`" in normalized:
            if "work_package_id = %s" in normalized:
                return [
                    {"name": row["name"], "work_package_id": row["work_package_id"]}
                    for row in self.fixtures["packages"].values()
                    if row.get("work_package_id") == values[0]
                ]
            return [
                {
                    "name": row["name"],
                    "work_package_id": row["work_package_id"],
                    "supersedes": row.get("supersedes"),
                }
                for row in self.fixtures["packages"].values()
                if row.get("roof_job") == values[0]
            ]
        if "`tabJob Assignment`" in normalized:
            if "name = %s OR assignment_id = %s" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["assignments"].values()
                    if row.get("name") in values or row.get("assignment_id") in values
                ]
            return [
                dict(row)
                for row in self.fixtures["assignments"].values()
                if row.get("roof_job") == values[0]
            ]
        if "`tabUser`" in normalized:
            user = self.fixtures["users"].get(values[0])
            return [dict(user)] if user else []
        if "`tabCrew Profile`" in normalized:
            crew = self.fixtures["crews"].get(values[0])
            return [dict(crew)] if crew else []
        if "`tabCrew Member`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["crew_members"]
                if row.get("parent") == values[0]
                and row.get("crew_user") == values[1]
                and row.get("active") == 1
            ]
        if "`tabEvidence Item`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["evidence"]
                if row.get("name") in values or row.get("evidence_id") in values
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class WorkPackageApiTests(unittest.TestCase):
    def fixtures(self, *, status: str = "Released") -> dict:
        package = {
            "name": "WP-001",
            "work_package_id": "WP-001",
            "roof_job": "JOB-001",
            "job_assignment": "ASSIGN-001",
            "safety_plan": "SAFE-001",
            "version": 1,
            "status": status,
            "expires_at": "2026-07-11 08:00:00",
            "released_by": "supervisor@example.com",
            "released_at": "2026-07-10 08:00:00",
            "acknowledged_by": None,
            "acknowledged_at": None,
            "acknowledgement_device_action_id": None,
            "started_at": None,
            "blocked_by": None,
            "blocked_at": None,
            "blocked_device_action_id": None,
            "blocker_reason": None,
            "hold_points": [
                {
                    "sequence": 1,
                    "hold_point": "Deck inspection",
                    "release_authority": "IronWrap Production",
                }
            ],
        }
        return {
            "packages": {package["name"]: package},
            "assignments": {
                "ASSIGN-001": {
                    "name": "ASSIGN-001",
                    "assignment_id": "ASSIGN-001",
                    "roof_job": "JOB-001",
                    "assignment_type": "Production",
                    "status": "Accepted",
                    "crew_profile": None,
                    "assigned_user": "crew@example.com",
                    "scheduled_start": "2026-07-10 07:00:00",
                    "supersedes": None,
                }
            },
            "users": {
                "crew@example.com": {"name": "crew@example.com", "enabled": 1},
                "supervisor@example.com": {
                    "name": "supervisor@example.com",
                    "enabled": 1,
                },
            },
            "crews": {},
            "crew_members": [],
            "evidence": [
                {
                    "name": "EVIDENCE-NAME-001",
                    "evidence_id": "EVI-001",
                    "roof_job": "JOB-001",
                    "sync_state": "Verified",
                    "capture_actor": "crew@example.com",
                }
            ],
            "events": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "worker@ironwrapexteriors.com",
        configured_issuer: str | None = "worker@ironwrapexteriors.com",
        request_method: str = "POST",
        can_permission: bool = True,
        roles_by_user: dict[str, list[str]] | None = None,
    ):
        fixtures = fixtures or self.fixtures()
        db = FakeDb(fixtures)
        transition_calls: list[dict] = []
        event_calls: list[dict] = []
        roles_by_user = roles_by_user or {
            "supervisor@example.com": ["IronWrap Production"],
            "crew@example.com": ["IronWrap Field"],
        }

        @contextmanager
        def work_package_transition_context(document):
            transition_calls.append(dict(document))
            yield

        @contextmanager
        def work_package_event_issuance_context(document):
            event_calls.append(dict(document))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.work_package_transition_context = (
            work_package_transition_context
        )
        validation_module.work_package_event_issuance_context = (
            work_package_event_issuance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = (
            {"ironwrap_work_package_issuer_user": configured_issuer}
            if configured_issuer is not None
            else {}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-10 10:00:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_permission
        frappe_module.get_roles = lambda user: roles_by_user.get(user, [])
        frappe_module.whitelist = lambda: lambda function: function

        def on_save(document: FakeDocument) -> None:
            fixtures["packages"][document["name"]] = dict(document)

        def on_insert(document: FakeDocument) -> None:
            fixtures["events"].append(dict(document))

        def get_doc(*args):
            if len(args) == 2:
                doctype, name = args
                if doctype != "Work Package":
                    raise AssertionError(f"unexpected doctype: {doctype}")
                return FakeDocument(
                    dict(fixtures["packages"][name]), on_save, on_insert
                )
            if len(args) == 1 and isinstance(args[0], dict):
                return FakeDocument(dict(args[0]), on_save, on_insert)
            raise AssertionError(f"unexpected get_doc args: {args!r}")

        frappe_module.get_doc = get_doc
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(
            exc(message)
        )
        spec = importlib.util.spec_from_file_location(
            "ironwrap_work_package_api_under_test", API_PATH
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
            transition_calls,
            event_calls,
            frappe_module,
        )

    @staticmethod
    def field_args(**overrides) -> dict:
        args = {
            "work_package_id": "WP-001",
            "roof_job_id": "JOB-001",
            "job_assignment_id": "ASSIGN-001",
            "actor_user": "crew@example.com",
            "device_action_id": "field-action-0001",
        }
        return {**args, **overrides}

    def test_acknowledge_locks_exact_current_facts_and_replays_exactly(self) -> None:
        api, fixtures, db, transitions, events, _ = self.load_api()

        first = api.acknowledge_work_package(**self.field_args())

        self.assertFalse(first["idempotent_replay"])
        self.assertEqual(first["work_package"]["name"], "WP-001")
        self.assertEqual(first["event"]["name"], api._event_id("field-action-0001"))
        package = fixtures["packages"]["WP-001"]
        self.assertEqual(package["status"], "Acknowledged")
        self.assertEqual(package["acknowledged_by"], "crew@example.com")
        self.assertEqual(
            package["acknowledgement_device_action_id"], "field-action-0001"
        )
        self.assertEqual(len(fixtures["events"]), 1)
        self.assertEqual(len(transitions), 1)
        self.assertEqual(len(events), 1)
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))

        replay = api.acknowledge_work_package(**self.field_args())

        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["event"]["name"], first["event"]["name"])
        self.assertEqual(len(fixtures["events"]), 1)
        self.assertEqual(len(transitions), 1)

    def test_start_requires_the_acknowledging_actor_and_exact_replay(self) -> None:
        api, fixtures, _, _, _, frappe_module = self.load_api(
            roles_by_user={
                "crew@example.com": ["IronWrap Field"],
                "supervisor@example.com": ["IronWrap Production"],
            }
        )
        api.acknowledge_work_package(**self.field_args(device_action_id="ack-00000001"))
        with self.assertRaisesRegex(FakeValidationError, "hold_points_pending"):
            api.start_work(**self.field_args(device_action_id="start-00000001"))

        api.submit_hold_point_evidence(
            **self.field_args(
                device_action_id="hold-evidence-0001",
                hold_point_sequence=1,
                evidence_item_id="EVI-001",
            )
        )
        frappe_module.session.user = "supervisor@example.com"
        api.release_hold_point(
            **self.field_args(
                device_action_id="hold-release-0001",
                actor_user="supervisor@example.com",
                hold_point_sequence=1,
                evidence_item_id="EVI-001",
            )
        )
        frappe_module.session.user = "worker@ironwrapexteriors.com"

        started = api.start_work(
            **self.field_args(device_action_id="start-00000001")
        )

        self.assertEqual(started["work_package"]["status"], "In Progress")
        self.assertEqual(fixtures["packages"]["WP-001"]["started_at"], "2026-07-10 10:00:00")
        self.assertFalse(started["idempotent_replay"])
        self.assertTrue(
            api.start_work(**self.field_args(device_action_id="start-00000001"))["idempotent_replay"]
        )

    def test_worker_principal_and_conflicting_device_action_are_rejected(self) -> None:
        api, fixtures, _, _, _, _ = self.load_api(session_user="owner@example.com")
        with self.assertRaisesRegex(FakePermissionError, "issuer_auth_mismatch"):
            api.acknowledge_work_package(**self.field_args())
        self.assertEqual(fixtures["events"], [])

        api, fixtures, _, _, _, _ = self.load_api()
        api.acknowledge_work_package(**self.field_args())
        with self.assertRaisesRegex(FakeValidationError, "replay_conflict"):
            api.stop_work(
                **self.field_args(blocker_reason="Wind above the released limit.")
            )
        self.assertEqual(len(fixtures["events"]), 1)

    def test_stop_persists_attribution_and_requires_independent_release(self) -> None:
        api, fixtures, _, _, _, frappe_module = self.load_api(
            roles_by_user={
                "crew@example.com": ["IronWrap Production"],
                "supervisor@example.com": ["IronWrap Production"],
            }
        )
        api.acknowledge_work_package(
            **self.field_args(device_action_id="ack-00000001")
        )
        stopped = api.stop_work(
            **self.field_args(
                device_action_id="stop-00000001",
                blocker_reason="Wind exceeds the released limit.",
            )
        )
        package = fixtures["packages"]["WP-001"]
        self.assertEqual(stopped["work_package"]["status"], "Blocked")
        self.assertEqual(package["blocked_by"], "crew@example.com")
        self.assertEqual(package["blocked_device_action_id"], "stop-00000001")

        frappe_module.session.user = "crew@example.com"
        with self.assertRaisesRegex(FakePermissionError, "independent_release_required"):
            api.release_work_package(
                **self.field_args(
                    device_action_id="release-00000001",
                    actor_user="crew@example.com",
                )
            )

        frappe_module.session.user = "supervisor@example.com"
        released = api.release_work_package(
            **self.field_args(
                device_action_id="release-00000001",
                actor_user="supervisor@example.com",
            )
        )
        self.assertEqual(released["work_package"]["status"], "Released")
        package = fixtures["packages"]["WP-001"]
        self.assertIsNone(package["acknowledged_by"])
        self.assertIsNone(package["acknowledgement_device_action_id"])
        self.assertIsNone(package["started_at"])
        self.assertIsNone(package["blocked_by"])
        self.assertIsNone(package["blocked_device_action_id"])
        self.assertTrue(
            any(event["event_type"] == "Stop Work" for event in fixtures["events"])
        )
        self.assertEqual(len(fixtures["events"]), 3)

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        resumed = api.acknowledge_work_package(
            **self.field_args(device_action_id="ack-00000002")
        )
        self.assertEqual(resumed["work_package"]["status"], "Acknowledged")
        package = fixtures["packages"]["WP-001"]
        self.assertEqual(package["acknowledged_by"], "crew@example.com")
        stopped_again = api.stop_work(
            **self.field_args(
                device_action_id="stop-00000002",
                blocker_reason="Materials no longer match the released package.",
            )
        )
        self.assertEqual(stopped_again["work_package"]["status"], "Blocked")
        self.assertEqual(
            fixtures["packages"]["WP-001"]["blocked_device_action_id"],
            "stop-00000002",
        )

    def test_hold_point_release_cannot_self_release_worker_evidence(self) -> None:
        fixtures = self.fixtures(status="In Progress")
        fixtures["packages"]["WP-001"].update(
            {
                "acknowledged_by": "crew@example.com",
                "acknowledged_at": "2026-07-10 09:00:00",
                "acknowledgement_device_action_id": "ack-00000001",
                "started_at": "2026-07-10 09:05:00",
            }
        )
        fixtures["events"].append(
            {
                "name": "wpe-evidence-1",
                "work_package_event_id": "wpe-evidence-1",
                "event_type": "Hold Point Evidence",
                "work_package": "WP-001",
                "roof_job": "JOB-001",
                "job_assignment": "ASSIGN-001",
                "work_package_version": 1,
                "actor_user": "crew@example.com",
                "actor_role": "Production direct assignment",
                "device_action_id": "evidence-00000001",
                "occurred_at": "2026-07-10 09:15:00",
                "payload_hash": "a" * 64,
                "hold_point_sequence": 1,
                "evidence_item": "EVIDENCE-NAME-001",
                "blocker_reason": None,
            }
        )
        api, fixtures, _, _, _, frappe_module = self.load_api(
            fixtures,
            roles_by_user={
                "crew@example.com": ["IronWrap Production"],
                "supervisor@example.com": ["IronWrap Production"],
            },
        )
        release_args = self.field_args(
            device_action_id="hold-release-0001",
            hold_point_sequence=1,
            evidence_item_id="EVI-001",
        )
        frappe_module.session.user = "crew@example.com"
        with self.assertRaisesRegex(FakePermissionError, "independent_release_required"):
            api.release_hold_point(**release_args)

        frappe_module.session.user = "supervisor@example.com"
        released = api.release_hold_point(
            **{
                **release_args,
                "actor_user": "supervisor@example.com",
            }
        )
        self.assertEqual(released["event"]["event_type"], "Hold Point Released")
        self.assertFalse(released["idempotent_replay"])
        with self.assertRaisesRegex(FakeValidationError, "already_released"):
            api.release_hold_point(
                **{
                    **release_args,
                    "device_action_id": "hold-release-0002",
                    "actor_user": "supervisor@example.com",
                }
            )


if __name__ == "__main__":
    unittest.main()
