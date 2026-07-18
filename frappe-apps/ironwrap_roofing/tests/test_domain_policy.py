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

        order = {
            "supplier_order_id": "so-1",
            "status": "Approved",
            "roof_job": "job-1",
            "material_takeoff": "to-1",
            "source_quote": "sq-1",
            "supplier": "supplier-1",
            "approved_by": "owner@example.com",
            "approved_at": "2026-07-10 11:30:00",
            "order_summary_json": '{"quote":"sq-1"}',
            "items": [{"quantity": 20, "received_qty": 0, "shortage_qty": 0}],
        }
        context = {"takeoff_status": "Approved", "supplier_quote_status": "Approved"}
        validate_record("supplier_order", order, context=context)
        self.assert_policy(
            "unapproved_supplier_quote",
            validate_record,
            "supplier_order",
            order,
            context={**context, "supplier_quote_status": "Draft"},
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

        # Completion is intentionally not required to schedule production work.
        validate_record(
            "job_assignment", assignment, context={"gates": gates, "gate_evidence": gate_evidence}
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
            "primary_lead": "lead@example.com",
            "home_region": "Calgary, AB",
            "timezone": "America/Edmonton",
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
            "system_name": "QuickBooks",
            "entity_type": "Invoice",
            "external_entity_id": "qb-1",
            "local_doctype": "Payment Milestone",
            "local_name": "pay-1",
            "direction": "Inbound",
            "status": "Matched",
            "detected_at": "2026-07-10 11:00:00",
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


if __name__ == "__main__":
    unittest.main()
