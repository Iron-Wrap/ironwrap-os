// The money desk's job reference: the Frappe read it actually issues, and the eligibility seam.
//
// `accounting-api.test.ts` covers what the route does with each answer. This covers the answers
// themselves - which is where the two things worth getting wrong live: the request that reaches
// Frappe (one DocType, four fields, one filter), and the predicate whose semantics are still the
// architect's to rule on.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  moneyIntentJobEligible,
  readMoneyIntentJobReference,
} from "../src/accounting-job-reference.ts";
import type { AppEnv } from "../src/app-types.ts";

const FRAPPE_ENV = {
  ERPNEXT_BASE_URL: "https://frappe.example.invalid",
  ERPNEXT_API_KEY: "key",
  ERPNEXT_API_SECRET: "secret",
} as AppEnv;

/** Stand in for Frappe for one call, capturing the URL the reader really built. */
async function withFrappe<T>(
  rows: unknown,
  body: (seen: { url: string | null }) => Promise<T>,
): Promise<T> {
  const seen: { url: string | null } = { url: null };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.url = String(input);
    return new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

test("the job lookup asks for one job by name and only the four fields the desk may see", async () => {
  const job = await withFrappe(
    [{ name: "job-0001", roof_job_id: "RJ-0001", job_status: "Proposal", modified: "2026-08-19" }],
    async (seen) => {
      const result = await readMoneyIntentJobReference(FRAPPE_ENV, "job-0001");
      const url = new URL(seen.url!);
      assert.equal(url.pathname, "/api/resource/Roof%20Job");
      assert.deepEqual(JSON.parse(url.searchParams.get("fields")!), [
        "name",
        "roof_job_id",
        "job_status",
        "modified",
      ]);
      assert.deepEqual(JSON.parse(url.searchParams.get("filters")!), [
        ["Roof Job", "name", "=", "job-0001"],
      ]);
      assert.equal(url.searchParams.get("limit_page_length"), "1");
      return result;
    },
  );
  assert.deepEqual(job, { name: "job-0001", roofJobId: "RJ-0001", jobStatus: "Proposal" });
});

test("a job the operating core does not have reads as absent, not as an empty job", async () => {
  const missing = await withFrappe([], async () =>
    await readMoneyIntentJobReference(FRAPPE_ENV, "job-0002"),
  );
  assert.equal(missing, null);
});

test("a row that is not the job that was asked for is not the job that was asked for", async () => {
  // Frappe's `=` is the storage collation's `=`; the reader confirms the name it got back rather
  // than trusting that a single returned row must be the one it named.
  const other = await withFrappe(
    [{ name: "job-0009", roof_job_id: "RJ-0009", job_status: "Won", modified: "2026-08-19" }],
    async () => await readMoneyIntentJobReference(FRAPPE_ENV, "job-0001"),
  );
  assert.equal(other, null);
});

test("a reference that is not a document name never reaches Frappe at all", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await readMoneyIntentJobReference(FRAPPE_ENV, '["Roof Job","name","like","%"]'), null);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false);
});

test("an unreachable operating core throws; it does not answer 'no such job'", async () => {
  // The route turns this into `accounting_job_directory_unavailable`. Returning `null` here would
  // turn an outage into a `not_found`, which reads like a verdict about the job.
  await assert.rejects(
    () => readMoneyIntentJobReference({} as AppEnv, "job-0001"),
    /frappe_read_not_configured/,
  );
});

test("today every existing job is eligible, whatever its status - the ruling is still open", async () => {
  // Pinning the inherited behaviour on purpose. ELEC-112 finding 3 asked for the PO's judgement on
  // the intended gate; until it lands, existence is the whole predicate, and this test is what
  // turns red when somebody narrows it without the ruling.
  for (const jobStatus of ["Proposal", "Won", "In Production", "Lost", null]) {
    for (const kind of ["deposit_invoice", "progress_invoice"] as const) {
      assert.equal(
        moneyIntentJobEligible({ name: "job-0001", roofJobId: "RJ-0001", jobStatus }, kind),
        true,
        `${kind} against ${jobStatus}`,
      );
    }
  }
});
