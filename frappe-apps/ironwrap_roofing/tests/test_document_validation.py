from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ADAPTER_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "document_validation.py"
)
SAFETY_PLAN_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "safety_plan"
    / "safety_plan.py"
)


class FakeValidationError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, previous: dict | None = None) -> None:
        super().__init__(values)
        self.previous = previous

    def as_dict(self) -> dict:
        return dict(self)

    def get_doc_before_save(self) -> dict | None:
        return self.previous


class DocumentValidationAdapterTests(unittest.TestCase):
    def load_adapter(self, *, values=None, counts=None, rows=None):
        values = values or {}
        counts = counts or {}
        rows = rows or {}
        calls = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.db = types.SimpleNamespace(
            get_value=lambda doctype, name, field: values.get((doctype, name, field)),
            count=lambda doctype, filters=None: counts.get(doctype, 0),
        )

        def get_all(doctype, *, filters, fields):
            calls.append((doctype, filters, fields))
            return rows.get(doctype, [])

        frappe_module.get_all = get_all
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(
            exc(message)
        )
        spec = importlib.util.spec_from_file_location(
            "ironwrap_document_validation_under_test", ADAPTER_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module, calls

    def test_policy_violations_become_frappe_validation_errors(self) -> None:
        adapter, _ = self.load_adapter()
        with self.assertRaisesRegex(FakeValidationError, "required_fields"):
            adapter.validate_business_document(FakeDocument({}), "lead_envelope")

    def test_previous_document_is_passed_to_immutable_policy(self) -> None:
        adapter, _ = self.load_adapter()
        document = FakeDocument(
            {"evidence_id": "ev-1", "r2_key": "raw/new"},
            previous={"evidence_id": "ev-1", "r2_key": "raw/original"},
        )
        with self.assertRaisesRegex(FakeValidationError, "write_once_field"):
            adapter.validate_business_document(document, "evidence_item")

    def test_closed_roof_job_uses_database_context(self) -> None:
        gates = [
            {
                "gate": gate,
                "state": "Done",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate in (
                "Deposit",
                "Materials",
                "Safety",
                "Access",
                "Weather",
                "Crew",
                "Completion",
            )
        ]
        adapter, calls = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Completion Packet": [{"status": "Approved"}],
                "Warranty Packet": [{"status": "Issued"}],
                "Payment Milestone": [{"status": "Matched"}],
            }
        )
        document = FakeDocument(
            {
                "name": "job-1",
                "roof_job_id": "job-1",
                "job_status": "Closed",
                "workflow_profile": "Residential Retail",
                "locale_policy_version": "ca-ab-2026-01",
                "locale_policy_snapshot_json": '{"country":"CA","province":"AB"}',
            }
        )

        adapter.validate_business_document(document, "roof_job")

        self.assertEqual(
            [doctype for doctype, _, _ in calls],
            [
                "Production Gate State",
                "Completion Packet",
                "Warranty Packet",
                "Payment Milestone",
            ],
        )
        self.assertTrue(
            all(filters == {"roof_job": "job-1"} for _, filters, _ in calls)
        )

    def test_safety_acknowledgements_require_the_atomic_append_context(self) -> None:
        adapter, _ = self.load_adapter()
        original = {
            "name": "safety:job-1:v1",
            "acknowledgements": [
                {
                    "acknowledged_by": "lead@example.com",
                    "acknowledged_at": "2026-07-10 07:30:00",
                    "acknowledgement_method": "QR Device Pairing",
                    "device_action_id": "field-ack-0001",
                    "evidence_item": "evidence:safety:lead-1",
                    "role_on_job": "Direct assignment · Production",
                    "notes": "Reviewed.",
                }
            ],
        }
        appended = {
            **original,
            "acknowledgements": [
                *original["acknowledgements"],
                {
                    "acknowledged_by": "crew@example.com",
                    "acknowledged_at": "2026-07-10 07:31:00",
                    "acknowledgement_method": "QR Device Pairing",
                    "device_action_id": "field-ack-0002",
                    "evidence_item": "evidence:safety:crew-1",
                    "role_on_job": "Crew assignment · Installer · Production",
                    "notes": "Reviewed.",
                },
            ],
        }
        with self.assertRaisesRegex(FakeValidationError, "atomic safety"):
            adapter.validate_safety_acknowledgement_mutation(
                FakeDocument(appended, previous=original)
            )
        with adapter.safety_acknowledgement_append_context(
            "safety:job-1:v1", "field-ack-0002"
        ):
            adapter.validate_safety_acknowledgement_mutation(
                FakeDocument(appended, previous=original)
            )

        replacement = {
            **appended,
            "acknowledgements": [
                {**original["acknowledgements"][0], "notes": "Forged replacement"},
                appended["acknowledgements"][1],
            ],
        }
        with (
            adapter.safety_acknowledgement_append_context(
                "safety:job-1:v1", "field-ack-0002"
            ),
            self.assertRaisesRegex(FakeValidationError, "did not match"),
        ):
            adapter.validate_safety_acknowledgement_mutation(
                FakeDocument(replacement, previous=original)
            )

        controller = SAFETY_PLAN_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn("validate_safety_acknowledgement_mutation(self)", controller)

    def test_ready_safety_plan_content_and_status_are_frozen_outside_atomic_append(
        self,
    ) -> None:
        adapter, _ = self.load_adapter()
        ready = {
            "name": "safety:job-1:v1",
            "safety_plan_id": "safety:job-1:v1",
            "roof_job": "job-1",
            "version": 1,
            "status": "Ready",
            "hazard_summary": "Fall exposure.",
            "controls": "Tie-off.",
            "emergency_plan": "Call 911.",
            "ppe_requirements": "Harness.",
            "weather_limits": "Stop above wind threshold.",
            "notes": "Original approved safety plan.",
        }
        with self.assertRaisesRegex(FakeValidationError, "content is immutable"):
            adapter.validate_safety_plan_frozen_content(
                FakeDocument(
                    {**ready, "hazard_summary": "Rewritten after approval."},
                    previous=ready,
                )
            )
        with self.assertRaisesRegex(FakeValidationError, "status is immutable"):
            adapter.validate_safety_plan_frozen_content(
                FakeDocument({**ready, "status": "Superseded"}, previous=ready)
            )

        acknowledged = {**ready, "status": "Acknowledged"}
        with adapter.safety_acknowledgement_append_context(
            "safety:job-1:v1", "field-ack-0002"
        ):
            adapter.validate_safety_plan_frozen_content(
                FakeDocument(acknowledged, previous=ready)
            )

        draft = {**ready, "status": "Draft"}
        adapter.validate_safety_plan_frozen_content(
            FakeDocument(
                {**draft, "status": "Ready", "notes": "Prepared."}, previous=draft
            )
        )

        controller = SAFETY_PLAN_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn("validate_safety_plan_frozen_content(self)", controller)


if __name__ == "__main__":
    unittest.main()
