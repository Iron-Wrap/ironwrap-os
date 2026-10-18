import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  auth,
  request,
  setup,
  TENANT,
  USERS,
} from "./pipeline-board-fixture.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  activateCatalogRevision,
  createCatalogRevision,
  readCatalogHead,
  readPricingCatalog,
  selectCatalogPricingForImport,
  PricingCatalogError,
  catalogRevisionView,
  catalogActivationView,
} from "../src/pricing-catalog.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";

import { catalogList } from "./pricing-catalog-fixture.ts";
const actor = { tenantId: TENANT, userId: USERS.owner.userId, role: "owner" };
const key = () => `pricing:synthetic:${crypto.randomUUID()}`;
const NOW = new Date("2026-09-30T12:00:00.000Z");
function fixture() {
  const f = setup(),
    batch = f.db.batch.bind(f.db);
  f.env.APP_PRICING_CATALOG_ENABLED = "true";
  let tail: Promise<unknown> = Promise.resolve();
  f.db.batch = (statements) => {
    const r = tail.then(() => batch(statements));
    tail = r.catch(() => {});
    return r;
  };
  return f;
}
test("catalog routes stay closed until the pricing cutover is enabled", async () => {
  const f = fixture();
  try {
    f.env.APP_PRICING_CATALOG_ENABLED = "false";
    assert.equal((await route(f, "GET")).status, 404);
    assert.equal(
      (
        await route(f, "POST", "/revisions", {
          label: "Unavailable",
          price_list: catalogList(),
        })
      ).status,
      404,
    );
    assert.equal(count(f, "pricing_catalog_revisions"), 0);
    assert.equal(count(f, "pricing_catalog_activations"), 0);
  } finally {
    f.db.raw.close();
  }
});
const route = (
  f: ReturnType<typeof fixture>,
  method: string,
  path = "",
  body?: unknown,
  k = key(),
  who = auth("owner"),
  csrf = true,
) =>
  handleAuthenticatedRoute(
    request(method, "/api/v1/pricing/catalog" + path, {
      body,
      idempotency: k,
      csrf,
    }),
    f.env,
    who,
  );
async function receipt(r: Response) {
  const body = await r.json();
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(body));
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.ok(body && typeof body === "object");
  assert.equal(typeof (body as Record<string, unknown>).replayed, "boolean");
  assert.ok("revision" in body || "activation" in body);
  return body as
    | { replayed: boolean; revision: ReturnType<typeof catalogRevisionView> }
    | {
        replayed: boolean;
        activation: ReturnType<typeof catalogActivationView>;
      };
}
const error = (code: string) => (e: unknown) =>
  e instanceof PricingCatalogError && e.code === code;
const count = (f: ReturnType<typeof fixture>, table: string) =>
  (f.db.raw.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number })
    .n;

test("catalog API: saving a reviewed-format revision is not approval; explicit owner/ops activation records exact hash and actor", async () => {
  const f = fixture();
  try {
    const id = key(),
      input = { label: "Synthetic A", price_list: catalogList() };
    const draft = await receipt(
      await route(f, "POST", "/revisions", input, id),
    );
    assert.ok("revision" in draft);
    assert.equal(draft.revision.snapshot_json, canonicalJson(input.price_list));
    assert.equal(
      draft.revision.snapshot_sha256,
      await sha256Hex(draft.revision.snapshot_json),
    );
    assert.equal(await selectCatalogPricingForImport(f.env, TENANT, NOW), null);
    assert.equal((await readCatalogHead(f.env, TENANT)).version, 0);
    assert.equal(count(f, "pricing_catalog_activations"), 0);
    const model = (await (await route(f, "GET")).json()) as Awaited<
      ReturnType<typeof readPricingCatalog>
    > & { allowed_actions: string[] };
    assert.equal(model.active_revision, null);
    const command = {
      revision_id: draft.revision.revision_id,
      reviewed_sha256: draft.revision.snapshot_sha256,
      expected_version: 0,
    };
    const active = await receipt(
      await route(f, "POST", "/activations", command, key(), auth("ops")),
    );
    assert.ok("activation" in active);
    assert.equal(active.activation.actor_id, USERS.ops.userId);
    assert.equal(active.activation.actor_role, "ops");
    assert.equal(
      active.activation.reviewed_sha256,
      draft.revision.snapshot_sha256,
    );
    const selected = await selectCatalogPricingForImport(
      f.env,
      TENANT,
      new Date(active.activation.approved_at),
    );
    assert.ok(selected);
    assert.equal(
      selected.authority.snapshotSha256,
      draft.revision.snapshot_sha256,
    );
    const sales = (await (
      await route(f, "GET", "", undefined, key(), auth("sales"))
    ).json()) as Awaited<ReturnType<typeof readPricingCatalog>> & {
      allowed_actions: string[];
    };
    assert.deepEqual(sales.allowed_actions, []);
    assert.deepEqual(f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});
test("catalog read fails closed when a restored head names a missing activation", async () => {
  const f = fixture();
  try {
    const draft = await createCatalogRevision(
      f.env,
      actor,
      { label: "Synthetic A", price_list: catalogList() },
      key(),
      NOW,
    );
    await activateCatalogRevision(
      f.env,
      actor,
      {
        revision_id: draft.revision.revision_id,
        reviewed_sha256: draft.revision.snapshot_sha256,
        expected_version: 0,
      },
      key(),
      NOW,
    );
    f.db.raw.exec("DROP TRIGGER pricing_catalog_head_update_guard");
    f.db.raw
      .prepare(
        "UPDATE pricing_catalog_heads SET activation_id=? WHERE tenant_id=?",
      )
      .run("pricingactivation:missing", TENANT);
    await assert.rejects(
      () => readPricingCatalog(f.env, TENANT),
      error("pricing_catalog_authority_invalid"),
    );
    const response = await route(f, "GET");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "pricing_catalog_authority_invalid",
    });
  } finally {
    f.db.close();
  }
});
test("a restored catalog without its head cannot silently become unpriced or accept another revision", async () => {
  const f = fixture();
  try {
    const draft = await createCatalogRevision(
      f.env,
      actor,
      { label: "Synthetic A", price_list: catalogList() },
      key(),
      NOW,
    );
    await activateCatalogRevision(
      f.env,
      actor,
      {
        revision_id: draft.revision.revision_id,
        reviewed_sha256: draft.revision.snapshot_sha256,
        expected_version: 0,
      },
      key(),
      NOW,
    );
    f.db.raw.exec("DROP TRIGGER pricing_catalog_head_no_delete");
    f.db.raw
      .prepare("DELETE FROM pricing_catalog_heads WHERE tenant_id=?")
      .run(TENANT);
    await assert.rejects(
      () => selectCatalogPricingForImport(f.env, TENANT, NOW),
      error("pricing_catalog_authority_invalid"),
    );
    await assert.rejects(
      () => readPricingCatalog(f.env, TENANT),
      error("pricing_catalog_authority_invalid"),
    );
    await assert.rejects(
      () =>
        createCatalogRevision(
          f.env,
          actor,
          { label: "Synthetic B", price_list: catalogList() },
          key(),
          NOW,
        ),
      error("pricing_catalog_authority_invalid"),
    );
    assert.equal(count(f, "pricing_catalog_heads"), 0);
    assert.equal(count(f, "pricing_catalog_revisions"), 1);
  } finally {
    f.db.close();
  }
});
test("a restored pricing head cannot reactivate a catalog behind retained approval history", async () => {
  const f = fixture();
  try {
    const approved = [];
    for (const revision of [1, 2]) {
      const draft = await createCatalogRevision(
        f.env,
        actor,
        { label: `Synthetic ${revision}`, price_list: catalogList(revision) },
        key(),
        NOW,
      );
      approved.push(
        await activateCatalogRevision(
          f.env,
          actor,
          {
            revision_id: draft.revision.revision_id,
            reviewed_sha256: draft.revision.snapshot_sha256,
            expected_version: revision - 1,
          },
          key(),
          NOW,
        ),
      );
    }
    f.db.raw.exec("DROP TRIGGER pricing_catalog_head_update_guard");
    f.db.raw
      .prepare(
        "UPDATE pricing_catalog_heads SET version=1,activation_id=? WHERE tenant_id=?",
      )
      .run(approved[0].activation.activation_id, TENANT);
    const changes = f.db.raw.prepare("SELECT total_changes() AS n").get();
    for (const read of [
      () => readPricingCatalog(f.env, TENANT),
      () => selectCatalogPricingForImport(f.env, TENANT, NOW),
      () =>
        createCatalogRevision(
          f.env,
          actor,
          { label: "Synthetic third", price_list: catalogList(3) },
          key(),
          NOW,
        ),
    ])
      await assert.rejects(read, error("pricing_catalog_authority_invalid"));
    const response = await route(f, "GET");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "pricing_catalog_authority_invalid",
    });
    assert.deepEqual(
      f.db.raw.prepare("SELECT total_changes() AS n").get(),
      changes,
    );
    assert.equal(count(f, "pricing_catalog_activations"), 2);
    assert.equal(count(f, "pricing_catalog_revisions"), 2);
  } finally {
    f.db.close();
  }
});

test("lost activation response replays original receipt after B activation and A expiry; changed key payload conflicts", async () => {
  const f = fixture();
  try {
    const a = await createCatalogRevision(
      f.env,
      actor,
      { label: "A", price_list: catalogList() },
      key(),
      NOW,
    );
    const action = {
        revision_id: a.revision.revision_id,
        reviewed_sha256: a.revision.snapshot_sha256,
        expected_version: 0,
      },
      id = key();
    const first = await activateCatalogRevision(f.env, actor, action, id, NOW);
    const b = await createCatalogRevision(
      f.env,
      actor,
      { label: "B", price_list: catalogList(2, 250) },
      key(),
      NOW,
    );
    await activateCatalogRevision(
      f.env,
      actor,
      {
        revision_id: b.revision.revision_id,
        reviewed_sha256: b.revision.snapshot_sha256,
        expected_version: 1,
      },
      key(),
      NOW,
    );
    const replay = await activateCatalogRevision(
      f.env,
      actor,
      action,
      id,
      new Date("2035-01-01T00:00:00.000Z"),
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.activation, first.activation);
    assert.equal((await readCatalogHead(f.env, TENANT)).version, 2);
    await assert.rejects(
      () =>
        activateCatalogRevision(
          f.env,
          actor,
          { ...action, expected_version: 2 },
          id,
          NOW,
        ),
      error("pricing_catalog_idempotency_conflict"),
    );
    assert.equal(count(f, "pricing_catalog_activations"), 2);
  } finally {
    f.db.close();
  }
});
test("deployment pricing transfers only on an explicit draft action and replays original bytes after env change", async () => {
  const f = fixture();
  try {
    Object.assign(f.env, {
      ESTIMATOR_PRICE_LIST_JSON: JSON.stringify(catalogList()),
    });
    assert.equal(await selectCatalogPricingForImport(f.env, TENANT, NOW), null);
    const k = key(),
      input = {
        label: "Transferred for review",
        source: "environment" as const,
      };
    const first = await createCatalogRevision(f.env, actor, input, k, NOW);
    Object.assign(f.env, {
      ESTIMATOR_PRICE_LIST_JSON: "broken synthetic config",
    });
    const replay = await createCatalogRevision(f.env, actor, input, k, NOW);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.revision, first.revision);
    assert.equal(count(f, "pricing_catalog_activations"), 0);
  } finally {
    f.db.close();
  }
});
test("concurrent and stale activations advance exactly once with no orphan receipts or partial head", async () => {
  const f = fixture();
  try {
    const a = await createCatalogRevision(
      f.env,
      actor,
      { label: "A", price_list: catalogList() },
      key(),
      NOW,
    );
    const b = await createCatalogRevision(
      f.env,
      actor,
      { label: "B", price_list: catalogList(2) },
      key(),
      NOW,
    );
    const outcomes = await Promise.allSettled(
      [a, b].map((x) =>
        activateCatalogRevision(
          f.env,
          actor,
          {
            revision_id: x.revision.revision_id,
            reviewed_sha256: x.revision.snapshot_sha256,
            expected_version: 0,
          },
          key(),
          NOW,
        ),
      ),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
    assert.equal(count(f, "pricing_catalog_activations"), 1);
    assert.equal((await readCatalogHead(f.env, TENANT)).version, 1);
    await assert.rejects(
      () =>
        activateCatalogRevision(
          f.env,
          actor,
          {
            revision_id: b.revision.revision_id,
            reviewed_sha256: b.revision.snapshot_sha256,
            expected_version: 0,
          },
          key(),
          NOW,
        ),
      error("pricing_catalog_head_conflict"),
    );
    assert.equal(count(f, "pricing_catalog_activations"), 1);
    for (const table of [
      "pricing_catalog_revisions",
      "pricing_catalog_activations",
    ]) {
      assert.throws(
        () => f.db.raw.exec(`UPDATE ${table} SET actor_role='ops'`),
        /pricing_catalog_immutable/,
      );
      assert.throws(
        () => f.db.raw.exec(`DELETE FROM ${table}`),
        /pricing_catalog_immutable/,
      );
      const row = f.db.raw.prepare(`SELECT * FROM ${table} LIMIT 1`).get()!;
      assert.throws(
        () =>
          f.db.raw
            .prepare(
              `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(
                row,
              )
                .map(() => "?")
                .join(",")})`,
            )
            .run(...(Object.values(row) as never[])),
        /pricing_catalog_immutable|pricing_catalog_head_conflict/,
      );
    }
    assert.throws(
      () => f.db.raw.exec("UPDATE pricing_catalog_heads SET version=version+1"),
      /pricing_catalog_head_conflict/,
    );
  } finally {
    f.db.close();
  }
});
test("tenant, role, permission and CSRF gates fail closed; SQL rechecks an actor changed after HTTP preflight", async () => {
  const f = fixture();
  try {
    const input = { label: "A", price_list: catalogList() };
    assert.equal(
      (await route(f, "POST", "/revisions", input, key(), auth("sales")))
        .status,
      403,
    );
    assert.equal(
      (await route(f, "POST", "/revisions", input, key(), auth("owner"), false))
        .status,
      403,
    );
    const other = {
      ...auth("owner"),
      session: { ...auth("owner").session, tenant_id: "other-synthetic" },
    };
    assert.equal(
      (await route(f, "GET", "", undefined, key(), other)).status,
      403,
    );
    assert.equal(
      (
        await route(f, "POST", "/revisions", {
          ...input,
          price_list: {
            ...catalogList(),
            approvedPolicy: {
              ...catalogList().approvedPolicy,
              tenantId: "other-synthetic",
            },
          },
        })
      ).status,
      403,
    );
    const a = await createCatalogRevision(f.env, actor, input, key(), NOW);
    const prepare = f.db.prepare.bind(f.db);
    let changed = false;
    f.db.prepare = (sql) => {
      if (
        sql.startsWith("INSERT INTO pricing_catalog_activations") &&
        !changed
      ) {
        changed = true;
        f.db.raw
          .prepare("UPDATE app_users SET access_role='sales' WHERE user_id=?")
          .run(actor.userId);
      }
      return prepare(sql);
    };
    await assert.rejects(
      () =>
        activateCatalogRevision(
          f.env,
          actor,
          {
            revision_id: a.revision.revision_id,
            reviewed_sha256: a.revision.snapshot_sha256,
            expected_version: 0,
          },
          key(),
          NOW,
        ),
      error("pricing_catalog_actor_forbidden"),
    );
    assert.equal(count(f, "pricing_catalog_activations"), 0);
    assert.equal((await readCatalogHead(f.env, TENANT)).version, 0);
  } finally {
    f.db.close();
  }
});
test("catalog rejects tampered hash, ambiguous/missing/float rates, units, unknown fields, oversized bytes and exact UTC window violations", async () => {
  const f = fixture();
  try {
    for (const change of [
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        panel: { ...p.panel, rateCents: 1.5 },
      }),
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        panel: { sku: "PANEL", unit: "sqft", sourceRef: "synthetic:rate" },
      }),
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        panel: { ...p.panel, unit: "squares" },
      }),
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        panel: { ...p.panel, rate: 1 },
      }),
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        panel: { ...p.panel, rateCents: 0, sourceRef: "" },
      }),
      (p: ReturnType<typeof catalogList>) => ({ ...p, ignored: "no" }),
      (p: ReturnType<typeof catalogList>) => ({
        ...p,
        approvedPolicy: {
          ...p.approvedPolicy,
          effectiveAt: "2026-01-01T00:00:00Z",
        },
      }),
    ]) {
      await assert.rejects(
        () =>
          createCatalogRevision(
            f.env,
            actor,
            { label: "Invalid", price_list: change(catalogList()) },
            key(),
            NOW,
          ),
        error("pricing_catalog_snapshot_invalid"),
      );
    }
    assert.equal(count(f, "pricing_catalog_revisions"), 0);
    assert.equal(count(f, "pricing_catalog_heads"), 0);
    const p = catalogList();
    p.approvedPolicy.effectiveAt = NOW.toISOString();
    p.approvedPolicy.expiresAt = new Date(NOW.getTime() + 1).toISOString();
    p.panel.rateCents = 0;
    const a = await createCatalogRevision(
      f.env,
      actor,
      { label: "Boundary zero", price_list: p },
      key(),
      NOW,
    );
    const command = {
      revision_id: a.revision.revision_id,
      reviewed_sha256: a.revision.snapshot_sha256,
      expected_version: 0,
    };
    await assert.rejects(
      () =>
        activateCatalogRevision(
          f.env,
          actor,
          { ...command, reviewed_sha256: "a".repeat(64) },
          key(),
          NOW,
        ),
      error("pricing_catalog_review_mismatch"),
    );
    await assert.rejects(
      () =>
        activateCatalogRevision(
          f.env,
          actor,
          command,
          key(),
          new Date(NOW.getTime() - 1),
        ),
      error("pricing_catalog_not_effective"),
    );
    await activateCatalogRevision(f.env, actor, command, key(), NOW);
    assert.ok(await selectCatalogPricingForImport(f.env, TENANT, NOW));
    assert.ok(
      await selectCatalogPricingForImport(
        f.env,
        TENANT,
        new Date(NOW.getTime() + 1),
      ),
    );
    await assert.rejects(
      () =>
        selectCatalogPricingForImport(
          f.env,
          TENANT,
          new Date(NOW.getTime() + 2),
        ),
      error("pricing_catalog_not_effective"),
    );
    f.db.raw.exec("DROP TRIGGER pricing_catalog_revision_no_update");
    f.db.raw.exec(
      "UPDATE pricing_catalog_revisions SET snapshot_sha256='" +
        "f".repeat(64) +
        "'",
    );
    await assert.rejects(
      () => readPricingCatalog(f.env, TENANT),
      error("pricing_catalog_snapshot_corrupt"),
    );
    assert.equal(
      (
        await route(f, "POST", "/revisions", {
          label: "Too large",
          price_list: { padding: "x".repeat(68000) },
        })
      ).status,
      413,
    );
  } finally {
    f.db.close();
  }
});
test("catalog tables, indexes, triggers and estimator pins are in both backup/restore inventories", () => {
  const f = fixture();
  try {
    const names = f.db.raw
      .prepare(
        "SELECT name,type,tbl_name FROM sqlite_master WHERE name LIKE '%pricing_catalog%' AND type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string; type: string; tbl_name: string }>;
    for (const file of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
      const script = readFileSync(
        new URL(`../../deploy/${file}`, import.meta.url),
        "utf8",
      );
      for (const n of names)
        assert.ok(
          script.includes(
            n.type === "table" ? n.name : `${n.name}=${n.tbl_name}`,
          ),
          `${file}: ${n.name}`,
        );
    }
  } finally {
    f.db.close();
  }
});

test("an activation projection failure atomically rolls back its approval receipt and head", async () => {
  const f = fixture();
  try {
    const a = await createCatalogRevision(
      f.env,
      actor,
      { label: "Atomic synthetic", price_list: catalogList() },
      key(),
      NOW,
    );
    f.db.raw.exec(
      "CREATE TRIGGER synthetic_catalog_failure BEFORE UPDATE ON pricing_catalog_heads BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END;",
    );
    await assert.rejects(() =>
      activateCatalogRevision(
        f.env,
        actor,
        {
          revision_id: a.revision.revision_id,
          reviewed_sha256: a.revision.snapshot_sha256,
          expected_version: 0,
        },
        key(),
        NOW,
      ),
    );
    assert.equal(count(f, "pricing_catalog_activations"), 0);
    assert.equal((await readCatalogHead(f.env, TENANT)).version, 0);
    assert.equal(count(f, "pricing_catalog_revisions"), 1);
  } finally {
    f.db.close();
  }
});
