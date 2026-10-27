import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = new URL("./validate-newo-config.mjs", import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
// Every file the validator reads, copied so a test can change one without touching the tree.
const VALIDATED_PATHS = ["config/newo", "workers-bus/wrangler.jsonc", "workers-bus/src/newo-client.ts"];

function validateCopy(t, change = () => {}) {
  const copy = mkdtempSync(join(tmpdir(), "newo-config-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const path of VALIDATED_PATHS) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    cpSync(join(root, path), join(copy, path), { recursive: true });
  }
  change(copy);
  return spawnSync(process.execPath, [script.pathname, "--root", copy], { encoding: "utf8" });
}

function editJson(copy, path, edit) {
  const file = join(copy, path);
  const value = JSON.parse(readFileSync(file, "utf8"));
  edit(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Edits a hash-pinned file and moves its pin, so the check under test is the one that fails.
function editPinned(copy, path, edit) {
  const file = join(copy, path);
  const before = readFileSync(file, "utf8");
  const after = edit(before);
  assert.notEqual(after, before, `${path} edit changed nothing`);
  writeFileSync(file, after);
  const [oldHash, newHash] = [before, after].map((text) => createHash("sha256").update(text).digest("hex"));
  for (const pinned of ["config/newo/production.expected.json", "workers-bus/wrangler.jsonc"]) {
    const pinnedFile = join(copy, pinned);
    writeFileSync(pinnedFile, readFileSync(pinnedFile, "utf8").replaceAll(oldHash, newHash));
  }
}

async function assertEachFails(t, cases) {
  for (const [name, change, message] of cases) {
    await t.test(name, (subtest) => {
      const result = validateCopy(subtest, change);
      assert.notEqual(result.status, 0, `${name} passed validation`);
      assert.match(result.stderr, message);
    });
  }
}

test("staging Newo contract is internally consistent", () => {
  const result = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok Newo staging config validated: 5 tools, 31 API operations/);
  assert.match(result.stdout, /production blockers/);
});

test("production gate refuses pending provider and owner evidence", () => {
  const result = spawnSync(process.execPath, [script.pathname, "--production"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Newo production gate blocked/);
  assert.match(result.stderr, /release_state/);
  assert.match(result.stderr, /console_proof/);
});

test("the callback-only config with Newo SMS off passes", (t) => {
  const result = validateCopy(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok Newo staging config validated/);
});

test("a live transfer fails wherever it comes back", async (t) => {
  await assertEachFails(t, [
    [
      "transfer block in the expected config",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.transfer = { policy: "owner_then_voicemail", owner_line_env: "NEWO_OWNER_TRANSFER_NUMBER" };
      }),
      /Newo config must not set up a live handoff/,
    ],
    [
      "handoff policy other than callback only",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.handoff.policy = "owner_then_voicemail";
      }),
      /Newo handoff must stay callback only/,
    ],
    [
      "transfer control in the console proof",
      (copy) => editJson(copy, "config/newo/console-proof.json", (proof) => {
        proof.proofs.push({
          control: "owner_transfer_and_voicemail_fallback",
          status: "pending",
          evidence_ref: null,
          observed_at: null,
          expires_at: null,
        });
      }),
      /console proof must not carry a live-handoff control/,
    ],
    [
      "transfer number in the Worker config",
      (copy) => {
        const file = join(copy, "workers-bus/wrangler.jsonc");
        writeFileSync(file, readFileSync(file, "utf8").replace(
          '"NEWO_ENABLED_CHANNELS": "voice",',
          '"NEWO_ENABLED_CHANNELS": "voice",\n      "NEWO_OWNER_TRANSFER_NUMBER": "",',
        ));
      },
      /Worker config must not set up a live handoff/,
    ],
    [
      "transfer instruction in the AKB",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "- Callback only.",
        "- Transfer policy: configured owner line first, then configured voicemail fallback.\n- Callback only.",
      )),
      /AKB may mention a live handoff only to forbid it/,
    ],
    [
      "evaluation case that expects a transfer",
      (copy) => editPinned(copy, "config/newo/evaluation-cases.v1.json", (evaluation) => evaluation.replace(
        /("id": "call-18".*?"expected_outcome": ")[^"]*/,
        "$1Record reason and attempt immediate transfer with voicemail and callback fallback",
      )),
      /call-18 expects a live handoff/,
    ],
  ]);
});

test("a live handoff fails however the config spells it, and so does texting the caller", async (t) => {
  await assertEachFails(t, [
    ...["owner_line", "forward_the_call", "forwarding_number"].map((key) => [
      `${key} key in the expected config`,
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.telephony[key] = "NEWO_OWNER_PHONE";
      }),
      /Newo config must not set up a live handoff/,
    ]),
    [
      "forwarding number in a tool definition",
      (copy) => editPinned(copy, "config/newo/tools.v1.json", (tools) => tools.replace(
        '"outbound_customer_send": false\n  },\n  "check_availability"',
        '"outbound_customer_send": false,\n    "forwarding_number_env": "NEWO_OWNER_PHONE"\n  },\n  "check_availability"',
      )),
      /Newo tools must not set up a live handoff/,
    ],
    [
      "call-forwarding control in the console proof",
      (copy) => editJson(copy, "config/newo/console-proof.json", (proof) => {
        proof.proofs.push({ control: "forward_call_to_owner", status: "pending", evidence_ref: null, observed_at: null, expires_at: null });
      }),
      /console proof must not carry a live-handoff control/,
    ],
    [
      "owner line in the Worker config",
      (copy) => {
        const file = join(copy, "workers-bus/wrangler.jsonc");
        writeFileSync(file, readFileSync(file, "utf8").replace(
          '"NEWO_ENABLED_CHANNELS": "voice",',
          '"NEWO_ENABLED_CHANNELS": "voice",\n      "NEWO_OWNER_LINE": "",',
        ));
      },
      /Worker config must not set up a live handoff/,
    ],
    [
      "AKB forwards the call",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "- Then say staff will call back.",
        "- If the owner is free, forward the call.\n- Then say staff will call back.",
      )),
      /AKB may mention a live handoff only to forbid it/,
    ],
    [
      "AKB texts the caller",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "- Then say staff will call back.",
        "- Text the caller a confirmation.\n- Then say staff will call back.",
      )),
      /AKB must not text the caller/,
    ],
    [
      "evaluation case expects Newo to text the caller",
      (copy) => editPinned(copy, "config/newo/evaluation-cases.v1.json", (evaluation) => evaluation.replace(
        /("id": "call-19".*?"expected_outcome": ")[^"]*/,
        "$1Record consent, then text the caller a confirmation",
      )),
      /call-19 expects Newo to text the caller/,
    ],
    [
      "baseline case without the promised-callback-time catastrophe",
      (copy) => editPinned(copy, "config/newo/evaluation-cases.v1.json", (evaluation) => evaluation.replace(
        /("id": "call-09".*?), "claims_callback_time"/,
        "$1",
      )),
      /call-09 must treat claims_callback_time as catastrophic/,
    ],
    [
      "report schema accepts any handoff status",
      (copy) => editPinned(copy, "config/newo/schemas/session-report.v1.schema.json", (schema) => schema.replace(
        '"handoff_status": { "enum": ["requested", "failed", null] }',
        '"handoff_status": { "type": ["string", "null"], "maxLength": 80 }',
      )),
      /the report schema must accept only handoff status requested, failed, or null/,
    ],
  ]);
});

// The gate applies the migrations and reads sqlite_master; these synthetic migrations probe it.
// Only a real newo_callback_records table with the columns a person needs opens it.
const CALLBACK_RECORD_TABLE_SQL = `CREATE TABLE newo_callback_records (
  callback_id TEXT PRIMARY KEY, tenant_id TEXT, session_id TEXT, reason TEXT, urgency TEXT,
  contact_phone TEXT, recorded_at TEXT
);
`;
const NOT_A_CALLBACK_RECORD_TABLE = [
  ["a bare SELECT 1", "SELECT 1;\n"],
  ["the CREATE TABLE only in a comment", `-- ${CALLBACK_RECORD_TABLE_SQL.replaceAll("\n", " ")}\nSELECT 1;\n`],
  ["the CREATE TABLE only in a string", "SELECT 'CREATE TABLE newo_callback_records (';\n"],
  // A quoted alias: text that reads as the CREATE TABLE, run as a SELECT.
  ["the CREATE TABLE only as a quoted alias", 'SELECT 1 AS "CREATE TABLE newo_callback_records (callback_id TEXT)";\n'],
  ["a CREATE TABLE that a later statement drops", `${CALLBACK_RECORD_TABLE_SQL}DROP TABLE newo_callback_records;\n`],
  ["a different table", CALLBACK_RECORD_TABLE_SQL.replace("newo_callback_records", "newo_callback_records_draft")],
  ["a view under the table's name", "CREATE VIEW newo_callback_records AS SELECT 1 AS callback_id;\n"],
  ["a table without the contact column", CALLBACK_RECORD_TABLE_SQL.replace(" contact_phone TEXT,", "")],
  ["the table in a migration that fails to apply", `${CALLBACK_RECORD_TABLE_SQL}SELECT * FROM no_such_table;\n`],
];

function writeMarker(copy, sql, name = "0999_newo_callback_records.sql") {
  mkdirSync(join(copy, "workers-bus/migrations"), { recursive: true });
  writeFileSync(join(copy, "workers-bus/migrations", name), sql);
}

function copyMigrations(copy) {
  cpSync(join(root, "workers-bus/migrations"), join(copy, "workers-bus/migrations"), { recursive: true });
}

const setWorkerVar = (copy, from, to) => {
  const file = join(copy, "workers-bus/wrangler.jsonc");
  const before = readFileSync(file, "utf8");
  const after = before.replace(from, to);
  assert.notEqual(after, before, `wrangler.jsonc has no ${from}`);
  writeFileSync(file, after);
};
const enable = (copy) => setWorkerVar(copy, '"NEWO_ENABLED": "false"', '"NEWO_ENABLED": "true"');
// The Worker reads String(NEWO_ENABLED) === "true", so a JSON boolean switches it on too: in the
// CFG_NEWO group, and as a flat var, which wins over the group.
const enableBoolean = (copy) => setWorkerVar(copy, '"NEWO_ENABLED": "false"', '"NEWO_ENABLED": true');
const enableFlatBoolean = (copy) => setWorkerVar(copy, '"CFG_NEWO": {', '"NEWO_ENABLED": true,\n    "CFG_NEWO": {');
const refusedWithoutRecord = /build no newo_callback_records table/;

test("NEWO_ENABLED=true is refused while no D1 callback record exists", async (t) => {
  const refused = /NEWO_ENABLED=true \(production\) is refused until the D1 callback record exists/;
  await assertEachFails(t, [
    ["Worker config enables Newo", enable, refused],
    ["Worker config enables Newo with a JSON boolean", enableBoolean, refused],
    ["Worker config enables Newo with a flat JSON boolean", enableFlatBoolean, refused],
    [
      "expected config enables Newo",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.runtime.enabled = true;
      }),
      /NEWO_ENABLED=true \(production.expected.json\) is refused until the D1 callback record exists/,
    ],
    [
      "expected config enables Newo with the string true",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.runtime.enabled = "true";
      }),
      /NEWO_ENABLED=true \(production.expected.json\) is refused until the D1 callback record exists/,
    ],
    // Only the schema the migrations build counts, never the text of a migration.
    ...NOT_A_CALLBACK_RECORD_TABLE.map(([name, sql]) => [
      `a migration with ${name}`,
      (copy) => {
        enable(copy);
        writeMarker(copy, sql);
      },
      refusedWithoutRecord,
    ]),
  ]);
  // A real table with the record's columns opens the gate, whatever the file is called.
  for (const turnOn of [enable, enableFlatBoolean]) {
    const opened = validateCopy(t, (copy) => {
      turnOn(copy);
      writeMarker(copy, CALLBACK_RECORD_TABLE_SQL, "0001_any_name.sql");
    });
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /ok Newo staging config validated/);
  }
});

test("the repository's own migrations build the callback record, so enabling Newo is no longer refused", async (t) => {
  const opened = validateCopy(t, (copy) => {
    enable(copy);
    copyMigrations(copy);
  });
  assert.equal(opened.status, 0, opened.stderr);
  // A later migration that drops the table closes the gate again.
  const dropped = validateCopy(t, (copy) => {
    enable(copy);
    copyMigrations(copy);
    writeMarker(copy, "DROP TABLE newo_callback_records;\n", "0999_drop_newo_callback_records.sql");
  });
  assert.notEqual(dropped.status, 0, "a dropped callback record passed the gate");
  assert.match(dropped.stderr, refusedWithoutRecord);
  // Without 0168 the record does not exist.
  const without = validateCopy(t, (copy) => {
    enable(copy);
    copyMigrations(copy);
    rmSync(join(copy, "workers-bus/migrations/0168_newo_callback_records.sql"));
  });
  assert.notEqual(without.status, 0, "the migrations without 0168 passed the gate");
  assert.match(without.stderr, refusedWithoutRecord);
  // NEWO_ENABLED itself stays false in the shipped config; turning Newo on is a separate change.
  const source = readFileSync(join(root, "workers-bus/wrangler.jsonc"), "utf8");
  assert.equal((source.match(/"NEWO_ENABLED": "false"/g) ?? []).length >= 1, true);
  assert.doesNotMatch(source, /"NEWO_ENABLED": (?:"true"|true)/);
});

test("an evaluation case may not promise a callback incident the Worker never opens", async (t) => {
  const promising = (id, outcome) => (copy) => editPinned(copy, "config/newo/evaluation-cases.v1.json", (evaluation) =>
    evaluation.replace(new RegExp(`("id": "${id}".*?"expected_outcome": ")[^"]*`), `$1${outcome}`));
  await assertEachFails(t, [
    [
      "call-10 promises an urgent callback incident",
      promising("call-10", "Capture callback and address; mark emergency; request the callback so it opens an urgent callback incident"),
      /call-10 promises a callback incident/,
    ],
    [
      "call-09 promises a callback-incident",
      promising("call-09", "Capture the caller and the reason; request the callback and raise a callback-incident for staff"),
      /call-09 promises a callback incident \("callback-incident"\)/,
    ],
    [
      "call-09 promises a callback_incident",
      promising("call-09", "Capture the caller and the reason; request the callback, which records a callback_incident"),
      /call-09 promises a callback incident \("callback_incident"\)/,
    ],
    [
      "call-18 says the callback opens an incident",
      promising("call-18", "Capture the caller and the reason; the callback request opens an incident for the office"),
      /call-18 promises a callback incident \("opens an incident"\)/,
    ],
    [
      "call-18 says the Worker creates a Frappe incident",
      promising("call-18", "Capture the caller and the reason; the Worker creates a Frappe incident for staff to call back"),
      /call-18 promises a callback incident \("creates a Frappe incident"\)/,
    ],
  ]);
  // The failure cases keep their own words for the Worker's failure records.
  const evaluation = readFileSync(join(root, "config/newo/evaluation-cases.v1.json"), "utf8");
  assert.match(evaluation, /409 and incident evidence/);
  assert.match(evaluation, /a retry or incident is visible/);
});

test("callback only fails when failed becomes the routine handoff status", async (t) => {
  await assertEachFails(t, [
    [
      "expected config reports every handoff as failed",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.handoff.handoff_status = "failed";
      }),
      /callback only must not report every handoff as failed/,
    ],
    [
      "AKB requests callbacks with handoff status failed",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "and handoff status `requested`.",
        "and handoff status `failed`.",
      )),
      /AKB must request callbacks with handoff status requested/,
    ],
    [
      "AKB reports failed for anything but a failed tool call",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "- Then say staff will call back.",
        "- If the caller hangs up, report handoff status `failed`.\n- Then say staff will call back.",
      )),
      /AKB may report handoff status failed only when the handoff tool call itself failed/,
    ],
  ]);
});

test("Newo in-call SMS fails when it is turned on", async (t) => {
  await assertEachFails(t, [
    [
      "in-call SMS tool enabled",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.sms.newo_in_call_sms_enabled = true;
      }),
      /Newo in-call SMS tool must stay disabled/,
    ],
    [
      "SMS confirmations moved to Newo",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.sms.confirmation_sender = "newo";
      }),
      /SMS confirmations come from IronWrap, not Newo/,
    ],
    [
      "console proof for the disabled SMS tool removed",
      (copy) => editJson(copy, "config/newo/console-proof.json", (proof) => {
        proof.proofs = proof.proofs.filter((entry) => entry.control !== "newo_in_call_sms_disabled");
      }),
      /console proof must keep newo_in_call_sms_disabled/,
    ],
    [
      "AKB no longer keeps Newo SMS off",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "Newo never sends SMS, and its in-call SMS tool stays disabled. ",
        "",
      )),
      /AKB must keep Newo SMS off/,
    ],
  ]);
});
