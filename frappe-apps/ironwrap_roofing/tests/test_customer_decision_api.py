"""Bounded customer-portal decision command, wired to the real document guards.

The point of this module is the wiring, not the command in isolation.  ELEC-95
found that ``record_customer_portal_material_decision`` had never once saved a
decision for a real customer: it inserts a Verified Evidence Item as the
dedicated customer-decision identity, and ``validate_evidence_verification_mutation``
had no branch for that identity, so every insert threw.  No test caught it
because every API-level test in this app substitutes a stub
``ironwrap_roofing.document_validation`` module -- the issuance context becomes a
no-op ``@contextmanager`` and the guard never runs (see
``tests/test_fleet_operations_api.py`` for the shape).

So this module loads the *real* ``document_validation`` module and runs the real
``Evidence Item`` controller chain from ``FakeDocument.insert``.  Only ``frappe``
itself is faked.  ``test_evidence_item_controller_matches_the_validator_chain``
pins the mirror to the shipped controller so it cannot drift.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import (
    CUSTOMER_ACCEPTANCE_SERVICE_ROLE,
    CUSTOMER_DECISION_SERVICE_ROLE,
)


APP_ROOT = Path(__file__).resolve().parents[1] / "ironwrap_roofing"
API_PATH = APP_ROOT / "customer_decision_api.py"
VALIDATION_PATH = APP_ROOT / "document_validation.py"
EVIDENCE_ITEM_CONTROLLER_PATH = (
    APP_ROOT / "ironwrap_roofing" / "doctype" / "evidence_item" / "evidence_item.py"
)

SERVICE_USER = "ironwrap-customer-decision@ironwrap.local"
HMAC_KEY = "test-customer-decision-hmac-key"
DECISION_ID = "decision_0a1b2c3d4e5f6071"
RECORD_PATH = (
    "/api/method/ironwrap_roofing.customer_decision_api."
    "record_customer_portal_material_decision"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeNonceCache:
    def __init__(self) -> None:
        self.reserved: set[str] = set()

    def make_key(self, name: str) -> str:
        return name

    def set(self, *, name: str, value: str, nx: bool, ex: int) -> bool:
        if nx and name in self.reserved:
            return False
        self.reserved.add(name)
        return True


class FakeDb:
    """Answers exactly the ``FOR UPDATE`` reads the bounded command issues."""

    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.locked: list[str] = []

    def sql(self, query: str, values, *, as_dict: bool = False):
        normalized = " ".join(query.split())
        if "`tabRoof Job`" in normalized:
            self.locked.append("Roof Job")
            return [
                dict(row)
                for row in self.fixtures["jobs"]
                if row["roof_job_id"] == values[0]
            ]
        if "`tabRoofing Customer`" in normalized:
            self.locked.append("Roofing Customer")
            return [
                dict(row)
                for row in self.fixtures["customers"]
                if row["customer_id"] == values[0]
            ]
        if "`tabOption Package`" in normalized:
            self.locked.append("Option Package")
            return [
                dict(row)
                for row in self.fixtures["packages"]
                if row["option_package_id"] == values[0]
            ]
        if "`tabCustomer Decision`" in normalized:
            self.locked.append("Customer Decision")
            return [
                dict(row)
                for row in self.fixtures["decisions"]
                if row["decision_id"] == values[0]
            ]
        if "`tabEvidence Item`" in normalized:
            self.locked.append("Evidence Item")
            return [
                dict(row)
                for row in self.fixtures["evidence"]
                if row["evidence_id"] == values[0]
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")

    def get_value(self, _doctype, _name, _fields, **_kwargs):
        return None

    def exists(self, _doctype, name):
        return bool(name)

    def count(self, _doctype, filters=None):
        return 0


class FakeDocument(dict):
    """A document whose ``insert`` runs the shipped controller's validators."""

    def __init__(self, values: dict, validators, on_insert) -> None:
        super().__init__(values)
        object.__setattr__(self, "_validators", validators)
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

    def get_doc_before_save(self):
        return None

    def insert(self) -> None:
        for validate in self._validators.get(self["doctype"], ()):
            validate(self)
        self["name"] = self.get("evidence_id") or self.get("decision_id")
        self._on_insert(self)


class CustomerDecisionApiTests(unittest.TestCase):
    def fixtures(self) -> dict:
        return {
            "jobs": [
                {
                    "name": "job-1",
                    "roof_job_id": "RJ-ELEC110-0001",
                    "customer": "customer-1",
                }
            ],
            "customers": [
                {
                    "name": "customer-1",
                    "customer_id": "CUST-ELEC110-0001",
                    "display_name": "Willow Bend Residence",
                }
            ],
            "packages": [
                {
                    "name": "package-better",
                    "option_package_id": "OP-ELEC110-BETTER",
                    "roof_job": "job-1",
                    "package_name": "Standing Seam Charcoal",
                    "tier": "Better",
                    "status": "Approved",
                }
            ],
            "decisions": [],
            "evidence": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = SERVICE_USER,
        roles: list[str] | None = None,
    ):
        """Load the command against the real validators, faking only ``frappe``."""

        fixtures = fixtures if fixtures is not None else self.fixtures()
        db = FakeDb(fixtures)
        nonce_cache = FakeNonceCache()

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.cache = lambda: nonce_cache
        frappe_module.conf = {
            "ironwrap_customer_decision_service_user": SERVICE_USER,
            "ironwrap_customer_decision_hmac_key": HMAC_KEY,
        }
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method="POST", headers={})
        frappe_module.flags = types.SimpleNamespace(allow_legacy_authority_context=True)
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else [CUSTOMER_DECISION_SERVICE_ROLE]
        )
        frappe_module.has_permission = lambda *args, **kwargs: True
        frappe_module.get_all = lambda _doctype, **_kwargs: []
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-08-20 21:15:00"
        )
        frappe_module.whitelist = lambda: lambda function: function

        def throw(message, *, exc):
            raise exc(message)

        frappe_module.throw = throw

        validation = self.load_module(
            "ironwrap_customer_decision_validation_under_test",
            VALIDATION_PATH,
            frappe_module,
        )
        # The shipped Evidence Item controller, mirrored -- see
        # test_evidence_item_controller_matches_the_validator_chain.
        validators = {
            "Evidence Item": (
                validation.validate_facet_design_projection_evidence_mutation,
                validation.validate_evidence_verification_mutation,
                lambda document: validation.validate_business_document(
                    document, "evidence_item"
                ),
            ),
            "Customer Decision": (
                lambda document: validation.validate_business_document(
                    document, "customer_decision"
                ),
            ),
        }

        def on_insert(document: FakeDocument) -> None:
            if document["doctype"] == "Evidence Item":
                fixtures["evidence"].append(dict(document))
            else:
                fixtures["decisions"].append(dict(document))

        frappe_module.get_doc = lambda values: FakeDocument(
            dict(values), validators, on_insert
        )

        api = self.load_module(
            "ironwrap_customer_decision_api_under_test",
            API_PATH,
            frappe_module,
            extra_modules={"ironwrap_roofing.document_validation": validation},
        )
        return api, validation, fixtures, db, frappe_module

    @staticmethod
    def load_module(name: str, path: Path, frappe_module, *, extra_modules=None):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        modules = {"frappe": frappe_module, **(extra_modules or {})}
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(module)
        return module

    @staticmethod
    def canonical(payload: dict) -> str:
        return json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )

    def claim(self, **overrides) -> dict:
        payload = {
            "decision_id": DECISION_ID,
            "portal_link_id": "portal-link-000110",
            "tenant_id": "ironwrap",
            "roof_job_id": "RJ-ELEC110-0001",
            "customer_id": "CUST-ELEC110-0001",
            "option_package_id": "OP-ELEC110-BETTER",
            "option_label": "Standing Seam Charcoal",
            "selected_at": "2026-08-20T21:14:31Z",
            "receipt_key": "receipts/customer-portal/decision/RJ-ELEC110-0001.json",
            "receipt_hash": "c" * 64,
            "receipt_content_type": "application/json",
            "receipt_content_length": 412,
            "receipt_captured_at": "2026-08-20T21:14:32Z",
        }
        payload.update(overrides)
        return payload

    def signed(self, frappe_module, payload: dict, *, nonce: str = "elec110nonce0001") -> str:
        claim_json = self.canonical(payload)
        timestamp = str(int(time.time()))
        body_hash = hashlib.sha256(claim_json.encode("utf-8")).hexdigest()
        signed = f"POST\n{RECORD_PATH}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(HMAC_KEY.encode("utf-8"), signed, hashlib.sha256).digest()
            )
            .rstrip(b"=")
            .decode("ascii")
        )
        frappe_module.request.headers = {
            "X-IronWrap-Decision-Timestamp": timestamp,
            "X-IronWrap-Decision-Nonce": nonce,
            "X-IronWrap-Decision-Signature": signature,
        }
        return claim_json

    def test_a_real_customer_choice_saves_through_the_real_evidence_guard(self) -> None:
        """ELEC-95's repro: this failed on every job, for every customer, before the fix."""

        api, _validation, fixtures, db, frappe_module = self.load_api()
        claim_json = self.signed(frappe_module, self.claim())

        result = api.record_customer_portal_material_decision(claim_json)

        self.assertEqual(result, {"decision_id": DECISION_ID})
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["decisions"]), 1)
        evidence = fixtures["evidence"][0]
        decision = fixtures["decisions"][0]
        self.assertEqual(evidence["evidence_id"], f"decision-receipt:{DECISION_ID}")
        self.assertEqual(evidence["sync_state"], "Verified")
        self.assertEqual(evidence["proof_owner"], SERVICE_USER)
        self.assertEqual(
            evidence["verification_source"],
            "ironwrap-worker-r2-customer-portal-decision",
        )
        self.assertEqual(decision["roof_job"], "job-1")
        self.assertEqual(decision["customer"], "customer-1")
        self.assertEqual(decision["option_package"], "package-better")
        self.assertEqual(decision["status"], "Recorded")
        self.assertEqual(decision["evidence_item"], evidence["evidence_id"])
        # The lineage is re-locked by Frappe, not trusted from the Worker's read.
        self.assertEqual(
            db.locked[:3], ["Roof Job", "Roofing Customer", "Option Package"]
        )

    def test_the_decision_identity_cannot_verify_evidence_outside_its_command(
        self,
    ) -> None:
        """The grant is one receipt from one bounded call -- not a standing privilege."""

        _api, validation, _fixtures, _db, _frappe_module = self.load_api()
        forged = FakeDocument(
            {
                "doctype": "Evidence Item",
                "evidence_id": "decision-receipt:forged",
                "roof_job": "job-1",
                "sync_state": "Verified",
                "verification_source": "ironwrap-worker-r2-customer-portal-decision",
            },
            {},
            lambda _document: None,
        )
        with self.assertRaisesRegex(
            FakePermissionError, "bounded customer portal decision command"
        ):
            validation.validate_evidence_verification_mutation(forged)

    def test_the_trusted_context_authorizes_only_the_document_it_was_opened_for(
        self,
    ) -> None:
        """A second, different receipt cannot ride along on an open context."""

        _api, validation, _fixtures, _db, _frappe_module = self.load_api()
        issued = FakeDocument(
            {
                "doctype": "Evidence Item",
                "evidence_id": f"decision-receipt:{DECISION_ID}",
                "roof_job": "job-1",
                "r2_key": "receipts/customer-portal/decision/RJ-ELEC110-0001.json",
                "sync_state": "Verified",
            },
            {},
            lambda _document: None,
        )
        smuggled = FakeDocument(
            {**issued, "evidence_id": "decision-receipt:smuggled"},
            {},
            lambda _document: None,
        )
        with validation.customer_decision_issuance_context(issued):
            validation.validate_evidence_verification_mutation(issued)
            with self.assertRaisesRegex(
                FakePermissionError, "bounded customer portal decision command"
            ):
                validation.validate_evidence_verification_mutation(smuggled)
        # And the authority does not outlive the ``with`` block.
        with self.assertRaisesRegex(
            FakePermissionError, "bounded customer portal decision command"
        ):
            validation.validate_evidence_verification_mutation(issued)

    def test_the_decision_context_grants_no_authority_to_another_service_identity(
        self,
    ) -> None:
        """An open decision context must not verify an acceptance-lane receipt."""

        _api, validation, _fixtures, _db, _frappe_module = self.load_api(
            session_user="ironwrap-customer-acceptance@ironwrap.local",
            roles=[CUSTOMER_ACCEPTANCE_SERVICE_ROLE],
        )
        receipt = FakeDocument(
            {
                "doctype": "Evidence Item",
                "evidence_id": "contract-receipt:accept-1",
                "roof_job": "job-1",
                "sync_state": "Verified",
            },
            {},
            lambda _document: None,
        )
        with validation.customer_decision_issuance_context(receipt):
            with self.assertRaisesRegex(
                FakePermissionError, "bounded customer contract command"
            ):
                validation.validate_evidence_verification_mutation(receipt)

    def test_replay_of_the_same_decision_returns_without_a_second_write(self) -> None:
        api, _validation, fixtures, _db, frappe_module = self.load_api()
        first = self.signed(frappe_module, self.claim(), nonce="elec110nonce0001")
        api.record_customer_portal_material_decision(first)
        second = self.signed(frappe_module, self.claim(), nonce="elec110nonce0002")

        self.assertEqual(
            api.record_customer_portal_material_decision(second),
            {"decision_id": DECISION_ID},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["decisions"]), 1)

    def test_a_retired_option_package_cannot_be_chosen(self) -> None:
        fixtures = self.fixtures()
        fixtures["packages"][0]["status"] = "Superseded"
        api, _validation, _fixtures, _db, frappe_module = self.load_api(fixtures)
        claim_json = self.signed(frappe_module, self.claim())

        with self.assertRaisesRegex(
            FakeValidationError, "customer_decision_option_package_not_selectable"
        ):
            api.record_customer_portal_material_decision(claim_json)

    def test_claim_instants_are_stored_as_frappe_datetimes_not_rfc_3339(self) -> None:
        """MariaDB rejects `...Z` outright for a DATETIME column (ELEC-92, same class).

        The guard refusal this module's headline test covers hid this one: no write
        ever reached the insert, so the RFC 3339 text never met the column.
        """

        api, _validation, fixtures, _db, frappe_module = self.load_api()
        claim_json = self.signed(frappe_module, self.claim())

        api.record_customer_portal_material_decision(claim_json)

        evidence = fixtures["evidence"][0]
        decision = fixtures["decisions"][0]
        self.assertEqual(evidence["captured_at"], "2026-08-20 21:14:32")
        self.assertEqual(decision["decided_at"], "2026-08-20 21:14:31")
        for value in (evidence["captured_at"], decision["decided_at"]):
            self.assertNotIn("T", value)
            self.assertNotIn("Z", value)

    def test_a_replay_matches_the_stored_datetime_not_the_claim_text(self) -> None:
        """Frappe hands a DATETIME column back as `datetime`; the replay must still match."""

        from datetime import datetime as real_datetime

        fixtures = self.fixtures()
        api, _validation, _fixtures, _db, frappe_module = self.load_api(fixtures)
        api.record_customer_portal_material_decision(
            self.signed(frappe_module, self.claim(), nonce="elec110nonce0011")
        )
        # Re-read as Frappe would: the stored columns come back as datetime objects.
        for row in (*fixtures["evidence"], *fixtures["decisions"]):
            for field in ("captured_at", "decided_at", "verified_at"):
                if isinstance(row.get(field), str):
                    row[field] = real_datetime.fromisoformat(row[field])

        self.assertEqual(
            api.record_customer_portal_material_decision(
                self.signed(frappe_module, self.claim(), nonce="elec110nonce0012")
            ),
            {"decision_id": DECISION_ID},
        )
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["decisions"]), 1)

    def test_evidence_item_controller_matches_the_validator_chain(self) -> None:
        """Keep ``load_api``'s mirror honest against the shipped controller."""

        controller = EVIDENCE_ITEM_CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "validate_facet_design_projection_evidence_mutation(self)", controller
        )
        self.assertIn("validate_evidence_verification_mutation(self)", controller)
        self.assertIn('validate_business_document(self, "evidence_item")', controller)

    def test_the_command_opens_the_trusted_context_around_the_insert(self) -> None:
        """Pin the wiring: the guard is satisfied by the context, not by a stub."""

        source = API_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "from ironwrap_roofing.document_validation import "
            "customer_decision_issuance_context",
            source,
        )
        self.assertIn("with customer_decision_issuance_context(", source)


if __name__ == "__main__":
    unittest.main()
