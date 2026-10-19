# IronWrap OS System v2: tokens

Status: draft 2.0.0-draft.3. Direction: Spine. Visual truth: the Spine direction comps (kept outside the repository because they show a real job photo), with the owner decisions recorded under Decisions below.
Source of truth for values: [`tokens.json`](../../app/src/design-system/tokens.json) in `app/src/design-system/` (W3C Design Tokens format, 2025.10). This document explains it; where the two disagree, `tokens.json` wins. The tables were generated from it.

Files: `app/src/design-system/tokens.json` (the tokens), `app/src/design-system/contrast-check.mjs` (the contrast proof, zero dependencies), `app/scripts/build-tokens.mjs` (tokens to CSS), `MIGRATION.md` (today's Figma variables and CSS properties mapped to these), `PIPELINE.md` (how tokens reach CSS and Figma).

## Principles

1. **Two signals, one meaning each.** Red (`signal.held`) means held or stopped. Blue (`signal.you`) means the viewer is the one being waited on. Nothing else is coloured: no green "OK", no amber "warning", no brass accent. Every other state is graphite ink plus a glyph plus words. The crew phone and shop tablet say "waiting on the office" in neutral ink, because there the viewer is not the one being waited on. The keyboard focus ring is ink, so blue keeps its one meaning.
2. **Graphite ink on a near-white working surface.** One neutral family carries everything else; dark modes use the same family inverted.
3. **Unknown is never 0.** A value nobody has measured or set is words ("Not measured yet", "Owner to set") inside a dashed `control.placeholder` edge, in `text.secondary`. Never a zero, a dash, an empty field or a pre-filled guess.
4. **Recolour, never fade.** Dimming (a lens, events off a traced chain, a disabled control) recolours to `text.tertiary`. Opacity never says "less important", and nothing held or needing a person is ever dimmed.
5. **Flat.** One floating surface (the bottom sheet) and one shadow under controls on photos. No elevation scale.
6. **Mono only for codes and machine readings.** Words, money, times and percentages are Geist with tabular figures; money keeps every minor digit.
7. **Raise, never shrink, for the place.** Density modes only enlarge targets and type relative to the office.

## Layers, axes and names

| Layer | Groups in `tokens.json` | Modes | Used by |
| --- | --- | --- | --- |
| Primitives | `color`, `space`, `size`, `radius`, `border`, `font`, `motion`, `shadow`, `brand` | none | semantic and density tokens. Components never use colour primitives |
| Semantic colour | `semantic.*` (36 roles) | colour-mode axis: `office-light` (default), `office-dark`, `field-sun`, `field-night`, `shop-dark`, `shop-light`, `customer-light`, `customer-dark`, `customer-sun` | every colour in the product |
| Density | `density.*` | density axis: `office` (default), `touch`, `glove` | control sizes, gutters, radii, spine node, stage track, type scale |

Modes are stored per token in `$extensions["com.ironwrap.os"].modes`; `$value` is the default mode. A token without modes has one value in every mode of its axis. A semantic token may alias another (`control.fill` = `text.primary`); the alias resolves inside the current mode.

**Names.** One rule, no lookup table:

| From the token path | Rule | Example |
| --- | --- | --- |
| Figma variable | drop the layer group (`semantic.`, `density.`), dots become slashes | `semantic.text.primary` -> Color / `text/primary` |
| CSS custom property | drop the layer group, dots become hyphens | `--text-primary`, `--control-height`, `--type-body-size` |
| Figma code syntax (WEB) | `var(--name)` | `var(--text-primary)` |

Colour ramp steps are named by perceptual lightness: step = round(10 x (100 - CIELAB L*)), so 0 is white, 1000 is black, higher is darker, and a new step slots in without renaming the others. That is why the comps' deliberate near-twins (three light rails, two held tints) can all exist as named steps.

## Where each mode is valid

Colour mode and density are chosen independently; only these combinations exist:

| Place | Colour modes | Density | How the mode is chosen |
| --- | --- | --- | --- |
| Office desktop | `office-light`, `office-dark` | `office` | Follows the device (`prefers-color-scheme`) unless the person pins light or dark in the person menu |
| Office on a phone, a tablet or a narrow window | `office-light`, `office-dark` | `touch` | Same colour rule; density becomes `touch` on `pointer: coarse` or in a window 720px wide or narrower |
| Crew phone | `field-sun` (default), `field-night` | `touch` | Sun by default. Night only by the crew's own toggle, never by the phone's dark setting (a phone left in dark mode would be unreadable on a roof at noon) |
| Shop tablet or kiosk | `shop-dark` (default), `shop-light` | `glove` | Dark by default. Light ("bright bay") is a per-device kiosk setting |
| Customer phone or browser | `customer-light` (default), `customer-dark`, `customer-sun` | `touch` | Light by default. Dark when the phone is set to dark (`prefers-color-scheme: dark`). Sun when the phone asks for more contrast (`prefers-contrast: more`), which wins over dark |

Not valid: `field-*`, `shop-*` or `customer-*` with `office` density; `shop-*` with `touch`; `office-*`, `field-*` or `customer-*` with `glove`. The app puts a mode and a density on a root only through `scopes` in `app/src/lib/theme.ts`, and its test proves every scope is a combination `tokens.json` lists for a place.

The nine modes follow the comps' three palettes plus the customer page: `office-dark`, `field-night`, `shop-dark` and `customer-dark` share the dark set; `field-sun`, `shop-light` and `customer-sun` share the sun set and differ only in `control.border` (ink on the phone and the customer page, secondary ink on the shop, as the comps draw the buttons); `office-light` and `customer-light` are the light set, with the customer page on white paper and darker ink. `customer-dark` takes the values of `field-night` (ink control edge, as the customer page draws its buttons in light), and `customer-sun` the values of `field-sun`. They stay separate modes because each place has its own contrast rule and control edge, and Figma frames are assigned per place.

## Primitives

### Colour

Every value is a Spine comp value, except `graphite.434` (changed, see Changes from the comps) and `graphite.669` (added for the sun placeholder, see the placeholder change under Contrast).

| Token | Hex | Used for |
| --- | --- | --- |
| `color.white` | `#FFFFFF` | Paper in sun and customer; text on held and you fills |
| `color.graphite.14` | `#FBFBFA` | Office paper |
| `color.graphite.35` | `#F5F5F3` | Dark ink; customer rail; light skeleton sheen |
| `color.graphite.39` | `#F4F4F2` | Sun rail |
| `color.graphite.42` | `#F3F3F1` | Office rail |
| `color.graphite.53` | `#F0F0ED` | Office and customer selected; skeleton base |
| `color.graphite.56` | `#EFEFEC` | Sun selected |
| `color.graphite.84` | `#E7E7E4` | Office hairline and pressed |
| `color.graphite.95` | `#E4E4E0` | Customer hairline and pressed |
| `color.graphite.123` | `#DCDCD8` | Sun hairline and pressed |
| `color.graphite.134` | `#D9D9D5` | Office strong line |
| `color.graphite.170` | `#CFCFCA` | Customer strong line |
| `color.graphite.192` | `#C9C9C4` | Sun strong line |
| `color.graphite.205` | `#C3C5CB` | Dark secondary text; shop control edge |
| `color.graphite.293` | `#AAADB4` | Dark tertiary text |
| `color.graphite.395` | `#8E929A` | Dark control and placeholder edge |
| `color.graphite.434` | `#85888E` | Light control edge (changed from `#8A8D93`) |
| `color.graphite.536` | `#6B6E74` | Light placeholder text and edge (4.5:1 on paper) |
| `color.graphite.561` | `#65686E` | Office tertiary text |
| `color.graphite.627` | `#55585E` | Customer tertiary text |
| `color.graphite.669` | `#4B4E53` | Sun placeholder text and edge (7:1 on paper, rail and selected) |
| `color.graphite.699` | `#45474C` | Office secondary text |
| `color.graphite.734` | `#3D3F44` | Sun and customer secondary text; bright-bay control edge |
| `color.graphite.743` | `#3A3D44` | Dark strong line |
| `color.graphite.820` | `#2A2C31` | Dark hairline and pressed; dark skeleton sheen |
| `color.graphite.887` | `#1C1E23` | Dark selected; dark skeleton base |
| `color.graphite.913` | `#18191B` | Office ink |
| `color.graphite.927` | `#15161A` | Dark rail |
| `color.graphite.946` | `#111214` | Sun and customer ink |
| `color.graphite.961` | `#0D0E10` | Dark paper |
| `color.graphite-alpha.12 / 20 / 30 / 50 / 86` | `#0D0E10` at 12, 20, 30, 50, 86% | Pressed inset shadow, sheet shadow, photo shadow, scrim, photo label plate |
| `color.red.47` | `#FBEFEC` | Held tint (office, customer) |
| `color.red.49` | `#FCEEEC` | Held tint (sun) |
| `color.red.177` | `#EBC4BD` | Held divider (light) |
| `color.red.334` | `#FF7A66` | Held text (dark) |
| `color.red.561` | `#C2311C` | Held text and fill (office, customer) |
| `color.red.650` | `#A01F17` | Held fill (dark) |
| `color.red.665` | `#98201A` | Held text and fill (sun) |
| `color.red.681` | `#8F2213` | Held fill pressed (office, customer) |
| `color.red.759` | `#701812` | Held fill pressed (dark, sun) |
| `color.red.804` | `#4A2520` | Held divider (dark) |
| `color.red.942` | `#1E0F0D` | Held tint (dark) |
| `color.blue.50` | `#EEF0FD` | You tint (light, sun) |
| `color.blue.131` | `#D3D8FA` | You tint edge (office, customer); you fill pressed (dark) |
| `color.blue.164` | `#C9CEF7` | You tint edge (sun) |
| `color.blue.301` | `#9AA4FF` | You (dark) |
| `color.blue.612` | `#3A49D6` | You (office, customer) |
| `color.blue.668` | `#2F3CC0` | You (sun); you fill pressed (office, customer) |
| `color.blue.760` | `#2E3566` | You tint edge (dark) |
| `color.blue.893` | `#181B33` | You tint (dark); you fill pressed (sun) |

### Space, size, radius, border

| Group | Values (px) | Note |
| --- | --- | --- |
| `space.*` | 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48 | 4px base with 2px half steps for tight office rows. Equal to Tailwind's default `--spacing` (0.25rem), so `p-2` = `space.8` |
| `size.*` | 8, 10, 14, 16, 24, 28, 32, 48, 64, 72 | Control heights, icons, spine nodes |
| `radius.*` | 4, 6, 8, 10, 12, 14, 16, 22, `full` (9999) | `radius.4` is for `kbd` only |
| `border.width.*` | 1 (hairline), 2 (touch and glove control edge) | |

### Font

| Token | Value |
| --- | --- |
| `font.family.sans` | `Geist, system-ui, sans-serif` |
| `font.family.mono` | `Geist Mono, Geist, ui-monospace, monospace` (Geist second on purpose, see Typography) |
| `font.weight.*` | regular 400, medium 500, semibold 600, strong 650, bold 700 |
| `font.size.*` | 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 26, 28, 30, 32, 34, 38, 48 |
| `font.line-height.*` (px) | 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 56 |
| `font.tracking.*` (em, `$type: number`) | `0` 0, `m10` -0.01, `m15` -0.015, `m20` -0.02, `m25` -0.025, `m30` -0.03 |

Letter-spacing is a plain number in em because DTCG dimensions allow only px and rem.

## Semantic colour, per mode

`=` marks a role that aliases another role in every mode. Values marked * are not drawn in the comps and were derived from the ramps: `control.fill-pressed`, `signal.you-fill-pressed`, `surface.pressed` and `skeleton.*` in dark and sun.

| Token | CSS | office-light | office-dark | field-sun | field-night | shop-dark | shop-light | customer-light | customer-dark | customer-sun |
|---|---|---|---|---|---|---|---|---|---|---|
| `surface.paper` | `--surface-paper` | `#FBFBFA` | `#0D0E10` | `#FFFFFF` | `#0D0E10` | `#0D0E10` | `#FFFFFF` | `#FFFFFF` | `#0D0E10` | `#FFFFFF` |
| `surface.rail` | `--surface-rail` | `#F3F3F1` | `#15161A` | `#F4F4F2` | `#15161A` | `#15161A` | `#F4F4F2` | `#F5F5F3` | `#15161A` | `#F4F4F2` |
| `surface.selected` | `--surface-selected` | `#F0F0ED` | `#1C1E23` | `#EFEFEC` | `#1C1E23` | `#1C1E23` | `#EFEFEC` | `#F0F0ED` | `#1C1E23` | `#EFEFEC` |
| `surface.pressed` | `--surface-pressed` | `#E7E7E4` | `#2A2C31`* | `#DCDCD8`* | `#2A2C31`* | `#2A2C31`* | `#DCDCD8`* | `#E4E4E0`* | `#2A2C31`* | `#DCDCD8`* |
| `text.primary` | `--text-primary` | `#18191B` | `#F5F5F3` | `#111214` | `#F5F5F3` | `#F5F5F3` | `#111214` | `#111214` | `#F5F5F3` | `#111214` |
| `text.secondary` | `--text-secondary` | `#45474C` | `#C3C5CB` | `#3D3F44` | `#C3C5CB` | `#C3C5CB` | `#3D3F44` | `#3D3F44` | `#C3C5CB` | `#3D3F44` |
| `text.tertiary` | `--text-tertiary` | `#65686E` | `#AAADB4` | `#3D3F44` | `#AAADB4` | `#AAADB4` | `#3D3F44` | `#55585E` | `#AAADB4` | `#3D3F44` |
| `line.hairline` | `--line-hairline` | `#E7E7E4` | `#2A2C31` | `#DCDCD8` | `#2A2C31` | `#2A2C31` | `#DCDCD8` | `#E4E4E0` | `#2A2C31` | `#DCDCD8` |
| `line.strong` | `--line-strong` | `#D9D9D5` | `#3A3D44` | `#C9C9C4` | `#3A3D44` | `#3A3D44` | `#C9C9C4` | `#CFCFCA` | `#3A3D44` | `#C9C9C4` |
| `control.border` | `--control-border` | `#85888E` | `#8E929A` | `#111214` | `#F5F5F3` | `#C3C5CB` | `#3D3F44` | `#111214` | `#F5F5F3` | `#111214` |
| `control.placeholder` | `--control-placeholder` | `#6B6E74` | `#8E929A` | `#4B4E53` | `#8E929A` | `#8E929A` | `#4B4E53` | `#6B6E74` | `#8E929A` | `#4B4E53` |
| `control.fill` = text.primary | `--control-fill` | `#18191B` | `#F5F5F3` | `#111214` | `#F5F5F3` | `#F5F5F3` | `#111214` | `#111214` | `#F5F5F3` | `#111214` |
| `control.fill-pressed` = text.secondary | `--control-fill-pressed` | `#45474C`* | `#C3C5CB`* | `#3D3F44`* | `#C3C5CB`* | `#C3C5CB`* | `#3D3F44`* | `#3D3F44`* | `#C3C5CB`* | `#3D3F44`* |
| `control.on-fill` = surface.paper | `--control-on-fill` | `#FBFBFA` | `#0D0E10` | `#FFFFFF` | `#0D0E10` | `#0D0E10` | `#FFFFFF` | `#FFFFFF` | `#0D0E10` | `#FFFFFF` |
| `focus.ring` = text.primary | `--focus-ring` | `#18191B` | `#F5F5F3` | `#111214` | `#F5F5F3` | `#F5F5F3` | `#111214` | `#111214` | `#F5F5F3` | `#111214` |
| `signal.held` | `--signal-held` | `#C2311C` | `#FF7A66` | `#98201A` | `#FF7A66` | `#FF7A66` | `#98201A` | `#C2311C` | `#FF7A66` | `#98201A` |
| `signal.held-tint` | `--signal-held-tint` | `#FBEFEC` | `#1E0F0D` | `#FCEEEC` | `#1E0F0D` | `#1E0F0D` | `#FCEEEC` | `#FBEFEC` | `#1E0F0D` | `#FCEEEC` |
| `signal.held-text-on-tint` = signal.held | `--signal-held-text-on-tint` | `#C2311C` | `#FF7A66` | `#98201A` | `#FF7A66` | `#FF7A66` | `#98201A` | `#C2311C` | `#FF7A66` | `#98201A` |
| `signal.held-line` | `--signal-held-line` | `#EBC4BD` | `#4A2520` | `#EBC4BD` | `#4A2520` | `#4A2520` | `#EBC4BD` | `#EBC4BD` | `#4A2520` | `#EBC4BD` |
| `signal.held-fill` | `--signal-held-fill` | `#C2311C` | `#A01F17` | `#98201A` | `#A01F17` | `#A01F17` | `#98201A` | `#C2311C` | `#A01F17` | `#98201A` |
| `signal.held-fill-pressed` | `--signal-held-fill-pressed` | `#8F2213` | `#701812` | `#701812` | `#701812` | `#701812` | `#701812` | `#8F2213` | `#701812` | `#701812` |
| `signal.held-on-fill` | `--signal-held-on-fill` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` |
| `signal.you` | `--signal-you` | `#3A49D6` | `#9AA4FF` | `#2F3CC0` | `#9AA4FF` | `#9AA4FF` | `#2F3CC0` | `#3A49D6` | `#9AA4FF` | `#2F3CC0` |
| `signal.you-tint` | `--signal-you-tint` | `#EEF0FD` | `#181B33` | `#EEF0FD` | `#181B33` | `#181B33` | `#EEF0FD` | `#EEF0FD` | `#181B33` | `#EEF0FD` |
| `signal.you-tint-edge` | `--signal-you-tint-edge` | `#D3D8FA` | `#2E3566` | `#C9CEF7` | `#2E3566` | `#2E3566` | `#C9CEF7` | `#D3D8FA` | `#2E3566` | `#C9CEF7` |
| `signal.you-fill` = signal.you | `--signal-you-fill` | `#3A49D6` | `#9AA4FF` | `#2F3CC0` | `#9AA4FF` | `#9AA4FF` | `#2F3CC0` | `#3A49D6` | `#9AA4FF` | `#2F3CC0` |
| `signal.you-fill-pressed` | `--signal-you-fill-pressed` | `#2F3CC0`* | `#D3D8FA`* | `#181B33`* | `#D3D8FA`* | `#D3D8FA`* | `#181B33`* | `#2F3CC0`* | `#D3D8FA`* | `#181B33`* |
| `signal.you-on-fill` | `--signal-you-on-fill` | `#FFFFFF` | `#0D0E10` | `#FFFFFF` | `#0D0E10` | `#0D0E10` | `#FFFFFF` | `#FFFFFF` | `#0D0E10` | `#FFFFFF` |
| `seam.open` = line.strong | `--seam-open` | `#D9D9D5` | `#3A3D44` | `#C9C9C4` | `#3A3D44` | `#3A3D44` | `#C9C9C4` | `#CFCFCA` | `#3A3D44` | `#C9C9C4` |
| `seam.locked` = text.primary | `--seam-locked` | `#18191B` | `#F5F5F3` | `#111214` | `#F5F5F3` | `#F5F5F3` | `#111214` | `#111214` | `#F5F5F3` | `#111214` |
| `seam.pending` = text.secondary | `--seam-pending` | `#45474C` | `#C3C5CB` | `#3D3F44` | `#C3C5CB` | `#C3C5CB` | `#3D3F44` | `#3D3F44` | `#C3C5CB` | `#3D3F44` |
| `skeleton.base` = surface.selected | `--skeleton-base` | `#F0F0ED` | `#1C1E23`* | `#EFEFEC`* | `#1C1E23`* | `#1C1E23`* | `#EFEFEC`* | `#F0F0ED` | `#1C1E23`* | `#EFEFEC`* |
| `skeleton.sheen` | `--skeleton-sheen` | `#F5F5F3` | `#2A2C31`* | `#F5F5F3`* | `#2A2C31`* | `#2A2C31`* | `#F5F5F3`* | `#F5F5F3` | `#2A2C31`* | `#F5F5F3`* |
| `overlay.plate` | `--overlay-plate` | `#0D0E10` 86% | same | same | same | same | same | same | same | same |
| `overlay.on-plate` | `--overlay-on-plate` | `#FFFFFF` | same | same | same | same | same | same | same | same |
| `overlay.scrim` | `--overlay-scrim` | `#0D0E10` 50% | same | same | same | same | same | same | same | same |

### Role rules

- **Surfaces.** `paper` is the working surface. `rail` is the second layer: navigation rail, chips, keypad keys, the customer money card. `selected` marks the selected event or row and is the hover fill for ghost controls on the office. `pressed` is a control that is down (a pressed lens) and the current place in navigation (the comps' rail already uses the hairline colour for it); it carries `text.primary` only.
- **Text.** `primary` for content, `secondary` for supporting text, `tertiary` for times, meta and anything a lens dims. In the sun palette tertiary equals secondary: there is no third grey outdoors. Tertiary is never used on `pressed`.
- **Lines.** `hairline` divides. `strong` is structure (selected-row edge, open seam, a part not cut yet, `kbd`). Neither is ever the only edge of a control.
- **Controls.** `control.border` is the resting edge of every input and secondary button: grey on the office, ink on the crew and customer phones, secondary ink on the shop (the comps' 2px button edges). With `density.control.border-width` (1 / 2 / 2), `border: var(--control-border-width) solid var(--control-border)` is right in every place. `control.placeholder` is the dashed edge of an unknown value or an empty state ("No coil scanned yet") and the colour of a Sample label; a hint is read as text, so the proof checks it as text on paper (4.5:1) and at 7:1 on paper, rail and selected in sun; on the light rail and selected it is checked as a control edge (3:1). Field placeholder hints in the Figma library use `text.tertiary`. `control.fill` is the neutral primary action (Take photo, Find, the customer's primary); `control.on-fill` is its label. `focus.ring` is ink, the same colour as `text.primary`.
- **Held.** `signal.held` is text, icons, node fills and the hold-card border. `held-tint` is the hold cell and hold card; text on it uses `held-text-on-tint` (today equal to `held`; a separate role so one mode can darken it alone), and its internal divider is `held-line`. `held-fill` is Stop work, the stopped banner and the Stop work confirmation, with white `held-on-fill`; `held-fill-pressed` shows while Stop work is held down. The alert sentence is always `held` or `held-on-fill`.
- **You.** `signal.you` is the "Needs you" chip, its dot, its node and the count badge. `you-tint` is a waiting row, `you-tint-edge` its 1px inset edge. `you-fill` is a primary action that answers a needs-you item (Approve change order); dark modes put dark text on it (`you-on-fill`). A lens never dims a held or waiting row.
- **Overlay.** `plate` is the label plate on photos and in the camera finder, the same in every mode because photos are photos. `scrim` sits behind a modal dialog or the bottom sheet only.

## Density, per mode

| Token | CSS | office | touch | glove |
| --- | --- | --- | --- | --- |
| `target.min` | `--target-min` | 24 | 48 | 72 |
| `control.height-small` | `--control-height-small` | 24 | 48 | 72 |
| `control.height` | `--control-height` | 28 | 48 | 72 |
| `control.height-primary` | `--control-height-primary` | 32 | 64 | 72 |
| `control.height-safety` | `--control-height-safety` | 32 | 72 | 72 |
| `control.border-width` | `--control-border-width` | 1 | 2 | 2 |
| `control.radius` | `--control-radius` | 8 | 14 | 14 |
| `control.icon` | `--control-icon` | 16 | 24 | 24 |
| `row.min-height` | `--row-min-height` | 24 | 48 | 72 |
| `space.gutter` | `--space-gutter` | 24 | 16 | 24 |
| `space.gap` | `--space-gap` | 8 | 10 | 12 |
| `radius.card` | `--radius-card` | 12 | 14 | 16 |
| `radius.chip` | `--radius-chip` | 6 | 10 | 8 |
| `radius.sheet` | `--radius-sheet` | 12 | 22 | 16 |
| `spine.node` | `--spine-node` | 8 | 10 | 14 |
| `track.height` | `--track-height` | 14 | 16 | 16 |
| `track.stroke` | `--track-stroke` | 1.5 | 2 | 2 |
| `track.stroke-done` | `--track-stroke-done` | 2 | 2.5 | 2.5 |
| `track.stroke-held` | `--track-stroke-held` | 3 | 3.5 | 3.5 |
| `track.rib-width` | `--track-rib-width` | 3 | 4 | 4 |

### Target sizes

| Density | Every target | Primary action | Notes |
| --- | --- | --- | --- |
| `office` | 24 minimum | 32 | Keyboard first: small 24, default 28, primary 32. A secondary button beside a primary takes the primary height. Every shortcut has a labelled control (Z3.1) |
| `touch` | 48 minimum | 64 | Capture and Stop work sit in a bottom dock in the thumb zone. Stop work has its own row 24px clear of the capture buttons and needs a 2 second hold; a plain tap, Enter or switch press opens the confirmation sheet, whose confirm button is 72 (`control.height-safety`). Tappable rows are 48 |
| `glove` | 72, every control | 72 | Nothing needs a precise tap. Keypad keys are 72 with a 12px gap |

Thumbnails and photos use `radius.chip`; `kbd` uses `radius.4`. On the office, `radius.sheet` is the dialog radius.

## Typography

| Role | Family | office | touch | glove | Use |
| --- | --- | --- | --- | --- | --- |
| `caption` | Geist | 12/16 400 | 14/18 400 | 18/24 400 | Times, meta, small labels. The text floor of each density |
| `body` | Geist | 13/20 400 | 16/24 400 | 20/28 400 | Default text. Touch is 16 (owner decision): the size the app ships on a phone, with its 1.5 line height |
| `lead` | Geist | 14/20 500 | 16/22 500 | 22/30 500 | Event text, list item names; section heads set strong |
| `label` | Geist | 13/20 600 | 16/22 600 | 20/28 600 | Buttons and controls |
| `title` | Geist | 18/24 600 -0.015em | 18/24 650 -0.015em | 22/28 650 -0.015em | Brief sentences, phone header, shop section label |
| `headline` | Geist | 22/28 600 -0.02em | 21/28 600 -0.02em | 32/40 600 -0.02em | Job title (office), stage sentence (phone), work order (shop) |
| `display` | Geist | 22/28 600 -0.02em | 26/32 650 -0.02em | 32/40 600 -0.02em | The largest sentence on a screen (customer greeting) |
| `alert` | Geist | 22/28 600 -0.015em | 22/28 700 | 38/44 700 -0.025em | The held sentence, and the Stop work confirm label |
| `reading` | Geist Mono | 19/26 500 -0.02em | 30/36 500 -0.03em | 28/34 500 -0.01em | A raw reading or code value in a row (money is Geist with tabular figures) |
| `reading-large` | Geist Mono | 34/40 500 -0.03em | 30/36 500 -0.03em | 28/34 500 -0.01em | A reading that is selected, traced or shown as evidence |
| `display-reading` | Geist Mono | 48/56 500 -0.03em | 48/56 500 -0.03em | 48/56 500 -0.03em | The one display-size reading: the raw evidence value in the lineage view (owner decision). One size in every density, because density modes only enlarge |
| `body-mono` | Geist Mono | 13/20 500 | 16/24 500 | 20/28 500 | A code after its plain label in running text ("Coil PMS-2231"). Body size and line height in the mono family; replaces the stamped tag plate |
| `caption-mono` | Geist Mono | 12/16 500 | 14/18 500 | 18/24 500 | A code in meta text. Caption size and line height in the mono family |

Each role is five tokens, `density.type.<role>.{family,size,line-height,weight,tracking}` (CSS `--type-body-size` and so on). Any Geist role may be set strong (`font.weight.semibold`), which gives the Figma styles `Caption/Strong`, `Body/Strong` and `Lead/Strong`. `body-mono` and `caption-mono` alias the size and line height of `body` and `caption`, so a code always sits at its surrounding size; their Figma styles are `Body/Mono` and `Caption/Mono`.

Rules:
- **Floors.** 12px on the office, 14 on touch, 18 on glove. Nothing below 12 anywhere (the shipped family test already bans it).
- **Mono only for codes and machine readings.** Money is Geist with tabular figures, as every reference frame sets it (Track B ruling on TEMPLATES.md open question 1). A code always follows its plain label ("Coil PMS-2231"), and only the code is mono. Inline codes take the surrounding role's size in Geist Mono (`body-mono` and `caption-mono`, Figma `Body/Mono`, `Caption/Mono`); the stamped tag plate is gone. Words, money, times and percentages are Geist with `font-variant-numeric: tabular-nums`.
- **Fractions and primes are always Geist.** The shipped Geist Mono build draws U+215C (⅜) as ⅝. Production fixes it in the font face, not in markup: the Geist Mono `@font-face` declares a `unicode-range` that excludes U+00BC-00BE, U+2150-215E, U+2032 (′) and U+2033 (″), and `font.family.mono` lists Geist second, so those code points fall back to Geist inside any mono run. The comps' `.fr` span still works but is no longer needed.
- **Regression test for the glyph bug** (app browser tests):
  1. Static: the built CSS's Geist Mono `@font-face` has a `unicode-range` that does not cover U+215C, U+215D, U+2032 or U+2033, and the mono stack has Geist second.
  2. Rendered: with the production fonts loaded (`document.fonts.ready`), render `<span class="mono">⅜</span>`, `<span class="mono">⅝</span>` and `<span style="font-family: Geist">⅜</span>` at 40px and screenshot each. The mono ⅜ must differ from the mono ⅝ and match the Geist ⅜ pixel for pixel.
  3. Content: the field measurement `42′ 7⅜″` in `reading` matches a stored reference image.
  Run it on every font upgrade. If a later Geist Mono build fixes the glyph, drop the range exclusion deliberately.
- Sentence case everywhere. No uppercase kickers, no letter-spaced labels.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `motion.fast` | 140ms | Hover, press and focus feedback. No delay, so every tap shows feedback within 100ms (Z3.9) |
| `motion.standard` | 220ms | Disclosure, lens recolour, sheet and panel |
| `motion.seam` | 280ms | The seam lock only |
| `motion.sheen` | 1400ms | Skeleton sheen loop |
| `motion.ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | Every transition. There is one curve |

Rules:
- Motion never carries information alone. State changes recolour; they do not fade.
- The skeleton appears within 200ms and keeps each row's final height, so nothing shifts when data arrives.
- **Seam lock.** "Trace where this came from" (key L accelerates it) draws the locked seam from the event you are on back to its oldest ancestor: one `clip-path` reveal (`inset(100% 0 0 0)` to `inset(0)`) over `motion.seam` with `motion.ease`, starting at the selected event. Clips appear where the chain crosses a handoff. Events off the chain recolour to `text.tertiary` at the same moment; held and waiting rows keep full strength.
- **`prefers-reduced-motion: reduce`.** `motion.fast`, `motion.standard` and `motion.seam` become 0ms: the seam appears already locked, lenses and sheets switch instantly. The skeleton shows `skeleton.base` without the sheen. No translate or scale on page entry. The Stop work hold keeps its 2 second duration (it is a safety interlock, not decoration) and the tap-to-confirm sheet stays available.

## Focus ring

- 2px solid `focus.ring`, ink (`text.primary`), offset 2px outside the element, following the element's radius plus the offset. The same in every density. Blue stays reserved for "needs you".
- Shown on `:focus-visible` for every interactive element; never removed, never replaced by a colour change alone.
- 3:1 against every surface it can sit on (paper, rail, selected, both tints), proven per mode in the contrast report.
- On a filled button the 2px offset shows the container colour between fill and ring, so the ring stays visible on `you-fill`, `held-fill` and the ink `control.fill`.
- `forced-colors: active` uses the system `Highlight` colour.

## The standing seam (brand)

The one IronWrap idea: the standing-seam panel the company rolls and installs. The shield logo is the only fixed asset; everything else stays graphite.

| Element | Geometry tokens | Colour tokens |
| --- | --- | --- |
| **Stage track.** The 11 lifecycle stages as a panel profile: one pan per stage, a rib between pans. The customer view uses 6 stages | `density.track.height` (14 office, 16 phone), `track.rib-width` (3, 4); rib height = track height - 4; baseline 1px above the bottom. Pans not reached and ribs use `track.stroke`, finished pans `track.stroke-done`, the held run inside the current pan `track.stroke-held` | Finished pans and their ribs `seam.locked`; held run `signal.held`; not reached `seam.open` |
| **Seam line.** The spine seen from above: two parallel lines | Open: two 1px lines (`brand.seam.stroke-open`) 3px centre to centre (`pitch-open`). Locked: 1.5px lines 3.5px apart (`stroke-locked`, `pitch-locked`), which keeps the same 2px clear channel. Pending: 1.25px lines 3px apart, dashed 3 on 4 (`stroke-pending`, `pitch-pending`, `brand.seam.dash`) | Open `seam.open` (history); locked `seam.locked` (the traced chain); pending `seam.pending` (not on the server yet: queued photos, planned install and invoice) |
| **Seam clip.** Where a locked seam crosses a stage handoff | 12 x 5 rectangle, radius 1, stroke 1.25 (`brand.clip.*`), centred on the seam | Fill `surface.paper`, stroke `seam.locked` |
| **Event node** | `density.spine.node` (8, 10, 14). A held or waiting node gets a ring of its tint, `brand.node.halo` (3px) | Plain: `text.tertiary` outline on `surface.paper`; on chain `seam.locked`; held `signal.held` + `held-tint` halo; waiting `signal.you` + `you-tint` halo |
| **Parts as panels.** On a long job each part is a small panel | Component geometry (14 x 20, radius 2 in the comp) | Cut and checked `seam.locked`; quarantined `signal.held`; not cut yet a 1px inset `line.strong`, no fill |

Turn the brand up only on the stage track. Anywhere else it breaks the quiet density the spine needs at 186 events.

## Elevation and states

- **Flat.** Dialogs and popovers sit on `surface.paper` with a 1px `line.strong` edge. A modal dims the page with `overlay.scrim`.
- `shadow.sheet` (`0 -8px 28px`, graphite 20%) is the bottom sheet, the one floating surface (the Stop work confirmation), with `radius.sheet` on its top corners.
- `shadow.on-photo` (`0 1px 3px`, graphite 30%) is a badge or control sitting on a photo.
- `shadow.pressed-inset` (`inset 0 1px 2px`, graphite 12%) pairs with `surface.pressed` on a pressed toggle.
- **Hover** (office only): ghost and secondary controls take `surface.selected`. Filled controls do not change on hover.
- **Pressed:** ghost controls `surface.pressed`; filled controls switch to `control.fill-pressed`, `signal.you-fill-pressed` or `signal.held-fill-pressed`.
- **Disabled:** `text.tertiary` label, `line.hairline` edge, no fill, never opacity. Prefer one plain next step (Z3.4) to a disabled control.
- **Unknown:** dashed `control.placeholder`, `text.secondary`, words never digits. A value the viewer can set is a real control, not a dashed placeholder.

## Contrast proof

`node app/src/design-system/contrast-check.mjs` (in the app, `npm run tokens:contrast`) resolves every alias in every colour mode and checks each pair declared in `tokens.json` (`$extensions["com.ironwrap.os"].contrast.pairs`): 49 pairs x 9 modes = 441 checks. Minimums: 4.5:1 text; 3:1 UI (control edge, placeholder edge on rail and selected, focus ring, locked and pending seam). `control.placeholder` on `surface.paper` is checked as text, because Sample labels and hints use it as text. Overrides: every text pair at 7:1 in the sun palette (`field-sun`, `shop-light` and `customer-sun`); `control.placeholder` at 7:1 on paper, rail and selected in the sun palette; `text.primary` at 7:1 in `shop-dark`. `app/scripts/build-tokens.mjs` runs the proof first and writes nothing when it fails. No text pair takes the large-text discount. It also fails on structure: a moded token missing a mode, an alias or nested reference that does not resolve, or a hex that disagrees with its components. Exit code 1 on any failure.

Result of the proof at `2.0.0-draft.3` with the placeholder change below: 441 of 441 pass. The ink focus ring clears 15:1 on every surface it can sit on. Tightest margins: sun held on selected 7.13, sun you on selected 7.21, sun placeholder on selected 7.25, light control edge on selected 3.11. Exempt, with reasons in the report: `line.hairline`, `line.strong`, `seam.open`, `signal.you-tint-edge`, `signal.held-line`, `skeleton.*`, `overlay.scrim`, `signal.held-fill` (Stop work carries its words in `held-on-fill`).

Placeholder change (audit finding 94, LIBRARY-WAVE 16): `control.placeholder` was `#85888E` in the light set, 3.43:1 on office paper and 3.55:1 on customer white, too light for the Sample labels and hints that use it as text. It is now `#6B6E74` (`graphite.536`) in `office-light` and `customer-light`, 4.94:1 and 5.11:1. In the sun set (`field-sun`, `shop-light`, `customer-sun`) it is `#4B4E53` (`graphite.669`): 8.35:1 on white, 7.59:1 on rail and 7.25:1 on selected, where `#55585E` measured 6.2 to 6.5:1 on the grey surfaces. `control.border` keeps `#85888E`.

With the comps' `--control: #8A8D93` the same script fails, among others: control and placeholder edge on rail 2.99 and on selected 2.91 (office), placeholder on selected 2.91 (customer).

## Changes from the comps

For the comp agent, against the comps as of 17:20. Values only; no layout or wording changes.

**Colour**

| Comp | Where | System v2 | Why |
| --- | --- | --- | --- |
| `--control: #8A8D93` | `:root` in base.css; hard-coded on the customer `.sample` | `#85888E` (`control.border` on office and customer; `control.placeholder` is now `#6B6E74`) | 2.99:1 on rail, 2.91:1 on selected; now 3.20 and 3.11 |
| `.lens.pressed` `#E3E3DF` | states-office | `surface.pressed` `#E7E7E4` | Same role as the rail's current item, which already uses `--line` |
| Skeleton `#EEEEEB`, `#F6F6F4`, dot `#E2E2DE` | states-office | `skeleton.base` `#F0F0ED`, `skeleton.sheen` `#F5F5F3`, dot `skeleton.base` | One-off literals become roles |
| Photo tag `rgba(24,25,27,.86)`; finder "live" chip `rgba(13,14,16,.78)` | desktop.css; shop | `overlay.plate` (`#0D0E10` 86%) | One plate everywhere (the scan-failed camera message already uses it) |
| Scrim `rgba(0,0,0,.5)`, sheet shadow `rgba(0,0,0,.2)`, badge shadow `rgba(0,0,0,.3)` | field-phone | `#0D0E10` at 50%, 20%, 30% | Graphite instead of pure black |
| Control edges in `line-2` | search box, Back, evidence buttons, fold "Open" (desktop); keypad keys (shop, also 1.5px to 2px) | `control.border` | An input edge at 1.3:1 fails WCAG 1.4.11; every control gets the same resting edge. `kbd` keeps `line.strong` |

The comment on the dark set in base.css says every text pair is 7:1 or better. One is not: held text on a selected row is 6.53:1 (it passes AA, and the spec only requires 7:1 for shop primary text). Either soften the comment or lift `--held` in dark.

**Type snaps**

| Comp | System v2 role |
| --- | --- |
| 11px lens `kbd` and rail count badge | `caption` 12 (12px floor) |
| 12.5px mono in the right-column chain | inherits `body` 13 |
| Office hold cell sentence 21px | `alert` 22 (NOTES already says 22) |
| Lineage title 20px | `headline` 22 |
| Lineage summary bold 15px | `lead` strong 14 |
| Lineage evidence reading 52px | `display-reading` 48 (its own role, owner decision) |
| Phone Back 15, dock and picker buttons 15 and 17, customer buttons 15 and 17, Stop sheet "Keep working" 18 | `label` 16 |
| Phone Stop work rail label 19, header job name 18/600 | `title` 18/650 |
| Stop sheet heading 23/29 700 | `alert` 22/28 700; the confirm label 22/700 already matches |
| Stop sheet consequence 18/25 500 | `title` 18/24 |
| Customer text 16/23 (greeting line, honest line, to-do, next payment) | `body` 16/24 (touch body is 16, owner decision) |
| Customer step labels 12px | `caption` 14 (touch floor; six labels may need two lines) |
| Customer heading 26/31 | `display` 26/32 |
| Customer money heading 21/27 650 | `headline` 21/28 600 |
| Shop work order 26px | `headline` 32 (NOTES already says 32) |
| Shop hold headline 42/48 | `alert` 38/44 (NOTES already says 38) |
| Shop "No coil scanned yet" 34/40 650 | `headline` 32/40 |
| Shop event text 21/28 400, hold reason 21/28 | `lead` 22/30 500, `body` 20/28 |
| Shop hint, buttons, small event text 19 | `body` or `label` 20 |
| Shop lookup label 21/650, top bar place 22/600 | `title` 22/650 |
| Shop keypad digits 26, Find 22 | `title` 22 and `label` 20 |

**Sizes**

| Comp | System v2 |
| --- | --- |
| Office primary 34, confirm-sheet buttons 36 | `control.height-primary` 32 |
| Office secondary, search, Back 30; lens 26 | `control.height` 28 |
| Office "Set" button 22 | `control.height-small` 24 |
| Office rail item radius 10 | `control.radius` 8 |
| Customer primary 56 | `control.height-primary` 64 |
| Customer secondary edge 1.5px, radius 12 | 2px, `control.radius` 14 |
| Customer side gutter 20 | `space.gutter` 16 |
| Customer update node 9 | `spine.node` 10 |
| Stop sheet "Keep working" 56 | `control.height-primary` 64 |
| Shop buttons 64, keypad keys 66, lookup field 64 | 72 (NOTES already says every tablet control is 72) |
| Shop keypad gap 8, keypad radius 12, thumbnail radius 10 | `space.gap` 12, `control.radius` 14, `radius.chip` 8 |
| Shop work order column padding 28 | `space.gutter` 24 |
| Crew "Offline" chip 40 tall | 48 if it can be tapped |

## Decisions

The owner settled the questions the first draft left open. Each is applied in `tokens.json` and shown where it matters above.

1. **Focus ring colour: ink.** `focus.ring` is `text.primary`, so blue keeps its one meaning, "needs you".
2. **Status colours retire, per screen.** Today's green, amber, blue info and violet "local" statuses become ink with a glyph and words, one screen at a time. Until a screen is repainted, the old names (`--ok`, `--warning`, `--info`, `--local` and their `-soft` and `-line` forms) alias a neutral stand-in, listed in `MIGRATION.md`; no screen is repainted by the token pipeline.
3. **Brass and the stamped job tag retire.** A code is mono text after a plain label: the roles `body-mono` and `caption-mono` are its tokens. The `RefTag` plate keeps rendering through neutral aliases until the component changes.
4. **Night mode on the crew phone is manual only.** Sun is the default whatever the phone's dark setting is. The "Sun mode" button is the crew's switch: on is `field-sun`, off is `field-night`, and the choice lives in the crew phone's own storage, so nothing an earlier release stored can turn night on.
5. **The customer page ships light, dark and sun.** Dark follows the phone's colour scheme (`customer-dark`); increased contrast gives sun (`customer-sun`). All three are `touch`, and only combinations in the table above are used.
6. **Lineage evidence size: a display reading of 48.** `display-reading` is its own role instead of a snap to `reading-large`.
7. **Body size on touch: 16.** `body` is 16/24 on touch, the size the app ships today.
