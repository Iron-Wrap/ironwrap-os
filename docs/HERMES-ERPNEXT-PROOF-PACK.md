# Hermes/Frappe Proof Pack

Status: repository proof packet; no live deployment claim.
Date: 2026-07-08. Updated 2026-07-12: 48-DocType Frappe-only application, atomic safety acknowledgement,
runtime-governed MCP writes, Field Companion PWA, and pinned deployment/recovery contract.

This collapses the artificial blockers from the Hermes/ERPNext blocker audit.
It defines the owned path that gradually replaces JobNimbus/GHL bridge duties as each live proof
gate passes. Legacy `erpnext-*` names are compatibility identifiers for the plain Frappe site;
the ERPNext application is removed and forbidden.

Repository proof, deployment proof, runtime proof, and account/admin acceptance are separate.
Passing the commands in this packet does not prove a deployed Worker/site/Hermes runtime, real
source cutover, a successful restore, or operator acceptance.

## Source Proof

Upstream repos inspected under `/tmp/ironwrap-research`:

| Surface | Checked Commit | Useful Result |
|---|---:|---|
| Hermes Agent | `v2026.7.7.2` / `9de9c25f620ff7f1ce0fd5457d596052d5159596` | Runtime input locked by tag and commit in `deploy/runtime-lock.json`. |
| Frappe | `v15.114.0` / `105b17938839f4e5c6cdff817d42afc40c3bcc32` | Framework and build source locked by tag and commit. |
| ERPNext | `95212e5` | Lead, Opportunity, Customer, Quotation, Sales Order, Project, Task, Item, Material Request, Purchase, and Stock primitives already exist. Since removed from the stack (2026-07-09, GPL-3.0): replaced by owned DocTypes. |
| Frappe Docker | `v3.2.1` / `d4a310089f5d6fc38ed1317b898d75b9c74901db` | Build context locked; dirty/mismatched checkout is rejected. |
| Activepieces | `598f1535` | Community source includes HTTP/webhook, Jotform, Gmail, Google Drive, QuickBooks, and Twilio pieces. |
| DocuSeal | `d86b16d` | API/webhooks/embedded signing exist; AGPL plus additional terms. Retired 2026-07-09: AGPL rules it out even as a fallback. |

The two Frappe container bases are also locked by sha256 digest. The repository verifier rejects
floating sources, credential-bearing app URLs, ERPNext installation/inheritance, and a build that
does not consume the exact lock.

## Frappe Roofing App Proof

The app is Frappe-only: `ironwrap_roofing` installs on a plain Frappe site and the erpnext app
is never installed. ERPNext was removed 2026-07-09 for 100% IP ownership; the app is proprietary
IronWrap IP on the MIT Frappe framework, with fixtures committed as DocType JSON. The only
non-custom Link target is Frappe core `User`.

Exactly 48 DocTypes are committed: 40 top-level objects and eight child tables.

| DocType | Kind | Purpose / principal links |
| --- | --- | --- |
| Lead Envelope | top-level | Immutable inbound bus identity and raw reference |
| Roofing Customer | top-level | Owned person/company record linked to lead |
| Roofing Property | top-level | Site/access/hazard facts linked to customer/lead |
| Roof Job | top-level | Pipeline/work wrapper linked to lead/customer/property/quote |
| Customer Quote | top-level | Approval/acceptance-gated owned quote linked to job/customer/evidence |
| Evidence Item | top-level | Write-once raw/photo/report/document/transcript/signature evidence |
| Instant Estimate Session | top-level | Non-binding range/session with assumptions, review, and approval |
| Price Book Rule | top-level | Effective-dated source/approval-backed pricing rule |
| Measurement Report | top-level | Provider/source metadata and reviewed measurement rows |
| Measurement Value | child | Source-referenced measurement value and review state |
| Visual Property Model | top-level | Provider-neutral model URI, evidence, screenshots, values, confidence |
| Roof Area | top-level | Area/pitch/facet/edge facts linked to property/report/model |
| Material Takeoff | top-level | Approved-measurement-backed materials and assumptions |
| Material Takeoff Item | child | Quantity/unit/waste/review rows |
| Option Package | top-level | Good/better/best material, scope, warranty, and price delta |
| Proposal Evidence Pack | top-level | Evidence-backed proposal state linked to accepted quote/signature |
| Scope Clause | top-level | Versioned inclusion/exclusion/assumption/risk/warranty clause |
| Payment Milestone | top-level | QuickBooks-linked deposit/progress/final/holdback mirror |
| Production Gate State | top-level | Deposit/material/safety/access/weather/crew/completion gate |
| Field Check-in | top-level | Crew/GPS/device/photo/voice/blocker update |
| Supplier Profile | top-level | Owned supplier master |
| Supplier Quote | top-level | Validity/substitution/readiness-backed supplier offer |
| Supplier Quote Item | child | Supplier quote quantity/price/substitution rows |
| Supplier Order | top-level | Approved takeoff/quote-backed order and delivery state |
| Supplier Order Item | child | Ordered/received/shortage/substitution rows |
| Completion Packet | top-level | Completion evidence, deficiencies, signoff, warranty readiness |
| Warranty Packet | top-level | Approved-completion-backed coverage and issue evidence |
| Review Request | top-level | Consent/payment/completion-gated review eligibility; never auto-sent |
| Communication Event | top-level | Consent/quiet-hours-gated record only; no send tool |
| Hermes Run | top-level | Run/input/policy/approval/mutation/audit/incident evidence |
| Automation Incident | top-level | Operational failure, severity, owner, resolution, and correlation |
| Market Watch Item | top-level | Sourced competitor/product gap and disposition |
| White-Label Tenant | top-level | Site-per-company identity, namespace, brand, and policy config |
| Crew Profile | top-level | Active crew, member, safety, and workflow profile |
| Job Assignment | top-level | Append-only direct/crew assignment lifecycle |
| Change Order | top-level | Versioned internal scope/price change draft |
| Change Order Item | child | Scoped quantity/price/approval line item |
| Safety Plan | top-level | Versioned safety evidence and acknowledgement parent |
| Safety Acknowledgement | child | Atomic device-bound acknowledgement evidence |
| Crew Member | child | Active crew membership and role |
| Job Compliance Record | top-level | Permit/licence/inspection/waiver truth |
| Communication Consent | top-level | Append-only consent/revocation evidence |
| Customer Decision | top-level | Evidence-backed decision record, never signature impersonation |
| Contract Acceptance | top-level | Customer/provider acceptance evidence, Hermes read-only |
| Integration Reconciliation | top-level | External-mirror discrepancy and resolution record |
| Tenant Export Run | top-level | Requested export audit record |

Every top-level object has a unique field-based identity and a controller that calls the shared
server-side validation adapter. The pure policy layer validates strict JSON, immutable/write-once
source identities, evidence chains, approval facts, supplier/proposal/production/closeout gates,
and terminal audit state. Install/migrate hooks create eight IronWrap roles and reconcile the
least-privilege permission matrix. Delete is disabled; child tables have no standalone grants.

The former ERPNext primitives are replaced by owned equivalents:

| Former ERPNext Primitive | Owned Equivalent |
|---|---|
| Lead / Opportunity | Lead Envelope + Roof Job own the pipeline |
| Customer / Contact | Roofing Customer |
| Quotation | Customer Quote |
| Project / Task | Roof Job + Production Gate State + Field Check-in |
| Item / Material Request / Purchase Order | Material Takeoff + Supplier Quote + Supplier Order + Supplier Profile |
| Sales Invoice mirror | Payment Milestone; QuickBooks is accounting truth |
| User / Role / Permission, Web Forms, Workflow | MIT Frappe framework features |

Repository gate: `node tools/validate-erpnext-doctypes.mjs` plus the Frappe-free Python suite
prove schema/controller/policy/RBAC/packaging contracts. The standard `IronWrap OS` Workspace and
read-only, permission-scoped `IronWrap Control Center` Page are packaged with the app; their source
contract proves no direct mutation call. Runtime gate: install and migrate the app on a plain
Frappe site (no `erpnext`), create one role-specific fixture from lead -> customer -> property ->
measurement -> quote -> gates -> closeout, prove unauthorized/unsafe transitions fail, and smoke
the Control Center for every role plus empty/error/readiness states. Standard Frappe lists/forms
remain the truthful fallback. No customer portal is present in this checkpoint.

## Bus To Frappe Sync Contract

The current Worker remains the front door. The Frappe site becomes an additional
consumer only after the current owned-store-first path is stable. The erpnext-*
names below (bridge module, env vars, validator) are retained for compatibility
and refer to the Frappe site.

Current implementation checkpoint:

- Worker bridge: `workers-bus/src/erpnext.ts`.
- D1 proof fields: `workers-bus/migrations/0002_erpnext_consumer.sql` and
  `workers-bus/migrations/0003_erpnext_operating_core.sql`; operational schema, replay audit, and
  run-id ledger are extended by ordered migrations `0007` through `0010`.
- Frappe app contract: `frappe-apps/ironwrap_roofing` carries all 48 blueprint DocTypes, shared
  policy/controllers, site roles/permissions, install/migrate hooks, and package discovery proof.
- Contract validator: `node tools/validate-erpnext-doctypes.mjs`.
- Worker operational truth: `GET /health` is liveness, `GET /ready` queries D1 schema and verifies
  binding/config presence, and authenticated `GET /admin/status` aggregates heartbeat, queues,
  dead letters, Frappe/replay errors, audit failures, and latest QuickBooks receipt. `/ready` does
  not prove downstream network reachability.
- Read-only bus diagnostics also include `GET /admin/envelopes`,
  `GET /admin/envelope/:id`, and `GET /admin/dead-letter`.
- Targeted `POST /admin/replay` requires envelope id, stable `run_id`, human approver, and reason;
  compare-and-set prevents double queueing and a failed publication restores the claim. Bulk
  replay requires exact hard confirmation and is unavailable to Hermes. The replay-request ledger
  makes an exact completed `run_id` retry read-only, rejects changed intent/approver/reason, exposes
  concurrent in-progress requests, and permits safe retry of a failed rolled-back request.
- MCP wrappers: `mcp/ironwrap-bus-mcp` exposes 7 tools and `mcp/erpnext-roofing-mcp` exposes 129;
  the role/manifest validator currently proves 136 implemented tools across eight roles.
- Measurement bridge: `/ingest/measurement` now stores raw input first, then
  mirrors parsed report metadata and child measurement values into Frappe
  `Measurement Report` plus a linked `Evidence Item` when `ERPNEXT_ENABLED=true`.
- Estimator bridge: `/ingest/estimate` stores raw estimator/configurator payloads first,
  writes a D1 envelope with no JobNimbus/GHL queue dependency, then mirrors Lead Envelope,
  Roof Job, and review-gated `Instant Estimate Session` rows when `ERPNEXT_ENABLED=true`.
  It carries project ids, configurator/share URLs, totals, selected services, and material
  choices when present.
- Production gate bootstrap: Roof Job sync creates missing `Production Gate State`
  rows for Deposit, Materials, Safety, Access, Weather, Crew, and Completion.
  Existing rows are not overwritten on retry.
- Domain spine (2026-07-12): all 48 DocTypes are exact-contract validated. Review Requests apply
  deterministic completion/payment/consent stops; Communication Events apply CASL-style consent
  and quiet hours and remain record-only; field intake accepts voice notes/transcripts as Evidence
  Items; supplier, proposal, production, and closeout transitions validate upstream evidence.
- Approved Frappe writes share one audited helper. Production URLs require HTTPS, requests have a
  bounded timeout, redirects fail, and every request tool requires canonical role/actor, verified
  evidence, a stable `run_id`, current dry-run receipt, and separately signed human approval receipt.
  Reusing a completed run returns recorded truth; an in-flight claim never re-executes. Target failure ends `Failed`; a mutation followed by
  audit-finalization failure ends `Audit Failed` with `mutation_applied=true`, correlation/result
  evidence, and `audit_incident_id`, with best-effort Automation Incident creation.
- White-label/ops (2026-07-08): tenant configs in `config/tenants/` validated by
  `node tools/validate-tenant-config.mjs`; clone playbook in
  `docs/WHITE-LABEL-CLONE-PLAYBOOK.md`; operations runbook in
  `docs/OPERATIONS-RUNBOOK.md`.
- Deploy/recovery (2026-07-10): `deploy/runtime-lock.json`, digest-pinned Frappe-only
  `Containerfile.frappe`, strict host/build scripts, encrypted/verified/marker-committed backup,
  and `tools/production-readiness.mjs` separate repository contract proof from live-env shape.

Create/update order:

1. Worker receives source payload and writes raw R2 plus D1 envelope.
2. Worker/bridge maps the D1 envelope to Frappe `Lead Envelope`.
3. If address/site data exists, upsert `Roofing Property`.
4. Always upsert a `Roof Job` wrapper tied back to the Lead Envelope, optional
   property, JobNimbus contact/job refs, JobNimbus job number, and current
   qualification gate.
5. Create missing initial `Production Gate State` rows for deterministic gatekeeping.
6. If estimator/configurator data exists, create or update `Instant Estimate Session`.
7. If measurement/report data exists, create `Measurement Report`, child
   `Measurement Value` rows linked to the Roof Job by JobNimbus job number when
   that Frappe job record exists, and an `Evidence Item` pointing at the raw R2
   key plus report URI/file.
8. Record Worker envelope id and raw key on every Frappe-linked record.
9. Reconcile D1 count, Frappe consumer state, and failed sync/audit rows.

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

| Level | Repository capability |
| --- | --- |
| Read-only | Bus readiness/status/envelopes/dead letters plus Frappe job/gate/estimate/measurement/evidence/material/supplier/proposal/payment/field/closeout/comms/market/run reads |
| Dry-run | Deterministic preview for targeted replay and each of 11 Frappe write families |
| Approved write | Targeted bus replay; Frappe gate, takeoff create/status, supplier order/quote, proposal, completion, warranty, review, communication-record, and market-watch request |
| Denied | raw SQL, arbitrary HTTP, deletion, bulk Hermes replay, accounting/payment mutation, or customer send |

Every approved write creates a `Hermes Run` row with:

- user request
- tool name and arguments
- before/after target ids
- approval actor
- result/error
- linked evidence

The bus replay is the exception to the Frappe row type: it records the same run/approver/reason
proof in the D1 audit ledger. Bulk replay is admin-only with a separate hard confirmation.

Proof gate: run Hermes against fixture-backed MCP tools first. The first Frappe approved-write
proof is `request_update_gate`, guarded by `ERPNEXT_WRITE_ENABLED=true`, runtime role/actor,
a signed preview receipt, human approval receipt, stable `run_id`, and a Hermes Run before/after
record. Retry the same completed `run_id` and prove stored truth returns with no repeated target mutation.

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

## Estimator Proof

The Worker has an owned estimator intake route:

- `POST /ingest/estimate`
- uses `project_id`, `Idempotency-Key`, or project URL to return the original envelope on retry
- stores the accepted normalized estimator payload under `raw/estimates/...`
- writes a D1 envelope with `status=received`
- does not enqueue JobNimbus/GHL
- mirrors Lead Envelope, Roof Job, and Instant Estimate Session when the Frappe consumer is enabled
- keeps `review_required=1` and non-binding assumptions/exclusions

Minimum frontend/server payload:

```json
{
  "project_id": "26-180-ER",
  "job_number": "26-180-ER",
  "customer": "Jim Rakievich",
  "email": "jim@example.com",
  "address": "Gunn, AB",
  "selected_services": ["Roof", "Wall", "Soffit", "Fascia"],
  "materials": { "roof": "SnapLock Metal Roofing", "roof_color": "Wrinkle RAL 7024" },
  "total_estimate": "$216,269.58",
  "project_url": "https://estimator.example/projects/26-180-ER"
}
```

Proof gate: the 3D estimator submit/save action returns Frappe Lead Envelope, Roof Job, and
Instant Estimate Session ids without any JobNimbus/GHL queue dependency; replaying the same
project/idempotency key returns those original ids without a second raw write, envelope insert, or
Frappe/Drive mutation.

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
mock Worker/Frappe endpoint, and shows retries/failures clearly enough for ops.

## DocuSeal Decision

Decision (2026-07-09): DocuSeal is retired permanently, even as a fallback. AGPLv3 plus
additional terms conflict with the 100% IP-ownership posture, so it is no longer an option.

E-sign direction: a commercial e-sign API (a proprietary service, e.g. Dropbox Sign or the
DocuSign API) or owned signing built on the Proposal Evidence Pack. The owned Proposal Evidence
Pack remains the target; JobNimbus native e-sign can bridge only while that path is incomplete
and dies with the JobNimbus retirement.

Proof gate: one sample proposal signed through the chosen commercial e-sign API or the owned
signing path, with completion recorded back to the Roof Job.

## Repository Proof Commands

Run from a clean release checkout. These are the same proof families enforced in CI:

```bash
node tools/validate-erpnext-doctypes.mjs
node tools/validate-hermes-config.mjs
node tools/validate-tenant-config.mjs
node tools/applicad-xml-proof.mjs --check

(cd frappe-apps/ironwrap_roofing && python -m unittest discover -s tests -t .)
npm ci --prefix mcp/erpnext-roofing-mcp
npm test --prefix mcp/erpnext-roofing-mcp
npm ci --prefix mcp/ironwrap-bus-mcp
npm test --prefix mcp/ironwrap-bus-mcp

npm ci --prefix workers-bus
npm run typegen --prefix workers-bus
npm test --prefix workers-bus
npm run typecheck --prefix workers-bus
npm run deploy --prefix workers-bus -- --dry-run

node --test tools/production-readiness.test.mjs
node tools/production-readiness.mjs contract
find deploy workers-bus/scripts -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
```

`production-readiness.mjs contract` reads repository templates only. `live-env` checks a filled
environment for exact pins, digest image identity, HTTPS endpoints, credential separation, write
flags, and backup shape, but does not call the services. Deployment/runtime/admin proof remains the
launch runbook.

## Real Remaining Gates

These are not artificial and should stay visible:

| Gate | Owner/access/evidence needed |
| --- | --- |
| Git remote publication and protected CI | Repository authority; push release branch, open PR, pass required checks |
| Locked image publication | Private app release tag, registry authority, image digest, SBOM/vulnerability policy decision |
| Plain-Frappe install/migrate | Production-like host, persistent services, dedicated API user, role/negative tests |
| Worker deployment/migrations | Correct IronWrap Cloudflare account; migration and deployment evidence; `/ready` and `/admin/status` |
| Hermes runtime | Locked release, supervision, secret bindings, live read and approved-write smoke proofs |
| Backup and restore | R2 backup authority, offline `age` identity, successful isolated restore with recorded duration |
| JobNimbus key rotation, plan limits, Engage availability, fields/stages | JobNimbus admin |
| A2P 10DLC / Canadian carrier registration | legal business details plus provider approval |
| Website form cutover | website host/CMS/agency access and real test lead |
| Make scenario resave/retirement | Make UI and owner confirmation |
| Field Companion real-device/offline test (Jotform bridge optional) | iOS/Android devices, weak-signal/kill/storage proof, and live backend |
| QuickBooks Payments/webhook/OAuth | Webhook receiver has signed-payload replay receipts; QuickBooks admin/OAuth still required for payment detail reads |
| Google DKIM/DMARC and Microsoft mirror shutdown | Google/Microsoft admin plus owner signoff |
| Cloudflare token rotation | Cloudflare account authority |
| Historical OneDrive migration | Microsoft/Google access plus legacy mapping |
| Compliance/legal notices | lawyer/owner approval |
| Operator UI | Frappe Control Center and the read-only React Owner Now decision board exist in source; Sales, approvals, and customer portal remain open. Live role/device/browser proof remains open. |

These are launch/product gates, not reasons to weaken repository contracts. Keep them open until
the named external evidence exists.
