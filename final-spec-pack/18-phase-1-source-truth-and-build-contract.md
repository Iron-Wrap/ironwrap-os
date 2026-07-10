# 18 - Phase 1 Source Truth And Build Contract

Status: repository implementation checkpoint; live Phase 1 acceptance is open.

This file is the authoritative first-phase contract for turning the current
IronWrap stack into the Frappe/Hermes end product. It starts from what exists,
not from a clean-room plan. Legacy `erpnext-*` names refer to the plain Frappe
site; the ERPNext application is removed and forbidden.

Repository validation, deployment evidence, runtime health, and account/admin
truth are distinct. This contract records implemented source capability and the
remaining live acceptance gates without treating one as proof of another.

## Evidence Reviewed

Repository evidence rechecked on 2026-07-10; external-account facts below remain
last-known evidence until the named admin revalidates them:

- Task branch: `codex/hermes-end-product` is published as draft PR [#8](https://github.com/ironwrap/ironwrap-ops/pull/8); CI/merge truth remains separate from repository proof.
- Worker code: `workers-bus/src/index.ts`, `photos.ts`, `measurements.ts`,
  `quickbooks.ts`, `google.ts`, `jobnimbus.ts`, `store.ts`, and D1 migration.
- Cloudflare config: `workers-bus/wrangler.jsonc`.
- Local secret name inventory only: `ACCESS.env`, `workers-bus/.dev.vars`,
  `workers-bus/.dev.vars.example`. Secret values were not printed or copied.
- Samples: `samples/` has 29 files: 28 PDFs and 1 AppliCad XML.
- Generated/provenance folders: `task1-spec/assets/` has 27 source artifacts;
  `output/` has 24 generated/audit artifacts.
- AppliCad proof: `node tools/applicad-xml-proof.mjs --check` passes.
- Frappe contract: exactly 46 DocTypes (39 top-level plus seven child tables),
  shared business validation, installed role matrix, packaging, and pure Python tests.
- Worker operations: separate `/health` and `/ready`, authenticated
  `/admin/status`, and approved/audited targeted replay.
- Hermes/MCP: eight role profiles, eleven skills, 118 implemented source tools (111 Frappe: 69 reads,
  21 dry-runs, 21 approved writes; plus 7 bus), runtime role filtering, and required dry-run
  pairs for every granted approved write.
- Deployment/recovery: exact runtime lock, digest-pinned Frappe-only image build,
  contract-validated local production configuration, encrypted/verified Frappe and D1 recovery protocols,
  and local isolated verification. Live D1/R2/Frappe drill evidence remains open.
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
| Field capture / Jotform | Owned Field Companion PWA/BFF is locally implemented for offline photo, voice, blocker, and GPS check-ins with verified replay; connected Jotform account remains a bridge. | Complete real-device, weak-signal, background-kill, storage, accessibility, and live-backend proof; Jotform may bridge `POST /ingest/photo` meanwhile. |
| QuickBooks | QBO account exists under `info@ironwrapexteriors.com`; Worker signed webhook receiver exists. | Connect `QB_WEBHOOK_TOKEN` and Intuit webhook; defer OAuth read/status mirror until needed. |
| SMS/phone | Worker does not send SMS. JobNimbus Engage is the SMS path after A2P approval. Twilio secrets exist as names only, but Worker must not use Twilio SMS. | Configure Engage/A2P; own portable DID only if AssistAI/voice routing needs it. |
| Frappe/Hermes | Proprietary Frappe-only app, 46 DocTypes, server policy/RBAC, atomic safety acknowledgement RPC, a standard Workspace plus read-only exception-first Control Center, two hardened MCP servers, eight runtime-filtered Hermes roles, and pinned deploy/recovery source are present. | Keep Worker/D1/R2 as front door; install on plain Frappe, role-test the cockpit and signed approval broker, and prove live reads plus one approved audited write. |

## Worker Surface That Already Exists

| Method | Path | Current behavior |
|---|---|---|
| `GET` | `/health` | Liveness JSON. |
| `GET` | `/ready` | D1 schema query plus R2/Queue binding and required-config presence; returns 503 on failure and does not prove downstream network reachability. |
| `POST` | `/ingest/:source` | Bearer-auth lead intake for allowed source names; raw to R2, envelope to D1, dedup, Gmail instant ack, enqueue JobNimbus push. |
| `POST` | `/ingest/photo` | Bearer-auth Jotform/photo intake; raw to R2, requires job number and photo URLs, files to Google Drive when configured, writes audit rows. |
| `POST` | `/ingest/measurement` | Bearer-auth RoofRuler/AppliCad metadata/report intake; raw to R2, requires job number, captures structured measurements, files report to Google Drive when configured. |
| `POST` | `/webhook/quickbooks` | Verifies Intuit `intuit-signature`, stores raw payload, records entity events; JobNimbus status mirror waits for QB OAuth. |
| `POST` | `/admin/reconcile` | Admin-auth source-vs-landed reconciliation and heartbeat. |
| `POST` | `/admin/source-count` | Admin-auth independent count input for reconciliation. |
| `GET` | `/admin/status` | Admin-auth heartbeat, queue/dead-letter, Frappe error, audit failure, and QB receipt view. |
| `POST` | `/admin/replay` | Admin-auth approved replay. Envelope-scoped by default with compare-and-set; requires `run_id`, approver, and reason. Bulk requires exact hard confirmation. |
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
-> Frappe Lead Envelope / Roofing Customer / Property / Roof Job / gates
-> reconciliation heartbeat
-> readiness and incident/replay evidence
```

Frappe and Hermes are implemented consumers/operators, never the first raw-event
write. The Worker/D1/R2 path remains the source spine. Do not move intake in front
of it or treat Frappe/Hermes availability as a prerequisite for raw capture.

## Exhaustive Phase 1 Work Items

| ID | Work item | Repository state | Acceptance proof |
| --- | --- | --- | --- |
| P1.1 | Switch/refresh Cloudflare auth for IronWrap account `7ee5775bc1ba46f05c5a65235b60e939`. | External open | `wrangler whoami`, D1, R2, Queue, and Worker inventory succeed in the intended account. |
| P1.2 | Revalidate deployed Worker, bindings, cron, migrations, and secret names. | External open | Read-only inventory plus `/ready` and `/admin/status`; no secret values copied. |
| P1.3 | Rotate shared JobNimbus API key and install a dedicated bus key. | External open | Rotation evidence and one non-duplicate bridge push. |
| P1.4 | Feed one real website or Make lead into `/ingest/website`. | Route/test implemented; live open | R2 raw, D1 envelope/audit, Frappe mirror, Gmail ack/alert, and temporary JobNimbus tag exist. |
| P1.5 | Add independent source count and reconcile. | Route/test implemented; live open | Source-count plus reconcile shows no unexplained gap and `/admin/status` shows a fresh heartbeat. |
| P1.6 | Freeze new GHL work. | Repository policy recorded; admin confirmation open | Make/GHL inventory states no new keeper mutations. |
| P1.7 | Retire/park rescue scenarios after owner confirmation. | External open | Exported scenario map and owner-approved disable/archive evidence. |
| P1.8 | Bridge RoofRuler scenario `4754599` to `/ingest/measurement` or replace it. | Ingest/sample proof implemented; source open | One real report stores raw, reviewed values, Drive file, Frappe report/evidence, and audit. |
| P1.9 | Keep duplicate Google RoofRuler routing disabled unless dedup is proven. | External open | One report creates one canonical event/execution. |
| P1.10 | Validate owned Field Companion PWA plus Jotform bridge. | PWA/BFF local implementation green; device/live backend open | Job number, photos, voice note, Drive/R2, Evidence Item, Field Check-in, offline recovery, and real-device verification are proven. |
| P1.11 | Connect signed QuickBooks webhook. | Signature/receipt tests implemented; admin open | Valid receipt accepted/idempotent, invalid signature rejected, status visible. |
| P1.12 | Implement D1-to-Frappe consumer contract. | Repository implemented | Idempotent Lead Envelope/Customer/Property/Job/session/measurement/evidence/gate mirrors pass fixture and live proof. |
| P1.13 | Implement proprietary Frappe-only operating core. | Repository implemented; site proof open | Exactly 46 DocTypes, policy/RBAC and atomic safety tests, plain-Frappe install/migrate, no `erpnext`. |
| P1.14 | Implement Hermes tool boundary. | Repository implemented; runtime proof open | Eight roles and 118 tools validate; runtime role/actor scope, verified proof, preview receipt, signed approval, single-claim write, and audit cannot be skipped. |
| P1.15 | Expose owner exception truth. | Frappe Control Center built; React owner cockpit open | `/admin/status`, MCP, and Control Center show readiness, heartbeat, dead/stuck/Frappe/replay/audit/QB facts; live role testing and React cockpit remain open. |
| P1.16 | Update recovery/launch SOPs and train operators. | Repository/local verification implemented; acceptance open | Operator completes status diagnosis, targeted replay, incident record, exact Frappe/D1 restore, and GHL no-touch drill on isolated/live-shaped infrastructure. |

## Frappe Phase 1 Contract

`ironwrap_roofing` is implemented as a proprietary consumer/operating core on
plain Frappe. It must never become the raw intake front door and must never install
the ERPNext application.

The exact implemented contract is 39 top-level DocTypes:

- `Automation Incident`, `Communication Event`, `Completion Packet`, `Customer Quote`
- `Evidence Item`, `Field Check-in`, `Hermes Run`, `Instant Estimate Session`
- `Lead Envelope`, `Market Watch Item`, `Material Takeoff`, `Measurement Report`
- `Option Package`, `Payment Milestone`, `Price Book Rule`, `Production Gate State`
- `Proposal Evidence Pack`, `Review Request`, `Roof Area`, `Roof Job`
- `Roofing Customer`, `Roofing Property`, `Scope Clause`, `Supplier Order`
- `Supplier Profile`, `Supplier Quote`, `Visual Property Model`, `Warranty Packet`
- `White-Label Tenant`

- `Crew Profile`, `Job Assignment`, `Change Order`, `Safety Plan`,
  `Job Compliance Record`, `Communication Consent`, `Customer Decision`,
  `Contract Acceptance`, `Integration Reconciliation`, and `Tenant Export Run`

The seven child DocTypes are `Material Takeoff Item`, `Measurement Value`,
`Supplier Order Item`, `Supplier Quote Item`, `Crew Member`, `Change Order Item`,
and `Safety Acknowledgement`.

Every top-level controller delegates to shared business validation. The site
installs eight least-privilege IronWrap roles; delete is disabled; only owned
DocTypes and Frappe core `User` may be Link targets.

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

Implemented bus tools:

- `get_bus_readiness`, `get_operational_status`
- `list_recent_envelopes`, `get_envelope`, `list_dead_letters`
- `dry_run_replay`, `request_replay` (one envelope only)

The compatibility-named `erpnext-roofing-mcp` implements 111 Frappe tools: 69 bounded
reads plus 21 deterministic dry-run/request families for gates, takeoff, supplier,
proposal, assignment, change order, safety, compliance, consent, decision, reconciliation,
export, closeout, comms, and market watch. With seven bus tools, the inventory is 118.
`tools/validate-hermes-config.mjs` proves the full inventory against eight role allowlists,
runtime filtering, and the dry-run pair for every granted request tool.

Every Frappe request requires an explicit write flag, canonical role/actor, a current
server-issued dry-run receipt, an independently signed approval receipt bound to the configured
approver and site, and stable `run_id`. Creating the Hermes Run is the one mutation claim:
completed exact retries return stored truth while in-flight, failed, and audit-failed claims
never re-execute. A post-mutation audit failure is terminal `Audit Failed`, linked to
incident/result evidence; it is never reported as a normal success.

Hard bans in Phase 1:

- No direct final price changes.
- No direct accounting mutation.
- No customer send without approval.
- No deleting evidence.
- No bypassing Frappe workflow/evidence gates.
- No bulk replay through Hermes.
- No silent mutation outside an audit row.

## Real Gates, Not Artificial Blockers

| Gate | Why it is real | How to clear |
|---|---|---|
| Cloudflare account mismatch | Current local Wrangler login cannot read the configured IronWrap account. | Log in/supply token for the configured account, then inventory resources. |
| JobNimbus shared key | Existing key was exposed during setup. | Rotate and install dedicated bus key. |
| Make/GHL live UI state | No Make/GHL connector is exposed in this session, and live scenario edits can break production. | Use Make UI/browser account, export scenario map, then disable only after replacement proof. |
| A2P/Engage | Automated SMS legally/operationally requires approval. | Submit/approve registration; until then use Gmail ack and owner alert. |
| QuickBooks status mirror | Signed webhook/receipt guard exists, but admin connection and OAuth reads are external. | Connect/replay a signed webhook, prove receipt status, then add reads only where required; QuickBooks remains truth. |
| Git remote/CI publication | Repository work cannot be treated as published without remote authority and required checks. | Push the task branch, open/update PR, and pass protected CI. |
| Frappe/Hermes deployment | Source is production-candidate but no host/site/runtime proof is implied. | Build the locked image, install/migrate plain Frappe, deploy locked Hermes, and archive smoke evidence. |
| Recovery proof | Repository recovery protocols and local isolated verification are proven, not live recovery. | Complete exact-prefix R2 retrieval, non-production D1 restore, Frappe restore, row/file parity, retention, and denied-delete evidence. |
| Operator UX | The `IronWrap OS` Workspace and permission-scoped `IronWrap Control Center` surface blocked gates, approvals, incidents, stale jobs, pipeline, job runway, evidence, and public bus readiness without mutating records. | Install and role-test it on the target Frappe site, including empty/error/readiness states and source-record navigation; keep standard lists/forms as fallback. |

## Definition Of Phase 1 Done

Phase 1 is done when:

- One real source event lands through `/ingest/website` and proves R2, D1,
  Gmail ack, Frappe mirror, temporary JobNimbus push, and reconciliation.
- One measurement event lands through `/ingest/measurement` and proves raw
  storage, parsed values/report metadata, Drive filing, and audit logging.
- One field photo event lands through `/ingest/photo` and proves raw storage,
  Drive filing, and audit logging.
- One QuickBooks signed webhook event is captured and audited.
- GHL has no new front-door responsibility.
- Make scenarios are tagged keep/bridge/retire with owner confirmation.
- Plain-Frappe app installs with all 46 DocTypes and role/policy/atomic-safety negative tests.
- `/ready` passes and `/admin/status` shows fresh heartbeat with no unexplained
  dead/stuck/Frappe/audit failure.
- Read-only Hermes answers from live truth with zero writes; one approved Frappe
  mutation has complete, idempotent `Hermes Run` evidence.
- Owner exception truth shows readiness, recent envelopes, dead letters, heartbeat,
  Frappe errors, audit failures, and QB receipt freshness; UI absence is explicitly accepted
  or the cockpit slice is complete.
- One targeted replay and one encrypted isolated restore drill are proven.
