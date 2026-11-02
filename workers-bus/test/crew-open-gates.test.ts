import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  crewOpenGatesForJob,
  CREW_SCHEDULING_GATES,
} from "../src/crew-open-gates.ts";
import type { AppEnv } from "../src/app-types.ts";

const TENANT = "ironwrap";
const JOB = "job:synthetic:gates";
const at = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((n) => /^\d{4}_.+\.sql$/.test(n))
    .sort()) {
    db.exec(
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async all() {
                return { results: db.prepare(sql).all(...(values as never[])) };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  function user(
    id: string,
    name: string,
    role = "production",
    options: {
      tenant?: string;
      alias?: string;
      active?: number;
      createdBy?: string;
    } = {},
  ) {
    db.prepare(
      `INSERT INTO app_users
      (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      options.tenant ?? TENANT,
      `${id}@example.invalid`,
      name,
      role === "field" ? "field" : "ops",
      role,
      options.alias ?? (role === "field" ? `${id}@example.invalid` : null),
      options.active ?? 1,
      options.createdBy ?? "owner@example.invalid",
      at(-1),
      at(-1),
    );
  }
  function competency(id: string, overrides: Record<string, unknown> = {}) {
    const suffix = randomBytes(8).toString("hex");
    const row: Record<string, unknown> = {
      readback_id: `readback.gates.${suffix}`,
      tenant_id: TENANT,
      authority_record_id: `competency_${id}`,
      authority_version: 1,
      subject_type: "Person",
      subject_role: "Worker",
      person_user: id,
      organization: null,
      authority_kind: "Worker Competency",
      authority_scope: "site_safety",
      scope_type: "Tenant",
      scope_ref: TENANT,
      roof_job: null,
      scope_json: "{}",
      issuer_name: TENANT,
      issuer_jurisdiction: "AB-CA",
      issuer_reference: "internal:competency:synthetic",
      issuer_source_version: "1",
      verification_state: "verified",
      evidence_refs_json: "[]",
      evidence_sha256: hash(`evidence:${suffix}`),
      authority_state_digest_sha256: hash(`state:${suffix}`),
      authority_effective_from: at(-30).slice(0, 10),
      authority_expires_at: at(30).slice(0, 10),
      authority_revoked_at: null,
      supersedes_authority_record_id: null,
      authority_verification_method: "Internal Competency Assessment",
      issuer_receipt_sha256: null,
      observed_by_user_id: "appu_owner_observer",
      observed_at: at(-1),
      observation_fingerprint_sha256: hash(`observed:${suffix}`),
      action_id: null,
      ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO authority_record_readbacks (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(...(keys.map((key) => row[key]) as never[]));
  }
  return { db, env, user, competency };
}
function source(open = "Materials", owner = "ironwrap-worker") {
  return {
    rows: CREW_SCHEDULING_GATES.map((gate) => ({
      gate,
      state: gate === open ? "blocked" : "ready",
      owner_user: owner,
    })),
    partial: false,
  };
}

test("crew projection distinguishes cleared, incomplete, unavailable and in-progress gates", async (t) => {
  const h = fixture();
  t.after(() => h.db.close());
  assert.deepEqual(
    await crewOpenGatesForJob(h.env, TENANT, JOB, source("none")),
    { open_gates: [], stale_fields: [] },
  );
  const incomplete = source();
  incomplete.rows.pop();
  assert.deepEqual(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, incomplete)).open_gates,
    null,
  );
  assert.deepEqual(
    (
      await crewOpenGatesForJob(h.env, TENANT, JOB, {
        ...source(),
        partial: true,
      })
    ).open_gates,
    null,
  );
  assert.deepEqual(
    (
      await crewOpenGatesForJob(h.env, TENANT, JOB, {
        ...source(),
        unavailable: true,
      })
    ).stale_fields,
    ["open_gates.unavailable"],
  );
  const working = source();
  working.rows[1]!.state = "in_progress";
  assert.deepEqual(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, working)).open_gates,
    [
      {
        gate: "Materials",
        label: "Materials",
        clearer_display_name: "The office",
      },
    ],
  );
  const invalid = source();
  invalid.rows[1]!.state = "unknown";
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, invalid)).open_gates,
    null,
  );
});

test("eligible assignee wins; holder counts use all people, with safe display-only fallbacks", async (t) => {
  const h = fixture();
  t.after(() => h.db.close());
  h.user("appu_owner_gates_01", "Zed Synthetic", "owner");
  h.user("appu_production_01", "Amy Synthetic");
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source())).open_gates?.[0]
      ?.clearer_display_name,
    "Amy Synthetic or Zed Synthetic",
  );
  h.user("appu_production_02", "Ben Synthetic");
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source())).open_gates?.[0]
      ?.clearer_display_name,
    "The office",
  );
  const selected = await crewOpenGatesForJob(
    h.env,
    TENANT,
    JOB,
    source("Materials", " APPU_OWNER_GATES_01@EXAMPLE.INVALID "),
  );
  assert.deepEqual(selected.open_gates, [
    {
      gate: "Materials",
      label: "Materials",
      clearer_display_name: "Zed Synthetic",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(selected),
    /appu_|@|owner_user|authority|evidence|role/,
  );
  h.user("appu_another_name01", "Zed Synthetic", "field");
  assert.equal(
    (
      await crewOpenGatesForJob(
        h.env,
        TENANT,
        JOB,
        source("Materials", "appu_owner_gates_01"),
      )
    ).open_gates?.[0]?.clearer_display_name,
    "The office",
  );
});

test("wrong role, inactive, QA seed, cross-tenant, and email-valued display names are not named", async (t) => {
  const h = fixture();
  t.after(() => h.db.close());
  h.user("appu_ops_gates_0001", "Operations Only", "ops");
  h.user("appu_inactive_0001", "Inactive", "production", { active: 0 });
  h.user("appu_seed_gates_001", "Seed", "owner", {
    createdBy: "system:owner_directed_qa_seed_grant",
  });
  h.user("appu_other_gates_01", "Other tenant", "owner", {
    tenant: "other-tenant",
  });
  let result = await crewOpenGatesForJob(
    h.env,
    TENANT,
    JOB,
    source("Materials", "appu_other_gates_01"),
  );
  assert.equal(result.open_gates?.[0]?.clearer_display_name, "The office");
  h.user("appu_email_name_001", "private@example.invalid");
  result = await crewOpenGatesForJob(
    h.env,
    TENANT,
    JOB,
    source("Materials", "appu_email_name_001"),
  );
  assert.equal(result.open_gates?.[0]?.clearer_display_name, "The office");
  assert.doesNotMatch(
    JSON.stringify(result),
    /@|Other tenant|Operations Only|Seed/,
  );
});

test("crew identity aliases exclude attesters, while Deposit remains an office settlement path", async (t) => {
  const h = fixture();
  t.after(() => h.db.close());
  h.user("appu_holder_gates01", "Casey Synthetic");
  h.user("appu_worker_gates01", "Crew Synthetic", "field", {
    alias: " APPU_HOLDER_GATES01 ",
  });
  h.db
    .prepare(
      `INSERT INTO fleet_crews (crew_id,tenant_id,display_name,status,version,created_at,updated_at)
    VALUES ('crew:synthetic',?,'Synthetic Crew','Active',1,?,?)`,
    )
    .run(TENANT, at(-1), at(-1));
  h.db
    .prepare(
      `INSERT INTO fleet_crew_members (membership_id,tenant_id,crew_id,user_id,active,version,created_at,updated_at)
    VALUES ('member:synthetic',?,'crew:synthetic','appu_worker_gates01',1,1,?,?)`,
    )
    .run(TENANT, at(-1), at(-1));
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Access")))
      .open_gates?.[0]?.clearer_display_name,
    "The office",
  );
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Deposit")))
      .open_gates?.[0]?.clearer_display_name,
    "Casey Synthetic",
  );
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Crew")))
      .open_gates?.[0]?.clearer_display_name,
    "The office",
  );
  // SQLite trims only ASCII spaces while the Worker trims Unicode whitespace. An unprovable
  // alias must not turn a crew member into a named independent attester.
  h.db
    .prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
    .run("\u00a0APPU_HOLDER_GATES01\u00a0", "appu_worker_gates01");
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Access")))
      .open_gates?.[0]?.clearer_display_name,
    "The office",
  );
});

test("Safety names only a current independent site-safety competency holder", async (t) => {
  const h = fixture();
  t.after(() => h.db.close());
  h.user("appu_owner_observer", "Observer Synthetic", "owner");
  h.user("appu_safety_gates01", "Safety Synthetic");
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Safety")))
      .open_gates?.[0]?.clearer_display_name,
    "The office",
  );
  h.competency("appu_safety_gates01");
  assert.deepEqual(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Safety")))
      .open_gates,
    [
      {
        gate: "Safety",
        label: "Safety check",
        clearer_display_name: "Safety Synthetic",
      },
    ],
  );
  h.competency("appu_safety_gates01", {
    authority_version: 2,
    authority_revoked_at: at(-1),
  });
  assert.equal(
    (await crewOpenGatesForJob(h.env, TENANT, JOB, source("Safety")))
      .open_gates?.[0]?.clearer_display_name,
    "The office",
  );
});

test("clearer read failure preserves every known open gate and marks the degraded projection", async () => {
  const env = {
    DB: {
      prepare() {
        throw new Error("synthetic directory unavailable");
      },
    },
  } as unknown as AppEnv;
  const result = await crewOpenGatesForJob(env, TENANT, JOB, source("Weather"));
  assert.deepEqual(result, {
    open_gates: [
      { gate: "Weather", label: "Weather", clearer_display_name: "The office" },
    ],
    stale_fields: ["open_gates.clearers_unavailable"],
  });
});
