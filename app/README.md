# IronWrap OS PWA

Repository-built foundation for the installable IronWrap OS product surface; build success is not
deployment, real-device, technical-reference, or customer proof. This directory is an
independent Vite application that talks only to the same-origin Worker BFF under `/api/v1/*`.
It never calls Frappe directly and it ships no demo jobs, leads, customers, or fallback business
data. The Worker, not the browser, enforces authority. See the canonical boundary in
[`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md).

## Implemented surface

- Vite 8, React 19, TypeScript 7, Tailwind 4, local Radix/CVA UI primitives, TanStack Router and
  Query, Workbox through `vite-plugin-pwa`, and IndexedDB through `idb`.
- Exact session-contract validation, magic-link sign-in, a fail-closed auth boundary, and role
  navigation for `owner`, `ops`, `sales`, `production`, `accounting`, and `field`.
- Responsive desktop/sidebar and thumb-first bottom navigation. Field controls use a 64 px target;
  general primary targets use at least 56 px.
- Semantic light/dark tokens and accessible loading, error, and teaching empty states.
- The owner-approved Iron Wrap identity, ported from the `iron-wrap-exteriors` reference: primer
  ground, charcoal chrome, ink primary actions, brass only for focus and the active place, and
  self-hosted Archivo with Martian Mono for identifiers. `src/components/ui` carries its
  primitives: the stamped `RefTag`, glyph-and-word `Status`, `Notice` tones including on-device
  `local`, `Queue`/`QueueRow`, `PageHeader`, `Segmented`, `SaveIndicator`, `Timeline`,
  `ErrorSummary`, a native-`<dialog>` `Dialog`/drawer, and the `Logo`/`BrandMark` assets in
  `public/brand`. The shell itself is not yet restyled to the reference's rail layout.
- Install, update, network, queue, upload, verification, and attention status that uses an icon,
  word, and colour together.
- Chromium/iOS-compatible 192 px and 512 px PNG install icons plus a full-bleed maskable icon; SVG
  remains a supplemental scalable asset.
- A durable IndexedDB outbox with Blob support, stable `device_action_id`, idempotency headers,
  CSRF-at-send, exponential retry, conflict retention, and server-confirmed completion.
- A contract-tested, read-only Owner Now decision board: work-stops, operating exceptions,
  and lead attention are separated into proof-safe lanes; data limits stay visible; and job packets
  open only when the BFF grants `job.read`. It does not invent delivery, follow-up, approvals, or
  financial impact.
- A contract-tested governed Approvals inbox: server-safe before/patch diff cards, a
  permanent local-only scope fence, BFF-issued `approval.approve` / `approval.reject` /
  `approval.reconcile` capability, stable idempotency for approve/reject, and an explicit no-retry
  `Execution Uncertain` state with one immutable evidence reconciliation. It never
  receives a receipt, raw write arguments, broker output, Frappe credential, or generic tool picker.
  Approval decisions are deliberately online-only and are never placed in the field outbox.
- A contract-tested Sales-to-triage preparation flow: an exact `Untriaged` Lead Envelope
  exposes `approval.prepare` only when its BFF grants it. The route submits only the Frappe Lead
  Envelope name and one internal summary; the Worker derives the broker-bound request text and
  returns the user to the existing human review queue. It cannot send a customer message, modify
  transport, issue a quote, alter commercial terms, or triage the lead directly.
- A locally contract-tested office Sales Desk: a bounded Lead Envelope, estimate, quote, and
  communication-record review queue with a separate BFF allowlist. It labels preliminary estimate
  ranges as non-binding and source limits as uncertainty. It does not receive raw intake payloads,
  commercial policy snapshots, generic Frappe data, or any send, quote, or payment control.
- A locally contract-tested Measurement Workbench: an office-only source review reached from Sales
  that shows retained-source geometry checks, persisted metric and takeoff references, versioned
  quote/proposal state, and attributable scope clauses. Raw R2 keys/XML, report URLs, tax-policy
  snapshots, supplier costs, evidence JSON, and customer messages stay server-side; it has no
  price, takeoff, proposal, signature, payment, or communication write control. Source geometry is
  explicitly not field-verification evidence.
- A locally contract-tested Draft Revision approval vertical: the workbench offers a contextual
  entry only when its BFF grants `quote_revision_approval.prepare` for a current versioned,
  non-accepted source. Its prepare page submits only source identity plus correction reason; its
  separate queue and detail routes receive a redacted source-to-blank-Draft projection, use exact
  BFF capability for decisions, keep stable approve/reject idempotency, and turn an uncertain
  execution into reconciliation work with no retry. It cannot carry commercial terms, broker
  proof, raw write arguments, customer messaging, or accounting mutation into the browser.
- A field-first Today run sheet: server order is preserved, schedules format in the tenant time
  zone, and local packet availability visibly progresses from checking to saving, saved, or not
  saved. A cached packet is never called complete or safety-cleared; a blocked gate can only open
  the governed job packet for review.
- A gate-and-proof-first Job packet: physical work locks, the read-only safety/access brief, and
  the verified Proof Stream precede collapsible supporting records. The mobile capture control is
  64 px and appears only for an active assignment with the BFF's `field.checkin.create` capability;
  blocker capture records the condition but cannot open or waive a gate.
- A camera-and-voice-first Check-in: selection is reviewable and removable before it is saved,
  blocker reporting is explicit, notes and location remain optional, and the visible outbox state
  distinguishes device save, queued work, upload, verification, and attention without implying
  delivery or onsite proof.
- A capability-limited customer Portal: a share link resolves only a published project projection
  and does not expose raw evidence, internal notes, prices outside the approved proposal record,
  or an office session. Today, Job, Check-in, Owner Now, Production Runway, Approvals, Sales,
  Measurement Workbench, Draft Revision review, and Settings implement the canonical interaction
  and evidence
  foundations. The inbox and production runway remain review surfaces, not generic editors or
  dispatch controls; live native-Worker/provider/operator proof and any enabled compatibility
  projection proof remain separate launch gates.

## Run it

Node 22.12 or newer is required.

```bash
npm ci
npm run dev
```

Validation:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

All direct and development dependencies are pinned without ranges and recorded in
`package-lock.json`. ESLint parses TypeScript through Babel 8 while the TypeScript 7 compiler owns
semantic checking; this avoids running current `typescript-eslint` against a compiler version
outside its declared and working peer range. Lint and typecheck remain separate required gates.

## BFF and auth contracts

Endpoint names are centralized in `src/lib/api-paths.ts`:

| Method         | Path                                             | Purpose                                                   |
| -------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `GET`          | `/api/v1/session`                                | Versioned tenant/session/RBAC read model                  |
| `POST`         | `/api/v1/auth/magic-link/request`                | Request a one-time link with `{email}`                    |
| `POST`         | `/api/v1/auth/magic-link/consume`                | Consume `{token}` after browser-side extraction           |
| `POST`         | `/api/v1/auth/device-pairing/consume`            | Consume QR `{token, device_proof}` for Field Companion    |
| `GET`          | `/api/v1/field-users`                            | Owner/ops list of pairable active field users             |
| `GET` / `POST` | `/api/v1/device-pairings`                        | Owner/ops device list or QR issuance                      |
| `POST`         | `/api/v1/device-pairings/:id/revoke`             | Revoke one lost or reassigned field device                |
| `POST`         | `/api/v1/auth/logout`                            | Revoke the current session with `X-CSRF-Token`            |
| `GET`          | `/api/v1/sales`                                  | Owner/ops bounded Sales Desk review DTO                   |
| `GET`          | `/api/v1/estimator/jobs/:id`                     | Owner/ops bounded Measurement Workbench review DTO        |
| `GET` / `POST` | `/api/v1/quote-revision-approvals`               | Isolated redacted Draft Revision queue or preparation     |
| `GET`          | `/api/v1/quote-revision-approvals/:id`           | One redacted Draft Revision review                        |
| `POST`         | `/api/v1/quote-revision-approvals/:id/approve`   | Configured approver, CAS/idempotent Draft-shell decision  |
| `POST`         | `/api/v1/quote-revision-approvals/:id/reject`    | Configured approver, durable rejection with reason        |
| `POST`         | `/api/v1/quote-revision-approvals/:id/reconcile` | Configured approver, immutable uncertainty reconciliation |
| `GET`          | `/api/v1/approvals`                              | Owner/ops browser-safe approval inbox and capability DTO  |
| `POST`         | `/api/v1/approvals/:id/approve`                  | Configured-owner, CAS/idempotent approval decision        |
| `POST`         | `/api/v1/approvals/:id/reject`                   | Configured-owner, durable rejection with reason           |
| `POST`         | `/api/v1/approvals/:id/reconcile`                | Configured-owner, immutable uncertain-run reconciliation  |

The session envelope is validated centrally with Zod in `src/auth/session.ts`. Unauthenticated
responses are `200` with null user/session fields and public tenant presentation; an authenticated
envelope includes the tenant, role, permissions, allowed actions, CSRF token, expiry, freshness
timestamps, and explicit stale fields.

Magic-link URLs use `/auth/verify#token=...`, not a query string and not a GET mutation. The app
extracts the fragment and immediately removes it with `history.replaceState` before the token is
POSTed. It is never placed in TanStack Query state, route search state, IndexedDB, or a URL sent to
the server. Link scanners therefore cannot consume a sign-in token with a passive GET.

Field crew cannot receive a magic-link session. An owner or operations user instead issues a
short-lived `/auth/pair#token=...` QR from **Settings -> Crew devices**. The pairing fragment is
scrubbed before a POST; a fresh 256-bit device proof stays only in memory until the Worker returns
an authenticated `field` session, then persists in IndexedDB. Every field session, field read,
outbox flush, and logout sends `X-IronWrap-Device-Proof` alongside the session cookie. The proof is
never included in a session snapshot or outbox record. A failed/expired QR leaves an existing
proof intact; a 401 or office revocation clears it and requires a fresh supervised QR.

The Worker stores only hashes of pairing tokens and device proofs. Office users can list and revoke
devices; crew users cannot issue, list, or revoke them. Pairing links never use a query string and
are neither logged nor retained in a backup as reusable secrets.

An online authenticated session is cached without its CSRF token until its server expiry so an
already-provisioned crew device can reopen the offline shell. The offline marker cannot sign out
or upload. Every mutation is re-authorized by the Worker when connectivity returns.

## Interaction contract

Each role gets a focused surface with one primary next action, progressive disclosure, plain-language
blockers, visible evidence provenance, authority, and sync state, plus a reachable human escalation.
A workflow board is a read model: its lanes are versioned predicates over authoritative state. A
drag/drop gesture requests a typed Worker command with aggregate-version and idempotency
preconditions; it never edits a generic status in the browser.

Operational forms follow versioned domain schemas with typed fields, field-level read/write
authority, provenance, conditional evidence, offline rules, and correction audit. This is a target
composition contract, not a claim that the PWA currently contains a generic form builder.

The planned conversational owner surface is another client of the same BFF read models and action
catalog. It may query, explain, draft, request governed action, present required approval, and show
readback/reconciliation. It is not a global chatbot, does not receive credentials or ambient
authority, and cannot replace role screens, exception queues, audit, or recovery controls.

## Offline outbox contract

Every field mutation follows this visible state machine:

```text
Saved locally -> Queued -> Uploading -> Verified
                     \          \
                      +----------> Needs attention -> Queued
```

`Verified` means the server returned the same `device_action_id` with `status: "verified"`; a 2xx
response alone is not enough. JSON writes contain `{device_action_id, payload}`. Blob writes use
multipart form data with metadata and one or more attachments. Both forms send:

- `Idempotency-Key: <device_action_id>`
- `X-Device-Action-Id: <device_action_id>`
- `X-CSRF-Token: <current in-memory session token>`

Session and CSRF tokens are rejected if a caller tries to place them in persisted outbox payloads.
The current CSRF value is supplied only when a flush begins. It is not part of an action record.

Network errors, 408, 429, and 5xx responses return the action to `Queued` with bounded exponential
backoff and `Retry-After` support. A 409 or 412 moves it to `Needs attention` and retains both the
local action and every Blob. Other 4xx responses also require review. Blob bytes are deleted only
after exact server verification; the small verified action record remains as local audit truth.

Interrupted `Uploading` records recover to `Queued` on the next launch. Flushes run on launch,
`online`, `visibilitychange`, and every 30 seconds while the app stays open and has a current CSRF
token. A module lock prevents concurrent flush loops.

This contract is intentionally limited to field evidence writes. An office approval is not an
outbox action: it stays disabled offline, is never auto-retried after a timeout, and is refreshed
from the durable approval ledger before another human action can be offered.

The app also makes a best-effort `navigator.storage.persist()` request and reads the browser quota.
Unsupported storage APIs never block capture. Denied persistence, an unreadable storage estimate,
or less than 512 MiB of reported headroom produces a visible warning; none of those states is
misreported as durable offline readiness.

## PWA truth

The service worker precaches only the generated application shell. It does not runtime-cache
`/api/*`, so stale API responses cannot masquerade as live business truth. Updates are prompted;
they are not forced over an operator mid-action.

iOS does not provide Background Sync for this PWA. The UI therefore says **keep the app open**
while queued work is uploading. Reconnecting or backgrounding the app is never shown as
`Verified`; only the server acknowledgement changes that state.

### Offline capability matrix

This matrix is the current product boundary. Future routes must declare and test their own row before
being described as offline-capable.

| Capability                                                           | Offline behavior                                                   | Reconnect behavior                                               | Authority rule                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Application shell                                                    | Precached shell only; no live business truth                       | Refetch session and route data                                   | Cached UI grants nothing                                               |
| Cached field work packet                                             | Read the explicitly saved packet with stale/saved state visible    | Refresh version and blockers                                     | Never implies gate, safety, or completion clearance                    |
| Field check-in/evidence                                              | Save Blob/JSON intent and stable action ID in the durable outbox   | Re-authorize, upload, and require exact server verification      | Queueing is not delivery or onsite proof                               |
| Protected field report/stop/make-safe                                | Retain the granted action intent without treating it as a release  | Re-authorize, reconcile duplicate/conflict, show terminal result | Stop/report rights remain protected; release is never inferred offline |
| Owner/ops/sales/production/accounting reads                          | Shell may open; uncached API facts are unavailable, not fabricated | Refetch authoritative read model                                 | Stale or absent data cannot authorize a decision                       |
| Approval, customer acceptance, commercial/accounting/provider commit | Disabled; never enters the field outbox or auto-retries            | Reload durable ledger and require a fresh explicit action        | Online Worker policy, permit, effect, and readback rules apply         |

The deployment target is one Cloudflare Worker with static assets configured for SPA fallback and
`run_worker_first = ["/api/*"]`. Those Worker deployment settings live with the server/deploy
slice, not in this standalone frontend package.

`public/_headers` is copied into the Cloudflare static-asset output. It enforces a self-only CSP,
blocks framing and MIME sniffing, sends HSTS and no-referrer policy, and limits camera, microphone,
and geolocation to this origin. Blob/data allowances are narrowly retained for captured media and
the service worker. The production build fails unless `_headers`, the web manifest, and every
required PNG icon exist in `dist` with the expected manifest purposes.

## Product rules

The shell follows the canonical AI-native, operating, and evidence contracts: evidence before claims,
camera/voice before keyboard, physical gate locks, exception-first owner work, one clear next action,
progressive disclosure, undoable interaction design, trade-language errors, visible authority and
sync truth, and an accessible human handoff. New routes must preserve these laws and may not add fake
production data to make an unfinished screen look populated.
