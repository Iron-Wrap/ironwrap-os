"""Read side of the fleet capture rail: the driver's own vehicle panel (IRO-54).

The capture commands were reachable long before any screen called them.  These
tests cover the read that makes the screen possible without widening the rail:
one field actor's own assets, and the release fence's own verdict on each.
"""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.domain_policy import OPEN_OUT_OF_SERVICE_DEFECT_STATUSES


API_PATH = Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "fleet_operations_api.py"
ISSUER = "worker@ironwrapexteriors.invalid"
DRIVER = "driver@example.invalid"
TODAY = "2026-07-11"


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class PanelFakeDb:
    """Answer only the unlocked reads the panel is allowed to make.

    Anything else raises, which is the point: a panel query that quietly took a
    row lock, or reached a DocType outside the driver's own fleet, would fail
    here rather than in production.
    """

    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if "FOR UPDATE" in normalized:
            raise AssertionError(f"the panel read must not lock rows: {normalized}")
        if "SELECT cargo.fleet_asset, cargo.trailer_asset" in normalized:
            statuses = set(values[:-3])
            actor = values[-2]
            return [
                {
                    "fleet_asset": row.get("fleet_asset"),
                    "trailer_asset": row.get("trailer_asset"),
                }
                for row in self.fixtures["cargo_loads"]
                if row.get("status") in statuses
                and actor in (row.get("driver_user"), row.get("driver_authority_user"))
            ]
        if "custody_holder_type = 'User'" in normalized:
            return [
                {"name": row["name"]}
                for row in self.fixtures["assets"].values()
                if row.get("custody_holder_type") == "User"
                and row.get("custody_user") == values[0]
                and row.get("status") != "Retired"
            ]
        if "custody_holder_type = 'Crew'" in normalized:
            crews = {
                row["parent"]
                for row in self.fixtures["crew_members"]
                if row.get("crew_user") == values[0] and row.get("active") == 1
            }
            return [
                {"name": row["name"]}
                for row in self.fixtures["assets"].values()
                if row.get("custody_holder_type") == "Crew"
                and row.get("custody_crew_profile") in crews
                and row.get("status") != "Retired"
            ]
        if "`tabFleet Asset`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["assets"].values()
                if row["name"] in values and row.get("status") != "Retired"
            ]
        if "`tabAsset Defect`" in normalized:
            statuses = set(values[-len(OPEN_OUT_OF_SERVICE_DEFECT_STATUSES) :])
            return [
                {"fleet_asset": row["fleet_asset"]}
                for row in self.fixtures["defects"]
                if row.get("fleet_asset") in values
                and row.get("out_of_service") == 1
                and row.get("status") in statuses
            ]
        if "`tabAsset Inspection`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["inspections"]
                if row.get("fleet_asset") in values
            ]
        if "`tabDriver Authority`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["driver_authorities"]
                if row.get("driver_user") == values[0]
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


def asset(**overrides: object) -> dict:
    row = {
        "name": "asset-truck-1",
        "fleet_asset_id": "TRUCK-01",
        "asset_kind": "Vehicle",
        "status": "Active",
        "display_name": "Truck 01",
        "unit_number": "01",
        "licence_plate": "ABC-123",
        "meter_kind": "Odometer km",
        "current_meter": 142000.0,
        "required_licence_class": None,
        "inspection_authority_source": "Physical Inspection",
        "last_inspection_at": "2026-07-11 06:30:00",
        "next_inspection_due": "2026-07-12",
        "next_service_due_date": None,
        "calibration_required": 0,
        "next_calibration_due": None,
        "registration_expiry": "2027-01-01",
        "insurance_expiry": "2027-01-01",
        "out_of_service_reason": None,
        "custody_holder_type": "User",
        "custody_crew_profile": None,
        "custody_user": DRIVER,
    }
    row.update(overrides)
    return row


class FleetPanelTestCase(unittest.TestCase):
    def fixtures(self, *assets: dict, **overrides: object) -> dict:
        rows = assets or (asset(),)
        base = {
            "assets": {row["name"]: row for row in rows},
            "crew_members": [],
            "cargo_loads": [],
            "defects": [],
            "inspections": [],
            "driver_authorities": [],
        }
        base.update(overrides)
        return base

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
        db = PanelFakeDb(fixtures)
        permission_checks: list[tuple[str, str]] = []

        @contextmanager
        def asset_inspection_transition_context(document):
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

        def has_permission(doctype, *, ptype, user):
            permission_checks.append((doctype, ptype))
            return can_permission

        frappe_module.has_permission = has_permission
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.get_doc = lambda *args: (_ for _ in ()).throw(
            AssertionError("the panel read must not load documents")
        )
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))
        spec = importlib.util.spec_from_file_location(
            "ironwrap_fleet_panel_api_under_test", API_PATH
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
        return module, fixtures, db, permission_checks

    def read(self, module, **overrides: object):
        arguments: dict = {"actor_user": DRIVER, "reference_date": TODAY}
        arguments.update(overrides)
        return module.read_driver_fleet_panel(**arguments)


class PanelScopeTests(FleetPanelTestCase):
    def test_the_custody_holder_sees_their_own_asset_with_no_blocker(self) -> None:
        module, _, db, _ = self.load_api()
        panel = self.read(module)

        self.assertEqual(panel["reference_date"], TODAY)
        self.assertEqual(len(panel["assets"]), 1)
        row = panel["assets"][0]
        self.assertEqual(row["fleet_asset_id"], "TRUCK-01")
        self.assertEqual(row["display_name"], "Truck 01")
        self.assertEqual(row["relationship"], "custody")
        self.assertEqual(row["blockers"], [])
        self.assertEqual(row["last_pre_trip_at"], None)
        self.assertFalse(any("FOR UPDATE" in query for query in db.queries))

    def test_a_crew_member_reaches_the_crew_held_asset(self) -> None:
        fixtures = self.fixtures(
            asset(custody_holder_type="Crew", custody_crew_profile="crew-1", custody_user=None),
            crew_members=[{"parent": "crew-1", "crew_user": DRIVER, "active": 1}],
        )
        module, _, _, _ = self.load_api(fixtures)

        panel = self.read(module)
        self.assertEqual([row["relationship"] for row in panel["assets"]], ["custody"])

    def test_the_driver_of_an_open_load_reaches_the_carrier_and_the_trailer(self) -> None:
        fixtures = self.fixtures(
            asset(custody_holder_type="Yard", custody_user=None),
            asset(
                name="trailer-1",
                fleet_asset_id="TRAILER-01",
                asset_kind="Trailer",
                display_name="Trailer 01",
                custody_holder_type="Yard",
                custody_user=None,
            ),
            cargo_loads=[
                {
                    "name": "load-1",
                    "fleet_asset": "asset-truck-1",
                    "trailer_asset": "trailer-1",
                    "driver_user": DRIVER,
                    "status": "Loaded",
                }
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        panel = self.read(module)
        self.assertEqual(
            sorted(row["fleet_asset_id"] for row in panel["assets"]),
            ["TRAILER-01", "TRUCK-01"],
        )
        self.assertEqual({row["relationship"] for row in panel["assets"]}, {"driver"})

    def test_a_stranger_to_the_fleet_sees_nothing_at_all(self) -> None:
        module, _, _, _ = self.load_api()

        panel = self.read(module, actor_user="stranger@example.invalid")
        self.assertEqual(panel["assets"], [])

    def test_a_retired_asset_never_appears(self) -> None:
        module, _, _, _ = self.load_api(self.fixtures(asset(status="Retired")))

        self.assertEqual(self.read(module)["assets"], [])

    def test_the_panel_never_returns_the_fence_only_columns(self) -> None:
        module, _, _, _ = self.load_api()

        row = self.read(module)["assets"][0]
        for hidden in ("registration_expiry", "insurance_expiry", "custody_user"):
            self.assertNotIn(hidden, row)

    def test_custody_outranks_driving_when_both_bindings_hold(self) -> None:
        fixtures = self.fixtures(
            asset(),
            cargo_loads=[
                {
                    "name": "load-1",
                    "fleet_asset": "asset-truck-1",
                    "trailer_asset": None,
                    "driver_user": DRIVER,
                    "status": "Loaded",
                }
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        self.assertEqual(self.read(module)["assets"][0]["relationship"], "custody")


class PanelBlockerTests(FleetPanelTestCase):
    def blockers(self, module, **overrides: object) -> list[str]:
        return [row["code"] for row in self.read(module, **overrides)["assets"][0]["blockers"]]

    def test_an_overdue_inspection_is_reported_as_the_fence_states_it(self) -> None:
        module, _, _, _ = self.load_api(self.fixtures(asset(next_inspection_due="2026-07-01")))

        row = self.read(module)["assets"][0]
        self.assertEqual([blocker["code"] for blocker in row["blockers"]], ["overdue_fleet_inspection"])
        self.assertEqual(row["blockers"][0]["field"], "next_inspection_due")
        self.assertIn("inspection is overdue", row["blockers"][0]["message"])

    def test_an_out_of_service_asset_reports_the_unsafe_asset_fence(self) -> None:
        module, _, _, _ = self.load_api(
            self.fixtures(asset(status="Out of Service", out_of_service_reason="Air leak"))
        )

        row = self.read(module)["assets"][0]
        self.assertEqual([blocker["code"] for blocker in row["blockers"]], ["unsafe_fleet_asset"])
        self.assertEqual(row["out_of_service_reason"], "Air leak")

    def test_an_open_out_of_service_defect_blocks_an_otherwise_ready_asset(self) -> None:
        fixtures = self.fixtures(
            asset(),
            defects=[
                {"fleet_asset": "asset-truck-1", "out_of_service": 1, "status": "Open"},
                {"fleet_asset": "asset-truck-1", "out_of_service": 1, "status": "Closed"},
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        row = self.read(module)["assets"][0]
        self.assertEqual(row["open_out_of_service_defects"], 1)
        self.assertEqual(
            [blocker["code"] for blocker in row["blockers"]],
            ["open_out_of_service_defect"],
        )

    def test_every_status_the_fence_counts_blocks_the_panel_too(self) -> None:
        """The panel and the release fence read one status list, not two copies.

        ``Open`` is the obvious case.  ``Contained`` and ``Scheduled`` are the
        ones a hand-maintained second copy would silently drop, and the driver
        would see a ready vehicle that dispatch is about to refuse.  The loop
        is driven from the fence's own constant, so a status added there is
        covered here without anyone remembering to edit this test.
        """

        for status in OPEN_OUT_OF_SERVICE_DEFECT_STATUSES:
            with self.subTest(status=status):
                module, _, _, _ = self.load_api(
                    self.fixtures(
                        asset(),
                        defects=[
                            {
                                "fleet_asset": "asset-truck-1",
                                "out_of_service": 1,
                                "status": status,
                            }
                        ],
                    )
                )

                row = self.read(module)["assets"][0]
                self.assertEqual(row["open_out_of_service_defects"], 1)
                self.assertEqual(
                    [blocker["code"] for blocker in row["blockers"]],
                    ["open_out_of_service_defect"],
                )

    def test_a_defect_outside_the_fence_list_leaves_the_asset_ready(self) -> None:
        """The count is not "any defect": a closed one, or one that never took
        the asset out of service, is not something to stop a driver over."""

        module, _, _, _ = self.load_api(
            self.fixtures(
                asset(),
                defects=[
                    {"fleet_asset": "asset-truck-1", "out_of_service": 1, "status": "Closed"},
                    {"fleet_asset": "asset-truck-1", "out_of_service": 0, "status": "Open"},
                ],
            )
        )

        row = self.read(module)["assets"][0]
        self.assertEqual(row["open_out_of_service_defects"], 0)
        self.assertEqual(row["blockers"], [])

    def test_telematics_authority_is_reported_as_the_fence_refuses_it(self) -> None:
        module, _, _, _ = self.load_api(
            self.fixtures(asset(inspection_authority_source="Telematics"))
        )

        self.assertEqual(self.blockers(module), ["telematics_cannot_authorize_asset"])

    def test_an_expired_registration_blocks_a_road_asset(self) -> None:
        module, _, _, _ = self.load_api(self.fixtures(asset(registration_expiry="2026-01-01")))

        self.assertEqual(self.blockers(module), ["expired_fleet_registration"])

    def test_an_expired_licence_is_reported_when_the_actor_holds_an_authority(self) -> None:
        fixtures = self.fixtures(
            asset(),
            driver_authorities=[
                {
                    "name": "driver-1",
                    "driver_user": DRIVER,
                    "status": "Active",
                    "authority_source": "Physical Document",
                    "licence_class": "3",
                    "licence_expiry": "2026-01-01",
                    "medical_expiry": None,
                }
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        row = self.read(module)["assets"][0]
        self.assertEqual([blocker["code"] for blocker in row["blockers"]], ["expired_driver_licence"])
        self.assertEqual(row["blockers"][0]["field"], "licence_expiry")

    def test_an_actor_with_no_driver_authority_is_not_accused_of_one(self) -> None:
        # A crew member holding custody of a trailer is not its driver. Reporting
        # `unverified_driver_authority` for them would be noise, not a blocker.
        module, _, _, _ = self.load_api()

        self.assertEqual(self.blockers(module), [])

    def test_a_non_road_asset_never_reports_a_driver_blocker(self) -> None:
        fixtures = self.fixtures(
            asset(asset_kind="Equipment", registration_expiry=None, insurance_expiry=None),
            driver_authorities=[
                {
                    "name": "driver-1",
                    "driver_user": DRIVER,
                    "status": "Suspended",
                    "authority_source": "Physical Document",
                    "licence_class": "3",
                    "licence_expiry": "2027-01-01",
                    "medical_expiry": None,
                }
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        self.assertEqual(self.blockers(module), [])

    def test_both_the_asset_and_the_driver_fence_are_reported_together(self) -> None:
        fixtures = self.fixtures(
            asset(next_inspection_due="2026-07-01"),
            driver_authorities=[
                {
                    "name": "driver-1",
                    "driver_user": DRIVER,
                    "status": "Suspended",
                    "authority_source": "Physical Document",
                    "licence_class": "3",
                    "licence_expiry": "2027-01-01",
                    "medical_expiry": None,
                }
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        self.assertEqual(
            self.blockers(module),
            ["overdue_fleet_inspection", "inactive_driver_authority"],
        )


class PanelCurrencyTests(FleetPanelTestCase):
    def test_the_newest_capture_per_kind_is_reported_whoever_recorded_it(self) -> None:
        fixtures = self.fixtures(
            asset(),
            inspections=[
                {
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Pre-Trip",
                    "performed_at": "2026-07-11 06:30:00",
                    "result": "Pass",
                },
                {
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Pre-Trip",
                    "performed_at": "2026-07-10 06:30:00",
                    "result": "Pass",
                },
                {
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Post-Trip",
                    "performed_at": "2026-07-10 18:00:00",
                    "result": "Pass",
                },
            ],
        )
        module, _, _, _ = self.load_api(fixtures)

        row = self.read(module)["assets"][0]
        self.assertEqual(row["last_pre_trip_at"], "2026-07-11 06:30:00")
        self.assertEqual(row["last_post_trip_at"], "2026-07-10 18:00:00")


class PanelIssuerTests(FleetPanelTestCase):
    def test_only_the_configured_worker_principal_may_read_the_panel(self) -> None:
        module, _, _, _ = self.load_api(session_user="someone.else@example.invalid")

        with self.assertRaises(FakePermissionError) as caught:
            self.read(module)
        self.assertIn("fleet_issuer_auth_mismatch", str(caught.exception))

    def test_an_unconfigured_issuer_refuses_the_read(self) -> None:
        module, _, _, _ = self.load_api(configured_issuer=None)

        with self.assertRaises(FakePermissionError) as caught:
            self.read(module)
        self.assertIn("fleet_issuer_not_configured", str(caught.exception))

    def test_the_read_demands_read_permission_and_not_a_create_grant(self) -> None:
        module, _, _, checks = self.load_api()
        self.read(module)

        self.assertEqual(checks, [("Fleet Asset", "read")])

    def test_a_principal_without_the_read_grant_is_refused(self) -> None:
        module, _, _, _ = self.load_api(can_permission=False)

        with self.assertRaises(FakePermissionError) as caught:
            self.read(module)
        self.assertIn("fleet_issuer_permission_denied", str(caught.exception))

    def test_a_get_request_is_refused_like_every_other_bounded_rail_call(self) -> None:
        module, _, _, _ = self.load_api(request_method="GET")

        with self.assertRaises(FakePermissionError) as caught:
            self.read(module)
        self.assertIn("fleet_post_required", str(caught.exception))

    def test_a_malformed_reference_date_is_refused(self) -> None:
        module, _, _, _ = self.load_api()

        with self.assertRaises(FakeValidationError):
            self.read(module, reference_date="11/07/2026")

    def test_an_absent_reference_date_falls_back_to_the_site_clock(self) -> None:
        module, _, _, _ = self.load_api()

        self.assertEqual(self.read(module, reference_date=None)["reference_date"], TODAY)


if __name__ == "__main__":
    unittest.main()
