import { getDatabase } from "../storage/db";
import type { InventoryCommandInput } from "./inventory-contracts";

/**
 * A stock action sent online is kept on the device, exactly as sent, before the first send, and
 * let go only once the Worker has answered for good (applied or refused) or a read-back by its
 * `command_id` has settled it. A lost answer, a reload or a closed tab therefore never turns into a
 * second stock movement under a new identity: the page finds the kept action again, reads it back,
 * and a retry resends the same `command_id`, idempotency key, input and file receipts.
 *
 * Every unsettled action of one person on this device sits in one ledger record, changed only
 * inside a single IndexedDB read-write transaction. Transactions on one store never overlap, even
 * across tabs, so two tabs cannot both reserve: the second sees the first one's action and has to
 * settle it before it can record another.
 */
export interface StockCommandIntent {
  commandId: string;
  key: string;
  input: InventoryCommandInput;
  receiptIds: string[];
  /** `online`: sent to the Worker, settled by a read-back. `offline`: being handed to saved work. */
  mode: "online" | "offline";
  createdAt: number;
}

type Ledger = Record<string, StockCommandIntent>;

export function stockCommandLedgerKey(principal: { tenantId: string; userId: string }): string {
  return `stock-command-intent:${principal.tenantId}:${principal.userId}`;
}

function oldestFirst(ledger: Ledger): StockCommandIntent[] {
  return Object.values(ledger).sort((a, b) => a.createdAt - b.createdAt);
}

/** Every unsettled stock action of this person on this device, oldest first. */
export async function listStockCommands(ledgerKey: string): Promise<StockCommandIntent[]> {
  const database = await getDatabase();
  const record = await database.get("meta", ledgerKey);
  return oldestFirst((record?.value as Ledger | undefined) ?? {});
}

/**
 * Keeps `intent` unless a different action is still unsettled; then that one is returned and
 * nothing is kept. Keeping the same action again (a retry) is allowed.
 */
export async function reserveStockCommand(
  ledgerKey: string,
  intent: StockCommandIntent,
): Promise<{ kind: "reserved" } | { kind: "busy"; other: StockCommandIntent }> {
  const database = await getDatabase();
  const transaction = database.transaction("meta", "readwrite");
  const record = await transaction.store.get(ledgerKey);
  const ledger: Ledger = { ...((record?.value as Ledger | undefined) ?? {}) };
  const other = oldestFirst(ledger).find((kept) => kept.commandId !== intent.commandId);
  if (other) {
    await transaction.done;
    return { kind: "busy", other };
  }
  ledger[intent.commandId] = ledger[intent.commandId] ?? intent;
  await transaction.store.put({ key: ledgerKey, value: ledger, updatedAt: Date.now() });
  await transaction.done;
  return { kind: "reserved" };
}

/** Lets one settled action go; the others stay. */
export async function releaseStockCommand(ledgerKey: string, commandId: string): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction("meta", "readwrite");
  const record = await transaction.store.get(ledgerKey);
  const ledger: Ledger = { ...((record?.value as Ledger | undefined) ?? {}) };
  delete ledger[commandId];
  if (Object.keys(ledger).length === 0) await transaction.store.delete(ledgerKey);
  else await transaction.store.put({ key: ledgerKey, value: ledger, updatedAt: Date.now() });
  await transaction.done;
}
