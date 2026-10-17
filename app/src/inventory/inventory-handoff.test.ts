import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import type { EvidenceSubmission } from "../evidence/evidence-uploads";
import { API_PATHS } from "../lib/api-paths";
import {
  getOutboxAction,
  markOutboxVerified,
  saveOutboxAction,
  transitionOutboxAction,
} from "../storage/outbox";
import { resetDatabaseForTests } from "../storage/db";

// The real outbox, with its first read observable, so a test can let "another tab" move the saved
// action between the handoff's first look and its queueing.
vi.mock("../storage/outbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("../storage/outbox")>();
  return { ...real, getOutboxAction: vi.fn(real.getOutboxAction) };
});
import type { JsonValue } from "../storage/outbox-types";
import { handOffInventoryCommand, inventoryCommandBody } from "./inventory-api";
import type { InventoryCommandInput } from "./inventory-contracts";

const session = {
  tenant: { id: "ironwrap" },
  user: { id: "appu_ops", role: "ops" },
} as unknown as AuthenticatedSession;
const key = "inventory-action-handoff-0001";
const input = {
  command_id: "inventory-command-handoff-0001",
  transition: "issue_use",
  authority_ref: "Authority-Inventory-Readback-01",
  policy_ref: "policy:inventory-command",
  policy_version: "1",
  source_position_id: "position-1",
  item_id: "item-1",
  lot_id: "lot-1",
  bin_id: "bin-1",
  uom_id: "uom-1",
  job_custody: "-",
  quantity_scaled: 5,
  job_id: "job-1",
} as unknown as InventoryCommandInput;
const evidence = (targetId = "lot-1"): EvidenceSubmission => ({
  scope: {
    purpose: "stock",
    targetId,
    action: "issue_use",
    operationId: input.command_id,
  },
  files: [
    {
      uploadKey: "evidence-key-handoff-0001",
      fileName: "stock.jpg",
      mimeType: "image/jpeg",
      size: 4,
      blob: new Blob(["jpeg"], { type: "image/jpeg" }),
    },
  ],
});

/** What an interrupted first try left in saved work: the exact action, saved but never queued. */
async function saveExact(overrides: Partial<Parameters<typeof saveOutboxAction>[0]> = {}) {
  await saveOutboxAction({
    deviceActionId: key,
    tenantId: "ironwrap",
    userId: "appu_ops",
    kind: "inventory_command",
    endpoint: API_PATHS.inventoryCommands,
    payload: inventoryCommandBody(input, key) as unknown as JsonValue,
    evidence: evidence(),
    ...overrides,
  });
}

describe("handing a stock action to saved work", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
  });

  it("queues the exact action an interrupted try saved but never queued, without its files", async () => {
    await saveExact();
    expect((await getOutboxAction(key))?.state).toBe("saved_locally");

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("queued");
    expect((await getOutboxAction(key))?.state).toBe("queued");
  });

  it("does not save the same action twice when a try is repeated", async () => {
    expect(await handOffInventoryCommand(session, input, key, evidence())).toBe("queued");
    expect(await handOffInventoryCommand(session, input, key, evidence())).toBe("queued");
    expect((await getOutboxAction(key))?.state).toBe("queued");
  });

  it("says when the action is in saved work nowhere and its files are not here", async () => {
    expect(await handOffInventoryCommand(session, input, key, null)).toBe("missing");
    expect(await getOutboxAction(key)).toBeUndefined();
  });

  it.each<[string, Partial<Parameters<typeof saveOutboxAction>[0]>]>([
    ["another person", { userId: "appu_other" }],
    ["another company", { tenantId: "other-tenant" }],
    [
      "another kind",
      {
        kind: "inventory_scan",
        endpoint: API_PATHS.inventoryScans,
        payload: { device_action_id: key },
        evidence: undefined,
      },
    ],
    [
      "another payload",
      {
        payload: inventoryCommandBody(
          { ...input, quantity_scaled: 6 } as InventoryCommandInput,
          key,
        ) as unknown as JsonValue,
      },
    ],
  ])("never takes a record saved for %s as this action", async (_label, overrides) => {
    await saveExact(overrides);

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("mismatch");
    expect(await handOffInventoryCommand(session, input, key, evidence())).toBe("mismatch");
    // The other record is left exactly as it was: never queued under this action's name.
    expect((await getOutboxAction(key))?.state).toBe("saved_locally");
  });

  it("never takes files saved for another lot as this action's files", async () => {
    await saveExact({ evidence: evidence("lot-2") });
    expect(await handOffInventoryCommand(session, input, key, null)).toBe("mismatch");
    expect((await getOutboxAction(key))?.state).toBe("saved_locally");
  });

  it("does not save files that belong to another lot", async () => {
    expect(await handOffInventoryCommand(session, input, key, evidence("lot-2"))).toBe("mismatch");
    expect(await getOutboxAction(key)).toBeUndefined();
  });

  it("reports a stopped action that a person can try again from saved work", async () => {
    await saveExact();
    await handOffInventoryCommand(session, input, key, null);
    await transitionOutboxAction(key, "needs_attention", Date.now(), {
      lastError: { status: 503, code: "worker_unavailable", message: "", occurredAt: Date.now() },
    });

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("needs_attention");
    // Saved work keeps it stopped: nothing here sends it by itself.
    expect((await getOutboxAction(key))?.state).toBe("needs_attention");
  });

  it("reports a stopped action that saved work will never send again", async () => {
    await saveExact();
    await handOffInventoryCommand(session, input, key, null);
    await transitionOutboxAction(key, "needs_attention", Date.now(), {
      lastError: {
        status: 422,
        code: "inventory_rule_failed",
        message: "",
        occurredAt: Date.now(),
      },
    });

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("stopped");
    expect((await getOutboxAction(key))?.state).toBe("needs_attention");
  });

  it("never queues an action another tab stopped for good after the handoff first looked", async () => {
    await saveExact();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const real = await vi.importActual<typeof import("../storage/outbox")>("../storage/outbox");
    vi.mocked(getOutboxAction).mockImplementationOnce(async (id) => {
      const seen = await real.getOutboxAction(id);
      // Another tab queues it, sends it, and the Worker refuses it for good.
      await real.queueOutboxAction(id);
      await real.transitionOutboxAction(id, "uploading");
      await real.transitionOutboxAction(id, "needs_attention", Date.now(), {
        lastError: { status: 422, code: "inventory_rule_failed", message: "", occurredAt: 1 },
      });
      return seen;
    });

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("stopped");
    const after = await real.getOutboxAction(key);
    expect(after?.state).toBe("needs_attention");
    expect(after?.lastError?.code).toBe("inventory_rule_failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports an action saved work already sent, so only a read-back can say what happened", async () => {
    await saveExact();
    await handOffInventoryCommand(session, input, key, null);
    await transitionOutboxAction(key, "uploading");
    await markOutboxVerified(key, { verifiedAt: Date.now() });

    expect(await handOffInventoryCommand(session, input, key, null)).toBe("verified");
  });
});
