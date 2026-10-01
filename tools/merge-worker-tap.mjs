#!/usr/bin/env node
// Merges N Worker-suite shard TAP files (`make worker-shard SHARD=k/N`) into one
// TAP whose single summary block is what `tools/validate-documentation.mjs`'s
// `workerTestCount` reads. That function takes the *first* `^# tests (\d+)$`
// match in the file: a plain `cat` of the shard TAPs would silently bind the
// capability evidence receipt to one shard's count alone (IRO-267), not the
// total. This tool strips every shard's own summary footer and appends exactly
// one merged summary, so the first (and only) match is the true total.
//
// `--shards N` is required and enforced: exactly N files, numbered 1..N with no
// repeat, each filename's own N matching. `gate` treats a skipped job as a
// passing one, so a shard that never ran and never uploaded is otherwise
// invisible to this tool (IRO-267 blocker 12).
//
// `--min-tests N` is also required and enforced: the summed `# tests` across
// all shards must be at least N. A shard TAP names no test file (only 4 of 406
// top-level points on a real shard artifact are `# Subtest: test/<file>` lines,
// and those are fixtures that declare no named test), so exact file-set
// equality would need a second `--test-reporter` pair writing the file list
// beside the TAP - a larger change than this floor. The floor still closes the
// gap it exists for: four well-formed TAPs that between them ran far fewer than
// 151 files cannot reach the pre-split total (IRO-267 revision 2).
import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const SUMMARY_FIELDS = ["tests", "pass", "fail", "skipped", "todo"];
const SUMMARY_LINE = /^# (tests|pass|fail|skipped|todo|suites|cancelled) \d+$/;
// worker-tests-<shard>-<of N>.tap, written by `make worker-shard SHARD=k/N`.
const SHARD_FILENAME = /^worker-tests-(\d+)-(\d+)\.tap$/;

export class MergeWorkerTapError extends Error {}

function summaryField(content, field, shardLabel) {
  const match = content.match(new RegExp(`^# ${field} (\\d+)$`, "m"));
  if (!match) {
    throw new MergeWorkerTapError(`${shardLabel}: missing "# ${field} N" summary line`);
  }
  return Number.parseInt(match[1], 10);
}

// `gate`'s check treats a skipped job as a passing one, so a matrix leg that
// never runs (a stray `if:`, a path filter, a job that times out and is
// cancelled before it uploads) is otherwise invisible here: --shards N and this
// check are what make "fewer than N shard TAPs" a hard failure rather than a
// silently short, still-accepted receipt (IRO-267 blocker 12).
function requireExactShards(shardPaths, shards) {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new MergeWorkerTapError("--shards N is required");
  }
  if (shardPaths.length !== shards) {
    throw new MergeWorkerTapError(`expected ${shards} shard TAP files, got ${shardPaths.length}`);
  }
  const seen = new Set();
  for (const shardPath of shardPaths) {
    const match = SHARD_FILENAME.exec(basename(shardPath));
    if (!match) {
      throw new MergeWorkerTapError(
        `${shardPath}: filename does not match worker-tests-<k>-<N>.tap`,
      );
    }
    const shardNumber = Number.parseInt(match[1], 10);
    const shardTotal = Number.parseInt(match[2], 10);
    if (shardTotal !== shards) {
      throw new MergeWorkerTapError(
        `${shardPath}: filename's own N (${shardTotal}) does not match --shards ${shards}`,
      );
    }
    if (shardNumber < 1 || shardNumber > shards) {
      throw new MergeWorkerTapError(`${shardPath}: shard number ${shardNumber} out of range 1..${shards}`);
    }
    if (seen.has(shardNumber)) {
      throw new MergeWorkerTapError(`${shardPath}: shard number ${shardNumber} repeated`);
    }
    seen.add(shardNumber);
  }
}

function requireMinTests(minTests) {
  if (!Number.isInteger(minTests) || minTests < 1) {
    throw new MergeWorkerTapError("--min-tests N is required");
  }
}

export function mergeWorkerTap(shardPaths, { shards, minTests } = {}) {
  if (!Array.isArray(shardPaths) || shardPaths.length === 0) {
    throw new MergeWorkerTapError("no shard TAP files given");
  }
  requireExactShards(shardPaths, shards);
  requireMinTests(minTests);
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
  const bodies = [];
  for (const shardPath of shardPaths) {
    let content;
    try {
      content = readFileSync(shardPath, "utf8");
    } catch {
      throw new MergeWorkerTapError(`${shardPath}: shard TAP file not found`);
    }
    const failCount = summaryField(content, "fail", shardPath);
    if (failCount !== 0) {
      throw new MergeWorkerTapError(`${shardPath}: shard reports "# fail ${failCount}", not 0`);
    }
    for (const field of SUMMARY_FIELDS) {
      totals[field] += summaryField(content, field, shardPath);
    }
    const body = content
      .split("\n")
      .filter((line) => !SUMMARY_LINE.test(line))
      .join("\n")
      .replace(/\n+$/, "");
    bodies.push(`# shard: ${shardPath}\n${body}`);
  }
  if (totals.tests < minTests) {
    throw new MergeWorkerTapError(
      `summed "# tests ${totals.tests}" is below the --min-tests ${minTests} floor - ` +
        "either a shard ran fewer files than it should, or tests were removed " +
        "deliberately and WORKER_TEST_FLOOR in .github/workflows/ci.yml has to " +
        "come down with them",
    );
  }
  const lines = [
    "TAP version 13",
    ...bodies,
    `# tests ${totals.tests}`,
    `# pass ${totals.pass}`,
    `# fail ${totals.fail}`,
    `# skipped ${totals.skipped}`,
    `# todo ${totals.todo}`,
  ];
  return lines.join("\n") + "\n";
}

function main(argv) {
  const shardPaths = [];
  let output = null;
  let shards = null;
  let minTests = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      output = argv[(index += 1)];
    } else if (argv[index] === "--shards") {
      shards = Number.parseInt(argv[(index += 1)], 10);
    } else if (argv[index] === "--min-tests") {
      minTests = Number.parseInt(argv[(index += 1)], 10);
    } else {
      shardPaths.push(argv[index]);
    }
  }
  if (!output) throw new MergeWorkerTapError("--output <path> is required");
  writeFileSync(output, mergeWorkerTap(shardPaths, { shards, minTests }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`merge-worker-tap: ${error.message}\n`);
    process.exit(1);
  }
}
