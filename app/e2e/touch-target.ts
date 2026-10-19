import { expect, test, type Locator } from "@playwright/test";

/** CSS layout units can be represented just below an integer in Chromium. */
export const TOUCH_TARGET_MIN = 44;
/** The office's keyboard-and-mouse target (design/system-v2/TOKENS.md, Target sizes). */
export const OFFICE_TARGET_MIN = 24;
export const LAYOUT_UNIT = 1 / 64;
export const TOLERANCE = LAYOUT_UNIT / 2;

export function meetsTouchTarget(measured: number, min = TOUCH_TARGET_MIN): boolean {
  return measured >= min - TOLERANCE;
}

/**
 * The floor a control is held to by default. It comes from the project the test runs in, never
 * from the control's own tokens, so a control whose token shrank cannot pass by its own measure:
 * 44px on a phone project (`isMobile`), 24px on a desktop one, the office's keyboard-and-mouse
 * target. A place whose spec asks for more, such as 48 on the crew phone, passes `min`.
 */
export function defaultTargetMin(): number {
  return test.info().project.use.isMobile ? TOUCH_TARGET_MIN : OFFICE_TARGET_MIN;
}

export async function expectTouchTarget(
  locator: Locator,
  {
    name,
    min,
    axis = "both",
  }: {
    name: string;
    /** A fixed floor; by default `defaultTargetMin`. */
    min?: number;
    axis?: "both" | "height";
  } = { name: "control" },
): Promise<void> {
  await expect(locator, `${name} should be visible`).toBeVisible();
  const floor = min ?? defaultTargetMin();
  const box = await locator.boundingBox();
  expect(box, `${name} should have a measurable box`).not.toBeNull();

  expect(
    meetsTouchTarget(box?.height ?? 0, floor),
    `${name} height should be at least ${floor}px`,
  ).toBe(true);
  if (axis === "both") {
    expect(
      meetsTouchTarget(box?.width ?? 0, floor),
      `${name} width should be at least ${floor}px`,
    ).toBe(true);
  }
}
