// The shared commercial context: who may read it, what it refuses to claim, and the source binding
// a follow-up decision is written against.
//
// The quote -> proposal -> publication -> acceptance progression on real records, and a draft quote
// on real records, are asserted inside `iro208-commercial-reference.test.ts`, which already builds
// that chain through the real routes. This file covers the gates, the contact and consent facts, the
// blockers, and the offer states real data cannot cheaply reach.
//
// Fixtures follow the only writer (`operating-core.ts`): addresses are stored lower-cased and
// trimmed, a customer's address equals its lead's whenever both are set, and an email consent row
// exists only for a lead that has its own address.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  commercialContextFrom,
  commercialSourceBindingDigest,
  sourceBindingChanges,
  type CommercialContactRow,
  type CommercialContextReadModel,
} from "../src/commercial-context.ts";
import type { CommercialJobPhaseReadModel } from "../src/commercial-job-phase.ts";

const TENANT = "ironwrap";
const AT = "2026-09-01T10:00:00.000Z";
const JOB = "JOB-CONTEXT-1";
const ADDRESS = "owner@northside.example";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
  }

  prepare(sql: string) {
    const raw = this.raw;
    return {
      bind: (...args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          return (raw.prepare(sql).get(...args) ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: raw.prepare(sql).all(...args) as T[] };
        },
      }),
    };
  }
}

interface Seed {
  tenant?: string;
  jobId?: string;
  customerEmail?: string | null;
  leadEmail?: string | null;
  consent?: "granted" | "denied" | null;
  consentChannel?: "email" | "phone";
  jobStatus?: "qualified" | "in_progress" | "complete" | "cancelled";
  leadStatus?: "untriaged" | "qualified" | "disqualified";
  customerStatus?: "prospect" | "active" | "archived";
}

function seed(db: SqliteD1, input: Seed = {}): void {
  const tenant = input.tenant ?? TENANT;
  const jobId = input.jobId ?? JOB;
  const raw = db.raw;
  const envelopeId = `ow_${tenant}_${jobId}`;
  raw
    .prepare(
      `INSERT INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at)
     VALUES (?, 'website', '{}', ?, 'received', ?, ?)`,
    )
    .run(envelopeId, AT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_phone, contact_email, lifecycle_status, created_at, updated_at)
     VALUES (?, ?, ?, 'website', 'Nora Northwind', '+14035550101', ?, ?, ?, ?)`,
    )
    .run(
      `LEAD-${jobId}`,
      tenant,
      envelopeId,
      input.leadEmail === undefined ? ADDRESS : input.leadEmail,
      input.leadStatus ?? "qualified",
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_phone, contact_email, lifecycle_status, created_at, updated_at)
     VALUES (?, ?, ?, 'Northside Holdings', '+14035550111', ?, ?, ?, ?)`,
    )
    .run(
      `CUSTOMER-${jobId}`,
      tenant,
      envelopeId,
      input.customerEmail === undefined ? ADDRESS : input.customerEmail,
      input.customerStatus ?? "active",
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'IW-2001', 'Metal re-roof', ?, ?, ?)`,
    )
    .run(
      jobId,
      tenant,
      `LEAD-${jobId}`,
      `CUSTOMER-${jobId}`,
      envelopeId,
      input.jobStatus ?? "qualified",
      AT,
      AT,
    );
  if (input.consent) {
    raw
      .prepare(
        `INSERT INTO operating_consents (consent_id, tenant_id, lead_id, customer_id, roof_job_id, source_envelope_id, source_raw_key, channel, purpose, status, jurisdiction, consent_basis, captured_by, recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'raw/leads/seed.json', ?, 'estimate_follow_up', ?, 'CA-AB', 'express', 'public_estimator', ?, ?)`,
      )
      .run(
        `consent:${jobId}:${input.consentChannel ?? "email"}`,
        tenant,
        `LEAD-${jobId}`,
        `CUSTOMER-${jobId}`,
        jobId,
        envelopeId,
        input.consentChannel ?? "email",
        input.consent,
        AT,
        AT,
      );
  }
}

function env(db: SqliteD1): AppEnv {
  return { APP_TENANT_ID: TENANT, DB: db } as unknown as AppEnv;
}

function auth(role: AppRole, tenantId = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: AT,
      session_expires_at: "2036-09-02T10:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: tenantId,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: AT,
      updated_at: AT,
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function get(db: SqliteD1, path: string, role: AppRole): Promise<Response> {
  return handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`),
    env(db),
    auth(role),
  );
}

async function context(
  db: SqliteD1,
  jobId = JOB,
): Promise<CommercialContextReadModel> {
  const response = await get(
    db,
    `/api/v1/jobs/${jobId}/commercial-context`,
    "sales",
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommercialContextReadModel;
}

test("the people who write to customers can read it; nobody else can, and nothing is cached", async () => {
  const db = new SqliteD1();
  seed(db, { consent: "granted" });
  for (const role of ["owner", "ops", "sales"] as const) {
    const response = await get(
      db,
      `/api/v1/jobs/${JOB}/commercial-context`,
      role,
    );
    assert.equal(response.status, 200, role);
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      role,
    );
  }
  // It carries the customer's email and consent, which the job packet never gives a crew.
  for (const role of ["field", "production", "accounting"] as const) {
    const response = await get(
      db,
      `/api/v1/jobs/${JOB}/commercial-context`,
      role,
    );
    assert.equal(response.status, 403, role);
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      role,
    );
    assert.deepEqual(
      await response.json(),
      { error: "sales_read_required" },
      role,
    );
  }
});

test("a crew can no longer read any job's commercial phase by id", async () => {
  const db = new SqliteD1();
  seed(db);
  const crew = await get(db, `/api/v1/jobs/${JOB}/phase`, "field");
  assert.equal(crew.status, 403);
  assert.deepEqual(await crew.json(), { error: "job_read_any_required" });
  assert.equal(crew.headers.get("cache-control"), "private, no-store");

  const office = await get(db, `/api/v1/jobs/${JOB}/phase`, "production");
  assert.equal(office.status, 200);
  // Quote totals and accounting intents must never sit in a shared cache.
  assert.equal(office.headers.get("cache-control"), "private, no-store");
  const missing = await get(db, "/api/v1/jobs/JOB-MISSING/phase", "owner");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "private, no-store");
});

test("a job in another tenant is a 404, not a refusal that confirms it exists", async () => {
  const db = new SqliteD1();
  seed(db, { tenant: "otherco", jobId: "JOB-THEIRS-1" });
  const response = await get(
    db,
    "/api/v1/jobs/JOB-THEIRS-1/commercial-context",
    "sales",
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("with granted consent for the recipient's own address, nothing in the records stops a follow-up", async () => {
  const db = new SqliteD1();
  seed(db, { consent: "granted" });
  const model = await context(db);

  assert.equal(model.schema, "ironwrap_commercial_context_v1");
  assert.equal(model.job.job_number, "IW-2001");
  assert.equal(model.job.customer_display_name, "Northside Holdings");
  assert.equal(model.offer.state, "no_quote");
  assert.equal(model.offer.quote_head, null);
  assert.equal(model.offer.withdrawn_acceptance, null);
  assert.deepEqual(model.contact.email, {
    address: ADDRESS,
    source: "customer",
  });
  assert.equal(model.contact.consent?.status, "granted");
  assert.equal(model.contact.consent?.channel, "email");
  assert.equal(model.contact.consent?.purpose, "estimate_follow_up");
  assert.deepEqual(model.follow_up.blockers, []);
  // What a consent row cannot prove is stated, not implied.
  assert.deepEqual(model.contact.consent_limits, [
    "no_revocation_recorded",
    "no_expiry",
    "not_bound_to_address",
    "estimate_follow_up_only",
  ]);
  assert.equal(model.source_binding.offer_state, "no_quote");
  assert.equal(model.source_binding.customer_archived, false);
  assert.equal(
    model.source_binding_sha256,
    await commercialSourceBindingDigest(model.source_binding),
  );
  // The phase reader's production, closeout and accounting reasons are not this route's to show.
  assert.deepEqual(model.stale_reasons, [
    "commercial.quote_head_missing",
    "commercial.proposal_head_missing",
    "commercial.publication_not_settled",
    "commercial.customer_acceptance_missing",
  ]);
  // The real phase also reports deposit, gates, closeout and invoices for this job; none reach sales.
  const office = (await (
    await get(db, `/api/v1/jobs/${JOB}/phase`, "owner")
  ).json()) as { stale_reasons: string[] };
  assert.ok(
    office.stale_reasons.some((reason) => reason.startsWith("production.")),
  );
  assert.ok(
    model.stale_reasons.every((reason) =>
      /^commercial\.(quote_|proposal_|publication_|customer_acceptance_)/.test(
        reason,
      ),
    ),
  );
});

test("each blocker is named for what is actually missing", async () => {
  const noConsent = new SqliteD1();
  seed(noConsent, { consent: null });
  assert.deepEqual((await context(noConsent)).follow_up.blockers, [
    "consent_missing",
  ]);

  const denied = new SqliteD1();
  seed(denied, { consent: "denied" });
  assert.deepEqual((await context(denied)).follow_up.blockers, [
    "consent_not_granted",
  ]);

  // A phone-only retry that reused an existing customer: the lead has no address of its own and
  // its consent row is for the phone. That row must not be read as email consent.
  const phoneOnly = new SqliteD1();
  seed(phoneOnly, {
    consent: "granted",
    consentChannel: "phone",
    leadEmail: null,
  });
  const phone = await context(phoneOnly);
  assert.deepEqual(phone.contact.email, {
    address: ADDRESS,
    source: "customer",
  });
  assert.equal(phone.contact.consent, null);
  assert.deepEqual(phone.follow_up.blockers, ["consent_missing"]);

  const noAddress = new SqliteD1();
  seed(noAddress, { consent: null, customerEmail: null, leadEmail: null });
  const unreachable = await context(noAddress);
  assert.equal(unreachable.contact.email, null);
  assert.equal(unreachable.source_binding.recipient_sha256, null);
  assert.deepEqual(unreachable.follow_up.blockers, [
    "recipient_email_missing",
    "consent_missing",
  ]);

  const cancelled = new SqliteD1();
  seed(cancelled, { consent: "granted", jobStatus: "cancelled" });
  assert.deepEqual((await context(cancelled)).follow_up.blockers, [
    "job_cancelled",
  ]);

  const disqualified = new SqliteD1();
  seed(disqualified, { consent: "granted", leadStatus: "disqualified" });
  assert.deepEqual((await context(disqualified)).follow_up.blockers, [
    "lead_disqualified",
  ]);

  const archived = new SqliteD1();
  seed(archived, { consent: "granted", customerStatus: "archived" });
  const archivedModel = await context(archived);
  assert.deepEqual(archivedModel.follow_up.blockers, ["customer_archived"]);
  assert.equal(archivedModel.source_binding.customer_archived, true);
});

test("consent given with one address does not cover a different recipient", async () => {
  // A phone-matched intake can leave the customer holding an older address while the new lead —
  // and its consent — carry another. The recipient would be the customer's.
  const db = new SqliteD1();
  seed(db, {
    consent: "granted",
    customerEmail: "old.owner@northside.example",
    leadEmail: "new.buyer@northside.example",
  });
  const model = await context(db);
  assert.deepEqual(model.contact.email, {
    address: "old.owner@northside.example",
    source: "customer",
  });
  assert.equal(model.contact.consent?.status, "granted");
  assert.deepEqual(model.follow_up.blockers, ["consent_recipient_mismatch"]);
});

// ---- pure mapping: the states real data cannot cheaply reach ----

function phase(
  commercial: Partial<CommercialJobPhaseReadModel["facts"]["commercial"]>,
  staleReasons: string[] = [],
) {
  return {
    version: 1,
    read_model_generated_at: AT,
    phase: "commercial_in_progress",
    job: {
      roof_job_id: JOB,
      lead_id: "LEAD-1",
      customer_id: "CUSTOMER-1",
      property_id: null,
      status: "qualified",
      current_gate_state: "qualification",
      version: 3,
    },
    facts: {
      commercial: {
        lead_status: "qualified",
        lead_version: 2,
        customer_status: "active",
        customer_version: 1,
        property_version: null,
        quote_head: null,
        quote: null,
        proposal: null,
        publication: null,
        acceptance: null,
        acceptance_under_withdrawn_publication: null,
        deposit_derivation: null,
        ...commercial,
      },
      production: {
        gates: [],
        all_required_gates_ready: false,
        assignment: null,
        work_package: null,
      },
      safety: { active_stops: [], blocked: false },
      accounting: {
        deposit_intents: [],
        final_invoice_intents: [],
        deposit_reconciled: false,
        final_invoice_reconciled: false,
      },
      closeout: { completion_packet: null },
      warranty: { warranty_declared: false, service_cases: [] },
    },
    stale_reasons: staleReasons,
  } as CommercialJobPhaseReadModel;
}

const CONTACT: CommercialContactRow = {
  job_number: "IW-2001",
  customer_display_name: "Northside Holdings",
  customer_email: ADDRESS,
  lead_email: ADDRESS,
  consent_id: "consent:1",
  consent_channel: "email",
  consent_purpose: "estimate_follow_up",
  consent_status: "granted",
  consent_basis: "express",
  consent_recorded_at: AT,
};

const HEAD = {
  quote_revision_id: "qrev-1",
  revision_number: 1,
  status: "approved",
  terms_hash: "t".repeat(64),
};
const QUOTE = {
  ...HEAD,
  customer_quote_id: "cq-1",
  currency: "CAD",
  total_cents: 105_000,
  valid_until: "2026-12-31",
};
const PROPOSAL = {
  proposal_revision_id: "prev-1",
  proposal_pack_id: "pack-1",
  revision_number: 1,
  quote_revision_id: "qrev-1",
  terms_hash: "t".repeat(64),
};
const PUBLISHED = {
  publication_event_id: "pub-1",
  proposal_revision_id: "prev-1",
  proposal_pack_id: "pack-1",
  publication_version: 1,
  state: "published",
  occurred_at: AT,
};
const ACCEPTANCE = {
  acceptance_binding_id: "bind-1",
  acceptance_id: "acc-1",
  quote_revision_id: "qrev-1",
  proposal_revision_id: "prev-1",
  terms_hash: "t".repeat(64),
  accepted_at: AT,
  bound_at: AT,
};

function build(
  commercial: Parameters<typeof phase>[0],
  stale: string[] = [],
  contact = CONTACT,
  now = AT,
) {
  return commercialContextFrom(
    TENANT,
    phase(commercial, stale),
    contact,
    new Date(now),
  );
}

test("the offer state names where the chain stops, and an unsettled chain blocks a follow-up", async () => {
  const cases: Array<[string, Parameters<typeof phase>[0], string[], boolean]> =
    [
      [
        "quote_not_approved",
        { quote_head: { ...HEAD, status: "draft" } },
        ["commercial.quote_head_not_approved"],
        false,
      ],
      [
        "proposal_terms_mismatch",
        { quote_head: HEAD, quote: QUOTE },
        ["commercial.proposal_terms_mismatch"],
        false,
      ],
      ["quote_ambiguous", {}, ["commercial.quote_head_ambiguous"], true],
      [
        "proposal_ambiguous",
        { quote_head: HEAD, quote: QUOTE },
        ["commercial.proposal_head_ambiguous"],
        true,
      ],
      [
        "publication_ambiguous",
        { quote_head: HEAD, quote: QUOTE, proposal: PROPOSAL },
        ["commercial.publication_head_ambiguous"],
        true,
      ],
      [
        "withdrawn",
        {
          quote_head: HEAD,
          quote: QUOTE,
          proposal: PROPOSAL,
          publication: { ...PUBLISHED, state: "withdrawn" },
        },
        [],
        false,
      ],
      [
        "acceptance_ambiguous",
        {
          quote_head: HEAD,
          quote: QUOTE,
          proposal: PROPOSAL,
          publication: PUBLISHED,
        },
        ["commercial.customer_acceptance_ambiguous"],
        true,
      ],
      [
        "published",
        {
          quote_head: HEAD,
          quote: QUOTE,
          proposal: PROPOSAL,
          publication: PUBLISHED,
        },
        [],
        false,
      ],
      [
        "accepted",
        {
          quote_head: HEAD,
          quote: QUOTE,
          proposal: PROPOSAL,
          publication: PUBLISHED,
          acceptance: ACCEPTANCE,
        },
        [],
        false,
      ],
    ];
  for (const [expected, commercial, stale, blocked] of cases) {
    const model = await build(commercial, stale);
    assert.equal(model.offer.state, expected, expected);
    assert.equal(
      model.follow_up.blockers.includes("commercial_facts_ambiguous"),
      blocked,
      expected,
    );
  }
});

test("an acceptance under a later-withdrawn publication is shown, and blocks", async () => {
  const model = await build(
    {
      quote_head: HEAD,
      quote: QUOTE,
      proposal: PROPOSAL,
      publication: { ...PUBLISHED, publication_version: 2, state: "withdrawn" },
      acceptance_under_withdrawn_publication: ACCEPTANCE,
    },
    [
      "commercial.publication_not_settled",
      "commercial.customer_acceptance_publication_withdrawn",
    ],
  );
  assert.equal(model.offer.state, "withdrawn_after_acceptance");
  assert.equal(model.offer.acceptance, null);
  assert.deepEqual(model.offer.withdrawn_acceptance, {
    acceptance_id: "acc-1",
    accepted_at: AT,
  });
  assert.deepEqual(model.follow_up.blockers, ["commercial_facts_ambiguous"]);
});

test("only the offer chain's own stale reasons are passed on", async () => {
  const model = await build({ quote_head: HEAD, quote: QUOTE }, [
    "commercial.proposal_terms_mismatch",
    "commercial.deposit_derivation_missing",
    "production.gate_deposit_blocked",
    "closeout.completion_packet_missing",
    "accounting.final_invoice_missing",
    "safety.active_stop_scan_overflow",
  ]);
  assert.deepEqual(model.stale_reasons, ["commercial.proposal_terms_mismatch"]);
});

test("a quote is expired only after its last valid day, by the same rule acceptance enforces", async () => {
  const at = async (validUntil: string, now: string) =>
    (
      await build(
        { quote_head: HEAD, quote: { ...QUOTE, valid_until: validUntil } },
        [],
        CONTACT,
        now,
      )
    ).offer;
  // `valid_until` is a date. Parsing it as a timestamp would expire the quote at the start of its
  // last day; customer acceptance compares it to today's UTC date, so this does too.
  assert.equal(
    (await at("2026-09-01", "2026-09-01T23:59:59.000Z")).expired,
    false,
  );
  assert.equal(
    (await at("2026-09-01", "2026-09-02T00:00:00.000Z")).expired,
    true,
  );
  const offer = await at("2026-12-31", AT);
  assert.equal(offer.state, "proposal_missing");
  assert.equal(offer.quote?.currency, "CAD");
  assert.equal(offer.quote?.total_cents, 105_000);
});

test("the binding moves when a quote lapses, though nothing was written", async () => {
  const quote = {
    quote_head: HEAD,
    quote: { ...QUOTE, valid_until: "2026-09-01" },
  };
  const before = await build(quote, [], CONTACT, "2026-09-01T20:00:00.000Z");
  const after = await build(quote, [], CONTACT, "2026-09-02T08:00:00.000Z");
  assert.notEqual(before.source_binding_sha256, after.source_binding_sha256);
  assert.deepEqual(
    sourceBindingChanges(before.source_binding, after.source_binding),
    ["offer"],
  );
});

test("no quote and two quotes are different facts, so they are different bindings", async () => {
  const none = await build({}, ["commercial.quote_head_missing"]);
  const two = await build({}, ["commercial.quote_head_ambiguous"]);
  assert.equal(none.source_binding.quote, null);
  assert.equal(two.source_binding.quote, null);
  assert.notEqual(none.source_binding_sha256, two.source_binding_sha256);
  assert.deepEqual(
    sourceBindingChanges(none.source_binding, two.source_binding),
    ["offer"],
  );
});

test("the recipient is bound case-insensitively, so re-capitalising an address moves nothing", async () => {
  const lower = await build({}, [], CONTACT);
  const upper = await build({}, [], {
    ...CONTACT,
    customer_email: "OWNER@Northside.EXAMPLE",
    lead_email: "OWNER@Northside.EXAMPLE",
  });
  assert.equal(
    upper.source_binding.recipient_sha256,
    lower.source_binding.recipient_sha256,
  );
  assert.deepEqual(
    sourceBindingChanges(lower.source_binding, upper.source_binding),
    [],
  );
});

test("the binding digest ignores key order and changes with every bound fact", async () => {
  const base = (await build({ quote_head: HEAD, quote: QUOTE })).source_binding;
  const reordered = Object.fromEntries(
    Object.entries(base).reverse(),
  ) as typeof base;
  assert.equal(
    await commercialSourceBindingDigest(reordered),
    await commercialSourceBindingDigest(base),
  );

  const cases: Array<[string, typeof base]> = [
    ["job", { ...base, job_version: base.job_version + 1 }],
    ["lead", { ...base, lead_version: base.lead_version + 1 }],
    ["customer", { ...base, customer_archived: true }],
    ["offer", { ...base, offer_state: "not_published" }],
    ["offer", { ...base, quote_expired: true }],
    ["quote", { ...base, quote: { ...HEAD, revision_number: 2 } }],
    [
      "proposal",
      {
        ...base,
        proposal: { proposal_revision_id: "prev-2", revision_number: 2 },
      },
    ],
    [
      "publication",
      {
        ...base,
        publication: {
          publication_event_id: "pub-2",
          publication_version: 2,
          state: "withdrawn",
        },
      },
    ],
    ["acceptance", { ...base, acceptance: { acceptance_id: "acc-1" } }],
    [
      "consent",
      { ...base, consent: { consent_id: "consent:1", status: "revoked" } },
    ],
    ["recipient", { ...base, recipient_sha256: "0".repeat(64) }],
  ];
  for (const [component, changed] of cases) {
    assert.deepEqual(
      sourceBindingChanges(base, changed),
      [component],
      component,
    );
    assert.notEqual(
      await commercialSourceBindingDigest(changed),
      await commercialSourceBindingDigest(base),
      component,
    );
  }
  assert.deepEqual(sourceBindingChanges(base, base), []);
  // Another job's acceptance activates the shared customer; that is not a change to this job's facts.
  const beforeActivation = await build({
    customer_status: "prospect",
    customer_version: 1,
  });
  const afterActivation = await build({
    customer_status: "active",
    customer_version: 2,
  });
  assert.equal(
    beforeActivation.source_binding_sha256,
    afterActivation.source_binding_sha256,
  );
});
