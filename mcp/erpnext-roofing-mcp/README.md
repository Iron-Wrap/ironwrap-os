# erpnext-roofing-mcp

Read-only MCP server for the IronWrap ERPNext/Frappe roofing app.

This server is the first Hermes proof surface over ERPNext truth. It uses
Frappe token auth and exposes narrow read tools only:

- `get_roof_job`
- `get_lead_envelope`
- `list_job_gates`
- `list_blocked_jobs`
- `get_measurement_report`
- `list_measurement_reports_for_job`
- `get_evidence_item`
- `list_evidence_for_job`
- `get_hermes_run`
- `list_hermes_runs_for_job`
- `dry_run_update_gate`
- `request_update_gate`

`request_update_gate` is the only write tool. It is disabled unless
`ERPNEXT_WRITE_ENABLED=true` and `HERMES_WRITE_TOKEN` are set. The caller must
provide the approval token, and the token is redacted from the `Hermes Run`
audit payload.

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
