import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function inventory(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`^${name}(?:\\+)?="([^\"]*)"`, "gm"))]
    .flatMap((match) => match[1].split(","))
    .filter(Boolean);
}

test("measurement recovery inventories and semantic contracts match the real complete SQLite schema", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  const schema = db
    .prepare(
      "SELECT name,tbl_name,type,sql FROM sqlite_master WHERE sql IS NOT NULL",
    )
    .all();
  for (const file of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
    const source = readFileSync(
      new URL(`../../deploy/${file}`, import.meta.url),
      "utf8",
    );
    for (const [kind, variable] of [
      ["index", "INDEX"],
      ["trigger", "TRIGGER"],
    ]) {
      const bindings = inventory(source, `REQUIRED_${variable}_BINDINGS`);
      const count = Number(
        source.match(new RegExp(`^REQUIRED_${variable}_COUNT=(\\d+)`, "m"))![1],
      );
      assert.equal(bindings.length, count);
      assert.equal(new Set(bindings).size, count);
      assert.equal(schema.filter((row) => row.type === kind).length, count);
      for (const row of schema.filter(
        (row) =>
          row.type === kind && String(row.name).includes("field_measurement"),
      ))
        assert.ok(
          bindings.includes(`${row.name}=${row.tbl_name}`),
          `${file} must recover ${row.name}`,
        );
    }
    for (const [kind, variable] of [
      ["table", "TABLE"],
      ["index", "INDEX"],
      ["trigger", "TRIGGER"],
    ]) {
      const contract = source.match(
        new RegExp(
          `^REQUIRED_FIELD_MEASUREMENT_${variable}_SEMANTICS="([^\"]*)"`,
          "m",
        ),
      )![1];
      for (const spec of contract.split(";")) {
        const [name, ...parts] = spec.split("|");
        const row = schema.find(
          (row) => row.type === kind && row.name === name,
        );
        assert.ok(row, `${file}: missing ${name}`);
        const sql = String(row.sql)
          .toLowerCase()
          .replace(/\s+/g, "")
          .replaceAll("ifnotexists", "");
        for (const fragment of parts)
          assert.ok(
            sql.includes(fragment),
            `${file}: ${name} must preserve ${fragment}`,
          );
      }
    }
    assert.match(
      source,
      /if ! verify_field_measurement_semantics "\$verification_db"/,
    );
  }
});
