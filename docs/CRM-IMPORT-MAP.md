# CRM Import Map

Status: runbook for onboarding a customer's existing CRM export into a fresh tenant
Owner: IronWrap OS integrations
Last verified: 2026-08-22
Review trigger: a real customer export arrives, the seeded pipeline's stage keys change, or a new
provider adapter is added

A company that already runs a CRM does not start from an empty board. This runbook is the contract
for copying an existing CRM export into a tenant with **values and stage placement intact**, without
inventing anything the export does not prove.

It follows [`JOBNIMBUS-MIGRATION-MAP.md`](JOBNIMBUS-MIGRATION-MAP.md) deliberately: same doctrine,
same capping pattern, same "archive rather than drop" disposition for fields with no home. That
runbook migrates JobNimbus into Frappe; this one imports any CRM export into the D1 operating core
and the pipeline board.

## Doctrine

- **Nothing is fabricated.** Where a source stage asserts something our system would need real
  evidence to back, the card is placed on the furthest stage the evidence honestly supports and the
  true source stage rides a `stage_capped` ledger entry.
- **Nothing is silently dropped.** Every populated source column is either placed in a field or
  archived verbatim in the envelope payload, and every archive is named in the import report.
- **Identity is deterministic**, so the import is idempotent: `envelope_id` is a hash of
  (adapter, tenant, import key), every operating id derives from it, and every insert on that path
  is `ON CONFLICT DO NOTHING`. A second run over the same file adopts; it never duplicates.
- **The core stays generic.** The importer adds three `crm_import_*` tables of its own and not one
  column to a core table. Provider knowledge lives in one adapter constant
  (`workers-bus/src/crm-import/adapters.ts`); everything downstream of it is provider-agnostic.
- **No provider is ever contacted.** The only input is a file the operator already has.

## Surfaces

| Surface | What it does |
|---|---|
| `POST /admin/crm-import/dry-run` | Plans every row and writes nothing, anywhere. Returns the full report. |
| `POST /admin/crm-import/execute` | Applies that same plan. Returns the same report plus `applied`. |
| `GET /admin/crm-import/runs` | Recent executed runs. |
| `GET /admin/crm-import/runs/<id>` | The stored report for one run. |
| `GET /admin/crm-import/adapters` | The adapter and pipeline catalogue, before anyone uploads a file. |
| `tools/crm-import.mjs` | Reads the file, calls the Worker, prints the report a human reviews. Refuses non-local targets. |
| `tools/ghl-api-to-crm-import.mjs` | Offline: converts a GoHighLevel API pull (opportunities, contacts, pipelines; raw bodies or bridge envelopes) into the `ghl` adapter's row file, one row per opportunity with the stage name resolved. Closed deals (status abandoned or lost, or an Abandoned/Lost stage) go to a separate file, because the lead lifecycle has no closed-lost state yet. Prints counts only. |
| `tools/seed-env.mjs` | Drives this surface with the shipped synthetic JobNimbus fixture to seed a non-production environment (`docs/OPERATIONS-RUNBOOK.md`). Synthetic rows only; refuses the production Worker name, route hostname, workers.dev hostname and D1 id committed in `workers-bus/wrangler.jsonc`, plus any non-loopback `--base-url` - a remote target is allowed only when `workers-bus/wrangler.jsonc` declares it as a non-production environment, which today is `qa` alone, unlike `tools/crm-import.mjs`'s local-only refusal below. |

All `/admin/` paths are bearer-gated on `ADMIN_TOKEN` by the Worker router.

```bash
ADMIN_TOKEN=... node tools/crm-import.mjs --file export.csv --adapter ghl          # dry run
ADMIN_TOKEN=... node tools/crm-import.mjs --file export.csv --adapter ghl --execute
```

## The documented import format

**No real customer export exists yet.** This is the format the readiness report recommended, not a
file anyone has seen; when the real export arrives it is an alias-table change in one file. One row
per opportunity, CSV (or a JSON array of the same objects):

| Column | Required | Notes |
|---|---|---|
| `external_id` | recommended | The source's own opportunity id. Without it, identity falls back to row content plus an occurrence counter - stable across re-ordering, but supply an id if you have one. |
| `contact_name` | | |
| `email` / `phone` | **one of the two** | A row with neither cannot become a customer and is reported as a row error. |
| `address`, `city`, `province`, `postal_code` | | A row with no address parts creates no property. |
| `service` | | Multi-value cells split on `;`, `,` and ` / `. The first entry is the primary. |
| `value` | | `C$6,400.00`, `$12,750.50` or `22000`. Anything ambiguous is a row error, never a guess. |
| `stage` | | The source board column, verbatim. Mapped through the table below. |
| `lead_number`, `job_number` | | |

Anything else in the file is archived verbatim, per column, and named in the report.

The `ghl` adapter accepts the GoHighLevel-style column names (`Opportunity ID`, `Contact Name`,
`Services Needed`, `Opportunity Value`, `Pipeline Stage`, ...) and reads `Notes`, `Tasks`, `Emails`,
`Calls`, `SMS` and `Conversations` as engagement counters.

## Stage placement map

Target is the seeded Sales pipeline. Stage keys are the slugified seed labels; the board owns the
stage rows and this module only records the key it placed a card under.

| Source stage | Placed on | Verdict |
|---|---|---|
| New Lead, Lead, New | `new_lead` | direct |
| Visit Booked, Appointment/Inspection booked, Visit scheduled | `visit_booked` | direct |
| Need Quote, Needs quote, Quote needed, Estimating | `need_quote` | direct |
| Quote Sent, Proposal sent, Estimate sent, Quoted | `quote_sent` | direct |
| Contract signed, Signed, Sold, Won, Closed won | `contract_signed` | direct |
| Deposit, Deposit received/paid | `contract_signed` | **capped** |
| Materials in prod(uction), In production, Materials ordered | `contract_signed` | **capped** |
| Materials ready, Job start booked, Job started, Job complete, Job signed off | `contract_signed` | **capped** |
| anything else, or blank | `new_lead` | **unmapped**, reported per label |

**Why those cap.** The post-contract job stages assert scheduling, installation and sign-off, which
need real job-phase and acceptance evidence; a migration never fabricates it. `Deposit` asserts money received; QuickBooks remains posted accounting truth
and an export carries no payment record. `Materials in prod` asserts production started, which needs
real `operating_production_gates` rows - exactly the reason `JOBNIMBUS-MIGRATION-MAP.md` caps
JobNimbus `In Production` and `Closed`. `Contract signed` itself imports directly, matching that
runbook's `signed / sold / won / approved -> Won` row: it is the last stage the export's own claim
supports.

**A stage placement does not flip authoritative state.** `operating_leads.lifecycle_status` and
`operating_roof_jobs.job_status` keep their defaults. Coupling a stage to job state is an automation
action with its own contract, not a side effect of an import.

## Field dispositions

| Source field | Home | Disposition |
|---|---|---|
| contact name | `operating_leads.contact_name`, `operating_customers.display_name` | placed |
| email / phone | `operating_leads.contact_*`, `operating_customers.contact_*` | placed, normalized; also the customer dedup identity |
| address, city, province, postal code | `operating_properties.address_line1/.city/.province/.postal_code` | placed |
| service (primary) | `operating_roof_jobs.service_type` | placed |
| service (additional) | `payload_json` `crm_import.services` | **archived** - `service_type` is a single Select; multi-service jobs are M5 |
| value, from `Need Quote` onward | `operating_instant_estimates.estimate_total_cents` | placed |
| value, before `Need Quote` | `payload_json` `crm_import.source_value_cents` | **archived** - there is no estimate or quote to attach money to, and a fabricated total is worse than a blank card |
| stage | `crm_import_records.stage_key` | placed; capped and unmapped placements keep the true source stage |
| lead number | `crm_import_records.source_lead_number`, `payload_json` | placed as data. `envelope_id` is an opaque UUID and is never printed as a lead number; a card shows `Lead:` only where the export supplied a real code |
| job number | `operating_roof_jobs.job_number` | placed. No number generator is owned in M1 |
| activity counters | `payload_json` `crm_import.activity` | **archived** - `Communication Event` has per-message rows and no rollup; no count is fabricated |
| unmapped columns | `payload_json` `crm_import.extras` | **archived**, named per column in the report |
| unparseable email/phone | `payload_json` `crm_import.extras` | **archived** - a bad contact method does not sink an otherwise-good row |

Nothing is dropped. `dropped` stays 0 in every report; the column exists so a future disposition that
genuinely cannot be archived has somewhere honest to appear.

## The board seam

The importer writes `crm_import_records.stage_key`, a stage key string - not a foreign key into a
pipeline table. The pipeline board owns pipelines, stages and cards; it reads placements by
(`tenant_id`, `pipeline_key`, `stage_key`) and joins to `operating_roof_jobs` on `roof_job_id`. That
keeps the import runnable before the board exists and keeps the board free to own its own schema.

If the seeded pipeline slugs its stages differently from the labels above, `SEEDED_SALES_PIPELINE` in
`workers-bus/src/crm-import/stage-map.ts` is the single line that changes.

## Reconciliation contract

Every report carries, for the same run:

- `reconciliation` - source rows = planned + errored, and source cents = placed + archived. The
  `balanced` flag is that arithmetic, not an assertion.
- `stages` - card count, placed value and archived value per target stage.
- `sourceStages` - the same counts per source board column, with the verdict that moved them.
- `capped`, `unmappedStages`, `fieldDispositions`, `rowErrors` - every disposition, named.

The executed report is stored verbatim in `crm_import_runs.report_json`, and every capped, archived
or failed disposition is also a queryable `crm_import_issues` row.

## Verified example (synthetic fixture)

`workers-bus/test/fixtures/crm-import/ghl-opportunities.csv` - 11 rows, reserved `example.invalid`
domains and 555 numbers, covering all seven stages, an unmapped stage, a multi-service row, an early
value, a row with no id and a row with no contact method.

| | rows | value |
|---|---:|---:|
| Source | 11 | $108,650.50 |
| Planned | 10 | placed $99,150.50 + archived $9,500.00 |
| Row errors | 1 (no contact method) | |
| Capped | 2 (`Deposit`, `Materials in prod`) | |
| Second run | 0 created, 10 adopted | |

Covered by `workers-bus/test/crm-import-plan.test.ts`, `crm-import-store.test.ts` and
`crm-import-api.test.ts`.

## Limits, stated plainly

- The format is the recommended shape, not a customer's actual file.
- Contract acceptance, payment and production-gate evidence are never synthesized; capped cards need
  a human to advance them once real evidence exists.
- Activity counters have no rendering home and are archive-only.
- The import surface is bearer-gated and operator-run. A self-service upload screen belongs to the
  PWA and is not part of this module.
