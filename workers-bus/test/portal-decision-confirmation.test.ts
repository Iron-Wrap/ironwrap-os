import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { reconcileCustomerPortalDecisionAttempts } from "../src/customer-portal-decision.ts";
import {
  recordPortalDecisionConfirmation,
  type PortalDecisionConfirmationInput,
} from "../src/portal-decision-confirmation.ts";
import type { AppEnv } from "../src/app-types.ts";

const NOW = "2026-08-21T21:00:00.000Z";
const DECISION_ID = "decision_0000000000000001";
const INPUT = {
  tenantId: "ironwrap",
  decisionId: DECISION_ID,
  portalLinkId: "portal_00000000-0000-4000-8000-000000000101",
  roofJobId: "JOB-SEP1",
  customerId: "customer:sep1:0001",
  optionPackageId: "opt-better",
  optionLabel: "Charcoal standing seam",
};

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          first<T>() {
            return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
          },
          all<T>() {
            return { results: sqlite.prepare(sql).all(...values) as T[] };
          },
          run() {
            const result = sqlite.prepare(sql).run(...values);
            return { meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

async function testEnv(insecureLocal = true): Promise<AppEnv> {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  const names = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of names) {
    DB.sqlite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  return {
    DB,
    APP_ALLOW_INSECURE_LOCAL: insecureLocal ? "true" : "false",
    APP_PUBLIC_ORIGIN: "https://app.example.invalid",
  } as unknown as AppEnv;
}

test("portal confirmation lands in the local-dev outbox and is idempotent", async () => {
  const env = await testEnv(true);
  seedRecordedDecision(env, DECISION_ID, INPUT);
  const first = await recordPortalDecisionConfirmation(env, INPUT, {
    lookupRecipient: async () => "Homeowner@Example.invalid",
    now: () => NOW,
  });
  assert.deepEqual(first, {
    outcome: "dev_captured",
    channel: "dev_outbox",
    recipient: "homeowner@example.invalid",
    providerMessageId: null,
    errorCode: null,
  });

  const replay = await recordPortalDecisionConfirmation(env, INPUT, {
    lookupRecipient: async () => "homeowner@example.invalid",
    now: () => NOW,
  });
  assert.equal(replay, null);

  const db = (env.DB as unknown as TestD1).sqlite;
  const confirmations = db
    .prepare("SELECT confirmation_id, outcome, recipient FROM portal_decision_confirmations")
    .all() as Array<{ confirmation_id: string; outcome: string; recipient: string }>;
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0]?.outcome, "dev_captured");
  assert.equal(confirmations[0]?.recipient, "homeowner@example.invalid");

  const outbox = db
    .prepare("SELECT kind, recipient FROM dev_outbox WHERE kind = 'portal_decision_confirmation'")
    .all() as Array<{ kind: string; recipient: string }>;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.recipient, "homeowner@example.invalid");
});

test("portal confirmation records skipped_no_recipient without sending", async () => {
  const env = await testEnv(true);
  seedRecordedDecision(env, DECISION_ID, INPUT);
  const result = await recordPortalDecisionConfirmation(env, INPUT, {
    lookupRecipient: async () => null,
    now: () => NOW,
  });
  assert.deepEqual(result, {
    outcome: "skipped_no_recipient",
    channel: "none",
    recipient: "none@example.invalid",
    providerMessageId: null,
    errorCode: null,
  });
  const db = (env.DB as unknown as TestD1).sqlite;
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM dev_outbox").get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM portal_decision_confirmations").get() as { n: number }).n,
    0,
  );
});

test("portal confirmation uses the injected Gmail path when local-dev capture is off", async () => {
  const env = await testEnv(false);
  seedRecordedDecision(env, DECISION_ID, INPUT);
  let sentTo = "";
  const result = await recordPortalDecisionConfirmation(env, INPUT, {
    lookupRecipient: async () => "homeowner@example.invalid",
    now: () => NOW,
    sendEmail: async (_env, to, subject) => {
      sentTo = to;
      assert.match(subject, /material choice/i);
      return { providerMessageId: "gmail-msg-sep1" };
    },
  });
  assert.equal(sentTo, "homeowner@example.invalid");
  assert.deepEqual(result, {
    outcome: "provider_accepted",
    channel: "email",
    recipient: "homeowner@example.invalid",
    providerMessageId: "gmail-msg-sep1",
    errorCode: null,
  });
});

test("portal confirmation ledger rejects transient, unrecorded, and drifted inserts", async () => {
  const env = await testEnv(false);
  seedRecordedDecision(env, DECISION_ID, INPUT);
  seedPendingDecision(env, "decision_0000000000000002", INPUT);
  const db = (env.DB as unknown as TestD1).sqlite;
  let sequence = 0;
  const insert = (overrides: Record<string, string | null | undefined> = {}) => {
    sequence += 1;
    return db.prepare(
      `INSERT INTO portal_decision_confirmations
         (confirmation_id, tenant_id, decision_id, portal_link_id, roof_job_id, customer_id,
          recipient, channel, option_package_id, option_label, outcome, provider_message_id,
          error_code, created_at)
       VALUES (?, 'ironwrap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `pdc_schema_${sequence}`,
      overrides.decisionId ?? INPUT.decisionId,
      overrides.portalLinkId ?? INPUT.portalLinkId,
      overrides.roofJobId ?? INPUT.roofJobId,
      overrides.customerId ?? INPUT.customerId,
      "homeowner@example.invalid",
      overrides.channel ?? "email",
      INPUT.optionPackageId,
      INPUT.optionLabel,
      overrides.outcome ?? "provider_accepted",
      overrides.providerMessageId === undefined
        ? "gmail-schema-message"
        : overrides.providerMessageId,
      overrides.errorCode ?? null,
      NOW,
    );
  };

  assert.throws(
    () => insert({ outcome: "attempt_failed", providerMessageId: null }),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert({ decisionId: "decision_0000000000000002" }),
    /portal_decision_confirmation_scope_mismatch/,
  );
  assert.throws(
    () => insert({ customerId: "CUSTOMER-DRIFT" }),
    /portal_decision_confirmation_scope_mismatch/,
  );
  assert.throws(
    () => insert({ channel: "dev_outbox" }),
    /CHECK constraint failed/,
  );
});

function seedPendingDecision(
  env: AppEnv,
  decisionId: string,
  facts: Pick<
    PortalDecisionConfirmationInput,
    "portalLinkId" | "roofJobId" | "customerId" | "optionPackageId" | "optionLabel"
  >,
): void {
  const db = (env.DB as unknown as TestD1).sqlite;
  const now = NOW;
  db.prepare(
    `INSERT INTO customer_portal_decision_intents
       (decision_id, idempotency_key_hash, request_fingerprint, tenant_id, portal_link_id,
        roof_job_id, customer_id, option_package_id, option_tier, option_label, selected_at,
        selector_ip_hash, receipt_key, receipt_hash, receipt_content_length, state,
        frappe_attempted_at, frappe_attempt_lease_expires_at, result_json, response_status,
        error_code, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'ironwrap', ?, ?, ?, ?, 'Better', ?, ?, ?, ?, NULL, NULL, 'receipt_pending',
        NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    decisionId,
    "a".repeat(64),
    "b".repeat(64),
    facts.portalLinkId,
    facts.roofJobId,
    facts.customerId,
    facts.optionPackageId,
    facts.optionLabel,
    now,
    "c".repeat(64),
    `customer-portal-decision/v1/${decisionId}.json`,
    now,
    now,
  );
}

function seedRecordedDecision(
  env: AppEnv,
  decisionId: string,
  facts: Pick<
    PortalDecisionConfirmationInput,
    "portalLinkId" | "roofJobId" | "customerId" | "optionPackageId" | "optionLabel"
  > = {
    portalLinkId: "portal_00000000-0000-4000-8000-000000000099",
    roofJobId: "JOB-PORTAL-TEST",
    customerId: "CUSTOMER-PORTAL-TEST",
    optionPackageId: "opt-better",
    optionLabel: "Charcoal standing seam",
  },
): void {
  const db = (env.DB as unknown as TestD1).sqlite;
  const now = NOW;
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, 'ironwrap', ?, 'Portal Test Owner', 'owner', ?, 1, 'seed', ?, ?)`,
  ).run("appu_portal_test_0001", "owner-portal-test@example.invalid", "owner-portal-test@example.invalid", now, now);
  db.prepare(
    `INSERT INTO customer_portal_links
       (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
        created_at, expires_at, revoked_at, revoked_by_user_id, last_accessed_at, access_count,
        issued_ip_hash, issued_user_agent_hash)
     VALUES (?, ?, 'ironwrap', ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
  ).run(
    facts.portalLinkId,
    "a".repeat(64),
    facts.roofJobId,
    facts.customerId,
    "appu_portal_test_0001",
    now,
    "2027-08-21T21:00:00.000Z",
    "b".repeat(64),
    "c".repeat(64),
  );
  db.prepare(
    `INSERT INTO customer_portal_decision_intents
       (decision_id, idempotency_key_hash, request_fingerprint, tenant_id, portal_link_id,
        roof_job_id, customer_id, option_package_id, option_tier, option_label, selected_at,
        selector_ip_hash, receipt_key, receipt_hash, receipt_content_length, state,
        frappe_attempted_at, frappe_attempt_lease_expires_at, result_json, response_status,
        error_code, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'ironwrap', ?, ?, ?, ?, 'Better', ?, ?, ?, ?, ?, 10, 'recorded', ?, NULL, ?, 200, NULL, ?, ?, ?)`,
  ).run(
    decisionId,
    "d".repeat(64),
    "e".repeat(64),
    facts.portalLinkId,
    facts.roofJobId,
    facts.customerId,
    facts.optionPackageId,
    facts.optionLabel,
    now,
    "f".repeat(64),
    `customer-portal-decision/v1/${decisionId}.json`,
    "1".repeat(64),
    now,
    `{"status":"recorded","decision_id":"${decisionId}"}`,
    now,
    now,
    now,
  );
}

test("scheduled decision reconciliation retries a failed confirmation and does not send again after success", async () => {
  const env = await testEnv(false);
  const decisionId = "decision_0000000000000001";
  seedRecordedDecision(env, decisionId);
  let shouldFail = true;
  let sendCalls = 0;
  const deps = {
    lookupRecipient: async () => "homeowner@example.invalid",
    sendEmail: async () => {
      sendCalls += 1;
      if (shouldFail) throw new Error("gmail_temporarily_unavailable");
      return { providerMessageId: "gmail-message-portal-recovery" };
    },
    now: () => NOW,
  };

  await reconcileCustomerPortalDecisionAttempts(env, new Date(NOW), deps);
  assert.equal(sendCalls, 1);
  assert.equal(
    ((env.DB as unknown as TestD1).sqlite
      .prepare("SELECT COUNT(*) AS n FROM portal_decision_confirmations").get() as { n: number }).n,
    0,
  );

  shouldFail = false;
  await reconcileCustomerPortalDecisionAttempts(env, new Date("2026-08-21T21:01:00.000Z"), deps);
  assert.equal(sendCalls, 2);
  assert.deepEqual(
    (env.DB as unknown as TestD1).sqlite
      .prepare("SELECT outcome, provider_message_id FROM portal_decision_confirmations")
      .all().map((row) => ({ ...row })),
    [{ outcome: "provider_accepted", provider_message_id: "gmail-message-portal-recovery" }],
  );

  await reconcileCustomerPortalDecisionAttempts(env, new Date("2026-08-21T21:02:00.000Z"), {
    ...deps,
    sendEmail: async () => {
      throw new Error("duplicate_send");
    },
  });
  assert.equal(sendCalls, 2);
});

test("portal customer lookup failures remain retryable errors, not no-recipient results", async () => {
  const env = await testEnv(false);
  await assert.rejects(
    recordPortalDecisionConfirmation(env, INPUT, {
      lookupRecipient: async () => {
        throw new Error("customer_store_unavailable");
      },
      now: () => NOW,
    }),
    /customer_store_unavailable/,
  );
  assert.equal(
    ((env.DB as unknown as TestD1).sqlite
      .prepare("SELECT COUNT(*) AS n FROM portal_decision_confirmations").get() as { n: number }).n,
    0,
  );
});
