# IronWrap OS

IronWrap OS is the owned operating system for IronWrap Exteriors and iRoof Alberta. Its target is
an agent-operated Alberta roofing, metal-exteriors, and metal-fabrication company in which reliable
agents run digital work and people retain physical, legal, and relationship-sensitive work.

The repository contains both the target contract and the implementation. Those are intentionally
different truth classes: a documented target is not evidence that a capability is deployed or
production-proven.

## Start here

| Authority | Purpose |
|---|---|
| [`docs/AUTONOMOUS-OPERATING-SYSTEM.md`](./docs/AUTONOMOUS-OPERATING-SYSTEM.md) | Complete company model, workflows, agent responsibilities, human work, exceptions, and target state machine |
| [`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md) | Decision authority, work-package, evidence, safety, side-effect, and reconciliation contracts |
| [`docs/CAPABILITY-MATRIX.md`](./docs/CAPABILITY-MATRIX.md) | Target-to-code gap register and implementation order |
| [`docs/COMPLIANCE-REGISTER.md`](./docs/COMPLIANCE-REGISTER.md) | Alberta/Canada obligations, official sources, owners, evidence, and review dates |
| [`docs/DOCUMENTATION-CONTRACT.md`](./docs/DOCUMENTATION-CONTRACT.md) | Documentation authority, allowed document classes, freshness, privacy, and retirement rules |
| [`AGENTS.md`](./AGENTS.md) | Contributor workflow, repository map, and implementation guardrails |

Deployment and operational procedures are subordinate to those contracts:
[`docs/LAUNCH-RUNBOOK.md`](./docs/LAUNCH-RUNBOOK.md),
[`docs/OPERATIONS-RUNBOOK.md`](./docs/OPERATIONS-RUNBOOK.md), and the scoped integration
runbooks under `docs/`.

## Human and agent boundary

Reliable agents may perform sales administration, estimating, planning, purchasing, scheduling,
compliance checks, communications, job documentation, billing preparation, reconciliation, and
warranty triage when the corresponding capability and authority are implemented.

People perform access-sensitive inspection, fabrication exceptions, material handling,
installation, emergency stabilization, relationship-sensitive conversations, and legally required
signoffs. Every physical assignment is an exact work package with prerequisites, hazards, stop
conditions, hold points, instructions, acceptance criteria, and required evidence. No schedule,
margin, or customer promise can override a safety stop.

## Repository map

| Path | Responsibility |
|---|---|
| `workers-bus/` | Cloudflare Worker integration bus and owned D1/R2 intake spine |
| `app/` | React PWA for field, estimating, customer, sales, production, and owner surfaces |
| `frappe-apps/ironwrap_roofing/` | Proprietary Frappe operating records and server policy |
| `mcp/` | Bounded tools connecting agents to the bus, Frappe, and Newo |
| `hermes/` | Agent roles, runtime configuration, and operational procedures |
| `config/` | Tenant and integration release contracts; secret names only |
| `deploy/` | Local and production deployment assets |
| `docs/` | Canonical contracts and current runbooks only |
| `tools/` | Validators, readiness checks, and synthetic fixtures |
| `Facet/` | Ignored nested product repository with its own authority and Git lifecycle |

Generated reports belong outside Git under `output/`. Customer files and production exports belong
in approved operational storage, never in this repository. Committed fixtures must be synthetic.

## Validation

Run the cheapest relevant check first, then broaden:

```bash
node tools/validate-documentation.mjs
node tools/validate-erpnext-doctypes.mjs
node tools/validate-tenant-config.mjs
node tools/validate-hermes-config.mjs
node tools/validate-newo-config.mjs
node tools/validate-lead-triage-shadow-authority.mjs
node tools/applicad-xml-proof.mjs --check
node tools/production-readiness.mjs contract
(cd workers-bus && npm test && npm run typecheck)
(cd mcp/erpnext-roofing-mcp && npm test)
(cd mcp/ironwrap-bus-mcp && npm test)
(cd mcp/newo-mcp && npm test)
```

Never infer deployment, runtime health, business acceptance, or production proof from repository
validation alone. Record each status with the evidence required by the authority contract.
