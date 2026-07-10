"""Thin Frappe adapter for the pure IronWrap domain policy."""

from __future__ import annotations

from typing import Any

import frappe

from ironwrap_roofing.domain_policy import PolicyViolation, validate_record


def _as_dict(document: Any) -> Any:
    if document is None:
        return None
    converter = getattr(document, "as_dict", None)
    return converter() if callable(converter) else document


def _previous(document: Any) -> Any:
    getter = getattr(document, "get_doc_before_save", None)
    return _as_dict(getter()) if callable(getter) else None


def _value(doctype: str, name: str | None, field: str) -> Any:
    if not name:
        return None
    return frappe.db.get_value(doctype, name, field)


def _context(document: Any, kind: str) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if kind == "material_takeoff":
        context["measurement_status"] = _value(
            "Measurement Report", document.get("measurement_report"), "review_status"
        )
    elif kind in {"supplier_quote", "supplier_order"}:
        context["takeoff_status"] = _value(
            "Material Takeoff", document.get("material_takeoff"), "status"
        )
        if kind == "supplier_order":
            context["supplier_quote_status"] = _value(
                "Supplier Quote", document.get("source_quote"), "status"
            )
    elif kind == "proposal_evidence_pack":
        context["quote_status"] = _value(
            "Customer Quote", document.get("quotation"), "status"
        )
        context["signed_evidence_type"] = _value(
            "Evidence Item", document.get("signed_evidence"), "evidence_type"
        )
    elif kind in {"warranty_packet", "review_request"}:
        context["completion_status"] = _value(
            "Completion Packet", document.get("completion_packet"), "status"
        )
    elif kind == "roof_job" and document.get("job_status") in {
        "In Production",
        "Closed",
    }:
        roof_job = document.get("name") or document.get("roof_job_id")
        context["gates"] = frappe.get_all(
            "Production Gate State",
            filters={"roof_job": roof_job},
            fields=[
                "gate",
                "state",
                "blocker_reason",
                "evidence_item",
                "waived_by",
                "waived_at",
                "waiver_reason",
            ],
        )
        if document.get("job_status") == "Closed":
            context["completion_packets"] = frappe.get_all(
                "Completion Packet", filters={"roof_job": roof_job}, fields=["status"]
            )
            context["warranty_packets"] = frappe.get_all(
                "Warranty Packet", filters={"roof_job": roof_job}, fields=["status"]
            )
            context["payment_milestones"] = frappe.get_all(
                "Payment Milestone", filters={"roof_job": roof_job}, fields=["status"]
            )
    elif kind == "white_label_tenant" and document.get("status") == "Active":
        filters: dict[str, Any] = {"status": "Active"}
        if document.get("name"):
            filters["name"] = ["!=", document.get("name")]
        context["other_active_tenants"] = frappe.db.count(
            "White-Label Tenant", filters=filters
        )
    return context


def validate_business_document(document: Any, kind: str) -> None:
    try:
        validate_record(
            kind,
            _as_dict(document),
            previous=_previous(document),
            context=_context(document, kind),
        )
    except PolicyViolation as exc:
        frappe.throw(str(exc), exc=frappe.ValidationError)
