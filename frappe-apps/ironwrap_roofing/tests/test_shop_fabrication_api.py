from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


API_PATH = (
    Path(__file__).resolve().parents[1]
    / "ironwrap_roofing"
    / "shop_fabrication_api.py"
)


class FakeValidationError(Exception):
    pass


class FakePermissionError(Exception):
    pass


class FakeDoc(dict):
    def __init__(self, values: dict) -> None:
        super().__init__(values)
        object.__setattr__(self, "save_count", 0)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name == "save_count":
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def set(self, field: str, value) -> None:
        self[field] = value

    def save(self) -> None:
        self.save_count += 1


class FakeDb:
    def __init__(self, fixtures: dict) -> None:
        self.fixtures = fixtures
        self.lock_queries: list[tuple[str, tuple]] = []

    def sql(self, query: str, values: tuple, *, as_dict: bool):
        normalized = " ".join(query.split())
        if "FOR UPDATE" not in normalized:
            raise AssertionError(f"expected row lock: {normalized}")
        self.lock_queries.append((normalized, values))
        record_id = values[0]
        if "`tabHermes Run`" in normalized:
            run = self.fixtures["run"]
            return [dict(run)] if run.get("name") == record_id else []
        table_maps = (
            ("`tabControlled Item`", "items"),
            ("`tabMaterial Lot`", "lots"),
            ("`tabShop Order`", "orders"),
            ("`tabMaterial Takeoff`", "takeoffs"),
            ("`tabSupplier Order`", "supplier_orders"),
            ("`tabWork Package`", "work_packages"),
            ("`tabEvidence Item`", "evidence"),
        )
        for table, fixture_key in table_maps:
            if table in normalized:
                document = self.fixtures[fixture_key].get(record_id)
                return [dict(document)] if document is not None else []
        raise AssertionError(f"unexpected SQL: {normalized}")


class ShopFabricationApiTests(unittest.TestCase):
    def fixture_data(self) -> dict:
        return {
            "items": {
                "item-1": FakeDoc(
                    {
                        "name": "item-1",
                        "controlled_item_id": "item-1",
                        "status": "Draft",
                        "modified": "2026-07-30 10:00:00",
                        "approved_by": "",
                        "approved_at": "",
                        "approval_note": "",
                    }
                )
            },
            "lots": {
                "lot-1": FakeDoc(
                    {
                        "name": "lot-1",
                        "material_lot_id": "lot-1",
                        "roof_job": "job-1",
                        "controlled_item": "item-1",
                        "source_kind": "Supplier Receipt",
                        "supplier_order": "supplier-1",
                        "source_shop_order": "",
                        "source_evidence": "evidence-receipt-1",
                        "lot_number": "SUP-COIL-001",
                        "condition_status": "Accepted",
                        "received_quantity": 10,
                        "available_quantity": "",
                        "reserved_quantity": "",
                        "consumed_quantity": "",
                        "unit": "each",
                        "status": "Draft",
                        "modified": "2026-07-30 10:01:00",
                    }
                )
            },
            "orders": {
                "shop-1": FakeDoc(
                    {
                        "name": "shop-1",
                        "shop_order_id": "shop-1",
                        "roof_job": "job-1",
                        "material_takeoff": "takeoff-1",
                        "supplier_order": "supplier-1",
                        "work_package": "package-1",
                        "status": "Draft",
                        "modified": "2026-07-30 10:02:00",
                        "released_by": "",
                        "released_at": "",
                        "reserved_at": "",
                        "setup_started_at": "",
                        "quality_hold_reason": "",
                        "lines": [
                            {
                                "line_no": 1,
                                "controlled_item": "item-1",
                                "requested_quantity": 8,
                                "accepted_quantity": 8,
                                "billable_quantity": 8,
                                "unit": "each",
                                "dimensions": "2400 mm panel length",
                                "tolerance": "± 3 mm",
                                "orientation": "Eave to ridge",
                                "invoice_basis": "Each",
                            }
                        ],
                        "material_allocations": [],
                        "operations": [],
                    }
                )
            },
            "takeoffs": {
                "takeoff-1": FakeDoc(
                    {
                        "name": "takeoff-1",
                        "roof_job": "job-1",
                        "status": "Approved",
                    }
                )
            },
            "supplier_orders": {
                "supplier-1": FakeDoc(
                    {
                        "name": "supplier-1",
                        "roof_job": "job-1",
                        "status": "Received",
                    }
                )
            },
            "work_packages": {
                "package-1": FakeDoc(
                    {
                        "name": "package-1",
                        "roof_job": "job-1",
                        "status": "Released",
                    }
                )
            },
            "evidence": {
                "evidence-receipt-1": FakeDoc(
                    {
                        "name": "evidence-receipt-1",
                        "roof_job": "job-1",
                        "sync_state": "Verified",
                    }
                )
            },
            "run": {
                "name": "run-shop-0001",
                "run_id": "run-shop-0001",
                "agent_role": "Production Controller",
                "requested_by": "production@example.com",
                "target_doctype": "",
                "target_name": "",
                "roof_job": "job-1",
                "capability_level": "Approved-write",
                "tool_name": "",
                "tool_args_json": "{}",
                "dry_run_receipt": "signed-dry-run-receipt",
                "approval_receipt": "signed-approval-receipt",
                "policy_check_json": "{}",
                "approval_status": "Approved",
                "approved_by": "owner@example.com",
                "approved_at": "2026-07-30 10:00:00",
                "mutation_applied": 0,
            },
        }

    def load_api(
        self,
        fixtures: dict | None = None,
        *,
        session_user: str = "production@example.com",
        request_method: str = "POST",
        can_write: bool = True,
        roles: list[str] | None = None,
        permission_grants: dict[tuple[str, str], bool] | None = None,
    ):
        fixtures = fixtures or self.fixture_data()
        db = FakeDb(fixtures)
        context_calls: list[tuple[str, str]] = []

        @contextmanager
        def controlled_item_transition_context(document):
            self.assertEqual(document["status"], "Approved")
            context_calls.append(("controlled_item", document["name"]))
            yield

        @contextmanager
        def material_lot_transition_context(document):
            self.assertIn(document["status"], {"Available", "Quarantined", "Reserved"})
            context_calls.append(("material_lot", document["name"]))
            yield

        @contextmanager
        def shop_order_transition_context(document):
            self.assertIn(
                document["status"],
                {"Released", "Reserved", "Setup / First Piece", "Quality Hold"},
            )
            context_calls.append(("shop_order", document["name"]))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.controlled_item_transition_context = (
            controlled_item_transition_context
        )
        validation_module.material_lot_transition_context = material_lot_transition_context
        validation_module.shop_order_transition_context = shop_order_transition_context
        approval_module = types.ModuleType("ironwrap_roofing.approval_receipt")

        class FakeApprovalReceiptError(Exception):
            def __init__(self, code: str) -> None:
                self.code = code
                super().__init__(code)

        def assert_approved_hermes_run_receipt(run, **_kwargs) -> None:
            if run.get("receipt_error"):
                raise FakeApprovalReceiptError(run["receipt_error"])

        approval_module.ApprovalReceiptError = FakeApprovalReceiptError
        approval_module.assert_approved_hermes_run_receipt = (
            assert_approved_hermes_run_receipt
        )
        frappe_module = types.ModuleType("frappe")
        frappe_module.ValidationError = FakeValidationError
        frappe_module.PermissionError = FakePermissionError
        frappe_module.db = db
        frappe_module.session = types.SimpleNamespace(user=session_user)
        frappe_module.request = types.SimpleNamespace(method=request_method)
        frappe_module.utils = types.SimpleNamespace(
            now_datetime=lambda: "2026-07-30 10:05:00"
        )
        frappe_module.get_roles = lambda _user: (
            roles if roles is not None else ["IronWrap Production"]
        )
        permission_checks: list[tuple[str, str, str]] = []

        def has_permission(doctype: str, *, ptype: str, user: str) -> bool:
            permission_checks.append((doctype, ptype, user))
            if permission_grants is None:
                return can_write
            return permission_grants.get((doctype, ptype), False)

        frappe_module.has_permission = has_permission
        frappe_module.permission_checks = permission_checks
        frappe_module.whitelist = lambda: lambda function: function

        def get_doc(doctype: str, name: str):
            fixture_key = {
                "Controlled Item": "items",
                "Material Lot": "lots",
                "Shop Order": "orders",
            }.get(doctype)
            if fixture_key and name in fixtures[fixture_key]:
                return fixtures[fixture_key][name]
            raise AssertionError(f"unexpected get_doc: {doctype} {name}")

        frappe_module.get_doc = get_doc

        def throw(message: str, *, exc):
            raise exc(message)

        frappe_module.throw = throw
        spec = importlib.util.spec_from_file_location(
            "ironwrap_shop_fabrication_api_under_test", API_PATH
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                "frappe": frappe_module,
                "ironwrap_roofing.approval_receipt": approval_module,
                "ironwrap_roofing.document_validation": validation_module,
            },
        ):
            spec.loader.exec_module(module)
        return module, fixtures, db, context_calls

    def bind_run(
        self,
        api,
        fixtures: dict,
        *,
        tool_name: str,
        target_doctype: str,
        target_name: str,
        target_field: str,
        snapshot: dict,
        extra: dict[str, str] | None = None,
        agent_role: str | None = None,
    ) -> None:
        args = {
            target_field: target_name,
            "request_text": "Approved governed shop command.",
            "approved_by": "owner@example.com",
            "run_id": "run-shop-0001",
            "expected_snapshot_sha256": api._snapshot_hash(snapshot),
        }
        args.update(extra or {})
        fixtures["run"].update(
            {
                "agent_role": agent_role
                or (
                    "Owner Operator"
                    if tool_name == api.APPROVE_CONTROLLED_ITEM_TOOL
                    else "Production Controller"
                ),
                "tool_name": tool_name,
                "target_doctype": target_doctype,
                "target_name": target_name,
                "tool_args_json": json.dumps(args, separators=(",", ":")),
                "policy_check_json": json.dumps(
                    {
                        "allowed": True,
                        "target": {"doctype": target_doctype, "name": target_name},
                    },
                    separators=(",", ":"),
                ),
            }
        )

    def test_approve_controlled_item_locks_and_derives_approval_facts(self) -> None:
        api, fixtures, db, context_calls = self.load_api(
            roles=["IronWrap Owner"]
        )
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )

        result = api.approve_controlled_item("item-1", "run-shop-0001")

        self.assertEqual(result["controlled_item"]["status"], "Approved")
        self.assertEqual(item["approved_by"], "owner@example.com")
        self.assertEqual(item["approved_at"], "2026-07-30 10:05:00")
        self.assertEqual(item["approval_note"], "Approved governed shop command.")
        self.assertEqual(item.save_count, 1)
        self.assertEqual(context_calls, [("controlled_item", "item-1")])
        self.assertTrue(any("`tabHermes Run`" in query for query, _ in db.lock_queries))
        self.assertTrue(
            any("`tabControlled Item`" in query for query, _ in db.lock_queries)
        )
        self.assertEqual(fixtures["run"]["mutation_applied"], 0)

    def test_snapshot_normalizes_frappe_float_values_like_json(self) -> None:
        api, _, _, _ = self.load_api()

        self.assertEqual(
            api._snapshot_values(
                {"available_quantity": 10.0, "reserved_quantity": 0.0},
                ("available_quantity", "reserved_quantity"),
            ),
            {"available_quantity": "10", "reserved_quantity": "0"},
        )

    def test_receive_material_lot_locks_evidence_and_sets_balances(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        api, fixtures, db, context_calls = self.load_api(fixtures)
        lot = fixtures["lots"]["lot-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECEIVE_MATERIAL_LOT_TOOL,
            target_doctype="Material Lot",
            target_name="lot-1",
            target_field="material_lot_id",
            snapshot=api._material_lot_snapshot(lot),
        )

        result = api.receive_material_lot("lot-1", "run-shop-0001")

        self.assertEqual(result["material_lot"]["status"], "Available")
        self.assertEqual(lot["available_quantity"], "10")
        self.assertEqual(lot["reserved_quantity"], "0")
        self.assertEqual(lot["consumed_quantity"], "0")
        self.assertEqual(lot["received_at"], "2026-07-30 10:05:00")
        self.assertEqual(lot.save_count, 1)
        self.assertEqual(context_calls, [("material_lot", "lot-1")])
        self.assertTrue(
            any("`tabEvidence Item`" in query for query, _ in db.lock_queries)
        )
        self.assertTrue(
            any("`tabSupplier Order`" in query for query, _ in db.lock_queries)
        )

    def test_receive_material_lot_rejects_condition_drift_after_preview(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        lot = fixtures["lots"]["lot-1"]
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECEIVE_MATERIAL_LOT_TOOL,
            target_doctype="Material Lot",
            target_name="lot-1",
            target_field="material_lot_id",
            snapshot=api._material_lot_snapshot(lot),
        )
        lot["condition_status"] = "Quarantined"

        with self.assertRaisesRegex(FakeValidationError, "stale_snapshot"):
            api.receive_material_lot("lot-1", "run-shop-0001")
        self.assertEqual(lot.save_count, 0)

    def test_receive_shop_remnant_requires_a_final_locked_source_order(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        fixtures["orders"]["shop-1"]["status"] = "In Fabrication"
        lot = fixtures["lots"]["lot-1"]
        lot.update(
            {
                "source_kind": "Shop Remnant",
                "supplier_order": "",
                "source_shop_order": "shop-1",
            }
        )
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECEIVE_MATERIAL_LOT_TOOL,
            target_doctype="Material Lot",
            target_name="lot-1",
            target_field="material_lot_id",
            snapshot=api._material_lot_snapshot(lot),
        )

        with self.assertRaisesRegex(FakeValidationError, "source_not_ready"):
            api.receive_material_lot("lot-1", "run-shop-0001")
        self.assertEqual(lot.save_count, 0)

    def test_release_shop_order_locks_sources_and_only_derives_release(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        api, fixtures, db, context_calls = self.load_api(fixtures)
        order = fixtures["orders"]["shop-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RELEASE_SHOP_ORDER_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_snapshot(order),
        )

        result = api.release_shop_order("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Released")
        self.assertEqual(order["released_by"], "owner@example.com")
        self.assertEqual(order["released_at"], "2026-07-30 10:05:00")
        self.assertEqual(order["material_allocations"], [])
        self.assertEqual(order.save_count, 1)
        self.assertEqual(context_calls, [("shop_order", "shop-1")])
        for table in (
            "`tabHermes Run`",
            "`tabShop Order`",
            "`tabMaterial Takeoff`",
            "`tabSupplier Order`",
            "`tabWork Package`",
            "`tabControlled Item`",
        ):
            self.assertTrue(any(table in query for query, _ in db.lock_queries), table)

    def test_reserve_shop_order_locks_sorted_lots_and_conserves_balance(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Released"
        order["modified"] = "2026-07-30 10:10:00"
        lot_a = fixtures["lots"]["lot-1"]
        lot_a.update(
            {
                "material_lot_id": "lot-a",
                "name": "lot-a",
                "status": "Available",
                "available_quantity": 5,
                "reserved_quantity": 0,
                "consumed_quantity": 5,
                "modified": "2026-07-30 10:11:00",
            }
        )
        del fixtures["lots"]["lot-1"]
        fixtures["lots"]["lot-a"] = lot_a
        fixtures["lots"]["lot-b"] = FakeDoc(
            {
                **lot_a,
                "name": "lot-b",
                "material_lot_id": "lot-b",
                "available_quantity": 7,
                "reserved_quantity": 0,
                "consumed_quantity": 3,
                "modified": "2026-07-30 10:12:00",
            }
        )
        allocations_json = json.dumps(
            [
                {
                    "allocation_id": "alloc-a",
                    "line_no": 1,
                    "material_lot": "lot-b",
                    "reserved_quantity": 4,
                    "unit": "each",
                },
                {
                    "allocation_id": "alloc-b",
                    "line_no": 1,
                    "material_lot": "lot-a",
                    "reserved_quantity": 2,
                    "unit": "each",
                },
            ],
            separators=(",", ":"),
        )
        api, fixtures, db, context_calls = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RESERVE_SHOP_ORDER_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_snapshot(order, [lot_a, fixtures["lots"]["lot-b"]]),
            extra={"allocations_json": allocations_json},
        )

        result = api.reserve_shop_order_materials("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Reserved")
        self.assertEqual(order["reserved_at"], "2026-07-30 10:05:00")
        self.assertEqual(len(order["material_allocations"]), 2)
        self.assertEqual(lot_a["available_quantity"], "3")
        self.assertEqual(lot_a["reserved_quantity"], "2")
        self.assertEqual(fixtures["lots"]["lot-b"]["available_quantity"], "3")
        self.assertEqual(fixtures["lots"]["lot-b"]["reserved_quantity"], "4")
        self.assertEqual(context_calls, [
            ("material_lot", "lot-a"),
            ("material_lot", "lot-b"),
            ("shop_order", "shop-1"),
        ])
        lot_lock_ids = [
            values[0]
            for query, values in db.lock_queries
            if "`tabMaterial Lot`" in query
        ]
        self.assertEqual(lot_lock_ids, ["lot-a", "lot-b"])

    def test_reserve_shop_order_rejects_authoritative_lot_balance_drift(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Released"
        lot = fixtures["lots"]["lot-1"]
        lot.update(
            {
                "status": "Available",
                "available_quantity": 5,
                "reserved_quantity": 0,
                "consumed_quantity": 5,
            }
        )
        allocations_json = json.dumps(
            [
                {
                    "allocation_id": "alloc-1",
                    "line_no": 1,
                    "material_lot": "lot-1",
                    "reserved_quantity": 2,
                    "unit": "each",
                }
            ],
            separators=(",", ":"),
        )
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RESERVE_SHOP_ORDER_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_snapshot(order, [lot]),
            extra={"allocations_json": allocations_json},
        )
        lot["available_quantity"] = 4

        with self.assertRaisesRegex(FakeValidationError, "stale_snapshot"):
            api.reserve_shop_order_materials("shop-1", "run-shop-0001")

        self.assertEqual(order.save_count, 0)
        self.assertEqual(lot.save_count, 0)

    def test_advance_shop_order_setup_derives_a_ready_signed_route(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Reserved"
        setup_payload_json = json.dumps(
            {
                "action": "begin_setup",
                "operations": [
                    {
                        "sequence": 1,
                        "operation": "Cut panels",
                        "machine_tooling": "Shear A",
                        "operator": "operator@example.com",
                    },
                    {
                        "sequence": 2,
                        "operation": "Form hems",
                        "machine_tooling": "Brake B",
                        "operator": "operator@example.com",
                    },
                ],
            },
            separators=(",", ":"),
        )
        api, fixtures, db, context_calls = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={"setup_payload_json": setup_payload_json},
        )

        result = api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Setup / First Piece")
        self.assertEqual(order["setup_started_at"], "2026-07-30 10:05:00")
        self.assertEqual(order["quality_hold_reason"], "")
        self.assertEqual(
            order["operations"],
            [
                {
                    "sequence": 1,
                    "operation": "Cut panels",
                    "machine_tooling": "Shear A",
                    "operator": "operator@example.com",
                    "status": "Ready",
                },
                {
                    "sequence": 2,
                    "operation": "Form hems",
                    "machine_tooling": "Brake B",
                    "operator": "operator@example.com",
                    "status": "Ready",
                },
            ],
        )
        self.assertEqual(order.save_count, 1)
        self.assertEqual(context_calls, [("shop_order", "shop-1")])
        for table in (
            "`tabHermes Run`",
            "`tabShop Order`",
            "`tabMaterial Takeoff`",
            "`tabSupplier Order`",
            "`tabWork Package`",
            "`tabControlled Item`",
        ):
            self.assertTrue(any(table in query for query, _ in db.lock_queries), table)

    def test_advance_shop_order_setup_holds_and_resumes_an_existing_route(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order.update(
            {
                "status": "Setup / First Piece",
                "setup_started_at": "2026-07-30 10:03:00",
                "operations": [
                    {
                        "sequence": 1,
                        "operation": "Cut panels",
                        "machine_tooling": "Shear A",
                        "operator": "operator@example.com",
                        "status": "Ready",
                    }
                ],
            }
        )
        api, fixtures, _, context_calls = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={
                "setup_payload_json": json.dumps(
                    {"action": "place_quality_hold", "reason": "First piece awaits check."},
                    separators=(",", ":"),
                )
            },
        )

        api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(order["status"], "Quality Hold")
        self.assertEqual(order["quality_hold_reason"], "First piece awaits check.")
        self.assertEqual(order["setup_started_at"], "2026-07-30 10:03:00")
        route_before_resume = list(order["operations"])
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={"setup_payload_json": '{"action":"resume_setup"}'},
        )

        result = api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Setup / First Piece")
        self.assertEqual(order["quality_hold_reason"], "")
        self.assertEqual(order["setup_started_at"], "2026-07-30 10:03:00")
        self.assertEqual(order["operations"], route_before_resume)
        self.assertEqual(order.save_count, 2)
        self.assertEqual(
            context_calls,
            [("shop_order", "shop-1"), ("shop_order", "shop-1")],
        )

    def test_advance_shop_order_setup_rejects_injected_route_fields_without_save(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Reserved"
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={
                "setup_payload_json": json.dumps(
                    {
                        "action": "begin_setup",
                        "operations": [
                            {
                                "sequence": 1,
                                "operation": "Cut panels",
                                "machine_tooling": "Shear A",
                                "operator": "operator@example.com",
                                "status": "In Fabrication",
                            }
                        ],
                    },
                    separators=(",", ":"),
                )
            },
        )

        with self.assertRaisesRegex(FakeValidationError, "invalid_approval_args"):
            api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(order.save_count, 0)
        self.assertEqual(order["status"], "Reserved")
        self.assertEqual(order["operations"], [])

    def test_shop_command_reads_but_does_not_write_hermes_run(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Reserved"
        api, fixtures, _, _ = self.load_api(
            fixtures,
            permission_grants={
                ("Shop Order", "write"): True,
                ("Hermes Run", "read"): True,
                ("Hermes Run", "write"): False,
            },
        )
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={
                "setup_payload_json": (
                    '{"action":"begin_setup","operations":[{"sequence":1,'
                    '"operation":"Cut panels","machine_tooling":"Shear A",'
                    '"operator":"operator@example.com"}]}'
                )
            },
        )

        result = api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Setup / First Piece")
        self.assertIn(
            ("Hermes Run", "read", "production@example.com"),
            api.frappe.permission_checks,
        )
        self.assertNotIn(
            ("Hermes Run", "write", "production@example.com"),
            api.frappe.permission_checks,
        )

    def test_shop_command_rejects_agent_without_granted_tool(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Reserved"
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.ADVANCE_SHOP_ORDER_SETUP_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_setup_snapshot(order),
            extra={"setup_payload_json": '{"action":"place_quality_hold","reason":"Awaiting check."}'},
            agent_role="Field Companion",
        )

        with self.assertRaisesRegex(FakePermissionError, "agent_role_denied"):
            api.advance_shop_order_setup("shop-1", "run-shop-0001")

        self.assertEqual(order.save_count, 0)
        self.assertEqual(order["status"], "Reserved")

    def test_commands_reject_untrusted_or_stale_writes_without_saving(self) -> None:
        api, fixtures, _, _ = self.load_api(request_method="GET", roles=["IronWrap Owner"])
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )
        with self.assertRaisesRegex(FakePermissionError, "post_required"):
            api.approve_controlled_item("item-1", "run-shop-0001")
        self.assertEqual(item.save_count, 0)

        api, fixtures, _, _ = self.load_api(roles=[])
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )
        with self.assertRaisesRegex(FakePermissionError, "role_denied"):
            api.approve_controlled_item("item-1", "run-shop-0001")
        self.assertEqual(item.save_count, 0)

        fixtures = self.fixture_data()
        api, fixtures, _, _ = self.load_api(fixtures, roles=["IronWrap Owner"])
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )
        item["modified"] = "2026-07-30 10:06:00"
        with self.assertRaisesRegex(FakeValidationError, "stale_snapshot"):
            api.approve_controlled_item("item-1", "run-shop-0001")
        self.assertEqual(item.save_count, 0)

        fixtures = self.fixture_data()
        api, fixtures, _, _ = self.load_api(fixtures, roles=["IronWrap Owner"])
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )
        fixtures["run"]["receipt_error"] = "expired"
        with self.assertRaisesRegex(FakeValidationError, "approval_receipt_expired"):
            api.approve_controlled_item("item-1", "run-shop-0001")
        self.assertEqual(item.save_count, 0)

        fixtures = self.fixture_data()
        api, fixtures, _, _ = self.load_api(fixtures, roles=["IronWrap Owner"])
        item = fixtures["items"]["item-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.APPROVE_CONTROLLED_ITEM_TOOL,
            target_doctype="Controlled Item",
            target_name="item-1",
            target_field="controlled_item_id",
            snapshot=api._controlled_item_snapshot(item),
        )
        fixtures["run"]["mutation_applied"] = 1
        with self.assertRaisesRegex(FakeValidationError, "run_already_consumed"):
            api.approve_controlled_item("item-1", "run-shop-0001")
        self.assertEqual(item.save_count, 0)

        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        fixtures["orders"]["shop-1"]["status"] = "Released"
        fixtures["lots"]["lot-1"].update(
            {
                "status": "Available",
                "available_quantity": 2,
                "reserved_quantity": 0,
                "consumed_quantity": 8,
            }
        )
        api, fixtures, _, _ = self.load_api(fixtures)
        order = fixtures["orders"]["shop-1"]
        lot = fixtures["lots"]["lot-1"]
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RESERVE_SHOP_ORDER_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=api._shop_order_snapshot(order, [lot]),
            extra={
                "allocations_json": json.dumps(
                    [
                        {
                            "allocation_id": "alloc-1",
                            "line_no": 1,
                            "material_lot": "lot-1",
                            "reserved_quantity": 3,
                            "unit": "each",
                        }
                    ],
                    separators=(",", ":"),
                )
            },
        )
        with self.assertRaisesRegex(FakeValidationError, "insufficient_lot_quantity"):
            api.reserve_shop_order_materials("shop-1", "run-shop-0001")
        self.assertEqual(order.save_count, 0)
        self.assertEqual(lot.save_count, 0)


if __name__ == "__main__":
    unittest.main()
