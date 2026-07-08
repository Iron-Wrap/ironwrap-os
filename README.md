# IronWrap

Internal operating system for **IronWrap Exteriors** (Alberta roofing & metal exteriors; two
brands — IronWrap Exteriors + iRoof Alberta). Goal: capture every lead, never lose one, and run
jobs lead → proposal → deposit → materials → completion → invoice → review on a portable,
owned-data spine (JobNimbus CRM + a Cloudflare owned data layer).

New here? Read **[AGENTS.md](./AGENTS.md)** for the architecture, verified facts, and conventions.
Shipping it? See **[DELIVERY-PLAN.md](./DELIVERY-PLAN.md)** — the phased roadmap from today to the spec's final state — and **[SETUP-CHECKLIST.md](./SETUP-CHECKLIST.md)** for the manual SaaS-side config.

Exploring the next-generation ERPNext/Hermes product direction? See
**[docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md](./docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md)**
and the blocker triage in
**[docs/HERMES-ERPNEXT-BLOCKER-AUDIT.md](./docs/HERMES-ERPNEXT-BLOCKER-AUDIT.md)**.
The resolved proof packet is
**[docs/HERMES-ERPNEXT-PROOF-PACK.md](./docs/HERMES-ERPNEXT-PROOF-PACK.md)**.

## Layout

| Path | What |
|---|---|
| [`final-spec-pack/`](./final-spec-pack/) | **The spec** (18 chapters; start at its `README.md`). The target system. |
| [`workers-bus/`](./workers-bus/) | **The integration bus** — Cloudflare Worker (owned D1/R2 store + lead bus). `npm test` / `wrangler deploy`. |
| `samples/` | Real RoofRuler measurement reports + AppliCad XML (extraction inputs). `_duplicates/` = deletable. |
| `docs/` | Summaries & plans (incl. Russian deliverables). |
| `output/` | Generated deliverables (Russian `.docx`, overview PDF, website audit). |
| `task1-spec/` | Original source material (v9.1 docs, pricing, early PDFs). |
| `tools/` | Build/proof scripts, including the AppliCad XML measurement proof. |

## Status

- **Spec:** mostly complete, with the current direction locked in `final-spec-pack/00`:
  JobNimbus spine, Cloudflare owned store, Google Workspace/Drive, QuickBooks Payments,
  two brands, QuoteLock removed.
- **Bus:** deployed/buildable; tests green; JobNimbus write path enabled; Gmail instant-ack
  and Google Drive filing are the current code path.

## Housekeeping

`tmp/` and `samples/_duplicates/` are pure cruft — delete to reclaim ~35M:
`rm -rf tmp samples/_duplicates`. Secrets live in `workers-bus/.dev.vars` (gitignored) — the
JobNimbus key shared during setup should be rotated.
