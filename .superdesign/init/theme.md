# IronWrap OS theme

## Compact token summary

- Typeface: Inter Variable, system sans fallback.
- Surfaces: warm neutral light canvas and olive-charcoal dark canvas.
- Accent: amber/yellow for primary action and attention.
- Semantic status: green success, amber warning, red danger, blue information.
- Geometry: 8px, 12px, and 16px radii; cards use a restrained 1px border and subtle shadow.
- Focus: 3px information-color outline with 3px offset.
- Motion: color transitions only; all motion collapses under `prefers-reduced-motion`.
- Mobile: safe-area top/bottom variables are part of the visual contract.

## Raw global theme — `app/src/styles.css`

```css
@import "tailwindcss";

@theme inline {
  --font-sans: "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;

  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-surface-muted: var(--surface-muted);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-ok: var(--ok);
  --color-ok-soft: var(--ok-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-danger: var(--danger);
  --color-danger-foreground: var(--danger-foreground);
  --color-danger-soft: var(--danger-soft);
  --color-info: var(--info);
  --color-info-soft: var(--info-soft);

  --radius-sm: 0.5rem;
  --radius-md: 0.75rem;
  --radius-lg: 1rem;
  --radius-xl: 1rem;
}

:root {
  color-scheme: light;
  --background: oklch(0.975 0.006 118);
  --surface: oklch(0.995 0.002 118);
  --surface-raised: oklch(1 0 0);
  --surface-muted: oklch(0.944 0.008 118);
  --foreground: oklch(0.19 0.018 118);
  --muted: oklch(0.45 0.018 118);
  --border: oklch(0.84 0.012 118);
  --accent: oklch(0.77 0.17 82);
  --accent-foreground: oklch(0.16 0.02 82);
  --ok: oklch(0.43 0.12 145);
  --ok-soft: oklch(0.93 0.045 145);
  --warning: oklch(0.48 0.15 65);
  --warning-soft: oklch(0.94 0.055 75);
  --danger: oklch(0.49 0.18 27);
  --danger-foreground: oklch(0.99 0 0);
  --danger-soft: oklch(0.94 0.04 27);
  --info: oklch(0.48 0.13 250);
  --info-soft: oklch(0.93 0.035 250);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: oklch(0.15 0.012 118);
    --surface: oklch(0.19 0.014 118);
    --surface-raised: oklch(0.23 0.016 118);
    --surface-muted: oklch(0.27 0.014 118);
    --foreground: oklch(0.95 0.008 118);
    --muted: oklch(0.73 0.015 118);
    --border: oklch(0.34 0.015 118);
    --accent: oklch(0.8 0.16 82);
    --accent-foreground: oklch(0.18 0.02 82);
    --ok: oklch(0.72 0.14 145);
    --ok-soft: oklch(0.27 0.055 145);
    --warning: oklch(0.79 0.15 75);
    --warning-soft: oklch(0.29 0.055 75);
    /* Dark mode lightens danger, so white text on it fails WCAG AA (2.64:1).
       Pair it with a dark foreground, exactly as --accent does above. */
    --danger: oklch(0.72 0.16 27);
    --danger-foreground: oklch(0.18 0.02 27);
    --danger-soft: oklch(0.28 0.07 27);
    --info: oklch(0.73 0.12 250);
    --info-soft: oklch(0.27 0.055 250);
  }
}

* {
  border-color: var(--border);
}

html {
  min-width: 320px;
  min-height: 100%;
  background: var(--background);
  font-family: "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
  text-rendering: optimizeLegibility;
}

body {
  min-height: 100dvh;
  margin: 0;
  background: var(--background);
  color: var(--foreground);
}

button,
input,
textarea,
select {
  font: inherit;
}

button,
a,
input,
textarea,
select {
  touch-action: manipulation;
}

:focus-visible {
  outline: 3px solid color-mix(in oklch, var(--info) 72%, transparent);
  outline-offset: 3px;
}

::selection {
  background: color-mix(in oklch, var(--accent) 48%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

.safe-bottom {
  --safe-bottom-inset: max(1rem, env(safe-area-inset-bottom));

  padding-bottom: var(--safe-bottom-inset);
}

.safety-action-drawer {
  bottom: calc(4rem + var(--safe-bottom-inset));
}

.safe-top {
  padding-top: env(safe-area-inset-top);
}
```
