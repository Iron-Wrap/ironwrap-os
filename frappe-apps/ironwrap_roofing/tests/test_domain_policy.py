from __future__ import annotations

import json
import unittest

from ironwrap_roofing.domain_policy import (
    PolicyViolation,
    parse_json_field,
    validate_record,
)


def proposal_evidence_summary(roof_job: str = "job-1", quotation: str = "cq-1") -> str:
    return json.dumps(
        {
            "roof_job": roof_job,
            "quotation": quotation,
            "quote_version": 1,
            "counts": {
                "measurement_reports": 1,
                "eligible_evidence": 1,
                "withheld_evidence": 0,
            },
            "measurement_reports": [
                {
                    "measurement_id": "measurement-1",
                    "provider": "RoofRuler",
                    "review_status": "Approved",
                    "approved_at": "2026-07-10T12:00:00.000Z",
                }
            ],
            "eligible_evidence": [
                {
                    "evidence_id": "evidence-1",
                    "evidence_type": "Photo",
                    "proof_slot": "Measurement",
                }
            ],
            "withheld_evidence": {
                "not_customer_safe": 0,
                "unverified_or_incomplete": 0,
                "identity_missing": 0,
            },
        }
    )


def proposal_context(**overrides: object) -> dict[str, object]:
    context: dict[str, object] = {
        "quote_status": "Approved",
        "quote_roof_job": "job-1",
        "quote_version": 1,
        "quote_price_rule_snapshot_bound": True,
        "proposal_measurements": {
            "measurement-1": {
                "roof_job": "job-1",
                "provider": "RoofRuler",
                "review_status": "Approved",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-10T12:00:00.000Z",
            }
        },
        "proposal_evidence": {
            "evidence-1": {
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
        },
    }
    context.update(overrides)
    return context


def price_rule_source() -> dict[str, object]:
    return {
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


def price_rule_snapshot() -> str:
    source = price_rule_source()
    return json.dumps(
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
                    key: json.loads(source[key]) if key == "rule_json" else str(source[key])
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


def price_rule_snapshot_context(**overrides: object) -> dict[str, object]:
    source = price_rule_source()
    context: dict[str, object] = {"price_rule_snapshot_rules": {"rule-1": source}}
    context.update(overrides)
    return context


def verified_gate_evidence(roof_job: str = "job-1", **overrides: object) -> dict[str, object]:
    source: dict[str, object] = {
        "roof_job": roof_job,
        "sync_state": "Verified",
        "content_checksum": "a" * 64,
        "checksum_algorithm": "SHA-256",
        "verified_at": "2026-07-10T12:00:00.000Z",
        "verification_source": "worker-checksum",
        "r2_key": f"private/{roof_job}/evidence.jpg",
    }
    source.update(overrides)
    return source


def gate_evidence_context(gates: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    return {
        str(gate["evidence_item"]): verified_gate_evidence(str(gate["roof_job"]))
        for gate in gates
        if gate.get("state") in {"Ready", "Done"} and gate.get("evidence_item")
    }


def supplier_order_evidence(evidence_id: str = "evidence:materials-1") -> dict[str, object]:
    return {
        "name": evidence_id,
        "roof_job": "job-1",
        "proof_slot": "Materials",
        "sync_state": "Verified",
        "content_checksum": "a" * 64,
        "checksum_algorithm": "SHA-256",
        "verified_at": "2026-07-10T12:00:00.000Z",
        "verification_source": "worker-checksum",
        "r2_key": f"private/job-1/{evidence_id}.pdf",
    }


def supplier_order_context(**overrides: object) -> dict[str, object]:
    context: dict[str, object] = {
        "takeoff_status": "Approved",
        "supplier_quote_status": "Approved",
        "supplier_order_evidence": {
            "evidence:materials-1": supplier_order_evidence(),
            "evidence:materials-2": supplier_order_evidence("evidence:materials-2"),
        },
    }
    context.update(overrides)
    return context


def supplier_order_record(status: str = "Needs Review", **overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "supplier_order_id": "so-1",
        "status": status,
        "roof_job": "job-1",
        "material_takeoff": "to-1",
        "source_quote": "sq-1",
        "supplier": "supplier-1",
        "prepared_at": "2026-07-10 10:00:00",
        "approved_by": "owner@example.com",
        "approved_at": "2026-07-10 11:00:00",
        "requested_delivery_date": "2026-07-15",
        "order_summary_json": '{"quote":"sq-1"}',
        "assumptions": "Confirmed selection.",
        "exclusions": "Freight variance.",
        "delivery_notes": "Call before delivery.",
        "items": [
            {
                "category": "Roof Surface",
                "item_name": "Panel",
                "quantity": "10",
                "unit": "each",
                "source_ref": "takeoff:1",
                "status": "Draft",
                "received_qty": "0",
                "shortage_qty": "0",
                "substitution_notes": "",
                "needs_review": 1,
            },
            {
                "category": "Trim",
                "item_name": "Flashing",
                "quantity": "5",
                "unit": "each",
                "source_ref": "takeoff:2",
                "status": "Draft",
                "received_qty": "0",
                "shortage_qty": "0",
                "substitution_notes": "",
                "needs_review": 1,
            },
        ],
    }
    record.update(overrides)
    return record


def current_crew_authority(**overrides: object) -> dict[str, object]:
    crew: dict[str, object] = {
        "name": "crew-1",
        "crew_profile_id": "crew-1",
        "status": "Active",
        "crew_type": "Subcontractor",
        "competency_status": "Current",
        "competency_checked_at": "2026-07-01 08:00:00",
        "competency_expiry": "2026-12-31",
        "equipment_status": "Safe",
        "equipment_checked_at": "2026-07-01 08:00:00",
        "equipment_expiry": "2026-12-31",
        "wcb_status": "Current",
        "wcb_checked_at": "2026-07-01 08:00:00",
        "wcb_expiry": "2026-12-31",
        "active_stop": 0,
    }
    crew.update(overrides)
    return crew


def current_compliance_authority(gate: str, **overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": f"compliance:{gate.lower()}:1",
        "compliance_record_id": f"compliance:{gate.lower()}:1",
        "roof_job": "job-1",
        "required_before_gate": gate,
        "status": "Approved",
        "effective_date": "2026-07-01",
        "expiry_date": "2026-12-31",
    }
    record.update(overrides)
    return record


class DomainPolicyTests(unittest.TestCase):
    def assert_policy(self, code: str, function, *args, **kwargs) -> PolicyViolation:
        with self.assertRaises(PolicyViolation) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_json_contracts_are_strict(self) -> None:
        self.assert_policy(
            "invalid_json", parse_json_field, {"payload": '{"a":1,"a":2}'}, "payload"
        )
        self.assert_policy(
            "invalid_json_shape", parse_json_field, {"payload": "42"}, "payload"
        )
        self.assert_policy(
            "invalid_json", parse_json_field, {"payload": '{"value":NaN}'}, "payload"
        )
        self.assert_policy(
            "json_too_large",
            parse_json_field,
            {"payload": '"' + ("x" * 1_000_001) + '"'},
            "payload",
        )

    def test_identity_is_required_and_immutable(self) -> None:
        self.assert_policy("required_fields", validate_record, "lead_envelope", {})
        self.assert_policy(
            "unknown_record_kind", validate_record, "unknown", {"id": "x"}
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "lead_envelope",
            {"envelope_id": "lead-2"},
            previous={"envelope_id": "lead-1"},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "evidence_item",
            {"evidence_id": "ev-1", "r2_key": "raw/new"},
            previous={"evidence_id": "ev-1", "r2_key": "raw/original"},
        )

    def test_jobnimbus_ids_are_late_bound_once_then_immutable(self) -> None:
        lead_before = {
            "envelope_id": "lead-1",
            "jobnimbus_contact_id": "",
            "jobnimbus_job_id": None,
        }
        lead_bound = {
            **lead_before,
            "jobnimbus_contact_id": "jn-contact-1",
            "jobnimbus_job_id": "jn-job-1",
        }
        # Owned-first intake creates the envelope before JobNimbus responds.
        validate_record("lead_envelope", lead_bound, previous=lead_before)
        self.assert_policy(
            "write_once_field",
            validate_record,
            "lead_envelope",
            {**lead_bound, "jobnimbus_contact_id": "jn-contact-2"},
            previous=lead_bound,
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "lead_envelope",
            {**lead_bound, "jobnimbus_job_id": ""},
            previous=lead_bound,
        )

        roof_job_before = {
            "roof_job_id": "job-1",
            "jobnimbus_contact_id": "",
            "jobnimbus_job_id": "",
        }
        roof_job_bound = {
            **roof_job_before,
            "jobnimbus_contact_id": "jn-contact-1",
            "jobnimbus_job_id": "jn-job-1",
        }
        validate_record("roof_job", roof_job_bound, previous=roof_job_before)
        self.assert_policy(
            "write_once_field",
            validate_record,
            "roof_job",
            {**roof_job_bound, "jobnimbus_job_id": "jn-job-2"},
            previous=roof_job_bound,
        )

    def test_lead_envelope_triage_is_migration_safe_and_sticky_once_triaged(self) -> None:
        # Pre-triage documents have no triage fields. They remain valid as Unknown.
        legacy = {"envelope_id": "lead-legacy"}
        validate_record("lead_envelope", legacy)

        # A worker-created legacy envelope can subsequently be marked Untriaged.
        validate_record(
            "lead_envelope",
            {"envelope_id": "lead-legacy", "triage_status": "Untriaged"},
            previous=legacy,
        )

        triaged = {
            "envelope_id": "lead-1",
            "triage_status": "Triaged",
            "triaged_by": "sales@example.com",
            "triaged_at": "2026-07-10 12:00:00",
            "triage_summary": "Confirmed residential metal reroof request.",
        }
        validate_record("lead_envelope", triaged)
        validate_record(
            "lead_envelope",
            {**triaged, "triage_summary": "Customer requested a Friday call."},
            previous=triaged,
        )

        for triage_status in ("Unknown", "Untriaged"):
            with self.subTest(triage_status=triage_status):
                self.assert_policy(
                    "invalid_state_transition",
                    validate_record,
                    "lead_envelope",
                    {"envelope_id": "lead-1", "triage_status": triage_status},
                    previous=triaged,
                )

    def test_lead_envelope_triage_requires_complete_details_and_known_state(self) -> None:
        self.assert_policy(
            "invalid_triage_status",
            validate_record,
            "lead_envelope",
            {"envelope_id": "lead-1", "triage_status": "Queued"},
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "lead_envelope",
            {"envelope_id": "lead-1", "triage_status": "Triaged"},
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "lead_envelope",
            {
                "envelope_id": "lead-1",
                "triage_status": "Triaged",
                "triaged_by": "sales@example.com",
                "triaged_at": "2026-07-10 12:00:00",
                "triage_summary": "   ",
            },
        )
        for triage_status in ("Unknown", "Untriaged"):
            with self.subTest(triage_status=triage_status):
                self.assert_policy(
                    "stale_triage_details",
                    validate_record,
                    "lead_envelope",
                    {
                        "envelope_id": "lead-1",
                        "triage_status": triage_status,
                        "triage_summary": "Needs a human check.",
                    },
                )

    def test_estimate_review_and_approval_gate(self) -> None:
        approved = {
            "estimate_session_id": "est-1",
            "status": "Approved",
            "range_low": 10_000,
            "range_high": 15_000,
            "estimate_total": 12_500,
            "review_required": 0,
            "reviewed_by": "estimator@example.com",
            "reviewed_at": "2026-07-10 10:00:00",
            "review_notes": "Measurements and exclusions checked.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 10:05:00",
            "assumptions": "Standard access.",
            "exclusions": "Deck repairs excluded.",
            "selected_services_json": '[{"service":"metal-roof"}]',
        }
        validate_record("instant_estimate_session", approved)
        invalid = {**approved, "range_low": 20_000}
        self.assert_policy(
            "invalid_estimate_range",
            validate_record,
            "instant_estimate_session",
            invalid,
        )

    def test_measurement_and_takeoff_require_reviewed_evidence(self) -> None:
        measurement = {
            "measurement_id": "m-1",
            "review_status": "Approved",
            "roof_job": "job-1",
            "source_file": "report.xml",
            "approved_by": "estimator@example.com",
            "approved_at": "2026-07-10 10:00:00",
            "approval_note": "Compared with source XML.",
            "measurements": [
                {
                    "metric": "area",
                    "value": 2400,
                    "unit": "sqft",
                    "source_ref": "xml:/area",
                }
            ],
        }
        validate_record("measurement_report", measurement)
        self.assert_policy(
            "unresolved_review",
            validate_record,
            "measurement_report",
            {
                **measurement,
                "measurements": [{**measurement["measurements"][0], "needs_review": 1}],
            },
        )

        takeoff = {
            "takeoff_id": "to-1",
            "status": "Approved",
            "roof_job": "job-1",
            "measurement_report": "m-1",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 11:00:00",
            "approval_note": "Waste and quantities checked.",
            "assumptions": "Full sheets.",
            "exclusions": "Special-order trim.",
            "source_measurements_json": '{"measurement":"m-1"}',
            "items": [{"quantity": 20, "needs_review": 0}],
        }
        validate_record(
            "material_takeoff", takeoff, context={"measurement_status": "Approved"}
        )
        self.assert_policy(
            "unapproved_measurement",
            validate_record,
            "material_takeoff",
            takeoff,
            context={"measurement_status": "Needs Review"},
        )

    def test_roof_graph_is_bound_to_measurement_evidence(self) -> None:
        revision = "a" * 64
        roof_graph = {
            "schema_version": "roof_graph/v1",
            "revision": revision,
            "source": {
                "raw_key": "measurements/job-1/source.xml",
                "raw_sha256": revision,
                "provider": "AppliCad",
                "ingested_at": "2026-07-18T12:00:00.000Z",
                "capture": {"captured_at": None, "provenance": "not_supplied"},
            },
            "coordinate_system": {
                "kind": "local_3d",
                "crs": None,
                "transform": None,
                "provenance": "not_declared_by_source",
            },
            "points": [],
            "edges": [],
            "facets": [],
            "checks": [],
            "needs_review": True,
            "measurements": {},
            "source_refs": {},
        }
        record = {
            "measurement_id": "m-graph-1",
            "review_status": "Parsed",
            "provider": "AppliCad",
            "raw_key": "measurements/job-1/source.xml",
            "roof_graph_revision": revision,
            "roof_graph_json": json.dumps(roof_graph),
        }
        validate_record("measurement_report", record)
        self.assert_policy(
            "roof_graph_source_mismatch",
            validate_record,
            "measurement_report",
            {
                **record,
                "roof_graph_json": json.dumps(
                    {**roof_graph, "source": {**roof_graph["source"], "provider": "Other"}}
                ),
            },
        )

    def test_supplier_quote_and_order_require_approved_upstream_records(self) -> None:
        quote = {
            "supplier_quote_id": "sq-1",
            "status": "Approved",
            "roof_job": "job-1",
            "material_takeoff": "to-1",
            "supplier": "supplier-1",
            "valid_until": "2026-08-01",
            "assumptions": "Stock confirmed.",
            "exclusions": "Freight variance.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 11:00:00",
            "quote_total": 8500,
            "quote_summary_json": '{"supplier":"supplier-1"}',
            "items": [{"quantity": 20, "unit_price": 400, "line_total": 8000}],
        }
        validate_record("supplier_quote", quote, context={"takeoff_status": "Approved"})

        review = supplier_order_record("Needs Review")
        order = {
            **review,
            "status": "Approved",
            "items": [{**row, "needs_review": 0} for row in review["items"]],
        }
        context = supplier_order_context()
        validate_record("supplier_order", order, previous=review, context=context)
        self.assert_policy(
            "unapproved_supplier_quote",
            validate_record,
            "supplier_order",
            order,
            previous=review,
            context={**context, "supplier_quote_status": "Draft"},
        )

    def test_supplier_order_lifecycle_is_explicit_and_freezes_approved_facts(self) -> None:
        draft = supplier_order_record("Draft")
        review = {**draft, "status": "Needs Review"}
        approved = {
            **review,
            "status": "Approved",
            "items": [{**row, "needs_review": 0} for row in review["items"]],
        }
        validate_record("supplier_order", draft, context=supplier_order_context())
        validate_record(
            "supplier_order", review, previous=draft, context=supplier_order_context()
        )
        validate_record(
            "supplier_order",
            approved,
            previous=review,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "supplier_order",
            {**approved, "status": "Received"},
            previous=approved,
            context=supplier_order_context(),
        )

        transmitted = {
            **approved,
            "status": "Ordered",
            "internal_transmission_id": "transmission:so-1",
            "internal_transmitted_at": "2026-07-10 12:00:00",
        }
        validate_record(
            "supplier_order",
            transmitted,
            previous=approved,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "supplier_order_items_immutable",
            validate_record,
            "supplier_order",
            {
                **transmitted,
                "items": [
                    {**transmitted["items"][0], "quantity": "11"},
                    *transmitted["items"][1:],
                ],
            },
            previous=transmitted,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "supplier_order",
            {**transmitted, "source_quote": "sq-other"},
            previous=transmitted,
            context=supplier_order_context(),
        )

    def test_supplier_order_lifecycle_facts_require_their_transition_state(self) -> None:
        draft = supplier_order_record("Draft")
        review = {**draft, "status": "Needs Review"}
        approved = {
            **review,
            "status": "Approved",
            "items": [{**row, "needs_review": 0} for row in review["items"]],
        }
        context = supplier_order_context()
        pre_transmission_states = (
            (draft, None),
            (review, draft),
            (approved, review),
        )
        for record, previous in pre_transmission_states:
            for field, value in (
                ("internal_transmission_id", "transmission:so-1"),
                ("internal_transmitted_at", "2026-07-10 12:00:00"),
            ):
                with self.subTest(status=record["status"], field=field):
                    self.assert_policy(
                        "supplier_order_transmission_before_ordered",
                        validate_record,
                        "supplier_order",
                        {**record, field: value},
                        previous=previous,
                        context=context,
                    )

        transmitted = {
            **approved,
            "status": "Ordered",
            "internal_transmission_id": "transmission:so-1",
            "internal_transmitted_at": "2026-07-10 12:00:00",
        }
        cancelled = {**transmitted, "status": "Cancelled"}
        validate_record("supplier_order", transmitted, previous=approved, context=context)
        validate_record("supplier_order", cancelled, previous=transmitted, context=context)

        for record, previous in (
            (draft, None),
            (review, draft),
            (approved, review),
            (transmitted, approved),
            (cancelled, transmitted),
        ):
            for field, value in (
                ("received_at", "2026-07-11 08:00:00"),
                ("receipt_evidence_json", '{"evidence_item_ids":["evidence:materials-1"]}'),
            ):
                with self.subTest(status=record["status"], field=field):
                    self.assert_policy(
                        "supplier_order_receipt_facts_before_receiving",
                        validate_record,
                        "supplier_order",
                        {**record, field: value},
                        previous=previous,
                        context=context,
                    )

    def test_supplier_order_acknowledgement_and_receipts_are_evidence_backed(self) -> None:
        approved = supplier_order_record(
            "Approved",
            items=[
                {**row, "needs_review": 0}
                for row in supplier_order_record()["items"]
            ],
        )
        transmitted = {
            **approved,
            "status": "Ordered",
            "internal_transmission_id": "transmission:so-1",
            "internal_transmitted_at": "2026-07-10 12:00:00",
        }
        acknowledged = {
            **transmitted,
            "supplier_acknowledgement_id": "ack:so-1",
            "supplier_acknowledged_at": "2026-07-10 12:05:00",
            "supplier_acknowledgement_evidence": "evidence:materials-1",
        }
        validate_record(
            "supplier_order",
            acknowledged,
            previous=transmitted,
            context=supplier_order_context(),
        )
        validate_record(
            "supplier_order",
            acknowledged,
            previous=acknowledged,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "supplier_order",
            {**acknowledged, "supplier_acknowledgement_id": "ack:other"},
            previous=acknowledged,
            context=supplier_order_context(),
        )

        partial = {
            **acknowledged,
            "status": "Partially Received",
            "received_at": "2026-07-11 08:00:00",
            "receipt_evidence_json": '{"evidence_item_ids":["evidence:materials-2"]}',
            "items": [
                {**acknowledged["items"][0], "status": "Ordered", "received_qty": "5"},
                {**acknowledged["items"][1], "status": "Ordered"},
            ],
        }
        validate_record(
            "supplier_order",
            partial,
            previous=acknowledged,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "supplier_order",
            {**partial, "status": "Cancelled"},
            previous=partial,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "supplier_order_evidence_missing",
            validate_record,
            "supplier_order",
            partial,
            previous=acknowledged,
            context=supplier_order_context(supplier_order_evidence={}),
        )
        self.assert_policy(
            "supplier_order_receipt_evidence_not_append_only",
            validate_record,
            "supplier_order",
            {
                **partial,
                "receipt_evidence_json": '{"evidence_item_ids":["evidence:materials-1"]}',
            },
            previous=partial,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "supplier_order_quantity_overage",
            validate_record,
            "supplier_order",
            {
                **partial,
                "items": [
                    {**partial["items"][0], "received_qty": "11"},
                    partial["items"][1],
                ],
            },
            previous=partial,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "supplier_order_received_quantity_mismatch",
            validate_record,
            "supplier_order",
            {**partial, "status": "Received"},
            previous=partial,
            context=supplier_order_context(),
        )

        shortage = {
            **partial,
            "status": "Shortage",
            "items": [
                {**partial["items"][0], "status": "Received", "received_qty": "10"},
                {**partial["items"][1], "status": "Shortage", "shortage_qty": "5"},
            ],
        }
        validate_record(
            "supplier_order",
            shortage,
            previous=partial,
            context=supplier_order_context(),
        )
        self.assert_policy(
            "supplier_order_receipts_finalized",
            validate_record,
            "supplier_order",
            {
                **shortage,
                "items": [
                    {**shortage["items"][0], "received_qty": "9"},
                    shortage["items"][1],
                ],
            },
            previous=shortage,
            context=supplier_order_context(),
        )

    def test_customer_quote_revision_is_minimal_and_cannot_replace_a_contract(self) -> None:
        prior = {
            "name": "cq-1",
            "customer_quote_id": "cq-1",
            "roof_job": "job-1",
            "customer": "customer-1",
            "quote_version": 1,
            "status": "Approved",
        }
        revision = {
            "customer_quote_id": "cq-2",
            "roof_job": "job-1",
            "customer": "customer-1",
            "quote_version": 2,
            "status": "Draft",
            "supersedes": "cq-1",
            "correction_reason": "Measurement and supplier inputs require a fresh review.",
        }
        validate_record("customer_quote", revision, context={"superseded_record": prior})

        self.assert_policy(
            "cross_customer_correction",
            validate_record,
            "customer_quote",
            {**revision, "customer": "customer-2"},
            context={"superseded_record": prior},
        )
        self.assert_policy(
            "stale_version",
            validate_record,
            "customer_quote",
            {**revision, "quote_version": 1},
            context={"superseded_record": prior},
        )
        self.assert_policy(
            "accepted_quote_revision_requires_change_order",
            validate_record,
            "customer_quote",
            revision,
            context={"superseded_record": {**prior, "status": "Accepted"}},
        )
        self.assert_policy(
            "accepted_quote_revision_requires_change_order",
            validate_record,
            "customer_quote",
            revision,
            context={"superseded_record": {**prior, "contract_acceptance": "accept-1"}},
        )

    def test_quote_proposal_and_closeout_evidence_chain(self) -> None:
        customer_quote = {
            "customer_quote_id": "cq-1",
            "status": "Accepted",
            "roof_job": "job-1",
            "customer": "customer-1",
            "quote_version": 1,
            "price_book_version": "retail-2026-07",
            "pricing_effective_at": "2026-07-10 11:30:00",
            "price_rule_snapshot_json": price_rule_snapshot(),
            "subtotal": 23_809.52,
            "tax_amount": 1_190.48,
            "tax_code": "GST",
            "tax_rate": 5,
            "tax_policy_snapshot_json": '{"country":"CA","province":"AB","rate":5}',
            "quote_total": 25_000,
            "currency": "CAD",
            "deposit_amount": 5_000,
            "amount_due": 25_000,
            "amount_paid": 0,
            "balance_due": 25_000,
            "payment_status": "Deposit Due",
            "payment_truth_source": "IronWrap Quote",
            "payment_truth_at": "2026-07-10 12:00:00",
            "scope_summary": "Standing-seam replacement.",
            "assumptions": "Clear driveway.",
            "exclusions": "Structural repairs.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 12:00:00",
            "quote_summary_json": '{"total":25000}',
            "acceptance_evidence": "ev-signed",
            "contract_acceptance": "accept-1",
            "accepted_at": "2026-07-10 12:30:00",
        }
        validate_record(
            "customer_quote",
            customer_quote,
            previous={**customer_quote, "status": "Approved"},
            context=price_rule_snapshot_context(),
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "customer_quote",
            {key: value for key, value in customer_quote.items() if key != "price_rule_snapshot_json"},
            context=price_rule_snapshot_context(),
        )

        draft_quote = {
            "customer_quote_id": "cq-1",
            "roof_job": "job-1",
            "customer": "customer-1",
            "quote_version": 1,
            "status": "Draft",
            "price_book_version": "retail-2026-07",
            "pricing_effective_at": "2026-07-10 11:30:00",
            "price_rule_snapshot_json": price_rule_snapshot(),
        }
        validate_record(
            "customer_quote", draft_quote, context=price_rule_snapshot_context()
        )
        altered_snapshot = json.loads(price_rule_snapshot())
        altered_snapshot["rules"][0]["unit_price"] = "99.00"
        self.assert_policy(
            "price_rule_snapshot_source_mismatch",
            validate_record,
            "customer_quote",
            {**draft_quote, "price_rule_snapshot_json": json.dumps(altered_snapshot)},
            context=price_rule_snapshot_context(),
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "customer_quote",
            {**draft_quote, "price_rule_snapshot_json": json.dumps(altered_snapshot)},
            previous=draft_quote,
            context=price_rule_snapshot_context(),
        )

        proposal = {
            "pack_id": "proposal:cq-1",
            "status": "Draft",
            "roof_job": "job-1",
            "quotation": "cq-1",
            "assumptions": "Clear driveway.",
            "exclusions": "Structural repairs.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 12:00:00",
            "evidence_summary_json": proposal_evidence_summary(),
            "signed_evidence": "ev-signed",
            "signed_at": "2026-07-10 12:30:00",
        }
        validate_record(
            "proposal_evidence_pack",
            proposal,
            context=proposal_context(quote_status="Accepted"),
        )
        self.assert_policy(
            "proposal_pack_draft_only",
            validate_record,
            "proposal_evidence_pack",
            {**proposal, "status": "Signed"},
            context=proposal_context(quote_status="Accepted"),
        )

    def test_proposal_evidence_pack_anchor_is_required_verified_and_immutable_from_draft(self) -> None:
        draft = {
            "pack_id": "proposal:cq-1",
            "status": "Draft",
            "roof_job": "job-1",
            "quotation": "cq-1",
            "evidence_summary_json": proposal_evidence_summary(),
        }
        context = proposal_context()
        validate_record("proposal_evidence_pack", draft, context=context)

        self.assert_policy(
            "required_fields",
            validate_record,
            "proposal_evidence_pack",
            {key: value for key, value in draft.items() if key != "roof_job"},
            context=context,
        )
        self.assert_policy(
            "proposal_pack_id_mismatch",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "pack_id": "proposal:other"},
            context=context,
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "proposal_evidence_pack",
            {key: value for key, value in draft.items() if key != "quotation"},
            context=context,
        )
        self.assert_policy(
            "empty_json_contract",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "evidence_summary_json": "{}"},
            context=context,
        )
        unsafe_summary = json.loads(proposal_evidence_summary())
        unsafe_summary["eligible_evidence"][0]["source_uri"] = "r2://private/job-1/raw.jpg"
        self.assert_policy(
            "invalid_proposal_evidence_summary",
            validate_record,
            "proposal_evidence_pack",
            {
                **draft,
                "evidence_summary_json": json.dumps(unsafe_summary),
            },
            context=context,
        )
        self.assert_policy(
            "proposal_customer_message_forbidden",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "customer_message": "A customer-facing draft must stay in the approved path."},
            context=context,
        )
        synthetic_summary = json.loads(proposal_evidence_summary())
        synthetic_summary["eligible_evidence"][0]["evidence_id"] = "synthetic-evidence"
        self.assert_policy(
            "unverified_proposal_evidence",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "evidence_summary_json": json.dumps(synthetic_summary)},
            context=context,
        )
        self.assert_policy(
            "proposal_pack_draft_only",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "status": "Ready"},
            context=context,
        )
        self.assert_policy(
            "unapproved_quote",
            validate_record,
            "proposal_evidence_pack",
            draft,
            context=proposal_context(quote_status="Draft"),
        )
        self.assert_policy(
            "unverified_proposal_quote",
            validate_record,
            "proposal_evidence_pack",
            draft,
            context=proposal_context(quote_roof_job=None),
        )
        self.assert_policy(
            "cross_job_proposal_quote",
            validate_record,
            "proposal_evidence_pack",
            draft,
            context=proposal_context(quote_status="Accepted", quote_roof_job="job-other"),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "quotation": "cq-2"},
            previous=draft,
            context=proposal_context(),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "proposal_evidence_pack",
            {**draft, "roof_job": "job-2"},
            previous=draft,
            context=proposal_context(quote_roof_job="job-2"),
        )

    def test_proposal_publication_requires_exact_private_context(self) -> None:
        draft = {
            "name": "proposal:cq-1",
            "pack_id": "proposal:cq-1",
            "status": "Draft",
            "roof_job": "job-1",
            "quotation": "cq-1",
            "evidence_summary_json": proposal_evidence_summary(),
        }
        published = {
            **draft,
            "status": "Approved",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-17 10:00:00",
        }
        self.assert_policy(
            "proposal_pack_draft_only",
            validate_record,
            "proposal_evidence_pack",
            published,
            previous=draft,
            context=proposal_context(),
        )
        publication = {
            "proposal_evidence_pack_id": "proposal:cq-1",
            "hermes_run_id": "run-proposal-publication-0001",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-17 10:00:00",
        }
        validate_record(
            "proposal_evidence_pack",
            published,
            previous=draft,
            context=proposal_context(proposal_publication=publication),
        )
        self.assert_policy(
            "proposal_pack_draft_only",
            validate_record,
            "proposal_evidence_pack",
            published,
            previous=draft,
            context=proposal_context(
                proposal_publication={**publication, "approved_by": "other@example.com"}
            ),
        )

        completion = {
            "completion_packet_id": "cp-1",
            "status": "Approved",
            "roof_job": "job-1",
            "customer_signoff_ref": "signoff-1",
            "completion_evidence": "ev-complete",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-15 16:00:00",
            "photo_evidence_json": '["ev-photo-1"]',
            "evidence_summary_json": '{"completion":"ev-complete"}',
            "warranty_ready": 1,
            "deficiencies_resolved": 1,
        }
        validate_record("completion_packet", completion)
        self.assert_policy(
            "open_deficiencies",
            validate_record,
            "completion_packet",
            {**completion, "deficiencies_resolved": 0},
        )

        warranty = {
            "warranty_packet_id": "wp-1",
            "status": "Issued",
            "roof_job": "job-1",
            "completion_packet": "cp-1",
            "material_system": "24ga standing seam",
            "warranty_terms": "40-year material / 10-year workmanship.",
            "coverage_start": "2026-07-15",
            "coverage_years": 10,
            "exclusions": "Storm damage.",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-15 17:00:00",
            "evidence_summary_json": '{"packet":"wp-1"}',
            "issued_at": "2026-07-15 17:10:00",
            "issued_evidence": "ev-warranty",
        }
        validate_record(
            "warranty_packet", warranty, context={"completion_status": "Approved"}
        )

    def test_production_and_closeout_gates_fail_closed(self) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Ready",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "due_at": "2026-07-11 08:00:00",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        gate_evidence = gate_evidence_context(gates)
        validate_record(
            "roof_job",
            {
                "roof_job_id": "job-1",
                "job_status": "In Production",
                "workflow_profile": "Residential Retail",
                "locale_policy_version": "ca-ab-2026-01",
                "locale_policy_snapshot_json": '{"country":"CA","province":"AB"}',
            },
            context={"gates": gates, "gate_evidence": gate_evidence},
        )
        self.assert_policy(
            "production_gate_block",
            validate_record,
            "roof_job",
            {
                "roof_job_id": "job-1",
                "job_status": "In Production",
                "workflow_profile": "Residential Retail",
                "locale_policy_version": "ca-ab-2026-01",
                "locale_policy_snapshot_json": '{"country":"CA","province":"AB"}',
            },
            context={"gates": gates[:-1], "gate_evidence": gate_evidence},
        )

        closed_gates = [{**gate, "state": "Done"} for gate in gates]
        closed_gates.append(
            {
                "roof_job": "job-1",
                "gate": "Completion",
                "state": "Done",
                "evidence_item": "ev-complete",
                "owner_user": "closeout@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
        )
        closeout_context = {
            "gates": closed_gates,
            "gate_evidence": gate_evidence_context(closed_gates),
            "completion_packets": [{"status": "Approved"}],
            "warranty_packets": [{"status": "Issued"}],
            "payment_milestones": [{"status": "Matched"}],
        }
        validate_record(
            "roof_job",
            {
                "roof_job_id": "job-1",
                "job_status": "Closed",
                "workflow_profile": "Residential Retail",
                "locale_policy_version": "ca-ab-2026-01",
                "locale_policy_snapshot_json": '{"country":"CA","province":"AB"}',
            },
            context=closeout_context,
        )

    def test_scheduled_production_assignment_requires_current_non_closeout_gates(self) -> None:
        def gate(gate_name: str, state: str) -> dict[str, str]:
            result = {
                "roof_job": "job-1",
                "gate": gate_name,
                "state": state,
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            if state == "Ready":
                result.update(
                    due_at="2026-07-11 08:00:00",
                    evidence_item=f"ev-{gate_name.lower()}",
                )
            elif state == "Done":
                result.update(evidence_item=f"ev-{gate_name.lower()}")
            elif state == "Waived":
                result.update(
                    waived_by="owner@example.com",
                    waived_at="2026-07-10 07:30:00",
                    waiver_reason="Owner-approved exception.",
                )
            else:
                result.update(
                    due_at="2026-07-11 08:00:00",
                    blocker_reason="Waiting for source evidence.",
                )
            return result

        gates = [
            gate("Deposit", "Ready"),
            gate("Materials", "Done"),
            gate("Safety", "Waived"),
            gate("Access", "Ready"),
            gate("Weather", "Done"),
            gate("Crew", "Ready"),
        ]
        gate_evidence = gate_evidence_context(gates)
        assignment = {
            "assignment_id": "assignment-production-1",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "crew_profile": "crew-1",
            "assigned_by": "production@example.com",
            "assigned_at": "2026-07-10 08:00:00",
            "scheduled_start": "2026-07-11 08:00:00",
        }
        authority_context = {
            "scheduled_assignment_crew_profile": current_crew_authority(),
            "job_compliance_rows": [
                current_compliance_authority(gate)
                for gate in ("Crew", "Safety", "Access")
            ],
        }

        # Completion is intentionally not required to schedule production work.
        validate_record(
            "job_assignment",
            assignment,
            context={"gates": gates, "gate_evidence": gate_evidence, **authority_context},
        )

        self.assert_policy(
            "production_schedule_gate_block",
            validate_record,
            "job_assignment",
            assignment,
            context={"gates": gates[:-1], "gate_evidence": gate_evidence},
        )
        blocked = [
            gate("Safety", "Blocked") if row["gate"] == "Safety" else row
            for row in gates
        ]
        self.assert_policy(
            "production_schedule_gate_block",
            validate_record,
            "job_assignment",
            assignment,
            context={"gates": blocked, "gate_evidence": gate_evidence},
        )
        self.assert_policy(
            "ambiguous_gate",
            validate_record,
            "job_assignment",
            assignment,
            context={"gates": [*gates, gate("Safety", "Done")], "gate_evidence": gate_evidence},
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "job_assignment",
            assignment,
            context={
                "gates": [
                    {key: value for key, value in row.items() if key != "evidence_item"}
                    if row["gate"] == "Deposit"
                    else row
                    for row in gates
                ],
                "gate_evidence": gate_evidence,
            },
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "job_assignment",
            assignment,
            context={
                "gates": [
                    {key: value for key, value in row.items() if key != "waiver_reason"}
                    if row["gate"] == "Safety"
                    else row
                    for row in gates
                ],
                "gate_evidence": gate_evidence,
            },
        )

        validate_record(
            "job_assignment",
            {**assignment, "assignment_id": "assignment-production-unscheduled", "scheduled_start": ""},
        )
        validate_record(
            "job_assignment",
            {
                **assignment,
                "assignment_id": "assignment-inspection-scheduled",
                "assignment_type": "Inspection",
            },
        )
        self.assert_policy(
            "scheduled_end_requires_start",
            validate_record,
            "job_assignment",
            {
                **assignment,
                "assignment_id": "assignment-orphaned-end",
                "scheduled_start": "",
                "scheduled_end": "2026-07-11 16:00:00",
            },
        )
        self.assert_policy(
            "invalid_assignment_window",
            validate_record,
            "job_assignment",
            {
                **assignment,
                "assignment_id": "assignment-zero-window",
                "scheduled_end": assignment["scheduled_start"],
            },
            context={"gates": gates, "gate_evidence": gate_evidence},
        )

        safety_gate = {
            "gate_id": "gate-safety-1",
            "roof_job": "job-1",
            **gate("Safety", "Ready"),
        }
        validate_record(
            "production_gate_state",
            safety_gate,
            context={"gate_evidence": gate_evidence_context([safety_gate])},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "production_gate_state",
            {**safety_gate, "roof_job": "job-2"},
            previous=safety_gate,
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "production_gate_state",
            {**safety_gate, "gate": "Weather"},
            previous=safety_gate,
        )

    def test_scheduled_production_assignment_enforces_current_assignment_and_material_fences(
        self,
    ) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Waived",
                "owner_user": "owner@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                "waived_by": "owner@example.com",
                "waived_at": "2026-07-10 08:00:00",
                "waiver_reason": "Owner-approved exception.",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        current = {
            "name": "assignment:current",
            "assignment_id": "assignment:current",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "scheduled_start": "2026-07-11 08:00:00",
        }
        assignment = {
            "assignment_id": "assignment:next",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "crew_profile": "crew-2",
            "assigned_by": "production@example.com",
            "assigned_at": "2026-07-10 08:00:00",
            "scheduled_start": "2026-07-12 08:00:00",
        }
        context = {
            "gates": gates,
            "gate_evidence": {},
            "job_assignment_rows": [current],
            "supplier_order_exception_rows": [],
            "scheduled_assignment_crew_profile": current_crew_authority(
                name="crew-2", crew_profile_id="crew-2"
            ),
            "job_compliance_rows": [
                current_compliance_authority(gate)
                for gate in ("Crew", "Safety", "Access")
            ],
        }

        self.assert_policy(
            "duplicate_current_production_assignment",
            validate_record,
            "job_assignment",
            assignment,
            context=context,
        )

        correction = {
            **assignment,
            "assignment_id": "assignment:correction",
            "supersedes": "assignment:current",
            "correction_reason": "Move the crew after access changed.",
        }
        validate_record(
            "job_assignment",
            correction,
            context={**context, "superseded_record": current},
        )

        self.assert_policy(
            "stale_production_assignment_correction",
            validate_record,
            "job_assignment",
            {**correction, "assignment_id": "assignment:second-correction"},
            context={
                **context,
                "job_assignment_rows": [current, {**correction, "name": "assignment:correction"}],
                "superseded_record": current,
            },
        )
        for status in ("Needs Review", "Shortage"):
            self.assert_policy(
                "material_exception_blocks_production_schedule",
                validate_record,
                "job_assignment",
                {**assignment, "assignment_id": f"assignment:{status.lower()}"},
                context={
                    **context,
                    "job_assignment_rows": [],
                    "supplier_order_exception_rows": [
                        {"name": "supplier-order-1", "roof_job": "job-1", "status": status}
                    ],
                },
            )

    def test_work_package_release_requires_current_controls_and_preserves_issued_content(
        self,
    ) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate_name,
                "state": "Done",
                "evidence_item": f"ev-{gate_name.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate_name in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
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
        released = {
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
                },
                {
                    "sequence": 2,
                    "instruction": "Install panels to the approved layout.",
                    "required_evidence": "Progress photo set.",
                    "acceptance_criteria": "Panel alignment and fastening meet the released detail.",
                },
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

        def release_context(**overrides: object) -> dict[str, object]:
            context: dict[str, object] = {
                "now": "2026-07-10 10:00:00",
                "gates": gates,
                "gate_evidence": gate_evidence_context(gates),
                "job_assignment_rows": [assignment],
                "work_package_assignment": assignment,
                "work_package_crew_profile": current_crew_authority(),
                "job_compliance_rows": [
                    current_compliance_authority(gate)
                    for gate in ("Crew", "Safety", "Access")
                ],
                "safety_plan_rows": [safety_plan],
                "work_package_safety_plan": safety_plan,
                "work_package_rows": [],
            }
            context.update(overrides)
            return context

        validate_record("work_package", released, context=release_context())
        self.assert_policy(
            "work_package_production_gate_block",
            validate_record,
            "work_package",
            released,
            context=release_context(gates=gates[:-1]),
        )
        self.assert_policy(
            "stale_work_package_safety_plan",
            validate_record,
            "work_package",
            released,
            context=release_context(
                safety_plan_rows=[
                    safety_plan,
                    {
                        "safety_plan_id": "safety:job-1:v2",
                        "supersedes": safety_plan["safety_plan_id"],
                    },
                ]
            ),
        )
        self.assert_policy(
            "stale_work_package",
            validate_record,
            "work_package",
            released,
            context=release_context(
                work_package_rows=[
                    {
                        "work_package_id": "work-package:job-1:v2",
                        "supersedes": released["work_package_id"],
                    }
                ]
            ),
        )
        self.assert_policy(
            "inactive_work_package_assignment",
            validate_record,
            "work_package",
            released,
            context=release_context(
                work_package_assignment={**assignment, "status": "Blocked"}
            ),
        )
        self.assert_policy(
            "invalid_work_package_version",
            validate_record,
            "work_package",
            {**released, "version": 0},
            context=release_context(),
        )
        self.assert_policy(
            "expired_work_package",
            validate_record,
            "work_package",
            released,
            context=release_context(now="2026-07-11 08:00:00"),
        )
        self.assert_policy(
            "invalid_work_package_sequence",
            validate_record,
            "work_package",
            {
                **released,
                "steps": [{**released["steps"][0], "sequence": 2}],
            },
            context=release_context(),
        )

        acknowledged = {
            **released,
            "status": "Acknowledged",
            "acknowledged_by": "lead@example.com",
            "acknowledged_at": "2026-07-10 10:15:00",
            "acknowledgement_device_action_id": "fem_ack_0123456789",
        }
        validate_record(
            "work_package",
            acknowledged,
            previous=released,
            context=release_context(),
        )
        blocked = {
            **acknowledged,
            "status": "Blocked",
            "blocked_by": "lead@example.com",
            "blocked_at": "2026-07-10 10:30:00",
            "blocked_device_action_id": "fem_stop_0123456789",
            "blocker_reason": "Wind exceeds the released limit.",
        }
        validate_record(
            "work_package",
            blocked,
            previous=acknowledged,
            context=release_context(),
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "work_package",
            {**blocked, "status": "In Progress", "started_at": "2026-07-10 10:45:00"},
            previous=blocked,
            context=release_context(),
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "work_package",
            {**released, "objective": "Rewritten after release."},
            previous=released,
            context=release_context(),
        )

        revision = {
            **released,
            "work_package_id": "work-package:job-1:v2",
            "version": 2,
            "supersedes": released["work_package_id"],
            "correction_reason": "Changed condition requires a new package.",
        }
        validate_record(
            "work_package",
            revision,
            context=release_context(superseded_record=released),
        )
        validate_record(
            "work_package",
            {**released, "status": "Superseded"},
            previous=released,
            context={"superseding_work_package": revision},
        )

    def test_crew_authority_blocks_scheduled_and_released_production(self) -> None:
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
        crew = current_crew_authority()
        compliance_rows = [
            current_compliance_authority(gate) for gate in ("Crew", "Safety", "Access")
        ]
        assignment = {
            "name": "assignment:authority",
            "assignment_id": "assignment:authority",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "crew_profile": "crew-1",
            "assigned_by": "production@example.com",
            "assigned_at": "2026-07-10 08:00:00",
            "scheduled_start": "2026-07-11 08:00:00",
        }
        safety_plan = {
            "name": "safety:authority",
            "safety_plan_id": "safety:authority",
            "roof_job": "job-1",
            "version": 1,
            "status": "Acknowledged",
        }
        released = {
            "work_package_id": "work-package:authority",
            "roof_job": "job-1",
            "job_assignment": assignment["assignment_id"],
            "safety_plan": safety_plan["safety_plan_id"],
            "version": 1,
            "status": "Released",
            "title": "Authority-gated production work",
            "objective": "Perform only the released production scope.",
            "boundaries": "No work outside the released scope.",
            "prerequisites": "All production controls remain current.",
            "expected_result": "Released work is completed safely.",
            "stop_conditions": "Stop for unsafe conditions or authority loss.",
            "make_safe_procedure": "Secure the site and notify production.",
            "issued_at": "2026-07-10 08:00:00",
            "expires_at": "2026-07-12 08:00:00",
            "released_by": "production@example.com",
            "released_at": "2026-07-10 09:00:00",
            "steps": [
                {
                    "sequence": 1,
                    "instruction": "Confirm current authority before work.",
                    "required_evidence": "Field check-in.",
                    "acceptance_criteria": "Authority remains current.",
                }
            ],
            "hold_points": [
                {
                    "sequence": 1,
                    "hold_point": "Authority verification",
                    "release_authority": "IronWrap Production",
                    "required_evidence": "Current authority record.",
                    "acceptance_criteria": "Authority permits the work.",
                }
            ],
        }

        def scheduled_context(**overrides: object) -> dict[str, object]:
            context: dict[str, object] = {
                "gates": gates,
                "gate_evidence": gate_evidence_context(gates),
                "scheduled_assignment_crew_profile": crew,
                "job_compliance_rows": compliance_rows,
            }
            context.update(overrides)
            return context

        def release_context(**overrides: object) -> dict[str, object]:
            context: dict[str, object] = {
                "now": "2026-07-10 10:00:00",
                "gates": gates,
                "gate_evidence": gate_evidence_context(gates),
                "job_assignment_rows": [assignment],
                "work_package_assignment": assignment,
                "work_package_crew_profile": crew,
                "job_compliance_rows": compliance_rows,
                "safety_plan_rows": [safety_plan],
                "work_package_safety_plan": safety_plan,
                "work_package_rows": [],
            }
            context.update(overrides)
            return context

        def assert_authority_block(
            code: str,
            *,
            crew_profile: dict[str, object] | None = crew,
            authorities: list[dict[str, object]] = compliance_rows,
        ) -> None:
            self.assert_policy(
                code,
                validate_record,
                "job_assignment",
                assignment,
                context=scheduled_context(
                    scheduled_assignment_crew_profile=crew_profile,
                    job_compliance_rows=authorities,
                ),
            )
            self.assert_policy(
                code,
                validate_record,
                "work_package",
                released,
                context=release_context(
                    work_package_crew_profile=crew_profile,
                    job_compliance_rows=authorities,
                ),
            )

        validate_record("job_assignment", assignment, context=scheduled_context())
        validate_record("work_package", released, context=release_context())
        self.assert_policy(
            "production_assignment_requires_crew_profile",
            validate_record,
            "job_assignment",
            {**assignment, "crew_profile": "", "assigned_user": "lead@example.com"},
            context=scheduled_context(),
        )
        self.assert_policy(
            "work_package_crew_authority_required",
            validate_record,
            "work_package",
            released,
            context=release_context(
                work_package_assignment={**assignment, "crew_profile": ""}
            ),
        )
        assert_authority_block("unverified_assignment_crew_profile", crew_profile=None)

        for code, invalid_crew in (
            (
                "crew_competency_not_current",
                current_crew_authority(competency_status="Expired"),
            ),
            (
                "crew_competency_expired",
                current_crew_authority(competency_expiry="2026-07-09"),
            ),
            (
                "crew_wcb_not_current",
                current_crew_authority(wcb_status="Revoked"),
            ),
            ("crew_wcb_expired", current_crew_authority(wcb_expiry="2026-07-09")),
            ("unsafe_crew_equipment", current_crew_authority(equipment_status="Unsafe")),
            (
                "crew_equipment_inspection_expired",
                current_crew_authority(equipment_expiry="2026-07-09"),
            ),
            (
                "active_crew_stop",
                current_crew_authority(
                    active_stop=1,
                    active_stop_at="2026-07-10 07:00:00",
                    active_stop_reason="Weather stop remains active.",
                ),
            ),
        ):
            with self.subTest(crew_authority=code):
                assert_authority_block(code, crew_profile=invalid_crew)

        for gate in ("Crew", "Safety", "Access"):
            with self.subTest(missing_compliance_authority=gate):
                assert_authority_block(
                    "missing_compliance_authority",
                    authorities=[
                        row for row in compliance_rows if row["required_before_gate"] != gate
                    ],
                )
            with self.subTest(expired_compliance_authority=gate):
                assert_authority_block(
                    "expired_compliance_authority",
                    authorities=[
                        {**row, "expiry_date": "2026-07-09"}
                        if row["required_before_gate"] == gate
                        else row
                        for row in compliance_rows
                    ],
                )
            with self.subTest(not_yet_effective_compliance_authority=gate):
                assert_authority_block(
                    "compliance_authority_not_effective",
                    authorities=[
                        {**row, "effective_date": "2026-07-12"}
                        if row["required_before_gate"] == gate
                        else row
                        for row in compliance_rows
                    ],
                )
            with self.subTest(ambiguous_compliance_authority=gate):
                assert_authority_block(
                    "ambiguous_compliance_authority",
                    authorities=[
                        *compliance_rows,
                        current_compliance_authority(
                            gate,
                            name=f"compliance:{gate.lower()}:2",
                            compliance_record_id=f"compliance:{gate.lower()}:2",
                        ),
                    ],
                )

        waived_safety_gates = [
            {
                **gate,
                "state": "Waived",
                "waived_by": "owner@example.com",
                "waived_at": "2026-07-10 08:00:00",
                "waiver_reason": "Owner accepted the documented exception.",
            }
            if gate["gate"] == "Safety"
            else gate
            for gate in gates
        ]
        missing_safety_authority = [
            row for row in compliance_rows if row["required_before_gate"] != "Safety"
        ]
        self.assert_policy(
            "missing_compliance_authority",
            validate_record,
            "job_assignment",
            assignment,
            context=scheduled_context(
                gates=waived_safety_gates,
                gate_evidence=gate_evidence_context(waived_safety_gates),
                job_compliance_rows=missing_safety_authority,
            ),
        )
        self.assert_policy(
            "missing_compliance_authority",
            validate_record,
            "work_package",
            released,
            context=release_context(
                gates=waived_safety_gates,
                gate_evidence=gate_evidence_context(waived_safety_gates),
                job_compliance_rows=missing_safety_authority,
            ),
        )

    def test_ready_and_done_gates_require_verified_same_job_evidence(self) -> None:
        invalid_sources = (
            ("missing", None, "unverified_gate_evidence"),
            ("cross_job", verified_gate_evidence("job-2"), "cross_job_gate_evidence"),
            (
                "unverified",
                verified_gate_evidence(sync_state="Uploaded"),
                "unverified_gate_evidence",
            ),
            (
                "bad_checksum",
                verified_gate_evidence(content_checksum="not-a-sha256"),
                "invalid_sha256",
            ),
            (
                "wrong_algorithm",
                verified_gate_evidence(checksum_algorithm="SHA-1"),
                "unsupported_checksum",
            ),
            (
                "no_source_pointer",
                verified_gate_evidence(source_uri="", r2_key="", drive_file_id=""),
                "unverified_gate_evidence",
            ),
        )
        for state in ("Ready", "Done"):
            gate = {
                "gate_id": f"gate-safety-{state.lower()}",
                "roof_job": "job-1",
                "gate": "Safety",
                "state": state,
                "evidence_item": "ev-safety",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
                **({"due_at": "2026-07-11 08:00:00"} if state == "Ready" else {}),
            }
            with self.subTest(state=state, source="valid"):
                validate_record(
                    "production_gate_state",
                    gate,
                    context={"gate_evidence": {"ev-safety": verified_gate_evidence()}},
                )
            for label, source, code in invalid_sources:
                with self.subTest(state=state, source=label):
                    self.assert_policy(
                        code,
                        validate_record,
                        "production_gate_state",
                        gate,
                        context={
                            "gate_evidence": {} if source is None else {"ev-safety": source}
                        },
                    )

    def test_legacy_invalid_gate_evidence_blocks_scheduling_and_closeout(self) -> None:
        gates = [
            {
                "roof_job": "job-1",
                "gate": gate,
                "state": "Done",
                "evidence_item": f"ev-{gate.lower()}",
                "owner_user": "production@example.com",
                "assigned_at": "2026-07-10 08:00:00",
            }
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion")
        ]
        evidence = gate_evidence_context(gates)
        evidence["ev-safety"]["sync_state"] = "Uploaded"
        assignment = {
            "assignment_id": "assignment-legacy-evidence",
            "roof_job": "job-1",
            "assignment_type": "Production",
            "status": "Assigned",
            "crew_profile": "crew-1",
            "assigned_by": "production@example.com",
            "assigned_at": "2026-07-10 08:00:00",
            "scheduled_start": "2026-07-11 08:00:00",
        }
        self.assert_policy(
            "unverified_gate_evidence",
            validate_record,
            "job_assignment",
            assignment,
            context={"gates": gates[:-1], "gate_evidence": evidence},
        )
        self.assert_policy(
            "unverified_gate_evidence",
            validate_record,
            "roof_job",
            {
                "roof_job_id": "job-1",
                "job_status": "Closed",
                "workflow_profile": "Residential Retail",
                "locale_policy_version": "ca-ab-2026-01",
                "locale_policy_snapshot_json": '{"country":"CA","province":"AB"}',
            },
            context={
                "gates": gates,
                "gate_evidence": evidence,
                "completion_packets": [{"status": "Approved"}],
                "warranty_packets": [{"status": "Issued"}],
                "payment_milestones": [{"status": "Matched"}],
            },
        )

    def test_review_and_customer_communication_policy(self) -> None:
        review = {
            "review_request_id": "rr-1",
            "status": "Sent",
            "roof_job": "job-1",
            "completion_packet": "cp-1",
            "review_link": "https://example.test/review",
            "consent_basis": "Completed customer",
            "eligibility_checked_by": "closeout@example.com",
            "eligibility_checked_at": "2026-07-15 18:00:00",
            "quiet_hours_ok": 1,
            "stop_conditions_json": '{"clear":true}',
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-15 18:05:00",
            "sent_at": "2026-07-15 18:10:00",
        }
        validate_record(
            "review_request", review, context={"completion_status": "Approved"}
        )
        self.assert_policy(
            "review_stop_condition",
            validate_record,
            "review_request",
            {**review, "stop_conditions_json": "{}"},
            context={"completion_status": "Approved"},
        )

        communication = {
            "communication_event_id": "comm-1",
            "direction": "Outbound",
            "policy_result": "Allowed",
            "status": "Sent",
            "consent_basis": "Estimate follow-up consent",
            "policy_checked_by": "sales@example.com",
            "policy_checked_at": "2026-07-10 14:00:00",
            "quiet_hours_ok": 1,
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 14:01:00",
            "sent_at": "2026-07-10 14:02:00",
            "provider_message_id": "msg-1",
        }
        validate_record("communication_event", communication)
        self.assert_policy(
            "communication_blocked",
            validate_record,
            "communication_event",
            {
                **communication,
                "policy_result": "Blocked",
                "policy_reasons_json": '["no consent"]',
            },
        )

    def test_offline_evidence_and_field_checkin_truth(self) -> None:
        evidence = {
            "evidence_id": "ev-verified",
            "device_action_id": "device-action-1",
            "evidence_type": "Photo",
            "source_system": "IronWrap Field",
            "source_uri": "device://photo/1",
            "content_checksum": "a" * 64,
            "checksum_algorithm": "SHA-256",
            "content_type": "image/jpeg",
            "content_length": 2048,
            "capture_actor": "field@example.com",
            "captured_at": "2026-07-10 08:00:00",
            "proof_owner": "production@example.com",
            "proof_slot": "Production",
            "latitude": 51.0447,
            "longitude": -114.0719,
            "location_accuracy_m": 5,
            "sync_state": "Verified",
            "verified_at": "2026-07-10 08:01:00",
            "verification_source": "R2 receipt",
        }
        validate_record(
            "evidence_item",
            evidence,
            previous={**evidence, "sync_state": "Uploaded", "verified_at": None},
        )
        self.assert_policy(
            "invalid_location",
            validate_record,
            "evidence_item",
            {**evidence, "latitude": 100},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "evidence_item",
            {**evidence, "device_action_id": "device-action-2"},
            previous=evidence,
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "evidence_item",
            {**evidence, "verification_source": "forged source"},
            previous=evidence,
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "evidence_item",
            {**evidence, "sync_state": "Uploaded"},
            previous=evidence,
        )

        checkin = {
            "checkin_id": "checkin-1",
            "device_action_id": "checkin-device-1",
            "roof_job": "job-1",
            "job_assignment": "assignment-1",
            "crew_profile": "crew-1",
            "source_system": "IronWrap Field",
            "capture_actor": "field@example.com",
            "capture_started_at": "2026-07-10 08:00:00",
            "capture_completed_at": "2026-07-10 08:05:00",
            "submitted_at": "2026-07-10 08:06:00",
            "status": "Needs Review",
            "sync_state": "Verified",
            "verified_at": "2026-07-10 08:07:00",
            "evidence_ids_json": '["ev-verified"]',
            "blocker_flag": 1,
            "blocker_category": "Weather",
            "blocker_summary": "Wind exceeds plan limit.",
            "voice_evidence": "ev-voice-1",
        }
        validate_record("field_check_in", checkin)
        self.assert_policy(
            "required_fields",
            validate_record,
            "field_check_in",
            {**checkin, "blocker_summary": None},
        )

    def test_workforce_safety_and_compliance_records(self) -> None:
        crew = {
            "crew_profile_id": "crew-1",
            "crew_name": "Calgary Metal Crew",
            "status": "Active",
            "crew_type": "Internal",
            "primary_lead": "lead@example.com",
            "home_region": "Calgary, AB",
            "timezone": "America/Edmonton",
            "competency_status": "Current",
            "competency_checked_at": "2026-07-01 08:00:00",
            "competency_expiry": "2026-12-31",
            "equipment_status": "Safe",
            "equipment_checked_at": "2026-07-01 08:00:00",
            "equipment_expiry": "2026-12-31",
            "active_stop": 0,
            "members": [
                {"crew_user": "lead@example.com", "active": 1},
                {"crew_user": "roofer@example.com", "active": 1},
            ],
        }
        validate_record("crew_profile", crew)
        self.assert_policy(
            "duplicate_crew_member",
            validate_record,
            "crew_profile",
            {**crew, "members": [crew["members"][0], crew["members"][0]]},
        )

        validate_record(
            "job_assignment",
            {
                "assignment_id": "assignment-1",
                "roof_job": "job-1",
                "assignment_type": "Installation",
                "status": "In Progress",
                "crew_profile": "crew-1",
                "assigned_by": "production@example.com",
                "assigned_at": "2026-07-10 07:00:00",
                "accepted_at": "2026-07-10 07:15:00",
                "started_at": "2026-07-10 08:00:00",
            },
        )

        safety = {
            "safety_plan_id": "safety-1",
            "roof_job": "job-1",
            "version": 1,
            "status": "Acknowledged",
            "effective_date": "2026-07-10",
            "prepared_by": "production@example.com",
            "prepared_at": "2026-07-09 17:00:00",
            "hazard_summary": "Falls, wind, material handling.",
            "controls": "Tie-off and exclusion zones.",
            "emergency_plan": "Call 911 and site lead.",
            "ppe_requirements": "Harness, helmet, gloves.",
            "weather_limits": "Stop above approved wind threshold.",
            "evidence_item": "ev-safety-plan",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-09 18:00:00",
            "acknowledgements": [
                {
                    "acknowledged_by": "lead@example.com",
                    "acknowledged_at": "2026-07-10 07:30:00",
                    "acknowledgement_method": "Field App",
                    "device_action_id": "ack-device-1",
                    "evidence_item": "ev-safety-ack-1",
                }
            ],
        }
        validate_record("safety_plan", safety)

        compliance = {
            "compliance_record_id": "permit-1",
            "roof_job": "job-1",
            "jurisdiction": "Calgary, AB",
            "record_type": "Permit",
            "authority_name": "City of Calgary",
            "status": "Waived",
            "required_before_gate": "Materials",
            "owner_user": "production@example.com",
            "effective_date": "2026-07-01",
            "expiry_date": "2026-12-31",
            "waived_by": "owner@example.com",
            "waived_at": "2026-07-10 09:00:00",
            "waiver_reason": "Authority confirmed no permit is required for like-for-like work.",
        }
        validate_record("job_compliance_record", compliance)

    def test_change_order_and_payment_truth_are_versioned(self) -> None:
        change = {
            "change_order_id": "co-1",
            "roof_job": "job-1",
            "customer_quote": "cq-1",
            "change_number": "CO-001",
            "version": 1,
            "status": "Approved",
            "title": "Deck repair",
            "reason": "Hidden rot discovered after tear-off.",
            "scope_delta": "Replace 10 sheets of decking.",
            "currency": "CAD",
            "subtotal": 1000,
            "tax_amount": 50,
            "total_amount": 1050,
            "price_book_version": "retail-2026-07",
            "tax_policy_snapshot_json": '{"country":"CA","province":"AB","rate":5}',
            "items": [
                {
                    "item_type": "Labour and Material",
                    "description": "Deck replacement",
                    "quantity": 10,
                    "unit": "sheet",
                    "unit_price": 100,
                    "line_total": 1000,
                }
            ],
            "requested_by": "production@example.com",
            "requested_at": "2026-07-10 10:00:00",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 10:15:00",
        }
        validate_record("change_order", change)
        self.assert_policy(
            "amount_mismatch",
            validate_record,
            "change_order",
            {**change, "total_amount": 1000},
        )
        corrected = {
            **change,
            "change_order_id": "co-2",
            "version": 2,
            "supersedes": "co-1",
            "correction_reason": "Correct tax treatment.",
        }
        validate_record(
            "change_order", corrected, context={"superseded_record": change}
        )
        self.assert_policy(
            "stale_version",
            validate_record,
            "change_order",
            {**corrected, "version": 1},
            context={"superseded_record": change},
        )

        payment = {
            "payment_milestone_id": "pay-1",
            "roof_job": "job-1",
            "milestone_type": "Invoice",
            "milestone_version": 1,
            "status": "Matched",
            "currency": "CAD",
            "subtotal": 1000,
            "tax_amount": 50,
            "total_amount": 1050,
            "amount_due": 1050,
            "amount_paid": 250,
            "balance_due": 800,
            "payment_status": "Partially Paid",
            "tax_code": "GST",
            "tax_rate": 5,
            "tax_policy_snapshot_json": '{"rate":5}',
            "truth_source": "QuickBooks",
            "truth_at": "2026-07-10 11:00:00",
        }
        validate_record("payment_milestone", payment)

    def test_insurance_supplement_requires_verified_human_evidence(self) -> None:
        def evidence(evidence_type: str) -> dict[str, object]:
            return {
                "roof_job": "job-1",
                "evidence_type": evidence_type,
                "sync_state": "Verified",
                "content_checksum": "a" * 64,
                "checksum_algorithm": "SHA-256",
                "verified_at": "2026-07-12T10:00:00.000Z",
                "verification_source": "worker-checksum",
                "r2_key": "private/job-1/evidence",
            }

        sources = {
            "ev-carrier": evidence("PDF"),
            "ev-code": evidence("PDF"),
            "ev-photo": evidence("Photo"),
            "ev-invoice": evidence("Invoice"),
        }
        context = {
            "insurance_measurement": {
                "roof_job": "job-1",
                "review_status": "Approved",
                "approved_by": "estimator@example.com",
                "approved_at": "2026-07-12T09:00:00.000Z",
            },
            "insurance_evidence": sources,
        }
        review = {
            "insurance_supplement_id": "supp-1",
            "roof_job": "job-1",
            "version": 1,
            "status": "Ready for Human Review",
            "carrier_name": "Carrier record retained internally",
            "claim_reference": "claim-internal",
            "policy_reference": "policy-internal",
            "date_of_loss": "2026-06-18",
            "adjuster_reference": "adjuster-internal",
            "supplement_basis": "Verified scope, measurement, code, and photo evidence are attached.",
            "measurement_report": "measurement-1",
            "invoice_required": 1,
            "evidence": [
                {"evidence_item": "ev-carrier", "evidence_role": "Carrier Scope"},
                {"evidence_item": "ev-code", "evidence_role": "Code/Manufacturer"},
                {"evidence_item": "ev-photo", "evidence_role": "Photo"},
                {"evidence_item": "ev-invoice", "evidence_role": "Invoice"},
            ],
        }
        validate_record("insurance_supplement", review, context=context)
        self.assert_policy(
            "missing_insurance_evidence",
            validate_record,
            "insurance_supplement",
            {**review, "evidence": review["evidence"][:-2]},
            context=context,
        )
        self.assert_policy(
            "unverified_insurance_evidence",
            validate_record,
            "insurance_supplement",
            review,
            context={
                **context,
                "insurance_evidence": {
                    **sources,
                    "ev-photo": {**sources["ev-photo"], "sync_state": "Uploaded"},
                },
            },
        )

        manifest = {
            "roof_job": "job-1",
            "measurement_report": "measurement-1",
            "evidence": [
                {
                    "evidence_item_id": evidence_id,
                    "evidence_role": role,
                    "evidence_type": sources[evidence_id]["evidence_type"],
                    "content_checksum": sources[evidence_id]["content_checksum"],
                    "checksum_algorithm": "SHA-256",
                    "verified_at": sources[evidence_id]["verified_at"],
                    "verification_source": sources[evidence_id]["verification_source"],
                }
                for evidence_id, role in [
                    ("ev-carrier", "Carrier Scope"),
                    ("ev-code", "Code/Manufacturer"),
                    ("ev-invoice", "Invoice"),
                    ("ev-photo", "Photo"),
                ]
            ],
        }
        approved = {
            **review,
            "status": "Approved for Submission",
            "evidence_manifest_json": json.dumps(manifest),
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-12T10:05:00.000Z",
        }
        validate_record(
            "insurance_supplement",
            approved,
            previous=review,
            context=context,
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "insurance_supplement",
            {**approved, "carrier_name": "Changed carrier"},
            previous=approved,
            context=context,
        )
        self.assert_policy(
            "missing_submission_evidence",
            validate_record,
            "insurance_supplement",
            {**approved, "status": "Submitted", "submitted_at": "2026-07-12T10:10:00.000Z"},
            previous=approved,
            context=context,
        )

    def test_customer_consent_decision_and_acceptance_are_append_only(self) -> None:
        consent = {
            "consent_id": "consent-1",
            "customer": "customer-1",
            "channel": "SMS",
            "purpose": "Job Updates",
            "status": "Granted",
            "jurisdiction": "Alberta, Canada",
            "consent_basis": "Written",
            "source_system": "IronWrap Web",
            "source_reference": "form-1",
            "captured_by": "sales@example.com",
            "captured_at": "2026-07-10 09:00:00",
            "effective_from": "2026-07-10 09:00:00",
            "proof_evidence": "ev-consent-1",
        }
        validate_record("communication_consent", consent)
        self.assert_policy(
            "write_once_field",
            validate_record,
            "communication_consent",
            {**consent, "status": "Revoked"},
            previous=consent,
        )

        validate_record(
            "customer_decision",
            {
                "decision_id": "decision-1",
                "roof_job": "job-1",
                "customer": "customer-1",
                "decision_type": "Option Selection",
                "status": "Recorded",
                "decision_value": "Premium",
                "decision_summary": "Customer selected premium standing seam option.",
                "source_channel": "In Person",
                "decided_at": "2026-07-10 09:30:00",
                "captured_by": "sales@example.com",
                "evidence_item": "ev-decision-1",
                "option_package": "option-premium",
            },
        )

        validate_record(
            "contract_acceptance",
            {
                "acceptance_id": "accept-1",
                "roof_job": "job-1",
                "customer": "customer-1",
                "customer_quote": "cq-1",
                "contract_version": "cq-1:v1",
                "status": "Accepted",
                "signer_name": "Alex Customer",
                "signer_email": "alex@example.com",
                "signer_ip": "203.0.113.10",
                "accepted_at": "2026-07-10 10:00:00",
                "acceptance_method": "Click to Accept",
                "evidence_item": "ev-contract-1",
                "terms_hash": "a" * 64,
                "document_checksum": "b" * 64,
                "source_system": "Owned Signing",
                "provider_reference": "signature-1",
                "captured_by": "sales@example.com",
            },
        )
        portal_acceptance = {
            "acceptance_id": "accept-portal-1",
            "roof_job": "job-1",
            "customer": "customer-1",
            "customer_quote": "cq-1",
            "proposal_evidence_pack": "proposal:cq-1",
            "contract_version": "cq-1:v1",
            "status": "Accepted",
            "signer_name": "Alex Customer",
            "signer_email": "alex@example.com",
            "signer_ip": "203.0.113.10",
            "accepted_at": "2026-07-10 10:00:00",
            "acceptance_method": "Click to Accept",
            "evidence_item": "ev-contract-portal-1",
            "terms_hash": "a" * 64,
            "terms_snapshot_json": '{"anchor":{"quote_id":"cq-1"}}',
            "document_checksum": "b" * 64,
            "source_system": "ironwrap-customer-portal",
            "provider_reference": "challenge-1",
            "captured_by": "customer-acceptance@example.com",
        }
        validate_record("contract_acceptance", portal_acceptance)
        self.assert_policy(
            "required_fields",
            validate_record,
            "contract_acceptance",
            {
                key: value
                for key, value in portal_acceptance.items()
                if key != "terms_snapshot_json"
            },
        )
        self.assert_policy(
            "empty_json_contract",
            validate_record,
            "contract_acceptance",
            {**portal_acceptance, "terms_snapshot_json": "{}"},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "contract_acceptance",
            {**portal_acceptance, "terms_snapshot_json": '{"anchor":{"quote_id":"cq-2"}}'},
            previous=portal_acceptance,
        )
        self.assert_policy(
            "invalid_acceptance_method",
            validate_record,
            "contract_acceptance",
            {
                "acceptance_id": "accept-verbal",
                "roof_job": "job-1",
                "customer": "customer-1",
                "customer_quote": "cq-1",
                "contract_version": "cq-1:v1",
                "status": "Accepted",
                "signer_name": "Alex Customer",
                "signer_email": "alex@example.com",
                "accepted_at": "2026-07-10 10:00:00",
                "acceptance_method": "Recorded Verbal",
                "evidence_item": "ev-contract-1",
                "terms_hash": "a" * 64,
                "document_checksum": "b" * 64,
                "source_system": "Phone",
                "provider_reference": "call-1",
                "captured_by": "sales@example.com",
            },
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "contract_acceptance",
            {
                "acceptance_id": "accept-no-ip",
                "roof_job": "job-1",
                "customer": "customer-1",
                "customer_quote": "cq-1",
                "contract_version": "cq-1:v1",
                "status": "Accepted",
                "signer_name": "Alex Customer",
                "signer_email": "alex@example.com",
                "accepted_at": "2026-07-10 10:00:00",
                "acceptance_method": "Click to Accept",
                "evidence_item": "ev-contract-1",
                "terms_hash": "a" * 64,
                "document_checksum": "b" * 64,
                "source_system": "Owned Signing",
                "provider_reference": "signature-1",
                "captured_by": "sales@example.com",
            },
        )

    def test_reconciliation_and_tenant_export_fail_closed(self) -> None:
        reconciliation = {
            "reconciliation_id": "recon-1",
            "roof_job": "job-1",
            "system_name": "Accounting Bridge",
            "entity_type": "Invoice",
            "external_entity_id": "qb-1",
            "local_doctype": "Payment Milestone",
            "local_name": "pay-1",
            "direction": "Inbound",
            "status": "Matched",
            "detected_at": "2026-07-10 11:00:00",
            "raw_key": "raw/quickbooks/2026-07-10/ow-recon.json",
            "source_version": "Update",
            "source_amount": 1050,
            "local_amount": 1050,
            "currency": "CAD",
            "source_payload_hash": "a" * 64,
            "local_payload_hash": "a" * 64,
            "attempt_count": 1,
        }
        validate_record("integration_reconciliation", reconciliation)
        self.assert_policy(
            "unmatched_payload",
            validate_record,
            "integration_reconciliation",
            {**reconciliation, "local_payload_hash": "b" * 64},
        )

        webhook_milestone = {
            "payment_milestone_id": "qb:1234567890:Invoice:42",
            "roof_job": "job-1",
            "milestone_type": "Invoice",
            "milestone_version": 1,
            "status": "Webhook Seen",
            "qb_entity_type": "Invoice",
            "qb_entity_id": "42",
            "qb_operation": "Update",
            "realm_id": "1234567890",
            "event_ts": "2026-07-10 11:00:00",
            "raw_key": "raw/quickbooks/2026-07-10/ow-webhook.json",
            "raw_payload_hash": "c" * 64,
        }
        validate_record("payment_milestone", webhook_milestone)
        self.assert_policy(
            "webhook_payment_milestone_provider_truth_unavailable",
            validate_record,
            "payment_milestone",
            {**webhook_milestone, "payment_status": "Paid", "amount_paid": 1},
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "payment_milestone",
            {**webhook_milestone, "status": "Matched"},
            previous=webhook_milestone,
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "payment_milestone",
            {**webhook_milestone, "raw_payload_hash": "d" * 64},
            previous=webhook_milestone,
        )

        pending = {
            "reconciliation_id": f"qbr:{'c' * 64}:0",
            "system_name": "QuickBooks",
            "entity_type": "Payment",
            "external_entity_id": "7",
            "local_doctype": "Unresolved QuickBooks Event",
            "local_name": f"qbr:{'c' * 64}:0",
            "direction": "Inbound",
            "status": "Pending",
            "detected_at": "2026-07-10 11:00:00",
            "raw_key": "raw/quickbooks/2026-07-10/ow-webhook.json",
            "source_version": "Create",
            "source_payload_hash": "c" * 64,
            "local_payload_hash": "d" * 64,
            "attempt_count": 0,
        }
        validate_record("integration_reconciliation", pending)
        self.assert_policy(
            "quickbooks_initial_status_must_be_pending",
            validate_record,
            "integration_reconciliation",
            {**pending, "status": "Matched"},
        )
        self.assert_policy(
            "quickbooks_provider_truth_unavailable",
            validate_record,
            "integration_reconciliation",
            {
                **pending,
                "status": "Resolved",
                "resolution_action": "Await authenticated provider read",
                "resolved_by": "finance@example.com",
                "resolved_at": "2026-07-10 12:00:00",
                "resolution_evidence": "ev-provider-read",
            },
            previous=pending,
        )
        self.assert_policy(
            "quickbooks_unresolved_linkage",
            validate_record,
            "integration_reconciliation",
            {**pending, "local_doctype": "Payment Milestone"},
        )

        export = {
            "export_run_id": "export-1",
            "tenant": "ironwrap",
            "status": "Completed",
            "requested_by": "support@example.com",
            "requested_at": "2026-07-10 12:00:00",
            "started_at": "2026-07-10 12:01:00",
            "completed_at": "2026-07-10 12:05:00",
            "scope_json": '{"doctypes":["Roof Job","Evidence Item"]}',
            "manifest_key": "exports/export-1/manifest.json",
            "manifest_checksum": "a" * 64,
            "archive_key": "exports/export-1/archive.tar.zst",
            "archive_checksum": "b" * 64,
            "record_count": 10,
            "evidence_count": 3,
            "byte_count": 4096,
            "encryption_key_ref": "kms://ironwrap/export-1",
        }
        validate_record("tenant_export_run", export)
        self.assert_policy(
            "required_fields",
            validate_record,
            "tenant_export_run",
            {**export, "manifest_checksum": None},
        )

    def test_executed_hermes_write_requires_complete_audit_chain(self) -> None:
        run = {
            "run_id": "run-1",
            "capability_level": "Approved-write",
            "approval_status": "Executed",
            "target_doctype": "Roof Job",
            "target_name": "job-1",
            "tool_name": "erpnext_update_gate_approved",
            "tool_args_json": '{"gate_id":"gate-1"}',
            "dry_run_receipt": "signed-dry-run-receipt",
            "dry_run_json": '{"allowed":true,"changes":["state"]}',
            "policy_check_json": '{"allowed":true}',
            "policy_checked_by": "owner@example.com",
            "policy_checked_at": "2026-07-10 15:00:00",
            "approval_receipt": "signed-human-approval-receipt",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 15:01:00",
            "audit_event_id": "audit-1",
            "request_correlation_id": "request-1",
            "before_target_ids": "[]",
            "after_target_ids": '["gate-1"]',
            "completed_at": "2026-07-10 15:02:00",
            "result_status": "OK",
            "mutation_applied": 1,
            "result_json": '{"updated":"gate-1"}',
        }
        validate_record("hermes_run", run)
        self.assert_policy(
            "required_fields",
            validate_record,
            "hermes_run",
            {**run, "policy_checked_at": None},
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "hermes_run",
            {**run, "approval_receipt": None},
        )
        self.assert_policy(
            "audit_state_mismatch",
            validate_record,
            "hermes_run",
            {**run, "approval_status": "Denied"},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "hermes_run",
            {**run, "target_name": "job-2"},
            previous=run,
        )

    def test_audit_failure_preserves_truth_about_an_applied_mutation(self) -> None:
        audit_failed = {
            "run_id": "run-audit-failed",
            "capability_level": "Approved-write",
            "approval_status": "Audit Failed",
            "target_doctype": "Roof Job",
            "target_name": "job-1",
            "tool_name": "erpnext_update_gate_approved",
            "tool_args_json": '{"gate_id":"gate-1"}',
            "dry_run_receipt": "signed-dry-run-receipt",
            "dry_run_json": '{"allowed":true,"changes":["state"]}',
            "policy_check_json": '{"allowed":true}',
            "policy_checked_by": "owner@example.com",
            "policy_checked_at": "2026-07-10 15:00:00",
            "approval_receipt": "signed-human-approval-receipt",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 15:01:00",
            "audit_incident_id": "incident-audit-1",
            "request_correlation_id": "request-1",
            "before_target_ids": '["gate-1"]',
            "after_target_ids": '["gate-1"]',
            "completed_at": "2026-07-10 15:02:00",
            "result_status": "Error",
            "mutation_applied": 1,
            "result_json": '{"target_mutation":{"updated":"gate-1"}}',
            "error": "Target mutation succeeded but Hermes Run finalization failed.",
        }
        validate_record("hermes_run", audit_failed)
        self.assert_policy(
            "required_fields",
            validate_record,
            "hermes_run",
            {**audit_failed, "audit_incident_id": None},
        )
        self.assert_policy(
            "audit_state_mismatch",
            validate_record,
            "hermes_run",
            {**audit_failed, "approval_status": "Failed"},
        )
        self.assert_policy(
            "truthy_once_field",
            validate_record,
            "hermes_run",
            {**audit_failed, "mutation_applied": 0, "approval_status": "Failed"},
            previous=audit_failed,
        )

    def test_pricing_measurement_and_scope_products_require_approval_proof(
        self,
    ) -> None:
        records = {
            "price_book_rule": {
                "price_rule_id": "price-1",
                "rule_name": "Standing seam panel",
                "status": "Approved",
                "rule_type": "Material",
                "unit": "sqft",
                "source_ref": "supplier-sheet-2026-07",
                "effective_from": "2026-07-01",
                "assumptions": "Standard colour.",
                "exclusions": "Freight.",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-10 10:00:00",
                "approval_note": "Supplier sheet checked.",
                "rule_json": '{"unit_price":12.50}',
            },
            "visual_property_model": {
                "visual_model_id": "model-1",
                "status": "Approved",
                "roof_job": "job-1",
                "roofing_property": "property-1",
                "provider": "Hover",
                "model_uri": "https://example.test/model/1",
                "confidence": 95,
                "source_evidence": "ev-model",
                "needs_review": 0,
                "measurements_json": '{"area_sqft":2400}',
                "approved_by": "estimator@example.com",
                "approved_at": "2026-07-10 10:00:00",
                "approval_note": "Model checked against report.",
            },
            "roof_area": {
                "roof_area_id": "area-1",
                "status": "Approved",
                "roof_job": "job-1",
                "roofing_property": "property-1",
                "area_name": "Main roof",
                "area_sqft": 2400,
                "source_ref": "model-1:/main",
                "visual_model": "model-1",
                "needs_review": 0,
                "approved_by": "estimator@example.com",
                "approved_at": "2026-07-10 10:00:00",
                "approval_note": "Area checked.",
            },
            "option_package": {
                "option_package_id": "option-1",
                "status": "Approved",
                "package_name": "Better",
                "tier": "Better",
                "material_system": "24ga standing seam",
                "warranty_summary": "40/10 years",
                "payment_assumptions": "40% deposit, balance at completion.",
                "assumptions": "Standard access.",
                "exclusions": "Deck repair.",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-10 10:00:00",
                "approval_note": "Commercial terms checked.",
                "options_json": '{"snow_guards":true}',
                "scope_clause_ids_json": '["clause-1"]',
            },
            "scope_clause": {
                "scope_clause_id": "clause-1",
                "roof_job": "job-1",
                "customer_quote": "quote-1",
                "status": "Approved",
                "clause_type": "Included",
                "title": "Tear-off",
                "clause_text": "Remove one existing layer.",
                "version": "1.0",
                "source_ref": "scope-library:v1",
                "customer_visible": 1,
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-10 10:00:00",
                "approval_note": "Legal wording reviewed.",
            },
        }
        for kind, record in records.items():
            with self.subTest(kind=kind):
                validate_record(
                    kind,
                    record,
                    context=(
                        {"scope_clause_quote": {"roof_job": "job-1"}}
                        if kind == "scope_clause"
                        else None
                    ),
                )

        self.assert_policy(
            "scope_clause_quote_missing",
            validate_record,
            "scope_clause",
            records["scope_clause"],
        )
        self.assert_policy(
            "scope_clause_quote_mismatch",
            validate_record,
            "scope_clause",
            records["scope_clause"],
            context={"scope_clause_quote": {"roof_job": "other-job"}},
        )
        self.assert_policy(
            "write_once_field",
            validate_record,
            "scope_clause",
            {**records["scope_clause"], "customer_quote": "quote-2"},
            previous=records["scope_clause"],
            context={"scope_clause_quote": {"roof_job": "job-1"}},
        )

        self.assert_policy(
            "value_out_of_range",
            validate_record,
            "visual_property_model",
            {**records["visual_property_model"], "confidence": 101},
        )
        price_rule = records["price_book_rule"]
        validate_record(
            "price_book_rule", {**price_rule, "status": "Retired"}, previous=price_rule
        )
        self.assert_policy(
            "invalid_state_transition",
            validate_record,
            "price_book_rule",
            {**price_rule, "status": "Draft"},
            previous=price_rule,
        )
        self.assert_policy(
            "immutable_field",
            validate_record,
            "price_book_rule",
            {**price_rule, "source_ref": "supplier-sheet-2026-08"},
            previous=price_rule,
        )

    def test_reception_session_and_request_only_appointment_contracts(self) -> None:
        event = {
            "schema_version": "newo.event.v1",
            "event_id": "event-1",
            "session_id": "session-1",
            "event_type": "booking_requested",
            "occurred_at": "2026-07-18T18:00:00.000Z",
            "provider": {},
            "channel": "phone",
            "direction": "inbound",
            "contact": {},
            "intent": {},
            "consent": {},
            "appointment": {},
            "outcome": {"transcript_ref": "newo:transcript:session-1"},
            "handoff_summary": None,
        }
        session = {
            "session_id": "session-1",
            "provider": "Newo",
            "channel": "Phone",
            "direction": "Inbound",
            "session_status": "appointment_requested",
            "urgency": "routine",
            "ai_disclosed": 1,
            "recording_disclosed": 1,
            "transcript_pointer": "newo:transcript:session-1",
            "recording_pointer": "newo:recording:session-1",
            "raw_key": "raw/newo/events/2026-07-18/event-1.json",
            "payload_hash": "a" * 64,
            "structured_json": json.dumps(event),
            "provider_updated_at": "2026-07-18 18:00:00",
        }
        validate_record("reception_session", session)
        copied_content = {
            **session,
            "structured_json": json.dumps(
                {**event, "outcome": {"transcript": "verbatim caller text"}}
            ),
        }
        self.assert_policy(
            "provider_content_not_allowed",
            validate_record,
            "reception_session",
            copied_content,
        )
        self.assert_policy(
            "recording_without_disclosure",
            validate_record,
            "reception_session",
            {**session, "recording_disclosed": 0},
        )

        appointment = {
            "appointment_request_id": "appointment-1",
            "reception_session": "session-1",
            "request_status": "Pending",
            "booking_mode": "Request Only",
            "provider": "Newo",
            "preferred_windows_json": json.dumps(
                [{"start": "2026-07-21T16:00:00.000Z", "end": None}]
            ),
            "timezone": "America/Edmonton",
            "requested_at": "2026-07-18 18:00:00",
            "raw_key": "raw/newo/events/2026-07-18/event-1.json",
            "payload_hash": "a" * 64,
        }
        validate_record("appointment_request", appointment)
        self.assert_policy(
            "request_only_confirmation",
            validate_record,
            "appointment_request",
            {
                **appointment,
                "request_status": "Confirmed",
                "confirmed_external_id": "jn-appointment-1",
                "confirmed_start": "2026-07-21 16:00:00",
                "confirmed_end": "2026-07-21 17:00:00",
                "decision_by": "owner@example.com",
                "decision_at": "2026-07-18 18:05:00",
                "decision_notes": "Controlled test only.",
            },
            previous=appointment,
        )
        validate_record(
            "appointment_request",
            {
                **appointment,
                "request_status": "Cancelled",
                "cancelled_at": "2026-07-18 18:10:00",
            },
            previous=appointment,
        )

    def test_incident_and_tenant_lifecycle_gates(self) -> None:
        incident = {
            "incident_id": "incident-1",
            "status": "Closed",
            "severity": "High",
            "source_system": "Cloudflare Bus",
            "category": "Stuck Envelope",
            "summary": "Envelope exhausted retries.",
            "detected_at": "2026-07-10 10:00:00",
            "retry_count": 3,
            "resolution_notes": "Replay succeeded after provider recovery.",
            "resolved_by": "support@example.com",
            "resolved_at": "2026-07-10 11:00:00",
        }
        validate_record("automation_incident", incident)
        self.assert_policy(
            "required_fields",
            validate_record,
            "automation_incident",
            {**incident, "resolution_notes": None},
        )

        tenant = {
            "tenant_id": "tenant-1",
            "status": "Active",
            "site_hostname": "ironwrap.example.test",
            "legal_name": "IronWrap Exteriors Ltd.",
            "primary_brand": "IronWrap Exteriors",
            "owner_user": "owner@example.com",
            "data_residency": "Canada",
            "isolation_model": "Site per Tenant",
            "brand_config_json": '{"brand":"IronWrap Exteriors"}',
            "namespace_config_json": '{"site":"ironwrap"}',
            "policy_config_json": '{"quiet_hours":"21:00-08:00"}',
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 10:00:00",
            "approval_note": "Provisioning checklist complete.",
            "activated_at": "2026-07-10 10:05:00",
        }
        validate_record(
            "white_label_tenant", tenant, context={"other_active_tenants": 0}
        )
        self.assert_policy(
            "tenant_isolation",
            validate_record,
            "white_label_tenant",
            tenant,
            context={"other_active_tenants": 1},
        )

    def test_supply_only_shop_order_requires_traceable_material_quality_and_yield(self) -> None:
        item = {
            "controlled_item_id": "item:panel:24ga:v1",
            "status": "Approved",
            "revision": 1,
            "item_kind": "Finished Product",
            "unit": "each",
            "profile": "Standing seam panel",
            "gauge": "24 ga",
            "coating": "PVDF",
            "colour": "Charcoal",
            "dimension_spec": "16 in cover width",
            "tolerance": "± 3 mm",
            "lot_required": 1,
            "certificate_required": 1,
            "source_ref": "supplier-spec:2026-07",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-30 08:00:00",
            "approval_note": "Approved metal system specification.",
        }
        validate_record("controlled_item", item)
        self.assert_policy(
            "immutable_field",
            validate_record,
            "controlled_item",
            {**item, "source_ref": "supplier-spec:forged"},
            previous=item,
        )

        lot_draft = {
            "material_lot_id": "lot:coil:001",
            "roof_job": "job-1",
            "controlled_item": item["controlled_item_id"],
            "source_kind": "Supplier Receipt",
            "supplier_order": "so-1",
            "source_evidence": "evidence:receipt-1",
            "lot_number": "SUP-COIL-001",
            "condition_status": "Accepted",
            "received_quantity": 10,
            "unit": "each",
            "status": "Draft",
        }
        lot_context = {
            "controlled_item": {
                "name": item["controlled_item_id"],
                "status": "Approved",
            },
            "supplier_order": {
                "name": "so-1",
                "roof_job": "job-1",
                "status": "Received",
            },
        }
        validate_record("material_lot", lot_draft, context=lot_context)
        lot_available = {
            **lot_draft,
            "status": "Available",
            "received_at": "2026-07-30 08:30:00",
            "available_quantity": 10,
            "reserved_quantity": 0,
            "consumed_quantity": 0,
        }
        validate_record(
            "material_lot", lot_available, previous=lot_draft, context=lot_context
        )
        self.assert_policy(
            "unreceived_supplier_order",
            validate_record,
            "material_lot",
            lot_available,
            previous=lot_draft,
            context={
                **lot_context,
                "supplier_order": {
                    **lot_context["supplier_order"],
                    "status": "Approved",
                },
            },
        )
        self.assert_policy(
            "unapproved_material_lot_item",
            validate_record,
            "material_lot",
            lot_available,
            previous=lot_draft,
            context={
                **lot_context,
                "controlled_item": {
                    **lot_context["controlled_item"],
                    "status": "Draft",
                },
            },
        )
        self.assert_policy(
            "cross_job_material_lot_supplier_order",
            validate_record,
            "material_lot",
            lot_available,
            previous=lot_draft,
            context={
                **lot_context,
                "supplier_order": {
                    **lot_context["supplier_order"],
                    "roof_job": "job-other",
                },
            },
        )
        self.assert_policy(
            "material_lot_balance_mismatch",
            validate_record,
            "material_lot",
            {**lot_available, "available_quantity": 9},
            previous=lot_draft,
            context=lot_context,
        )
        lot_reserved = {
            **lot_available,
            "status": "Reserved",
            "available_quantity": 2,
            "reserved_quantity": 8,
            "consumed_quantity": 0,
        }
        validate_record(
            "material_lot", lot_reserved, previous=lot_available, context=lot_context
        )
        lot_quarantined = {**lot_reserved, "status": "Quarantined"}
        validate_record(
            "material_lot", lot_quarantined, previous=lot_reserved, context=lot_context
        )
        self.assertEqual(
            {
                field: lot_quarantined[field]
                for field in ("available_quantity", "reserved_quantity", "consumed_quantity")
            },
            {
                field: lot_reserved[field]
                for field in ("available_quantity", "reserved_quantity", "consumed_quantity")
            },
        )

        line = {
            "line_no": 1,
            "controlled_item": item["controlled_item_id"],
            "requested_quantity": 8,
            "accepted_quantity": 8,
            "billable_quantity": 8,
            "unit": "each",
            "dimensions": "2400 mm panel length",
            "tolerance": "± 3 mm",
            "orientation": "Eave to ridge",
            "invoice_basis": "Each",
            "needs_review": 0,
        }
        draft = {
            "shop_order_id": "shop:job-1:001",
            "roof_job": "job-1",
            "material_takeoff": "takeoff-1",
            "supplier_order": "so-1",
            "work_package": "wp:shop-1",
            "status": "Draft",
            "lines": [line],
        }
        source_context = {
            "material_takeoff": {
                "name": "takeoff-1",
                "roof_job": "job-1",
                "status": "Approved",
            },
            "supplier_order": {
                "name": "so-1",
                "roof_job": "job-1",
                "status": "Received",
            },
            "work_package": {
                "name": "wp:shop-1",
                "roof_job": "job-1",
                "status": "Released",
            },
        }
        validate_record("shop_order", draft, context=source_context)
        released = {
            **draft,
            "status": "Released",
            "released_by": "production@example.com",
            "released_at": "2026-07-30 09:00:00",
        }
        validate_record("shop_order", released, previous=draft, context=source_context)
        self.assert_policy(
            "cross_job_shop_supplier_order",
            validate_record,
            "shop_order",
            released,
            previous=draft,
            context={
                **source_context,
                "supplier_order": {
                    **source_context["supplier_order"],
                    "roof_job": "job-other",
                },
            },
        )

        allocation = {
            "allocation_id": "alloc:1",
            "line_no": 1,
            "material_lot": lot_available["material_lot_id"],
            "reserved_quantity": 10,
            "issued_quantity": 10,
            "unit": "each",
            "status": "Issued",
            "needs_review": 0,
        }
        shop_context = {
            **source_context,
            "material_lots": {lot_available["material_lot_id"]: lot_available},
        }
        reserved = {
            **released,
            "status": "Reserved",
            "reserved_at": "2026-07-30 09:05:00",
            "material_allocations": [allocation],
        }
        validate_record("shop_order", reserved, previous=released, context=shop_context)
        quality_hold = {
            **reserved,
            "status": "Quality Hold",
            "quality_hold_reason": "Incoming material inspection requires containment.",
        }
        validate_record(
            "shop_order", quality_hold, previous=reserved, context=shop_context
        )
        quarantined_lot_context = {
            **shop_context,
            "material_lots": {
                lot_available["material_lot_id"]: {
                    **lot_available,
                    "status": "Quarantined",
                }
            },
        }
        validate_record(
            "shop_order",
            quality_hold,
            previous=reserved,
            context=quarantined_lot_context,
        )
        self.assert_policy(
            "shop_allocation_lot_unavailable",
            validate_record,
            "shop_order",
            reserved,
            previous=released,
            context=quarantined_lot_context,
        )
        self.assert_policy(
            "shop_allocation_roof_job_mismatch",
            validate_record,
            "shop_order",
            reserved,
            previous=released,
            context={
                **shop_context,
                "material_lots": {
                    lot_available["material_lot_id"]: {**lot_available, "roof_job": "job-other"}
                },
            },
        )
        self.assert_policy(
            "shop_allocation_item_mismatch",
            validate_record,
            "shop_order",
            reserved,
            previous=released,
            context={
                **shop_context,
                "material_lots": {
                    lot_available["material_lot_id"]: {
                        **lot_available,
                        "controlled_item": "item:other",
                    }
                },
            },
        )
        self.assert_policy(
            "shop_allocation_unit_mismatch",
            validate_record,
            "shop_order",
            reserved,
            previous=released,
            context={
                **shop_context,
                "material_lots": {
                    lot_available["material_lot_id"]: {**lot_available, "unit": "kg"}
                },
            },
        )
        self.assert_policy(
            "shop_allocation_quantity_exceeds_lot",
            validate_record,
            "shop_order",
            reserved,
            previous=released,
            context={
                **shop_context,
                "material_lots": {
                    lot_available["material_lot_id"]: {**lot_available, "received_quantity": 9}
                },
            },
        )
        operation = {
            "sequence": 1,
            "operation": "Form standing seam panel",
            "machine_tooling": "Roll former / approved die set",
            "operator": "fabricator@example.com",
            "status": "Complete",
            "started_at": "2026-07-30 09:12:00",
        }
        setup = {
            **reserved,
            "status": "Setup / First Piece",
            "setup_started_at": "2026-07-30 09:10:00",
            "operations": [operation],
        }
        validate_record("shop_order", setup, previous=reserved, context=shop_context)
        first_piece = {
            "inspection_type": "First Piece",
            "line_no": 1,
            "allocation_id": "alloc:1",
            "operation_sequence": 1,
            "result": "Pass",
            "nominal_value": 2400,
            "measured_value": 2400,
            "tolerance_value": 3,
            "measurement_unit": "mm",
            "measured_result": "Profile and length within tolerance.",
            "inspected_by": "quality@example.com",
            "inspected_at": "2026-07-30 09:15:00",
            "evidence_item": "evidence:first-piece-1",
            "needs_review": 0,
        }
        fabricating = {
            **setup,
            "status": "In Fabrication",
            "fabrication_started_at": "2026-07-30 09:20:00",
            "inspections": [first_piece],
        }
        validate_record("shop_order", fabricating, previous=setup, context=shop_context)
        self.assert_policy(
            "first_piece_tolerance_result_mismatch",
            validate_record,
            "shop_order",
            {
                **fabricating,
                "inspections": [{**first_piece, "measured_value": 2404}],
            },
            previous=setup,
            context=shop_context,
        )
        self.assert_policy(
            "missing_first_piece_pass",
            validate_record,
            "shop_order",
            {**fabricating, "inspections": []},
            previous=setup,
            context=shop_context,
        )
        self.assert_policy(
            "non_independent_shop_inspection",
            validate_record,
            "shop_order",
            {
                **fabricating,
                "inspections": [{**first_piece, "inspected_by": operation["operator"]}],
            },
            previous=setup,
            context=shop_context,
        )

        final = {
            **first_piece,
            "inspection_type": "Final",
            "evidence_item": "evidence:final-1",
        }
        ready = {
            **fabricating,
            "status": "Ready",
            "ready_at": "2026-07-30 10:00:00",
            "inspections": [first_piece, final],
            "yields": [
                {
                    "allocation_id": "alloc:1",
                    "operation_sequence": 1,
                    "input_quantity": 10,
                    "finished_quantity": 8,
                    "remnant_quantity": 1,
                    "remnant_lot": "lot:remnant:001",
                    "scrap_quantity": 1,
                    "scrap_disposition": "recycle-bin:metal",
                    "evidence_item": "evidence:scrap-1",
                }
            ],
            "bundles": [
                {
                    "bundle_id": "bundle:1",
                    "line_no": 1,
                    "material_lot": lot_available["material_lot_id"],
                    "piece_identity": "panel:1-8",
                    "accepted_quantity": 8,
                    "unit": "each",
                    "label_text": "job-1 / panel 1-8 / lot SUP-COIL-001",
                    "handoff_status": "Prepared",
                    "condition": "Finish protected; no visible damage.",
                    "needs_review": 0,
                }
            ],
        }
        ready_context = {**shop_context, "open_nonconformance_count": 0}
        validate_record("shop_order", ready, previous=fabricating, context=ready_context)
        self.assert_policy(
            "open_shop_nonconformance",
            validate_record,
            "shop_order",
            ready,
            previous=fabricating,
            context={**ready_context, "open_nonconformance_count": 1},
        )
        self.assert_policy(
            "shop_yield_conservation_mismatch",
            validate_record,
            "shop_order",
            {
                **ready,
                "yields": [
                    {**ready["yields"][0], "finished_quantity": 7}
                ],
            },
            previous=fabricating,
            context=ready_context,
        )

        handed_over_bundle = {
            **ready["bundles"][0],
            "handoff_status": "Handed Over",
            "handed_over_to": "install@example.com",
            "handed_over_at": "2026-07-30 10:10:00",
            "handoff_evidence": "evidence:bundle-handoff-1",
        }
        handed_over = {
            **ready,
            "status": "Handed Over",
            "handed_over_to": "install@example.com",
            "handed_over_at": "2026-07-30 10:10:00",
            "handoff_evidence": "evidence:order-handoff-1",
            "bundles": [handed_over_bundle],
        }
        validate_record(
            "shop_order", handed_over, previous=ready, context=ready_context
        )
        self.assert_policy(
            "required_fields",
            validate_record,
            "shop_order",
            {**handed_over, "handoff_evidence": None},
            previous=ready,
            context=ready_context,
        )
        self.assert_policy(
            "unhanded_shop_bundle",
            validate_record,
            "shop_order",
            {**handed_over, "bundles": [ready["bundles"][0]]},
            previous=ready,
            context=ready_context,
        )

        invoice_milestone = {
            "name": "payment:shop-1:invoice-1",
            "roof_job": "job-1",
            "shop_order": draft["shop_order_id"],
            "status": "Webhook Seen",
        }
        invoice_context = {
            **ready_context,
            "invoice_payment_milestone": invoice_milestone,
        }
        invoice_ready = {
            **handed_over,
            "status": "Invoice Ready",
            "invoice_payment_milestone": invoice_milestone["name"],
            "invoice_ready_at": "2026-07-30 10:15:00",
        }
        validate_record(
            "shop_order",
            invoice_ready,
            previous=handed_over,
            context=invoice_context,
        )
        self.assert_policy(
            "cross_job_shop_invoice_basis",
            validate_record,
            "shop_order",
            invoice_ready,
            previous=handed_over,
            context={
                **invoice_context,
                "invoice_payment_milestone": {
                    **invoice_milestone,
                    "roof_job": "job-other",
                },
            },
        )
        self.assert_policy(
            "shop_invoice_basis_mismatch",
            validate_record,
            "shop_order",
            invoice_ready,
            previous=handed_over,
            context={
                **invoice_context,
                "invoice_payment_milestone": {
                    **invoice_milestone,
                    "shop_order": "shop:job-other:001",
                },
            },
        )
        self.assert_policy(
            "unverified_shop_invoice_basis",
            validate_record,
            "shop_order",
            invoice_ready,
            previous=handed_over,
            context={
                **invoice_context,
                "invoice_payment_milestone": {
                    **invoice_milestone,
                    "status": "Ignored",
                },
            },
        )

        ncr = {
            "nonconformance_id": "ncr:shop-1:1",
            "shop_order": draft["shop_order_id"],
            "material_lot": lot_available["material_lot_id"],
            "status": "Draft",
        }
        ncr_context = {
            "shop_order": {"name": draft["shop_order_id"], "roof_job": "job-1"},
            "material_lot": lot_available,
            "shop_order_allocation_lot_ids": {lot_available["material_lot_id"]},
        }
        validate_record("nonconformance", ncr, context=ncr_context)
        contained_ncr = {
            **ncr,
            "status": "Contained",
            "detected_at": "2026-07-30 09:15:00",
            "reported_by": "quality@example.com",
            "description": "First-piece measurement exceeded tolerance.",
            "evidence_item": "evidence:first-piece-1",
            "containment": "Material lot quarantined; Shop Order on Quality Hold.",
        }
        validate_record("nonconformance", contained_ncr, context=ncr_context)
        self.assert_policy(
            "nonconformance_roof_job_mismatch",
            validate_record,
            "nonconformance",
            ncr,
            context={
                **ncr_context,
                "material_lot": {**lot_available, "roof_job": "job-other"},
            },
        )
        self.assert_policy(
            "nonconformance_unallocated_lot",
            validate_record,
            "nonconformance",
            ncr,
            context={**ncr_context, "shop_order_allocation_lot_ids": {"lot:other"}},
        )

        remnant_draft = {
            "material_lot_id": "lot:remnant:001",
            "roof_job": "job-1",
            "controlled_item": item["controlled_item_id"],
            "source_kind": "Shop Remnant",
            "source_shop_order": draft["shop_order_id"],
            "source_evidence": "evidence:remnant-1",
            "lot_number": "REM-001",
            "condition_status": "Accepted",
            "received_quantity": 1,
            "unit": "each",
            "status": "Draft",
        }
        validate_record("material_lot", remnant_draft)
        remnant_available = {
            **remnant_draft,
            "status": "Available",
            "received_at": "2026-07-30 10:00:00",
            "available_quantity": 1,
            "reserved_quantity": 0,
            "consumed_quantity": 0,
        }
        remnant_context = {
            "controlled_item": {
                "name": item["controlled_item_id"],
                "status": "Approved",
            },
            "source_shop_order": {
                "name": draft["shop_order_id"],
                "roof_job": "job-1",
                "status": "Ready",
            },
        }
        validate_record(
            "material_lot",
            remnant_available,
            previous=remnant_draft,
            context=remnant_context,
        )
        self.assert_policy(
            "unfinalized_shop_remnant",
            validate_record,
            "material_lot",
            remnant_available,
            previous=remnant_draft,
            context={
                **remnant_context,
                "source_shop_order": {
                    **remnant_context["source_shop_order"],
                    "status": "In Fabrication",
                },
            },
        )
        self.assert_policy(
            "cross_job_shop_remnant",
            validate_record,
            "material_lot",
            remnant_available,
            previous=remnant_draft,
            context={
                **remnant_context,
                "source_shop_order": {
                    **remnant_context["source_shop_order"],
                    "roof_job": "job-other",
                },
            },
        )


if __name__ == "__main__":
    unittest.main()
