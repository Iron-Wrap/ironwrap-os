import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { OutboxAction, OutboxBlobRecord, OutboxState } from "./outbox-types";

const DATABASE_NAME = "ironwrap-os";
const DATABASE_VERSION = 3;

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface FieldCacheRecord {
  key: string;
  value: unknown;
  sourceUpdatedAt: string | null;
  updatedAt: number;
  /** Optional read-context receipt. Legacy/unbound packets remain readable as job details. */
  savedPlanBinding?: unknown;
}

interface IronWrapDatabase extends DBSchema {
  outbox_actions: {
    key: string;
    value: OutboxAction;
    indexes: {
      by_state: OutboxState;
      by_principal_state: [string, string, OutboxState];
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
  field_cache: {
    key: string;
    value: FieldCacheRecord;
    indexes: {
      by_updated_at: number;
    };
  };
}

let databasePromise: Promise<IDBPDatabase<IronWrapDatabase>> | undefined;

export function getDatabase(): Promise<IDBPDatabase<IronWrapDatabase>> {
  databasePromise ??= openDB<IronWrapDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const actions = database.createObjectStore("outbox_actions", {
          keyPath: "deviceActionId",
        });
        actions.createIndex("by_state", "state");
        actions.createIndex("by_next_attempt", "nextAttemptAt");
        actions.createIndex("by_updated_at", "updatedAt");

        const blobs = database.createObjectStore("outbox_blobs", { keyPath: "blobKey" });
        blobs.createIndex("by_action", "deviceActionId");
        database.createObjectStore("meta", { keyPath: "key" });
      }
      if (oldVersion < 2) {
        const fieldCache = database.createObjectStore("field_cache", { keyPath: "key" });
        fieldCache.createIndex("by_updated_at", "updatedAt");
      }
      if (oldVersion < 3) {
        transaction
          .objectStore("outbox_actions")
          .createIndex("by_principal_state", ["tenantId", "userId", "state"]);
      }
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
