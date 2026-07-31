from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from ironwrap_roofing.access_control import (
    ALL_IRONWRAP_ROLES,
    IRONWRAP_ROLES,
    LAUNCH_PROOF_READER_ROLE,
)


INSTALL_PATH = Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "install.py"


class FakeRoleDocument:
    def __init__(self, payload: dict, inserted: list[tuple[dict, bool]]) -> None:
        self.payload = payload
        self.inserted = inserted

    def insert(self, *, ignore_permissions: bool) -> None:
        self.inserted.append((self.payload, ignore_permissions))


class InstallHookTests(unittest.TestCase):
    def load_install_module(self, frappe_module: types.ModuleType):
        spec = importlib.util.spec_from_file_location(
            "ironwrap_roofing_install_under_test", INSTALL_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module

    def test_roles_are_created_or_repaired_idempotently(self) -> None:
        existing = IRONWRAP_ROLES[0]
        inserted: list[tuple[dict, bool]] = []
        repaired: list[tuple] = []
        db = types.SimpleNamespace(
            exists=lambda doctype, name: name if name == existing else None,
            set_value=lambda *args, **kwargs: repaired.append((*args, kwargs)),
            commit=lambda: None,
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.db = db
        frappe_module.get_doc = lambda payload: FakeRoleDocument(payload, inserted)
        frappe_module.clear_cache = lambda: None

        module = self.load_install_module(frappe_module)
        module.before_install()

        self.assertEqual(len(repaired), 1)
        self.assertEqual(
            repaired[0][0:3], ("Role", existing, {"desk_access": 1, "disabled": 0})
        )
        self.assertEqual(repaired[0][3], {"update_modified": False})
        self.assertEqual(
            {item[0]["role_name"] for item in inserted},
            set(ALL_IRONWRAP_ROLES) - {existing},
        )
        self.assertTrue(all(ignore_permissions for _, ignore_permissions in inserted))
        for role_name in (
            "IronWrap Customer Acceptance Service",
            LAUNCH_PROOF_READER_ROLE,
        ):
            service = next(
                item[0] for item in inserted if item[0]["role_name"] == role_name
            )
            self.assertEqual(service["desk_access"], 0)

    def test_before_migrate_reuses_idempotent_role_reconciliation(self) -> None:
        inserted = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.db = types.SimpleNamespace(
            exists=lambda doctype, name: None,
            set_value=lambda *args, **kwargs: None,
            commit=lambda: None,
        )
        frappe_module.get_doc = lambda payload: FakeRoleDocument(payload, inserted)
        frappe_module.clear_cache = lambda: None
        module = self.load_install_module(frappe_module)

        module.before_migrate()

        self.assertEqual(
            {item[0]["role_name"] for item in inserted}, set(ALL_IRONWRAP_ROLES)
        )

    def test_after_install_commits_and_clears_cache(self) -> None:
        events = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.db = types.SimpleNamespace(commit=lambda: events.append("commit"))
        frappe_module.clear_cache = lambda: events.append("clear_cache")
        module = self.load_install_module(frappe_module)

        module.after_install()

        self.assertEqual(events, ["commit", "clear_cache"])

    def test_after_migrate_marks_legacy_leads_unknown_without_calling_them_untriaged(self) -> None:
        sql_calls = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.db = types.SimpleNamespace(
            exists=lambda doctype, name: name,
            set_value=lambda *args, **kwargs: None,
            sql=lambda statement: sql_calls.append(statement),
        )
        frappe_module.get_doc = lambda payload: FakeRoleDocument(payload, [])
        frappe_module.clear_cache = lambda: None
        module = self.load_install_module(frappe_module)

        module.after_migrate()

        self.assertEqual(len(sql_calls), 1)
        self.assertIn("SET triage_status = 'Unknown'", sql_calls[0])
        self.assertIn("triage_status IS NULL", sql_calls[0])


if __name__ == "__main__":
    unittest.main()
