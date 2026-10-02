import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { auth, request, setup } from "./pipeline-board-fixture.ts";
import {
  manualMeasurementResultSchema,
  manualMeasurementsResponseSchema,
} from "../../app/src/estimator/manual-measurement-contracts.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
const JOB = "job:board:0001";
const PATH = `/api/v1/estimator/jobs/${encodeURIComponent(JOB)}/manual-measurements`;
const key = () => `manual-measurement:${crypto.randomUUID()}`;
const input = {
  expected_job_version: 2,
  expected_observation_head: null,
  target: { new_area_label: "South roof" },
  area_sq_ft: 1200,
  area_basis: "roof_surface",
  pitch_rise_per_12: 6,
  method: "tape",
  uncertainty: "Eave obscured by gutter",
  correction_reason: null,
};
function fixture() {
  const f = setup();
  f.db.raw
    .prepare(
      "UPDATE operating_roof_jobs SET job_number=NULL, version=version+1 WHERE roof_job_id=?",
    )
    .run(JOB);
  // A D1 database serializes atomic batches; this SQLite adapter otherwise interleaves BEGINs.
  const original = f.db.batch.bind(f.db);
  let tail: Promise<unknown> = Promise.resolve();
  f.db.batch = (statements) => {
    const result = tail.then(() => original(statements));
    tail = result.catch(() => {});
    return result;
  };
  return f;
}
function post(
  f: ReturnType<typeof fixture>,
  id = key(),
  value: unknown = input,
  actor = auth("owner"),
  csrf = true,
) {
  return handleAuthenticatedRoute(
    request("POST", PATH, { body: value, idempotency: id, csrf }),
    f.env,
    actor,
  );
}
function get(f: ReturnType<typeof fixture>, query = "", actor = auth("owner")) {
  return handleAuthenticatedRoute(request("GET", PATH + query), f.env, actor);
}
async function saved(response: Response) {
  const json = await response.json();
  assert.ok([200, 201].includes(response.status), JSON.stringify(json));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return manualMeasurementResultSchema.parse(json);
}
async function read(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return manualMeasurementsResponseSchema.parse(await response.json());
}
function count(f: ReturnType<typeof fixture>, table: string) {
  return (
    f.db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }
  ).n;
}
const total = (f: ReturnType<typeof fixture>) =>
  (f.db.raw.prepare("SELECT total_changes() n").get() as { n: number }).n;

test("manual observations: numberless native job, strict app readback, server provenance and no other authority writes", async () => {
  const f = fixture();
  try {
    const untouched = [
      "measurement_intake_receipts",
      "native_measurement_revisions",
      "measurement_deltas",
      "commercial_quote_revisions",
      "operating_roof_jobs",
    ].map((t) => [t, count(f, t)] as const);
    const id = key();
    const result = await saved(await post(f, id));
    const observation = result.receipt.observation;
    assert.equal(result.replayed, false);
    assert.equal(observation.recorded_by, auth("owner").session.user_id);
    assert.equal(observation.revision, 1);
    assert.equal(
      result.receipt.request_hash,
      await sha256Hex(canonicalJson(input)),
    );
    const { sha256, ...facts } = observation;
    assert.equal(sha256, await sha256Hex(canonicalJson(facts)));
    const changes = total(f);
    const model = await read(
      await get(f, `?request_id=${encodeURIComponent(id)}`),
    );
    assert.equal(total(f), changes);
    assert.equal(model.job.job_number, null);
    assert.equal(model.job.version, 2);
    assert.equal(model.observation_head, observation.id);
    assert.deepEqual(model.areas, [observation]);
    assert.deepEqual(model.receipt, result.receipt);
    assert.deepEqual(
      (await read(await get(f, "", auth("sales")))).allowed_actions,
      [],
    );
    for (const [table, n] of untouched) assert.equal(count(f, table), n, table);
    assert.deepEqual(f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});

test("manual corrections preserve original facts and replay the original key after the head and job move", async () => {
  const f = fixture();
  try {
    const id = key();
    const first = await saved(await post(f, id));
    const old = first.receipt.observation;
    const correction = {
      ...input,
      expected_observation_head: old.id,
      target: { area_id: old.area_id },
      area_sq_ft: 1250,
      correction_reason: "Measured the hidden eave",
    };
    const next = await saved(await post(f, key(), correction, auth("ops")));
    const current = next.receipt.observation;
    assert.equal(current.revision, 2);
    assert.equal(current.supersedes_observation_id, old.id);
    assert.equal(current.area_id, old.area_id);
    const model = await read(await get(f));
    assert.deepEqual(model.areas, [current]);
    assert.deepEqual(model.history.items, [current, old]);
    f.db.raw
      .prepare(
        "UPDATE operating_roof_jobs SET version=version+1 WHERE roof_job_id=?",
      )
      .run(JOB);
    const before = total(f);
    const replay = await saved(await post(f, id));
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(replay.replayed, true);
    assert.equal(total(f), before);
    assert.equal(
      (await post(f, id, { ...input, area_sq_ft: 800 })).status,
      409,
    );
    assert.equal(
      (await get(f, `?request_id=${encodeURIComponent(id)}`, auth("ops")))
        .status,
      404,
    );
    for (const table of [
      "job_manual_observations",
      "job_manual_measurement_receipts",
    ]) {
      assert.throws(() => f.db.raw.exec(`DELETE FROM ${table}`), /immutable/);
      assert.throws(
        () => f.db.raw.exec(`UPDATE ${table} SET recorded_at='changed'`),
        /immutable/,
      );
    }
  } finally {
    f.db.close();
  }
});

test("manual command rejects roles, revoked actors, CSRF, tenant, missing job and malformed input before any write", async () => {
  const f = fixture();
  try {
    const before = total(f);
    for (const role of ["sales", "production", "field"] as const)
      assert.equal((await post(f, key(), input, auth(role))).status, 403);
    assert.equal(
      (await post(f, key(), input, auth("owner"), false)).status,
      403,
    );
    assert.equal(
      (await post(f, key(), input, auth("owner", "foreign"))).status,
      403,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            "POST",
            PATH.replace(encodeURIComponent(JOB), "job-missing"),
            { body: input, idempotency: key() },
          ),
          f.env,
          auth("owner"),
        )
      ).status,
      404,
    );
    for (const invalid of [
      { ...input, method: "" },
      { ...input, area_sq_ft: -2 },
      { ...input, pitch_rise_per_12: 25 },
      { ...input, area_sq_ft: null, pitch_rise_per_12: null },
      { ...input, source: "deterministic" },
      { ...input, uncertainty: "" },
      { ...input, expected_job_version: 1.5 },
      {
        ...input,
        target: { new_area_label: "x", area_id: `marea_${"a".repeat(64)}` },
      },
    ])
      assert.equal((await post(f, key(), invalid)).status, 400);
    assert.equal((await post(f, "bad-key")).status, 400);
    assert.equal(total(f), before);
    f.db.raw
      .prepare("UPDATE app_users SET active=0 WHERE user_id=?")
      .run(auth("owner").session.user_id);
    const revoked = total(f);
    assert.equal((await post(f)).status, 403);
    assert.equal(total(f), revoked);
  } finally {
    f.db.close();
  }
});

test("manual CAS refuses stale job/head, unknown area and missing correction reasons with no ledger writes", async () => {
  const f = fixture();
  try {
    const first = (await saved(await post(f))).receipt.observation;
    const before = total(f);
    assert.equal((await post(f)).status, 409);
    assert.equal(
      (await post(f, key(), { ...input, expected_job_version: 99 })).status,
      409,
    );
    assert.equal(
      (
        await post(f, key(), {
          ...input,
          expected_observation_head: first.id,
          target: { area_id: first.area_id },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(f, key(), {
          ...input,
          expected_observation_head: first.id,
          target: { area_id: `marea_${"f".repeat(64)}` },
          correction_reason: "Correct area",
        })
      ).status,
      404,
    );
    assert.equal(total(f), before);
    const duplicate = await post(f, key(), {
      ...input,
      expected_observation_head: first.id,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(count(f, "job_manual_observations"), 1);
  } finally {
    f.db.close();
  }
});

test("concurrent same-key writes replay once; competing new commands cannot fork the head", async () => {
  const f = fixture();
  try {
    const id = key();
    const same = await Promise.all([post(f, id), post(f, id)]);
    const results = await Promise.all(same.map(saved));
    assert.deepEqual(results[0].receipt, results[1].receipt);
    assert.equal(count(f, "job_manual_observations"), 1);
    const head = results[0].receipt.observation;
    const correction = {
      ...input,
      expected_observation_head: head.id,
      target: { area_id: head.area_id },
      correction_reason: "Rechecked the edge",
    };
    const racing = await Promise.all([
      post(f, key(), { ...correction, area_sq_ft: 1210 }),
      post(f, key(), { ...correction, area_sq_ft: 1220 }),
    ]);
    assert.deepEqual(racing.map((r) => r.status).sort(), [201, 409]);
    assert.equal(count(f, "job_manual_observations"), 2);
    assert.equal(count(f, "job_manual_measurement_receipts"), 2);
  } finally {
    f.db.close();
  }
});

test("failed receipt persistence rolls back observation and head; a fresh read then identical retry can recover", async () => {
  const f = fixture();
  try {
    f.db.raw.exec(
      "CREATE TRIGGER fail_manual_receipt BEFORE INSERT ON job_manual_measurement_receipts BEGIN SELECT RAISE(ABORT,'test storage failed'); END;",
    );
    const id = key();
    assert.equal((await post(f, id)).status, 503);
    assert.equal(count(f, "job_manual_observations"), 0);
    assert.equal(count(f, "job_manual_observation_heads"), 0);
    const model = await read(
      await get(f, `?request_id=${encodeURIComponent(id)}`),
    );
    assert.equal(model.receipt, null);
    assert.equal(model.observation_head, null);
    f.db.raw.exec("DROP TRIGGER fail_manual_receipt");
    const created = await saved(await post(f, id));
    assert.deepEqual(
      (await read(await get(f, `?request_id=${encodeURIComponent(id)}`)))
        .receipt,
      created.receipt,
    );
    assert.equal(count(f, "job_manual_observations"), 1);
  } finally {
    f.db.close();
  }
});

test("manual history traverses more than 25 revisions without gaps; exact receipt is independent of the history window", async () => {
  const f = fixture();
  try {
    const id = key();
    let last = (await saved(await post(f, id))).receipt.observation;
    const first = last;
    for (let i = 0; i < 27; i++)
      last = (
        await saved(
          await post(f, key(), {
            ...input,
            expected_observation_head: last.id,
            target: { area_id: last.area_id },
            area_sq_ft: 1201 + i,
            correction_reason: "Updated field observation",
          }),
        )
      ).receipt.observation;
    const current = await read(
      await get(f, `?request_id=${encodeURIComponent(id)}`),
    );
    assert.equal(current.history.items.length, 25);
    assert.equal(current.history.next_before, 4);
    assert.equal(current.receipt?.observation.id, first.id);
    const page = await read(await get(f, "?before=4"));
    assert.deepEqual(
      page.history.items.map((o) => o.sequence),
      [3, 2, 1],
    );
    assert.equal(page.history.next_before, null);
    assert.equal(page.areas[0].id, last.id);
    for (const query of [
      "?before=-1",
      "?before=1.5",
      "?before=1000001",
      "?request_id=bad",
      "?before=1&before=2",
      "?tenant=other",
    ])
      assert.equal((await get(f, query)).status, 400);
  } finally {
    f.db.close();
  }
});

test("manual read failure is unavailable and evidence drift is never an empty or trusted read", async () => {
  const f = fixture();
  try {
    const id = key();
    await saved(await post(f, id));
    f.db.raw.exec(
      "DROP TRIGGER job_manual_observation_no_update; UPDATE job_manual_observations SET area_sq_ft=500;",
    );
    assert.equal((await get(f)).status, 503);
    assert.equal(
      (await get(f, `?request_id=${encodeURIComponent(id)}`)).status,
      503,
    );
    assert.equal((await post(f, id)).status, 503);
  } finally {
    f.db.close();
  }
});

test("manual migration objects are present in both recovery inventories", () => {
  const migration = readFileSync(
    new URL("../migrations/0135_job_manual_measurements.sql", import.meta.url),
    "utf8",
  );
  const objects = [...migration.matchAll(/CREATE TABLE (\w+)/g)].map(
    (m) => m[1],
  );
  const indexes = [
    ...migration.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/g),
  ].map((m) => `${m[1]}=${m[2]}`);
  const triggers = [
    ...migration.matchAll(
      /CREATE TRIGGER (\w+) (?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE) ON (\w+)/g,
    ),
  ].map((m) => `${m[1]}=${m[2]}`);
  for (const file of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
    const source = readFileSync(
      new URL(`../../deploy/${file}`, import.meta.url),
      "utf8",
    );
    for (const item of [...objects, ...indexes, ...triggers])
      assert.ok(source.includes(item), `${file}: ${item}`);
  }
});

test("a freshly materialized office job records observations at version one without a job number", async () => {
  const { materializeOperatingCore } = await import("../src/operating-core.ts");
  const { getEnvelope } = await import("../src/store.ts");
  const f = fixture();
  try {
    f.db.raw
      .prepare(
        `INSERT INTO envelopes (envelope_id,source,contact_name,contact_email,payload_json,raw_key,ts,status,created_at,updated_at)
      VALUES ('ow_manual_fresh_fixture','manual','Synthetic Observer','manual-fresh@example.invalid','{}','raw/manual-fresh.json','2026-09-30T12:00:00.000Z','reconciled','2026-09-30T12:00:00.000Z','2026-09-30T12:00:00.000Z')`,
      )
      .run();
    const envelope = await getEnvelope(f.env, "ow_manual_fresh_fixture");
    const core = await materializeOperatingCore(f.env, envelope!);
    const path = `/api/v1/estimator/jobs/${encodeURIComponent(core.roofJobId)}/manual-measurements`;
    const initial = await read(
      await handleAuthenticatedRoute(
        request("GET", path),
        f.env,
        auth("owner"),
      ),
    );
    assert.equal(initial.job.version, 1);
    assert.equal(initial.job.job_number, null);
    const result = await saved(
      await handleAuthenticatedRoute(
        request("POST", path, {
          body: { ...input, expected_job_version: 1 },
          idempotency: key(),
        }),
        f.env,
        auth("owner"),
      ),
    );
    assert.equal(result.job_id, core.roofJobId);
    assert.equal(result.receipt.observation.job_version, 1);
  } finally {
    f.db.close();
  }
});

test("manual reads are tenant scoped even when the caller and configured tenant both differ from the stored job", async () => {
  const f = fixture();
  try {
    const id = key();
    await saved(await post(f, id));
    const before = total(f);
    const foreignEnv = { ...f.env, APP_TENANT_ID: "foreign" };
    const response = await handleAuthenticatedRoute(
      request("GET", `${PATH}?request_id=${encodeURIComponent(id)}`),
      foreignEnv,
      auth("owner", "foreign"),
    );
    assert.equal(response.status, 404);
    assert.equal(total(f), before);
    assert.equal((await get(f, "", auth("field"))).status, 403);
  } finally {
    f.db.close();
  }
});

test("manual transport bounds input bytes and enum types; recording rights remain explicit in session and read models", async () => {
  const { sessionPayload } = await import("../src/app-auth.ts");
  const f = fixture();
  try {
    const before = total(f);
    for (const invalid of [
      { ...input, method: ["tape"] },
      { ...input, area_basis: ["roof_surface"] },
    ])
      assert.equal((await post(f, key(), invalid)).status, 400);
    for (const [text, type, status] of [
      [" ".repeat(8193), "application/json", 413],
      ["{}", "text/plain", 415],
      ["{", "application/json", 400],
    ] as const) {
      const req = new Request(`https://app.example.invalid${PATH}`, {
        method: "POST",
        headers: {
          "content-type": type,
          "x-csrf-token": "csrf-token",
          "idempotency-key": key(),
        },
        body: text,
      });
      assert.equal(
        (await handleAuthenticatedRoute(req, f.env, auth("owner"))).status,
        status,
      );
    }
    assert.equal(total(f), before);
    for (const role of ["owner", "ops", "sales"] as const) {
      const expected = role !== "sales";
      const session = sessionPayload(auth(role), f.env);
      assert.equal(
        (session.permissions as string[]).includes("measurements:record"),
        expected,
      );
      assert.equal(
        (session.allowed_actions as string[]).includes(
          "manual_measurement.record",
        ),
        expected,
      );
    }
  } finally {
    f.db.close();
  }
});

test("a lost post-commit readback recovers the exact receipt without a second observation", async () => {
  const f = fixture();
  try {
    const originalBatch = f.db.batch.bind(f.db);
    const originalPrepare = f.db.prepare.bind(f.db);
    let committed = false;
    f.db.batch = async (statements) => {
      const result = await originalBatch(statements);
      committed = true;
      return result;
    };
    f.db.prepare = (sql) => {
      if (committed && sql.includes("FROM job_manual_measurement_receipts"))
        throw new Error("synthetic readback outage");
      return originalPrepare(sql);
    };
    const id = key();
    assert.equal((await post(f, id)).status, 503);
    assert.equal(count(f, "job_manual_observations"), 1);
    f.db.prepare = originalPrepare;
    const before = total(f);
    const recovered = await read(
      await get(f, `?request_id=${encodeURIComponent(id)}`),
    );
    assert.equal(recovered.receipt?.request_id, id);
    const replay = await saved(await post(f, id));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, recovered.receipt);
    assert.equal(total(f), before);
  } finally {
    f.db.close();
  }
});
