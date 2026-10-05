# IronWrap OS zero-learning gate

Owner directive (2026-10-02): staff must be able to use the final UI with zero learning. New staff get no training, no manual and no walkthrough. This gate adapts the HELM zero-training gate used across Mindburn Labs products to Iron Wrap's staff and places.

A surface that fails the gate does not move on:
- A Figma slice does not go to code.
- A PR does not merge.
- A QA build is not accepted.

## Z1 First-time task success

Testers get a fresh context each, only the screens (PNG), and the task as one sentence in the words a foreman or office manager would use. No docs, no glossary, no product vocabulary. Each tester answers what they would tap or click, in order, and why. Two tiers:
- a novice proxy on Haiku;
- an independent proxy on Sonnet, or a GPT tester via Codex when available.

| # | Who / where | Task (as told to the tester) |
| --- | --- | --- |
| T1 | Owner, desktop | "Is the Harlow job on track? If not, what is stuck and is it costing us?" |
| T2 | Owner, desktop | "Something is waiting for you on this job. Approve it." |
| T3 | Owner, desktop | "The shop found a bad part. Find which coil it came from and which measurement the cut was based on." |
| T4 | Owner, desktop | "What did the assistant do on this job, and does it need anything from you?" |
| T5 | Owner, desktop | "Who approved the quote, and what did they see when they approved it?" |
| T6 | Crew lead, phone, no signal | "Take a photo of the south eave." |
| T7 | Crew lead, phone, no signal | "Record a measurement: south eave is 42 feet 7 and three-eighths inches." |
| T8 | Crew lead, phone | "You see a safety problem. Stop the work." |
| T9 | Crew lead, phone, no signal | "Did your photos get sent to the office?" |
| T10 | Shop lead, tablet, gloves | "Check whether you can cut from this coil." |
| T11 | Shop lead, tablet, gloves | "Add a photo of the bad first piece to the problem report." |
| T12 | Shop lead, tablet | "The scanner won't read the label. Look the coil up another way." |
| T13 | Customer, phone | "When is my roof being done, and what do I owe?" |

Pass requires all three:
- each tier completes at least 90% of the covered tasks on the first try;
- no task fails in both tiers;
- the median number of actions is no more than the expert path plus one.

A task the screens do not cover is reported as a coverage gap, never counted as a pass.

## Z2 Plain language

- **Everyday words on primary surfaces.** Internal or system terms may appear only inside an explicit "Details" disclosure. Banned on primary surfaces: work package, disposition, derived phase, outbox, idempotency, effect, capability, principal, receipt hash, digest, SHA, envelope, payload, tenant, grant.
- **Every code needs a plain label.** A code may appear, but only beside a plain label: "Quality problem NCR-31", "Coil PMS-2231", "Survey reading S-7", "Cut list C-14", "Change order CO-3". The plain label comes first.
- **Trade words stay but read plainly.** Trade words staff already use (eave, coil, lot, flashing, first piece, change order) are allowed. Anything else is explained in place the first time it appears on a screen.
- **The agent is called "Assistant".** On primary surfaces it is the Assistant. "HELM" appears only in Details. Its three outcomes are "Done for you", "Blocked" and "Needs you".

Pass: zero banned terms on primary surfaces, and every code carries its plain label.

## Z3 Interaction rules (binary; every item must pass)

1. **Shortcuts only accelerate.** Every keyboard shortcut (L, J/K, 1–4, ⌘K) has a visible, labelled control on screen. No action exists only as a key, a gesture or a hover.
2. **One primary action per context**, labelled verb + object ("Approve change order", "Take photo", "Stop work"). Never "Open", "Go" or "Submit".
3. **Same thing, same place, same word** on desktop, phone and tablet.
4. **Exactly one next step** in every empty, blocked, held, offline and error state, in plain words. No dead ends.
5. **Irreversible actions state their consequence** before confirming. Everything else can be undone.
6. **Unknown is shown as unknown** ("Not measured yet", "Owner to set"), never as 0, OK or a guess. No pre-filled safety answers.
7. **Field and shop sizing.**
   - Primary targets are 56–64 px and every target is at least 48 px.
   - Primary actions and Stop work sit in the thumb zone.
   - Text is 7:1 in sun mode.
   - Nothing requires precision taps with gloves.
8. **Offline is honest.** Each saved item is visible on the device with its state (saved on this phone / sending / sent / needs attention).
9. **Feedback is immediate.** Every tap gets feedback in under 100 ms, a skeleton appears within 200 ms, and nothing shifts the layout.
10. **Accessibility.** Everything is keyboard reachable and meets WCAG 2.1 AA. Light, dark and sun modes are all provided.

## Z4 Side by side with the bar

Run the owner's five jobs against the best of Linear, Arc and the Rivian app for each job:
- see the state of one thing;
- approve;
- trace where something came from;
- capture in the field;
- stop.

Each job gets a verdict of better, equal or worse with a one-line reason. One "worse" fails the gate.

## Where it runs

| Stage | Run by | Fixes by |
| --- | --- | --- |
| Direction comps and Figma slices, before code | Independent testers (a novice-proxy model and a stronger model, fresh context, never the designer), then the program controller's gate (frames plus the key) | UI owner |
| PR, before merge | PR owner, with evidence | owning lane |
| QA build | Controller acceptance | owning lane |

Results (screens, the key, tester answers and the verdict) are dated evidence, so they live in the private evidence store, not in this repository.
