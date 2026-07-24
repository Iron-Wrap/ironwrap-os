import assert from "node:assert/strict";
import { test } from "node:test";

import { devOutboxCapture } from "../src/app-auth.ts";

class DevOutboxDb {
  rows: unknown[][] = [];
  prepare(sql: string) {
    assert.ok(sql.startsWith("INSERT INTO dev_outbox"), `unexpected SQL: ${sql}`);
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          this.rows.push(args);
          return { success: true, meta: { changes: 1 } };
        },
      }),
    };
  }
}

function envWith(flag: string, db: DevOutboxDb) {
  return { APP_ALLOW_INSECURE_LOCAL: flag, DB: db } as never;
}

test("dev outbox captures a magic-link href only in explicit localhost mode", async () => {
  const db = new DevOutboxDb();
  const captured = await devOutboxCapture(
    envWith("true", db),
    "magic_link",
    "owner@example.com",
    "http://localhost:8787/auth/verify#token=abc",
  );
  assert.equal(captured, true);
  assert.equal(db.rows.length, 1);
  const [id, kind, recipient, href, createdAt] = db.rows[0] as string[];
  assert.match(id, /^devcap_[0-9a-f-]{36}$/);
  assert.equal(kind, "magic_link");
  assert.equal(recipient, "owner@example.com");
  assert.match(href, /^http:\/\/localhost:8787\/auth\/verify#token=/);
  assert.ok(!Number.isNaN(Date.parse(createdAt)));
});

test("dev outbox stays inert outside localhost mode (production default)", async () => {
  const db = new DevOutboxDb();
  const captured = await devOutboxCapture(
    envWith("false", db),
    "magic_link",
    "owner@example.com",
    "https://app.example.com/auth/verify#token=abc",
  );
  assert.equal(captured, false);
  assert.equal(db.rows.length, 0);
});
