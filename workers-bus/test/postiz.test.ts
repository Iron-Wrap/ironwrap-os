import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  approvePostizIntent,
  createPostizDraft,
  createPostizDraftFromFacetApproval,
  getPostizIntent,
  postizIntentEnvelope,
  recoverPostizControlPlane,
  recoverPostizFacetDrafts,
  reconcilePostizIntent,
  rejectPostizIntent,
  requestPostizConnect,
  stopPostizIntent,
} from "../src/postiz.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const SCHEDULED = "2026-08-20T12:00:00.000Z";
const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_ID = "22222222-2222-4222-8222-222222222222";
const SUBMIT_EFFECT = "33333333-3333-4333-8333-333333333333";
const STOP_EFFECT = "44444444-4444-4444-8444-444444444444";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor(withFacet = false) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(
      readFileSync(
        new URL("../migrations/0011_app_bff_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    if (withFacet) {
      this.raw.exec(
        readFileSync(
          new URL(
            "../migrations/0030_facet_design_ingest.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      this.raw.exec(
        readFileSync(
          new URL(
            "../migrations/0034_facet_customer_approval_ingest.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      this.raw.exec(
        readFileSync(
          new URL(
            "../migrations/0035_facet_design_evidence_associations.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      this.raw.exec(
        readFileSync(
          new URL("../migrations/0038_app_access_roles.sql", import.meta.url),
          "utf8",
        ),
      );
    }
    this.raw.exec(
      readFileSync(
        new URL("../migrations/0040_postiz_control_plane.sql", import.meta.url),
        "utf8",
      ),
    );
    this.raw.exec(
      readFileSync(
        new URL(
          "../migrations/0042_external_effect_runtime.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const insert = this.raw.prepare(
      `INSERT INTO app_users
        (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
         active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    for (const role of ["owner", "ops", "sales", "field"] as const) {
      insert.run(
        `appu_${role}_0001`,
        TENANT,
        `${role}@example.invalid`,
        role,
        role === "field" ? "field" : role === "owner" ? "owner" : "ops",
        `${role}@example.invalid`,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    }
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
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
}

function env(db = new SqliteD1(), overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_TENANT_BRAND: "IronWrap",
    POSTIZ_ENABLED: "true",
    POSTIZ_EXPECTED_VERSION: "v2.23.0",
    POSTIZ_API_BASE_URL: "https://postiz.example.invalid/",
    POSTIZ_API_TIMEOUT_MS: "1000",
    POSTIZ_ALLOWED_PROVIDERS: "facebook,linkedin-page,gmb",
    POSTIZ_API_KEY: "postiz-worker-secret-never-store-or-return",
    POSTIZ_FACET_DRAFT_ENABLED: "false",
    POSTIZ_FACET_DRAFT_PROVIDER: "facebook",
    POSTIZ_FACET_DRAFT_OFFSET_HOURS: "168",
    POSTIZ_FACET_DRAFT_NOT_BEFORE: "2026-08-13T00:00:00.000Z",
    ...overrides,
  } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2026-08-14T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}_0001`,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function integrations(id = "integration-facebook-1"): Response {
  return Response.json([{ id, identifier: "facebook", disabled: false }]);
}

const OAUTH_SCOPES = {
  facebook:
    "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
  "linkedin-page":
    "openid profile w_member_social r_basicprofile rw_organization_admin w_organization_social r_organization_social",
  gmb: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage",
} as const;

function oauthUrl(
  provider: "facebook" | "linkedin-page" | "gmb",
  callbackOrigin = "https://postiz.example.invalid",
): string {
  const contract =
    provider === "facebook"
      ? { base: "https://www.facebook.com/v20.0/dialog/oauth", state: "Ab12Cd" }
      : provider === "linkedin-page"
        ? {
            base: "https://www.linkedin.com/oauth/v2/authorization",
            state: "Ef34Gh",
          }
        : {
            base: "https://accounts.google.com/o/oauth2/v2/auth",
            state: "Ij56Klm",
          };
  const query = new URLSearchParams();
  if (provider === "linkedin-page") {
    query.set("response_type", "code");
    query.set("prompt", "none");
  }
  if (provider === "gmb") {
    query.set("access_type", "offline");
    query.set("prompt", "consent");
  }
  query.set(
    "client_id",
    provider === "gmb" ? "123.apps.googleusercontent.com" : "client_123",
  );
  query.set(
    "redirect_uri",
    `${callbackOrigin}/integrations/social/${provider}`,
  );
  query.set("state", contract.state);
  query.set("scope", OAUTH_SCOPES[provider]);
  if (provider === "gmb") query.set("response_type", "code");
  return `${contract.base}?${query.toString()}`;
}

async function draft(
  testEnv: AppEnv,
  fetcher: typeof fetch = async () => integrations(),
  overrides: Partial<Parameters<typeof createPostizDraft>[1]> = {},
) {
  return await createPostizDraft(testEnv, {
    tenantId: TENANT,
    agentRole: "specialized_marketing_agent",
    triggerRef: "business-event:synthetic-001",
    title: "Approved exterior design",
    content:
      "A customer-approved exterior design is ready for its next verified step.",
    provider: "facebook",
    scheduledAt: SCHEDULED,
    evidenceRefs: ["evidence:synthetic-001"],
    citations: [
      {
        id: "citation:synthetic-001",
        label: "Synthetic event",
        source_ref: "event:synthetic-001",
      },
    ],
    permissionScope: "brand:ironwrap:marketing.social.review",
    idempotencyKey: "postiz-draft-synthetic-0001",
    now: NOW,
    intentId: INTENT_ID,
    remotePostId: REMOTE_ID,
    submissionEffectId: SUBMIT_EFFECT,
    stopEffectId: STOP_EFFECT,
    fetcher,
    ...overrides,
  });
}

test("draft creation is exact-idempotent, bounded, and PII/HTML fail closed", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  assert.equal((await draft(testEnv)).kind, "created");
  assert.equal((await draft(testEnv)).kind, "replayed");
  assert.equal(
    (
      await draft(testEnv, async () => integrations(), {
        content: "Changed safe content",
      })
    ).kind,
    "rejected",
  );
  assert.deepEqual(
    await draft(testEnv, async () => integrations(), {
      idempotencyKey: "postiz-draft-synthetic-pii-0002",
      intentId: crypto.randomUUID(),
      remotePostId: crypto.randomUUID(),
      submissionEffectId: crypto.randomUUID(),
      stopEffectId: crypto.randomUUID(),
      content: "Call 403-555-0101 <strong>today</strong>",
    }),
    { kind: "rejected", code: "postiz_draft_invalid", status: 400 },
  );
  assert.equal(count(db, "postiz_intents"), 1);
  assert.equal(count(db, "postiz_intent_events"), 1);
});

test("marketing references cannot claim an upload receipt", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  const ref = `evidence-upload://evu_${"a".repeat(64)}`;
  assert.deepEqual(
    await draft(testEnv, async () => integrations(), { evidenceRefs: [ref] }),
    { kind: "rejected", code: "postiz_evidence_refs_invalid", status: 400 },
  );
  assert.equal(count(db, "postiz_intents"), 0);
});

test("approval is human-gated and an unknown create response is never retried", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  assert.equal((await draft(testEnv)).kind, "created");
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE postiz_intents SET state = 'submission_pending', version = version + 1 WHERE intent_id = ?",
        )
        .run(INTENT_ID),
    /postiz_submission_approval_required/,
  );

  let creates = 0;
  const unknownCreate: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      creates += 1;
      throw new Error("response lost");
    }
    return integrations();
  };
  const approved = await approvePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-approve-synthetic-0001",
    fetcher: unknownCreate,
    now: NOW,
  });
  assert.equal(approved.kind, "updated");
  if (approved.kind === "rejected") return;
  assert.equal(approved.intent.state, "reconciliation_required");
  assert.equal(creates, 1);
  assert.deepEqual(
    await recoverPostizControlPlane(testEnv, unknownCreate, NOW),
    {
      effects_processed: 0,
      intents_reconciled: 1,
    },
  );
  assert.equal(creates, 1, "attempted create must never be auto-retried");
  assert.deepEqual(
    {
      ...db.raw
        .prepare(
          "SELECT state, attempt_count, detail_code FROM postiz_effect_outbox WHERE effect_id = ?",
        )
        .get(SUBMIT_EFFECT)!,
    },
    {
      state: "unknown",
      attempt_count: 1,
      detail_code: "postiz_readback_response_unverified",
    },
  );
});

test("approved Postiz submission uses the universal effect ledger and provider readback", async () => {
  const db = new SqliteD1();
  const testEnv = env(db, { EFFECT_RUNTIME_ENABLED: "true" });
  await draft(testEnv);
  const approved = await approvePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-runtime-approve-0001",
    now: NOW,
    fetcher: async (_input, init) => {
      if (init?.method === "POST") {
        return Response.json(
          [{ postId: REMOTE_ID, integration: "integration-facebook-1" }],
          { status: 201 },
        );
      }
      if (init?.method === undefined || init.method === "GET") {
        return Response.json({ posts: [{ id: REMOTE_ID, state: "QUEUE" }] });
      }
      return integrations();
    },
  });
  assert.equal(approved.kind, "updated");
  if (approved.kind === "rejected") return;
  assert.equal(approved.intent.state, "submitted");
  const effect = db.raw
    .prepare(
      "SELECT state, provider, provider_external_id FROM external_effects WHERE provider = 'postiz'",
    )
    .get() as { state: string; provider: string; provider_external_id: string };
  assert.equal(effect.state, "succeeded");
  assert.equal(effect.provider, "postiz");
  assert.equal(effect.provider_external_id, REMOTE_ID);
});

test("readback alone proves publication and failed reconciliation remains explicit", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  await draft(testEnv);
  await approvePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-approve-synthetic-0002",
    now: NOW,
    fetcher: async (_input, init) =>
      init?.method === "POST"
        ? Response.json(
            [{ postId: REMOTE_ID, integration: "integration-facebook-1" }],
            { status: 201 },
          )
        : Response.json({ posts: [{ id: REMOTE_ID, state: "QUEUE" }] }),
  });
  let row = await getPostizIntent(testEnv, TENANT, INTENT_ID);
  assert.equal(row?.state, "submitted", "create 2xx is submission only");

  const failed = await reconcilePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    expectedVersion: row!.version,
    idempotencyKey: "postiz-reconcile-synthetic-failed-0001",
    now: NOW,
    fetcher: async () => new Response("unavailable", { status: 503 }),
  });
  assert.equal(failed.kind, "updated");
  if (failed.kind === "rejected") return;
  assert.equal(failed.intent.state, "reconciliation_required");
  assert.equal(failed.intent.error_code, "postiz_reconciliation_read_failed");

  const published = await reconcilePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    expectedVersion: failed.intent.version,
    idempotencyKey: "postiz-reconcile-synthetic-published-0001",
    now: NOW,
    fetcher: async () =>
      Response.json({
        posts: [
          {
            id: REMOTE_ID,
            state: "PUBLISHED",
            releaseURL: "https://social.example.invalid/posts/1",
          },
        ],
      }),
  });
  assert.equal(published.kind, "updated");
  if (published.kind === "rejected") return;
  assert.equal(published.intent.state, "published");
  assert.equal(
    postizIntentEnvelope(testEnv, published.intent).reconciliation.release_url,
    null,
  );
  assert.deepEqual(
    {
      ...db.raw
        .prepare(
          "SELECT release_url, published_observed_at FROM postiz_intents WHERE intent_id = ?",
        )
        .get(INTENT_ID)!,
    },
    { release_url: null, published_observed_at: NOW.toISOString() },
  );

  const later = new Date(NOW.getTime() + 31 * 60 * 1000);
  assert.deepEqual(
    await recoverPostizControlPlane(
      testEnv,
      async () => Response.json({ posts: [{ id: REMOTE_ID, state: "ERROR" }] }),
      later,
    ),
    { effects_processed: 0, intents_reconciled: 1 },
  );
  const drifted = (await getPostizIntent(testEnv, TENANT, INTENT_ID))!;
  assert.equal(drifted.state, "reconciliation_required");
  assert.equal(drifted.error_code, "postiz_publication_drift_error");
  assert.equal(drifted.published_observed_at, NOW.toISOString());
  assert.deepEqual(postizIntentEnvelope(testEnv, drifted).allowed_actions, [
    "postiz.intent.review",
    "postiz.intent.reconcile",
  ]);
  assert.deepEqual(
    await stopPostizIntent(testEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      actorUserId: "appu_owner_0001",
      expectedVersion: drifted.version,
      idempotencyKey: "postiz-stop-after-publication-drift-0001",
      now: later,
    }),
    {
      kind: "rejected",
      code: "postiz_published_retraction_manual",
      status: 409,
    },
  );
  assert.deepEqual(
    db.raw
      .prepare(
        "SELECT event_type FROM postiz_intent_events WHERE intent_id = ? AND event_type IN ('published', 'reconciliation_required') ORDER BY event_seq",
      )
      .all(INTENT_ID)
      .map((event) => event.event_type),
    ["reconciliation_required", "published", "reconciliation_required"],
  );
  assert.deepEqual(
    db.raw
      .prepare(
        "SELECT remote_state, outcome_code FROM postiz_reconciliation_observations WHERE intent_id = ? ORDER BY checked_at, rowid",
      )
      .all(INTENT_ID)
      .map((observation) => ({ ...observation })),
    [
      { remote_state: null, outcome_code: "postiz_reconciliation_read_failed" },
      {
        remote_state: "PUBLISHED",
        outcome_code: "postiz_publication_confirmed",
      },
      { remote_state: "ERROR", outcome_code: "postiz_publication_drift_error" },
    ],
  );
});

test("published exact-id absence and ambiguity become explicit drift without erasing publication evidence", async () => {
  for (const [label, posts, expectedCode] of [
    ["absent", [], "postiz_publication_drift_absent"],
    [
      "ambiguous",
      [
        { id: REMOTE_ID, state: "PUBLISHED" },
        { id: REMOTE_ID, state: "ERROR" },
      ],
      "postiz_publication_drift_ambiguous",
    ],
  ] as const) {
    const db = new SqliteD1();
    const testEnv = env(db);
    await draft(testEnv);
    await approvePostizIntent(testEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      actorUserId: "appu_owner_0001",
      expectedVersion: 1,
      idempotencyKey: `postiz-approve-drift-${label}-0001`,
      now: NOW,
      fetcher: async (_input, init) =>
        init?.method === "POST"
          ? Response.json([
              { postId: REMOTE_ID, integration: "integration-facebook-1" },
            ])
          : integrations(),
    });
    const submitted = (await getPostizIntent(testEnv, TENANT, INTENT_ID))!;
    const published = await reconcilePostizIntent(testEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      expectedVersion: submitted.version,
      idempotencyKey: `postiz-published-drift-${label}-0001`,
      now: NOW,
      fetcher: async () =>
        Response.json({ posts: [{ id: REMOTE_ID, state: "PUBLISHED" }] }),
    });
    assert.equal(published.kind, "updated");
    if (published.kind === "rejected") continue;
    const drifted = await reconcilePostizIntent(testEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      expectedVersion: published.intent.version,
      idempotencyKey: `postiz-reconcile-drift-${label}-0001`,
      now: new Date(NOW.getTime() + 60_000),
      fetcher: async () => Response.json({ posts }),
    });
    assert.equal(drifted.kind, "updated");
    if (drifted.kind === "rejected") continue;
    assert.equal(drifted.intent.state, "reconciliation_required");
    assert.equal(drifted.intent.error_code, expectedCode);
    assert.equal(drifted.intent.published_observed_at, NOW.toISOString());
    assert.equal(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM postiz_intent_events WHERE intent_id = ? AND event_type = 'published'",
        )
        .get(INTENT_ID)!.count,
      1,
    );
  }
});

test("scheduled publication rechecks use evidence recency, not the original post schedule", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  await draft(testEnv);
  await approvePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-approve-old-schedule-0001",
    now: NOW,
    fetcher: async (_input, init) =>
      init?.method === "POST"
        ? Response.json([
            { postId: REMOTE_ID, integration: "integration-facebook-1" },
          ])
        : integrations(),
  });
  const submitted = (await getPostizIntent(testEnv, TENANT, INTENT_ID))!;
  const publicationObservedAt = new Date("2026-08-30T12:00:00.000Z");
  const published = await reconcilePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    expectedVersion: submitted.version,
    idempotencyKey: "postiz-discover-old-schedule-publication-0001",
    now: publicationObservedAt,
    fetcher: async () =>
      Response.json({ posts: [{ id: REMOTE_ID, state: "PUBLISHED" }] }),
  });
  assert.equal(published.kind, "updated");
  if (published.kind === "rejected") return;
  assert.equal(
    published.intent.published_observed_at,
    publicationObservedAt.toISOString(),
  );

  let calls = 0;
  const recentEvidenceNow = new Date("2026-08-30T12:31:00.000Z");
  assert.deepEqual(
    await recoverPostizControlPlane(
      testEnv,
      async () => {
        calls += 1;
        return Response.json({ posts: [{ id: REMOTE_ID, state: "ERROR" }] });
      },
      recentEvidenceNow,
    ),
    { effects_processed: 0, intents_reconciled: 1 },
  );
  assert.equal(
    calls,
    1,
    "recent publication evidence must be rechecked even for an old schedule",
  );

  calls = 0;
  assert.deepEqual(
    await recoverPostizControlPlane(
      testEnv,
      async () => {
        calls += 1;
        return Response.json({ posts: [] });
      },
      new Date("2026-09-07T12:32:00.000Z"),
    ),
    {
      effects_processed: 0,
      intents_reconciled: 0,
    },
  );
  assert.equal(
    calls,
    0,
    "publication evidence older than seven days is outside scheduled polling",
  );
});

test("stop remains reconciliation-required after DRAFT readback and published retraction is manual", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  await draft(testEnv);
  await approvePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-approve-stop-0001",
    now: NOW,
    fetcher: async (_input, init) =>
      init?.method === "POST"
        ? Response.json([
            { postId: REMOTE_ID, integration: "integration-facebook-1" },
          ])
        : integrations(),
  });
  const submitted = (await getPostizIntent(testEnv, TENANT, INTENT_ID))!;
  const stopped = await stopPostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: submitted.version,
    idempotencyKey: "postiz-stop-synthetic-0001",
    now: NOW,
    fetcher: async () => Response.json({ id: REMOTE_ID, state: "DRAFT" }),
  });
  assert.equal(stopped.kind, "updated");
  if (stopped.kind === "rejected") return;
  assert.equal(stopped.intent.state, "stop_reconciliation_required");
  const reconciled = await reconcilePostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    expectedVersion: stopped.intent.version,
    idempotencyKey: "postiz-stop-reconcile-synthetic-0001",
    now: NOW,
    fetcher: async () =>
      Response.json({ posts: [{ id: REMOTE_ID, state: "DRAFT" }] }),
  });
  assert.equal(reconciled.kind, "updated");
  if (reconciled.kind !== "rejected") {
    assert.equal(reconciled.intent.state, "stop_reconciliation_required");
    assert.equal(
      reconciled.intent.error_code,
      "postiz_stop_workflow_unverified",
    );
    const publishedAfterStop = await reconcilePostizIntent(testEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      expectedVersion: reconciled.intent.version,
      idempotencyKey: "postiz-stop-reconcile-published-0002",
      now: new Date(NOW.getTime() + 60_000),
      fetcher: async () =>
        Response.json({ posts: [{ id: REMOTE_ID, state: "PUBLISHED" }] }),
    });
    assert.equal(publishedAfterStop.kind, "updated");
    if (publishedAfterStop.kind !== "rejected") {
      assert.equal(
        publishedAfterStop.intent.state,
        "stop_reconciliation_required",
      );
      assert.equal(
        publishedAfterStop.intent.error_code,
        "postiz_stop_failed_published",
      );
      assert.equal(
        publishedAfterStop.intent.published_observed_at,
        new Date(NOW.getTime() + 60_000).toISOString(),
      );
    }
  }
  const publishedDb = new SqliteD1();
  const publishedEnv = env(publishedDb);
  await draft(publishedEnv);
  await approvePostizIntent(publishedEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-approve-published-0001",
    now: NOW,
    fetcher: async (_input, init) =>
      init?.method === "POST"
        ? Response.json([
            { postId: REMOTE_ID, integration: "integration-facebook-1" },
          ])
        : integrations(),
  });
  const beforePublication = (await getPostizIntent(
    publishedEnv,
    TENANT,
    INTENT_ID,
  ))!;
  await reconcilePostizIntent(publishedEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    expectedVersion: beforePublication.version,
    idempotencyKey: "postiz-published-readback-0001",
    now: NOW,
    fetcher: async () =>
      Response.json({ posts: [{ id: REMOTE_ID, state: "PUBLISHED" }] }),
  });
  const published = (await getPostizIntent(publishedEnv, TENANT, INTENT_ID))!;
  assert.deepEqual(
    await stopPostizIntent(publishedEnv, {
      tenantId: TENANT,
      intentId: INTENT_ID,
      actorUserId: "appu_owner_0001",
      expectedVersion: published.version,
      idempotencyKey: "postiz-stop-published-0001",
      now: NOW,
    }),
    {
      kind: "rejected",
      code: "postiz_published_retraction_manual",
      status: 409,
    },
  );
});

test("owner can reject while every Postiz API route denies ops, sales, and field", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  await draft(testEnv);
  const rejected = await rejectPostizIntent(testEnv, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    actorUserId: "appu_owner_0001",
    expectedVersion: 1,
    idempotencyKey: "postiz-reject-synthetic-0001",
    now: NOW,
  });
  assert.equal(rejected.kind, "updated");
  assert.deepEqual(
    db.raw
      .prepare(
        "SELECT event_type, actor_kind FROM postiz_intent_events ORDER BY event_seq",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { event_type: "proposed", actor_kind: "specialized_marketing_agent" },
      { event_type: "rejected", actor_kind: "owner" },
    ],
  );
  for (const role of ["ops", "sales", "field"] as const) {
    const response = await handleAuthenticatedRoute(
      new Request(
        `https://app.example.invalid/api/v1/postiz/intents/${INTENT_ID}`,
      ),
      testEnv,
      auth(role),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "owner_role_required" });
  }
});

test("owner API exposes only the sanitized envelope and validated OAuth handoff", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  await draft(testEnv);
  const detail = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/postiz/intents/${INTENT_ID}`,
    ),
    testEnv,
    auth("owner"),
  );
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  assert.equal(detailText.includes(String(testEnv.POSTIZ_API_KEY)), false);
  assert.equal(detailText.includes("draft_idempotency_sha256"), false);
  assert.equal(detailText.includes("remote_post_id"), false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      url: oauthUrl("facebook"),
      callback_origin: "https://evil.example",
    });
  try {
    const connect = await handleAuthenticatedRoute(
      postRequest(
        "/api/v1/postiz/connect",
        { provider: "facebook" },
        "postiz-connect-api-0001",
      ),
      testEnv,
      auth("owner"),
    );
    assert.equal(connect.status, 201);
    assert.deepEqual(await connect.json(), {
      version: 1,
      connect_url: oauthUrl("facebook"),
      callback_origin: "https://postiz.example.invalid",
      provider: "facebook",
    });
    const stored = JSON.stringify(
      db.raw.prepare("SELECT * FROM postiz_effect_outbox").all(),
    );
    assert.equal(stored.includes("Ab12Cd"), false);
    assert.equal(stored.includes(String(testEnv.POSTIZ_API_KEY)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth handoff accepts only the pinned v2.23.0 provider paths and exact query contracts", async () => {
  for (const provider of ["facebook", "linkedin-page", "gmb"] as const) {
    const testEnv = env(new SqliteD1());
    const result = await requestPostizConnect(testEnv, {
      tenantId: TENANT,
      actorUserId: "appu_owner_0001",
      provider,
      idempotencyKey: `postiz-connect-valid-${provider}-0001`,
      now: NOW,
      fetcher: async () => Response.json({ url: oauthUrl(provider) }),
    });
    assert.deepEqual(result, {
      kind: "created",
      connectUrl: oauthUrl(provider),
      callbackOrigin: "https://postiz.example.invalid",
      provider,
    });
  }
  const portOrigin = "https://postiz.example.invalid:8443";
  assert.deepEqual(
    await requestPostizConnect(
      env(new SqliteD1(), { POSTIZ_API_BASE_URL: `${portOrigin}/` }),
      {
        tenantId: TENANT,
        actorUserId: "appu_owner_0001",
        provider: "facebook",
        idempotencyKey: "postiz-connect-valid-matching-port-0001",
        now: NOW,
        fetcher: async () =>
          Response.json({ url: oauthUrl("facebook", portOrigin) }),
      },
    ),
    {
      kind: "created",
      connectUrl: oauthUrl("facebook", portOrigin),
      callbackOrigin: portOrigin,
      provider: "facebook",
    },
  );
});

test("OAuth handoff rejects provider-host redirectors and any path or query drift", async () => {
  const valid = oauthUrl("facebook");
  const invalidUrls = [
    "https://www.facebook.com/l.php?u=https%3A%2F%2Fattacker.example.invalid",
    valid.replace("/v20.0/dialog/oauth", "/dialog/oauth"),
    `${valid}&next=https%3A%2F%2Fattacker.example.invalid`,
    valid.replace("www.facebook.com", "www.linkedin.com"),
    valid.replace("https://", "https://user:pass@"),
    `${valid}#continue`,
    `${valid}&state=Ef34Gh`,
    oauthUrl("facebook", "https://evil.example"),
    oauthUrl("facebook", "https://auth.postiz.example.invalid"),
    oauthUrl("facebook", "https://postiz.example.invalid.evil.example"),
    oauthUrl("facebook", "https://postiz.example.invalid:8443"),
    valid.replace(
      encodeURIComponent(
        "https://postiz.example.invalid/integrations/social/facebook",
      ),
      encodeURIComponent(
        "https://postiz.example.invalid/integrations/social/facebook?next=/admin",
      ),
    ),
  ];
  for (const [index, url] of invalidUrls.entries()) {
    const testEnv = env(new SqliteD1());
    assert.deepEqual(
      await requestPostizConnect(testEnv, {
        tenantId: TENANT,
        actorUserId: "appu_owner_0001",
        provider: "facebook",
        idempotencyKey: `postiz-connect-path-policy-${String(index).padStart(2, "0")}-0001`,
        now: NOW,
        fetcher: async () => Response.json({ url }),
      }),
      {
        kind: "rejected",
        code: "postiz_connect_response_unverified",
        status: 502,
      },
    );
  }
});

test("OAuth handoff rejects untrusted hosts and an unknown request cannot be replayed", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  let calls = 0;
  const input = {
    tenantId: TENANT,
    actorUserId: "appu_owner_0001",
    provider: "facebook" as const,
    idempotencyKey: "postiz-connect-host-policy-0001",
    now: NOW,
    fetcher: async () => {
      calls += 1;
      return Response.json({ url: "https://attacker.example.invalid/oauth" });
    },
  };
  assert.deepEqual(await requestPostizConnect(testEnv, input), {
    kind: "rejected",
    code: "postiz_connect_response_unverified",
    status: 502,
  });
  assert.deepEqual(await requestPostizConnect(testEnv, input), {
    kind: "rejected",
    code: "postiz_connect_handoff_already_requested",
    status: 409,
  });
  assert.equal(calls, 1);
});

test("disabled and unsafe/mismatched Postiz config fail closed without exposing secrets", async () => {
  for (const overrides of [
    { POSTIZ_ENABLED: "false" },
    { POSTIZ_EXPECTED_VERSION: "latest" },
    { POSTIZ_API_BASE_URL: "https://127.0.0.1/" },
    { POSTIZ_API_BASE_URL: "https://user:pass@postiz.example.invalid/" },
  ]) {
    const db = new SqliteD1();
    const testEnv = env(db, overrides);
    const created = await draft(testEnv);
    assert.equal(created.kind, "created");
    if (created.kind === "rejected") continue;
    const envelope = JSON.stringify(
      postizIntentEnvelope(testEnv, created.intent),
    );
    assert.equal(postizIntentEnvelope(testEnv, created.intent).enabled, false);
    assert.equal(envelope.includes(String(testEnv.POSTIZ_API_KEY)), false);
    assert.equal(envelope.includes("api_key"), false);
  }
});

test("durable Facet approvals recover missing immediate work and never create duplicate intents", async () => {
  const db = new SqliteD1(true);
  insertFacetApproval(db, "facet-event-v2-recovery-0001");
  const testEnv = env(db, { POSTIZ_FACET_DRAFT_ENABLED: "true" });
  const failingDb = {
    prepare(sql: string) {
      const prepared = db.prepare(sql);
      if (!sql.includes("INSERT INTO postiz_intents")) return prepared;
      return {
        bind(...args: unknown[]) {
          const bound = prepared.bind(...args);
          return {
            ...bound,
            run: async () => {
              throw new Error("transient D1 failure");
            },
          };
        },
      };
    },
  };
  await assert.rejects(
    createPostizDraftFromFacetApproval(
      { ...testEnv, DB: failingDb as never },
      "facet-event-v2-recovery-0001",
      async () => integrations(),
      NOW,
    ),
    /transient D1 failure/,
  );
  assert.equal(count(db, "postiz_intents"), 0);
  assert.deepEqual(
    await recoverPostizFacetDrafts(testEnv, async () => integrations(), NOW),
    {
      eligible: 1,
      created: 1,
    },
  );
  assert.deepEqual(
    await recoverPostizFacetDrafts(testEnv, async () => integrations(), NOW),
    {
      eligible: 0,
      created: 0,
    },
  );
  assert.equal(count(db, "postiz_intents"), 1);

  insertFacetApproval(db, "facet-event-v2-immediate-0002");
  const [immediate, scheduled] = await Promise.all([
    createPostizDraftFromFacetApproval(
      testEnv,
      "facet-event-v2-immediate-0002",
      async () => integrations(),
      NOW,
    ),
    recoverPostizFacetDrafts(testEnv, async () => integrations(), NOW),
  ]);
  assert.ok(
    typeof immediate !== "string" &&
      ["created", "replayed"].includes(immediate.kind),
  );
  assert.ok(scheduled.eligible === 0 || scheduled.eligible === 1);
  assert.equal(count(db, "postiz_intents"), 2);
  const stored = JSON.stringify(
    db.raw.prepare("SELECT * FROM postiz_intents ORDER BY trigger_ref").all(),
  );
  assert.equal(stored.includes("frozen_evidence"), false);
  assert.equal(stored.includes("capability_fingerprint"), false);
  assert.equal(stored.includes("c".repeat(64)), false);
});

test("Facet activation watermark ignores history and recovery never creates a past schedule", async () => {
  const db = new SqliteD1(true);
  insertFacetApproval(
    db,
    "facet-event-before-watermark-0001",
    "2026-08-12T10:00:00.000Z",
    "2026-08-12T10:01:00.000Z",
  );
  insertFacetApproval(
    db,
    "facet-event-after-watermark-0002",
    "2026-08-13T10:00:00.000Z",
    "2026-08-13T10:01:00.000Z",
  );
  const recoveryNow = new Date("2026-08-20T12:00:00.000Z");
  const testEnv = env(db, {
    POSTIZ_FACET_DRAFT_ENABLED: "true",
    POSTIZ_FACET_DRAFT_OFFSET_HOURS: "1",
  });

  assert.equal(
    await createPostizDraftFromFacetApproval(
      testEnv,
      "facet-event-before-watermark-0001",
      async () => integrations(),
      recoveryNow,
    ),
    "not_eligible",
  );
  assert.deepEqual(
    await recoverPostizFacetDrafts(
      testEnv,
      async () => integrations(),
      recoveryNow,
    ),
    { eligible: 1, created: 1 },
  );
  const stored = db.raw
    .prepare("SELECT trigger_ref, scheduled_at FROM postiz_intents LIMIT 1")
    .get() as { trigger_ref: string; scheduled_at: string };
  assert.equal(
    stored.trigger_ref,
    "facet-approval:facet-event-after-watermark-0002",
  );
  assert.equal(stored.scheduled_at, "2026-08-21T12:00:00.000Z");
  assert.ok(Date.parse(stored.scheduled_at) > recoveryNow.getTime());
  const replay = await createPostizDraftFromFacetApproval(
    testEnv,
    "facet-event-after-watermark-0002",
    async () => integrations(),
    new Date("2026-08-22T12:00:00.000Z"),
  );
  assert.ok(typeof replay !== "string" && replay.kind === "replayed");
  assert.equal(replay.intent.scheduled_at, stored.scheduled_at);
  assert.deepEqual(
    await recoverPostizFacetDrafts(
      testEnv,
      async () => integrations(),
      recoveryNow,
    ),
    { eligible: 0, created: 0 },
  );

  const unconfigured = await createPostizDraftFromFacetApproval(
    { ...testEnv, POSTIZ_FACET_DRAFT_NOT_BEFORE: "" },
    "facet-event-after-watermark-0002",
    async () => integrations(),
    recoveryNow,
  );
  assert.ok(
    typeof unconfigured !== "string" && unconfigured.kind === "rejected",
  );
  assert.equal(unconfigured.code, "postiz_facet_draft_not_configured");
});

function insertFacetApproval(
  db: SqliteD1,
  eventId: string,
  occurredAt = NOW.toISOString(),
  receivedAt = occurredAt,
): void {
  db.raw
    .prepare(
      `INSERT INTO facet_customer_approval_events
      (event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
       facet_project_id, design_revision_id, design_revision_sha256,
       frozen_evidence_sha256, approval_actor_type, capability_fingerprint,
       identity_assurance, raw_key, raw_sha256, raw_content_length, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, ?, 'ironwrap', ?, ?, ?, ?,
             'customer_capability', ?, 'bearer_capability_only', ?, ?, 256, ?)`,
    )
    .run(
      eventId,
      occurredAt,
      TENANT,
      `facet-project-${eventId}`,
      `facet-json-v1:${"a".repeat(64)}`,
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      `facet-design/v2/${eventId}.json`,
      "d".repeat(64),
      receivedAt,
    );
}

function count(db: SqliteD1, table: string): number {
  return Number(
    (
      db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function postRequest(
  path: string,
  body: Record<string, unknown>,
  key: string,
): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}
