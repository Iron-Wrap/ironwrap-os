import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOLDBACK_NOT_IMPLEMENTED,
  HOLDBACK_PAYROLL_HTTP_STATUS,
  HOLDBACK_SLICE,
  PAYROLL_NOT_IMPLEMENTED,
  PAYROLL_SLICE,
  holdbackPayrollFailClosedRefusal,
  holdbackPayrollPostingTarget,
  isHoldbackPayrollIntentKind,
} from "../src/accounting-holdback-payroll-contract.ts";
import { apiTestEnv, call } from "./accounting-api-fixture.ts";

test("holdback and payroll kinds are the only fail-closed money leftovers", () => {
  assert.equal(isHoldbackPayrollIntentKind("holdback_release"), true);
  assert.equal(isHoldbackPayrollIntentKind("payroll_journal"), true);
  assert.equal(isHoldbackPayrollIntentKind("deposit_invoice"), false);
  assert.equal(holdbackPayrollPostingTarget(), null);
});

test("the contract refusal never invents a posting target or live acceptance", () => {
  const holdback = holdbackPayrollFailClosedRefusal("holdback_release");
  assert.deepEqual(holdback, {
    status: HOLDBACK_PAYROLL_HTTP_STATUS,
    error: HOLDBACK_NOT_IMPLEMENTED,
    slice: HOLDBACK_SLICE,
    live_accountant_acceptance: false,
    live_quickbooks_call: false,
    posting_target: null,
  });
  const payroll = holdbackPayrollFailClosedRefusal("payroll_journal");
  assert.equal(payroll.error, PAYROLL_NOT_IMPLEMENTED);
  assert.equal(payroll.slice, PAYROLL_SLICE);
  assert.equal(payroll.live_accountant_acceptance, false);
  assert.equal(payroll.live_quickbooks_call, false);
  assert.equal(payroll.posting_target, null);
});

test("deriving holdback or payroll fails closed with the named slice instead of posting", async () => {
  const { env } = apiTestEnv();
  const holdback = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: {
      kind: "holdback_release",
      roof_job_id: "job-0001",
      realm_id: "1234567890",
      customer_ref: "cust-1",
      item_ref: "item-1",
      tax_code_ref: "tax-1",
      subtotal: "1000.00",
      tax_amount: "50.00",
      txn_date: "2026-08-21",
      due_date: "2026-09-21",
      source_documents: ["quote:1"],
      jurisdiction: "CA-AB",
      tax_code: "GST",
    },
  });
  assert.equal(holdback.status, 501);
  assert.equal(holdback.body.error, HOLDBACK_NOT_IMPLEMENTED);
  assert.equal(holdback.body.slice, HOLDBACK_SLICE);
  assert.equal(holdback.body.live_accountant_acceptance, false);
  assert.equal(holdback.body.live_quickbooks_call, false);
  assert.equal(holdback.body.posting_target, null);

  const payroll = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: {
      kind: "payroll_journal",
      roof_job_id: "job-0001",
      realm_id: "1234567890",
      customer_ref: "cust-1",
      item_ref: "item-1",
      tax_code_ref: "tax-1",
      subtotal: "1000.00",
      tax_amount: "50.00",
      txn_date: "2026-08-21",
      due_date: "2026-09-21",
      source_documents: ["timesheet:1"],
      jurisdiction: "CA-AB",
      tax_code: "GST",
    },
  });
  assert.equal(payroll.status, 501);
  assert.equal(payroll.body.error, PAYROLL_NOT_IMPLEMENTED);
  assert.equal(payroll.body.slice, PAYROLL_SLICE);
  assert.equal(payroll.body.posting_target, null);
});
