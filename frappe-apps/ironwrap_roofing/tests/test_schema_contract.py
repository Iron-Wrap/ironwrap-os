from __future__ import annotations

import ast
import json
import os
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

from setuptools import find_namespace_packages

from ironwrap_roofing.access_control import (
    DOCTYPE_ROLE_MATRIX,
    IRONWRAP_ROLES,
    SYSTEM_MANAGER,
    expected_permissions,
)
from ironwrap_roofing.domain_policy import (
    IDENTITY_FIELDS,
    JSON_FIELDS,
    TRUTHY_ONCE_FIELDS,
    VALIDATORS,
    WRITE_ONCE_FIELDS,
)


APP_ROOT = Path(__file__).resolve().parents[1]
DOCTYPE_ROOT = APP_ROOT / "ironwrap_roofing" / "ironwrap_roofing" / "doctype"

TOP_LEVEL_DOCTYPES = {
    "Appointment Request",
    "Automation Incident",
    "Change Order",
    "Communication Consent",
    "Communication Event",
    "Completion Packet",
    "Contract Acceptance",
    "Crew Profile",
    "Customer Decision",
    "Customer Quote",
    "Evidence Item",
    "Field Check-in",
    "Hermes Run",
    "Instant Estimate Session",
    "Integration Reconciliation",
    "Insurance Supplement",
    "Job Assignment",
    "Job Compliance Record",
    "Lead Envelope",
    "Market Watch Item",
    "Material Takeoff",
    "Measurement Report",
    "Option Package",
    "Payment Milestone",
    "Price Book Rule",
    "Production Gate State",
    "Proposal Evidence Pack",
    "Reception Session",
    "Review Request",
    "Roof Area",
    "Roof Job",
    "Roofing Customer",
    "Roofing Property",
    "Safety Plan",
    "Scope Clause",
    "Supplier Order",
    "Supplier Profile",
    "Supplier Quote",
    "Tenant Export Run",
    "Visual Property Model",
    "Warranty Packet",
    "White-Label Tenant",
    "Work Package",
    "Work Package Event",
}
CHILD_DOCTYPES = {
    "Change Order Item",
    "Insurance Supplement Evidence",
    "Crew Member",
    "Material Takeoff Item",
    "Measurement Value",
    "Supplier Order Item",
    "Supplier Quote Item",
    "Safety Acknowledgement",
    "Work Package Hold Point",
    "Work Package Step",
}
FRAPPE_CORE_LINK_TARGETS = {"User"}
NEW_BLUEPRINT_FIELDS = {
    "Automation Incident": {
        "incident_id",
        "status",
        "severity",
        "source_system",
        "category",
        "summary",
        "detected_at",
        "assigned_to",
        "acknowledged_at",
        "resolution_notes",
        "resolved_by",
        "resolved_at",
    },
    "Measurement Report": {
        "measurement_id",
        "roof_job",
        "roofing_property",
        "provider",
        "source_file",
        "report_url",
        "raw_key",
        "roof_graph_revision",
        "roof_graph_json",
        "parsed_at",
        "review_status",
        "approved_by",
        "approved_at",
        "approval_note",
        "measurements",
    },
    "Option Package": {
        "option_package_id",
        "package_name",
        "tier",
        "material_system",
        "price_delta",
        "options_json",
        "scope_clause_ids_json",
        "warranty_summary",
        "payment_assumptions",
        "assumptions",
        "exclusions",
    },
    "Price Book Rule": {
        "price_rule_id",
        "rule_name",
        "rule_type",
        "unit_cost",
        "unit_price",
        "source_ref",
        "rule_json",
        "effective_from",
        "effective_to",
        "approved_by",
        "approved_at",
        "approval_note",
    },
    "Roof Area": {
        "roof_area_id",
        "roof_job",
        "roofing_property",
        "area_name",
        "area_sqft",
        "pitch",
        "facet_count",
        "penetration_count",
        "edge_length_ft",
        "measurement_report",
        "visual_model",
        "source_ref",
    },
    "Scope Clause": {
        "scope_clause_id",
        "customer_quote",
        "clause_type",
        "title",
        "clause_text",
        "version",
        "source_ref",
        "customer_visible",
        "approved_by",
        "approved_at",
        "approval_note",
    },
    "Visual Property Model": {
        "visual_model_id",
        "roof_job",
        "roofing_property",
        "provider",
        "provider_model_id",
        "model_uri",
        "source_evidence",
        "roof_graph_measurement",
        "roof_graph_revision",
        "screenshots_json",
        "measurements_json",
        "confidence",
        "needs_review",
    },
    "White-Label Tenant": {
        "tenant_id",
        "site_hostname",
        "legal_name",
        "primary_brand",
        "owner_user",
        "data_residency",
        "isolation_model",
        "brand_config_json",
        "namespace_config_json",
        "policy_config_json",
        "activated_at",
    },
}

NEW_BLUEPRINT_FIELDS.update(
    {
        "Appointment Request": {"appointment_request_id", "reception_session", "request_status", "booking_mode", "preferred_windows_json", "timezone", "requested_at", "raw_key", "payload_hash"},
        "Crew Profile": {"crew_profile_id", "crew_name", "status", "primary_lead", "members", "home_region", "timezone", "competency_status", "competency_checked_at", "competency_expiry", "equipment_status", "equipment_checked_at", "equipment_expiry", "wcb_status", "wcb_checked_at", "wcb_expiry", "active_stop", "active_stop_at", "active_stop_reason"},
        "Job Assignment": {"assignment_id", "roof_job", "status", "crew_profile", "assigned_user", "scheduled_start", "scheduled_end", "supersedes", "correction_reason"},
        "Change Order": {"change_order_id", "roof_job", "version", "status", "subtotal", "tax_amount", "total_amount", "tax_policy_snapshot_json", "items", "contract_acceptance", "supersedes", "correction_reason"},
        "Safety Plan": {"safety_plan_id", "roof_job", "version", "status", "hazard_summary", "controls", "emergency_plan", "acknowledgements", "supersedes", "correction_reason"},
        "Job Compliance Record": {"compliance_record_id", "roof_job", "jurisdiction", "record_type", "status", "required_before_gate", "evidence_item", "owner_user", "due_date"},
        "Communication Consent": {"consent_id", "channel", "purpose", "status", "jurisdiction", "consent_basis", "captured_at", "proof_evidence", "supersedes"},
        "Customer Decision": {"decision_id", "roof_job", "decision_type", "status", "decision_value", "decided_at", "evidence_item", "supersedes"},
        "Contract Acceptance": {"acceptance_id", "roof_job", "contract_version", "status", "accepted_at", "evidence_item", "terms_hash", "document_checksum", "supersedes"},
        "Integration Reconciliation": {"reconciliation_id", "system_name", "external_entity_id", "status", "diff_json", "source_payload_hash", "local_payload_hash", "resolution_evidence"},
        "Insurance Supplement": {"insurance_supplement_id", "roof_job", "customer_quote", "change_order", "version", "status", "carrier_name", "claim_reference", "policy_reference", "date_of_loss", "adjuster_reference", "supplement_basis", "measurement_report", "invoice_required", "invoice_exception_reason", "evidence", "evidence_manifest_json", "approved_by", "approved_at", "submitted_at", "carrier_response_at", "resolution_summary", "closed_at", "supersedes", "correction_reason"},
        "Tenant Export Run": {"export_run_id", "tenant", "status", "scope_json", "manifest_key", "manifest_checksum", "archive_key", "archive_checksum", "encryption_key_ref"},
        "Evidence Item": {"evidence_id", "device_action_id", "proof_owner", "proof_slot", "content_checksum", "capture_actor", "latitude", "longitude", "sync_state", "correction_of"},
        "Field Check-in": {"checkin_id", "device_action_id", "job_assignment", "crew_profile", "capture_actor", "sync_state", "blocker_flag", "voice_evidence", "correction_of"},
        "Production Gate State": {"gate_id", "owner_user", "assigned_at", "due_at"},
        "Roof Job": {"roof_job_id", "workflow_profile", "locale_policy_version", "locale_policy_snapshot_json"},
        "Customer Quote": {"customer_quote_id", "quote_version", "price_book_version", "price_rule_snapshot_json", "subtotal", "tax_amount", "tax_policy_snapshot_json", "amount_due", "amount_paid", "balance_due", "payment_truth_source", "supersedes"},
        "Payment Milestone": {"payment_milestone_id", "milestone_version", "subtotal", "tax_amount", "total_amount", "amount_due", "amount_paid", "balance_due", "tax_policy_snapshot_json", "truth_source", "supersedes"},
        "Reception Session": {"session_id", "provider", "channel", "direction", "session_status", "lead_envelope", "contact_phone", "structured_summary", "transcript_pointer", "recording_pointer", "ai_disclosed", "recording_disclosed", "raw_key", "payload_hash", "structured_json"},
        "Work Package": {"work_package_id", "roof_job", "job_assignment", "safety_plan", "version", "status", "objective", "stop_conditions", "make_safe_procedure", "expires_at", "acknowledgement_device_action_id", "blocked_by", "blocked_device_action_id", "steps", "hold_points", "supersedes"},
        "Work Package Event": {"work_package_event_id", "event_type", "work_package", "roof_job", "job_assignment", "work_package_version", "actor_user", "actor_role", "device_action_id", "occurred_at", "payload_hash", "hold_point_sequence", "evidence_item", "blocker_reason"},
    }
)


def load_doctypes() -> dict[str, tuple[Path, dict]]:
    result = {}
    for path in sorted(DOCTYPE_ROOT.glob("*/*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        result[document["name"]] = (path, document)
    return result


class DocTypeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.doctypes = load_doctypes()

    def test_complete_54_doctype_blueprint(self) -> None:
        self.assertEqual(set(self.doctypes), TOP_LEVEL_DOCTYPES | CHILD_DOCTYPES)
        self.assertEqual(len(self.doctypes), 54)

        for name, (_, document) in self.doctypes.items():
            with self.subTest(doctype=name):
                self.assertEqual(document["doctype"], "DocType")
                self.assertEqual(document["module"], "IronWrap Roofing")
                self.assertEqual(bool(document.get("istable")), name in CHILD_DOCTYPES)

                fields = [field["fieldname"] for field in document["fields"]]
                self.assertEqual(len(fields), len(set(fields)))
                self.assertEqual(set(fields), set(document["field_order"]))

                if name in TOP_LEVEL_DOCTYPES:
                    identity = document["autoname"].removeprefix("field:")
                    field_by_name = {
                        field["fieldname"]: field for field in document["fields"]
                    }
                    self.assertEqual(document["autoname"], f"field:{identity}")
                    self.assertEqual(document["naming_rule"], "By fieldname")
                    self.assertEqual(field_by_name[identity].get("reqd"), 1)
                    self.assertEqual(field_by_name[identity].get("unique"), 1)

    def test_link_targets_are_owned_or_frappe_core(self) -> None:
        allowed = set(self.doctypes) | FRAPPE_CORE_LINK_TARGETS
        for name, (_, document) in self.doctypes.items():
            for field in document["fields"]:
                if field["fieldtype"] not in {"Link", "Table"}:
                    continue
                with self.subTest(doctype=name, field=field["fieldname"]):
                    self.assertIn(field.get("options"), allowed)

    def test_new_blueprint_entities_have_their_operational_contracts(self) -> None:
        for name, required_fields in NEW_BLUEPRINT_FIELDS.items():
            document = self.doctypes[name][1]
            actual_fields = {field["fieldname"] for field in document["fields"]}
            with self.subTest(doctype=name):
                self.assertTrue(required_fields <= actual_fields)

    def test_permissions_match_the_canonical_least_privilege_matrix(self) -> None:
        self.assertEqual(set(DOCTYPE_ROLE_MATRIX), TOP_LEVEL_DOCTYPES)
        for name, (_, document) in self.doctypes.items():
            with self.subTest(doctype=name):
                if name in CHILD_DOCTYPES:
                    self.assertEqual(document.get("permissions"), [])
                    continue
                self.assertEqual(
                    document.get("permissions"), expected_permissions(name)
                )
                roles = {row["role"] for row in document["permissions"]}
                self.assertIn(SYSTEM_MANAGER, roles)
                self.assertIn("IronWrap Owner", roles)
                self.assertTrue(roles <= {SYSTEM_MANAGER, *IRONWRAP_ROLES})
                for row in document["permissions"]:
                    self.assertNotEqual(row.get("delete"), 1)
                    if row["role"] != SYSTEM_MANAGER:
                        self.assertFalse({"export", "import", "share"} & row.keys())

    def test_every_top_level_controller_uses_shared_validation(self) -> None:
        folder_kinds = set()
        for name, (json_path, document) in self.doctypes.items():
            if document.get("istable"):
                continue
            kind = json_path.parent.name
            folder_kinds.add(kind)
            source_path = json_path.with_suffix(".py")
            tree = ast.parse(source_path.read_text(encoding="utf-8"))
            calls = [
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "validate_business_document"
            ]
            with self.subTest(doctype=name):
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0].args[1].value, kind)
                self.assertIn(kind, IDENTITY_FIELDS)
                fields = {field["fieldname"] for field in document["fields"]}
                self.assertTrue(set(IDENTITY_FIELDS[kind]) <= fields)
                self.assertTrue(set(WRITE_ONCE_FIELDS.get(kind, ())) <= fields)
                self.assertTrue(set(TRUTHY_ONCE_FIELDS.get(kind, ())) <= fields)
                self.assertTrue(set(JSON_FIELDS.get(kind, ())) <= fields)

        self.assertEqual(folder_kinds, set(IDENTITY_FIELDS))
        self.assertTrue(set(VALIDATORS) <= folder_kinds)

    def test_validator_fields_exist_in_their_doctype_contract(self) -> None:
        policy_tree = ast.parse(
            (APP_ROOT / "ironwrap_roofing" / "domain_policy.py").read_text(
                encoding="utf-8"
            )
        )
        functions = {
            node.name: node
            for node in policy_tree.body
            if isinstance(node, ast.FunctionDef)
        }
        documents_by_kind = {
            path.parent.name: document for path, document in self.doctypes.values()
        }
        for kind, validator in VALIDATORS.items():
            used_fields = set()
            for call in (
                node
                for node in ast.walk(functions[validator.__name__])
                if isinstance(node, ast.Call)
            ):
                if (
                    not call.args
                    or not isinstance(call.args[0], ast.Name)
                    or call.args[0].id != "record"
                ):
                    continue
                function_name = (
                    call.func.id if isinstance(call.func, ast.Name) else None
                )
                if function_name in {
                    "_get",
                    "_decimal",
                    "parse_json_field",
                    "require_between",
                }:
                    if len(call.args) > 1 and isinstance(call.args[1], ast.Constant):
                        used_fields.add(call.args[1].value)
                elif function_name in {"require_fields", "require_nonnegative"}:
                    used_fields.update(
                        argument.value
                        for argument in call.args[1:]
                        if isinstance(argument, ast.Constant)
                        and isinstance(argument.value, str)
                    )
                elif function_name == "require_approval":
                    used_fields.update({"approved_by", "approved_at"})
                    used_fields.update(
                        keyword.value.value
                        for keyword in call.keywords
                        if keyword.arg in {"actor", "timestamp", "note"}
                        and isinstance(keyword.value, ast.Constant)
                    )

            actual_fields = {
                field["fieldname"] for field in documents_by_kind[kind]["fields"]
            }
            with self.subTest(kind=kind):
                self.assertTrue(used_fields <= actual_fields)

    def test_distribution_discovers_all_controller_packages(self) -> None:
        build_system = (APP_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('build-backend = "setuptools.build_meta"', build_system)
        self.assertIn('"wheel"', build_system)
        expected_packages = set(
            find_namespace_packages(
                where=str(APP_ROOT), include=("ironwrap_roofing", "ironwrap_roofing.*")
            )
        )
        previous_workdir = Path.cwd()
        try:
            os.chdir(APP_ROOT)
            with patch("setuptools.setup") as setup:
                runpy.run_path(str(APP_ROOT / "setup.py"), run_name="__main__")
        finally:
            os.chdir(previous_workdir)
        distribution = setup.call_args.kwargs
        packages = set(distribution["packages"])
        self.assertEqual(packages, expected_packages)
        self.assertEqual(
            distribution["package_data"], {"": ["*.css", "*.js", "*.json", "*.txt"]}
        )
        self.assertEqual(distribution["python_requires"], ">=3.10")
        for _, (json_path, _) in self.doctypes.items():
            expected = (
                f"ironwrap_roofing.ironwrap_roofing.doctype.{json_path.parent.name}"
            )
            with self.subTest(package=expected):
                self.assertIn(expected, packages)

    def test_exception_first_control_center_is_a_standard_permission_scoped_surface(
        self,
    ) -> None:
        module_root = APP_ROOT / "ironwrap_roofing" / "ironwrap_roofing"
        page_root = module_root / "page" / "ironwrap_control_center"
        workspace_path = module_root / "workspace" / "ironwrap_os" / "ironwrap_os.json"
        for path in [
            page_root / "ironwrap_control_center.json",
            page_root / "ironwrap_control_center.py",
            page_root / "ironwrap_control_center.js",
            page_root / "ironwrap_control_center.css",
            workspace_path,
        ]:
            with self.subTest(path=path):
                self.assertTrue(path.is_file())

        page = json.loads(
            (page_root / "ironwrap_control_center.json").read_text(encoding="utf-8")
        )
        self.assertEqual(page["doctype"], "Page")
        self.assertEqual(page["page_name"], "ironwrap-control-center")
        self.assertEqual(page["standard"], "Yes")
        self.assertEqual(
            {row["role"] for row in page["roles"]},
            set(IRONWRAP_ROLES) | {SYSTEM_MANAGER},
        )

        adapter = (page_root / "ironwrap_control_center.py").read_text(encoding="utf-8")
        self.assertIn("frappe.has_permission", adapter)
        self.assertIn("frappe.get_list", adapter)
        self.assertNotIn("frappe.get_all", adapter)
        self.assertIn("@frappe.whitelist()", adapter)
        client = (page_root / "ironwrap_control_center.js").read_text(encoding="utf-8")
        self.assertIn("get_control_center", client)
        for forbidden in ["frappe.db.insert", ".save(", ".delete("]:
            self.assertNotIn(forbidden, client)

        workspace = json.loads(workspace_path.read_text(encoding="utf-8"))
        self.assertEqual(workspace["doctype"], "Workspace")
        self.assertEqual(workspace["module"], "IronWrap Roofing")
        self.assertEqual(
            {row["role"] for row in workspace["roles"]},
            set(IRONWRAP_ROLES) | {SYSTEM_MANAGER},
        )
        json.loads(workspace["content"])
        for link in workspace["links"]:
            if link.get("type") != "Link":
                continue
            with self.subTest(link=link.get("label")):
                if link.get("link_type") == "Page":
                    self.assertEqual(link.get("link_to"), "ironwrap-control-center")
                else:
                    self.assertIn(link.get("link_to"), TOP_LEVEL_DOCTYPES)

    def test_install_hooks_are_registered(self) -> None:
        hooks = (APP_ROOT / "ironwrap_roofing" / "hooks.py").read_text(encoding="utf-8")
        tree = ast.parse(hooks)
        values = {
            node.targets[0].id: node.value.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
        }
        self.assertEqual(
            values["before_install"], "ironwrap_roofing.install.before_install"
        )
        self.assertEqual(
            values["after_install"], "ironwrap_roofing.install.after_install"
        )
        self.assertEqual(
            values["before_migrate"], "ironwrap_roofing.install.before_migrate"
        )
        self.assertEqual(
            values["after_migrate"], "ironwrap_roofing.install.after_migrate"
        )

        namespace = runpy.run_path(str(APP_ROOT / "ironwrap_roofing" / "hooks.py"))
        self.assertEqual(set(namespace["doc_events"]), TOP_LEVEL_DOCTYPES)
        for event in namespace["doc_events"].values():
            self.assertEqual(
                event["on_trash"],
                "ironwrap_roofing.document_validation.deny_business_document_delete",
            )


if __name__ == "__main__":
    unittest.main()
