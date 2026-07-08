#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const doctypeRoot = "frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype";
const existingErpNextTargets = new Set([
  "Customer",
  "Lead",
  "Opportunity",
  "Project",
  "Quotation",
  "User",
]);

const specs = [
  {
    name: "Lead Envelope",
    dir: "lead_envelope",
    idField: "envelope_id",
    requiredFields: [
      "envelope_id",
      "source",
      "contact_name",
      "contact_phone",
      "contact_email",
      "job_ref",
      "raw_key",
      "event_ts",
      "status",
      "intent_queue",
      "payload_json",
      "jobnimbus_contact_id",
      "jobnimbus_job_id",
    ],
  },
  {
    name: "Roofing Property",
    dir: "roofing_property",
    idField: "property_key",
    requiredFields: ["property_key", "lead_envelope", "customer", "address_line1", "city", "province", "postal_code"],
  },
  {
    name: "Roof Job",
    dir: "roof_job",
    idField: "roof_job_id",
    requiredFields: [
      "roof_job_id",
      "job_number",
      "brand",
      "service_type",
      "job_status",
      "lead_envelope",
      "roofing_property",
      "lead",
      "opportunity",
      "customer",
      "quotation",
      "project",
      "current_gate_state",
      "jobnimbus_contact_id",
      "jobnimbus_job_id",
      "qb_invoice_ref",
    ],
  },
  {
    name: "Measurement Value",
    dir: "measurement_value",
    child: true,
    requiredFields: ["metric", "value", "unit", "confidence", "source_ref", "needs_review"],
  },
  {
    name: "Measurement Report",
    dir: "measurement_report",
    idField: "measurement_id",
    requiredFields: ["measurement_id", "roof_job", "roofing_property", "provider", "source_file", "raw_key", "review_status", "measurements"],
  },
  {
    name: "Material Takeoff Item",
    dir: "material_takeoff_item",
    child: true,
    requiredFields: ["category", "item_name", "quantity", "unit", "waste_factor", "source_ref", "confidence", "needs_review"],
  },
  {
    name: "Material Takeoff",
    dir: "material_takeoff",
    idField: "takeoff_id",
    requiredFields: ["takeoff_id", "roof_job", "measurement_report", "status", "prepared_at", "approved_by", "approved_at", "approval_note", "source_measurements_json", "assumptions", "exclusions", "items"],
  },
  {
    name: "Instant Estimate Session",
    dir: "instant_estimate_session",
    idField: "estimate_session_id",
    requiredFields: ["estimate_session_id", "lead_envelope", "roof_job", "source", "service_type", "status", "range_low", "range_high", "estimate_total", "configurator_url", "confidence", "review_required", "assumptions", "exclusions", "selected_services_json", "material_choices_json", "payload_json"],
  },
  {
    name: "Evidence Item",
    dir: "evidence_item",
    idField: "evidence_id",
    requiredFields: ["evidence_id", "roof_job", "lead_envelope", "evidence_type", "source_system", "source_uri", "r2_key", "drive_file_id", "customer_safe"],
  },
  {
    name: "Field Check-in",
    dir: "field_check_in",
    idField: "checkin_id",
    requiredFields: ["checkin_id", "roof_job", "job_number", "source_system", "submitted_at", "status", "photo_count", "evidence_ids_json", "notes", "drive_folder_url", "raw_key"],
  },
  {
    name: "Proposal Evidence Pack",
    dir: "proposal_evidence_pack",
    idField: "pack_id",
    requiredFields: ["pack_id", "roof_job", "quotation", "status", "evidence_summary_json", "assumptions", "exclusions", "customer_message"],
  },
  {
    name: "Payment Milestone",
    dir: "payment_milestone",
    idField: "payment_milestone_id",
    requiredFields: ["payment_milestone_id", "roof_job", "milestone_type", "status", "qb_entity_type", "qb_entity_id", "qb_operation", "realm_id", "event_ts", "raw_key", "notes"],
  },
  {
    name: "Production Gate State",
    dir: "production_gate_state",
    idField: "gate_id",
    requiredFields: ["gate_id", "roof_job", "gate", "state", "blocker_reason", "evidence_item", "waived_by", "waived_at", "waiver_reason"],
  },
  {
    name: "Hermes Run",
    dir: "hermes_run",
    idField: "run_id",
    requiredFields: [
      "run_id",
      "run_ts",
      "agent_role",
      "requested_by",
      "request_text",
      "target_doctype",
      "target_name",
      "lead_envelope",
      "roof_job",
      "linked_evidence",
      "capability_level",
      "tool_name",
      "tool_args_json",
      "dry_run_json",
      "approval_status",
      "approved_by",
      "approved_at",
      "before_target_ids",
      "after_target_ids",
      "result_status",
      "result_json",
      "error",
    ],
  },
];

const docs = new Map(specs.map((spec) => [spec.name, readDoc(spec.dir)]));
const localDoctypes = new Set(docs.keys());

for (const spec of specs) {
  const doc = docs.get(spec.name);
  const fields = new Map(doc.fields.map((field) => [field.fieldname, field]));

  assert.equal(doc.doctype, "DocType");
  assert.equal(doc.name, spec.name);
  assert.equal(doc.module, "IronWrap Roofing");
  assert.equal(doc.istable ? 1 : 0, spec.child ? 1 : 0, `${spec.name} istable mismatch`);

  if (spec.idField) {
    assert.equal(doc.autoname, `field:${spec.idField}`, `${spec.name} autoname`);
    assert.equal(doc.naming_rule, "By fieldname", `${spec.name} naming_rule`);
    assert.equal(fields.get(spec.idField)?.unique, 1, `${spec.name}.${spec.idField} must be unique`);
    assert.equal(fields.get(spec.idField)?.reqd, 1, `${spec.name}.${spec.idField} must be required`);
  }

  for (const name of spec.requiredFields) {
    assert.ok(fields.has(name), `${spec.name} missing field: ${name}`);
    assert.ok(doc.field_order.includes(name), `${spec.name} field_order missing: ${name}`);
  }

  for (const field of doc.fields) {
    if (field.fieldtype !== "Link" && field.fieldtype !== "Table") continue;
    const target = field.options;
    assert.ok(target, `${spec.name}.${field.fieldname} missing link/table target`);
    assert.ok(localDoctypes.has(target) || existingErpNextTargets.has(target), `${spec.name}.${field.fieldname} unknown target: ${target}`);
  }
}

function readDoc(dir) {
  const path = join(root, doctypeRoot, dir, `${dir}.json`);
  assert.ok(existsSync(path), `missing DocType JSON: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

console.log(`ok ${specs.length} IronWrap ERPNext DocTypes validated`);
