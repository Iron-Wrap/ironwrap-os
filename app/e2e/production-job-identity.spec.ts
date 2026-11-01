import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  identityStates,
  malformedProductionIdentityFixture,
  nativeJobIdentityFixtures,
  productionIdentityFixture,
  syntheticNativeJobId,
} from "./fixtures/production-identity";

const captureDir = process.env.PRODUCTION_D5_CAPTURE_DIR;
const states = identityStates;

test.describe("Production job identity representation", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "requires the synthetic office session");

  for (const state of states) {
    test(`renders the ${state} identity without inferred data or authority`, async ({
      page,
    }, testInfo) => {
      const valid = productionIdentityFixture(state === "malformed" ? "known" : state);
      const identity = valid.jobs[0]!;
      const body = state === "malformed" ? malformedProductionIdentityFixture() : valid;
      const reads: string[] = [];
      await page.route(
        (url) => url.pathname === "/api/v1/production",
        async (route) => {
          const url = new URL(route.request().url());
          reads.push(url.pathname + url.search);
          expect(url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
            headers: { "Cache-Control": "private, no-store" },
          });
        },
      );
      await page.goto("/production");

      if (state === "malformed") {
        await expect(page.getByRole("heading", { name: "Job plan could not load" })).toBeVisible();
        await expect(page.getByText("Synthetic Customer One")).toHaveCount(0);
      } else {
        await expect(page.getByRole("heading", { name: "Production plan" })).toBeVisible();
        await expect(page.getByText("native-job:synthetic-d5", { exact: true })).toBeHidden();
        if (state === "legacy" || state === "unknown") {
          await expect(page.getByText("Customer name not available")).toBeVisible();
          await expect(page.getByText("Site address not available")).toBeVisible();
        } else {
          await expect(
            page.getByText(identity.customer_display_name!, { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(String(identity.address), { exact: true })).toBeVisible();
        }
        await expect(
          page.getByRole("heading", {
            name:
              state === "unknown"
                ? "Job number Not recorded"
                : `Job number ${body.jobs[0]!.job_number}`,
          }),
        ).toBeVisible();
        await expect(page.getByLabel("Materials: Blocked")).toBeVisible();
        await expect(page.getByRole("button", { name: /clear|schedule|dispatch/i })).toHaveCount(0);
      }

      expect(reads).toEqual(["/api/v1/production?include_job_identity=1"]);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const size = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(size.content).toBeLessThanOrEqual(size.viewport);
      if (captureDir) {
        await mkdir(captureDir, { recursive: true });
        await page.screenshot({
          path: join(captureDir, `${state}-top-${testInfo.project.name}.png`),
        });
        if (state !== "malformed") {
          await page.evaluate(() =>
            window.scrollTo({ top: document.documentElement.scrollHeight }),
          );
          await page.screenshot({
            path: join(captureDir, `${state}-bottom-${testInfo.project.name}.png`),
          });
        }
      }
    });
  }
});

test.describe("Current production job finder", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "requires the synthetic office session");

  test("switches the selected current row after reading a disclosure", async ({ page }) => {
    const production = productionIdentityFixture("known");
    production.jobs.push({
      ...production.jobs[0]!,
      id: "native-job:synthetic-d5-second",
      job_number: "IW-SYNTH-SECOND",
      customer_display_name: "Synthetic Second Customer",
      address: "200 Second Example Street, Example City, AB",
    });
    production.summary.active_jobs = 2;
    production.summary.blocked = 2;
    await page.route(
      (url) => url.pathname === "/api/v1/production",
      (route) => route.fulfill({ status: 200, json: production }),
    );
    await page.goto("/production");
    await page.getByRole("button", { name: "Find a job" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /IW-SYNTH-D5 / }).click();
    await dialog.locator("summary").click();
    await expect(dialog.getByText(syntheticNativeJobId, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Choose another job" }).click();
    await dialog.getByRole("button", { name: /IW-SYNTH-SECOND/ }).click();
    await expect(dialog.getByRole("heading", { name: "Job number IW-SYNTH-SECOND" })).toBeFocused();
    await expect(dialog.getByText("Synthetic Second Customer", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Synthetic Customer One", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(syntheticNativeJobId, { exact: true })).toHaveCount(0);
    await expect(dialog.locator("details")).not.toHaveAttribute("open");
    await expect(dialog.getByRole("link", { name: "Open IW-SYNTH-SECOND" })).toHaveAttribute(
      "href",
      "/jobs/native-job%3Asynthetic-d5-second",
    );
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: "Find a job" })).toBeFocused();
  });

  for (const state of states) {
    test(`reads ${state} through the real chooser, disclosure and same-native routes`, async ({
      page,
    }, testInfo) => {
      const device =
        testInfo.project.name === "mobile-chromium"
          ? { width: 390, height: 844 }
          : { width: 1280, height: 720 };
      await page.setViewportSize(device);
      let malformed = state === "malformed";
      const validState = state === "malformed" ? "known" : state;
      const production = productionIdentityFixture(validState);
      const native = nativeJobIdentityFixtures(validState);
      const routeRequests: string[] = [];
      await page.route(
        (url) => url.pathname === "/api/v1/production",
        (route) =>
          route.fulfill({
            status: 200,
            json: malformed ? malformedProductionIdentityFixture() : production,
            headers: { "Cache-Control": "private, no-store" },
          }),
      );
      await page.route(
        (url) =>
          decodeURIComponent(url.pathname) === `/api/v1/jobs/${syntheticNativeJobId}` ||
          decodeURIComponent(url.pathname) === `/api/v1/jobs/${syntheticNativeJobId}/history`,
        async (route) => {
          const path = decodeURIComponent(new URL(route.request().url()).pathname);
          routeRequests.push(path);
          await route.fulfill({
            status: 200,
            json: path.endsWith("/history") ? native.history : native.plan,
            headers: { "Cache-Control": "private, no-store" },
          });
        },
      );
      await page.goto("/production");
      if (malformed) {
        await expect(page.getByRole("heading", { name: "Job plan could not load" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Find a job" })).toHaveCount(0);
        malformed = false;
        await page.getByRole("button", { name: "Load again" }).click();
      }
      const frontDoor = page.getByRole("button", { name: "Find a job" });
      await expect(frontDoor).toBeInViewport({ ratio: 1 });
      await frontDoor.click();
      const chooser = page.getByRole("dialog", { name: "Choose a job" });
      await expect.poll(() => chooser.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
      await expect(chooser.getByRole("button", { name: "Close" })).toBeFocused();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(
        true,
      );
      await page.keyboard.press("Shift+Tab");
      await expect(chooser.getByRole("button", { name: "Close" })).toBeFocused();
      await chooser.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(frontDoor).toBeFocused();
      await frontDoor.click();
      await expect.poll(() => chooser.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(frontDoor).toBeFocused();

      const choose = async () => {
        await page.getByRole("button", { name: "Find a job" }).click();
        const picker = page.getByRole("dialog", { name: "Choose a job" });
        await picker.getByRole("button", { name: /IW-SYNTH|Job number not recorded/ }).click();
        return page.getByRole("dialog", { name: "Job information" });
      };
      const dialog = await choose();
      await expect(dialog.getByRole("heading", { name: /^Job number/ })).toBeFocused();
      await expect(
        dialog.getByText(
          state === "legacy" || state === "unknown"
            ? "Customer name not available"
            : production.jobs[0]!.customer_display_name!,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        dialog.getByText(
          state === "legacy" || state === "unknown"
            ? "Site address not available"
            : production.jobs[0]!.address!,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(dialog.getByText(syntheticNativeJobId, { exact: true })).toBeHidden();
      await dialog.locator("summary").click();
      await expect(dialog.getByText(syntheticNativeJobId, { exact: true })).toBeVisible();
      await expect(dialog.getByRole("link", { name: /^Open / })).toHaveAttribute(
        "href",
        "/jobs/native-job%3Asynthetic-d5",
      );
      await expect(dialog.getByRole("link", { name: /^History of / })).toHaveAttribute(
        "href",
        "/jobs/native-job%3Asynthetic-d5/history",
      );
      await dialog.getByRole("link", { name: /^Open / }).click();
      await expect(page.getByRole("heading", { name: "Job details", exact: true })).toBeVisible();
      await expect(page.locator("main h1")).toContainText(native.plan.job.address ?? "Job plan");
      await page.goBack();
      const restored = await choose();
      await restored.getByRole("link", { name: /^History of / }).click();
      await expect(page.locator("main h1")).toHaveText(
        native.history.job.job_number ?? syntheticNativeJobId,
      );
      expect(routeRequests).toEqual([
        `/api/v1/jobs/${syntheticNativeJobId}`,
        `/api/v1/jobs/${syntheticNativeJobId}/history`,
      ]);
    });
  }
});
