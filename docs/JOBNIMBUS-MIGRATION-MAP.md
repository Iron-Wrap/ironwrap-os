# JobNimbus Migration Map

Status: runbook for the JobNimbus exit, phase 1 (data-migration readiness)
Owner: IronWrap OS product owner
Last verified: 2026-08-21
Review trigger: JobNimbus schema change, D1 operating-core change, or any phase gate decision

IronWrap OS replaces JobNimbus. The dual-write bridge
([`workers-bus/src/jobnimbus.ts`](../workers-bus/src/jobnimbus.ts)) is an exit ramp, not a
destination. This runbook is the contract for copying JobNimbus data into **D1 operating
core** (`operating_leads` / `operating_customers` / `operating_properties` /
`operating_roof_jobs`) and proving the copy, without ever mutating JobNimbus.
The leftover Frappe importer (`tools/jobnimbus-import.mjs`) remains as a compatibility
tool only. Dual-write, Make, and Jotform are **not** retired until IRO-193 and the
Ivan/Ilya crew no longer open JobNimbus.

## Doctrine

- **JobNimbus is strictly read-only.** api1 has no DELETE; the exporter issues GET only.
  The migration is one-way copy + freeze. Nothing in phase 1 flips a system of record.
- **Snapshots are never committed.** Exported rows carry customer PII and live under the
  gitignored `output/` tree. Only aggregate counts, date ranges, and field names leave it.
- **Policy is not bypassed.** A JobNimbus adapter has not yet been joined to the canonical
  D1 CRM-import path. Until that adapter exists, no JobNimbus snapshot is treated as an owned
  D1 import; the existing Frappe importer remains compatibility-only. The future adapter must
  use `/admin/crm-import/{dry-run,execute}`, preserve source status and unmapped fields in the
  CRM import ledger, and never fabricate production-gate evidence.
- **Idempotency is keyed on the preserved JobNimbus id** (`jnid`), stored in the existing
  `jobnimbus_contact_id` / `jobnimbus_job_id` fields and in deterministic record ids
  (`jn:<jnid>` envelopes, `jn-<jnid>` customers/jobs, `jn-contact-<jnid>` properties).
  Records already created by the live bridge are **adopted** through their `jobnimbus_*`
  reference fields, never duplicated. Re-running any step converges.

## Toolchain (Export and compatibility tooling only; D1 adapter pending)

| Step | Tool | Side effects |
|---|---|---|
| 1. Export | `tools/jobnimbus-export.mjs` | GET-only against api1; NDJSON + manifest under `output/jobnimbus-export/` |
| 2. Import (pending) | JobNimbus adapter into `/admin/crm-import/{dry-run,execute}` | Not implemented; no direct-SQLite writer is owned by this repository. The adapter must use the canonical CRM import ledger and provider boundary. |
| 2b. Import (leftover) | `tools/jobnimbus-import.mjs` | Compatibility only; local Frappe; do not treat as the destination |
| 3. Reconcile | `tools/jobnimbus-reconcile.mjs` | Read-only leftover Frappe check; no D1 JobNimbus import verdict exists until the adapter is joined |
| Fixture | `tools/fixtures/generate-jobnimbus-synthetic-snapshot.mjs` | Deterministic synthetic snapshot (reserved `example.invalid` domains, 555 numbers) |

Credentials come from the environment at runtime (`JOBNIMBUS_API_KEY`; Frappe
`ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET`/`ERPNEXT_BASE_URL`), are never committed, and are never
printed by the tools.

## Source schema provenance

The live export snapshot manifest (counts, date ranges, per-field coverage, schema
fingerprint) is the binding observation of the JobNimbus schema. Until a live snapshot exists
(**Blocked**: `JOBNIMBUS_API_KEY` is currently empty in the local `ACCESS.env`; api1 answers
`401 {"status":401,"body":"Authentication required"}` without it), the field inventory below
derives from the two live-verified in-repo sources — the bridge's api1 facts
([`workers-bus/src/jobnimbus.ts`](../workers-bus/src/jobnimbus.ts), live-verified 2026-06-28)
and the fields the bridge itself writes — plus the JobNimbus api1 client conventions already
proven in production use. **First action after the key is restored: run the exporter and diff
the manifest's schema fingerprint against this table; extend the table where reality
disagrees.** `/account` (workflow stages, record types, custom-field definitions) is part of
the snapshot for exactly that purpose.

## Field map: JobNimbus contact

Target records: D1 `envelopes` (archive + external-reference anchor), `operating_customers`,
`operating_properties` (when the contact carries an address). Leftover Frappe names below
are the old compatibility labels, not the destination.

| JobNimbus field | Target | Transform |
|---|---|---|
| `jnid` | `envelopes.jn_contact_id`; keys `jn:<jnid>` / `jn-<jnid>` / `jn-contact-<jnid>` | verbatim |
| `display_name` | `operating_customers.display_name`, `envelopes.contact_name` | verbatim; fallback `company`, then `JobNimbus contact <jnid>` |
| `company` | archive-only in `payload_json` on D1 | D1 customers have no company/homeowner enum |
| `first_name`, `last_name` | archive-only in `payload_json` on D1 | D1 customers store `display_name` |
| `email` | `operating_customers.contact_email`, `envelopes.contact_email` | verbatim |
| `mobile_phone`, `home_phone`, `work_phone`, `phone` | `operating_customers.contact_phone`, `envelopes.contact_phone` | first non-empty, in that order (GHL imports land in `home_phone`) |
| `address_line1`, `city`, `state_text`, `zip`, `country_name` | `operating_properties.address_line1/.city/.province/.postal_code/.country` | verbatim; country defaults `Canada` |
| `description` | archive-only in `payload_json` on D1 | no customer notes column on D1 operating customers |
| `date_created` | `envelopes.ts` | unix seconds → datetime when present; otherwise import time |
| entire raw row | `envelopes.payload_json` | JSON, archive-only home for everything below |

Envelope constants: `source=manual`, `status=reconciled`,
`raw_key=jobnimbus-export:contacts:<jnid>`.

**No projected home (archive-only in `payload_json`):** `status_name` (JobNimbus contact
status has no `Roofing Customer` equivalent), `source_name`, `sales_rep`/`sales_rep_name`,
`record_type`/`record_type_name`, `tags`, `external_id` (bridge-written envelope id; the
adoption path uses the envelope directly), `is_lead`/`is_active`/`is_archived`, `geo`,
`address_line2`, `date_updated`, `created_by*`, and all account custom fields (`cf_*` /
account-named). Decision: archive-only for phase 1 — no new custom DocType fields until a
live snapshot shows which of these carry operational value. Revisit per field when phase 2
scopes owned workflows.

## Field map: JobNimbus job

Target record: D1 `operating_roof_jobs`, linked to the contact's envelope/customer/property.

| JobNimbus field | Target | Transform |
|---|---|---|
| `jnid` | `operating_roof_jobs.jobnimbus_job_id`; key `jn-<jnid>`; mirrored to `envelopes.jn_job_id` | verbatim |
| `number` | `operating_roof_jobs.job_number` | stringified (drives the Drive folder convention) |
| `related[type=contact].id` | `operating_roof_jobs.jobnimbus_contact_id` + links lead/customer/property | resolved through the contact's migrated records |
| `status_name` | `operating_roof_jobs.job_status` | status table below |
| `name`, `description`, `record_type_name` | `operating_roof_jobs.service_type` | keyword inference (metal/siding/gutter/roof → `Other`), same rule as the bus |
| `tags` (`brand:*`) | `operating_roof_jobs.brand` | `ironwrap` \| `iroof`; default `ironwrap` (JobNimbus predates the iroof split) |

**No projected home (archive-only via the contact envelope + snapshot):** job-site address
fields (`address_line1`/`city`/`state_text`/`zip` — phase 1 projects the *contact* address as
the property; a job whose site differs from the contact's mailing address keeps its true
address in the archive and gets a per-job property in phase 2), `geo`, `date_start`/`date_end`,
`approved_estimate_total`/`approved_invoice_total` (QuickBooks remains posted accounting
truth), `sales_rep*`, `primary`, `external_id`, `is_archived`, `date_updated`.

### Status table

| JobNimbus `status_name` (case-insensitive) | D1 `operating_roof_jobs.job_status` |
|---|---|
| lead, new, qualified | `qualified` |
| measurement, inspection, estimating, estimate, proposal, proposal sent, quote, signed, sold, won, approved, scheduled, in progress, in production, work in progress, completed, complete, job completed, invoiced, paid, closed | `qualified` + `status_capped` (do not infer completion or in-progress from JN) |
| lost, dead, cancelled, canceled | `cancelled` |
| anything else | `qualified` + `status_unmapped` |

A migration must never fabricate gate evidence. Imported jobs stay on
`current_gate_state=qualification`. Advancing capped jobs through owned gates is later
workflow work, not an import side effect.

## Field map: JobNimbus activity

User-written notes stay in the snapshot archive for the D1 importer. The leftover Frappe
importer may still write `Comment` records; that is not operating truth. System
status-change activities are not projected. Estimates, invoices, files, tasks, work orders,
and material orders are exported for the frozen archive but not imported in phase 1: money
stays QuickBooks-owned, files belong to the Drive migration, tasks are operational ephemera.

## Reconciliation contract

The leftover `tools/jobnimbus-reconcile.mjs` still reads local Frappe. There are currently no
owned D1 JobNimbus plan counts or `--execute` receipts: those remain pending a provider adapter
joined to `/admin/crm-import/{dry-run,execute}`. Once that adapter exists, its canonical CRM
import ledger and reconciliation report must prove every snapshot id landed exactly once, preserve
collisions/issues as queryable records, and carry aggregate numbers and field names only.

### Repository-verified worked example (synthetic fixture)

The leftover Frappe importer still has a synthetic GREEN loop against
[`deploy/local`](../deploy/local/README.md). That loop is compatibility evidence, not the
owned destination. No JobNimbus D1 adapter or D1 destination test is claimed here; live snapshot
counts and the adapter's status-cap rules belong in a later gate review, not in this file.

## Phases (1 is this runbook; 2-4 are decisions, not tools)

| Phase | Content | Gate |
|---|---|---|
| 1 | Export + map + adapter design (this runbook) | Green compatibility loop (done); canonical D1 adapter and live-snapshot loop pending |
| 2 | Live snapshot into a fresh local/staging D1; owner reviews counts, capped statuses, unmapped fields; per-field decisions on the archive-only set | Owner sign-off on the reconciliation verdict |
| 3 | Production import + JobNimbus freeze (bridge to read-only, owned intake primary) | Owner-authorized flip; rollback documented before execution |
| 4 | JobNimbus subscription exit after a full parallel period with reconciled evidence | Owner decision on the operating record |

Phase 1 makes no production writes anywhere: the D1 importer refuses remote URLs and
requires a local `IRONWRAP_D1_SQLITE_PATH` for `--execute`. Nothing here runs automatically.
