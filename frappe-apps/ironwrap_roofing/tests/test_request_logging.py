from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "request_logging.py"
HOOKS_PATH = Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "hooks.py"


class CaseInsensitiveHeaders(dict):
    def __init__(self, values: dict[str, str] | None = None) -> None:
        super().__init__((key.lower(), value) for key, value in (values or {}).items())

    def get(self, key: str, default=None):
        return super().get(key.lower(), default)

    def __setitem__(self, key: str, value: str) -> None:
        super().__setitem__(key.lower(), value)


class RequestLoggingTests(unittest.TestCase):
    def load_module(self, request):
        frappe_module = types.ModuleType("frappe")
        frappe_module.local = types.SimpleNamespace(request=request, site="ironwrap.example")
        spec = importlib.util.spec_from_file_location("ironwrap_request_logging_under_test", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            spec.loader.exec_module(module)
        return module, frappe_module

    @staticmethod
    def capture(module):
        stream = io.StringIO()
        handler = next(
            item for item in module._LOGGER.handlers if getattr(item, "ironwrap_json", False)
        )
        handler.setStream(stream)
        return stream

    def test_completion_log_and_response_headers_share_one_safe_id_without_secrets(self) -> None:
        request = types.SimpleNamespace(
            method="POST",
            path="/api/method/ironwrap_roofing.facet",
            full_path="/api/method/ironwrap_roofing.facet?token=must-not-log",
            headers=CaseInsensitiveHeaders({
                "Authorization": "token must-not-log",
                "X-Correlation-ID": "44444444-4444-4444-8444-444444444444",
                "X-Request-ID": "different-request-id",
                "X-IronWrap-Envelope-ID": "44444444-4444-4444-8444-444444444444",
            }),
        )
        module, frappe_module = self.load_module(request)
        stream = self.capture(module)
        module.before_request()
        response = types.SimpleNamespace(status_code=200, headers=CaseInsensitiveHeaders())
        module.after_request(response=response, request=request)

        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        request_id = "44444444-4444-4444-8444-444444444444"
        self.assertEqual(response.headers.get("X-Request-ID"), request_id)
        self.assertEqual(response.headers.get("X-Correlation-ID"), request_id)
        self.assertEqual(record["request_id"], request_id)
        self.assertEqual(record["envelope_id"], request_id)
        self.assertEqual(record["route"], request.path[:256])
        self.assertEqual(record["service"], "frappe")
        self.assertEqual(record["tenant"], "ironwrap.example")
        self.assertEqual(record["status"], 200)
        self.assertIsInstance(record["duration_ms"], int)
        self.assertNotIn("must-not-log", lines[0])
        self.assertLess(len(lines[0]), 1024)
        self.assertEqual(frappe_module.local.ironwrap_request_id, request_id)

    def test_invalid_inbound_ids_fall_back_to_one_uuid(self) -> None:
        request = types.SimpleNamespace(
            method="GET",
            path="/health",
            headers=CaseInsensitiveHeaders({"X-Correlation-ID": "bad,value"}),
        )
        module, _frappe_module = self.load_module(request)
        stream = self.capture(module)
        module.before_request()
        response = types.SimpleNamespace(status_code=503, headers=CaseInsensitiveHeaders())
        module.after_request(response=response, request=request)

        record = json.loads(stream.getvalue())
        request_id = response.headers.get("X-Request-ID")
        self.assertRegex(request_id, re.compile(r"^[0-9a-f-]{36}$"))
        self.assertEqual(response.headers.get("X-Correlation-ID"), request_id)
        self.assertEqual(record["request_id"], request_id)
        self.assertEqual(record["level"], "error")
        self.assertEqual(record["error_code"], "http_5xx")

    def test_frappe_request_hooks_are_wired_to_the_structured_logger(self) -> None:
        hooks = HOOKS_PATH.read_text(encoding="utf-8")
        self.assertIn(
            'before_request = ["ironwrap_roofing.request_logging.before_request"]',
            hooks,
        )
        self.assertIn(
            'after_request = ["ironwrap_roofing.request_logging.after_request"]',
            hooks,
        )


if __name__ == "__main__":
    unittest.main()
