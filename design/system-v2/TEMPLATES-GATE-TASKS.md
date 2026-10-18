# Template gate: zero-learning tasks

Tasks for the template gate (Phase 2 of `output/figma-v2/SCOPE-IRW-R8b.md`): Z1 to Z4 of `../ZERO-LEARNING-GATE.md`
run on the template Figma board, whose frames are the examples of `TEMPLATES.md` section 8 filled with the
canonical facts of `output/figma-v2/SAMPLE-DATA.md`.

Method, as in every Track B round: each task goes to a Haiku tester and a Sonnet tester, each in a fresh context,
with only the PNGs listed for the task and the task sentence. No docs, no glossary. Each tester says what they
would tap or click, in order, and why. A Sonnet judge, who did not build the frames, counts actions (taps and
clicks only; reading, scrolling, typing and calls are not counted), checks the answer against "Pass answer", and
judges Z2, Z3 and Z4 on the same frames. Pass: each tier completes at least 90% of the covered tasks on the first
try, no task fails in both tiers, and the median actions are at most the expert path plus one. A task whose step
is not drawn is a coverage gap, never a pass.

"View" names the example and its state. "Frames" lists what the tester gets. Fixed-surface frames that a task
lands on (Decisions detail, receipt) come from the fixed-surface pages and are given as the end frame only.

## `list`

| # | Who, where | Task (as told to the tester) | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TL1 | Owner, desktop | "Ask the system which projects can't move forward right now, and why." | 8.1 "Which jobs are stuck?" | HOME-12 just opened; the HOME-12 answer with "See the 3 jobs" (`1078:771168`, `output/figma-v2/ai-home/HOME-12-desktop-light-which-jobs-stuck-view-link--1078-771168.png`); the `list` view, office light | 1. Click "Ask IronWrap or search work". 2. Type the question, click "Send". 3. Click "See the 3 jobs". Then read. (3 + typing) | Three jobs: Linda Chu's (work stopped, rotten deck boards), Kyle Brandt's (no crew yet; AI scheduler proposes Sam Keewatin's crew Thu 07:00), Helen Park's (material shortage; AI buyer proposes a Westman Steel order) |
| TL2 | Owner, phone | "On your phone, get to the decision for the project where the crew had to halt." | 8.1, phone | The `list` view, phone light, with the bottom action bar; end frame: the work stop decision detail (HOME-05 phone) | 1. Tap "Review the work stop" in the bottom bar. (1) | Lands on the work stop decision; says only Dana Whitford or Tom Lachance can release it |
| TL3 | Owner, desktop | "The system's AI has gone quiet. Can you still tell which projects can't move forward, and is anything fresh being suggested?" | 8.1, AI unavailable state of the open view | The `list` view, office light, AI unavailable | Read the notice and the rows. (0) | Yes: the list still updates from the records; nothing new is proposed while the AI is down |

## `record`

| # | Who, where | Task | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TR1 | Owner, desktop | "Is the Chu job on track? If not, what is stuck and is it costing us?" | 8.2 example 1, morning | The job record, office light, whole page | Read the summary cells. (0) | Not on track: work stopped for rotten deck boards on the north slope; 3 decisions need you; the cost of the stop is not known yet, because crew idle time is not tracked and the deck repair is not priced |
| TR2 | Owner, desktop | "What has IronWrap's AI done on this project so far, and does any of it wait on you? Get to the most pressing item." | 8.2 example 1 | The job record, office light; end frame: the work stop decision detail (HOME-05) | Read "AI team on this job". 1. Click "Review the work stop". (1) | Four AI steps: correction drafted for the work stop (needs you, people only), reply to Linda Chu drafted (needs you), payment to apply found (needs you), deck repair change order being priced (working on it); the work stop comes first |
| TR3 | Estimator on the Sales desk (Priya Nand), desktop | "What do we know for sure about the top of the home at 1180 Tamarack Bend, what is only a guess, and where do you settle the guess?" | 8.2 example 2 | The property and roof record, office light; end frame: the pitch decision detail | Read "The roof". 1. Click "Review the pitch". (1) | Known: area 2,860 sq ft over 6 facets and facet areas (read by the AI measurer, not checked by a person yet), shingle layers, gutters pulling away; guess: pitch 6/12, proposed because page 4 was unreadable; warranty not known yet; the pitch is settled on its decision page |

## `comparison`

| # | Who, where | Task | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TC1 | Owner, desktop | "Which vendor should Helen Park's metal come from, and how much does that choice save?" | 8.3 | The `comparison` view, office light | Read the columns. (0) | Westman Steel, proposed by the AI buyer: CAD 109.60 less landed than Vicwest, free delivery, arrives on the needed-by day, Fri |
| TC2 | Owner, desktop | "You agree with the AI's pick. Go ahead and buy the material." | 8.3 | The `comparison` view; then HOME-05 purchase order detail and its place sheet (fixed) | 1. Click "Review purchase order". 2. Click "Place purchase order" on the decision. 3. Confirm on the sheet. (3) | The order to Westman Steel, CAD 1,694.00, is placed once; it sends the order to Westman Steel |
| TC3 | Owner, phone | "You don't want the AI's pick. Weigh the vendors by hand instead." | 8.3, phone | The `comparison` view, phone light | 1. Tap "Compare suppliers myself". (1) | Opens the supplier table to compare by hand |

## `report`

| # | Who, where | Task | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TP1 | Owner, desktop | "Are we losing money on any of our projects?" | 8.4 | The `report` view, office light | Read the status line. (0) | No job is below zero margin; 1 job (Ruth Okafor) is CAD 420.00 over its estimate; 4 jobs are not known yet |
| TP2 | Owner, desktop | "Ruth Okafor's project ran over budget. By how much, and what does the AI suggest to learn the reason?" | 8.4 | The `report` view, office light | Read the alert and the proposal. (0) | CAD 420.00 over (CAD 6,520.00 against CAD 6,100.00); margin 30.6% against 35.0% planned; the cause is not known; proposed: Tom Lachance counts the material left |
| TP3 | Owner, phone | "For which projects can't we tell yet whether they make a profit, and why not?" | 8.4, phone | The `report` view, phone light | Read the stacked table. (0) | Linda Chu (not finished; deck repair change order being drafted), Nadia Petrov, Marcel Dufresne, Paul Moreau (no costs posted yet) |

## `timeline`

| # | Who, where | Task | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TH1 | Owner, desktop | "What went on at the Chu job yesterday, and who halted the crew?" | 8.5 | The `timeline` view, office light | Read. (0) | Sam Keewatin checked in 07:02, took a photo of the north slope deck 09:08 and stopped the work 09:12; Dana Whitford approved the deposit invoice 15:10; the AI bookkeeper sent it 15:12; Linda Chu emailed 15:40 |
| TH2 | Owner, desktop | "Show only the AI's own steps on this project, then check exactly what the AI bookkeeper did about Linda Chu's first bill." | 8.5 | The `timeline` view, All and AI team filter states; end frame: the receipt (fixed, `1078:771840`, `output/figma-v2/ai-home/HOME-01-receipt-deposit-invoice-sent--1078-771840.png`) | 1. Click "AI team". 2. Click "See receipt for sending the deposit invoice". (2) | The AI bookkeeper sent the CAD 3,150.00 deposit invoice to QuickBooks after Dana Whitford approved it; it matches QuickBooks, checked today 10:31 |
| TH3 | Owner, desktop | "Who signed off on Linda Chu's first bill, and what was in front of them when they did?" | 8.5 | The `timeline` view; end frame: HOME-05 approved result (fixed, `1078:770863`, `output/figma-v2/ai-records/HOME-05-deposit-invoice-approved-result--1078-770863.png`) | 1. Click "See what she saw" on the approval event. (1) | Dana Whitford, yesterday 15:10; she saw CAD 3,150.00 (CAD 3,000.00 + GST 150.00), deposit invoice V1, to QuickBooks |

## `schedule`

| # | Who, where | Task | View | Frames | Expert path | Pass answer |
|---|---|---|---|---|---|---|
| TS1 | Owner, desktop | "Where will Sam Keewatin's team be over the coming days, and which of its projects are blocked?" | 8.6 | The `schedule` view, office light | Read the grid. (0) | Wed: Linda Chu's job 06:30 (cannot start, work stop open) and Nadia Petrov's 07:00; Thu: Kyle Brandt's, proposed; Fri: not set yet; Sat: Marcel Dufresne's (Dev Sandhu's training to verify); Linda Chu's cannot start |
| TS2 | Owner, phone | "Kyle Brandt's project has nobody assigned to it. Find the AI's suggestion and get to where you settle it." | 8.6, phone | The `schedule` view, phone light, Thu tab; end frame: the crew and date decision (fixed) | 1. Tap "Thu". 2. Tap "Review crew and date". (2) | Proposed by the AI scheduler: Sam Keewatin's crew, Thu 07:00, weather, certificates and delivery checked; decided on its decision page |
| TS3 | Owner, desktop | "Paul Moreau's project has no day to begin. Have the system draft one for you to okay, without booking anything yourself." | 8.6, and its after-press state | The `schedule` view; the same view after the press (row shows Working on it) | 1. Click "Prepare a start date for your approval". (1) | The AI scheduler prepares a start date; it appears on Decisions for approval; nothing is booked or sent until a person approves |

## Frames the template board must draw for these tasks

| Template | Frames |
|---|---|
| `list` | Office light, office dark, phone light, phone dark; AI unavailable; loading; empty ("No job is stuck"); offline |
| `record` | Job record: office light, dark, compact, phone light, dark; loading; one section failed (money); AI unavailable; stale QuickBooks; offline; crew phone sun (crew scope, money hidden); work stop released (afternoon); crew items on top (IW-1031). Property record: office light, dark, phone light; loading; empty record |
| `comparison` | Office light, dark, phone light; empty (one quote); stale quote |
| `report` | Office light, dark, phone light; loading; stale QuickBooks |
| `timeline` | Office light, dark, phone light; AI team filter; older events loaded; empty; crew phone sun |
| `schedule` | Office light, dark, phone light (day tabs); after "Prepare a start date for your approval"; crew phone sun ("My week"); empty; offline |

Every frame gets a keyboard-focus twin for one control, and every phone frame in sun mode where the template is
allowed on the crew phone (ZL-15).
