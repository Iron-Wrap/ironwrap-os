# IronWrap OS Product Layer: Mobile-First North Star Plan

Status: repository implementation checkpoint, 2026-07-12. Builds on the verified competitive position in
`docs/MARKET-DEFENSE-SCORECARD.md` and the audited substrate below. This is the plan for the
layer users actually touch: mobile-first, crew-proof, and designed to subjectively beat
JobNimbus, GoHighLevel, Roofr, and AccuLynx screen for screen.

Fresh demand evidence, current-product verification, and the resulting acceptance contracts are
maintained in `docs/ROOFING-DEMAND-EVIDENCE.md`. Primary demand scoring uses 2025-2026
owner/operator discussions, verified reviews, and paid roles; vendor pages verify current
capability only.

## 1. Audit: what the substrate provides today (verified 2026-07-11)

| Layer | State |
| --- | --- |
| Frappe operating core | 48 DocTypes (40 top + 8 child), the blueprint's full record model, contract-validated |
| Worker bus | Intake/dedup/dead-letter/reconcile, geometry-verified measurements, `/health` `/ready` `/admin/status` |
| Hermes agent layer | 8 runtime-filtered roles, 139 MCP tools, receipt-bound approved-write contract |
| Deploy/ops | Contract-validated production configuration, pinned runtime lock, encrypted Frappe/D1 recovery, launch runbook |
| Competitive truth | 10 exceeded / 7 covered / 19 open, adversarially audited |
| Product UI | P0 shell/session/magic-link/outbox, P1 Field Companion/BFF, QR device proof/revocation, P2 Owner Now plus governed `/approvals` and contextual lead-triage preparation, and P3 Sales, Measurement Workbench, a restricted insurance-evidence rail, and the isolated Draft Revision approval vertical are locally implemented and contract-tested. Owner Now separates work-stops, operating exceptions, lead attention, and a redacted read-only measurement-intake exception queue; the inbox renders only allowlisted before/patch/outcome DTOs and server-granted decision capability; Sales joins narrowly allowlisted office lead, estimate, quote, and communication-record context; the workbench recomputes retained source geometry in the Worker and shows bounded measurement, takeoff, quote, proposal-record, clause lineage, and derived supplement proof state. The contextual triage and revision entries use exact server-granted capability, strict browser DTOs, stable idempotency, and reconcile-only execution uncertainty. None claims delivery, field verification, human follow-up, carrier coverage, or a carrier decision. Local browser/mocked-visual proof is not live Worker/broker/Frappe/device/operator proof; those gates and P4-P5 remain open, with Frappe Control Center as the truthful fallback. |

Every "their UX beats ours" row in the scorecard (boards, mobile app, omnichannel inbox,
homeowner widget) lands in this one missing layer. That makes the UI the highest-leverage
build remaining and the place the "subjectively outperforms" claim is won or lost.

## 2. Design philosophy: evidence-first, thumb-first, zero-training

The signature move nobody else has: the **Proof Stream**. Every job screen is organized
around the evidence chain (lead, measurement, quote, gates, field proof, closeout, warranty)
rendered as the job's visual spine. Competitors show activity logs; we show proof.
The second signature: **Gates as physical locks**. Production state is a row of lock chips;
a blocked gate visibly blocks the schedule button. The user never wonders why work can't start.

### The ten dumb-proofing laws (enforced in every design review)

1. One primary action per screen; it lives in the bottom thumb zone.
2. Touch targets: 56px minimum, 64px on field surfaces (gloves).
3. Camera and voice come before keyboard in the field; typing is the last resort.
4. Anything that can be a choice, scan, or photo is never a text field.
5. Offline is not an error: every field action queues in a local outbox with a visible
   sync badge, and replays through the bus's existing idempotent routes.
6. Undo everywhere, confirmation dialogs never: destructive actions are soft with a 10s undo.
7. Every empty state teaches the single next action.
8. Errors speak trade language and say what to do next; no codes, no jargon.
9. Status is always color + icon + word (sunlight and colorblind safe, WCAG AA+).
10. Any screen answers in three seconds: where am I, what is blocked, what is next.

### Design system

- Tokens: 8pt spacing grid, 4-step radius scale, 3-level elevation, motion 150-250ms with
  standard easing, reduced-motion respected.
- Type: Inter (UI) with tabular numerals for money and measurements; 16px base, 1.25 scale.
- Color: high-contrast light-first (sunlight legibility on roofs), auto dark; gate semantics
  (blocked/ready/waived/done) as the core palette, AA+ contrast everywhere.
- Components: shadcn/ui base layer, then the IronWrap tier: GateChip, ProofCard, EvidenceTile,
  MoneyRow, SyncBadge, BigAction, StepperForm, VoiceNoteButton, PhotoGrid.
- White-label: all tokens resolve from `config/tenants/<tenant>.json` (brand colors, logo,
  domains) so a second tenant is a config change, not a redesign.

## 3. Architecture

```text
app/ (implemented monorepo dir)
  Vite 8 + React 19.2 + TypeScript + Tailwind 4.3 + shadcn/ui
  TanStack Router v1 + Query v5; vite-plugin-pwa; IndexedDB outbox
  shipped as ONE Cloudflare Worker with static assets:
    [assets] not_found_handling = "single-page-application"
    run_worker_first = ["/api/*"]  (the BFF routes)
workers-bus
  gains /api/* BFF routes: session auth, per-surface read models
  (aggregated Frappe reads), writes ONLY via the existing audited paths
```

Stack currency was verified against primary sources on 2026-07-10: Cloudflare's own
guidance is to start new projects on Workers static assets, not Pages (all new platform
investment is Workers-only), which collapses SPA + BFF into one deployment. Vite 8 runs
the Rolldown bundler and needs Node 20.19+/22.12+; vite-plugin-pwa must pass a build on
Vite 8 at scaffold time (temporary fallback: pin Vite 7). Workbox is maintenance-only, so
it is consumed ONLY through vite-plugin-pwa, with Serwist (@serwist/vite) as the
documented swap-in. TypeScript posture: 6.x as the repo default (tooling compatibility),
TS 7 (native compiler) for type-check runs. shadcn current defaults apply: new-york
style, OKLCH tokens, sonner for toasts.

- **PWA, not native.** One codebase, installable on iOS/Android, offline-capable, zero app
  store friction, and the crew installs it by scanning a QR. Native is a later option, not an
  assumption: current JobNimbus and CompanyCam materials claim offline support, so the PWA earns
  superiority only after real-device weak-signal, backgrounding, quota, and recovery proof.
- **Worker as BFF.** The app never talks to Frappe directly. The Worker aggregates reads
  into screen-shaped payloads (one request per screen), enforces auth, and reuses the
  existing idempotent, audited write paths. The Hermes mutation contract stays intact:
  nothing in the UI can bypass dry-run/approval for agent actions.
- **Auth, dumb-proofed.** Office: email magic link. Crew: QR device pairing issued from the
  office (device-bound token, role-scoped to Field Companion); nobody types a password on a
  roof. On iOS, install + push opt-in + pairing happen as ONE supervised provisioning ritual
  at the office (Safari's share-sheet install and the push permission tap are manual by
  design). Customer portal: signed per-job links.
  The QR pairing flow, device-bound field proof, office revocation surface, and lost-device
  procedure are locally implemented. No field-launch claim is permitted until the deployed
  pairing, revocation, and lost-device proof gate closes on real devices.
- **Offline outbox, iOS-real.** Field actions (check-in, photos, voice, gate view) write to
  IndexedDB first; the server already dedupes and replays safely. Verified WebKit constraint:
  there is NO Background Sync API on iOS, so the outbox flushes only while the app is open.
  Design: flush on launch, visibilitychange, and the online event; a visible "syncing, keep
  the app open" state after submit; server-driven push nudges for stale devices. Installed
  PWAs get ~60%-of-disk storage, exemption from the 7-day eviction, and navigator.storage
  persistence. Photos use native input capture; getUserMedia is confined to voice notes on a
  single route (known standalone re-prompt bugs). Device baseline: iOS 18.4+ (Declarative
  Web Push). Verdict from primary sources: no native wrapper needed.
- **Reuse with the owner's estimator.** Same React stack; extract shared design tokens into
  a package once both apps stabilize so the estimator and OS feel like one product.

## 4. Surface inventory and phases

Each phase ends with its own proof gate: Playwright e2e in CI, screenshot + axe
accessibility checks, a device video, and a multi-agent design-judge eval against the
competitor's equivalent screen. Repository slices may proceed in parallel, but no phase is
marketed or shipped until its own prerequisite proof gates pass.

### P0: Foundation (design system + shell + auth + BFF)

Repository status: shell, session/magic-link boundaries, BFF read routes, principal-bound
outbox, and QR crew pairing/revocation are implemented. Live-backend enablement, browser
accessibility, real-device, and performance acceptance remain open.

Tokens, component tier, app shell with role-based navigation, session auth, `/api/*` read
models for jobs/gates/evidence, outbox plumbing, CI wiring (build, Playwright, pinned
@lhci/cli 0.15.x asserting category scores and metric values, not legacy audit ids).
P0 also fixes the cross-system contracts that fresh roofing demand shows cannot be deferred:
one canonical tenant/property/job identity; source/destination/freshness/mismatch truth for every
integration; complete tenant export/restore; role-shaped read models; and Canada/U.S. currency,
tax, consent, licence, and template policy.
Proof gate: 95+ on the four current Lighthouse categories (performance, accessibility,
best-practices, SEO; the PWA category was removed in Lighthouse 12) on a mid-range phone
profile, PLUS an explicit Playwright installability check (valid manifest, registered
service worker, offline response), login by QR pairing works, one job renders its Proof
Stream from live-shaped fixtures.

### P1: Field Companion (the crew app; biggest differentiator)

Repository status: Today is a server-ordered field run sheet, not a generic card grid: it keeps
the tenant schedule time zone, distinguishes `checking` / `saving` / `saved` / `not saved` local
packet availability, exposes an offline snapshot as a snapshot, and renders a blocked production
gate count as a review-only work stop. The Job packet now leads with the physical gate lock, its
actual blocker detail, read-only safety/access context, a permission-and-assignment-gated proof
capture path, then verified proof and collapsible supporting records. It does not infer safety
clearance, packet completeness, a gate override, or a separate authoritative checklist from the
currently gate-derived `required_proof` payload. Check-in is now camera-and-voice first: selected
media is reviewable and removable before the device save, blocker reporting is deliberate, notes
and location are optional, and the outbox state remains exact about local save, queue, upload,
verification, and attention. IndexedDB packets/outbox, upload verification, bounded proof
rendering, and device-bound QR access are implemented and locally tested. Real iOS/Android,
weak-signal, process-kill, storage, multi-tab, accessibility, and timing proof remain open.

Screens: Today (assigned jobs as a chronological run sheet), Job (physical gate locks, safety/access
brief, Proof Stream, and supporting packet records), Check-in (camera/voice capture, selected-media
review, deliberate blocker escalation, optional note/location, and device-first save), all offline-first.
The assigned scope, measurements, materials, changes, safety plan, and proof checklist are visibly
prefetched before departure. Media capture is designed and tested for 30-400 photos per job; the
proof viewer handles more than 1,000 items without losing scroll/filter/selection state.
Beats current mobile competitors on verified durability, evidence ownership, and server-confirmed
sync truth rather than on an unverified claim that they lack offline mode.
Proof gate: full check-in executed in airplane mode in 15 seconds and 4 taps or fewer,
synced later with zero loss; crew member with no training completes it on first try.

### P2: Owner Cockpit + Approvals Inbox

Screens: Now (blocked jobs, unpaid, untriaged leads, triage-data quality; heartbeat remains a gate), Job drill-down, Approvals inbox
(pending Hermes dry-runs rendered as diff cards with approve/reject, plus bounded
uncertainty reconciliation when execution status cannot be proven).
Repository checkpoint: the role-scoped **Now** decision board and a dedicated `/approvals` inbox
are implemented locally. Now turns the current proof-safe payload into three compact signals and
ordered lanes for verified crew work-stops/gates, operating exceptions, and lead attention. It
exposes stale and bounded source truth rather than repeating unavailable due/action copy on every
row, formats timestamps in the tenant time zone, and renders job access only when `job.read` is in
the BFF response. It keeps untriaged leads separate from bus transport state and labels MCTB only
as provider acceptance, late/unproven/no-channel evidence.

The inbox is deliberately review-only rather than a generic lead editor. Sales now exposes a
source-backed office lead contract and a contextual local-triage preparation route. It appears only
for an explicitly `Untriaged` Lead Envelope with the BFF-issued `approval.prepare` capability; an
`Unknown` legacy state stays visible as data-quality work rather than becoming a write affordance.
The route sends only the Frappe Lead Envelope name and one internal triage summary. The Worker
derives its request text, previews through the private broker, and returns the user to the existing
`/approvals` human queue; the browser never triages the lead directly.
It renders the exact local-triage before/patch diff plus scope fence (no customer message, transport,
quote, or accounting mutation); the browser never sees a receipt, raw write args, broker output, or
tool selector. It honors BFF `approval.approve` / `approval.reject` / `approval.reconcile` capabilities
instead of inferring authority from role. A decision requires current CSRF, a recent configured-approver
session, expected version, and stable idempotency key. It is not queued offline or automatically retried; broker ambiguity
becomes a visible no-retry reconciliation state whose evidence can be appended without reopening the write.
Remote D1/Frappe migration, private broker reachability,
live source freshness, real browser/device operation, and the phone acceptance gate remain open.
Beats: JN Insights ("AWFUL" per their own users) and gives the agent layer a human surface
nobody in the market has: governed AI with a one-thumb approval queue.
Proof gate: "what is blocked and why" answered in one tap in under 3 seconds; one real
approved write executed from the phone with its Hermes Run audit visible.

### P3: Sales Desk + Estimator Workbench

Sales: lead queue with source/consent context, quote status. Estimator (responsive,
desktop-optimized): measurement verification view that renders the geometry engine's
checks (declared vs recomputed, deviations highlighted), takeoff review, customer quote,
proposal pack assembly. Repricing clones an immutable prior estimate against a versioned price
book, shows every scope/price/tax/assumption delta, and retains all source references. Insurance
supplements get a separate evidence lane rather than being forced through the retail flow.
Repository checkpoint: the first `/sales` screen is locally implemented as an office-only, bounded
review queue. Its BFF uses a dedicated Sales allowlist so Field Companion and Owner Now never fetch
office contact or commercial fields. Each row joins the Lead Envelope, latest estimate session,
latest quote, linked communication-record context, and explicit source/row-limit status. It labels
an estimate range as non-binding and does not expose raw intake payloads, price-book internals,
outbound send controls, quote issuance, payment controls, or a generic Frappe query. The estimator
workbench is now locally implemented at `/estimator/jobs/:jobId` as a separate office-only read
contract. Its Worker-only detail reads retain the selected raw measurement key solely long enough
to reparse an allowlisted `raw/measurements/...` object from R2; the browser receives no raw key,
XML, report URL, evidence JSON, or generic Frappe record. Instead it receives capped declared versus
recomputed facet values, deterministic check results, persisted metric/takeoff source references,
quote price-book/version state, proposal-record state, and attributable scope clauses. It explicitly
labels recomputation as source-file math, not field verification, and never infers a continuous
chain: the selected takeoff must link to the selected Measurement Report and the proposal must link
to the selected Customer Quote; mismatch and bounded-source uncertainty remain visible. It has no
price, takeoff, proposal, signature, payment, or communication write control. Its local Commercial
Decision Rail now compares a selected quote only to an explicitly superseded prior version, makes
the captured price-book/effective-date snapshot distinct from a live supplier-price claim, isolates
pending change orders by selected quote linkage, and exposes proposal-review stops. It cannot
regenerate an amount, mutate a quote, prepare a proposal, send a customer message, or infer written
customer agreement. A governed MCP quote-revision command now creates only an append-only Draft
shell bound to its source quote, customer, job, reason, and fresh version; it never copies price,
tax, scope, payment, approval, acceptance, or customer-facing terms, and an accepted quote must
use the Change Order path. Its dedicated estimator-assistant broker, separate D1 event ledger,
redacted preview, and BFF approval routes are locally contract-tested; they never reuse the
lead-triage broker or `/approvals` inbox. The workbench exposes a contextual entry only when the
exact BFF action is granted for a current versioned, non-accepted source. The resulting prepare,
queue, and detail routes show a source-to-blank-Draft decision rail, commercial-term fence,
server-granted actions only, stable idempotency, and reconciliation instead of retry on ambiguity.
A separate governed proposal-pack MCP slice can now create only a Draft pack for one explicit,
same-job `Approved`/`Accepted` quote: it requires an approved measurement and customer-safe,
checksum/provenance-verified evidence, creates a quote-owned identity, and persists only a
redacted summary. Frappe re-resolves every retained source ID and rejects customer messages or any
non-Draft status until a dedicated delivery path exists. A quote can now carry a server-bound,
immutable Price Book Rule snapshot: it is created only for Draft/Needs Review quotes from approved,
effective source rules; required before quote approval or proof-pack assembly; and redacted from
the browser. This protects real supplier-cost volatility without presenting a timestamp as live
pricing. The local workbench remains review-only: it has no price-rule bind control, live supplier
feed, browser proposal assembler, customer renderer/send, e-sign, or live proof. Its insurance
rail is locally implemented as a restricted read-only evidence surface: it shows only derived
measurement, role-coverage, invoice, and human-handoff state; it exposes no claim/carrier/policy
facts, document identity, storage pointers, customer controls, or carrier controls. ESX, live
carrier submission, and coverage/determination workflows remain open, as do live
source/browser/operator proof. The BFF omits this rail entirely unless the server authorizes an
owner session or a session-bound Frappe estimator identity explicitly listed in
`APP_INSURANCE_ESTIMATOR_FRAPPE_USERS`; broad operations access alone never fetches it.
Beats: SmartEstimates on trust: JN auto-drafts from unverified numbers; we show the
verification. Proof gate: measurement-to-proposal flow completed with every number
traceable to its in-file source ref on screen.

### P4: Customer Portal + Instant Estimate Widget

Portal (signed links): proposal with options, progress (customer-safe evidence only),
invoices, completion proof, payment receipt, and warranty packet. Closeout remains physically
locked on final proof, punch resolution, payment, inspection/permit close, manufacturer detail,
warranty registration, and signed completion. Widget: embeddable static JS posting to `/ingest/estimate`
with the non-binding range UX.
Beats: Roofr's $125-149/mo widget (ours is included) and GHL funnels on trust (proof,
not marketing pressure). Proof gate: a homeowner completes an estimate and a customer
accepts a proposal on a phone without instructions.

### P5: White-label theming + tenant admin

Theme resolution from tenant config, tenant admin surface (users, toggles, templates),
demo tenant re-skinned end to end. Proof gate: second brand fully themed by config alone.

## 5. "Subjectively outperform," measured

| Benchmark | Target | Versus |
| --- | --- | --- |
| Field check-in | 15s, 4 taps or fewer, works offline with server-verified replay | Current competitors claim offline; IronWrap must prove zero-loss weak-signal recovery |
| Owner "what is blocked" | 1 tap, under 3s | JN Insights: called "AWFUL" by its own users |
| Cold load | LCP 2.0s or less under Lighthouse default mobile throttling (moto-g-class, 4G); CWV baseline is 2.5s, so this is a deliberate stretch | JN/GHL mobile lag complaints |
| Lighthouse (performance/accessibility/best-practices/SEO) | 95+ each, enforced in CI via pinned @lhci/cli; installability proven separately in Playwright (PWA category removed in Lighthouse 12) | Not published by any competitor |
| Responsiveness | Field INP under 200ms at p75 via web-vitals RUM; CI lab proxy TBT under 200ms (INP is not lab-measurable) | Unpublished by competitors |
| Data loss under bad signal | Zero (outbox replay proof test) | JN documented mid-entry estimate loss |
| Judge panel | Multi-agent design evals + one real crew, screen vs screen | JN/GHL/Roofr equivalents |
| Training required | None: first-try task completion by a new crew member | Competitor onboarding courses |

The eval harness is part of the build: each phase's judge eval and task-time runs are
scripted and repeatable, so "subjectively better" is re-checkable after every change,
not a one-time opinion.

## 6. Absolute-best upgrades (adopted 2026-07-10)

The base plan is excellent; these six deltas are what separate excellent from
category-defining, and they are now part of the plan:

1. **Local-first upgrade path (verified 2026-07-10).** The P0 outbox + query cache gives
   90% of the feel; the ceiling is a true local-first replica. Verified verdict: none of
   the named engines fit this backend today (PowerSync: Postgres/Mongo GA, no MariaDB/D1;
   ElectricSQL and Zero: Postgres-only; Replicache: archived June 2026; Triplit:
   community-only). So outbox + cache carries further than hoped, and the replayability
   commitment becomes a TESTABLE P0 contract: every read model carries stable entity ids
   and a monotonic cursor, every mutation has a client-generated idempotent id, and CI
   proves a cold client rebuilds purely from cursors + replay. Watchlist: LiveStore
   (Apache-2.0, the only Worker/DO/D1-native engine, pre-1.0) and TinyBase (MIT) as an
   outbox-layer upgrade. All candidates pass the no-AGPL gate. Interaction budgets from
   day one: field INP under 200ms at p75 via web-vitals RUM (CI lab proxy: TBT under
   200ms), optimistic UI on every idempotent write, same-document View Transitions
   (cross-browser since Firefox 144) behind a feature detect; cross-document transitions
   are progressive enhancement only.
2. **Voice as command, not just evidence.** P2 adds voice check-in: crew speaks ("twelve
   squares done, need more screws tomorrow"), speech-to-structured drafts a check-in for
   one-tap confirm. It lands through the governed draft path, which is why ours can ship
   safely while JobNimbus Scout stays a freeform-write liability.
3. **One product with the owner's estimator.** The estimator (separate React codebase) and
   this app must not drift into two products. P0 deliverable: a written integration
   contract (shared design tokens package, the estimator's payload contract on
   `/ingest/estimate`, embed points in Estimator Workbench and Customer Portal).
4. **Proactive surface.** PWA push notifications at P2: approvals pending, gate flips,
   morning brief ("2 jobs blocked on materials, 1 quote expiring"), driven by Hermes cron
   through the read-only roles. Competitors cannot copy this safely without our governance
   layer.
5. **Distinctiveness gate.** shadcn/ui is the headless base, never the look; the default
   shadcn aesthetic is template-recognizable in 2026. Every phase's judge eval includes a
   distinctiveness criterion (typography pairing, motion identity, the Proof Stream visual
   language) so no screen ships looking like a template.
6. **Real crews from week one.** Judge panels are proxies. P1 starts field sessions with
   the actual crew in its first week, filmed task-completion, five-user protocol, weekly.
   Nothing in this plan substitutes for live hours; speed-to-field is the truest maximizer
   of "best."

## 7. What this needs

From the repo: remaining product surfaces, live flags/deployment, and device acceptance remain to
be built or proven. From the owner: P1 field testing needs a phone and one crew member; P4 widget
embed needs website access (already tracked). Build order starts with the remaining P0 acceptance
work; every phase is verifiable locally per the
launch runbook's truth-boundary rules before anything ships to the Oracle host.
