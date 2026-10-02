import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
} from "../src/app-types.ts";
import {
  buildDecisionsReadModel,
  parseDecisionPageRequest,
} from "../src/decision-read-model.ts";
import { auth, setup } from "./pipeline-board-fixture.ts";

// The app uses bundler resolution. Keep this exact, temporary resolver in the test
// so a real handler response is validated by the shipped app schema under Node.
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === "../accounting/quickbooks-contracts" &&
        context.parentURL?.endsWith("/app/src/now/now-contracts.ts")
        ? `${specifier}.ts`
        : specifier,
      context,
    );
  },
});
const { decisionsReadModelSchema, nowResponseSchema } =
  await import("../../app/src/now/now-contracts.ts");
resolver.deregister();

const NOW = new Date("2026-09-29T12:00:00.000Z");
const tables = [
  ["lead_triage", "approval_requests", "approval_request_id"],
  [
    "quote_revision",
    "quote_revision_approval_requests",
    "quote_revision_approval_id",
  ],
  [
    "proposal_publication",
    "proposal_publication_approval_requests",
    "proposal_publication_approval_id",
  ],
  ["postiz", "postiz_intents", "intent_id"],
  ["quickbooks_final_invoice", "quickbooks_final_invoice_intents", "intent_id"],
] as const;

function actor(role: AppRole, tenant = "ironwrap") {
  const result = auth("owner", tenant);
  result.session.role = role;
  result.permissions = permissionsForRole(role);
  return result;
}

// Minimal tables exercise the real projection SQL with controllable source failures.
// A separate all-migrations handler test below verifies the actual deployed columns.
function fixture() {
  const db = new DatabaseSync(":memory:");
  const reads: string[] = [];
  const unavailable = new Set<string>();
  for (const [, table, id] of tables)
    db.exec(`CREATE TABLE ${table} (
    ${id} TEXT, tenant_id TEXT, state TEXT, version INTEGER,
    request_text TEXT, correction_reason TEXT, roof_job_id TEXT, target_quote_version INTEGER,
    updated_at TEXT, expires_at TEXT, title TEXT, currency TEXT, final_balance TEXT,
    dry_run_receipt TEXT, write_args_json TEXT)`);
  const env = {
    DB: {
      prepare(sql: string) {
        assert.match(sql.trim(), /^SELECT /);
        assert.doesNotMatch(sql, /production_schedule_approval_requests/);
        reads.push(sql);
        if ([...unavailable].some((table) => sql.includes(`FROM ${table}`)))
          throw new Error("fixture source unavailable");
        return {
          bind: (...args: unknown[]) => ({
            all: async () => ({
              success: true,
              results: db.prepare(sql).all(...(args as never[])),
            }),
          }),
        };
      },
    },
  } as unknown as AppEnv;
  function seed(
    index: number,
    suffix = "1",
    state = index < 3 ? "pending" : "pending_review",
    tenant = "ironwrap",
  ) {
    const [, table, id] = tables[index]!;
    const value =
      index === 3
        ? `11111111-1111-4111-8111-${suffix.padStart(12, "0")}`
        : index === 4
          ? `request:fixture:${index}:${suffix}`
          : `${["approval", "quote-revision-approval", "proposal-publication-approval"][index]}:${suffix.padStart(16, "0")}`;
    db.prepare(
      `INSERT INTO ${table} (${id}, tenant_id, state, version, request_text,
      correction_reason, roof_job_id, target_quote_version, updated_at, expires_at,
      title, currency, final_balance, dry_run_receipt, write_args_json)
      VALUES (?, ?, ?, 2, 'Review captured note', 'Correct measurement', 'job:fixture:1', 3,
        ?, '2026-09-28T12:00:00.000Z', 'Roof update', 'CAD', '1200.00',
        'withheld fixture receipt', '{"fixture":"withheld arguments"}')`,
    ).run(value, tenant, state, NOW.toISOString());
    return value;
  }
  return { db, env, reads, unavailable, seed };
}

test("all five live sources are tenant-bound read-only projections with native destinations", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < tables.length; index++) {
      f.seed(index);
      f.seed(index, "2", undefined, "another-tenant");
    }
    const before = f.db.prepare("SELECT total_changes() AS count").get()!.count;
    const model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "ready");
    assert.equal(model.items.length, 5);
    assert.equal(model.sources.length, 6);
    assert.deepEqual(
      model.sources.find((source) => source.kind === "production_schedule"),
      {
        kind: "production_schedule",
        state: "retired",
        loaded_count: 0,
        has_more: null,
        next_cursor: null,
        read_model_generated_at: null,
      },
    );
    assert.deepEqual(
      model.items.map((item) => item.review_href),
      [
        "/approvals?review=approval%3A0000000000000001",
        "/quote-revision-approvals/quote-revision-approval%3A0000000000000001",
        "/estimator/jobs/job%3Afixture%3A1",
        "/marketing/postiz/11111111-1111-4111-8111-000000000001",
        "/accounting/quickbooks/final-invoices/request%3Afixture%3A4%3A1",
      ],
    );
    assert.equal(
      model.items[0]!.native_state,
      "pending",
      "browsing must not run expiry maintenance",
    );
    assert.equal(model.items[0]!.expires_at, "2026-09-28T12:00:00.000Z");
    assert.doesNotMatch(
      JSON.stringify(model),
      /withheld|dry_run_receipt|write_args_json|allowed_actions/,
    );
    assert.equal(
      f.db.prepare("SELECT total_changes() AS count").get()!.count,
      before,
    );
  } finally {
    f.db.close();
  }
});

test("visible sources follow both native API permissions and detail screen roles", async () => {
  const f = fixture();
  try {
    const expected = {
      owner: [
        "lead_triage",
        "quote_revision",
        "proposal_publication",
        "production_schedule",
        "postiz",
        "quickbooks_final_invoice",
      ],
      ops: [
        "lead_triage",
        "quote_revision",
        "proposal_publication",
        "production_schedule",
      ],
      sales: ["quote_revision", "production_schedule"],
      accounting: ["quickbooks_final_invoice"],
      production: [],
      field: [],
    };
    for (const role of Object.keys(expected) as AppRole[]) {
      f.reads.length = 0;
      const model = decisionsReadModelSchema.parse(
        await buildDecisionsReadModel(f.env, actor(role), NOW),
      );
      assert.deepEqual(
        model.sources.map((source) => source.kind),
        expected[role],
        role,
      );
      assert.equal(
        f.reads.length,
        expected[role].filter((kind) => kind !== "production_schedule").length,
      );
    }
    const widenedGrant = actor("production");
    widenedGrant.permissions = permissionsForRole("owner");
    assert.deepEqual(
      (await buildDecisionsReadModel(f.env, widenedGrant, NOW)).sources,
      [],
    );
  } finally {
    f.db.close();
  }
});

test("a malformed native identity fails its whole source instead of advertising a dead link", async () => {
  const f = fixture();
  try {
    f.seed(0);
    f.seed(1);
    f.db
      .prepare(
        "UPDATE quote_revision_approval_requests SET quote_revision_approval_id = '..'",
      )
      .run();
    const model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "limited");
    assert.equal(model.items.length, 1);
    assert.equal(
      model.sources.find((source) => source.kind === "quote_revision")!.state,
      "unavailable",
    );
  } finally {
    f.db.close();
  }
});

test("one failed source retains other sources, while all failed sources never mean all clear", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < tables.length; index++) f.seed(index);
    f.unavailable.add(tables[1][1]);
    let model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "limited");
    assert.equal(model.items.length, 4);
    assert.deepEqual(model.sources[1], {
      kind: "quote_revision",
      state: "unavailable",
      loaded_count: 0,
      has_more: null,
      next_cursor: null,
      read_model_generated_at: null,
    });
    for (const [, table] of tables) f.unavailable.add(table);
    model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "limited");
    assert.equal(model.items.length, 0);
  } finally {
    f.db.close();
  }
});

test("keyset pages reach every open request without terminal history consuming the bound", async () => {
  const f = fixture();
  try {
    for (let index = 1; index <= 58; index++) {
      const id = f.seed(
        0,
        String(index),
        index % 3 === 0
          ? "execution_uncertain"
          : index % 3 === 1
            ? "pending"
            : "executing",
      );
      f.db
        .prepare(
          "UPDATE approval_requests SET updated_at = ? WHERE approval_request_id = ?",
        )
        .run(new Date(NOW.getTime() - (index % 5) * 1000).toISOString(), id);
    }
    for (let index = 100; index < 170; index++)
      f.seed(0, String(index), ["executed", "denied", "expired"][index % 3]);
    f.seed(0, "999", "pending", "another-tenant");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ decision_source: "lead_triage" });
      if (cursor) params.set("decision_cursor", cursor);
      const parsed = parseDecisionPageRequest(params, actor("owner"));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error("cursor must parse");
      const model = decisionsReadModelSchema.parse(
        await buildDecisionsReadModel(f.env, actor("owner"), NOW, parsed.page),
      );
      assert.equal(model.sources.length, 1);
      assert.equal(model.sources[0]!.loaded_count, model.items.length);
      assert.equal(
        model.sources[0]!.has_more,
        model.sources[0]!.next_cursor !== null,
      );
      ids.push(...model.items.map((item) => item.id));
      cursor = model.sources[0]!.next_cursor;
    } while (cursor);
    assert.equal(ids.length, 58);
    assert.equal(new Set(ids).size, 58);
    assert.ok(ids.every((id) => Number(id.split(":").at(-1)) < 100));
  } finally {
    f.db.close();
  }
});

test("native unresolved provider states remain visible, terminal outcomes do not", async () => {
  const f = fixture();
  try {
    const postiz = [
      "connection_required",
      "pending_review",
      "submission_pending",
      "submitted",
      "reconciliation_required",
      "stop_submitted",
      "stop_reconciliation_required",
    ];
    const quickbooks = [
      "connection_required",
      "blocked",
      "pending_review",
      "submission_pending",
      "submitted",
      "failed",
      "reconciliation_required",
    ];
    [...postiz, "published", "rejected"].forEach((state, index) =>
      f.seed(3, String(index), state),
    );
    [...quickbooks, "matched", "rejected"].forEach((state, index) =>
      f.seed(4, String(index), state),
    );
    const model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.deepEqual(
      new Set(
        model.items
          .filter((item) => item.kind === "postiz")
          .map((item) => item.native_state),
      ),
      new Set(postiz),
    );
    assert.deepEqual(
      new Set(
        model.items
          .filter((item) => item.kind === "quickbooks_final_invoice")
          .map((item) => item.native_state),
      ),
      new Set(quickbooks),
    );
  } finally {
    f.db.close();
  }
});

test("the real Now handler preserves legacy shape and opts into decisions without writes", async () => {
  const f = setup();
  try {
    const before = f.db.raw.prepare("SELECT total_changes() AS count").get()!
      .count;
    const legacyResponse = await handleAuthenticatedRoute(
      new Request("https://app.example.invalid/api/v1/now"),
      f.env,
      actor("owner"),
    );
    assert.equal(legacyResponse.status, 200);
    const legacyModel = await legacyResponse.json();
    assert.equal(Object.hasOwn(legacyModel, "decisions"), false);
    assert.deepEqual(Object.keys(legacyModel).sort(), [
      "allowed_actions",
      "permissions",
      "read_model_generated_at",
      "role",
      "sources",
      "ui",
      "version",
    ]);
    nowResponseSchema.parse(legacyModel);
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.invalid/api/v1/now?include_decisions=1"),
      f.env,
      actor("owner"),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /private.*no-store/);
    const model = nowResponseSchema.parse(await response.json());
    assert.equal(model.decisions!.state, "empty");
    assert.equal(model.decisions!.sources.length, 6);
    assert.ok(
      model.decisions!.sources.every(
        (source) => source.state !== "unavailable",
      ),
    );
    for (const query of [
      "decision_source=quote_revision",
      "include_decisions=1&decision_source=quote_revision",
    ]) {
      const pageResponse = await handleAuthenticatedRoute(
        new Request(`https://app.example.invalid/api/v1/now?${query}`),
        f.env,
        actor("owner"),
      );
      assert.equal(pageResponse.status, 200);
      const page = nowResponseSchema.parse(await pageResponse.json());
      assert.deepEqual(
        page.decisions!.sources.map((source) => source.kind),
        ["quote_revision"],
      );
    }
    assert.equal(
      f.db.raw.prepare("SELECT total_changes() AS count").get()!.count,
      before,
    );
  } finally {
    f.db.close();
  }
});

test("invalid, retired and unauthorized cursor requests stop before any database access", async () => {
  const env = {
    DB: {
      prepare() {
        assert.fail("rejected queries must not access any source");
      },
    },
  } as unknown as AppEnv;
  for (const [role, query, status] of [
    ["owner", "include_decisions=0", 400],
    ["owner", "include_decisions=1&include_decisions=1", 400],
    ["owner", "decision_cursor=bad", 400],
    ["owner", "decision_source=lead_triage&decision_cursor=bad", 400],
    [
      "owner",
      "decision_source=lead_triage&decision_source=quote_revision",
      400,
    ],
    ["owner", "decision_source=production_schedule", 404],
    ["sales", "decision_source=lead_triage", 404],
    ["sales", "decision_source=proposal_publication", 404],
    ["ops", "decision_source=postiz", 404],
    ["ops", "decision_source=quickbooks_final_invoice", 404],
  ] as const) {
    const response = await handleAuthenticatedRoute(
      new Request(`https://app.example.invalid/api/v1/now?${query}`),
      env,
      actor(role),
    );
    assert.equal(response.status, status, query);
  }
  const f = fixture();
  try {
    for (let index = 0; index < 26; index++) f.seed(0, String(index));
    const model = await buildDecisionsReadModel(f.env, actor("owner"), NOW);
    const cursor = model.sources[0]!.next_cursor!;
    assert.deepEqual(
      parseDecisionPageRequest(
        new URLSearchParams({
          decision_source: "quote_revision",
          decision_cursor: cursor,
        }),
        actor("owner"),
      ),
      { ok: false, status: 400 },
    );
    assert.deepEqual(
      parseDecisionPageRequest(
        new URLSearchParams({
          decision_source: "lead_triage",
          decision_cursor: cursor,
        }),
        actor("owner", "another-tenant"),
      ),
      { ok: false, status: 400 },
    );
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    for (const invalid of [
      { ...decoded, v: 2 },
      { ...decoded, priority: 4 },
      { ...decoded, priority: 1.5 },
      { ...decoded, updated_at: null },
      { ...decoded, id: ".." },
      { ...decoded, extra: true },
    ]) {
      const malformed = Buffer.from(JSON.stringify(invalid)).toString(
        "base64url",
      );
      const response = await handleAuthenticatedRoute(
        new Request(
          `https://app.example.invalid/api/v1/now?decision_source=lead_triage&decision_cursor=${malformed}`,
        ),
        env,
        actor("owner"),
      );
      assert.equal(response.status, 400);
    }
  } finally {
    f.db.close();
  }
});
