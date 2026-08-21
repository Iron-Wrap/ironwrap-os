"""Bounded fleet capture command tests (IRO-54)."""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "fleet_operations_api.py"
)
VALIDATION_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "document_validation.py"
)
ISSUER = "worker@ironwrapexteriors.invalid"
DRIVER = "driver@example.invalid"
MANIFEST_KEY = "fleet/v1/abcdef0123456789abcdef01/pre_trip_inspection/device-fleet-0001/manifest.json"


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, on_write) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_write", on_write)
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
            raise AssertionError("a bounded fleet mutation must not use generic writes")
        self.save_count += 1
        self._on_write("save", self)

    def insert(self, *, ignore_permissions: bool = False) -> None:
        if not ignore_permissions:
            raise AssertionError("a bounded fleet capture must not use generic writes")
        self.insert_count += 1
        self.setdefault(
            "name",
            self.get("asset_inspection_id")
            or self.get("asset_defect_id")
            or self.get("evidence_id"),
        )
        self["name"] = (
            self.get("asset_inspection_id")
            or self.get("asset_defect_id")
            or self.get("evidence_id")
        )
        self._on_write("insert", self)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []
        self.relationship_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        # The actor/asset relationship lookups are deliberately unlocked: they
        # only read supporting rows, and locking Cargo Load after Fleet Asset
        # would invert the release fence's own lock order.  Every row the
        # capture actually writes against still has to be locked.
        if "`tabCrew Member`" in normalized:
            self.relationship_queries.append(normalized)
            return [
                dict(row)
                for row in self.fixtures.get("crew_members", [])
                if row.get("parent") == values[0] and row.get("crew_user") == values[1]
            ]
        if "`tabCargo Load`" in normalized:
            self.relationship_queries.append(normalized)
            asset_name, actor = values[0], values[-1]
            statuses = set(values[2:-2])
            return [
                {"name": row["name"]}
                for row in self.fixtures.get("cargo_loads", [])
                if asset_name in (row.get("fleet_asset"), row.get("trailer_asset"))
                and row.get("status") in statuses
                and actor
                in (row.get("driver_user"), row.get("driver_authority_user"))
            ]
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabUser`" in normalized:
            user = self.fixtures["users"].get(values[0])
            return [dict(user)] if user else []
        if "`tabFleet Asset`" in normalized:
            return [
                {"name": row["name"], "fleet_asset_id": row["fleet_asset_id"]}
                for row in self.fixtures["assets"].values()
                if row.get("name") in values or row.get("fleet_asset_id") in values
            ]
        if "`tabAsset Inspection`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["inspections"]
                if row.get("device_action_id") == values[0]
            ]
        if "`tabAsset Defect`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["defects"]
                if row.get("device_action_id") == values[0]
            ]
        if "`tabEvidence Item`" in normalized:
            return [
                dict(row)
                for row in self.fixtures.get("evidence_items", [])
                if row.get("evidence_id") == values[0]
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class FleetOperationsApiTestCase(unittest.TestCase):
    def fixtures(self, *, asset_status: str = "Active") -> dict:
        return {
            "assets": {
                "asset-truck-1": {
                    "name": "asset-truck-1",
                    "fleet_asset_id": "asset-truck-1",
                    "asset_kind": "Vehicle",
                    "status": asset_status,
                    "custody_holder_type": "User",
                    "custody_crew_profile": None,
                    "custody_user": DRIVER,
                    "last_inspection": None,
                    "last_inspection_at": None,
                    "next_inspection_due": None,
                    "out_of_service_reason": None,
                    "out_of_service_at": None,
                }
            },
            "crew_members": [],
            "cargo_loads": [],
            "users": {
                DRIVER: {"name": DRIVER, "enabled": 1},
                "retired@example.invalid": {
                    "name": "retired@example.invalid",
                    "enabled": 0,
                },
            },
            "inspections": [],
            "defects": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = ISSUER,
        configured_issuer: str | None = ISSUER,
        request_method: str = "POST",
        can_permission: bool = True,
    ):
        fixtures = fixtures if fixtures is not None else self.fixtures()
        db = FakeDb(fixtures)
        transition_calls: list[dict] = []

        @contextmanager
        def asset_inspection_transition_context(document):
            transition_calls.append(dict(document))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.asset_inspection_transition_context = (
            asset_inspection_transition_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = (
            {"ironwrap_fleet_capture_issuer_user": configured_issuer}
            if configured_issuer is not None
            else {}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-11 07:00:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: can_permission
        frappe_module.whitelist = lambda: lambda function: function

        def on_write(action: str, document: FakeDocument) -> None:
            if document.get("doctype") == "Asset Inspection":
                fixtures["inspections"].append(dict(document))
            elif document.get("doctype") == "Asset Defect":
                fixtures["defects"].append(dict(document))
            elif document.get("doctype") == "Evidence Item":
                fixtures.setdefault("evidence_items", []).append(dict(document))
            else:
                fixtures["assets"][document["name"]] = dict(document)

        def get_doc(*args):
            if len(args) == 2:
                doctype, name = args
                if doctype != "Fleet Asset":
                    raise AssertionError(f"unexpected doctype: {doctype}")
                return FakeDocument(dict(fixtures["assets"][name]), on_write)
            if len(args) == 1 and isinstance(args[0], dict):
                return FakeDocument(dict(args[0]), on_write)
            raise AssertionError(f"unexpected get_doc args: {args!r}")

        frappe_module.get_doc = get_doc
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))
        spec = importlib.util.spec_from_file_location(
            "ironwrap_fleet_operations_api_under_test", API_PATH
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
        return module, fixtures, db, transition_calls

    @staticmethod
    def inspection(**overrides: object) -> dict:
        payload: dict = {
            "performed_at": "2026-07-11T06:30:00.000Z",
            "meter_reading": 142000,
            "items": [
                {"sequence": 1, "check_point": "Brakes", "result": "Pass"},
                {"sequence": 2, "check_point": "Lights", "result": "Pass"},
            ],
        }
        payload.update(overrides)
        return payload

    def record_inspection(self, module, **overrides: object):
        arguments: dict = {
            "fleet_asset_id": "asset-truck-1",
            "actor_user": DRIVER,
            "device_action_id": "device-fleet-0001",
            "manifest_key": MANIFEST_KEY,
            "inspection_type": "Pre-Trip",
            "inspection": self.inspection(),
        }
        arguments.update(overrides)
        return module.record_asset_inspection(**arguments)


class InspectionCaptureTests(FleetOperationsApiTestCase):
    def test_a_passing_capture_lands_as_a_submitted_manifest_bound_record(self) -> None:
        module, fixtures, db, transitions = self.load_api()
        result = self.record_inspection(module)

        self.assertFalse(result["idempotent_replay"])
        self.assertEqual(result["record"]["status"], "Submitted")
        self.assertEqual(result["record"]["result"], "Pass")
        self.assertEqual(result["record"]["defect_count"], 0)
        self.assertEqual(result["record"]["performed_by"], DRIVER)
        self.assertEqual(len(fixtures["inspections"]), 1)
        stored = fixtures["inspections"][0]
        self.assertEqual(stored["raw_key"], MANIFEST_KEY)
        self.assertEqual(stored["sync_state"], "Uploaded")
        self.assertEqual(stored["capture_actor"], DRIVER)
        self.assertEqual(len(stored["items"]), 2)
        # The lifecycle fact only exists inside the private transition context.
        self.assertEqual(len(transitions), 1)
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Active")

    def test_an_out_of_service_finding_stops_the_asset_immediately(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_inspection(
            module,
            inspection=self.inspection(
                items=[
                    {
                        "sequence": 1,
                        "check_point": "Brakes",
                        "result": "Fail",
                        "severity": "Out of Service",
                        "observation": "Air leak at the rear chamber.",
                    }
                ]
            ),
        )

        self.assertEqual(result["record"]["result"], "Fail")
        self.assertEqual(result["record"]["defect_count"], 1)
        asset = fixtures["assets"]["asset-truck-1"]
        self.assertEqual(asset["status"], "Out of Service")
        self.assertIn("device-fleet-0001", asset["out_of_service_reason"])
        self.assertEqual(asset["out_of_service_at"], "2026-07-11 06:30:00")

    def test_a_minor_finding_records_defects_without_stopping_the_asset(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_inspection(
            module,
            inspection=self.inspection(
                items=[
                    {
                        "sequence": 1,
                        "check_point": "Mirror",
                        "result": "Fail",
                        "severity": "Minor",
                    }
                ]
            ),
        )

        self.assertEqual(result["record"]["result"], "Pass With Defects")
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Active")

    def test_nothing_here_can_return_an_asset_to_service(self) -> None:
        module, fixtures, _db, _transitions = self.load_api(
            self.fixtures(asset_status="Out of Service")
        )
        self.record_inspection(module, inspection_type="Return To Service")

        self.assertEqual(
            fixtures["assets"]["asset-truck-1"]["status"],
            "Out of Service",
            "returning an asset to service stays a supervised Maintenance Order decision",
        )

    def test_a_lost_connectivity_replay_returns_the_first_capture(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        first = self.record_inspection(module)
        replay = self.record_inspection(module)

        self.assertFalse(first["idempotent_replay"])
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["record"]["name"], first["record"]["name"])
        self.assertEqual(len(fixtures["inspections"]), 1)

    def test_a_duplicate_device_action_with_different_facts_is_a_conflict(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        self.record_inspection(module)

        with self.assertRaises(FakeValidationError) as caught:
            self.record_inspection(
                module,
                inspection=self.inspection(performed_at="2026-07-11T07:45:00.000Z"),
            )
        self.assertIn("fleet_capture_replay_conflict", str(caught.exception))
        self.assertEqual(len(fixtures["inspections"]), 1)

    def test_a_failed_check_point_must_declare_a_severity(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api()
        with self.assertRaises(FakeValidationError):
            self.record_inspection(
                module,
                inspection=self.inspection(
                    items=[{"sequence": 1, "check_point": "Brakes", "result": "Fail"}]
                ),
            )
        with self.assertRaises(FakeValidationError):
            self.record_inspection(
                module,
                inspection=self.inspection(
                    items=[
                        {
                            "sequence": 1,
                            "check_point": "Brakes",
                            "result": "Pass",
                            "severity": "Major",
                        }
                    ]
                ),
            )

    def test_the_capture_envelope_is_bounded(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api()
        rejected = {
            "an out-of-order item sequence": self.inspection(
                items=[{"sequence": 2, "check_point": "Brakes", "result": "Pass"}]
            ),
            "an empty item list": self.inspection(items=[]),
            "a non-UTC timestamp": self.inspection(performed_at="2026-07-11 06:30:00"),
            "a negative meter reading": self.inspection(meter_reading=-5),
        }
        for label, payload in rejected.items():
            with self.subTest(case=label):
                with self.assertRaises(FakeValidationError):
                    self.record_inspection(module, inspection=payload)
        with self.assertRaises(FakeValidationError):
            self.record_inspection(module, inspection_type="Roadside")
        with self.assertRaises(FakeValidationError):
            self.record_inspection(module, device_action_id="short")

    def test_a_telematics_reference_rides_along_with_the_physical_inspector(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        self.record_inspection(
            module,
            inspection=self.inspection(telematics_reference="samsara:trip-9"),
        )
        stored = fixtures["inspections"][0]
        self.assertEqual(stored["telematics_reference"], "samsara:trip-9")
        self.assertEqual(
            stored["performed_by"],
            DRIVER,
            "the recorded inspector is always the authenticated physical actor",
        )

    def test_only_the_configured_worker_principal_may_capture(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api(
            session_user="crew@example.invalid"
        )
        with self.assertRaises(FakePermissionError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_issuer_auth_mismatch", str(caught.exception))

        module, _fixtures, _db, _transitions = self.load_api(configured_issuer=None)
        with self.assertRaises(FakePermissionError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_issuer_not_configured", str(caught.exception))

        module, _fixtures, _db, _transitions = self.load_api(request_method="GET")
        with self.assertRaises(FakePermissionError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_post_required", str(caught.exception))

        module, _fixtures, _db, _transitions = self.load_api(can_permission=False)
        with self.assertRaises(FakePermissionError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_issuer_permission_denied", str(caught.exception))

    def test_a_disabled_actor_or_unknown_asset_is_refused(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api()
        with self.assertRaises(FakePermissionError) as caught:
            self.record_inspection(module, actor_user="retired@example.invalid")
        self.assertIn("fleet_actor_not_enabled", str(caught.exception))

        module, _fixtures, _db, _transitions = self.load_api()
        with self.assertRaises(FakeValidationError) as caught:
            self.record_inspection(module, fleet_asset_id="asset-truck-9")
        self.assertIn("fleet_asset_not_found", str(caught.exception))

    def test_a_retired_asset_refuses_any_capture(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api(
            self.fixtures(asset_status="Retired")
        )
        with self.assertRaises(FakeValidationError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_asset_retired", str(caught.exception))


class DefectCaptureTests(FleetOperationsApiTestCase):
    def record_defect(self, module, **overrides: object):
        defect: dict = {
            "detected_at": "2026-07-11T06:35:00.000Z",
            "severity": "Out of Service",
            "description": "Air brake chamber leaking.",
            "asset_inspection_id": "inspection:device-fleet-0001",
        }
        defect.update(overrides.pop("defect", {}))
        arguments: dict = {
            "fleet_asset_id": "asset-truck-1",
            "actor_user": DRIVER,
            "device_action_id": "device-fleet-0002",
            "manifest_key": MANIFEST_KEY,
            "defect": defect,
        }
        arguments.update(overrides)
        return module.record_asset_defect(**arguments)

    def test_an_out_of_service_report_opens_a_defect_and_stops_the_asset(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_defect(module)

        self.assertFalse(result["idempotent_replay"])
        self.assertEqual(result["record"]["status"], "Open")
        self.assertEqual(result["record"]["severity"], "Out of Service")
        self.assertEqual(result["record"]["out_of_service"], 1)
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Out of Service")
        self.assertEqual(fixtures["defects"][0]["raw_key"], MANIFEST_KEY)

    def test_a_minor_report_never_stops_the_asset(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_defect(module, defect={"severity": "Minor"})

        self.assertEqual(result["record"]["out_of_service"], 0)
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Active")

    def test_a_replayed_defect_report_is_idempotent_and_conflict_safe(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        first = self.record_defect(module)
        replay = self.record_defect(module)

        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["record"]["name"], first["record"]["name"])
        self.assertEqual(len(fixtures["defects"]), 1)

        with self.assertRaises(FakeValidationError) as caught:
            self.record_defect(module, defect={"description": "Different fault."})
        self.assertIn("fleet_capture_replay_conflict", str(caught.exception))

    def test_an_unsupported_severity_is_refused(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api()
        with self.assertRaises(FakeValidationError):
            self.record_defect(module, defect={"severity": "Cosmetic"})

    def test_photo_evidence_writes_the_defect_evidence_item(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        sha256 = "ab" * 32
        photo = {
            "attachment_id": "photo-fleet-0001",
            "file_name": "chamber.jpg",
            "content_type": "image/jpeg",
            "sha256": sha256,
            "r2_key": "fleet/v1/scope/photo/asset-truck-1/photo-fleet-0001.bin",
        }
        result = self.record_defect(
            module,
            defect={"severity": "Major", "photo_evidence": [photo]},
        )

        evidence_id = f"fleet-photo:device-fleet-0002:{sha256[:16]}"
        self.assertEqual(result["record"]["evidence_item"], evidence_id)
        self.assertEqual(fixtures["defects"][0]["evidence_item"], evidence_id)
        self.assertEqual(len(fixtures["evidence_items"]), 1)
        self.assertEqual(fixtures["evidence_items"][0]["evidence_type"], "Photo")
        self.assertTrue(fixtures["evidence_items"][0]["r2_key"].startswith("fleet/v1/"))

        # A lost-response retry must replay both the defect and the Evidence Item.
        replay = self.record_defect(
            module,
            defect={"severity": "Major", "photo_evidence": [photo]},
        )
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["record"]["evidence_item"], evidence_id)
        self.assertEqual(len(fixtures["evidence_items"]), 1)
        self.assertEqual(len(fixtures["defects"]), 1)


class CaptureAuthorizationTests(FleetOperationsApiTestCase):
    """A capture is only legitimate from an actor who holds or drives the asset."""

    def unrelated_fixtures(self) -> dict:
        fixtures = self.fixtures()
        asset = fixtures["assets"]["asset-truck-1"]
        asset["custody_holder_type"] = "User"
        asset["custody_user"] = "someone.else@example.invalid"
        return fixtures

    def record_defect(self, module, **overrides: object):
        arguments: dict = {
            "fleet_asset_id": "asset-truck-1",
            "actor_user": DRIVER,
            "device_action_id": "device-fleet-0002",
            "manifest_key": MANIFEST_KEY,
            "defect": {
                "detected_at": "2026-07-11T06:35:00.000Z",
                "severity": "Out of Service",
                "description": "Air brake chamber leaking.",
            },
        }
        arguments.update(overrides)
        return module.record_asset_defect(**arguments)

    def test_a_field_actor_with_no_relationship_cannot_capture_against_an_asset(
        self,
    ) -> None:
        module, fixtures, _db, _transitions = self.load_api(self.unrelated_fixtures())

        with self.assertRaises(FakeValidationError) as inspection_refusal:
            self.record_inspection(module)
        self.assertIn("fleet_asset_not_found", str(inspection_refusal.exception))

        with self.assertRaises(FakeValidationError) as defect_refusal:
            self.record_defect(module)
        self.assertIn("fleet_asset_not_found", str(defect_refusal.exception))

        # Nothing was written, and the asset a stranger tried to ground is still
        # Active — this is the fleet-grounding path the fence exists to close.
        self.assertEqual(fixtures["inspections"], [])
        self.assertEqual(fixtures["defects"], [])
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Active")

    def test_an_unrelated_asset_is_refused_exactly_like_a_missing_one(self) -> None:
        module, _fixtures, _db, _transitions = self.load_api(self.unrelated_fixtures())
        with self.assertRaises(FakeValidationError) as unrelated:
            self.record_inspection(module)
        with self.assertRaises(FakeValidationError) as missing:
            self.record_inspection(module, fleet_asset_id="asset-truck-9")
        # Identical refusals: the rail cannot be used to enumerate the fleet.
        self.assertEqual(str(unrelated.exception), str(missing.exception))

    def test_crew_custody_authorizes_the_crew_member_and_no_one_else(self) -> None:
        fixtures = self.unrelated_fixtures()
        asset = fixtures["assets"]["asset-truck-1"]
        asset["custody_holder_type"] = "Crew"
        asset["custody_crew_profile"] = "crew-1"
        asset["custody_user"] = None
        fixtures["crew_members"] = [
            {"parent": "crew-1", "crew_user": DRIVER, "active": 1}
        ]
        module, fixtures, _db, _transitions = self.load_api(fixtures)
        self.assertEqual(self.record_inspection(module)["record"]["result"], "Pass")

        other = self.fixtures()
        other["assets"]["asset-truck-1"].update(
            custody_holder_type="Crew",
            custody_crew_profile="crew-1",
            custody_user=None,
        )
        other["crew_members"] = [
            {"parent": "crew-2", "crew_user": DRIVER, "active": 1}
        ]
        module, _fixtures, _db, _transitions = self.load_api(other)
        with self.assertRaises(FakeValidationError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_asset_not_found", str(caught.exception))

    def test_driving_an_open_cargo_load_authorizes_the_capture(self) -> None:
        fixtures = self.unrelated_fixtures()
        fixtures["cargo_loads"] = [
            {
                "name": "load-1",
                "fleet_asset": "asset-truck-1",
                "trailer_asset": None,
                "driver_user": DRIVER,
                "status": "Loaded",
            }
        ]
        module, _fixtures, db, _transitions = self.load_api(fixtures)
        self.assertEqual(self.record_inspection(module)["record"]["result"], "Pass")
        self.assertTrue(db.relationship_queries)

        cancelled = self.unrelated_fixtures()
        cancelled["cargo_loads"] = [
            {
                "name": "load-1",
                "fleet_asset": "asset-truck-1",
                "trailer_asset": None,
                "driver_user": DRIVER,
                "status": "Cancelled",
            }
        ]
        module, _fixtures, _db, _transitions = self.load_api(cancelled)
        with self.assertRaises(FakeValidationError) as caught:
            self.record_inspection(module)
        self.assertIn("fleet_asset_not_found", str(caught.exception))

    def test_a_trailer_on_an_open_load_is_reachable_by_its_driver(self) -> None:
        fixtures = self.unrelated_fixtures()
        fixtures["assets"]["trailer-1"] = {
            "name": "trailer-1",
            "fleet_asset_id": "trailer-1",
            "asset_kind": "Trailer",
            "status": "Active",
            "custody_holder_type": "Yard",
            "custody_crew_profile": None,
            "custody_user": None,
            "last_inspection": None,
            "last_inspection_at": None,
            "next_inspection_due": None,
            "out_of_service_reason": None,
            "out_of_service_at": None,
        }
        fixtures["cargo_loads"] = [
            {
                "name": "load-1",
                "fleet_asset": "asset-truck-1",
                "trailer_asset": "trailer-1",
                "driver_user": DRIVER,
                "status": "In Transit",
            }
        ]
        module, _fixtures, _db, _transitions = self.load_api(fixtures)
        result = self.record_inspection(module, fleet_asset_id="trailer-1")
        self.assertEqual(result["record"]["fleet_asset"], "trailer-1")


class InspectionCurrencyTests(FleetOperationsApiTestCase):
    """A passing inspection is what clears the release fence for the asset."""

    def test_a_passing_pre_trip_advances_the_asset_inspection_currency(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_inspection(module)

        # Policy, not the device, decides the interval: a pre-trip is daily.
        self.assertEqual(result["record"]["next_inspection_due"], "2026-07-12")
        asset = fixtures["assets"]["asset-truck-1"]
        self.assertEqual(asset["next_inspection_due"], "2026-07-12")
        self.assertEqual(asset["last_inspection"], "inspection:device-fleet-0001")
        self.assertEqual(asset["last_inspection_at"], "2026-07-11 06:30:00")

    def test_a_failed_inspection_never_advances_currency(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_inspection(
            module,
            inspection=self.inspection(
                items=[
                    {
                        "sequence": 1,
                        "check_point": "Brakes",
                        "result": "Fail",
                        "severity": "Major",
                        "observation": "Rear brake out of adjustment.",
                    }
                ]
            ),
        )

        self.assertEqual(result["record"]["result"], "Fail")
        self.assertIsNone(result["record"]["next_inspection_due"])
        self.assertIsNone(fixtures["assets"]["asset-truck-1"]["next_inspection_due"])
        self.assertIsNone(fixtures["assets"]["asset-truck-1"]["last_inspection"])

    def test_currency_only_ever_moves_forward(self) -> None:
        fixtures = self.fixtures()
        asset = fixtures["assets"]["asset-truck-1"]
        # A periodic inspection already carries this asset well past a daily cycle.
        asset["next_inspection_due"] = "2026-09-30"
        asset["last_inspection"] = "inspection:periodic-1"
        asset["last_inspection_at"] = "2026-07-01 08:00:00"
        module, fixtures, _db, _transitions = self.load_api(fixtures)
        self.record_inspection(module)

        stored = fixtures["assets"]["asset-truck-1"]
        self.assertEqual(stored["next_inspection_due"], "2026-09-30")
        # The newer passing observation still becomes the last inspection.
        self.assertEqual(stored["last_inspection"], "inspection:device-fleet-0001")

    def test_a_pass_with_minor_defects_still_keeps_the_asset_current(self) -> None:
        module, fixtures, _db, _transitions = self.load_api()
        result = self.record_inspection(
            module,
            inspection=self.inspection(
                items=[
                    {
                        "sequence": 1,
                        "check_point": "Mirror",
                        "result": "Fail",
                        "severity": "Minor",
                        "observation": "Chipped mirror housing.",
                    }
                ]
            ),
        )

        self.assertEqual(result["record"]["result"], "Pass With Defects")
        self.assertEqual(
            fixtures["assets"]["asset-truck-1"]["next_inspection_due"], "2026-07-12"
        )
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Active")


class RealTrustGuardInspectionTests(unittest.TestCase):
    """Run the real transition context against the real lifecycle guard.

    Every other test in this suite substitutes a no-op transition context, so
    the ordering between Frappe's naming step and the guard is never observed.
    On a real Frappe core ``insert()`` autonames ``Asset Inspection`` from
    ``asset_inspection_id`` *before* ``validate`` runs, and the guard compares
    the name it then sees against the name the context was opened with.  A
    context opened against an unnamed document therefore authorizes nothing and
    the guard refuses the very bounded command it exists to admit.
    """

    def load_validation(self):
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(
            exc(message)
        )
        spec = importlib.util.spec_from_file_location(
            "ironwrap_document_validation_for_fleet_capture", VALIDATION_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module

    def load_api(self, validation_module, fixtures: dict):
        db = FakeDb(fixtures)
        validated: list[dict] = []

        class NamedDocument(FakeDocument):
            """A document that names itself on insert, the way Frappe does."""

            def get_doc_before_save(self):
                return None

            def insert(self, *, ignore_permissions: bool = False) -> None:
                if not ignore_permissions:
                    raise AssertionError(
                        "a bounded fleet capture must not use generic writes"
                    )
                self.insert_count += 1
                if self.get("doctype") == "Asset Inspection":
                    # `autoname: field:asset_inspection_id` discards whatever
                    # `name` the caller supplied and derives it from the field,
                    # then `validate` runs against the named document.
                    self["name"] = self["asset_inspection_id"]
                    validated.append(dict(self))
                    validation_module.validate_asset_inspection_runtime_mutation(self)
                else:
                    self["name"] = self.get("asset_defect_id")
                self._on_write("insert", self)

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = {"ironwrap_fleet_capture_issuer_user": ISSUER}
        frappe_module.session = types.SimpleNamespace(user=ISSUER)
        frappe_module.request = types.SimpleNamespace(method="POST")
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-11 07:00:00"
        )
        frappe_module.has_permission = lambda *args, **kwargs: True
        frappe_module.whitelist = lambda: lambda function: function

        def on_write(action: str, document) -> None:
            if document.get("doctype") == "Asset Inspection":
                fixtures["inspections"].append(dict(document))
            elif document.get("doctype") == "Asset Defect":
                fixtures["defects"].append(dict(document))
            else:
                fixtures["assets"][document["name"]] = dict(document)

        def get_doc(*args):
            if len(args) == 2:
                doctype, name = args
                if doctype != "Fleet Asset":
                    raise AssertionError(f"unexpected doctype: {doctype}")
                return NamedDocument(dict(fixtures["assets"][name]), on_write)
            if len(args) == 1 and isinstance(args[0], dict):
                return NamedDocument(dict(args[0]), on_write)
            raise AssertionError(f"unexpected get_doc args: {args!r}")

        frappe_module.get_doc = get_doc
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(
            exc(message)
        )
        spec = importlib.util.spec_from_file_location(
            "ironwrap_fleet_operations_api_with_real_guard", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {"frappe": frappe_module, "ironwrap_roofing.document_validation": validation_module},
        ):
            spec.loader.exec_module(module)
        return module, validated

    def test_a_bounded_capture_is_admitted_by_the_real_lifecycle_guard(self) -> None:
        validation_module = self.load_validation()
        fixtures = FleetOperationsApiTestCase().fixtures()
        module, validated = self.load_api(validation_module, fixtures)

        result = module.record_asset_inspection(
            fleet_asset_id="asset-truck-1",
            actor_user=DRIVER,
            device_action_id="device-fleet-0001",
            manifest_key=MANIFEST_KEY,
            inspection_type="Pre-Trip",
            inspection=FleetOperationsApiTestCase.inspection(),
        )

        self.assertEqual(result["record"]["status"], "Submitted")
        self.assertEqual(result["record"]["name"], "inspection:device-fleet-0001")
        # The guard saw the named document, and the row actually landed.
        self.assertEqual(len(validated), 1)
        self.assertEqual(validated[0]["name"], "inspection:device-fleet-0001")
        self.assertEqual(len(fixtures["inspections"]), 1)
        self.assertEqual(
            fixtures["inspections"][0]["name"], "inspection:device-fleet-0001"
        )

    def test_an_out_of_service_capture_is_admitted_and_stops_the_asset(self) -> None:
        validation_module = self.load_validation()
        fixtures = FleetOperationsApiTestCase().fixtures()
        module, _validated = self.load_api(validation_module, fixtures)

        result = module.record_asset_inspection(
            fleet_asset_id="asset-truck-1",
            actor_user=DRIVER,
            device_action_id="device-fleet-0002",
            manifest_key=MANIFEST_KEY,
            inspection_type="Post-Trip",
            inspection=FleetOperationsApiTestCase.inspection(
                items=[
                    {
                        "sequence": 1,
                        "check_point": "Brakes",
                        "result": "Fail",
                        "severity": "Out of Service",
                        "observation": "Air leak at the rear chamber.",
                    }
                ]
            ),
        )

        self.assertEqual(result["record"]["result"], "Fail")
        self.assertEqual(len(fixtures["inspections"]), 1)
        self.assertEqual(fixtures["assets"]["asset-truck-1"]["status"], "Out of Service")

    def test_a_submitted_inspection_outside_the_command_is_still_refused(self) -> None:
        validation_module = self.load_validation()
        unbounded = FakeDocument(
            {
                "doctype": "Asset Inspection",
                "name": "inspection:forged-0001",
                "asset_inspection_id": "inspection:forged-0001",
                "status": "Submitted",
                "result": "Pass",
                "performed_by": DRIVER,
                "performed_at": "2026-07-11 06:30:00",
                "defect_count": 0,
                "sync_state": "Uploaded",
                "verified_at": None,
                "evidence_item": None,
            },
            lambda *args: None,
        )
        unbounded.get_doc_before_save = lambda: None

        with self.assertRaisesRegex(FakeValidationError, "Asset Inspection lifecycle"):
            validation_module.validate_asset_inspection_runtime_mutation(unbounded)


if __name__ == "__main__":
    unittest.main()
