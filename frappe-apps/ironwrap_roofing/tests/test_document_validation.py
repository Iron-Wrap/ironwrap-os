from __future__ import annotations

import importlib.util
import json
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
LEAD_ENVELOPE_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "lead_envelope"
    / "lead_envelope.py"
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
            get_value=lambda doctype, name, field, **_kwargs: values.get((doctype, name, field)),
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

    def test_customer_quote_correction_loads_contract_lineage_context(self) -> None:
        fields = (
            "roof_job",
            "customer",
            "quote_version",
            "status",
            "contract_acceptance",
            "accepted_at",
        )
        source = {
            "roof_job": "job-1",
            "customer": "customer-1",
            "quote_version": 1,
            "status": "Approved",
            "contract_acceptance": "",
            "accepted_at": "",
        }
        revision = FakeDocument(
            {
                "customer_quote_id": "cq-2",
                "roof_job": "job-1",
                "customer": "customer-1",
                "quote_version": 2,
                "status": "Draft",
                "supersedes": "cq-1",
                "correction_reason": "Fresh source review is required.",
            }
        )
        adapter, _ = self.load_adapter(
            values={("Customer Quote", "cq-1", fields): source}
        )
        adapter.validate_business_document(revision, "customer_quote")

        accepted_adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "cq-1", fields): {
                    **source,
                    "status": "Accepted",
                    "contract_acceptance": "accept-1",
                }
            }
        )
        with self.assertRaisesRegex(
            FakeValidationError, "accepted_quote_revision_requires_change_order"
        ):
            accepted_adapter.validate_business_document(revision, "customer_quote")

    def test_customer_quote_snapshot_loads_verified_price_rule_context(self) -> None:
        rule = {
            "name": "rule-1",
            "price_rule_id": "rule-1",
            "rule_name": "Standing seam panel",
            "rule_type": "Material",
            "status": "Approved",
            "service_type": "Metal reroof",
            "material_system": "24ga standing seam",
            "unit": "sqft",
            "unit_cost": "8.00",
            "unit_price": "12.50",
            "minimum_quantity": "0",
            "currency": "CAD",
            "source_ref": "supplier-sheet-2026-07",
            "effective_from": "2026-07-01",
            "effective_to": "",
            "assumptions": "Standard colour.",
            "exclusions": "Freight.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 10:00:00",
            "rule_json": '{"unit_price":12.5}',
        }
        snapshot = json.dumps(
            {
                "quote": {
                    "customer_quote_id": "cq-1",
                    "quote_version": 1,
                    "price_book_version": "retail-2026-07",
                    "pricing_effective_at": "2026-07-10 11:30:00",
                },
                "captured_at": "2026-07-10T11:31:00.000Z",
                "rules": [
                    {
                        key: json.loads(rule[key]) if key == "rule_json" else str(rule[key])
                        for key in (
                            "price_rule_id",
                            "rule_name",
                            "rule_type",
                            "status",
                            "service_type",
                            "material_system",
                            "unit",
                            "unit_cost",
                            "unit_price",
                            "minimum_quantity",
                            "currency",
                            "source_ref",
                            "effective_from",
                            "effective_to",
                            "assumptions",
                            "exclusions",
                            "approved_by",
                            "approved_at",
                            "rule_json",
                        )
                    }
                ],
            }
        )
        draft = FakeDocument(
            {
                "customer_quote_id": "cq-1",
                "roof_job": "job-1",
                "customer": "customer-1",
                "quote_version": 1,
                "status": "Draft",
                "price_book_version": "retail-2026-07",
                "pricing_effective_at": "2026-07-10 11:30:00",
                "price_rule_snapshot_json": snapshot,
            }
        )
        adapter, _ = self.load_adapter(rows={"Price Book Rule": [rule]})
        adapter.validate_business_document(draft, "customer_quote")

        missing_adapter, _ = self.load_adapter()
        with self.assertRaisesRegex(FakeValidationError, "unverified_price_rule_snapshot"):
            missing_adapter.validate_business_document(draft, "customer_quote")

    def test_proposal_evidence_pack_loads_quote_anchor_context_for_draft(self) -> None:
        quote_fields = (
            "roof_job",
            "status",
            "quote_version",
            "price_rule_snapshot_json",
        )
        proposal_rows = {
            "Measurement Report": [
                {
                    "name": "measurement-1",
                    "roof_job": "job-1",
                    "provider": "RoofRuler",
                    "review_status": "Approved",
                    "approved_by": "owner@example.com",
                    "approved_at": "2026-07-10T12:00:00.000Z",
                }
            ],
            "Evidence Item": [
                {
                    "name": "evidence-1",
                    "roof_job": "job-1",
                    "evidence_type": "Photo",
                    "proof_slot": "Measurement",
                    "customer_safe": 1,
                    "sync_state": "Verified",
                    "content_checksum": "a" * 64,
                    "checksum_algorithm": "SHA-256",
                    "verified_at": "2026-07-10T12:00:00.000Z",
                    "verification_source": "worker-checksum",
                    "r2_key": "private/job-1/evidence-1.jpg",
                }
            ],
        }
        draft = FakeDocument(
            {
                "pack_id": "proposal:cq-1",
                "status": "Draft",
                "roof_job": "job-1",
                "quotation": "cq-1",
                "evidence_summary_json": """{
                  "roof_job": "job-1",
                  "quotation": "cq-1",
                  "quote_version": 1,
                  "counts": {"measurement_reports": 1, "eligible_evidence": 1, "withheld_evidence": 0},
                  "measurement_reports": [{"measurement_id": "measurement-1", "provider": "RoofRuler", "review_status": "Approved", "approved_at": "2026-07-10T12:00:00.000Z"}],
                  "eligible_evidence": [{"evidence_id": "evidence-1", "evidence_type": "Photo", "proof_slot": "Measurement"}],
                  "withheld_evidence": {"not_customer_safe": 0, "unverified_or_incomplete": 0, "identity_missing": 0}
                }""",
            }
        )
        adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "cq-1", quote_fields): {
                    "roof_job": "job-1",
                    "status": "Approved",
                    "quote_version": 1,
                    "price_rule_snapshot_json": "{}",
                }
            },
            rows=proposal_rows,
        )
        adapter.validate_business_document(draft, "proposal_evidence_pack")

        cross_job_adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "cq-1", quote_fields): {
                    "roof_job": "job-other",
                    "status": "Accepted",
                    "quote_version": 1,
                    "price_rule_snapshot_json": "{}",
                }
            },
            rows=proposal_rows,
        )
        with self.assertRaisesRegex(FakeValidationError, "cross_job_proposal_quote"):
            cross_job_adapter.validate_business_document(draft, "proposal_evidence_pack")

        draft_quote_adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "cq-1", quote_fields): {
                    "roof_job": "job-1",
                    "status": "Draft",
                    "quote_version": 1,
                    "price_rule_snapshot_json": "{}",
                }
            },
            rows=proposal_rows,
        )
        with self.assertRaisesRegex(FakeValidationError, "unapproved_quote"):
            draft_quote_adapter.validate_business_document(draft, "proposal_evidence_pack")

        missing_source_adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "cq-1", quote_fields): {
                    "roof_job": "job-1",
                    "status": "Approved",
                    "quote_version": 1,
                    "price_rule_snapshot_json": "{}",
                }
            },
            rows={"Measurement Report": proposal_rows["Measurement Report"]},
        )
        with self.assertRaisesRegex(FakeValidationError, "unverified_proposal_evidence"):
            missing_source_adapter.validate_business_document(draft, "proposal_evidence_pack")

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

    def test_lead_triage_requires_the_approved_command_context(self) -> None:
        adapter, _ = self.load_adapter()
        original = {
            "name": "lead:1",
            "envelope_id": "lead:1",
            "status": "pending_jn_push",
            "triage_status": "Untriaged",
            "triaged_by": "",
            "triaged_at": "",
            "triage_summary": "",
        }
        transport_only = {**original, "status": "pushed"}
        adapter.validate_lead_envelope_triage_mutation(
            FakeDocument(transport_only, previous=original)
        )

        triaged = {
            **transport_only,
            "triage_status": "Triaged",
            "triaged_by": "owner@example.com",
            "triaged_at": "2026-07-10 18:00:00",
            "triage_summary": "Urgent active leak; verify address before outreach.",
        }
        with self.assertRaisesRegex(FakeValidationError, "approved Hermes command"):
            adapter.validate_lead_envelope_triage_mutation(
                FakeDocument(triaged, previous=transport_only)
            )
        with adapter.lead_triage_transition_context(
            "lead:1",
            "run-lead-triage-0001",
            "owner@example.com",
            "2026-07-10 18:00:00",
            "Urgent active leak; verify address before outreach.",
        ):
            adapter.validate_lead_envelope_triage_mutation(
                FakeDocument(triaged, previous=transport_only)
            )
        with (
            adapter.lead_triage_transition_context(
                "lead:1",
                "run-lead-triage-0001",
                "owner@example.com",
                "2026-07-10 18:00:00",
                "Different summary",
            ),
            self.assertRaisesRegex(FakeValidationError, "did not match"),
        ):
            adapter.validate_lead_envelope_triage_mutation(
                FakeDocument(triaged, previous=transport_only)
            )
        with self.assertRaisesRegex(FakeValidationError, "approved Hermes command"):
            adapter.validate_lead_envelope_triage_mutation(FakeDocument(triaged))

        controller = LEAD_ENVELOPE_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn("validate_lead_envelope_triage_mutation(self)", controller)


if __name__ == "__main__":
    unittest.main()
