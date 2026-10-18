# System v2 token pipeline

One source, two outputs, one direction.

```
tokens.json (Git) ──contrast-check──▶ build-tokens.mjs ──▶ app/src/styles/tokens.css
        │
        └──▶ figma-sync job (local bridge, plugin API) ──▶ Figma variables + styles
```

## Source

`app/src/design-system/tokens.json` in Git is the only place a token value is edited. It lives beside `contrast-check.mjs` and replaced `figma-token-map.json`, which the derivable naming rule made unnecessary. A token change is a pull request: edit `tokens.json`, run `npm run tokens` in `app/`, commit both. The `app` job of `make check` (CI's `pwa` job) runs `npm run tokens:contrast` and `npm run tokens:check` (`node scripts/build-tokens.mjs --check`) before typecheck, and `scripts/styles.family.test.ts` repeats both under `npm test`.

## CSS: `app/scripts/build-tokens.mjs`

Zero-dependency Node, about 170 lines. It runs the contrast proof first and refuses to write on any failure, then generates `app/src/styles/tokens.css`, which `styles.css` imports after `@import "tailwindcss"`. `--check` exits 1 if the file on disk differs from what it would write. `npm run tokens` writes it. Values come out in the units `tokens.json` holds (px, ms, em for letter-spacing); a mode is `color-scheme: dark` when its paper is dark; `$extensions["com.ironwrap.os"].defaults` names the mode and density on `:root`, and `system` names the ones the device chooses when an element has no attribute.

**Naming.** Token path minus the layer group, dots to hyphens: `semantic.text.primary` -> `--text-primary`, `density.control.height` -> `--control-height`, `density.type.body.size` -> `--type-body-size`, `motion.seam` -> `--motion-seam`, `brand.seam.pitch-open` -> `--brand-seam-pitch-open`. The same path with slashes is the Figma variable name, and `var(--name)` is its code syntax, so Figma dev mode shows exactly what the code uses. The build fails on any two tokens that produce the same name, and on a compatibility alias that collides with a token or reads a property that is not generated.

Why this rule: it is derivable in both directions, so no mapping file can drift, and it reads the same in Figma, CSS and review. Compatibility is kept where it costs nothing: `--motion-fast`, `--motion-standard` and `--motion-ease` already follow it and keep their names; the Tailwind `@theme` names stay; the old raw names get generated aliases for one release (below).

**What is emitted.** Semantic colour and density tokens, plus the non-colour constants components read directly (`font.family.*`, `motion.*`, `shadow.*`, `brand.*`). Colour primitives are never emitted, so a component cannot reach past a role. Space primitives are not emitted either: Tailwind's `--spacing` (0.25rem) already is the 4px scale.

**What ships.** `tokens.css` carries every token; the production bundle does not. The stylesheet is render-blocking, so first paint waits for every byte, and the paired-device budget has tens of milliseconds of headroom: the generated tokens cost about 1.1 KB gzip over the palette they replaced, which measured 40 to 55 ms of first paint. `vite.config.ts` therefore drops each token declaration that nothing reads through `var(--name)`, repeating until the dead aliases and the tokens only they read are gone (`scripts/prune-tokens.ts`). The reads are the stylesheet's own utilities after Tailwind has generated them, plus every other stylesheet and script under `src`, so a token is live the moment a utility or component reads it and there is no list to maintain. The prune runs before Vite names and minifies the file, which keeps the content hash honest: the service worker precaches hashed files without a revision. `scripts/verify-dist.mjs` fails the build when the bundle reads a token it no longer declares. Build a variable name whole (`var(--text-primary)`), never from parts, or the build cannot see the read. The dev server and the committed file keep every token. With the pruning the stylesheet is about 0.4 KB smaller on the wire than before the pipeline.

**Shape.**

```css
/* Generated from tokens.json by scripts/build-tokens.mjs. Do not edit. */
:root, [data-mode="office-light"] { color-scheme: light; --surface-paper: #fbfbfa; /* every semantic token */ }
@media (prefers-color-scheme: dark) { :root:not([data-mode]) { color-scheme: dark; /* office-dark */ } }
[data-mode="office-dark"]    { color-scheme: dark;  /* … */ }
[data-mode="field-sun"]      { color-scheme: light; /* … */ }
/* field-night, shop-dark, shop-light, customer-light, customer-dark, customer-sun */
:root, [data-density="office"] { --control-height: 28px; --type-body-size: 13px; /* … */ }
@media (pointer: coarse) { :root:not([data-density]) { /* touch */ } }
[data-density="touch"] { /* … */ }
[data-density="glove"] { /* … */ }
:root { --font-family-sans: Geist, system-ui, sans-serif; --motion-seam: 280ms; --motion-ease: cubic-bezier(0.16, 1, 0.3, 1); /* … */ }
@media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; --motion-standard: 0ms; --motion-seam: 0ms; } }
```

- Every mode block carries a resolved value for every token. Aliases are resolved at build time, never written as `var()` between tokens: a custom property that references another is substituted on the element where it is declared, so a subtree that switches `data-mode` would otherwise inherit its parent's resolved value. The shipped CSS already hit this with the tag aliases.
- Modes nest: the crew shell sets `data-mode="field-sun" data-density="touch"` on its root; a dialog inside it inherits both.
- The Geist Mono `@font-face` (in `styles.css`, beside the other faces) carries the `unicode-range` that sends fractions and primes to Geist; see `TOKENS.md`, Typography.

**Tailwind.** `@theme inline` in `styles.css` maps utility names to the properties: the shipped names stay and point at the new properties (`--color-foreground: var(--text-primary)`, `--color-danger: var(--signal-held)`, `--color-primary: var(--control-fill)`, …), so the existing `bg-*`, `text-*` and `border-*` utilities keep working with no codemod. New roles get utilities named after their property (`bg-signal-held-tint`, `text-signal-you`, `bg-surface-pressed`); `scripts/styles.family.test.ts` fails when a `semantic.*` role has no mapping or the theme reads a property that is not generated. `inline` matters: the utility then reads the property on the element that uses it, so nested modes work.

**Compatibility aliases.** For one release the build also writes the old raw names (`--foreground`, `--muted`, `--border-control`, `--danger`, … per `MIGRATION.md`) as `var(--new)`, declared on `:is(:root, [data-mode], [data-density])` so each mode scope resolves its own. The map lives in `tokens.json` (`$extensions["com.ironwrap.os"].compat.aliases`); retired names alias their neutral stand-in. `npm run tokens:aliases` lists the call sites that still read them (`var(--name)` uses and the Tailwind utilities built on the shipped names); an alias is deleted from the map when its row reaches zero, and the key when the map is empty.

**Modes in the app.** The office appearance is `data-mode` on `<html>` (`src/lib/theme.ts`, same storage key as before); with no attribute the device decides. The crew phone, the shop reading view and the customer page carry their own `data-mode` and `data-density` on their roots, taken from `scopes` in `theme.ts`, whose test proves each pair is a combination `tokens.json` lists for a place. A mode scope repaints its own ground and ink in `styles.css`, because an inherited `color` is a computed value.

## Figma: through the local bridge

Code Connect is unavailable on the Pro plan, and the Figma MCP quota is shared, so Figma is written by a plugin-API job through the local Iron Wrap Figma bridge (a plugin-API job queue on the designer's machine; the "Iron Wrap bridge" plugin runs the job inside the file).

`app/scripts/figma-sync-tokens.mjs` (zero-dependency Node) writes the job: `tokens.json` inlined into a plugin-API function body. The job:
1. Reads collections, modes and variables; on the first run applies the renames in `MIGRATION.md` so variable and mode IDs survive. Collections: colour primitives and font families in `Primitives` (hidden from publishing); semantic colour in `Color` (nine modes); every number in `Density` (three modes).
2. Upserts each variable by name and writes `valuesByMode`: literals for primitives, `createVariableAlias` for every alias so Figma shows the chain (`text/primary` -> `color/graphite/900`).
3. Sets code syntax `setVariableCodeSyntax("WEB", "var(--…)")` from the naming rule, the description from `$description`, and scopes by group: `surface/*` frame and shape fill, `text/*` text fill, `line/*`, `control/border`, `seam/*` stroke, `space/*` gap and padding, `radius/*` corner radius, `type/*` font size, line height, weight and letter spacing.
4. Binds the sixteen text styles to their `type/<role>/*` variables (`Body/Mono`, `Caption/Mono` and `Reading/Display` to `body-mono`, `caption-mono` and `display-reading`) and writes the effect styles. Letter spacing is stored in em; if Figma applies a bound letter-spacing value in px, the job writes size times em per role and mode instead.
5. Returns a receipt: created, renamed, changed and untouched counts, and every ID. A second run with no token change reports zero changes.

Direction is one way. A variable edited in Figma is overwritten by the next sync. A `--diff` run of the same job reads Figma and reports drift against `tokens.json`, so a designer's change comes back as a pull request instead of being lost or silently kept.
