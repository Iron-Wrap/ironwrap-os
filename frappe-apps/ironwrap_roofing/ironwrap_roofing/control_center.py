"""Pure projections for the IronWrap exception-first operating cockpit."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

GATE_ORDER = (
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
    "Completion",
)
COMPLETE_GATE_STATES = {"Ready", "Waived", "Done"}


def _latest(records: Sequence[Mapping[str, Any]] | None) -> Mapping[str, Any] | None:
    return records[0] if records else None


def _record_step(
    key: str,
    label: str,
    records: Sequence[Mapping[str, Any]] | None,
    *,
    status_field: str = "status",
    complete: set[str] | None = None,
    attention: set[str] | None = None,
) -> dict[str, Any]:
    record = _latest(records)
    if not record:
        return {"key": key, "label": label, "state": "pending", "detail": "Not started"}
    status = str(record.get(status_field) or "Unknown")
    if status in (attention or set()):
        state = "attention"
    elif status in (complete or set()):
        state = "complete"
    else:
        state = "active"
    return {"key": key, "label": label, "state": state, "detail": status}


def build_job_runway(snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Build a stable, color-independent job runway from already-authorized rows."""

    job = snapshot.get("job") or {}
    job_status = str(job.get("job_status") or "Not started")
    intake_state = (
        "pending"
        if not job
        else (
            "complete"
            if job_status in {"Won", "In Production", "Completed", "Closed"}
            else "active"
        )
    )
    runway = [
        {
            "key": "intake",
            "label": "Intake",
            "state": intake_state,
            "detail": job_status,
        },
        _record_step(
            "estimate",
            "Estimate",
            snapshot.get("estimates"),
            complete={"Approved"},
            attention={"Needs Review", "Rejected"},
        ),
        _record_step(
            "measurement",
            "Measurement",
            snapshot.get("measurements"),
            status_field="review_status",
            complete={"Approved"},
            attention={"Needs Review", "Rejected"},
        ),
        _record_step(
            "takeoff",
            "Takeoff",
            snapshot.get("takeoffs"),
            complete={"Approved"},
            attention={"Needs Review", "Rejected"},
        ),
    ]

    proposal_records = snapshot.get("proposals") or snapshot.get("quotes")
    runway.append(
        _record_step(
            "proposal",
            "Proposal",
            proposal_records,
            complete={"Approved", "Accepted", "Sent", "Signed"},
            attention={"Needs Review", "Rejected", "Expired"},
        )
    )

    orders = snapshot.get("supplier_orders") or []
    supplier_quotes = snapshot.get("supplier_quotes") or []
    material_records = orders or supplier_quotes
    material_step = _record_step(
        "materials",
        "Materials",
        material_records,
        complete={"Received"},
        attention={"Needs Review", "Rejected", "Expired", "Shortage", "Cancelled"},
    )
    if not orders and supplier_quotes and material_step["state"] == "active":
        material_step["detail"] = f"Quote {material_step['detail']}"
    runway.append(material_step)

    gates = snapshot.get("gates") or []
    gate_by_name = {str(gate.get("gate")): gate for gate in gates}
    blocked = [gate for gate in gates if gate.get("state") == "Blocked"]
    required_names = set(GATE_ORDER[:-1])
    if blocked:
        gate_step = {
            "key": "production",
            "label": "Production",
            "state": "attention",
            "detail": f"{len(blocked)} blocked gate{'s' if len(blocked) != 1 else ''}",
        }
    elif required_names.issubset(gate_by_name) and all(
        gate_by_name[name].get("state") in COMPLETE_GATE_STATES
        for name in required_names
    ):
        gate_step = {
            "key": "production",
            "label": "Production",
            "state": "complete",
            "detail": "Required gates clear",
        }
    else:
        gate_step = {
            "key": "production",
            "label": "Production",
            "state": "pending" if not gates else "active",
            "detail": "No gate state" if not gates else "Gates in progress",
        }
    runway.append(gate_step)

    runway.append(
        _record_step(
            "field",
            "Field proof",
            snapshot.get("field_check_ins"),
            complete={"Resolved"},
            attention={"Needs Review"},
        )
    )

    closeout_records = (
        snapshot.get("review_requests")
        or snapshot.get("warranties")
        or snapshot.get("completions")
    )
    runway.append(
        _record_step(
            "closeout",
            "Closeout",
            closeout_records,
            complete={"Approved", "Issued", "Sent"},
            attention={"Needs Review", "Blocked", "Stopped"},
        )
    )

    payments = snapshot.get("payments") or []
    if payments and all(
        row.get("status") in {"Matched", "Ignored"} for row in payments
    ):
        finance_step = {
            "key": "finance",
            "label": "Finance",
            "state": "complete",
            "detail": "Reconciled",
        }
    elif any(row.get("status") == "Needs Review" for row in payments):
        finance_step = {
            "key": "finance",
            "label": "Finance",
            "state": "attention",
            "detail": "Needs review",
        }
    else:
        finance_step = _record_step("finance", "Finance", payments)
    runway.append(finance_step)
    return runway


def sort_action_queue(
    items: Sequence[Mapping[str, Any]], limit: int = 40
) -> list[dict[str, Any]]:
    """Sort urgent work first, then newest, without trusting caller ordering."""

    normalized = [dict(item) for item in items]
    normalized.sort(
        key=lambda item: (
            int(item.get("priority", 99)),
            str(item.get("modified") or ""),
            str(item.get("doctype") or ""),
            str(item.get("name") or ""),
        ),
        reverse=False,
    )
    # Within one priority, more recent ISO/Frappe timestamps should appear first.
    grouped: list[dict[str, Any]] = []
    for priority in sorted({int(item.get("priority", 99)) for item in normalized}):
        rows = [
            item for item in normalized if int(item.get("priority", 99)) == priority
        ]
        rows.sort(key=lambda item: str(item.get("modified") or ""), reverse=True)
        grouped.extend(rows)
    return grouped[: max(0, limit)]
