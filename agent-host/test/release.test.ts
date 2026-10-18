import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { releaseSha256, specialistRelease } from "../src/host/release.ts";
import { tempDir } from "./helpers.ts";

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

test("the release hash is the SHA-256 of the canonical JSON of its five fields", () => {
  const release = { specialist_id: "lead_concierge", playbook_sha256: "1".repeat(64), allowlist_sha256: "2".repeat(64), common_sha256: "3".repeat(64), catalog_sha256: "4".repeat(64) };
  const expected = hex(
    `{"allowlist_sha256":"${"2".repeat(64)}","catalog_sha256":"${"4".repeat(64)}","common_sha256":"${"3".repeat(64)}","playbook_sha256":"${"1".repeat(64)}","specialist_id":"lead_concierge"}`,
  );
  assert.equal(releaseSha256(release), expected);
  // Key order and extra fields never change it; a malformed field is refused.
  const reordered = Object.fromEntries(Object.entries({ ...release, extra: "x" }).reverse()) as typeof release;
  assert.equal(releaseSha256(reordered), expected);
  assert.throws(() => releaseSha256({ ...release, common_sha256: "A".repeat(64) }), /common_sha256/);
  assert.throws(() => releaseSha256({ ...release, specialist_id: "" }), /specialist id/);
});

test("a specialist's release hashes its playbook, allowlist and COMMON.md bytes as they are", (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, "lead_concierge"));
  writeFileSync(join(root, "COMMON.md"), "# Common\n");
  writeFileSync(join(root, "lead_concierge", "playbook.md"), "# Synthetic playbook\n");
  writeFileSync(join(root, "lead_concierge", "allowlist.json"), '{"actions": []}\n');
  const release = specialistRelease(root, "lead_concierge", "5".repeat(64));
  assert.deepEqual(
    [release.common_sha256, release.playbook_sha256, release.allowlist_sha256],
    [hex("# Common\n"), hex("# Synthetic playbook\n"), hex('{"actions": []}\n')],
  );
  assert.equal(release.release_sha256, releaseSha256(release));
  writeFileSync(join(root, "lead_concierge", "playbook.md"), "# Synthetic playbook, edited\n");
  assert.notEqual(specialistRelease(root, "lead_concierge", "5".repeat(64)).release_sha256, release.release_sha256);
  // Exact bytes: a BOM, CRLF and invalid UTF-8 all count, unlike a text read.
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff]);
  writeFileSync(join(root, "COMMON.md"), bytes);
  assert.equal(specialistRelease(root, "lead_concierge", "5".repeat(64)).common_sha256, createHash("sha256").update(bytes).digest("hex"));
  // A path outside the specialists root is never read.
  assert.throws(() => specialistRelease(root, "../outside", "5".repeat(64)), /specialist id/);
});
