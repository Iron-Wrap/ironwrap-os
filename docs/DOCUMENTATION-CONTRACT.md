# Documentation Contract

Status: binding repository policy
Owner: IronWrap OS product owner
Last verified: 2026-08-10
Review trigger: architecture, authority, legal, deployment, or operating-model change

## Purpose

IronWrap OS is operated by agents and humans that must distinguish target policy, implemented
capability, live evidence, and historical discussion. Repository prose is safe only when its
authority and consumer are explicit.

This contract governs every tracked Markdown, PDF, office document, generated report, runbook,
runtime prompt, and component README.

## Authority order

When sources disagree, use this order:

1. Applicable law, permit, regulator direction, executed contract, manufacturer instruction, and
   authenticated external-system record for the exact job.
2. [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md) for the company target and
   human/agent boundary.
3. [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md) for authority,
   evidence, transitions, stops, and side effects.
4. [`HERMES-DESKTOP-TEXT-PILOT.md`](./HERMES-DESKTOP-TEXT-PILOT.md) for the accepted owner/ops
   desktop text pilot and its pairing, task, connector-context, draft, and handoff boundary.
5. [`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md) for researched regulatory triggers. It is a
   control index, not legal advice.
6. [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md) for implemented versus missing capability.
7. Current component contracts and runbooks for behavior that exists in this repository.
8. Runtime agent profiles, skills, tenant configuration, and provider knowledge bases, bounded by
   items 1 through 7.
9. Tests, release evidence, and live probes for proof of a particular build or environment.

Git history is the only archive. A deleted plan remains recoverable there but has no current
authority.

## Document classes

| Class | Purpose | May claim target behavior | May claim implemented behavior | May claim live state |
|---|---|---:|---:|---:|
| `canonical` | Company target, authority, evidence, compliance, capability | Yes | Only with code/test reference | No |
| `runbook` | Repeatable launch, operation, recovery, provider, or integration procedure | No | Yes | Only from a fresh command |
| `component` | Public contract for one code component | No | Yes | No |
| `runtime` | Agent profile, skill, or knowledge base consumed at runtime | Only by canonical reference | Yes | Only through a tool |
| `developer` | Contributor instructions and repository entry points | No | Yes | No |

The machine-readable registry is `docs/manifest.json`. Unregistered prose is a CI failure.

## Required truth labels

Use these exact meanings:

- **Target**: required end state; existence in prose does not mean it is built.
- **Implemented**: code or configuration exists in the referenced commit.
- **Repository-verified**: a fresh local/CI check passed against the exact commit.
- **Deployed**: artifacts were published to a named environment.
- **Runtime-verified**: a fresh authenticated probe passed in that environment.
- **Business-accepted**: an authorized owner/customer/worker completed the defined acceptance.
- **Production-proven**: the real workflow completed with reconciled evidence.
- **Blocked**: a named prerequisite prevents the next transition.

Never translate one label into another. In particular:

- Repository-verified does not mean deployed.
- Deployed does not mean runtime-ready.
- Runtime-ready does not mean customer-accepted.
- A target specification does not mean implemented.
- A checkbox in Markdown is not live evidence.

## What must not be tracked

The following are prohibited:

- Historical plans, superseded specifications, dated readiness narratives, or archive directories.
- Generated Word, PDF, slide, spreadsheet, screenshot, and report outputs.
- Customer-named measurement reports, addresses, recordings, photographs, contracts, or other
  personal/business evidence.
- Credentials, copied environment values, access status, KYC state, or provider-console snapshots.
- Vendor pricing or legal claims presented as indefinitely current.
- Absolute workstation paths.
- A second file claiming to be the final spec, source of truth, binding plan, or readiness truth.

Synthetic fixtures may be tracked when they contain no real person, property, account, credential,
or provider secret and are necessary for deterministic validation.

Generated and historical artifacts belong in an approved private evidence store with retention,
access, checksum, and legal-hold controls. They do not belong in the source repository.

## Update rules

1. Change the canonical contract before or with a behavior that changes company authority.
2. Change the component README with the component behavior.
3. Update all inbound references in the same commit.
4. Do not preserve a superseded document in `docs/archive`; delete it.
5. Record implementation status in the capability matrix, not in another roadmap.
6. Record live readiness through the release/evidence tooling, not a dated report.
7. Reverify external rules at their review trigger and update `Last verified`.
8. Keep external-source URLs on the exact control they support.
9. Use synthetic examples.
10. Run `node tools/validate-documentation.mjs` before commit.

## Review policy

| Content | Mandatory review trigger |
|---|---|
| Company target or human/agent boundary | Product-owner decision |
| Authority or evidence rule | New mutation, side effect, physical action, or external system |
| Compliance register | Law/regulator change, new geography/service, or at least every 90 days |
| Launch/operations runbook | Deployment topology, secret, backup, provider, or recovery change |
| Component README | Public route, data model, environment, tool, or operator workflow change |
| Runtime prompt/skill | Tool, policy, data classification, or customer-facing behavior change |

## Repository validation

`tools/validate-documentation.mjs` must prove:

- every tracked prose document is registered;
- every registry entry exists and is unique;
- forbidden legacy/generated/customer-document paths are absent;
- internal Markdown links resolve;
- workstation-absolute links are absent;
- canonical files carry current review metadata;
- runtime and component documents point back to canonical authority where required.

The validator prevents structural drift. It cannot prove that a legal interpretation, live
provider setting, or business assertion is substantively correct; those require their named
authority and fresh evidence.
