import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { ApiError } from "../lib/api";
import {
  addAdminPipelineStage,
  configurationErrorMessage,
  createAutomationRule,
  createAdminPipeline,
  createSchemaField,
  copyAdminPipeline,
  loadAdminPipelines,
  loadAutomationHistory,
  loadSchemaFieldHistory,
  removeAdminPipelineStage,
  reorderAdminPipelines,
  reorderAdminPipelineStages,
  reviseAutomationRule,
  reviseSchemaField,
  updateAdminPipeline,
  updateAdminPipelineRoles,
  updateAdminPipelineStage,
} from "./configuration-api";

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@freshco.example",
    display_name: "Ada Owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "freshco",
    name: "FreshCo Exteriors",
    brand: "FreshCo",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["now:read"],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2036-08-22T00:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-22T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function stage(stageId = "stage:one") {
  return {
    stage_id: stageId,
    key: "one",
    name: "One",
    color: null,
    position: 0,
    is_won: false,
    is_lost: false,
    min_role_to_enter: null,
    is_active: true,
    card_count: 0,
    updated_at: "2026-08-22T12:00:00.000Z",
  };
}

function pipeline() {
  return {
    pipeline_id: "pipeline:one",
    key: "one",
    name: "One",
    entity_type: "lead",
    owning_role: "sales",
    is_active: true,
    is_template: false,
    template_source_id: null,
    position: 0,
    version: 1,
    card_count: 0,
    card_template: { version: 1, slots: [{ slot: "title", sources: ["entity.contact_name"] }] },
    stages: [stage()],
    role_grants: [],
    updated_at: "2026-08-22T12:00:00.000Z",
  };
}

function adminList() {
  return {
    version: 1,
    entity_types: [{ entity_type: "lead", label: "Lead" }],
    roles: ["owner", "ops", "sales"],
    stage_limit: 200,
    pipelines: [pipeline()],
  };
}

function field() {
  return {
    field_id: "field:one",
    entity_type: "lead",
    field_key: "colour",
    revision_id: "fieldrev:field:one:1",
    version: 1,
    prior_revision_id: null,
    action: "create" as const,
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
    actor: { type: "owner", role: "owner", id: "appu_owner", authority_ref: "app:appu_owner" },
    command_fingerprint: "a".repeat(64),
    effective_at: "2026-08-22T12:00:00.000Z",
    created_at: "2026-08-22T12:00:00.000Z",
  };
}

function automationRule() {
  return {
    rule_id: "rule:one",
    tenant_id: "freshco",
    pipeline_id: "pipeline:one",
    to_stage_id: "stage:one",
    revision_id: "automationrev:one:1",
    version: 1,
    prior_revision_id: null,
    action: "operations.email.send",
    recipient_ref: "owner",
    template_key: "pipeline.stage-change-summary",
    template_version: 1 as const,
    active: 1,
    actor_role: "owner",
    actor_id: "appu_owner",
    created_at: "2026-08-22T12:00:00.000Z",
  };
}

const catalog = {
  actions: [{ action: "operations.email.send", label: "Stage-change email" }],
  templates: [
    { template_key: "pipeline.stage-change-summary", version: 1 as const, label: "Summary" },
  ],
  recipient_refs: ["owner"],
  recipient_configured: true,
};

describe("configuration API contracts", () => {
  it("reads the owner pipeline projector and rejects malformed responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(adminList()));
    const response = await loadAdminPipelines(fetcher);

    expect(response.pipelines[0]?.pipeline_id).toBe("pipeline:one");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/pipelines",
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );

    fetcher.mockResolvedValueOnce(Response.json({ version: 1, pipelines: [] }));
    await expect(loadAdminPipelines(fetcher)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends complete pipeline order, CSRF, and a unique mutation key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ pipelines: [pipeline()] }));
    await reorderAdminPipelines(
      session,
      [{ pipeline_id: "pipeline:one", expected_version: 1 }],
      fetcher,
    );

    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/admin/pipelines/order");
    expect(JSON.parse(String(init?.body))).toEqual({
      pipelines: [{ pipeline_id: "pipeline:one", expected_version: 1 }],
    });
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(
      /^configuration:pipeline-order:/,
    );
  });

  it("uses the exact pipeline mutation paths and CAS bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (String(_path).endsWith("/stages"))
        return Response.json({ pipeline: pipeline(), stage: stage("stage:two") });
      if (String(_path).includes("/stages/stage%3Aone"))
        return Response.json({ pipeline: pipeline(), stage: stage() });
      if (Array.isArray(body.grants)) return Response.json({ pipeline: pipeline() });
      return Response.json({ pipeline: pipeline() });
    });
    await createAdminPipeline(
      session,
      {
        key: "one",
        name: "One",
        entity_type: "lead",
        owning_role: "owner",
        card_template: { version: 1, slots: [] },
        stages: [{ key: "one", name: "One" }],
      },
      fetcher,
    );
    await updateAdminPipeline(session, "pipeline:one", 1, { name: "Renamed" }, fetcher);
    await copyAdminPipeline(session, "pipeline:one", { key: "two", name: "Two" }, fetcher);
    await updateAdminPipelineRoles(
      session,
      "pipeline:one",
      2,
      [{ role: "ops", can_write: true }],
      fetcher,
    );
    await addAdminPipelineStage(session, "pipeline:one", 3, { key: "two", name: "Two" }, fetcher);
    await updateAdminPipelineStage(
      session,
      "pipeline:one",
      "stage:one",
      4,
      { name: "Updated", color: null, is_won: false, is_lost: false, min_role_to_enter: null },
      fetcher,
    );
    await reorderAdminPipelineStages(session, "pipeline:one", 5, ["stage:one"], fetcher);

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/pipelines",
      "/api/v1/admin/pipelines/pipeline%3Aone",
      "/api/v1/admin/pipelines/pipeline%3Aone/copy",
      "/api/v1/admin/pipelines/pipeline%3Aone/roles",
      "/api/v1/admin/pipelines/pipeline%3Aone/stages",
      "/api/v1/admin/pipelines/pipeline%3Aone/stages/stage%3Aone",
      "/api/v1/admin/pipelines/pipeline%3Aone/stages/order",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      name: "Renamed",
      expected_version: 1,
    });
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toEqual({
      name: "Updated",
      color: null,
      is_won: false,
      is_lost: false,
      min_role_to_enter: null,
      expected_version: 4,
    });
    expect(JSON.parse(String(fetcher.mock.calls[6]?.[1]?.body))).toEqual({
      expected_version: 5,
      stage_ids: ["stage:one"],
    });
  });

  it("uses encoded stage paths and the safe move-then-remove body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ pipeline: pipeline(), stages: [], outcome: "archived", moved_cards: 2 }),
      );
    await removeAdminPipelineStage(session, "pipeline:one", "stage:one", 4, "stage:two", fetcher);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/admin/pipelines/pipeline%3Aone/stages/stage%3Aone/remove");
    expect(JSON.parse(String(init?.body))).toEqual({
      expected_version: 4,
      move_cards_to_stage_id: "stage:two",
    });
  });

  it("keeps schema-field configuration bounded and appends the owner action", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ outcome: "created", field: field() }, { status: 201 }));
    await createSchemaField(
      session,
      {
        entity_type: "lead",
        field_key: "colour",
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
      },
      fetcher,
    );
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/admin/schema-fields");
    expect(JSON.parse(String(init?.body))).toMatchObject({ entity_type: "lead", action: "create" });
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf");
  });

  it("resends the complete current field definition for CAS revisions and history", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (String(path).endsWith("/revisions"))
        return Response.json({
          field_id: "field:one",
          current_revision_id: field().revision_id,
          current_version: 1,
          revisions: [field()],
        });
      return Response.json({ outcome: "revised", field: field() });
    });
    const current = field();
    await reviseSchemaField(
      session,
      "field:one",
      {
        entity_type: current.entity_type,
        field_key: current.field_key,
        label: "Updated colour",
        position: current.position,
        field_type: current.field_type,
        validator_key: current.validator_key,
        validator_config: current.validator_config,
        visibility_key: current.visibility_key,
        visibility_config: current.visibility_config,
        evidence_class: current.evidence_class,
        retention_policy: current.retention_policy,
        offline_mode: current.offline_mode,
        read_scope: current.read_scope,
        write_scope: current.write_scope,
        read_roles: current.read_roles,
        write_roles: current.write_roles,
        active: true,
        action: "revise",
        expected_version: 1,
      },
      fetcher,
    );
    await loadSchemaFieldHistory("field:one", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/admin/schema-fields/field%3Aone");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "revise",
      expected_version: 1,
      label: "Updated colour",
      field_type: "text",
      read_roles: ["owner"],
      write_roles: ["owner"],
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/admin/schema-fields/field%3Aone/revisions");
  });

  it("uses only the automation history route for immutable revisions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        pipeline_id: "pipeline:one",
        rule_id: "rule:one",
        current_revision_id: "automationrev:one:1",
        current_version: 1,
        revisions: [automationRule()],
      }),
    );
    const response = await loadAutomationHistory("pipeline:one", "rule:one", fetcher);
    expect(response.revisions).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/pipelines/pipeline%3Aone/automation-rules/rule%3Aone/revisions",
      expect.objectContaining({ method: "GET" }),
    );

    fetcher.mockResolvedValueOnce(Response.json({ rule: automationRule(), catalog }));
    await createAutomationRule(
      session,
      "pipeline:one",
      {
        to_stage_id: "stage:one",
        action: "operations.email.send",
        recipient_ref: "owner",
        template_key: "pipeline.stage-change-summary",
        template_version: 1,
        active: true,
      },
      fetcher,
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/pipelines/pipeline%3Aone/automation-rules",
    );
  });

  it("sends automation revisions with the expected version and closed-catalog values", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ rule: automationRule(), catalog }));
    await reviseAutomationRule(
      session,
      "pipeline:one",
      "rule:one",
      {
        to_stage_id: "stage:one",
        action: "operations.email.send",
        recipient_ref: "owner",
        template_key: "pipeline.stage-change-summary",
        template_version: 1,
        active: false,
        expected_version: 1,
      },
      fetcher,
    );
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe(
      "/api/v1/admin/pipelines/pipeline%3Aone/automation-rules/rule%3Aone/revisions",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      to_stage_id: "stage:one",
      action: "operations.email.send",
      recipient_ref: "owner",
      template_key: "pipeline.stage-change-summary",
      template_version: 1,
      active: false,
      expected_version: 1,
    });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(
      /^configuration:automation-revise:/,
    );
  });

  it("maps uncurated transport failures to safe copy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "automation_recipient_config_malformed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createAutomationRule(
        session,
        "pipeline:one",
        {
          to_stage_id: "stage:one",
          action: "operations.email.send",
          recipient_ref: "owner",
          template_key: "pipeline.stage-change-summary",
          template_version: 1,
          active: true,
        },
        fetcher,
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(
      configurationErrorMessage(
        new ApiError({
          status: 400,
          code: "automation_recipient_config_unavailable",
          message: "raw",
        }),
      ),
    ).toContain("unavailable");
    expect(
      configurationErrorMessage(
        new ApiError({
          status: 400,
          code: "automation_recipient_config_malformed",
          message: "raw",
        }),
      ),
    ).toContain("could not be read safely");
    expect(
      configurationErrorMessage(
        new ApiError({ status: 400, code: "automation_recipient_ref_unknown", message: "raw" }),
      ),
    ).toContain("no longer configured");
  });
});
