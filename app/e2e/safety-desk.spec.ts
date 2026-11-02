import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { settleAnimations } from "./settle";
import { expectTouchTarget } from "./touch-target";

test.describe("the safety desk", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "office acceptance session only");

  test.beforeEach(async ({ request }) => {
    expect((await request.post("/__acceptance/safety/reset")).ok()).toBe(true);
  });

  test("records an inspection from the equipment list and reads the quarantined revision", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety");
    await page.getByRole("link", { name: "Equipment", exact: true }).click();
    await page.getByRole("link", { name: "Open equipment", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Inspect safety equipment" })).toBeVisible();
    await page
      .getByLabel("Inspection findings")
      .fill("Harness stitching is damaged. Remove from use.");
    const save = page.getByRole("button", { name: "Record inspection", exact: true });
    await expectTouchTarget(save, { name: "Record inspection" });
    await settleAnimations(page);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    const sent = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().endsWith("/inspections"),
    );
    await save.click();
    const request = await sent;
    // The verdict is bound to the revision the inspector read; the server refuses any other.
    expect(request.postDataJSON()).toEqual({
      result: "fail",
      detail: "Harness stitching is damaged. Remove from use.",
      expected_version: 1,
    });
    expect(request.headers()["x-csrf-token"]).toBeTruthy();
    await expect(page.getByText("Inspection recorded", { exact: true })).toBeVisible();
    await expect(page.getByText("Quarantined", { exact: true })).toBeVisible();
    // A version number never stands in a person's line (ruling).
    await expect(page.getByText(/revision \d/)).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });

  test("verifies independently and closes a corrective action from the desk", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety");
    await page
      .locator('section[aria-labelledby="tracking"]')
      .getByRole("link", { name: "Open action" })
      .first()
      .click();
    await page.getByLabel("Decision findings").fill("Replacement label checked independently.");
    const verify = page.getByRole("button", { name: "Verify the fix" });
    await expectTouchTarget(verify, { name: "Verify the fix" });
    await settleAnimations(page);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await verify.click();
    const close = page.getByRole("button", { name: "Close action", exact: true });
    await expect(close).toBeVisible();
    await page
      .getByLabel("Decision findings")
      .fill("Independent verification accepted; close action.");
    await expectTouchTarget(close, { name: "Close action" });
    await close.click();
    await expect(page.getByText("Decision recorded", { exact: true })).toBeVisible();
    await expect(close).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });

  test("uploads evidence saved before an offline reload as soon as the network returns", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety/corrective-actions/ca_acceptance_blocking");
    // The offline reload below needs the installed app shell, so wait for the service worker
    // to take control of this page first.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
        );
    });
    await page.getByLabel("Stored evidence reference").fill("r2://safety/tie-off-check.pdf");
    await page.getByLabel("Evidence SHA-256").fill("a".repeat(64));
    await page.getByLabel("What was fixed").fill("Tie-off installed and checked.");
    const evidencePosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/ca_acceptance_blocking/evidence"))
        evidencePosts.push(request.headers()["idempotency-key"] ?? "");
    });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Save evidence" }).click();
    await expect(page.getByText("Evidence saved on this device", { exact: true })).toBeVisible();

    // The app is closed and reopened without signal: it signs in from the offline snapshot.
    await page.reload();
    await expect(
      page.getByText("Evidence saved on this device is waiting to upload", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save evidence" })).toHaveCount(0);
    await expect(
      page
        .getByText("Sign-in paused", { exact: true })
        .or(page.getByText("Offline", { exact: true })),
    ).toBeVisible();

    // Signal returns. No reload, no Refresh: the queue drains and the readback is shown.
    const uploaded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/ca_acceptance_blocking/evidence") &&
        response.request().method() === "POST",
    );
    await context.setOffline(false);
    expect((await uploaded).ok()).toBe(true);
    await expect(
      page.getByText("Independent verification required", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/revision \d/)).toHaveCount(0);
    await expect(
      page.getByText("Evidence saved on this device is waiting to upload", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Sign-in paused")).toHaveCount(0);
    // Exactly one server effect, carrying the device action id as its idempotency key.
    expect(evidencePosts).toHaveLength(1);
    expect(evidencePosts[0]).toMatch(/\S/);
  });

  test("keeps findings and the action in place when the sign-in ends mid-decision", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety/corrective-actions/ca_acceptance_tracking");
    await page.getByLabel("Decision findings").fill("Replacement label checked independently.");
    expect((await page.request.post("/__acceptance/safety/revoke-session")).ok()).toBe(true);
    await page.getByRole("button", { name: "Verify the fix" }).click();
    await expect(
      page.getByText("Your sign-in ended before this was recorded", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Decision findings")).toHaveValue(
      "Replacement label checked independently.",
    );
    await expect(page.getByText(/Action ca_acceptance_tracking\. Owned by/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify the fix" })).toBeDisabled();
    expect(page.url()).toContain("/safety/corrective-actions/ca_acceptance_tracking");
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);

    // The session is restored (fixture reset keeps the record state). Nothing was recorded.
    expect((await page.request.post("/__acceptance/safety/reset")).ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh action" }).click();
    await expect(page.getByRole("button", { name: "Verify the fix" })).toBeEnabled();
    await page.getByRole("button", { name: "Verify the fix" }).click();
    await expect(page.getByText("Decision recorded", { exact: true })).toBeVisible();
  });

  test("refuses the occurrence reporter as verifier even with full authority", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety/corrective-actions/ca_acceptance_reported");
    await expect(page.getByText(/Re-hang the fire extinguisher sign/)).toBeVisible();
    await expect(page.getByText("Evidence submitted", { exact: false }).first()).toBeVisible();
    await expect(
      page.getByText("Independent verification required", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify the fix" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject the evidence" })).toHaveCount(0);
    // The fixture server refuses the same actor on the wire, not only in the projection.
    const refused = await page.request.post(
      "/api/v1/safety/corrective-actions/ca_acceptance_reported/verification",
      { data: { verdict: "verified", detail: "Reporter trying to close its own loop." } },
    );
    expect(refused.status()).toBe(409);
    await page.reload();
    await expect(page.getByText(/Action ca_acceptance_reported\. Owned by/)).toBeVisible();
  });

  test("queues evidence offline, uploads after reconnect, and refuses self-verification", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/safety/corrective-actions/ca_acceptance_blocking");
    await page.getByLabel("Stored evidence reference").fill("r2://safety/tie-off-check.pdf");
    await page.getByLabel("Evidence SHA-256").fill("a".repeat(64));
    await page.getByLabel("What was fixed").fill("Tie-off installed and checked.");
    const save = page.getByRole("button", { name: "Save evidence" });
    await expectTouchTarget(save, { name: "Save evidence" });
    await context.setOffline(true);
    await save.click();
    await expect(page.getByText("Evidence saved on this device", { exact: true })).toBeVisible();
    await expect(page.getByText("Evidence accepted by the server", { exact: true })).toHaveCount(0);
    const uploaded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/ca_acceptance_blocking/evidence") &&
        response.request().method() === "POST",
    );
    await context.setOffline(false);
    expect((await uploaded).ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh action" }).click();
    await expect(
      page.getByText("Independent verification required", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify the fix" })).toHaveCount(0);
  });

  for (const width of [390, 1440]) {
    test(`puts release blockers first and fits ${width}px with accessible controls`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v1/safety/") && request.method() !== "GET") {
          mutations.push(`${request.method()} ${request.url()}`);
        }
      });
      await page.goto("/safety");
      await expect(
        page.getByRole("heading", { name: "Stops work now, 2", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("The last inspection failed. Take this harness out of service."),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Due soon, 1", exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Open, not stopping work, 2", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Usable, 1", exact: true })).toBeVisible();
      const headings = await page.locator("main h2").allTextContents();
      expect(headings.indexOf("Stops work now, 2")).toBeLessThan(headings.indexOf("Usable, 1"));

      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      await expectTouchTarget(refresh, { name: "Refresh safety desk" });
      const refreshed = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/safety/desk") && response.request().method() === "GET",
      );
      await refresh.click();
      expect((await refreshed).ok()).toBe(true);
      await expect(refresh).toBeEnabled();
      expect(mutations).toEqual([]);
      await settleAnimations(page);

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return {
          px: doc.scrollWidth - doc.clientWidth,
          worst: [...document.querySelectorAll("*")]
            .filter((element) => element.getBoundingClientRect().right > doc.clientWidth + 0.5)
            .slice(0, 3)
            .map(
              (element) =>
                `${element.tagName}.${element.className} :: ${(element.textContent ?? "").trim().slice(0, 40)}`,
            ),
        };
      });
      expect(
        overflow.px,
        `horizontal overflow at ${width}: ${overflow.worst.join("; ")}`,
      ).toBeLessThanOrEqual(0);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
});
