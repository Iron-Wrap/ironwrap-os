import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import type {
  AdminPipeline,
  AdminPipelineListResponse,
  AdminPipelineStage,
  AutomationListResponse,
  SchemaFieldListResponse,
  SchemaField,
  SchemaFieldWriteInput,
} from "./configuration-contracts";
import {
  createSchemaField,
  createAutomationRule,
  loadAdminPipelines,
  loadAutomationHistory,
  loadAutomationRules,
  loadSchemaFieldHistory,
  loadSchemaFields,
  reviseSchemaField,
  reorderAdminPipelineStages,
  reorderAdminPipelines,
  updateAdminPipeline,
  updateAdminPipelineRoles,
} from "./configuration-api";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import { AutomationConfigurationPage } from "./automation-configuration-page";
import { ConfigurationPage } from "./configuration-page";
import { PipelineConfigurationPage, stageSwatchPresentation } from "./pipeline-configuration-page";
import {
  SchemaFieldsConfigurationPage,
  deriveSchemaFieldAction,
  planSchemaFieldReorder,
  sortSchemaFields,
} from "./schema-fields-configuration-page";

vi.mock("./configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configuration-api")>()),
  createAutomationRule: vi.fn(),
  createSchemaField: vi.fn(),
  loadAdminPipelines: vi.fn(),
  loadAutomationHistory: vi.fn(),
  loadAutomationRules: vi.fn(),
  loadSchemaFieldHistory: vi.fn(),
  loadSchemaFields: vi.fn(),
  reviseSchemaField: vi.fn(),
  reorderAdminPipelineStages: vi.fn(),
  reorderAdminPipelines: vi.fn(),
  updateAdminPipeline: vi.fn(),
  updateAdminPipelineRoles: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

function stage(
  stageId: string,
  position: number,
  overrides: Partial<AdminPipelineStage> = {},
): AdminPipelineStage {
  return {
    stage_id: stageId,
    key: stageId.replace("stage_", ""),
    name: stageId.replace("stage_", "Stage "),
    color: null,
    position,
    is_won: false,
    is_lost: false,
    min_role_to_enter: null,
    is_active: true,
    card_count: 0,
    updated_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function pipeline(
  pipelineId: string,
  name: string,
  position: number,
  overrides: Partial<AdminPipeline> = {},
): AdminPipeline {
  return {
    pipeline_id: pipelineId,
    key: pipelineId.replace("pipeline_", ""),
    name,
    entity_type: "lead",
    owning_role: "owner",
    is_active: true,
    is_template: false,
    template_source_id: null,
    position,
    version: 2,
    card_count: 0,
    card_template: { version: 1, slots: [] },
    stages: [stage(`${pipelineId}_stage_a`, 0), stage(`${pipelineId}_stage_b`, 1)],
    role_grants: [{ role: "ops", can_write: true }],
    updated_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function pipelineResponse(
  pipelines: AdminPipeline[],
  entityTypes = [{ entity_type: "lead", label: "Lead" }],
): AdminPipelineListResponse {
  return {
    version: 1,
    entity_types: entityTypes,
    roles: ["owner", "ops", "sales"],
    stage_limit: 200,
    pipelines,
  };
}

function schemaField(overrides: Partial<SchemaField> = {}): SchemaField {
  return {
    field_id: "field_one",
    entity_type: "lead",
    field_key: "colour",
    revision_id: "fieldrev_field_one_1",
    version: 1,
    prior_revision_id: null,
    action: "create",
    label: "Colour",
    position: 0,
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
      id: "appu_owner",
      authority_ref: "app:appu_owner",
    },
    command_fingerprint: "a".repeat(64),
    effective_at: "2026-08-27T10:00:00.000Z",
    created_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function schemaFieldInput(field: SchemaField, overrides: Partial<SchemaFieldWriteInput> = {}) {
  return {
    entity_type: field.entity_type,
    field_key: field.field_key,
    label: field.label,
    position: field.position,
    field_type: field.field_type,
    validator_key: field.validator_key,
    validator_config: field.validator_config,
    visibility_key: field.visibility_key,
    visibility_config: field.visibility_config,
    evidence_class: field.evidence_class,
    retention_policy: field.retention_policy,
    offline_mode: field.offline_mode,
    read_scope: field.read_scope,
    write_scope: field.write_scope,
    read_roles: field.read_roles,
    write_roles: field.write_roles,
    active: field.active,
    ...overrides,
  } satisfies SchemaFieldWriteInput;
}

function fieldsResponse(fields: SchemaField[] = []): SchemaFieldListResponse {
  return {
    version: 1,
    catalog: {
      roles: ["owner", "ops", "sales"],
      field_types: ["text", "integer"],
      validators: ["none", "options", "range"],
      visibility_rules: ["always", "when_field_present"],
      evidence_classes: ["none", "source"],
      retention_policies: ["standard", "extended"],
      offline_modes: ["online_only", "offline_read"],
      scopes: ["all", "assigned"],
    },
    fields,
  };
}

function automationResponse(
  pipelines: AdminPipeline[],
  overrides: Partial<AutomationListResponse["catalog"]> = {},
): AutomationListResponse {
  return {
    version: 1,
    pipeline_id: pipelines[0]!.pipeline_id,
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
      ...overrides,
    },
  };
}

describe("owner configuration route and state matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOnline(true);
  });

  it("keeps the hub and every configuration page owner-only for direct navigation", () => {
    for (const Page of [
      ConfigurationPage,
      PipelineConfigurationPage,
      SchemaFieldsConfigurationPage,
      AutomationConfigurationPage,
    ]) {
      const { unmount } = renderWithSession(<Page />, sessionFor("ops"));
      expect(screen.getByText("This work belongs to another role")).toBeVisible();
      unmount();
    }
    renderWithSession(<ConfigurationPage />, sessionFor("owner"));
    expect(screen.getByText("Configuration areas")).toBeVisible();
  });

  it("renders loading, empty, server error, and offline pipeline states", async () => {
    let resolve: ((value: AdminPipelineListResponse) => void) | undefined;
    vi.mocked(loadAdminPipelines).mockImplementationOnce(
      () =>
        new Promise<AdminPipelineListResponse>((complete) => {
          resolve = complete;
        }),
    );
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    expect(screen.getByText("Loading pipelines…")).toBeVisible();
    resolve?.(pipelineResponse([]));
    expect(await screen.findByText("No pipelines yet")).toBeVisible();

    vi.mocked(loadAdminPipelines).mockRejectedValueOnce(
      new Error("server phrase must stay hidden"),
    );
    const { unmount } = renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    expect(await screen.findByText("Pipelines could not load")).toBeVisible();
    expect(screen.queryByText("server phrase must stay hidden")).toBeNull();
    unmount();

    setOnline(false);
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    expect(screen.getByText(/not available offline yet/)).toBeVisible();
    expect(loadAdminPipelines).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard and touch-equivalent pipeline reorder controls and refreshes after success", async () => {
    const first = pipeline("pipeline_first", "First", 0);
    const second = pipeline("pipeline_second", "Second", 1);
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([first, second]));
    vi.mocked(reorderAdminPipelines).mockResolvedValue({ pipelines: [second, first] });
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    const moveSecondUp = await screen.findByRole("button", { name: "Move Second up" });
    expect(moveSecondUp.className).toContain("min-h-11");
    expect(document.querySelectorAll(".flex-wrap").length).toBeGreaterThan(0);
    await user.click(moveSecondUp);
    await waitFor(() => expect(reorderAdminPipelines).toHaveBeenCalledOnce());
    expect(vi.mocked(reorderAdminPipelines).mock.calls[0]?.[1]).toEqual([
      { pipeline_id: "pipeline_second", expected_version: 2 },
      { pipeline_id: "pipeline_first", expected_version: 2 },
    ]);
    await waitFor(() => expect(loadAdminPipelines).toHaveBeenCalledTimes(2));
  });

  it("turns a stale pipeline save into safe conflict copy with a reload path", async () => {
    vi.mocked(loadAdminPipelines).mockResolvedValue(
      pipelineResponse([pipeline("pipeline_one", "One", 0)]),
    );
    vi.mocked(updateAdminPipeline).mockRejectedValue(
      new ApiError({ status: 409, code: "pipeline_version_conflict", message: "raw conflict" }),
    );
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("New name");
    await user.clear(name);
    await user.type(name, "New name");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText(/changed in another session/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(screen.queryByText("raw conflict")).toBeNull();
  });

  it("closes a rename draft when a pipeline refetch changes its server version", async () => {
    const before = pipeline("pipeline_one", "Server old", 0, { version: 2 });
    const after = pipeline("pipeline_one", "Server new", 0, { version: 3 });
    vi.mocked(loadAdminPipelines)
      .mockResolvedValueOnce(pipelineResponse([before]))
      .mockResolvedValueOnce(pipelineResponse([after]));
    vi.mocked(updateAdminPipelineRoles).mockResolvedValue({ pipeline: after });
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("New name");
    await user.clear(name);
    await user.type(name, "Stale local draft");

    await user.click(screen.getByRole("button", { name: "Save role access" }));
    await waitFor(() => expect(loadAdminPipelines).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Server new")).toBeVisible();
    expect(screen.queryByLabelText("New name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save name" })).toBeNull();
    expect(updateAdminPipeline).not.toHaveBeenCalled();
  });

  it("keeps rename success status after a versioned pipeline refetch", async () => {
    const before = pipeline("pipeline_one", "Server old", 0, { version: 2 });
    const after = pipeline("pipeline_one", "Saved name", 0, { version: 3 });
    vi.mocked(loadAdminPipelines)
      .mockResolvedValueOnce(pipelineResponse([before]))
      .mockResolvedValueOnce(pipelineResponse([after]));
    vi.mocked(updateAdminPipeline).mockResolvedValue({ pipeline: after });
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("New name");
    await user.clear(name);
    await user.type(name, "Saved name");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(loadAdminPipelines).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Saved name")).toBeVisible();
    expect(screen.getByText("The latest server version is now live.")).toBeVisible();
  });

  it("keeps precise role success status after a versioned refetch", async () => {
    const before = pipeline("pipeline_one", "One", 0, { version: 2 });
    const after = pipeline("pipeline_one", "One", 0, { version: 3 });
    vi.mocked(loadAdminPipelines)
      .mockResolvedValueOnce(pipelineResponse([before]))
      .mockResolvedValueOnce(pipelineResponse([after]));
    vi.mocked(updateAdminPipelineRoles).mockResolvedValue({ pipeline: after });
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Save role access" }));

    await waitFor(() => expect(updateAdminPipelineRoles).toHaveBeenCalledOnce());
    expect(vi.mocked(updateAdminPipelineRoles).mock.calls[0]?.[2]).toBe(2);
    await waitFor(() => expect(loadAdminPipelines).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("The selected roles now use this board.")).toHaveLength(1);
    expect(screen.queryByText("The latest server version is now live.")).toBeNull();
  });

  it("keeps precise stage success after a versioned refetch and clears it on failure", async () => {
    const before = pipeline("pipeline_one", "One", 0, {
      version: 2,
      stages: [
        stage("stage_first", 0, { name: "First" }),
        stage("stage_second", 1, { name: "Second" }),
      ],
    });
    const after = pipeline("pipeline_one", "One", 0, {
      version: 3,
      stages: [
        stage("stage_second", 0, { name: "Second" }),
        stage("stage_first", 1, { name: "First" }),
      ],
    });
    vi.mocked(loadAdminPipelines)
      .mockResolvedValueOnce(pipelineResponse([before]))
      .mockResolvedValueOnce(pipelineResponse([after]));
    vi.mocked(reorderAdminPipelineStages).mockResolvedValue({
      pipeline: after,
      stages: after.stages,
    });
    vi.mocked(updateAdminPipeline).mockRejectedValue(
      new ApiError({ status: 409, code: "pipeline_version_conflict", message: "raw conflict" }),
    );
    const user = userEvent.setup();
    renderWithSession(<PipelineConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Move Second up" }));
    await waitFor(() => expect(reorderAdminPipelineStages).toHaveBeenCalledOnce());
    expect(vi.mocked(reorderAdminPipelineStages).mock.calls[0]?.[2]).toBe(2);
    await waitFor(() => expect(loadAdminPipelines).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("The visible controls now match the server order.")).toHaveLength(1);
    expect(screen.queryByText("The latest server version is now live.")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("New name");
    await user.clear(name);
    await user.type(name, "A failed later save");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText(/changed in another session/)).toBeVisible();
    expect(screen.queryByText("The visible controls now match the server order.")).toBeNull();
  });

  it("keeps field configuration read-only offline and exposes bounded catalog controls online", async () => {
    setOnline(false);
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));
    expect(screen.getByText(/field configuration is not available offline yet/i)).toBeVisible();
    expect(loadSchemaFields).not.toHaveBeenCalled();

    setOnline(true);
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse());
    vi.mocked(loadAdminPipelines).mockResolvedValue(
      pipelineResponse(
        [],
        [
          { entity_type: "lead", label: "Lead" },
          { entity_type: "job", label: "Job" },
        ],
      ),
    );
    const { unmount } = renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));
    expect(await screen.findByText("Field definitions")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "New field" }));
    expect(screen.getByLabelText("Field type")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Entity type" })).toBeNull();
    const entitySelects = screen.getAllByRole("combobox", { name: "Entity type" });
    const entitySelect = entitySelects[0]!;
    expect([...entitySelect.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "lead",
      "job",
    ]);
    expect(screen.getByLabelText("Validator")).toBeVisible();
    expect(screen.queryByLabelText("Validator configuration")).toBeNull();
    unmount();
  });

  it("keeps fields readable while an entity catalog failure disables field changes", async () => {
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse([schemaField()]));
    vi.mocked(loadAdminPipelines).mockRejectedValue(new Error("raw catalog failure"));
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));
    expect(await screen.findByText("Field definitions")).toBeVisible();
    expect(screen.getByText("Entity type catalog unavailable")).toBeVisible();
    expect(screen.getByText("Colour")).toBeVisible();
    expect(screen.getByRole("button", { name: "New field" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revise" })).toBeDisabled();
    expect(screen.queryByText("raw catalog failure")).toBeNull();
  });

  it("reads field definitions in position order whatever order the server sends them in", () => {
    const colour = schemaField({ field_id: "field_colour", field_key: "colour", position: 2 });
    const material = schemaField({
      field_id: "field_material",
      field_key: "material",
      position: 0,
    });
    const quantity = schemaField({
      field_id: "field_quantity",
      field_key: "quantity",
      position: 1,
    });
    const job = schemaField({
      field_id: "field_job_note",
      field_key: "note",
      entity_type: "job",
      position: 0,
    });
    expect(
      sortSchemaFields([colour, job, material, quantity]).map((field) => field.field_key),
    ).toEqual(["note", "material", "quantity", "colour"]);
    // Equal positions fall back to the field key, exactly as the list query does.
    const tie = schemaField({ field_id: "field_alpha", field_key: "alpha", position: 0 });
    expect(sortSchemaFields([material, tie]).map((field) => field.field_key)).toEqual([
      "alpha",
      "material",
    ]);
  });

  it("plans a field move as one revision per definition that really changes place", () => {
    const material = schemaField({
      field_id: "field_material",
      field_key: "material",
      position: 0,
    });
    const quantity = schemaField({
      field_id: "field_quantity",
      field_key: "quantity",
      position: 1,
    });
    const colour = schemaField({ field_id: "field_colour", field_key: "colour", position: 2 });
    const visible = [material, quantity, colour];
    expect(
      planSchemaFieldReorder(visible, 2, 1).map((placement) => [
        placement.field.field_id,
        placement.position,
      ]),
    ).toEqual([
      ["field_colour", 1],
      ["field_quantity", 2],
    ]);
    // A move off either end, or across an entity boundary, is not a move.
    expect(planSchemaFieldReorder(visible, 0, -1)).toEqual([]);
    expect(planSchemaFieldReorder(visible, 2, 3)).toEqual([]);
    const job = schemaField({ field_id: "field_job", field_key: "note", entity_type: "job" });
    expect(planSchemaFieldReorder([colour, job], 1, 0)).toEqual([]);
    // Definitions the server left sharing a position still move: the plan forces the
    // reused slots strictly ascending, so the one that has to give way is the only one
    // revised and the pair stops being a tie the sort has to guess at.
    const flatA = schemaField({ field_id: "field_a", field_key: "a", position: 0 });
    const flatB = schemaField({ field_id: "field_b", field_key: "b", position: 0 });
    expect(
      planSchemaFieldReorder([flatA, flatB], 1, 0).map((placement) => [
        placement.field.field_id,
        placement.position,
      ]),
    ).toEqual([["field_a", 1]]);
  });

  it("supports keyboard and touch-equivalent field reorder controls and refreshes after success", async () => {
    const material = schemaField({
      field_id: "field_material",
      field_key: "material",
      label: "Material",
      position: 0,
    });
    const quantity = schemaField({
      field_id: "field_quantity",
      field_key: "quantity",
      label: "Quantity",
      position: 1,
    });
    const colour = schemaField({
      field_id: "field_colour",
      field_key: "colour",
      label: "Colour",
      position: 2,
    });
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse([colour, material, quantity]));
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([]));
    vi.mocked(reviseSchemaField).mockImplementation((_session, _fieldId, input) =>
      Promise.resolve({ outcome: "revised", field: { ...colour, ...input } as SchemaField }),
    );
    const user = userEvent.setup();
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));

    const moveColourUp = await screen.findByRole("button", { name: "Move Colour up" });
    expect(moveColourUp.className).toContain("min-h-11");
    expect(
      screen
        .getAllByRole("button", { name: /^Move .+ up$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Move Material up", "Move Quantity up", "Move Colour up"]);
    // The ends of the list cannot be moved past.
    expect(screen.getByRole("button", { name: "Move Material up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Colour down" })).toBeDisabled();

    await user.click(moveColourUp);
    await waitFor(() => expect(reviseSchemaField).toHaveBeenCalledTimes(2));
    expect(vi.mocked(reviseSchemaField).mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [
        "field_colour",
        expect.objectContaining({ action: "reorder", position: 1, expected_version: 1 }),
      ],
      [
        "field_quantity",
        expect.objectContaining({ action: "reorder", position: 2, expected_version: 1 }),
      ],
    ]);
    expect(await screen.findByText("Field order saved")).toBeVisible();
    await waitFor(() => expect(loadSchemaFields).toHaveBeenCalledTimes(2));
  });

  it("keeps a refused field move visible instead of showing an order the server rejected", async () => {
    const material = schemaField({
      field_id: "field_material",
      field_key: "material",
      label: "Material",
      position: 0,
    });
    const colour = schemaField({
      field_id: "field_colour",
      field_key: "colour",
      label: "Colour",
      position: 1,
    });
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse([material, colour]));
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([]));
    vi.mocked(reviseSchemaField).mockRejectedValue(
      new ApiError({ status: 409, code: "schema_field_version_conflict", message: "raw conflict" }),
    );
    const user = userEvent.setup();
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Move Colour up" }));
    expect(await screen.findByText("Field order was not saved")).toBeVisible();
    expect(screen.queryByText("Field order saved")).toBeNull();
    expect(screen.queryByText("raw conflict")).toBeNull();
  });

  it("creates a new field after the last one of its entity type without asking for a number", async () => {
    const colour = schemaField({ field_id: "field_colour", field_key: "colour", position: 4 });
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse([colour]));
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([]));
    vi.mocked(createSchemaField).mockResolvedValue({
      outcome: "created",
      field: schemaField({ field_id: "field_size", field_key: "size", label: "Size" }),
    });
    const user = userEvent.setup();
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New field" }));
    expect(screen.queryByLabelText("Position")).toBeNull();
    await user.type(screen.getByLabelText("Field key"), "size");
    await user.type(screen.getByLabelText("Label", { exact: true }), "Size");
    await user.click(screen.getByRole("button", { name: "Save field definition" }));

    await waitFor(() => expect(createSchemaField).toHaveBeenCalledOnce());
    expect(vi.mocked(createSchemaField).mock.calls[0]?.[1]).toMatchObject({
      field_key: "size",
      position: 5,
    });
  });

  it("derives strict field revision actions and rejects no-op revisions", () => {
    const current = schemaField();
    const unchanged = schemaFieldInput(current);
    expect(deriveSchemaFieldAction(current, unchanged)).toBeNull();
    expect(
      deriveSchemaFieldAction(current, schemaFieldInput(current, { label: "New label" })),
    ).toBe("relabel");
    expect(deriveSchemaFieldAction(current, schemaFieldInput(current, { position: 2 }))).toBe(
      "reorder",
    );
    expect(
      deriveSchemaFieldAction(current, schemaFieldInput(current, { label: "New", position: 2 })),
    ).toBe("revise");
    expect(
      deriveSchemaFieldAction(current, schemaFieldInput(current, { validator_key: "required" })),
    ).toBe("revise");
  });

  it("uses derived field actions in the revision payload and blocks a no-op", async () => {
    const current = schemaField();
    vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse([current]));
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([]));
    vi.mocked(reviseSchemaField).mockResolvedValue({
      outcome: "revised",
      field: current,
    });
    const user = userEvent.setup();
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "Revise" }));
    await user.click(screen.getByRole("button", { name: "Save field definition" }));
    expect(await screen.findByText(/No changes to save/)).toBeVisible();
    expect(reviseSchemaField).not.toHaveBeenCalled();

    const label = screen.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "Updated colour");
    await user.click(screen.getByRole("button", { name: "Save field definition" }));
    await waitFor(() => expect(reviseSchemaField).toHaveBeenCalledOnce());
    expect(vi.mocked(reviseSchemaField).mock.calls[0]?.[2]).toMatchObject({
      action: "relabel",
      expected_version: 1,
      label: "Updated colour",
    });
  });

  it("refreshes field history when a refetch moves the field to a newer revision", async () => {
    const before = schemaField();
    const after = schemaField({
      version: 2,
      revision_id: "fieldrev_field_one_2",
      label: "Colour updated",
    });
    vi.mocked(loadSchemaFields)
      .mockResolvedValueOnce(fieldsResponse([before]))
      .mockResolvedValueOnce(fieldsResponse([after]));
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse([]));
    vi.mocked(loadSchemaFieldHistory)
      .mockResolvedValueOnce({
        field_id: before.field_id,
        current_revision_id: before.revision_id,
        current_version: before.version,
        revisions: [before],
      })
      .mockResolvedValueOnce({
        field_id: after.field_id,
        current_revision_id: after.revision_id,
        current_version: after.version,
        revisions: [after, before],
      });
    vi.mocked(createSchemaField).mockResolvedValue({
      outcome: "created",
      field: schemaField({ field_id: "field_two", field_key: "size", label: "Size" }),
    });

    const user = userEvent.setup();
    renderWithSession(<SchemaFieldsConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText(/Current revision 1/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New field" }));
    await user.type(screen.getByLabelText("Field key"), "size");
    await user.type(screen.getByLabelText("Label"), "Size");
    await user.click(screen.getByRole("button", { name: "Save field definition" }));

    await waitFor(() => expect(createSchemaField).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Current revision 2/)).toBeVisible();
    expect(vi.mocked(loadSchemaFieldHistory)).toHaveBeenCalledTimes(2);
  });

  it("uses a visible neutral swatch for non-CSS semantic stage colors", () => {
    expect(stageSwatchPresentation("slate")).toMatchObject({
      className: expect.stringContaining("bg-surface-muted"),
    });
    expect(stageSwatchPresentation("#abc")).toMatchObject({
      style: { backgroundColor: "#abc" },
    });
  });

  it("renders distinct unavailable automation provider state and only server catalog choices", async () => {
    const pipelines = [pipeline("pipeline_one", "One", 0)];
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse(pipelines));
    vi.mocked(loadAutomationRules).mockResolvedValue(
      automationResponse(pipelines, { recipient_configured: false, recipient_refs: [] }),
    );
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));
    expect(await screen.findByText("Recipient configuration unavailable")).toBeVisible();
    expect(screen.getByText(/no raw email address can be entered/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "New rule" })).toBeDisabled();
  });

  it("refreshes automation rules after a successful governed create", async () => {
    const pipelines = [pipeline("pipeline_one", "One", 0)];
    const data = automationResponse(pipelines);
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse(pipelines));
    vi.mocked(loadAutomationRules).mockResolvedValue(data);
    vi.mocked(createAutomationRule).mockResolvedValue({
      rule: undefined as never,
      catalog: data.catalog,
    });
    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(createAutomationRule).toHaveBeenCalledOnce());
    expect(screen.getByText("Create an automation")).toBeVisible();
    await waitFor(() => expect(loadAutomationRules).toHaveBeenCalledTimes(2));
  });

  it("refreshes automation history when a refetch moves the rule to a newer revision", async () => {
    const pipelines = [pipeline("pipeline_one", "One", 0)];
    const beforeRule = {
      rule_id: "rule_one",
      tenant_id: "freshco",
      pipeline_id: "pipeline_one",
      to_stage_id: "pipeline_one_stage_a",
      revision_id: "automationrev_one_1",
      version: 1,
      prior_revision_id: null,
      action: "operations.email.send",
      recipient_ref: "owner",
      template_key: "pipeline.stage-change-summary",
      template_version: 1 as const,
      active: 1 as const,
      actor_role: "owner",
      actor_id: "appu_owner",
      created_at: "2026-08-27T10:00:00.000Z",
    };
    const afterRule = { ...beforeRule, version: 2, revision_id: "automationrev_one_2" };
    vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineResponse(pipelines));
    vi.mocked(loadAutomationRules)
      .mockResolvedValueOnce({ ...automationResponse(pipelines), rules: [beforeRule] })
      .mockResolvedValueOnce({ ...automationResponse(pipelines), rules: [afterRule] });
    vi.mocked(loadAutomationHistory)
      .mockResolvedValueOnce({
        version: 1,
        pipeline_id: beforeRule.pipeline_id,
        rule_id: beforeRule.rule_id,
        current_revision_id: beforeRule.revision_id,
        current_version: beforeRule.version,
        revisions: [beforeRule],
      })
      .mockResolvedValueOnce({
        version: 1,
        pipeline_id: afterRule.pipeline_id,
        rule_id: afterRule.rule_id,
        current_revision_id: afterRule.revision_id,
        current_version: afterRule.version,
        revisions: [afterRule, beforeRule],
      });
    vi.mocked(createAutomationRule).mockResolvedValue({
      rule: afterRule,
      catalog: automationResponse(pipelines).catalog,
    });

    const user = userEvent.setup();
    renderWithSession(<AutomationConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText(/Current revision 1/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New rule" }));
    await user.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(createAutomationRule).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Current revision 2/)).toBeVisible();
    expect(vi.mocked(loadAutomationHistory)).toHaveBeenCalledTimes(2);
  });
});
