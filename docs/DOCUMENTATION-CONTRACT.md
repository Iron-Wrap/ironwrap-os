# Documentation Contract

Status: binding repository policy
Owner: IronWrap OS product owner
Last verified: 2026-08-31
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
2. [`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md) for the current executable map,
   repository boundaries, AI control loop, role journeys, derived lifecycle, and technical
   production-reference target.
3. [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md) for the company target and
   human/agent boundary.
4. [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md) for authority,
   evidence, transitions, stops, and side effects.
5. [`HERMES-DESKTOP-TEXT-PILOT.md`](./HERMES-DESKTOP-TEXT-PILOT.md) for the accepted owner/ops
   desktop text pilot and its pairing, task, connector-context, draft, and handoff boundary.
6. [`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md) for researched regulatory triggers. It is a
   control index, not legal advice.
7. [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md) for implemented versus missing capability.
8. Current component contracts and runbooks for behavior that exists in this repository.
9. Runtime agent profiles, skills, tenant configuration, and provider knowledge bases, bounded by
   items 1 through 8.
10. Tests, release evidence, and live probes for proof of a particular build or environment.

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

This is the single proof-label vocabulary. Every tracked document asserts proof using these classes
and only these classes; no document may define a competing vocabulary (see "Migration from prior
vocabularies" below for what each document used before this section existed).

### The six proof classes

A claim's class is the highest one for which it passes that class's admission test **and** every
admission test below it — see "Proof classes never merge."

- **Target**: required end state; existence in prose does not mean it is built. Not a proof class —
  the recorded absence of one. Use it only until Source-present is earned.
- **Source-present**: a route, component, handler, schema, adapter, migration, or deterministic test
  fixture exists in the referenced commit and can be cited as `path:line` or `repo@sha`.
  - Refuses: existence only in a spec, roadmap, comment, or prose description; code that does not
    compile or is not reachable from a registered route/command.
- **Locally-validated**: a named deterministic check (domain/state/policy, storage, adapter-contract,
  API, PWA-component, or the acceptance harness) passed on this exact checkout, and the command that
  reproduces the pass is named.
  - Refuses: "should pass," a manual read-through, a check that passed on a different commit, or a
    check run once historically and never re-verified on the cited commit.
- **Configured**: names one environment (dev, staging, or a named reference tenant) where the required
  non-secret values and secret identities are bound, and the artifact is deployed to it.
  - Refuses: values that exist only in `.env.example` or documentation; "will be configured"; a claim
    of configuration in an environment other than the one named.
- **Runtime-proven**: a fresh, authenticated probe or the exact production/reference workflow executed
  in the named configured environment, and names the readback that closed the loop (provider response,
  webhook match, signed receipt, or reconciliation record).
  - Refuses: a request or webhook receipt alone with no matching readback; a mocked or synthetic
    provider response presented as a live one; a probe against a prior, now-stale environment state.
- **Business-accepted**: names the accountable human (an owner, customer-facing role, or worker acting
  within their authority — never "the team") who completed the defined acceptance procedure for the
  exact capability and revision, in the correct environment, and names the record of that acceptance.
  - Refuses: an internal reviewer approving code or a PR; acceptance assumed because no objection was
    raised; acceptance recorded against a different revision or narrower scope than the one claimed.
- **Customer-validated**: names the real customer(s) — never a synthetic actor or reference tenant —
  who independently used the workflow and reached the claimed outcome, and how that use was captured.
  - Refuses: synthetic or reference-tenant use no matter how production-like; internal dogfooding; a
    demo performed for a customer rather than performed by them.

`Blocked: <named prerequisite>` is not a class; it is an orthogonal status flag a claim carries
alongside its highest earned class when a named prerequisite prevents the next transition.

### Orthogonal qualifiers

These describe a claim without asserting a higher class. Attach them to whichever class the claim
actually earned; never let one substitute for a class:

- **Partial**: a meaningful path exists but a material part of the named scope is missing. States how
  complete the claim is, not how proven it is — `Partial, locally-validated` is a valid claim.
- **`<class>, repository-verified <date>`**: the cited class was re-checked against the current commit
  on the named date. A freshness qualifier on a claim, not a rung of its own — it may attach to any
  class from Source-present upward.
- **Canonical**: the requirement is required by an owning IronWrap contract. States where the
  requirement comes from, not how proven it is.
- **`Blocked: <named prerequisite>` / `External proof required: <dependency>`**: the same status flag
  — a named reason progression has stalled — under the two names different documents have used for it.

### Proof classes never merge

A claim's proof class is exactly the highest class for which it passes that class's admission test and
every admission test below it. A document must never round a claim up by borrowing the evidence of a
lower class to satisfy a higher one — citing a passing unit test as "configured," or citing
configuration alone as "runtime-proven." Doing so lets a reader or downstream agent act on trust the
evidence never earned, which is the exact failure this rule exists to prevent. A claim above
Locally-validated must still be able to cite the evidence for every class below it that it depends on,
not only its own rung. In particular:

- Repository-verified freshness does not mean configured.
- Configured does not mean runtime-proven.
- Runtime-proven does not mean business-accepted.
- Runtime-proven in a reference tenant does not mean customer-validated.
- A target specification does not mean source-present.
- A checkbox in Markdown is not live evidence.

### Relationship to the ten-rung validation ladder

`IRONWRAP-OS-PRODUCT-TEAM-SPEC.md` §18.1 lists ten test rungs. The six proof classes are a coarsening
of that ladder, not a parallel scheme:

| Ladder rungs | Proof class |
|---|---|
| 1–5 (domain/state/policy, storage, adapter-contract, API, PWA-component tests) | Locally-validated |
| 6 (integration tests with provider sandboxes or controlled fakes) | Configured once the sandbox is credentialed and named; Runtime-proven only if a live authenticated call and its readback actually executed against it — a controlled fake alone stays Locally-validated |
| 7–8 (real-device exercises; named-environment dependency/readiness, restore, degraded-operation drills) | Runtime-proven |
| 9 (controlled non-customer reference journey across the full lifecycle) | Runtime-proven at its fullest single-capability instance — this is what prior documents called "technical reference-proven" |
| 10 (separate accountable customer validation) | Customer-validated |

The ladder has no numbered rung for Business-accepted: it is earned when a named accountable internal
human (not a real customer) reviews and accepts the evidence gathered at rung 8 or 9, in the correct
environment. That review is an event layered on top of ladder evidence, not an eleventh rung.

### Migration from prior vocabularies

Before this section existed, three documents each defined their own proof vocabulary, and this
contract carried a fourth that never named itself canonical. All four are retired in favor of the six
classes and qualifiers above. Nothing below is force-fit into a class it does not mean — where a term
described something other than proof, it is named as a qualifier instead.

| Prior term | Source | Maps to | Note |
|---|---|---|---|
| Target | This file (prior revision) | Target (kept) | Unchanged — never was a proof class. |
| Implemented | This file (prior revision) | Source-present | Same meaning, renamed for consistency with the other two vocabularies. |
| Repository-verified | This file (prior revision); `CAPABILITY-MATRIX.md` §"Status vocabulary" | Freshness qualifier | Describes when a class was last re-checked, not which class was reached — see `CAPABILITY-MATRIX.md`'s own use, which already treats it as a check against "the named commit" rather than a rung. |
| Deployed | This file (prior revision) | Folded into Configured's admission test | Deployment to a named environment is a precondition of Configured, not a separate class between Implemented and Runtime-verified. |
| Runtime-verified | This file (prior revision) | Runtime-proven | Same meaning, renamed for consistency. |
| Business-accepted | This file (prior revision) | Business-accepted (kept) | Unchanged in name; admission/refusal tests added. |
| Production-proven | This file (prior revision) | Retired — reclassify per instance | Conflated "ran in a real environment" with "someone accepted it" without naming who. Reclassify each existing use as Runtime-proven (technical loop only) or Business-accepted/Customer-validated (an accountable human or real customer signed off), citing the real, non-reference environment either way. |
| Technical reference-proven | This file (prior revision) | Runtime-proven, environment = reference tenant | No separate class needed: Runtime-proven's environment-naming requirement already carries the real-vs-reference distinction the old term existed to express. |
| Customer-validated | This file (prior revision); `CAPABILITY-MATRIX.md` | Customer-validated (kept) | Unchanged. |
| Blocked | This file (prior revision) | Blocked status flag (kept) | Confirmed as orthogonal, not a rung. |
| Canonical | `IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.md` §1.1 | Canonical qualifier (kept) | Describes a requirement's source, not its proof; cannot map to a rung. |
| Source-present | Annex §1.1; `CAPABILITY-MATRIX.md` (as "Implemented") | Source-present (kept) | Unchanged. |
| Locally rendered | Annex §1.1 | Folded into Source-present's admission evidence | A UI-specific way to show Source-present (it rendered) — weaker than Locally-validated, which requires a check to have passed, not just a render. |
| Locally validated | Annex §1.1 | Locally-validated (kept) | Hyphenation only. |
| Partial | Annex §1.1; `CAPABILITY-MATRIX.md` | Partial qualifier (kept) | Confirmed as a completeness qualifier, not a rung. |
| Not proven | Annex §1.1 | Retired | Redundant once "proof classes never merge" is a rule: a claim that has not earned a class simply does not assert one. State the class actually reached (often Source-present) instead of a separate negative label. |
| Built | `CAPABILITY-MATRIX.md` | Locally-validated | The matrix's own definition ("passes its required repository build and focused checks") already matches Locally-validated; keeping both is two words for one class. |
| Configured | `CAPABILITY-MATRIX.md` | Configured (kept) | Unchanged. |
| Provider-reachable | `CAPABILITY-MATRIX.md` | Runtime-proven | The matrix's own definition ("authenticated reachability and exact provider readback are freshly proven") is Runtime-proven's admission test verbatim. |
| Technically proven | `CAPABILITY-MATRIX.md` | Runtime-proven | Same class as Provider-reachable and rung 9 above, described at broader scope (full reference path plus failure drills); no new rung needed. |
| Target-only | `CAPABILITY-MATRIX.md` | Target (kept) | Same meaning as this file's "Target." |
| External proof required | `CAPABILITY-MATRIX.md` | Blocked status flag | Same function as "Blocked" under a different name; unified above. |

`docs/CAPABILITY-MATRIX.md` §"Status vocabulary" keeps a pointer to this section instead of its own
term list; relabeling its capability rows to the six classes is out of scope here and is handed to
G1.6 (Multica ELEC-230's downstream). `docs/IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.md` §1.1 and
`docs/IRONWRAP-OS-PRODUCT-TEAM-SPEC.md` §18.1/§22 are updated in this same slice to point here instead
of restating a competing table.

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
- the AI-native architecture snapshot matches checkable code/configuration reachability;
- forbidden legacy authority claims do not reappear in current Markdown.

The validator prevents structural drift. It cannot prove that a legal interpretation, live
provider setting, or business assertion is substantively correct; those require their named
authority and fresh evidence.
