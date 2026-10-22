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

test("NEWO_ENABLED=true is refused until the D1 callback record exists", async (t) => {
  const enable = (copy) => {
    const file = join(copy, "workers-bus/wrangler.jsonc");
    writeFileSync(file, readFileSync(file, "utf8").replace('"NEWO_ENABLED": "false"', '"NEWO_ENABLED": "true"'));
  };
  await assertEachFails(t, [
    ["Worker config enables Newo", enable, /NEWO_ENABLED=true \(production\) is refused until the D1 callback record exists/],
    [
      "expected config enables Newo",
      (copy) => editJson(copy, "config/newo/production.expected.json", (expected) => {
        expected.runtime.enabled = true;
      }),
      /NEWO_ENABLED=true \(production.expected.json\) is refused until the D1 callback record exists/,
    ],
  ]);
  // The slice that builds the record adds the marker migration, and the gate opens.
  const opened = validateCopy(t, (copy) => {
    enable(copy);
    mkdirSync(join(copy, "workers-bus/migrations"), { recursive: true });
    writeFileSync(join(copy, "workers-bus/migrations/0999_newo_callback_records.sql"), "SELECT 1;\n");
  });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /ok Newo staging config validated/);
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
