"""IRO-54 fleet, equipment, driver, cargo, and maintenance policy tests."""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.domain_policy import (
    CARGO_LOAD_RELEASE_FENCE_STATUSES,
    PolicyViolation,
    validate_record,
)


ADAPTER_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "document_validation.py"
)


REFERENCE_DAY = "2026-07-11"
SCHEDULED_START = "2026-07-11 08:00:00"


def fleet_asset(**overrides: object) -> dict[str, object]:
    """A currently safe, inspected, insured Vehicle held by crew-1."""

    record: dict[str, object] = {
        "fleet_asset_id": "asset-truck-1",
        "name": "asset-truck-1",
        "asset_kind": "Vehicle",
        "status": "Active",
        "display_name": "Unit 12 flat deck",
        "version": 1,
        "vin_or_serial": "2FTRX18L1XCA00001",
        "licence_plate": "ABC-1234",
        "registration_expiry": "2026-12-31",
        "insurance_expiry": "2026-12-31",
        "required_licence_class": "Class 3",
        "meter_kind": "Odometer km",
        "current_meter": "142000",
        "current_meter_at": "2026-07-10 18:00:00",
        "payload_capacity_kg": "4000",
        "gvwr_kg": "8000",
        "inspection_authority_source": "Physical Inspection",
        "next_inspection_due": "2026-07-31",
        "next_service_due_date": "2026-09-30",
        "calibration_required": 0,
        "custody_holder_type": "Crew",
        "custody_crew_profile": "crew-1",
        "custody_since": "2026-07-01 07:00:00",
        "home_region": "Calgary",
    }
    record.update(overrides)
    return record


def driver_authority(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "driver_authority_id": "driver-1",
        "name": "driver-1",
        "driver_user": "driver@example.invalid",
        "status": "Active",
        "version": 1,
        "authority_source": "Physical Document",
        "licence_class": "Class 3, Class 5",
        "licence_reference": "AB-000111",
        "licence_issuer": "Alberta Registries",
        "licence_expiry": "2027-01-31",
        "medical_expiry": "2026-12-31",
        "abstract_checked_at": "2026-06-30",
        "abstract_evidence": "evidence:abstract-1",
        "verified_by": "production@example.invalid",
        "verified_at": "2026-06-30 09:00:00",
    }
    record.update(overrides)
    return record


def inspection_item(sequence: int = 1, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "sequence": sequence,
        "check_point": "Brakes",
        "result": "Pass",
        "severity": "None",
    }
    row.update(overrides)
    return row


def asset_inspection(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "asset_inspection_id": "inspection-1",
        "name": "inspection-1",
        "fleet_asset": "asset-truck-1",
        "inspection_type": "Pre-Trip",
        "status": "Verified",
        "result": "Pass",
        "performed_by": "driver@example.invalid",
        "performed_at": "2026-07-11 06:30:00",
        "device_action_id": "device-inspection-1",
        "raw_key": "fleet/v1/abcdef0123456789abcdef01/pre_trip_inspection/device-inspection-1/manifest.json",
        "capture_actor": "field-companion",
        "evidence_item": "evidence:inspection-1",
        "sync_state": "Verified",
        "verified_at": "2026-07-11 06:40:00",
        "defect_count": 0,
        "meter_reading": "142000",
        "items": [inspection_item()],
    }
    record.update(overrides)
    return record


def inspection_context(**overrides: object) -> dict[str, object]:
    context: dict[str, object] = {"inspection_fleet_asset": fleet_asset()}
    context.update(overrides)
    return context


def cargo_line(line_no: int = 1, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "line_no": line_no,
        "line_kind": "Material",
        "controlled_item": "item-panel",
        "material_lot": "lot-1",
        "unit": "each",
        "planned_quantity": "10",
        "loaded_quantity": "10",
        "delivered_quantity": "8",
        "returned_quantity": "2",
        "weight_kg": "300",
        "scan_reference": f"scan-{line_no}",
        "condition": "Good",
        "needs_review": 0,
    }
    row.update(overrides)
    return row


def cargo_load(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "cargo_load_id": "load-1",
        "name": "load-1",
        "roof_job": "job-1",
        "fleet_asset": "asset-truck-1",
        "job_assignment": "assignment-1",
        "driver_authority": "driver-1",
        "driver_user": "driver@example.invalid",
        "status": "Loaded",
        "version": 1,
        "custody_holder_type": "Crew",
        "custody_crew_profile": "crew-1",
        "planned_weight_kg": "3000",
        "loaded_weight_kg": "3000",
        "securement_confirmed": 1,
        "pre_trip_inspection": "inspection-1",
        "loaded_by": "production@example.invalid",
        "loaded_at": SCHEDULED_START,
        "device_action_id": "device-load-1",
        "lines": [cargo_line()],
    }
    record.update(overrides)
    return record


def cargo_context(**overrides: object) -> dict[str, object]:
    context: dict[str, object] = {
        "cargo_carrier_asset": fleet_asset(),
        "cargo_driver_authority": driver_authority(),
        "cargo_pre_trip_inspection": {
            "name": "inspection-1",
            "fleet_asset": "asset-truck-1",
            "inspection_type": "Pre-Trip",
            "status": "Verified",
            "result": "Pass",
        },
        "cargo_post_trip_inspection": {
            "name": "inspection-2",
            "fleet_asset": "asset-truck-1",
            "inspection_type": "Post-Trip",
            "status": "Verified",
            "result": "Pass",
        },
    }
    context.update(overrides)
    return context


def release_context(**overrides: object) -> dict[str, object]:
    """The job-scoped fleet rows the schedule and release fences read."""

    context: dict[str, object] = {
        "fleet_cargo_load_rows": [
            {
                "name": "load-1",
                "roof_job": "job-1",
                "fleet_asset": "asset-truck-1",
                "trailer_asset": None,
                "driver_authority": "driver-1",
                "driver_user": "driver@example.invalid",
                "status": "Loaded",
                "loaded_weight_kg": "3000",
                "custody_holder_type": "Crew",
                "custody_crew_profile": "crew-1",
            }
        ],
        "fleet_asset_rows": {"asset-truck-1": fleet_asset()},
        "driver_authority_rows": {"driver-1": driver_authority()},
        "fleet_out_of_service_defect_counts": {"asset-truck-1": 0},
    }
    context.update(overrides)
    return context


def gate(gate_name: str) -> dict[str, object]:
    return {
        "roof_job": "job-1",
        "gate": gate_name,
        "state": "Waived",
        "owner_user": "production@example.invalid",
        "assigned_at": "2026-07-10 08:00:00",
        "waived_by": "owner@example.invalid",
        "waived_at": "2026-07-10 07:30:00",
        "waiver_reason": "Owner-approved exception.",
    }


def current_crew_authority() -> dict[str, object]:
    return {
        "name": "crew-1",
        "crew_profile_id": "crew-1",
        "status": "Active",
        "crew_type": "Employee",
        "competency_status": "Current",
        "competency_expiry": "2026-12-31",
        "equipment_status": "Safe",
        "equipment_expiry": "2026-12-31",
        "active_stop": 0,
    }


def compliance_authority(gate_name: str) -> dict[str, object]:
    return {
        "name": f"compliance:{gate_name.lower()}:1",
        "compliance_record_id": f"compliance:{gate_name.lower()}:1",
        "roof_job": "job-1",
        "required_before_gate": gate_name,
        "status": "Approved",
        "effective_date": "2026-07-01",
        "expiry_date": "2026-12-31",
    }


def scheduled_assignment(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "assignment_id": "assignment-1",
        "name": "assignment-1",
        "roof_job": "job-1",
        "assignment_type": "Production",
        "status": "Assigned",
        "crew_profile": "crew-1",
        "assigned_by": "production@example.invalid",
        "assigned_at": "2026-07-10 08:00:00",
        "scheduled_start": SCHEDULED_START,
        "scheduled_end": "2026-07-11 16:00:00",
    }
    record.update(overrides)
    return record


def schedule_context(**overrides: object) -> dict[str, object]:
    context: dict[str, object] = {
        "gates": [
            gate(name)
            for name in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ],
        "gate_evidence": {},
        "legacy_authority_context": True,
        "scheduled_assignment_crew_profile": current_crew_authority(),
        "job_compliance_rows": [
            compliance_authority(name) for name in ("Crew", "Safety", "Access")
        ],
        **release_context(),
    }
    context.update(overrides)
    return context


class FleetPolicyTestCase(unittest.TestCase):
    def assert_policy(self, code: str, function, *args, **kwargs) -> PolicyViolation:
        with self.assertRaises(PolicyViolation) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception


class FleetAssetPolicyTests(FleetPolicyTestCase):
    def test_active_vehicle_requires_its_road_and_inspection_authority(self) -> None:
        validate_record("fleet_asset", fleet_asset(), context={})

        for missing in (
            "registration_expiry",
            "insurance_expiry",
            "vin_or_serial",
            "required_licence_class",
            "next_inspection_due",
            "home_region",
        ):
            with self.subTest(field=missing):
                record = fleet_asset()
                record.pop(missing)
                self.assert_policy(
                    "required_fields", validate_record, "fleet_asset", record, context={}
                )

    def test_telematics_never_becomes_the_asset_inspection_authority(self) -> None:
        self.assert_policy(
            "telematics_cannot_authorize_asset",
            validate_record,
            "fleet_asset",
            fleet_asset(inspection_authority_source="Telematics"),
            context={},
        )

    def test_out_of_service_details_track_the_status(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "fleet_asset",
            fleet_asset(status="Out of Service"),
            context={},
        )
        validate_record(
            "fleet_asset",
            fleet_asset(
                status="Out of Service",
                out_of_service_reason="Air brake fault.",
                out_of_service_at="2026-07-10 19:00:00",
            ),
            context={},
        )
        self.assert_policy(
            "stale_out_of_service",
            validate_record,
            "fleet_asset",
            fleet_asset(out_of_service_reason="Air brake fault."),
            context={},
        )

    def test_capacity_and_custody_stay_internally_consistent(self) -> None:
        self.assert_policy(
            "invalid_fleet_asset_capacity",
            validate_record,
            "fleet_asset",
            fleet_asset(payload_capacity_kg="9000"),
            context={},
        )
        self.assert_policy(
            "invalid_fleet_asset_custody",
            validate_record,
            "fleet_asset",
            fleet_asset(custody_user="yard@example.invalid"),
            context={},
        )
        self.assert_policy(
            "invalid_fleet_asset_custody",
            validate_record,
            "fleet_asset",
            fleet_asset(
                custody_holder_type="Yard",
                custody_crew_profile="crew-1",
            ),
            context={},
        )

    def test_retired_assets_are_terminal_and_identity_is_frozen(self) -> None:
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "fleet_asset",
            fleet_asset(status="Active"),
            previous=fleet_asset(status="Retired"),
            context={},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "fleet_asset",
            fleet_asset(vin_or_serial="2FTRX18L1XCA99999"),
            previous=fleet_asset(),
            context={},
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "fleet_asset",
            fleet_asset(fleet_asset_id="asset-truck-2"),
            previous=fleet_asset(),
            context={},
        )

    def test_a_superseding_asset_revision_needs_a_verified_higher_version(self) -> None:
        self.assert_policy(
            "unverified_correction",
            validate_record,
            "fleet_asset",
            fleet_asset(
                fleet_asset_id="asset-truck-1-v2",
                name="asset-truck-1-v2",
                version=2,
                supersedes="asset-truck-1",
                correction_reason="Re-plated after collision repair.",
            ),
            context={},
        )
        self.assert_policy(
            "stale_version",
            validate_record,
            "fleet_asset",
            fleet_asset(
                fleet_asset_id="asset-truck-1-v2",
                name="asset-truck-1-v2",
                version=1,
                supersedes="asset-truck-1",
                correction_reason="Re-plated after collision repair.",
            ),
            context={"superseded_record": {"asset_kind": "Vehicle", "version": 1}},
        )
        validate_record(
            "fleet_asset",
            fleet_asset(
                fleet_asset_id="asset-truck-1-v2",
                name="asset-truck-1-v2",
                version=2,
                supersedes="asset-truck-1",
                correction_reason="Re-plated after collision repair.",
            ),
            context={"superseded_record": {"asset_kind": "Vehicle", "version": 1}},
        )


class DriverAuthorityPolicyTests(FleetPolicyTestCase):
    def test_an_active_authority_requires_a_verified_physical_document(self) -> None:
        validate_record("driver_authority", driver_authority(), context={})
        self.assert_policy(
            "telematics_cannot_authorize_driver",
            validate_record,
            "driver_authority",
            driver_authority(authority_source="Telematics"),
            context={},
        )
        for missing in ("licence_class", "licence_expiry", "abstract_evidence", "verified_at"):
            with self.subTest(field=missing):
                record = driver_authority()
                record.pop(missing)
                self.assert_policy(
                    "required_fields",
                    validate_record,
                    "driver_authority",
                    record,
                    context={},
                )

    def test_suspension_details_track_the_status(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "driver_authority",
            driver_authority(status="Suspended"),
            context={},
        )
        self.assert_policy(
            "stale_driver_suspension",
            validate_record,
            "driver_authority",
            driver_authority(suspended_reason="Under review."),
            context={},
        )


class AssetInspectionPolicyTests(FleetPolicyTestCase):
    def test_a_verified_inspection_needs_a_physical_inspector_and_evidence(self) -> None:
        validate_record("asset_inspection", asset_inspection(), context=inspection_context())
        for missing in ("performed_by", "performed_at", "device_action_id", "evidence_item"):
            with self.subTest(field=missing):
                record = asset_inspection()
                record.pop(missing)
                self.assert_policy(
                    "required_fields",
                    validate_record,
                    "asset_inspection",
                    record,
                    context=inspection_context(),
                )

    def test_telematics_evidence_never_replaces_the_physical_inspector(self) -> None:
        record = asset_inspection(
            telematics_reference="samsara:trip-9",
            telematics_observed_at="2026-07-11 06:25:00",
        )
        record.pop("performed_by")
        self.assert_policy(
            "telematics_cannot_authorize_inspection",
            validate_record,
            "asset_inspection",
            record,
            context=inspection_context(),
        )
        validate_record(
            "asset_inspection",
            asset_inspection(
                telematics_reference="samsara:trip-9",
                telematics_observed_at="2026-07-11 06:25:00",
            ),
            context=inspection_context(),
        )

    def test_the_declared_result_must_match_the_recorded_check_points(self) -> None:
        failing = asset_inspection(
            result="Pass",
            defect_count=0,
            items=[inspection_item(result="Fail", severity="Major")],
        )
        self.assert_policy(
            "inspection_result_mismatch",
            validate_record,
            "asset_inspection",
            failing,
            context=inspection_context(),
        )
        self.assert_policy(
            "inspection_defect_count_mismatch",
            validate_record,
            "asset_inspection",
            asset_inspection(
                result="Fail",
                defect_count=0,
                items=[inspection_item(result="Fail", severity="Out of Service")],
            ),
            context=inspection_context(),
        )
        self.assert_policy(
            "invalid_failed_inspection",
            validate_record,
            "asset_inspection",
            asset_inspection(
                result="Fail",
                defect_count=1,
                items=[inspection_item(result="Fail", severity="Minor")],
            ),
            context=inspection_context(),
        )
        validate_record(
            "asset_inspection",
            asset_inspection(
                result="Fail",
                defect_count=1,
                items=[inspection_item(result="Fail", severity="Out of Service")],
            ),
            context=inspection_context(),
        )

    def test_a_failed_check_point_requires_a_severity(self) -> None:
        self.assert_policy(
            "missing_inspection_item_severity",
            validate_record,
            "asset_inspection",
            asset_inspection(
                result="Fail",
                defect_count=1,
                items=[inspection_item(result="Fail", severity="None")],
            ),
            context=inspection_context(),
        )

    def test_check_point_sequence_must_be_contiguous(self) -> None:
        self.assert_policy(
            "invalid_inspection_sequence",
            validate_record,
            "asset_inspection",
            asset_inspection(items=[inspection_item(), inspection_item(3)]),
            context=inspection_context(),
        )

    def test_a_replayed_offline_capture_cannot_rewrite_the_recorded_facts(self) -> None:
        """A lost-connectivity retry must replay identically or be rejected."""

        previous = asset_inspection()
        validate_record(
            "asset_inspection",
            asset_inspection(),
            previous=previous,
            context=inspection_context(),
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "asset_inspection",
            asset_inspection(performed_at="2026-07-11 07:15:00"),
            previous=previous,
            context=inspection_context(),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "asset_inspection",
            asset_inspection(
                result="Fail",
                defect_count=1,
                items=[inspection_item(result="Fail", severity="Out of Service")],
            ),
            previous=previous,
            context=inspection_context(),
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "asset_inspection",
            asset_inspection(device_action_id="device-inspection-2"),
            previous=previous,
            context=inspection_context(),
        )

    def test_an_offline_capture_stays_bound_to_its_immutable_manifest(self) -> None:
        record = asset_inspection()
        record.pop("raw_key")
        self.assert_policy(
            "required_fields",
            validate_record,
            "asset_inspection",
            record,
            context=inspection_context(),
        )

    def test_a_retired_asset_cannot_record_a_new_inspection(self) -> None:
        self.assert_policy(
            "retired_asset_inspection",
            validate_record,
            "asset_inspection",
            asset_inspection(),
            context=inspection_context(
                inspection_fleet_asset=fleet_asset(status="Retired")
            ),
        )


class AssetDefectPolicyTests(FleetPolicyTestCase):
    def defect(self, **overrides: object) -> dict[str, object]:
        record: dict[str, object] = {
            "asset_defect_id": "defect-1",
            "name": "defect-1",
            "fleet_asset": "asset-truck-1",
            "asset_inspection": "inspection-1",
            "status": "Open",
            "severity": "Out of Service",
            "out_of_service": 1,
            "detected_at": "2026-07-11 06:35:00",
            "reported_by": "driver@example.invalid",
            "description": "Air brake chamber leaking.",
            "evidence_item": "evidence:defect-1",
            "device_action_id": "device-defect-1",
            "raw_key": "fleet/v1/abcdef0123456789abcdef01/defect_report/device-defect-1/manifest.json",
        }
        record.update(overrides)
        return record

    def test_severity_and_the_out_of_service_flag_must_agree(self) -> None:
        validate_record("asset_defect", self.defect(), context={})
        self.assert_policy(
            "out_of_service_defect_flag",
            validate_record,
            "asset_defect",
            self.defect(out_of_service=0),
            context={},
        )
        self.assert_policy(
            "out_of_service_defect_flag",
            validate_record,
            "asset_defect",
            self.defect(severity="Minor"),
            context={},
        )

    def test_a_device_reported_defect_stays_bound_to_its_manifest(self) -> None:
        record = self.defect()
        record.pop("raw_key")
        self.assert_policy(
            "required_fields", validate_record, "asset_defect", record, context={}
        )

    def test_closing_an_out_of_service_defect_requires_a_passed_return_to_service(
        self,
    ) -> None:
        closed = self.defect(
            status="Closed",
            repaired_by="mechanic@example.invalid",
            repaired_at="2026-07-12 10:00:00",
            repair_evidence="evidence:repair-1",
            closed_by="production@example.invalid",
            closed_at="2026-07-12 11:00:00",
            return_to_service_inspection="inspection-rts-1",
        )
        self.assert_policy(
            "unverified_return_to_service_inspection",
            validate_record,
            "asset_defect",
            closed,
            previous=self.defect(
                status="Repaired",
                repaired_by="mechanic@example.invalid",
                repaired_at="2026-07-12 10:00:00",
                repair_evidence="evidence:repair-1",
            ),
            context={},
        )
        self.assert_policy(
            "failed_return_to_service_inspection",
            validate_record,
            "asset_defect",
            closed,
            context={
                "defect_return_to_service_inspection": {
                    "name": "inspection-rts-1",
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Return To Service",
                    "status": "Verified",
                    "result": "Fail",
                }
            },
        )
        validate_record(
            "asset_defect",
            closed,
            context={
                "defect_return_to_service_inspection": {
                    "name": "inspection-rts-1",
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Return To Service",
                    "status": "Verified",
                    "result": "Pass",
                }
            },
        )

    def test_a_linked_maintenance_order_must_stay_on_the_same_asset(self) -> None:
        self.assert_policy(
            "cross_asset_defect_maintenance",
            validate_record,
            "asset_defect",
            self.defect(status="Scheduled", maintenance_order="mo-1"),
            context={
                "defect_maintenance_order": {
                    "name": "mo-1",
                    "fleet_asset": "asset-trailer-9",
                    "order_kind": "Corrective",
                    "status": "Scheduled",
                }
            },
        )

    def test_closed_defects_are_terminal(self) -> None:
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "asset_defect",
            self.defect(status="Open"),
            previous=self.defect(status="Closed"),
            context={},
        )


class MaintenanceOrderPolicyTests(FleetPolicyTestCase):
    def order(self, **overrides: object) -> dict[str, object]:
        record: dict[str, object] = {
            "maintenance_order_id": "mo-1",
            "name": "mo-1",
            "fleet_asset": "asset-truck-1",
            "order_kind": "Preventive",
            "status": "Draft",
        }
        record.update(overrides)
        return record

    def test_scheduling_requires_a_window_and_a_due_trigger(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "maintenance_order",
            self.order(status="Scheduled"),
            context={},
        )
        self.assert_policy(
            "required_reference",
            validate_record,
            "maintenance_order",
            self.order(status="Scheduled", scheduled_for="2026-09-20 08:00:00"),
            context={},
        )
        validate_record(
            "maintenance_order",
            self.order(
                status="Scheduled",
                scheduled_for="2026-09-20 08:00:00",
                due_date="2026-09-30",
            ),
            context={},
        )

    def test_completion_requires_evidence_and_calibration_certificates(self) -> None:
        completed = self.order(
            status="Completed",
            started_at="2026-09-20 08:00:00",
            performed_by="mechanic@example.invalid",
            completed_at="2026-09-20 12:00:00",
            work_summary="Replaced brake chamber.",
            completion_evidence="evidence:mo-1",
        )
        validate_record("maintenance_order", completed, context={})
        self.assert_policy(
            "required_fields",
            validate_record,
            "maintenance_order",
            {**completed, "order_kind": "Calibration"},
            context={},
        )
        validate_record(
            "maintenance_order",
            {
                **completed,
                "order_kind": "Calibration",
                "certificate_reference": "CAL-2026-441",
                "certificate_expiry": "2027-09-20",
                "next_due_date": "2027-09-20",
            },
            context={},
        )

    def test_a_corrective_order_is_bound_to_its_defect(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "maintenance_order",
            self.order(order_kind="Corrective"),
            context={},
        )
        self.assert_policy(
            "cross_asset_maintenance_defect",
            validate_record,
            "maintenance_order",
            self.order(order_kind="Corrective", asset_defect="defect-1"),
            context={
                "maintenance_asset_defect": {
                    "name": "defect-1",
                    "fleet_asset": "asset-trailer-9",
                    "severity": "Major",
                    "out_of_service": 0,
                    "status": "Open",
                }
            },
        )

    def test_completing_an_out_of_service_repair_requires_return_to_service(self) -> None:
        completed = self.order(
            order_kind="Corrective",
            asset_defect="defect-1",
            status="Completed",
            started_at="2026-07-12 08:00:00",
            performed_by="mechanic@example.invalid",
            completed_at="2026-07-12 10:00:00",
            work_summary="Replaced brake chamber.",
            completion_evidence="evidence:mo-1",
        )
        context = {
            "maintenance_asset_defect": {
                "name": "defect-1",
                "fleet_asset": "asset-truck-1",
                "severity": "Out of Service",
                "out_of_service": 1,
                "status": "Scheduled",
            }
        }
        self.assert_policy(
            "required_fields", validate_record, "maintenance_order", completed, context=context
        )
        validate_record(
            "maintenance_order",
            {**completed, "return_to_service_inspection": "inspection-rts-1"},
            context=context,
        )


class AssetUsageLogPolicyTests(FleetPolicyTestCase):
    def usage(self, **overrides: object) -> dict[str, object]:
        record: dict[str, object] = {
            "asset_usage_log_id": "usage-1",
            "name": "usage-1",
            "fleet_asset": "asset-truck-1",
            "entry_kind": "Meter",
            "source": "Physical",
            "status": "Recorded",
            "recorded_by": "driver@example.invalid",
            "recorded_at": "2026-07-11 18:00:00",
            "device_action_id": "device-usage-1",
            "meter_reading": "142240",
            "previous_meter_reading": "142000",
            "authoritative": 1,
        }
        record.update(overrides)
        return record

    def test_a_telematics_reading_is_evidence_and_never_authoritative(self) -> None:
        self.assert_policy(
            "telematics_meter_not_authoritative",
            validate_record,
            "asset_usage_log",
            self.usage(source="Telematics", provider_reference="samsara:vehicle-12"),
            context={"usage_fleet_asset": fleet_asset()},
        )
        validate_record(
            "asset_usage_log",
            self.usage(
                source="Telematics",
                provider_reference="samsara:vehicle-12",
                authoritative=0,
            ),
            context={"usage_fleet_asset": fleet_asset()},
        )

    def test_a_meter_reading_cannot_run_backwards(self) -> None:
        validate_record(
            "asset_usage_log", self.usage(), context={"usage_fleet_asset": fleet_asset()}
        )
        self.assert_policy(
            "non_monotonic_meter",
            validate_record,
            "asset_usage_log",
            self.usage(meter_reading="141000"),
            context={"usage_fleet_asset": fleet_asset()},
        )

    def test_an_unmetered_asset_cannot_record_a_meter_reading(self) -> None:
        self.assert_policy(
            "unmetered_asset_usage",
            validate_record,
            "asset_usage_log",
            self.usage(),
            context={"usage_fleet_asset": fleet_asset(meter_kind="None")},
        )

    def test_a_physical_fuel_entry_requires_a_positive_volume_and_evidence(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "asset_usage_log",
            self.usage(entry_kind="Fuel", authoritative=0),
            context={"usage_fleet_asset": fleet_asset()},
        )
        self.assert_policy(
            "invalid_fuel_volume",
            validate_record,
            "asset_usage_log",
            self.usage(
                entry_kind="Fuel",
                authoritative=0,
                fuel_volume_l="0",
                evidence_item="evidence:fuel-1",
            ),
            context={"usage_fleet_asset": fleet_asset()},
        )
        validate_record(
            "asset_usage_log",
            self.usage(
                entry_kind="Fuel",
                authoritative=0,
                fuel_volume_l="180.5",
                fuel_cost="288.80",
                evidence_item="evidence:fuel-1",
            ),
            context={"usage_fleet_asset": fleet_asset()},
        )


class CargoLoadPolicyTests(FleetPolicyTestCase):
    def test_a_loaded_record_requires_securement_driver_and_pre_trip_proof(self) -> None:
        validate_record("cargo_load", cargo_load(), context=cargo_context())
        self.assert_policy(
            "unsecured_cargo_load",
            validate_record,
            "cargo_load",
            cargo_load(securement_confirmed=0),
            context=cargo_context(),
        )
        for missing in ("driver_authority", "driver_user", "pre_trip_inspection", "loaded_at"):
            with self.subTest(field=missing):
                record = cargo_load()
                record.pop(missing)
                self.assert_policy(
                    "required_fields",
                    validate_record,
                    "cargo_load",
                    record,
                    context=cargo_context(),
                )

    def test_a_failed_pre_trip_inspection_blocks_the_load(self) -> None:
        self.assert_policy(
            "failed_cargo_pre_trip_inspection",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_pre_trip_inspection={
                    "name": "inspection-1",
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Pre-Trip",
                    "status": "Verified",
                    "result": "Fail",
                }
            ),
        )
        self.assert_policy(
            "failed_cargo_pre_trip_inspection",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_pre_trip_inspection={
                    "name": "inspection-1",
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Pre-Trip",
                    "status": "Submitted",
                    "result": "Pass",
                }
            ),
        )
        self.assert_policy(
            "cross_asset_cargo_pre_trip_inspection",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_pre_trip_inspection={
                    "name": "inspection-1",
                    "fleet_asset": "asset-trailer-9",
                    "inspection_type": "Pre-Trip",
                    "status": "Verified",
                    "result": "Pass",
                }
            ),
        )

    def test_an_expired_or_wrong_class_licence_blocks_the_load(self) -> None:
        self.assert_policy(
            "expired_driver_licence",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_driver_authority=driver_authority(licence_expiry="2026-07-01")
            ),
        )
        self.assert_policy(
            "unlicensed_fleet_driver",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_driver_authority=driver_authority(licence_class="Class 5")
            ),
        )
        self.assert_policy(
            "inactive_driver_authority",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_driver_authority=driver_authority(
                    status="Suspended",
                    suspended_reason="Under review.",
                    suspended_at="2026-07-05 09:00:00",
                )
            ),
        )
        self.assert_policy(
            "cargo_driver_mismatch",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_driver_authority=driver_authority(
                    driver_user="other-driver@example.invalid"
                )
            ),
        )

    def test_an_unsafe_or_overdue_carrier_blocks_the_load(self) -> None:
        self.assert_policy(
            "unsafe_fleet_asset",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_carrier_asset=fleet_asset(
                    status="Out of Service",
                    out_of_service_reason="Air brake fault.",
                    out_of_service_at="2026-07-10 19:00:00",
                )
            ),
        )
        self.assert_policy(
            "overdue_fleet_inspection",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_carrier_asset=fleet_asset(next_inspection_due="2026-07-01")
            ),
        )
        self.assert_policy(
            "overdue_fleet_maintenance",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_carrier_asset=fleet_asset(next_service_due_date="2026-07-05")
            ),
        )
        self.assert_policy(
            "expired_fleet_insurance",
            validate_record,
            "cargo_load",
            cargo_load(),
            context=cargo_context(
                cargo_carrier_asset=fleet_asset(insurance_expiry="2026-07-09")
            ),
        )

    def test_the_loaded_weight_cannot_exceed_the_carrier_capacity(self) -> None:
        self.assert_policy(
            "overloaded_cargo_load",
            validate_record,
            "cargo_load",
            cargo_load(loaded_weight_kg="4200"),
            context=cargo_context(),
        )

    def test_the_cargo_custody_holder_must_match_the_carrier_custody(self) -> None:
        self.assert_policy(
            "wrong_custody_cargo_load",
            validate_record,
            "cargo_load",
            cargo_load(custody_crew_profile="crew-9"),
            context=cargo_context(),
        )
        self.assert_policy(
            "wrong_custody_cargo_load",
            validate_record,
            "cargo_load",
            cargo_load(
                custody_holder_type="User",
                custody_crew_profile=None,
                custody_user="driver@example.invalid",
            ),
            context=cargo_context(),
        )

    def test_each_cargo_line_carries_a_distinct_scan_reference(self) -> None:
        self.assert_policy(
            "duplicate_cargo_scan",
            validate_record,
            "cargo_load",
            cargo_load(lines=[cargo_line(), cargo_line(2, scan_reference="scan-1")]),
            context=cargo_context(),
        )
        self.assert_policy(
            "invalid_cargo_line_sequence",
            validate_record,
            "cargo_load",
            cargo_load(lines=[cargo_line(), cargo_line(3)]),
            context=cargo_context(),
        )

    def test_reconciliation_balances_loaded_delivered_and_returned_quantity(self) -> None:
        reconciled = cargo_load(
            status="Reconciled",
            departed_at="2026-07-11 08:30:00",
            delivered_at="2026-07-11 09:30:00",
            delivery_evidence="evidence:delivery-1",
            returned_at="2026-07-11 17:00:00",
            return_evidence="evidence:return-1",
            post_trip_inspection="inspection-2",
            reconciled_by="production@example.invalid",
            reconciled_at="2026-07-11 18:00:00",
        )
        validate_record("cargo_load", reconciled, context=cargo_context())
        self.assert_policy(
            "cargo_reconciliation_mismatch",
            validate_record,
            "cargo_load",
            {**reconciled, "lines": [cargo_line(returned_quantity="1")]},
            context=cargo_context(),
        )
        # An explicit shortage stays possible, but only as reviewed, noted work.
        self.assert_policy(
            "required_fields",
            validate_record,
            "cargo_load",
            {
                **reconciled,
                "lines": [cargo_line(returned_quantity="1", needs_review=1)],
            },
            context=cargo_context(),
        )
        validate_record(
            "cargo_load",
            {
                **reconciled,
                "lines": [cargo_line(returned_quantity="1", needs_review=1)],
                "reconciliation_note": "One bundle held at site for the return trip.",
            },
            context=cargo_context(),
        )

    def test_a_returned_load_requires_a_verified_post_trip_inspection(self) -> None:
        returned = cargo_load(
            status="Returned",
            departed_at="2026-07-11 08:30:00",
            delivered_at="2026-07-11 09:30:00",
            delivery_evidence="evidence:delivery-1",
            returned_at="2026-07-11 17:00:00",
            return_evidence="evidence:return-1",
            post_trip_inspection="inspection-2",
        )
        validate_record("cargo_load", returned, context=cargo_context())
        self.assert_policy(
            "invalid_cargo_post_trip_inspection",
            validate_record,
            "cargo_load",
            returned,
            context=cargo_context(
                cargo_post_trip_inspection={
                    "name": "inspection-2",
                    "fleet_asset": "asset-truck-1",
                    "inspection_type": "Post-Trip",
                    "status": "Submitted",
                    "result": "Pass",
                }
            ),
        )

    def test_loading_facts_freeze_once_the_load_leaves_the_yard(self) -> None:
        self.assert_policy(
            "write_once_field",
            validate_record,
            "cargo_load",
            cargo_load(fleet_asset="asset-truck-9"),
            previous=cargo_load(),
            context=cargo_context(),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "cargo_load",
            cargo_load(loaded_weight_kg="2900"),
            previous=cargo_load(),
            context=cargo_context(),
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "cargo_load",
            cargo_load(device_action_id="device-load-2"),
            previous=cargo_load(),
            context=cargo_context(),
        )


class AssetCustodyEventPolicyTests(FleetPolicyTestCase):
    def custody(self, **overrides: object) -> dict[str, object]:
        record: dict[str, object] = {
            "asset_custody_event_id": "custody-1",
            "name": "custody-1",
            "fleet_asset": "asset-truck-1",
            "event_type": "Transfer",
            "status": "Recorded",
            "occurred_at": "2026-07-11 07:00:00",
            "recorded_by": "production@example.invalid",
            "device_action_id": "device-custody-1",
            "from_holder_type": "Crew",
            "from_crew_profile": "crew-1",
            "to_holder_type": "Crew",
            "to_crew_profile": "crew-2",
            "condition": "Good",
        }
        record.update(overrides)
        return record

    def test_a_reassignment_must_start_from_the_current_custody_holder(self) -> None:
        context = {"custody_fleet_asset": fleet_asset()}
        validate_record("asset_custody_event", self.custody(), context=context)
        self.assert_policy(
            "wrong_custody_transfer",
            validate_record,
            "asset_custody_event",
            self.custody(from_crew_profile="crew-7"),
            context=context,
        )
        self.assert_policy(
            "wrong_custody_transfer",
            validate_record,
            "asset_custody_event",
            self.custody(
                from_holder_type="Yard",
                from_crew_profile=None,
            ),
            context=context,
        )

    def test_a_lost_asset_needs_missing_condition_and_evidence(self) -> None:
        self.assert_policy(
            "required_fields",
            validate_record,
            "asset_custody_event",
            self.custody(event_type="Lost", condition="Missing"),
            context={"custody_fleet_asset": fleet_asset()},
        )
        self.assert_policy(
            "invalid_lost_custody_condition",
            validate_record,
            "asset_custody_event",
            self.custody(
                event_type="Lost",
                notes="Not returned from the Airdrie site.",
                evidence_item="evidence:custody-1",
            ),
            context={"custody_fleet_asset": fleet_asset()},
        )
        validate_record(
            "asset_custody_event",
            self.custody(
                event_type="Lost",
                condition="Missing",
                notes="Not returned from the Airdrie site.",
                evidence_item="evidence:custody-1",
            ),
            context={"custody_fleet_asset": fleet_asset()},
        )


class FleetReleaseFencePolicyTests(FleetPolicyTestCase):
    """Unsafe, overdue, unlicensed, overloaded, or wrong-custody assets block release."""

    def test_a_ready_fleet_lets_production_scheduling_through(self) -> None:
        validate_record(
            "job_assignment", scheduled_assignment(), context=schedule_context()
        )

    def test_an_unsafe_or_overdue_asset_blocks_production_scheduling(self) -> None:
        cases = {
            "unsafe_fleet_asset": fleet_asset(
                status="Out of Service",
                out_of_service_reason="Air brake fault.",
                out_of_service_at="2026-07-10 19:00:00",
            ),
            "overdue_fleet_inspection": fleet_asset(next_inspection_due="2026-07-01"),
            "overdue_fleet_maintenance": fleet_asset(next_service_due_date="2026-07-01"),
            "overdue_fleet_calibration": fleet_asset(
                calibration_required=1, next_calibration_due="2026-07-01"
            ),
            "expired_fleet_registration": fleet_asset(registration_expiry="2026-07-01"),
            "expired_fleet_insurance": fleet_asset(insurance_expiry="2026-07-01"),
            "telematics_cannot_authorize_asset": fleet_asset(
                inspection_authority_source="Telematics"
            ),
        }
        for code, asset in cases.items():
            with self.subTest(code=code):
                self.assert_policy(
                    code,
                    validate_record,
                    "job_assignment",
                    scheduled_assignment(),
                    context=schedule_context(
                        fleet_asset_rows={"asset-truck-1": asset}
                    ),
                )

    def test_an_open_out_of_service_defect_blocks_production_scheduling(self) -> None:
        self.assert_policy(
            "open_out_of_service_defect",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(
                fleet_out_of_service_defect_counts={"asset-truck-1": 1}
            ),
        )

    def test_an_unlicensed_or_expired_driver_blocks_production_scheduling(self) -> None:
        self.assert_policy(
            "expired_driver_licence",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(
                driver_authority_rows={
                    "driver-1": driver_authority(licence_expiry="2026-07-01")
                }
            ),
        )
        self.assert_policy(
            "unlicensed_fleet_driver",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(
                driver_authority_rows={
                    "driver-1": driver_authority(licence_class="Class 5")
                }
            ),
        )
        self.assert_policy(
            "expired_driver_medical",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(
                driver_authority_rows={
                    "driver-1": driver_authority(medical_expiry="2026-07-01")
                }
            ),
        )
        self.assert_policy(
            "unverified_driver_authority",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(driver_authority_rows={}),
        )

    def test_an_overloaded_or_wrong_custody_asset_blocks_production_scheduling(
        self,
    ) -> None:
        overloaded = release_context()
        overloaded["fleet_cargo_load_rows"][0]["loaded_weight_kg"] = "4200"
        self.assert_policy(
            "overloaded_cargo_load",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(**overloaded),
        )
        reassigned = release_context()
        reassigned["fleet_cargo_load_rows"][0]["custody_crew_profile"] = "crew-9"
        self.assert_policy(
            "wrong_custody_fleet_asset",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(**reassigned),
        )

    def test_an_unverified_asset_row_blocks_production_scheduling(self) -> None:
        self.assert_policy(
            "unverified_fleet_asset",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(fleet_asset_rows={}),
        )

    def test_a_planned_draft_load_still_fences_the_asset_it_binds(self) -> None:
        """Scheduling happens days before loading, so Draft is in the perimeter."""

        planned = release_context()
        planned["fleet_cargo_load_rows"][0].update(
            status="Draft",
            driver_authority=None,
            driver_user=None,
            loaded_weight_kg=None,
            custody_holder_type=None,
            custody_crew_profile=None,
        )
        # A planned load records no driver, weight, or custody holder yet, so
        # only the asset fences apply to it and a ready asset passes.
        validate_record(
            "job_assignment", scheduled_assignment(), context=schedule_context(**planned)
        )

        unsafe = release_context()
        unsafe["fleet_cargo_load_rows"][0].update(
            status="Draft",
            driver_authority=None,
            driver_user=None,
            loaded_weight_kg=None,
            custody_holder_type=None,
            custody_crew_profile=None,
        )
        unsafe["fleet_asset_rows"] = {
            "asset-truck-1": fleet_asset(next_inspection_due="2026-07-01")
        }
        self.assert_policy(
            "overdue_fleet_inspection",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(**unsafe),
        )

    def test_a_mismatched_trailer_custody_blocks_production_scheduling(self) -> None:
        context = release_context()
        context["fleet_cargo_load_rows"][0]["trailer_asset"] = "trailer-1"
        context["fleet_asset_rows"]["trailer-1"] = fleet_asset(
            name="trailer-1",
            fleet_asset_id="trailer-1",
            asset_kind="Trailer",
            required_licence_class=None,
            payload_capacity_kg=None,
            custody_crew_profile="crew-9",
        )
        context["fleet_out_of_service_defect_counts"]["trailer-1"] = 0
        self.assert_policy(
            "wrong_custody_fleet_asset",
            validate_record,
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(**context),
        )

        matched = release_context()
        matched["fleet_cargo_load_rows"][0]["trailer_asset"] = "trailer-1"
        matched["fleet_asset_rows"]["trailer-1"] = fleet_asset(
            name="trailer-1",
            fleet_asset_id="trailer-1",
            asset_kind="Trailer",
            required_licence_class=None,
            payload_capacity_kg=None,
        )
        matched["fleet_out_of_service_defect_counts"]["trailer-1"] = 0
        validate_record(
            "job_assignment", scheduled_assignment(), context=schedule_context(**matched)
        )

    def test_the_fence_engages_only_on_assets_a_cargo_load_binds_to_the_job(
        self,
    ) -> None:
        """The Cargo Load is the only record that binds an asset to a job.

        A job that binds no asset therefore has nothing for this fence to check.
        Its perimeter is deliberately stated this way in the capability matrix
        rather than as a blanket claim over every asset a crew might touch.
        """

        validate_record(
            "job_assignment",
            scheduled_assignment(),
            context=schedule_context(
                fleet_cargo_load_rows=[],
                fleet_asset_rows={},
                driver_authority_rows={},
                fleet_out_of_service_defect_counts={},
            ),
        )


class FleetReleaseContextLockTests(unittest.TestCase):
    """The snapshot the fence reads must be locked and cover planned loads."""

    def load_adapter(self, rows: dict[str, list[dict[str, object]]]):
        queries: list[tuple[str, tuple[object, ...]]] = []

        def sql(query, values, *, as_dict):
            normalized = " ".join(query.split())
            queries.append((normalized, tuple(values)))
            if "FOR UPDATE" not in normalized:
                raise AssertionError(f"expected row lock: {normalized}")
            if "`tabCargo Load`" in normalized:
                wanted = set(values[1:])
                return [
                    dict(row)
                    for row in rows.get("Cargo Load", [])
                    if row.get("roof_job") == values[0] and row.get("status") in wanted
                ]
            if "`tabFleet Asset`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Fleet Asset", [])
                    if row.get("name") in set(values)
                ]
            if "`tabDriver Authority`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Driver Authority", [])
                    if row.get("name") in set(values)
                ]
            if "`tabAsset Defect`" in normalized:
                return [
                    {"fleet_asset": row["fleet_asset"]}
                    for row in rows.get("Asset Defect", [])
                    if row.get("fleet_asset") in set(values)
                ]
            raise AssertionError(f"unexpected SQL: {normalized}")

        def unlocked_count(*args, **kwargs):
            raise AssertionError(
                "the release snapshot must not read defects through an unlocked count"
            )

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = ValueError
        frappe_module.PermissionError = PermissionError
        frappe_module.db = types.SimpleNamespace(sql=sql, count=unlocked_count)
        frappe_module.throw = lambda message, *, exc=ValueError: (
            _ for _ in ()
        ).throw(exc(message))
        spec = importlib.util.spec_from_file_location(
            "ironwrap_document_validation_fleet_release", ADAPTER_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module, queries

    def rows(self) -> dict[str, list[dict[str, object]]]:
        return {
            "Cargo Load": [
                {
                    "name": "load-draft",
                    "cargo_load_id": "load-draft",
                    "roof_job": "job-1",
                    "fleet_asset": "asset-truck-1",
                    "trailer_asset": None,
                    "job_assignment": None,
                    "driver_authority": None,
                    "driver_user": None,
                    "status": "Draft",
                    "loaded_weight_kg": None,
                    "custody_holder_type": None,
                    "custody_crew_profile": None,
                    "custody_user": None,
                },
                {
                    "name": "load-cancelled",
                    "cargo_load_id": "load-cancelled",
                    "roof_job": "job-1",
                    "fleet_asset": "asset-truck-2",
                    "trailer_asset": None,
                    "job_assignment": None,
                    "driver_authority": None,
                    "driver_user": None,
                    "status": "Cancelled",
                    "loaded_weight_kg": None,
                    "custody_holder_type": None,
                    "custody_crew_profile": None,
                    "custody_user": None,
                },
            ],
            "Fleet Asset": [dict(fleet_asset(), name="asset-truck-1")],
            "Driver Authority": [],
            "Asset Defect": [
                {"fleet_asset": "asset-truck-1"},
                {"fleet_asset": "asset-truck-1"},
            ],
        }

    def test_a_planned_load_is_inside_the_locked_release_snapshot(self) -> None:
        adapter, queries = self.load_adapter(self.rows())
        loads, assets, _drivers, defects = adapter._locked_fleet_release_context("job-1")

        self.assertEqual([row["name"] for row in loads], ["load-draft"])
        self.assertIn("asset-truck-1", assets)
        _cargo_query, cargo_values = next(
            (query, values) for query, values in queries if "`tabCargo Load`" in query
        )
        self.assertEqual(
            set(cargo_values[1:]), set(CARGO_LOAD_RELEASE_FENCE_STATUSES)
        )
        # The defect rows are counted from the locked snapshot, not from an
        # unlocked frappe.db.count a Desk-created defect could slip past.
        self.assertEqual(defects, {"asset-truck-1": 2})
        self.assertTrue(
            any("`tabAsset Defect`" in query for query, _values in queries)
        )


if __name__ == "__main__":
    unittest.main()
