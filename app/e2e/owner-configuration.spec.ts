import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
    recipient_configured: true,
  },
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
        path: "/settings/configuration/automations",
        heading: "Automations",
        action: "New rule",
        cachedText: "Sales board · lead",
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
      await expect(action).toBeVisible();
      const bounds = await action.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds?.width).toBeGreaterThanOrEqual(44);

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
      await expect(page.getByText("Offline — configuration is read-only")).toBeVisible();
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
    const bounds = await moveColourUp.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
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
      "/settings/configuration/automations",
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
        path: "/settings/configuration/automations",
        heading: "Automations",
        cachedText: "Sales board · lead",
        kind: "automation",
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
      } else {
        await page.getByRole("button", { name: "New rule", exact: true }).click();
        input = page.getByLabel("When a card enters", { exact: true });
        await input.selectOption(pipeline.stages[0]!.stage_id);
        await page.getByLabel("Action", { exact: true }).selectOption("operations.email.send");
        await page
          .getByLabel("Template", { exact: true })
          .selectOption("pipeline.stage-change-summary");
        await page.getByLabel("Recipient reference", { exact: true }).selectOption("owner");
        submit = page.getByRole("button", { name: "Save automation", exact: true });
      }

      await expect(input).toBeVisible();
      await expect(submit).toBeEnabled();
      await focusFromKeyboard(page, input);
      await expect(input).toBeFocused();
      await expectKeyboardFocusVisible(input);

      await context.setOffline(true);
      await expect(page.getByText("Offline — configuration is read-only")).toBeVisible();
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
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(results.violations).toEqual([]);
    }
    await context.setOffline(false);
  });
});

interface FieldServer {
  fields: ReturnType<typeof schemaField>[];
  revisions: { field_id: string; action: unknown; position: unknown; expected_version: unknown }[];
}

async function routeConfigurationApis(page: Page): Promise<FieldServer> {
  const server: FieldServer = {
    fields: seedFields.map((field) => ({ ...field })),
    revisions: [],
  };
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
  return server;
}

/**
 * The field list is taller than a phone screen, so an element screenshot of it scrolls the sticky
 * shell chrome through the middle of the evidence image. Hide the chrome for the shot only, and
 * leave the layout in place so nothing measured after it moves.
 */
async function screenshotFieldList(page: Page, path: string): Promise<void> {
  const style = await page.addStyleTag({
    content:
      "header, [aria-label='Main navigation'], a[href='#main-content'] { visibility: hidden !important; }",
  });
  await page.getByRole("list", { name: "Field definitions" }).screenshot({ path });
  await style.evaluate((node) => node.remove());
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
