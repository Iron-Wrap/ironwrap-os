import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";
import {
  CustomerQuoteRevisionInputSchema,
  buildCustomerQuoteRevisionDraft,
  buildServer,
} from "../src/server.mjs";

const sourceQuote = {
  name: "cq:1",
  customer_quote_id: "cq:1",
  roof_job: "job:1",
  customer: "customer:1",
  quote_version: 1,
  status: "Approved",
  price_book_version: "retail-2026-07",
  pricing_effective_at: "2026-07-10T12:00:00.000Z",
  quote_total: 25_000,
  currency: "CAD",
  valid_until: "2026-07-20",
  modified: "2026-07-10T12:05:00.000Z",
};
const baseArgs = {
  roof_job_id: "job:1",
  customer_quote_id: "cq:1",
  correction_reason: "A fresh field and supplier review is required.",
};

function json(data) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

function quoteReadMock({ source = sourceQuote, existingQuotes = [sourceQuote], targetExists = false, onPost } = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Customer%20Quote/cq%3A1")) return json(source);
    if (init.method === "GET" && target.includes("Customer%20Quote?")) return json(existingQuotes);
    if (init.method === "GET" && target.includes("Customer%20Quote/quote-revision%3Ajob-1-v")) {
      return targetExists ? json({ name: "quote-revision:job-1-v2" }) : new Response("missing", { status: 404 });
    }
    if (onPost) return onPost(target, init);
    throw new Error(`unexpected request ${init.method} ${target}`);
  };
}

test("quote revision draft is strict, version-safe, and never carries commercial facts forward", () => {
  assert.equal(CustomerQuoteRevisionInputSchema.safeParse(baseArgs).success, true);
  assert.equal(CustomerQuoteRevisionInputSchema.safeParse({ ...baseArgs, unexpected: true }).success, false);

  const draft = buildCustomerQuoteRevisionDraft({
    sourceQuote,
    roofJobId: "job:1",
    existingQuotes: [sourceQuote, { quote_version: 3 }],
    correctionReason: baseArgs.correction_reason,
  });
  assert.deepEqual(draft, {
    customer_quote_id: "quote-revision:job-1-v4",
    roof_job: "job:1",
    customer: "customer:1",
    quote_version: 4,
    status: "Draft",
    supersedes: "cq:1",
    correction_reason: baseArgs.correction_reason,
  });
  for (const field of [
    "price_book_version", "pricing_effective_at", "subtotal", "tax_amount", "tax_code",
    "tax_rate", "tax_policy_snapshot_json", "quote_total", "deposit_amount", "amount_due",
    "amount_paid", "balance_due", "payment_status", "payment_truth_source", "payment_truth_at",
    "valid_until", "scope_summary", "assumptions", "exclusions", "quote_summary_json",
    "approved_by", "approved_at", "acceptance_evidence", "contract_acceptance", "accepted_at",
  ]) assert.equal(field in draft, false, `${field} must not carry into a revision shell`);

  assert.throws(
    () => buildCustomerQuoteRevisionDraft({
      sourceQuote: { ...sourceQuote, status: "Accepted" },
      roofJobId: "job:1",
      correctionReason: baseArgs.correction_reason,
    }),
    /accepted_quote_revision_requires_change_order/,
  );
  assert.throws(
    () => buildCustomerQuoteRevisionDraft({
      sourceQuote: { ...sourceQuote, roof_job: "job:2" },
      roofJobId: "job:1",
      correctionReason: baseArgs.correction_reason,
    }),
    /customer_quote_roof_job_mismatch/,
  );
});

test("quote revision preview is receipt-safe and rejects an already-created deterministic target", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
  });
  assert.ok(server._registeredTools.dry_run_quote_revision);
  assert.ok(server._registeredTools.request_create_quote_revision);

  t.mock.method(globalThis, "fetch", quoteReadMock({
    existingQuotes: [sourceQuote, { ...sourceQuote, name: "cq:3", customer_quote_id: "cq:3", quote_version: 3 }],
  }));
  const preview = JSON.parse(
    (await server._registeredTools.dry_run_quote_revision.handler(baseArgs)).content[0].text,
  );
  assert.equal(preview.append_only, true);
  assert.equal(preview.source.modified, sourceQuote.modified);
  assert.equal(preview.draft.customer_quote_id, "quote-revision:job-1-v4");
  assert.equal(preview.draft.quote_version, 4);

  t.mock.method(globalThis, "fetch", quoteReadMock({ targetExists: true }));
  await assert.rejects(
    () => server._registeredTools.dry_run_quote_revision.handler(baseArgs),
    /quote_revision_append_only/,
  );

  t.mock.method(globalThis, "fetch", quoteReadMock({
    existingQuotes: Array.from({ length: 100 }, (_, index) => ({
      ...sourceQuote,
      name: `cq:${index + 1}`,
      customer_quote_id: `cq:${index + 1}`,
      quote_version: index + 1,
    })),
  }));
  await assert.rejects(
    () => server._registeredTools.dry_run_quote_revision.handler(baseArgs),
    /customer_quote_version_window_exceeded/,
  );
});

test("Customer Quote reads are strict projections, not a route to tax, payment, or acceptance internals", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
  });
  t.mock.method(globalThis, "fetch", quoteReadMock({
    source: {
      ...sourceQuote,
      tax_policy_snapshot_json: '{"rate":5}',
      amount_paid: 900,
      payment_truth_source: "QuickBooks",
      acceptance_evidence: "evidence:private",
      contract_acceptance: "acceptance:private",
      notes: "private estimator note",
    },
  }));
  const result = JSON.parse(
    (await server._registeredTools.get_customer_quote.handler({ customer_quote_id: "cq:1" })).content[0].text,
  ).data;
  assert.equal(result.customer_quote_id, "cq:1");
  assert.equal(result.quote_total, 25_000);
  for (const field of [
    "tax_policy_snapshot_json", "amount_paid", "payment_truth_source", "acceptance_evidence",
    "contract_acceptance", "notes",
  ]) assert.equal(field in result, false, `${field} must not leave the server`);
});

test("an approved quote revision command writes one audited Draft shell and stale source evidence fails closed", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "estimator-assistant",
    actorUser: "estimator@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "q".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  let quoteWrites = 0;
  let hermesRunPosts = 0;
  let source = { ...sourceQuote };
  const onPost = async (target, init) => {
    if (init.method === "GET" && target.includes("Hermes%20Run/run-quote-revision-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      hermesRunPosts += 1;
      return json({ name: "run-quote-revision-0001" });
    }
    if (init.method === "POST" && target.includes("Customer%20Quote")) {
      quoteWrites += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.status, "Draft");
      assert.equal(body.supersedes, "cq:1");
      assert.equal("quote_total" in body, false);
      assert.equal("tax_policy_snapshot_json" in body, false);
      assert.equal("accepted_at" in body, false);
      return json({ name: body.customer_quote_id });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-quote-revision-0001")) {
      return json({ name: "run-quote-revision-0001" });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => quoteReadMock({
    source,
    onPost,
  })(url, init));

  const initialPreview = JSON.parse(
    (await server._registeredTools.dry_run_quote_revision.handler(baseArgs)).content[0].text,
  );
  const writeArgs = {
    ...baseArgs,
    request_text: "Create a blank revision shell for a newly reviewed price and scope.",
    approved_by: "owner@example.com",
    run_id: "run-quote-revision-0001",
    dry_run_receipt: initialPreview.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_create_quote_revision",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "estimator-assistant",
    actor_user: "estimator@example.com",
    site_id: initialPreview.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  source = { ...source, modified: "2026-07-10T12:06:00.000Z" };
  await assert.rejects(
    () => server._registeredTools.request_create_quote_revision.handler(writeArgs),
    /dry_run_receipt_mismatch:preview_digest/,
  );
  assert.equal(quoteWrites, 0);

  source = { ...sourceQuote };
  const currentPreview = JSON.parse(
    (await server._registeredTools.dry_run_quote_revision.handler(baseArgs)).content[0].text,
  );
  writeArgs.dry_run_receipt = currentPreview.approval_request.dry_run_receipt;
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_create_quote_revision",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "estimator-assistant",
    actor_user: "estimator@example.com",
    site_id: currentPreview.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = JSON.parse(
    (await server._registeredTools.request_create_quote_revision.handler(writeArgs)).content[0].text,
  );
  assert.equal(result.created, true);
  assert.equal(result.quote_version, 2);
  assert.equal(result.audit_finalized, true);
  assert.equal(quoteWrites, 1);
  assert.equal(hermesRunPosts, 1);
});
