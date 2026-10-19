/**
 * Disabled, for every base control: `text.tertiary` on no fill with a hairline edge, never
 * faded. A busy control (`aria-busy`) is disabled too but keeps its own look while it works.
 * One string for buttons and fields, so the shipped stylesheet carries these rules once.
 */
export const disabledLook =
  "disabled:cursor-not-allowed disabled:not-aria-busy:border-line-hairline disabled:not-aria-busy:bg-transparent disabled:not-aria-busy:text-text-tertiary";

/**
 * The resting look every text field, select and text area shares (design/system-v2, Board 2),
 * read from the density tokens so `data-density` on any ancestor resizes it: the edge is
 * `control.border` at `--control-border-width`, the corner `--control-radius`; the body type
 * comes from the `.ui-input`, `.ui-select` and `.ui-textarea` rule in styles.css. Hover (office
 * only) fills with `surface.selected`; an invalid field takes the held edge; disabled is
 * `disabledLook`. Focus is the ink outline from styles.css. Hints use `text.tertiary`, as the
 * Figma library does.
 */
export const fieldControl = [
  "w-full rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-control-border bg-surface-paper text-text-primary",
  "transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
  "placeholder:text-text-tertiary hover:bg-surface-selected",
  "aria-invalid:border-signal-held aria-busy:cursor-progress",
  disabledLook,
].join(" ");

/**
 * A value the viewer can read but not change: the rail fill and a hairline edge, ink text, no
 * hover. It keeps the ink focus outline, because a read-only field can still be reached and copied.
 */
export const fieldReadOnly = "border-line-hairline bg-surface-rail hover:bg-surface-rail";
