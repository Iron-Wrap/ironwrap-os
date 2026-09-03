import type { Page } from "@playwright/test";

/** Wait until animated layout and contrast state have settled before inspection. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== "running"),
    undefined,
    { timeout: 5000 },
  );
}
