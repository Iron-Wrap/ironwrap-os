import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { type AppEnv, type AppRole } from "../src/app-types.ts";
import {
  buildDecisionsReadModel,
  parseDecisionPageRequest,
} from "../src/decision-read-model.ts";
import { setup } from "./pipeline-board-fixture.ts";
import { actor, fixture, NOW, tables } from "./decision-read-model-fixture.ts";
import { permissionsForRole } from "../src/app-types.ts";

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

test("current sources are tenant-bound read-only projections with native destinations", async () => {
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
    assert.equal(model.items.length, 2);
    assert.equal(model.sources.length, 6);
    assert.deepEqual(
      model.items.map((item) => item.review_href),
      [
        "/marketing/postiz/11111111-1111-4111-8111-000000000001",
        "/accounting/quickbooks/final-invoices/request%3Afixture%3A4%3A1",
      ],
    );
    assert.equal(model.items[0]!.native_state, "pending_review");
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
        expected[role].filter(
          (kind) => kind === "postiz" || kind === "quickbooks_final_invoice",
        ).length,
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
    f.seed(3);
    f.seed(4);
    f.db.prepare("UPDATE postiz_intents SET intent_id = '..'").run();
    const model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "limited");
    assert.equal(model.items.length, 1);
    assert.equal(
      model.sources.find((source) => source.kind === "postiz")!.state,
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
    f.unavailable.add(tables[3][1]);
    let model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.equal(model.state, "limited");
    assert.equal(model.items.length, 1);
    assert.deepEqual(model.sources[4], {
      kind: "postiz",
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
        3,
        String(index),
        index % 3 === 0
          ? "reconciliation_required"
          : index % 3 === 1
            ? "pending_review"
            : "submission_pending",
      );
      f.db
        .prepare("UPDATE postiz_intents SET updated_at = ? WHERE intent_id = ?")
        .run(new Date(NOW.getTime() - (index % 5) * 1000).toISOString(), id);
    }
    for (let index = 100; index < 170; index++)
      f.seed(3, String(index), ["published", "rejected"][index % 2]);
    f.seed(3, "999", "pending_review", "another-tenant");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ decision_source: "postiz" });
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
    assert.ok(ids.every((id) => Number(id.split("-").at(-1)) < 100));
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
      "decision_source=postiz",
      "include_decisions=1&decision_source=postiz",
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
        ["postiz"],
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
    ["owner", "decision_source=postiz&decision_cursor=bad", 400],
    [
      "owner",
      "decision_source=lead_triage&decision_source=quote_revision",
      400,
    ],
    ["owner", "decision_source=production_schedule", 404],
    ["owner", "decision_source=lead_triage", 404],
    ["owner", "decision_source=quote_revision", 404],
    ["owner", "decision_source=proposal_publication", 404],
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
    for (let index = 0; index < 26; index++) f.seed(3, String(index));
    const model = await buildDecisionsReadModel(f.env, actor("owner"), NOW);
    const cursor = model.sources.find(
      (source) => source.kind === "postiz",
    )!.next_cursor!;
    assert.deepEqual(
      parseDecisionPageRequest(
        new URLSearchParams({
          decision_source: "quickbooks_final_invoice",
          decision_cursor: cursor,
        }),
        actor("owner"),
      ),
      { ok: false, status: 400 },
    );
    assert.deepEqual(
      parseDecisionPageRequest(
        new URLSearchParams({
          decision_source: "postiz",
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
          `https://app.example.invalid/api/v1/now?decision_source=postiz&decision_cursor=${malformed}`,
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

test("retired broker rows remain stored without current Decisions invitations", async () => {
  const f = fixture();
  try {
    for (const index of [0, 1, 2]) {
      f.seed(index, "1", "pending");
      f.seed(index, "2", "execution_uncertain");
      f.seed(index, "3", "pending", "another-tenant");
    }
    const currentId = f.seed(3, "1", "pending_review");
    f.seed(3, "2", "pending_review", "another-tenant");
    const before = tables.map(([, table]) =>
      f.db.prepare(`SELECT * FROM ${table}`).all(),
    );
    const model = decisionsReadModelSchema.parse(
      await buildDecisionsReadModel(f.env, actor("owner"), NOW),
    );
    assert.deepEqual(
      model.items.map((item) => item.id),
      [currentId],
    );
    for (const kind of [
      "lead_triage",
      "quote_revision",
      "proposal_publication",
      "production_schedule",
    ])
      assert.deepEqual(
        model.sources.find((source) => source.kind === kind),
        {
          kind,
          state: "retired",
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        },
      );
    assert.ok(
      f.reads.every(
        (sql) =>
          !/FROM (approval_requests|quote_revision_approval_requests|proposal_publication_approval_requests)/.test(
            sql,
          ),
      ),
    );
    assert.deepEqual(
      tables.map(([, table]) => f.db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
  } finally {
    f.db.close();
  }
});
