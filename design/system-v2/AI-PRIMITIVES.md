# System v2 AI primitives

The parts every IronWrap screen uses to show the AI team at work. They extend System v2
(`TOKENS.md`, the Figma boards on `03 Components`) and follow the owner decisions IRW-R8 and
the zero-learning gate (`../ZERO-LEARNING-GATE.md`). The roster, the action catalog and the
receipt fields come from `docs/AI-TEAM-CONTRACT.md`; where this file and the contract
disagree, the contract wins and this file is corrected.

Figma: `03 Components` › `Board 6 · AI team`. Builders use the instances, never copies.

## Rules

1. **One face, named specialists.** The face is the tenant's brand name ("IronWrap" for
   Iron Wrap Exteriors). Its entry reads "Ask IronWrap". Specialists are named "AI" plus their
   job in plain words: AI receptionist, AI estimator. A customer always sees the disclosure
   "AI receptionist at Iron Wrap Exteriors" and a way to reach a person. A public marketing post that a person
   approved in its exact version carries no AI disclosure (owner decision); no generated or altered job photo is
   shown as a real job, and every claim cites approved evidence.
2. **Agents and people look different without colour.** People are a circle with initials.
   Agents are a rounded square with the specialist's glyph. The name always says "AI".
3. **Two signals stay two.** Red means held or stopped, blue means the viewer is waited on.
   Agent identity, autonomy and "proposed" never use colour; they use shape, glyph and words.
4. **Proposed is not fact.** Anything an agent proposed and nobody has accepted carries the
   word "Proposed", the open-diamond glyph and a dotted edge. Facts have none of these.
   "Not known yet" keeps its dashed edge. A proposed value is never totalled with facts
   unless the total also says "Proposed".
5. **Words, not codes.** People see the delegation words only. Action classes (A0 to A3,
   H), permits, tools, models and run ids live behind "System details".
6. **Every agent step has a receipt** with a way out: "Do it myself" opens today's manual
   screen with the agent's work filled in where it helps, and "Undo" appears whenever the
   step can be undone.
7. **Exact facts.** Receipts restate exact amounts, versions and recipients and cite where
   each fact came from. Narrative is allowed only around cited facts.

## Delegation words

The action class is fixed by consequence; the delegation setting is per action and per
specialist, and only the owner changes it. Agents never change their own setting.

| Class (System details only) | Words people see | Meaning |
|---|---|---|
| A0 | Reads and watches | Runs all the time; changes nothing |
| A1 | Prepares | Drafts and fills inside IronWrap; nothing leaves; can be undone |
| A2 | Acts within your limits | Acts outward inside an owner-set ceiling (amount, count, recipients) and tells you after |
| A3 | Asks first | A person approves each time; the start state for every action with an outside effect |
| H | People only | Never delegable: customer acceptance, releasing a safety stop, waiving a gate, refunds and write-offs, legal sign-offs |
| (setting) | Paused | The owner paused this specialist or action; nothing new starts |
| (fixed) | Always on: protects you | Protective actions; cannot be set to Asks first; keep running while paused |
| (fixed) | Always asks first | Actions the owner can never delegate (no control is shown) |
| (setting) | Off until you turn it on | An action the owner has not enabled yet (for example live answering, contract action `conversation.answer_live`); nothing happens until it is turned on |

## Copy table (one name per state)

| State | Words | Signal |
|---|---|---|
| Agent finished a step | Done for you | ink, tick glyph; after a person approved an outside action and the tool ran, the receipt also says who approved it in Checked |
| A person did it (answered, approved, released) | Done by {name} | the person's initials circle, tick glyph, never the AI badge; when the answer still has to reach a phone or another system: "Answered by {name} · waiting for the phone" with a clock glyph |
| Nothing in progress (empty Working on it) | Nothing in progress right now. | caption under it: "When the AI team starts something, it shows here."; no "See all" link to an empty list |
| Agent is working | Working on it | ink, loader glyph |
| A person must decide | Needs you | blue |
| Agent cannot go on | Held | red, with the reason in words |
| A person undid the step | Undone by {name} | ink, undo glyph |
| Agent output not accepted yet | Proposed | ink, open diamond, dotted edge |
| Section: sources | Where this came from | |
| Section: why it waits for a person | Why it asks you | |
| Section: provider read-back | Checked | "Checked in QuickBooks today 10:31" / "Not checked yet" |
| Way out | Do it myself | Secondary button when the receipt is Needs you or Held; ghost button when it is Done for you |
| Undo | Undo | Secondary button on Done for you (the step most likely wanted after the work is done), ghost button on Needs you; always with "You can undo this until {time}" or "Can't be undone: {reason}" |
| Entry to the face | Ask IronWrap | |
| Owner's daily summary | Brief | "Brief made 6:50 a.m. by IronWrap" |
| Found by an agent | Risk / Opportunity | glyph and word, never colour alone |

## Components

| Component | Variants | Anatomy |
|---|---|---|
| `AI/Badge` | Who (IronWrap and the 15 specialists) × Size (Small 24, Default 32, Large 48) | Rounded square, `radius/8`, `line/strong` edge, `surface/rail` fill, specialist glyph in `text/primary`. IronWrap uses the tenant brand mark. |
| `Avatar/Person` | Size (Small, Default, Large) | Circle with initials, `surface/rail` fill, `line/hairline` edge |
| `AI/Name` | Size (Row, Header) | Badge, name ("AI estimator"), optional line ("Prices quotes") |
| `AI/Delegation` | Setting (Reads and watches, Prepares, Acts within your limits, Asks first, People only, Paused, Off) | Outlined pill, glyph plus words, ink only |
| `Signal chip` (added kinds) | Proposed, Working on it | Proposed: open diamond, dotted edge. Working on it: loader glyph |
| `AI/Proposed value` | Kind (Inline, Field, Block) | Open diamond, dotted edge, "Proposed" caption with who proposed it and from what; Field adds Accept and Change |
| `AI/Source chip` | Kind (Record, Document, Message, Photo, Reading) | Glyph, plain label, code in mono after it |
| `AI/Receipt` | State (Done for you, Working on it, Needs you, Held, Undone) | Header: badge, name, time, state chip. Title. Rows: Did, Doing, Needs you, Where this came from, Why it asks you, Checked. Actions: the one primary action (Needs you only), then Do it myself and Undo ranked as in the copy table. System details (closed) |
| `AI/Receipt row` | State (as above) | 56 px list row: small badge, one-line summary, state chip, one outlined action (the row never adds a second primary) |
| `AI/Receipt · Phone` | State (as above) | The receipt at 358 px: labels above values, state and delegation under the name, full-width 48 px actions |
| `AI/Receipt row · Phone` | State (as above) | 64 px or taller row; the whole row opens the receipt; state under the summary |
| `AI/Ask entry` | Place (Desktop, Compact, Crew, Customer) | Desktop: field "Ask IronWrap or search work" with ⌘K. Compact: 48 px button. Crew: 64 px button with microphone. Customer: "Ask a question" with the AI disclosure |
| `AI/Message` | From (Person, IronWrap, Specialist) | Bubble text; IronWrap messages carry source chips under every fact and may hold one receipt |
| `AI/Conversation` | Place (Docked, Sheet) | Header with badge and close, messages, composer with microphone and send |
| `AI/Brief section` | Kind (Needs you, Found, Done for you, Working on it) | Header with count, then receipt rows |
| `AI/Macro tile` | State (Known, Not known yet) | Label, exact value, change line, source line |
| `AI/Timeline item` | Actor (Person, Specialist, IronWrap, Customer) | Day and time, avatar or badge, what happened, receipt link |
| `AI/Alert` | Kind (Risk, Opportunity) × For (Needs you, For your information) | Glyph and word, "Found by" badge, title, exact evidence with sources, impact, "Review the proposal" and "Not now" |

## Receipt fields and the contract

The contract (`docs/AI-TEAM-CONTRACT.md`, JSON block `ironwrap_ai_team_contract_v1`) defines 14 receipt fields.

| Contract field | Where it shows |
|---|---|
| specialist_id | Badge and "AI ..." name (`display_name` from the contract) |
| run_id, action_id | System details |
| did | "Did" row and the card title |
| doing | "Doing" row; state Working on it |
| needs_from_you (reviewer_role, person_id, ask) | "Needs you" row, the one primary action and who may decide |
| sources (fact_id, version, hash) | "Where this came from" source chips; hash only in System details |
| policy (policy_id, version, result, checks, reason_codes) | "Why it asks you" or "Why it waits" in plain words; ids in System details |
| permit (kind, permit_id, approval_id, approved_by, delegation_id) | "Approved by {name}" in Checked; the rest in System details |
| tool (name, binding, idempotency_key, request_hash) | System details only |
| readback (source, reference, response_hash, matched) | "Checked" row ("Checked in QuickBooks today 10:31: matches") |
| outcome | The state chip (below) |
| undo (mode, action_id, available) | Undo button and its window, or "Can't be undone" with the reason |
| do_it_myself (surface, context) | "Do it myself" button and the manual screen it opens |

Outcome and policy result to words:

| Contract | Words people see |
|---|---|
| policy.result needs_approval | Needs you |
| outcome succeeded | Done for you (after an approval: "Approved by {name}" in Checked) |
| outcome unknown, no_readback_yet | Working on it ("Waiting for QuickBooks to confirm") |
| outcome failed: declined, superseded, done_by_person | Undone by {name} / Replaced / Done by {name} |
| outcome failed: policy_denied, tool_refused, provider_rejected, readback_mismatch, approval_expired | Held, with the reason in one sentence and one next step |
| outcome abstained: fact_missing, fact_stale, fact_conflict, citation_unverifiable | Held: a fact is missing / out of date / two records disagree / the source could not be checked |
| outcome abstained: ceiling_reached | Held: it reached the limit you set |
| outcome abstained: provider_unavailable | Held: its AI service is not answering; "Do it myself" |
| outcome abstained: injection_suspected | Held: the message looked like an attempt to trick it; a person reads it |
| outcome abstained: person_requested | Held: the customer asked for a person |
| outcome abstained: action_unregistered, policy_missing, out_of_scope, no_progress | Held: this is not something it may do; a person decides |
| outcome abstained: safety_event | Held: a work stop or safety report stopped it; a person takes over |
| outcome abstained: emergency | Held: an emergency; it paged a person and does nothing else |

Delegation in the contract: `default_delegation` asks_first → "Asks first"; within_limits → "Acts within your
limits"; off_until_enabled → "Off until you turn it on". `human_only` (12 actions: delegation.set, policy.activate,
acceptance.customer_decision, terms.legal_signoff, safety_stop.release, payee.change_details, payee.unfreeze,
refund.issue, write_off.record, filing.submit, gate.waive, access.change) → "People only" with no control.
`protective` (17 actions: stop, hold, block, freeze, escalate, quarantine, page, revoke a portal link, raise a finding,
hold a specialist) → "Always on: protects you": never "Asks first", and they keep running while a specialist or the
whole team is paused. `delegable: false` with asks_first (18 actions, for example storm_mode.propose,
inbound.release, consent.record, gate.clear, hold_point.release, claim.approve, finding.close) → "Always asks first"
with no control. Contract version: `6efb04a5` on main (16 specialists, 156 actions, 115 watches; adds crew_item.propose_resolution, A1, field_safety, watch crew_item_unconfirmed); a copy for builders
is `output/figma-v2/ai-kit/AI-TEAM-CONTRACT.md` and `contract.json`.

## Where the primitives go

- Every office shell: the top bar entry becomes `AI/Ask entry` Desktop or Compact; the
  docked `AI/Conversation` opens from it. Crew phone: `AI/Ask entry` Crew above the tab bar.
  Customer pages: `AI/Ask entry` Customer.
- Now: `AI/Macro tile` strip, then `AI/Brief section` Needs you, Found, Done for you,
  Working on it.
- Decisions: only "Asks first" and "People only" items, each an `AI/Receipt` in Needs you.
- Records (job, property and roof): `AI/Timeline item` mixing people and agents; proposed
  facts as `AI/Proposed value`.
- Proposal-first pages: the agent's proposal on top (`AI/Receipt` or a page-specific proposal
  card using `AI/Proposed value`), today's manual screen behind "Do it myself".
