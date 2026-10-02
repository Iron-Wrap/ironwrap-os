import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";
import { getEnvelope } from "../src/store.ts";
import { auth, request, setup } from "./pipeline-board-fixture.ts";
import { MemoryR2 } from "./onboarding-fixture.ts";
import {
  officeLeadReceiptResponseSchema,
  salesLeadDetailResponseSchema,
  newLeadResponseSchema,
} from "../../app/src/sales/sales-contracts.ts";

const CREATE = "/api/v1/sales/leads?include_receipt=1";
const key = () => `office-lead:${crypto.randomUUID()}`;
const input = {
  name: "Morgan Example",
  email: "morgan@example.invalid",
  phone: "+1 403 555 0171",
  address: "12 Example Lane",
  city: "Example City",
  province: "AB",
  postal_code: "T1A 1A1",
  service: "Custom metal trim",
  message: "Review south fascia",
  intake_source: "referral",
  preferred_contact_channel: "email",
  email_estimate_follow_up_consent: true,
};
function fixture() {
  const base = setup();
  const queued: unknown[] = [];
  const raw = new MemoryR2();
  Object.assign(base.env, {
    RAW: raw,
    JN_QUEUE: {
      send: async (value: unknown) => {
        queued.push(value);
      },
    },
    PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "Alberta, Canada",
  });
  return { ...base, queued, raw };
}
function create(
  f: ReturnType<typeof fixture>,
  id: string,
  body: unknown = input,
  actor = auth("sales"),
) {
  return handleAuthenticatedRoute(
    request("POST", CREATE, { body, idempotency: id }),
    f.env,
    actor,
  );
}
async function receipt(response: Response) {
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return officeLeadReceiptResponseSchema.parse(json).receipt;
}
async function get(
  f: ReturnType<typeof fixture>,
  id: string,
  actor = auth("sales"),
) {
  return handleAuthenticatedRoute(
    request("GET", `/api/v1/sales/intakes/${encodeURIComponent(id)}`),
    f.env,
    actor,
  );
}
function count(f: ReturnType<typeof fixture>, table: string) {
  return (
    f.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

test("new office capture has persisted facts, one stable identity, no acknowledgement, and exact read after native materialization", async () => {
  const f = fixture();
  try {
    const id = key();
    let pendingEffects = 0;
    const response = await handleAuthenticatedRoute(
      request("POST", CREATE, { body: input, idempotency: id }),
      f.env,
      auth("sales"),
      {
        ctx: {
          waitUntil() {
            pendingEffects++;
          },
        },
      },
    );
    const saved = await receipt(response);
    assert.equal(pendingEffects, 0);
    assert.equal(saved.outcome, "created");
    assert.equal(saved.lead_id, null);
    assert.equal(saved.submitted_details_applied, true);
    assert.equal(saved.details?.intake_source, "referral");
    assert.equal(saved.details?.preferred_contact_channel, "email");
    assert.deepEqual(saved.details?.email_consent, {
      status: "granted",
      purpose: "estimate_follow_up",
      recorded_at: saved.captured_at,
      captured_by: auth("sales").session.user_id,
      jurisdiction: "Alberta, Canada",
      wording_version: "office-estimate-follow-up-v1",
    });
    const replay = await receipt(await create(f, id));
    assert.deepEqual(replay, saved);
    assert.equal(f.queued.length, 1);
    const envelope = await getEnvelope(f.env, saved.canonical_envelope_id!);
    assert.ok(envelope);
    const rawCapture = JSON.parse(
      await (await f.raw.get(envelope.raw_key!))!.text(),
    ).office_capture;
    assert.equal(rawCapture.intake_source, "referral");
    assert.equal(
      rawCapture.email_consent.captured_by,
      auth("sales").session.user_id,
    );
    assert.equal(rawCapture.email_consent.recorded_at, saved.captured_at);
    const core = await materializeOperatingCore(f.env, envelope);
    assert.equal(core.consentIds.length, 1);
    const persisted = f.db.raw
      .prepare(
        "SELECT channel, purpose, status, captured_by, recorded_at FROM operating_consents WHERE lead_id = ?",
      )
      .get(core.leadId);
    assert.deepEqual(
      { ...persisted },
      {
        channel: "email",
        purpose: "estimate_follow_up",
        status: "granted",
        captured_by: auth("sales").session.user_id,
        recorded_at: saved.captured_at,
      },
    );
    assert.equal((await receipt(await get(f, id))).lead_id, core.leadId);
    const detailResponse = await handleAuthenticatedRoute(
      request("GET", `/api/v1/sales/leads/${encodeURIComponent(core.leadId)}`),
      f.env,
      auth("sales"),
    );
    assert.equal(detailResponse.status, 200);
    const detail = salesLeadDetailResponseSchema.parse(
      await detailResponse.json(),
    );
    assert.equal(detail.lead.id, core.leadId);
    assert.deepEqual(detail.intake, saved.details);
    assert.equal(
      detailResponse.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(count(f, "lead_ack_receipts"), 0);
  } finally {
    f.db.close();
  }
});

test("duplicate returns original persisted facts and cannot overwrite preference, source or consent", async () => {
  const f = fixture();
  try {
    const first = await receipt(
      await create(f, key(), {
        ...input,
        preferred_contact_channel: null,
        email_estimate_follow_up_consent: false,
      }),
    );
    const duplicate = await receipt(
      await create(f, key(), {
        ...input,
        name: "Unapplied Name",
        intake_source: "phone",
        message: "Unapplied replacement",
      }),
    );
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(duplicate.submitted_details_applied, false);
    assert.equal(duplicate.canonical_envelope_id, first.canonical_envelope_id);
    assert.deepEqual(duplicate.details, first.details);
    assert.equal(duplicate.details?.email_consent.status, "not_recorded");
    const envelope = await getEnvelope(f.env, first.canonical_envelope_id!);
    const core = await materializeOperatingCore(f.env, envelope!);
    assert.deepEqual(core.consentIds, []);
    assert.equal(f.queued.length, 1);
  } finally {
    f.db.close();
  }
});

test("concurrent same-key commands and a lost queue acknowledgement retain one envelope and a recoverable receipt", async () => {
  const f = fixture();
  try {
    const id = key();
    const before = count(f, "envelopes");
    const results = await Promise.all([create(f, id), create(f, id)]);
    const [a, b] = await Promise.all(results.map(receipt));
    assert.equal(a.canonical_envelope_id, b.canonical_envelope_id);
    assert.equal(count(f, "envelopes"), before + 1);
    assert.equal(count(f, "office_lead_intake_receipts"), 1);
    assert.equal(
      (await create(f, id, { ...input, message: "Changed intent" })).status,
      409,
    );
    const retryId = key();
    const retryInput = {
      ...input,
      email: "second@example.invalid",
      phone: "+1 403 555 0172",
    };
    let failQueue = true;
    f.env.JN_QUEUE = {
      send: async () => {
        if (failQueue) throw new Error("fixture queue interrupted");
      },
    } as never;
    assert.equal((await create(f, retryId, retryInput)).status, 503);
    const beforeRead = f.db.raw.prepare("SELECT total_changes() AS n").get();
    assert.equal((await receipt(await get(f, retryId))).state, "processing");
    assert.deepEqual(
      f.db.raw.prepare("SELECT total_changes() AS n").get(),
      beforeRead,
    );
    failQueue = false;
    const recovered = await receipt(await create(f, retryId, retryInput));
    assert.equal(recovered.outcome, "created");
    assert.equal(count(f, "envelopes"), before + 2);
    assert.deepEqual(await receipt(await get(f, retryId)), recovered);
  } finally {
    f.db.close();
  }
});

test("role, actor, tenant, CSRF, request identity and capture validation fail before any writes", async () => {
  const f = fixture();
  try {
    const initial = count(f, "office_lead_intake_receipts");
    for (const role of ["field", "production"] as const)
      assert.equal((await create(f, key(), input, auth(role))).status, 403);
    assert.equal(
      (await create(f, key(), input, auth("sales", "other-co"))).status,
      403,
    );
    assert.equal((await create(f, "bad-request-id")).status, 400);
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request("POST", CREATE, {
            body: input,
            idempotency: key(),
            csrf: false,
          }),
          f.env,
          auth("sales"),
        )
      ).status,
      403,
    );
    const invalid = [
      { ...input, intake_source: "website" },
      { ...input, preferred_contact_channel: "sms" },
      { ...input, phone: null, preferred_contact_channel: "phone" },
      { ...input, email: null },
      { ...input, email_estimate_follow_up_consent: "true" },
      { ...input, captured_by: "client actor" },
    ];
    for (const body of invalid)
      assert.equal((await create(f, key(), body)).status, 400);
    f.env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION = "";
    assert.equal((await create(f, key())).status, 503);
    assert.equal(count(f, "office_lead_intake_receipts"), initial);
    assert.equal(f.raw.objects.size, 0);
    const id = key();
    assert.equal((await get(f, id)).status, 404);
    await receipt(
      await create(f, id, {
        ...input,
        email_estimate_follow_up_consent: false,
      }),
    );
    assert.equal((await get(f, id, auth("ops"))).status, 404);
    assert.equal((await get(f, id, auth("sales", "other-co"))).status, 404);
    assert.equal((await get(f, id, auth("field"))).status, 403);
    assert.equal(
      (
        await create(
          f,
          id,
          { ...input, email_estimate_follow_up_consent: false },
          auth("ops"),
        )
      ).status,
      404,
    );
  } finally {
    f.db.close();
  }
});

test("legacy create preserves the previous response and rejects new fields without explicit opt-in", async () => {
  const f = fixture();
  try {
    const old = {
      name: input.name,
      email: input.email,
      service: input.service,
    };
    const response = await handleAuthenticatedRoute(
      request("POST", "/api/v1/sales/leads", { body: old }),
      f.env,
      auth("sales"),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body as object).sort(), ["lead", "version"]);
    newLeadResponseSchema.parse(body);
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request("POST", "/api/v1/sales/leads", { body: input }),
          f.env,
          auth("sales"),
        )
      ).status,
      400,
    );
    assert.equal(count(f, "office_lead_intake_receipts"), 0);
  } finally {
    f.db.close();
  }
});

test("raw office marker cannot mint consent; receipt bindings resist overwrite, deletion and replacement", async () => {
  const f = fixture();
  try {
    const id = key();
    const saved = await receipt(await create(f, id));
    assert.throws(
      () =>
        f.db.raw
          .prepare(
            "UPDATE office_lead_intake_receipts SET input_json = '{}' WHERE request_id = ?",
          )
          .run(id),
      /immutable/,
    );
    assert.throws(
      () =>
        f.db.raw
          .prepare(
            "DELETE FROM office_lead_intake_receipts WHERE request_id = ?",
          )
          .run(id),
      /immutable/,
    );
    assert.throws(
      () =>
        f.db.raw.exec(
          "INSERT OR REPLACE INTO office_lead_intake_receipts SELECT * FROM office_lead_intake_receipts",
        ),
      /immutable/,
    );
    const original = await getEnvelope(f.env, saved.canonical_envelope_id!);
    await assert.rejects(
      materializeOperatingCore(f.env, {
        ...original!,
        contact_email: "changed@example.invalid",
      }),
      /provenance_conflict/,
    );
    const forged = {
      ...original!,
      envelope_id: "ow_forged",
      contact_email: "forged@example.invalid",
      contact_phone: null,
    };
    f.db.raw
      .prepare(
        `INSERT INTO envelopes (envelope_id, source, contact_email, payload_json, raw_key, ts, status, attempts, created_at, updated_at, tenant_id)
      VALUES (?, 'manual', ?, ?, ?, ?, 'received', 0, ?, ?, 'ironwrap')`,
      )
      .run(
        forged.envelope_id,
        forged.contact_email,
        forged.payload_json,
        forged.raw_key,
        forged.ts,
        forged.created_at,
        forged.updated_at,
      );
    assert.deepEqual(
      (await materializeOperatingCore(f.env, forged)).consentIds,
      [],
    );
  } finally {
    f.db.close();
  }
});

test("exact lead lookup reaches a record beyond the bounded desk and remains tenant-scoped and read-only", async () => {
  const f = fixture();
  try {
    const saved = await receipt(await create(f, key()));
    const core = await materializeOperatingCore(
      f.env,
      (await getEnvelope(f.env, saved.canonical_envelope_id!))!,
    );
    for (let i = 0; i < 101; i++) {
      const envelope = `ow_extra_${i}`;
      const lead = `lead:ironwrap:${i.toString(16).padStart(64, "0")}`;
      f.db.raw
        .prepare(
          `INSERT INTO envelopes (envelope_id,source,payload_json,ts,status,attempts,created_at,updated_at,tenant_id)
        VALUES (?, 'manual', '{}', '2098-01-01T00:00:00.000Z', 'received', 0, '2098-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z', 'ironwrap')`,
        )
        .run(envelope);
      f.db.raw
        .prepare(
          `INSERT INTO operating_leads (lead_id,tenant_id,source_envelope_id,source,created_at,updated_at)
        VALUES (?, 'ironwrap', ?, 'manual', '2098-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z')`,
        )
        .run(lead, envelope);
    }
    const deskResponse = await handleAuthenticatedRoute(
      request("GET", "/api/v1/sales"),
      f.env,
      auth("sales"),
    );
    const desk = (await deskResponse.json()) as {
      leads: Array<{ id: string }>;
    };
    assert.equal(desk.leads.length, 100);
    assert.ok(desk.leads.every((lead) => lead.id !== core.leadId));
    const totalChanges = f.db.raw.prepare("SELECT total_changes() AS n").get();
    const url = `/api/v1/sales/leads/${encodeURIComponent(core.leadId)}`;
    const exact = await handleAuthenticatedRoute(
      request("GET", url),
      f.env,
      auth("sales"),
    );
    assert.equal(exact.status, 200);
    const model = salesLeadDetailResponseSchema.parse(await exact.json());
    assert.equal(model.lead.id, core.leadId);
    assert.equal(model.lead.job?.id, core.roofJobId);
    assert.equal(model.lead.consent.records.length, 1);
    assert.deepEqual(model.partial_sources, []);
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request("GET", url),
          f.env,
          auth("sales", "other-co"),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request("GET", url),
          f.env,
          auth("field"),
        )
      ).status,
      403,
    );
    assert.deepEqual(
      f.db.raw.prepare("SELECT total_changes() AS n").get(),
      totalChanges,
    );
    const realDb = f.env.DB;
    f.env.DB = {
      prepare(sql: string) {
        if (sql.includes("FROM operating_leads"))
          throw new Error("fixture read failed");
        return realDb.prepare(sql);
      },
    } as never;
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request("GET", url),
          f.env,
          auth("sales"),
        )
      ).status,
      502,
    );
  } finally {
    f.db.close();
  }
});

test("a failed first raw write preserves its receipt and explicit replay retains the same assigned envelope", async () => {
  const f = fixture();
  try {
    const id = key();
    const body = {
      ...input,
      email_estimate_follow_up_consent: false,
      preferred_contact_channel: null,
    };
    let fail = true;
    f.env.RAW = {
      put: async (...args: Parameters<MemoryR2["put"]>) => {
        if (fail) throw new Error("fixture R2 interrupted");
        return f.raw.put(...args);
      },
    } as never;
    const before = count(f, "envelopes");
    assert.equal((await create(f, id, body)).status, 503);
    const held = f.db.raw
      .prepare(
        "SELECT envelope_id FROM office_lead_intake_receipts WHERE request_id = ?",
      )
      .get(id) as { envelope_id: string };
    assert.equal(count(f, "envelopes"), before);
    assert.equal((await receipt(await get(f, id))).state, "processing");
    fail = false;
    const result = await receipt(await create(f, id, body));
    assert.equal(result.canonical_envelope_id, held.envelope_id);
    assert.equal(result.details?.preferred_contact_channel, null);
    assert.equal(result.details?.email_consent.status, "not_recorded");
    assert.equal(count(f, "envelopes"), before + 1);
  } finally {
    f.db.close();
  }
});

test("a crash after claiming contact dedup resumes the same envelope and cannot publish a nonexistent duplicate", async () => {
  const f = fixture();
  try {
    const originalDb = f.env.DB;
    const firstId = key();
    const competingId = key();
    let failEnvelope = true;
    f.env.DB = {
      prepare(sql: string) {
        if (failEnvelope && sql.includes("INSERT INTO envelopes"))
          throw new Error("fixture envelope write interrupted");
        return originalDb.prepare(sql);
      },
    } as never;
    const before = count(f, "envelopes");
    assert.equal((await create(f, firstId)).status, 503);
    const held = f.db.raw
      .prepare(
        "SELECT envelope_id FROM office_lead_intake_receipts WHERE request_id = ?",
      )
      .get(firstId) as { envelope_id: string };
    assert.equal(count(f, "envelopes"), before);
    assert.equal(count(f, "dedup_claims"), 1);
    failEnvelope = false;
    // The foreign dedup claim has no envelope yet: never report a recorded duplicate.
    assert.equal((await create(f, competingId)).status, 503);
    assert.equal(
      (await receipt(await get(f, competingId))).state,
      "processing",
    );
    const resumed = await receipt(await create(f, firstId));
    assert.equal(resumed.outcome, "created");
    assert.equal(resumed.canonical_envelope_id, held.envelope_id);
    const duplicate = await receipt(await create(f, competingId));
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(
      duplicate.canonical_envelope_id,
      resumed.canonical_envelope_id,
    );
    assert.deepEqual(duplicate.details, resumed.details);
    assert.equal(count(f, "envelopes"), before + 1);
    assert.equal(f.queued.length, 1);
  } finally {
    f.db.close();
  }
});

function resume(
  f: ReturnType<typeof fixture>,
  id: string,
  actor = auth("sales"),
  body: unknown = {},
) {
  return handleAuthenticatedRoute(
    request("POST", `/api/v1/sales/intakes/${encodeURIComponent(id)}/resume`, {
      body,
      idempotency: null,
    }),
    f.env,
    actor,
  );
}

test("fresh-page explicit resume repairs raw or queue failure using only the saved identity; GET has no effects", async () => {
  for (const fault of ["raw", "queue"] as const) {
    const f = fixture();
    try {
      const id = key();
      let fail = true;
      let rawWrites = 0;
      let queueWrites = 0;
      f.env.RAW = {
        put: async (...args: Parameters<MemoryR2["put"]>) => {
          rawWrites++;
          if (fail && fault === "raw")
            throw new Error("fixture raw interrupted");
          return f.raw.put(...args);
        },
      } as never;
      f.env.JN_QUEUE = {
        send: async (value: unknown) => {
          queueWrites++;
          if (fail && fault === "queue")
            throw new Error("fixture queue interrupted");
          f.queued.push(value);
        },
      } as never;
      assert.equal((await create(f, id)).status, 503);
      const saved = f.db.raw
        .prepare(
          "SELECT * FROM office_lead_intake_receipts WHERE request_id = ?",
        )
        .get(id) as Record<string, unknown>;
      const beforeGet = [
        rawWrites,
        queueWrites,
        f.db.raw.prepare("SELECT total_changes() AS n").get(),
      ];
      assert.equal((await receipt(await get(f, id))).state, "processing");
      assert.deepEqual(
        [
          rawWrites,
          queueWrites,
          f.db.raw.prepare("SELECT total_changes() AS n").get(),
        ],
        beforeGet,
      );
      fail = false;
      // New client has only the receipt identity: no mutable form body is submitted.
      const recovered = await receipt(await resume(f, id));
      assert.equal(recovered.canonical_envelope_id, saved.envelope_id);
      assert.equal(recovered.captured_at, saved.captured_at);
      assert.equal(recovered.details?.name, input.name);
      const completed = f.db.raw
        .prepare(
          "SELECT * FROM office_lead_intake_receipts WHERE request_id = ?",
        )
        .get(id) as Record<string, unknown>;
      for (const field of [
        "request_id",
        "request_hash",
        "actor_user_id",
        "input_json",
        "payload_json",
        "payload_sha256",
        "captured_at",
        "envelope_id",
      ])
        assert.equal(completed[field], saved[field]);
      const beforeReplay = [
        rawWrites,
        queueWrites,
        f.db.raw.prepare("SELECT total_changes() AS n").get(),
      ];
      assert.deepEqual(await receipt(await resume(f, id)), recovered);
      assert.deepEqual(
        [
          rawWrites,
          queueWrites,
          f.db.raw.prepare("SELECT total_changes() AS n").get(),
        ],
        beforeReplay,
      );
      assert.equal(f.queued.length, 1);
      assert.equal(count(f, "lead_ack_receipts"), 0);
    } finally {
      f.db.close();
    }
  }
});

test("concurrent receipt resumes share one envelope and native lead", async () => {
  const f = fixture();
  try {
    const id = key();
    const beforeEnvelopes = count(f, "envelopes");
    const beforeLeads = count(f, "operating_leads");
    f.env.RAW = {
      put: async () => {
        throw new Error("fixture raw interrupted");
      },
    } as never;
    assert.equal((await create(f, id)).status, 503);
    f.env.RAW = f.raw as never;
    const [first, second] = await Promise.all(
      (await Promise.all([resume(f, id), resume(f, id)])).map(receipt),
    );
    assert.deepEqual(first, second);
    assert.equal(count(f, "envelopes"), beforeEnvelopes + 1);
    assert.equal(count(f, "office_lead_intake_receipts"), 1);
    const envelope = await getEnvelope(f.env, first.canonical_envelope_id!);
    const one = await materializeOperatingCore(f.env, envelope!);
    const two = await materializeOperatingCore(f.env, envelope!);
    assert.equal(one.leadId, two.leadId);
    assert.equal(count(f, "operating_leads"), beforeLeads + 1);
    assert.equal(count(f, "lead_ack_receipts"), 0);
  } finally {
    f.db.close();
  }
});

test("resume rejects other actors, tenants, roles, missing CSRF, new input and missing receipts without creating anything", async () => {
  const f = fixture();
  try {
    const id = key();
    f.env.RAW = {
      put: async () => {
        throw new Error("fixture raw interrupted");
      },
    } as never;
    assert.equal((await create(f, id)).status, 503);
    f.env.RAW = f.raw as never;
    const before = f.db.raw.prepare("SELECT total_changes() AS n").get();
    assert.equal((await resume(f, key())).status, 404);
    assert.equal((await resume(f, "not-a-request")).status, 404);
    assert.equal((await resume(f, id, auth("ops"))).status, 404);
    assert.equal((await resume(f, id, auth("sales", "other-co"))).status, 403);
    for (const role of ["field", "production"] as const)
      assert.equal((await resume(f, id, auth(role))).status, 403);
    assert.equal((await resume(f, id, auth("sales"), { input })).status, 400);
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            "POST",
            `/api/v1/sales/intakes/${encodeURIComponent(id)}/resume`,
            { body: {}, csrf: false },
          ),
          f.env,
          auth("sales"),
        )
      ).status,
      403,
    );
    assert.deepEqual(
      f.db.raw.prepare("SELECT total_changes() AS n").get(),
      before,
    );
    assert.equal(f.raw.objects.size, 0);
    assert.equal(f.queued.length, 0);
    assert.equal(count(f, "office_lead_intake_receipts"), 1);
  } finally {
    f.db.close();
  }
});

test("resume fails closed on saved snapshot hash drift before raw, queue or database writes", async () => {
  const f = fixture();
  try {
    const id = key();
    f.env.RAW = {
      put: async () => {
        throw new Error("fixture raw interrupted");
      },
    } as never;
    assert.equal((await create(f, id)).status, 503);
    f.env.RAW = f.raw as never;
    const originalDb = f.env.DB;
    f.env.DB = {
      prepare(sql: string) {
        const statement = originalDb.prepare(sql);
        if (!sql.includes("SELECT * FROM office_lead_intake_receipts"))
          return statement;
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return {
              first: async () => {
                const row = await bound.first<Record<string, unknown>>();
                return row ? { ...row, request_hash: "0".repeat(64) } : row;
              },
            };
          },
        };
      },
    } as never;
    const before = f.db.raw.prepare("SELECT total_changes() AS n").get();
    const response = await resume(f, id);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "office_intake_snapshot_invalid",
    });
    assert.deepEqual(
      f.db.raw.prepare("SELECT total_changes() AS n").get(),
      before,
    );
    assert.equal(f.raw.objects.size, 0);
    assert.equal(f.queued.length, 0);
  } finally {
    f.db.close();
  }
});
