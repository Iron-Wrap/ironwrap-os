"""Install hooks for site-local IronWrap roles."""

from __future__ import annotations

import frappe

from ironwrap_roofing.access_control import IRONWRAP_ROLES


def ensure_roles() -> None:
    """Create or repair every site-local role used by DocType permissions."""

    for role_name in IRONWRAP_ROLES:
        existing_role = frappe.db.exists("Role", role_name)
        if existing_role:
            frappe.db.set_value(
                "Role",
                existing_role,
                {"desk_access": 1, "disabled": 0},
                update_modified=False,
            )
            continue
        frappe.get_doc(
            {
                "doctype": "Role",
                "role_name": role_name,
                "desk_access": 1,
                "disabled": 0,
            }
        ).insert(ignore_permissions=True)


def reconcile_site_contract() -> None:
    """Idempotently repair roles and invalidate stale permission metadata."""

    ensure_roles()
    frappe.clear_cache()


def backfill_lead_triage_unknown() -> None:
    """Make pre-triage Lead Envelopes explicit data-quality work, never fresh leads."""

    frappe.db.sql(
        """
        UPDATE `tabLead Envelope`
        SET triage_status = 'Unknown'
        WHERE triage_status IS NULL OR TRIM(triage_status) = ''
        """
    )


def before_install() -> None:
    """Create app roles before initial DocType permission synchronization."""

    reconcile_site_contract()


def before_migrate() -> None:
    """Ensure upgraded sites have roles before DocType permissions are reloaded."""

    reconcile_site_contract()


def after_install() -> None:
    """Make role creation durable before the first operator session."""

    frappe.db.commit()
    frappe.clear_cache()


def after_migrate() -> None:
    """Reconcile permissions again after DocType metadata has been installed."""

    reconcile_site_contract()
    backfill_lead_triage_unknown()
