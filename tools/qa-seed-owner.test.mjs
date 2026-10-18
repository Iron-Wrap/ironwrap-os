import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SEED_OWNER_EMAIL, mintToken, seedOwnerSql, seedOwnerUserId, writeSecret } from "./qa-seed-owner.mjs";

const migrations = new URL("../workers-bus/migrations/", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-01-01T00:00:00.000Z");

function database({ owner = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_.+\.sql$/.test(value)).sort()) {
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  if (owner) {
    db.prepare(
      `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role,
         frappe_user_id, active, created_by, created_at, updated_at)
       VALUES ('appu_existing_owner', 'ironwrap', 'owner@example.invalid', 'Synthetic Owner', 'owner',
         'owner', NULL, 1, 'system', ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString());
  }
  return db;
}

const seedRows = (db) => ({
  users: db.prepare("SELECT user_id, access_role, active FROM app_users WHERE email_normalized = ?").all(SEED_OWNER_EMAIL).map((row) => ({ ...row })),
  audits: db.prepare("SELECT detail_code FROM app_auth_audit WHERE user_id = ? AND event = 'user_provision'").all(seedOwnerUserId()).map((row) => ({ ...row })),
  links: db.prepare("SELECT token_hash, created_at, expires_at, consumed_at FROM app_magic_links WHERE user_id = ?").all(seedOwnerUserId()).map((row) => ({ ...row })),
});

test("the minted token has the exact shape the consume route accepts", () => {
  assert.match(mintToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(mintToken(), mintToken());
});

test("one batch adds the seed owner, one audit row and a 15-minute sign-in, only when an owner exists", () => {
  const empty = database({ owner: false });
  empty.exec(seedOwnerSql({ tokenHash: sha256("first"), now: NOW }));
  assert.deepEqual(seedRows(empty), { users: [], audits: [], links: [] });

  const db = database();
  db.exec(seedOwnerSql({ tokenHash: sha256("first"), now: NOW }));
  assert.deepEqual(seedRows(db), {
    users: [{ user_id: seedOwnerUserId(), access_role: "owner", active: 1 }],
    audits: [{ detail_code: "owner:qa_seed_owner_directed_grant_outside_ui" }],
    links: [{ token_hash: sha256("first"), created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:15:00.000Z", consumed_at: null }],
  });
});

test("a later run never adds a second owner or audit row; it only replaces the sign-in", () => {
  const db = database();
  db.exec(seedOwnerSql({ tokenHash: sha256("first"), now: NOW }));
  db.prepare("UPDATE app_magic_links SET consumed_at = ? WHERE user_id = ?").run("2026-01-01T00:01:00.000Z", seedOwnerUserId());
  const later = new Date("2026-01-01T02:00:00.000Z");
  db.exec(seedOwnerSql({ tokenHash: sha256("second"), now: later }));
  const rows = seedRows(db);
  assert.equal(rows.users.length, 1);
  assert.equal(rows.audits.length, 1);
  assert.deepEqual(rows.links, [{ token_hash: sha256("second"), created_at: later.toISOString(), expires_at: "2026-01-01T02:15:00.000Z", consumed_at: null }]);
});

test("a seed email held by any other user gets no sign-in from this batch", () => {
  const db = database();
  db.prepare(
    `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role,
       frappe_user_id, active, created_by, created_at, updated_at)
     VALUES ('appu_someone_else', 'ironwrap', ?, 'Someone Else', 'ops', 'ops', NULL, 1, 'system', ?, ?)`,
  ).run(SEED_OWNER_EMAIL, NOW.toISOString(), NOW.toISOString());
  db.exec(seedOwnerSql({ tokenHash: sha256("first"), now: NOW }));
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM app_magic_links").get().n, 0);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM app_auth_audit").get().n, 0);
});

test("the secret is written alone to its line in a mode-600 file, replacing an earlier value", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-seed-owner-"));
  const file = join(dir, "qa-release.env");
  writeFileSync(file, "OTHER=keep\nQA_SEED_MAGIC_LINK_TOKEN=old\n");
  writeSecret(file, "QA_SEED_MAGIC_LINK_TOKEN", "new-value");
  assert.equal(readFileSync(file, "utf8"), "OTHER=keep\nQA_SEED_MAGIC_LINK_TOKEN=new-value\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
