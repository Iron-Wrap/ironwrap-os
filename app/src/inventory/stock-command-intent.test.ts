import { afterEach, describe, expect, it } from "vitest";

import { resetDatabaseForTests } from "../storage/db";
import type { InventoryCommandInput } from "./inventory-contracts";
import {
  listStockCommands,
  releaseStockCommand,
  reserveStockCommand,
  stockCommandLedgerKey,
  type StockCommandIntent,
} from "./stock-command-intent";

const ledgerKey = stockCommandLedgerKey({ tenantId: "ironwrap", userId: "appu_ops" });
const intent = (commandId: string, createdAt: number): StockCommandIntent => ({
  commandId,
  key: `key-${commandId}`,
  input: { command_id: commandId, transition: "issue_use" } as unknown as InventoryCommandInput,
  receiptIds: [],
  mode: "online",
  createdAt,
});

describe("stock command ledger", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
  });

  it("lets only one unsettled action be kept, even when two tabs reserve at once", async () => {
    const [a, b] = await Promise.all([
      reserveStockCommand(ledgerKey, intent("command-a", 1)),
      reserveStockCommand(ledgerKey, intent("command-b", 2)),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["busy", "reserved"]);
    expect(await listStockCommands(ledgerKey)).toHaveLength(1);
  });

  it("hands the unsettled action to the next tab instead of overwriting it", async () => {
    await reserveStockCommand(ledgerKey, intent("command-a", 1));
    const second = await reserveStockCommand(ledgerKey, intent("command-b", 2));
    expect(second).toEqual({ kind: "busy", other: intent("command-a", 1) });
    expect((await listStockCommands(ledgerKey)).map((kept) => kept.commandId)).toEqual([
      "command-a",
    ]);
  });

  it("allows a retry of the same action and frees the ledger only when it is settled", async () => {
    await reserveStockCommand(ledgerKey, intent("command-a", 1));
    expect(await reserveStockCommand(ledgerKey, intent("command-a", 5))).toEqual({
      kind: "reserved",
    });
    // The retry keeps the action exactly as first kept.
    expect((await listStockCommands(ledgerKey))[0]?.createdAt).toBe(1);
    await releaseStockCommand(ledgerKey, "command-a");
    expect(await listStockCommands(ledgerKey)).toEqual([]);
    expect(await reserveStockCommand(ledgerKey, intent("command-b", 6))).toEqual({
      kind: "reserved",
    });
  });
});
