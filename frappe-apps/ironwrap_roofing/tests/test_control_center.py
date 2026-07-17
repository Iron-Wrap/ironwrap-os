from __future__ import annotations

import unittest

from ironwrap_roofing.control_center import (
    build_customer_portal_scope_actions,
    build_job_runway,
    sort_action_queue,
)


class ControlCenterProjectionTests(unittest.TestCase):
    def test_runway_surfaces_review_and_gate_exceptions(self) -> None:
        runway = build_job_runway(
            {
                "job": {"job_status": "Proposal"},
                "estimates": [{"status": "Approved"}],
                "measurements": [{"review_status": "Needs Review"}],
                "gates": [
                    {"gate": "Deposit", "state": "Ready"},
                    {"gate": "Materials", "state": "Blocked"},
                ],
                "payments": [{"status": "Needs Review"}],
            }
        )
        states = {step["key"]: step["state"] for step in runway}
        self.assertEqual(states["estimate"], "complete")
        self.assertEqual(states["measurement"], "attention")
        self.assertEqual(states["production"], "attention")
        self.assertEqual(states["finance"], "attention")

    def test_runway_marks_required_production_gates_clear(self) -> None:
        gates = [
            {"gate": gate, "state": "Ready"}
            for gate in ("Deposit", "Materials", "Safety", "Access", "Weather", "Crew")
        ]
        runway = build_job_runway({"job": {"job_status": "Won"}, "gates": gates})
        production = next(step for step in runway if step["key"] == "production")
        self.assertEqual(production["state"], "complete")
        self.assertEqual(production["detail"], "Required gates clear")

    def test_action_queue_orders_priority_then_recency_and_caps(self) -> None:
        items = [
            {"name": "old", "priority": 1, "modified": "2026-07-09 10:00:00"},
            {"name": "low", "priority": 3, "modified": "2026-07-10 12:00:00"},
            {"name": "new", "priority": 1, "modified": "2026-07-10 11:00:00"},
        ]
        self.assertEqual(
            [item["name"] for item in sort_action_queue(items, limit=2)],
            ["new", "old"],
        )

    def test_customer_portal_scope_actions_only_flags_unpublishable_clauses(
        self,
    ) -> None:
        clauses = [
            {
                "name": "scope-job-missing",
                "customer_quote": "quote-1",
                "status": "Approved",
                "customer_visible": 1,
            },
            {
                "name": "scope-valid",
                "roof_job": "job-1",
                "customer_quote": "quote-1",
                "status": "Approved",
                "customer_visible": 1,
            },
            {
                "name": "scope-quote-missing",
                "roof_job": "job-1",
                "customer_quote": "",
                "status": "Approved",
                "customer_visible": 1,
            },
            {
                "name": "scope-quote-unknown",
                "roof_job": "job-1",
                "customer_quote": "quote-unknown",
                "status": "Approved",
                "customer_visible": 1,
            },
            {
                "name": "scope-quote-mismatch",
                "roof_job": "job-1",
                "customer_quote": "quote-2",
                "status": "Approved",
                "customer_visible": 1,
            },
            {
                "name": "scope-internal",
                "roof_job": "job-1",
                "status": "Approved",
                "customer_visible": 0,
            },
        ]
        actions = build_customer_portal_scope_actions(
            clauses,
            [
                {"name": "quote-1", "roof_job": "job-1"},
                {"name": "quote-2", "roof_job": "job-2"},
            ],
        )

        self.assertEqual(
            [action["name"] for action in actions],
            [
                "scope-job-missing",
                "scope-quote-missing",
                "scope-quote-unknown",
                "scope-quote-mismatch",
            ],
        )
        self.assertTrue(all(action["priority"] == 1 for action in actions))
        self.assertIn("Do not repoint", actions[-2]["detail"])
        self.assertIn("another Roof Job", actions[-1]["detail"])

    def test_runway_does_not_treat_a_historical_pack_as_current_quote_publication(
        self,
    ) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "quotes": [
                    {
                        "name": "quote-current",
                        "roof_job": "job-1",
                        "status": "Needs Review",
                    }
                ],
                "proposals": [
                    {
                        "name": "pack-old",
                        "roof_job": "job-1",
                        "quotation": "quote-old",
                        "status": "Approved",
                    }
                ],
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "attention")
        self.assertEqual(proposal["detail"], "Needs Review")

    def test_runway_requires_current_quote_publication_not_any_job_pack(self) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "quotes": [
                    {
                        "name": "quote-current",
                        "roof_job": "job-1",
                        "status": "Approved",
                    }
                ],
                "proposals": [
                    {
                        "name": "pack-old",
                        "roof_job": "job-1",
                        "quotation": "quote-old",
                        "status": "Approved",
                    }
                ],
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "attention")
        self.assertEqual(
            proposal["detail"], "Quote approved; customer publication pending"
        )

    def test_runway_keeps_publication_complete_when_a_newer_office_draft_exists(
        self,
    ) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "quotes": [
                    {
                        "name": "quote-current",
                        "roof_job": "job-1",
                        "status": "Approved",
                    }
                ],
                "proposals": [
                    {
                        "name": "pack-current-draft",
                        "roof_job": "job-1",
                        "quotation": "quote-current",
                        "status": "Draft",
                    },
                    {
                        "name": "pack-current-published",
                        "roof_job": "job-1",
                        "quotation": "quote-current",
                        "status": "Approved",
                    },
                ],
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "complete")
        self.assertEqual(
            proposal["detail"], "Published; latest returned office pack Draft"
        )

    def test_runway_does_not_turn_unreadable_quote_data_into_attention(self) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "proposal_access": {"quote": False, "publication": False},
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "pending")
        self.assertEqual(
            proposal["detail"], "Customer quote is not available in your role"
        )

    def test_runway_does_not_turn_unreadable_publication_data_into_attention(
        self,
    ) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "proposal_access": {"quote": True, "publication": False},
                "quotes": [
                    {
                        "name": "quote-current",
                        "roof_job": "job-1",
                        "status": "Approved",
                    }
                ],
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "active")
        self.assertEqual(
            proposal["detail"], "Customer publication is not available in your role"
        )

    def test_runway_surfaces_an_unverifiable_anchor_to_lineage_authority(self) -> None:
        runway = build_job_runway(
            {
                "job": {
                    "name": "job-1",
                    "job_status": "Proposal",
                    "quotation": "quote-current",
                },
                "proposal_access": {
                    "quote": True,
                    "quote_lineage": True,
                    "publication": False,
                },
            }
        )

        proposal = next(step for step in runway if step["key"] == "proposal")
        self.assertEqual(proposal["state"], "attention")
        self.assertEqual(proposal["detail"], "Current quote link cannot be verified")


if __name__ == "__main__":
    unittest.main()
