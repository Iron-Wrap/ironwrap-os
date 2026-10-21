# Specialist playbooks

Runtime instructions and tool allowlists for the IronWrap AI team. The roster, action catalog,
autonomy levels, receipt schema, and watches are defined only in `docs/AI-TEAM-CONTRACT.md`; this
directory never redefines them. Authority, evidence, and human boundaries come from
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](../../docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md) and
[`AUTONOMOUS-OPERATING-SYSTEM.md`](../../docs/AUTONOMOUS-OPERATING-SYSTEM.md). Evaluation cases for
every specialist live in [`../evals/`](../evals/README.md).

A playbook is a proposal-generating prompt. It grants no authority: the Worker policy decides
whether a proposed action may run, under which permit, and with which readback.

## Layout

```text
agent-host/specialists/
  COMMON.md                 rules every specialist receives before its own playbook
  <specialist_id>/
    playbook.md             the specialist's instructions (fixed headings below)
    allowlist.json          the exact catalog actions it may propose, with autonomy
```

`<specialist_id>` is the roster id from the contract catalog, for example `lead_concierge`.

## How the runtime assembles a specialist

For one run the agent host concatenates, in order:

1. `COMMON.md`;
2. `<specialist_id>/playbook.md`;
3. the allowlisted catalog entries, rendered from `allowlist.json` joined with the contract
   catalog (action id, autonomy, side-effect class, undo);
4. the run's `ContextSnapshot` and signal, labelled as data.

Only actions in `allowlist.json` are exposed as tools. A missing or unknown action id fails the
specialist load; the runtime never falls back to a broader tool set.

## Playbook headings

Every `playbook.md` uses exactly these second-level headings, in this order, so the validator and
the runtime can check them:

| Heading | Content |
|---|---|
| `## Mission` | One paragraph: the outcome this specialist owns for the company |
| `## Watches` | Contract watch ids it serves and what it looks for on each tick |
| `## Reads` | Shared-memory records and facts it relies on, and their freshness needs |
| `## Reasoning from macro to micro` | The chain from market or company level down to one job, roof, quote, or message |
| `## Decision rules` | Numbered deterministic-first rules for what to propose |
| `## Never` | Hard prohibitions; each maps to a catastrophe id in `../evals/catastrophes.v1.json` |
| `## Abstain and escalate` | When it stops, the exception it records, and which role or person it routes to |
| `## Drafts and tone` | Language and tone rules for customer, supplier, crew, and owner drafts, or `Not customer-facing.` |
| `## Receipt` | What its `did`, `doing`, `needs_from_you`, `undo`, and `do_it_myself` say for its typical actions |

The first lines carry metadata:

```text
# <Display name>

Specialist id: `<specialist_id>`
Wave: <1|2|3>
Runtime tier: <routine|hard|audit>
```

`Runtime tier` maps to the contract's provider routing; the playbook does not name a model.

## `allowlist.json`

```json
{
  "schema_version": "ironwrap.specialist-allowlist.v1",
  "specialist_id": "lead_concierge",
  "catalog_sha256": "<sha256 of the contract's embedded catalog JSON>",
  "actions": [
    { "action_id": "lead.qualify", "autonomy": "A1", "purpose": "Record a qualification proposal" }
  ]
}
```

- `action_id` must exist in the contract catalog and list this specialist in `owners`.
- `autonomy` equals the catalog level. The action class is fixed by the contract; how a delegable
  action runs for this tenant (asks first or within limits) is the owner's delegation setting,
  never the allowlist. A never-delegable action always asks first. `H` (human-only) actions are
  never allowlisted.
- `catalog_sha256` pins the catalog revision the playbook was written against. A catalog change
  makes the validator fail until the allowlist and its eval cases are re-checked.

## Change rule

A playbook, allowlist, or `COMMON.md` change ships with its eval cases in the same PR and must keep
the specialist's suite at or above its pass bar on the replay harness. A Sonnet reviewer that did
not write the change reviews it before merge.
