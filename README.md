# IronWrap OS

**IronWrap OS** for **IronWrap Exteriors** (Alberta roofing & metal exteriors; two
brands — IronWrap Exteriors + iRoof Alberta). Goal: capture every lead, never lose one, and run
jobs lead → estimate → proposal → deposit → materials → completion → invoice → review on a
portable owned-data spine. JobNimbus and GoHighLevel are temporary bridge systems until the owned
IronWrap OS path covers the same work with proof.

New here? Start with the [spec index](./final-spec-pack/README.md) and its
[Phase 1 source-truth and build contract](./final-spec-pack/18-phase-1-source-truth-and-build-contract.md).
Read [AGENTS.md](./AGENTS.md) for the repository map and contributor conventions.

Shipping it? The deployment authority is [docs/LAUNCH-RUNBOOK.md](./docs/LAUNCH-RUNBOOK.md);
[docs/OPERATIONS-RUNBOOK.md](./docs/OPERATIONS-RUNBOOK.md) covers recovery and day-two operation.
The Frappe-only/Hermes target and repository proof are
[the end-product blueprint](./docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md) and
[the proof pack](./docs/HERMES-ERPNEXT-PROOF-PACK.md). Legacy `erpnext-*` names are compatibility
identifiers only; ERPNext is forbidden in the runtime.

## Layout

| Path | What |
|---|---|
| [`final-spec-pack/`](./final-spec-pack/) | **The spec** (19 chapters; start at its `README.md`). The target system. |
| [`workers-bus/`](./workers-bus/) | **The integration bus** — Cloudflare Worker (owned D1/R2 store + lead/photo/measurement/estimate bus). `npm test` / `wrangler deploy`. |
| [`app/`](./app/) | **The production PWA** — owned app surface (Vite 8 / React 19 / TS 7): Field Companion, public estimator, customer portal, production schedule. Vitest + Playwright e2e + Lighthouse. |
| [`deploy/local/`](./deploy/local/) | **Local E2E stack** — docker-compose Frappe v15 + MariaDB + Redis with provisioner and seed data; wired into workers-bus `npm run dev`. Dev-only, never production. |
| `samples/` | Real RoofRuler measurement reports + AppliCad XML (extraction inputs). |
| `docs/` | Current runbooks, proof material, scoped references, and archived planning records. |
| `output/` | Generated deliverables (Russian `.docx`, overview PDF, website audit). |
| `task1-spec/` | Original source material (v9.1 docs, pricing, early PDFs). |
| `tools/` | Build/proof scripts, including AppliCad XML and Frappe DocType contract checks. |
| `frappe-apps/ironwrap_roofing/` | Proprietary Frappe-only operating core. |
| `mcp/ironwrap-bus-mcp/` | Read-only MCP wrapper for Hermes/operator diagnostics over the bus admin endpoints. |
| `mcp/erpnext-roofing-mcp/` | MCP wrapper for Hermes/operator diagnostics plus narrow approved Frappe writes. |

## Status

- **Spec:** the current direction is locked in `final-spec-pack/18`: owned Worker/D1/R2 first-write
  spine, Frappe-only/Hermes core, Field Companion PWA primary, and JobNimbus/GHL/Make/Jotform as
  temporary bridges.
- **Bus:** buildable; tests green; website/photo/measurement/estimate/QuickBooks intake paths are
  in code. `/ingest/estimate` is the owned estimator handoff and does not depend on JobNimbus/GHL.
- **App:** the production PWA in `app/` is buildable with unit + Playwright e2e coverage.
- **Local E2E:** `deploy/local/` runs the full stack locally (docker-compose Frappe v15 + MariaDB +
  Redis, seeded synthetic data) behind workers-bus `npm run dev`; dev-only, never production.

## Provenance

`task1-spec/`, `samples/`, and `output/` retain source inputs and generated deliverables. Historical
planning records live under `docs/archive/`; they are not operating authority. Secrets live in
`workers-bus/.dev.vars` (gitignored); the JobNimbus key shared during setup should be rotated.
