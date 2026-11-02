import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { FieldMeasurementReadItem } from "../src/app-read-models.ts";
import {
  handleFieldAction,
  type FieldActionPayload,
} from "../src/field-actions.ts";
import {
  listFieldMeasurementsFromD1,
  type FieldMeasurementCapture,
} from "../src/field-measurements.ts";
import { recordOperatingJobAssignment } from "../src/operating-job-assignment-store.ts";
import { issueNativeWorkPackage, nativeWorkPackageAction } from "../src/work-package-store.ts";
import type { AuthContext } from "../src/app-types.ts";
import { clearScheduleGatesInLedger, fixtureSchedule } from "./production-gate-ledger-fixture.ts";
import {
  auth,
  request,
  setup,
  SEED_TIME,
  USERS,
} from "./pipeline-board-fixture.ts";

const JOB = "job:board:0001";
const DEVICE = "measurement-device-0001";
const WP = "wp:measurement:0001";
const PATH = `/api/v1/jobs/${encodeURIComponent(JOB)}`;
const READING = { feet: 42, inches: 7, eighths: 3, area_label: "South eave" };
const REQUIREMENTS = [
  {
    authority_record_id: "authority:measurement:worker",
    subject_type: "Person" as const,
    subject_role: "Worker" as const,
    subject_ref: USERS.field.userId,
    authority_kind: "Worker Competency" as const,
    scope_type: "Roof Job" as const,
    scope_ref: JOB,
    version: 1,
    state_digest_sha256: "c".repeat(64),
  },
];

function fieldAuth(): AuthContext {
  const value = auth("field");
  value.session.device_id = DEVICE;
  return value;
}

function bucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; sha256: string; metadata: string }
  >();
  let corruptHead = false;
  let failStoredHead = false;
  let puts = 0;
  return {
    objects,
    get puts() {
      return puts;
    },
    set corruptHead(value: boolean) {
      corruptHead = value;
    },
    set failStoredHead(value: boolean) {
      failStoredHead = value;
    },
    async head(key: string) {
      const obj = objects.get(key);
      if (obj && failStoredHead) throw new Error("r2_readback_unavailable");
      return obj
        ? {
            size: obj.bytes.byteLength,
            customMetadata: { sha256: obj.metadata },
            checksums: {
              sha256: Uint8Array.from(
                Buffer.from(corruptHead ? "0".repeat(64) : obj.sha256, "hex"),
              ).buffer,
            },
          }
        : null;
    },
    async put(
      key: string,
      body: Blob | string,
      options: {
        customMetadata: { sha256: string };
        onlyIf: Headers;
      },
    ) {
      assert.ok(options.onlyIf instanceof Headers);
      assert.equal(options.onlyIf.get("if-none-match"), "*");
      if (objects.has(key)) return null;
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(await body.arrayBuffer());
      objects.set(key, {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        metadata: options.customMetadata.sha256,
      });
      puts += 1;
      return { key };
    },
  };
}

async function fixture(typed = false) {
  const f = setup();
  const raw = f.db.raw;
  const objects = bucket();
  // The production D1 wrapper names constraint refusals; plain SQLite messages do not.
  const d1 = {
    prepare(sql: string) {
      const statement = f.db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          async function call<T>(method: () => Promise<T>): Promise<T> {
            try {
              return await method();
            } catch (error) {
              if (
                error instanceof Error &&
                ((error as { errcode?: number }).errcode ?? 0) % 256 === 19
              )
                throw new Error(
                  `D1_ERROR: ${error.message}: SQLITE_CONSTRAINT`,
                );
              throw error;
            }
          }
          return {
            first: <T>() => call(() => bound.first<T>()),
            all: <T>() => call(() => bound.all<T>()),
            run: () => call(() => bound.run()),
          };
        },
      };
    },
    batch: f.db.batch.bind(f.db),
  };
  f.env.DB = d1 as never;
  f.env.RAW = objects as never;
  raw
    .prepare(
      `INSERT INTO app_devices(device_id,tenant_id,user_id,device_proof_hash,paired_at,last_seen_at,created_ip_hash,created_user_agent_hash)
    VALUES (?, 'ironwrap', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      DEVICE,
      USERS.field.userId,
      "d".repeat(64),
      SEED_TIME,
      SEED_TIME,
      "e".repeat(64),
      "f".repeat(64),
    );
  raw
    .prepare(
      "INSERT INTO fleet_crews(crew_id,tenant_id,display_name,status,version,created_at,updated_at) VALUES ('crew:measurement:0001','ironwrap','Synthetic Crew','Active',1,?,?)",
    )
    .run(SEED_TIME, SEED_TIME);
  raw
    .prepare(
      "INSERT INTO fleet_crew_members(membership_id,tenant_id,crew_id,user_id,active,version,created_at,updated_at) VALUES ('member:measurement:0001','ironwrap','crew:measurement:0001',?,1,1,?,?)",
    )
    .run(USERS.field.userId, SEED_TIME, SEED_TIME);
  for (const gate of [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ])
    raw
      .prepare(
        `INSERT INTO operating_production_gates(gate_id,tenant_id,roof_job_id,source_envelope_id,gate,state,owner_user,assigned_at,due_at,blocker_reason,version,created_at,updated_at)
      VALUES (?,'ironwrap',?,'ow_pipeline_board_0001',?,'blocked',?, ?, ?, 'Synthetic readiness',1,?,?)`,
      )
      .run(
        `gate:measurement:${gate}`,
        JOB,
        gate,
        USERS.owner.userId,
        SEED_TIME,
        SEED_TIME,
        SEED_TIME,
        SEED_TIME,
      );
  // Production, on no crew, clears the five gates a schedule rests on; the schedule binds Crew.
  clearScheduleGatesInLedger(raw, {
    tenantId: "ironwrap",
    roofJobId: JOB,
    ownerUserId: USERS.owner.userId,
    attesterUserId: USERS.production.userId,
    attesterRole: "production",
  });
  const assignment = (
    await recordOperatingJobAssignment(
      f.env,
      {
        tenantId: "ironwrap",
        roofJobId: JOB,
        expectedRoofJobVersion: 1,
        crewId: "crew:measurement:0001",
        expectedCrewVersion: 1,
        authorityRequirements: REQUIREMENTS,
        // Inside the Weather window production attested, which D1 holds to its own clock.
        scheduledStart: fixtureSchedule(1).start,
        actorUserId: USERS.owner.userId,
        idempotencyKey: "measurement-assignment-0001",
      },
      new Date(SEED_TIME),
    )
  ).assignment;
  if (typed)
    await issueNativeWorkPackage(f.env, {
      tenantId: "ironwrap",
      workPackageId: WP,
      version: 1,
      deviceActionId: "measurement-issue-0001",
      manifestKey: "work-packages/measurement-issue-0001.json",
      jobId: JOB,
      assignmentId: assignment.assignment_id,
      assignmentVersion: assignment.assignment_version,
      assignmentCommandFingerprint: assignment.command_fingerprint,
      assignmentAuthorityRequirementsSha256:
        assignment.authority_requirements_sha256!,
      issueRequestSha256: "b".repeat(64),
      workObjectType: "Roof Job",
      workObjectId: JOB,
      physicalContextType: "Roof Site",
      physicalContextId: JOB,
      title: "Synthetic field readings",
      objective: "Observe the eave",
      boundaries: "Observation only",
      prerequisites: "Use issued plan",
      expectedResult: "A recorded observation",
      stopConditions: "Stop if unsafe",
      makeSafeProcedure: "Secure the area",
      issuedAt: SEED_TIME,
      releasedAt: SEED_TIME,
      expiresAt: "2099-01-01T00:00:00.000Z",
      releaseAttemptId: "measurement-release-0001",
      authorityRequirements: REQUIREMENTS,
      assignedWorkers: [
        {
          sequence: 1,
          workerUser: USERS.field.email,
          workerRole: "Field Worker",
          required: true,
        },
      ],
      steps: [
        {
          sequence: 1,
          instruction: "Observe eave length",
          requiredEvidence: "Eave reading and tape photo",
          acceptanceCriteria: "Office review required",
        },
      ],
      holdPoints: [
        {
          sequence: 1,
          holdPoint: "Observation review",
          releasePhase: "Completion",
          releaseAuthority: "IronWrap Owner",
          requiredEvidence: "Review reading",
          acceptanceCriteria: "Human review",
        },
      ],
      issuedByUser: USERS.owner.email,
      issuedByRole: "IronWrap Owner",
    });
  return { ...f, objects, assignmentId: assignment.assignment_id };
}

function payload(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<FieldActionPayload> = {},
): FieldActionPayload {
  return {
    assignment_id: f.assignmentId,
    proof_slot: "Measurement",
    measurement: READING,
    capture_started_at: SEED_TIME,
    capture_completed_at: SEED_TIME,
    notes: null,
    blocker: false,
    blocker_category: null,
    blocker_summary: null,
    latitude: null,
    longitude: null,
    location_accuracy_m: null,
    location_permission_state: "not_requested",
    correction_of: null,
    correction_reason: null,
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    customer_safe_requested: false,
    ...overrides,
  };
}

function multipart(
  id: string,
  value: unknown,
  photo = false,
  path = PATH,
  csrf = true,
) {
  const form = new FormData();
  const attachments = [];
  if (photo) {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 42])], {
      type: "image/jpeg",
    });
    attachments.push({
      attachmentId: "photo-0001",
      fileName: "tape.jpg",
      mimeType: blob.type,
      size: blob.size,
    });
    form.append("attachments", blob, "tape.jpg");
  }
  form.set(
    "metadata",
    JSON.stringify({ device_action_id: id, payload: value, attachments }),
  );
  return new Request(`https://app.example.com${path}/check-ins`, {
    method: "POST",
    body: form,
    headers: csrf
      ? { "X-CSRF-Token": "csrf-token", "Idempotency-Key": id }
      : {},
  });
}

async function post(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  value = payload(f),
  actor = fieldAuth(),
  photo = false,
) {
  return handleAuthenticatedRoute(multipart(id, value, photo), f.env, actor);
}

async function checked(response: Response, status = 200) {
  const value = await response.json<Record<string, unknown>>();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

function manifests(f: Awaited<ReturnType<typeof fixture>>) {
  return [...f.objects.objects.entries()].filter(([key]) =>
    key.endsWith("/manifest.json"),
  );
}

test("structured measurement persists exact eighths, native reload and immutable R2 receipt through the existing authenticated outbox route", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const id = "measurement-save-0001";
  const saved = await checked(
    await post(
      f,
      id,
      payload(f, {
        measurement: { ...READING, area_label: "  South   eave  " },
      }),
    ),
  );
  assert.deepEqual(saved.measurement, {
    ...READING,
    total_eighth_inches: 4091,
  });
  const row = f.db.raw
    .prepare("SELECT * FROM field_actions WHERE device_action_id=?")
    .get(id)!;
  assert.equal(row.measurement_total_eighth_inches, 4091);
  assert.equal(row.measurement_device_id, DEVICE);
  assert.equal(
    row.evidence_device_id,
    null,
    "generic capture does not pretend to fill a Work Package slot",
  );
  const json = JSON.parse(new TextDecoder().decode(manifests(f)[0][1].bytes));
  assert.deepEqual(json.payload.measurement, READING);
  assert.equal(json.measurement_device_id, DEVICE);
  assert.equal(json.user_id, USERS.field.userId);
  assert.equal(json.tenant_id, "ironwrap");
  const model = await checked(
    await handleAuthenticatedRoute(request("GET", PATH), f.env, fieldAuth()),
  );
  const items = model.field_measurements as FieldMeasurementReadItem[];
  assert.deepEqual(items[0].measurement, saved.measurement);
  assert.equal(items[0].checkin_id, saved.checkin_id);
  assert.equal(items[0].device_id, DEVICE);
  assert.equal(items[0].recorded_by_name, "field");
  assert.deepEqual(items[0].allowed_actions, ["field.measurement.correct"]);
  assert.deepEqual(items[0].correction_target, {
    correction_of: saved.checkin_id,
  });
  assert.equal(model.field_measurements_more, false);
  const office = await checked(
    await handleAuthenticatedRoute(request("GET", PATH), f.env, auth("owner")),
  );
  assert.deepEqual(
    (office.field_measurements as FieldMeasurementReadItem[])[0]
      .allowed_actions,
    [],
  );
  const puts = f.objects.puts;
  assert.deepEqual(await checked(await post(f, id)), saved);
  assert.equal(f.objects.puts, puts);
  const conflict = await checked(
    await post(f, id, payload(f, { measurement: { ...READING, eighths: 4 } })),
    409,
  );
  assert.equal(conflict.error, "idempotency_conflict");
  assert.equal(f.objects.puts, puts);
  assert.equal(
    f.db.raw
      .prepare("SELECT COUNT(*) n FROM native_measurement_revisions")
      .get()!.n,
    0,
  );
});

test("an optional measurement read failure leaves the live job and office history available", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await checked(await post(f, "measurement-optional-read-0001"));
  const realDb = f.env.DB;
  for (const reason of [
    "d1_read_unavailable",
    "field_measurement_storage_mismatch",
  ]) {
    f.env.DB = {
      prepare(sql: string) {
        if (
          sql.includes("a.measurement_area_label") &&
          sql.includes("ORDER BY a.created_at DESC")
        )
          throw new Error(reason);
        return realDb.prepare(sql);
      },
      batch: realDb.batch.bind(realDb),
    } as never;
    const jobResponse = await handleAuthenticatedRoute(
      request("GET", PATH),
      f.env,
      fieldAuth(),
    );
    const job = await checked(jobResponse);
    assert.equal(jobResponse.status, 200);
    assert.deepEqual(job.field_measurements, []);
    assert.equal(job.field_measurements_more, false);
    assert.ok(
      (job.stale_fields as string[]).includes(
        "field_measurements.native_unavailable",
      ),
    );

    const historyResponse = await handleAuthenticatedRoute(
      request("GET", `${PATH}/history`),
      f.env,
      auth("owner"),
    );
    const history = await checked(historyResponse);
    assert.equal(historyResponse.status, 200);
    assert.deepEqual(history.field_measurements, []);
    assert.ok(
      (history.stale_fields as string[]).includes(
        "field_measurements.native_unavailable",
      ),
    );

    const page = await checked(
      await handleAuthenticatedRoute(
        request("GET", `${PATH}/field-measurements`),
        f.env,
        fieldAuth(),
      ),
      502,
    );
    assert.equal(page.error, "field_measurements_unavailable");
  }
  f.env.DB = realDb;
});

test("structured measurement rejects malformed, zero, out-of-range and authority-forging input before any receipt writes", async () => {
  const invalid: unknown[] = [
    null,
    "42 feet",
    {},
    { ...READING, feet: "42" },
    { ...READING, feet: 1.5 },
    { ...READING, feet: -1 },
    { ...READING, feet: 100001 },
    { ...READING, inches: 12 },
    { ...READING, eighths: 8 },
    { ...READING, eighths: -1 },
    { ...READING, feet: 0, inches: 0, eighths: 0 },
    { ...READING, area_label: "  " },
    { ...READING, area_label: "x".repeat(121) },
    { ...READING, area_label: "North\u0000eave" },
    { ...READING, total_eighth_inches: 1 },
    { ...READING, reviewed: true },
  ];
  for (const [index, measurement] of invalid.entries()) {
    const f = await fixture();
    try {
      // A null object is compatible with old captures; every other attempted value is strict.
      if (measurement === null) continue;
      const response = await handleFieldAction(
        multipart(`measurement-invalid-${index}`, {
          ...payload(f),
          measurement,
        }),
        f.env,
        fieldAuth(),
        JOB,
        f.assignmentId,
      );
      assert.equal(
        (await checked(response, 400)).error,
        "invalid_field_measurement",
      );
      assert.equal(
        f.db.raw.prepare("SELECT COUNT(*) n FROM field_actions").get()!.n,
        0,
      );
      assert.equal(f.objects.puts, 0);
    } finally {
      f.db.close();
    }
  }
});

test("feet, inches and eighth bounds accept the smallest reading and maximum supported reading exactly", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (const [index, measurement] of [
    { ...READING, feet: 0, inches: 0, eighths: 1 },
    { ...READING, feet: 100000, inches: 11, eighths: 7 },
  ].entries()) {
    const saved = await checked(
      await post(f, `measurement-bound-${index}`, payload(f, { measurement })),
    );
    assert.equal(
      (saved.measurement as { total_eighth_inches: number })
        .total_eighth_inches,
      index === 0 ? 1 : 9600095,
    );
  }
  assert.equal(
    (
      await checked(
        await post(
          f,
          "measurement-slot-0001",
          payload(f, { proof_slot: "Access" }),
        ),
        400,
      )
    ).error,
    "field_measurement_slot_required",
  );
});

test("tenant, actor, device, job, assignment and CSRF refusals preserve the capture boundary", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const otherTenant = fieldAuth();
  otherTenant.session.tenant_id = "other-co";
  assert.equal(
    (await post(f, "measurement-tenant-0001", payload(f), otherTenant)).status,
    404,
  );
  assert.equal(
    (await post(f, "measurement-role-0001", payload(f), auth("owner"))).status,
    403,
  );
  const absentDevice = fieldAuth();
  absentDevice.session.device_id = null;
  assert.equal(
    (
      await checked(
        await post(f, "measurement-device-0001", payload(f), absentDevice),
        403,
      )
    ).error,
    "field_measurement_device_required",
  );
  const forgedDevice = fieldAuth();
  forgedDevice.session.device_id = "forged-device-0001";
  assert.equal(
    (
      await checked(
        await post(f, "measurement-forged-0001", payload(f), forgedDevice),
        409,
      )
    ).error,
    "field_measurement_actor_device_invalid",
  );
  assert.equal(
    (
      await handleAuthenticatedRoute(
        multipart(
          "measurement-job-0001",
          payload(f),
          false,
          "/api/v1/jobs/another-job-0001",
        ),
        f.env,
        fieldAuth(),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await checked(
        await post(
          f,
          "measurement-assign-0001",
          payload(f, { assignment_id: "stale-assignment" }),
        ),
        409,
      )
    ).error,
    "assignment_changed",
  );
  assert.equal(
    (
      await handleAuthenticatedRoute(
        multipart("measurement-csrf-0001", payload(f), false, PATH, false),
        f.env,
        fieldAuth(),
      )
    ).status,
    403,
  );
  assert.equal(f.objects.puts, 0);
  assert.equal(
    f.db.raw.prepare("SELECT COUNT(*) n FROM field_actions").get()!.n,
    0,
  );
});

test("a correction appends a new reading and keeps the original receipt; retries are exact and a second successor is refused", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const first = await checked(await post(f, "measurement-original-0001"));
  const originalBytes = manifests(f)[0][1].bytes.slice();
  const correction = payload(f, {
    measurement: { ...READING, inches: 8 },
    correction_of: first.checkin_id as string,
    correction_reason: "Tape was read at the wrong edge",
  });
  const saved = await checked(
    await post(f, "measurement-correct-0001", correction),
  );
  assert.deepEqual(
    await checked(await post(f, "measurement-correct-0001", correction)),
    saved,
  );
  const read = await listFieldMeasurementsFromD1(f.env, {
    tenantId: "ironwrap",
    jobId: JOB,
  });
  assert.equal(read!.items.length, 2);
  const original = read!.items.find(
    (item) => item.checkin_id === first.checkin_id,
  )!;
  assert.equal(original.measurement.total_eighth_inches, 4091);
  assert.equal(original.superseded_by, saved.checkin_id);
  assert.deepEqual(
    manifests(f).find(([, object]) =>
      new TextDecoder()
        .decode(object.bytes)
        .includes('"measurement-original-0001"'),
    )![1].bytes,
    originalBytes,
  );
  assert.equal(
    (await checked(await post(f, "measurement-fork-0001", correction), 409))
      .error,
    "field_measurement_correction_conflict",
  );
  assert.equal(
    (
      await checked(
        await post(f, "measurement-missing-0001", {
          ...correction,
          correction_of: `fci_${"a".repeat(32)}`,
        }),
        409,
      )
    ).error,
    "field_measurement_correction_invalid",
  );
});

test("the SQLite correction boundary refuses a different assignment even when the actor, job and scope match", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const first = await checked(await post(f, "measurement-assignment-base"));
  const original = f.db.raw.prepare("SELECT * FROM field_actions WHERE device_action_id=?")
    .get("measurement-assignment-base") as Record<string, string | number | null>;
  const successor = {
    ...original,
    device_action_id: "measurement-assignment-crossed",
    checkin_id: `fci_${"b".repeat(32)}`,
    assignment_id: "assignment:another:0001",
    measurement_correction_of: first.checkin_id as string,
    correction_reason: "Correct the reading under another assignment",
    status: "processing",
    manifest_key: null,
    response_json: null,
    verified_at: null,
  };
  const columns = Object.keys(successor);
  assert.throws(() => f.db.raw.prepare(
    `INSERT INTO field_actions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  ).run(...Object.values(successor)), /field_measurement_correction_invalid/);
  assert.equal(f.db.raw.prepare("SELECT COUNT(*) n FROM field_actions").get()!.n, 1);
});

test("concurrent correction requests produce one SQLite successor and preserve the losing saved action", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const first = await checked(await post(f, "measurement-race-base"));
  const correction = payload(f, {
    measurement: { ...READING, eighths: 4 },
    correction_of: first.checkin_id as string,
    correction_reason: "Read the tape again",
  });
  const responses = await Promise.all([
    post(f, "measurement-race-one", correction),
    post(f, "measurement-race-two", correction),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const refused = await responses.find((response) => response.status === 409)!.json<{ error: string; retryable: boolean }>();
  assert.equal(refused.error, "field_measurement_correction_conflict");
  assert.equal(refused.retryable, false);
  const successors = f.db.raw.prepare("SELECT * FROM field_actions WHERE measurement_correction_of=?")
    .all(first.checkin_id as string);
  assert.equal(successors.length, 1);
  assert.equal(successors[0].status, "verified");
  assert.equal(manifests(f).length, 2);
});

test("Blocked allows safe measurement capture and correction without restart, release or acceptance", async (t) => {
  const f = await fixture(true);
  t.after(() => f.db.close());
  const scope = {
    workPackageId: WP, workPackageVersion: 1, jobId: JOB, assignmentId: f.assignmentId,
    actorUser: USERS.field.email, actorRole: "field", releaseAttemptId: "measurement-release-0001",
    workObjectType: "Roof Job", workObjectId: JOB, physicalContextType: "Roof Site", physicalContextId: JOB,
  };
  await nativeWorkPackageAction(f.env, {
    ...scope, kind: "stop_work", deviceActionId: "measurement-safe-stop",
    blockerReason: "Unsafe access; observe from a safe location only",
    manifestKey: "field/measurement-safe-stop.json",
  });
  const typed = payload(f, {
    work_package_id: WP, work_package_version: 1, evidence_slot_id: "step:1",
    evidence_requirement: "Eave reading and tape photo", evidence_source: "field-companion",
    work_package_release_attempt_id: "measurement-release-0001",
  });
  const first = await checked(await post(f, "measurement-blocked-base", typed, fieldAuth(), true));
  const evidenceId = (first.media as Array<{ evidence_id: string }>)[0].evidence_id;
  await checked(await post(f, "measurement-blocked-correct", {
    ...typed, measurement: { ...READING, eighths: 4 },
    evidence_correction_of: `wpe_${evidenceId.slice(4)}`, evidence_item_correction_of: evidenceId,
    correction_reason: "Corrected the safe observation",
  }, fieldAuth(), true));
  assert.equal(f.db.raw.prepare("SELECT status FROM work_packages WHERE work_package_id=?").get(WP)!.status, "Blocked");
  await assert.rejects(nativeWorkPackageAction(f.env, {
    ...scope, kind: "start_work", deviceActionId: "measurement-blocked-restart",
    blockerReason: null, manifestKey: "field/measurement-blocked-restart.json",
  }), /work_package_action_not_allowed/);
  const read = await checked(await handleAuthenticatedRoute(request("GET", PATH), f.env, fieldAuth()));
  assert.equal((read.packet as { work_package: { status: string } }).work_package.status, "Blocked");
  assert.equal((read.allowed_actions as string[]).includes("work_package.start"), false);
  assert.equal((read.allowed_actions as string[]).includes("work_package.complete"), false);
  const rows = f.db.raw.prepare("SELECT * FROM field_actions ORDER BY created_at,device_action_id").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.assignment_id === f.assignmentId && row.work_package_id === WP && row.work_package_version === 1));
  assert.ok(rows.every((row) => row.evidence_verification === "Verified" && row.evidence_disposition === "Open"));
  assert.equal(f.db.raw.prepare("SELECT COUNT(*) n FROM native_measurement_revisions").get()!.n, 0);
  assert.equal(f.db.raw.prepare("SELECT COUNT(*) n FROM measurement_deltas").get()!.n, 0);
});

test("Work Package measurement uses the real current authorization and rejects stale package/release/actor/device bindings", async (t) => {
  const f = await fixture(true);
  t.after(() => f.db.close());
  const typed = payload(f, {
    work_package_id: WP,
    work_package_version: 1,
    evidence_slot_id: "step:1",
    evidence_requirement: "Eave reading and tape photo",
    evidence_source: "field-companion",
    work_package_release_attempt_id: "measurement-release-0001",
  });
  const saved = await checked(
    await post(f, "measurement-typed-0001", typed, fieldAuth(), true),
  );
  assert.equal(saved.status, "verified");
  const row = f.db.raw
    .prepare(
      "SELECT * FROM field_actions WHERE device_action_id='measurement-typed-0001'",
    )
    .get()!;
  assert.equal(row.evidence_verification, "Verified");
  assert.equal(row.evidence_disposition, "Open");
  assert.equal(row.evidence_device_id, DEVICE);
  const puts = f.objects.puts;
  for (const [index, change] of [
    { work_package_version: 2 },
    { work_package_id: "wp:wrong:0001" },
    { work_package_release_attempt_id: "stale-release" },
    { evidence_device_id: "another-device" },
    { evidence_disposition: "Accepted" as const },
  ].entries()) {
    const refused = await post(
      f,
      `measurement-typed-bad-${index}`,
      { ...typed, ...change },
      fieldAuth(),
      true,
    );
    assert.ok(
      [400, 409].includes(refused.status),
      JSON.stringify(await refused.json()),
    );
  }
  const notAssigned = fieldAuth();
  notAssigned.session.user_id = "appu_unassigned_0001";
  notAssigned.session.email_normalized = "other@example.invalid";
  notAssigned.session.frappe_user_id = "other@example.invalid";
  f.db.raw
    .prepare(
      `INSERT INTO app_users(user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
        VALUES ('appu_unassigned_0001','ironwrap','other@example.invalid','Unassigned synthetic worker','field','field','other@example.invalid',1,'seed',?,?)`,
    )
    .run(SEED_TIME, SEED_TIME);
  assert.equal(
    (
      await handleFieldAction(
        multipart("measurement-typed-actor-0001", typed, true),
        f.env,
        notAssigned,
        JOB,
        f.assignmentId,
      )
    ).status,
    403,
  );
  assert.equal(f.objects.puts, puts);
});

test("a typed measurement correction retains the immutable media and Work Package lineage", async (t) => {
  const f = await fixture(true);
  t.after(() => f.db.close());
  const typed = payload(f, {
    work_package_id: WP,
    work_package_version: 1,
    evidence_slot_id: "step:1",
    evidence_requirement: "Eave reading and tape photo",
    evidence_source: "field-companion",
    work_package_release_attempt_id: "measurement-release-0001",
  });
  const first = await checked(
    await post(f, "measurement-typed-base-0001", typed, fieldAuth(), true),
  );
  const evidenceId = (first.media as Array<{ evidence_id: string }>)[0]
    .evidence_id;
  const current = await checked(
    await handleAuthenticatedRoute(request("GET", PATH), f.env, fieldAuth()),
  );
  const originalForCrew = (
    current.field_measurements as FieldMeasurementReadItem[]
  )[0];
  assert.deepEqual(originalForCrew.allowed_actions, [
    "field.measurement.correct",
  ]);
  assert.deepEqual(originalForCrew.correction_target, {
    evidence_correction_of: `wpe_${evidenceId.slice(4)}`,
    evidence_item_correction_of: evidenceId,
  });
  const corrected = await checked(
    await post(
      f,
      "measurement-typed-fix-0001",
      {
        ...typed,
        measurement: { ...READING, eighths: 4 },
        evidence_correction_of: `wpe_${evidenceId.slice(4)}`,
        evidence_item_correction_of: evidenceId,
        correction_reason: "Corrected the tape reading",
      },
      fieldAuth(),
      true,
    ),
  );
  const read = await listFieldMeasurementsFromD1(f.env, {
    tenantId: "ironwrap",
    jobId: JOB,
  });
  const item = read!.items.find(
    (item) => item.checkin_id === corrected.checkin_id,
  )!;
  assert.equal(item.correction_of, first.checkin_id);
  assert.equal(item.evidence_item_correction_of, evidenceId);
  const after = await checked(
    await handleAuthenticatedRoute(request("GET", PATH), f.env, fieldAuth()),
  );
  const originalAfter = (
    after.field_measurements as FieldMeasurementReadItem[]
  ).find((candidate) => candidate.checkin_id === first.checkin_id)!;
  assert.deepEqual(originalAfter.allowed_actions, []);
  assert.equal(originalAfter.correction_target, null);
  assert.equal(
    item.work_package_release_attempt_id,
    "measurement-release-0001",
  );
  assert.equal(
    f.db.raw.prepare("SELECT COUNT(*) n FROM field_action_media").get()!.n,
    2,
  );
});

test("legacy/non-measurement notes remain compatible and are never guessed into structured values", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const legacy = payload(f, {
    measurement: null,
    notes: "South eave 42 ft 7 3/8 in",
  });
  const saved = await checked(await post(f, "measurement-legacy-0001", legacy));
  assert.equal("measurement" in saved, false);
  const omitted = { ...legacy };
  delete omitted.measurement;
  assert.deepEqual(
    await checked(await post(f, "measurement-legacy-0001", omitted)),
    saved,
  );
  await checked(
    await post(
      f,
      "measurement-other-0001",
      payload(f, {
        proof_slot: "Access",
        measurement: null,
        notes: "Gate unlocked",
      }),
    ),
  );
  assert.deepEqual(
    (await listFieldMeasurementsFromD1(f.env, {
      tenantId: "ironwrap",
      jobId: JOB,
    }))!.items,
    [],
  );
  assert.equal(manifests(f).length, 2);
  assert.match(
    new TextDecoder().decode(manifests(f)[0][1].bytes),
    /South eave 42 ft 7 3\/8 in/,
  );
  assert.equal(
    f.db.raw
      .prepare(
        "SELECT COUNT(*) n FROM field_actions WHERE measurement_area_label IS NOT NULL",
      )
      .get()!.n,
    0,
  );
});

test("a transient R2 readback failure stays queued and is invisible on reload until the same capture is verified", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.objects.failStoredHead = true;
  const failed = await checked(await post(f, "measurement-recover-0001"), 502);
  assert.equal(failed.retryable, true);
  assert.deepEqual(
    (await listFieldMeasurementsFromD1(f.env, {
      tenantId: "ironwrap",
      jobId: JOB,
    }))!.items,
    [],
  );
  f.objects.failStoredHead = false;
  await checked(await post(f, "measurement-recover-0001"));
  assert.equal(
    (await listFieldMeasurementsFromD1(f.env, {
      tenantId: "ironwrap",
      jobId: JOB,
    }))!.items.length,
    1,
  );
  assert.equal(f.objects.puts, 1, "retry reused the immutable manifest");
});

test("an R2 checksum conflict is terminal and never appears as a saved structured measurement", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.objects.corruptHead = true;
  const failed = await checked(await post(f, "measurement-checksum-0001"), 409);
  assert.equal(failed.error, "immutable_object_conflict");
  assert.equal(failed.retryable, false);
  assert.deepEqual(
    (await listFieldMeasurementsFromD1(f.env, {
      tenantId: "ironwrap",
      jobId: JOB,
    }))!.items,
    [],
  );
});

test("real SQLite prevents measurement/manifest/verified receipt mutation, replacement, deletion and legacy backfill", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await checked(await post(f, "measurement-immutable-0001"));
  for (const set of [
    "measurement_eighths=4",
    "measurement_total_eighth_inches=4092",
    "measurement_device_id='another-device-0001'",
    "manifest_key='another-key'",
    "response_json='{}'",
    "status='retryable_error'",
  ])
    assert.throws(
      () =>
        f.db.raw.exec(
          `UPDATE field_actions SET ${set} WHERE device_action_id='measurement-immutable-0001'`,
        ),
      /field_measurement_immutable/,
    );
  assert.throws(
    () =>
      f.db.raw.exec(
        "DELETE FROM field_actions WHERE device_action_id='measurement-immutable-0001'",
      ),
    /field_measurement_immutable/,
  );
  const columns = f.db.raw
    .prepare("PRAGMA table_info(field_actions)")
    .all()
    .map((row) => row.name as string);
  assert.throws(
    () =>
      f.db.raw.exec(
        `INSERT OR REPLACE INTO field_actions(${columns.join(",")}) SELECT ${columns.join(",")} FROM field_actions WHERE device_action_id='measurement-immutable-0001'`,
      ),
    /field_measurement_immutable/,
  );
  await checked(
    await post(
      f,
      "measurement-backfill-0001",
      payload(f, { measurement: null, notes: "Old text" }),
    ),
  );
  assert.throws(
    () =>
      f.db.raw.exec(
        "UPDATE field_actions SET measurement_area_label='Guessed eave' WHERE device_action_id='measurement-backfill-0001'",
      ),
    /field_measurement_immutable/,
  );
});

test("field measurement history pages past 100 without duplicating rows or widening job access", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const originalId = "measurement-page-original";
  await checked(await post(f, originalId));
  const original = f.db.raw
    .prepare("SELECT * FROM field_actions WHERE device_action_id=?")
    .get(originalId) as Record<string, string | number | null>;
  const columns = Object.keys(original);
  const insert = f.db.raw.prepare(
    `INSERT INTO field_actions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (let index = 1; index <= 101; index++) {
    const deviceActionId = `measurement-page-${String(index).padStart(4, "0")}`;
    const checkinId = `fci_${createHash("sha256").update(deviceActionId).digest("hex").slice(0, 32)}`;
    const createdAt = new Date(
      Date.parse(String(original.created_at)) + index * 1000,
    ).toISOString();
    const response = JSON.parse(String(original.response_json)) as Record<
      string,
      unknown
    >;
    const row = {
      ...original,
      device_action_id: deviceActionId,
      checkin_id: checkinId,
      manifest_key: `raw/field/measurement-page-${index}/manifest.json`,
      response_json: JSON.stringify({ ...response, checkin_id: checkinId }),
      created_at: createdAt,
      updated_at: createdAt,
      verified_at: createdAt,
    };
    insert.run(...columns.map((column) => row[column]));
  }
  const route = `${PATH}/field-measurements`;
  const firstResponse = await handleAuthenticatedRoute(
    request("GET", route),
    f.env,
    fieldAuth(),
  );
  const first = await checked(firstResponse);
  assert.match(
    firstResponse.headers.get("Cache-Control") ?? "",
    /private.*no-store/,
  );
  assert.equal((first.items as FieldMeasurementCapture[]).length, 100);
  assert.equal(first.page_size, 100);
  assert.deepEqual(first.allowed_actions, []);
  assert.equal(typeof first.next_cursor, "string");
  const second = await checked(
    await handleAuthenticatedRoute(
      request("GET", `${route}?cursor=${first.next_cursor}`),
      f.env,
      fieldAuth(),
    ),
  );
  assert.equal((second.items as FieldMeasurementCapture[]).length, 2);
  assert.equal(second.next_cursor, null);
  const ids = [
    ...(first.items as FieldMeasurementCapture[]),
    ...(second.items as FieldMeasurementCapture[]),
  ].map((item) => item.device_action_id);
  assert.equal(new Set(ids).size, 102);
  assert.ok(ids.includes(originalId));

  const owner = await checked(
    await handleAuthenticatedRoute(request("GET", route), f.env, auth("owner")),
  );
  assert.equal((owner.items as FieldMeasurementCapture[]).length, 100);
  assert.deepEqual(owner.allowed_actions, []);
  for (const cursor of [
    "",
    "garbage",
    "e30",
    `${first.next_cursor}&cursor=duplicate`,
    "x=1",
  ]) {
    const query = cursor === "x=1" ? cursor : `cursor=${cursor}`;
    const refusal = await checked(
      await handleAuthenticatedRoute(
        request("GET", `${route}?${query}`),
        f.env,
        fieldAuth(),
      ),
      400,
    );
    assert.equal(refusal.error, "invalid_field_measurement_cursor");
  }
  const otherTenant = fieldAuth();
  otherTenant.session.tenant_id = "another-tenant";
  await checked(
    await handleAuthenticatedRoute(request("GET", route), f.env, otherTenant),
    404,
  );
  const unassigned = fieldAuth();
  unassigned.session.user_id = "appu_not_assigned_0001";
  unassigned.session.email_normalized = "not-assigned@example.invalid";
  await checked(
    await handleAuthenticatedRoute(request("GET", route), f.env, unassigned),
    404,
  );
});
