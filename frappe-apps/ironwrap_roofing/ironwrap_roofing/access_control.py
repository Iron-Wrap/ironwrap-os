"""Canonical site-local roles and least-privilege DocType access matrix."""

from __future__ import annotations

SYSTEM_MANAGER = "System Manager"
CUSTOMER_ACCEPTANCE_SERVICE_ROLE = "IronWrap Customer Acceptance Service"
QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE = (
    "IronWrap QuickBooks Reconciliation Issuer"
)
FACET_DESIGN_PROJECTION_SERVICE_ROLE = "IronWrap Facet Design Projection Service"
# Separate from the acceptance service on purpose: this identity may record a provisional
# customer preference and its receipt evidence, and can never sign a contract or touch a quote.
CUSTOMER_DECISION_SERVICE_ROLE = "IronWrap Customer Decision Service"
LAUNCH_PROOF_READER_ROLE = "IronWrap Launch Proof Reader"

IRONWRAP_ROLES = (
    "IronWrap Owner",
    "IronWrap Sales",
    "IronWrap Estimator",
    "IronWrap Production",
    "IronWrap Field",
    "IronWrap Finance",
    "IronWrap Closeout",
    "IronWrap Support",
)
IRONWRAP_SERVICE_ROLES = (
    CUSTOMER_ACCEPTANCE_SERVICE_ROLE,
    CUSTOMER_DECISION_SERVICE_ROLE,
    QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE,
    FACET_DESIGN_PROJECTION_SERVICE_ROLE,
    LAUNCH_PROOF_READER_ROLE,
)
ALL_IRONWRAP_ROLES = IRONWRAP_ROLES + IRONWRAP_SERVICE_ROLES

READ = "read"
WRITE = "write"
WRITE_EXISTING = "write_existing"
CREATE_OWN = "create_own"
CREATE = "create"
CREATE_WRITE = "create_write"

# Each Frappe site is one tenant.  These roles never grant cross-site access.
DOCTYPE_ROLE_MATRIX: dict[str, dict[str, str]] = {
    "Appointment Request": {
        "IronWrap Sales": WRITE,
        "IronWrap Support": READ,
    },
    "Asset Custody Event": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Support": READ,
    },
    "Asset Defect": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Asset Inspection": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Asset Usage Log": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Finance": READ,
    },
    "Automation Incident": {"IronWrap Support": WRITE},
    "Authority Record": {
        "IronWrap Production": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Cargo Load": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Change Order": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Production": WRITE,
        "IronWrap Finance": READ,
        "IronWrap Closeout": READ,
    },
    "Communication Event": {
        "IronWrap Sales": WRITE,
        "IronWrap Closeout": WRITE,
        "IronWrap Support": READ,
    },
    "Communication Consent": {
        "IronWrap Sales": WRITE,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Controlled Item": {
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
    },
    "Completion Packet": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": WRITE,
    },
    "Customer Quote": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Finance": READ,
        "IronWrap Production": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: WRITE_EXISTING,
        FACET_DESIGN_PROJECTION_SERVICE_ROLE: CREATE_WRITE,
    },
    "Contract Acceptance": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Finance": READ,
        "IronWrap Production": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: CREATE,
    },
    "Crew Profile": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Support": READ,
    },
    "Customer Decision": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
        "IronWrap Closeout": READ,
        CUSTOMER_DECISION_SERVICE_ROLE: CREATE,
    },
    "Driver Authority": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Support": READ,
    },
    "Evidence Item": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": WRITE,
        "IronWrap Support": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: CREATE,
        CUSTOMER_DECISION_SERVICE_ROLE: CREATE,
        FACET_DESIGN_PROJECTION_SERVICE_ROLE: CREATE,
    },
    "Field Check-in": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": READ,
    },
    "Fleet Asset": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
        "IronWrap Support": READ,
    },
    "Hermes Run": {"IronWrap Support": WRITE},
    "Instant Estimate Session": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Support": READ,
        LAUNCH_PROOF_READER_ROLE: READ,
    },
    "Integration Reconciliation": {
        "IronWrap Finance": WRITE,
        "IronWrap Production": READ,
        "IronWrap Support": WRITE,
        # Generic creation is independently rejected for QuickBooks by a
        # private issuer context; this create-only role exists solely so the
        # bounded command can insert one Pending record.
        QUICKBOOKS_RECONCILIATION_ISSUER_SERVICE_ROLE: CREATE,
        FACET_DESIGN_PROJECTION_SERVICE_ROLE: CREATE,
    },
    "Insurance Supplement": {"IronWrap Estimator": WRITE},
    "Job Cost Event": {
        "IronWrap Finance": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Production": READ,
        "IronWrap Closeout": READ,
    },
    "Job Assignment": {
        "IronWrap Sales": READ,
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
    },
    "Job Compliance Record": {
        "IronWrap Sales": READ,
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Lead Envelope": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Production": READ,
        "IronWrap Finance": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Maintenance Order": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
    },
    "Market Watch Item": {"IronWrap Support": WRITE, "IronWrap Estimator": READ},
    "Material Lot": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
    },
    "Material Takeoff": {
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
        "IronWrap Finance": READ,
    },
    "Material Takeoff Policy": {
        "IronWrap Estimator": READ,
        "IronWrap Production": READ,
    },
    "Measurement Report": {
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
        "IronWrap Field": READ,
    },
    "Nonconformance": {
        "IronWrap Production": WRITE,
        "IronWrap Field": CREATE_OWN,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Option Package": {
        "IronWrap Estimator": WRITE,
        "IronWrap Sales": READ,
        "IronWrap Finance": READ,
        CUSTOMER_DECISION_SERVICE_ROLE: READ,
    },
    "Payment Milestone": {
        "IronWrap Finance": WRITE,
        "IronWrap Sales": READ,
        "IronWrap Production": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Price Book Rule": {"IronWrap Estimator": WRITE, "IronWrap Finance": READ},
    "Production Gate State": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
    },
    "Proposal Evidence Pack": {
        "IronWrap Estimator": WRITE,
        "IronWrap Sales": WRITE,
        "IronWrap Closeout": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: READ,
    },
    "Review Request": {
        "IronWrap Closeout": WRITE,
        "IronWrap Sales": READ,
        "IronWrap Support": READ,
    },
    "Reception Session": {
        "IronWrap Sales": WRITE,
        "IronWrap Support": READ,
    },
    "Roof Area": {
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
        "IronWrap Field": READ,
    },
    "Roof Job": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
        "IronWrap Closeout": WRITE,
        "IronWrap Support": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: READ,
        CUSTOMER_DECISION_SERVICE_ROLE: READ,
        FACET_DESIGN_PROJECTION_SERVICE_ROLE: READ,
    },
    "Roofing Customer": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Production": READ,
        "IronWrap Finance": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
        CUSTOMER_ACCEPTANCE_SERVICE_ROLE: READ,
        CUSTOMER_DECISION_SERVICE_ROLE: READ,
    },
    "Roofing Property": {
        "IronWrap Sales": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Production": READ,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
    },
    "Safety Plan": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
        "IronWrap Support": READ,
    },
    "Shop Order": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
        "IronWrap Closeout": READ,
    },
    "Scope Clause": {
        "IronWrap Estimator": WRITE,
        "IronWrap Sales": READ,
        "IronWrap Production": READ,
        "IronWrap Closeout": READ,
    },
    "Service Case": {
        "IronWrap Support": WRITE,
        "IronWrap Production": WRITE,
        "IronWrap Closeout": WRITE,
        "IronWrap Field": READ,
        "IronWrap Finance": READ,
        "IronWrap Sales": READ,
    },
    "Supplier Order": {
        "IronWrap Production": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Finance": READ,
        "IronWrap Field": READ,
    },
    "Supplier Profile": {
        "IronWrap Production": WRITE,
        "IronWrap Estimator": READ,
        "IronWrap Finance": READ,
    },
    "Supplier Quote": {
        "IronWrap Production": WRITE,
        "IronWrap Estimator": WRITE,
        "IronWrap Finance": READ,
    },
    "Tenant Export Run": {
        "IronWrap Finance": READ,
        "IronWrap Support": WRITE,
    },
    "Visual Property Model": {
        "IronWrap Estimator": WRITE,
        "IronWrap Sales": READ,
        "IronWrap Production": READ,
        "IronWrap Field": READ,
    },
    "Warranty Packet": {
        "IronWrap Closeout": WRITE,
        "IronWrap Production": READ,
        "IronWrap Sales": READ,
    },
    "White-Label Tenant": {"IronWrap Support": WRITE},
    "Work Package": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
    },
    "Work Package Event": {
        "IronWrap Production": WRITE,
        "IronWrap Field": READ,
        "IronWrap Closeout": READ,
    },
}


def permission_row(role: str, access: str) -> dict[str, int | str]:
    row: dict[str, int | str] = {
        "role": role,
        "read": 1,
        "delete": 0,
    }
    if access == WRITE:
        row.update({"create": 1, "write": 1, "print": 1, "report": 1})
    elif access == WRITE_EXISTING:
        row.update({"write": 1})
    elif access == READ:
        row.update({"print": 1, "report": 1})
    elif access == CREATE_OWN:
        row.update({"create": 1, "write": 1, "if_owner": 1})
    elif access == CREATE:
        row.update({"create": 1})
    elif access == CREATE_WRITE:
        row.update({"create": 1, "write": 1})
    else:
        raise ValueError(f"unknown access level {access!r}")
    return row


def expected_permissions(doctype: str) -> list[dict[str, int | str]]:
    """Return the canonical permission rows used by schema contract tests."""

    rows: list[dict[str, int | str]] = [
        {
            "role": SYSTEM_MANAGER,
            "create": 1,
            "delete": 0,
            "export": 1,
            "import": 1,
            "print": 1,
            "read": 1,
            "report": 1,
            "share": 1,
            "write": 1,
        }
    ]
    rows.append(permission_row("IronWrap Owner", WRITE))
    for role, access in DOCTYPE_ROLE_MATRIX.get(doctype, {}).items():
        rows.append(permission_row(role, access))
    return rows
