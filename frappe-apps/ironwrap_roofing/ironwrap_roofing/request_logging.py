from __future__ import annotations

import json
import logging
import re
import sys
import time
import uuid
from typing import Any

import frappe


_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_VALID_IDENTIFIER = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_LOGGER = logging.getLogger("ironwrap.request")


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = getattr(record, "ironwrap_payload", {})
        return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


if not any(getattr(handler, "ironwrap_json", False) for handler in _LOGGER.handlers):
    _handler = logging.StreamHandler(sys.stdout)
    _handler.ironwrap_json = True  # type: ignore[attr-defined]
    _handler.setFormatter(_JsonFormatter())
    _LOGGER.addHandler(_handler)
_LOGGER.setLevel(logging.INFO)
_LOGGER.propagate = False


def _header(request: Any, name: str) -> str | None:
    headers = getattr(request, "headers", None)
    value = headers.get(name) if headers is not None else None
    return value if isinstance(value, str) else None


def _safe_identifier(value: Any) -> str | None:
    return value if isinstance(value, str) and _VALID_IDENTIFIER.fullmatch(value) else None


def _safe_request_id(value: Any) -> str | None:
    return value if isinstance(value, str) and _VALID_REQUEST_ID.fullmatch(value) else None


def _request_id(request: Any) -> str:
    for name in ("X-Correlation-ID", "X-Request-ID"):
        value = _header(request, name)
        if value and _VALID_REQUEST_ID.fullmatch(value):
            return value
    return str(uuid.uuid4())


def before_request() -> None:
    request = getattr(frappe.local, "request", None)
    frappe.local.ironwrap_request_id = _request_id(request)
    frappe.local.ironwrap_request_started_at = time.perf_counter()


def after_request(response: Any = None, request: Any = None, **_kwargs: Any) -> None:
    request = request or getattr(frappe.local, "request", None)
    request_id = _safe_request_id(
        getattr(frappe.local, "ironwrap_request_id", None)
    ) or _request_id(request)
    started_at = getattr(frappe.local, "ironwrap_request_started_at", time.perf_counter())
    status = int(getattr(response, "status_code", 500))
    if response is not None and getattr(response, "headers", None) is not None:
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Correlation-ID"] = request_id
    payload = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": "error" if status >= 500 else "info",
        "msg": "http_request_completed",
        "service": "frappe",
        "request_id": request_id,
        "tenant": _safe_identifier(getattr(frappe.local, "site", None)),
        "method": str(getattr(request, "method", "UNKNOWN"))[:16],
        "route": str(getattr(request, "path", "/"))[:256],
        "status": status,
        "duration_ms": max(0, round((time.perf_counter() - started_at) * 1000)),
        "envelope_id": _safe_identifier(_header(request, "X-IronWrap-Envelope-ID")),
        "error_code": "http_5xx" if status >= 500 else None,
    }
    _LOGGER.log(
        logging.ERROR if status >= 500 else logging.INFO,
        "",
        extra={"ironwrap_payload": payload},
    )
