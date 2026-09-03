import { expect, type Locator } from "@playwright/test";

/** CSS layout units can be represented just below an integer in Chromium. */
export const TOUCH_TARGET_MIN = 44;
export const LAYOUT_UNIT = 1 / 64;
export const TOLERANCE = LAYOUT_UNIT / 2;

export function meetsTouchTarget(measured: number, min = TOUCH_TARGET_MIN): boolean {
  return measured >= min - TOLERANCE;
}

export async function expectTouchTarget(
  locator: Locator,
  {
    name,
    min = TOUCH_TARGET_MIN,
    axis = "both",
  }: {
    name: string;
    min?: number;
    axis?: "both" | "height";
  } = { name: "control" },
): Promise<void> {
  await expect(locator, `${name} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} should have a measurable box`).not.toBeNull();

  expect(
    meetsTouchTarget(box?.height ?? 0, min),
    `${name} height should be at least ${min}px`,
  ).toBe(true);
  if (axis === "both") {
    expect(
      meetsTouchTarget(box?.width ?? 0, min),
      `${name} width should be at least ${min}px`,
    ).toBe(true);
  }
}
