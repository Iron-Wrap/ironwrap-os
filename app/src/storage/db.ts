import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { OutboxAction, OutboxBlobRecord, OutboxState } from "./outbox-types";

const DATABASE_NAME = "ironwrap-os";
const DATABASE_VERSION = 1;

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

interface IronWrapDatabase extends DBSchema {
  outbox_actions: {
    key: string;
    value: OutboxAction;
    indexes: {
      by_state: OutboxState;
      by_next_attempt: number;
      by_updated_at: number;
    };
  };
  outbox_blobs: {
    key: string;
    value: OutboxBlobRecord;
    indexes: {
      by_action: string;
    };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

let databasePromise: Promise<IDBPDatabase<IronWrapDatabase>> | undefined;

export function getDatabase(): Promise<IDBPDatabase<IronWrapDatabase>> {
  databasePromise ??= openDB<IronWrapDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      const actions = database.createObjectStore("outbox_actions", {
        keyPath: "deviceActionId",
      });
      actions.createIndex("by_state", "state");
      actions.createIndex("by_next_attempt", "nextAttemptAt");
      actions.createIndex("by_updated_at", "updatedAt");

      const blobs = database.createObjectStore("outbox_blobs", { keyPath: "blobKey" });
      blobs.createIndex("by_action", "deviceActionId");
      database.createObjectStore("meta", { keyPath: "key" });
    },
  });
  return databasePromise;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const database = await getDatabase();
  const record = await database.get("meta", key);
  return record?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const database = await getDatabase();
  await database.put("meta", { key, value, updatedAt: Date.now() });
}

export async function deleteMeta(key: string): Promise<void> {
  const database = await getDatabase();
  await database.delete("meta", key);
}

export async function resetDatabaseForTests(): Promise<void> {
  if (databasePromise) {
    const database = await databasePromise;
    database.close();
    databasePromise = undefined;
  }
  await deleteDB(DATABASE_NAME);
}
