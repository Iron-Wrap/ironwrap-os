import { test } from "node:test";
import assert from "node:assert/strict";

import { sendInstantAck } from "../src/notify.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import type { LeadAckReceipt } from "../src/store.ts";

const rec: EnvelopeRecord = {
  envelope_id: "ow_44444444-4444-4444-8444-444444444444",
  source: "website",
  contact_name: "Pat Prospect",
  contact_phone: "+14035550123",
  contact_email: "pat@example.com",
  job_ref: null,
  payload_json: "{}",
  raw_key: "raw/2026-07-10/ow_444.json",
  ts: "2026-07-10T10:00:00.000Z",
  status: "pending_jn_push",
  dedup_key: null,
  dup_of: null,
  attempts: 0,
  last_error: null,
  jn_contact_id: null,
  jn_job_id: null,
  intent_queue: "residential_sales",
  created_at: "2026-07-10T10:00:00.000Z",
  updated_at: "2026-07-10T10:00:00.000Z",
};

function harness(sendImpl: (to: string) => Promise<{ providerMessageId: string }>) {
  const sent: string[] = [];
  const receipts: Array<Omit<LeadAckReceipt, "created_at">> = [];
  return {
    sent,
    receipts,
    dependencies: {
      sendEmail: async (_env: Env, to: string) => {
        sent.push(to);
        return await sendImpl(to);
      },
      recordReceipt: async (_env: Env, receipt: Omit<LeadAckReceipt, "created_at">) => {
        receipts.push(receipt);
      },
      now: () => new Date("2026-07-10T10:00:30.000Z"),
      receiptId: () => "ack_test_1",
    },
  };
}

test("instant acknowledgement records provider acceptance, never delivery", async () => {
  const h = harness(async () => ({ providerMessageId: "gmail-accepted-1" }));
  const result = await sendInstantAck({ OWNER_ALERT_EMAIL: "owner@example.com" } as never, rec, h.dependencies);

  assert.deepEqual(result, { prospect: "provider_accepted", owner_alert: "provider_accepted" });
  assert.deepEqual(h.sent, ["pat@example.com", "owner@example.com"]);
  assert.deepEqual(h.receipts, [{
    receipt_id: "ack_test_1", envelope_id: rec.envelope_id, channel: "email",
    outcome: "provider_accepted", observed_at: "2026-07-10T10:00:30.000Z",
    provider_message_id: "gmail-accepted-1", error_code: null,
  }]);
});

test("failed prospect acknowledgement stays unproven even when the owner alert succeeds", async () => {
  const h = harness(async (to) => {
    if (to === "pat@example.com") throw new Error("gmail_send_503: unavailable");
    return { providerMessageId: "gmail-owner-1" };
  });
  const result = await sendInstantAck({ OWNER_ALERT_EMAIL: "owner@example.com" } as never, rec, h.dependencies);

  assert.deepEqual(result, { prospect: "attempt_failed", owner_alert: "provider_accepted" });
  assert.deepEqual(h.receipts[0], {
    receipt_id: "ack_test_1", envelope_id: rec.envelope_id, channel: "email",
    outcome: "attempt_failed", observed_at: "2026-07-10T10:00:30.000Z",
    provider_message_id: null, error_code: "gmail_send_503",
  });
});

test("no eligible prospect channel records that fact without pretending a message was sent", async () => {
  const h = harness(async () => ({ providerMessageId: "gmail-owner-1" }));
  const result = await sendInstantAck(
    { OWNER_ALERT_EMAIL: "owner@example.com" } as never,
    { ...rec, contact_email: null },
    h.dependencies,
  );

  assert.deepEqual(result, { prospect: "no_eligible_channel", owner_alert: "provider_accepted" });
  assert.deepEqual(h.sent, ["owner@example.com"]);
  assert.deepEqual(h.receipts[0], {
    receipt_id: "ack_test_1", envelope_id: rec.envelope_id, channel: "none",
    outcome: "no_eligible_channel", observed_at: "2026-07-10T10:00:30.000Z",
    provider_message_id: null, error_code: null,
  });
});

test("prospect receipt is recorded at prospect settlement without waiting for the owner alert", async () => {
  const receipts: Array<Omit<LeadAckReceipt, "created_at">> = [];
  let resolveOwner: ((value: { providerMessageId: string }) => void) | undefined;
  let releaseReceipt: (() => void) | undefined;
  const receiptRecorded = new Promise<void>((resolve) => { releaseReceipt = resolve; });
  const result = sendInstantAck({ OWNER_ALERT_EMAIL: "owner@example.com" } as never, rec, {
    sendEmail: async (_env, to) => {
      if (to === rec.contact_email) return { providerMessageId: "gmail-prospect-1" };
      return await new Promise<{ providerMessageId: string }>((resolve) => { resolveOwner = resolve; });
    },
    recordReceipt: async (_env, receipt) => {
      receipts.push(receipt);
      releaseReceipt?.();
    },
    now: () => new Date("2026-07-10T10:00:05.000Z"),
    receiptId: () => "ack_settlement_1",
  });

  await receiptRecorded;
  assert.deepEqual(receipts, [{
    receipt_id: "ack_settlement_1", envelope_id: rec.envelope_id, channel: "email",
    outcome: "provider_accepted", observed_at: "2026-07-10T10:00:05.000Z",
    provider_message_id: "gmail-prospect-1", error_code: null,
  }]);
  let completed = false;
  void result.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, "owner alert must still be allowed to settle independently");

  resolveOwner?.({ providerMessageId: "gmail-owner-1" });
  assert.deepEqual(await result, { prospect: "provider_accepted", owner_alert: "provider_accepted" });
});
