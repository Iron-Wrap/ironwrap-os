// ELEC-132 defect B: a correct, fail-closed authority refusal reached the approving
// office user as an opaque `502 broker_mcp_call_ambiguous`. Frappe decided, said why, and
// every word of it was destroyed on the way out - `erpRequestDirect` dropped the response
// body, so the refusal became `erpnext_http_417: EXPECTATION FAILED`, which is not JSON,
// so `parseToolPayload` threw `mcp_tool_payload_invalid`, which the broker could only
// read as "the write may or may not have happened".
//
// The two bodies below are VERBATIM captures from a live local Frappe v15.114.0 stack
// (`docker compose -f deploy/local/docker-compose.yml`, site `ironwrap.localhost`) taken
// while proving this fix, not hand-written approximations. One is a real IronWrap
// `PolicyViolation`; the other is a Frappe framework error on the SAME 417 status, which
// is what keeps the classification honest: the traceback in `exc` must never travel.

import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAuditedWrite } from "../src/server.mjs";
import { parseToolPayload } from "../src/approval-contract.mjs";

/** POST /api/resource/Crew Profile - an Active crew with no members. */
const DOMAIN_REFUSAL_BODY = JSON.stringify({
  exception: "frappe.exceptions.ValidationError: [missing_crew_members] an active crew requires members",
  exc_type: "ValidationError",
  exc: '["Traceback (most recent call last):\\n  File \\"apps/frappe/frappe/app.py\\", line 120, in application\\n    raise exc\\n"]',
  _server_messages: JSON.stringify([
    JSON.stringify({
      message: "[missing_crew_members] an active crew requires members",
      title: "Message",
      indicator: "red",
      raise_exception: 1,
      __frappe_exc_id: "e4b5a597675edf5fae515ad30dbdec36066bdaf7d3549e10fa8177e6",
    }),
  ]),
});

/** The refusal this issue is actually about, in the same captured shape. */
const AUTHORITY_REFUSAL_MESSAGE =
  "[authority_missing_current_authority] authority_requirements_json: the exact tenant-scoped " +
  "Authority Record requirements are not satisfied: no current authority matches the exact tenant, " +
  "subject, kind, and scope: Worker Competency for crew@ironwrap.local scoped to Roof Job job:ELEC133-01";

const AUTHORITY_REFUSAL_BODY = JSON.stringify({
  exception: `frappe.exceptions.ValidationError: ${AUTHORITY_REFUSAL_MESSAGE}`,
  exc_type: "ValidationError",
  exc: '["Traceback (most recent call last):\\n  File \\"apps/ironwrap_roofing/document_validation.py\\", line 3967\\n"]',
  _server_messages: JSON.stringify([
    JSON.stringify({ message: AUTHORITY_REFUSAL_MESSAGE, title: "Message", indicator: "red", raise_exception: 1 }),
  ]),
});

/** POST /api/resource/Job Assignment with an unknown roof_job - 417, but not a decision. */
const FRAMEWORK_ERROR_BODY = JSON.stringify({
  exception: "frappe.exceptions.LinkValidationError: Could not find Roof Job: job:nope",
  exc_type: "LinkValidationError",
  exc: '["Traceback (most recent call last):\\n  File \\"apps/frappe/frappe/model/document.py\\", line 982, in _validate_links\\n"]',
  _server_messages: JSON.stringify([
    JSON.stringify({ message: "Could not find Roof Job: job:nope", title: "Message", indicator: "red" }),
  ]),
});

const CONFIG = { baseUrl: "https://erp.example", apiKey: "key", apiSecret: "secret" };

test("a domain refusal survives the Frappe boundary; a framework error does not", async (t) => {
  // The whole point of the narrow default: a caller must not learn Frappe's internals
  // from a failure. A `PolicyViolation` is not an internal - it is a sentence the domain
  // wrote for an operator, in a fixed shape - so it, and only it, is carried.
  const { erpPost } = await import("../src/server.mjs");

  for (const [label, body, expected] of [
    ["domain PolicyViolation", DOMAIN_REFUSAL_BODY, "missing_crew_members"],
    ["authority refusal", AUTHORITY_REFUSAL_BODY, "authority_missing_current_authority"],
    ["framework LinkValidationError", FRAMEWORK_ERROR_BODY, null],
  ]) {
    t.mock.method(globalThis, "fetch", async () =>
      new Response(body, { status: 417, statusText: "EXPECTATION FAILED", headers: { "content-type": "application/json" } }));
    const error = await erpPost(CONFIG, "/api/resource/Probe", {}).then(() => null, (err) => err);
    assert.ok(error, `${label} must reject`);
    assert.equal(error.domainRefusal?.code ?? null, expected, label);
    assert.equal(
      /Traceback|apps\/frappe|apps\/ironwrap_roofing/.test(JSON.stringify(error.domainRefusal ?? {})),
      false,
      `${label}: the traceback Frappe puts in exc must never travel`,
    );
  }
});

test("the authority refusal names the crew member and the certificate it wanted", async (t) => {
  const { erpPost } = await import("../src/server.mjs");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(AUTHORITY_REFUSAL_BODY, { status: 417, statusText: "EXPECTATION FAILED" }));

  const error = await erpPost(CONFIG, "/api/resource/Job%20Assignment", {}).then(() => null, (err) => err);
  const refusal = error.domainRefusal;
  assert.equal(refusal.code, "authority_missing_current_authority");
  // The field prefix travels inside the message rather than being split back out - see
  // DOMAIN_REFUSAL_PATTERN for why the wire format cannot tell a field from a message
  // that happens to start with a word and a colon.
  assert.match(refusal.message, /^authority_requirements_json: /);
  // This is the sentence the office approver has to be able to act on: which person,
  // which certificate, which job. Without it the fix is not worth having.
  assert.match(refusal.message, /Worker Competency/);
  assert.match(refusal.message, /crew@ironwrap\.local/);
  assert.match(refusal.message, /job:ELEC133-01/);
  // The log gets the same sentence; the narrow status prefix stays so every existing
  // `erpnext_http_<status>` match keeps working.
  assert.match(error.message, /^erpnext_http_417: EXPECTATION FAILED: \[authority_missing_current_authority\]/);
});

test("only a 417 may be a refusal, and only from a parseable body", async (t) => {
  const { erpPost } = await import("../src/server.mjs");
  // A 403, a 500 and an HTML error page all carry text; none of them is a decision the
  // domain made, and a 404 in particular is read by `readbackForEffect` as "not found"
  // rather than "refused".
  for (const [status, body] of [[403, DOMAIN_REFUSAL_BODY], [500, DOMAIN_REFUSAL_BODY], [404, DOMAIN_REFUSAL_BODY], [417, "<html>gateway</html>"]]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status, statusText: "FAILED" }));
    const error = await erpPost(CONFIG, "/api/resource/Probe", {}).then(() => null, (err) => err);
    assert.equal(error.domainRefusal, undefined, `status ${status} must stay opaque`);
    assert.equal(error.message, `erpnext_http_${status}: FAILED`);
  }
});

test("a refusal is only reportable when the audit trail proves nothing was written", async (t) => {
  // `mutation_applied: false` is the whole licence to call this a refusal rather than an
  // uncertain execution. It comes from the same place the Hermes Run failure record does,
  // so the two can never disagree.
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "GET") {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    if (String(url).includes("Job%20Assignment")) {
      return new Response(AUTHORITY_REFUSAL_BODY, { status: 417, statusText: "EXPECTATION FAILED" });
    }
    writes.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return Response.json({ data: { name: "hr_elec133_1" } });
  });

  const error = await executeAuditedWrite(CONFIG, {
    runId: "hr_elec133_1",
    now: "2026-08-21T08:00:00.000Z",
    args: {
      run_id: "hr_elec133_1",
      roof_job_id: "job:ELEC133-01",
      request_text: "schedule the metal crew",
      approved_by: "owner@ironwrap.local",
    },
    agentRole: "Production Controller",
    toolName: "request_create_job_assignment",
    target: { doctype: "Job Assignment", name: "assignment:elec133-01" },
    roofJob: "job:ELEC133-01",
    dryRun: { operation: "create" },
    beforeSummary: null,
    afterSummary: { assignment_id: "assignment:elec133-01" },
    execute: async () => {
      const { erpPost } = await import("../src/server.mjs");
      return await erpPost(CONFIG, "/api/resource/Job%20Assignment", {});
    },
    responseExtra: { created: true },
  }).then(() => null, (err) => err);

  assert.ok(error, "the refusal still aborts the write");
  assert.equal(error.domainRefusal.mutation_applied, false);
  assert.equal(error.domainRefusal.code, "authority_missing_current_authority");
  // The durable half of the same fact: the Hermes Run says the mutation did not apply.
  const failurePatch = writes.at(-1);
  assert.equal(failurePatch.body.approval_status, "Failed");
  assert.equal(failurePatch.body.mutation_applied, 0);
});

test("a refusal raised after the mutation applied is not a refusal", async (t) => {
  // A refusal from a LATER step cannot mean "nothing was written". The assignment insert
  // below SUCCEEDS; the failure comes after, once `mutationApplied` is already true. That
  // is a genuinely uncertain execution, and stripping the refusal here is what stops it
  // being reported to the approver as a confident decision.
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "GET") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return Response.json({ data: { name: "assignment:elec133-01" } });
  });

  const error = await executeAuditedWrite(CONFIG, {
    runId: "hr_elec133_2",
    now: "2026-08-21T08:00:00.000Z",
    args: { run_id: "hr_elec133_2", request_text: "schedule", approved_by: "owner@ironwrap.local" },
    agentRole: "Production Controller",
    toolName: "request_create_job_assignment",
    target: { doctype: "Job Assignment", name: "assignment:elec133-01" },
    dryRun: { operation: "create" },
    beforeSummary: null,
    // Runs after the write landed and after `mutationApplied` was set.
    afterSummary: () => {
      const applied = new Error("erpnext_http_417: EXPECTATION FAILED: [authority_authority_blocked] too late");
      applied.domainRefusal = { code: "authority_authority_blocked", message: "too late" };
      throw applied;
    },
    execute: async () => ({ name: "assignment:elec133-01" }),
    responseExtra: { created: true },
  }).then(() => null, (err) => err);

  assert.ok(error);
  assert.equal(error.domainRefusal, undefined, "a post-mutation refusal must not be reportable");
});

test("parseToolPayload never reads an errored result as a payload", () => {
  // It used to survive only by failing JSON.parse, which meant a well-formed error body
  // would have been read back as a successful write.
  assert.throws(
    () => parseToolPayload({ isError: true, content: [{ type: "text", text: JSON.stringify({ created: true }) }] }),
    /mcp_tool_call_failed/,
  );
  assert.throws(
    () => parseToolPayload({ isError: true, content: [{ type: "text", text: "Error: erpnext_http_500" }] }),
    /mcp_tool_call_failed/,
  );
});

test("parseToolPayload hands a structured refusal back as one", () => {
  let error;
  try {
    parseToolPayload({
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "domain_refusal",
          refusal: {
            code: "authority_missing_current_authority",
                    message: "Worker Competency for crew@ironwrap.local scoped to Roof Job job:ELEC133-01",
            mutation_applied: false,
          },
        }),
      }],
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(String(error), /mcp_tool_domain_refusal:authority_missing_current_authority/);
  assert.match(error.domainRefusal.message, /crew@ironwrap\.local/);
});

test("an envelope that does not prove non-application is not a refusal", () => {
  for (const refusal of [
    { code: "authority_missing_current_authority", message: "x", mutation_applied: true },
    { code: "authority_missing_current_authority", message: "x" },
    { message: "x", mutation_applied: false },
  ]) {
    assert.throws(
      () => parseToolPayload({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "domain_refusal", refusal }) }],
      }),
      /mcp_tool_call_failed/,
    );
  }
});
