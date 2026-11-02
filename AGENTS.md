# AGENTS.md — IronWrap working guide

Canonical contributor guide for IronWrap OS. `CLAUDE.md` points here.

## Product boundary

IronWrap OS is the owned operating system for IronWrap Exteriors and iRoof Alberta: Alberta
roofing, metal exteriors, service, and shop fabrication. AI output is always an untrusted proposal;
deterministic policy, permits, tools, provider readback, and reconciliation make digital work
reliable while people retain physical, legal, customer-choice, safety-release, and
relationship-sensitive authority.

Read the documents relevant to the change:

- Documentation authority or new docs: `docs/DOCUMENTATION-CONTRACT.md`.
- Architecture, repository boundaries, or cross-surface changes: `docs/AI-NATIVE-ARCHITECTURE.md`.
- Target company/workflow design: `docs/AUTONOMOUS-OPERATING-SYSTEM.md`.
- AI team roster, action catalog, delegation, receipts, watches, reports, or model routing:
  `docs/AI-TEAM-CONTRACT.md`.
- Transitions, work packages, side effects, evidence, or safety: `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`.
- Capability/status claims: `docs/CAPABILITY-MATRIX.md` and current source evidence.
- Compliance-sensitive changes: `docs/COMPLIANCE-REGISTER.md`.

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

Use `rg` for text, configuration, and checks of current edits. For structural questions, prefer available CodeGraph tools when the project is indexed and pass the actual project path. Treat graph links as best-effort; inspect current source when results are stale or incomplete. Use tgrep for repeated broad searches when its index helps. An unavailable index does not block a task that ordinary search can finish cheaply.

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

## Tracker

IronWrap work is tracked in GitHub Issues in `Iron-Wrap/ironwrap-tracker` and planned in the org
project **IronWrap OS** (<https://github.com/orgs/Iron-Wrap/projects/1>). Old `IRO-`/`IRW-` keys, gate
codes and Multica ids are history; refer to work as `Iron-Wrap/ironwrap-tracker#N`.
**Nothing here blocks a person or an agent.** Every rule is a convention that bots and a weekly
health report check after the fact; none is a gate.

**Work model.** Two levels. An **Outcome** (type `Feature`) is an epic owned by a human, a handful for
the product. A **Task** (`Task`, `Bug`, `Research`) is PR-sized; an agent dispatch packet is a Task
and a sub-issue of an Outcome. A **Decision** (type `Decision`) is an owner choice that unblocks
work. No `[Program]`/`[R0]`/`[T01]` title prefixes on new issues.

**Fields.** Assignee is the accountable human (`peycheff-com` unless the issue names another owner).
Executor (`Codex`, `Claude`, `Human`, `Bot`) is who runs it. `Blocked` means an open dependency.
`Waiting on human` plus label `agent:needs-human-decision` means a human-only step or an owner
decision; those items form the one human queue (project view **Waiting on human**).

**Priority.** Every issue has one. At most **5** `Urgent` (it blocks the current release gate or
production). Agents create issues at `Medium`; triage raises or lowers.

**Agent contract.** Project commands need the `project` scope, which is on the `peycheff-com`
account; scope the token to the shell and never print it. Ids come from
`gh project field-list 1 --owner Iron-Wrap --format json`; re-read the list if a command rejects one.

```sh
export GH_TOKEN=$(gh auth token --user peycheff-com)
REPO=Iron-Wrap/ironwrap-tracker OWNER=Iron-Wrap PROJECT=1 PROJECT_ID=PVT_kwDOEs01w84Bpfni
F_STATUS=PVTSSF_lADOEs01w84Bpfnizhn7BLI F_PRIORITY=PVTSSF_lADOEs01w84Bpfnizhn7BMw F_EXECUTOR=PVTSSF_lADOEs01w84BpfnizhoDLzE
# Status: Triage c31efdf9, Backlog ab6e23bd, Todo 8e01614e, In Progress 0f0d42c1, Blocked 534dd5d0,
#         Waiting on human c2154851, In Review 799164df, Done 22a1f344
S_PROGRESS=0f0d42c1 S_BLOCKED=534dd5d0 S_WAITING=c2154851 S_REVIEW=799164df
# Priority: Urgent 3e207955, High ddad08df, Medium 78009964, Low ffd0d10a      P_MEDIUM=78009964
# Executor: Codex 5760ef6f, Claude d95f3347, Human 0cfa6ddd, Bot db89f8cc      X_CODEX=5760ef6f X_CLAUDE=d95f3347
# Component field PVTSSF_lADOEs01w84Bpfnizhn75I8: facet bd250a0f, ironwrap-os cae99531
item()   { gh project item-add $PROJECT --owner $OWNER --url "https://github.com/$REPO/issues/$1" --format json --jq .id; }
setsel() { gh project item-edit --id "$1" --project-id $PROJECT_ID --field-id "$2" --single-select-option-id "$3"; }
```

1. **Check claims first.** Do not start a lane already `In Progress` for the same scope; take other
   work. A claim with no comment, commit or PR activity for 7 days is stale: take it over and say so.
   ```sh
   Q=<keyword>
   gh issue list -R $REPO --state open --search "$Q" --json number,title,assignees
   gh project item-list $PROJECT --owner $OWNER --limit 1000 --format json |
     jq -r --arg q "$Q" '.items[]|select(.status=="In Progress" or .status=="In Review" or .status=="Blocked")
       |select((.title+" "+(.content.body//""))|test($q;"i"))|"#\(.content.number)\t\(.status)\t\(.executor//"-")\t\(.title)"'
   gh search prs --owner $OWNER --state open --match title,body "$Q" --json repository,number,title
   ```
2. **Claim.** Set the assignee (only if empty), Executor and `In Progress`, then comment. No issue
   yet: create it first (`gh issue create -R $REPO --type Task --title ... --body-file ...`) at
   `Medium`.
   ```sh
   N=123; ITEM=$(item $N)
   [ -z "$(gh issue view $N -R $REPO --json assignees --jq '.assignees[0].login')" ] &&
     gh issue edit $N -R $REPO --add-assignee peycheff-com
   setsel "$ITEM" $F_EXECUTOR $X_CODEX        # or $X_CLAUDE
   setsel "$ITEM" $F_STATUS   $S_PROGRESS
   gh issue comment $N -R $REPO --body "Agent claim: <tool>, <lane or worktree>. Plan: <one line>."
   ```
3. **One status comment per checkpoint** (claimed, PR opened, blocked, handed off, done), not one per step:
   `gh issue comment $N -R $REPO --body "Checkpoint: <done>. Next: <next>."`
4. **PR body** ends with `Closes Iron-Wrap/ironwrap-tracker#N` (or `Refs ...#N` when the issue must stay
   open; then `setsel "$(item $N)" $F_STATUS $S_REVIEW`). Start the branch and worktree name with the
   issue number (`ironwrap-wt-<issue#>-<slug>`) so a link bot can infer it. Dependency and bot PRs
   carry the label `no-issue`; a PR with no inferable issue gets `needs-issue` and appears in the
   weekly report. Neither label fails `gate`.
5. **Auto-merge** every PR you open: `gh pr merge --auto --squash`.
6. **Human-only step:** mark it and continue other work; never stop a lane for it.
   ```sh
   setsel "$(item $N)" $F_STATUS $S_WAITING
   gh issue edit $N -R $REPO --add-label agent:needs-human-decision
   gh issue comment $N -R $REPO --body "Waiting on human: <exact step, where, who>. Default: <what I proceed with>. Continuing with #<other>."
   ```
   An owner decision that other work needs is a `Decision` issue
   (`gh issue create -R $REPO --type Decision --label agent:needs-human-decision --assignee peycheff-com ...`,
   Status `Waiting on human`, body: question, options with a recommendation, what it unblocks,
   default if unanswered). The issue that needs it is `Blocked` on it through the native blocked-by
   link (`addBlockedBy`); the answer is a comment, then close the Decision as completed.
7. **One task, one tool.** The Executor is the only live executor. Switching Codex and Claude means an
   `Agent release:` handoff comment (state, branch or PR, what is left) and an Executor change; the
   next tool posts its own `Agent claim:`. Never run one campaign in both, and do not re-create a live
   thread because the model changed.

**Merge tiers (all non-blocking).** Every PR auto-merges on green `gate`; a tier decides only what review
follows. Tier 0: dependency patch/minor, docs, mechanical changes. Tier 1: agent product code; the Codex
connector's review comment is advisory (fix findings in the PR if they arrive before the merge, in a
follow-up after). Tier 2: PRs touching `workers-bus/migrations/`, `release-issuer/`, `deploy/`,
`.github/workflows/`, `config/authority/` or the release-please files get the label `tier-2` and land
in a weekly post-merge review queue for Ivan and Sergey: revert, don't gate. The release-please release
PR keeps its own procedure (see the validation ladder). Tiers govern PR review only; the product
write contract in "Mutation guardrails" below is unchanged.

**Soft concurrency targets** (scheduling guidance for conductors, never a refusal): about 8 live root
chats on the workstation and about 3 on this repo; serialize Figma and computer-use lanes; cap
usability-gate rounds (for example 8–12 testers per round, a few rounds a day).

**Program state** lives in the issue fields plus one pinned status comment on the Outcome (it starts
with `<!-- program-state -->` and is edited in place), not in heartbeat prompts, authority logs or
handoff files. Conductors read the project. A weekly health report posts to the project: inflow vs
outflow, Urgent count, `In Progress` items with no linked PR for 7 days, merged PRs labelled
`needs-issue`, workflows that fail on every run, the Waiting-on-human queue and the `tier-2` queue.

## Validation ladder

CI runs what `make check` (validators, tool/MCP/app/Worker/Frappe suites, npm audits, capability
evidence receipt), `make e2e` (Playwright PWA suites), and `make secret-scan` cover, split across
parallel jobs that together reach exactly the same checks (`.github/workflows/ci.yml`); the
required check is `gate`. On a pull request, `tools/ci-scope.mjs` skips the Playwright and
Lighthouse legs when nothing they build from changed and every suite for a markdown-only change;
a push to `main` always runs everything. The individual steps, run locally and sequentially:

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

A push to `main` deploys `qa` only (`.github/workflows/deploy.yml`, IRO-260); production releases
come from a `v*` tag through `.github/workflows/deploy-production.yml`, which promotes the bytes that
Deploy already proved on `qa` rather than building its own (IRO-264).
`.github/workflows/release-please.yml` checks every pull request title, keeps one release pull
request open, and tags the release commit after Deploy proves it; a person merges that release pull
request. The first Deploy run after that merge fails closed at admission by design.

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
