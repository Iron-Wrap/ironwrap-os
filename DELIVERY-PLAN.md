# IronWrap OS - End-to-End Delivery Plan

How we get from the **current Worker/Make/JobNimbus/GHL bridge stack** to the owned IronWrap OS path.
This is the execution overlay: sequencing, dependencies, owners, and exit gates. Chapter
references (e.g. `02 §Phase 3`) point at the spec for detail. No calendar estimates are used;
progress is tracked by proof gates, live account gates, and production evidence.
For the exhaustive first phase, use `final-spec-pack/18-phase-1-source-truth-and-build-contract.md`.

## Current status vs spec — snapshot (2026-07-08)

Honest two-layer view: **Built** = code/config present + unit-verified · **Operating** = running on live
traffic/data in production. The Worker bus is real and current in code/config: D1/R2/queues/cron, Gmail instant-ack,
Google Drive filing, temporary JobNimbus push, photo intake, measurement intake, owned estimator intake,
ERPNext bridge, and signed QuickBooks webhook capture are implemented. The operating gap is live-source cutover:
website/Make still must feed `/ingest/website`, the 3D estimator must POST to `/ingest/estimate`,
and A2P/Engage, compliance, QuickBooks Payments/webhook configuration, JobNimbus admin config,
Jotform live forms, and AssistAI remain account/owner gates. A 2026-07-08
Wrangler check found the local Cloudflare login is for Mindburn Labs, not the configured
IronWrap account, so live Cloudflare inventory/deploy work requires the IronWrap account token/login first.

| Phase | Built | Operating (live) |
|---|---|---|
| 0 · Foundations | 🟢 bus deployed (D1/R2/queues/cron/secrets); maintainer; Google decisions locked | 🟡 bus live; JobNimbus key rotation + A2P/Engage + compliance still owner gates |
| 1 · Lead + estimator spine | 🟢 spine, dedup, reconcile+heartbeat, dead-letter, brand-tagging, Gmail ack, `/ingest/estimate`, GHL rescue (103) — verified | 🔴 real lead feed not cut over; website/Make must POST to `/ingest/website`; estimator frontend must POST to `/ingest/estimate` |
| 2 · Messaging + bridge shrink | 🟡 Gmail email path built; CASL drafts | 🔴 needs A2P + temporary Engage or owned replacement proof; GHL/JN bridge routes retire only after owned replacements pass |
| 3 · Field · docs · proposals | 🟢 photo/measurement/QuickBooks/estimator endpoints + ERPNext estimate/takeoff/proposal proof — verified | 🟡 Google Drive creds exist; Jotform/RoofRuler/QB/estimator live hooks still need cutover; QB OAuth status mirror is intentionally deferred |
| 4 · Phone AI (AssistAI) | 🟡 eval framework doc | 🔴 not configured |
| 5 · QA · security · compliance · launch | 🟡 compliance drafts + QA matrix (`docs/QA-TEST-MATRIX.md`) | 🔴 not started; keys not rotated; no sign-off |

> The bus, the Phase-3 endpoints, and the email/SMS code are all real — but a roofing lead has **not yet
> traveled the owned path end-to-end in production.** Closing that gap is credentials + careful (UI, not
> API) integration, not more code. The credential-by-credential unlock order is in `docs/ACTIVATION-CHECKLIST.md`.

## From → To

| Area | Today (experimental) | Target (spec final) |
|---|---|---|
| Lead front door | Website/FB → **GHL** via ~16 experimental Make scenarios | All sources → **Workers bus → owned D1/R2 FIRST → ERPNext/IronWrap OS**, with JobNimbus/GHL only as temporary consumers |
| System of record | None (GHL holds it) | **Cloudflare D1 + R2** (owned), ERPNext/IronWrap OS as operating truth; JobNimbus/GHL = bridge consumers |
| CRM / job truth | GHL + partial JobNimbus | **IronWrap OS / ERPNext** as target; JobNimbus bridges until replaced |
| Instant response | none | **Instant-ack / MCTB <60s, 24/7** |
| SMS / email | Google Workspace live for email; SMS not live | **Engage SMS** (post-A2P) + **Google Workspace brand mailboxes** |
| Storage | OneDrive (GHL-keyed folders) | **Google Drive** (Google Workspace, supersedes OneDrive, 2026-07-01), JobNimbus-job-number-keyed |
| Accounting/payments | BookIPI/Stripe/MileIQ legacy | **QuickBooks** (catalog + invoices + POs + mileage) + **QuickBooks Payments**; BookIPI/Stripe/MileIQ retire |
| Measurements | Make RoofRuler intake (AI Extract) | RoofRuler/AppliCad → toMarkdown → Mistral fallback, on the spine |
| Phone AI | none | **AssistAI** (eval-gated) → managed Retell → voicemail floor |
| Brands | mixed | **IronWrap + iRoof Alberta**, brand-tagged end to end |
| GHL | live hub | **temporary bridge only**; retire route-by-route after owned replacement proof |

## Sequencing principles

1. **A2P is an account gate** — it gates Engage SMS and cannot be solved in repo code. Everything else routes around it.
2. **Instant-ack ships through the interim channel** via email + owner alert; the prospect-SMS leg switches on at A2P approval.
3. **Owned-store-first is the keystone** — stand up D1/R2 + the bus before repointing any lead source.
4. **Migrate, don't duplicate subscriptions** — reuse what works only as a bridge, move proof into the owned bus/ERPNext spine, then retire GHL/JN pieces route-by-route.
5. **Managed to prove, own-operated to scale.** Start on managed hosting to prove the core, then move to IronWrap-operated infra as resale tenants onboard; owning and operating the code is the product strategy (see Gates).
6. **Compliance gates are hard launch-blockers**, not paperwork (`09`).

## Phase overview

| # | Phase | Exit gate | Depends on |
|---|---|---|---|
| 0 | Foundations & unblock | Bus deployed; account gates identified; owners named | — |
| 1 | Lead + estimator spine | Every lead/estimate -> D1/R2 -> ERPNext; bridge push where still needed; reconcile green | 0 |
| 2 | Messaging + bridge shrink | Customer messaging works with consent; GHL/JN automations retired where owned proof exists | 1 + A2P or owned messaging proof |
| 3 | Field · documents · proposals | Jotform photos, RoofRuler, proposals, QuickBooks on the spine | 1 |
| 4 | Phone AI (gated) | AssistAI passes written eval (>=85%, 0 catastrophic) | 2 |
| 5 | QA · security · launch | Full QA + compliance gate + owner sign-off | 1-4 |

## Phases in detail

### Phase 0 — Foundations & unblock
- **Decide (done):** build/operate owner; Google Workspace/Drive; two-brand handling.
- **A2P 10DLC + Canadian carrier registration** (`02 §0.5`, `09`) is an external account gate.
- **Provision & own the Twilio business DID** (portable; AssistAI/Engage later).
- **Rotate the JobNimbus API key** (it was shared in chat) and issue a dedicated bus key.
- **Deploy the owned data layer / bus** (`workers-bus/`): `wrangler d1/r2/queues create` → migrate → `wrangler secret put` → `deploy`. Decide **hybrid**: Workers bus for the heavy lifting + keep the Make Core seat for connectors/observability.
- **Verify website form post destinations** (both brand domains) so they can be repointed.
- *Exit:* bus deployed + healthy; A2P submitted (tracking); DID owned; owners named.

### Phase 1 — Lead + estimator spine
- Execute `final-spec-pack/18-phase-1-source-truth-and-build-contract.md` as the exhaustive source-truth/build contract.
- Repoint one real website/GBP/manual/Make lead source → bus → **D1/R2 first** → ERPNext/IronWrap OS, with JobNimbus push only where still needed, and with **dedup, dead-letter, retry sweep, daily reconciliation + heartbeat, partial-write repair** (`01`,`04 §WF1/§WF8`,`06`).
- Repoint the 3D estimator/configurator submit/save action → `POST /ingest/estimate`. This creates the owned raw record, D1 envelope, ERPNext Roof Job, and review-gated Instant Estimate Session without GHL/JN dependency.
- **Instant-ack / MCTB interim** live: prospect **email** + owner alert, off the owned-store write (`04 §WF7`).
- **Brand tagging** on the envelope (`03`).
- **GHL/JN cutover rule:** the bulk GHL rescue is complete; freeze new keeper work in GHL/JN, keep only bridge/retire actions, and disable old routes after replacement proof.
- **ERPNext/Hermes first contract:** define ERPNext sync objects and Hermes tool boundary, but keep live intake fronted by the Worker until the first source is operating.
- *Exit:* every test lead and estimator session (both brands) lands in D1/R2 + ERPNext, bridge-pushes only where still needed, with email ack/reconcile green; GHL no longer owns the front door; Hermes cannot mutate live customer/job truth outside approved tools.

### Phase 2 — Messaging + bridge shrink
- A2P approved → **Engage 2-way SMS** live → MCTB **prospect-SMS leg** switches on.
- **Google Workspace brand-mailbox email** (SPF/DKIM/DMARC + bounce monitoring) for nurture/review; JN native email stays off. Microsoft 365 mirrors only during migration.
- **CASL consent ledger** live in JobNimbus + dual-written (`09`); review-request flow with stop conditions.
- **Retire bridges by proof:** decommission/disable experimental GHL scenarios and any JobNimbus marketing/AI modules only after owned replacement proof exists.
- *Exit:* customer messaging round-trips; review/nurture send via approved channels; no GHL/JN module remains as a keeper; consent enforced.

### Phase 3 — Field · documents · proposals
- **Jotform "Jobsite Photo"** form live (device GPS at submit, offline) → bus → **Google Drive** job folder + JN (`02 §2B`; supersedes OneDrive, see Gates #3).
- **RoofRuler/AppliCad intake** uses the Worker-owned `POST /ingest/measurement` path; Make can bridge existing RoofRuler events into that route until direct intake is proven. Deterministic extraction comes before `toMarkdown()` and Mistral-only hard cases (`07`).
- **Google Drive folder automation** keyed by **JobNimbus job number** (migrate from GHL-lead-number keying); **migrate historical job files from OneDrive** during the same cutover (some contact/job/file mapping needs manual fixing — owner flagged this).
- **Proposals:** JobNimbus native e-sign / HTML+PDF; DocuSeal remains a benched escape hatch only (`07`).
- **Owned estimator/proposal path:** `/ingest/estimate` captures configurator totals, project links, selected services, and material choices as a review-gated ERPNext Instant Estimate Session; Hermes/MCP then drafts Material Takeoff and Proposal Evidence Pack rows for human approval.
- **QuickBooks** as catalog + invoice + PO master; **QuickBooks Payments** for invoice payments (`04 §WF4`); BookIPI/Stripe/MileIQ retire.
- **Business-process scenarios** (Proposal Sent → Contract Signed → Deposit Paid → Job Started → Completion): build in this order once the lead spine is capturing live traffic — full detail in `final-spec-pack/04` Workflows 3/3C/5/5C/6.
- *Exit:* a job runs measurements → proposal → deposit with photos/folders auto-filed; no manual retyping.

### Phase 4 — Phone AI
- Configure **AssistAI**; run the **written scored eval** (15–20 calls; ≥85% capture+routing, zero catastrophic) (`05`). Voicemail floor always on; hard minute cap/budget alert.
- Managed **Retell** only if AssistAI fails the gate. (4-vendor DIY stack stays killed.)
- *Exit:* eval passed + Ilya approves production call behavior; MCTB confirmed on every missed path.

### Phase 5 — QA · security · launch
- **End-to-end QA** across every path + both brands (`10` test matrix): web/quote/contact/service leads, duplicate, file upload, missed call, dual-write repair, interim+SMS ack, reconciliation, RoofRuler, proposal, deposit.
- **Security hardening** (`09 §Final`): rotate all creds, MFA, named users, least-privilege, secrets manager, vendor register, field allowlists.
- **Compliance go-live gate** (`09`): privacy notice (names cross-border processors incl. Google, temporary Microsoft mirror, Cloudflare, Make, Mistral), CASL + unsubscribe tested, A2P approved, DNCL policy, call-recording notice, retention schedule, breach playbook, signed DPAs/ZDR.
- **Owner sign-off** (`11`).
- *Exit:* "What Counts As Shipped" (`README`) fully satisfied.

## Proof-Gate Execution Map

| Gate | Proof |
|---|---|
| Lead spine | One real lead source posts to `/ingest/website`; D1/R2, ERPNext, temporary bridge push if needed, Gmail ack, and reconcile all prove it. |
| Estimator spine | 3D estimator posts to `/ingest/estimate`; raw R2, D1 envelope, ERPNext Roof Job, and Instant Estimate Session prove it without JobNimbus/GHL. |
| Measurement spine | RoofRuler/AppliCad feed posts to `/ingest/measurement`; raw body, measurement values, Drive filing, and audit row prove it. |
| Field photo/voice spine | Jotform posts to `/ingest/photo`; raw body, Drive folder, uploaded files, `Voice Note` evidence for audio, and audit row prove it. |
| Hermes agent layer | `node tools/validate-hermes-config.mjs` proves all 8 agent roles map only to real MCP tools and that no approved-write is granted without its `dry_run` pair; `hermes/agents/` + `hermes/skills/` codify the roles and procedures. |
| Closeout spine | Completion/Warranty/Review-request and Communication-event DocTypes plus their review-gated MCP tools; review requests are never auto-sent, comms enforce CASL consent + quiet hours and are record-only. |
| QuickBooks webhook | Signed webhook returns `{ ok: true }`; bad signature returns 401; audit row exists. |
| Engage SMS | A2P approved; opt-in SMS sends/receives; STOP honored. |
| AssistAI | Eval in `docs/ASSISTAI-EVAL.md` passes with >=85% capture+routing and zero catastrophic failures. |
| Launch | `docs/QA-TEST-MATRIX.md` P0/P1 cases pass; compliance and owner signoff are complete. |

## Current → target migration map (experimental Make → disposition)

| Existing Make scenario(s) | Disposition |
|---|---|
| GHL → JobNimbus Import / Bulk Import | **Fix `record_type` → run once (rescue) → retire** |
| GHL webform lead | **Replace** with bus website intake (D1/R2-first) |
| JobNimbus/GHL marketing AI or estimator-like modules | **Do not expand**; replace with owned estimator/Hermes proof as each slice passes |
| GHL Lead#/Job# → OneDrive folder (create/rename/move) | **Retire/re-key to JobNimbus job number + Google Drive** on the spine |
| RoofRuler Report Processing (AI Extract + OneDrive) | **Bridge/migrate to Worker**: Worker owns `/ingest/measurement`; current Make-mailhook may forward there until direct intake is proven |
| GHL Opportunity file uploads / "Before" / Signed-off→DONE | **Re-trigger from JobNimbus stages** |
| Jotform Completion Form (inactive) | **Activate** on the spine (Phase 3) |
| Facebook Lead Ads (inactive) | Re-enable later as a bus source (gated with paid ads) |

## Gates & decisions needed from the owner

1. ✅ **Build/operate owner, DECIDED: Ilia (owner) via Claude Code** (CC = the engineering/ops capacity). IronWrap builds and operates this platform as an owned product and resells it to other contractors, so owning the code is the strategy, not a liability.
2. ✅ **Two live actions done:** JobNimbus write path live-tested + gate flipped to `true`; Make bulk-import fixed (`record_type`→`Customer`, `status`→`New`, dropped invalid `source_name`) — ready to run the one-time rescue.
3. ✅ **Standing decisions confirmed:** two brands. **Superseded 2026-07-01 (owner-directed, see
   `final-spec-pack/00`):** storage moves OneDrive → **Google Drive**; email moves Microsoft
   365/Gmail-split → **Google Workspace** (both brands, on a new Workspace built on the unassigned
   IronWrap Workspace); SMS reconfirmed as **JobNimbus Engage** (Twilio stays
   DID-only, no change); accounting refined to **QuickBooks** (catalog + invoices + POs + mileage)
   with **QuickBooks Payments**, retiring BookIPI/Stripe/MileIQ.
4. ✅ **Five business-process scenarios locked** (Proposal Sent → Contract Signed → Deposit Paid →
   Job Started → Completion): full SOP in `final-spec-pack/04` Workflows 3/3C/5/5C/6. Two items
   still need owner/real-world confirmation: whether Engage can trigger from pipeline automations
   (vs. manual-template-only), and the actual WCB Alberta filing mechanism (no API assumed yet).
5. Phase-gated buys (default deferred): AssistAI minutes, managed Retell (only on eval fail), Mistral OCR (hard docs only), CallRail (only with paid ads), Renoworks, Paradigm. DocuSeal stays the e-sign fallback bench (JobNimbus native e-sign is still first choice for Proposal Sent).
6. Compliance artifacts (lawyer-reviewed where noted in `09`).

## Risk register

| Risk | Mitigation |
|---|---|
| A2P approval slips | Interim email/owner-alert ack runs while SMS waits for approval |
| Operating and reselling an owned platform | IronWrap builds, operates, and resells this platform as a product, so engineering/ops is a core capability, not an outsourced risk. Control it with the operations runbook (`docs/OPERATIONS-RUNBOOK.md`), per-tenant isolation, config/CI validators, and a defined tenant support/SLA model |
| GHL-rescue duplicates in JobNimbus | Idempotency via `external_id`/`bus:` tag; verify a sample before bulk run |
| Dual-write partial failure | Already designed out: single owned-store write + retried JN push + sweep (`06`) |
| Two-brand sender/deliverability | Per-brand SPF/DKIM/DMARC; brand on the envelope drives sender/GBP/review |
| Compliance miss at launch | Hard go-live gate (`09`); nothing texts/calls before A2P + consent + notices |

## Current Next Actions

1. ✅ Maintainer named (Ilia via Claude Code). ✅ JobNimbus write path validated + gate on. ✅ Google Workspace/Drive path built.
2. **Switch/refresh Cloudflare auth for the IronWrap account** so `wrangler d1 list` and `wrangler queues list` can read the configured account.
3. **Wire one real lead source to `/ingest/website`** — website server-side forward or one Make UI HTTP module.
4. **Wire the 3D estimator submit/save action to `/ingest/estimate`** with `INGEST_TOKEN` kept server-side.
5. **Submit A2P 10DLC + Canadian carrier registration** if JobNimbus Engage remains the temporary SMS bridge.
6. **Rotate the JobNimbus API key** (it was shared in chat) + issue a dedicated bridge key.
7. Connect Jotform photo intake, RoofRuler measurement bridge, and QuickBooks webhook after the first live lead path is proven.
8. Retire/disable one-time GHL rescue and old routes only after replacement proof exists.

## Definition of done
The plan is delivered when `final-spec-pack/README.md` "What Counts As Shipped" is fully true:
all sources land via the bus, dual-written with instant-ack and green reconciliation; IronWrap OS
owns job truth while JobNimbus/GHL remain only temporary bridges; folders, proposals, deposits, materials, completion, invoice, review, and
field photos work end to end (both brands); AssistAI passes its gate; A2P/consent/compliance
gates approved; GHL/JN keeper routes retired; security hardening complete.
