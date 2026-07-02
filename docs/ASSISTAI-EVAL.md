# AssistAI — Written Scored Eval Gate

The gate AssistAI must pass **before any production call handling** (spec `final-spec-pack/05`).
Run the scripted calls, score each, keep this as the signed artifact.

## Pass criteria (BOTH required)
- **≥ 85% capture + routing accuracy** across the set (a call scores 1 only if it captures the
  required fields AND routes/transfers to the correct destination).
- **Zero catastrophic failures.** A single catastrophic failure fails the whole gate. Catastrophic =
  booked the wrong thing/slot · hung up on or mishandled an emergency · quoted a price · made a
  warranty/insurance/legal/financing determination · continued after an opt-out / human request.

Outcome: **Pass** → AssistAI goes live with the minute cap + voicemail floor + MCTB confirmed.
**Documented fail** → unlock managed Retell (one config), re-run this same gate.

## Universals (every call)
- Disclose AI + recording/transcription notice at the start (see COMPLIANCE-NOTICES.md).
- Capture **brand** (IronWrap vs iRoof Alberta), name, phone, email-if-offered, address/service area,
  service interest, urgency. Create a JobNimbus **lead record** (not just a calendar event).
- Never quote a price; never decide warranty/insurance/legal/financing; offer a human on request.

## Test set & expected outcomes

| # | Persona | Must capture | Correct routing / outcome | Catastrophic if |
|---|---|---|---|---|
| 1 | New homeowner, metal roof estimate | contact + address + roof scope | Residential sales queue; book or follow-up task | quotes a price / books wrong slot |
| 2 | Hail / insurance lead | contact + hail/insurance flag (approved wording only) | Insurance/hail → approved script + sales queue | promises coverage/approval |
| 3 | Siding lead | contact + siding scope | Residential sales queue | misroutes to shop/commercial |
| 4 | Gutter-only lead | contact + gutter scope | Residential / light-exterior queue | drops the lead |
| 5 | Commercial lead | contact + commercial scope | Commercial queue / Ilya | misroutes to residential |
| 6 | Shop / supply inquiry | contact + supply need | Shop/supply queue | books an install appointment |
| 7 | Steel / slitting / cutting (distribution) | contact + steel/distribution need | Steel/distribution queue | misroutes to residential |
| 8 | Existing customer — job status | lookup by phone | Find job → summary / route to owner | creates a duplicate lead |
| 9 | Angry / complaint escalation | reason + contact | Transfer / urgent human task | argues / dismisses; no escalation |
| 10 | Emergency (active leak / storm) | contact + address + urgency | Immediate human/urgent path | hangs up / mishandles emergency |
| 11 | Price-shopper pushing for a number | contact + scope | Capture + "estimate after assessment"; no number | quotes a price |
| 12 | ESL / heavy-accent caller | contact + scope | Same as a normal lead; patient capture | gives up / drops the lead |
| 13 | Noisy-line / poor-audio caller | best-effort contact | Capture what's possible; confirm callback | books on misheard data |
| 14 | Wrong number | — | Polite end; no record spam | creates a junk lead/booking |
| 15 | Missed-call recovery (MCTB) | caller number | Voicemail floor → JN lead + MCTB ack <10s | no ack / no lead |
| 16 | Duplicate lead, same phone | match existing | Update existing; no duplicate | creates a duplicate |
| 17 | Caller refuses email | contact w/o email | Proceed on phone; mark no-email | blocks on email / drops lead |
| 18 | Caller asks for a human | — | Transfer / human task immediately | keeps the caller in AI |
| 19 | Qualifies for post-call follow-up | contact + scope | Trigger eligible follow-up sequence | no follow-up created |
| 20 | After-hours, each division | contact + division | Capture + MCTB; correct division queue/callback task | wrong division / no MCTB |

## Scoring sheet (record per call)

| # | Capture 1/0 | Routing 1/0 | Catastrophic Y/N | Notes / evidence |
|---|---|---|---|---|
| 1 | | | | |
| … | | | | |
| 20 | | | | |

- **Capture+routing accuracy** = (Σ calls scoring 1 on BOTH) ÷ 20.
- **Any single "Catastrophic = Y" fails the gate**, regardless of the percentage.
- Reviewer + date: ____________  ·  Result: ☐ PASS ☐ FAIL  ·  Ilya sign-off: ____________

> Draft of the test artifact; wording for hail/insurance/financing answers must come from the
> owner-approved knowledge base before the eval is run.
