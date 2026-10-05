import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { assertNoFrappeDesk } from "./frappe-desk-guard";
import { expectTouchTarget } from "./touch-target";

const estimatorMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

test.describe("Facet design acceptance", () => {
  test.skip(!estimatorMode, "requires ACCEPTANCE_MODE=estimator");

  test.beforeAll(async () => {
    await mkdir(shotDir, { recursive: true });
  });

  test("shows the customer choice first and keeps system data closed", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/v1/facet-design-evidence", async (route) => {
      await route.fulfill({
        json: {
          version: 2,
          read_model_generated_at: "2026-08-21T12:00:00.000Z",
          permissions: ["facet:read"],
          allowed_actions: ["facet_design.read"],
          evidence: [
            {
              event_id: "facet-event-acceptance",
              tenant_id: "ironwrap",
              brand_id: "ironwrap-exteriors",
              facet_project_id: "facet-project-acceptance",
              design_revision_id: `facet-json-v1:${"a".repeat(64)}`,
              design_revision_sha256: "a".repeat(64),
              frozen_evidence_sha256: "b".repeat(64),
              occurred_at: "2026-08-21T10:00:00.000Z",
              received_at: "2026-08-21T10:01:00.000Z",
              provenance: "customer_approved_v2",
              identity_assurance: "oidc",
              decision_kind: "approved",
              previous_event_id: null,
              roof_job_id: "IW-1042",
              customer_quote_id: "QUOTE-1042",
              external_project_link_id: `ironwrap-project-v1:${"c".repeat(64)}`,
              association_sha256: "d".repeat(64),
              projection_state: "projected",
              status_code: "blank_draft_projected",
              projection: {
                outcome: "projected_native_design",
                projection_id: "facet-native-design-v2:projection-acceptance",
                projection_sha256: "e".repeat(64),
                source_quote_revision_id: "quote-revision:accepted-1042",
                source_quote_version: 3,
                source_proposal_revision_id: "proposal-revision:accepted-1042",
                source_publication_event_id: "publication-event:accepted-1042",
                source_acceptance_binding_id: "acceptance-binding:accepted-1042",
                launch_intent_sha256: "f".repeat(64),
                design_sequence: 1,
                design_state: "active",
                error_code: null,
                attempted_at: "2026-08-21T10:02:00.000Z",
              },
            },
          ],
          intake_exceptions: [
            {
              event_id: "facet-unlinked-acceptance",
              received_at: "2026-08-21T10:04:00.000Z",
              state: "awaiting_association",
              status_code: "awaiting_exact_project_identity_association",
              recovery: "automatic_reconciliation",
            },
          ],
        },
      });
    });

    await page.goto("/facet-designs");
    await expect(page.getByRole("heading", { name: "Customer design evidence" })).toBeVisible();
    await expect(page.getByText("Native design ready")).toBeVisible();
    await expect(page.getByText("Google OIDC · exact project link")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recover without a manual association" }),
    ).toBeVisible();
    await expect(page.getByText("facet-project-acceptance")).toBeHidden();

    const width = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(width.page).toBeLessThanOrEqual(width.view + 1);

    const controls = page.locator("main button:visible, main a:visible");
    for (let index = 0; index < (await controls.count()); index += 1) {
      await expectTouchTarget(controls.nth(index), {
        name: `control ${index}`,
        axis: "height",
      });
    }

    await assertNoFrappeDesk(page);
    await page.screenshot({
      path: `${shotDir}/facet-designs-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByText("System details").click();
    await expect(page.getByText("facet-project-acceptance")).toBeVisible();
    await expect(page.getByRole("button", { name: /connect|prepare/i })).toHaveCount(0);
  });
});
