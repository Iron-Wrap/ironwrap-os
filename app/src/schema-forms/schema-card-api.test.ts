import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { resetDatabaseForTests } from "../storage/db";
import { loadSchemaCard, schemaCardPath } from "./schema-card-api";
import type { SchemaCardResponse } from "./schema-card-contracts";

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
