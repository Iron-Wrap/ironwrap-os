# System v2 migration map

From what exists before System v2 to `tokens.json` 2.0.0-draft.3 (`app/src/design-system/tokens.json`):
- Figma file `0eK7JOWRYmAtESSwPWQOwx` after the Codex UI-audit repair (`origin/codex/ui-audit-repair-20261002`, `app/src/design-system/figma-token-map.json` and `ui-audit-handoff.json`);
- the CSS custom properties in `app/src/styles.css` on that branch and on `origin/main`.

System v2 is a migration, not a fork: every existing variable either keeps its ID under a new name, folds into one that does, or retires with a reason.

## Actions

| Action | Meaning in Figma | Meaning in CSS |
| --- | --- | --- |
| keep | Same variable, same name, new values | Same property, new values |
| rename | Same variable ID, new name and values. Bound nodes keep their binding | Property renamed; a compatibility alias is emitted until call sites move (see `PIPELINE.md`) |
| merge | Same role as another variable. Step 1: its values become an alias of the target, so bound nodes already render the System v2 value. Step 2: rebind its nodes to the target ID. Step 3: delete it once it has zero bindings | Compatibility alias to the target, then a codemod, then removal |
| retire | The role does not exist in Spine. Same three steps as merge; the target is the neutral stand-in named in the table, and every rebound node is listed for a design check | Same as merge; the compatibility alias is the neutral stand-in and every call site gets a review |
| new | No predecessor. Created | Emitted by the build |

When several variables map to one target, the one marked rename keeps its ID; the others merge into it. If a run finds a merging variable has far more bindings than the renamed one, swap them: the ID worth keeping is the one with more bound nodes.

## Figma: collections and modes

| Today | System v2 | How |
| --- | --- | --- |
| `Primitives` (`VariableCollectionId:2:2`, 143 vars, mode `Value`) | `Primitives`: colour ramps (`color/graphite/*`, `color/red/*`, `color/blue/*`, `color/white`, `color/graphite-alpha/*`) and font family strings. Hidden from publishing so designers pick roles | Keep the collection and its single mode. Rename where listed below, create the rest, retire the old palette after rebinding |
| `Color` (`VariableCollectionId:2:3`, 57 vars) modes `Light` `2:1`, `Dark` `2:2`, `Field Sun` `782:0`, `Shop` `782:1` | `Color`, 36 vars, modes `office-light`, `office-dark`, `field-sun`, `shop-dark`, plus new `field-night`, `shop-light`, `customer-light`, `customer-dark`, `customer-sun` | Rename modes in place so mode IDs survive: `Light` -> `office-light`, `Dark` -> `office-dark`, `Field Sun` -> `field-sun`, `Shop` -> `shop-dark`. Add five modes (the customer page ships light, dark and sun: owner decision). Frames already set to a mode keep it. Nine modes must fit the Pro plan's per-collection limit (verify at run time; the job stops if `addMode` throws) |
| `Layout` (`VariableCollectionId:2:124`, 41 vars) modes `Office` `2:3`, `Touch` `782:2`, `Shop` `782:3` | `Density`, modes `office`, `touch`, `glove` | Rename the collection and its modes in place (`Shop` -> `glove`). It also holds every number token: space, size, radius, border width, font sizes, line heights, weights, tracking, brand geometry, the density tokens and the type roles. Figma cannot move a variable between collections, and the bound spacing and radius variables already live here |
| `Prototype · Manual history` (`679:8432`, hidden) | unchanged | Prototype state, not tokens. Out of scope |

Text styles bind their font size, line height, weight, letter spacing and family to `Density` variables, so one style renders at office, touch or glove size by the frame's `Density` mode.

## Figma: `Color` collection (57 variables)

Variable IDs are from `figma-token-map.json` (prefix `VariableID:` dropped). The file left the app with the token pipeline, since the naming rule makes a map unnecessary; the IDs live in the tables below and the file is in Git history.

| Variable today | ID | CSS today | Action | System v2 | Note |
| --- | --- | --- | --- | --- | --- |
| `bg/app` | `2:11` | `--background` | merge | `surface/paper` | Spine has no page ground behind cards; the whole page is paper |
| `bg/surface` | `2:13` | `--surface` | rename | `surface/paper` |  |
| `bg/sunk` | `2:16` | `--surface-sunk` | merge | `surface/rail` |  |
| `bg/hover` | `2:19` | `--surface-hover` | merge | `surface/selected` | Office hover for ghost controls is the selected fill |
| `bg/document` | `2:22` | `--surface-sunk` | merge | `surface/paper` | Customer document ground |
| `bg/scrim` | `2:25` | `--scrim` | rename | `overlay/scrim` |  |
| `text/primary` | `2:27` | `--foreground` | keep | `text/primary` | Same name, new values |
| `text/secondary` | `2:30` | `--muted` | keep | `text/secondary` |  |
| `text/tertiary` | `2:33` | `--faint` | keep | `text/tertiary` |  |
| `border/default` | `2:36` | `--border` | rename | `line/hairline` |  |
| `border/strong` | `2:39` | `--border-control` | rename | `control/border` | Already the 3:1 control edge after the repair |
| `accent/default` | `2:41` | `--accent` | retire | `text/primary` | Brass retires (two signals only). Current place becomes surface/pressed + text/primary |
| `accent/soft` | `2:44` | `--accent-soft` | retire | `surface/selected` | Brass |
| `accent/line` | `2:47` | `--accent-line` | rename | `line/strong` | Keeps an ID for line/strong; brass lines become graphite |
| `accent/focus` | `2:49` | `--focus` | rename | `focus/ring` | Brass ring becomes ink (owner decision: blue keeps one meaning) |
| `accent/highlight` | `2:52` | `--highlight` | retire | `surface/pressed` | Text selection is ink on paper in Spine; search-match fills take pressed |
| `action/primary-bg` | `2:53` | `--primary` | rename | `control/fill` |  |
| `action/primary-bg-hover` | `2:55` | `--primary-hover` | rename | `control/fill-pressed` | Filled controls do not change on hover; the variable becomes the pressed fill |
| `action/primary-fg` | `2:57` | `--primary-foreground` | rename | `control/on-fill` |  |
| `status/ok` | `2:60` | `--ok` | retire | `text/primary` | No green: done is ink + check glyph + words |
| `status/ok-soft` | `2:63` | `--ok-soft` | retire | `surface/rail` |  |
| `status/info` | `2:66` | `--info` | retire | `text/secondary` | Information is neutral; blue means needs you |
| `status/info-soft` | `2:69` | `--info-soft` | retire | `surface/rail` |  |
| `status/warn` | `2:72` | `--warning` | retire | `text/primary` | No amber: a blocker is held (red) or needs you (blue); anything else is neutral |
| `status/warn-soft` | `2:75` | `--warning-soft` | retire | `surface/rail` |  |
| `status/warn-line` | `2:78` | `--warning-line` | retire | `line/strong` |  |
| `status/stop` | `2:81` | `--danger` | rename | `signal/held` |  |
| `status/stop-soft` | `2:84` | `--danger-soft` | rename | `signal/held-tint` |  |
| `status/stop-line` | `2:87` | `--danger-line` | rename | `signal/held-line` | Divider inside a held card |
| `status/local` | `2:90` | `--local` | retire | `text/secondary` | Saved on this device is a dashed pending seam + words, in neutral ink |
| `status/local-soft` | `2:93` | `--local-soft` | retire | `surface/rail` |  |
| `status/neutral` | `2:96` | `--neutral` | merge | `text/secondary` |  |
| `status/neutral-soft` | `2:99` | `--neutral-soft` | merge | `surface/rail` |  |
| `rail/bg` | `2:101` | `--chrome` | rename | `surface/rail` | The rail is light in Spine |
| `rail/text` | `2:103` | `--chrome-muted` | merge | `text/tertiary` |  |
| `rail/text-strong` | `2:104` | `--chrome-foreground` | merge | `text/primary` |  |
| `rail/muted` | `2:106` | `--chrome-faint` | merge | `text/tertiary` |  |
| `rail/hover` | `2:109` | `--chrome-raised` | merge | `surface/selected` |  |
| `rail/active` | `2:112` | `--chrome-active` | rename | `surface/pressed` | Current place |
| `rail/focus` | `2:113` | `--chrome-focus` | merge | `focus/ring` |  |
| `tag/metal-text` | `2:116` | `--tag-metal-text` | retire | `text/primary` |  |
| `tag/paper-text` | `2:118` | `--tag-paper-text` | retire | `text/primary` |  |
| `tag/metal` | `2:121` | `--tag-metal-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/paper` | `2:123` | `--tag-paper-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/case` | `7:15` | `--tag-case-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/case-text` | `7:17` | `--tag-case-text` | retire | `text/primary` |  |
| `tag/supply` | `7:19` | `--tag-supply-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/supply-text` | `7:21` | `--tag-supply-text` | retire | `text/primary` |  |
| `tag/record` | `7:23` | `--tag-record-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/record-text` | `7:25` | `--tag-record-text` | retire | `text/primary` |  |
| `tag/asset` | `7:27` | `--tag-asset-fill` | retire | `surface/rail` | Stamped tag plates retire: a code is mono text after its plain label |
| `tag/asset-text` | `7:29` | `--tag-asset-text` | retire | `text/primary` |  |
| `bg/raised` | `60:5` | `--surface-raised` | merge | `surface/paper` | Flat: nothing is raised |
| `bg/selected` | `60:8` | `--selected` | rename | `surface/selected` | Loses the brass tint |
| `border/soft` | `60:11` | `--border-soft` | merge | `line/hairline` |  |
| `rail/line` | `60:14` | `--chrome-border` | merge | `line/hairline` |  |
| `tag/metal-edge` | `60:17` | `--tag-metal-edge` | retire | `line/strong` |  |

Totals: 3 keep, 15 rename, 14 merge, 25 retire. The 18 kept or renamed IDs carry `surface/paper`, `surface/rail`, `surface/selected`, `surface/pressed`, `text/primary`, `text/secondary`, `text/tertiary`, `line/hairline`, `line/strong`, `control/border`, `control/fill`, `control/fill-pressed`, `control/on-fill`, `focus/ring`, `signal/held`, `signal/held-tint`, `signal/held-line`, `overlay/scrim`.

New (18): `control/placeholder`, `signal/held-text-on-tint`, `signal/held-fill`, `signal/held-fill-pressed`, `signal/held-on-fill`, `signal/you`, `signal/you-tint`, `signal/you-tint-edge`, `signal/you-fill`, `signal/you-fill-pressed`, `signal/you-on-fill`, `seam/open`, `seam/locked`, `seam/pending`, `skeleton/base`, `skeleton/sheen`, `overlay/plate`, `overlay/on-plate`. `status/info` is deliberately not reused for `signal/you`: information is not "needs you", and reusing the ID would turn every info badge into a request.

## Figma: `Primitives` collection (143 variables)

The pre-repair names are known by pattern (`design/audit-notes/figma-vars.txt`); the repair added 49 whose names are not in the repository. The migration job dumps the collection first and applies these rules by prefix, failing on any name no rule covers.

| Today | Action | System v2 | Note |
| --- | --- | --- | --- |
| `palette/ink` | rename | `color/graphite/913` (`#18191B`) | Closest role: office ink |
| `palette/sheet` | rename | `color/graphite/14` (`#FBFBFA`) | Working sheet becomes paper |
| `palette/primer` | rename | `color/graphite/42` (`#F3F3F1`) | Primer ground becomes rail |
| `palette/charcoal` | rename | `color/graphite/961` (`#0D0E10`) | Charcoal chrome becomes dark paper |
| `palette/galvanized` | rename | `color/graphite/434` (`#85888E`) | Galvanized grey becomes the control edge |
| `palette/brass` | retire | none | Brass is gone; nothing aliases to it after the `Color` rebind |
| `light/*`, `dark/*` (mode-split copies of semantic roles) and the 49 repair additions (assumed `field-sun/*` and `shop/*` copies) | retire | none | After `Color` variables alias the System v2 ramps, these have no consumers. Delete once the binding count is zero; any binding found is rebound to the matching `Color` role first |
| none | new | the 29 graphite steps, 5 graphite-alpha, 11 red, 8 blue, white, `font/family/sans`, `font/family/mono` not covered by a rename | |

## Figma: `Layout` collection (41 variables) -> `Density`

| Variable today | Action | System v2 | Note |
| --- | --- | --- | --- |
| `space/2`, `4`, `6`, `8`, `10`, `12`, `16`, `20`, `24`, `28`, `32` | keep | same names, one value in every mode | |
| `space/14`, `space/18`, `space/22` | merge | `space/16`, `space/20`, `space/24` | Off the 4px grid; rounded up so nothing shrinks |
| `radius/s` (6), `radius/m` (8), `radius/l` (12), `radius/xl` | rename | `radius/6`, `radius/8`, `radius/12`, `radius/16` | `radius/xl` value unread; verify it is 16 before renaming |
| `radius/full` | keep | `radius/full` | |
| `size/control` | rename | `control/height` (28 / 48 / 72) | |
| `size/control-s` | rename | `control/height-small` (24 / 48 / 72) | |
| `size/input` | merge | `control/height` | Inputs and buttons share heights |
| `size/rail`, `size/header`, `size/tabbar`, `size/inspector` | retire | none | Layout constants of the old shell. Spine's rail (72), title bar (40), phone dock and right column (424) are component dimensions, not tokens |
| `page/pad-desktop` | rename | `space/gutter` (24 / 16 / 24) | |
| `page/pad-tablet`, `page/pad-phone` | merge | `space/gutter` | The density mode now picks the value |
| `page/max`, `page/max-wide`, `page/form` | retire | none | Page width caps are layout constants |
| `phone/size/button` | rename | `control/height-primary` (32 / 64 / 72) | |
| `phone/size/button-small` | merge | `control/height-small` | |
| `phone/size/checkbox-row` | rename | `row/min-height` (24 / 48 / 72) | |
| `phone/size/icon` | rename | `control/icon` (16 / 24 / 24) | |
| `phone/size/icon-small`, `phone/size/checkbox` | merge | `control/icon` | |
| `phone/size/textarea` | retire | none | Component dimension |
| `phone/radius/control` | rename | `control/radius` (8 / 14 / 14) | |
| `phone/opacity/disabled` | retire | none | Spine never fades: disabled is `text/tertiary` with a `line/hairline` edge |

New in `Density`: `space/40`, `space/48`, `size/*`, `radius/4`, `radius/10`, `radius/14`, `radius/22`, `border/width/1`, `border/width/2`, `font/size/*`, `font/line-height/*`, `font/weight/*`, `font/tracking/*`, `brand/seam/*`, `brand/clip/*`, `brand/node/halo`, `target/min`, `control/height-safety`, `control/border-width`, `space/gap`, `radius/card`, `radius/chip`, `radius/sheet`, `spine/node`, `track/*` (5), and `type/<role>/{size,line-height,weight,tracking}` for the 13 roles, including `display-reading`, `body-mono` and `caption-mono` (family strings live in `Primitives`).

## Figma: text and effect styles

Sixteen text styles replace about fifty. Each binds to `type/<role>/*`, so its size follows the frame's density mode. `Body/Mono` and `Caption/Mono` bind to the roles `type/body-mono/*` and `type/caption-mono/*` (a code at its surrounding size in the mono family), and `Reading/Display` to `type/display-reading/*`.

| System v2 style | Keeps the ID of | Merged into it (re-applied, then deleted) |
| --- | --- | --- |
| `Caption` | `Small` | `Meta`, `Phone/Field/Optional`, `Phone/Field/Hint`, `Native/Fact label` |
| `Caption/Strong` | `Small/Strong` | `Meta/Strong`, `Count`, `Status`, `Nav group` |
| `Caption/Mono` | `Mono/Tag` | `Tag`, `Tag/Large` (tags retire; any code text left becomes Caption/Mono) |
| `Body` | `Body` | `Body/Compact`, `Notice body`, `Input`, `Field error`, `Nav`, `Native/Body`, `Phone/Field/Checkbox label`, `Shop/Body` |
| `Body/Strong` | `Body/Strong` | `Body/Compact Strong`, `Native/Body strong` |
| `Body/Mono` | `Field/Ref` | `Mono`, `Code` |
| `Lead` | `Row title` | `Native/Intro` |
| `Lead/Strong` | `Heading 3` | `Native/Subheading`, `Native/Card title` |
| `Label` | `Label` | `Button`, `Button/Small`, `Tab`, `Control`, `Control/Small`, `Field label`, `Native/Label`, `Phone/Field/{Button, Button small, Label}`, `Shop/Control` |
| `Title` | `Heading 2` | `Panel title`, `Native/Heading` |
| `Headline` | `Title` | `Title/Phone`, `Native/Title`, `Native/Title phone`, `Shop/Title` |
| `Display` | new | |
| `Alert` | new | |
| `Reading` | new | |
| `Reading/Large` | new | |
| `Reading/Display` | new | |
| retire | `Wordmark` | The wordmark is the fixed logo asset, not text |

Effect styles `Shadow/XS`, `Shadow/1`, `Shadow/2`, `Shadow/Pop` retire (Spine is flat; overlays use a `line/strong` edge). New effect styles: `Shadow/Sheet`, `Shadow/On photo` and `Shadow/Pressed inset`, from `shadow.sheet`, `shadow.on-photo` and `shadow.pressed-inset`.

## CSS custom properties

Shipped values are on `origin/main`; the Codex branch adds `--environment-*`, `--tag-case/supply/record/asset-*` and `--ui-control-size`, and changes `--border-control` (to the 3:1 `#7b8289`) and `--accent`. Both map the same way.

### Colour (the `:root`, dark and environment blocks)

| Today | Action | System v2 |
| --- | --- | --- |
| `--background`, `--surface`, `--surface-raised` | rename / merge | `--surface-paper` |
| `--surface-muted`, `--surface-sunk`, `--chrome`, `--neutral-soft` | rename / merge | `--surface-rail` |
| `--surface-hover`, `--selected`, `--chrome-raised`, `--accent-soft` | rename / merge | `--surface-selected` |
| `--chrome-active`, `--highlight` | rename / merge | `--surface-pressed` |
| `--foreground`, `--chrome-foreground` | rename / merge | `--text-primary` |
| `--muted`, `--neutral` | rename / merge | `--text-secondary` |
| `--faint`, `--chrome-muted`, `--chrome-faint` | rename / merge | `--text-tertiary` |
| `--border`, `--border-soft`, `--chrome-border` | rename / merge | `--line-hairline` |
| `--accent-line` | rename | `--line-strong` |
| `--border-control`, `--border-strong` | rename / merge | `--control-border` |
| `--primary` | rename | `--control-fill` |
| `--primary-hover` | rename | `--control-fill-pressed` |
| `--primary-foreground`, `--accent-foreground` | rename / merge | `--control-on-fill` |
| `--focus`, `--chrome-focus` | rename / merge | `--focus-ring` |
| `--danger` | rename | `--signal-held` |
| `--danger-soft` | rename | `--signal-held-tint` |
| `--danger-line` | rename | `--signal-held-line` |
| `--danger-strong` | rename | `--signal-held-fill` |
| `--danger-foreground` | rename, changed | `--surface-paper`. Text on a held-coloured fill (`bg-danger text-danger-foreground`, one use) is paper in every mode: contrast is symmetric, so the proof's `signal.held` on `surface.paper` pair already covers it. `--signal-held-on-fill` would put white on the pale dark-mode red |
| `--danger-strong-foreground` | rename | `--signal-held-on-fill` |
| `--scrim` | rename | `--overlay-scrim` |
| `--accent` | retire, interim `--text-primary` | Brass. 53 `*-accent` utilities and 3 `var(--accent)` uses; `desks.family.test.ts` and `leftover.family.test.ts` pin `inset_3px_0_0_var(--accent)` as the current-tab marker, which becomes `surface.pressed` + `text.primary` |
| `--accent-hover`, `--accent-active` | retire | Dead code today |
| `--ok`, `--info`, `--warning`, `--local` | retire, interim `--text-primary` (`--info`, `--local`: `--text-secondary`) | No third colour. About 580 utility uses (`text-warning` 143, `text-danger` 102, `bg-warning-soft` 101, `text-ok` 93, ...); the `danger` ones are renames, the rest need a review per component, starting with the Status variants |
| `--ok-soft`, `--info-soft`, `--warning-soft`, `--local-soft` | retire, interim `--surface-rail` | |
| `--warning-line` | retire, interim `--line-strong` | |
| `--tag-metal-*`, `--tag-paper-*`, `--tag-case-*`, `--tag-supply-*`, `--tag-record-*`, `--tag-asset-*` (fill, edge, text) and `.ref-tag`'s `--tag-h`, `--hole`, `--tag-fill`, `--tag-edge` | retire | The stamped tag plate goes; a code is mono text after its plain label |
| none | new | `--control-placeholder`, `--signal-held-text-on-tint`, `--signal-held-fill-pressed`, `--signal-you`, `--signal-you-tint`, `--signal-you-tint-edge`, `--signal-you-fill`, `--signal-you-fill-pressed`, `--signal-you-on-fill`, `--seam-open`, `--seam-locked`, `--seam-pending`, `--skeleton-base`, `--skeleton-sheen`, `--overlay-plate`, `--overlay-on-plate` |

The Tailwind names in `@theme inline` (`--color-foreground`, `--color-muted`, `--color-danger`, ...) stay during the migration and point at the new properties, so the existing `bg-*`, `text-*` and `border-*` utilities keep working; see `PIPELINE.md`.

### Everything else

| Today | Action | System v2 |
| --- | --- | --- |
| `--font-sans` (Archivo), `--font-mono` (Martian Mono) in `@theme` | keep the names, change the values | `var(--font-family-sans)` (Geist), `var(--font-family-mono)` (Geist Mono, Geist second) |
| `--radius-sm` 6, `--radius-md` 8, `--radius-lg` 12, `--radius-xl` 16 in `@theme` | keep | Same values as `radius.6/8/12/16`; control, card and chip radii come from `--control-radius`, `--radius-card`, `--radius-chip` |
| `--motion-fast` 140ms, `--motion-standard` 220ms | keep | `motion.fast`, `motion.standard` (same names and values, so `pipeline-surface.family.test.ts` holds) |
| `--motion-ease` `cubic-bezier(0.2, 0.8, 0.2, 1)` | keep the name, change the value | `cubic-bezier(0.16, 1, 0.3, 1)` |
| none | new | `--motion-seam` 280ms, `--motion-sheen` 1400ms (replaces the hard-coded 1.4s skeleton sheen) |
| `--shadow-floating` | retire, interim `0 0 0 1px var(--line-strong)` | Flat. Overlays take a `--line-strong` edge; the one floating surface, the bottom sheet, uses `--shadow-sheet` |
| `--environment-control-size` (2.75rem / 3rem / 4rem) | rename later; kept as a component variable for now | `--control-height` (28 / 48 / 72). Not aliased: the office value would shrink nothing but the glove value would grow the shop reading view from 4rem to 72px |
| `--environment-body-size` (1rem / 1rem / 1.5rem) | rename later; kept as a component variable for now | `--type-body-size` (13 / 16 / 20). Not aliased: the glove value would shrink the shop reading view from 1.5rem to 20px |
| `--environment-control-type` (0.875rem / 1rem / 1.5rem) | rename later; kept as a component variable for now | `--type-label-size` (13 / 16 / 20). Not aliased, for the same reason |

The three `--environment-*` sizes keep their shipped values, set on `[data-density="touch"]` and `[data-density="glove"]` in `styles.css`, until the components read the density tokens; the office values stay on `:root`.
| `--ui-control-size` (button, input, select, textarea recipes) | keep as a component variable | Its values come from `--control-height-small`, `--control-height` and `--control-height-primary` |
| `--rail-w` 240, `--inspector-w` 380, `--header-h`, `--tabbar-h`, `--crew-w`, `--crew-tabs-h` | retire as tokens | Shell dimensions stay scoped in the shell CSS (Spine: rail 72, right column 424, title bar 40) |
| `--safe-bottom-inset` | keep | Platform inset, not a design token |

### Mode attributes

| Today | System v2 |
| --- | --- |
| `data-theme="light" / "dark"` on `<html>` (`src/lib/theme.ts`, storage key `ironwrap.theme.v1`) | `data-mode="office-light" / "office-dark"` on `<html>`; same storage key and values, so stored preferences survive. With no attribute, the device scheme decides |
| `data-environment="field"` and `"field-sun"` | `data-mode="field-sun"` (or `"field-night"` from the crew's toggle) `data-density="touch"`. The plain `field` environment used office colours; it now gets sun mode. The "Sun mode" button is the switch (on is sun, off is night) and stores `ironwrap.field.night-mode`; the old `ironwrap.field.sun-mode` is ignored |
| `data-environment="shop"` | `data-mode="shop-dark"` (or `"shop-light"`) `data-density="glove"`, on the page and, through `ShopReadingContext`, on the shell, so the rail, top bar and tab bar follow the page |
| `data-environment="customer"` | `data-mode="customer-light"`, `"customer-dark"` (phone set to dark) or `"customer-sun"` (`prefers-contrast: more`, which wins over dark), with `data-density="touch"` |
| `@media (pointer: coarse), (max-width: 720px)` control floors | `data-density="touch"` defaulted on `pointer: coarse` by the generated CSS |

## `app/scripts/styles.family.test.ts`

The token pipeline change rewrote this file against the generated `tokens.css`. What shipped, and what waits for the font and call-site steps:

| Test | Change |
| --- | --- |
| "uses the Iron Wrap identity: Archivo on primer, a charcoal spine, brass only for place" | Replaced by "generates the System v2 tokens, proves their contrast, and keeps the shipped faces self-hosted". It asserts: `src/styles/tokens.css` equals the build output (`build-tokens.mjs --check`); the contrast proof exits 0; `styles.css` imports `tokens.css` after tailwind; `index.html` boot colours, `theme-color` and the Vite manifest colours equal resolved `tokens.json` values (`surface.paper`, `surface.rail`, `line.strong`, `text.primary`, `text.secondary` in `office-light`). The brass, primer and charcoal pins are gone. **Waits for the Geist packages:** the packaged-face comparison still points at Archivo and Martian Mono, and the Geist Mono `unicode-range` assertion (U+00BC-00BE, U+2150-215E, U+2032-2033) lands with the Geist faces |
| (new) "declares no colour or density token of its own" | styles.css may declare only the component variables on an allow-list; a token added by hand would be invisible to `npm run tokens`. The `Archivo`, `Martian Mono`, `--accent` and `--tag-` bans wait for the font swap and for the call sites to move |
| (new) "maps every System v2 role to a utility named after its property" | Every `semantic.*` role has `--color-<role>: var(--<role>)` in `@theme inline`, and every property the theme reads is generated |
| uppercase, backdrop-blur, 12px floor, motion through tokens, `text-wrap-style` | Unchanged |
| "keeps the primary action ink, so brass never reads as an action colour" | Unchanged: `--color-primary` maps to `control.fill`, ink. The no-`*-accent` assertion waits for the call sites to move (37 `text-accent` uses remain, rendered ink through the alias) |
| "qualifies resting and hover control edges plus small brass text on every office ground" | Deleted; the contrast proof covers the control-edge rule in all nine modes |
| "keeps Sun and Shop text and status receipts at 7:1 across their scoped surfaces" | Deleted; the proof's overrides cover sun (every text pair 7:1) and shop (primary text 7:1) |
| The comment promising the two dark blocks stay identical | Covered by the `--check` assertion: the generator writes both from one source |

`app/scripts/build-tokens.test.ts` runs the generator against a disposable copy of the pipeline: it writes the committed file, `--check` detects drift, a failing proof writes nothing, duplicate generated names and unresolvable aliases fail, and the generated blocks hold the mode, density and alias structure. `src/lib/theme.test.ts` proves every scope the app uses is a combination `tokens.json` lists.

Also: `desks.family.test.ts` and `leftover.family.test.ts` pin `inset_3px_0_0_var(--accent)` and `variant="accent"` for the current tab. They stay as they are until the component moves to the Spine current-place treatment (`surface.pressed` with `text.primary`); the alias renders that marker in ink meanwhile. `pipeline-surface.family.test.ts` pins `--motion-fast`, `--motion-standard` and `--safe-bottom-inset`, which keep their names; it now reads the reduced-motion durations from `tokens.css`.

## Order of operations

1. **Figma, one bridge job, dry run first.** Dump all collections, modes, variables and binding counts (walk every page for `boundVariables` and `textStyleId`). Fail on any unmapped name. Print the plan.
2. **Figma, apply.** Rename modes and collections; rename kept variables; create new ones; write all values from `tokens.json` (colours as aliases to `Primitives`); set code syntax `var(--…)` and scopes; point every merge and retire variable at its target as an alias. Nothing is deleted in this step, so every bound node already shows System v2 values.
3. **Figma, rebind.** Swap bindings and text styles from merged and retired IDs to their targets. Delete what reaches zero bindings. List every retired binding for a design check.
4. **Code.** (a) Add the generated `tokens.css` with the compatibility aliases, switch `data-theme` and `data-environment` to `data-mode` and `data-density`, update the family tests: done by the token pipeline change. (b) Package Geist and Geist Mono and point `--font-sans` and `--font-mono` at them. (c) Move call sites off the compatibility names, repainting statuses and the tag plate screen by screen; `npm run tokens:aliases` lists what still reads them. (d) Delete the aliases.

Rollback: steps 1 and 2 are reversible from the dump (names, values, modes). Step 3 deletes; run it only after the design check.
