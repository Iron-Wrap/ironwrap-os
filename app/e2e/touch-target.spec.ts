import { expect, test } from "@playwright/test";

import { LAYOUT_UNIT, TOUCH_TARGET_MIN, meetsTouchTarget } from "./touch-target";

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
});
