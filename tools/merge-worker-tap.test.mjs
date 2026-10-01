import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MergeWorkerTapError, mergeWorkerTap } from "./merge-worker-tap.mjs";

function shardTap({ tests, pass, fail, skipped = 0, todo = 0, name }) {
  return `TAP version 13\n# Subtest: ${name}\nok 1 - ${name}\n1..1\n# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n# todo ${todo}\n`;
}

async function withShardFiles(t, shards, { total = shards.length, names } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-worker-tap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = [];
  for (const [index, shard] of shards.entries()) {
    const shardNumber = names ? names[index] : index + 1;
    const shardPath = path.join(dir, `worker-tests-${shardNumber}-${total}.tap`);
    await writeFile(shardPath, shardTap(shard));
    paths.push(shardPath);
  }
  return paths;
}

test("shards with complete passing totals sum correctly", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 428, pass: 428, fail: 0, name: "shard-1" },
    { tests: 396, pass: 396, fail: 0, name: "shard-2" },
    { tests: 402, pass: 402, fail: 0, name: "shard-3" },
    { tests: 444, pass: 444, fail: 0, name: "shard-4" },
  ]);
  const merged = mergeWorkerTap(paths, { shards: 4, minTests: 1670 });
  assert.match(merged, /^# tests 1670$/m);
  assert.match(merged, /^# pass 1670$/m);
  assert.match(merged, /^# fail 0$/m);
  assert.match(merged, /^# skipped 0$/m);
  assert.match(merged, /^# todo 0$/m);
  // Exactly one summary block: the merge, not a per-shard leftover.
  assert.equal([...merged.matchAll(/^# tests \d+$/gm)].length, 1);
});

test("a shard reporting a failure is rejected", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 10, pass: 10, fail: 0, name: "shard-1" },
    { tests: 10, pass: 9, fail: 1, name: "shard-2" },
  ]);
  assert.throws(() => mergeWorkerTap(paths, { shards: 2, minTests: 1 }), MergeWorkerTapError);
});

test("a missing shard file is rejected", async (t) => {
  const paths = await withShardFiles(t, [{ tests: 10, pass: 10, fail: 0, name: "shard-1" }], {
    total: 2,
  });
  assert.throws(
    () =>
      mergeWorkerTap([...paths, "/nonexistent/worker-tests-2-2.tap"], { shards: 2, minTests: 1 }),
    MergeWorkerTapError,
  );
});

test("no shard files given is rejected", () => {
  assert.throws(() => mergeWorkerTap([], { shards: 4, minTests: 1 }), MergeWorkerTapError);
});

test("fewer files than --shards is rejected, even if every file present is well formed", async (t) => {
  // gate treats a skipped job as a passing one, so a shard that never ran and
  // never uploaded must be a hard failure here, not a silently short total.
  const paths = await withShardFiles(
    t,
    [
      { tests: 10, pass: 10, fail: 0, name: "shard-1" },
      { tests: 10, pass: 10, fail: 0, name: "shard-2" },
      { tests: 10, pass: 10, fail: 0, name: "shard-3" },
    ],
    { total: 4 },
  );
  assert.throws(() => mergeWorkerTap(paths, { shards: 4, minTests: 1 }), MergeWorkerTapError);
});

test("a repeated shard number is rejected", async (t) => {
  const paths = await withShardFiles(
    t,
    [
      { tests: 10, pass: 10, fail: 0, name: "shard-1" },
      { tests: 10, pass: 10, fail: 0, name: "shard-2" },
      { tests: 10, pass: 10, fail: 0, name: "shard-3" },
      { tests: 10, pass: 10, fail: 0, name: "shard-3-again" },
    ],
    { total: 4, names: [1, 2, 3, 3] },
  );
  assert.throws(() => mergeWorkerTap(paths, { shards: 4, minTests: 1 }), MergeWorkerTapError);
});

test("a shard number outside 1..N is rejected", async (t) => {
  const paths = await withShardFiles(
    t,
    [
      { tests: 10, pass: 10, fail: 0, name: "shard-1" },
      { tests: 10, pass: 10, fail: 0, name: "shard-2" },
      { tests: 10, pass: 10, fail: 0, name: "shard-3" },
      { tests: 10, pass: 10, fail: 0, name: "shard-5" },
    ],
    { total: 4, names: [1, 2, 3, 5] },
  );
  assert.throws(() => mergeWorkerTap(paths, { shards: 4, minTests: 1 }), MergeWorkerTapError);
});

test("exactly N of N well-formed shards are accepted", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 428, pass: 428, fail: 0, name: "shard-1" },
    { tests: 396, pass: 396, fail: 0, name: "shard-2" },
    { tests: 402, pass: 402, fail: 0, name: "shard-3" },
    { tests: 444, pass: 444, fail: 0, name: "shard-4" },
  ]);
  const merged = mergeWorkerTap(paths, { shards: 4, minTests: 1670 });
  assert.match(merged, /^# tests 1670$/m);
});

test("a plain concatenation of the shard TAPs does not carry an accepted total", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 428, pass: 428, fail: 0, name: "shard-1" },
    { tests: 396, pass: 396, fail: 0, name: "shard-2" },
  ]);
  const concatenated = (await Promise.all(paths.map((shardPath) => readFile(shardPath, "utf8")))).join(
    "",
  );
  // The same first-match rule `workerTestCount` (tools/validate-documentation.mjs)
  // applies to a naive `cat`: it silently binds to shard 1's count, not the total.
  const firstMatch = concatenated.match(/^# tests (\d+)$/m)?.[1];
  assert.equal(firstMatch, "428");
  assert.notEqual(firstMatch, "824");

  const merged = mergeWorkerTap(paths, { shards: 2, minTests: 824 });
  assert.equal(merged.match(/^# tests (\d+)$/m)?.[1], "824");
});

// IRO-267 revision 2: the shard TAP names no test file, so exact file-set
// equality isn't checked here - a --min-tests floor is. Below the floor
// rejected, exactly at it accepted, and the flag itself is required.
test("a summed total below --min-tests is rejected", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 5, pass: 5, fail: 0, name: "shard-1" },
    { tests: 5, pass: 5, fail: 0, name: "shard-2" },
  ]);
  assert.throws(() => mergeWorkerTap(paths, { shards: 2, minTests: 11 }), MergeWorkerTapError);
});

test("a summed total exactly at --min-tests is accepted", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 5, pass: 5, fail: 0, name: "shard-1" },
    { tests: 5, pass: 5, fail: 0, name: "shard-2" },
  ]);
  const merged = mergeWorkerTap(paths, { shards: 2, minTests: 10 });
  assert.match(merged, /^# tests 10$/m);
});

test("a missing --min-tests is rejected", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 5, pass: 5, fail: 0, name: "shard-1" },
    { tests: 5, pass: 5, fail: 0, name: "shard-2" },
  ]);
  assert.throws(() => mergeWorkerTap(paths, { shards: 2 }), MergeWorkerTapError);
});

test("against the four real shard TAPs, --min-tests one over the true total is rejected and the true total is accepted", async (t) => {
  const paths = await withShardFiles(t, [
    { tests: 396, pass: 396, fail: 0, name: "shard-1" },
    { tests: 428, pass: 428, fail: 0, name: "shard-2" },
    { tests: 444, pass: 444, fail: 0, name: "shard-3" },
    { tests: 402, pass: 402, fail: 0, name: "shard-4" },
  ]);
  assert.throws(() => mergeWorkerTap(paths, { shards: 4, minTests: 1671 }), MergeWorkerTapError);
  const merged = mergeWorkerTap(paths, { shards: 4, minTests: 1670 });
  assert.match(merged, /^# tests 1670$/m);
});
