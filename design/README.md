# IronWrap OS design

This folder holds the design system work for the IronWrap OS PWA: the visual direction, the System v2 tokens and the gate every surface passes before it reaches code. Company target, authority and capability claims live in `docs/`; nothing here overrides them.

## Places

One codebase serves four places, and every design decision names the place it is for:

| Place | Who | Device and conditions |
| --- | --- | --- |
| Office | owner, ops, sales and estimating, accounting | desktop, dense, keyboard first |
| Shop | production with shop, warehouse and quality grants | tablet or kiosk beside the brake, slitter and roll former; gloves, noise, read at one metre, scan first |
| Field | crew lead and installers | phone, one hand, sun, wind and cold, bad signal; capture never loses data |
| Customer | homeowner, payer, decision-maker | phone, calm; "when is my job happening" and "what do I owe" |

## Direction: Spine (owner decision, 2026-10-02)

- A job is one chronological spine of raw events (photo, measurement, note, scan, message). Stage, holds, approvals and money are lenses laid over that spine, not tabs that split the job.
- The owner's Job view opens with a brief of at most four sentences, assembled from templates over job state and never free-written by a model. Every claim links into the spine.
- Lineage ("where this came from") opens as its own view from any event, drawn in the same language: survey reading, design, cut list, coil, parts, quality problem, fix.
- Two signals, one meaning each: red means held or stopped, blue means the viewer is the one being waited on. Everything else is graphite ink, a glyph and words.
- Brand: the IronWrap shield and wordmark are the only fixed assets. The one brand idea is the standing-seam panel: the stage track is drawn as a panel profile and the spine line as a seam seen from above.
- Agent work appears as "Assistant" with three outcomes: done for you, blocked, needs you. Its receipt sits behind Details.

## Files

| File | What it is |
| --- | --- |
| [`ZERO-LEARNING-GATE.md`](./ZERO-LEARNING-GATE.md) | The binding gate: first-time task success with novice testers, plain language, interaction rules, side by side with the quality bar |
| [`system-v2/TOKENS.md`](./system-v2/TOKENS.md) | System v2 token specification: colour modes per place, density modes, type, motion, focus, the standing-seam brand tokens |
| `system-v2/tokens.json` | The tokens in W3C Design Tokens format; the source the CSS and Figma variables are generated from |
| `system-v2/contrast-check.mjs` | Zero-dependency contrast proof over every declared text and control pair in every colour mode: `node design/system-v2/contrast-check.mjs` |
| [`system-v2/MIGRATION.md`](./system-v2/MIGRATION.md) | Current Figma variables and CSS custom properties mapped to System v2 tokens, or retired with a reason |
| [`system-v2/PIPELINE.md`](./system-v2/PIPELINE.md) | How tokens reach the app CSS and Figma |

Direction comps, audit notes and gate results use real job photos or are dated evidence, so they stay in the private evidence store, not in this repository.
