import { onlineManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import {
  automationRecipientErrorMessage,
  createAutomationRecipient,
  createAutomationRule,
  loadAdminPipelines,
  loadAutomationRecipientDetail,
  loadAutomationRecipientHistory,
  loadAutomationRecipients,
  loadAutomationRules,
  retireAutomationRecipient,
  reviseAutomationRecipient,
} from "./configuration-api";
import type {
  AdminPipeline,
  AdminPipelineListResponse,
  AutomationListResponse,
  AutomationRecipient,
  AutomationRecipientListResponse,
} from "./configuration-contracts";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import {
  automationRecipientProblem,
  recipientAddressProblem,
  recipientRefFromLabel,
} from "./automation-recipient-form";
import { AutomationConfigurationPage } from "./automation-configuration-page";
import {
  AutomationRecipientsConfigurationPage,
  sortAutomationRecipients,
} from "./automation-recipients-configuration-page";

vi.mock("./configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configuration-api")>()),
  createAutomationRecipient: vi.fn(),
  createAutomationRule: vi.fn(),
  loadAdminPipelines: vi.fn(),
  loadAutomationRecipientDetail: vi.fn(),
  loadAutomationRecipientHistory: vi.fn(),
  loadAutomationRecipients: vi.fn(),
  loadAutomationRules: vi.fn(),
  retireAutomationRecipient: vi.fn(),
  reviseAutomationRecipient: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

/**
 * Connectivity, as both the app and React Query see it.
 *
 * React Query only listens for the window event while a client is mounted, so a test that goes
 * offline and unmounts leaves the query layer stuck offline and every later query paused
 * mid-flight. Telling the manager directly is what keeps one test's disconnection its own.
 */
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
  act(() => {
    onlineManager.setOnline(value);
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

function recipient(
  ref: string,
  label: string,
  overrides: Partial<AutomationRecipient> = {},
): AutomationRecipient {
  return {
    recipient_id: `recipient_${ref}`,
    recipient_ref: ref,
    revision_id: `recipientrev_${ref}_1`,
    version: 1,
    prior_revision_id: null,
    action: "create",
    label,
    channel: "email",
    destination_masked: `s***@${ref}.example.invalid`,
    destination_digest: "d".repeat(64),
    active: true,
    actor: { role: "owner", id: "appu_owner" },
    command_fingerprint: "c".repeat(64),
    created_at: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

function recipientList(recipients: AutomationRecipient[]): AutomationRecipientListResponse {
  return { version: 1, catalog: { channels: ["email"] }, recipients };
}

const stage = {
  stage_id: "stage_new",
  key: "new",
  name: "New",
  color: null,
  position: 0,
  is_won: false,
  is_lost: false,
  min_role_to_enter: null,
  is_active: true,
  card_count: 0,
  updated_at: "2026-08-28T10:00:00.000Z",
};

const pipeline: AdminPipeline = {
  pipeline_id: "pipeline_one",
  key: "one",
  name: "Sales board",
  entity_type: "lead",
  owning_role: "owner",
  is_active: true,
  is_template: false,
  template_source_id: null,
  position: 0,
  version: 1,
  card_count: 0,
  card_template: { version: 1, slots: [] },
  stages: [stage],
  role_grants: [],
  updated_at: "2026-08-28T10:00:00.000Z",
};

const pipelineResponse: AdminPipelineListResponse = {
  version: 1,
  entity_types: [{ entity_type: "lead", label: "Lead" }],
  roles: ["owner"],
  stage_limit: 200,
  pipelines: [pipeline],
};

function automationResponse(
  overrides: Partial<AutomationListResponse["catalog"]> = {},
): AutomationListResponse {
  return {
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
      recipient_refs: [],
      recipient_configured: false,
      ...overrides,
    },
  };
}

describe("automation recipient administration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOnline(true);
  });

  it("keeps the recipients screen owner-only for direct navigation", () => {
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("ops"));
    expect(screen.getByText("This work belongs to another role")).toBeVisible();
    expect(loadAutomationRecipients).not.toHaveBeenCalled();
  });

  // The defect ELEC-218 recorded: the route existed server-side and nothing in `app/` called it,
  // so "add the shop" meant a developer with deploy access. This is the whole fix in one flow.
  it("adds a recipient from an empty catalog without a developer", async () => {
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([]));
    vi.mocked(createAutomationRecipient).mockResolvedValue({
      outcome: "created",
      recipient: recipient("the-shop", "The shop"),
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    expect(await screen.findByText("No recipients yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New recipient" }));

    // Taking over the deployment's own list is a consequence an owner has to be told about
    // BEFORE the first save, not after their existing rules stop resolving.
    expect(screen.getByText("This is the first recipient this account owns")).toBeVisible();

    await user.type(screen.getByLabelText("Name"), "The shop");
    // The reference an owner never has to invent, derived from the name they did type.
    expect(screen.getByLabelText("Reference")).toHaveValue("the-shop");
    await user.type(screen.getByLabelText("Email address"), "Shop@Example.Invalid");
    await user.click(screen.getByRole("button", { name: "Save recipient" }));

    await waitFor(() => expect(createAutomationRecipient).toHaveBeenCalledOnce());
    expect(vi.mocked(createAutomationRecipient).mock.calls[0]?.[1]).toEqual({
      recipient_ref: "the-shop",
      label: "The shop",
      channel: "email",
      destination: "shop@example.invalid",
    });
  });

  it("refuses to save a recipient whose address is not one plain address", async () => {
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([]));
    const user = userEvent.setup();
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New recipient" }));
    await user.type(screen.getByLabelText("Name"), "The shop");
    await user.type(screen.getByLabelText("Email address"), "Shop <shop@example.invalid>");
    await user.click(screen.getByRole("button", { name: "Save recipient" }));

    expect(screen.getByText("Not ready to save")).toBeVisible();
    expect(createAutomationRecipient).not.toHaveBeenCalled();
  });

  // The server never hands the address back, so the form cannot pre-fill it. Omitting the key is
  // what keeps the stored address; sending the mask back would overwrite a real inbox with stars.
  it("re-labels a recipient without resending an address it was never given", async () => {
    const shop = recipient("shop", "The shop", { version: 3 });
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([shop]));
    vi.mocked(reviseAutomationRecipient).mockResolvedValue({
      outcome: "revised",
      recipient: { ...shop, version: 4, label: "Shop desk" },
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const reference = screen.getByLabelText("Reference");
    expect(reference).toHaveValue("shop");
    expect(reference).toBeDisabled();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Shop desk");
    await user.click(screen.getByRole("button", { name: "Save recipient" }));

    await waitFor(() => expect(reviseAutomationRecipient).toHaveBeenCalledOnce());
    const [, recipientId, body] = vi.mocked(reviseAutomationRecipient).mock.calls[0]!;
    expect(recipientId).toBe("recipient_shop");
    expect(body).toEqual({ label: "Shop desk", channel: "email", expected_version: 3 });
    expect(body).not.toHaveProperty("destination");
  });

  // Retiring a recipient a live rule still names would turn a configuration change into a silent
  // delivery failure. The server refuses it; this screen asks the same question first.
  it("names the live rules that block a retirement instead of offering a refused command", async () => {
    const shop = recipient("shop", "The shop");
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([shop]));
    vi.mocked(loadAutomationRecipientDetail).mockResolvedValue({
      recipient: shop,
      referenced_by: [
        { rule_id: "rule_one", pipeline_id: "pipeline_one", to_stage_id: "stage_production" },
      ],
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Retire" }));
    expect(await screen.findByText("One live rule still sends here")).toBeVisible();
    expect(screen.getByText(/stage_production/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retire recipient" })).toBeDisabled();
    expect(retireAutomationRecipient).not.toHaveBeenCalled();
  });

  it("retires a recipient nothing points at", async () => {
    const shop = recipient("shop", "The shop", { version: 2 });
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([shop]));
    vi.mocked(loadAutomationRecipientDetail).mockResolvedValue({
      recipient: shop,
      referenced_by: [],
    });
    vi.mocked(retireAutomationRecipient).mockResolvedValue({
      outcome: "revised",
      recipient: { ...shop, version: 3, active: false, action: "retire" },
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Retire" }));
    expect(await screen.findByText(/No live rule sends to shop/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retire recipient" }));

    await waitFor(() => expect(retireAutomationRecipient).toHaveBeenCalledOnce());
    expect(vi.mocked(retireAutomationRecipient).mock.calls[0]?.[1]).toMatchObject({
      recipient_id: "recipient_shop",
      version: 2,
    });
  });

  it("offers a retired recipient a restore rather than a second create", async () => {
    const retired = recipient("shop", "The shop", { active: false, action: "retire", version: 4 });
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([retired]));
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));

    expect(await screen.findByRole("button", { name: "Restore" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retire" })).toBeNull();
    expect(
      screen.getByText(/a rule still naming it fails rather than delivering somewhere unintended/i),
    ).toBeVisible();
  });

  it("keeps cached recipients readable while offline and refuses every write", async () => {
    const shop = recipient("shop", "The shop");
    vi.mocked(loadAutomationRecipients).mockResolvedValue(recipientList([shop]));
    const user = userEvent.setup();
    const { unmount } = renderWithSession(
      <AutomationRecipientsConfigurationPage />,
      sessionFor("owner"),
    );
    expect(await screen.findByText("The shop")).toBeVisible();

    setOnline(false);

    expect(await screen.findByText("Offline — configuration is read-only")).toBeVisible();
    expect(screen.getByText("The shop")).toBeVisible();
    expect(screen.getByRole("button", { name: "New recipient" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("History is not cached")).toBeVisible();
    expect(loadAutomationRecipientHistory).not.toHaveBeenCalled();
    expect(reviseAutomationRecipient).not.toHaveBeenCalled();
    unmount();

    // A cold offline open has nothing to show and says so, rather than an empty list that reads
    // as "this account has no recipients".
    renderWithSession(<AutomationRecipientsConfigurationPage />, sessionFor("owner"));
    expect(screen.getByText(/not available offline yet/)).toBeVisible();
    expect(loadAutomationRecipients).toHaveBeenCalledTimes(1);
  });

  // A rule half-composed when the owner discovers the recipient is missing is real work. Adding
  // one must not cost them the stage, action and template they already chose.
  it("adds a recipient from inside the rule builder without losing the rule being composed", async () => {
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse);
    vi.mocked(loadAutomationRules).mockResolvedValue(automationResponse());
    vi.mocked(createAutomationRecipient).mockResolvedValue({
      outcome: "created",
      recipient: recipient("the-shop", "The shop"),
    });
    vi.mocked(createAutomationRule).mockResolvedValue({
      rule: undefined as never,
      catalog: automationResponse().catalog,
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.selectOptions(screen.getByLabelText("When a card enters"), "stage_new");
    expect(screen.getByRole("button", { name: "Save automation" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add a recipient" }));
    await user.type(screen.getByLabelText("Name"), "The shop");
    await user.type(screen.getByLabelText("Email address"), "shop@example.invalid");
    await user.click(screen.getByRole("button", { name: "Save recipient" }));

    await waitFor(() => expect(createAutomationRecipient).toHaveBeenCalledOnce());
    // The rule survived, the new recipient is selected, and the save is now possible.
    const picker = await screen.findByLabelText("Recipient");
    expect(picker).toHaveValue("the-shop");
    expect(within(picker).getByRole("option", { name: "The shop · the-shop" })).toBeInTheDocument();
    expect(screen.getByLabelText("When a card enters")).toHaveValue("stage_new");

    const save = screen.getByRole("button", { name: "Save automation" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(createAutomationRule).toHaveBeenCalledOnce());
    expect(vi.mocked(createAutomationRule).mock.calls[0]?.[2]).toMatchObject({
      to_stage_id: "stage_new",
      recipient_ref: "the-shop",
    });
  });

  it("counts the rules a refused retirement named", () => {
    const refused = new ApiError({
      message: "in use",
      status: 409,
      code: "automation_recipient_in_use",
      details: {
        rules: [
          { rule_id: "rule_one", pipeline_id: "p", to_stage_id: "s" },
          { rule_id: "rule_two", pipeline_id: "p", to_stage_id: "s" },
        ],
      },
    });
    expect(automationRecipientErrorMessage(refused)).toMatch(/2 automation rules still send/);
    const immutable = new ApiError({
      message: "immutable",
      status: 409,
      code: "automation_recipient_ref_immutable",
    });
    expect(automationRecipientErrorMessage(immutable)).toMatch(/cannot be renamed/);
  });

  it("derives a reference an owner never has to invent", () => {
    expect(recipientRefFromLabel("The Shop")).toBe("the-shop");
    expect(recipientRefFromLabel("  Ilya's office / dispatch  ")).toBe("ilya-s-office-dispatch");
    expect(recipientRefFromLabel("!!!")).toBe("");
  });

  it("applies the server's own narrow address parse before the round trip", () => {
    expect(recipientAddressProblem("shop@example.invalid")).toBeNull();
    expect(recipientAddressProblem("shop@sub.example.invalid")).toBeNull();
    for (const rejected of [
      "shop@example.invalid, office@example.invalid",
      "Shop <shop@example.invalid>",
      "shop@@example.invalid",
      "shop@example",
      ".shop@example.invalid",
      "shop@ example.invalid",
      "shop@exämple.invalid",
    ])
      expect(recipientAddressProblem(rejected)).not.toBeNull();
  });

  it("asks for the address on a create and lets a revise keep the stored one", () => {
    const base = { label: "The shop", recipientRef: "shop", address: "" };
    expect(automationRecipientProblem({ ...base, existing: false })).toMatch(/email address/);
    expect(automationRecipientProblem({ ...base, existing: true })).toBeNull();
    expect(automationRecipientProblem({ ...base, label: " ", existing: true })).toMatch(/a name/);
    expect(
      automationRecipientProblem({ ...base, recipientRef: "no spaces", existing: false }),
    ).toMatch(/letters, numbers/);
  });

  it("puts live recipients above retired ones and keeps the server's reference order", () => {
    const sorted = sortAutomationRecipients([
      recipient("owner", "Owner"),
      recipient("archive", "Archive", { active: false }),
      recipient("accounting", "Accounting"),
    ]);
    expect(sorted.map((entry) => entry.recipient_ref)).toEqual(["accounting", "owner", "archive"]);
  });
});
