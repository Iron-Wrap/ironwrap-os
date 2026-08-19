import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateSiteConfigPins } from "./validate-site-config-pins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLAYBOOK = [
  "ironwrap_field_evidence_issuer_user",
  "ironwrap_fleet_capture_issuer_user",
  "ironwrap_deferred_reader_user",
].join("\n");

const EXEMPTIONS = new Map([
  [
    "ironwrap_deferred_reader_user",
    "release-time reader identity supplied by the operator, never part of the local compose rail",
  ],
]);

test("the checked-in provisioners pin every site-config identity key the app reads", () => {
  const script = new URL("./validate-site-config-pins.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok \d+ site-config identity keys validated/);
});

test("a key the app reads but no provisioner pins is rejected", () => {
  // The IRO-54 defect exactly: fleet_operations_api.py read the key, nothing wrote it.
  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_field_evidence_issuer_user", "ironwrap_fleet_capture_issuer_user"],
        pinnedKeys: ["ironwrap_field_evidence_issuer_user"],
        playbookText: PLAYBOOK,
        exemptions: new Map(),
      }),
    /ironwrap_fleet_capture_issuer_user .* no provisioner pins it/,
  );
});

test("a pinned key that the playbook never documents is rejected", () => {
  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_undocumented_issuer_user"],
        pinnedKeys: ["ironwrap_undocumented_issuer_user"],
        playbookText: PLAYBOOK,
        exemptions: new Map(),
      }),
    /WHITE-LABEL-CLONE-PLAYBOOK\.md never mentions it/,
  );
});

test("an exemption stands in for a local pin but still has to be documented", () => {
  const { consumed, pinned } = validateSiteConfigPins({
    consumedKeys: ["ironwrap_field_evidence_issuer_user", "ironwrap_deferred_reader_user"],
    pinnedKeys: ["ironwrap_field_evidence_issuer_user"],
    playbookText: PLAYBOOK,
    exemptions: EXEMPTIONS,
  });
  assert.deepEqual(consumed, [
    "ironwrap_deferred_reader_user",
    "ironwrap_field_evidence_issuer_user",
  ]);
  assert.deepEqual(pinned, ["ironwrap_field_evidence_issuer_user"]);

  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_deferred_reader_user"],
        pinnedKeys: [],
        playbookText: "nothing documented here",
        exemptions: EXEMPTIONS,
      }),
    /WHITE-LABEL-CLONE-PLAYBOOK\.md never mentions it/,
  );
});

test("an exemption may not hide behind a reason that says nothing", () => {
  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_deferred_reader_user"],
        pinnedKeys: [],
        playbookText: PLAYBOOK,
        exemptions: new Map([["ironwrap_deferred_reader_user", "later"]]),
      }),
    /must state which identity provisions it instead/,
  );
});

test("a stale exemption for a key nothing reads any more is rejected", () => {
  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_field_evidence_issuer_user"],
        pinnedKeys: ["ironwrap_field_evidence_issuer_user"],
        playbookText: PLAYBOOK,
        exemptions: EXEMPTIONS,
      }),
    /stale exemption: ironwrap_deferred_reader_user/,
  );
});

test("a provisioner pin for a key nothing reads any more is rejected", () => {
  assert.throws(
    () =>
      validateSiteConfigPins({
        consumedKeys: ["ironwrap_field_evidence_issuer_user"],
        pinnedKeys: ["ironwrap_field_evidence_issuer_user", "ironwrap_retired_issuer_user"],
        playbookText: PLAYBOOK,
        exemptions: new Map(),
      }),
    /provisioners pin ironwrap_retired_issuer_user but no shipped code reads it/,
  );
});
