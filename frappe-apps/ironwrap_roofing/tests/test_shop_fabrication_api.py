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
    def __init__(self, values: dict, *, on_insert=None) -> None:
        super().__init__(values)
        object.__setattr__(self, "save_count", 0)
        object.__setattr__(self, "insert_count", 0)
        object.__setattr__(self, "_on_insert", on_insert)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value) -> None:
        if name in {"save_count", "insert_count", "_on_insert"}:
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def set(self, field: str, value) -> None:
        self[field] = value

    def save(self) -> None:
        self.save_count += 1

    def insert(self) -> None:
        if self._on_insert is not None:
            self._on_insert(self)
        self.insert_count += 1


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
            ("`tabJob Assignment`", "job_assignments"),
            ("`tabCrew Profile`", "crew_profiles"),
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
                        "fabrication_started_at": "",
                        "quality_hold_reason": "",
                        "lines": [
                            {
                                "line_no": 1,
                                "controlled_item": "item-1",
                                "requested_quantity": 8,
                                "accepted_quantity": 8,
                                "billable_quantity": 8,
                                "unit": "each",
                                "dimensions": "2400 mm",
                                "tolerance": "± 3 mm",
                                "orientation": "Eave to ridge",
                                "invoice_basis": "Each",
                                "needs_review": 0,
                            }
                        ],
                        "material_allocations": [],
                        "operations": [],
                        "inspections": [],
                    }
                )
            },
            "takeoffs": {
                "takeoff-1": FakeDoc(
                    {
                        "name": "takeoff-1",
                        "roof_job": "job-1",
                        "status": "Approved",
                        "modified": "2026-07-30 10:00:30",
                    }
                )
            },
            "supplier_orders": {
                "supplier-1": FakeDoc(
                    {
                        "name": "supplier-1",
                        "roof_job": "job-1",
                        "status": "Received",
                        "modified": "2026-07-30 10:00:45",
                    }
                )
            },
            "work_packages": {
                "package-1": FakeDoc(
                    {
                        "name": "package-1",
                        "work_package_id": "package-1",
                        "roof_job": "job-1",
                        "job_assignment": "assignment-1",
                        "safety_plan": "safety-plan-1",
                        "version": 1,
                        "status": "Released",
                        "expires_at": "2026-12-31 23:59:59",
                        "acknowledged_by": "production@example.com",
                        "acknowledged_at": "2026-07-30 10:02:30",
                        "started_at": "",
                        "modified": "2026-07-30 10:02:45",
                    }
                )
            },
            "job_assignments": {
                "assignment-1": FakeDoc(
                    {
                        "name": "assignment-1",
                        "assignment_id": "assignment-1",
                        "roof_job": "job-1",
                        "assignment_type": "Production",
                        "status": "In Progress",
                        "crew_profile": "crew-1",
                        "assigned_user": "production@example.com",
                        "scheduled_start": "2026-07-30 10:00:00",
                        "supersedes": "",
                        "modified": "2026-07-30 10:02:50",
                    }
                )
            },
            "crew_profiles": {
                "crew-1": FakeDoc(
                    {
                        "name": "crew-1",
                        "crew_profile_id": "crew-1",
                        "status": "Active",
                        "crew_type": "Shop fabrication",
                        "competency_status": "Current",
                        "competency_checked_at": "2026-07-30 09:00:00",
                        "competency_expiry": "2026-12-31 23:59:59",
                        "equipment_status": "Current",
                        "equipment_checked_at": "2026-07-30 09:00:00",
                        "equipment_expiry": "2026-12-31 23:59:59",
                        "wcb_status": "Current",
                        "wcb_checked_at": "2026-07-30 09:00:00",
                        "wcb_expiry": "2026-12-31 23:59:59",
                        "active_stop": 0,
                        "active_stop_at": "",
                        "active_stop_reason": "",
                        "modified": "2026-07-30 10:02:55",
                    }
                )
            },
            "evidence": {
                "evidence-receipt-1": FakeDoc(
                    {
                        "name": "evidence-receipt-1",
                        "evidence_id": "evidence-receipt-1",
                        "roof_job": "job-1",
                        "sync_state": "Verified",
                        "modified": "2026-07-30 10:01:30",
                    }
                )
            },
            "nonconformances": {},
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

    def first_piece_ready_fixture(self) -> tuple[dict, FakeDoc, FakeDoc, FakeDoc]:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order.update(
            {
                "status": "Setup / First Piece",
                "setup_started_at": "2026-07-30 10:03:00",
                "material_allocations": [
                    {
                        "allocation_id": "allocation-1",
                        "line_no": 1,
                        "material_lot": "lot-1",
                        "reserved_quantity": 8,
                        "issued_quantity": 0,
                        "unit": "each",
                        "status": "Reserved",
                        "needs_review": 0,
                    }
                ],
                "operations": [
                    {
                        "sequence": 1,
                        "operation": "Cut panels",
                        "machine_tooling": "Shear A",
                        "operator": "fabricator@example.com",
                        "status": "In Progress",
                        "started_at": "2026-07-30 10:03:30",
                        "completed_at": "",
                        "notes": "",
                    }
                ],
            }
        )
        lot = fixtures["lots"]["lot-1"]
        lot.update(
            {
                "status": "Reserved",
                "available_quantity": 2,
                "reserved_quantity": 8,
                "consumed_quantity": 0,
            }
        )
        evidence = FakeDoc(
            {
                "name": "evidence-first-piece-1",
                "evidence_id": "evidence-first-piece-1",
                "roof_job": "job-1",
                "evidence_type": "Measurement Report",
                "proof_owner": "production@example.com",
                "proof_slot": "Production",
                "source_system": "ironwrap-pwa",
                "r2_key": "field/v1/job-1/first-piece.json",
                "content_checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "checksum_algorithm": "SHA-256",
                "content_type": "application/json",
                "content_length": 128,
                "capture_actor": "production@example.com",
                "captured_at": "2026-07-30 10:04:00",
                "sync_state": "Verified",
                "verified_at": "2026-07-30 10:04:10",
                "verification_source": "evidence-verifier",
                "device_action_id": "device-action-first-piece-1",
                "modified": "2026-07-30 10:04:00",
            }
        )
        fixtures["evidence"]["evidence-first-piece-1"] = evidence
        return fixtures, order, lot, evidence

    def first_piece_snapshot(
        self,
        api,
        fixtures: dict,
        order: FakeDoc,
        lot: FakeDoc,
        evidence: FakeDoc,
        *,
        authenticated_user: str = "production@example.com",
    ) -> dict:
        return api._shop_order_first_piece_snapshot(
            order,
            [lot],
            [evidence],
            {
                "material_takeoff": fixtures["takeoffs"]["takeoff-1"],
                "supplier_order": fixtures["supplier_orders"]["supplier-1"],
                "work_package": fixtures["work_packages"]["package-1"],
            },
            {
                "work_package": fixtures["work_packages"]["package-1"],
                "job_assignment": fixtures["job_assignments"]["assignment-1"],
                "crew_profile": fixtures["crew_profiles"]["crew-1"],
                "authenticated_user": authenticated_user,
                "assignment_role": "Production direct assignment",
            },
        )

    def test_preview_first_piece_authority_reuses_current_package_validation(self) -> None:
        fixtures, order, _, _ = self.first_piece_ready_fixture()
        api, fixtures, db, _ = self.load_api(fixtures)

        preview = api.preview_first_piece_authority("shop-1")

        self.assertEqual(preview["authenticated_user"], "production@example.com")
        self.assertEqual(preview["work_package"]["name"], "package-1")
        self.assertEqual(preview["work_package"]["job_assignment"], "assignment-1")
        self.assertEqual(preview["job_assignment"]["assignment_id"], "assignment-1")
        self.assertEqual(preview["crew_profile"]["crew_profile_id"], "crew-1")
        self.assertEqual(preview["assignment_role"], "Production direct assignment")
        for table in (
            "`tabShop Order`",
            "`tabMaterial Takeoff`",
            "`tabSupplier Order`",
            "`tabWork Package`",
            "`tabJob Assignment`",
            "`tabCrew Profile`",
        ):
            self.assertTrue(any(table in query for query, _ in db.lock_queries), table)

        fixtures["work_packages"]["package-1"]["authority_error"] = "work_package_expired"
        with self.assertRaisesRegex(FakeValidationError, "work_package_expired"):
            api.preview_first_piece_authority(order["name"])

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
            self.assertIn(
                document["status"], {"Available", "Consumed", "Quarantined", "Reserved"}
            )
            context_calls.append(("material_lot", document["name"]))
            yield

        @contextmanager
        def nonconformance_transition_context(document):
            self.assertEqual(document["status"], "Contained")
            context_calls.append(("nonconformance", document["name"]))
            yield

        @contextmanager
        def shop_order_transition_context(document):
            self.assertIn(
                document["status"],
                {
                    "Released",
                    "Reserved",
                    "Setup / First Piece",
                    "In Fabrication",
                    "Quality Hold",
                },
            )
            context_calls.append(("shop_order", document["name"]))
            yield

        validation_module = types.ModuleType("ironwrap_roofing.document_validation")
        validation_module.controlled_item_transition_context = (
            controlled_item_transition_context
        )
        validation_module.material_lot_transition_context = material_lot_transition_context
        validation_module.nonconformance_transition_context = (
            nonconformance_transition_context
        )
        validation_module.shop_order_transition_context = shop_order_transition_context

        def validate_business_document(document, kind: str) -> None:
            self.assertEqual(kind, "work_package")
            if document.get("authority_error"):
                raise FakeValidationError(document["authority_error"])

        validation_module.validate_business_document = validate_business_document
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

        def get_doc(doctype: str | dict, name: str | None = None):
            if isinstance(doctype, dict):
                if doctype.get("doctype") != "Nonconformance":
                    raise AssertionError(f"unexpected document payload: {doctype}")

                def store_nonconformance(document) -> None:
                    if document["name"] in fixtures["nonconformances"]:
                        raise FakeValidationError("nonconformance_already_exists")
                    fixtures["nonconformances"][document["name"]] = document

                return FakeDoc(doctype, on_insert=store_nonconformance)
            fixture_key = {
                "Controlled Item": "items",
                "Material Lot": "lots",
                "Shop Order": "orders",
                "Work Package": "work_packages",
            }.get(doctype)
            if fixture_key and name in fixtures[fixture_key]:
                return fixtures[fixture_key][name]
            raise AssertionError(f"unexpected get_doc: {doctype} {name}")

        frappe_module.get_doc = get_doc

        work_package_module = types.ModuleType("ironwrap_roofing.work_package_api")

        def lock_assignment(package, roof_job_id: str, assignment_id: str):
            assignment = fixtures["job_assignments"].get(assignment_id)
            if assignment is None or package.get("roof_job") != roof_job_id:
                raise FakeValidationError("work_package_assignment_mismatch")
            return dict(assignment)

        def assert_package_current_and_unexpired(package) -> None:
            if package.get("authority_error"):
                raise FakeValidationError(package["authority_error"])

        def assert_actor_is_assigned(assignment, actor_user: str) -> str:
            if assignment.get("assigned_user") != actor_user:
                raise FakePermissionError("work_package_actor_not_assigned")
            return "Production direct assignment"

        work_package_module._lock_assignment = lock_assignment
        work_package_module._assert_package_current_and_unexpired = (
            assert_package_current_and_unexpired
        )
        work_package_module._assert_actor_is_assigned = assert_actor_is_assigned

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
                "ironwrap_roofing.work_package_api": work_package_module,
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

    def test_record_first_piece_outcome_derives_pass_and_starts_fabrication(self) -> None:
        fixtures, order, lot, evidence = self.first_piece_ready_fixture()
        first_piece_payload_json = json.dumps(
            {
                "action": "pass_to_fabrication",
                "inspections": [
                    {
                        "line_no": 1,
                        "allocation_id": "allocation-1",
                        "operation_sequence": 1,
                        "issued_quantity": "1",
                        "measured_value": "2400",
                        "measurement_unit": "mm",
                        "evidence_item": "evidence-first-piece-1",
                    }
                ],
            },
            separators=(",", ":"),
        )
        api, fixtures, db, context_calls = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECORD_FIRST_PIECE_OUTCOME_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=self.first_piece_snapshot(api, fixtures, order, lot, evidence),
            extra={"first_piece_payload_json": first_piece_payload_json},
        )

        result = api.record_first_piece_outcome("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "In Fabrication")
        self.assertEqual(result["shop_order"]["first_piece_inspection_count"], 1)
        self.assertEqual(order["fabrication_started_at"], "2026-07-30 10:05:00")
        self.assertEqual(order["quality_hold_reason"], "")
        self.assertEqual(
            order["inspections"],
            [
                {
                    "inspection_type": "First Piece",
                    "line_no": 1,
                    "allocation_id": "allocation-1",
                    "operation_sequence": 1,
                    "result": "Pass",
                    "nominal_value": "2400",
                    "measured_value": "2400",
                    "tolerance_value": "3",
                    "measurement_unit": "mm",
                    "measured_result": "2400 mm; nominal 2400 +/- 3 mm",
                    "inspected_by": "production@example.com",
                    "inspected_at": "2026-07-30 10:05:00",
                    "evidence_item": "evidence-first-piece-1",
                    "needs_review": 0,
                }
            ],
        )
        self.assertEqual(order.save_count, 1)
        self.assertEqual(lot["reserved_quantity"], "7")
        self.assertEqual(lot["consumed_quantity"], "1")
        self.assertEqual(order["material_allocations"][0]["issued_quantity"], "1")
        self.assertEqual(context_calls, [("material_lot", "lot-1"), ("shop_order", "shop-1")])
        for table in (
            "`tabMaterial Lot`",
            "`tabEvidence Item`",
            "`tabJob Assignment`",
            "`tabCrew Profile`",
        ):
            self.assertTrue(any(table in query for query, _ in db.lock_queries), table)

    def test_record_first_piece_outcome_records_failure_and_holds_order(self) -> None:
        fixtures, order, lot, evidence = self.first_piece_ready_fixture()
        first_piece_payload_json = json.dumps(
            {
                "action": "fail_to_quality_hold",
                "inspection": {
                    "line_no": 1,
                    "allocation_id": "allocation-1",
                    "operation_sequence": 1,
                    "issued_quantity": "1",
                    "measured_value": "2404",
                    "measurement_unit": "mm",
                    "evidence_item": "evidence-first-piece-1",
                },
                "reason": "First-piece measurement requires review.",
            },
            separators=(",", ":"),
        )
        api, fixtures, _, context_calls = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECORD_FIRST_PIECE_OUTCOME_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=self.first_piece_snapshot(api, fixtures, order, lot, evidence),
            extra={"first_piece_payload_json": first_piece_payload_json},
        )

        result = api.record_first_piece_outcome("shop-1", "run-shop-0001")

        self.assertEqual(result["shop_order"]["status"], "Quality Hold")
        self.assertEqual(order["fabrication_started_at"], "")
        self.assertEqual(
            order["quality_hold_reason"], "First-piece measurement requires review."
        )
        self.assertEqual(order["inspections"][0]["result"], "Fail")
        self.assertEqual(order["inspections"][0]["needs_review"], 1)
        self.assertEqual(lot["status"], "Quarantined")
        self.assertEqual(lot["condition_status"], "Accepted")
        self.assertEqual(lot["reserved_quantity"], "7")
        self.assertEqual(lot["consumed_quantity"], "1")
        ncr_id = api._first_piece_ncr_id("run-shop-0001")
        self.assertEqual(result["material_lot"]["status"], "Quarantined")
        self.assertEqual(result["nonconformance"]["name"], ncr_id)
        self.assertEqual(result["nonconformance"]["status"], "Contained")
        self.assertEqual(fixtures["nonconformances"][ncr_id]["evidence_item"], evidence["name"])
        self.assertEqual(order.save_count, 1)
        self.assertEqual(lot.save_count, 1)
        self.assertEqual(
            context_calls,
            [
                ("material_lot", "lot-1"),
                ("nonconformance", ncr_id),
                ("shop_order", "shop-1"),
            ],
        )

    def test_record_first_piece_outcome_rejects_missing_passes_and_self_inspection(self) -> None:
        fixtures, order, lot, evidence = self.first_piece_ready_fixture()
        order["lines"].append(
            {
                **order["lines"][0],
                "line_no": 2,
                "dimensions": "1800 mm",
            }
        )
        order["material_allocations"].append(
            {
                **order["material_allocations"][0],
                "allocation_id": "allocation-2",
                "line_no": 2,
            }
        )
        first_piece_payload_json = json.dumps(
            {
                "action": "pass_to_fabrication",
                "inspections": [
                    {
                        "line_no": 1,
                        "allocation_id": "allocation-1",
                        "operation_sequence": 1,
                        "issued_quantity": "1",
                        "measured_value": "2400",
                        "measurement_unit": "mm",
                        "evidence_item": "evidence-first-piece-1",
                    }
                ],
            },
            separators=(",", ":"),
        )
        api, fixtures, _, _ = self.load_api(fixtures)
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECORD_FIRST_PIECE_OUTCOME_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=self.first_piece_snapshot(api, fixtures, order, lot, evidence),
            extra={"first_piece_payload_json": first_piece_payload_json},
        )

        with self.assertRaisesRegex(FakeValidationError, "missing_first_piece_pass"):
            api.record_first_piece_outcome("shop-1", "run-shop-0001")
        self.assertEqual(order.save_count, 0)

        order["lines"].pop()
        order["material_allocations"].pop()
        order["operations"][0]["operator"] = "production@example.com"
        self.bind_run(
            api,
            fixtures,
            tool_name=api.RECORD_FIRST_PIECE_OUTCOME_TOOL,
            target_doctype="Shop Order",
            target_name="shop-1",
            target_field="shop_order_id",
            snapshot=self.first_piece_snapshot(api, fixtures, order, lot, evidence),
            extra={"first_piece_payload_json": first_piece_payload_json},
        )

        with self.assertRaisesRegex(FakePermissionError, "non_independent_inspection"):
            api.record_first_piece_outcome("shop-1", "run-shop-0001")
        self.assertEqual(order.save_count, 0)

    def test_shop_command_needs_no_generic_hermes_run_permission(self) -> None:
        fixtures = self.fixture_data()
        fixtures["items"]["item-1"]["status"] = "Approved"
        order = fixtures["orders"]["shop-1"]
        order["status"] = "Reserved"
        api, fixtures, _, _ = self.load_api(
            fixtures,
            permission_grants={
                ("Shop Order", "write"): True,
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
        self.assertNotIn(
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
