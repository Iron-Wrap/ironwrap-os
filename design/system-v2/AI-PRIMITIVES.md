# System v2 AI primitives

## IRW-R8d · owner decisions (read this first; this section wins)

The owner's review-meeting decisions (IRW-R8d, `output/figma-v2/COPY-AUDIT-BRIEF.md`) revise IRW-R8 for this file.
The whole system works without AI: people do every job on drawn, gated manual screens, and the AI only automates
work so that a person does not need to open those screens. Where any later part of this file disagrees with this
section, this section wins. Superseded rules stay where they are, each marked "IRW-R8d"; nothing was deleted. The
shared rules (manual surfaces, Decisions, denial wording, times, Alberta time, payments and design decisions D4 to
D7) are numbered in `TEMPLATES.md` "IRW-R8d" and cited here as "TEMPLATES IRW-R8d rule N". This file's own rules
are named R8d-1 to R8d-6, so they never collide with the TEMPLATES numbers or with the original rules 1 to 7. Audit:
`output/figma-v2/copy-audit/REPORT.md` (PD-32, G-07; I-01, I-02, I-26, K-08, K-22; V-29).

**What IRW-R8d reverses**

- "Agents own the routine work" and "every screen keeps a 'Do it myself' path" (FigJam 206:11822, 206:11594).
- Original rule 6 and the copy table's "Do it myself" way out: Edit replaces it.
- "Where the primitives go": proposal-first pages, and Decisions as the place for every Asks first and People only
  item.
- Specialists as the actors of flows.

**What stays**

- Original rules 1 to 5 and 7: one face and named specialists; people and agents look different without colour; two signals;
  Proposed is not fact; words, not codes; exact facts. Under original rule 1, callers and customers hear the Business's name:
  the speaker is Iron Wrap Exteriors, never "IronWrap", and the disclosure stays "AI receptionist at Iron Wrap
  Exteriors" with a way to reach a person (K-22). Who answers the customer's ask entry follows MD-19.
- The delegation words, the launch rule (every action with an outside effect asks first) and People only (customer
  acceptance, releasing a safety stop, waiving a gate, refunds and write-offs, legal sign-offs). They apply whenever
  the owner turns AI help on; the walkthrough's default is AI off.
- Every component, used inline on the work screen. Receipts stay the record of what the AI did, so the audit is a
  record and never a user step; Undo stays wherever a step can be undone.

**Rules for the primitives (R8d-1 to R8d-6)**

- **R8d-1. Inline on the work screen.** An agent's output sits on the screen where the person works, as `AI/Proposed value`
   (Inline, Field or Block) with Accept and Edit; a draft adds Discard, as in ASSIST-01: "not sent, not saved to the
   record" (PD-17). The screen works the same with the AI off. Field instances drawn with "Change" read as Edit until
   Board 6 is updated. "Accept" and "Edit", with "Discard" for a draft, is a written Track B lead ruling (LIBRARY-WAVE
   item 27), in line with REPORT PD-17 and section 10 delta 3; it departs from REPORT K-08, which says "Accept and
   Change".
- **R8d-2. Edit replaces "Do it myself".** On a receipt, the control that was "Do it myself" reads "Edit {object}" and opens
   the work screen with the agent's work in place; the line under the buttons follows one standard (Track E Z1 r8d: "reverts nothing" failed as jargon): "Edit {object}: {what it opens}. It does not undo anything." ("Edit the reply: opens the lead with the call notes filled in. It does not undo anything."); where the product does something next, a per-card "after" clause follows ("Your fix goes into this draft. Dana Whitford still decides."); Discard says what it removes ("Discarding removes this draft only; the last quote stays."); Accept names its object ("Accept the quote"). Undo, "Stop {the watch}" and their
   lines do not change (TEMPLATES IRW-R8d rule 4).
- **R8d-3. No specialist acts inside a flow.** A specialist is never the actor, handler or owner of a flow step. It appears
   as the source of a Proposed value or a draft ("Proposed by AI receptionist from the call"), and in receipts and
   timelines as what happened. The AI booking a visit, holding a slot or calling a customer back is a branch, never
   the happy path (TEMPLATES IRW-R8d rule 5).
- **R8d-4. Decisions is a queue for set rules.** A Needs you receipt sits on the work screen of the thing it is about. It
   also appears on Decisions only when an operation-set rule sends it to someone else. The working list until MD-01
   and MD-03 are answered: a limit, an item the person prepared (OD-23), the OD-32 margin floor, or a People only
   step for a set holder. "Who may decide" names the
   person and, where it matters, the set; never a job title or a department (TEMPLATES IRW-R8d rules 3, 6 and 7).
- **R8d-5. Times, Alberta time, payments.** Receipts, timelines, the brief and every AI message write weekday plus time and,
   in sample content and specimens, never a calendar date (live records keep the tenant's short date format for events
   older than 6 days, TEMPLATES 6.5); they never print "MST", "MDT" or any zone abbreviation, and never mention a deposit while OD-01's
   payment on completion applies (TEMPLATES IRW-R8d rules 8, 9 and 10).
- **R8d-6. Design decisions D4, D6 and D7 on AI output.** A Needs you item names the responsible person (a named
   person or, until MD-06 is answered, "Nobody yet") and the next action (D4). An AI reply to a website request confirms an enquiry only, never a booking, an order or a quote
   acceptance (D6). The AI never makes a public claim the Owner has not approved and never promises 24/7 help, an
   on-call person or a visit time; emergency means next business day (D7, pending MD-10).

**Owner decisions these rules wait on:** MD-01 and MD-03 (the Decisions working list, R8d-4), MD-06 (named person
or "Nobody yet", R8d-6), MD-10 (D7), MD-19 (who answers the customer's ask entry); the shared rules also wait on
the MDs listed in `TEMPLATES.md` "IRW-R8d".

---

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
   shown as a real job, and every claim cites approved evidence. **IRW-R8d:** callers and customers hear "Iron Wrap
   Exteriors", never "IronWrap", as the speaker; "Ask IronWrap" stays the staff entry, and the customer's entry follows
   MD-19.
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
   step can be undone. **IRW-R8d: superseded in part.** The receipt and Undo stay; "Do it
   myself" becomes "Edit {object}", which opens the work screen with the agent's work in place
   (R8d-2).
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
| Way out | Do it myself | Secondary button when the receipt is Needs you or Held; ghost button when it is Done for you. Wherever it renders, a line under the buttons starts with the bold label "Do it myself:" and says what it opens ("Do it myself: opens the lead with the call notes filled in; reverts nothing"). **IRW-R8d (R8d-2):** the control reads "Edit {object}" and the line reads "Edit {object}: {what it opens}. It does not undo anything.", with an "after" clause where the product acts next; Discard says what it removes; Accept names its object |
| Undo | Undo | Only on Done for you, as a secondary button, with its own line: "You can undo this until {time}" or "Can't be undone: {reason}". Never on Needs you, Working on it or Held: nothing is done yet, and testers read it as "undo my approval" (Track E Z1 r1 and r2 on the receipt card) |
| Stop a standing watch | Stop {the watch} | On the Done for you receipt of a standing watch ("Stop the storm watch"), in place of Undo, with one line: "Stopping ends {what it does}. You can ask IronWrap to start it again." Never "Can't be undone" for a watch |
| Entry to the face | Ask IronWrap | |
| Owner's daily summary | Brief | "Brief made 6:50 a.m. by IronWrap" |
| Found by an agent | Risk / Opportunity | glyph and word, never colour alone |

**IRW-R8d** on the copy table. The "Way out · Do it myself" row is superseded: the control reads "Edit {object}",
ranked where "Do it myself" was, with the line under the buttons saying what it opens (R8d-2). "Needs you"
is shown on the work screen, and on Decisions only for set rules (R8d-4). The "Brief" shows only when the
AI is on.

## Components

| Component | Variants | Anatomy |
|---|---|---|
| `AI/Badge` | Who (IronWrap and the 15 specialists) × Size (Small 24, Default 32, Large 48) | Rounded square, `radius/8`, `line/strong` edge, `surface/rail` fill, specialist glyph in `text/primary`. IronWrap uses the tenant brand mark. |
| `Avatar/Person` | Size (Small, Default, Large) | Circle with initials, `surface/rail` fill, `line/hairline` edge |
| `AI/Name` | Size (Row, Header) | Badge, name ("AI estimator"), optional line ("Prices quotes") |
| `AI/Delegation` | Setting (Reads and watches, Prepares, Acts within your limits, Asks first, People only, Paused, Off) | Outlined pill, glyph plus words, ink only |
| `Signal chip` (added kinds) | Proposed, Working on it | Proposed: open diamond, dotted edge. Working on it: loader glyph |
| `AI/Proposed value` | Kind (Inline, Field, Block) | Open diamond, dotted edge, "Proposed" caption with who proposed it and from what; Field adds Accept and Edit (IRW-R8d; was "Accept and Change") |
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

**IRW-R8d** on the components. `AI/Proposed value` Field: Accept and Edit (was "Accept and Change"; LIBRARY-WAVE item 27); a draft adds
Discard (R8d-1). `AI/Receipt` actions: "Edit {object}" in place of Do it myself (R8d-2).
`AI/Ask entry` stays on every screen as an addition for ad-hoc questions; it is never the only way to do a job.

## Receipt fields and the contract

The contract (`docs/AI-TEAM-CONTRACT.md`, JSON block `ironwrap_ai_team_contract_v1`) defines 14 receipt fields.

| Contract field | Where it shows |
|---|---|
| specialist_id | Badge and "AI ..." name (`display_name` from the contract) |
| action_id | The action's `name` from the contract ("sending a customer message"); the id only in System details |
| run_id | System details |
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
| do_it_myself (surface, context) | "Do it myself" button and the manual screen it opens. **IRW-R8d:** the button reads "Edit {object}" and the surface is the work screen itself (R8d-2); the contract field name does not change |

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
| outcome abstained: provider_unavailable | Held: its AI service is not answering; "Do it myself" (**IRW-R8d:** "Edit {object}"; the work screen works without it) |
| outcome abstained: no_qualified_route | Held: no AI model is cleared for this work yet; "Do it myself" (**IRW-R8d:** "Edit {object}"; the work screen works without it) |
| outcome abstained: injection_suspected | Held: the message looked like an attempt to trick it; a person reads it |
| outcome abstained: person_requested | Held: the customer asked for a person |
| outcome abstained: action_unregistered, policy_missing, out_of_scope, no_progress | Held: this is not something it may do; a person decides |
| outcome abstained: safety_event | Held: a work stop or safety report stopped it; a person takes over |
| outcome abstained: emergency | Held: an emergency; it paged a person and does nothing else |

Delegation in the contract: `default_delegation` asks_first → "Asks first"; within_limits → "Acts within your
limits"; off_until_enabled → "Off until you turn it on". The owner's `shadow` setting, never a start state → "Practice
only"; its receipts read "Practice run" and never show under Done for you or in Decisions. `human_only` (16 actions:
delegation.set, policy.activate, settings.apply, onboarding.go_live, acceptance.customer_decision,
terms.legal_signoff, safety_stop.release, hold_point.release, completion.accept, payee.change_details,
payee.unfreeze, refund.issue, write_off.record, filing.submit, gate.waive, access.change) → "People only" with no
control.
`protective` (17 actions: stop, hold, block, freeze, escalate, quarantine, page, revoke a portal link, raise a finding,
hold a specialist) → "Always on: protects you": never "Asks first", and they keep running while a specialist or the
whole team is paused. `delegable: false` with asks_first (41 actions, for example storm_mode.propose,
inbound.release, consent.record, gate.clear, claim.approve, finding.close) → "Always asks first" with no control.
Contract version: catalog sha `59e0eaabfdcf8267e15abc387f3743ac03054a6f4f712d64b3260d3fa37879f6` (16 specialists,
163 actions, 116 watches; every action has a plain `name`). Builders read
[`docs/AI-TEAM-CONTRACT.md`](../../docs/AI-TEAM-CONTRACT.md) itself; a local copy, such as one under the git-ignored
`output/`, is current only while its catalog sha equals this one.

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

**IRW-R8d** on this list. The Ask entry bullet and the Records bullet stay. Superseded:
- "Decisions: only Asks first and People only items". Each Needs you receipt sits on the work
  screen of the thing it is about; Decisions is the queue only for what an operation-set rule
  sends to someone else (R8d-4).
- "Proposal-first pages". There are none. The manual screen is the page, and the agent's
  proposal sits inline on it as `AI/Proposed value` with Accept and Edit (R8d-1 and R8d-2).
- "Now": the macro strip and brief sections show only when the AI is on; the screen works
  without them.
- Flow pages (the walkthrough): no specialist is a step's actor or handler; AI-on variants show
  the same step with Proposed values inline (R8d-3; PD-17).
