import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const noticeText =
  "Do not start, resume, release a hold point, or change scope. Go online for the latest issued plan, or call production.";
const baselineDir = process.env.O2_BASELINE_DIR;
const resultsDir = process.env.O2_RESULTS_DIR;

async function jobFixture(page: Page, state: "known" | "long" | "unknown", issued: boolean) {
  const headers = { "X-IronWrap-Device-Proof": "a".repeat(43) };
  const session = await (await page.request.get("/api/v1/session", { headers })).json();
  session.user = {
    ...session.user,
    id: "appu_synthetic_production",
    email: "production@example.invalid",
    display_name: "Synthetic production",
    role: "production",
    frappe_user_id: null,
  };
  session.permissions = ["jobs:read:any", "today:read"];
  session.allowed_actions = [];
  const model = await (await page.request.get("/api/v1/jobs/JOB-ACCEPTANCE", { headers })).json();
  model.allowed_actions = [];
  if (!issued) model.packet.work_package = null;
  if (state === "known") {
    model.job.job_number = "IW-SYNTHETIC";
    model.job.address = "Synthetic training site";
  } else if (state === "long") {
    model.job.job_number = "SYNTHETIC LONG JOB REFERENCE ".repeat(12).trim();
    model.job.address = "Synthetic long site description and access reference. ".repeat(24).trim();
  } else {
    model.job.job_number = null;
    model.job.address = null;
  }
  await page.route("**/api/v1/session", (route) => route.fulfill({ json: session }));
  await page.route("**/api/v1/jobs/JOB-ACCEPTANCE", (route) => route.fulfill({ json: model }));
  await page.goto("/jobs/JOB-ACCEPTANCE");
  await expect(page.getByRole("heading", { name: "Ready offline", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function visibility(page: Page, bottom: boolean) {
  return page.evaluate(
    async ({ bottom, expected }) => {
      window.scrollTo(0, bottom ? document.documentElement.scrollHeight : 0);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const heading = document.getElementById("work-package-heading")!;
      const section = heading.closest("section")!;
      const paragraph = section.querySelector("p:last-child")!;
      const fixedNavigation = [...document.querySelectorAll("nav")]
        .map((node) => ({ rect: node.getBoundingClientRect(), style: getComputedStyle(node) }))
        .filter(
          ({ rect, style }) =>
            style.position === "fixed" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.right > 0 &&
            rect.left < innerWidth &&
            rect.height > 0 &&
            rect.height < innerHeight / 2 &&
            rect.top >= innerHeight / 2 &&
            rect.bottom >= innerHeight - 1,
        );
      const lower = Math.min(innerHeight, ...fixedNavigation.map(({ rect }) => rect.top));
      const textRects = [heading, paragraph].flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map(({ top, bottom, left, right }) => ({ top, bottom, left, right }));
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        scrollY,
        lower,
        notice: paragraph.textContent!.replace(/\s+/g, " ").trim(),
        exactText: paragraph.textContent!.replace(/\s+/g, " ").trim() === expected,
        complete:
          textRects.length > 0 &&
          textRects.every(
            (rect) =>
              rect.top >= 0 && rect.bottom <= lower && rect.left >= 0 && rect.right <= innerWidth,
          ),
        textRects,
      };
    },
    { bottom, expected: noticeText },
  );
}

test.describe("O2 ordinary null-plan visibility source check", () => {
  for (const state of ["known", "long", "unknown"] as const) {
    test(`${state} null plan keeps the complete prohibition and recovery readable at an ordinary rest`, async ({
      page,
    }, testInfo) => {
      await jobFixture(page, state, false);
      await expect(
        page.getByRole("heading", { name: "No work plan is ready", exact: true }),
      ).toHaveCount(1);
      await expect(page.getByText(noticeText, { exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /Start work|Finish work/i })).toHaveCount(0);
      await expect(
        page.getByText(
          "This job plan is saved on this phone. Work and safety checks still apply.",
          { exact: true },
        ),
      ).toBeVisible();
      const top = await visibility(page, false);
      const bottom = await visibility(page, true);
      if (resultsDir)
        writeFileSync(
          join(resultsDir, `${testInfo.project.name}-${state}.json`),
          JSON.stringify({ top, bottom }, null, 2) + "\n",
        );
      await testInfo.attach(`ordinary-${state}-visibility`, {
        contentType: "application/json",
        body: JSON.stringify({ top, bottom, screenshots: false, inputAdmission: false }),
      });
      expect(top.exactText && bottom.exactText).toBe(true);
      expect(top.complete || bottom.complete, JSON.stringify({ top, bottom })).toBe(true);
    });
  }

  test("an issued plan keeps its existing structural layout and has no null-plan notice", async ({
    page,
  }, testInfo) => {
    await jobFixture(page, "known", true);
    await expect(
      page.getByRole("heading", { name: "No work plan is ready", exact: true }),
    ).toHaveCount(0);
    const signature = await page.locator("main").evaluate((main) => ({
      headings: [...main.querySelectorAll("h1,h2,h3")].map((node) => ({
        tag: node.tagName,
        id: node.id,
        class: node.className,
        text: node.textContent!.replace(/\s+/g, " ").trim(),
      })),
      package: (() => {
        const node = document.getElementById("work-package-heading")!;
        const rect = node.getBoundingClientRect();
        return {
          class: node.className,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      })(),
    }));
    const name = `issued-${testInfo.project.name}.json`;
    if (baselineDir) {
      const path = join(baselineDir, name);
      if (process.env.O2_RECORD_BASELINE === "1")
        writeFileSync(path, JSON.stringify(signature, null, 2) + "\n");
      else expect(signature).toEqual(JSON.parse(readFileSync(path, "utf8")));
    }
    await testInfo.attach("issued-structural-layout", {
      contentType: "application/json",
      body: JSON.stringify(signature),
    });
  });
});
