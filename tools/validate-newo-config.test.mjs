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
      /Newo config must not set up a live transfer/,
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
      /console proof must not carry a live-transfer control/,
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
      /Worker config must not set up a live transfer/,
    ],
    [
      "transfer instruction in the AKB",
      (copy) => editPinned(copy, "config/newo/akb/ironwrap-receptionist.v1.md", (akb) => akb.replace(
        "- Callback only.",
        "- Transfer policy: configured owner line first, then configured voicemail fallback.\n- Callback only.",
      )),
      /AKB may mention transfer only to forbid it/,
    ],
    [
      "evaluation case that expects a transfer",
      (copy) => editPinned(copy, "config/newo/evaluation-cases.v1.json", (evaluation) => evaluation.replace(
        /("id": "call-18".*?"expected_outcome": ")[^"]*/,
        "$1Record reason and attempt immediate transfer with voicemail and callback fallback",
      )),
      /call-18 expects a live transfer/,
    ],
  ]);
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
