# UI uplift plan — 2026-08-22

Ivan (2026-08-22): every user-facing Facet and IronWrap OS surface, planned first, then small PRs. Not a Facet-lab color pass.

This file lives in both repos. Facet copy: `facet/docs/ui-uplift-plan-2026-08-22.md`. IronWrap copy: `ironwrap-os/docs/ui-uplift-plan-2026-08-22.md`. Linear: comments on [IRO-2](https://linear.app/mindburn/issue/IRO-2) and [IRO-1](https://linear.app/mindburn/issue/IRO-1).

**Surface count: 60** (20 Facet + 40 IronWrap OS). Hermes desktop is not an IronWrap operator UI (Tempora-internal MCP). Frappe Desk is ERPNext, not this visual program.

## Commercial and visual contract

| | Facet | IronWrap OS |
|---|---|---|
| Product | Sell-as-is visual estimating studio | Field/office operating system |
| Brand | Own brand. First prospect: IronWrap Exteriors | IronWrap |
| Mode | Operate around a 3D house | Operate around today’s work |
| World | Anodized equipment: dusk frame `#161b21`, mineral paper, Mona Sans, oxide red `#c81d25` only for commit | Same oxide + dusk + mineral family, Hubot Sans. Related, not a clone |
| Must not | Look like an IronWrap skin or Tailwind purple SaaS | Skip desk pages because they are ugly |

**Keep:** AI photo default OFF; no SAMPLE_HOUSE boot; auth/tenancy; no secrets in UI; Facet token names / 44px / workspace grid; no wrangler deploy; Facet Cloud Build only after a visual PR is on `main` and canary-safe.

**Git:** branch from `origin/main`; merge main in, never rebase. Do not clobber Share-AI leftover. `GH_TOKEN=$(gh auth token -u peycheff-com)` for Facet, `-u ironwrap` for ironwrap-os. Never `gh auth switch`.

**Evidence:** Lazyweb https://www.lazyweb.com/agentic-search/473cad67-1f30-4d13-b551-1212036c96e5 (Jobber desk, IKEA Kreativ / Higharc / Hover from the prior configurator pass). Live Facet lab: https://facet-gpt-lab-4gzpp5by6a-nn.a.run.app

**Premature work (do not merge or deploy):** Facet [#76](https://github.com/Iron-Wrap/facet/pull/76) and IronWrap [#142](https://github.com/Iron-Wrap/ironwrap-os/pull/142) jumped to tokens/auth before this inventory. Convert to draft. Reuse as WS1/WS5 only after this plan is on `main`.

---

## Facet surfaces (20)

Each row: **current** · **job** · **failure** · **target** · **depends** · **stream**

### F01 Auth gate (login / signup / server error / launch-failed)
Live lab is a lone off-center white card on charcoal, system face, leftover intro CSS with no markup. Contractor must trust the product in one glance, then sign in. Target: dusk stage, statement “See the house. Price the finish.”, mineral plate, Mona, full-width oxide hairline. Depends: none. **WS1.**

### F02 Tenant selection
Same card stack; role line used an em-dash. Owner with several companies picks one. Target: same plate as F01, hyphenated role, 44px rows. Depends: F01 tokens. **WS1.**

### F03 Temporary-password change
Same gate chrome, hardcoded error red leftovers. User must rotate a temp password before work. Target: F01 plate + semantic error class. Depends: F01. **WS1.**

### F04 Empty stage
Compact card, cramped type, 48px icon contract. Owner starts a blank project (no SAMPLE_HOUSE). Target: mineral card, 1.25rem title, one primary import. Depends: F01 tokens, workspace grid. **WS2.**

### F05 Import (RoofRuler / AppliCAD)
File control in inspector; 44px label contract. Get a measured house onto the stage. Failure: inspector type soup, disabled chrome. Target: one obvious import, honest errors. Depends: F04. **WS2.**

### F06 Sales workspace (rail + 3D + inspector + estimate)
Graphite/cream leftover, cramped topbar, muddy glass over the model. Sell a priced finish on the measured house. Target: dusk rails, mineral inspector, house leads. Desktop + phone contracts stay. Depends: F01 tokens. **WS2.**

### F07 Expert workspace
Same family; tool rail + clip/surface inspector. Expert edits one surface without losing the model. Failure: same chrome slop. Target: F06 language, Expert-only density. Depends: F06. **WS2.**

### F08 Showroom (customer)
Customer-safe compare + finishes + approve. Failure: frosted graphite chips, leftover cream popovers. Target: opaque dusk plates, no login on `?p` / `?d`. Depends: F06, approval contract. **WS3.**

### F09 Estimate / review dock
Critical-red totals, cramped nav. Trust the price and step next. Target: split-flap tabular rows, oxide only when money is at risk. Depends: F06. **WS2.**

### F10 Share / Photo / AI Photo
Share Design + Photo + optional AI hero. Failure: Share AI leftover (do not clobber that branch). Target: Photo default; AI off unless asked; billed hero is the one shown. Depends: #72/#73 already on main; leftover UI polish only. **WS3.**

### F11 PDF export
Labelled roof-plan page exists; chrome around export is leftover. Send a trustworthy PDF. Target: same type/color as studio, no cream. Depends: F09. **WS3.**

### F12 Custom services / packages
Admin list + estimate lines. Price extras without leaving the studio. Failure: generic form soup. Target: ruled mineral table. Depends: F14–F16 tokens. **WS4.**

### F13 Tenant settings
Company logo, units, expert entitlement. Failure: `#e5e7eb` leftovers. Target: same plates as F01. Depends: F01. **WS4.**

### F14 Discounts
Rule cards + mute toggles. Set tenant pricing rules. Failure: danger-button hex soup. Target: semantic tokens only. Depends: F01. **WS4.**

### F15 Profiles & Colors / Library
4px red structural bar, Tailwind grays. Maintain manufacturer finishes. Target: 1px joints, dusk headers. Depends: F01. **WS4.**

### F16 Capture
Lazy Capture panel over the stage. Failure: overlay chrome. Target: opaque mineral dock. Depends: F06. **WS2.**

### F17 Platform / superadmin
`#f3f5f7` / `#667085` dashboard. Platform ops manage tenants. Target: mineral console, no hero-metrics costume. Capability gate stays. Depends: F01. **WS4.**

### F18 Mobile workspace
Phone: compact header, sheet inspector, sticky estimate. Failure: 0.6875rem controls, yellow 3D chip. Target: 0.8125rem dusk chips, 44px. Depends: F06. **WS2.**

### F19 Desktop workspace
168px rail / 21rem inspector / 3.25rem topbar contract. Failure: muddy 82% glass docks. Target: opaque plates. Do not change grid rem. Depends: F06. **WS2.**

### F20 Customer share link (unauthenticated)
`?p` / `?d` / snapshot HTML. Customer reviews without an account. Failure: if auth ever leaks here it is a P0. Target: Showroom only. Depends: F08. **WS3.**

---

## IronWrap OS surfaces (40)

### I01 Boot shell
Sage `#f5f6f4` / `#121611` before JS. Prove the device before work. Target: dusk plate, mineral page, theme `#161b21`. **WS5.**

### I02 Magic-link sign-in
Generic Card + circular icon on light canvas. Office signs in without a password. Target: dusk stage + mineral card (family of F01, Hubot). **WS5.**

### I03 Magic-link consume `/auth/verify`
Centered consume card. Finish the email link. Target: I02. **WS5.**

### I04 Device pair `/auth/pair`
QR consume. Pair a crew phone. Target: I02, 44px. **WS5.**

### I05 App shell (header, rail, mobile tab, Safety)
Frosted header, 3px side-tab nav, nine-item office bar. Every authenticated job lives here. Target: opaque mineral header, dusk rail, inset-top state, Safety stays reachable. **WS5.**

### I06 Now (office)
Kickers, `border-l-4` cards. Owner/ops see what to do next. Target: Jobber-like queue, no eyebrows, tone by fill not side-tab. **WS5.**

### I07 Today (field)
Assigned jobs; blocked first. Failure: inset 3px danger, uppercase “Scheduled”. Target: field density, honest empty. **WS6.**

### I08 Job packet
Plan, proof, next step for one job. Failure: still easy to read as card soup. Target: packet, not dashboard. **WS6.**

### I09 Work object / work package
Physical context + evidence slots. Failure: form density. Target: one package, one next action. **WS6.**

### I10 Check-in
Photos/voice before typing. Failure: placeholder leftovers exist beside the real page. Target: I07 language. **WS6.**

### I11 Fleet / vehicle
Field-only capture against an asset. Target: dusk/mineral, no office tab. **WS6.**

### I12 Inventory
Shop/warehouse counts. Failure: desk-ugly. Target: tabular mineral, not skipped. **WS6.**

### I13 Safety action (global)
Fixed hazard/rescue. Must never depend on a job being open. Target: keep geometry; restyle to family. **WS6.**

### I14 Owner Now `/owner`
Owner-specific now. Failure: same card costume as I06. Target: I06. **WS5.**

### I15 Approvals inbox
HITL queue. Target: ruled rows, oxide only on commit. **WS7.**

### I16 Sales desk
Do not skip because ugly. Next commercial action on a lead/job. Target: Jobber-desk density, Hubot. **WS7.**

### I17 Lead triage
Internal summary + prepare. Target: I16. **WS7.**

### I18 Estimator workbench
Quote lines on a job. Failure: long page, button soup. Target: workbench, tabular money. **WS7.**

### I19–I21 Quote revision queue / detail / prepare
Approve a revision. Target: I15 + I18. **WS7.**

### I22 Production runway
Lanes (blocked → verify). Failure: unused `border-l-*` tone map. Target: lane headers by icon+copy, not side-tabs. **WS7.**

### I23–I25 Production schedule prepare / queue / detail
Set a start date with authority. Target: I15. **WS7.**

### I26 Service desk
Cases list. Desk-ugly. Target: I16. **WS7.**

### I27 Service case
One case. Target: I08. **WS7.**

### I28 Reception / Newo
Calls intake. Failure: third visual world if any. Target: family chrome; Newo copy stays. **WS8.**

### I29 Postiz / marketing intent
Publication intent. Defer visual depth if rail is thin. Target: family only. **WS8.**

### I30 Money desk
Accounting landing. Do not skip. Target: tabular money, no hero-metrics. **WS8.**

### I31 Money intent
One payment intent. Target: I30. **WS8.**

### I32 Money exceptions
Issues queue. Target: I15. **WS8.**

### I33 QuickBooks settings
Connection, not a queue. Target: settings plate. **WS8.**

### I34 QB final invoice
Invoice check. Target: I30. **WS8.**

### I35 Facet designs inbox
Consume Facet evidence only. Target: family; never look like Facet studio. **WS8.**

### I36 Settings / crew devices
Pairing QR. Target: I04 family. **WS5.**

### I37 Customer portal `/portal`
Customer project. Target: quiet customer chrome, not office dusk-rail. **WS9.**

### I38 Contract accept `/contract-accept`
Genuine customer confirmation. Target: I37; no office nav. **WS9.**

### I39 Public estimate `/estimate`
Public form + Turnstile. Target: I37. **WS9.**

### I40 Not found
Retry to `/now`. Target: family error. **WS5.**

---

## Sequenced workstreams

| Stream | Scope | Exit | Ship |
|---|---|---|---|
| **WS0** | This plan on both mains + Linear | Plan PRs green | Plan-only PRs. No Cloud Build. No wrangler. |
| **WS1** | Facet F01–F03 tokens + first viewport | Auth looks like the product | Rebase-never: merge `main` into a rewritten #76 or a new PR. Canary lab only after squash-merge. |
| **WS2** | Facet F04–F07, F09, F16, F18–F19 | Empty → import → sales/expert/estimate | Small PRs. Keep grid rem. |
| **WS3** | Facet F08, F10, F11, F20 | Showroom, share, PDF | Do not clobber Share AI. |
| **WS4** | Facet F12–F15, F17 | Admin/library/platform | Last Facet visual. |
| **WS5** | IronWrap I01–I06, I14, I36, I40 | Boot, auth, shell, Now | New PR; #142 is a partial, draft only. |
| **WS6** | IronWrap I07–I13 | Field + inventory + safety | |
| **WS7** | IronWrap I15–I27 | Office desks (sales, production, service, estimator) | Do not skip desks. |
| **WS8** | IronWrap I28–I35 | Money, QB, Newo, Postiz, Facet inbox | |
| **WS9** | IronWrap I37–I39 | Customer portal / contract / public estimate | Separate chrome from office. |

Each implementation PR: one stream or a named slice; tests green; before/after screenshots; no secrets.

## Deferred

- Merge or Cloud Build of #76 / #142 until WS0 is on `main` and the PR matches its stream.
- Wrangler / issuer-missing deploys.
- Tempora Hermes and Frappe Desk (not this program).
- Regenerating raster PWA icons (SVG theme is enough in WS5).
- Facet 3D dusk/glass fidelity (IRO-27/35), not chrome.
- Newo/Postiz deep UX if those rails stay thin (WS8 is family-only).
- Marketing landing pages (none in these repos).
