# JobNimbus Migration Map

Status: runbook for the JobNimbus exit, phase 1 (data-migration readiness)
Owner: IronWrap OS product owner
Last verified: 2026-08-09
Review trigger: JobNimbus schema change, `ironwrap_roofing` DocType change, or any phase gate decision

IronWrap OS replaces JobNimbus. The dual-write bridge
([`workers-bus/src/jobnimbus.ts`](../workers-bus/src/jobnimbus.ts)) is an exit ramp, not a
destination. This runbook is the contract for copying JobNimbus data into the owned Frappe
records and proving the copy, without ever mutating JobNimbus.

## Doctrine

- **JobNimbus is strictly read-only.** api1 has no DELETE; the exporter issues GET only.
  The migration is one-way copy + freeze. Nothing in phase 1 flips a system of record.
- **Snapshots are never committed.** Exported rows carry customer PII and live under the
  gitignored `output/` tree. Only aggregate counts, date ranges, and field names leave it.
- **Policy is not bypassed.** The import goes through the Frappe REST API and is validated by
  [`domain_policy.py`](../frappe-apps/ironwrap_roofing/ironwrap_roofing/domain_policy.py) like
  any other writer. Where policy demands evidence a migration cannot honestly supply
  (production gates), the import stops short and says so instead of fabricating it.
- **Idempotency is keyed on the preserved JobNimbus id** (`jnid`), stored in the existing
  `jobnimbus_contact_id` / `jobnimbus_job_id` fields and in deterministic record ids
  (`jn:<jnid>` envelopes, `jn-<jnid>` customers/jobs, `jn-contact-<jnid>` properties).
  Records already created by the live bridge are **adopted** through their `jobnimbus_*`
  reference fields, never duplicated. Re-running any step converges.

## Toolchain (Implemented; Repository-verified against the local stack)

| Step | Tool | Side effects |
|---|---|---|
| 1. Export | `tools/jobnimbus-export.mjs` | GET-only against api1; NDJSON + manifest under `output/jobnimbus-export/` |
| 2. Import | `tools/jobnimbus-import.mjs` | Dry-run by default; `--execute` upserts into a **local** Frappe only (non-local targets refused) |
| 3. Reconcile | `tools/jobnimbus-reconcile.mjs` | Read-only; GREEN/RED verdict with aggregate numbers only |
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

Target records: `Lead Envelope` (archive + external-reference anchor), `Roofing Customer`,
`Roofing Property` (when the contact carries an address).

| JobNimbus field | Target | Transform |
|---|---|---|
| `jnid` | `Lead Envelope.jobnimbus_contact_id`; keys `jn:<jnid>` / `jn-<jnid>` / `jn-contact-<jnid>` | verbatim |
| `display_name` | `Roofing Customer.display_name`, `Lead Envelope.contact_name` | verbatim; fallback `company`, then `JobNimbus contact <jnid>` |
| `company` | `Roofing Customer.customer_type` | non-empty → `Company`, else `Homeowner` |
| `first_name`, `last_name` | `Roofing Customer.first_name/.last_name` | verbatim |
| `email` | `Roofing Customer.email`, `Lead Envelope.contact_email` | verbatim |
| `mobile_phone`, `home_phone`, `work_phone`, `phone` | `Roofing Customer.phone`, `Lead Envelope.contact_phone` | first non-empty, in that order (GHL imports land in `home_phone`) |
| `address_line1`, `city`, `state_text`, `zip`, `country_name` | `Roofing Property.address_line1/.city/.province/.postal_code/.country` | verbatim; country defaults `Canada` |
| `description` | `Roofing Customer.notes` | verbatim |
| `date_created` | `Lead Envelope.event_ts` | unix seconds → datetime |
| entire raw row | `Lead Envelope.payload_json` | JSON, archive-only home for everything below |

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

Target record: `Roof Job`, linked to the contact's envelope/customer/property.

| JobNimbus field | Target | Transform |
|---|---|---|
| `jnid` | `Roof Job.jobnimbus_job_id`; key `jn-<jnid>`; mirrored to `Lead Envelope.jobnimbus_job_id` + `.job_ref` | verbatim |
| `number` | `Roof Job.job_number` | stringified (drives the Drive folder convention) |
| `related[type=contact].id` | `Roof Job.jobnimbus_contact_id` + links `lead_envelope`/`customer`/`roofing_property` | resolved through the contact's migrated records |
| `status_name` | `Roof Job.job_status` | status table below |
| `name`, `description`, `record_type_name` | `Roof Job.service_type` | keyword inference (metal/siding/gutter/soffit/fascia/commercial/roof → `Other`), same rule as the bus |
| `tags` (`brand:*`) | `Roof Job.brand` | `ironwrap` \| `iroof`; default `ironwrap` (JobNimbus predates the iroof split) |

**No projected home (archive-only via the contact envelope + snapshot):** job-site address
fields (`address_line1`/`city`/`state_text`/`zip` — phase 1 projects the *contact* address as
the property; a job whose site differs from the contact's mailing address keeps its true
address in the archive and gets a per-job property in phase 2), `geo`, `date_start`/`date_end`,
`approved_estimate_total`/`approved_invoice_total` (QuickBooks remains posted accounting
truth), `sales_rep*`, `primary`, `external_id`, `is_archived`, `date_updated`.

### Status table

| JobNimbus `status_name` (case-insensitive) | `Roof Job.job_status` |
|---|---|
| lead, new, qualified | Qualified |
| measurement, inspection | Measurement |
| estimating, estimate, proposal, proposal sent, quote | Proposal |
| signed, sold, won, approved | Won |
| scheduled, in progress, in production, work in progress | In Production → **imported as Won** (capped) |
| completed, complete, job completed, invoiced | Completed |
| paid, closed | Closed → **imported as Completed** (capped) |
| lost, dead, cancelled, canceled | Lost |
| anything else | Qualified + `status_unmapped` ledger entry |

Two policy consequences, discovered by running the loop (not designed in advance):

- `Won`/`Completed` (and beyond) require `workflow_profile` + the locale policy snapshot.
  The importer supplies `Residential Retail` + the operative locale from
  [`config/tenants/ironwrap.json`](../config/tenants/ironwrap.json) at create time only
  (the fields are write-once).
- `In Production`/`Closed` additionally require real Production Gate State rows. A migration
  must never fabricate gate evidence, so those imports are **capped** (table above) with a
  `status_capped` ledger entry carrying the true JobNimbus status; advancing capped jobs
  through gates is phase-2+ owned-workflow work. Updates never regress a status and never
  resurrect a `Lost` job (`status_conflict` ledger entry, Frappe state kept).

## Field map: JobNimbus activity

User-written notes (`record_type=1`, `is_status_change=false`, non-empty `note`) become Frappe
`Comment` records on the mapped `Roof Job` (preferred) or `Roofing Customer`, with the marker
`[jn:<jnid>]` in `subject` + `content` as the idempotency key. System status-change activities
are not projected: the frozen snapshot is their archive, and JobNimbus workflow history does
not become owned workflow history. Estimates, invoices, files, tasks, work orders, and
material orders are exported for the frozen archive but not imported in phase 1: money stays
QuickBooks-owned, files belong to the Drive migration, tasks are operational ephemera.

## Reconciliation contract

`tools/jobnimbus-reconcile.mjs` recomputes, from the snapshot and a fresh read of the local
Frappe: per-entity counts (snapshot vs landed), missing-id sets, collision sets (duplicate
`jnid`s in the snapshot; multiple Frappe records claiming one `jnid`; duplicate
`job_number`s), and the unmapped-field inventory against this map. Verdict is GREEN only when
every snapshot id landed exactly once and no collisions exist. The verdict file carries
aggregate numbers and field names only — safe to quote in a PR or Linear comment.

### Repository-verified worked example (synthetic fixture)

Loop: fixture snapshot → dry-run → `--execute` → `--execute` again (idempotency) → reconcile,
against the local stack from [`deploy/local`](../deploy/local/README.md):

| Entity | Snapshot | In Frappe | Missing |
|---|---:|---:|---:|
| Contacts → Lead Envelope + Roofing Customer | 12 | 12 | 0 |
| Jobs → Roof Job | 9 | 9 | 0 |
| User notes → Comment | 14 | 14 | 0 |

Verdict GREEN; collisions none; second `--execute` pass converged (contacts adopted/updated,
5 jobs adopted + 4 created after the policy gates above were honored, notes deduplicated);
2 `status_capped`, 1 `status_unmapped`, 0 errors. Synthetic numbers from the committed
fixture generator — live counts belong in the phase-2 gate review, not in this file.

## Phases (1 is this runbook; 2-4 are decisions, not tools)

| Phase | Content | Gate |
|---|---|---|
| 1 | Export + map + idempotent local import + reconciliation (this runbook) | Green synthetic loop (done); green live-snapshot loop pending the restored key |
| 2 | Live snapshot into a fresh local/staging Frappe; owner reviews counts, capped statuses, unmapped fields; per-field decisions on the archive-only set | Owner sign-off on the reconciliation verdict |
| 3 | Production import + JobNimbus freeze (bridge to read-only, owned intake primary) | Owner-authorized flip; rollback documented before execution |
| 4 | JobNimbus subscription exit after a full parallel period with reconciled evidence | Owner decision on the operating record |

Phase 1 makes no production writes anywhere: the importer refuses non-local Frappe targets at
startup, and nothing here runs automatically.
