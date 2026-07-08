# erpnext-roofing-mcp

Read-only MCP server for the IronWrap ERPNext/Frappe roofing app.

This server is the first Hermes proof surface over ERPNext truth. It uses
Frappe token auth and exposes narrow read tools only:

- `get_roof_job`
- `get_lead_envelope`
- `list_job_gates`
- `list_blocked_jobs`
- `get_hermes_run`
- `list_hermes_runs_for_job`

Required environment:

```bash
ERPNEXT_BASE_URL=https://erp.example.com
ERPNEXT_API_KEY=...
ERPNEXT_API_SECRET=...
```

Run locally:

```bash
npm install
npm test
npm start
```
