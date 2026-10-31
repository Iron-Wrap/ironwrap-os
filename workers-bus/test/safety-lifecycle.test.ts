import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { seedStopPhoto } from "./safety-stop-photo-fixture.ts";

import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import { handleSafetyRoute } from "../src/safety-api.ts";
import {
  processSafetyDeviceAction,
  type SafetyDeviceActionSubmission,
} from "../src/safety-actions.ts";
import {
  assignCorrectiveAction,
  closeCorrectiveAction,
  evaluateSafetyReadiness,
  getSafetyEquipment,
  issueSafetyEquipment,
  recordEquipmentInspection,
  recordSafetyNotification,
  recordSafetyResponse,
  reportSafetyOccurrence,
  recordMakeSafe,
  safetyDeskProjection,
  safetyCorrectiveActionProjection,
  safetyPanelProjection,
  SafetyError,
  submitCorrectiveActionEvidence,
  validEvidenceRefsJson,
  submitSafetyNotification,
  verifyCorrectiveAction,
} from "../src/safety-lifecycle.ts";
import {
  safetyReadinessForScope,
  safetyReleaseGate,
} from "../src/safety-release-gate.ts";
import {
  fieldWorkPackageProjection,
  type FieldWorkPackage,
} from "../src/work-package.ts";

const TENANT = "ironwrap";
const NOW = "2026-08-17T12:00:00.000Z";
const RELEASE_PHOTO_ID = `evi_${"e".repeat(32)}`;
const LATER = "2026-08-17T13:00:00.000Z";

test("only canonical resolved upload refs may enter the receipt-enabled safety path", () => {
  const digest = "a".repeat(64);
  const canonical = `evidence-upload://evu_${digest}`;
  const refs = (ref: string) => JSON.stringify([{ ref, sha256: digest }]);
  assert.equal(validEvidenceRefsJson(refs(canonical)), false);
  assert.equal(validEvidenceRefsJson(refs(canonical), true), true);
  for (const alias of [` ${canonical}`, canonical.toUpperCase(), `evidence-upload://EVU_${digest}`]) {
    assert.equal(validEvidenceRefsJson(refs(alias), true), false);
  }
});

const USERS = {
  crew: {
    id: "appu_crew_member_0001",
    role: "field" as AppRole,
    access: "field",
  },
  mate: {
    id: "appu_crew_member_0002",
    role: "field" as AppRole,
    access: "field",
  },
  supervisor: {
    id: "appu_supervisor_0001",
    role: "ops" as AppRole,
    access: "production",
  },
  inspector: {
    id: "appu_shop_inspect_01",
    role: "ops" as AppRole,
    access: "shop",
  },
  auditor: {
    id: "appu_independent_001",
    role: "ops" as AppRole,
    access: "production",
  },
  owner: {
    id: "appu_owner_account01",
    role: "owner" as AppRole,
    access: "owner",
  },
} as const;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of readdirSync(
      new URL("../migrations/", import.meta.url),
    )
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      if (migration === "0038_app_access_roles.sql") {
        this.raw
          .prepare(
            `INSERT INTO app_users
               (user_id, tenant_id, email_normalized, display_name, role, active,
                created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'ops', 1, 'seed', ?, ?)`,
          )
          .run(
            "appu_legacy_ops_0001",
            TENANT,
            "legacy-ops@example.invalid",
            "Legacy Operations",
            "2026-08-13T11:59:00.000Z",
            "2026-08-13T11:59:00.000Z",
          );
      }
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const insert = this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role,
          frappe_user_id, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    for (const user of Object.values(USERS)) {
      insert.run(
        user.id,
        TENANT,
        `${user.id}@example.invalid`,
        user.id,
        user.role,
        user.access,
        `${user.id}@example.invalid`,
        NOW,
        NOW,
      );
    }
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  /** D1 runs a batch as one transaction: every statement commits, or none does. */
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

interface StoredObject {
  body: string;
  checksum: string;
}

function memoryObjects(): {
  store: Map<string, StoredObject>;
  objects: {
    ensure: (
      key: string,
      body: string,
      contentType: string,
      checksum: string,
    ) => Promise<void>;
  };
} {
  const store = new Map<string, StoredObject>();
  return {
    store,
    objects: {
      async ensure(key, body, _contentType, checksum) {
        const existing = store.get(key);
        if (existing) {
          if (existing.checksum !== checksum)
            throw new Error("immutable_object_conflict");
          return;
        }
        store.set(key, { body, checksum });
      },
    },
  };
}

/** Minimal immutable R2 stand-in: head reports the exact stored digest. */
function memoryBucket(store: Map<string, StoredObject>) {
  return {
    async head(key: string) {
      const stored = store.get(key);
      if (!stored) return null;
      const digest = Uint8Array.from(
        (stored.checksum.match(/../g) ?? []).map((byte) =>
          Number.parseInt(byte, 16),
        ),
      );
      return {
        size: new TextEncoder().encode(stored.body).byteLength,
        customMetadata: { sha256: stored.checksum },
        checksums: { sha256: digest.buffer },
      };
    },
    async put(
      key: string,
      body: string,
      options: { customMetadata?: { sha256?: string } },
    ) {
      store.set(key, { body, checksum: options.customMetadata?.sha256 ?? "" });
    },
  };
}

function env(db: SqliteD1, objects?: ReturnType<typeof memoryObjects>): AppEnv {
  const bucket = objects ?? memoryObjects();
  if (!db.raw.prepare("SELECT 1 FROM field_action_media WHERE evidence_id = ?").get(RELEASE_PHOTO_ID)) {
    seedStopPhoto(db.raw, { userId: USERS.crew.id, jobId: "JOB-A", evidenceId: RELEASE_PHOTO_ID, capturedAt: LATER });
  }
  return {
    DB: db as never,
    RAW: memoryBucket(bucket.store) as never,
    APP_TENANT_ID: TENANT,
    APP_ALLOW_INSECURE_LOCAL: "true",
  } as AppEnv;
}

function auth(user: { id: string; role: AppRole }): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(user.role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW,
      session_expires_at: LATER,
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      user_id: user.id,
      tenant_id: TENANT,
      email_normalized: `${user.id}@example.invalid`,
      display_name: user.id,
      role: user.role,
      frappe_user_id: `${user.id}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function request(
  path: string,
  body?: Record<string, unknown>,
  options: { csrf?: boolean; deviceActionId?: string } = {},
): Request {
  const headers = new Headers();
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf");
  if (body) headers.set("content-type", "application/json");
  if (options.deviceActionId)
    headers.set("x-device-action-id", options.deviceActionId);
  return new Request(`https://app.example.invalid${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function rejectionCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SafetyError) return error.code;
    return `unexpected:${String(error)}`;
  }
  return "no_rejection";
}

function occurrenceReport(overrides: Record<string, unknown> = {}) {
  return {
    occurrenceId: "so_ladder_slip_0001",
    tenantId: TENANT,
    occurrenceKind: "near_miss" as const,
    severity: "high" as const,
    scope: { type: "roof_job" as const, id: "JOB-A" },
    reportedByUserId: USERS.crew.id,
    reportedAt: NOW,
    summary: "Ladder slipped on the north elevation.",
    rescueRequired: false,
    evidence: null,
    capturedOffline: true,
    deviceActionId: null,
    now: NOW,
    ...overrides,
  };
}

test("reporting and making safe are worker rights that need no authority", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const reported = await reportSafetyOccurrence(app, occurrenceReport());
  assert.equal(reported.kind, "reported");
  assert.equal(reported.occurrence.state, "reported");
  assert.equal(reported.occurrence.stop_active, 1);

  const madeSafe = await recordMakeSafe(app, {
    tenantId: TENANT,
    occurrenceId: "so_ladder_slip_0001",
    actorUserId: USERS.crew.id,
    detail: "Barricaded the drop zone and removed the ladder.",
    evidence: null,
    capturedOffline: true,
    deviceActionId: null,
    occurredAt: NOW,
    now: LATER,
  });
  assert.equal(madeSafe.state, "made_safe");
  // Making safe never lifts the stop on its own.
  assert.equal(madeSafe.stop_active, 1);

  const events = db.raw
    .prepare(
      "SELECT event_kind, actor_role, captured_offline FROM safety_occurrence_events WHERE occurrence_id = ? ORDER BY occurrence_version",
    )
    .all("so_ladder_slip_0001") as Array<{
    event_kind: string;
    actor_role: string;
    captured_offline: number;
  }>;
  assert.deepEqual(
    events.map((row) => row.event_kind),
    ["reported", "make_safe"],
  );
  assert.equal(events[0]?.actor_role, "field");
  assert.equal(events[0]?.captured_offline, 1);
});

test("rescue command, control, release, and closure each require exact authority", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport({ rescueRequired: true }));
  await recordMakeSafe(app, {
    tenantId: TENANT,
    occurrenceId: "so_ladder_slip_0001",
    actorUserId: USERS.crew.id,
    detail: "Area secured.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: NOW,
    now: NOW,
  });
  for (const command of [
    "rescue_dispatched",
    "controlled",
    "released",
    "closed",
  ] as const) {
    assert.equal(
      await rejectionCode(() =>
        recordSafetyResponse(app, {
          tenantId: TENANT,
          occurrenceId: "so_ladder_slip_0001",
          actorUserId: USERS.crew.id,
          command,
          detail: "Crew attempted an authority command.",
          evidence: null,
          now: NOW,
        }),
      ),
      command === "rescue_dispatched"
        ? "safety_rescue_authority_required"
        : "safety_release_authority_required",
      `${command} must refuse a field actor`,
    );
  }
  // An unknown or deactivated identity is refused before any command runs.
  assert.equal(
    await rejectionCode(() =>
      recordSafetyResponse(app, {
        tenantId: TENANT,
        occurrenceId: "so_ladder_slip_0001",
        actorUserId: "appu_not_a_real_user1",
        command: "controlled",
        detail: "Ghost actor.",
        evidence: null,
        now: NOW,
      }),
    ),
    "safety_actor_unknown",
  );
});

test("a stop is released only after control and a completed required rescue", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(
    app,
    occurrenceReport({
      occurrenceKind: "emergency",
      severity: "critical",
      rescueRequired: true,
    }),
  );
  const step = async (
    actor: string,
    command: Parameters<typeof recordSafetyResponse>[1]["command"],
  ) =>
    await recordSafetyResponse(app, {
      tenantId: TENANT,
      occurrenceId: "so_ladder_slip_0001",
      actorUserId: actor,
      command,
      ...(command === "released" ? { evidenceIds: [RELEASE_PHOTO_ID] } : {}),
      detail: `Recorded ${command}.`,
      evidence: null,
      now: NOW,
    });
  await recordMakeSafe(app, {
    tenantId: TENANT,
    occurrenceId: "so_ladder_slip_0001",
    actorUserId: USERS.crew.id,
    detail: "Made safe.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: NOW,
    now: NOW,
  });
  await step(USERS.supervisor.id, "investigation_opened");
  await step(USERS.supervisor.id, "controlled");
  // The rescue was declared required and never completed, so the stop holds.
  assert.equal(
    await rejectionCode(() => step(USERS.supervisor.id, "released")),
    "safety_stop_release_not_permitted",
  );
  await step(USERS.supervisor.id, "rescue_completed");
  const released = await step(USERS.supervisor.id, "released");
  assert.equal(released.stop_active, 0);
  assert.equal(released.state, "controlled");
});

test("a duplicate offline report of the same event converges on one occurrence", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const first = await reportSafetyOccurrence(app, occurrenceReport());
  // A second device replays the same physical fact under a different id.
  const second = await reportSafetyOccurrence(
    app,
    occurrenceReport({ occurrenceId: "so_ladder_slip_0002" }),
  );
  assert.equal(first.kind, "reported");
  assert.equal(second.kind, "duplicate");
  assert.equal(second.occurrence.occurrence_id, "so_ladder_slip_0001");
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS count FROM safety_occurrences")
        .get() as {
        count: number;
      }
    ).count,
    1,
  );
});

test("failed PPE inspection quarantines the item and blocks its holder", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-0001",
    assignedUserId: USERS.crew.id,
    inspectionIntervalDays: 180,
    actorUserId: USERS.inspector.id,
    now: NOW,
  });
  // No inspection recorded yet is the same fact as an expired one for a gate.
  const unproven = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [{ type: "roof_job", id: "JOB-A" }],
    subjectUserIds: [USERS.crew.id],
    now: NOW,
  });
  assert.equal(unproven.ready, false);
  assert.deepEqual(
    unproven.blockers.map((blocker) => blocker.code),
    ["safety_equipment_unserviceable"],
  );

  const passed = await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    actorUserId: USERS.inspector.id,
    result: "pass",
    detail: "Webbing, stitching, and hardware verified.",
    evidence: null,
    expectedVersion: 1,
    now: NOW,
  });
  assert.equal(passed.status, "in_service");
  assert.equal(
    (
      await evaluateSafetyReadiness(app, {
        tenantId: TENANT,
        scopes: [{ type: "roof_job", id: "JOB-A" }],
        subjectUserIds: [USERS.crew.id],
        now: NOW,
      })
    ).ready,
    true,
  );

  const failed = await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    actorUserId: USERS.inspector.id,
    result: "fail",
    detail: "Cut through the leg strap webbing.",
    evidence: null,
    expectedVersion: 2,
    now: LATER,
  });
  assert.equal(failed.status, "quarantined");
  const blocked = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [{ type: "roof_job", id: "JOB-A" }],
    subjectUserIds: [USERS.crew.id],
    now: LATER,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers[0]?.code, "safety_equipment_unserviceable");
  assert.equal(blocked.blockers[0]?.subject_id, "eq_harness_0001");

  // A field worker may condemn equipment but never certify it.
  assert.equal(
    await rejectionCode(() =>
      recordEquipmentInspection(app, {
        tenantId: TENANT,
        equipmentId: "eq_harness_0001",
        actorUserId: USERS.crew.id,
        result: "pass",
        detail: "Looks fine to me.",
        evidence: null,
        expectedVersion: 3,
        now: LATER,
      }),
    ),
    "safety_inspection_authority_required",
  );
});

test("an overdue high-risk corrective action blocks its scope", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "high",
    ownerUserId: USERS.mate.id,
    dueAt: "2026-08-16T12:00:00.000Z",
    description: "Install a permanent ladder tie-off point.",
    recurrenceOfId: null,
    actorUserId: USERS.supervisor.id,
    now: NOW,
  });
  const readiness = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [{ type: "roof_job", id: "JOB-A" }],
    subjectUserIds: [],
    now: NOW,
  });
  assert.equal(readiness.ready, false);
  assert.ok(
    readiness.blockers.some(
      (blocker) =>
        blocker.code === "safety_corrective_action_overdue" &&
        blocker.subject_id === "ca_ladder_control01",
    ),
    "an overdue high-risk action must appear as its own blocker",
  );
});

test("the reporter, owner, and evidence capturer cannot verify a closure", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(
    app,
    occurrenceReport({ reportedByUserId: USERS.crew.id }),
  );
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "critical",
    ownerUserId: USERS.auditor.id,
    dueAt: "2026-08-30T12:00:00.000Z",
    description: "Retrain the crew on ladder placement.",
    recurrenceOfId: null,
    actorUserId: USERS.owner.id,
    now: NOW,
  });
  const evidence = {
    refsJson: JSON.stringify([
      { ref: "r2://safety/retraining.pdf", sha256: "b".repeat(64) },
    ]),
    sha256: "c".repeat(64),
  };
  await submitCorrectiveActionEvidence(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    actorUserId: USERS.owner.id,
    evidence,
    detail: "Attendance sheet and competency check.",
    now: NOW,
  });
  // Owner of the fix, the evidence capturer, and the occurrence reporter are
  // each excluded, even though every one of them holds verification authority.
  assert.equal(
    await rejectionCode(() =>
      verifyCorrectiveAction(app, {
        tenantId: TENANT,
        correctiveActionId: "ca_ladder_control01",
        actorUserId: USERS.auditor.id,
        verdict: "verified",
        detail: "Self-verification attempt.",
        now: LATER,
      }),
    ),
    "safety_verification_separation_required",
  );
  assert.equal(
    await rejectionCode(() =>
      verifyCorrectiveAction(app, {
        tenantId: TENANT,
        correctiveActionId: "ca_ladder_control01",
        actorUserId: USERS.owner.id,
        verdict: "verified",
        detail: "Capturer verification attempt.",
        now: LATER,
      }),
    ),
    "safety_verification_separation_required",
  );
  // A field worker holds no verification authority at all.
  assert.equal(
    await rejectionCode(() =>
      verifyCorrectiveAction(app, {
        tenantId: TENANT,
        correctiveActionId: "ca_ladder_control01",
        actorUserId: USERS.crew.id,
        verdict: "verified",
        detail: "Crew verification attempt.",
        now: LATER,
      }),
    ),
    "safety_verification_authority_required",
  );

  // Someone who touched none of it may verify, and only then may it close.
  const verified = await verifyCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    actorUserId: USERS.supervisor.id,
    verdict: "verified",
    detail: "Independent check of retraining records.",
    now: LATER,
  });
  assert.equal(verified.state, "verified");
  assert.equal(verified.verified_by_user_id, USERS.supervisor.id);
  const closed = await closeCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    actorUserId: USERS.supervisor.id,
    detail: "Closed on independent verification.",
    now: LATER,
  });
  assert.equal(closed.state, "closed");
});

test("an occurrence reporter with full production authority still cannot verify", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(
    app,
    occurrenceReport({ reportedByUserId: USERS.supervisor.id }),
  );
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_reporter_block01",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "high",
    ownerUserId: USERS.mate.id,
    dueAt: "2026-08-30T12:00:00.000Z",
    description: "Replace the damaged ladder.",
    recurrenceOfId: null,
    actorUserId: USERS.auditor.id,
    now: NOW,
  });
  await submitCorrectiveActionEvidence(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_reporter_block01",
    actorUserId: USERS.mate.id,
    evidence: {
      refsJson: JSON.stringify([
        { ref: "r2://safety/ladder.jpg", sha256: "b".repeat(64) },
      ]),
      sha256: "c".repeat(64),
    },
    detail: "New ladder photographed on site.",
    now: NOW,
  });
  // The supervisor holds production authority and is untouched by the fix, but
  // reported the occurrence, so separation of duties still refuses.
  assert.equal(
    await rejectionCode(() =>
      verifyCorrectiveAction(app, {
        tenantId: TENANT,
        correctiveActionId: "ca_reporter_block01",
        actorUserId: USERS.supervisor.id,
        verdict: "verified",
        detail: "Reporter verification attempt.",
        now: LATER,
      }),
    ),
    "safety_verification_separation_required",
  );
  const verified = await verifyCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_reporter_block01",
    actorUserId: USERS.auditor.id,
    verdict: "verified",
    detail: "Independent check of the replacement ladder.",
    now: LATER,
  });
  assert.equal(verified.verified_by_user_id, USERS.auditor.id);
});

test("safety records are additive: events refuse update and delete", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE safety_occurrence_events SET detail = 'rewritten' WHERE occurrence_id = ?",
        )
        .run("so_ladder_slip_0001"),
    /safety_occurrence_events_append_only/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare("DELETE FROM safety_occurrence_events WHERE occurrence_id = ?")
        .run("so_ladder_slip_0001"),
    /safety_occurrence_events_retained/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare("DELETE FROM safety_occurrences WHERE occurrence_id = ?")
        .run("so_ladder_slip_0001"),
    /safety_occurrences_retained/,
  );
});

test("a release gate records an immutable snapshot of exactly what it saw", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  const blocked = await safetyReleaseGate(app, {
    tenantId: TENANT,
    scope: { type: "roof_job", id: "JOB-A" },
    jobId: "JOB-A",
    subjectUserIds: [],
    consumer: "work_package_release",
    evaluatedByUserId: USERS.supervisor.id,
    decisionRef: "decision-0001",
    now: NOW,
  });
  assert.equal(blocked.readiness.ready, false);
  assert.equal(blocked.readiness.blockers[0]?.code, "safety_stop_active");
  const snapshot = db.raw
    .prepare(
      "SELECT ready, blocker_codes, consumer FROM safety_readiness_snapshots WHERE snapshot_id = ?",
    )
    .get(blocked.snapshot_id) as {
    ready: number;
    blocker_codes: string;
    consumer: string;
  };
  assert.equal(snapshot.ready, 0);
  assert.equal(snapshot.blocker_codes, "safety_stop_active");
  assert.equal(snapshot.consumer, "work_package_release");
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE safety_readiness_snapshots SET ready = 1 WHERE snapshot_id = ?",
        )
        .run(blocked.snapshot_id),
    /safety_readiness_snapshots_append_only/,
  );
});

test("a tenant-wide stop reaches every job below it", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(
    app,
    occurrenceReport({
      occurrenceKind: "environmental",
      scope: { type: "tenant", id: TENANT },
      summary: "Lightning within five kilometres of all active sites.",
    }),
  );
  const readiness = await safetyReadinessForScope(app, {
    tenantId: TENANT,
    scope: { type: "work_package", id: "WP-99" },
    jobId: "JOB-Z",
    subjectUserIds: [],
    now: NOW,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockers[0]?.code, "safety_stop_active");
});

test("the offline safety action rail works with no work package and replays idempotently", async () => {
  const db = new SqliteD1();
  const objects = memoryObjects();
  const app = env(db, objects);
  const submission: SafetyDeviceActionSubmission = {
    deviceActionId: "dev-safety-0000001",
    kind: "report_occurrence",
    scope: { type: "roof_job", id: "JOB-A" },
    capturedAt: "2026-08-17T11:45:00.000Z",
    payload: {
      detail: "Unguarded skylight opening on the east slope.",
      occurrence_kind: "hazard",
      severity: "critical",
    },
  };
  const first = await processSafetyDeviceAction(
    app,
    auth(USERS.crew),
    submission,
    {
      objects: objects.objects,
      now: () => new Date(NOW),
      randomId: () => "token-1",
    },
  );
  assert.equal(first.status, "verified");
  // The same device action replays to the identical response, not a second
  // incident, and the R2 manifest is written exactly once.
  const replay = await processSafetyDeviceAction(
    app,
    auth(USERS.crew),
    submission,
    {
      objects: objects.objects,
      now: () => new Date(NOW),
      randomId: () => "token-2",
    },
  );
  assert.deepEqual(replay, first);
  assert.equal(objects.store.size, 1);
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS count FROM safety_occurrences")
        .get() as {
        count: number;
      }
    ).count,
    1,
  );
  // The same device action id bound to different content is a conflict, never
  // a silent overwrite of the original safety report.
  assert.equal(
    await rejectionCode(() =>
      processSafetyDeviceAction(
        app,
        auth(USERS.crew),
        {
          ...submission,
          payload: {
            ...submission.payload,
            detail: "Something else entirely.",
          },
        },
        {
          objects: objects.objects,
          now: () => new Date(NOW),
          randomId: () => "token-3",
        },
      ),
    ),
    "idempotency_conflict",
  );
});

test("a forward-dated device clock cannot create a future safety record", async () => {
  const db = new SqliteD1();
  const objects = memoryObjects();
  const app = env(db, objects);
  await processSafetyDeviceAction(
    app,
    auth(USERS.crew),
    {
      deviceActionId: "dev-safety-0000002",
      kind: "rescue_request",
      scope: { type: "roof_job", id: "JOB-A" },
      capturedAt: "2027-01-01T00:00:00.000Z",
      payload: {
        detail: "Worker suspended in harness on the north elevation.",
      },
    },
    {
      objects: objects.objects,
      now: () => new Date(NOW),
      randomId: () => "token-1",
    },
  );
  const occurrence = db.raw
    .prepare(
      "SELECT occurrence_kind, severity, rescue_required, reported_at, stop_active FROM safety_occurrences",
    )
    .get() as {
    occurrence_kind: string;
    severity: string;
    rescue_required: number;
    reported_at: string;
    stop_active: number;
  };
  assert.equal(occurrence.occurrence_kind, "emergency");
  assert.equal(occurrence.severity, "critical");
  assert.equal(occurrence.rescue_required, 1);
  assert.equal(occurrence.stop_active, 1);
  assert.equal(occurrence.reported_at, NOW);
});

test("the global safety panel is reachable by a field worker with no assignment", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const response = await handleSafetyRoute(
    request("/api/v1/safety/panel"),
    app,
    auth(USERS.crew),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    panel: { allowed_actions: string[] };
  };
  assert.deepEqual(payload.panel.allowed_actions, [
    "safety.report_occurrence",
    "safety.make_safe",
    "safety.equipment_defect",
    "safety.rescue_request",
  ]);

  const supervisorPanel = await safetyPanelProjection(
    app,
    TENANT,
    USERS.supervisor.id,
  );
  assert.ok(supervisorPanel.allowed_actions.includes("safety.rescue_command"));
  assert.ok(
    supervisorPanel.allowed_actions.includes("safety.verify_corrective_action"),
  );
  assert.ok(
    !supervisorPanel.allowed_actions.includes("safety.notify_authority"),
  );
});

test("the replayed offline envelope reaches the safety rail through the route", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const envelope = {
    device_action_id: "dev-outbox-0000001",
    payload: {
      kind: "make_safe",
      scope_type: "roof_job",
      scope_id: "JOB-A",
      captured_at: "2026-08-17T11:30:00.000Z",
      occurrence_id: "so_ladder_slip_0001",
      detail: "Coned off the drop zone before leaving the roof.",
    },
  };
  await reportSafetyOccurrence(app, occurrenceReport());
  const first = await handleSafetyRoute(
    request("/api/v1/safety/actions", envelope, {
      deviceActionId: "dev-outbox-0000001",
    }),
    app,
    auth(USERS.crew),
  );
  assert.equal(first?.status, 200);
  const verified = (await first?.json()) as {
    status: string;
    server_ref: string;
  };
  assert.equal(verified.status, "verified");
  assert.equal(verified.server_ref, "so_ladder_slip_0001");

  // The outbox replays the identical envelope after a dropped response.
  const replay = await handleSafetyRoute(
    request("/api/v1/safety/actions", envelope, {
      deviceActionId: "dev-outbox-0000001",
    }),
    app,
    auth(USERS.crew),
  );
  assert.equal(replay?.status, 200);
  assert.deepEqual(await replay?.json(), verified);
  assert.equal(
    (
      db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM safety_occurrence_events WHERE event_kind = 'make_safe'",
        )
        .get() as { count: number }
    ).count,
    1,
  );

  // A device action id header that disagrees with the body is refused.
  const mismatched = await handleSafetyRoute(
    request("/api/v1/safety/actions", envelope, {
      deviceActionId: "dev-outbox-0000002",
    }),
    app,
    auth(USERS.crew),
  );
  assert.equal(mismatched?.status, 400);
  assert.deepEqual(await mismatched?.json(), {
    error: "invalid_safety_action",
    message: "The safety action is invalid.",
  });
});

// A raise is never refused for the scope it names. When that scope is not a job, Work Package or
// tenant of this tenant, the stop is recorded and active as always, and the answer says so.

const SCOPE_SEED_AT = "2026-08-17T10:00:00.000Z";
const OTHER_TENANT = "other-tenant";

/** A native job, with the envelope, lead and customer its keys need, in the given tenant. */
function seedRoofJob(db: SqliteD1, roofJobId: string, tenantId = TENANT): void {
  const at = SCOPE_SEED_AT;
  // ON CONFLICT skips only a row seeded earlier; a CHECK the seed breaks still fails loudly.
  db.raw
    .prepare(
      `INSERT INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at)
       VALUES ('env-scope-seed', 'website', '{}', ?, 'received', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(at, at, at);
  db.raw
    .prepare(
      `INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, created_at, updated_at)
       VALUES (?, ?, 'env-scope-seed', 'website', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(`lead-${tenantId}`, tenantId, at, at);
  db.raw
    .prepare(
      `INSERT INTO operating_customers
         (customer_id, tenant_id, source_envelope_id, display_name, contact_email, created_at, updated_at)
       VALUES (?, ?, 'env-scope-seed', 'Synthetic Customer', ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(`customer-${tenantId}`, tenantId, `customer-${tenantId}@example.invalid`, at, at);
  db.raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, service_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'env-scope-seed', 'Metal re-roof', ?, ?)`,
    )
    .run(roofJobId, tenantId, `lead-${tenantId}`, `customer-${tenantId}`, at, at);
}

/** A released first version of a Work Package; its definition repeats the row, as D1 requires. */
function seedWorkPackage(db: SqliteD1, workPackageId: string, tenantId = TENANT): void {
  const definition = {
    work_package_id: workPackageId,
    tenant_id: tenantId,
    version: 1,
    job_id: "job-scope-0001",
    assignment_id: "assignment-scope-0001",
    work_object_type: "Roof Job",
    work_object_id: "job-scope-0001",
    physical_context_type: "Roof Site",
    physical_context_id: "job-scope-0001",
    title: "Tear off the north slope",
    objective: "Remove the old shingles from the north slope.",
    boundaries: "North slope only.",
    prerequisites: "Anchors installed and inspected.",
    expected_result: "Deck bare and swept.",
    stop_conditions: "Lightning within ten kilometres.",
    make_safe_procedure: "Tarp the open deck and clear the drop zone.",
    issued_at: SCOPE_SEED_AT,
    expires_at: "2026-08-18T10:00:00.000Z",
    released_at: SCOPE_SEED_AT,
    release_attempt_id: "release-scope-0001",
  };
  const row = { ...definition, status: "Released", created_at: SCOPE_SEED_AT, updated_at: SCOPE_SEED_AT };
  db.raw
    .prepare(
      `INSERT INTO work_packages (${Object.keys(row).join(", ")}, definition_json)
       VALUES (${Object.keys(row).map(() => "?").join(", ")}, ?)`,
    )
    .run(...Object.values(row), JSON.stringify(definition));
}

/** The offline envelope a raise replays to the route, as the PWA outbox sends it. */
function raiseEnvelope(
  deviceActionId: string,
  scope: { type: string; id: string },
  kind: "report_occurrence" | "rescue_request" = "report_occurrence",
) {
  return {
    device_action_id: deviceActionId,
    payload: {
      kind,
      scope_type: scope.type,
      scope_id: scope.id,
      captured_at: "2026-08-17T11:45:00.000Z",
      detail: "Unguarded skylight opening on the east slope.",
      ...(kind === "report_occurrence" ? { occurrence_kind: "hazard", severity: "high" } : {}),
    },
  };
}

async function raise(
  app: AppEnv,
  envelope: ReturnType<typeof raiseEnvelope>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleSafetyRoute(
    request("/api/v1/safety/actions", envelope, { deviceActionId: envelope.device_action_id }),
    app,
    auth(USERS.crew),
  );
  assert.ok(response);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The recorded stop behind a raise's answer. */
function raisedStop(db: SqliteD1, body: Record<string, unknown>) {
  return db.raw
    .prepare(
      "SELECT state, stop_active, scope_type, scope_id FROM safety_occurrences WHERE occurrence_id = ?",
    )
    .get(String(body.server_ref));
}

test("a raise on a job that exists answers scope_unresolved false", async () => {
  const db = new SqliteD1();
  const app = env(db);
  seedRoofJob(db, "job-scope-0001");
  const raised = await raise(app, raiseEnvelope("dev-scope-job-0001", { type: "roof_job", id: "job-scope-0001" }));
  assert.equal(raised.status, 200);
  assert.equal(raised.body.status, "verified");
  assert.equal(raised.body.scope_unresolved, false);
});

test("a raise naming a job this tenant does not have is recorded, active and flagged", async () => {
  const db = new SqliteD1();
  const app = env(db);
  seedRoofJob(db, "job-scope-0001");
  seedRoofJob(db, "job-other-0001", OTHER_TENANT);
  for (const [deviceActionId, jobId, kind] of [
    ["dev-scope-nojob-0001", "job-missing-0001", "report_occurrence"],
    ["dev-scope-nojob-0002", "job-other-0001", "rescue_request"],
  ] as const) {
    const raised = await raise(app, raiseEnvelope(deviceActionId, { type: "roof_job", id: jobId }, kind));
    assert.equal(raised.status, 200, jobId);
    assert.equal(raised.body.status, "verified", jobId);
    assert.equal(raised.body.scope_unresolved, true, jobId);
    assert.deepEqual(
      { ...raisedStop(db, raised.body) },
      { state: "reported", stop_active: 1, scope_type: "roof_job", scope_id: jobId },
    );
  }
});

test("a raise on a Work Package that exists answers scope_unresolved false", async () => {
  const db = new SqliteD1();
  const app = env(db);
  seedWorkPackage(db, "wp-scope-0001");
  const raised = await raise(app, raiseEnvelope("dev-scope-wp-0001", { type: "work_package", id: "wp-scope-0001" }));
  assert.equal(raised.status, 200);
  assert.equal(raised.body.status, "verified");
  assert.equal(raised.body.scope_unresolved, false);
});

test("a raise naming a Work Package this tenant does not have is recorded, active and flagged", async () => {
  const db = new SqliteD1();
  const app = env(db);
  seedWorkPackage(db, "wp-scope-0001");
  seedWorkPackage(db, "wp-other-0001", OTHER_TENANT);
  for (const [deviceActionId, workPackageId, kind] of [
    ["dev-scope-nowp-0001", "wp-missing-0001", "report_occurrence"],
    ["dev-scope-nowp-0002", "wp-other-0001", "rescue_request"],
  ] as const) {
    const raised = await raise(
      app,
      raiseEnvelope(deviceActionId, { type: "work_package", id: workPackageId }, kind),
    );
    assert.equal(raised.status, 200, workPackageId);
    assert.equal(raised.body.status, "verified", workPackageId);
    assert.equal(raised.body.scope_unresolved, true, workPackageId);
    assert.deepEqual(
      { ...raisedStop(db, raised.body) },
      { state: "reported", stop_active: 1, scope_type: "work_package", scope_id: workPackageId },
    );
  }
});

test("a tenant raise resolves only to this tenant's own id", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const own = await raise(app, raiseEnvelope("dev-scope-tenant-0001", { type: "tenant", id: TENANT }));
  assert.equal(own.status, 200);
  assert.equal(own.body.scope_unresolved, false);

  const other = await raise(app, raiseEnvelope("dev-scope-tenant-0002", { type: "tenant", id: OTHER_TENANT }));
  assert.equal(other.status, 200);
  assert.equal(other.body.scope_unresolved, true);
  assert.equal((raisedStop(db, other.body) as { stop_active: number }).stop_active, 1);
});

test("a replayed raise repeats the scope answer it first gave, even after the job appears", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const envelope = raiseEnvelope("dev-scope-replay-0001", { type: "roof_job", id: "job-late-0001" });
  const first = await raise(app, envelope);
  assert.equal(first.status, 200);
  assert.equal(first.body.scope_unresolved, true);

  seedRoofJob(db, "job-late-0001");
  const replay = await raise(app, envelope);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  // A new raise on the same job reads it now, so only the stored answer kept the replay at true.
  const fresh = await raise(app, raiseEnvelope("dev-scope-replay-0002", { type: "roof_job", id: "job-late-0001" }));
  assert.equal(fresh.body.scope_unresolved, false);
});

test("a shop or vehicle raise carries no scope answer, since nothing checks those scopes yet", async () => {
  const db = new SqliteD1();
  const app = env(db);
  for (const [deviceActionId, type] of [
    ["dev-scope-shop-0001", "shop"],
    ["dev-scope-vehicle-0001", "vehicle"],
  ] as const) {
    const raised = await raise(app, raiseEnvelope(deviceActionId, { type, id: `${type}-unit-0001` }));
    assert.equal(raised.status, 200, type);
    assert.equal(raised.body.status, "verified", type);
    assert.equal("scope_unresolved" in raised.body, false, type);
  }
});

test("a raise whose scope lookup fails is recorded and answered without a scope answer", async (t) => {
  const db = new SqliteD1();
  const healthy = env(db);
  // The job lookup fails as a D1 read can; every other statement of the raise runs as usual.
  const failing = {
    ...healthy,
    DB: {
      prepare: (sql: string) =>
        sql.includes("FROM operating_roof_jobs")
          ? {
              bind: () => ({
                first: async () => {
                  throw new Error("D1_ERROR: synthetic read failure");
                },
              }),
            }
          : db.prepare(sql),
    } as never,
  } as AppEnv;
  const logged = t.mock.method(console, "error", () => undefined);
  const envelope = raiseEnvelope("dev-scope-fail-0001", { type: "roof_job", id: "job-missing-0001" });

  const first = await raise(failing, envelope);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "verified");
  assert.equal("scope_unresolved" in first.body, false);
  assert.deepEqual(
    { ...raisedStop(db, first.body) },
    { state: "reported", stop_active: 1, scope_type: "roof_job", scope_id: "job-missing-0001" },
  );
  // Counted by name: Node can print its own warnings through console.error during the test.
  const lookupFailures = logged.mock.calls.filter(
    (call) => call.arguments[0] === "safety_scope_lookup_failed",
  );
  assert.equal(lookupFailures.length, 1);

  // The replay answers from the stored response: still no flag, though the lookup works now and
  // would find no such job.
  const replay = await raise(healthy, envelope);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
});

test("the safety route enforces CSRF and rejects an unknown command", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  const noCsrf = await handleSafetyRoute(
    request(
      "/api/v1/safety/occurrences/so_ladder_slip_0001/commands",
      { command: "controlled", detail: "x" },
      { csrf: false },
    ),
    app,
    auth(USERS.supervisor),
  );
  assert.equal(noCsrf?.status, 403);
  assert.deepEqual(await noCsrf?.json(), { error: "csrf_failed" });

  const badCommand = await handleSafetyRoute(
    request("/api/v1/safety/occurrences/so_ladder_slip_0001/commands", {
      command: "make_it_go_away",
      detail: "x",
    }),
    app,
    auth(USERS.supervisor),
  );
  assert.equal(badCommand?.status, 400);
  assert.deepEqual(await badCommand?.json(), {
    error: "safety_command_invalid",
  });
});

test("the route layer surfaces the store's exact rejection code and status", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  const denied = await handleSafetyRoute(
    request("/api/v1/safety/occurrences/so_ladder_slip_0001/commands", {
      command: "controlled",
      detail: "Field worker attempts to declare control.",
    }),
    app,
    auth(USERS.crew),
  );
  assert.equal(denied?.status, 403);
  assert.equal(
    ((await denied?.json()) as { error: string }).error,
    "safety_release_authority_required",
  );
});

test("an occurrence cannot close over an unresolved notification or open action", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(
    app,
    occurrenceReport({ occurrenceKind: "injury", severity: "critical" }),
  );
  const advance = async (
    command: Parameters<typeof recordSafetyResponse>[1]["command"],
  ) =>
    await recordSafetyResponse(app, {
      tenantId: TENANT,
      occurrenceId: "so_ladder_slip_0001",
      actorUserId: USERS.supervisor.id,
      command,
      ...(command === "released" ? { evidenceIds: [RELEASE_PHOTO_ID] } : {}),
      detail: `Recorded ${command}.`,
      evidence: null,
      now: NOW,
    });
  await recordMakeSafe(app, {
    tenantId: TENANT,
    occurrenceId: "so_ladder_slip_0001",
    actorUserId: USERS.crew.id,
    detail: "First aid given, area secured.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: NOW,
    now: NOW,
  });
  await recordSafetyNotification(app, {
    tenantId: TENANT,
    notificationId: "sn_wcb_alberta_0001",
    occurrenceId: "so_ladder_slip_0001",
    authorityName: "WCB Alberta",
    authorityJurisdiction: "Alberta",
    notificationKind: "regulatory",
    required: true,
    dueAt: "2026-08-18T12:00:00.000Z",
    determinationReason: "Lost-time injury is reportable.",
    actorUserId: USERS.owner.id,
    now: NOW,
  });
  await advance("investigation_opened");
  await advance("controlled");
  await advance("released");
  assert.equal(
    await rejectionCode(() => advance("closed")),
    "safety_notification_outstanding",
  );
  for (const ref of [
    `evidence-upload://evu_${"a".repeat(64)}`,
    ` EVIDENCE-UPLOAD://evu_${"a".repeat(64)}`,
  ]) {
    assert.equal(await rejectionCode(() => submitSafetyNotification(app, {
      tenantId: TENANT,
      notificationId: "sn_wcb_alberta_0001",
      actorUserId: USERS.owner.id,
      externalReference: "WCB-2026-0001",
      evidence: { refsJson: JSON.stringify([{ ref, sha256: "a".repeat(64) }]), sha256: "a".repeat(64) },
      now: NOW,
    })), "safety_evidence_invalid");
  }
  await submitSafetyNotification(app, {
    tenantId: TENANT,
    notificationId: "sn_wcb_alberta_0001",
    actorUserId: USERS.owner.id,
    externalReference: "WCB-2026-0001",
    evidence: null,
    now: NOW,
  });
  const closed = await advance("closed");
  assert.equal(closed.state, "closed");
  assert.equal(closed.stop_active, 0);
});

test("a field worker may not record a regulatory notification", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  assert.equal(
    await rejectionCode(() =>
      recordSafetyNotification(app, {
        tenantId: TENANT,
        notificationId: "sn_wcb_alberta_0001",
        occurrenceId: "so_ladder_slip_0001",
        authorityName: "WCB Alberta",
        authorityJurisdiction: "Alberta",
        notificationKind: "regulatory",
        required: true,
        dueAt: null,
        determinationReason: "Crew believes it is reportable.",
        actorUserId: USERS.crew.id,
        now: NOW,
      }),
    ),
    "safety_notification_authority_required",
  );
});

function releasedWorkPackage(): FieldWorkPackage {
  return {
    name: "WP-0001",
    id: "WP-0001",
    version: 1,
    status: "Released",
    title: "North elevation metal",
    objective: "Install the released metal system.",
    boundaries: "North roof only.",
    prerequisites: "Tie-off verified.",
    expectedResult: "Section complete.",
    stopConditions: "Stop for unsafe weather or missing controls.",
    makeSafeProcedure: "Secure the area and notify the supervisor.",
    issuedAt: NOW,
    expiresAt: LATER,
    releasedAt: NOW,
    workObjectType: "Roof Job",
    workObjectId: "JOB-A",
    physicalContextType: "Roof Site",
    physicalContextId: "JOB-A",
    releaseAttemptId: "attempt-0001",
    supersession: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    steps: [],
    holdPoints: [],
    assignedWorkers: [
      {
        sequence: 1,
        workerUser: `${USERS.crew.id}@example.invalid`,
        workerRole: "Installer",
        required: true,
      },
    ],
    workerRosterKnown: true,
    acknowledgementLedgerAvailable: true,
    acknowledgements: [],
    evidenceLedgerAvailable: true,
    evidence: [],
    modified: NOW,
  };
}

test("a safety blocker removes every work-package action except stopping work", async () => {
  const actor = `${USERS.crew.id}@example.invalid`;
  const clear = fieldWorkPackageProjection(releasedWorkPackage(), actor, {
    safetyBlockers: [],
  });
  assert.deepEqual(clear.allowedActions, [
    "work_package.acknowledge",
    "work_package.stop_work",
  ]);
  assert.deepEqual(clear.work_package?.safety_blockers, []);

  const blockers = [
    {
      code: "safety_stop_active" as const,
      subject_type: "occurrence" as const,
      subject_id: "so_ladder_slip_0001",
      detail: "An active hazard stop is in force.",
    },
  ];
  const blocked = fieldWorkPackageProjection(releasedWorkPackage(), actor, {
    safetyBlockers: blockers,
  });
  // Acknowledge is gone; stopping work survives every safety state.
  assert.deepEqual(blocked.allowedActions, ["work_package.stop_work"]);
  assert.deepEqual(blocked.work_package?.safety_blockers, blockers);
});

/**
 * The drill. One emergency runs end to end through every rail the ticket names:
 * an offline rescue call, a failed PPE item, a duplicate offline report, a
 * regulatory notification, a late high-risk corrective action, independent
 * verification by someone who touched none of it, and only then a release.
 */
test("emergency drill: rescue, failed PPE, duplicate report, late action, independent release", async () => {
  const db = new SqliteD1();
  const objects = memoryObjects();
  const app = env(db, objects);

  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-DRILL-1",
    assignedUserId: USERS.crew.id,
    inspectionIntervalDays: 180,
    actorUserId: USERS.inspector.id,
    now: "2026-08-01T12:00:00.000Z",
  });
  await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    actorUserId: USERS.inspector.id,
    result: "pass",
    detail: "Pre-season inspection.",
    evidence: null,
    expectedVersion: 1,
    now: "2026-08-01T12:00:00.000Z",
  });

  // 1. The crew calls for rescue from an offline device.
  const rescueCall = await processSafetyDeviceAction(
    app,
    auth(USERS.crew),
    {
      deviceActionId: "dev-drill-00000001",
      kind: "rescue_request",
      scope: { type: "roof_job", id: "JOB-A" },
      capturedAt: NOW,
      payload: {
        detail: "Worker suspended in harness after an arrested fall.",
      },
    },
    {
      objects: objects.objects,
      now: () => new Date(NOW),
      randomId: () => "token-1",
    },
  );
  const occurrenceId = rescueCall.server_ref;

  // 2. A second crew member's queued device reports the same event; it must not
  //    become a second emergency.
  const duplicate = await reportSafetyOccurrence(app, {
    occurrenceId: "so_drill_duplicate01",
    tenantId: TENANT,
    occurrenceKind: "emergency",
    severity: "critical",
    scope: { type: "roof_job", id: "JOB-A" },
    reportedByUserId: USERS.crew.id,
    reportedAt: NOW,
    summary: "Worker suspended in harness after an arrested fall.",
    rescueRequired: true,
    evidence: null,
    capturedOffline: true,
    deviceActionId: null,
    now: NOW,
  });
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.occurrence.occurrence_id, occurrenceId);

  // 3. The arrested fall condemns the harness. A field worker may do this.
  const defect = await processSafetyDeviceAction(
    app,
    auth(USERS.mate),
    {
      deviceActionId: "dev-drill-00000002",
      kind: "equipment_defect",
      scope: { type: "roof_job", id: "JOB-A" },
      capturedAt: NOW,
      payload: {
        detail: "Harness took an arrested fall and is out of service.",
        equipment_id: "eq_harness_0001",
      },
    },
    {
      objects: objects.objects,
      now: () => new Date(NOW),
      randomId: () => "token-2",
    },
  );
  assert.equal(defect.server_ref, "eq_harness_0001");

  // 4. Release is blocked on three independent grounds at this point.
  const earlyGate = await safetyReleaseGate(app, {
    tenantId: TENANT,
    scope: { type: "roof_job", id: "JOB-A" },
    jobId: "JOB-A",
    subjectUserIds: [USERS.crew.id],
    consumer: "schedule_release",
    evaluatedByUserId: USERS.supervisor.id,
    decisionRef: "drill-early",
    now: NOW,
  });
  assert.equal(earlyGate.readiness.ready, false);
  const earlyCodes = new Set(
    earlyGate.readiness.blockers.map((blocker) => blocker.code),
  );
  assert.ok(earlyCodes.has("safety_stop_active"));
  assert.ok(earlyCodes.has("safety_equipment_unserviceable"));

  // 5. Rescue is commanded by production authority, never by the crew.
  assert.equal(
    await rejectionCode(() =>
      recordSafetyResponse(app, {
        tenantId: TENANT,
        occurrenceId,
        actorUserId: USERS.crew.id,
        command: "rescue_dispatched",
        detail: "Crew attempts to command the rescue.",
        evidence: null,
        now: NOW,
      }),
    ),
    "safety_rescue_authority_required",
  );
  const command = async (
    actor: string,
    kind: Parameters<typeof recordSafetyResponse>[1]["command"],
  ) =>
    await recordSafetyResponse(app, {
      tenantId: TENANT,
      occurrenceId,
      actorUserId: actor,
      command: kind,
      ...(kind === "released" ? { evidenceIds: [RELEASE_PHOTO_ID] } : {}),
      detail: `Drill: ${kind}.`,
      evidence: null,
      now: NOW,
    });
  await command(USERS.supervisor.id, "rescue_dispatched");
  await recordMakeSafe(app, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: USERS.crew.id,
    detail: "Suspended worker lowered; area cleared below.",
    evidence: null,
    capturedOffline: true,
    deviceActionId: null,
    occurredAt: NOW,
    now: NOW,
  });
  await command(USERS.supervisor.id, "rescue_completed");

  // 6. A reportable injury needs a regulatory notification before closure.
  await recordSafetyNotification(app, {
    tenantId: TENANT,
    notificationId: "sn_drill_wcb_00001",
    occurrenceId,
    authorityName: "WCB Alberta",
    authorityJurisdiction: "Alberta",
    notificationKind: "regulatory",
    required: true,
    dueAt: "2026-08-18T12:00:00.000Z",
    determinationReason: "Arrested fall with suspension is reportable.",
    actorUserId: USERS.owner.id,
    now: NOW,
  });
  const notificationBlocked = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [{ type: "roof_job", id: "JOB-A" }],
    subjectUserIds: [],
    now: NOW,
  });
  assert.ok(
    notificationBlocked.blockers.some(
      (blocker) => blocker.code === "safety_notification_outstanding",
    ),
  );
  await submitSafetyNotification(app, {
    tenantId: TENANT,
    notificationId: "sn_drill_wcb_00001",
    actorUserId: USERS.owner.id,
    externalReference: "WCB-DRILL-0001",
    evidence: null,
    now: NOW,
  });

  // 7. A high-risk corrective action, already past due, keeps the scope blocked.
  await command(USERS.supervisor.id, "investigation_opened");
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_drill_anchor_001",
    occurrenceId,
    riskLevel: "critical",
    ownerUserId: USERS.mate.id,
    dueAt: "2026-08-16T12:00:00.000Z",
    description: "Install engineered anchors on the north elevation.",
    recurrenceOfId: null,
    actorUserId: USERS.supervisor.id,
    now: NOW,
  });
  const lateGate = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [{ type: "roof_job", id: "JOB-A" }],
    subjectUserIds: [],
    now: NOW,
  });
  assert.ok(
    lateGate.blockers.some(
      (blocker) => blocker.code === "safety_corrective_action_overdue",
    ),
  );

  // 8. Evidence is captured by the owner of the fix; verification must not be.
  await submitCorrectiveActionEvidence(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_drill_anchor_001",
    actorUserId: USERS.mate.id,
    evidence: {
      refsJson: JSON.stringify([
        { ref: "r2://safety/drill/anchor-install.jpg", sha256: "d".repeat(64) },
      ]),
      sha256: "e".repeat(64),
    },
    detail: "Anchors installed and load tested.",
    now: NOW,
  });
  assert.equal(
    await rejectionCode(() =>
      verifyCorrectiveAction(app, {
        tenantId: TENANT,
        correctiveActionId: "ca_drill_anchor_001",
        actorUserId: USERS.mate.id,
        verdict: "verified",
        detail: "Owner tries to verify their own fix.",
        now: NOW,
      }),
    ),
    "safety_verification_authority_required",
  );
  const verified = await verifyCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_drill_anchor_001",
    actorUserId: USERS.auditor.id,
    verdict: "verified",
    detail: "Independent inspection of the installed anchors.",
    now: NOW,
  });
  assert.equal(verified.state, "verified");
  assert.equal(verified.verified_by_user_id, USERS.auditor.id);
  await closeCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_drill_anchor_001",
    actorUserId: USERS.auditor.id,
    detail: "Closed on independent verification.",
    now: NOW,
  });

  // 9. Replace the condemned harness so its holder is serviceable again.
  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0002",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-DRILL-2",
    assignedUserId: USERS.crew.id,
    inspectionIntervalDays: 180,
    actorUserId: USERS.inspector.id,
    now: NOW,
  });
  await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0002",
    actorUserId: USERS.inspector.id,
    result: "pass",
    detail: "New harness accepted into service.",
    evidence: null,
    expectedVersion: 1,
    now: NOW,
  });
  db.raw
    .prepare(
      "UPDATE safety_equipment SET version = version + 1, status = 'retired', assigned_user_id = NULL, assigned_at = NULL, updated_at = ? WHERE equipment_id = 'eq_harness_0001'",
    )
    .run(NOW);

  // 10. Only now does the stop lift, and only by production authority.
  await command(USERS.supervisor.id, "controlled");
  const released = await command(USERS.supervisor.id, "released");
  assert.equal(released.stop_active, 0);
  await command(USERS.supervisor.id, "closed");

  const finalGate = await safetyReleaseGate(app, {
    tenantId: TENANT,
    scope: { type: "roof_job", id: "JOB-A" },
    jobId: "JOB-A",
    subjectUserIds: [USERS.crew.id],
    consumer: "schedule_release",
    evaluatedByUserId: USERS.supervisor.id,
    decisionRef: "drill-final",
    now: NOW,
  });
  assert.deepEqual(finalGate.readiness.blockers, []);
  assert.equal(finalGate.readiness.ready, true);

  // The whole drill is reconstructable: nothing was deleted, and both the
  // refusal and the release were recorded.
  const snapshots = db.raw
    .prepare(
      "SELECT ready, blocker_codes FROM safety_readiness_snapshots ORDER BY evaluated_at, snapshot_id",
    )
    .all() as Array<{ ready: number; blocker_codes: string }>;
  assert.equal(snapshots.length, 2);
  assert.ok(
    snapshots.some((row) => row.ready === 0 && row.blocker_codes.length > 0),
  );
  assert.ok(
    snapshots.some((row) => row.ready === 1 && row.blocker_codes === ""),
  );
  assert.equal(
    (
      db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM safety_occurrence_events WHERE occurrence_id = ?",
        )
        .get(occurrenceId) as { count: number }
    ).count,
    8,
  );
});

test("the safety desk judges equipment by the release gate's own rule", async () => {
  const db = new SqliteD1();
  const app = env(db);
  // Two items: one inspected and due soon, one never inspected.
  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-0001",
    assignedUserId: USERS.crew.id,
    inspectionIntervalDays: 10,
    actorUserId: USERS.inspector.id,
    now: NOW,
  });
  await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0001",
    actorUserId: USERS.inspector.id,
    result: "pass",
    detail: "Webbing, stitching, and hardware verified.",
    evidence: null,
    expectedVersion: 1,
    now: NOW,
  });
  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_0002",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-0002",
    assignedUserId: USERS.mate.id,
    inspectionIntervalDays: 180,
    actorUserId: USERS.inspector.id,
    now: NOW,
  });

  const desk = await safetyDeskProjection(
    app,
    TENANT,
    USERS.supervisor.id,
    NOW,
  );
  const byId = new Map(
    (desk.equipment ?? []).map((item) => [item.equipment_id, item]),
  );

  // Due in 10 days: visible and named, but this is not what stops a crew.
  const soon = byId.get("eq_harness_0001");
  assert.equal(soon?.verdict, "expiring");
  assert.equal(soon?.days_left, 10);

  // Never inspected: the desk says exactly what the gate says.
  const unproven = byId.get("eq_harness_0002");
  assert.equal(unproven?.verdict, "unserviceable");
  assert.equal(
    unproven?.detail,
    "fall_arrest_harness SN-0002 has no recorded inspection.",
  );

  const readiness = await evaluateSafetyReadiness(app, {
    tenantId: TENANT,
    scopes: [],
    subjectUserIds: [USERS.crew.id, USERS.mate.id],
    now: NOW,
  });
  // The desk and the gate must not disagree about who is stopped.
  assert.deepEqual(
    readiness.blockers.map((blocker) => blocker.subject_id),
    ["eq_harness_0002"],
  );
});

test("the safety desk marks only the corrective actions the gate refuses on", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_control01",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "high",
    ownerUserId: USERS.mate.id,
    dueAt: "2026-08-16T12:00:00.000Z",
    description: "Install a permanent ladder tie-off point.",
    recurrenceOfId: null,
    actorUserId: USERS.supervisor.id,
    now: NOW,
  });
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_ladder_signage1",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "low",
    ownerUserId: USERS.mate.id,
    dueAt: "2026-08-16T12:00:00.000Z",
    description: "Add a reminder sign at the ladder base.",
    recurrenceOfId: null,
    actorUserId: USERS.supervisor.id,
    now: NOW,
  });

  const desk = await safetyDeskProjection(
    app,
    TENANT,
    USERS.supervisor.id,
    NOW,
  );
  const actions = new Map(
    (desk.corrective_actions ?? []).map((action) => [
      action.corrective_action_id,
      action,
    ]),
  );
  // Both are overdue and both are shown; only high risk stops the work.
  assert.equal(actions.get("ca_ladder_control01")?.blocking, true);
  assert.equal(actions.get("ca_ladder_signage1")?.blocking, false);
  assert.equal(actions.get("ca_ladder_signage1")?.days_left, -1);
});

test("the safety desk shows a rail only to a role that may act on it", async () => {
  const db = new SqliteD1();
  const app = env(db);

  // Shop may handle equipment but does not run the response rail: null, never an empty
  // list, so "none on file" and "not yours to see" cannot be confused.
  const shop = await safetyDeskProjection(app, TENANT, USERS.inspector.id, NOW);
  assert.equal(shop.actor_role, "shop");
  assert.ok(Array.isArray(shop.equipment));
  assert.equal(shop.corrective_actions, null);

  const production = await safetyDeskProjection(
    app,
    TENANT,
    USERS.supervisor.id,
    NOW,
  );
  assert.ok(Array.isArray(production.equipment));
  assert.ok(Array.isArray(production.corrective_actions));

  await assert.rejects(
    () => safetyDeskProjection(app, TENANT, USERS.crew.id, NOW),
    (error: unknown) =>
      error instanceof SafetyError &&
      error.code === "safety_desk_role_required",
  );
});

test("the safety desk route refuses a crew session and answers an operations one", async () => {
  const db = new SqliteD1();
  const app = env(db);
  const refused = await handleSafetyRoute(
    request("/api/v1/safety/desk"),
    app,
    auth(USERS.crew),
  );
  assert.equal(refused?.status, 403);

  const allowed = await handleSafetyRoute(
    request("/api/v1/safety/desk"),
    app,
    auth(USERS.owner),
  );
  assert.equal(allowed?.status, 200);
  const payload = (await allowed?.json()) as {
    version: number;
    equipment: unknown[];
    corrective_actions: unknown[];
  };
  assert.equal(payload.version, 1);
  assert.ok(Array.isArray(payload.equipment));
  assert.ok(Array.isArray(payload.corrective_actions));
});

test("corrective evidence acknowledges only an exact replay, including after independent closure", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await reportSafetyOccurrence(app, occurrenceReport());
  await assignCorrectiveAction(app, {
    tenantId: TENANT,
    correctiveActionId: "ca_replay_exact01",
    occurrenceId: "so_ladder_slip_0001",
    riskLevel: "high",
    ownerUserId: USERS.mate.id,
    dueAt: LATER,
    description: "Install a permanent tie-off point.",
    recurrenceOfId: null,
    actorUserId: USERS.supervisor.id,
    now: NOW,
  });
  const input = {
    tenantId: TENANT,
    correctiveActionId: "ca_replay_exact01",
    actorUserId: USERS.mate.id,
    evidence: {
      refsJson: JSON.stringify([
        { ref: "r2://safety/tie-off-check.pdf", sha256: "a".repeat(64) },
      ]),
      sha256: "b".repeat(64),
    },
    detail: "Tie-off installed and checked.",
    now: NOW,
  };
  assert.deepEqual(
    (
      await safetyCorrectiveActionProjection(
        app,
        TENANT,
        USERS.mate.id,
        input.correctiveActionId,
      )
    ).allowed_actions,
    ["submit_evidence"],
  );
  const saved = await submitCorrectiveActionEvidence(app, input);
  assert.equal(
    (await submitCorrectiveActionEvidence(app, { ...input, now: LATER }))
      .version,
    saved.version,
  );
  for (const changed of [
    { ...input, actorUserId: USERS.crew.id },
    { ...input, detail: "A different observation." },
    { ...input, evidence: { ...input.evidence, sha256: "c".repeat(64) } },
    {
      ...input,
      evidence: {
        ...input.evidence,
        refsJson: JSON.stringify([
          { ref: "r2://safety/other.pdf", sha256: "a".repeat(64) },
        ]),
      },
    },
  ]) {
    assert.equal(
      await rejectionCode(() => submitCorrectiveActionEvidence(app, changed)),
      "safety_corrective_evidence_conflict",
    );
  }
  const self = await safetyCorrectiveActionProjection(
    app,
    TENANT,
    USERS.mate.id,
    input.correctiveActionId,
  );
  assert.deepEqual(self.allowed_actions, []);
  const independent = await safetyCorrectiveActionProjection(
    app,
    TENANT,
    USERS.supervisor.id,
    input.correctiveActionId,
  );
  assert.deepEqual(independent.allowed_actions, ["verify", "reject"]);
  await verifyCorrectiveAction(app, {
    ...input,
    actorUserId: USERS.supervisor.id,
    verdict: "verified",
    now: LATER,
  });
  await closeCorrectiveAction(app, {
    ...input,
    actorUserId: USERS.supervisor.id,
    now: LATER,
  });
  const replayed = await submitCorrectiveActionEvidence(app, {
    ...input,
    now: LATER,
  });
  assert.equal(replayed.state, "closed");
  assert.deepEqual(
    (
      await safetyCorrectiveActionProjection(
        app,
        TENANT,
        USERS.supervisor.id,
        input.correctiveActionId,
      )
    ).allowed_actions,
    [],
  );
  assert.equal(
    db.raw
      .prepare(
        "SELECT count(*) AS n FROM safety_corrective_action_events WHERE corrective_action_id = ? AND event_kind = 'evidence_submitted'",
      )
      .get(input.correctiveActionId)?.n,
    1,
  );
});

test("a pass recorded from a stale equipment screen is refused after someone else quarantined the item", async () => {
  const db = new SqliteD1();
  const app = env(db);
  await issueSafetyEquipment(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_stale01",
    equipmentKind: "fall_arrest_harness",
    serialNumber: "SN-STALE-01",
    assignedUserId: USERS.crew.id,
    inspectionIntervalDays: 180,
    actorUserId: USERS.inspector.id,
    now: NOW,
  });
  // Inspector A reads revision 1. Inspector B then fails the item: revision 2, quarantined.
  const read = await getSafetyEquipment(app, TENANT, "eq_harness_stale01");
  assert.equal(read?.version, 1);
  const quarantined = await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_stale01",
    actorUserId: USERS.supervisor.id,
    result: "fail",
    detail: "Cut webbing above the dorsal D-ring.",
    evidence: null,
    expectedVersion: 1,
    now: NOW,
  });
  assert.equal(quarantined.version, 2);
  assert.equal(quarantined.status, "quarantined");
  // A submits "pass" from the revision-1 screen: refused, nothing changes, no event appended.
  assert.equal(
    await rejectionCode(() =>
      recordEquipmentInspection(app, {
        tenantId: TENANT,
        equipmentId: "eq_harness_stale01",
        actorUserId: USERS.inspector.id,
        result: "pass",
        detail: "Looked fine this morning.",
        evidence: null,
        expectedVersion: 1,
        now: LATER,
      }),
    ),
    "safety_equipment_version_conflict",
  );
  const after = await getSafetyEquipment(app, TENANT, "eq_harness_stale01");
  assert.equal(after?.version, 2);
  assert.equal(after?.status, "quarantined");
  assert.equal(after?.last_inspection_result, "fail");
  assert.equal(
    db.raw
      .prepare(
        "SELECT count(*) AS n FROM safety_equipment_events WHERE equipment_id = ? AND event_kind = 'inspection_pass'",
      )
      .get("eq_harness_stale01")?.n,
    0,
  );
  // Reading the new condition and passing against revision 2 is the only way back to service.
  const cleared = await recordEquipmentInspection(app, {
    tenantId: TENANT,
    equipmentId: "eq_harness_stale01",
    actorUserId: USERS.inspector.id,
    result: "pass",
    detail: "Webbing replaced and verified.",
    evidence: null,
    expectedVersion: 2,
    now: LATER,
  });
  assert.equal(cleared.version, 3);
  assert.equal(cleared.status, "in_service");
});
