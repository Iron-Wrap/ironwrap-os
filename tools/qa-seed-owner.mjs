#!/usr/bin/env node
// QA only. Mints the QA seed owner's single-use sign-in, so tools/seed-qa-journey.mjs can drive the
// governed commercial routes as a person, without an auth bypass and without mailing anyone.
//
// One guarded batch against the qa D1 database (ironwrap-bus-qa):
//   1. the seed owner qa-seed@example.invalid, written exactly as the owner-directed QA access
//      grant writes an owner (output/qa/owner-access/qa-owner-grant.sql): only when that email is
//      absent and an active owner already exists, never updating an existing row;
//   2. one app_auth_audit user_provision row for it, detail
//      owner:qa_seed_owner_directed_grant_outside_ui, only if none exists yet;
//   3. a fresh magic link for that user alone, stored as the sha256 of a 32-byte random token with
//      the app's own 15-minute lifetime (MAGIC_LINK_TTL_SECONDS), replacing any earlier one.
// The raw token goes only to the secrets file as QA_SEED_MAGIC_LINK_TOKEN (mode 600); it is never
// printed or logged. Run it right before the seed; each seed run consumes one token.
//
// Usage:
//   node tools/qa-seed-owner.mjs --sql-out output/qa/owner-access/qa-seed-owner.sql \
//     --secrets ~/.secrets/ironwrap/qa-release.env [--apply]
// Without --apply it only writes the SQL and the secret. With --apply it first reads whether the
// seed owner exists, then runs the batch with `wrangler d1 execute ironwrap-bus-qa --env qa --remote`.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEED_OWNER_EMAIL = "qa-seed@example.invalid";
export const QA_DATABASE = "ironwrap-bus-qa";
export const TOKEN_VARIABLE = "QA_SEED_MAGIC_LINK_TOKEN";
const TENANT = "ironwrap";
const MAGIC_LINK_TTL_SECONDS = 15 * 60;
const AUDIT_DETAIL = "owner:qa_seed_owner_directed_grant_outside_ui";
const MARKER = sha256("ironwrap-qa:qa-seed-owner:outside-ui:no-request");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** The seed owner's id never changes, so every run targets the same row. */
export function seedOwnerUserId() {
  const hex = sha256(`${TENANT}:${SEED_OWNER_EMAIL}`);
  return `appu_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A token in the exact shape /api/v1/auth/magic-link/consume accepts (43 base64url characters). */
export function mintToken() {
  return randomBytes(32).toString("base64url");
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function seedOwnerSql({ tokenHash, now = new Date() }) {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("token hash must be 64 hex characters");
  const userId = seedOwnerUserId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  return `-- QA only (D1 ${QA_DATABASE}). Owner-directed QA seed owner and its single-use sign-in, outside the UI.
-- Same guards as output/qa/owner-access/qa-owner-grant.sql: the user row only if the email is absent
-- and an active owner exists; the audit row only once; the sign-in only for this exact active user.
INSERT INTO app_users
  (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
   active, created_by, created_at, updated_at)
SELECT ${quote(userId)}, ${quote(TENANT)}, ${quote(SEED_OWNER_EMAIL)}, 'QA Seed Owner (synthetic)', 'owner', 'owner', NULL,
       1, 'system:owner_directed_qa_seed_grant', ${quote(createdAt)}, ${quote(createdAt)}
 WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE tenant_id = ${quote(TENANT)} AND email_normalized = ${quote(SEED_OWNER_EMAIL)})
   AND EXISTS (SELECT 1 FROM app_users WHERE tenant_id = ${quote(TENANT)} AND access_role = 'owner' AND active = 1);
INSERT INTO app_auth_audit
  (created_at, tenant_id, user_id, event, outcome, ip_hash, user_agent_hash, detail_code)
SELECT ${quote(createdAt)}, ${quote(TENANT)}, ${quote(userId)}, 'user_provision', 'active', ${quote(MARKER)}, ${quote(MARKER)},
       ${quote(AUDIT_DETAIL)}
 WHERE EXISTS (SELECT 1 FROM app_users WHERE user_id = ${quote(userId)})
   AND NOT EXISTS (SELECT 1 FROM app_auth_audit WHERE user_id = ${quote(userId)} AND event = 'user_provision');
INSERT INTO app_magic_links
  (token_hash, user_id, tenant_id, created_at, expires_at, consumed_at, request_ip_hash, request_user_agent_hash)
SELECT ${quote(tokenHash)}, ${quote(userId)}, ${quote(TENANT)}, ${quote(createdAt)}, ${quote(expiresAt)}, NULL, ${quote(MARKER)}, ${quote(MARKER)}
 WHERE EXISTS (SELECT 1 FROM app_users
                WHERE user_id = ${quote(userId)} AND tenant_id = ${quote(TENANT)}
                  AND email_normalized = ${quote(SEED_OWNER_EMAIL)} AND access_role = 'owner' AND active = 1)
ON CONFLICT(user_id) DO UPDATE SET
  token_hash = excluded.token_hash,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  consumed_at = NULL,
  request_ip_hash = excluded.request_ip_hash,
  request_user_agent_hash = excluded.request_user_agent_hash;
`;
}

/** Replace (or add) one line in an env file without printing or keeping any other copy of it. */
export function writeSecret(path, name, value) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : [];
  const kept = lines.filter((line) => !line.startsWith(`${name}=`));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${[...kept, `${name}=${value}`].join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseArgs(argv) {
  const args = { apply: false, sqlOut: null, secrets: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--sql-out") args.sqlOut = argv[++i];
    else if (argv[i] === "--secrets") args.secrets = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.sqlOut || !args.secrets) throw new Error("--sql-out and --secrets are required");
  return args;
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: resolve(ROOT, "workers-bus"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const secrets = resolve(args.secrets.replace(/^~(?=\/)/, homedir()));
  const sqlOut = resolve(ROOT, args.sqlOut);
  const token = mintToken();
  const sql = seedOwnerSql({ tokenHash: sha256(token) });
  mkdirSync(dirname(sqlOut), { recursive: true });
  writeFileSync(sqlOut, sql, { mode: 0o600 });
  chmodSync(sqlOut, 0o600);
  writeSecret(secrets, TOKEN_VARIABLE, token);
  const summary = { user_id: seedOwnerUserId(), sql: args.sqlOut, secret: `${TOKEN_VARIABLE} in ${args.secrets}` };
  if (args.apply) {
    const before = JSON.parse(wrangler(["d1", "execute", QA_DATABASE, "--env", "qa", "--remote", "--json", "--command",
      `SELECT user_id FROM app_users WHERE tenant_id = '${TENANT}' AND email_normalized = '${SEED_OWNER_EMAIL}'`]));
    const existing = before?.[0]?.results?.[0]?.user_id ?? null;
    if (existing && existing !== seedOwnerUserId()) throw new Error("a different qa-seed user already exists; refusing");
    wrangler(["d1", "execute", QA_DATABASE, "--env", "qa", "--remote", "--file", sqlOut]);
    const after = JSON.parse(wrangler(["d1", "execute", QA_DATABASE, "--env", "qa", "--remote", "--json", "--command",
      `SELECT u.user_id, u.active, (SELECT count(*) FROM app_auth_audit a WHERE a.user_id = u.user_id AND a.event = 'user_provision') AS audits, (SELECT count(*) FROM app_magic_links m WHERE m.user_id = u.user_id AND m.consumed_at IS NULL) AS open_links FROM app_users u WHERE u.tenant_id = '${TENANT}' AND u.email_normalized = '${SEED_OWNER_EMAIL}'`]));
    Object.assign(summary, { created: !existing, readback: after?.[0]?.results?.[0] ?? null });
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
