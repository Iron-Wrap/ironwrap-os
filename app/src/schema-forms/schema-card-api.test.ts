import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { resetDatabaseForTests } from "../storage/db";
import { getOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import {
  loadSchemaCard,
  pendingSchemaCardWrites,
  queueSchemaCardValue,
  schemaCardPath,
  writeSchemaCardValue,
} from "./schema-card-api";
import type { SchemaCardResponse, SchemaCardWriteCommand } from "./schema-card-contracts";

function sessionFor(role: "field" | "owner", userId: string): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: userId,
      email: `${userId}@example.com`,
      display_name: "Crew",
      role,
      frappe_user_id: null,
    },
    tenant: {
      id: "ironwrap",
      name: "IronWrap OS",
      brand: "IronWrap",
      locale: "en-CA",
      time_zone: "America/Edmonton",
      currency: "CAD",
    },
    permissions: [],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-07-11T10:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-27T10:00:00.000Z",
    stale_fields: [],
  } satisfies AuthenticatedSession;
}

const crew = sessionFor("field", "appu_crew");

/** Index into a result the assertion is about to describe, failing loudly if it is not there. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an entry at index ${index}`);
  return item;
}

function card(fieldKeys: string[]): SchemaCardResponse {
  return {
    entity_type: "job",
    entity_id: "JOB-1",
    fields: fieldKeys.map((key, index) => ({
      definition: {
        field_id: `fld_${key}`,
        field_key: key,
        revision_id: "rev_1",
        version: 1,
        label: key,
        position: index,
        field_type: "text",
        validator_key: "none",
        validator_config: {},
        visibility_key: "always",
        visibility_config: {},
        evidence_class: "none",
        retention_policy: "standard",
        offline_mode: "offline_read",
      },
      value: {
        value_revision_id: `val_${key}`,
        field_definition_revision_id: "rev_1",
        version: 1,
        prior_value_revision_id: null,
        based_on_value_revision_id: null,
        correction_reason: null,
        value: `${key}-value`,
        value_digest: "digest",
        provenance_actor_type: "owner",
        created_at: "2026-08-27T18:00:00.000Z",
      },
    })),
  } as SchemaCardResponse;
}

const offlineFetcher = () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));

const onlineDescriptor = Object.getOwnPropertyDescriptor(
  window.Navigator.prototype,
  "onLine",
) as PropertyDescriptor;

/** A crew phone with no signal, and the same phone once it has some. */
function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

afterEach(() => {
  Object.defineProperty(window.Navigator.prototype, "onLine", onlineDescriptor);
});

describe("reading a record's configured fields", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it("reads the record route for the entity and caches what came back", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(card(["permit_number"])));

    const model = await loadSchemaCard(crew, "job", "JOB-1", fetcher);

    expect(model.offline).toBe(false);
    expect(model.response.fields).toHaveLength(1);
    const requested = at(at(fetcher.mock.calls, 0), 0);
    expect(String(requested)).toContain(schemaCardPath("job", "JOB-1"));
  });

  it("opens a card the crew already loaded once, with the device offline", async () => {
    await loadSchemaCard(
      crew,
      "job",
      "JOB-1",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(card(["permit_number", "site_contact"]))),
    );

    const offline = await loadSchemaCard(crew, "job", "JOB-1", offlineFetcher());

    expect(offline.offline).toBe(true);
    expect(offline.response.fields.map((field) => field.definition.field_key)).toEqual([
      "permit_number",
      "site_contact",
    ]);
  });

  it("refuses to invent an empty card for a record never opened on this device", async () => {
    // An absent field on this surface means "your role may not read this". Rendering zero fields
    // from a cache miss would look like an authority decision that never happened.
    await expect(loadSchemaCard(crew, "job", "NEVER-OPENED", offlineFetcher())).rejects.toThrow();
  });

  it("never serves one user's authorized card to another on a shared device", async () => {
    await loadSchemaCard(
      crew,
      "job",
      "JOB-1",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(card(["margin_band"]))),
    );

    const otherUser = sessionFor("field", "appu_second_crew");
    await expect(loadSchemaCard(otherUser, "job", "JOB-1", offlineFetcher())).rejects.toThrow();
  });

  it("raises a refusal rather than falling back to cache when the server answers", async () => {
    await loadSchemaCard(
      crew,
      "job",
      "JOB-1",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(card(["permit_number"]))),
    );

    const forbidden = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 }));

    await expect(loadSchemaCard(crew, "job", "JOB-1", forbidden)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("presents the crew device proof the field routes require", async () => {
    await storeDeviceSecret("p".repeat(43));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(card(["permit_number"])));

    await loadSchemaCard(crew, "job", "JOB-1", fetcher);

    const headers = (at(at(fetcher.mock.calls, 0), 1) as RequestInit).headers as Headers;
    expect(headers.get("X-IronWrap-Device-Proof")).toBe("p".repeat(43));
  });

  it("does not present a crew device proof for an office role", async () => {
    await storeDeviceSecret("p".repeat(43));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(card(["permit_number"])));

    await loadSchemaCard(sessionFor("owner", "appu_owner"), "job", "JOB-1", fetcher);

    const headers = (at(at(fetcher.mock.calls, 0), 1) as RequestInit).headers as Headers;
    expect(headers.get("X-IronWrap-Device-Proof")).toBeNull();
  });
});

function writeCommand(overrides: Partial<SchemaCardWriteCommand> = {}): SchemaCardWriteCommand {
  return {
    entityType: "job",
    entityId: "JOB-1",
    fieldId: "fld_permit_number",
    fieldDefinitionRevisionId: "rev_permit_number_1",
    expectedVersion: 1,
    value: "CAL-2026-8891",
    ...overrides,
  };
}

const writeAccepted = () =>
  vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        outcome: "created",
        value: {
          value_revision_id: "val_2",
          field_definition_revision_id: "rev_permit_number_1",
          version: 2,
          prior_value_revision_id: "val_1",
          based_on_value_revision_id: null,
          correction_reason: null,
          value: "CAL-2026-8891",
          value_digest: "digest",
          provenance_actor_type: "worker",
          created_at: "2026-08-28T18:00:00.000Z",
        },
      },
      { status: 201 },
    ),
  );

describe("writing a value back to the record", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it("posts the governed command to the field's own write route", async () => {
    const fetcher = writeAccepted();

    const written = await writeSchemaCardValue(crew, writeCommand(), fetcher, "idem-key-0001");

    expect(written.value.version).toBe(2);
    const [path, init] = at(fetcher.mock.calls, 0) as [string, RequestInit];
    expect(path).toBe("/api/v1/schema-fields/job/JOB-1/fld_permit_number/values");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      field_definition_revision_id: "rev_permit_number_1",
      expected_version: 1,
      value: "CAL-2026-8891",
      based_on_value_revision_id: null,
      correction_reason: null,
    });
  });

  it("carries the session's CSRF token and an idempotency key so a retry is not a second value", async () => {
    const fetcher = writeAccepted();

    await writeSchemaCardValue(crew, writeCommand(), fetcher, "idem-key-0001");

    const headers = (at(at(fetcher.mock.calls, 0), 1) as RequestInit).headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf");
    expect(headers.get("Idempotency-Key")).toBe("idem-key-0001");
  });

  it("hands the server's refusal back with its own code and detail intact", async () => {
    const conflicted = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "schema_field_value_version_conflict", expected_version: 1, current_version: 2 },
          { status: 409 },
        ),
      );

    await expect(writeSchemaCardValue(crew, writeCommand(), conflicted)).rejects.toMatchObject({
      status: 409,
      code: "schema_field_value_version_conflict",
      details: { current_version: 2 },
    });
  });

  it("sends a correction with both the value it replaces and the reason", async () => {
    const fetcher = writeAccepted();

    await writeSchemaCardValue(
      crew,
      writeCommand({
        expectedVersion: 2,
        basedOnValueRevisionId: "val_2",
        correctionReason: "Measured again after the tear-off",
      }),
      fetcher,
      "idem-key-0002",
    );

    expect(
      JSON.parse(String((at(at(fetcher.mock.calls, 0), 1) as RequestInit).body)),
    ).toMatchObject({
      expected_version: 2,
      based_on_value_revision_id: "val_2",
      correction_reason: "Measured again after the tear-off",
    });
  });
});

describe("holding a value on the phone until there is signal", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it("queues the same command the online path would have sent", async () => {
    const offline = offlineFetcher();

    const queued = await queueSchemaCardValue(crew, writeCommand(), offline);

    expect(queued.state).toBe("queued");
    expect(queued.kind).toBe("schema_field_value");
    expect(queued.endpoint).toBe("/api/v1/schema-fields/job/JOB-1/fld_permit_number/values");
    expect(queued.payload).toEqual({
      field_definition_revision_id: "rev_permit_number_1",
      expected_version: 1,
      value: "CAL-2026-8891",
      based_on_value_revision_id: null,
      correction_reason: null,
    });
  });

  it("reports what this device is still holding, per field", async () => {
    await queueSchemaCardValue(crew, writeCommand(), offlineFetcher());
    await queueSchemaCardValue(
      crew,
      writeCommand({ fieldId: "fld_gate_code", value: "4821" }),
      offlineFetcher(),
    );

    const pending = await pendingSchemaCardWrites(crew, "job", "JOB-1");

    expect([...pending.keys()].sort()).toEqual(["fld_gate_code", "fld_permit_number"]);
    expect(pending.get("fld_gate_code")?.payload).toMatchObject({ value: "4821" });
  });

  it("does not show one record's queued values on another record's card", async () => {
    await queueSchemaCardValue(crew, writeCommand(), offlineFetcher());

    const other = await pendingSchemaCardWrites(crew, "job", "JOB-2");

    expect(other.size).toBe(0);
  });

  it("refuses to hold a half-formed correction that could never be accepted", async () => {
    await expect(
      queueSchemaCardValue(
        crew,
        writeCommand({ basedOnValueRevisionId: "val_1" }),
        offlineFetcher(),
      ),
    ).rejects.toThrow(/correction/i);
  });
});

describe("a value that waited on the phone reaching the office", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
    // Entered on a roof: nothing may reach the network until the flush below.
    setOnline(false);
  });

  it("sends the queued command unchanged once there is signal, and marks it sent", async () => {
    // Queued with no network at all, then flushed the way a reconnect flushes it.
    const queued = await queueSchemaCardValue(crew, writeCommand(), offlineFetcher());
    expect(queued.attempts).toBe(0);
    const online = writeAccepted();
    setOnline(true);

    const result = await flushOutbox({
      tenantId: crew.tenant.id,
      userId: crew.user.id,
      csrfToken: crew.csrf_token,
      fetcher: online,
    });

    expect(result).toMatchObject({ processed: 1, verified: 1, needsAttention: 0 });
    const [path, init] = at(online.mock.calls, 0) as [string, RequestInit];
    expect(path).toBe("/api/v1/schema-fields/job/JOB-1/fld_permit_number/values");
    expect(JSON.parse(String(init.body))).toEqual({
      field_definition_revision_id: "rev_permit_number_1",
      expected_version: 1,
      value: "CAL-2026-8891",
      based_on_value_revision_id: null,
      correction_reason: null,
    });
    // The device action id is the idempotency key, so a replay after a dropped response resolves
    // to the value the server already stored rather than appending a second one.
    expect((init.headers as Headers).get("Idempotency-Key")).toBe(queued.deviceActionId);

    const settled = await getOutboxAction(queued.deviceActionId);
    expect(settled?.state).toBe("verified");
    expect(settled?.verification?.serverRef).toBe("val_2");
  });

  it("keeps a value whose field moved on, rather than retrying over the office's copy", async () => {
    const queued = await queueSchemaCardValue(crew, writeCommand(), offlineFetcher());
    setOnline(true);
    const conflicted = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "schema_field_value_version_conflict", expected_version: 1, current_version: 2 },
          { status: 409 },
        ),
      );

    const result = await flushOutbox({
      tenantId: crew.tenant.id,
      userId: crew.user.id,
      csrfToken: crew.csrf_token,
      fetcher: conflicted,
    });

    expect(result).toMatchObject({ needsAttention: 1, verified: 0 });
    const settled = await getOutboxAction(queued.deviceActionId);
    expect(settled?.state).toBe("needs_attention");
    expect(settled?.conflict).toMatchObject({
      status: 409,
      code: "schema_field_value_version_conflict",
    });
    // Nothing was discarded and nothing was retried blindly: the saved-work panel routes it to the
    // office, which is the only party that can see both copies.
    expect(settled?.payload).toMatchObject({ value: "CAL-2026-8891" });
  });

  it("does not call a server answer a confirmation when it named no value", async () => {
    const queued = await queueSchemaCardValue(crew, writeCommand(), offlineFetcher());
    setOnline(true);
    const vague = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));

    await flushOutbox({
      tenantId: crew.tenant.id,
      userId: crew.user.id,
      csrfToken: crew.csrf_token,
      fetcher: vague,
    });

    const settled = await getOutboxAction(queued.deviceActionId);
    expect(settled?.state).toBe("needs_attention");
    expect(settled?.lastError?.code).toBe("verification_mismatch");
  });
});
