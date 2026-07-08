import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDeadLetter } from "../src/store.ts";

test("recordDeadLetter stores a redacted payload pointer", async () => {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                writes.push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };

  await recordDeadLetter(env as never, {
    envelope_id: "ow_dead",
    stage: "jn_push",
    error: "boom",
    payload_json: JSON.stringify({ name: "Jane Doe", phone: "+15875551234", service: "roof" }),
  });

  const payload = JSON.parse(String(writes[0].args[4]));
  assert.equal(payload.redacted, true);
  assert.equal(payload.envelope_id, "ow_dead");
  assert.deepEqual(payload.payload_keys, ["name", "phone", "service"]);
  assert.equal(String(writes[0].args[4]).includes("+15875551234"), false);
});
