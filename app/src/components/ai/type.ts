import "./ai.css";

/**
 * The System v2 type roles the AI parts use, read from the density tokens so `data-density`
 * on any ancestor raises them (TOKENS.md, Typography). The face stays the app's text face; mono is
 * only for codes and machine readings, never money, which is the text face with tabular figures.
 */
export const type = {
  caption: "text-[length:var(--type-caption-size)] leading-[var(--type-caption-line-height)]",
  body: "text-[length:var(--type-body-size)] leading-[var(--type-body-line-height)]",
  lead: "text-[length:var(--type-lead-size)] leading-[var(--type-lead-line-height)]",
  title:
    "text-[length:var(--type-title-size)] leading-[var(--type-title-line-height)] tracking-[var(--type-title-tracking)]",
  /**
   * The same roles on an h1 to h3: the global heading leading in styles.css is unlayered, so it
   * outranks a layered utility unless the utility is important.
   */
  bodyHeading: "text-[length:var(--type-body-size)] leading-[var(--type-body-line-height)]!",
  leadHeading: "text-[length:var(--type-lead-size)] leading-[var(--type-lead-line-height)]!",
  titleHeading:
    "text-[length:var(--type-title-size)] leading-[var(--type-title-line-height)]! tracking-[var(--type-title-tracking)]",
  captionMono:
    "font-mono text-[length:var(--type-caption-mono-size)] leading-[var(--type-caption-mono-line-height)]",
  money: "tabular-nums",
} as const;
