import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";

test.describe("Operator command palette acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test("opens from the authenticated office shell, searches the server, jumps, and shows no results", async ({
    page,
  }) => {
    const searchRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/search") searchRequests.push(url.search);
    });

    await page.goto("/estimator/jobs/JOB-ESTIMATOR-ACCEPTANCE");
    const trigger = page.getByRole("button", { name: /Open search/i });
    await expect(trigger).toBeVisible();
    expect((await trigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await trigger.click();

    const input = page.getByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await expect(input).toBeFocused();
    await input.fill("no");
    await expect(page.getByRole("option", { name: /Now/ })).toBeVisible();
    expect(searchRequests).toContain("?q=no");

    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/now$/);
    await trigger.click();
    await input.fill("zz");
    await expect(page.getByRole("status")).toHaveText(/No results for/);
    expect(searchRequests).toContain("?q=zz");
  });
});
