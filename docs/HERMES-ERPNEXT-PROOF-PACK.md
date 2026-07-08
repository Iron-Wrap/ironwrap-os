# Hermes/ERPNext Proof Pack

Status: local/source proof packet.
Date: 2026-07-08.

This collapses the artificial blockers from the Hermes/ERPNext blocker audit.
It does not replace the current JobNimbus/Worker bus operating path. It defines
what can be built and tested without waiting for account access.

## Source Proof

Upstream repos inspected under `/tmp/ironwrap-research`:

| Surface | Checked Commit | Useful Result |
|---|---:|---|
| Hermes Agent | `f64e4f4` | MCP config, tool filters, cron, gateways, skills, memory, observability, and security hooks are source-visible. |
| Frappe | `80d9c31` | Custom apps, DocType JSON, hooks, generated REST APIs, permissions, and web forms cover the extension path. |
| ERPNext | `95212e5` | Lead, Opportunity, Customer, Quotation, Sales Order, Project, Task, Item, Material Request, Purchase, and Stock primitives already exist. |
| Frappe Docker | `d4a3100` | Docker path exists; disposable `pwd.yml` is not the custom-app proof path. |
| Activepieces | `598f1535` | Community source includes HTTP/webhook, Jotform, Gmail, Google Drive, QuickBooks, and Twilio pieces. |
| DocuSeal | `d86b16d` | API/webhooks/embedded signing exist; AGPL plus additional terms keep it a legal/commercial decision. |

## ERPNext Roofing App Proof

No ERPNext core fork is needed for the first proof. Use a custom Frappe app,
for example `erpnext_roofing`, with fixtures committed as DocType JSON.

Custom DocTypes:

| DocType | Purpose | Links |
|---|---|---|
| Lead Envelope | Immutable inbound source event mirrored from the Worker bus | ERPNext Lead, Contact, Customer, Opportunity |
| Roofing Property | Roof/site-specific property facts | Customer, Address, Lead Envelope |
| Measurement Report | Report metadata, vendor, source file, normalized values | Roofing Property, Project, Quotation |
| Measurement Value | Child rows for slope, area, eave, ridge, valley, perimeter, waste, confidence | Measurement Report |
| Evidence Item | Photo/report/document/source reference used in proposal or gate | Project, Quotation, Task, Measurement Report |
| Proposal Option | Good/better/best or roof/siding/gutter option with assumptions and exclusions | Quotation |
| Production Gate State | Deposit/material/safety/completion gate state and override history | Project, Task, Sales Order |
| Supplier Quote | Supplier, valid-until, material lines, substitutions, delivery readiness | Material Request, Supplier |
| Market Watch Item | Competitor/product gap and response decision | none required |
| Hermes Run | Agent run metadata, tool calls, approvals, blocked writes | any linked business record |

Use existing ERPNext primitives first:

| Existing ERPNext Primitive | Roofing Use |
|---|---|
| Lead / Opportunity / Customer | Lead and sales pipeline |
| Quotation / Sales Order | Proposal and accepted contract mirror |
| Project / Task | Production board and owner exceptions |
| Item / Item Price / Supplier | Materials/catalog/pricing |
| Material Request / Purchase Order | Supplier quote/order readiness |
| File / Communication / Activity Log | Evidence and audit history |

Proof gate: install the app on a local ERPNext dev site and create one job from
sample lead -> property -> measurement -> quotation -> project gates without a
core fork.

## Bus To ERPNext Sync Contract

The current Worker remains the front door. ERPNext becomes an additional
consumer only after the current owned-store-first path is stable.

Current implementation checkpoint:

- Worker bridge: `workers-bus/src/erpnext.ts`.
- D1 proof fields: `workers-bus/migrations/0002_erpnext_consumer.sql` and
  `workers-bus/migrations/0003_erpnext_operating_core.sql`.
- Frappe app contract: `frappe-apps/ironwrap_roofing` now covers the gate-2
  operating core: lead envelope, roofing property, roof job, measurement report/value,
  evidence item, proposal evidence pack, production gate state, and Hermes run audit.
- Contract validator: `node tools/validate-erpnext-doctypes.mjs`.
- Read-only bus truth endpoints for Hermes/operator diagnostics:
  `GET /admin/envelopes`, `GET /admin/envelope/:id`, and `GET /admin/dead-letter`.
- Read-only MCP wrappers: `mcp/ironwrap-bus-mcp` and
  `mcp/erpnext-roofing-mcp`.
- Measurement bridge: `/ingest/measurement` now stores raw input first, then
  mirrors parsed report metadata and child measurement values into ERPNext
  `Measurement Report` when `ERPNEXT_ENABLED=true`.

Create/update order:

1. Worker receives source payload and writes raw R2 plus D1 envelope.
2. Worker/bridge maps the D1 envelope to ERPNext `Lead Envelope`.
3. If address/site data exists, upsert `Roofing Property`.
4. Always upsert a `Roof Job` wrapper tied back to the Lead Envelope, optional
   property, JobNimbus contact/job refs, JobNimbus job number, and current
   qualification gate.
5. If measurement/report data exists, create `Measurement Report` and child
   `Measurement Value` rows linked to the Roof Job by JobNimbus job number when
   that ERPNext job record exists.
6. Record Worker envelope id and raw key on every ERPNext-linked record.
7. Reconcile D1 count, ERPNext count, and failed sync rows.

Minimum payload:

```json
{
  "envelope_id": "ow_...",
  "source": "website",
  "brand": "ironwrap",
  "contact": {
    "name": "Test Lead",
    "phone": "5875550000",
    "email": "t@example.com"
  },
  "job_ref": "roof estimate",
  "payload": {
    "service": "metal roofing",
    "source_url": "https://ironwrapexteriors.com/quote/"
  },
  "ts": "2026-07-08T00:00:00Z"
}
```

Idempotency key: `envelope_id` first, then normalized phone/email plus source
window as the duplicate backstop.

## Hermes MCP Boundary

Hermes should not write directly to SQL, Frappe internals, JobNimbus, or
QuickBooks. Give it narrow tools with explicit capability levels.

| Level | Tool Type | Allowed Examples |
|---|---|---|
| Read-only | Query system truth | `get_envelope`, `list_recent_envelopes`, `get_lead_envelope`, `get_roof_job`, `list_job_gates`, `list_blocked_jobs`, `get_measurement_report`, `list_measurement_reports_for_job`, `get_hermes_run`, `list_hermes_runs_for_job` |
| Draft | Produce proposed changes | `draft_customer_reply`, `draft_proposal_scope`, `draft_gate_exception`, `draft_material_request` |
| Approved-write | One audited mutation after human approval | Current proof: `dry_run_update_gate`, `request_update_gate`; later: `create_job_note`, `create_followup_task` |
| Denied | Never expose | raw SQL, arbitrary HTTP, unrestricted file deletion, accounting writes, payment capture, SMS send before A2P/consent |

Every approved write creates a `Hermes Run` row with:

- user request
- tool name and arguments
- before/after target ids
- approval actor
- result/error
- linked evidence

Proof gate: run Hermes against fixture-backed MCP tools first. The first
approved-write proof is `request_update_gate`, guarded by
`ERPNEXT_WRITE_ENABLED=true` plus `HERMES_WRITE_TOKEN`, and audited through a
`Hermes Run` record before and after the ERPNext mutation.

## Measurement Proof

The Worker already has a measurement intake route:

- `POST /ingest/measurement`
- stores raw payload under `raw/measurements/...`
- extracts job number, report URL, and known numeric measurement keys
- files report PDFs to Google Drive when Google is configured
- records an audit row either way

Existing sample inputs:

- AppliCad XML: `samples/1013 Moville St.xml`
- RoofRuler PDFs under `samples/`

Runnable deterministic proof:

```bash
node tools/applicad-xml-proof.mjs --check
node tools/applicad-xml-proof.mjs
```

The proof extracts the AppliCad sample into source-referenced values:

- `roof_area = 1942.68 sf`
- `fascia_length = 147 lf`
- `gable_length = 80.11 lf`
- `ridge_length = 89 lf`
- `step_length = 13.7 lf`
- `tuck_under_length = 3 lf`
- `valley_length = 24.7 lf`

No second parser stack is needed. The current proof emits:

```json
{
  "source_file": "samples/1013 Moville St.xml",
  "job_number": "optional-if-known",
  "measurements": [
    {
      "name": "roof_area",
      "value": 1942.68,
      "unit": "sqft",
      "source_ref": "1013 Moville St.xml:POLYGON[size,type=Roof]",
      "confidence": "deterministic"
    }
  ],
  "needs_review": false
}
```

Proof gate: values used in a proposal link back to source file and source ref.

## Activepieces Decision

Decision: keep Make for current live connectors and owner visibility; bench
Activepieces as the open-source Make replacement candidate.

Why not switch now:

- current Worker already owns the critical path
- Make is already connected to JobNimbus/Jotform
- switching automation UI before the lead spine is live adds churn

Why keep Activepieces warm:

- MIT community code outside enterprise areas
- source-visible pieces for HTTP/webhook, Jotform, Gmail, Google Drive,
  QuickBooks, and Twilio
- useful for a later white-label product where connector ownership matters

Proof gate: local Activepieces flow receives a webhook, transforms it, calls a
mock Worker/ERPNext endpoint, and shows retries/failures clearly enough for ops.

## DocuSeal Decision

Decision: keep DocuSeal benched, not primary.

Use JobNimbus native e-sign first because it is already the operational CRM
surface. Use DocuSeal only if JobNimbus native e-sign fails a real proposal
workflow.

DocuSeal is viable as a fallback because it has Docker deployment, API,
webhooks, embedded signing, and PDF/template tooling. It is not "free to
white-label without thought": AGPLv3 plus additional terms need legal/commercial
approval before packaged resale.

Proof gate: if JobNimbus e-sign fails, run one sample proposal through stock
DocuSeal and confirm completion webhook -> Worker/Make -> job status update.

## Real Remaining Gates

These are not artificial and should stay visible:

| Gate | Owner/Access Needed |
|---|---|
| JobNimbus key rotation, plan limits, Engage availability, fields/stages | JobNimbus admin |
| A2P 10DLC / Canadian carrier registration | legal business details plus provider approval |
| Website form cutover | website host/CMS/agency access and real test lead |
| Make scenario resave/retirement | Make UI and owner confirmation |
| Jotform live forms/webhooks/mobile offline test | Jotform account and device test |
| QuickBooks Payments/webhook/OAuth | QuickBooks admin/OAuth |
| Google DKIM/DMARC and Microsoft mirror shutdown | Google/Microsoft admin plus owner signoff |
| Cloudflare token rotation | Cloudflare account authority |
| Historical OneDrive migration | Microsoft/Google access plus legacy mapping |
| Compliance/legal notices | lawyer/owner approval |
| GitHub remote publication | repository access fix |

Everything else above is buildable as local proof work.
