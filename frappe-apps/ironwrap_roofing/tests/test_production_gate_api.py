"""The bounded production-gate clearing command.

Every case here answers one of the two questions ELEC-122 exists for: can a real
office decision move a gate off `Blocked` at all, and can anything else.

RETIREMENT (IRO-195 / ELEC-115 Path A): these cases go with
`ironwrap_roofing.production_gate_api` when IRO-195's D1-native production-gate
state replaces it.  The questions they ask do not retire: the authority, replay
and refusal cases move to `workers-bus/test/production-gate-clearance.test.ts`,
which already asks them of the Worker route.
"""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.domain_policy import PRODUCTION_GATES


API_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "production_gate_api.py"
)
ISSUER = "ironwrap-bus@example.com"
ACTOR = "production@example.com"
JOB = "job-122"
DECISION = "gate-clearance-key-0000000001"
REASON = "Environment Canada shows a dry three-day window from Monday."
EVIDENCE = {
    "r2_key": "production-gate-clearance/v1/gate-clearance-key-0000000001.json",
    "content_checksum": "f" * 64,
    "content_type": "application/json",
    "content_length": 412,
    "captured_at": "2026-08-21T00:00:00.000Z",
    "summary": "Deposit settlement observed on money intent acct-intent-deposit-1",
}


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDocument(dict):
    def __init__(self, values: dict, on_save, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_save", on_save)
        object.__setattr__(self, "_on_insert", on_insert)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def insert(self) -> None:
        if self["doctype"] != "Evidence Item":
            raise AssertionError(f"unexpected insert: {self['doctype']}")
        self["name"] = self["evidence_id"]
        self._on_insert(self)

    def save(self) -> None:
        self._on_save(self)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        if "`tabUser`" in normalized:
            user = self.fixtures["users"].get(values[0])
            return [dict(user)] if user else []
        if "`tabRoof Job`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["jobs"].values()
                if values[0] in {row["name"], row["roof_job_id"]}
            ]
        if "`tabProduction Gate State`" in normalized:
            return [
                dict(row)
                for row in self.fixtures["gates"].values()
                if row["roof_job"] == values[0] and row["gate"] == values[1]
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class ProductionGateApiTests(unittest.TestCase):
    def fixtures(self, **overrides) -> dict:
        gate = {
            "name": "gate:job-122:Weather",
            "gate_id": "gate:job-122:Weather",
            "roof_job": JOB,
            "gate": "Weather",
            "state": "Blocked",
            "owner_user": ISSUER,
            "assigned_at": "2026-08-20 10:00:00",
            "due_at": "2026-08-23 10:00:00",
            "blocker_reason": "Awaiting weather readiness proof.",
            "evidence_item": None,
            "waived_by": None,
            "waived_at": None,
            "waiver_reason": None,
        }
        gate.update(overrides.pop("gate", {}))
        job = {
            "name": JOB,
            "roof_job_id": JOB,
            "job_status": "Won",
        }
        job.update(overrides.pop("job", {}))
        return {
            "users": {ACTOR: {"name": ACTOR, "enabled": 1}},
            "jobs": {JOB: job},
            "gates": {gate["name"]: gate},
            "evidence": [],
            **overrides,
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = ISSUER,
        roles: list[str] | None = None,
        has_permission=True,
        site_config: dict | None = None,
        request_method: str = "POST",
    ):
        fixtures = fixtures if fixtures is not None else self.fixtures()
        db = FakeDb(fixtures)
        clearance_calls: list[tuple[dict, dict | None, str | None]] = []

        @contextmanager
        def production_gate_clearance_context(gate, evidence=None, waiver_actor=None):
            clearance_calls.append(
                (dict(gate), None if evidence is None else dict(evidence), waiver_actor)
            )
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.production_gate_clearance_context = (
            production_gate_clearance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.conf = dict(
            site_config
            if site_config is not None
            else {"ironwrap_production_gate_issuer_user": ISSUER}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method, headers={})
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else ["IronWrap Owner"]
        )

        def permission(doctype, ptype=None, user=None, doc=None):
            if callable(has_permission):
                return has_permission(doctype, ptype, user, doc)
            return has_permission

        frappe_module.has_permission = permission
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-08-21 00:05:00"
        )
        frappe_module.whitelist = lambda: lambda function: function

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw

        def on_insert(document: FakeDocument) -> None:
            fixtures["evidence"].append(dict(document))

        def on_save(document: FakeDocument) -> None:
            fixtures["gates"][document["name"]] = dict(document)

        def get_doc(*args):
            if len(args) == 2:
                doctype, name = args
                if doctype != "Production Gate State":
                    raise AssertionError(f"unexpected get_doc: {doctype}")
                row = dict(fixtures["gates"][name])
                row["doctype"] = "Production Gate State"
                return FakeDocument(row, on_save, on_insert)
            if len(args) == 1 and isinstance(args[0], dict):
                return FakeDocument(dict(args[0]), on_save, on_insert)
            raise AssertionError(f"unexpected get_doc args: {args}")

        frappe_module.get_doc = get_doc
        spec = importlib.util.spec_from_file_location(
            "ironwrap_production_gate_api_under_test", API_PATH
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
        return module, fixtures, db, clearance_calls

    @staticmethod
    def call(module, **overrides):
        payload = {
            "roof_job_id": JOB,
            "gate": "Weather",
            "clearance": "waived",
            "actor_user": ACTOR,
            "decision_id": DECISION,
            "reason": REASON,
        }
        payload.update(overrides)
        return module.record_production_gate_clearance(**payload)

    # ------------------------------------------------------------------ issuer

    def test_clearable_gates_are_exactly_the_scheduling_locks(self):
        module, _fixtures, _db, _calls = self.load_api()
        self.assertEqual(module.CLEARABLE_GATES, PRODUCTION_GATES)

    def test_unpinned_issuer_fails_the_rail_closed(self):
        module, _fixtures, _db, _calls = self.load_api(site_config={})
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_issuer_not_configured", str(error.exception))

    def test_another_principal_cannot_issue_a_clearance(self):
        module, _fixtures, _db, _calls = self.load_api(session_user="someone@example.com")
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_issuer_auth_mismatch", str(error.exception))

    def test_a_read_request_cannot_clear_a_gate(self):
        module, _fixtures, _db, _calls = self.load_api(request_method="GET")
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_post_required", str(error.exception))

    # ------------------------------------------------------------------- input

    def test_completion_is_not_clearable_here(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, gate="Completion")
        self.assertIn("production_gate_not_clearable", str(error.exception))

    def test_an_unknown_clearance_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, clearance="Done")
        self.assertIn("production_gate_invalid_input", str(error.exception))

    def test_a_reason_nobody_could_audit_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        for reason in (None, "", "too short"[:4], "   "):
            with self.assertRaises(FakeValidationError):
                self.call(module, reason=reason)

    # --------------------------------------------------------------------- job

    def test_an_unknown_job_has_no_gate(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, roof_job_id="job-missing")
        self.assertIn("production_gate_roof_job_not_found", str(error.exception))

    def test_a_tentative_job_has_no_schedule_to_unlock(self):
        module, _fixtures, _db, _calls = self.load_api(
            self.fixtures(job={"job_status": "Qualified"})
        )
        with self.assertRaises(FakeValidationError) as error:
            self.call(module)
        self.assertIn("production_gate_job_not_clearable", str(error.exception))

    def test_a_closed_job_has_no_schedule_to_unlock(self):
        module, _fixtures, _db, _calls = self.load_api(
            self.fixtures(job={"job_status": "Closed"})
        )
        with self.assertRaises(FakeValidationError):
            self.call(module)

    def test_a_missing_gate_row_is_named_as_such(self):
        fixtures = self.fixtures()
        fixtures["gates"] = {}
        module, _fixtures, _db, _calls = self.load_api(fixtures)
        with self.assertRaises(FakeValidationError) as error:
            self.call(module)
        self.assertIn("production_gate_not_found", str(error.exception))

    def test_two_current_rows_for_one_gate_are_ambiguous(self):
        fixtures = self.fixtures()
        duplicate = dict(next(iter(fixtures["gates"].values())))
        duplicate["name"] = "gate:job-122:Weather:2"
        fixtures["gates"][duplicate["name"]] = duplicate
        module, _fixtures, _db, _calls = self.load_api(fixtures)
        with self.assertRaises(FakeValidationError) as error:
            self.call(module)
        self.assertIn("production_gate_ambiguous", str(error.exception))

    # ------------------------------------------------------------------- actor

    def test_a_disabled_actor_cannot_clear(self):
        fixtures = self.fixtures()
        fixtures["users"][ACTOR]["enabled"] = 0
        module, _fixtures, _db, _calls = self.load_api(fixtures)
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_actor_not_enabled", str(error.exception))

    def test_an_actor_without_gate_authority_cannot_clear(self):
        module, _fixtures, _db, _calls = self.load_api(roles=["IronWrap Sales"])
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_actor_role_denied", str(error.exception))

    def test_an_owner_may_clear(self):
        module, fixtures, _db, _calls = self.load_api(roles=["IronWrap Owner"])
        result = self.call(module)
        self.assertEqual(result["actor_role"], "IronWrap Owner")
        self.assertEqual(fixtures["gates"]["gate:job-122:Weather"]["state"], "Waived")

    def test_production_may_record_evidence_but_may_not_waive(self):
        """The two bars differ, and not by this module's choice.

        `document_validation.validate_business_document` has always required an
        owner-level actor for a waiver; recording that a requirement was met is the
        gate write authority `access_control` grants IronWrap Production.
        """

        module, fixtures, _db, _calls = self.load_api(roles=["IronWrap Production"])
        result = self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        self.assertEqual(result["actor_role"], "IronWrap Production")
        self.assertEqual(fixtures["gates"]["gate:job-122:Weather"]["state"], "Ready")

        module, _fixtures, _db, _calls = self.load_api(roles=["IronWrap Production"])
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_actor_role_denied", str(error.exception))
        self.assertIn("IronWrap Owner", str(error.exception))

    def test_a_waiver_names_its_actor_to_the_validator(self):
        """Otherwise the shipped waiver rule would read the bus as the decider."""

        module, _fixtures, _db, calls = self.load_api()
        self.call(module)
        self.assertEqual(calls[0][2], ACTOR)

    def test_a_verified_clearance_names_no_waiver_actor(self):
        module, _fixtures, _db, calls = self.load_api()
        self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        self.assertIsNone(calls[0][2])

    def test_an_actor_without_row_permission_cannot_clear(self):
        module, _fixtures, _db, _calls = self.load_api(
            roles=["IronWrap Owner"],
            has_permission=lambda _doctype, _ptype, user, _doc: user != ACTOR,
        )
        with self.assertRaises(FakePermissionError) as error:
            self.call(module)
        self.assertIn("production_gate_actor_permission_denied", str(error.exception))

    # ------------------------------------------------------------------ waiver

    def test_a_waiver_records_its_actor_reason_and_time_and_answers_the_blocker(self):
        module, fixtures, db, calls = self.load_api()
        result = self.call(module)
        gate = fixtures["gates"]["gate:job-122:Weather"]
        self.assertEqual(gate["state"], "Waived")
        self.assertEqual(gate["waived_by"], ACTOR)
        self.assertEqual(gate["waived_at"], "2026-08-21 00:05:00")
        self.assertEqual(gate["waiver_reason"], REASON)
        self.assertIsNone(gate["blocker_reason"])
        self.assertEqual(fixtures["evidence"], [])
        self.assertFalse(result["replayed"])
        self.assertIsNone(result["evidence_item"])
        # A waiver authorizes no Evidence Item at all.
        self.assertEqual(calls[0][1], None)
        # The job and the gate were both locked before anything was decided.
        self.assertTrue(any("`tabRoof Job`" in query for query in db.lock_queries))
        self.assertTrue(
            any("`tabProduction Gate State`" in query for query in db.lock_queries)
        )

    def test_the_same_waiver_twice_converges_instead_of_rewriting(self):
        module, fixtures, _db, _calls = self.load_api()
        self.call(module)
        before = dict(fixtures["gates"]["gate:job-122:Weather"])
        result = self.call(module)
        self.assertTrue(result["replayed"])
        self.assertEqual(fixtures["gates"]["gate:job-122:Weather"], before)

    def test_a_different_clearance_never_silently_overwrites_one(self):
        module, _fixtures, _db, _calls = self.load_api()
        self.call(module)
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, reason="Somebody else decided something different.")
        self.assertIn("production_gate_already_cleared", str(error.exception))

    # ---------------------------------------------------------------- verified

    def test_a_verified_clearance_mints_its_receipt_and_binds_it_to_the_gate(self):
        module, fixtures, _db, calls = self.load_api()
        result = self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        gate = fixtures["gates"]["gate:job-122:Weather"]
        self.assertEqual(gate["state"], "Ready")
        self.assertEqual(gate["evidence_item"], f"gate-clearance:{DECISION}")
        self.assertIsNone(gate["waived_by"])
        self.assertIsNone(gate["waiver_reason"])
        self.assertIsNone(gate["blocker_reason"])
        self.assertEqual(result["evidence_item"], f"gate-clearance:{DECISION}")
        [evidence] = fixtures["evidence"]
        self.assertEqual(evidence["roof_job"], JOB)
        self.assertEqual(evidence["proof_slot"], "Weather")
        self.assertEqual(evidence["sync_state"], "Verified")
        self.assertEqual(evidence["checksum_algorithm"], "SHA-256")
        self.assertEqual(evidence["content_checksum"], "f" * 64)
        self.assertEqual(evidence["r2_key"], EVIDENCE["r2_key"])
        self.assertEqual(evidence["capture_actor"], ACTOR)
        self.assertEqual(evidence["proof_owner"], ACTOR)
        self.assertEqual(evidence["customer_safe"], 0)
        self.assertEqual(evidence["captured_at"], "2026-08-21 00:00:00")
        self.assertEqual(
            evidence["verification_source"],
            "ironwrap-worker-r2-production-gate-clearance",
        )
        # The context authorized exactly this receipt and this gate.
        self.assertEqual(calls[0][1]["evidence_id"], f"gate-clearance:{DECISION}")

    def test_a_verified_clearance_without_a_receipt_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, clearance="verified")
        self.assertIn("production_gate_evidence_required", str(error.exception))

    def test_a_receipt_that_is_not_a_sha256_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError):
            self.call(
                module,
                clearance="verified",
                evidence={**EVIDENCE, "content_checksum": "not-a-digest"},
            )

    def test_a_receipt_carrying_unexpected_fields_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError) as error:
            self.call(
                module,
                clearance="verified",
                evidence={**EVIDENCE, "sync_state": "Verified"},
            )
        self.assertIn("production_gate_invalid_input", str(error.exception))

    def test_a_receipt_with_no_stored_bytes_is_refused(self):
        module, _fixtures, _db, _calls = self.load_api()
        with self.assertRaises(FakeValidationError):
            self.call(
                module, clearance="verified", evidence={**EVIDENCE, "content_length": 0}
            )

    def test_a_gate_with_no_due_date_cannot_be_made_ready(self):
        module, _fixtures, _db, _calls = self.load_api(
            self.fixtures(gate={"due_at": None})
        )
        with self.assertRaises(FakeValidationError) as error:
            self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        self.assertIn("production_gate_due_at_missing", str(error.exception))

    def test_the_same_verified_clearance_twice_converges(self):
        module, fixtures, _db, _calls = self.load_api()
        self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        before = dict(fixtures["gates"]["gate:job-122:Weather"])
        result = self.call(module, clearance="verified", evidence=dict(EVIDENCE))
        self.assertTrue(result["replayed"])
        self.assertEqual(fixtures["gates"]["gate:job-122:Weather"], before)
        self.assertEqual(len(fixtures["evidence"]), 1)


if __name__ == "__main__":
    unittest.main()
