# AGENTS.md — IronWrap working guide

Canonical contributor guide for IronWrap OS. `CLAUDE.md` points here.

## Product boundary

IronWrap OS is the owned operating system for IronWrap Exteriors and iRoof Alberta: Alberta
roofing, metal exteriors, service, and shop fabrication. AI output is always an untrusted proposal;
deterministic policy, permits, tools, provider readback, and reconciliation make digital work
reliable while people retain physical, legal, customer-choice, safety-release, and
relationship-sensitive authority.

Read these in order:

1. `docs/DOCUMENTATION-CONTRACT.md` — which documents may claim authority.
2. `docs/AI-NATIVE-ARCHITECTURE.md` — current system map, target AI control loop, repository
   boundaries, user journeys, closure gaps, and proof path.
3. `docs/AUTONOMOUS-OPERATING-SYSTEM.md` — complete target company and workflow.
4. `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md` — transition, work-package, evidence, safety,
   side-effect, and reconciliation rules.
5. `docs/CAPABILITY-MATRIX.md` — implemented capabilities and gaps.
6. `docs/COMPLIANCE-REGISTER.md` — current external obligations and review cadence.

Do not treat target prose as implementation evidence. Do not treat a passing local check as
deployment, runtime verification, business acceptance, or production proof.

## Repository map

| Path | Responsibility |
|---|---|
| `workers-bus/` | Cloudflare Worker integration bus and D1/R2 intake spine |
| `app/` | React PWA for public estimate, field, portal, sales, production, and owner surfaces |
| `frappe-apps/ironwrap_roofing/` | Temporary Frappe compatibility projection during the D1 cutover; no new operating authority |
| `mcp/` | Bounded agent tools for the bus, compatibility rails, and Newo |
| `hermes/` | Agent roles, MCP configuration, and procedure packs |
| `config/tenants/` | White-label tenant contracts; secrets by environment-variable name only |
| `config/newo/` | Newo release contract, tools, evidence inventory, and versioned AKB |
| `deploy/` | Local stack and production launch assets |
| `docs/` | Canonical contracts and current operational runbooks only |
| `tools/` | Zero-dependency validators, readiness checks, and synthetic fixtures |
| `Facet/` | Ignored nested product repository; use its own guide and Git lifecycle |

## Target architecture

- D1 plus the Worker is the sole owned operating authority for normalized state, transitions,
  policy enforcement, audit, and reconciliation; R2 retains raw immutable evidence.
- Frappe is a temporary compatibility projection and administrative export surface. It may mirror
  D1 state while consumers migrate, but it may not originate or authorize new operating truth.
- Do not add a new Frappe DocType, direct Worker dependency, readiness dependency, or release
  dependency. Retire existing dependencies workflow by workflow after reconciliation and rollback
  proof.
- Hermes currently supplies role/tool configuration and one default-off drafting pilot. The target
  coordinator is the bounded loop in `docs/AI-NATIVE-ARCHITECTURE.md`; neither is a database or
  grant of authority.
- The PWA is the owned human work, customer, estimator, and supervisory surface.
- QuickBooks remains posted accounting truth; the OS prepares, validates, submits, and reconciles
  accounting side effects through explicit adapters.
- JobNimbus, GoHighLevel, Make, Jotform, OneDrive, and similar systems are migration bridges, not
  new systems of record.
- Newo may provide managed voice, but IronWrap owns business truth, tools, approvals, evidence,
  reconciliation, and audit.
- Google Drive may hold the human-readable job archive; R2 holds raw immutable evidence.

The implementation may lag this target. Retire a bridge only after equivalent owned capability is
implemented, reconciled, accepted, and proven in rollback-capable operation.

## Governed-AI rule

AI is probabilistic and untrusted. Reliability is a property of the complete control loop: exact
context, schema validation, deterministic policy, bounded permits, controlled execution, provider
readback, reconciliation, evidence, and safe stop. Suppliers, weather, networks, customers,
payments, machinery, and physical observations remain independently fallible.

Routine digital actions may become machine-authorized only after the policy, adapter, idempotency,
evidence, reconciliation, and rollback contracts are implemented. Until then, preserve the current
code-enforced approval gates. Human authority remains mandatory for legal signoffs, customer
commitments that require consent, physical acceptance, relationship-sensitive decisions, and
safety-critical exceptions.

## Human work rule

Every physical task must be issued as a versioned work package containing prerequisites, worker
competency, materials and tools, site conditions, hazards, controls, drawings/instructions, hold
points, stop conditions, acceptance criteria, and required evidence. A person may stop or refuse
work without penalty. No automation may reward bypassing a safety stop or suppressing bad news.

## Code discovery

Use the configured CodeGraph/codebase-memory tools first for structural questions:

- symbol discovery and definitions;
- callers, callees, and impact;
- routes and cross-service flow;
- architecture and focused code context.

Use `rg` for literal strings, non-code documents, configs, and log/error text. If the graph is not
initialized, ask before building an index. Do not duplicate graph findings with a grep/read loop.

## Working contract

At the start of non-trivial work, identify:

- repository/worktree, branch, upstream/base, and dirty files;
- the smallest owned area to change;
- focused validation and the actual finish condition.

Work in coherent checkpoints:

1. Inspect the real flow and existing pattern.
2. Make the smallest complete change.
3. Format and run the cheapest meaningful validation.
4. Stage only that slice and commit it precisely.
5. Broaden checks in proportion to risk.
6. Push, open/update the PR, monitor the checks, and merge yourself when they are green. No human
   approval step; automated checks are what stop a change.

Preserve unrelated user work. Never sweep dirty files into a commit. Avoid broad refactors,
dependency additions, generated artifacts, and speculative scaffolding.

## Validation ladder

CI runs `make check` (validators, tool/MCP/app/Worker/Frappe suites, npm audits, capability
evidence receipt), then `make e2e` (Playwright PWA suites) and `make secret-scan`; the required
check is `gate`. The individual steps:

```bash
make check
make e2e
make secret-scan   # set GITLEAKS_BIN off linux x64
node tools/validate-documentation.mjs
node tools/validate-erpnext-doctypes.mjs
node tools/validate-tenant-config.mjs
node tools/validate-hermes-config.mjs
node tools/validate-newo-config.mjs
node tools/applicad-xml-proof.mjs --check
node tools/production-readiness.mjs contract
(cd workers-bus && npm test && npm run typecheck)
(cd mcp/erpnext-roofing-mcp && npm test)
(cd mcp/ironwrap-bus-mcp && npm test)
(cd mcp/newo-mcp && npm test)
```

Run component-specific app, Playwright, Lighthouse, Frappe, deployment, and live proof checks when
the touched surface warrants them. Report skipped or blocked checks explicitly.

## Mutation guardrails

Current code uses role allowlists and bounded tools. Where a write requires
`read → propose → dry_run → policy_check → human_approval → write → audit_event`, do not bypass
that contract because the target eventually permits machine authority. Change the contract only
with matching policy, receipt, tests, audit, reconciliation, and documentation.

No agent tool directly mutates accounting truth. No customer outbound action is enabled merely
because configuration exists. Secrets belong in approved secret stores or ignored local files,
never committed source.

## Repository data policy

- No customer names, addresses, photos, measurement reports, invoices, calls, or production
  exports in Git.
- Test fixtures must be clearly synthetic and use reserved domains such as `example.invalid`.
- Generated reports belong under ignored `output/` or another disposable directory.
- Mutable provider/account observations belong in dated evidence outside canonical guidance.
- Delete obsolete documents from the active tree; Git history is the archive.
- Keep the document allowlist and freshness checks defined by `docs/DOCUMENTATION-CONTRACT.md`.
