// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDatabaseForTests } from "./db";
import {
  getOutboxAction,
  getOutboxActionsNeedingAttention,
  getOutboxActionsSettledByOffice,
  getOutboxActionWithBlobs,
  markOfficeSettlementSeen,
  queueOutboxAction,
  saveOutboxAction,
} from "./outbox";
import { outboxFailureGuidance } from "./outbox-failure";
import { flushOutbox } from "./outbox-processor";
import type { JsonValue, OutboxActionKind } from "./outbox-types";

const principal = { tenantId: "ironwrap", userId: "appu_field" };
const ID = "device-fleet-0001";
const ENDPOINT = "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections";
const RESOLUTIONS = "/api/v1/field-item-resolutions";
const FINGERPRINT = "f".repeat(64);
const UNCONFIRMED_REASON =
  "The office answered, but this phone could not confirm the office has this exact item.";

const inspection = {
  fleet_asset_id: "asset-truck-1",
  performed_at: "2026-07-11T06:30:00.000Z",
  items: [{ sequence: 1, check_point: "Brakes", result: "Pass" }],
};

function answer(
  resolution: "arrived" | "not_arrived" | "duplicate",
  overrides: Record<string, unknown> = {},
) {
  const held = resolution !== "not_arrived";
  return {
    resolution_id: `fir_${(held ? "1" : "2").repeat(64)}`,
    device_action_id: ID,
    item_kind: "fleet_pre_trip_inspection",
    payload_sha256: held ? "a".repeat(64) : null,
    resolution,
    linked_record: held ? { type: "fleet_asset_action", id: ID } : null,
    resolved_at: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

/** The office answered with a body that does not verify this exact item. */
const mismatched = () =>
  Response.json({ device_action_id: "someone-else", status: "verified" }, { status: 201 });
const verified = (id = ID) =>
  Response.json({ device_action_id: id, status: "verified", server_ref: `ref:${id}` });

function office(
  answers: () => Response | Promise<Response>,
  upload: () => Response | Promise<Response> = () => {
    throw new Error("This item must not be sent again.");
  },
) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      String(input).startsWith(RESOLUTIONS) ? await answers() : await upload(),
    );
}

const flush = (fetcher: typeof fetch, at: number) =>
  flushOutbox({
    ...principal,
    fetcher,
    csrfToken: "csrf",
    deviceProof: async () => "device-proof",
    now: () => at,
  });

async function unconfirmed(
  options: {
    id?: string;
    kind?: OutboxActionKind;
    endpoint?: string;
    payload?: JsonValue;
    files?: Blob[];
  } = {},
) {
  const id = options.id ?? ID;
  await saveOutboxAction({
    ...principal,
    deviceActionId: id,
    kind: options.kind ?? "fleet_pre_trip_inspection",
    endpoint: options.endpoint ?? ENDPOINT,
    payload: options.payload ?? inspection,
    attachments: (options.files ?? []).map((blob, index) => ({
      blob,
      fileName: `photo-${index}.jpg`,
      attachmentId: `photo-${index}`,
    })),
  });
  await queueOutboxAction(id, 1_000);
  await flush(
    vi.fn<typeof fetch>().mockImplementation(async () => mismatched()),
    2_000,
  );
  expect(await getOutboxAction(id)).toMatchObject({
    state: "needs_attention",
    lastError: { code: "verification_mismatch" },
  });
}

describe("office answers for unconfirmed crew items", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
  });

  it.each(["arrived", "duplicate"] as const)(
    "settles an item the office says %s without sending it again",
    async (resolution) => {
      await unconfirmed();
      const fetcher = office(() =>
        Response.json({ version: 1, resolutions: [answer(resolution)] }),
      );

      await flush(fetcher, 3_000);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(String(url)).toBe(`${RESOLUTIONS}?device_action_id=${ID}`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("X-IronWrap-Device-Proof")).toBe("device-proof");
      const settled = await getOutboxAction(ID);
      expect(settled).toMatchObject({
        state: "verified",
        attempts: 1,
        verification: {
          verifiedAt: 3_000,
          serverRef: ID,
          cursor: answer(resolution).resolution_id,
          officeResolution: {
            resolutionId: answer(resolution).resolution_id,
            resolution,
            linkedRecord: { type: "fleet_asset_action", id: ID },
          },
        },
      });
      expect(settled?.lastError).toBeUndefined();
      expect(outboxFailureGuidance(settled!).reason).toBe("The office confirmed it has this.");
      expect(outboxFailureGuidance(settled!).officeConfirmed).toBe(true);
    },
  );

  it("keeps a settled item on the office's list until the person has read it", async () => {
    await unconfirmed();
    expect(await getOutboxActionsSettledByOffice(principal)).toEqual([]);

    await flush(
      office(() => Response.json({ version: 1, resolutions: [answer("arrived")] })),
      3_000,
    );

    expect(await getOutboxActionsNeedingAttention(principal)).toEqual([]);
    expect((await getOutboxActionsSettledByOffice(principal)).map((a) => a.deviceActionId)).toEqual(
      [ID],
    );
    // Another person's settled items are never on this list.
    expect(
      await getOutboxActionsSettledByOffice({ tenantId: "ironwrap", userId: "appu_other" }),
    ).toEqual([]);

    await markOfficeSettlementSeen(ID, 4_000);

    expect(await getOutboxActionsSettledByOffice(principal)).toEqual([]);
    expect(await getOutboxAction(ID)).toMatchObject({
      state: "verified",
      verification: {
        verifiedAt: 3_000,
        officeResolution: { resolution: "arrived", seenAt: 4_000 },
      },
    });
  });

  it("lets go of a settled check-in's files the way a verified upload does", async () => {
    await unconfirmed({
      id: "device-checkin-0001",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/job-1/check-ins",
      payload: { note: "Arrived" },
      files: [new Blob(["roof photo"], { type: "image/jpeg" })],
    });
    expect((await getOutboxActionWithBlobs("device-checkin-0001"))?.blobs).toHaveLength(1);
    const fetcher = office(() =>
      Response.json({
        version: 1,
        resolutions: [
          answer("arrived", {
            device_action_id: "device-checkin-0001",
            item_kind: "field_checkin",
            linked_record: { type: "field_action", id: "device-checkin-0001" },
          }),
        ],
      }),
    );

    await flush(fetcher, 3_000);

    expect((await getOutboxAction("device-checkin-0001"))?.state).toBe("verified");
    expect((await getOutboxActionWithBlobs("device-checkin-0001"))?.blobs).toHaveLength(0);
  });

  it("resends once under the same key when the office says it did not arrive, then verifies normally", async () => {
    await unconfirmed();
    const upload = vi.fn(() => verified());
    const fetcher = office(
      () => Response.json({ version: 1, resolutions: [answer("not_arrived")] }),
      upload,
    );

    await expect(flush(fetcher, 3_000)).resolves.toMatchObject({ processed: 1, verified: 1 });

    expect(fetcher.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual([
      RESOLUTIONS,
      ENDPOINT,
    ]);
    const sent = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(sent.get("Idempotency-Key")).toBe(ID);
    expect(sent.get("X-Device-Action-Id")).toBe(ID);
    const after = await getOutboxAction(ID);
    expect(after).toMatchObject({
      state: "verified",
      verification: { serverRef: `ref:${ID}`, verifiedAt: 3_000 },
      officeResend: { resolutionId: answer("not_arrived").resolution_id, requeuedAt: 3_000 },
    });
    expect(after?.verification?.officeResolution).toBeUndefined();

    // Nothing is unconfirmed any more, so the office is not asked again.
    const quiet = office(() => Response.json({ version: 1, resolutions: [answer("not_arrived")] }));
    await flush(quiet, 4_000);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("never resends twice for the same answer, and still settles on a later arrival", async () => {
    await unconfirmed();
    const notArrived = () => Response.json({ version: 1, resolutions: [answer("not_arrived")] });

    await flush(office(notArrived, mismatched), 3_000);
    expect(await getOutboxAction(ID)).toMatchObject({
      state: "needs_attention",
      lastError: { code: "verification_mismatch" },
      officeResend: { resolutionId: answer("not_arrived").resolution_id },
    });

    const again = office(notArrived);
    await flush(again, 4_000);
    expect(again).toHaveBeenCalledTimes(1);
    expect(await getOutboxAction(ID)).toMatchObject({ state: "needs_attention" });
    expect(outboxFailureGuidance((await getOutboxAction(ID))!).reason).toBe(UNCONFIRMED_REASON);

    const later = office(() =>
      Response.json({ version: 1, resolutions: [answer("not_arrived"), answer("arrived")] }),
    );
    await flush(later, 5_000);
    expect(later).toHaveBeenCalledTimes(1);
    expect(await getOutboxAction(ID)).toMatchObject({
      state: "verified",
      verification: { officeResolution: { resolution: "arrived" } },
    });
  });

  it.each([
    ["no answer yet", () => Response.json({ version: 1, resolutions: [] })],
    [
      "an answer about another kind",
      () =>
        Response.json({
          version: 1,
          resolutions: [answer("arrived", { item_kind: "fleet_defect_report" })],
        }),
    ],
    [
      "an answer about another item",
      () =>
        Response.json({
          version: 1,
          resolutions: [answer("not_arrived", { device_action_id: "device-other-0001" })],
        }),
    ],
    [
      "an answer it does not recognise",
      () => Response.json({ version: 1, resolutions: [{ ...answer("arrived"), note: "extra" }] }),
    ],
    [
      "an inconsistent answer",
      () =>
        Response.json({ version: 1, resolutions: [answer("arrived", { linked_record: null })] }),
    ],
    ["a server error", () => Response.json({ error: "unavailable" }, { status: 503 })],
    ["no signal", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps today's guidance with %s", async (_label, answers) => {
    await unconfirmed();
    const fetcher = office(answers);

    await flush(fetcher, 3_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const kept = await getOutboxAction(ID);
    expect(kept).toMatchObject({
      state: "needs_attention",
      lastError: { code: "verification_mismatch" },
    });
    expect(kept?.officeResend).toBeUndefined();
    expect(outboxFailureGuidance(kept!)).toMatchObject({
      reason: UNCONFIRMED_REASON,
      officeConfirmed: false,
    });
  });

  it("settles an inventory scan only when the answer carries the fingerprint the phone computed", async () => {
    const scan = {
      scan_id: "scan-0001-abcdef",
      device_id: "device-0001",
      device_action_id: "device-scan-0001",
      barcode: "BAR-0001",
      scan_intent: "count",
      observed_at: "2026-07-11T06:30:00.000Z",
      captured_offline: true,
      payload: {},
      request_fingerprint_sha256: FINGERPRINT,
    };
    await unconfirmed({
      id: "device-scan-0001",
      kind: "inventory_scan",
      endpoint: "/api/v1/inventory/scans",
      payload: scan,
    });
    const scanAnswer = (payloadSha256: string) =>
      answer("arrived", {
        device_action_id: "device-scan-0001",
        item_kind: "inventory_scan",
        payload_sha256: payloadSha256,
        linked_record: { type: "inventory_scan", id: "scan-0001-abcdef" },
      });

    await flush(
      office(() => Response.json({ version: 1, resolutions: [scanAnswer("e".repeat(64))] })),
      3_000,
    );
    expect((await getOutboxAction("device-scan-0001"))?.state).toBe("needs_attention");

    await flush(
      office(() => Response.json({ version: 1, resolutions: [scanAnswer(FINGERPRINT)] })),
      4_000,
    );
    expect((await getOutboxAction("device-scan-0001"))?.state).toBe("verified");
  });

  it("asks the office only about unconfirmed items", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: ID,
      kind: "fleet_pre_trip_inspection",
      endpoint: ENDPOINT,
      payload: inspection,
    });
    await queueOutboxAction(ID, 1_000);
    await flush(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ error: "fleet_asset_not_found" }, { status: 400 }),
        ),
      2_000,
    );
    expect(await getOutboxAction(ID)).toMatchObject({ state: "needs_attention" });

    const fetcher = office(() => Response.json({ version: 1, resolutions: [answer("arrived")] }));
    await flush(fetcher, 3_000);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await getOutboxAction(ID)).toMatchObject({ state: "needs_attention" });
  });
});
