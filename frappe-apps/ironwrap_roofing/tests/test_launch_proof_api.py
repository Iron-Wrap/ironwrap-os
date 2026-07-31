from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "launch_proof_api.py"
)
CORRELATION_ID = "launch-proof:LP-1730000000000-0123456789abcdef0123456789abcdef"
ESTIMATE_SESSION_ID = "estimate:LP-1730000000000-0123456789abcdef0123456789abcdef"


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class LaunchProofApiTests(unittest.TestCase):
    def load_api(
        self,
        rows: list[dict] | None = None,
        *,
        session_user: str = "launch-proof@example.invalid",
        configured_reader: str | None = "launch-proof@example.invalid",
        request_method: str = "GET",
        can_read: bool = True,
        roles: list[str] | None = None,
    ):
        list_calls: list[dict] = []

        def get_list(doctype: str, **kwargs):
            list_calls.append({"doctype": doctype, **kwargs})
            return list(rows or [])

        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.conf = (
            {"ironwrap_launch_proof_reader_user": configured_reader}
            if configured_reader is not None
            else {}
        )
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.has_permission = lambda *args, **kwargs: can_read
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else ["IronWrap Launch Proof Reader"]
        )
        frappe_module.get_list = get_list
        frappe_module.whitelist = lambda: lambda function: function

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_launch_proof_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module, list_calls

    def test_lookup_returns_only_a_redacted_match_for_the_expected_synthetic_record(
        self,
    ) -> None:
        api, calls = self.load_api(rows=[{"estimate_session_id": ESTIMATE_SESSION_ID}])

        result = api.lookup_synthetic_correlation(CORRELATION_ID)

        self.assertEqual(
            result,
            {
                "correlation_id": CORRELATION_ID,
                "observation": "matched",
            },
        )
        self.assertEqual(
            calls,
            [
                {
                    "doctype": "Instant Estimate Session",
                    "fields": ["estimate_session_id"],
                    "filters": {"estimate_session_id": ESTIMATE_SESSION_ID},
                    "limit_page_length": 2,
                }
            ],
        )

    def test_lookup_marks_missing_or_contradictory_projection_non_success(self) -> None:
        api, calls = self.load_api()
        self.assertEqual(
            api.lookup_synthetic_correlation(CORRELATION_ID),
            {
                "correlation_id": CORRELATION_ID,
                "observation": "pending",
            },
        )
        self.assertEqual(len(calls), 1)

        api, calls = self.load_api(rows=[{"estimate_session_id": "estimate:LP-1730100000000-0123456789abcdef0123456789abcdef"}])
        self.assertEqual(
            api.lookup_synthetic_correlation(CORRELATION_ID),
            {
                "correlation_id": CORRELATION_ID,
                "observation": "mismatch",
            },
        )
        self.assertEqual(len(calls), 1)

    def test_lookup_rejects_non_synthetic_ids_and_unauthorized_reads(self) -> None:
        api, calls = self.load_api()
        with self.assertRaisesRegex(FakeValidationError, "generated synthetic"):
            api.lookup_synthetic_correlation("lead:customer-record")
        self.assertEqual(calls, [])

        with self.assertRaisesRegex(FakeValidationError, "generated synthetic"):
            api.lookup_synthetic_correlation("launch-proof:LP-12345678")
        self.assertEqual(calls, [])

        for kwargs, error in [
            ({"request_method": "POST"}, "get_required"),
            ({"session_user": "Guest"}, "auth_mismatch"),
            ({"configured_reader": None}, "reader_user"),
            ({"roles": ["IronWrap Support"]}, "role_missing"),
            ({"can_read": False}, "permission_denied"),
        ]:
            with self.subTest(kwargs=kwargs):
                api, calls = self.load_api(**kwargs)
                with self.assertRaisesRegex(FakePermissionError, error):
                    api.lookup_synthetic_correlation(CORRELATION_ID)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
