from __future__ import annotations

import unittest

from ironwrap_roofing.control_center import build_job_runway, sort_action_queue


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


if __name__ == "__main__":
    unittest.main()
