// The money desk's job reference: the D1 lookup it actually issues, and the eligibility seam.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  moneyIntentJobEligible,
  readMoneyIntentJobReference,
} from "../src/accounting-job-reference.ts";
import type { AppEnv } from "../src/app-types.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec(`
      CREATE TABLE operating_roof_jobs (
        roof_job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        job_status TEXT
      );
    `);
  }

  seed(roofJobId: string, tenantId = "ironwrap", jobStatus = "qualified"): void {
    this.raw.prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, job_status)
       VALUES (?, ?, ?)`,
    ).run(roofJobId, tenantId, jobStatus);
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
        };
      },
    };
  }
}

function env(db?: SqliteD1): AppEnv {
  return {
    APP_TENANT_ID: "ironwrap",
    ...(db ? { DB: db as never } : {}),
  } as AppEnv;
}

test("the job lookup reads one operating job by id for the configured tenant", async () => {
  const db = new SqliteD1();
  db.seed("job-0001", "ironwrap", "qualified");
  const job = await readMoneyIntentJobReference(env(db), "job-0001");
  assert.deepEqual(job, {
    name: "job-0001",
    roofJobId: "job-0001",
    jobStatus: "qualified",
  });
});

test("a job the operating core does not have reads as absent, not as an empty job", async () => {
  const db = new SqliteD1();
  assert.equal(await readMoneyIntentJobReference(env(db), "job-0002"), null);
});

test("a job belonging to another tenant is not the job that was asked for", async () => {
  const db = new SqliteD1();
  db.seed("job-0001", "other-tenant", "Won");
  assert.equal(await readMoneyIntentJobReference(env(db), "job-0001"), null);
});

test("a reference that is not a document name never reaches D1 at all", async () => {
  const db = new SqliteD1();
  let prepared = false;
  const original = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    prepared = true;
    return original(sql);
  }) as typeof db.prepare;
  assert.equal(
    await readMoneyIntentJobReference(env(db), '["Roof Job","name","like","%"]'),
    null,
  );
  assert.equal(prepared, false);
});

test("an unreachable operating core throws; it does not answer 'no such job'", async () => {
  await assert.rejects(
    () => readMoneyIntentJobReference({} as AppEnv, "job-0001"),
    /accounting_job_directory_unavailable/,
  );
  await assert.rejects(
    () => readMoneyIntentJobReference({ APP_TENANT_ID: "ironwrap" } as AppEnv, "job-0001"),
    /accounting_job_directory_unavailable/,
  );
});

test("today every existing job is eligible, whatever its status - the ruling is still open", async () => {
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
