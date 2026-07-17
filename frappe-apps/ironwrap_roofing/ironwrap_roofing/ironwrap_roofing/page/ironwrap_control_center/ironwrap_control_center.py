"""Permission-aware data adapter for the IronWrap Control Center."""

from __future__ import annotations

import os
import uuid
from typing import Any
from urllib.parse import urlsplit

import frappe
from frappe import _
from frappe.utils import add_to_date, get_datetime, now_datetime

from ironwrap_roofing.control_center import (
    GATE_ORDER,
    build_customer_portal_scope_actions,
    build_job_runway,
    sort_action_queue,
)

BUSINESS_ROLES = {
    "IronWrap Owner",
    "IronWrap Sales",
    "IronWrap Estimator",
    "IronWrap Production",
    "IronWrap Field",
    "IronWrap Finance",
    "IronWrap Closeout",
    "IronWrap Support",
    "System Manager",
}

PIPELINE_ORDER = (
    "Qualified",
    "Measurement",
    "Proposal",
    "Won",
    "In Production",
    "Completed",
    "Closed",
    "Lost",
)

PENDING_SPECS = (
    ("Customer Quote", "status", ("Needs Review",), "Customer quote", 2),
    ("Material Takeoff", "status", ("Needs Review",), "Material takeoff", 2),
    ("Supplier Quote", "status", ("Needs Review",), "Supplier quote", 2),
    ("Supplier Order", "status", ("Needs Review", "Shortage"), "Supplier order", 2),
    ("Proposal Evidence Pack", "status", ("Ready",), "Proposal pack", 2),
    ("Completion Packet", "status", ("Needs Review",), "Completion packet", 2),
    ("Warranty Packet", "status", ("Needs Review",), "Warranty packet", 2),
    ("Review Request", "status", ("Blocked", "Eligible"), "Review request", 2),
    ("Payment Milestone", "status", ("Needs Review",), "Payment milestone", 2),
    (
        "Hermes Run",
        "approval_status",
        ("Audit Failed", "Blocked", "Failed"),
        "Hermes run",
        0,
    ),
)


def _assert_cockpit_access() -> list[str]:
    roles = set(frappe.get_roles(frappe.session.user))
    permitted = sorted(roles & BUSINESS_ROLES)
    if not permitted:
        frappe.throw(
            _("You do not have access to the IronWrap Control Center."),
            frappe.PermissionError,
        )
    return permitted


def _records(
    doctype: str,
    fields: list[str],
    *,
    filters: dict[str, Any] | None = None,
    order_by: str = "modified desc",
    limit: int = 100,
) -> list[dict[str, Any]]:
    if not frappe.has_permission(doctype, ptype="read"):
        return []
    rows = frappe.get_list(
        doctype,
        fields=fields,
        filters=filters or {},
        order_by=order_by,
        limit_page_length=min(max(limit, 1), 500),
    )
    return [dict(row) for row in rows]


def _build_action_queue(
    blocked_gates: list[dict[str, Any]],
    incidents: list[dict[str, Any]],
    extra_actions: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for gate in blocked_gates:
        actions.append(
            {
                "priority": 1,
                "kind": "Blocked gate",
                "summary": f"{gate.get('gate') or 'Production'} gate is blocked",
                "detail": gate.get("blocker_reason") or "No blocker reason recorded",
                "doctype": "Production Gate State",
                "name": gate.get("name"),
                "roof_job": gate.get("roof_job"),
                "modified": gate.get("modified"),
            }
        )

    severity_priority = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    for incident in incidents:
        actions.append(
            {
                "priority": severity_priority.get(str(incident.get("severity")), 2),
                "kind": f"{incident.get('severity') or 'Open'} incident",
                "summary": incident.get("summary")
                or incident.get("category")
                or "Automation incident",
                "detail": incident.get("category")
                or incident.get("source_system")
                or "Needs investigation",
                "doctype": "Automation Incident",
                "name": incident.get("name"),
                "roof_job": incident.get("roof_job"),
                "modified": incident.get("modified"),
            }
        )

    for doctype, status_field, statuses, label, priority in PENDING_SPECS:
        for row in _records(
            doctype,
            ["name", "roof_job", status_field, "modified"],
            filters={status_field: ["in", list(statuses)]},
            limit=50,
        ):
            status = row.get(status_field) or "Needs review"
            actions.append(
                {
                    "priority": priority,
                    "kind": label,
                    "summary": f"{label} · {status}",
                    "detail": "Open the source record, verify evidence, then use the approved workflow.",
                    "doctype": doctype,
                    "name": row.get("name"),
                    "roof_job": row.get("roof_job"),
                    "modified": row.get("modified"),
                }
            )
    actions.extend(extra_actions or [])
    return sort_action_queue(actions, limit=40)


def _customer_portal_scope_actions(roles: list[str]) -> list[dict[str, Any]]:
    """Show legacy portal-lineage repairs only to owners who can verify both sides."""

    if not {"IronWrap Owner", "System Manager"}.intersection(roles):
        return []
    if not frappe.has_permission("Scope Clause", ptype="read") or not frappe.has_permission(
        "Customer Quote", ptype="read"
    ):
        return []

    clauses = _records(
        "Scope Clause",
        ["name", "roof_job", "customer_quote", "status", "customer_visible", "modified"],
        filters={"status": "Approved", "customer_visible": 1},
        limit=100,
    )
    quote_names = sorted(
        {
            str(clause["customer_quote"])
            for clause in clauses
            if clause.get("customer_quote")
        }
    )
    quotes = (
        _records(
            "Customer Quote",
            ["name", "roof_job"],
            filters={"name": ["in", quote_names]},
            limit=len(quote_names),
        )
        if quote_names
        else []
    )
    return build_customer_portal_scope_actions(clauses, quotes)


def _selected_job(
    requested: str | None,
    jobs: list[dict[str, Any]],
    blocked_gates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if requested:
        matches = _records(
            "Roof Job",
            [
                "name",
                "roof_job_id",
                "job_number",
                "brand",
                "service_type",
                "job_status",
                "quotation",
                "current_gate_state",
                "modified",
            ],
            filters={"name": requested},
            limit=1,
        )
        if not matches:
            matches = _records(
                "Roof Job",
                [
                    "name",
                    "roof_job_id",
                    "job_number",
                    "brand",
                    "service_type",
                    "job_status",
                    "quotation",
                    "current_gate_state",
                    "modified",
                ],
                filters={"roof_job_id": requested},
                limit=1,
            )
        return matches[0] if matches else None

    blocked_job = next(
        (row.get("roof_job") for row in blocked_gates if row.get("roof_job")), None
    )
    if blocked_job:
        match = next((job for job in jobs if job.get("name") == blocked_job), None)
        if match:
            return match
    active = next(
        (job for job in jobs if job.get("job_status") not in {"Closed", "Lost"}), None
    )
    return active or (jobs[0] if jobs else None)


def _prepend_unique_rows(
    preferred: list[dict[str, Any]], existing: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep exact lineage reads first without duplicating a Frappe document."""

    rows: list[dict[str, Any]] = []
    names: set[str] = set()
    for row in [*preferred, *existing]:
        name = str(row.get("name") or "")
        if name and name in names:
            continue
        if name:
            names.add(name)
        rows.append(row)
    return rows


def _snapshot(job: dict[str, Any] | None, roles: list[str]) -> dict[str, Any]:
    quote_access = bool(frappe.has_permission("Customer Quote", ptype="read"))
    quote_lineage_access = bool({"IronWrap Owner", "System Manager"}.intersection(roles)) and quote_access
    publication_access = quote_lineage_access and bool(
        frappe.has_permission("Proposal Evidence Pack", ptype="read")
    )
    snapshot: dict[str, Any] = {
        "job": job,
        "proposal_access": {
            "quote": quote_access,
            "quote_lineage": quote_lineage_access,
            "publication": publication_access,
        },
        "gates": [],
        "estimates": [],
        "measurements": [],
        "takeoffs": [],
        "quotes": [],
        "supplier_quotes": [],
        "supplier_orders": [],
        "proposals": [],
        "field_check_ins": [],
        "completions": [],
        "warranties": [],
        "review_requests": [],
        "payments": [],
        "evidence": [],
    }
    if not job:
        return snapshot
    name = str(job["name"])
    quote_fields = [
        "name",
        "customer_quote_id",
        "roof_job",
        "status",
        "quote_total",
        "currency",
        "modified",
    ]
    proposal_fields = [
        "name",
        "pack_id",
        "roof_job",
        "quotation",
        "status",
        "modified",
    ]
    specs = {
        "gates": (
            "Production Gate State",
            ["name", "gate", "state", "blocker_reason", "evidence_item", "modified"],
            20,
        ),
        "estimates": (
            "Instant Estimate Session",
            [
                "name",
                "status",
                "range_low",
                "range_high",
                "review_required",
                "modified",
            ],
            5,
        ),
        "measurements": (
            "Measurement Report",
            ["name", "measurement_id", "provider", "review_status", "modified"],
            5,
        ),
        "takeoffs": (
            "Material Takeoff",
            ["name", "takeoff_id", "status", "modified"],
            5,
        ),
        "quotes": (
            "Customer Quote",
            quote_fields,
            5,
        ),
        "supplier_quotes": (
            "Supplier Quote",
            [
                "name",
                "supplier_quote_id",
                "status",
                "quote_total",
                "valid_until",
                "modified",
            ],
            5,
        ),
        "supplier_orders": (
            "Supplier Order",
            [
                "name",
                "supplier_order_id",
                "status",
                "requested_delivery_date",
                "modified",
            ],
            5,
        ),
        "proposals": (
            "Proposal Evidence Pack",
            proposal_fields,
            5,
        ),
        "field_check_ins": (
            "Field Check-in",
            ["name", "checkin_id", "status", "photo_count", "submitted_at", "modified"],
            5,
        ),
        "completions": (
            "Completion Packet",
            ["name", "completion_packet_id", "status", "warranty_ready", "modified"],
            5,
        ),
        "warranties": (
            "Warranty Packet",
            ["name", "warranty_packet_id", "status", "modified"],
            5,
        ),
        "review_requests": (
            "Review Request",
            ["name", "review_request_id", "status", "modified"],
            5,
        ),
        "payments": (
            "Payment Milestone",
            [
                "name",
                "payment_milestone_id",
                "milestone_type",
                "status",
                "event_ts",
                "modified",
            ],
            20,
        ),
        "evidence": (
            "Evidence Item",
            [
                "name",
                "evidence_id",
                "evidence_type",
                "source_system",
                "customer_safe",
                "captured_at",
                "modified",
            ],
            12,
        ),
    }
    for key, (doctype, fields, limit) in specs.items():
        snapshot[key] = _records(
            doctype, fields, filters={"roof_job": name}, limit=limit
        )
    quote_name = str(job.get("quotation") or "")
    if quote_name and quote_access:
        # The generic history rails are deliberately short. Read the exact current lineage too,
        # so a historical pack cannot decide the runway and an older published pack is retained.
        current_quote = _records(
            "Customer Quote",
            quote_fields,
            filters={"name": quote_name, "roof_job": name},
            limit=1,
        )
        snapshot["quotes"] = _prepend_unique_rows(current_quote, snapshot["quotes"])
        if publication_access:
            latest_current_pack = _records(
                "Proposal Evidence Pack",
                proposal_fields,
                filters={"quotation": quote_name, "roof_job": name},
                limit=1,
            )
            published_current_pack = _records(
                "Proposal Evidence Pack",
                proposal_fields,
                filters={
                    "quotation": quote_name,
                    "roof_job": name,
                    "status": ["in", ["Approved", "Sent", "Signed"]],
                },
                limit=1,
            )
            snapshot["proposals"] = _prepend_unique_rows(
                [*latest_current_pack, *published_current_pack], snapshot["proposals"]
            )
    gate_position = {gate: index for index, gate in enumerate(GATE_ORDER)}
    snapshot["gates"].sort(key=lambda row: gate_position.get(str(row.get("gate")), 99))
    return snapshot


def _bus_readiness() -> dict[str, Any]:
    raw_url = frappe.conf.get("ironwrap_bus_base_url") or os.environ.get(
        "IRONWRAP_BUS_BASE_URL"
    )
    if not raw_url:
        return {"configured": False, "state": "not_configured", "checks": {}}
    try:
        parsed = urlsplit(str(raw_url))
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            return {"configured": True, "state": "invalid_configuration", "checks": {}}
        base_url = f"https://{parsed.netloc}{parsed.path.rstrip('/')}"
        import requests

        response = requests.get(
            f"{base_url}/ready",
            allow_redirects=False,
            headers={
                "accept": "application/json",
                "x-request-id": f"cockpit-{uuid.uuid4().hex}",
            },
            timeout=2,
        )
        payload = response.json() if response.status_code in {200, 503} else {}
        checks = payload.get("checks") if isinstance(payload, dict) else {}
        safe_checks = {
            str(key): bool(value)
            for key, value in (checks.items() if isinstance(checks, dict) else [])
            if isinstance(value, bool)
        }
        ready = (
            response.status_code == 200
            and payload.get("ok") is True
            and all(safe_checks.values())
        )
        return {
            "configured": True,
            "state": "ready" if ready else "not_ready",
            "checks": safe_checks,
        }
    except Exception:
        return {"configured": True, "state": "unreachable", "checks": {}}


@frappe.whitelist()
def get_control_center(roof_job: str | None = None) -> dict[str, Any]:
    """Return only data the current Desk user can already read."""

    roles = _assert_cockpit_access()
    jobs = _records(
        "Roof Job",
        [
            "name",
            "roof_job_id",
            "job_number",
            "brand",
            "service_type",
            "job_status",
            "quotation",
            "current_gate_state",
            "modified",
        ],
        limit=500,
    )
    blocked_gates = _records(
        "Production Gate State",
        ["name", "roof_job", "gate", "state", "blocker_reason", "modified"],
        filters={"state": "Blocked"},
        limit=100,
    )
    incidents = _records(
        "Automation Incident",
        [
            "name",
            "incident_id",
            "status",
            "severity",
            "source_system",
            "category",
            "summary",
            "roof_job",
            "modified",
        ],
        filters={"status": ["in", ["Open", "Acknowledged"]]},
        limit=100,
    )
    actions = _build_action_queue(
        blocked_gates,
        incidents,
        _customer_portal_scope_actions(roles),
    )
    selected = _selected_job(roof_job, jobs, blocked_gates)
    snapshot = _snapshot(selected, roles)

    pipeline_counts = {status: 0 for status in PIPELINE_ORDER}
    for job in jobs:
        status = str(job.get("job_status") or "")
        if status in pipeline_counts:
            pipeline_counts[status] += 1
    stale_cutoff = add_to_date(now_datetime(), hours=-72)
    stale_jobs = sum(
        1
        for job in jobs
        if job.get("job_status") not in {"Closed", "Lost"}
        and job.get("modified")
        and get_datetime(job["modified"]) < stale_cutoff
    )
    review_count = sum(
        1
        for action in actions
        if action.get("kind") not in {"Blocked gate"}
        and "incident" not in str(action.get("kind", "")).lower()
    )

    return {
        "schema_version": 1,
        "generated_at": now_datetime().isoformat(),
        "roles": roles,
        "metrics": {
            "active_jobs": sum(
                1 for job in jobs if job.get("job_status") not in {"Closed", "Lost"}
            ),
            "blocked_gates": len(blocked_gates),
            "pending_reviews": review_count,
            "open_incidents": len(incidents),
            "stale_jobs": stale_jobs,
        },
        "pipeline": [
            {"status": status, "count": count}
            for status, count in pipeline_counts.items()
        ],
        "action_queue": actions,
        "selected": {
            "job": selected,
            "runway": build_job_runway(snapshot),
            "gates": snapshot["gates"],
            "evidence": snapshot["evidence"],
        },
        "bus_readiness": _bus_readiness(),
        "safety": {
            "read_only": True,
            "message": "This cockpit does not mutate records. Open the source record or use the approved dry-run workflow.",
        },
    }
