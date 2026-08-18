from __future__ import annotations

import hashlib
import json
import sys
import types
import unittest
from unittest.mock import patch

from ironwrap_roofing.commercial_migration import (
    CommercialMigrationBlocked,
    commercial_schema_preflight_report,
    execute_commercial_schema_preflight,
    plan_commercial_schema_migration,
)


PRICE_RULE_JSON = (
    '{"schema_version":"ironwrap.price-rule.v1",'
    '"operation":"quantity_times_unit_price","rounding":"half_up_cent"}'
)


def price_rule(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": "RULE-1",
        "rule_type": "Material",
        "status": "Approved",
        "unit_price": "12.345",
        "minimum_quantity": "0",
        "currency": "CAD",
        "source_ref": "supplier-sheet:2026-08",
        "rule_json": PRICE_RULE_JSON,
        "effective_from": "2026-08-01",
        "effective_to": "2026-08-31",
        "approved_by": "owner@example.com",
        "approved_at": "2026-07-31 12:00:00",
        "assumptions": "Exact source facts only.",
        "exclusions": "No unlisted commercial inputs.",
        "approval_note": "Owner reviewed the exact rule.",
    }
    record.update(overrides)
    return record


def pricing_policy_anchor(**overrides: object) -> dict[str, object]:
    snapshot = {
        "approvedPolicy": {
            "schemaVersion": "ironwrap.pricing-policy.v1",
            "tenantId": "ironwrap",
            "policyId": "retail-metal",
            "revision": 1,
            "effectiveAt": "2026-08-01T00:00:00.000Z",
            "expiresAt": "2026-08-31T23:59:59.999Z",
            "pricing": {"method": "markup", "rateBps": 1000},
            "freightCents": 0,
            "contingencyRateBps": 0,
            "minimumChargeCents": 0,
            "taxRateBps": 500,
        },
        "currency": "CAD",
        "panel": {
            "sku": "PANEL",
            "unit": "lf",
            "rateCents": 500,
            "sourceRef": "price-book:panel",
        },
        "trims": {},
    }
    canonical = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    return price_rule(
        rule_type="Pricing Policy",
        unit_price=None,
        minimum_quantity=None,
        rule_json=(
            '{"operation":"bind_canonical_pricing_snapshot",'
            '"schema_version":"ironwrap.price-policy-authority.v1"}'
        ),
        pricing_policy_id="retail-metal",
        pricing_policy_revision=1,
        pricing_policy_snapshot_json=canonical,
        pricing_policy_snapshot_sha256=hashlib.sha256(
            canonical.encode("utf-8")
        ).hexdigest(),
        **overrides,
    )


def supplier_quote(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": "QUOTE-1",
        "status": "Needs Review",
        "quoted_at": "2026-08-10 12:00:00",
        "valid_until": "2026-08-31",
        "quote_total": None,
        "currency": "CAD",
    }
    record.update(overrides)
    return record


def supplier_item(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": "ITEM-1",
        "parent": "QUOTE-1",
        "item_name": "Synthetic panel",
        "quantity": "2.5",
        "unit": "sheet",
        "unit_price": "10.005",
        "line_total": None,
        "source_ref": "supplier-sheet:line-1",
    }
    record.update(overrides)
    return record


class CommercialMigrationPlanTests(unittest.TestCase):
    def fake_frappe(
        self,
        rules: list[dict[str, object]],
        quotes: list[dict[str, object]],
        items: list[dict[str, object]],
    ) -> tuple[types.ModuleType, list[tuple[str, str, dict[str, str], bool]]]:
        datasets = {
            "Price Book Rule": rules,
            "Supplier Quote": quotes,
            "Supplier Quote Item": items,
        }
        writes: list[tuple[str, str, dict[str, str], bool]] = []
        frappe_module = types.ModuleType("frappe")
        frappe_module.get_all = lambda doctype, **_kwargs: datasets[doctype]
        frappe_module.db = types.SimpleNamespace(
            savepoint=lambda _name: None,
            release_savepoint=lambda _name: None,
            rollback=lambda **_kwargs: None,
            set_value=lambda doctype, name, values, update_modified: writes.append(
                (doctype, name, values, update_modified)
            )
        )
        return frappe_module, writes

    def test_empty_database_is_a_clean_noop(self) -> None:
        plan = plan_commercial_schema_migration([], [], [])

        self.assertEqual(plan.updates, ())
        self.assertEqual(plan.issues, ())

    def test_blank_totals_are_backfilled_only_from_exact_line_arithmetic(self) -> None:
        first = plan_commercial_schema_migration(
            [price_rule()], [supplier_quote()], [supplier_item()]
        )

        self.assertEqual(first.issues, ())
        self.assertEqual(
            [
                (update.doctype, update.name, dict(update.values))
                for update in first.updates
            ],
            [
                ("Supplier Quote Item", "ITEM-1", {"line_total": "25.01"}),
                ("Supplier Quote", "QUOTE-1", {"quote_total": "25.01"}),
            ],
        )

        # Applying those exact values makes the same planner a no-op on retry.
        second = plan_commercial_schema_migration(
            [price_rule()],
            [supplier_quote(quote_total="25.01")],
            [supplier_item(line_total="25.01")],
        )
        self.assertEqual(second.updates, ())
        self.assertEqual(second.issues, ())

    def test_unknown_commercial_facts_and_tampered_totals_block_without_updates(
        self,
    ) -> None:
        plan = plan_commercial_schema_migration(
            [price_rule(effective_to=None, rule_json='{"operation":"eval"}')],
            [supplier_quote(currency=None, quote_total="20.00")],
            [supplier_item(source_ref=None, line_total="25.00")],
        )

        self.assertEqual(plan.updates, ())
        self.assertEqual(
            {
                (issue.doctype, issue.name, issue.code, issue.field)
                for issue in plan.issues
            },
            {
                ("Price Book Rule", "RULE-1", "missing_required_fact", "effective_to"),
                ("Price Book Rule", "RULE-1", "invalid_rule_contract", "rule_json"),
                ("Supplier Quote", "QUOTE-1", "missing_required_fact", "currency"),
                ("Supplier Quote", "QUOTE-1", "non_derivable_total", "quote_total"),
                (
                    "Supplier Quote Item",
                    "ITEM-1",
                    "missing_required_fact",
                    "source_ref",
                ),
                ("Supplier Quote Item", "ITEM-1", "line_total_mismatch", "line_total"),
            },
        )

    def test_duplicate_price_rule_keys_cannot_bypass_closed_contract(self) -> None:
        duplicate_contract = (
            '{"schema_version":"ignored",'
            '"schema_version":"ironwrap.price-rule.v1",'
            '"operation":"quantity_times_unit_price",'
            '"rounding":"half_up_cent"}'
        )

        plan = plan_commercial_schema_migration(
            [price_rule(rule_json=duplicate_contract)], [], []
        )

        self.assertEqual(plan.updates, ())
        self.assertEqual(
            [
                (issue.doctype, issue.name, issue.code, issue.field)
                for issue in plan.issues
            ],
            [("Price Book Rule", "RULE-1", "invalid_rule_contract", "rule_json")],
        )

    def test_frappe_gate_applies_complete_plan_or_zero_writes(self) -> None:
        clean_frappe, clean_writes = self.fake_frappe(
            [price_rule()], [supplier_quote()], [supplier_item()]
        )
        with patch.dict(sys.modules, {"frappe": clean_frappe}):
            plan = execute_commercial_schema_preflight()
        self.assertEqual(len(plan.updates), 2)
        self.assertEqual(
            clean_writes,
            [
                ("Supplier Quote Item", "ITEM-1", {"line_total": "25.01"}, False),
                ("Supplier Quote", "QUOTE-1", {"quote_total": "25.01"}, False),
            ],
        )

        blocked_frappe, blocked_writes = self.fake_frappe(
            [price_rule(currency=None)],
            [supplier_quote(currency=None)],
            [supplier_item(source_ref=None)],
        )
        with patch.dict(sys.modules, {"frappe": blocked_frappe}):
            with self.assertRaises(CommercialMigrationBlocked) as caught:
                execute_commercial_schema_preflight()
        self.assertGreater(len(caught.exception.issues), 0)
        self.assertEqual(blocked_writes, [])

    def test_read_only_report_enumerates_opaque_blockers_without_writes(self) -> None:
        frappe_module, writes = self.fake_frappe(
            [price_rule(effective_to=None)], [], []
        )
        with patch.dict(sys.modules, {"frappe": frappe_module}):
            report = commercial_schema_preflight_report()

        self.assertFalse(report["ready"])
        self.assertEqual(report["safe_update_count"], 0)
        self.assertEqual(report["unresolved_count"], 1)
        self.assertEqual(report["counts"], {"Price Book Rule.missing_required_fact": 1})
        self.assertEqual(
            report["issues"],
            [
                {
                    "doctype": "Price Book Rule",
                    "name": "RULE-1",
                    "code": "missing_required_fact",
                    "field": "effective_to",
                }
            ],
        )
        self.assertEqual(writes, [])

    def test_approved_policy_anchor_requires_exact_canonical_snapshot_facts(
        self,
    ) -> None:
        anchor = pricing_policy_anchor()
        canonical = str(anchor["pricing_policy_snapshot_json"])

        valid = plan_commercial_schema_migration([anchor], [], [])
        self.assertEqual(valid.issues, ())

        opaque_hash_only = plan_commercial_schema_migration(
            [{**anchor, "pricing_policy_snapshot_json": None}], [], []
        )
        self.assertEqual(opaque_hash_only.updates, ())
        self.assertIn(
            (
                "Price Book Rule",
                "RULE-1",
                "missing_required_fact",
                "pricing_policy_snapshot_json",
            ),
            {
                (issue.doctype, issue.name, issue.code, issue.field)
                for issue in opaque_hash_only.issues
            },
        )

        tampered = plan_commercial_schema_migration(
            [{**anchor, "pricing_policy_snapshot_json": f"{canonical} "}], [], []
        )
        self.assertIn(
            "invalid_policy_snapshot",
            {issue.code for issue in tampered.issues},
        )

        malformed_approval = plan_commercial_schema_migration(
            [{**anchor, "approved_at": "2026-07-31T12:00:00.000Z"}], [], []
        )
        self.assertIn(
            "invalid_policy_approval",
            {issue.code for issue in malformed_approval.issues},
        )

    def test_pre_schema_read_never_selects_absent_policy_columns(self) -> None:
        requested_fields: dict[str, list[str]] = {}
        datasets = {
            "Price Book Rule": [pricing_policy_anchor()],
            "Supplier Quote": [],
            "Supplier Quote Item": [],
        }
        frappe_module = types.ModuleType("frappe")

        def get_all(doctype: str, *, fields: list[str], **_kwargs: object):
            requested_fields[doctype] = fields
            return [
                {field: row.get(field) for field in fields}
                for row in datasets[doctype]
            ]

        frappe_module.get_all = get_all
        frappe_module.db = types.SimpleNamespace(
            has_column=lambda doctype, field: not (
                doctype == "Price Book Rule"
                and field.startswith("pricing_policy_")
            ),
        )

        with self.assertRaises(CommercialMigrationBlocked) as caught:
            execute_commercial_schema_preflight(frappe_module)

        self.assertTrue(
            {
                "pricing_policy_id",
                "pricing_policy_revision",
                "pricing_policy_snapshot_json",
                "pricing_policy_snapshot_sha256",
            }.isdisjoint(requested_fields["Price Book Rule"])
        )
        self.assertEqual(
            {
                issue.field
                for issue in caught.exception.issues
                if issue.doctype == "Price Book Rule"
            }
            & {
                "pricing_policy_id",
                "pricing_policy_revision",
                "pricing_policy_snapshot_json",
                "pricing_policy_snapshot_sha256",
            },
            {
                "pricing_policy_id",
                "pricing_policy_revision",
                "pricing_policy_snapshot_json",
                "pricing_policy_snapshot_sha256",
            },
        )

        datasets["Price Book Rule"] = [price_rule()]
        clean = execute_commercial_schema_preflight(frappe_module)
        self.assertEqual(clean.issues, ())
        self.assertEqual(clean.updates, ())

    def test_update_failure_rolls_back_to_preflight_savepoint(self) -> None:
        events: list[object] = []
        update_count = 0
        frappe_module, _writes = self.fake_frappe(
            [price_rule()], [supplier_quote()], [supplier_item()]
        )

        def set_value(*args: object, **kwargs: object) -> None:
            nonlocal update_count
            update_count += 1
            events.append((args, kwargs))
            if update_count == 2:
                raise RuntimeError("synthetic second update failure")

        frappe_module.db.savepoint = lambda name: events.append(("savepoint", name))
        frappe_module.db.set_value = set_value
        frappe_module.db.rollback = lambda **kwargs: events.append(
            ("rollback", kwargs)
        )
        frappe_module.db.release_savepoint = lambda name: events.append(
            ("release_savepoint", name)
        )

        with self.assertRaisesRegex(RuntimeError, "synthetic second update failure"):
            execute_commercial_schema_preflight(frappe_module)

        self.assertEqual(events[0], ("savepoint", "ironwrap_commercial_schema_preflight"))
        self.assertEqual(
            events[-1],
            (
                "rollback",
                {"save_point": "ironwrap_commercial_schema_preflight"},
            ),
        )
        self.assertEqual(update_count, 2)
        self.assertNotIn(
            ("release_savepoint", "ironwrap_commercial_schema_preflight"),
            events,
        )

    def test_success_releases_preflight_savepoint_after_all_updates(self) -> None:
        events: list[object] = []
        frappe_module, _writes = self.fake_frappe(
            [price_rule()], [supplier_quote()], [supplier_item()]
        )
        frappe_module.db.savepoint = lambda name: events.append(("savepoint", name))
        frappe_module.db.set_value = lambda *args, **kwargs: events.append(
            ("set_value", args, kwargs)
        )
        frappe_module.db.release_savepoint = lambda name: events.append(
            ("release_savepoint", name)
        )
        frappe_module.db.rollback = lambda **kwargs: events.append(
            ("rollback", kwargs)
        )

        execute_commercial_schema_preflight(frappe_module)

        self.assertEqual(events[0], ("savepoint", "ironwrap_commercial_schema_preflight"))
        self.assertEqual(
            events[-1],
            ("release_savepoint", "ironwrap_commercial_schema_preflight"),
        )
        self.assertEqual(
            sum(1 for event in events if isinstance(event, tuple) and event[0] == "set_value"),
            2,
        )
        self.assertFalse(any(event[0] == "rollback" for event in events))


if __name__ == "__main__":
    unittest.main()
