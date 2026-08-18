"""Fail-before-write preflight for the commercial-truth schema upgrade.

The migration may derive only arithmetic already implied by persisted supplier
quote lines. Currency, dates, provenance, rule meaning, and validity windows are
business facts and are never defaulted. The pure planner makes an entire-site
decision before the Frappe adapter performs any update, so an unresolved row
cannot leave a partially backfilled site.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Sequence

from ironwrap_roofing.domain_policy import (
    PolicyViolation,
    validate_pricing_policy_approval_evidence,
    validate_pricing_policy_snapshot,
)


MONEY_QUANTUM = Decimal("0.01")
PRICE_RULE_CONTRACT = {
    "schema_version": "ironwrap.price-rule.v1",
    "operation": "quantity_times_unit_price",
    "rounding": "half_up_cent",
}
PRICE_POLICY_AUTHORITY_CONTRACT = {
    "schema_version": "ironwrap.price-policy-authority.v1",
    "operation": "bind_canonical_pricing_snapshot",
}
PRICING_POLICY_FIELDS = (
    "pricing_policy_id",
    "pricing_policy_revision",
    "pricing_policy_snapshot_json",
    "pricing_policy_snapshot_sha256",
)


@dataclass(frozen=True)
class CommercialMigrationIssue:
    doctype: str
    name: str
    code: str
    field: str


@dataclass(frozen=True)
class CommercialMigrationUpdate:
    doctype: str
    name: str
    values: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class CommercialMigrationPlan:
    updates: tuple[CommercialMigrationUpdate, ...]
    issues: tuple[CommercialMigrationIssue, ...]


class CommercialMigrationBlocked(RuntimeError):
    """Raised before schema sync when unresolved commercial facts remain."""

    def __init__(self, issues: tuple[CommercialMigrationIssue, ...]):
        self.issues = issues
        counts: dict[str, int] = {}
        for issue in issues:
            key = f"{issue.doctype}.{issue.code}"
            counts[key] = counts.get(key, 0) + 1
        summary = ", ".join(f"{key}={counts[key]}" for key in sorted(counts))
        super().__init__(
            "commercial schema migration blocked; resolve persisted facts before "
            f"schema sync ({summary})"
        )


def _text(record: Mapping[str, Any], field: str) -> str:
    value = record.get(field)
    return value.strip() if isinstance(value, str) else ""


def _missing(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _decimal(value: Any) -> Decimal | None:
    if _missing(value) or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return number if number.is_finite() and number >= 0 else None


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_text(value: Decimal) -> str:
    return format(_money(value), ".2f")


def _unique_json_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate key {key!r}")
        value[key] = item
    return value


def _issue(
    issues: list[CommercialMigrationIssue],
    doctype: str,
    record: Mapping[str, Any],
    code: str,
    field: str,
) -> None:
    issues.append(
        CommercialMigrationIssue(
            doctype, str(record.get("name") or "<unnamed>"), code, field
        )
    )


def _required(
    issues: list[CommercialMigrationIssue],
    doctype: str,
    record: Mapping[str, Any],
    fields: Iterable[str],
) -> None:
    for field in fields:
        if _missing(record.get(field)):
            _issue(issues, doctype, record, "missing_required_fact", field)


def _parsed_json_object(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, Mapping):
        value = dict(raw)
    elif isinstance(raw, str):
        try:
            value = json.loads(raw, object_pairs_hook=_unique_json_object)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    else:
        return None
    return value if isinstance(value, dict) else None


def _valid_rule_contract(raw: Any, expected: Mapping[str, Any]) -> bool:
    return _parsed_json_object(raw) == expected


def _valid_policy_snapshot(rule: Mapping[str, Any]) -> bool:
    try:
        validate_pricing_policy_snapshot(rule)
    except PolicyViolation:
        return False
    return True


def _valid_policy_approval(rule: Mapping[str, Any]) -> bool:
    try:
        validate_pricing_policy_approval_evidence(rule)
    except PolicyViolation:
        return False
    return True


def plan_commercial_schema_migration(
    price_rules: Iterable[Mapping[str, Any]],
    supplier_quotes: Iterable[Mapping[str, Any]],
    supplier_quote_items: Iterable[Mapping[str, Any]],
) -> CommercialMigrationPlan:
    """Return an all-or-nothing deterministic update plan and opaque blockers."""

    issues: list[CommercialMigrationIssue] = []
    candidate_updates: list[CommercialMigrationUpdate] = []
    totals_by_parent: dict[str, Decimal] = {}
    item_count_by_parent: dict[str, int] = {}
    invalid_parents: set[str] = set()

    for rule in price_rules:
        # These two fields became schema-required for every lifecycle state.
        _required(
            issues,
            "Price Book Rule",
            rule,
            ("currency", "effective_to"),
        )
        if rule.get("status") != "Approved":
            continue
        is_policy_anchor = rule.get("rule_type") == "Pricing Policy"
        _required(
            issues,
            "Price Book Rule",
            rule,
            (
                "source_ref",
                "rule_json",
                "effective_from",
                "approved_by",
                "approved_at",
                "assumptions",
                "exclusions",
                "approval_note",
                *(PRICING_POLICY_FIELDS if is_policy_anchor else ("unit_price", "minimum_quantity")),
            ),
        )
        expected_contract = (
            PRICE_POLICY_AUTHORITY_CONTRACT
            if is_policy_anchor
            else PRICE_RULE_CONTRACT
        )
        if not _valid_rule_contract(rule.get("rule_json"), expected_contract):
            _issue(
                issues, "Price Book Rule", rule, "invalid_rule_contract", "rule_json"
            )
        if is_policy_anchor:
            if not _valid_policy_approval(rule):
                _issue(
                    issues,
                    "Price Book Rule",
                    rule,
                    "invalid_policy_approval",
                    "approved_at",
                )
            if not _valid_policy_snapshot(rule):
                _issue(
                    issues,
                    "Price Book Rule",
                    rule,
                    "invalid_policy_snapshot",
                    "pricing_policy_snapshot_json",
                )
        elif _decimal(rule.get("unit_price")) is None:
            _issue(issues, "Price Book Rule", rule, "invalid_decimal", "unit_price")
        if not is_policy_anchor and _decimal(rule.get("minimum_quantity")) is None:
            _issue(
                issues, "Price Book Rule", rule, "invalid_decimal", "minimum_quantity"
            )
        effective_from = _text(rule, "effective_from")[:10]
        effective_to = _text(rule, "effective_to")[:10]
        if effective_from and effective_to and effective_from > effective_to:
            _issue(
                issues,
                "Price Book Rule",
                rule,
                "invalid_effective_window",
                "effective_to",
            )

    for item in supplier_quote_items:
        parent = _text(item, "parent")
        _required(
            issues,
            "Supplier Quote Item",
            item,
            ("parent", "item_name", "quantity", "unit", "unit_price", "source_ref"),
        )
        quantity = _decimal(item.get("quantity"))
        unit_price = _decimal(item.get("unit_price"))
        if not parent or quantity is None or unit_price is None:
            if parent:
                invalid_parents.add(parent)
            if quantity is None:
                _issue(
                    issues, "Supplier Quote Item", item, "invalid_decimal", "quantity"
                )
            if unit_price is None:
                _issue(
                    issues, "Supplier Quote Item", item, "invalid_decimal", "unit_price"
                )
            continue
        expected = _money(quantity * unit_price)
        stored = _decimal(item.get("line_total"))
        if _missing(item.get("line_total")):
            candidate_updates.append(
                CommercialMigrationUpdate(
                    "Supplier Quote Item",
                    str(item.get("name") or "<unnamed>"),
                    (("line_total", _money_text(expected)),),
                )
            )
        elif stored is None or stored != expected:
            _issue(
                issues, "Supplier Quote Item", item, "line_total_mismatch", "line_total"
            )
            invalid_parents.add(parent)
        totals_by_parent[parent] = totals_by_parent.get(parent, Decimal("0")) + expected
        item_count_by_parent[parent] = item_count_by_parent.get(parent, 0) + 1

    quote_names: set[str] = set()
    for quote in supplier_quotes:
        name = str(quote.get("name") or "<unnamed>")
        quote_names.add(name)
        _required(
            issues,
            "Supplier Quote",
            quote,
            ("quoted_at", "valid_until", "currency"),
        )
        if item_count_by_parent.get(name, 0) == 0:
            _issue(issues, "Supplier Quote", quote, "missing_quote_items", "items")
            continue
        if name in invalid_parents:
            _issue(
                issues, "Supplier Quote", quote, "non_derivable_total", "quote_total"
            )
            continue
        expected = _money(totals_by_parent[name])
        stored = _decimal(quote.get("quote_total"))
        if _missing(quote.get("quote_total")):
            candidate_updates.append(
                CommercialMigrationUpdate(
                    "Supplier Quote", name, (("quote_total", _money_text(expected)),)
                )
            )
        elif stored is None or stored != expected:
            _issue(
                issues, "Supplier Quote", quote, "quote_total_mismatch", "quote_total"
            )

    for parent in sorted(set(item_count_by_parent) - quote_names):
        issues.append(
            CommercialMigrationIssue(
                "Supplier Quote Item", "<aggregate>", "orphan_quote_items", parent
            )
        )

    ordered_issues = tuple(
        sorted(issues, key=lambda row: (row.doctype, row.name, row.code, row.field))
    )
    return CommercialMigrationPlan(
        updates=()
        if ordered_issues
        else tuple(
            sorted(
                candidate_updates,
                key=lambda row: (
                    0 if row.doctype == "Supplier Quote Item" else 1,
                    row.name,
                ),
            )
        ),
        issues=ordered_issues,
    )


def _load_commercial_schema_plan(frappe: Any) -> CommercialMigrationPlan:
    has_column = getattr(frappe.db, "has_column", None)
    policy_fields_available = not callable(has_column) or all(
        has_column("Price Book Rule", field) for field in PRICING_POLICY_FIELDS
    )
    price_rule_fields = [
        "name",
        "rule_type",
        "status",
        "unit_price",
        "minimum_quantity",
        "currency",
        "source_ref",
        "rule_json",
        "effective_from",
        "effective_to",
        "approved_by",
        "approved_at",
        "assumptions",
        "exclusions",
        "approval_note",
    ]
    if policy_fields_available:
        price_rule_fields.extend(PRICING_POLICY_FIELDS)
    price_rules = frappe.get_all(
        "Price Book Rule",
        fields=price_rule_fields,
        limit_page_length=0,
    )
    supplier_quotes = frappe.get_all(
        "Supplier Quote",
        fields=[
            "name",
            "status",
            "quoted_at",
            "valid_until",
            "quote_total",
            "currency",
        ],
        limit_page_length=0,
    )
    supplier_quote_items = frappe.get_all(
        "Supplier Quote Item",
        fields=[
            "name",
            "parent",
            "item_name",
            "quantity",
            "unit",
            "unit_price",
            "line_total",
            "source_ref",
        ],
        filters={"parenttype": "Supplier Quote"},
        limit_page_length=0,
    )
    return plan_commercial_schema_migration(
        price_rules, supplier_quotes, supplier_quote_items
    )


def commercial_schema_preflight_report() -> dict[str, Any]:
    """Return a read-only, countable report for ``bench execute`` preflight.

    Operator command (no writes):
    ``bench --site <site> execute ironwrap_roofing.commercial_migration.commercial_schema_preflight_report``
    """

    import frappe

    plan = _load_commercial_schema_plan(frappe)
    counts: dict[str, int] = {}
    for issue in plan.issues:
        key = f"{issue.doctype}.{issue.code}"
        counts[key] = counts.get(key, 0) + 1
    return {
        "ready": not plan.issues,
        "safe_update_count": len(plan.updates),
        "unresolved_count": len(plan.issues),
        "counts": {key: counts[key] for key in sorted(counts)},
        "issues": [
            {
                "doctype": issue.doctype,
                "name": issue.name,
                "code": issue.code,
                "field": issue.field,
            }
            for issue in plan.issues
        ],
    }


def execute_commercial_schema_preflight(
    frappe_module: Any | None = None,
) -> CommercialMigrationPlan:
    """Read all affected facts, abort cleanly, or apply the complete safe plan."""

    if frappe_module is None:
        import frappe as frappe_module

    plan = _load_commercial_schema_plan(frappe_module)
    if plan.issues:
        raise CommercialMigrationBlocked(plan.issues)
    if not plan.updates:
        return plan
    save_point = "ironwrap_commercial_schema_preflight"
    frappe_module.db.savepoint(save_point)
    try:
        for update in plan.updates:
            frappe_module.db.set_value(
                update.doctype,
                update.name,
                dict(update.values),
                update_modified=False,
            )
        frappe_module.db.release_savepoint(save_point)
    except Exception:
        frappe_module.db.rollback(save_point=save_point)
        raise
    return plan
