# 18 - Phase 1 Source Truth And Build Contract

Status: active build contract.

This file is the authoritative first-phase contract for turning the current
IronWrap stack into the ERPNext/Hermes end product. It starts from what exists
now, not from a clean-room plan.

## Evidence Reviewed

Current repo and local evidence checked on 2026-07-08:

- Git branch: `codex/ironwrap-source-truth-cleanup`.
- Worker code: `workers-bus/src/index.ts`, `photos.ts`, `measurements.ts`,
  `quickbooks.ts`, `google.ts`, `jobnimbus.ts`, `store.ts`, and D1 migration.
- Cloudflare config: `workers-bus/wrangler.jsonc`.
- Local secret name inventory only: `ACCESS.env`, `workers-bus/.dev.vars`,
  `workers-bus/.dev.vars.example`. Secret values were not printed or copied.
- Samples: `samples/` has 29 files: 28 PDFs and 1 AppliCad XML.
- Generated/provenance folders: `task1-spec/assets/` has 27 source artifacts;
  `output/` has 24 generated/audit artifacts.
- AppliCad proof: `node tools/applicad-xml-proof.mjs --check` passes.
- Code graph: Worker clusters show website ingest, photo ingest, measurement
  ingest, QuickBooks webhook, JobNimbus queue push, Google Drive filing,
  retry, reconcile, and dead-letter paths.
- Wrangler live inventory attempt: current local Wrangler login is Mindburn
  Labs account `5023dd227b538fc4238439fd7d52640f`, while the IronWrap Worker
  config points at account `7ee5775bc1ba46f05c5a65235b60e939`; IronWrap D1 and
  Queue inventory cannot be revalidated from the current login.

## Current Connections Register

| Area | Current evidence | Build decision |
|---|---|---|
| Make | Prior verified account: org `IronWrap Exteriors` id `6202921`, Core plan, team `My Team` id `1742726`. About 16 experimental GHL-hub scenarios. JobNimbus and Jotform connections exist in Make. | Keep Make Core for native connectors and visibility, but make the Worker bus the owned spine. Edit live scenarios in Make UI only. |
| Make RoofRuler | `docs/EMAIL-DUAL-DELIVERY.md` verifies scenario `Roofroler Report Processing` id `4754599`, hook `RoofRulerMailHook` id `2165390`. RoofRuler replies directly to the Make mailhook; `quote@` is only Cc. | Do not add a second Google routing feed. Bridge this scenario to `POST /ingest/measurement` or replace it after direct intake is proven. |
| Make/GHL rescue | Existing GHL -> JobNimbus import was fixed to `Customer` / `New`; `source_name` omitted. Bulk rescue moved JobNimbus from 6 to 103 contacts, duplicates skipped. | Treat rescue as completed/import scaffolding. Retire one-time rescue scenarios after owner confirms no rerun is needed. |
| GHL | Experimental/legacy front-door routes still exist in the Make/GHL hub. It is not the target CRM or data owner. | No new GHL work. Replace live routes with bus feeds, then disable GHL routes after replacement proof. |
| Cloudflare Worker | Configured Worker `ironwrap-bus`; base URL in checklists is `https://ironwrap-bus.yellow-rain-7498.workers.dev`. | Worker remains the owned bus and first write point. Revalidate live resources after logging into the IronWrap Cloudflare account. |
| Cloudflare D1 | `wrangler.jsonc`: binding `DB`, database `ironwrap-bus`, id `f0674848-13df-4422-9896-8ba2719663b8`. | Canonical envelopes, audit log, source counts, heartbeat, dead letters. |
| Cloudflare R2 | `wrangler.jsonc`: binding `RAW`, bucket `ironwrap-bus-raw`. | Raw inbound payload/file metadata lands here before downstream mutation. |
| Cloudflare Queues | `ironwrap-jn-push` producer/consumer, `ironwrap-jn-dlq` dead-letter queue. | JobNimbus push is retried and recoverable; no lead depends on a single synchronous CRM write. |
| Cloudflare Cron | `*/5 * * * *` retry sweep and `0 14 * * *` daily reconcile. | Repair stuck pushes continuously; daily reconcile is detection and heartbeat. |
| Cloudflare auth | Current Wrangler OAuth account does not match the IronWrap `account_id`; D1/Queue reads fail with Cloudflare auth error code `10000`. | Real gate: switch/refresh Cloudflare login or token for account `7ee...e939` before deploy/inventory changes. |
| JobNimbus | Live API facts: base `https://app.jobnimbus.com/api1`, bearer auth, list shape `{count, results}`, id `jnid`, contact type `Customer`, job type `Retail`, invalid `"Lead"` rejected, `source_name` must be omitted unless configured. | JobNimbus is operating CRM/job truth and consumer of bus records; rotate shared API key and issue dedicated bus key. |
| Google Workspace mail | `sales@ironwrapexteriors.com` is the Google user; `info@` and `quote@` are aliases mirrored to Microsoft; `ilya@` routes Microsoft-only. | Gmail sends bus email from `sales@` until sender alias changes are explicitly tested. |
| Google Drive | Shared Drive IDs in `wrangler.jsonc`: Jobs `0AHqXhIQ3svySUk9PVA`, Restricted `0AMufCVvWaztwUk9PVA`, Archive `0AFTfvKuo0_6uUk9PVA`. | Google Drive is the human job archive; R2 is raw archive. Job folders key on JobNimbus job number. |
| Microsoft 365 / OneDrive | Mirror and legacy archive only. M365 receives `info@`/`quote@` copies; OneDrive remains migration source. | Do not build new workflow on M365/OneDrive. Migrate historical files to Google Drive. |
| Jotform | Connected account is `info@iroofalberta.ca`; Worker payload contract exists for jobsite photos. | Build/confirm live Jobsite Photo form and point to `POST /ingest/photo`. |
| QuickBooks | QBO account exists under `info@ironwrapexteriors.com`; Worker signed webhook receiver exists. | Connect `QB_WEBHOOK_TOKEN` and Intuit webhook; defer OAuth read/status mirror until needed. |
| SMS/phone | Worker does not send SMS. JobNimbus Engage is the SMS path after A2P approval. Twilio secrets exist as names only, but Worker must not use Twilio SMS. | Configure Engage/A2P; own portable DID only if AssistAI/voice routing needs it. |
| Hermes/ERPNext | Strategy/proof docs exist; no ERPNext runtime app is in this repo yet. | Phase 1 builds the bridge contract first, then adds ERPNext app skeleton after the current bus feed is operating. |

## Worker Surface That Already Exists

| Method | Path | Current behavior |
|---|---|---|
| `GET` | `/health` | Liveness JSON. |
| `POST` | `/ingest/:source` | Bearer-auth lead intake for allowed source names; raw to R2, envelope to D1, dedup, Gmail instant ack, enqueue JobNimbus push. |
| `POST` | `/ingest/photo` | Bearer-auth Jotform/photo intake; raw to R2, requires job number and photo URLs, files to Google Drive when configured, writes audit rows. |
| `POST` | `/ingest/measurement` | Bearer-auth RoofRuler/AppliCad metadata/report intake; raw to R2, requires job number, captures structured measurements, files report to Google Drive when configured. |
| `POST` | `/webhook/quickbooks` | Verifies Intuit `intuit-signature`, stores raw payload, records entity events; JobNimbus status mirror waits for QB OAuth. |
| `POST` | `/admin/reconcile` | Admin-auth source-vs-landed reconciliation and heartbeat. |
| `POST` | `/admin/source-count` | Admin-auth independent count input for reconciliation. |
| `POST` | `/admin/replay` | Admin-auth requeue of dead envelopes. |
| Queue | `ironwrap-jn-push` | Idempotent JobNimbus push. |
| DLQ | `ironwrap-jn-dlq` | Dead-letter record and owner alert. |
| Cron | retry/reconcile | Retry stuck pushes and write daily heartbeat. |

## Sample Inputs Inventory

The build must support the existing sample set before adding new providers.

| Sample class | Count | Examples | Required phase-1 handling |
|---|---:|---|---|
| AppliCad XML | 1 | `1013 Moville St.xml` | Deterministic parser first. Current proof extracts roof area 1942.68 sf, ridge 89 lf, valley 24.7 lf, and related edges. |
| Roof/metal-roof PDFs | 12 | `IronWrap 26-154-ER Richard Nowak Metal Roofing Report.pdf`, `590 Hermitage Rd... #1/#2.pdf` | Text/markdown extraction, then review queue for uncertain values. |
| Gutter PDFs | 5 | `94 Geikie Street... Gutter Report.pdf`, `IronWrap_26_165..._Gutter_Report.pdf` | Extract linear feet/areas when possible; otherwise review. |
| Soffit/fascia PDFs | 5 | `94_Geikie...Soffit_&_Fascia_Report.pdf` | Extract soffit/fascia quantities and attach evidence. |
| Siding PDFs | 2 | `IronWrap 26-171-ABN Ethan Hills Metal Siding Report.pdf` | Extract siding quantities and flag assumptions. |
| Generated website audit | 1 folder | `output/website-audit-2026-06-27/` screenshots and audit markdown | Source for website intake and UX fixes, not operating data. |
| Legacy planning pack | 27 files | `task1-spec/assets/*.pdf`, flow PNGs, RU docx | Provenance only unless a current spec cites it. |

## Phase 1 Goal

Phase 1 is not the whole product. It is the smallest complete operating loop
that proves the final architecture:

```text
real source event
-> Worker bus
-> R2 raw record
-> D1 envelope/audit row
-> Gmail instant ack / owner alert
-> JobNimbus contact/job push
-> Google Drive evidence folder
-> ERPNext-ready event contract
-> reconciliation heartbeat
```

ERPNext and Hermes enter Phase 1 as contracts and skeletons, not as the first
place live leads are written. The existing Worker path already protects leads;
do not destabilize it by inserting ERPNext in front of the first live feed.

## Exhaustive Phase 1 Work Items

| ID | Work item | Acceptance proof |
|---|---|---|
| P1.1 | Switch/refresh Cloudflare auth for IronWrap account `7ee5775bc1ba46f05c5a65235b60e939`. | `wrangler whoami` shows an account that can read the configured D1/Queues; `wrangler d1 list` and `wrangler queues list` succeed for IronWrap. |
| P1.2 | Revalidate deployed Worker, D1, R2, Queues, cron, and secret names. | Read-only inventory recorded; no secret values copied. |
| P1.3 | Rotate shared JobNimbus API key and install a dedicated bus key. | `wrangler secret put JOBNIMBUS_API_KEY`; one test push still lands in JobNimbus. |
| P1.4 | Feed one real website or Make lead into `/ingest/website`. | D1 envelope exists, raw R2 object exists, Gmail ack/owner alert sends, JobNimbus gets `bus:*` tag. |
| P1.5 | Add source count for that lead and run reconcile. | `/admin/source-count` then `/admin/reconcile` shows no gap for that source/day. |
| P1.6 | Freeze new GHL work. | Docs and Make notes state no new GHL mutations except rescue/disable actions. |
| P1.7 | Retire or park GHL rescue scenarios after owner confirms no rerun. | Scenario list marks rescue as disabled/archived; JobNimbus count remains stable. |
| P1.8 | Bridge RoofRuler scenario `4754599` to `/ingest/measurement` or replace with direct feed. | One RoofRuler sample event stores raw payload, captures measurements/report URL, files report, and records audit row. |
| P1.9 | Keep disabled duplicate Google RoofRuler routing rule disabled unless dedup is added. | No duplicate Make executions for one RoofRuler report. |
| P1.10 | Build/confirm Jotform Jobsite Photo form payload. | Payload includes JobNimbus job number plus photo URLs; Worker returns `uploaded > 0` when Drive is configured. |
| P1.11 | Connect signed QuickBooks webhook. | Correct Intuit signature returns `{ok:true}`; bad signature returns 401; audit row records events. |
| P1.12 | Define ERPNext sync contract from D1 events. | Field map exists for Lead Envelope, Roofing Property, Roof Job, Evidence Asset, Measurement Report, Communication Event, and Automation Incident. |
| P1.13 | Create ERPNext/Frappe app skeleton only after P1.4 proves live intake. | App installs locally; DocTypes exist; no production lead path depends on it yet. |
| P1.14 | Define Hermes tool boundary. | Hermes has no direct free-form write to ERPNext, QuickBooks, Drive, JobNimbus, or customer channels; tool names and approval rules are listed. |
| P1.15 | Add owner exception view from D1. | Owner can see latest envelopes, dead letters, reconcile heartbeat, and failed file/webhook events. |
| P1.16 | Update SOPs for the proven path. | Staff knows where a lead appears, what alert means, how to recover dead letters, and when not to touch GHL. |

## ERPNext Phase 1 Contract

Create an `ironwrap_roofing` app after the bus is operating. The skeleton should
only consume bus facts; it should not become a second lead front door.

Minimum DocTypes:

- `Lead Envelope`
- `Roofing Property`
- `Roof Job`
- `Evidence Asset`
- `Measurement Report`
- `Material Takeoff`
- `Proposal Evidence Pack`
- `Communication Event`
- `Automation Incident`
- `Agent Run`

Minimum sync event:

```json
{
  "envelope_id": "bus id",
  "source": "website|phone|gbp|ad|referral|manual|measurement|photo|quickbooks",
  "brand": "ironwrap|iroof",
  "contact": {"name": "", "phone": "", "email": ""},
  "job_ref": {"address": "", "job_number": ""},
  "payload": {},
  "raw_key": "r2 key",
  "status": "received|pending_jn_push|pushed|duplicate|dead",
  "created_at": "iso timestamp"
}
```

## Hermes Phase 1 Contract

Hermes may read broad context and draft work. Hermes may write only through
approved tools.

Allowed first tools:

- `bus.search_envelopes`
- `bus.get_envelope`
- `bus.replay_dead_letter`
- `erp.create_draft_roof_job`
- `erp.attach_evidence_asset`
- `measurement.parse_sample`
- `comms.draft_customer_reply`
- `ops.write_incident_note`

Hard bans in Phase 1:

- No direct final price changes.
- No direct accounting mutation.
- No customer send without approval.
- No deleting evidence.
- No bypassing JobNimbus or ERPNext workflow gates.
- No silent mutation outside an audit row.

## Real Gates, Not Artificial Blockers

| Gate | Why it is real | How to clear |
|---|---|---|
| Cloudflare account mismatch | Current local Wrangler login cannot read the configured IronWrap account. | Log in/supply token for the configured account, then inventory resources. |
| JobNimbus shared key | Existing key was exposed during setup. | Rotate and install dedicated bus key. |
| Make/GHL live UI state | No Make/GHL connector is exposed in this session, and live scenario edits can break production. | Use Make UI/browser account, export scenario map, then disable only after replacement proof. |
| A2P/Engage | Automated SMS legally/operationally requires approval. | Submit/approve registration; until then use Gmail ack and owner alert. |
| QuickBooks status mirror | Signed webhook exists, but OAuth read path is not built. | Connect webhook now; build OAuth mirror only after invoice/payment status is needed in JobNimbus/ERPNext. |
| ERPNext runtime | No ERPNext app exists in repo. | Create skeleton after lead bus proof; keep bus as front door. |

## Definition Of Phase 1 Done

Phase 1 is done when:

- One real source event lands through `/ingest/website` and proves R2, D1,
  Gmail ack, JobNimbus push, and reconciliation.
- One measurement event lands through `/ingest/measurement` and proves raw
  storage, parsed values/report metadata, Drive filing, and audit logging.
- One field photo event lands through `/ingest/photo` and proves raw storage,
  Drive filing, and audit logging.
- One QuickBooks signed webhook event is captured and audited.
- GHL has no new front-door responsibility.
- Make scenarios are tagged keep/bridge/retire with owner confirmation.
- ERPNext app skeleton and Hermes tool boundary exist without owning live lead intake.
- Owner exception view shows latest envelopes, dead letters, and heartbeat.
