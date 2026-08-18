from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


CONTROLLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "ironwrap_roofing"
    / "doctype"
    / "authority_record"
    / "authority_record.py"
)


class FakePermissionError(Exception):
    pass


class FakeDocument:
    def __init__(self, values: dict[str, object] | None = None) -> None:
        self.values = dict(values or {})

    def get(self, field: str, default: object = None) -> object:
        return self.values.get(field, default)

    def as_dict(self) -> dict[str, object]:
        return dict(self.values)

    def __setattr__(self, field: str, value: object) -> None:
        if field == "values":
            object.__setattr__(self, field, value)
        else:
            self.values[field] = value


def load_controller(roles: list[str]):
    frappe = types.ModuleType("frappe")
    frappe.PermissionError = FakePermissionError
    frappe.session = types.SimpleNamespace(user="authority@example.invalid")
    frappe.get_roles = lambda _user: roles
    frappe.throw = lambda message, *, exc: (_ for _ in ()).throw(exc(message))
    frappe_model = types.ModuleType("frappe.model")
    frappe_model_document = types.ModuleType("frappe.model.document")
    frappe_model_document.Document = FakeDocument
    with patch.dict(
        sys.modules,
        {
            "frappe": frappe,
            "frappe.model": frappe_model,
            "frappe.model.document": frappe_model_document,
        },
    ):
        spec = importlib.util.spec_from_file_location(
            "ironwrap_authority_record_under_test", CONTROLLER_PATH
        )
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
    module.validate_business_document = lambda _document, _kind: None
    return module


class AuthorityRecordControllerTests(unittest.TestCase):
    def test_system_manager_can_prepare_but_cannot_verify_or_revoke(self) -> None:
        controller = load_controller(["System Manager"])
        for status in ("Verified", "Revoked", "Contradictory", "Superseded"):
            with self.subTest(status=status):
                record = controller.AuthorityRecord({"status": status})
                with self.assertRaisesRegex(
                    FakePermissionError, "Owner or Production authority"
                ):
                    record.validate()

        draft = controller.AuthorityRecord({"status": "Unverified"})
        draft.validate()
        self.assertTrue(draft.get("state_digest_sha256"))

    def test_owner_and_production_are_business_verification_actors(self) -> None:
        for role in ("IronWrap Owner", "IronWrap Production"):
            with self.subTest(role=role):
                controller = load_controller([role])
                record = controller.AuthorityRecord({"status": "Verified"})
                record.validate()
                self.assertTrue(record.get("state_digest_sha256"))


if __name__ == "__main__":
    unittest.main()
