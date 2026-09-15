import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { settleAnimations } from "./settle";

/**
 * Making a document from the job shelf, seen by the owner.
 *
 * The estimator fixture serves an owner session and the committed capability state, in which
 * document generation is switched off. So the honest state on this surface is the off panel and
 * no live control; a direct command is refused as unavailable, never half-made. The success path
 * is the Worker's own (`document-generation-r2-api.test.ts`).
 */
test.describe("Making a document from the job", () => {
  test.skip(process.env.ACCEPTANCE_MODE !== "estimator", "office acceptance session only");

  test("shows the owner the off state instead of a live control, and refuses the command", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(page.getByTestId("document-generation-off")).toBeVisible();
    await expect(page.getByText("Document generation is turned off")).toBeVisible();
    await expect(page.getByRole("button", { name: "Make this document" })).toHaveCount(0);

    const refused = await page.request.post("/api/v1/document-generations", {
      headers: { "Idempotency-Key": "docgen:e2e-refused-0001" },
      data: {
        entity_type: "job",
        entity_id: "roof-job-acceptance",
        template_id: "tpl_materials_list",
        template_revision_id: "rev_tpl_materials_1",
      },
    });
    expect(refused.status()).toBe(503);
    expect(await refused.json()).toEqual({ error: "document_generation_unavailable" });

    await settleAnimations(page);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
