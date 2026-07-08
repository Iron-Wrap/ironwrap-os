# erpnext-roofing-mcp

Narrow MCP server for the IronWrap ERPNext/Frappe roofing app.

This server is the first Hermes proof surface over ERPNext truth. It uses
Frappe token auth and exposes read tools plus token-gated approved-write tools:

- `get_roof_job`
- `get_lead_envelope`
- `list_job_gates`
- `list_blocked_jobs`
- `get_measurement_report`
- `list_measurement_reports_for_job`
- `get_material_takeoff`
- `list_material_takeoffs_for_job`
- `get_instant_estimate_session`
- `list_instant_estimate_sessions_for_job`
- `get_evidence_item`
- `list_evidence_for_job`
- `get_field_check_in`
- `list_field_check_ins_for_job`
- `get_proposal_evidence_pack`
- `list_proposal_evidence_packs_for_job`
- `get_payment_milestone`
- `list_payment_milestones_for_job`
- `get_hermes_run`
- `list_hermes_runs_for_job`
- `dry_run_update_gate`
- `request_update_gate`
- `dry_run_material_takeoff`
- `request_create_material_takeoff`
- `dry_run_update_material_takeoff_status`
- `request_update_material_takeoff_status`
- `dry_run_proposal_evidence_pack`
- `request_create_proposal_evidence_pack`

Estimator intake enters ERPNext through the Worker `POST /ingest/estimate` route first. This MCP
server reads the resulting `Instant Estimate Session` rows and can draft downstream takeoff/proposal
work, but it does not accept raw public estimator submissions itself.

Write tools are disabled unless `ERPNEXT_WRITE_ENABLED=true` and
`HERMES_WRITE_TOKEN` are set. The caller must provide the approval token, and
the token is redacted from the `Hermes Run` audit payload.

Current approved-write tools:

- `request_update_gate` updates one `Production Gate State`.
- `request_create_material_takeoff` creates or updates one review-gated
  `Material Takeoff` from linked Measurement Report values. It does not approve
  quantities, create supplier orders, create purchase orders, or mutate invoices.
- `request_update_material_takeoff_status` updates one `Material Takeoff`
  review status with an approval note and Hermes Run audit row. It does not
  create supplier orders, purchase orders, invoices, or customer-facing scope.
- `request_create_proposal_evidence_pack` creates or updates one draft
  `Proposal Evidence Pack` from linked Measurement Report and Evidence Item
  rows. It does not approve pricing, scope, payment terms, material orders, or
  customer send.

Required environment:

```bash
ERPNEXT_BASE_URL=https://erp.example.com
ERPNEXT_API_KEY=...
ERPNEXT_API_SECRET=...
ERPNEXT_WRITE_ENABLED=false
HERMES_WRITE_TOKEN=...
```

Run locally:

```bash
npm install
npm test
npm start
```
