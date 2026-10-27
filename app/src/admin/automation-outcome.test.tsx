import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAutomationRule,
  loadAdminPipelines,
  loadAutomationActivity,
  loadAutomationRules,
} from "./configuration-api";
import {
  automationActivityResponseSchema,
  automationDispatchSchema,
} from "./configuration-contracts";
import type {
  AdminPipeline,
  AdminPipelineListResponse,
  AutomationActivityResponse,
  AutomationCatalog,
  AutomationDispatch,
  AutomationListResponse,
  AutomationRule,
} from "./configuration-contracts";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import {
  AutomationConfigurationPage,
  automationTemplateDisplay,
  automationTemplateOptions,
} from "./automation-configuration-page";
import {
  automationActivitySummary,
  automationOutcomeCopy,
  sortAutomationActivity,
} from "./automation-outcome";

vi.mock("./configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configuration-api")>()),
  createAutomationRule: vi.fn(),
  loadAdminPipelines: vi.fn(),
  loadAutomationActivity: vi.fn(),
  loadAutomationHistory: vi.fn(),
  loadAutomationRules: vi.fn(),
  reviseAutomationRule: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

const DOCUMENT_ACTION = "operations.document.generate_and_send";
const EMAIL_ACTION = "operations.email.send";
const MATERIALS_TEMPLATE_ID = "template:0000000000000000000000000000000000000abc";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

const pipeline: AdminPipeline = {
  pipeline_id: "pipeline_sales",
  key: "sales",
  name: "Sales board",
  entity_type: "job",
  owning_role: "owner",
  is_active: true,
  is_template: false,
  template_source_id: null,
  position: 0,
  version: 2,
  card_count: 1,
  card_template: { version: 1, slots: [] },
  stages: [
    {
      stage_id: "stage_sold",
      key: "sold",
      name: "Sold",
      color: null,
      position: 0,
      is_won: false,
      is_lost: false,
      min_role_to_enter: null,
      is_active: true,
      card_count: 1,
      updated_at: "2026-08-27T10:00:00.000Z",
    },
    {
      stage_id: "stage_production",
      key: "production",
      name: "In production",
      color: null,
      position: 1,
      is_won: false,
      is_lost: false,
      min_role_to_enter: null,
      is_active: true,
      card_count: 0,
      updated_at: "2026-08-27T10:00:00.000Z",
    },
  ],
  role_grants: [],
  updated_at: "2026-08-27T10:00:00.000Z",
};

const pipelineList: AdminPipelineListResponse = {
  version: 1,
  entity_types: [{ entity_type: "job", label: "Job" }],
  roles: ["owner"],
  stage_limit: 200,
  pipelines: [pipeline],
};

/** A catalog shaped the way the server publishes it: each action carries its own templates. */
function catalog(overrides: Partial<AutomationCatalog> = {}): AutomationCatalog {
  return {
    actions: [
      { action: EMAIL_ACTION, label: "Stage-change email", template_source: "builtin" },
      {
        action: DOCUMENT_ACTION,
        label: "Generate a document and send it",
        template_source: "document_template",
      },
    ],
    templates: [
      {
        template_key: "pipeline.stage-change-summary",
        version: 1,
        label: "Stage-change summary",
        action: EMAIL_ACTION,
      },
      {
        template_key: MATERIALS_TEMPLATE_ID,
        version: 2,
        label: "Materials list",
        action: DOCUMENT_ACTION,
      },
    ],
    recipient_refs: ["shop"],
    recipient_configured: true,
    document_generation_configured: true,
    ...overrides,
  };
}

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    rule_id: "rule_production",
    tenant_id: "freshco",
    pipeline_id: pipeline.pipeline_id,
    to_stage_id: "stage_production",
    revision_id: "automationrev_production_1",
    version: 1,
    prior_revision_id: null,
    action: DOCUMENT_ACTION,
    recipient_ref: "shop",
    template_key: MATERIALS_TEMPLATE_ID,
    template_version: 2,
    active: 1,
    actor_role: "owner",
    actor_id: "appu_owner",
    created_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function automationList(overrides: Partial<AutomationListResponse> = {}): AutomationListResponse {
  return {
    version: 1,
    pipeline_id: pipeline.pipeline_id,
    rules: [],
    catalog: catalog(),
    ...overrides,
  };
}

function dispatch(
  invocationId: string,
  overrides: Partial<AutomationDispatch> = {},
): AutomationDispatch {
  return {
    invocation_id: invocationId,
    outbox_id: `outbox_${invocationId}`,
    transition_id: `transition_${invocationId}`,
    card_id: "card_one",
    to_stage_id: "stage_production",
    rule_version: 1,
    action: DOCUMENT_ACTION,
    status: "succeeded",
    attempt_count: 1,
    result_code: "delivered",
    created_at: "2026-08-28T09:00:00.000Z",
    updated_at: "2026-08-28T09:00:05.000Z",
    completed_at: "2026-08-28T09:00:05.000Z",
    ...overrides,
  };
}

function activity(entries: AutomationDispatch[]): AutomationActivityResponse {
  return {
    version: 1,
    pipeline_id: pipeline.pipeline_id,
    rule_id: "rule_production",
    activity: entries,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
  vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineList);
});

describe("choosing what an automation sends", () => {
  it("offers an administrator-authored document once the document action is chosen", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(automationList());
    vi.mocked(createAutomationRule).mockResolvedValue({
      rule: rule(),
      catalog: catalog(),
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New rule" }));
    const template = screen.getByLabelText("Template");
    // The built-in action starts selected, so only its own template is on offer. Offering the
    // document here would offer a pair the server refuses.
    expect([...(template as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      "pipeline.stage-change-summary",
    ]);

    await user.selectOptions(screen.getByLabelText("Action"), DOCUMENT_ACTION);
    expect(
      [...(screen.getByLabelText("Template") as HTMLSelectElement).options].map(
        (option) => option.textContent,
      ),
    ).toEqual(["Materials list"]);

    await user.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(createAutomationRule).toHaveBeenCalledOnce());
    expect(vi.mocked(createAutomationRule).mock.calls[0]?.[2]).toMatchObject({
      action: DOCUMENT_ACTION,
      template_key: MATERIALS_TEMPLATE_ID,
      template_version: 2,
    });
  });

  it("describes a saved rule by the document's name, never by the stored identifier", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(automationList({ rules: [rule()] }));
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    expect(
      await screen.findByText(/Generate a document and send it · Materials list · shop/),
    ).toBeVisible();
    // `template_key` holds a template_id for a document rule. An administrator never chose that
    // string and cannot act on it, so it does not appear.
    expect(screen.queryByText(new RegExp(MATERIALS_TEMPLATE_ID))).toBeNull();
  });

  it("keeps a picker of one when the deployment does not scope templates by action", () => {
    const legacy = catalog({
      actions: [{ action: EMAIL_ACTION, label: "Stage-change email" }],
      templates: [
        {
          template_key: "pipeline.stage-change-summary",
          version: 1,
          label: "Stage-change summary",
        },
      ],
    });
    expect(automationTemplateOptions(legacy, EMAIL_ACTION)).toHaveLength(1);
  });

  it("says so plainly when a rule points at a document that is gone", () => {
    expect(
      automationTemplateDisplay(catalog({ templates: [] }), {
        template_key: MATERIALS_TEMPLATE_ID,
        template_version: 2,
      }),
    ).toBe("A document that is no longer offered");
  });
});

describe("seeing what an automation actually did", () => {
  it("surfaces a failed firing with a reason an administrator can act on", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationList({ rules: [rule()], catalog: catalog({ activity_available: true }) }),
    );
    vi.mocked(loadAutomationActivity).mockResolvedValue(
      activity([
        dispatch("inv_1", {
          status: "failed",
          result_code: "automation_recipient_ref_unknown",
          attempt_count: 3,
        }),
      ]),
    );
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    // The badge is the discovery: nobody has to open a panel to learn a rule is broken.
    expect(await screen.findByText("1 failed")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Activity" }));
    const firings = await screen.findByRole("list", { name: "Recent firings" });
    expect(within(firings).getByText("Failed")).toBeVisible();
    expect(
      within(firings).getByText("This rule points at a recipient that is no longer configured."),
    ).toBeVisible();
    expect(
      within(firings).getByText("Revise the rule and choose an available recipient."),
    ).toBeVisible();
    // The code stays as provenance beside the sentence; it is never the sentence.
    expect(within(firings).getByText(/automation_recipient_ref_unknown/)).toBeVisible();
  });

  it("renders an unconfirmed firing as neither sent nor failed", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationList({ rules: [rule()], catalog: catalog({ activity_available: true }) }),
    );
    vi.mocked(loadAutomationActivity).mockResolvedValue(
      activity([
        dispatch("inv_2", {
          status: "unknown",
          result_code: "gmail_readback_id_missing",
          completed_at: null,
        }),
      ]),
    );
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    expect(await screen.findByText("1 not confirmed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    const firings = await screen.findByRole("list", { name: "Recent firings" });

    expect(within(firings).getByText("Not confirmed")).toBeVisible();
    expect(within(firings).queryByText("Sent")).toBeNull();
    expect(within(firings).queryByText("Failed")).toBeNull();
    expect(
      within(firings).getByText(
        "The email service accepted the message but returned nothing to check it against, so delivery could not be confirmed.",
      ),
    ).toBeVisible();
    expect(
      within(firings).getByText("Check with the recipient before sending it again."),
    ).toBeVisible();
  });

  it("lists successes beside failures, newest first", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationList({ rules: [rule()], catalog: catalog({ activity_available: true }) }),
    );
    vi.mocked(loadAutomationActivity).mockResolvedValue(
      activity([
        dispatch("inv_old", { created_at: "2026-08-28T08:00:00.000Z" }),
        dispatch("inv_new", {
          created_at: "2026-08-28T10:00:00.000Z",
          status: "failed",
          result_code: "automation_provider_error",
        }),
      ]),
    );
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "Activity" }));

    const items = within(await screen.findByRole("list", { name: "Recent firings" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Failed");
    expect(items[1]).toHaveTextContent("Sent");
  });

  it("names the window instead of implying it is the whole record", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationList({ rules: [rule()], catalog: catalog({ activity_available: true }) }),
    );
    // The server capped this read at 20 and says it clipped older firings.
    vi.mocked(loadAutomationActivity).mockResolvedValue({
      ...activity(
        Array.from({ length: 20 }, (_, index) =>
          dispatch(`inv_${index}`, {
            created_at: `2026-08-28T${String(index).padStart(2, "0")}:00:00.000Z`,
          }),
        ),
      ),
      limit: 20,
      truncated: true,
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    // "20 sent" would read as "this rule has fired 20 times and never failed", which is exactly
    // the all-clear a clipped window cannot support.
    expect(await screen.findByText("20 most recent sent")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(
      await screen.findByText(
        /The 20 most recent times this rule ran\. Older firings are not shown/,
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Last 20 firings" })).toBeVisible();
    expect(screen.queryByText(/Every time a card entered this stage/)).toBeNull();
  });

  it("claims completeness only when the server says the window clipped nothing", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationList({ rules: [rule()], catalog: catalog({ activity_available: true }) }),
    );
    vi.mocked(loadAutomationActivity).mockResolvedValue({
      ...activity([
        dispatch("inv_1"),
        dispatch("inv_2", { created_at: "2026-08-28T08:00:00.000Z" }),
      ]),
      limit: 20,
      truncated: false,
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    expect(await screen.findByText("2 sent")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(
      await screen.findByText(/Every time a card entered this stage and the rule ran/),
    ).toBeVisible();
  });

  it("shows no firing surface at all when the deployment does not publish outcomes", async () => {
    vi.mocked(loadAutomationRules).mockResolvedValue(automationList({ rules: [rule()] }));
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    expect(await screen.findByRole("button", { name: "History" })).toBeVisible();
    // An empty panel would read as "nothing has gone wrong", which is a claim an unpublished
    // outcome cannot support. Nothing is asked for and nothing is shown.
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    expect(loadAutomationActivity).not.toHaveBeenCalled();
  });
});

/**
 * The seat boundary, asserted rather than assumed.
 *
 * `ironwrap-engineer` owns `workers-bus`; this client was written against a contract handed over on
 * ELEC-209 and implemented in PR #212. The fixtures below are the shape that PR publishes, copied
 * from `docs/PIPELINE-ADMIN-API-CONTRACT.md` and its own row-key assertion. If either seat moves
 * without the other, these fail here rather than in an administrator's browser - the same discipline
 * ELEC-195 / PR #203 used across the document read boundary.
 */
describe("agreeing with the activity route as shipped", () => {
  /** Every key one activity row carries, and no other (PR #212, `DISPATCH_KEYS`). */
  const SHIPPED_ROW_KEYS = [
    "action",
    "attempt_count",
    "card_id",
    "completed_at",
    "created_at",
    "invocation_id",
    "outbox_id",
    "result_code",
    "rule_version",
    "status",
    "to_stage_id",
    "transition_id",
    "updated_at",
  ];

  const SHIPPED_RESPONSE = {
    version: 1,
    pipeline_id: "pipeline_sales",
    rule_id: "rule_production",
    limit: 20,
    truncated: true,
    activity: [
      {
        invocation_id: "automationinv_one",
        outbox_id: "automationoutbox_one",
        transition_id: "transition_one",
        card_id: "card_one",
        to_stage_id: "stage_production",
        rule_version: 1,
        action: "operations.document.generate_and_send",
        status: "unknown",
        attempt_count: 1,
        result_code: "gmail_readback_id_missing",
        created_at: "2026-08-28T09:00:00.000Z",
        updated_at: "2026-08-28T09:00:05.000Z",
        completed_at: null,
      },
    ],
  };

  it("parses the response the route actually returns, window fields included", () => {
    const parsed = automationActivityResponseSchema.parse(SHIPPED_RESPONSE);
    // `limit` and `truncated` reached the client as values, not as fields dropped by passthrough:
    // a window the client cannot read is a window it will render as the whole record.
    expect(parsed.limit).toBe(20);
    expect(parsed.truncated).toBe(true);
    expect(parsed.activity[0]?.status).toBe("unknown");
  });

  it("reads exactly the keys the server publishes — no more, no fewer", () => {
    expect(Object.keys(automationDispatchSchema.shape).sort()).toEqual(
      [...SHIPPED_ROW_KEYS].sort(),
    );
  });

  it("accepts the nulls the server is entitled to send", () => {
    const row = SHIPPED_RESPONSE.activity[0]!;
    expect(() =>
      automationDispatchSchema.parse({
        ...row,
        card_id: null,
        result_code: null,
        completed_at: null,
      }),
    ).not.toThrow();
  });

  it("refuses a status outside the three the rail can reach", () => {
    const row = SHIPPED_RESPONSE.activity[0]!;
    expect(() => automationDispatchSchema.parse({ ...row, status: "sent" })).toThrow();
  });

  it("still parses a deployment that publishes no window, and then claims nothing about it", () => {
    const { limit, truncated, ...withoutWindow } = SHIPPED_RESPONSE;
    expect(limit).toBe(20);
    expect(truncated).toBe(true);
    const parsed = automationActivityResponseSchema.parse(withoutWindow);
    expect(parsed.limit).toBeUndefined();
    expect(parsed.truncated).toBeUndefined();
    // With no stated window, the badge falls back to the plain count rather than inventing a cap.
    expect(automationActivitySummary(parsed.activity, parsed.truncated === true)).toEqual({
      tone: "warning",
      label: "1 not confirmed",
    });
  });
});

describe("translating one firing", () => {
  it("keeps the three terminal outcomes distinct", () => {
    const sent = automationOutcomeCopy("succeeded", "delivered");
    const failed = automationOutcomeCopy("failed", "automation_provider_error");
    const unconfirmed = automationOutcomeCopy("unknown", "gmail_readback_id_missing");
    expect([sent.label, failed.label, unconfirmed.label]).toEqual([
      "Sent",
      "Failed",
      "Not confirmed",
    ]);
    expect([sent.tone, failed.tone, unconfirmed.tone]).toEqual(["ok", "danger", "warning"]);
    expect(new Set([sent.reason, failed.reason, unconfirmed.reason]).size).toBe(3);
  });

  it("answers from the status when nobody has written copy for the code", () => {
    const copy = automationOutcomeCopy("failed", "some_code_nobody_translated");
    expect(copy.label).toBe("Failed");
    expect(copy.reason).toBe("The automation ran and did not go through.");
    // The raw code is never the message an administrator is asked to interpret.
    expect(copy.reason).not.toContain("some_code_nobody_translated");
  });

  it("lets a code say that nothing is required, without inheriting the status's next step", () => {
    expect(automationOutcomeCopy("failed", "automation_provider_error").nextStep).toBe(
      "Nothing was sent. Check the recipient configuration, then move the card again.",
    );
    expect(automationOutcomeCopy("succeeded", "recovered_effect_success").nextStep).toBeNull();
  });

  it("ranks a failure above an unconfirmed firing above work in flight", () => {
    expect(automationActivitySummary([])).toBeNull();
    expect(automationActivitySummary([dispatch("a", { status: "failed" }), dispatch("b")])).toEqual(
      { tone: "danger", label: "1 failed" },
    );
    expect(
      automationActivitySummary([dispatch("a", { status: "unknown" }), dispatch("b")]),
    ).toEqual({ tone: "warning", label: "1 not confirmed" });
    expect(automationActivitySummary([dispatch("a", { status: "retry" })])).toEqual({
      tone: "info",
      label: "1 in progress",
    });
    expect(automationActivitySummary([dispatch("a"), dispatch("b")])).toEqual({
      tone: "ok",
      label: "2 sent",
    });
  });

  it("stops the all-clear from claiming more than the window it read", () => {
    const window = [dispatch("a"), dispatch("b")];
    // A count is a completeness claim; a clipped window cannot support one.
    expect(automationActivitySummary(window, true)).toEqual({
      tone: "ok",
      label: "2 most recent sent",
    });
    // A failure or an unconfirmed firing is a lower bound - one found is one to act on - so those
    // labels stay exactly as they are whether or not older firings were clipped.
    expect(automationActivitySummary([dispatch("a", { status: "failed" })], true)).toEqual({
      tone: "danger",
      label: "1 failed",
    });
  });

  it("orders firings newest first, and breaks a tie on identity rather than on arrival", () => {
    const ordered = sortAutomationActivity([
      dispatch("inv_a", { created_at: "2026-08-28T09:00:00.000Z" }),
      dispatch("inv_c", { created_at: "2026-08-28T09:00:00.000Z" }),
      dispatch("inv_b", { created_at: "2026-08-28T11:00:00.000Z" }),
    ]).map((entry) => entry.invocation_id);
    expect(ordered).toEqual(["inv_b", "inv_c", "inv_a"]);
  });
});
