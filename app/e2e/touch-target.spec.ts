import { expect, test } from "@playwright/test";

import {
  LAYOUT_UNIT,
  OFFICE_TARGET_MIN,
  TOUCH_TARGET_MIN,
  defaultTargetMin,
  meetsTouchTarget,
} from "./touch-target";

test.describe("touch-target tolerance", () => {
  test("admits measurement noise and still rejects a real shortfall", () => {
    expect(meetsTouchTarget(TOUCH_TARGET_MIN)).toBe(true);
    expect(meetsTouchTarget(43.999969482421875)).toBe(true);

    expect(meetsTouchTarget(TOUCH_TARGET_MIN - LAYOUT_UNIT)).toBe(false);
    expect(meetsTouchTarget(43)).toBe(false);
    expect(meetsTouchTarget(0)).toBe(false);

    expect(meetsTouchTarget(48, 48)).toBe(true);
    expect(meetsTouchTarget(48 - LAYOUT_UNIT, 48)).toBe(false);
  });

  test("holds a phone project to 44px and a desktop project to the office's 24px", () => {
    expect(defaultTargetMin()).toBe(
      test.info().project.name === "mobile-chromium" ? TOUCH_TARGET_MIN : OFFICE_TARGET_MIN,
    );
  });
});
