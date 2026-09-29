import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

// D1 splits the SQL it receives from `wrangler d1 migrations apply --remote`
// into statements itself, and its splitter ends a trigger body at the first
// literal `END;` (END immediately followed by a semicolon). SQLite's own
// grammar does not care, so a statement-level `SELECT CASE … END;` inside a
// trigger body compiles everywhere except on D1, where the trigger is cut short
// and the apply fails with `incomplete input: SQLITE_ERROR [code: 7500]`.
//
// Verified on the qa database on 2026-09-29 with scratch triggers:
//   rejected: `SELECT CASE WHEN … THEN RAISE(…) END;` inside a body, in any position
//   accepted: `SELECT RAISE(ABORT, '…') WHERE …;`, `… = CASE … END,` inside
//             UPDATE … SET, `(CASE … END)` inside VALUES or SELECT, `CASE … END`
//             followed by a newline and WHERE, and even `CASE … END ;`.
// Local Miniflare runs never see this, which is how 131 migrations applied on
// every stand while no remote database got past 0058.
//
// Rule enforced here, stricter than D1 on purpose: inside a CREATE TRIGGER
// statement the token END followed by a semicolon (with or without whitespace)
// appears exactly once, as the trigger's own terminator. Guards are written as
// `SELECT RAISE(ABORT, 'reason') WHERE condition;` — one statement per branch,
// in the original order, which SQLite evaluates identically.
//
// Statements are split with SQLite itself: `prepare` compiles exactly one
// statement, and `sourceSQL` tells where it ended. Needs the unflagged
// `node:sqlite` of Node 22.13+ (`.nvmrc` = 22).

const migrationsDir = fileURLToPath(new URL("../workers-bus/migrations/", import.meta.url));
const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const triggerTerminator = /\bEND\s*;/gi;

function statementsOf(db, sql) {
  const statements = [];
  let rest = sql;
  while (rest.trim()) {
    const statement = db.prepare(rest);
    const source = statement.sourceSQL;
    assert.ok(source.length > 0, "SQLite compiled an empty statement");
    statements.push(source);
    db.exec(source);
    rest = rest.slice(source.length);
  }
  return statements;
}

function triggerProblems(statement) {
  if (!/^\s*CREATE\s+TRIGGER/i.test(statement)) return null;
  const terminators = statement.match(triggerTerminator) ?? [];
  if (terminators.length === 1) return null;
  const name = /TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement)?.[1] ?? "?";
  return `trigger ${name} has ${terminators.length} occurrences of "END;" but D1 ends the trigger at the first one; ` +
    "rewrite statement-level CASE guards as `SELECT RAISE(ABORT, 'reason') WHERE condition;`";
}

test("the migrations directory is non-empty and ordered", () => {
  assert.ok(files.length >= 110, `expected at least 110 migration files, found ${files.length}`);
  assert.deepEqual(files, [...files].sort());
});

const db = new DatabaseSync(":memory:");
for (const name of files) {
  test(`${name} applies statement by statement and every trigger ends once for D1`, () => {
    const statements = statementsOf(db, readFileSync(path.join(migrationsDir, name), "utf8"));
    assert.ok(statements.length > 0, "no statements produced");
    for (const statement of statements) {
      const problem = triggerProblems(statement);
      assert.equal(problem, null, `${name}: ${problem}`);
    }
  });
}

test("the rule itself catches the shape D1 rejects and accepts the rewrite", () => {
  const rejected = "CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW BEGIN\n  SELECT CASE WHEN NEW.v != OLD.v + 1 THEN RAISE(ABORT, 'v') END;\nEND;";
  assert.match(triggerProblems(rejected) ?? "", /2 occurrences/);
  const accepted = "CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW BEGIN\n  SELECT RAISE(ABORT, 'v') WHERE NEW.v != OLD.v + 1;\n  UPDATE a SET w = CASE WHEN NEW.v > 0 THEN 1 ELSE w END, z = (CASE WHEN 1 THEN 1 END)\n   WHERE id = NEW.id;\nEND;";
  assert.equal(triggerProblems(accepted), null);
});
