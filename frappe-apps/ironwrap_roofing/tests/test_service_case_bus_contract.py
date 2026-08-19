"""Contract between the two halves of the service lifecycle.

The bus owns the versioned lifecycle in D1 migration ``0056_service_case_lifecycle.sql``; the
Frappe ``Service Case`` record is the Desk-side projection of the same facts.  Two independent
state machines describing one lifecycle drift silently, so this test reads the D1 triggers and
asserts the Python validator admits exactly what they admit:

* the allowed state transitions are the same set, in both directions;
* every closure the bus accepts is representable as a Frappe record;
* a closure the bus refuses is refused here too.

It is deliberately a parse of the real migration rather than a copied table: a change to the SQL
that nobody mirrors into ``domain_policy`` fails here instead of at a customer's callback.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from ironwrap_roofing.domain_policy import (
    SERVICE_CASE_TRANSITIONS,
    PolicyViolation,
    validate_record,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATION = REPO_ROOT / "workers-bus" / "migrations" / "0056_service_case_lifecycle.sql"

# The bus stores lowercase lifecycle codes; the Desk stores their human labels.  Both halves are
# closed sets, so the mapping is exhaustive and a new code on either side breaks this test.
STATE_LABELS = {
    "intake": "Intake",
    "triaged": "Triaged",
    "diagnosed": "Diagnosed",
    "remedy_issued": "Remedy Issued",
    "remedy_verified": "Remedy Verified",
    "customer_accepted": "Customer Accepted",
    "disputed": "Disputed",
    "closed": "Closed",
    "reopened": "Reopened",
}
CLOSURE_LABELS = {
    "remedied_accepted": "Remedied and Accepted",
    "no_fault_unknown": "No Fault Unknown",
    "excluded": "Excluded",
    "duplicate": "Duplicate",
    "withdrawn": "Withdrawn",
}

TRANSITION_CLAUSE = re.compile(
    r"OLD\.state = '(?P<source>\w+)' AND NEW\.state (?:IN \((?P<many>[^)]*)\)|= '(?P<one>\w+)')"
)
CLOSURE_CLAUSE = re.compile(
    r"OLD\.state = '(?P<source>\w+)' AND NEW\.closure_reason "
    r"(?:IN \((?P<many>[^)]*)\)|= '(?P<one>\w+)')"
)


def _quoted(values: str) -> list[str]:
    return re.findall(r"'(\w+)'", values)


def _trigger_body(sql: str, name: str) -> str:
    start = sql.index(f"CREATE TRIGGER IF NOT EXISTS {name}")
    return sql[start : sql.index("\nEND;", start)]


def _d1_transitions(sql: str) -> dict[str, set[str]]:
    body = _trigger_body(sql, "service_cases_valid_transition")
    clause = body[: body.index("service_case_event_type_mismatch")]
    transitions: dict[str, set[str]] = {}
    for match in TRANSITION_CLAUSE.finditer(clause):
        targets = _quoted(match.group("many")) if match.group("many") else [match.group("one")]
        transitions.setdefault(match.group("source"), set()).update(targets)
    return transitions


def _d1_closures(sql: str) -> dict[str, set[str]]:
    body = _trigger_body(sql, "service_cases_valid_transition")
    start = body.index("service_case_closure_reason_not_allowed")
    clause = body[start : body.index("service_case_reopen_must_preserve_history", start)]
    closures: dict[str, set[str]] = {}
    for match in CLOSURE_CLAUSE.finditer(clause):
        reasons = _quoted(match.group("many")) if match.group("many") else [match.group("one")]
        closures.setdefault(match.group("source"), set()).update(reasons)
    return closures


def _labelled(record: dict[str, object], **overrides: object) -> dict[str, object]:
    return {**record, **overrides}


BASE_CASE: dict[str, object] = {
    "service_case_id": "svc-contract-1",
    "roofing_customer": "cust-1",
    "roofing_property": "prop-1",
    "roof_job": "job-1",
    "severity": "Standard",
    "symptom_code": "interior_water_stain",
    "reported_channel": "Phone",
    "reported_at": "2026-08-18T10:00:00.000Z",
    "communication_consent": "consent-1",
    "response_due_at": "2026-08-19T10:00:00.000Z",
}
TRIAGE_FACTS: dict[str, object] = {
    "triage_category": "Workmanship",
    "responsibility": "IronWrap Workmanship",
    "triaged_by": "ops@example.invalid",
    "triaged_at": "2026-08-18T11:00:00.000Z",
}
DIAGNOSIS_FACTS: dict[str, object] = {
    "root_cause_code": "flashing_gap",
    "corrective_action_code": "reflash_penetration",
    "service_work_package": "wp-service-1",
}
VERIFICATION_FACTS: dict[str, object] = {
    "remedy_verified_by": "ops@example.invalid",
    "remedy_verified_at": "2026-08-25T18:00:00.000Z",
    "remedy_evidence": "evidence-1",
}
ACCEPTANCE_FACTS: dict[str, object] = {
    "customer_accepted_at": "2026-08-26T09:00:00.000Z",
    "customer_acceptance": "decision-1",
}

# The facts a case in each state genuinely carries, as the bus records them.
STATE_FACTS: dict[str, dict[str, object]] = {
    "Intake": {},
    "Triaged": TRIAGE_FACTS,
    "Diagnosed": {**TRIAGE_FACTS, **DIAGNOSIS_FACTS},
    "Remedy Issued": {**TRIAGE_FACTS, **DIAGNOSIS_FACTS},
    "Remedy Verified": {**TRIAGE_FACTS, **DIAGNOSIS_FACTS, **VERIFICATION_FACTS},
    "Customer Accepted": {
        **TRIAGE_FACTS,
        **DIAGNOSIS_FACTS,
        **VERIFICATION_FACTS,
        **ACCEPTANCE_FACTS,
    },
    "Disputed": {**TRIAGE_FACTS, **DIAGNOSIS_FACTS, **VERIFICATION_FACTS},
    "Closed": {},
    "Reopened": {},
}


class ServiceCaseBusContractTests(unittest.TestCase):
    """The bus and the Desk must describe one lifecycle, not two."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")

    def test_the_migration_is_readable_from_the_frappe_app(self) -> None:
        self.assertTrue(MIGRATION.is_file(), f"missing bus migration at {MIGRATION}")

    def test_the_two_state_machines_admit_the_same_transitions(self) -> None:
        d1 = {
            STATE_LABELS[source]: {STATE_LABELS[target] for target in targets}
            for source, targets in _d1_transitions(self.sql).items()
        }
        self.assertEqual(SERVICE_CASE_TRANSITIONS, d1)

    def test_every_closure_the_bus_accepts_is_representable_in_the_desk(self) -> None:
        for source, reasons in _d1_closures(self.sql).items():
            previous_status = STATE_LABELS[source]
            previous = _labelled(BASE_CASE, status=previous_status, **STATE_FACTS[previous_status])
            for reason in reasons:
                with self.subTest(source=previous_status, closure_reason=CLOSURE_LABELS[reason]):
                    closed = _labelled(
                        previous,
                        status="Closed",
                        closure_reason=CLOSURE_LABELS[reason],
                        closed_at="2026-08-27T09:00:00.000Z",
                    )
                    validate_record("service_case", closed, previous=previous)

    def test_an_untriaged_withdrawal_needs_no_triage_attribution(self) -> None:
        intake = _labelled(BASE_CASE, status="Intake")
        # The exact fact ELEC-7 reproduced: the bus accepts it, so the Desk must be able to hold it.
        validate_record(
            "service_case",
            _labelled(
                intake,
                status="Closed",
                closure_reason="Withdrawn",
                closed_at="2026-08-18T12:00:00.000Z",
            ),
            previous=intake,
        )

    def test_a_remedied_closure_still_names_the_triage_that_found_the_fault(self) -> None:
        accepted = _labelled(
            BASE_CASE, status="Customer Accepted", **STATE_FACTS["Customer Accepted"]
        )
        unattributed = {key: value for key, value in accepted.items() if key not in TRIAGE_FACTS}
        with self.assertRaises(PolicyViolation) as raised:
            validate_record(
                "service_case",
                _labelled(
                    unattributed,
                    status="Closed",
                    closure_reason="Remedied and Accepted",
                    closed_at="2026-08-27T09:00:00.000Z",
                ),
                previous=accepted,
            )
        self.assertEqual(raised.exception.code, "required_fields")

    def test_a_closure_the_bus_refuses_is_refused_here_too(self) -> None:
        closures = _d1_closures(self.sql)
        self.assertNotIn("remedied_accepted", closures["intake"])
        intake = _labelled(BASE_CASE, status="Intake")
        with self.assertRaises(PolicyViolation):
            validate_record(
                "service_case",
                _labelled(
                    intake,
                    status="Closed",
                    closure_reason="Remedied and Accepted",
                    closed_at="2026-08-18T12:00:00.000Z",
                ),
                previous=intake,
            )


if __name__ == "__main__":  # pragma: no cover - convenience for local runs
    unittest.main()
