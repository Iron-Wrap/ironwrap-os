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
            if "evidence_correction_of = %s" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("event_type") == "Evidence Captured"
                    and row.get("evidence_correction_of") == values[2]
                ]
            if "event_type = 'Acknowledged'" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("event_type") == "Acknowledged"
                ]
            if "event_type = 'Released'" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("event_type") == "Released"
                ]
            if "name = %s OR work_package_event_id = %s" in normalized:
                release_event = self.fixtures.get("release_event")
                candidates = list(self.fixtures["events"])
                if release_event:
                    candidates.append(release_event)
                return [
                    dict(row)
                    for row in candidates
                    if row.get("name") in values or row.get("work_package_event_id") in values
                ]
            if "event_type = 'Hold Point Released'" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("event_type") == "Hold Point Released"
                ]
            if "event_type = 'Evidence Reviewed'" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("event_type") == "Evidence Reviewed"
                    and row.get("evidence_review_of") == values[0]
                ]
            if "event_type IN ('Evidence Captured', 'Evidence Reviewed')" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["events"]
                    if row.get("event_type") in {"Evidence Captured", "Evidence Reviewed"}
                    and row.get("work_package") == values[0]
                    and str(row.get("work_package_version")) == str(values[1])
                    and row.get("release_attempt_id") == values[2]
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
            if "work_object_type = %s" in normalized:
                return [
                    {
                        "name": row["name"],
                        "work_package_id": row["work_package_id"],
                        "supersedes": row.get("supersedes"),
                    }
                    for row in self.fixtures["packages"].values()
                    if row.get("work_object_type") == values[0]
                    and row.get("work_object_id") == values[1]
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
            if "crew_user = %s" not in normalized:
                return [
                    dict(row)
                    for row in self.fixtures["crew_members"]
                    if row.get("parent") == values[0] and row.get("active") == 1
                ]
            return [
                dict(row)
                for row in self.fixtures["crew_members"]
                if row.get("parent") == values[0]
                and row.get("crew_user") == values[1]
                and row.get("active") == 1
            ]
        if "`tabWork Package Worker`" in normalized:
            if "worker_user = %s" in normalized:
                return [
                    dict(row)
                    for row in self.fixtures.get("assignment_workers", [])
                    if row.get("parent") == values[0]
                    and row.get("worker_user") == values[1]
                ]
            return [
                dict(row)
                for row in self.fixtures.get("assignment_workers", [])
                if row.get("parent") == values[0]
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
            "release_attempt_id": "wpe_release_attempt_00000001",
            "assigned_workers": [
                {
                    "sequence": 1,
                    "worker_user": "crew@example.com",
                    "worker_role": "Production direct assignment",
                    "required": 1,
                }
            ],
            "acknowledged_by": None,
            "acknowledged_at": None,
            "acknowledgement_device_action_id": None,
            "started_at": None,
            "blocked_by": None,
            "blocked_at": None,
            "blocked_device_action_id": None,
            "blocker_reason": None,
            "steps": [
                {
                    "sequence": 1,
                    "instruction": "Inspect the anchor zone.",
                    "required_evidence": "Anchor inspection photo.",
                    "acceptance_criteria": "Anchor and harness connection are visible.",
                }
            ],
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
                    "work_package": "WP-001",
                    "work_package_version": 1,
                    "evidence_slot_id": "step:1",
                    "evidence_requirement": "Anchor inspection photo.",
                    "evidence_source": "worker-camera",
                    "evidence_device_id": "paired-device-1",
                    "captured_at": "2026-07-10 09:15:00",
                    "work_package_release_attempt_id": "wpe_release_attempt_00000001",
                    "evidence_freshness": "Current",
                    "evidence_conflict_state": "None",
                    "evidence_verification": "Verified",
                    "evidence_disposition": "Open",
                },
                {
                    "name": "EVIDENCE-NAME-HOLD-001",
                    "evidence_id": "EVI-HOLD-001",
                    "roof_job": "JOB-001",
                    "sync_state": "Verified",
                    "capture_actor": "crew@example.com",
                    "work_package": "WP-001",
                    "work_package_version": 1,
                    "evidence_slot_id": "hold:1",
                    "evidence_device_id": "paired-device-1",
                    "work_package_release_attempt_id": "wpe_release_attempt_00000001",
                    "evidence_verification": "Verified",
                    "evidence_disposition": "Open",
                }
            ],
            "events": [],
            "release_event": {
                "name": "wpe_release_attempt_00000001",
                "work_package_event_id": "wpe_release_attempt_00000001",
                "event_type": "Released",
                "work_package": "WP-001",
                "roof_job": "JOB-001",
                "job_assignment": "ASSIGN-001",
                "work_package_version": 1,
                "actor_user": "supervisor@example.com",
                "actor_role": "IronWrap Production",
                "device_action_id": "release-seed-00000001",
                "occurred_at": "2026-07-10 08:00:00",
            },
        }

    def generic_physical_fixtures(self) -> dict:
        """Synthetic Shop adapter packet with no Roof Job parent at all."""

        fixtures = self.fixtures(status="Draft")
        package = fixtures["packages"]["WP-001"]
        package.update(
            {
                "roof_job": None,
                "safety_plan": None,
                "work_object_type": "Shop Order",
                "work_object_id": "SHOP-001",
                "physical_context_type": "Shop Floor",
                "physical_context_id": "SHOP-FLOOR-1",
                "released_by": None,
                "released_at": None,
                "assigned_workers": [],
            }
        )
        package["hold_points"][0].update(
            {
                "required_evidence": "Deck inspection photo.",
                "acceptance_criteria": "Deck condition is visible.",
            }
        )
        assignment = fixtures["assignments"]["ASSIGN-001"]
        assignment.update(
            {
                "roof_job": None,
                "assignment_type": "Shop",
                "crew_profile": None,
                "assigned_user": None,
                "authority_user": "supervisor@example.com",
                "authority_role": "IronWrap Production",
                "assigned_by": "supervisor@example.com",
                "assigned_at": "2026-07-10 07:00:00",
                "work_object_type": "Shop Order",
                "work_object_id": "SHOP-001",
                "physical_context_type": "Shop Floor",
                "physical_context_id": "SHOP-FLOOR-1",
                "assigned_workers": [
                    {
                        "sequence": 1,
                        "worker_user": "crew@example.com",
                        "worker_role": "Shop Operator",
                        "required": 1,
                    }
                ],
            }
        )
        fixtures["assignment_workers"] = [
            {
                "parent": "ASSIGN-001",
                "sequence": 1,
                "worker_user": "crew@example.com",
                "worker_role": "Shop Operator",
                "required": 1,
            }
        ]
        for evidence in fixtures["evidence"]:
            evidence["roof_job"] = None
        fixtures["evidence"][1].update(
            {
                "evidence_requirement": "Deck inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_captured_at": "2026-07-10 09:20:00",
                "captured_at": "2026-07-10 09:20:00",
                "evidence_freshness": "Current",
                "evidence_conflict_state": "None",
            }
        )
        fixtures["release_event"].update(
            {
                "roof_job": None,
                "work_object_type": "Shop Order",
                "work_object_id": "SHOP-001",
                "physical_context_type": "Shop Floor",
                "physical_context_id": "SHOP-FLOOR-1",
            }
        )
        return fixtures

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
            "work_package_version": 1,
            "roof_job_id": "JOB-001",
            "job_assignment_id": "ASSIGN-001",
            "actor_user": "crew@example.com",
            "device_action_id": "field-action-0001",
            "release_attempt_id": "wpe_release_attempt_00000001",
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

    def test_lost_ack_replay_does_not_reauthorize_assignment_expiry_or_supersession(self) -> None:
        for mutation in (
            lambda package: package.update({"job_assignment": "ASSIGN-002"}),
            lambda package: package.update({"expires_at": "2026-07-01 08:00:00"}),
            lambda package: package.update({"status": "Superseded", "supersedes": "WP-000"}),
        ):
            with self.subTest(mutation=mutation):
                api, fixtures, _, _, _, _ = self.load_api()
                first = api.acknowledge_work_package(**self.field_args())
                mutation(fixtures["packages"]["WP-001"])

                replay = api.acknowledge_work_package(**self.field_args())

                self.assertTrue(replay["idempotent_replay"])
                self.assertEqual(replay["event"]["name"], first["event"]["name"])
                self.assertEqual(len(fixtures["events"]), 1)

    def test_lost_evidence_replay_does_not_reauthorize_assignment_expiry_or_supersession(self) -> None:
        capture_args = self.field_args(
            device_action_id="evidence-lost-response-0001",
            evidence_slot_id="step:1",
            evidence_requirement="Anchor inspection photo.",
            evidence_source="worker-camera",
            evidence_item_id="EVI-001",
            evidence_device_id="paired-device-1",
            evidence_captured_at="2026-07-10 09:15:00",
        )
        for mutation in (
            lambda package: package.update({"job_assignment": "ASSIGN-002"}),
            lambda package: package.update({"expires_at": "2026-07-01 08:00:00"}),
            lambda package: package.update({"status": "Superseded", "supersedes": "WP-000"}),
        ):
            with self.subTest(mutation=mutation):
                fixtures = self.fixtures(status="Released")
                api, fixtures, _, _, _, _ = self.load_api(fixtures)
                first = api.capture_work_package_evidence(**capture_args)
                mutation(fixtures["packages"]["WP-001"])

                replay = api.capture_work_package_evidence(**capture_args)

                self.assertTrue(replay["idempotent_replay"])
                self.assertEqual(replay["event"]["name"], first["event"]["name"])
                self.assertEqual(len(fixtures["events"]), 1)

    def test_worker_actions_require_the_exact_package_version(self) -> None:
        api, fixtures, _, _, _, _ = self.load_api()
        missing_version = self.field_args()
        missing_version.pop("work_package_version")
        with self.assertRaisesRegex(FakeValidationError, "work_package_version"):
            api.acknowledge_work_package(**missing_version)
        with self.assertRaisesRegex(FakeValidationError, "work_package_version_conflict"):
            api.acknowledge_work_package(
                **self.field_args(work_package_version=2, device_action_id="stale-version-1")
            )
        self.assertEqual(fixtures["events"], [])

    def test_legacy_package_without_frozen_roster_fails_closed_but_stop_remains_available(self) -> None:
        fixtures = self.fixtures(status="Released")
        fixtures["packages"]["WP-001"]["assigned_workers"] = []
        api, fixtures, _, _, _, _ = self.load_api(fixtures)

        with self.assertRaisesRegex(FakeValidationError, "work_package_worker_roster_missing"):
            api.acknowledge_work_package(**self.field_args(device_action_id="legacy-ack-0001"))
        with self.assertRaisesRegex(FakeValidationError, "work_package_worker_roster_missing"):
            api.start_work(**self.field_args(device_action_id="legacy-start-0001"))

        stopped = api.stop_work(
            **self.field_args(
                device_action_id="legacy-stop-0001",
                blocker_reason="The legacy packet has no frozen worker roster.",
            )
        )
        self.assertEqual(stopped["work_package"]["status"], "Blocked")
        self.assertEqual(fixtures["packages"]["WP-001"]["blocked_by"], "crew@example.com")

    def test_non_roof_physical_context_is_not_coerced_into_production_assignment(self) -> None:
        fixtures = self.fixtures(status="Released")
        fixtures["packages"]["WP-001"].update(
            {
                "work_object_type": "Shop Order",
                "work_object_id": "SHOP-001",
                "physical_context_type": "Shop",
                "physical_context_id": "SHOP-FLOOR-1",
            }
        )
        api, fixtures, _, _, _, _ = self.load_api(fixtures)

        with self.assertRaisesRegex(
            FakeValidationError, "work_package_context_adapter_unavailable"
        ):
            api.acknowledge_work_package(**self.field_args(device_action_id="shop-ack-0001"))
        self.assertEqual(fixtures["events"], [])
        self.assertEqual(fixtures["packages"]["WP-001"]["status"], "Released")

    def test_shop_adapter_executes_issue_ack_start_evidence_review_hold_and_complete(self) -> None:
        fixtures = self.generic_physical_fixtures()
        fixtures["assignments"]["ASSIGN-001"]["assigned_by"] = (
            "assignment-creator@example.com"
        )
        unrelated_actors = (
            (
                "assignment-creator@example.com",
                "IronWrap Production",
                "work_package_assignment_authority_mismatch",
            ),
            (
                "owner@example.com",
                "IronWrap Owner",
                "work_package_assignment_authority_mismatch",
            ),
            (
                "production@example.com",
                "IronWrap Production",
                "work_package_assignment_authority_mismatch",
            ),
            (
                "system-manager@example.com",
                "System Manager",
                "work_package_release_role_denied",
            ),
        )
        for actor, _role, _error in unrelated_actors:
            fixtures["users"][actor] = {"name": actor, "enabled": 1}
        roles_by_user = {
            "crew@example.com": ["IronWrap Field"],
            "supervisor@example.com": ["IronWrap Production"],
            **{
                actor: [role]
                for actor, role, _error in unrelated_actors
            },
        }
        api, fixtures, _, _, _, frappe_module = self.load_api(
            fixtures,
            roles_by_user=roles_by_user,
        )
        supervisor = "supervisor@example.com"
        worker = "crew@example.com"
        base = self.field_args(
            roof_job_id=None,
            work_object_type="Shop Order",
            work_object_id="SHOP-001",
            physical_context_type="Shop Floor",
            physical_context_id="SHOP-FLOOR-1",
        )
        frappe_module.session.user = supervisor
        released = api.release_work_package(
            **{
                **base,
                "actor_user": supervisor,
                "device_action_id": "shop-release-0001",
            }
        )
        self.assertEqual(released["work_package"]["roof_job"], None)
        self.assertEqual(released["work_package"]["work_object_id"], "SHOP-001")
        attempt = released["work_package"]["release_attempt_id"]
        for evidence in fixtures["evidence"]:
            evidence["work_package_release_attempt_id"] = attempt
        action = {**base, "release_attempt_id": attempt}

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        api.acknowledge_work_package(
            **{
                **action,
                "actor_user": worker,
                "device_action_id": "shop-ack-0001",
            }
        )
        self.assertEqual(fixtures["events"][-1]["actor_role"], "Shop Operator")

        step_capture = api.capture_work_package_evidence(
            **{
                **action,
                "actor_user": worker,
                "device_action_id": "shop-step-evidence-1",
                "evidence_slot_id": "step:1",
                "evidence_requirement": "Anchor inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_item_id": "EVI-001",
                "evidence_device_id": "paired-device-1",
                "evidence_captured_at": "2026-07-10 09:15:00",
            }
        )
        frappe_module.session.user = supervisor
        api.review_work_package_evidence(
            work_package_id="WP-001",
            work_package_version=1,
            roof_job_id=None,
            job_assignment_id="ASSIGN-001",
            actor_user=supervisor,
            device_action_id="shop-step-review-1",
            evidence_event_id=step_capture["event"]["name"],
            evidence_item_id="EVIDENCE-NAME-001",
            evidence_slot_id="step:1",
            disposition="Accepted",
        )
        self.assertEqual(fixtures["events"][-1]["evidence_disposition"], "Accepted")

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        hold_evidence = api.submit_hold_point_evidence(
            **{
                **action,
                "actor_user": worker,
                "device_action_id": "shop-hold-submit-1",
                "hold_point_sequence": 1,
                "evidence_item_id": "EVI-HOLD-001",
            }
        )
        hold_capture = api.capture_work_package_evidence(
            **{
                **action,
                "actor_user": worker,
                "device_action_id": "shop-hold-evidence-1",
                "evidence_slot_id": "hold:1",
                "evidence_requirement": "Deck inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_item_id": "EVI-HOLD-001",
                "evidence_device_id": "paired-device-1",
                "evidence_captured_at": "2026-07-10 09:20:00",
            }
        )
        frappe_module.session.user = supervisor
        api.review_work_package_evidence(
            work_package_id="WP-001",
            work_package_version=1,
            roof_job_id=None,
            job_assignment_id="ASSIGN-001",
            actor_user=supervisor,
            device_action_id="shop-hold-review-1",
            evidence_event_id=hold_capture["event"]["name"],
            evidence_item_id="EVIDENCE-NAME-HOLD-001",
            evidence_slot_id="hold:1",
            disposition="Accepted",
        )
        self.assertEqual(hold_evidence["event"]["event_type"], "Hold Point Evidence")
        self.assertEqual(fixtures["events"][-1]["evidence_disposition"], "Accepted")
        released_hold = api.release_hold_point(
            **{
                **action,
                "actor_user": supervisor,
                "device_action_id": "shop-hold-release-1",
                "hold_point_sequence": 1,
                "evidence_item_id": "EVI-HOLD-001",
            }
        )
        self.assertEqual(released_hold["event"]["event_type"], "Hold Point Released")

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        started = api.start_work(
            **{
                **action,
                "actor_user": worker,
                "device_action_id": "shop-start-0001",
            }
        )
        self.assertEqual(started["work_package"]["status"], "In Progress")

        for index, (actor, _role, error) in enumerate(unrelated_actors, start=1):
            with self.subTest(actor=actor):
                frappe_module.session.user = actor
                with self.assertRaisesRegex(FakePermissionError, error):
                    api.complete_work_package(
                        **{
                            **action,
                            "actor_user": actor,
                            "device_action_id": f"unrelated-complete-{index}",
                        }
                    )
        self.assertEqual(fixtures["packages"]["WP-001"]["status"], "In Progress")
        self.assertFalse(
            any(event["event_type"] == "Completed" for event in fixtures["events"])
        )

        assignment = fixtures["assignments"]["ASSIGN-001"]
        assignment["authority_role"] = "IronWrap Owner"
        frappe_module.session.user = supervisor
        with self.assertRaisesRegex(
            FakePermissionError, "work_package_assignment_authority_role_mismatch"
        ):
            api.complete_work_package(
                **{
                    **action,
                    "actor_user": supervisor,
                    "device_action_id": "wrong-authority-role-complete-1",
                }
            )

        assignment["authority_user"] = worker
        assignment["authority_role"] = "IronWrap Production"
        roles_by_user[worker] = ["IronWrap Field", "IronWrap Production"]
        frappe_module.session.user = "worker@ironwrapexteriors.com"
        with self.assertRaisesRegex(
            FakePermissionError, "work_package_completion_independence_required"
        ):
            api.complete_work_package(
                **{
                    **action,
                    "actor_user": worker,
                    "device_action_id": "roster-authority-complete-1",
                }
            )

        assignment["authority_user"] = supervisor
        assignment["authority_role"] = "IronWrap Production"
        frappe_module.session.user = supervisor
        completed = api.complete_work_package(
            **{
                **action,
                "actor_user": supervisor,
                "device_action_id": "shop-complete-1",
            }
        )
        self.assertEqual(completed["work_package"]["status"], "Completed")
        self.assertIsNone(fixtures["packages"]["WP-001"]["roof_job"])

    def test_blocked_legacy_package_without_frozen_roster_requires_superseding_package(self) -> None:
        fixtures = self.fixtures(status="Blocked")
        fixtures["packages"]["WP-001"]["assigned_workers"] = []
        api, fixtures, _, _, _, frappe_module = self.load_api(fixtures)
        frappe_module.session.user = "supervisor@example.com"

        with self.assertRaisesRegex(FakeValidationError, "work_package_worker_roster_missing"):
            api.release_work_package(
                **self.field_args(
                    actor_user="supervisor@example.com",
                    device_action_id="legacy-resume-0001",
                )
            )
        self.assertEqual(fixtures["packages"]["WP-001"]["status"], "Blocked")
        self.assertEqual(fixtures["events"], [])

    def test_blocked_resume_rejects_changed_live_crew_instead_of_using_stale_roster(self) -> None:
        fixtures = self.fixtures(status="Blocked")
        fixtures["assignments"]["ASSIGN-001"]["assigned_user"] = "new-crew@example.com"
        fixtures["users"]["new-crew@example.com"] = {"name": "new-crew@example.com", "enabled": 1}
        api, fixtures, _, _, _, frappe_module = self.load_api(fixtures)
        frappe_module.session.user = "supervisor@example.com"

        with self.assertRaisesRegex(FakeValidationError, "work_package_worker_roster_drift"):
            api.release_work_package(
                **self.field_args(
                    actor_user="supervisor@example.com",
                    device_action_id="crew-drift-resume-0001",
                )
            )
        self.assertEqual(fixtures["packages"]["WP-001"]["status"], "Blocked")
        self.assertEqual(fixtures["events"], [])

    def test_first_draft_release_derives_required_roster_from_locked_assignment(self) -> None:
        fixtures = self.fixtures(status="Draft")
        fixtures["packages"]["WP-001"]["released_by"] = None
        fixtures["packages"]["WP-001"]["released_at"] = None
        fixtures["packages"]["WP-001"]["assigned_workers"] = [
            {
                "sequence": 1,
                "worker_user": "crew@example.com",
                "worker_role": "Optional stale role",
                "required": 0,
            },
            {
                "sequence": 2,
                "worker_user": "crew@example.com",
                "worker_role": "Duplicate stale role",
                "required": 1,
            },
            {
                "sequence": 3,
                "worker_user": "removed@example.com",
                "worker_role": "Removed worker",
                "required": 1,
            },
        ]
        api, fixtures, _, _, _, frappe_module = self.load_api(fixtures)
        frappe_module.session.user = "supervisor@example.com"

        api.release_work_package(
            **self.field_args(
                actor_user="supervisor@example.com",
                device_action_id="draft-release-roster-0001",
            )
        )
        roster = fixtures["packages"]["WP-001"]["assigned_workers"]
        self.assertEqual(
            roster,
            [
                {
                    "doctype": "Work Package Worker",
                    "sequence": 1,
                    "worker_user": "crew@example.com",
                    "worker_role": "Production direct assignment",
                    "required": 1,
                }
            ],
        )

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
                evidence_item_id="EVI-HOLD-001",
            )
        )
        frappe_module.session.user = "supervisor@example.com"
        api.release_hold_point(
            **self.field_args(
                device_action_id="hold-release-0001",
                actor_user="supervisor@example.com",
                hold_point_sequence=1,
                    evidence_item_id="EVI-HOLD-001",
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

    def test_future_hold_cannot_release_before_start_but_does_not_block_start(self) -> None:
        fixtures = self.fixtures(status="Released")
        fixtures["packages"]["WP-001"]["hold_points"][0]["release_phase"] = "In-process"
        api, fixtures, _, _, _, frappe_module = self.load_api(fixtures)

        api.acknowledge_work_package(**self.field_args(device_action_id="phase-ack-0001"))
        api.submit_hold_point_evidence(
            **self.field_args(
                device_action_id="phase-evidence-0001",
                hold_point_sequence=1,
                evidence_item_id="EVI-HOLD-001",
            )
        )
        frappe_module.session.user = "supervisor@example.com"
        with self.assertRaisesRegex(FakeValidationError, "work_package_transition_conflict"):
            api.release_hold_point(
                **self.field_args(
                    actor_user="supervisor@example.com",
                    device_action_id="phase-release-before-start-1",
                    hold_point_sequence=1,
                    evidence_item_id="EVI-HOLD-001",
                )
            )

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        started = api.start_work(
            **self.field_args(device_action_id="phase-start-0001")
        )
        self.assertEqual(started["work_package"]["status"], "In Progress")

        frappe_module.session.user = "supervisor@example.com"
        released = api.release_hold_point(
            **self.field_args(
                actor_user="supervisor@example.com",
                device_action_id="phase-release-after-start-1",
                hold_point_sequence=1,
                evidence_item_id="EVI-HOLD-001",
            )
        )
        self.assertEqual(released["event"]["event_type"], "Hold Point Released")

    def test_completion_requires_accepted_current_evidence_and_independent_authority(self) -> None:
        fixtures = self.fixtures(status="In Progress")
        package = fixtures["packages"]["WP-001"]
        package.update(
            {
                "acknowledged_by": "crew@example.com",
                "acknowledged_at": "2026-07-10 09:00:00",
                "acknowledgement_device_action_id": "ack-complete-1",
                "started_at": "2026-07-10 09:05:00",
            }
        )
        package["hold_points"][0].update(
            {
                "required_evidence": "Deck inspection photo.",
                "acceptance_criteria": "Deck condition is visible.",
            }
        )
        fixtures["evidence"][1].update(
            {
                "evidence_slot_id": "hold:1",
                "evidence_requirement": "Deck inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_device_id": "paired-device-1",
                "captured_at": "2026-07-10 09:20:00",
                "evidence_freshness": "Current",
                "evidence_conflict_state": "None",
            }
        )
        fixtures["evidence"][0]["captured_at"] = "2026-07-10 09:20:00"
        fixtures["events"].extend(
            [
                {
                    "name": "ack-complete-event-1",
                    "work_package_event_id": "ack-complete-event-1",
                    "event_type": "Acknowledged",
                    "work_package": "WP-001",
                    "roof_job": "JOB-001",
                    "job_assignment": "ASSIGN-001",
                    "work_package_version": 1,
                    "release_attempt_id": "wpe_release_attempt_00000001",
                    "actor_user": "crew@example.com",
                    "actor_role": "Production direct assignment",
                    "device_action_id": "ack-complete-1",
                },
                {
                    "name": "hold-complete-event-1",
                    "work_package_event_id": "hold-complete-event-1",
                    "event_type": "Hold Point Released",
                    "work_package": "WP-001",
                    "roof_job": "JOB-001",
                    "job_assignment": "ASSIGN-001",
                    "work_package_version": 1,
                    "release_attempt_id": "wpe_release_attempt_00000001",
                    "actor_user": "supervisor@example.com",
                    "actor_role": "IronWrap Production",
                    "device_action_id": "hold-complete-1",
                    "hold_point_sequence": 1,
                    "evidence_item": "EVIDENCE-NAME-HOLD-001",
                },
            ]
        )
        api, fixtures, _, _, _, frappe_module = self.load_api(fixtures)
        frappe_module.session.user = "supervisor@example.com"
        with self.assertRaisesRegex(FakeValidationError, "evidence_pending"):
            api.complete_work_package(
                **self.field_args(
                    actor_user="supervisor@example.com",
                    device_action_id="complete-before-evidence-1",
                )
            )

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        for suffix, evidence_id, slot_id, requirement in (
            ("step", "EVI-001", "step:1", "Anchor inspection photo."),
            ("hold", "EVI-HOLD-001", "hold:1", "Deck inspection photo."),
        ):
            api.capture_work_package_evidence(
                **self.field_args(
                    actor_user="crew@example.com",
                    device_action_id=f"capture-{suffix}-complete-1",
                    evidence_slot_id=slot_id,
                    evidence_requirement=requirement,
                    evidence_source="worker-camera",
                    evidence_item_id=evidence_id,
                    evidence_device_id="paired-device-1",
                    evidence_captured_at="2026-07-10 09:20:00",
                )
            )
        frappe_module.session.user = "supervisor@example.com"
        for suffix, event in (("step", "wpe_"), ("hold", "wpe_")):
            capture = next(
                row
                for row in fixtures["events"]
                if row.get("event_type") == "Evidence Captured"
                and row.get("evidence_slot_id") == f"{suffix}:1"
            )
            api.review_work_package_evidence(
                work_package_id="WP-001",
                work_package_version=1,
                roof_job_id="JOB-001",
                job_assignment_id="ASSIGN-001",
                actor_user="supervisor@example.com",
                device_action_id=f"review-{suffix}-complete-1",
                evidence_event_id=capture["name"],
                evidence_item_id=capture["evidence_item"],
                evidence_slot_id=f"{suffix}:1",
                disposition="Accepted",
            )
        frappe_module.session.user = "worker@ironwrapexteriors.com"
        completed = api.complete_work_package(
            **self.field_args(
                actor_user="supervisor@example.com",
                device_action_id="complete-package-0001",
            )
        )
        self.assertEqual(completed["work_package"]["status"], "Completed")
        self.assertEqual(completed["event"]["event_type"], "Completed")
        self.assertTrue(
            api.complete_work_package(
                **self.field_args(
                    actor_user="supervisor@example.com",
                    device_action_id="complete-package-0001",
                )
            )["idempotent_replay"]
        )

    def test_multi_worker_acknowledgements_are_per_actor_and_start_fails_closed_until_all_ack(self) -> None:
        fixtures = self.fixtures()
        fixtures["packages"]["WP-001"]["assigned_workers"] = [
            {
                "sequence": 1,
                "worker_user": "crew-a@example.com",
                "worker_role": "Installer",
                "required": 1,
            },
            {
                "sequence": 2,
                "worker_user": "crew-b@example.com",
                "worker_role": "Spotter",
                "required": 1,
            },
        ]
        fixtures["assignments"]["ASSIGN-001"].update(
            {"assigned_user": None, "crew_profile": "CREW-001"}
        )
        fixtures["crews"]["CREW-001"] = {"name": "CREW-001", "status": "Active"}
        fixtures["crew_members"] = [
            {
                "parent": "CREW-001",
                "crew_user": "crew-a@example.com",
                "crew_role": "Installer",
                "active": 1,
            },
            {
                "parent": "CREW-001",
                "crew_user": "crew-b@example.com",
                "crew_role": "Spotter",
                "active": 1,
            },
        ]
        fixtures["users"].update(
            {
                "crew-a@example.com": {"name": "crew-a@example.com", "enabled": 1},
                "crew-b@example.com": {"name": "crew-b@example.com", "enabled": 1},
            }
        )
        api, fixtures, _, _, _, _ = self.load_api(fixtures)

        first = api.acknowledge_work_package(
            **self.field_args(
                actor_user="crew-a@example.com",
                device_action_id="ack-crew-a-0001",
            )
        )
        self.assertFalse(first["idempotent_replay"])
        with self.assertRaisesRegex(FakeValidationError, "workers_pending"):
            api.start_work(
                **self.field_args(
                    actor_user="crew-a@example.com",
                    device_action_id="start-before-all-1",
                )
            )

        second = api.acknowledge_work_package(
            **self.field_args(
                actor_user="crew-b@example.com",
                device_action_id="ack-crew-b-0001",
            )
        )
        self.assertFalse(second["idempotent_replay"])
        self.assertEqual(
            {event["actor_user"] for event in fixtures["events"] if event["event_type"] == "Acknowledged"},
            {"crew-a@example.com", "crew-b@example.com"},
        )
        self.assertEqual(
            {event["actor_role"] for event in fixtures["events"] if event["event_type"] == "Acknowledged"},
            {"Installer", "Spotter"},
        )
        with self.assertRaisesRegex(FakeValidationError, "hold_points_pending"):
            api.start_work(
                **self.field_args(
                    actor_user="crew-a@example.com",
                    device_action_id="start-after-all-1",
                )
            )

    def test_typed_evidence_slots_replay_and_correct_once_without_mutating_history(self) -> None:
        fixtures = self.fixtures(status="In Progress")
        fixtures["packages"]["WP-001"].update(
            {
                "acknowledged_by": "crew@example.com",
                "acknowledged_at": "2026-07-10 09:00:00",
                "acknowledgement_device_action_id": "ack-00000001",
                "started_at": "2026-07-10 09:05:00",
            }
        )
        fixtures["evidence"].extend(
            [
                {
                    "name": "EVIDENCE-NAME-002",
                "evidence_id": "EVI-002",
                "roof_job": "JOB-001",
                "sync_state": "Verified",
                "capture_actor": "crew@example.com",
                "work_package": "WP-001",
                "work_package_version": 1,
                "evidence_slot_id": "step:1",
                "evidence_device_id": "paired-device-1",
                "evidence_requirement": "Anchor inspection photo.",
                "evidence_source": "worker-camera",
                "captured_at": "2026-07-10 09:20:00",
                "evidence_freshness": "Current",
                    "evidence_conflict_state": "None",
                    "work_package_release_attempt_id": "wpe_release_attempt_00000001",
                    "evidence_verification": "Verified",
                    "evidence_disposition": "Open",
                    "correction_of": "EVIDENCE-NAME-001",
                },
            ]
        )
        api, fixtures, _, _, _, _ = self.load_api(fixtures)
        capture_args = self.field_args(
            work_package_version=1,
            device_action_id="evidence-0001",
            evidence_slot_id="step:1",
            evidence_requirement="Anchor inspection photo.",
            evidence_source="worker-camera",
            evidence_item_id="EVI-001",
            evidence_device_id="paired-device-1",
            evidence_captured_at="2026-07-10 09:15:00",
        )

        first = api.capture_work_package_evidence(**capture_args)
        first_event = fixtures["events"][-1]
        self.assertFalse(first["idempotent_replay"])
        self.assertEqual(first_event["event_type"], "Evidence Captured")
        self.assertEqual(first_event["evidence_slot_id"], "step:1")
        self.assertEqual(first_event["evidence_requirement"], "Anchor inspection photo.")
        self.assertEqual(first_event["evidence_device_id"], "paired-device-1")

        replay = api.capture_work_package_evidence(**capture_args)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(len(fixtures["events"]), 1)

        correction_args = {
            **capture_args,
            "device_action_id": "evidence-correction-01",
            "evidence_item_id": "EVI-002",
            "evidence_captured_at": "2026-07-10 09:20:00",
            "evidence_correction_of": first_event["name"],
            "evidence_item_correction_of": "EVIDENCE-NAME-001",
            "correction_reason": "Anchor was re-photographed after the tie-off condition changed.",
        }
        corrected = api.capture_work_package_evidence(**correction_args)
        self.assertFalse(corrected["idempotent_replay"])
        self.assertEqual(len(fixtures["events"]), 2)
        self.assertEqual(fixtures["events"][0]["evidence_disposition"], "Open")
        self.assertEqual(fixtures["events"][1]["evidence_correction_of"], first_event["name"])

        with self.assertRaisesRegex(FakeValidationError, "correction_conflict"):
            api.capture_work_package_evidence(
                **{
                    **correction_args,
                    "device_action_id": "evidence-correction-02",
                    "evidence_item_id": "EVI-002",
                }
            )

    def test_typed_evidence_can_be_captured_from_released_package(self) -> None:
        api, fixtures, _, _, _, _ = self.load_api(self.fixtures(status="Released"))
        result = api.capture_work_package_evidence(
            **self.field_args(
                work_package_version=1,
                device_action_id="evidence-released-1",
                evidence_slot_id="step:1",
                evidence_requirement="Anchor inspection photo.",
                evidence_source="worker-camera",
                evidence_item_id="EVI-001",
                evidence_device_id="paired-device-1",
                evidence_captured_at="2026-07-10 09:15:00",
            )
        )

        self.assertFalse(result["idempotent_replay"])
        self.assertEqual(fixtures["events"][-1]["event_type"], "Evidence Captured")

        with self.assertRaisesRegex(FakeValidationError, "verification_forbidden"):
            api.capture_work_package_evidence(
                **self.field_args(
                    device_action_id="evidence-forged-verification",
                    evidence_slot_id="step:1",
                    evidence_requirement="Anchor inspection photo.",
                    evidence_source="worker-camera",
                    evidence_item_id="EVI-001",
                    evidence_device_id="paired-device-1",
                    evidence_captured_at="2026-07-10 09:15:00",
                    evidence_verification="Pending",
                )
            )

    def test_typed_evidence_correction_rejects_cross_paired_event_and_item_identities(self) -> None:
        fixtures = self.fixtures(status="In Progress")
        fixtures["packages"]["WP-001"].update(
            {
                "acknowledged_by": "crew@example.com",
                "acknowledged_at": "2026-07-10 09:00:00",
                "acknowledgement_device_action_id": "ack-00000001",
                "started_at": "2026-07-10 09:05:00",
            }
        )
        fixtures["evidence"].append(
            {
                "name": "EVIDENCE-NAME-002",
                "evidence_id": "EVI-002",
                "roof_job": "JOB-001",
                "sync_state": "Verified",
                "capture_actor": "crew@example.com",
                "work_package": "WP-001",
                "work_package_version": 1,
                "evidence_slot_id": "step:1",
                "evidence_requirement": "Anchor inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_device_id": "paired-device-1",
                "work_package_release_attempt_id": "wpe_release_attempt_00000001",
                "evidence_verification": "Verified",
                "evidence_disposition": "Open",
                "correction_of": "EVIDENCE-NAME-001",
            }
        )
        fixtures["evidence"].append(
            {
                "name": "EVIDENCE-NAME-003",
                "evidence_id": "EVI-003",
                "roof_job": "JOB-001",
                "sync_state": "Verified",
                "capture_actor": "crew@example.com",
                "work_package": "WP-001",
                "work_package_version": 1,
                "evidence_slot_id": "step:1",
                "evidence_requirement": "Anchor inspection photo.",
                "evidence_source": "worker-camera",
                "evidence_device_id": "paired-device-1",
                "captured_at": "2026-07-10 09:20:00",
                "work_package_release_attempt_id": "wpe_release_attempt_00000001",
                "evidence_freshness": "Current",
                "evidence_conflict_state": "None",
                "evidence_verification": "Verified",
                "evidence_disposition": "Open",
                "correction_of": "EVIDENCE-NAME-002",
            }
        )
        api, fixtures, _, _, _, _ = self.load_api(fixtures)
        first = api.capture_work_package_evidence(
            **self.field_args(
                device_action_id="cross-pair-prior-0001",
                evidence_slot_id="step:1",
                evidence_requirement="Anchor inspection photo.",
                evidence_source="worker-camera",
                evidence_item_id="EVI-001",
                evidence_device_id="paired-device-1",
                evidence_captured_at="2026-07-10 09:15:00",
            )
        )
        prior_event = first["event"]["name"]

        with self.assertRaisesRegex(FakeValidationError, "correction_mismatch"):
            api.capture_work_package_evidence(
                **self.field_args(
                    device_action_id="cross-pair-correction-0001",
                    evidence_slot_id="step:1",
                    evidence_requirement="Anchor inspection photo.",
                    evidence_source="worker-camera",
                    evidence_item_id="EVI-003",
                    evidence_device_id="paired-device-1",
                    evidence_captured_at="2026-07-10 09:20:00",
                    evidence_correction_of=prior_event,
                    evidence_item_correction_of="EVIDENCE-NAME-002",
                    correction_reason="The event and item identities were intentionally crossed.",
                )
            )
        self.assertEqual(len(fixtures["events"]), 1)

    def test_evidence_review_is_role_bound_append_only_and_replay_safe(self) -> None:
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
                "name": "EVIDENCE-REVIEW-TARGET",
                "work_package_event_id": "EVIDENCE-REVIEW-TARGET",
                "event_type": "Evidence Captured",
                "work_package": "WP-001",
                "roof_job": "JOB-001",
                "job_assignment": "ASSIGN-001",
                "work_package_version": 1,
                "release_attempt_id": "wpe_release_attempt_00000001",
                "actor_user": "crew@example.com",
                "actor_role": "Production direct assignment",
                "device_action_id": "evidence-review-target-0001",
                "occurred_at": "2026-07-10 09:15:00",
                "evidence_item": "EVIDENCE-NAME-001",
                "evidence_slot_id": "step:1",
                "evidence_disposition": "Open",
            }
        )
        api, fixtures, _, _, _, frappe_module = self.load_api(
            fixtures,
            roles_by_user={
                "crew@example.com": ["IronWrap Field"],
                "supervisor@example.com": ["IronWrap Production"],
            },
        )
        frappe_module.session.user = "supervisor@example.com"
        review_args = {
            "work_package_id": "WP-001",
            "work_package_version": 1,
            "roof_job_id": "JOB-001",
            "job_assignment_id": "ASSIGN-001",
            "actor_user": "supervisor@example.com",
            "device_action_id": "evidence-review-0001",
            "evidence_event_id": "EVIDENCE-REVIEW-TARGET",
            "evidence_item_id": "EVIDENCE-NAME-001",
            "evidence_slot_id": "step:1",
            "disposition": "Accepted",
        }
        reviewed = api.review_work_package_evidence(**review_args)
        self.assertFalse(reviewed["idempotent_replay"])
        self.assertEqual(fixtures["events"][-1]["event_type"], "Evidence Reviewed")
        self.assertEqual(fixtures["events"][-1]["evidence_review_of"], "EVIDENCE-REVIEW-TARGET")
        self.assertEqual(fixtures["events"][-1]["evidence_disposition"], "Accepted")

        replay = api.review_work_package_evidence(**review_args)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(len(fixtures["events"]), 2)
        with self.assertRaisesRegex(FakeValidationError, "replay_conflict"):
            api.review_work_package_evidence(
                **{**review_args, "disposition": "Needs Correction", "review_reason": "Fresh review required."}
            )
        with self.assertRaisesRegex(FakeValidationError, "review_conflict"):
            api.review_work_package_evidence(
                **{**review_args, "device_action_id": "evidence-review-0002"}
            )
        with self.assertRaisesRegex(FakeValidationError, "review_reason"):
            api.review_work_package_evidence(
                **{**review_args, "device_action_id": "evidence-review-0003", "disposition": "Needs Correction"}
            )

        frappe_module.session.user = "crew@example.com"
        with self.assertRaisesRegex(FakePermissionError, "release_role_denied"):
            api.review_work_package_evidence(
                **{**review_args, "device_action_id": "evidence-review-0004", "actor_user": "crew@example.com"}
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
        self.assertEqual(package["assigned_workers"][0]["worker_user"], "crew@example.com")
        self.assertTrue(
            any(event["event_type"] == "Stop Work" for event in fixtures["events"])
        )
        self.assertEqual(len(fixtures["events"]), 3)

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        resumed = api.acknowledge_work_package(
            **self.field_args(
                device_action_id="ack-00000002",
                release_attempt_id=fixtures["packages"]["WP-001"]["release_attempt_id"],
            )
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

    def test_acknowledgement_from_prior_release_attempt_cannot_satisfy_resumed_package(self) -> None:
        api, fixtures, _, _, _, frappe_module = self.load_api()
        attempt_a = fixtures["packages"]["WP-001"]["release_attempt_id"]

        api.stop_work(
            **self.field_args(
                device_action_id="attempt-a-stop-0001",
                blocker_reason="Wind exceeds the released limit.",
            )
        )
        frappe_module.session.user = "supervisor@example.com"
        resumed = api.release_work_package(
            **self.field_args(
                actor_user="supervisor@example.com",
                device_action_id="attempt-b-release-0001",
            )
        )
        attempt_b = resumed["work_package"]["release_attempt_id"]
        self.assertNotEqual(attempt_a, attempt_b)

        frappe_module.session.user = "worker@ironwrapexteriors.com"
        with self.assertRaisesRegex(FakeValidationError, "work_package_release_attempt_conflict"):
            api.acknowledge_work_package(
                **self.field_args(
                    device_action_id="attempt-a-queued-ack-0001",
                    release_attempt_id=attempt_a,
                )
            )
        self.assertEqual(
            [event for event in fixtures["events"] if event["event_type"] == "Acknowledged"],
            [],
        )

        current = api.acknowledge_work_package(
            **self.field_args(
                device_action_id="attempt-b-ack-0001",
                release_attempt_id=attempt_b,
            )
        )
        self.assertFalse(current["idempotent_replay"])
        self.assertEqual(current["event"]["release_attempt_id"], attempt_b)

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
