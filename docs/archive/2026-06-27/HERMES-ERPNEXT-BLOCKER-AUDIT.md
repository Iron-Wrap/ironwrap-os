# Hermes/ERPNext Blocker Audit

Status: source-backed blocker triage, with artificial blockers collapsed into
`docs/HERMES-ERPNEXT-PROOF-PACK.md`.
Date: 2026-07-08.

This audit answers one question: which blockers are real external blockers, and which
can already be collapsed by research, source inspection, local prototypes, or disposable
forks/clones.

No calendar estimates are used here. Progress is measured by proof artifacts and gates.
The current proof packet is now the implementation reference for the researchable
items: [Hermes/ERPNext Proof Pack](./HERMES-ERPNEXT-PROOF-PACK.md).

## Evidence Checked

Current IronWrap repo sources:

- `SETUP-CHECKLIST.md`
- `docs/ACTIVATION-CHECKLIST.md`
- `DELIVERY-PLAN.md`
- `docs/QA-TEST-MATRIX.md`
- `final-spec-pack/11-owner-signoff-checklist.md`
- `docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md`

Upstream source clones inspected under `/tmp/ironwrap-research`:

| Project | Commit Checked | What It Proves For This Audit |
|---|---:|---|
| `NousResearch/hermes-agent` | `f64e4f4` | Hermes is inspectable and MIT-licensed; MCP, cron, gateways, skills, memory, observability, and security surfaces can be evaluated from source. |
| `frappe/frappe` | `80d9c31` | Frappe supports app-level extension, DocTypes, hooks, permissions, generated REST APIs, web forms, and multi-site patterns without a core fork. |
| `frappe/erpnext` | `95212e5` | ERPNext already contains CRM, sales, projects, stock/materials, quotations, sales orders, material requests, purchase flow primitives, and GPL license terms. |
| `frappe/frappe_docker` | `d4a3100` | ERPNext/Frappe can be locally and production deployed with Docker; the disposable demo is explicitly not the custom-app proof path. |
| `activepieces/activepieces` | `598f1535` | Activepieces is a real self-hostable Make/Zapier alternative with HTTP/webhook, Google, Jotform, Gmail/Drive, QuickBooks, Twilio pieces and MCP-facing ambitions. |
| `docusealco/docuseal` | `d86b16d` | DocuSeal has API/webhooks/embedded signing, but AGPL plus additional terms made white-label use a legal/commercial decision. Retired outright 2026-07-09; direction is a commercial e-sign API or owned signing. |

External source anchors:

- [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/) and
  [MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [Frappe DocTypes](https://docs.frappe.io/framework/user/en/basics/doctypes),
  [Frappe REST API](https://docs.frappe.io/framework/user/en/api/rest),
  [Frappe custom app guide](https://docs.frappe.io/framework/user/en/tutorial/create-an-app),
  [Frappe Web Forms](https://docs.frappe.io/framework/user/en/web-form)
- [Frappe Framework repository](https://github.com/frappe/frappe) and
  [ERPNext repository](https://github.com/frappe/erpnext)
- [Activepieces repository/license notes](https://github.com/activepieces/activepieces)
- [DocuSeal repository/license notes](https://github.com/docusealco/docuseal/blob/master/README.md)

## Bottom Line

Several "blockers" are not actually blocked. They are unknowns we can collapse by
research and local proofs:

- ERPNext can be customized for roofing through a custom Frappe app instead of a core fork.
- Hermes can be integrated deeply through MCP/tool contracts, but should be fenced as
  read-only, draft-only, or approved-write per workflow.
- The Make replacement question can be tested against Activepieces source and a local
  flow, instead of guessed.
- DocuSeal can be evaluated as a fallback, but should not be promoted above JobNimbus
  native e-sign until license/white-label posture is accepted. (Superseded 2026-07-09:
  DocuSeal is retired outright, AGPL; the direction is a commercial e-sign API or owned
  signing.)
- ERPNext's fit for roofing can be tested using actual custom DocTypes and sample
  IronWrap lead/measurement/job fixtures.

The hard blockers are mostly account, secrets, production control-plane, compliance, and
owner/business-policy decisions.

## Already Resolved By Research/Source Inspection

| Former Blocker | Status | Why It Is No Longer A Pure Blocker | Next Proof Artifact |
|---|---|---|---|
| "Can ERPNext be tailored deeply enough?" | Resolvable now | Frappe's model is metadata-driven DocTypes plus custom apps, hooks, permissions, web forms, APIs, and reports. Source confirms JSON DocTypes and hook points. | `erpnext_roofing` app skeleton with custom DocTypes and fixtures. |
| "Do we need to fork ERPNext?" | Mostly resolved: no by default | Frappe/ERPNext can be extended by app-level DocTypes and hooks. Forking core should stay a last resort. | Document exact no-fork extension map and only list core-fork triggers if found. |
| "Can ERPNext hold the roofing object model?" | Resolvable now | ERPNext already has Lead, Opportunity, Customer, Quotation, Sales Order, Project, Task, Item, Item Price, Material Request, Purchase Order, Stock, Supplier primitives. Roofing-specific concepts can be custom DocTypes. | Field map: Lead Envelope, Roofing Property, Measurement Report, Evidence Item, Proposal Option, Gate State. |
| "Can Hermes talk safely to ERPNext/the bus?" | Resolvable now | Hermes supports MCP servers, tool include/exclude filters, stdio/HTTP MCP, cron, gateways, skills, and observer hooks. | MCP tool contract with read-only tools first, then one approved-write tool against fixtures. |
| "Can Hermes run outside a laptop?" | Resolvable now | Hermes source/docs show Docker/SSH/Modal/Daytona/local terminal backends and gateways. Production design still needs an operational choice. | Runtime matrix: VPS Docker vs managed/serverless vs local-first. |
| "Can field forms move from Jotform into ERPNext later?" | Resolvable now | Frappe Web Forms can create records for DocTypes and standard web forms can live in version control. | Prototype photo/checklist Web Form against custom Jobsite Update DocType. |
| "Can we avoid Make later?" | Resolvable now | Activepieces is open-core/MIT community edition, has source-visible pieces for HTTP, webhooks, Jotform, Gmail, Drive, QuickBooks, Twilio, and a TypeScript piece framework. | Local Activepieces flow: webhook -> transform -> mock bus/ERPNext. |
| "Can e-sign be owned if JobNimbus native e-sign fails?" | Resolved 2026-07-09 | DocuSeal has API/webhooks, embedded signing, PDF form builder, Docker deployment, but AGPL plus additional terms killed it as an option. | Decision closed: DocuSeal retired; direction is a commercial e-sign API or owned signing on the Proposal Evidence Pack. |
| "Can we self-host ERPNext?" | Resolvable now | `frappe_docker` provides production compose patterns and site operations. The quick `pwd.yml` demo is only disposable and not enough for custom app validation. | Repeatable local/dev compose that installs ERPNext plus the roofing app. |
| "What is the license posture?" | Resolved 2026-07-09 | Hermes and Frappe are MIT; ERPNext (GPL-3.0) was removed from the stack and DocuSeal (AGPLv3) was retired, leaving MIT foundations plus the proprietary IronWrap app. | One legal pass (trademark hygiene, MIT notice preservation) before the first external tenant. |

## Non-Blocking Research Still Useful

These do not need credentials or account access, but they are no longer blockers
to the current proof path:

- Roofing CRM/ERP competitor matrix: JobNimbus, Roofr, AccuLynx, RoofLink/Roofr-like
  products, Hover, EagleView, CompanyCam, Leap, Builder Prime, JobProgress, GHL
  replacements.
- Measurement-provider strategy: public docs and API availability for RoofRuler, AppliCad,
  EagleView, Hover, Renoworks/Paradigm-type visualization tools, and import/export formats.
- Public estimate policy: how competitors phrase non-binding ranges, assumptions,
  exclusions, and inspection gates.
- Deeper license/commercial review for resale packaging.
- White-label go-to-market packaging once the single-shop proof is real.

Output from that research should be a decision ledger, not a brainstorm.

## Optional Runtime Proofs Still Worth Running

These are not blockers to the current plan. They are the next local checks to
convert the proof contracts into running prototypes:

| Proof | Method | Resolves |
|---|---|---|
| ERPNext roofing app runtime | Create a Frappe app, add custom DocTypes as JSON, install against local ERPNext dev site. | Confirms the proof-pack model runs in Frappe. |
| Bus-to-ERPNext fixture sync | Use existing bus envelope fixtures and Frappe REST/token shape against local ERPNext or mocked Frappe API. | Confirms the owned-store-first spine can feed ERPNext cleanly. |
| Hermes read-only over system truth | Build an MCP server exposing read-only bus/ERPNext fixture tools; run Hermes against it. | Confirms Hermes can answer owner questions without unsafe writes. |
| Hermes approved-write | Add one narrow write tool: create/update a Roofing Lead Note or Gate Waiver in a fixture/local site. | Confirms the approval/audit pattern is viable. |
| RoofRuler PDF parser runtime | Extend the AppliCad proof in `tools/applicad-xml-proof.mjs` to text-readable RoofRuler PDFs. | Confirms deterministic PDF extraction can beat generic OCR for proposal inputs. |
| Proposal evidence graph | Link measurement values, photos, material lines, exclusions, and human overrides in JSON/DocTypes. | Whether proposals can be explainable instead of AI-generated fluff. |
| Activepieces replacement probe | Run a local Activepieces flow with webhook + HTTP + Jotform/QuickBooks piece inspection or mocks. | Whether Activepieces is worth replacing Make for this shop. |
| DocuSeal fallback probe | Cancelled 2026-07-09: DocuSeal is retired (AGPL); probe a commercial e-sign API or the owned signing path instead. | Whether the chosen e-sign path survives a real proposal workflow. |
| Frappe field surface probe | Create Web Forms/Portal pages for jobsite photo, safety, completion, and deficiency capture. | Whether Jotform can eventually be retired without hurting crews. |

## Real Blockers Requiring Account/Owner/Legal Access

These should not be presented as research tasks:

| Blocker | Why Research Cannot Finish It |
|---|---|
| JobNimbus API key rotation and dedicated bus key | Requires JobNimbus admin access. |
| JobNimbus plan limits, Engage availability, lead sources, statuses, custom fields, boards | Requires the live account UI and plan entitlements. |
| A2P 10DLC / Canadian carrier registration | Requires legal business details, carrier approval, and SMS provider/account flow. |
| JobNimbus Engage production SMS | Blocked until subscription/configuration and A2P approval. |
| AssistAI evaluation and production enablement | Requires account access and real/representative call tests. |
| Google DKIM/DMARC tightening and Microsoft mirror shutdown | Requires Google Admin/Microsoft Admin plus owner migration signoff. |
| Website lead-form cutover | Requires current site/CMS/host or agency access and a live test lead. |
| Make scenario resave/retirement | Requires Make UI/account access and owner confirmation before disabling legacy routes. |
| Jotform live webhook and mobile/offline behavior | Requires Jotform account/forms and real device test. |
| QuickBooks Payments and webhook configuration | Requires QuickBooks admin/OAuth/payment settings. |
| Cloudflare token revocation and production secret writes | Requires Cloudflare account authority. |
| Historical OneDrive -> Google Drive migration | Requires source drive access and manual mapping for legacy job/contact mismatches. |
| CASL/privacy/call-recording/DPAs/legal notices | Research can draft, but lawyer/owner approval is the gate. |
| White-label commercial licensing | Research can inventory licenses; legal/commercial posture must be approved before selling. |
| GitHub remote publication | Current `origin` has returned `Repository not found`; needs repository/access correction. |

## Done Without Waiting

These items were artificial blockers and are now resolved as concrete proof
contracts in `docs/HERMES-ERPNEXT-PROOF-PACK.md`:

1. `erpnext_roofing` custom app shape: custom DocTypes, existing ERPNext primitives, and proof gate.
2. Hermes MCP boundary: read-only, draft, approved-write, and denied tool classes.
3. Bus -> ERPNext sync map using current canonical lead envelopes.
4. Measurement proof shape using existing `samples/` and the current `/ingest/measurement` route.
5. Activepieces decision: bench as future Make replacement candidate, do not switch current live path now.
6. DocuSeal decision: keep as stock fallback only if JobNimbus native e-sign fails.
   (Superseded 2026-07-09: retired outright, AGPL; commercial e-sign API or owned signing.)
7. Current-stack real account gates: JobNimbus, Google, Make, Jotform, QuickBooks, Cloudflare, website, compliance, GitHub remote.

## What I Should Not Do Yet

- Do not replace the current Worker+Make+JobNimbus path before the ERPNext proof exists.
- Do not fork ERPNext core unless a specific no-app-level alternative is proven impossible.
- Do not make Hermes a direct SQL/API writer.
- Do not let Hermes own CRM memory; ERPNext/D1/R2 remain source truth.
- Do not switch e-sign away from JobNimbus native unless it fails a real workflow gate.
- Do not treat Activepieces as automatically better than Make; prove it against IronWrap flows.
- Do not claim compliance, SMS, email deliverability, or accounting gates are solved without live account/legal proof.

## Recommended Proof Order

1. ERPNext/Frappe roofing app feasibility.
2. Bus envelope -> ERPNext sync.
3. Hermes read-only owner assistant over fixture/live-like truth.
4. One approved Hermes write with audit trail.
5. Measurement/evidence parser and proposal traceability.
6. Field forms and production gate surface.
7. Activepieces keep/bench decision; the DocuSeal decision is closed (rejected/retired 2026-07-09, AGPL).
8. White-label/license packet.

This order deliberately separates product architecture proof from external account gates.
