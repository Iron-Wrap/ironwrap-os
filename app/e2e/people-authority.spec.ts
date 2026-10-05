import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { settleAnimations } from "./settle";
import { expectTouchTarget } from "./touch-target";

/** The People desk is an office surface, so it runs under the office acceptance session.
 *  In the default field mode the fixture session is a crew phone and the route refuses, which
 *  is correct but is not what this spec is about. */
const officeMode = process.env.ACCEPTANCE_MODE === "estimator";

test.describe("the People desk", () => {
  test.skip(!officeMode, "office acceptance session only (ACCEPTANCE_MODE=estimator)");

  test("shows what is blocked before what is clear, and says why", async ({ page }) => {
    await page.goto("/people");
    await expect(
      page.getByRole("heading", { name: "Who may do what, and until when", exact: true }),
    ).toBeVisible();

    // Attention first: the expired subject is above the clear one in the document.
    await expect(page.getByText(/Needs attention, 1 of 2/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Clear, 1", exact: true })).toBeVisible();

    const order = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        expired: text.indexOf("expired.acceptance@example.invalid"),
        clear: text.indexOf("clear.acceptance@example.invalid"),
      };
    });
    expect(order.expired).toBeGreaterThan(-1);
    expect(order.clear).toBeGreaterThan(order.expired);

    // The reason is in words, not carried by a colour.
    await expect(page.getByText(/The expiry date has passed/)).toBeVisible();
    await expect(page.getByText(/Expired 2026-01-01, 231 days ago/)).toBeVisible();

    // Every fact on screen came from the API.
    await expect(page.getByText(/Alberta issuer, AB-CA/).first()).toBeVisible();
    await expect(page.getByText("Fall Protection", { exact: true })).toBeVisible();
  });

  test("meets the target and accessibility floors at 390 and at 1440", async ({ page }) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/people");

      // The route is lazy, so right after goto nothing has mounted and nothing is animating yet.
      // Settle only once the page is on screen, or axe samples it mid-fade at reduced contrast.
      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      await expectTouchTarget(refresh, { name: "Refresh" });
      await settleAnimations(page);

      // Nothing may scroll sideways at either width. Measured against the content box, not the
      // requested viewport: a Linux runner reserves a classic vertical scrollbar, so scrollWidth
      // exceeds the viewport by that width on any page tall enough to scroll, which says nothing
      // about the layout.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const worst = [...document.querySelectorAll("*")]
          .filter((e) => e.getBoundingClientRect().right > doc.clientWidth + 0.5)
          .slice(0, 3)
          .map(
            (e) =>
              `${e.tagName}.${e.className || ""}`.slice(0, 40) +
              " :: " +
              (e.textContent || "").trim().slice(0, 40),
          );
        return { px: doc.scrollWidth - doc.clientWidth, worst };
      });
      expect(
        overflow.px,
        `horizontal overflow at ${width}: ${overflow.worst.join(" | ")}`,
      ).toBeLessThanOrEqual(0);

      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(scan.violations, `axe at ${width}`).toEqual([]);
    }
  });

  test("offers no way to change an authority record from this screen", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: /Who may do what/ })).toBeVisible();

    // Reading is the whole surface: a browser-claimed action has no fulfilment path yet, so
    // the desk must not offer one. Refresh is the only button.
    const buttons = await page.getByRole("button").allInnerTexts();
    const actions = buttons.map((t) => t.trim()).filter(Boolean);
    expect(actions.filter((t) => /verify|renew|revoke|supersede|record/i.test(t))).toEqual([]);

    let mutations = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/v1/authority-records")) {
        mutations += 1;
      }
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForTimeout(400);
    expect(mutations, "the desk sends no non-GET request").toBe(0);
  });
});
