from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import CUSTOMER_ACCEPTANCE_SERVICE_ROLE


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
EVIDENCE_ITEM_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "evidence_item"
    / "evidence_item.py"
)
CUSTOMER_QUOTE_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "customer_quote"
    / "customer_quote.py"
)
CONTRACT_ACCEPTANCE_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "contract_acceptance"
    / "contract_acceptance.py"
)
PROPOSAL_EVIDENCE_PACK_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "proposal_evidence_pack"
    / "proposal_evidence_pack.py"
)
WORK_PACKAGE_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "work_package"
    / "work_package.py"
)
WORK_PACKAGE_EVENT_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "work_package_event"
    / "work_package_event.py"
)
CONTROLLED_ITEM_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "controlled_item"
    / "controlled_item.py"
)
MATERIAL_LOT_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "material_lot"
    / "material_lot.py"
)
NONCONFORMANCE_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "nonconformance"
    / "nonconformance.py"
)
SHOP_ORDER_CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "shop_order"
    / "shop_order.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, previous: dict | None = None) -> None:
        super().__init__(values)
        self.previous = previous

    def as_dict(self) -> dict:
        return dict(self)

    def get_doc_before_save(self) -> dict | None:
        return self.previous


def gate_evidence_rows(gates: list[dict]) -> list[dict]:
    return [
        {
            "name": gate["evidence_item"],
            "roof_job": gate["roof_job"],
            "sync_state": "Verified",
            "content_checksum": "a" * 64,
            "checksum_algorithm": "SHA-256",
            "verified_at": "2026-07-10T12:00:00.000Z",
            "verification_source": "worker-checksum",
            "r2_key": f"private/{gate['roof_job']}/{gate['evidence_item']}.jpg",
        }
        for gate in gates
        if gate.get("state") in {"Ready", "Done"} and gate.get("evidence_item")
    ]


def current_crew_authority(crew_profile_id: str) -> dict:
    return {
        "name": crew_profile_id,
        "crew_profile_id": crew_profile_id,
        "status": "Active",
        "crew_type": "Internal",
        "competency_status": "Current",
        "competency_checked_at": "2026-07-01 08:00:00",
        "competency_expiry": "2026-12-31",
        "equipment_status": "Safe",
        "equipment_checked_at": "2026-07-01 08:00:00",
        "equipment_expiry": "2026-12-31",
        "wcb_status": "Not Required",
        "wcb_checked_at": "2026-07-01 08:00:00",
        "wcb_expiry": "",
        "active_stop": 0,
        "active_stop_at": "",
        "active_stop_reason": "",
    }


def current_compliance_authorities(roof_job: str) -> list[dict]:
    return [
        {
            "name": f"compliance:{gate.lower()}",
            "compliance_record_id": f"compliance:{gate.lower()}",
            "roof_job": roof_job,
            "required_before_gate": gate,
            "status": "Passed",
            "effective_date": "2026-01-01",
            "expiry_date": "2026-12-31",
            "supersedes": "",
        }
        for gate in ("Crew", "Safety", "Access")
    ]


class DocumentValidationAdapterTests(unittest.TestCase):
    def load_adapter(
        self,
        *,
        values=None,
        counts=None,
        rows=None,
        session_user="owner@example.com",
        roles=None,
    ):
        values = values or {}
        counts = counts or {}
        rows = rows or {}
        calls = []
        lock_calls = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError

        def sql(query, values, *, as_dict):
            normalized = " ".join(query.split())
            lock_calls.append((normalized, values, as_dict))
            if "`tabRoof Job`" in normalized:
                return [{"name": values[0]}] if values[0] else []
            if "`tabProduction Gate State`" in normalized:
                if "AND gate = %s" in normalized:
                    return [
                        dict(row)
                        for row in rows.get("Production Gate State Duplicate", [])
                    ]
                return [dict(row) for row in rows.get("Production Gate State", [])]
            if "`tabEvidence Item`" in normalized:
                requested_names = set(values)
                return [
                    dict(row)
                    for row in rows.get("Evidence Item", [])
                    if row.get("name") in requested_names
                ]
            if "`tabJob Assignment`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Job Assignment", [])
                    if row.get("roof_job") == values[0]
                ]
            if "`tabCrew Profile`" in normalized:
                requested_names = set(values)
                return [
                    dict(row)
                    for row in rows.get("Crew Profile", [])
                    if row.get("name") in requested_names
                ]
            if "`tabJob Compliance Record`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Job Compliance Record", [])
                    if row.get("roof_job") == values[0]
                ]
            if "`tabSafety Plan`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Safety Plan", [])
                    if row.get("roof_job") == values[0]
                ]
            if "`tabWork Package`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Work Package", [])
                    if row.get("roof_job") == values[0]
                ]
            if "`tabSupplier Order`" in normalized:
                return [
                    dict(row)
                    for row in rows.get("Supplier Order", [])
                    if row.get("roof_job") == values[0]
                ]
            raise AssertionError(f"unexpected SQL: {normalized}")

        frappe_module.db = types.SimpleNamespace(
            get_value=lambda doctype, name, field, **_kwargs: values.get((doctype, name, field)),
            count=lambda doctype, filters=None: counts.get(doctype, 0),
            sql=sql,
        )
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-10 10:00:00"
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else ["IronWrap Owner"]
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
        module._test_lock_calls = lock_calls
        return module, calls

    def test_policy_violations_become_frappe_validation_errors(self) -> None:
        adapter, _ = self.load_adapter()
        with self.assertRaisesRegex(FakeValidationError, "required_fields"):
            adapter.validate_business_document(FakeDocument({}), "lead_envelope")

    def test_waivers_require_the_current_owner_actor(self) -> None:
        compliance = FakeDocument(
            {
                "compliance_record_id": "compliance:safety:1",
                "roof_job": "job-1",
                "jurisdiction": "Calgary, AB",
                "record_type": "Inspection",
                "authority_name": "IronWrap Safety",
                "status": "Waived",
                "required_before_gate": "Safety",
                "effective_date": "2026-07-01",
                "expiry_date": "2026-12-31",
                "owner_user": "owner@example.com",
                "waived_by": "owner@example.com",
                "waived_at": "2026-07-10 08:00:00",
                "waiver_reason": "Owner accepted the documented exception.",
            }
        )
        gate = FakeDocument(
            {
                "gate_id": "gate-safety-1",
                "roof_job": "job-1",
                "gate": "Safety",
                "state": "Waived",
                "owner_user": "owner@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "waived_by": "owner@example.com",
                "waived_at": "2026-07-10 08:00:00",
                "waiver_reason": "Owner accepted the documented exception.",
            }
        )
        adapter, _ = self.load_adapter()
        adapter.validate_business_document(compliance, "job_compliance_record")
        adapter.validate_business_document(gate, "production_gate_state")

        production_adapter, _ = self.load_adapter(
            session_user="production@example.com", roles=["IronWrap Production"]
        )
        with self.assertRaisesRegex(FakePermissionError, "Owner or System Manager"):
            production_adapter.validate_business_document(
                FakeDocument({**compliance, "waived_by": "production@example.com"}),
                "job_compliance_record",
            )
        with self.assertRaisesRegex(FakePermissionError, "current owner-level actor"):
            adapter.validate_business_document(
                FakeDocument({**gate, "waived_by": "other@example.com"}),
                "production_gate_state",
            )

    def test_previous_document_is_passed_to_immutable_policy(self) -> None:
        adapter, _ = self.load_adapter()
        document = FakeDocument(
            {"evidence_id": "ev-1", "r2_key": "raw/new"},
            previous={"evidence_id": "ev-1", "r2_key": "raw/original"},
        )
        with self.assertRaisesRegex(FakeValidationError, "write_once_field"):
            adapter.validate_business_document(document, "evidence_item")

    def test_verified_evidence_requires_the_private_worker_issuer_context(self) -> None:
        adapter, _ = self.load_adapter()
        issued = FakeDocument(
            {
                "evidence_id": "ev-issued-1",
                "device_action_id": "device-action-1",
                "roof_job": "job-1",
                "evidence_type": "Photo",
                "proof_owner": "crew@example.com",
                "proof_slot": "Production",
                "source_system": "ironwrap-pwa",
                "r2_key": "field/v1/job-1/ev-issued-1.jpg",
                "content_checksum": "a" * 64,
                "checksum_algorithm": "SHA-256",
                "content_type": "image/jpeg",
                "content_length": 1024,
                "capture_actor": "crew@example.com",
                "captured_at": "2026-07-10 08:00:00",
                "sync_state": "Verified",
                "verified_at": "2026-07-10 08:01:00",
                "verification_source": "ironwrap-worker-r2-frappe",
                "customer_safe": 0,
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "dedicated Worker"):
            adapter.validate_evidence_verification_mutation(issued)
        with adapter.field_evidence_issuance_context(issued):
            adapter.validate_evidence_verification_mutation(issued)
        with self.assertRaisesRegex(FakeValidationError, "dedicated Worker"):
            adapter.validate_evidence_verification_mutation(
                FakeDocument(
                    {**issued, "summary": "forged after issuer context"},
                    previous={**issued, "sync_state": "Uploaded"},
                )
            )
        with self.assertRaisesRegex(FakeValidationError, "dedicated Worker"):
            adapter.validate_evidence_verification_mutation(
                FakeDocument(
                    dict(issued), previous={**issued, "sync_state": "Uploaded"}
                )
            )

        controller = EVIDENCE_ITEM_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn("validate_evidence_verification_mutation(self)", controller)

    def test_customer_contract_acceptance_requires_the_private_command_context(self) -> None:
        adapter, _ = self.load_adapter()
        evidence = FakeDocument(
            {
                "evidence_id": "contract-receipt:accept-1",
                "device_action_id": "accept-1",
                "roof_job": "job-1",
                "evidence_type": "Signed Document",
                "proof_slot": "Contract",
                "source_system": "ironwrap-customer-portal",
                "r2_key": "customer-contract-acceptance/v1/job-1/accept-1.json",
                "content_checksum": "a" * 64,
                "checksum_algorithm": "SHA-256",
                "content_type": "application/json",
                "content_length": 512,
                "capture_actor": "customer-acceptance@example.com",
                "captured_at": "2026-07-31T10:00:00Z",
                "sync_state": "Verified",
                "verified_at": "2026-07-31 10:01:00",
                "verification_source": "ironwrap-worker-r2-customer-contract-acceptance",
                "customer_safe": 0,
            }
        )
        acceptance = FakeDocument(
            {
                "acceptance_id": "accept-1",
                "roof_job": "job-1",
                "customer": "customer-1",
                "customer_quote": "cq-1",
                "proposal_evidence_pack": "proposal:cq-1",
                "contract_version": "cq-1:v1",
                "status": "Accepted",
                "signer_name": "Alex Customer",
                "signer_email": "alex@example.com",
                "signer_ip": "203.0.113.10",
                "accepted_at": "2026-07-31T10:00:00Z",
                "acceptance_method": "Click to Accept",
                "evidence_item": "contract-receipt:accept-1",
                "terms_hash": "b" * 64,
                "terms_snapshot_json": "{\"anchor\":{\"quote_id\":\"cq-1\"}}",
                "document_checksum": "a" * 64,
                "source_system": "ironwrap-customer-portal",
                "provider_reference": "challenge-1",
                "captured_by": "customer-acceptance@example.com",
            }
        )
        quote = FakeDocument(
            {
                "name": "cq-1",
                "status": "Accepted",
                "acceptance_evidence": "contract-receipt:accept-1",
                "contract_acceptance": "accept-1",
                "accepted_at": "2026-07-31T10:00:00Z",
            },
            previous={
                "name": "cq-1",
                "status": "Approved",
                "acceptance_evidence": "",
                "contract_acceptance": "",
                "accepted_at": "",
            },
        )
        with self.assertRaisesRegex(FakeValidationError, "bounded customer contract"):
            adapter.validate_contract_acceptance_mutation(acceptance)
        with self.assertRaisesRegex(FakeValidationError, "bounded customer contract"):
            adapter.validate_customer_quote_acceptance_mutation(quote)
        with adapter.customer_contract_acceptance_issuance_context(
            evidence, acceptance, quote
        ):
            adapter.validate_evidence_verification_mutation(evidence)
            adapter.validate_contract_acceptance_mutation(acceptance)
            adapter.validate_customer_quote_acceptance_mutation(quote)

        quote_controller = CUSTOMER_QUOTE_CONTROLLER_PATH.read_text(encoding="utf-8")
        acceptance_controller = CONTRACT_ACCEPTANCE_CONTROLLER_PATH.read_text(
            encoding="utf-8"
        )
        self.assertIn("validate_customer_quote_acceptance_mutation(self)", quote_controller)
        self.assertIn("validate_contract_acceptance_mutation(self)", acceptance_controller)

    def test_customer_acceptance_service_has_no_generic_document_write_path(self) -> None:
        adapter, _ = self.load_adapter(
            session_user="customer-acceptance@example.com",
            roles=[CUSTOMER_ACCEPTANCE_SERVICE_ROLE],
        )
        generic_documents = (
            (
                "evidence",
                adapter.validate_evidence_verification_mutation,
                FakeDocument(
                    {
                        "evidence_id": "contract-receipt:forged",
                        "sync_state": "Local",
                    }
                ),
            ),
            (
                "acceptance",
                adapter.validate_contract_acceptance_mutation,
                FakeDocument(
                    {
                        "acceptance_id": "accept-forged",
                        "status": "Declined",
                    }
                ),
            ),
            (
                "quote",
                adapter.validate_customer_quote_acceptance_mutation,
                FakeDocument(
                    {
                        "name": "cq-1",
                        "status": "Draft",
                        "acceptance_evidence": "",
                        "contract_acceptance": "",
                        "accepted_at": "",
                    },
                    previous={
                        "name": "cq-1",
                        "status": "Draft",
                        "acceptance_evidence": "",
                        "contract_acceptance": "",
                        "accepted_at": "",
                    },
                ),
            ),
        )
        for name, validator, document in generic_documents:
            with self.subTest(path=name):
                with self.assertRaisesRegex(
                    FakePermissionError, "Customer acceptance service users"
                ):
                    validator(document)

        evidence = FakeDocument(
            {
                "evidence_id": "contract-receipt:accept-1",
                "device_action_id": "accept-1",
                "roof_job": "job-1",
                "evidence_type": "Signed Document",
                "proof_slot": "Contract",
                "source_system": "ironwrap-customer-portal",
                "r2_key": "customer-contract-acceptance/v1/job-1/accept-1.json",
                "content_checksum": "a" * 64,
                "checksum_algorithm": "SHA-256",
                "content_type": "application/json",
                "content_length": 512,
                "capture_actor": "customer-acceptance@example.com",
                "captured_at": "2026-07-31T10:00:00Z",
                "sync_state": "Verified",
                "verified_at": "2026-07-31 10:01:00",
                "verification_source": "ironwrap-worker-r2-customer-contract-acceptance",
                "customer_safe": 0,
            }
        )
        acceptance = FakeDocument(
            {
                "acceptance_id": "accept-1",
                "roof_job": "job-1",
                "customer": "customer-1",
                "customer_quote": "cq-1",
                "proposal_evidence_pack": "proposal:cq-1",
                "contract_version": "cq-1:v1",
                "status": "Accepted",
                "signer_name": "Alex Customer",
                "signer_email": "alex@example.com",
                "signer_ip": "203.0.113.10",
                "accepted_at": "2026-07-31T10:00:00Z",
                "acceptance_method": "Click to Accept",
                "evidence_item": "contract-receipt:accept-1",
                "terms_hash": "b" * 64,
                "terms_snapshot_json": "{\"anchor\":{\"quote_id\":\"cq-1\"}}",
                "document_checksum": "a" * 64,
                "source_system": "ironwrap-customer-portal",
                "provider_reference": "challenge-1",
                "captured_by": "customer-acceptance@example.com",
            }
        )
        quote = FakeDocument(
            {
                "name": "cq-1",
                "status": "Accepted",
                "acceptance_evidence": "contract-receipt:accept-1",
                "contract_acceptance": "accept-1",
                "accepted_at": "2026-07-31T10:00:00Z",
            },
            previous={
                "name": "cq-1",
                "status": "Approved",
                "acceptance_evidence": "",
                "contract_acceptance": "",
                "accepted_at": "",
            },
        )
        with adapter.customer_contract_acceptance_issuance_context(
            evidence, acceptance, quote
        ):
            adapter.validate_evidence_verification_mutation(evidence)
            adapter.validate_contract_acceptance_mutation(acceptance)
            adapter.validate_customer_quote_acceptance_mutation(quote)

    def test_work_package_lifecycle_and_events_require_private_command_contexts(
        self,
    ) -> None:
        adapter, _ = self.load_adapter()
        released = {
            "name": "wp:job-1:v1",
            "status": "Released",
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
            "completed_at": None,
        }
        acknowledged = FakeDocument(
            {
                **released,
                "status": "Acknowledged",
                "acknowledged_by": "crew@example.com",
                "acknowledged_at": "2026-07-10 08:15:00",
                "acknowledgement_device_action_id": "field-ack-0001",
            },
            previous=released,
        )
        with self.assertRaisesRegex(FakeValidationError, "bounded Work Package"):
            adapter.validate_work_package_runtime_mutation(acknowledged)
        with adapter.work_package_transition_context(acknowledged):
            adapter.validate_work_package_runtime_mutation(acknowledged)

        event = FakeDocument(
            {
                "work_package_event_id": "wpe-ack-1",
                "event_type": "Acknowledged",
                "work_package": "wp:job-1:v1",
                "roof_job": "job-1",
                "job_assignment": "assignment-1",
                "work_package_version": 1,
                "actor_user": "crew@example.com",
                "actor_role": "Production direct assignment",
                "device_action_id": "field-ack-0001",
                "occurred_at": "2026-07-10 08:15:00",
                "payload_hash": "a" * 64,
                "hold_point_sequence": None,
                "evidence_item": None,
                "blocker_reason": None,
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "bounded Work Package"):
            adapter.validate_work_package_event_mutation(event)
        with adapter.work_package_event_issuance_context(event):
            adapter.validate_work_package_event_mutation(event)
        with self.assertRaisesRegex(FakeValidationError, "append-only"):
            adapter.validate_work_package_event_mutation(
                FakeDocument({**event, "actor_role": "Forged"}, previous=dict(event))
            )

        package_controller = WORK_PACKAGE_CONTROLLER_PATH.read_text(encoding="utf-8")
        event_controller = WORK_PACKAGE_EVENT_CONTROLLER_PATH.read_text(
            encoding="utf-8"
        )
        self.assertIn("validate_work_package_runtime_mutation(self)", package_controller)
        self.assertIn("validate_work_package_event_mutation(self)", event_controller)

    def test_shop_domain_lifecycles_require_private_command_contexts(self) -> None:
        adapter, _ = self.load_adapter()
        item_draft = FakeDocument(
            {
                "name": "item-1",
                "status": "Draft",
                "approved_by": "",
                "approved_at": "",
                "approval_note": "",
            }
        )
        item_approved = FakeDocument(
            {
                "name": "item-1",
                "status": "Approved",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-30 08:00:00",
                "approval_note": "Approved metal system specification.",
            },
            previous=dict(item_draft),
        )
        with self.assertRaisesRegex(FakeValidationError, "Controlled Item lifecycle"):
            adapter.validate_controlled_item_runtime_mutation(item_approved)
        with adapter.controlled_item_transition_context(item_approved):
            adapter.validate_controlled_item_runtime_mutation(item_approved)

        lot_draft = FakeDocument({"name": "lot-1", "status": "Draft"})
        lot_available = FakeDocument(
            {"name": "lot-1", "status": "Available"}, previous=dict(lot_draft)
        )
        with self.assertRaisesRegex(FakeValidationError, "Material Lot lifecycle"):
            adapter.validate_material_lot_runtime_mutation(lot_available)
        with adapter.material_lot_transition_context(lot_available):
            adapter.validate_material_lot_runtime_mutation(lot_available)

        ncr_draft = FakeDocument({"name": "ncr-1", "status": "Draft"})
        ncr_open = FakeDocument(
            {
                "name": "ncr-1",
                "status": "Open",
                "containment": "",
                "disposition": "",
                "disposition_by": "",
                "disposition_at": "",
                "closed_by": "",
                "closed_at": "",
                "closure_evidence": "",
            },
            previous=dict(ncr_draft),
        )
        with self.assertRaisesRegex(FakeValidationError, "Nonconformance lifecycle"):
            adapter.validate_nonconformance_runtime_mutation(ncr_open)
        with adapter.nonconformance_transition_context(ncr_open):
            adapter.validate_nonconformance_runtime_mutation(ncr_open)

        ncr_contained = FakeDocument(
            {
                "name": "ncr-first-piece-1",
                "status": "Contained",
                "containment": "Material Lot quarantined; Shop Order on Quality Hold.",
                "disposition": "",
                "disposition_by": "",
                "disposition_at": "",
                "closed_by": "",
                "closed_at": "",
                "closure_evidence": "",
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "Nonconformance lifecycle"):
            adapter.validate_nonconformance_runtime_mutation(ncr_contained)
        with adapter.nonconformance_transition_context(ncr_contained):
            adapter.validate_nonconformance_runtime_mutation(ncr_contained)

        shop_draft = FakeDocument({"name": "shop-1", "status": "Draft", "lines": []})
        shop_released = FakeDocument(
            {
                "name": "shop-1",
                "status": "Released",
                "released_by": "production@example.com",
                "released_at": "2026-07-30 09:00:00",
                "reserved_at": "",
                "setup_started_at": "",
                "fabrication_started_at": "",
                "quality_hold_reason": "",
                "ready_at": "",
                "handed_over_to": "",
                "handed_over_at": "",
                "handoff_evidence": "",
                "invoice_payment_milestone": "",
                "invoice_ready_at": "",
                "closed_at": "",
                "lines": [{"line_no": 1}],
                "material_allocations": [],
                "operations": [],
                "yields": [],
                "inspections": [],
                "bundles": [],
            },
            previous=dict(shop_draft),
        )
        with self.assertRaisesRegex(FakeValidationError, "Shop Order lifecycle"):
            adapter.validate_shop_order_runtime_mutation(shop_released)
        with adapter.shop_order_transition_context(shop_released):
            adapter.validate_shop_order_runtime_mutation(shop_released)

        for path, call in (
            (CONTROLLED_ITEM_CONTROLLER_PATH, "validate_controlled_item_runtime_mutation(self)"),
            (MATERIAL_LOT_CONTROLLER_PATH, "validate_material_lot_runtime_mutation(self)"),
            (NONCONFORMANCE_CONTROLLER_PATH, "validate_nonconformance_runtime_mutation(self)"),
            (SHOP_ORDER_CONTROLLER_PATH, "validate_shop_order_runtime_mutation(self)"),
        ):
            self.assertIn(call, path.read_text(encoding="utf-8"))

    def test_shop_context_resolves_lot_ncr_and_remnant_lineage(self) -> None:
        adapter, _ = self.load_adapter(
            values={
                ("Controlled Item", "item-1", ("name", "status")): {
                    "name": "item-1",
                    "status": "Approved",
                },
                ("Material Takeoff", "takeoff-1", ("name", "roof_job", "status")): {
                    "name": "takeoff-1",
                    "roof_job": "job-1",
                    "status": "Approved",
                },
                ("Supplier Order", "supplier-1", ("name", "roof_job", "status")): {
                    "name": "supplier-1",
                    "roof_job": "job-1",
                    "status": "Received",
                },
                ("Work Package", "package-1", ("name", "roof_job", "status")): {
                    "name": "package-1",
                    "roof_job": "job-1",
                    "status": "Released",
                },
                ("Payment Milestone", None, ("name", "roof_job", "shop_order", "status")): None,
                (
                    "Material Lot",
                    "lot-1",
                    (
                        "name",
                        "material_lot_id",
                        "roof_job",
                        "controlled_item",
                    "unit",
                    "received_quantity",
                    "available_quantity",
                    "reserved_quantity",
                    "consumed_quantity",
                    "status",
                    ),
                ): {
                    "name": "lot-1",
                    "material_lot_id": "lot-1",
                    "roof_job": "job-1",
                    "controlled_item": "item-1",
                    "unit": "each",
                    "received_quantity": 10,
                    "available_quantity": 10,
                    "reserved_quantity": 0,
                    "consumed_quantity": 0,
                    "status": "Available",
                },
                (
                    "Shop Order",
                    "shop-1",
                    ("name", "shop_order_id", "roof_job", "status"),
                ): {
                    "name": "shop-1",
                    "shop_order_id": "shop-1",
                    "roof_job": "job-1",
                    "status": "In Fabrication",
                },
                (
                    "Material Lot",
                    "lot-1",
                    ("name", "material_lot_id", "roof_job", "controlled_item", "unit", "status"),
                ): {
                    "name": "lot-1",
                    "material_lot_id": "lot-1",
                    "roof_job": "job-1",
                    "controlled_item": "item-1",
                    "unit": "each",
                    "status": "Reserved",
                },
                ("Shop Order", "shop-1", ("name", "roof_job", "status")): {
                    "name": "shop-1",
                    "roof_job": "job-1",
                    "status": "Ready",
                },
            },
            rows={"Shop Material Allocation": [{"parent": "shop-1", "material_lot": "lot-1"}]},
        )
        shop_context = adapter._context(
            FakeDocument(
                {
                    "roof_job": "job-1",
                    "material_takeoff": "takeoff-1",
                    "supplier_order": "supplier-1",
                    "work_package": "package-1",
                    "status": "Reserved",
                    "invoice_payment_milestone": None,
                    "material_allocations": [{"material_lot": "lot-1"}],
                }
            ),
            "shop_order",
        )
        self.assertEqual(shop_context["material_lots"]["lot-1"]["roof_job"], "job-1")
        self.assertEqual(shop_context["material_takeoff"]["roof_job"], "job-1")
        self.assertEqual(shop_context["supplier_order"]["roof_job"], "job-1")
        self.assertEqual(shop_context["work_package"]["roof_job"], "job-1")

        ncr_context = adapter._context(
            FakeDocument({"shop_order": "shop-1", "material_lot": "lot-1"}),
            "nonconformance",
        )
        self.assertEqual(ncr_context["shop_order"]["roof_job"], "job-1")
        self.assertEqual(ncr_context["material_lot"]["status"], "Reserved")
        self.assertEqual(ncr_context["shop_order_allocation_lot_ids"], {"lot-1"})

        remnant_context = adapter._context(
            FakeDocument(
                {
                    "controlled_item": "item-1",
                    "supplier_order": None,
                    "source_kind": "Shop Remnant",
                    "source_shop_order": "shop-1",
                }
            ),
            "material_lot",
        )
        self.assertEqual(remnant_context["source_shop_order"]["status"], "Ready")

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

    def test_customer_visible_scope_clause_requires_its_quote_to_share_the_job(self) -> None:
        document = FakeDocument(
            {
                "scope_clause_id": "scope-1",
                "roof_job": "job-1",
                "customer_quote": "quote-1",
                "status": "Approved",
                "clause_type": "Included",
                "title": "Roofing scope",
                "clause_text": "Install the reviewed roofing system.",
                "version": "1",
                "source_ref": "scope-library:v1",
                "customer_visible": 1,
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-17 10:00:00",
                "approval_note": "Quote wording reviewed.",
            }
        )
        adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "quote-1", ("roof_job",)): {"roof_job": "job-1"}
            }
        )
        adapter.validate_business_document(document, "scope_clause")

        mismatch_adapter, _ = self.load_adapter(
            values={
                ("Customer Quote", "quote-1", ("roof_job",)): {"roof_job": "other-job"}
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "scope_clause_quote_mismatch"):
            mismatch_adapter.validate_business_document(document, "scope_clause")

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
                "roof_job": "job-1",
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
                "Evidence Item": gate_evidence_rows(gates),
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
                "Completion Packet",
                "Warranty Packet",
                "Payment Milestone",
            ],
        )
        self.assertTrue(
            all(filters == {"roof_job": "job-1"} for _, filters, _ in calls)
        )
        self.assertEqual(len(adapter._test_lock_calls), 3)
        self.assertTrue(
            all("FOR UPDATE" in query for query, _, _ in adapter._test_lock_calls)
        )
        self.assertIn("`tabRoof Job`", adapter._test_lock_calls[0][0])
        self.assertIn("`tabProduction Gate State`", adapter._test_lock_calls[1][0])
        self.assertIn("`tabEvidence Item`", adapter._test_lock_calls[2][0])
        self.assertIn("FOR UPDATE", adapter._test_lock_calls[2][0])

        invalid_evidence = gate_evidence_rows(gates)
        invalid_evidence[2]["verification_source"] = ""
        invalid_adapter, _ = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Evidence Item": invalid_evidence,
                "Completion Packet": [{"status": "Approved"}],
                "Warranty Packet": [{"status": "Issued"}],
                "Payment Milestone": [{"status": "Matched"}],
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "unverified_gate_evidence"):
            invalid_adapter.validate_business_document(document, "roof_job")

    def test_scheduled_production_assignment_uses_current_database_gate_context(self) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Done",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        document = FakeDocument(
            {
                "assignment_id": "assignment-production-1",
                "roof_job": "job-1",
                "assignment_type": "Production",
                "status": "Assigned",
                "crew_profile": "crew-1",
                "assigned_by": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "scheduled_start": "2026-07-11 08:00:00",
            }
        )
        adapter, calls = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Crew Profile": [current_crew_authority("crew-1")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
            }
        )
        adapter.validate_business_document(document, "job_assignment")
        self.assertEqual(calls, [])
        self.assertEqual(len(adapter._test_lock_calls), 7)
        self.assertIn("`tabRoof Job`", adapter._test_lock_calls[0][0])
        self.assertIn("`tabProduction Gate State`", adapter._test_lock_calls[1][0])
        self.assertIn("`tabEvidence Item`", adapter._test_lock_calls[2][0])
        self.assertIn("`tabJob Assignment`", adapter._test_lock_calls[3][0])
        self.assertIn("`tabSupplier Order`", adapter._test_lock_calls[4][0])
        self.assertIn("`tabCrew Profile`", adapter._test_lock_calls[5][0])
        self.assertIn("`tabJob Compliance Record`", adapter._test_lock_calls[6][0])
        self.assertIn("FOR UPDATE", adapter._test_lock_calls[2][0])
        self.assertTrue(
            all("FOR UPDATE" in query for query, _, _ in adapter._test_lock_calls)
        )
        self.assertEqual(adapter._test_lock_calls[0][1], ("job-1",))
        self.assertEqual(adapter._test_lock_calls[1][1], ("job-1",))

        invalid_evidence = gate_evidence_rows(gates)
        invalid_evidence[2]["sync_state"] = "Uploaded"
        invalid_adapter, _ = self.load_adapter(
            rows={"Production Gate State": gates, "Evidence Item": invalid_evidence}
        )
        with self.assertRaisesRegex(FakeValidationError, "unverified_gate_evidence"):
            invalid_adapter.validate_business_document(document, "job_assignment")

        missing_adapter, _ = self.load_adapter()
        with self.assertRaisesRegex(FakeValidationError, "production_schedule_gate_block"):
            missing_adapter.validate_business_document(document, "job_assignment")

        unscheduled_adapter, unscheduled_calls = self.load_adapter()
        unscheduled_adapter.validate_business_document(
            FakeDocument({**document, "assignment_id": "assignment-unscheduled", "scheduled_start": ""}),
            "job_assignment",
        )
        self.assertEqual(unscheduled_calls, [])
        self.assertEqual(unscheduled_adapter._test_lock_calls, [])

        gate_adapter, gate_calls = self.load_adapter()
        gate_adapter.validate_business_document(
            FakeDocument(
                {
                    "gate_id": "gate-safety-1",
                    "roof_job": "job-1",
                    "gate": "Safety",
                    "state": "Blocked",
                    "owner_user": "production@example.com",
                    "assigned_at": "2026-07-10 08:00:00",
                    "due_at": "2026-07-11 08:00:00",
                    "blocker_reason": "Waiting for a field safety acknowledgement.",
                }
            ),
            "production_gate_state",
        )
        self.assertEqual(gate_calls, [])
        self.assertEqual(len(gate_adapter._test_lock_calls), 2)
        self.assertIn("`tabRoof Job`", gate_adapter._test_lock_calls[0][0])
        self.assertIn("FOR UPDATE", gate_adapter._test_lock_calls[0][0])
        self.assertIn("`tabProduction Gate State`", gate_adapter._test_lock_calls[1][0])
        self.assertIn("AND gate = %s", gate_adapter._test_lock_calls[1][0])

        ready_gate = FakeDocument(
            {
                "gate_id": "gate-safety-ready",
                "roof_job": "job-1",
                "gate": "Safety",
                "state": "Ready",
                "evidence_item": "ev-safety-ready",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "due_at": "2026-07-11 08:00:00",
            }
        )
        ready_evidence = gate_evidence_rows([dict(ready_gate)])
        ready_adapter, ready_calls = self.load_adapter(rows={"Evidence Item": ready_evidence})
        ready_adapter.validate_business_document(ready_gate, "production_gate_state")
        self.assertEqual(ready_calls, [])
        self.assertEqual(len(ready_adapter._test_lock_calls), 3)
        self.assertIn("`tabEvidence Item`", ready_adapter._test_lock_calls[2][0])
        self.assertIn("FOR UPDATE", ready_adapter._test_lock_calls[2][0])

        forged_evidence = gate_evidence_rows([dict(ready_gate)])
        forged_evidence[0]["roof_job"] = "job-other"
        forged_adapter, _ = self.load_adapter(rows={"Evidence Item": forged_evidence})
        with self.assertRaisesRegex(FakeValidationError, "cross_job_gate_evidence"):
            forged_adapter.validate_business_document(ready_gate, "production_gate_state")

        duplicate_adapter, _ = self.load_adapter(
            rows={"Production Gate State Duplicate": [{"name": "gate-safety-existing"}]}
        )
        with self.assertRaisesRegex(FakeValidationError, "duplicate_production_gate"):
            duplicate_adapter.validate_business_document(
                FakeDocument(
                    {
                        "gate_id": "gate-safety-2",
                        "roof_job": "job-1",
                        "gate": "Safety",
                        "state": "Blocked",
                        "owner_user": "production@example.com",
                        "assigned_at": "2026-07-10 08:00:00",
                        "due_at": "2026-07-11 08:00:00",
                        "blocker_reason": "Waiting for a field safety acknowledgement.",
                    }
                ),
                "production_gate_state",
            )

    def test_released_work_package_uses_locked_current_release_context(self) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Done",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        assignment = {
            "name": "assignment:production-1",
            "assignment_id": "assignment:production-1",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "crew_profile": "crew-1",
            "scheduled_start": "2026-07-10 12:00:00",
        }
        safety_plan = {
            "name": "safety:job-1:v1",
            "safety_plan_id": "safety:job-1:v1",
            "roof_job": "job-1",
            "version": 1,
            "status": "Acknowledged",
        }
        document = FakeDocument(
            {
                "work_package_id": "work-package:job-1:v1",
                "roof_job": "job-1",
                "job_assignment": assignment["assignment_id"],
                "safety_plan": safety_plan["safety_plan_id"],
                "version": 1,
                "status": "Released",
                "title": "Install standing-seam panels",
                "objective": "Install the approved main-roof panel sequence.",
                "boundaries": "Main roof only; no hidden-condition repair.",
                "prerequisites": "Access, materials, and safety gates are current.",
                "expected_result": "Panels are installed to the released detail.",
                "stop_conditions": "Stop for unsafe wind, deck damage, or a scope conflict.",
                "make_safe_procedure": "Secure materials, protect openings, and notify production.",
                "issued_at": "2026-07-10 08:00:00",
                "expires_at": "2026-07-11 08:00:00",
                "released_by": "production@example.com",
                "released_at": "2026-07-10 09:00:00",
                "steps": [
                    {
                        "sequence": 1,
                        "instruction": "Confirm protected access and staging.",
                        "required_evidence": "Arrival photo and field check-in.",
                        "acceptance_criteria": "Access is controlled and materials are secure.",
                    }
                ],
                "hold_points": [
                    {
                        "sequence": 1,
                        "hold_point": "Deck condition before panel installation",
                        "release_authority": "IronWrap Production",
                        "required_evidence": "Deck-condition photo set.",
                        "acceptance_criteria": "Substrate is dry, sound, and ready for installation.",
                    }
                ],
            }
        )
        adapter, calls = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Job Assignment": [assignment],
                "Crew Profile": [current_crew_authority("crew-1")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
                "Safety Plan": [safety_plan],
            }
        )
        adapter.validate_business_document(document, "work_package")
        self.assertEqual(calls, [])
        self.assertEqual(len(adapter._test_lock_calls), 8)
        self.assertIn("`tabRoof Job`", adapter._test_lock_calls[0][0])
        self.assertIn("`tabProduction Gate State`", adapter._test_lock_calls[1][0])
        self.assertIn("`tabEvidence Item`", adapter._test_lock_calls[2][0])
        self.assertIn("`tabJob Assignment`", adapter._test_lock_calls[3][0])
        self.assertIn("`tabSafety Plan`", adapter._test_lock_calls[4][0])
        self.assertIn("`tabWork Package`", adapter._test_lock_calls[5][0])
        self.assertIn("`tabCrew Profile`", adapter._test_lock_calls[6][0])
        self.assertIn("`tabJob Compliance Record`", adapter._test_lock_calls[7][0])
        self.assertTrue(
            all("FOR UPDATE" in query for query, _, _ in adapter._test_lock_calls)
        )

        stale_adapter, _ = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Job Assignment": [assignment],
                "Crew Profile": [current_crew_authority("crew-1")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
                "Safety Plan": [
                    safety_plan,
                    {
                        "name": "safety:job-1:v2",
                        "safety_plan_id": "safety:job-1:v2",
                        "roof_job": "job-1",
                        "version": 2,
                        "status": "Acknowledged",
                        "supersedes": safety_plan["safety_plan_id"],
                    },
                ],
            }
        )
        with self.assertRaisesRegex(FakeValidationError, "stale_work_package_safety_plan"):
            stale_adapter.validate_business_document(document, "work_package")

        controller = WORK_PACKAGE_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn('validate_business_document(self, "work_package")', controller)

    def test_scheduled_production_assignment_uses_locked_assignment_and_material_context(
        self,
    ) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Done",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        source = {
            "name": "assignment:current",
            "assignment_id": "assignment:current",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "scheduled_start": "2026-07-11 08:00:00",
        }
        correction = FakeDocument(
            {
                "assignment_id": "assignment:correction",
                "roof_job": "job-1",
                "assignment_type": "Production",
                "status": "Assigned",
                "crew_profile": "crew-2",
                "assigned_by": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "scheduled_start": "2026-07-12 08:00:00",
                "supersedes": "assignment:current",
                "correction_reason": "Access moved the production window.",
            }
        )
        adapter, _ = self.load_adapter(
            values={("Job Assignment", "assignment:current", ("roof_job",)): source},
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Job Assignment": [source],
                "Crew Profile": [current_crew_authority("crew-2")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
            },
        )
        adapter.validate_business_document(correction, "job_assignment")
        self.assertEqual(len(adapter._test_lock_calls), 7)
        self.assertIn("`tabRoof Job`", adapter._test_lock_calls[0][0])
        self.assertIn("`tabJob Assignment`", adapter._test_lock_calls[3][0])
        self.assertIn("`tabSupplier Order`", adapter._test_lock_calls[4][0])
        self.assertIn("`tabCrew Profile`", adapter._test_lock_calls[5][0])
        self.assertIn("`tabJob Compliance Record`", adapter._test_lock_calls[6][0])
        self.assertTrue(
            all("FOR UPDATE" in query for query, _, _ in adapter._test_lock_calls)
        )

        stale_adapter, _ = self.load_adapter(
            values={("Job Assignment", "assignment:current", ("roof_job",)): source},
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Job Assignment": [source, {**correction, "name": "assignment:correction"}],
                "Crew Profile": [current_crew_authority("crew-2")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
            },
        )
        with self.assertRaisesRegex(
            FakeValidationError, "stale_production_assignment_correction"
        ):
            stale_adapter.validate_business_document(
                FakeDocument({**correction, "assignment_id": "assignment:second-correction"}),
                "job_assignment",
            )

        material_adapter, _ = self.load_adapter(
            rows={
                "Production Gate State": gates,
                "Evidence Item": gate_evidence_rows(gates),
                "Crew Profile": [current_crew_authority("crew-2")],
                "Job Compliance Record": current_compliance_authorities("job-1"),
                "Supplier Order": [
                    {
                        "name": "supplier-order-1",
                        "supplier_order_id": "supplier-order-1",
                        "roof_job": "job-1",
                        "status": "Shortage",
                    }
                ],
            }
        )
        with self.assertRaisesRegex(
            FakeValidationError, "material_exception_blocks_production_schedule"
        ):
            material_adapter.validate_business_document(
                FakeDocument(
                    {
                        "assignment_id": "assignment:new",
                        "roof_job": "job-1",
                        "assignment_type": "Production",
                        "status": "Assigned",
                        "crew_profile": "crew-2",
                        "assigned_by": "production@example.com",
                        "assigned_at": "2026-07-10 08:00:00",
                        "scheduled_start": "2026-07-12 08:00:00",
                    }
                ),
                "job_assignment",
            )

    def test_supplier_order_shares_the_roof_job_lock_with_scheduling(self) -> None:
        order = FakeDocument(
            {
                "supplier_order_id": "supplier-order-1",
                "status": "Draft",
                "roof_job": "job-1",
                "items": [],
            }
        )
        adapter, _ = self.load_adapter()

        adapter.validate_business_document(order, "supplier_order")

        self.assertEqual(len(adapter._test_lock_calls), 1)
        query, values, _ = adapter._test_lock_calls[0]
        self.assertIn("`tabRoof Job`", query)
        self.assertIn("FOR UPDATE", query)
        self.assertEqual(values, ("job-1",))

    def test_supplier_order_context_resolves_acknowledgement_and_receipt_evidence(self) -> None:
        evidence_rows = [
            {
                "name": evidence_id,
                "roof_job": "job-1",
                "proof_slot": "Materials",
                "sync_state": "Verified",
                "content_checksum": "a" * 64,
                "checksum_algorithm": "SHA-256",
                "verified_at": "2026-07-10 12:00:00",
                "verification_source": "synthetic-test",
                "r2_key": f"private/job-1/{evidence_id}.pdf",
            }
            for evidence_id in ("evidence:ack-1", "evidence:receipt-1")
        ]
        adapter, calls = self.load_adapter(
            values={
                ("Material Takeoff", "takeoff-1", "status"): "Approved",
                ("Supplier Quote", "quote-1", "status"): "Approved",
            },
            rows={"Evidence Item": evidence_rows},
        )
        context = adapter._context(
            FakeDocument(
                {
                    "roof_job": "job-1",
                    "material_takeoff": "takeoff-1",
                    "source_quote": "quote-1",
                    "supplier_acknowledgement_evidence": "evidence:ack-1",
                    "receipt_evidence_json": '{"evidence_item_ids":["evidence:receipt-1"]}',
                }
            ),
            "supplier_order",
        )

        self.assertEqual(set(context["supplier_order_evidence"]), {
            "evidence:ack-1",
            "evidence:receipt-1",
        })
        evidence_call = next(call for call in calls if call[0] == "Evidence Item")
        self.assertEqual(evidence_call[1], {"name": ["in", ["evidence:ack-1", "evidence:receipt-1"]]})

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

    def test_proposal_publication_requires_the_approved_command_context(self) -> None:
        adapter, _ = self.load_adapter()
        draft = {
            "name": "proposal:cq-1",
            "pack_id": "proposal:cq-1",
            "status": "Draft",
            "approved_by": "",
            "approved_at": "",
        }
        published = {
            **draft,
            "status": "Approved",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-17 10:00:00",
        }
        with self.assertRaisesRegex(FakeValidationError, "approved Hermes command"):
            adapter.validate_proposal_publication_mutation(
                FakeDocument(published, previous=draft)
            )
        with adapter.proposal_publication_context(
            "proposal:cq-1",
            "run-proposal-publication-0001",
            "owner@example.com",
            "2026-07-17 10:00:00",
        ):
            adapter.validate_proposal_publication_mutation(
                FakeDocument(published, previous=draft)
            )
        with (
            adapter.proposal_publication_context(
                "proposal:cq-1",
                "run-proposal-publication-0001",
                "owner@example.com",
                "2026-07-17 10:00:01",
            ),
            self.assertRaisesRegex(FakeValidationError, "did not match"),
        ):
            adapter.validate_proposal_publication_mutation(
                FakeDocument(published, previous=draft)
            )

        controller = PROPOSAL_EVIDENCE_PACK_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertLess(
            controller.index("validate_proposal_publication_mutation(self)"),
            controller.index('validate_business_document(self, "proposal_evidence_pack")'),
        )


if __name__ == "__main__":
    unittest.main()
