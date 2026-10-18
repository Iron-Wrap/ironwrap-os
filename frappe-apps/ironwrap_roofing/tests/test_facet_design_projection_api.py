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
from contextlib import contextmanager
from datetime import timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import FACET_DESIGN_PROJECTION_SERVICE_ROLE


API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "facet_design_projection_api.py"
)
VALIDATION_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "document_validation.py"
)
DOCTYPE_DIR = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
)
SERVICE_USER = "facet-projection@example.invalid"
HMAC_KEY = "facet-projection-test-secret-longer-than-thirty-two-characters"
# A deliberately non-UTC site clock, so an implementation that passed the claim's
# ISO-8601 "Z" string straight through cannot match. A fixed offset rather than a
# named zone: the tenant's own America/Edmonton resolves differently across tzdata
# versions for a date this far out, and this test is about the conversion
# happening, not about which zone the site is configured for.
SITE_TIMEZONE = timezone(timedelta(hours=-7), "UTC-07:00 fixture")


SITE_CLOCK_CONVERSIONS: list = []


def convert_utc_to_system_timezone(value):
    """Stand in for ``frappe.utils.convert_utc_to_system_timezone``.

    Every call is recorded.  A value this command *stores* must never be routed
    through the site clock -- naive Frappe Datetimes are UTC here -- so "was this
    consulted at all?" is itself an assertion, not only the value it returned.
    """

    SITE_CLOCK_CONVERSIONS.append(value)
    return value.replace(tzinfo=timezone.utc).astimezone(SITE_TIMEZONE)


def doctype_schema(doctype: str) -> dict:
    slug = doctype.lower().replace(" ", "_")
    return json.loads((DOCTYPE_DIR / slug / f"{slug}.json").read_text())


class FakeMeta:
    """Just enough of ``frappe.get_meta`` to answer "what fieldtype is this?"."""

    def __init__(self, doctype: str) -> None:
        self.fields = [
            types.SimpleNamespace(**field) for field in doctype_schema(doctype)["fields"]
        ]

    def get_field(self, fieldname: str):
        return next(
            (field for field in self.fields if field.fieldname == fieldname), None
        )


def doctype_defaults(doctype: str) -> dict:
    """The new-document values a real Frappe site stamps for this DocType.

    Read from the committed DocType JSON rather than restated here, so the
    harness cannot drift from the schema it is meant to stand in for.  Frappe
    fills a new document from two static sources: an explicit ``default``, and -
    for ``Select`` - the first option when it is not blank.  ``Customer Quote``
    exercises both (``currency`` -> ``CAD`` by default, ``payment_status`` ->
    ``Not Due`` by either rule).
    """

    schema = doctype_schema(doctype)
    defaults: dict = {"doctype": doctype}
    for field in schema.get("fields", []):
        value = field.get("default")
        if not value and field.get("fieldtype") == "Select":
            value = (field.get("options") or "").split("\n")[0].strip()
        if value:
            defaults[field["fieldname"]] = value
    return defaults


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeNonceCache:
    def __init__(self) -> None:
        self.values: set[str] = set()

    @staticmethod
    def make_key(value: str) -> str:
        return value

    def set(self, *, name: str, value: str, nx: bool, ex: int) -> bool:
        del value, ex
        if not nx or name in self.values:
            return False
        self.values.add(name)
        return True


class FakeDocument(dict):
    def __init__(self, values: dict, on_insert, on_save=None, on_validate=None) -> None:
        super().__init__(values)
        object.__setattr__(self, "_on_insert", on_insert)
        object.__setattr__(self, "_on_save", on_save)
        object.__setattr__(self, "_on_validate", on_validate)

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
        # Frappe's ordering, which the projection has to survive: defaults are
        # applied to still-unset fields (``_set_defaults`` -> ``update_if_missing``)
        # and the row is autonamed, both *before* ``validate`` runs.
        for field, value in doctype_defaults(self["doctype"]).items():
            if self.get(field) is None:
                self[field] = value
        identity = (
            self.get("customer_quote_id")
            or self.get("evidence_id")
            or self.get("reconciliation_id")
        )
        self["name"] = identity
        if self._on_validate is not None:
            self._on_validate(self)
        self._on_insert(self)

    def save(self) -> None:
        if self._on_save is None:
            raise AssertionError("document is not persisted")
        self._on_save(self)


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[str] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        del as_dict
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append(normalized)
        value = values[0]
        if "`tabRoof Job`" in normalized:
            job = self.fixtures["job"]
            return [dict(job)] if job.get("roof_job_id") == value else []
        if "`tabCustomer Quote`" in normalized:
            return [
                dict(quote)
                for quote in self.fixtures["quotes"]
                if quote.get("roof_job") == value
            ]
        if "`tabEvidence Item`" in normalized:
            return [
                dict(item)
                for item in self.fixtures["evidence"]
                if item.get("evidence_id") == value
            ]
        if "`tabIntegration Reconciliation`" in normalized:
            return [
                dict(item)
                for item in self.fixtures["reconciliations"]
                if item.get("reconciliation_id") == value
            ]
        raise AssertionError(f"unexpected SQL: {normalized}")


class FacetDesignProjectionApiTests(unittest.TestCase):
    @staticmethod
    def canonical(payload: dict) -> str:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @classmethod
    def claim(cls, **overrides) -> dict:
        event_id = "44444444-4444-4444-8444-444444444444"
        project_id = "11111111-1111-4111-8111-111111111111"
        source_tenant = "22222222-2222-4222-8222-222222222222"
        values = {
            "approval_receipt_id": "33333333-3333-4333-8333-333333333333",
            "approval_receipt_sha256": "d" * 64,
            "association_sha256": "",
            "brand_id": "ironwrap",
            "customer_party_ref": "a" * 64,
            "customer_quote_id": "customer-quote-0001",
            "decision_kind": "approved",
            "design_revision_id": f"facet-json-v1:{'e' * 64}",
            "design_revision_sha256": "e" * 64,
            "destination_tenant_id": "ironwrap",
            "event_id": event_id,
            "event_type": "facet.design.customer_approved.v2",
            "external_customer_identity_link_id": f"facet-customer-oidc-v1:{'f' * 64}",
            "external_project_link_id": f"ironwrap-project-v1:{'2' * 64}",
            "facet_project_id": project_id,
            "frozen_evidence_sha256": "c" * 64,
            "identity_assurance": "oidc",
            "occurred_at": "2027-01-15T08:00:00.000Z",
            "oidc_issuer": "https://accounts.google.com",
            "oidc_subject_sha256": "b" * 64,
            "previous_event_id": None,
            "producer_identity_link_id": f"ironwrap-identity-v1:{'3' * 64}",
            "raw_content_length": 512,
            "raw_key": f"facet-design/v2/raw/{'9' * 64}.json",
            "raw_sha256": "9" * 64,
            "reason_sha256": None,
            "received_at": "2027-01-15T08:00:01.000Z",
            "roof_job_id": "roof-job-0001",
            "schema_version": 2,
            "source_environment": "production",
            "source_issuer": "facet",
            "source_tenant_id": source_tenant,
        }
        values.update(overrides)
        association = {
            "brand_id": values["brand_id"],
            "customer_party_ref": values["customer_party_ref"],
            "customer_quote_id": values["customer_quote_id"],
            "destination_tenant_id": values["destination_tenant_id"],
            "external_customer_identity_link_id": values[
                "external_customer_identity_link_id"
            ],
            "external_project_link_id": values["external_project_link_id"],
            "facet_project_id": values["facet_project_id"],
            "producer_identity_link_id": values["producer_identity_link_id"],
            "roof_job_id": values["roof_job_id"],
            "source_tenant_id": values["source_tenant_id"],
        }
        if not overrides.get("association_sha256"):
            values["association_sha256"] = hashlib.sha256(
                cls.canonical(association).encode()
            ).hexdigest()
        return values

    @staticmethod
    def fixtures() -> dict:
        source = {
            "name": "QUOTE-001",
            "customer_quote_id": "customer-quote-0001",
            "roof_job": "JOB-001",
            "customer": "CUSTOMER-001",
            "quote_version": 2,
            "status": "Approved",
            "contract_acceptance": None,
            "accepted_at": None,
            "price_book_version": "source-price-book",
            "quote_total": 42_000,
        }
        return {
            "job": {
                "name": "JOB-001",
                "roof_job_id": "roof-job-0001",
                "brand": "ironwrap",
                "quotation": "QUOTE-001",
            },
            "quotes": [source],
            "evidence": [],
            "reconciliations": [],
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = SERVICE_USER,
        roles: list[str] | None = None,
        permission: bool = True,
        request_method: str = "POST",
        hmac_key: str = HMAC_KEY,
    ):
        fixtures = fixtures or self.fixtures()
        db = FakeDb(fixtures)
        cache = FakeNonceCache()
        issuance_calls: list[tuple[dict, dict, dict | None, dict | None]] = []

        @contextmanager
        def facet_design_projection_issuance_context(
            evidence, reconciliation, quote=None, invalidated_quote=None
        ):
            issuance_calls.append(
                (
                    dict(evidence),
                    dict(reconciliation),
                    dict(quote) if quote is not None else None,
                    dict(invalidated_quote) if invalidated_quote is not None else None,
                )
            )
            yield

        validation = types.ModuleType("ironwrap_roofing.document_validation")
        validation.facet_design_projection_issuance_context = (
            facet_design_projection_issuance_context
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.cache = lambda: cache
        frappe_module.conf = {
            "ironwrap_facet_design_projection_service_user": SERVICE_USER,
            "ironwrap_facet_design_projection_hmac_key": hmac_key,
        }
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method, headers={})
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else [FACET_DESIGN_PROJECTION_SERVICE_ROLE]
        )
        frappe_module.has_permission = lambda *args, **kwargs: permission
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2027-01-15 08:00:02",
            convert_utc_to_system_timezone=convert_utc_to_system_timezone,
        )
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.new_doc = lambda doctype, as_dict=False: doctype_defaults(doctype)
        frappe_module.get_meta = lambda doctype: FakeMeta(doctype)

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw

        def on_insert(document: FakeDocument) -> None:
            if document["doctype"] == "Customer Quote":
                fixtures["quotes"].append(dict(document))
            elif document["doctype"] == "Evidence Item":
                fixtures["evidence"].append(dict(document))
            elif document["doctype"] == "Integration Reconciliation":
                fixtures["reconciliations"].append(dict(document))
            else:
                raise AssertionError(f"unexpected document: {document['doctype']}")

        def get_doc(values, name=None):
            if isinstance(values, dict) and name is None:
                return FakeDocument(dict(values), on_insert)
            if values == "Customer Quote" and isinstance(name, str):
                stored = next(
                    (
                        quote
                        for quote in fixtures["quotes"]
                        if quote.get("name") == name
                    ),
                    None,
                )
                if stored is None:
                    raise AssertionError(f"missing Customer Quote {name}")

                def on_save(document: FakeDocument) -> None:
                    stored.clear()
                    stored.update(dict(document))

                return FakeDocument(dict(stored), on_insert, on_save)
            raise AssertionError(f"unexpected get_doc: {values}, {name}")

        frappe_module.get_doc = get_doc
        spec = importlib.util.spec_from_file_location(
            "ironwrap_facet_design_projection_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                "frappe": frappe_module,
                "ironwrap_roofing.document_validation": validation,
            },
        ):
            spec.loader.exec_module(module)
        return module, fixtures, db, issuance_calls, frappe_module

    def call(self, api, frappe_module, claim: dict, *, nonce: str) -> dict:
        raw = self.canonical(claim)
        timestamp = str(int(time.time()))
        body_hash = hashlib.sha256(raw.encode()).hexdigest()
        signing_input = f"POST\n{api.COMMAND_PATH}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = base64.urlsafe_b64encode(
            hmac.new(HMAC_KEY.encode(), signing_input.encode(), hashlib.sha256).digest()
        ).rstrip(b"=").decode()
        frappe_module.request.headers = {
            "x-ironwrap-facet-projection-timestamp": timestamp,
            "x-ironwrap-facet-projection-nonce": nonce,
            "x-ironwrap-facet-projection-signature": signature,
        }
        return api.record_facet_design_proposal_evidence(raw)

    def assert_receipt(self, api, result: dict, claim: dict, *, replay: bool) -> None:
        receipt_sha = hashlib.sha256(
            self.canonical(result["receipt"]).encode()
        ).hexdigest()
        signature = base64.urlsafe_b64encode(
            hmac.new(
                HMAC_KEY.encode(),
                f"{api.RECEIPT_SIGNATURE_CONTEXT}\n{receipt_sha}".encode(),
                hashlib.sha256,
            ).digest()
        ).rstrip(b"=").decode()
        self.assertEqual(result["receipt_sha256"], receipt_sha)
        self.assertEqual(result["receipt_signature"], signature)
        self.assertEqual(result["receipt_signature_algorithm"], "HMAC-SHA256")
        receipt = result["receipt"]
        self.assertEqual(receipt["claim_sha256"], hashlib.sha256(self.canonical(claim).encode()).hexdigest())
        self.assertEqual(receipt["actor_identity_assurance"], "oidc")
        active = claim["decision_kind"] in {"approved", "corrected"}
        self.assertEqual(
            receipt["draft_quote_status"], "Draft" if active else "Rejected"
        )
        self.assertEqual(receipt["blank_commercial_revision"], active)
        self.assertFalse(receipt["customer_safe"])
        self.assertEqual(receipt["idempotent_replay"], replay)

    def test_exact_v2_claim_creates_one_blank_draft_and_replays(self) -> None:
        api, fixtures, db, issuance_calls, frappe_module = self.load_api()
        claim = self.claim()
        first = self.call(api, frappe_module, claim, nonce="a" * 32)
        event_hash = hashlib.sha256(claim["event_id"].encode()).hexdigest()
        draft_id = f"facet-quote-revision:{event_hash}"
        self.assertEqual(first["draft_customer_quote_id"], draft_id)
        self.assertEqual(first["draft_quote_version"], 3)
        self.assertFalse(first["idempotent_replay"])
        self.assert_receipt(api, first, claim, replay=False)
        self.assertEqual(len(fixtures["quotes"]), 2)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        draft = fixtures["quotes"][1]
        self.assertEqual(
            {
                "customer_quote_id": draft["customer_quote_id"],
                "roof_job": draft["roof_job"],
                "customer": draft["customer"],
                "quote_version": draft["quote_version"],
                "status": draft["status"],
                "supersedes": draft["supersedes"],
            },
            {
                "customer_quote_id": draft_id,
                "roof_job": "JOB-001",
                "customer": "CUSTOMER-001",
                "quote_version": 3,
                "status": "Draft",
                "supersedes": "QUOTE-001",
            },
        )
        # Blank means "carries no commercial fact", not "literally empty": a real
        # site stamps the DocType's own currency and payment status on insert.
        defaults = doctype_defaults("Customer Quote")
        self.assertEqual(
            {
                field: draft[field]
                for field in api.BLANK_QUOTE_FIELDS
                if draft[field] is not None
            },
            {"currency": "CAD", "payment_status": "Not Due"},
        )
        self.assertTrue(
            all(
                draft[field] is None or draft[field] == defaults.get(field)
                for field in api.BLANK_QUOTE_FIELDS
            )
        )
        self.assertEqual(api._commercial_violations(draft), ())
        self.assertEqual(len(issuance_calls), 1)
        self.assertNotEqual(
            claim["external_customer_identity_link_id"].removeprefix(
                "facet-customer-oidc-v1:"
            ),
            claim["oidc_subject_sha256"],
        )
        self.assertTrue(all("FOR UPDATE" in query for query in db.lock_queries))
        replay = self.call(api, frappe_module, claim, nonce="b" * 32)
        self.assertTrue(replay["idempotent_replay"])
        self.assert_receipt(api, replay, claim, replay=True)
        self.assertEqual(len(fixtures["quotes"]), 2)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)
        self.assertEqual(len(issuance_calls), 1)

    def test_correction_rejects_the_prior_draft_and_only_the_new_chain_head_is_operable(
        self,
    ) -> None:
        api, fixtures, _, issuance_calls, frappe_module = self.load_api()
        approved = self.claim()
        first = self.call(api, frappe_module, approved, nonce="u" * 32)
        corrected = self.claim(
            event_id="55555555-5555-4555-8555-555555555555",
            decision_kind="corrected",
            previous_event_id=approved["event_id"],
            reason_sha256="8" * 64,
            occurred_at="2027-01-15T08:01:00.000Z",
            received_at="2027-01-15T08:01:01.000Z",
        )
        second = self.call(api, frappe_module, corrected, nonce="v" * 32)
        prior = next(
            quote
            for quote in fixtures["quotes"]
            if quote["customer_quote_id"] == first["draft_customer_quote_id"]
        )
        current = next(
            quote
            for quote in fixtures["quotes"]
            if quote["customer_quote_id"] == second["draft_customer_quote_id"]
        )
        self.assertEqual(prior["status"], "Rejected")
        self.assertEqual(current["status"], "Draft")
        self.assertEqual(current["supersedes"], prior["name"])
        self.assertEqual(len(fixtures["evidence"]), 2)
        self.assertEqual(len(fixtures["reconciliations"]), 2)
        self.assertEqual(len(issuance_calls), 2)
        replay = self.call(api, frappe_module, corrected, nonce="w" * 32)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(len(fixtures["quotes"]), 3)
        self.assertEqual(len(fixtures["reconciliations"]), 2)

    def test_withdrawal_and_supersession_project_a_terminal_hold_on_the_prior_draft(
        self,
    ) -> None:
        for index, decision in enumerate(("withdrawn", "superseded")):
            with self.subTest(decision=decision):
                api, fixtures, _, _, frappe_module = self.load_api()
                approved = self.claim()
                first = self.call(
                    api,
                    frappe_module,
                    approved,
                    nonce=("x" if index == 0 else "j") * 32,
                )
                terminal = self.claim(
                    event_id=(
                        "66666666-6666-4666-8666-666666666666"
                        if decision == "withdrawn"
                        else "77777777-7777-4777-8777-777777777777"
                    ),
                    decision_kind=decision,
                    previous_event_id=approved["event_id"],
                    reason_sha256="9" * 64,
                    occurred_at="2027-01-15T08:02:00.000Z",
                    received_at="2027-01-15T08:02:01.000Z",
                )
                held = self.call(
                    api,
                    frappe_module,
                    terminal,
                    nonce=("z" if index == 0 else "k") * 32,
                )
                self.assertEqual(
                    held["draft_customer_quote_id"], first["draft_customer_quote_id"]
                )
                self.assertEqual(held["receipt"]["draft_quote_status"], "Rejected")
                self.assertFalse(held["receipt"]["blank_commercial_revision"])
                self.assertEqual(len(fixtures["quotes"]), 2)
                self.assertEqual(fixtures["quotes"][1]["status"], "Rejected")
                self.assertEqual(
                    fixtures["reconciliations"][-1]["status"], "Superseded"
                )
                replay = self.call(
                    api,
                    frappe_module,
                    terminal,
                    nonce=("n" if index == 0 else "l") * 32,
                )
                self.assertTrue(replay["idempotent_replay"])

    def test_correction_rejects_external_email_link_or_oidc_subject_drift_independently(
        self,
    ) -> None:
        for index, drift in enumerate(("external", "subject")):
            with self.subTest(drift=drift):
                api, fixtures, _, _, frappe_module = self.load_api()
                approved = self.claim()
                self.call(api, frappe_module, approved, nonce=chr(100 + index) * 32)
                overrides = {
                    "event_id": (
                        "88888888-8888-4888-8888-888888888888"
                        if drift == "external"
                        else "99999999-9999-4999-8999-999999999999"
                    ),
                    "decision_kind": "corrected",
                    "previous_event_id": approved["event_id"],
                    "reason_sha256": "7" * 64,
                    "occurred_at": "2027-01-15T08:03:00.000Z",
                    "received_at": "2027-01-15T08:03:01.000Z",
                }
                if drift == "external":
                    overrides["external_customer_identity_link_id"] = (
                        f"facet-customer-oidc-v1:{'1' * 64}"
                    )
                else:
                    overrides["oidc_subject_sha256"] = "1" * 64
                correction = self.claim(**overrides)
                with self.assertRaisesRegex(
                    FakeValidationError, "predecessor_authority_mismatch"
                ):
                    self.call(
                        api,
                        frappe_module,
                        correction,
                        nonce=chr(102 + index) * 32,
                    )
                self.assertEqual(len(fixtures["quotes"]), 2)
                self.assertEqual(fixtures["quotes"][1]["status"], "Draft")

    def test_rejects_legacy_bearer_identity_association_and_raw_key_drift(self) -> None:
        invalid = (
            ({**self.claim(), "event_type": "facet.design.approved.v1"}, "event_version_mismatch"),
            ({**self.claim(), "identity_assurance": "bearer_capability_only"}, "identity_assurance_mismatch"),
            ({**self.claim(), "association_sha256": "0" * 64}, "association_mismatch"),
            ({**self.claim(), "raw_key": f"facet-design/v2/raw/{'8' * 64}.json"}, "raw_key_mismatch"),
            ({**self.claim(), "customer_address": "not allowed"}, "invalid_claim"),
        )
        for index, (claim, code) in enumerate(invalid):
            with self.subTest(code=code):
                api, fixtures, _, _, frappe_module = self.load_api()
                with self.assertRaisesRegex(FakeValidationError, code):
                    self.call(api, frappe_module, claim, nonce=chr(99 + index) * 32)
                self.assertEqual(len(fixtures["quotes"]), 1)
                self.assertEqual(fixtures["evidence"], [])

    def test_rejects_noncurrent_accepted_or_cross_brand_source_quote(self) -> None:
        mutations = (
            (lambda fixtures: fixtures["job"].update(quotation="OTHER"), "quote_job_mismatch"),
            (lambda fixtures: fixtures["quotes"][0].update(status="Accepted"), "quote_not_reviewable"),
            (lambda fixtures: fixtures["job"].update(brand="iroof"), "brand_mismatch"),
        )
        for mutate, code in mutations:
            fixtures = self.fixtures()
            mutate(fixtures)
            api, fixtures, _, _, frappe_module = self.load_api(fixtures)
            with self.assertRaisesRegex(FakeValidationError, code):
                self.call(api, frappe_module, self.claim(), nonce=code[0] * 32)
            self.assertEqual(len(fixtures["quotes"]), 1)

    def test_requires_exact_service_role_permissions_hmac_and_one_time_nonce(self) -> None:
        claim = self.claim()
        api, fixtures, _, _, frappe_module = self.load_api(
            session_user="owner@example.invalid"
        )
        with self.assertRaisesRegex(FakePermissionError, "service_user_mismatch"):
            self.call(api, frappe_module, claim, nonce="m" * 32)
        self.assertEqual(len(fixtures["quotes"]), 1)
        api, _, _, _, frappe_module = self.load_api(roles=[])
        with self.assertRaisesRegex(FakePermissionError, "service_role_missing"):
            self.call(api, frappe_module, claim, nonce="n" * 32)
        api, _, _, _, frappe_module = self.load_api(permission=False)
        with self.assertRaisesRegex(FakePermissionError, "permission_denied"):
            self.call(api, frappe_module, claim, nonce="o" * 32)
        api, _, _, _, frappe_module = self.load_api(hmac_key="short")
        with self.assertRaisesRegex(FakePermissionError, "hmac_key_invalid"):
            self.call(api, frappe_module, claim, nonce="p" * 32)
        api, _, _, _, frappe_module = self.load_api()
        self.call(api, frappe_module, claim, nonce="q" * 32)
        with self.assertRaisesRegex(FakePermissionError, "nonce_replayed"):
            self.call(api, frappe_module, claim, nonce="q" * 32)

    def test_partial_or_commercially_tampered_replay_fails_closed(self) -> None:
        claim = self.claim()
        api, fixtures, _, _, frappe_module = self.load_api()
        first = self.call(api, frappe_module, claim, nonce="r" * 32)
        fixtures["quotes"][1]["quote_total"] = 1
        with self.assertRaisesRegex(FakeValidationError, "conflict"):
            self.call(api, frappe_module, claim, nonce="s" * 32)
        fixtures = self.fixtures()
        event_hash = hashlib.sha256(claim["event_id"].encode()).hexdigest()
        fixtures["evidence"].append(
            {
                "evidence_id": f"facet-design:{event_hash}",
                "sync_state": "Verified",
                "verification_source": "ironwrap-worker-r2-facet-design-projection",
            }
        )
        api, _, _, _, frappe_module = self.load_api(fixtures)
        with self.assertRaisesRegex(FakeValidationError, "projection trio is incomplete"):
            self.call(api, frappe_module, claim, nonce="t" * 32)
        self.assertFalse(first["idempotent_replay"])


class RealTrustGuardProjectionTests(unittest.TestCase):
    """Run the bounded command against the real issuance context and guard.

    Every other test in this suite substitutes a no-op issuance context, so the
    ordering between Frappe's insert-time defaults and the trust guard is never
    observed - which is exactly why CI stayed green while step 4 was dead on
    every real site.  ``Customer Quote`` defaults ``currency`` -> ``CAD`` and
    ``payment_status`` -> ``Not Due`` inside ``insert()``, *before* ``validate``
    runs, so a trusted tuple captured against the pre-insert document authorizes
    a document that never reaches the guard and the guard refuses the very
    bounded command it exists to admit (ELEC-86 §5, against real Frappe v15)::

        PermissionError: Facet design projection service users may only mutate
        records through the bounded projection command.
        diffs: [('currency', '', 'CAD'), ('payment_status', '', 'Not Due')]

    These cases run the real ``document_validation`` guards in the same order
    the DocType controllers call them, against documents that default and
    autoname on insert the way Frappe does.
    """

    def load_validation(self):
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.session = types.SimpleNamespace(user=SERVICE_USER)
        frappe_module.get_roles = lambda _user: [FACET_DESIGN_PROJECTION_SERVICE_ROLE]
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))
        spec = importlib.util.spec_from_file_location(
            "ironwrap_document_validation_for_facet_projection", VALIDATION_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module

    def load_api(self, validation_module, fixtures: dict):
        db = FakeDb(fixtures)
        cache = FakeNonceCache()
        guarded: list[dict] = []

        # The guards each DocType controller actually runs, in the same order.
        validators = {
            "Customer Quote": (
                validation_module.validate_customer_quote_acceptance_mutation,
            ),
            "Evidence Item": (
                validation_module.validate_facet_design_projection_evidence_mutation,
                validation_module.validate_evidence_verification_mutation,
            ),
            "Integration Reconciliation": (
                validation_module.validate_quickbooks_final_invoice_mutation,
                validation_module.validate_facet_design_projection_reconciliation_mutation,
            ),
        }

        def on_validate(document: FakeDocument) -> None:
            guarded.append(dict(document))
            for validator in validators[document["doctype"]]:
                validator(document)

        def on_write(document: FakeDocument) -> None:
            if document["doctype"] == "Customer Quote":
                fixtures["quotes"].append(dict(document))
            elif document["doctype"] == "Evidence Item":
                fixtures["evidence"].append(dict(document))
            else:
                fixtures["reconciliations"].append(dict(document))

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.cache = lambda: cache
        frappe_module.conf = {
            "ironwrap_facet_design_projection_service_user": SERVICE_USER,
            "ironwrap_facet_design_projection_hmac_key": HMAC_KEY,
        }
        frappe_module.session = types.SimpleNamespace(user=SERVICE_USER)
        frappe_module.request = types.SimpleNamespace(method="POST", headers={})
        frappe_module.get_roles = lambda _user: [FACET_DESIGN_PROJECTION_SERVICE_ROLE]
        frappe_module.has_permission = lambda *args, **kwargs: True
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2027-01-15 08:00:02",
            convert_utc_to_system_timezone=convert_utc_to_system_timezone,
        )
        frappe_module.whitelist = lambda: lambda function: function
        frappe_module.new_doc = lambda doctype, as_dict=False: doctype_defaults(doctype)
        frappe_module.get_meta = lambda doctype: FakeMeta(doctype)
        frappe_module.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))

        def get_doc(values, name=None):
            if isinstance(values, dict) and name is None:
                return FakeDocument(dict(values), on_write, None, on_validate)
            stored = next(
                quote for quote in fixtures["quotes"] if quote.get("name") == name
            )

            def on_save(document: FakeDocument) -> None:
                on_validate(document)
                stored.clear()
                stored.update(dict(document))

            return FakeDocument(dict(stored), on_write, on_save, None)

        frappe_module.get_doc = get_doc
        spec = importlib.util.spec_from_file_location(
            "ironwrap_facet_design_projection_api_with_real_guard", API_PATH
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
        return module, frappe_module, guarded

    def test_the_real_guard_admits_a_draft_that_defaults_on_insert(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, frappe_module, guarded = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()

        result = FacetDesignProjectionApiTests().call(
            api, frappe_module, claim, nonce="g" * 32
        )

        # The Draft actually landed - on main this raised PermissionError and
        # nothing was written, which is what left the Worker readback empty.
        self.assertFalse(result["idempotent_replay"])
        self.assertEqual(len(fixtures["quotes"]), 2)
        draft = fixtures["quotes"][1]
        self.assertEqual(draft["status"], "Draft")
        self.assertEqual(draft["name"], result["draft_customer_quote_id"])
        # The guard saw the document *after* insert applied the DocType defaults,
        # and the trusted tuple described that document.
        quote_seen = next(
            document for document in guarded if document["doctype"] == "Customer Quote"
        )
        self.assertEqual(quote_seen["currency"], "CAD")
        self.assertEqual(quote_seen["payment_status"], "Not Due")
        self.assertEqual(quote_seen["name"], result["draft_customer_quote_id"])
        self.assertEqual(api._commercial_violations(draft), ())

    def test_a_defaulted_draft_replays_instead_of_being_refused(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, frappe_module, _ = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()
        caller = FacetDesignProjectionApiTests()

        first = caller.call(api, frappe_module, claim, nonce="h" * 32)
        replay = caller.call(api, frappe_module, claim, nonce="i" * 32)

        # Re-delivery of the same event is idempotent, not a "Draft contains
        # commercial data" refusal over the values insert() itself wrote.
        self.assertFalse(first["idempotent_replay"])
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(
            replay["draft_customer_quote_id"], first["draft_customer_quote_id"]
        )
        self.assertEqual(replay["draft_quote_version"], first["draft_quote_version"])
        self.assertEqual(replay["evidence_id"], first["evidence_id"])
        self.assertEqual(replay["reconciliation_id"], first["reconciliation_id"])
        self.assertEqual(len(fixtures["quotes"]), 2)
        self.assertEqual(len(fixtures["evidence"]), 1)
        self.assertEqual(len(fixtures["reconciliations"]), 1)

    def test_commercial_data_in_a_defaulted_draft_is_still_refused(self) -> None:
        for field, value in (
            ("quote_total", 1),
            ("currency", "USD"),
            ("payment_status", "Overdue"),
            ("accepted_at", "2027-01-16 09:00:00"),
        ):
            with self.subTest(field=field):
                validation_module = self.load_validation()
                fixtures = FacetDesignProjectionApiTests.fixtures()
                api, frappe_module, _ = self.load_api(validation_module, fixtures)
                claim = FacetDesignProjectionApiTests.claim()
                caller = FacetDesignProjectionApiTests()
                caller.call(api, frappe_module, claim, nonce=f"j{field}".ljust(32, "0"))

                # Tolerating the schema default must not tolerate a value that
                # merely differs from it, nor any populated commercial field.
                fixtures["quotes"][1][field] = value
                with self.assertRaisesRegex(
                    FakeValidationError, "Draft contains commercial data"
                ) as raised:
                    caller.call(
                        api, frappe_module, claim, nonce=f"k{field}".ljust(32, "0")
                    )
                self.assertIn(field, str(raised.exception))

    def test_the_guard_still_refuses_a_write_outside_the_bounded_command(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        _api, _frappe_module, _guarded = self.load_api(validation_module, fixtures)

        # No issuance context is open: the service user has no standing authority
        # to write a Customer Quote, defaults resolved or not.
        with self.assertRaisesRegex(FakePermissionError, "bounded projection command"):
            validation_module.validate_customer_quote_acceptance_mutation(
                doctype_defaults("Customer Quote")
            )

    def test_a_numeric_column_reading_back_as_zero_is_still_blank(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, frappe_module, _ = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()
        caller = FacetDesignProjectionApiTests()
        first = caller.call(api, frappe_module, claim, nonce="n" * 32)

        # Frappe stores Currency/Float/Int NOT NULL DEFAULT 0, so every money and
        # count field this command wrote as NULL reads back as 0 on a real site.
        # That is the column speaking, not an estimator pricing something.
        zeroed = {
            "subtotal": 0.0, "tax_amount": 0.0, "tax_rate": 0.0, "quote_total": 0.0,
            "deposit_amount": 0.0, "amount_due": 0.0, "amount_paid": 0.0,
            "balance_due": 0.0, "qb_terms_due_days": 0,
        }
        fixtures["quotes"][1].update(zeroed)
        self.assertEqual(api._commercial_violations(fixtures["quotes"][1]), ())

        replay = caller.call(api, frappe_module, claim, nonce="o" * 32)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(
            replay["draft_customer_quote_id"], first["draft_customer_quote_id"]
        )
        # A real amount in the same column is still commercial data.
        fixtures["quotes"][1]["quote_total"] = 42_000
        self.assertEqual(api._commercial_violations(fixtures["quotes"][1]), ("quote_total",))

    def test_a_reconciliation_amount_stored_as_zero_replays(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, frappe_module, _ = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()
        caller = FacetDesignProjectionApiTests()
        first = caller.call(api, frappe_module, claim, nonce="q" * 32)

        # Integration Reconciliation's Currency columns store 0 for the NULL the
        # command wrote, so the replay comparison sees 0.0 where it expects None
        # on every real re-delivery.
        fixtures["reconciliations"][0].update({"source_amount": 0.0, "local_amount": 0.0})
        replay = caller.call(api, frappe_module, claim, nonce="r" * 32)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["reconciliation_id"], first["reconciliation_id"])

        # Only NULL may match a stored zero: a real amount is still drift.
        fixtures["reconciliations"][0]["source_amount"] = 250
        with self.assertRaisesRegex(FakeValidationError, "drifted: source_amount"):
            caller.call(api, frappe_module, claim, nonce="s" * 32)

    def test_claim_timestamps_are_written_as_naive_utc_datetimes(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, frappe_module, _ = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()
        SITE_CLOCK_CONVERSIONS.clear()
        FacetDesignProjectionApiTests().call(api, frappe_module, claim, nonce="p" * 32)

        # The Worker stamps received_at with new Date().toISOString(); MariaDB
        # rejects that shape outright, so the offset marker has to go - but the
        # instant must not move with it. A naive Frappe Datetime is UTC in this
        # app (quickbooks_final_invoice_api._timestamp_value states the policy;
        # document_validation._server_approval_utc_timestamp writes to it), and
        # this site clock is deliberately not UTC, so a system-timezone
        # conversion would show up here as a seven-hour skew.
        # The claim carries received_at = "2027-01-15T08:00:01.000Z".
        self.assertEqual(fixtures["evidence"][0]["captured_at"], "2027-01-15 08:00:01")
        self.assertEqual(
            fixtures["reconciliations"][0]["detected_at"], "2027-01-15 08:00:01"
        )
        self.assertNotEqual(
            fixtures["evidence"][0]["captured_at"], claim["received_at"]
        )
        self.assertNotIn("Z", fixtures["evidence"][0]["captured_at"])
        # Same instant, no site clock involved on the way in.
        self.assertEqual(SITE_CLOCK_CONVERSIONS, [])

    def test_every_guarded_field_is_specified_by_the_projection_payload(self) -> None:
        validation_module = self.load_validation()
        fixtures = FacetDesignProjectionApiTests.fixtures()
        api, _frappe_module, _ = self.load_api(validation_module, fixtures)
        claim = FacetDesignProjectionApiTests.claim()
        anchors = {
            "job": fixtures["job"],
            "source_quote": fixtures["quotes"][0],
            "existing_draft": None,
            "previous_draft": None,
            "draft_version": 3,
        }
        draft, evidence, reconciliation = api._projection_documents(
            claim, anchors, SERVICE_USER, "e", "r", "x", "d", "2027-01-15 08:00:02"
        )

        # The defaults fix only holds while the payload names every field the
        # guard snapshots: a field the payload omits is a field insert() may
        # default behind the trusted tuple's back.  This is the tripwire for that.
        for payload, fields in (
            (draft, validation_module.FACET_DESIGN_PROJECTION_QUOTE_FIELDS),
            (evidence, validation_module.FACET_DESIGN_PROJECTION_EVIDENCE_FIELDS),
            (
                reconciliation,
                validation_module.FACET_DESIGN_PROJECTION_RECONCILIATION_FIELDS,
            ),
        ):
            with self.subTest(doctype=payload["doctype"]):
                self.assertEqual(set(fields) - set(payload), set())


if __name__ == "__main__":
    unittest.main()
