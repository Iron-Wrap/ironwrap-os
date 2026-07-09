# AGENTS.md — IronWrap working guide

Canonical guide for any agent/contributor working in this repo. (`CLAUDE.md` points here.)

## What this is

**IronWrap Exteriors** is a low-volume Alberta (Canada) roofing & metal-exteriors contractor
running **two brands: IronWrap Exteriors (ironwrapexteriors.com) and iRoof Alberta
(iroofalberta.ca)**. This repo holds the spec + build for **IronWrap OS**:
capture every lead, never lose one, move jobs cleanly from lead → proposal → deposit →
materials → completion → invoice → review, on a portable owned-data spine.

## Repo map

| Path | What | Status |
|---|---|---|
| `final-spec-pack/` | **The spec** — 19 numbered chapters (`README.md` is the index). The source of truth for the target system. | Authoritative |
| `workers-bus/` | **The integration bus** — a Cloudflare Worker (fetch + queue + scheduled) that is the owned data layer + Make-bus replacement. Builds + tests green. | Buildable |
| `frappe-apps/ironwrap_roofing/` | **ERPNext operating core** — custom Frappe app (23 DocTypes: lead/property/job through closeout/warranty/review, comms, supplier quote, market watch, Hermes Run audit). Contract-validated, no core fork. | Buildable |
| `mcp/` | **Hermes tool surface** — `ironwrap-bus-mcp` (bus read + replay) and `erpnext-roofing-mcp` (read + deterministic policy checks + review-gated approved writes). Tests green. | Buildable |
| `hermes/` | **Agent runtime layer** — `agents/roles.json` (per-role MCP tool allowlists, source of truth), agent profiles, `mcp-servers.json`, and the `skills/` procedure packs. | Buildable |
| `config/tenants/` | **White-label tenant configs** — one JSON per contractor (brands, geography, gates, agents), secrets by env-var name only. Validated. | Buildable |
| `samples/` | Real RoofRuler measurement-report PDFs + one AppliCad XML (the extraction inputs the spec references). `samples/_duplicates/` = byte-identical dupes, safe to delete. | Inputs |
| `docs/` | Loose summaries/plans plus the Hermes/ERPNext blueprint, proof pack, clone playbook, and operations runbook. | Reference |
| `output/` | Generated deliverables (Russian `.docx`, overview PDF, website audit). | Generated |
| `task1-spec/` | Original source material (v9.1 planning docs, early PDFs, pricing, a build script). | Legacy source |
| `tools/` | Zero-dep validators run in CI/manually: `validate-erpnext-doctypes.mjs`, `validate-tenant-config.mjs`, `validate-hermes-config.mjs`, plus the AppliCad XML proof. | Active |

## The architecture in one screen (target = the spec)

- **JobNimbus and GoHighLevel are temporary bridges, not the final system.** Keep them only where
  they still keep operations running. Do not buy or build new keeper workflows around either one.
  New work moves toward the owned IronWrap OS path.
- **Owned data layer = Cloudflare D1 + R2** (the system of record). Every lead is written here
  FIRST as a canonical envelope `{source, brand, contact, job_ref, payload, ts}`, then pushed
  only to needed bridge systems. JobNimbus/GHL are consumers, not owners.
- **Estimator/configurator** = owned path first. `POST /ingest/estimate` stores raw estimator
  payloads, creates/updates ERPNext Lead Envelope / Roof Job / Instant Estimate Session when
  enabled, and keeps all pricing non-binding until human review.
- **Integration bus** = Make (on the **Core** plan, ~$9/mo, already subscribed) **or** the
  `workers-bus/` Cloudflare Worker. Recommended hybrid: Worker does the heavy lifting; keep the
  Make Core seat for native connectors + observability.
- **Instant-ack / MCTB** is the headline: <60s touch, 24/7. Interim (pre-A2P) ack = email +
  owner alert; the prospect-SMS leg switches on at A2P approval.
- **Storage = Google Drive Shared Drives** for the human job-folder archive (R2 holds raw).
  OneDrive is a migration source / temporary legacy archive only.
- **Email = Google Workspace brand mailboxes** for IronWrap (`sales@` with `info@`/`quote@`
  aliases) plus the separate iRoof Google account. Microsoft 365 is only a mirror during
  migration; see `docs/EMAIL-DUAL-DELIVERY.md`. JobNimbus native email stays unused.
- **SMS** = JobNimbus Engage (needs fresh A2P 10DLC + Canadian carrier registration first).
- **Phone AI** = JobNimbus AssistAI (behind a written eval gate) → managed Retell → managed-OSS
  (LiveKit/Pipecat) → voicemail floor. The 4-vendor DIY voice stack stays killed.
- **Field photos/geo** = Jotform "Jobsite Photo" form (device GPS at submit, offline).
- **e-sign** = owned proposal evidence pack first as it matures; JobNimbus native can bridge while
  the owned proposal flow is incomplete. DocuSeal is only a benched escape hatch; there is no
  active `/proposal/create` Worker route.
- **OCR** = deterministic XML/text → Cloudflare `toMarkdown()` (free) → Mistral OCR only for hard docs.
- **Design** = free Canva + free Affinity. **Accounting** = QuickBooks. **QuoteLock feature: CUT.**

## Verified facts (live-checked 2026-06-28 — trust these over guesses)

- **JobNimbus API**: base `https://app.jobnimbus.com/api1`; auth `Authorization: Bearer <key>`;
  list shape `{count, results:[…]}`; record id = `jnid`; the `filter` query param works
  (ES-style `{must:[{term:{…}}]}`). **Valid record types in this account: contact `Customer`,
  job `Retail`. `"Lead"` is REJECTED (HTTP 400)** — this is the bug that broke the experimental
  Make import. Proven contact fields: `first_name,last_name,display_name,mobile_phone,email,
  address_line1,city,state_text,zip,country_name,source_name,external_id,is_lead,names:"many",
  tags,record_type_name,status_name`. **`source_name` must be an account-configured Lead Source —
  OMIT it (unknown values 400; the bus carries source in `tags`+`description`).** api1 has **no
  DELETE** (405) — soft-delete via `PUT {is_archived:true}`. Search is eventually-consistent
  (sub-second lag), so the bus uses the D1 status as the instant idempotency guard and the JN
  `bus:<envelope_id>`/`external_id` search as the backstop. Write path live-tested 2026-06-28.
- **Make** (MCP connected): org "IronWrap Exteriors" (id 6202921, **Core** plan, 10k ops/mo),
  team "My Team" (id 1742726). ~16 scenarios on the experimental GHL hub (RoofRuler intake via
  AI Extract + legacy OneDrive, Drive folder automation, GHL→JobNimbus import mid-cutover, inactive
  Jotform completion + Facebook Lead Ads). JobNimbus + Jotform already connected in Make.

## Working with `workers-bus/`

```bash
cd workers-bus
npm install                      # (sharp optional-dep may fail in CI sandboxes — harmless)
npx wrangler types               # generate Env types (after any wrangler.jsonc change)
npm test                         # node --test, zero deps — pure-logic self-test
npm run typecheck                # tsc --noEmit
npx wrangler deploy --dry-run    # validate config + bundle
```
- The JobNimbus write path was **live-tested (create → verify → archive) on 2026-06-28**, so
  `JOBNIMBUS_ENABLED` is now `"true"`. Record types are configurable via `JN_CONTACT_RECORD_TYPE`
  (`Customer`) / `JN_JOB_RECORD_TYPE` (`Retail`) / `*_STATUS`.
- Secrets go in `.dev.vars` (local, gitignored) or `wrangler secret put` (prod): `INGEST_TOKEN`,
  `ADMIN_TOKEN`, `JOBNIMBUS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, and `QB_WEBHOOK_TOKEN`
  when QuickBooks is connected.

## Working with `hermes/`, `mcp/`, and the validators

```bash
node tools/validate-erpnext-doctypes.mjs   # DocType JSON contract (23 DocTypes)
node tools/validate-tenant-config.mjs      # white-label tenant configs, no secrets, isolation
node tools/validate-hermes-config.mjs      # agent roles vs LIVE MCP tool inventory + safety contract
(cd mcp/erpnext-roofing-mcp && npm test)   # pure-logic builders + policy checks
(cd mcp/ironwrap-bus-mcp && npm test)      # bus read/replay wrappers
```
- **Hermes is the operating brain, not the database.** It reads broadly and writes only through
  narrow approved-command tools. `hermes/agents/roles.json` is the source of truth for which MCP
  tools each of the 8 agent roles may use; `validate-hermes-config.mjs` proves every listed tool
  exists and that no approved-write tool is granted without its `dry_run` counterpart in the same
  role (the read → dry_run → approval → write → audit contract cannot be skipped).
- **The mutation contract is universal:** `read → propose → dry_run → policy_check →
  human_approval → write → audit_event`. No tool sends a customer message or mutates accounting;
  comms and review requests are record-only, and every approved write records a `Hermes Run` row.
- Approved writes are double-gated: `ERPNEXT_WRITE_ENABLED=true` (or `IRONWRAP_BUS_WRITE_ENABLED`)
  **plus** the `HERMES_WRITE_TOKEN` passed as `approval_token`. Skill packs live in `hermes/skills/`.

## Conventions & guardrails

- **Maintainer = Ilia (owner) via Claude Code** — CC is the dev/ops capacity; run changes through
  CC sessions. This is why owning custom code (the bus) is viable for a no-devops shop.
- **The owned IronWrap OS path is the target.** Don't "fix the spec" to match temporary
  JobNimbus/GHL behavior; migrate toward the bus + ERPNext/Hermes estimator/proof spine.
- **Never commit secrets.** The JobNimbus API key was shared in chat during setup — **rotate it**
  and issue a dedicated key for the bus.
- Spec house style: terse, declarative, tables + mermaid; heavy cross-referencing is intentional.
- **Cleanup pending (deletion gated to you):** `tmp/` and `samples/_duplicates/` are pure cruft —
  `rm -rf tmp samples/_duplicates` to reclaim ~35M.
