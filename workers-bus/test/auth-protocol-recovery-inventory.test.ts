import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, name);
  return source.slice(start, end + 3);
}

test("both actual recovery verifiers require exact auth metadata bindings and reject a same-name weakened SQL guard", () => {
  const temporary = mkdtempSync(join(tmpdir(), "ironwrap-auth-schema-"));
  try {
    const file = join(temporary, "schema.sqlite3");
    const db = new DatabaseSync(file);
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((x) => /^\d{4}_.+\.sql$/.test(x))
      .sort())
      db.exec(
        readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
      );
    for (const script of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
      const source = readFileSync(
        new URL(`../../deploy/${script}`, import.meta.url),
        "utf8",
      );
      const declarations = source
        .split("\n")
        .filter((x) => x.startsWith("REQUIRED_AUTH_PROTOCOL_"));
      assert.equal(declarations.length, 6);
      const helper = join(temporary, `${script}-helper.sh`);
      writeFileSync(
        helper,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          ...declarations,
          shellFunction(source, "verify_object_semantics"),
          shellFunction(source, "verify_auth_protocol_semantics"),
          'verify_auth_protocol_semantics "$1" "local synthetic schema"',
        ].join("\n"),
      );
      const healthy = spawnSync("bash", [helper, file], { encoding: "utf8" });
      assert.equal(healthy.status, 0, healthy.stderr);
      const original = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='app_auth_v2_session_insert'",
        )
        .get()!.sql as string;
      db.exec(
        "DROP TRIGGER app_auth_v2_session_insert; CREATE TRIGGER app_auth_v2_session_insert BEFORE INSERT ON app_sessions BEGIN SELECT 1; END",
      );
      const weakened = spawnSync("bash", [helper, file], { encoding: "utf8" });
      assert.notEqual(weakened.status, 0);
      assert.match(
        weakened.stderr,
        /auth protocol trigger semantics: app_auth_v2_session_insert/,
      );
      db.exec(`DROP TRIGGER app_auth_v2_session_insert; ${original}`);
    }
    db.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
