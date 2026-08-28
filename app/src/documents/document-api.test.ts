import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { resetDatabaseForTests } from "../storage/db";
import { entityDocumentsPath, loadEntityDocuments } from "./document-api";
import type { EntityDocumentsResponse } from "./document-contracts";

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

function shelf(labels: string[]): EntityDocumentsResponse {
  return {
    entity_type: "job",
    entity_id: "JOB-1",
    documents: labels.map((label, index) => ({
      template_id: `tpl_${index}`,
      template_key: label.toLowerCase().replace(/\s+/g, "_"),
      label,
      revision_id: `rev_${index}`,
      version: 1,
      blocks: [{ kind: "field", field_id: "fld_bundles" }],
    })),
  };
}

const offlineFetcher = () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));

describe("reading the documents a record carries", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it("reads the record's document route and caches what came back", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(shelf(["Materials list"])));

    const model = await loadEntityDocuments(crew, "job", "JOB-1", fetcher);

    expect(model.offline).toBe(false);
    expect(model.response.documents).toHaveLength(1);
    expect(String(at(at(fetcher.mock.calls, 0), 0))).toContain(entityDocumentsPath("job", "JOB-1"));
  });

  it("opens a document the crew already loaded once, with the device offline", async () => {
    await loadEntityDocuments(
      crew,
      "job",
      "JOB-1",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(shelf(["Materials list"]))),
    );

    const offline = await loadEntityDocuments(crew, "job", "JOB-1", offlineFetcher());

    expect(offline.offline).toBe(true);
    expect(offline.response.documents.map((document) => document.label)).toEqual([
      "Materials list",
    ]);
  });

  it("refuses to invent an empty shelf for a record never opened on this device", async () => {
    await expect(
      loadEntityDocuments(crew, "job", "NEVER-OPENED", offlineFetcher()),
    ).rejects.toThrow();
  });

  it("never serves one user's shelf to another on a shared device", async () => {
    await loadEntityDocuments(
      crew,
      "job",
      "JOB-1",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(shelf(["Margin sheet"]))),
    );

    await expect(
      loadEntityDocuments(
        sessionFor("field", "appu_second_crew"),
        "job",
        "JOB-1",
        offlineFetcher(),
      ),
    ).rejects.toThrow();
  });

  /**
   * The record read is the surface that tells a reader something was withheld. A record the
   * document route will not name is simply a record with no document here, and interrupting the
   * job packet over it would be noise on a phone.
   */
  it("treats a record the server will not name as a record with no documents", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));

    const model = await loadEntityDocuments(crew, "job", "JOB-1", fetcher);

    expect(model).toEqual({
      response: { entity_type: "job", entity_id: "JOB-1", documents: [] },
      offline: false,
    });
  });

  it("raises a refusal rather than falling back to cache when the server answers", async () => {
    await loadEntityDocuments(
      crew,
      "job",
      "JOB-1",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(shelf(["Materials list"]))),
    );

    await expect(
      loadEntityDocuments(
        crew,
        "job",
        "JOB-1",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 })),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("presents the crew device proof the field routes require", async () => {
    await storeDeviceSecret("p".repeat(43));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(shelf(["Materials list"])));

    await loadEntityDocuments(crew, "job", "JOB-1", fetcher);

    const headers = (at(at(fetcher.mock.calls, 0), 1) as RequestInit).headers as Headers;
    expect(headers.get("X-IronWrap-Device-Proof")).toBe("p".repeat(43));
  });

  it("does not present a crew device proof for an office role", async () => {
    await storeDeviceSecret("p".repeat(43));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(shelf(["Materials list"])));

    await loadEntityDocuments(sessionFor("owner", "appu_owner"), "job", "JOB-1", fetcher);

    const headers = (at(at(fetcher.mock.calls, 0), 1) as RequestInit).headers as Headers;
    expect(headers.get("X-IronWrap-Device-Proof")).toBeNull();
  });
});
