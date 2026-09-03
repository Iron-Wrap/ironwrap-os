import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectTouchTarget } from "./touch-target";
import { settleAnimations } from "./settle";

const ownerMode = process.env.ACCEPTANCE_MODE === "estimator";
const shotDir = ".playwright-mobile";

const pipeline = {
  pipeline_id: "pipeline_sales",
  key: "sales",
  name: "Sales board",
  entity_type: "lead",
  owning_role: "owner",
  is_active: true,
  is_template: false,
  template_source_id: null,
  position: 0,
  version: 2,
  card_count: 3,
  card_template: { version: 1, slots: [] },
  stages: [
    {
      stage_id: "stage_new",
      key: "new",
      name: "New",
      color: "slate",
      position: 0,
      is_won: false,
      is_lost: false,
      min_role_to_enter: null,
      is_active: true,
      card_count: 3,
      updated_at: "2026-08-27T10:00:00.000Z",
    },
  ],
  role_grants: [{ role: "ops", can_write: true }],
  updated_at: "2026-08-27T10:00:00.000Z",
};

const pipelineResponse = {
  version: 1,
  entity_types: [{ entity_type: "lead", label: "Lead" }],
  roles: ["owner", "ops", "sales"],
  stage_limit: 200,
  pipelines: [pipeline],
};

const fieldCatalog = {
  roles: ["owner", "ops", "sales"],
  field_types: ["text", "integer"],
  validators: ["none", "options", "range"],
  visibility_rules: ["always", "when_field_present"],
  evidence_classes: ["none", "source"],
  retention_policies: ["standard", "extended"],
  offline_modes: ["online_only", "offline_read"],
  scopes: ["all", "assigned"],
};

function schemaField(key: string, label: string, position: number) {
  return {
    field_id: `field_${key}`,
    entity_type: "lead",
    field_key: key,
    revision_id: `fieldrev_${key}_1`,
    version: 1,
    prior_revision_id: null,
    action: "create",
    label,
    position,
    field_type: "text",
    validator_key: "none",
    validator_config: {},
    visibility_key: "always",
    visibility_config: {},
    evidence_class: "none",
    retention_policy: "standard",
    offline_mode: "online_only",
    read_scope: "all",
    write_scope: "all",
    read_roles: ["owner"],
    write_roles: ["owner"],
    active: true,
    actor: {
      type: "owner",
      role: "owner",
      id: "appu_acceptance_owner",
      authority_ref: "app:appu_acceptance_owner",
    },
    command_fingerprint: "a".repeat(64),
    effective_at: "2026-08-27T10:00:00.000Z",
    created_at: "2026-08-27T10:00:00.000Z",
  };
}

// Served in creation order rather than position order, which is exactly the shape that hid a
// reorder from the admin who made it: Colour was created first and rendered first even though
// its position puts it last.
const seedFields = [
  schemaField("colour", "Colour", 2),
  schemaField("material", "Material", 0),
  schemaField("quantity", "Quantity", 1),
];

const documentTemplate = {
  template_id: "template:00000000000000000000000000000000materials",
  revision_id: "docrev:materials-list:1",
  version: 1,
  prior_revision_id: null,
  action: "create",
  entity_type: "lead",
  template_key: "materials-list",
  label: "Materials list",
  blocks: [
    { kind: "heading", level: 2, text: "Materials" },
    { kind: "field", field_id: "field_material" },
  ],
  retention_policy: "standard",
  active: true,
  actor: {
    type: "owner",
    role: "owner",
    id: "appu_acceptance_owner",
    authority_ref: "app:appu_acceptance_owner",
  },
  command_fingerprint: "c".repeat(64),
  effective_at: "2026-08-27T10:00:00.000Z",
  created_at: "2026-08-27T10:00:00.000Z",
};

const documentCatalog = {
  actions: ["create", "revise", "retire"],
  block_kinds: ["text", "heading", "field"],
  retention_policies: ["standard", "extended"],
};

const automationResponse = {
  version: 1,
  pipeline_id: pipeline.pipeline_id,
  rules: [],
  catalog: {
    actions: [{ action: "operations.email.send", label: "Stage-change email" }],
    templates: [
      {
        template_key: "pipeline.stage-change-summary",
        version: 1,
        label: "Stage-change summary",
      },
    ],
    recipient_refs: ["owner"],
    recipient_labels: [{ recipient_ref: "owner", label: "Owner" }],
    recipient_source: "tenant",
    recipient_configured: true,
  },
};

/** The tenant-administered recipient catalog (ELEC-204) this screen writes to. */
function recipientRecord(ref: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    recipient_id: `recipient_${ref}`,
    recipient_ref: ref,
    revision_id: `recipientrev_${ref}_1`,
    version: 1,
    prior_revision_id: null,
    action: "create",
    label,
    channel: "email",
    destination_masked: `o***@ironwrap.example.invalid`,
    destination_digest: "d".repeat(64),
    active: true,
    actor: { role: "owner", id: "appu_acceptance_owner" },
    command_fingerprint: "c".repeat(64),
    created_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * A deployment that publishes what a rule DID, not only how it is configured. Three outcomes
 * travel: a confirmed delivery, a failure, and one the effect ledger declined to call either.
 */
const automationOutcomeRule = {
  rule_id: "rule_new",
  tenant_id: "acceptance",
  pipeline_id: pipeline.pipeline_id,
  to_stage_id: pipeline.stages[0]!.stage_id,
  revision_id: "automationrev_new_1",
  version: 1,
  prior_revision_id: null,
  action: "operations.email.send",
  recipient_ref: "owner",
  template_key: "pipeline.stage-change-summary",
  template_version: 1,
  active: 1,
  actor_role: "owner",
  actor_id: "appu_acceptance_owner",
  created_at: "2026-08-27T10:00:00.000Z",
};

const automationWithOutcomesResponse = {
  ...automationResponse,
  rules: [automationOutcomeRule],
  catalog: { ...automationResponse.catalog, activity_available: true },
};

function firing(
  invocationId: string,
  status: string,
  resultCode: string | null,
  createdAt: string,
) {
  return {
    invocation_id: invocationId,
    outbox_id: `outbox_${invocationId}`,
    transition_id: `transition_${invocationId}`,
    card_id: "card_one",
    to_stage_id: pipeline.stages[0]!.stage_id,
    rule_version: 1,
    action: "operations.email.send",
    status,
    attempt_count: 1,
    result_code: resultCode,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: status === "succeeded" ? createdAt : null,
  };
}

const automationActivityResponse = {
  version: 1,
  pipeline_id: pipeline.pipeline_id,
  rule_id: "rule_new",
  // The window the route publishes (PR #212): the cap it applied and whether it clipped anything,
  // so a client can say "the 20 most recent" instead of implying it is showing everything.
  limit: 20,
  truncated: false,
  activity: [
    firing("inv_1", "succeeded", "delivered", "2026-08-28T08:00:00.000Z"),
    firing("inv_2", "unknown", "gmail_readback_id_missing", "2026-08-28T09:00:00.000Z"),
    firing("inv_3", "failed", "automation_recipient_ref_unknown", "2026-08-28T10:00:00.000Z"),
  ],
};

test.describe("Owner configuration mobile acceptance", () => {
  test.skip(!ownerMode, "requires ACCEPTANCE_MODE=estimator");

  test("keeps pipeline, field, and automation routes accessible and read-only offline", async ({
    context,
    page,
  }) => {
    await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const cases = [
      {
        path: "/settings/configuration/pipelines",
        heading: "Pipelines",
        action: "Rename",
        cachedText: "Sales board",
      },
      {
        path: "/settings/configuration/fields",
        heading: "Fields",
        action: "New field",
        cachedText: "Colour",
      },
      {
        path: "/settings/configuration/documents",
        heading: "Documents",
        action: "New document",
        cachedText: "Materials list",
      },
      {
        path: "/settings/configuration/automations",
        heading: "Automations",
        action: "New rule",
        cachedText: "Sales board · lead",
      },
      {
        path: "/settings/configuration/automations/recipients",
        heading: "Recipients",
        action: "New recipient",
        cachedText: "Owner",
      },
    ] as const;

    for (const routeCase of cases) {
      await context.setOffline(false);
      await page.goto(routeCase.path);
      await expect(
        page.getByRole("heading", { name: routeCase.heading, exact: true }),
      ).toBeVisible();
      await expectCachedContent(page, routeCase);

      const action = page.getByRole("button", { name: routeCase.action, exact: true });
      await expectTouchTarget(action, { name: routeCase.action });

      await focusFromKeyboard(page, action);
      const focus = await action.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          focusVisible: element.matches(":focus-visible"),
          outlineVisible: style.outlineStyle !== "none" && style.outlineWidth !== "0px",
        };
      });
      expect(focus.focusVisible || focus.outlineVisible).toBe(true);

      const geometry = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        ),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

      await settleAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(results.violations).toEqual([]);

      const mutationRequests: string[] = [];
      const onRequest = (request: import("@playwright/test").Request) => {
        if (
          request.method() !== "GET" &&
          new URL(request.url()).pathname.startsWith("/api/v1/admin/")
        ) {
          mutationRequests.push(new URL(request.url()).pathname);
        }
      };
      page.on("request", onRequest);
      await context.setOffline(true);
      await expect(page.getByText("Offline: configuration is read-only")).toBeVisible();
      // The app-wide banner is what an admin sees once they scroll past the page notice,
      // so it has to describe this surface: configuration queues nothing.
      await expect(
        page.getByText("Offline. This screen is read-only until you reconnect;", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("New work stays on this device", { exact: false })).toHaveCount(
        0,
      );
      await expectCachedContent(page, routeCase);
      await expect(action).toBeDisabled();
      await expect
        .poll(() => mutationRequests.length, {
          message: "offline configuration must not queue a mutation",
        })
        .toBe(0);
      page.off("request", onRequest);
    }
    await context.setOffline(false);
  });

  test("orders field definitions by position and moves one with the visible controls", async ({
    page,
  }) => {
    const server = await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/configuration/fields");
    await expect(page.getByRole("heading", { name: "Fields", exact: true })).toBeVisible();

    // Served Colour, Material, Quantity; read in position order.
    const fieldList = page.getByRole("list", { name: "Field definitions" });
    expect(await renderedFieldOrder(page)).toEqual(["Material", "Quantity", "Colour"]);
    await mkdir(shotDir, { recursive: true });
    await screenshotFieldList(page, `${shotDir}/owner-configuration-fields-before.png`);

    // No move may fall off either end of the list.
    await expect(page.getByRole("button", { name: "Move Material up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move Colour down" })).toBeDisabled();

    const moveColourUp = page.getByRole("button", { name: "Move Colour up" });
    await expectTouchTarget(moveColourUp, { name: "Move Colour up" });
    await moveColourUp.scrollIntoViewIfNeeded();
    await moveColourUp.focus();
    await expect(moveColourUp).toBeFocused();
    await expectKeyboardFocusVisible(moveColourUp);
    await page.keyboard.press("Enter");

    await expect(page.getByText("Field order saved")).toBeVisible();
    expect(await renderedFieldOrder(page)).toEqual(["Material", "Colour", "Quantity"]);
    // Only the two definitions that really moved are revised, each against its own version.
    expect(server.revisions).toEqual([
      { field_id: "field_colour", action: "reorder", position: 1, expected_version: 1 },
      { field_id: "field_quantity", action: "reorder", position: 2, expected_version: 1 },
    ]);
    await screenshotFieldList(page, `${shotDir}/owner-configuration-fields-after.png`);

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("refuses direct configuration navigation for an authenticated ops session", async ({
    page,
  }) => {
    const sessionProbe = await routeSessionAsRole(page, "ops");
    const adminRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/v1/admin/")) {
        adminRequests.push(`${request.method()} ${pathname}`);
      }
    });

    for (const path of [
      "/settings/configuration",
      "/settings/configuration/pipelines",
      "/settings/configuration/fields",
      "/settings/configuration/documents",
      "/settings/configuration/automations",
      "/settings/configuration/automations/recipients",
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: "This work belongs to another role", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => adminRequests.length, {
          message: `ops navigation must not request admin APIs at ${path}`,
        })
        .toBe(0);
    }

    expect(sessionProbe).toEqual({
      sourceAuthenticated: true,
      sourceRole: "owner",
      servedRole: "ops",
    });
    expect(adminRequests).toEqual([]);
  });

  test("does not submit stale open forms after going offline", async ({ context, page }) => {
    await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const cases = [
      {
        path: "/settings/configuration/pipelines",
        heading: "Pipelines",
        cachedText: "Sales board",
        kind: "pipeline",
      },
      {
        path: "/settings/configuration/fields",
        heading: "Fields",
        cachedText: "Colour",
        kind: "field",
      },
      {
        path: "/settings/configuration/documents",
        heading: "Documents",
        cachedText: "Materials list",
        kind: "document",
      },
      {
        path: "/settings/configuration/automations",
        heading: "Automations",
        cachedText: "Sales board · lead",
        kind: "automation",
      },
      {
        path: "/settings/configuration/automations/recipients",
        heading: "Recipients",
        cachedText: "Owner",
        kind: "recipient",
      },
    ] as const;

    for (const routeCase of cases) {
      await context.setOffline(false);
      await page.goto(routeCase.path);
      await expect(
        page.getByRole("heading", { name: routeCase.heading, exact: true }),
      ).toBeVisible();
      await expectCachedContent(page, routeCase);

      const mutationRequests: string[] = [];
      const onRequest = (request: import("@playwright/test").Request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() !== "GET" && pathname.startsWith("/api/v1/admin/")) {
          mutationRequests.push(`${request.method()} ${pathname}`);
        }
      };
      page.on("request", onRequest);

      let input: import("@playwright/test").Locator;
      let submit: import("@playwright/test").Locator;
      if (routeCase.kind === "pipeline") {
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        input = page.getByLabel("New name");
        await input.fill("Offline rename draft");
        submit = page.getByRole("button", { name: "Save name", exact: true });
      } else if (routeCase.kind === "field") {
        await page.getByRole("button", { name: "New field", exact: true }).click();
        input = page.getByLabel("Field key");
        await input.fill("offline_field");
        await page.getByLabel("Label", { exact: true }).fill("Offline field");
        submit = page.getByRole("button", { name: "Save field definition", exact: true });
      } else if (routeCase.kind === "document") {
        await page.getByRole("button", { name: "New document", exact: true }).click();
        input = page.getByLabel("Name", { exact: true });
        await input.fill("Offline document draft");
        await page.getByLabel("Key", { exact: true }).fill("offline-draft");
        submit = page.getByRole("button", { name: "Save document", exact: true });
      } else if (routeCase.kind === "recipient") {
        await page.getByRole("button", { name: "New recipient", exact: true }).click();
        input = page.getByLabel("Name", { exact: true });
        await input.fill("Offline recipient draft");
        await page.getByLabel("Email address", { exact: true }).fill("draft@example.invalid");
        submit = page.getByRole("button", { name: "Save recipient", exact: true });
      } else {
        await page.getByRole("button", { name: "New rule", exact: true }).click();
        input = page.getByLabel("When a card enters", { exact: true });
        await input.selectOption(pipeline.stages[0]!.stage_id);
        await page.getByLabel("Action", { exact: true }).selectOption("operations.email.send");
        await page
          .getByLabel("Template", { exact: true })
          .selectOption("pipeline.stage-change-summary");
        await page.getByLabel("Recipient", { exact: true }).selectOption("owner");
        submit = page.getByRole("button", { name: "Save automation", exact: true });
      }

      await expect(input).toBeVisible();
      await expect(submit).toBeEnabled();
      await focusFromKeyboard(page, input);
      await expect(input).toBeFocused();
      await expectKeyboardFocusVisible(input);

      await context.setOffline(true);
      await expect(page.getByText("Offline: configuration is read-only")).toBeVisible();
      await expectCachedContent(page, routeCase);
      await expect(submit).toBeDisabled();
      await focusFromKeyboard(page, input);
      await expect(input).toBeFocused();
      await expectKeyboardFocusVisible(input);
      await page.keyboard.press("Enter");
      await submit.evaluate((button) => (button as HTMLButtonElement).form?.requestSubmit());
      await expect
        .poll(() => mutationRequests.length, {
          message: `offline ${routeCase.kind} form must not queue a mutation`,
        })
        .toBe(0);
      page.off("request", onRequest);

      const geometry = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        ),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      await settleAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(results.violations).toEqual([]);
    }
    await context.setOffline(false);
  });

  test("authors a document out of fields, from a phone, without leaving the product", async ({
    page,
  }) => {
    const server = await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/configuration/documents");
    await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New document", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Estimate");
    await page.getByLabel("Key", { exact: true }).fill("estimate");
    await page.getByRole("button", { name: "Add heading", exact: true }).click();
    await page.getByLabel("Heading text", { exact: true }).fill("Scope of work");
    await page.getByRole("button", { name: "Add field", exact: true }).click();

    // Only this record type's active fields are offered, because that is all the server accepts.
    const fieldPicker = page.getByLabel("Field", { exact: true });
    await expect(fieldPicker.locator("option")).toHaveText([
      "Choose a field",
      "Material",
      "Quantity",
      "Colour",
    ]);
    await fieldPicker.selectOption("field_material");

    // Every block control is a real touch target on a 390px screen.
    for (const name of ["Add field", "Move Field 2 up", "Remove Field 2"]) {
      await expectTouchTarget(page.getByRole("button", { name, exact: true }), { name });
    }

    await mkdir(shotDir, { recursive: true });
    await withoutShellChrome(page, () =>
      page.screenshot({
        path: `${shotDir}/owner-configuration-document-editor.png`,
        fullPage: true,
      }),
    );

    const save = page.getByRole("button", { name: "Save document", exact: true });
    await focusFromKeyboard(page, save);
    await expectKeyboardFocusVisible(save);
    await page.keyboard.press("Enter");

    await expect(page.getByText("Document created.")).toBeVisible();
    expect(server.documentWrites).toEqual([
      {
        action: "create",
        active: true,
        entity_type: "lead",
        template_key: "estimate",
        label: "Estimate",
        retention_policy: "standard",
        blocks: [
          { kind: "heading", level: 2, text: "Scope of work" },
          { kind: "field", field_id: "field_material" },
        ],
      },
    ]);
    // The document an administrator just authored is on the list, with no developer involved.
    await expect(page.getByText("Estimate", { exact: true })).toBeVisible();

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("shows what an automation did, keeping a failure and an unconfirmed firing apart", async ({
    page,
  }) => {
    await routeConfigurationApis(page);
    await page.route(
      `**/api/v1/admin/pipelines/${pipeline.pipeline_id}/automation-rules`,
      (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(automationWithOutcomesResponse),
        });
      },
    );
    await page.route(
      `**/api/v1/admin/pipelines/${pipeline.pipeline_id}/automation-rules/rule_new/activity`,
      (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(automationActivityResponse),
        });
      },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/configuration/automations");
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

    // Discovery without opening anything: the rule itself says a firing failed.
    await expect(page.getByText("1 failed", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const firings = page.getByRole("list", { name: "Recent firings" });
    await expect(firings.getByText("Failed", { exact: true })).toBeVisible();
    await expect(firings.getByText("Not confirmed", { exact: true })).toBeVisible();
    await expect(firings.getByText("Sent", { exact: true })).toBeVisible();
    await expect(
      firings.getByText("This rule points at a recipient that is no longer configured."),
    ).toBeVisible();
    await expect(
      firings.getByText(
        "The email service accepted the message but returned nothing to check it against, so delivery could not be confirmed.",
      ),
    ).toBeVisible();

    await mkdir(shotDir, { recursive: true });
    await withoutShellChrome(page, () =>
      firings.screenshot({ path: `${shotDir}/owner-configuration-automation-activity.png` }),
    );

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * The defect ELEC-218 recorded, end to end on a phone: an owner adds "the shop" as an automation
   * recipient with no developer, no deploy secret, and no Frappe desk.
   */
  test("adds an automation recipient from the phone, with no developer and no deploy secret", async ({
    page,
  }) => {
    const server = await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });

    // Found from the screen that needs it, not from a URL someone had to be told.
    await page.goto("/settings/configuration/automations");
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    const gateway = page.getByRole("link", { name: /Manage recipients/ });
    await expectTouchTarget(gateway, { name: "Manage recipients", axis: "height" });
    await gateway.click();

    await expect(page.getByRole("heading", { name: "Recipients", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New recipient", exact: true }).click();

    await page.getByLabel("Name", { exact: true }).fill("The shop");
    // The permanent reference an owner never has to invent.
    await expect(page.getByLabel("Reference", { exact: true })).toHaveValue("the-shop");
    await page.getByLabel("Email address", { exact: true }).fill("shop@example.invalid");

    await mkdir(shotDir, { recursive: true });
    await withoutShellChrome(page, () =>
      page.screenshot({ path: `${shotDir}/owner-configuration-recipient-form.png` }),
    );

    const save = page.getByRole("button", { name: "Save recipient", exact: true });
    await expectTouchTarget(save, { name: "Save recipient", axis: "height" });
    await save.click();

    await expect(page.getByText("The shop", { exact: true })).toBeVisible();
    expect(server.recipientWrites).toEqual([
      {
        recipient_ref: "the-shop",
        label: "The shop",
        channel: "email",
        destination: "shop@example.invalid",
      },
    ]);
    // The address goes in and does not come back out: the list shows the mask the server publishes.
    await expect(page.getByText("s***@example.invalid", { exact: false })).toBeVisible();
    await expect(page.getByText("shop@example.invalid", { exact: true })).toHaveCount(0);

    await withoutShellChrome(page, () =>
      page.screenshot({ path: `${shotDir}/owner-configuration-recipients-list.png` }),
    );

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * The other half of the same gap: an owner who discovers mid-rule that "the shop" does not exist
   * must not have to abandon the rule to create it.
   */
  test("adds a recipient from inside the rule builder without losing the rule being composed", async ({
    page,
  }) => {
    const server = await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/configuration/automations");

    await page.getByRole("button", { name: "New rule", exact: true }).click();
    await page.getByLabel("When a card enters", { exact: true }).selectOption("stage_new");
    await page
      .getByLabel("Template", { exact: true })
      .selectOption("pipeline.stage-change-summary");

    await page.getByRole("button", { name: "Add a recipient", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("The shop");
    await page.getByLabel("Email address", { exact: true }).fill("shop@example.invalid");

    await mkdir(shotDir, { recursive: true });
    await withoutShellChrome(page, () =>
      page.screenshot({ path: `${shotDir}/owner-configuration-recipient-inline-create.png` }),
    );

    await page.getByRole("button", { name: "Save recipient", exact: true }).click();

    // The rule survived the detour and now names the recipient that was missing.
    const picker = page.getByLabel("Recipient", { exact: true });
    await expect(picker).toHaveValue("the-shop");
    await expect(page.getByLabel("When a card enters", { exact: true })).toHaveValue("stage_new");
    await expect(page.getByRole("button", { name: "Save automation", exact: true })).toBeEnabled();
    expect(server.recipientWrites).toEqual([
      {
        recipient_ref: "the-shop",
        label: "The shop",
        channel: "email",
        destination: "shop@example.invalid",
      },
    ]);

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * Retiring a recipient a live rule still names would turn a configuration change into a delivery
   * failure discovered by whoever did not get the email. The screen asks first and says who.
   */
  test("refuses to retire a recipient a live rule still sends to, and names the rule", async ({
    page,
  }) => {
    await routeConfigurationApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/configuration/automations/recipients");

    await page.getByRole("button", { name: "Retire", exact: true }).click();
    await expect(page.getByText("One live rule still sends here")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retire recipient", exact: true }),
    ).toBeDisabled();

    await mkdir(shotDir, { recursive: true });
    await withoutShellChrome(page, () =>
      page.screenshot({ path: `${shotDir}/owner-configuration-recipient-retire-blocked.png` }),
    );

    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});

interface FieldServer {
  fields: ReturnType<typeof schemaField>[];
  revisions: { field_id: string; action: unknown; position: unknown; expected_version: unknown }[];
  documents: (typeof documentTemplate)[];
  documentWrites: Record<string, unknown>[];
  recipients: ReturnType<typeof recipientRecord>[];
  recipientWrites: Record<string, unknown>[];
}

async function routeConfigurationApis(page: Page): Promise<FieldServer> {
  const server: FieldServer = {
    fields: seedFields.map((field) => ({ ...field })),
    revisions: [],
    documents: [{ ...documentTemplate }],
    documentWrites: [],
    recipients: [recipientRecord("owner", "Owner")],
    recipientWrites: [],
  };
  // The recipient catalog the automations screen reads and this screen writes. The fixture
  // accepts a create the way the Worker does - and answers the read the way it does too: a mask
  // and a digest, never the address that went in.
  await page.route("**/api/v1/admin/automation-recipients", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          catalog: { channels: ["email"] },
          recipients: server.recipients,
        }),
      });
    }
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    server.recipientWrites.push(body);
    const created = recipientRecord(String(body.recipient_ref ?? ""), String(body.label ?? ""), {
      destination_masked: maskedForm(String(body.destination ?? "")),
    });
    server.recipients.push(created);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "created", recipient: created }),
    });
  });
  await page.route("**/api/v1/admin/automation-recipients/*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const recipientId = new URL(route.request().url()).pathname.split("/").pop()!;
    const stored = server.recipients.find((entry) => entry.recipient_id === recipientId);
    if (!stored) return route.fulfill({ status: 404, body: "{}" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      // `owner` is the reference the seeded automation rule names, so retiring it is refused.
      body: JSON.stringify({
        recipient: stored,
        referenced_by:
          stored.recipient_ref === "owner"
            ? [
                {
                  rule_id: "rule_new",
                  pipeline_id: pipeline.pipeline_id,
                  to_stage_id: pipeline.stages[0]!.stage_id,
                },
              ]
            : [],
      }),
    });
  });
  await page.route("**/api/v1/admin/pipelines", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(pipelineResponse),
    });
  });
  await page.route("**/api/v1/admin/schema-fields", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: 1, catalog: fieldCatalog, fields: server.fields }),
    });
  });
  // A field revision is the only way to move a definition, so the fixture applies it the way
  // the Worker does: the recorded position replaces the stored one and the version advances.
  await page.route("**/api/v1/admin/schema-fields/*", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const fieldId = new URL(route.request().url()).pathname.split("/").pop()!;
    const body = route.request().postDataJSON() as {
      action?: unknown;
      position?: unknown;
      expected_version?: unknown;
    };
    server.revisions.push({
      field_id: fieldId,
      action: body.action,
      position: body.position,
      expected_version: body.expected_version,
    });
    const stored = server.fields.find((field) => field.field_id === fieldId);
    if (!stored || stored.version !== body.expected_version) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "schema_field_version_conflict" }),
      });
    }
    stored.position = Number(body.position);
    stored.version += 1;
    stored.revision_id = `fieldrev_${stored.field_key}_${stored.version}`;
    stored.action = "reorder";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "revised", field: stored }),
    });
  });
  await page.route(
    `**/api/v1/admin/pipelines/${pipeline.pipeline_id}/automation-rules`,
    (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(automationResponse),
      });
    },
  );
  await page.route("**/api/v1/admin/document-templates", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          catalog: documentCatalog,
          templates: server.documents,
        }),
      });
    }
    if (route.request().method() !== "POST") return route.fallback();
    // The fixture accepts a create the way the Worker does: the layout the client sent is what
    // comes back, so the screen an administrator sees after saving is the one they authored.
    const body = route.request().postDataJSON() as Record<string, unknown>;
    server.documentWrites.push(body);
    const created = {
      ...documentTemplate,
      template_id: `template:${String(body.template_key ?? "").padEnd(40, "0")}`,
      template_key: String(body.template_key ?? ""),
      label: String(body.label ?? ""),
      entity_type: String(body.entity_type ?? "lead"),
      blocks: body.blocks,
    };
    server.documents.push(created as typeof documentTemplate);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "created", template: created }),
    });
  });
  return server;
}

/** What the Worker publishes in place of an address: enough to recognise, never enough to harvest. */
function maskedForm(destination: string): string {
  const at = destination.indexOf("@");
  return at < 1 ? "***" : `${destination.slice(0, 1)}***${destination.slice(at)}`;
}

/**
 * A configuration screen is taller than a phone, so a screenshot of it scrolls the sticky shell
 * chrome through the middle of the evidence image. Hide the chrome for the shot only, and leave
 * the layout in place so nothing measured after it moves.
 */
async function withoutShellChrome(page: Page, shoot: () => Promise<unknown>): Promise<void> {
  const style = await page.addStyleTag({
    content:
      // The SHELL chrome only: the page's own header is the evidence, not the thing in its way.
      "header.safe-top, .safe-bottom, [aria-label='Main navigation'], a[href='#main-content'] { visibility: hidden !important; }",
  });
  await shoot();
  await style.evaluate((node) => node.remove());
}

async function screenshotFieldList(page: Page, path: string): Promise<void> {
  await withoutShellChrome(page, () =>
    page.getByRole("list", { name: "Field definitions" }).screenshot({ path }),
  );
}

/** The order an admin actually reads, taken from the move controls that reorder it. */
async function renderedFieldOrder(page: Page): Promise<string[]> {
  return await page
    .getByRole("list", { name: "Field definitions" })
    .getByRole("button", { name: /^Move .+ up$/ })
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute("aria-label") ?? "").replace(/^Move | up$/g, "")),
    );
}

async function routeSessionAsRole(page: Page, role: "ops") {
  const probe = {
    sourceAuthenticated: false,
    sourceRole: null as string | null,
    servedRole: null as string | null,
  };
  await page.route("**/api/v1/session", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      authenticated: boolean;
      user: { role: string; [key: string]: unknown } | null;
      [key: string]: unknown;
    };
    probe.sourceAuthenticated = body.authenticated;
    probe.sourceRole = body.user?.role ?? null;
    const user = body.user ? { ...body.user, role } : null;
    probe.servedRole = user?.role ?? null;
    await route.fulfill({ response, body: JSON.stringify({ ...body, user }) });
  });
  return probe;
}

async function expectCachedContent(page: Page, routeCase: { path: string; cachedText: string }) {
  if (routeCase.path.endsWith("/automations")) {
    await expect(page.getByRole("combobox", { name: "Pipeline" })).toHaveValue(
      pipeline.pipeline_id,
    );
    await expect(
      page.getByRole("option", { name: routeCase.cachedText, exact: true }),
    ).toBeAttached();
    return;
  }
  await expect(page.getByText(routeCase.cachedText, { exact: true })).toBeVisible();
}

async function focusFromKeyboard(page: Page, action: import("@playwright/test").Locator) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("Tab");
    if (await action.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard focus did not reach the route action");
}

async function expectKeyboardFocusVisible(control: import("@playwright/test").Locator) {
  const focus = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineVisible: style.outlineStyle !== "none" && style.outlineWidth !== "0px",
    };
  });
  expect(focus.focusVisible || focus.outlineVisible).toBe(true);
}
