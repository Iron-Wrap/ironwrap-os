import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Pins the shape of .github/workflows/ci.yml (IRO-267): nothing pinned it before
// this split, unlike tools/deploy-workflow.test.mjs for deploy.yml.
const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const deployWorkflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const makefileUrl = new URL("../Makefile", import.meta.url);
const repoRoot = new URL("../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot).replace(/\/$/, "");

function section(workflow, heading) {
  const start = workflow.indexOf(`  ${heading}:`);
  assert.ok(start >= 0, `missing job ${heading}`);
  const next = workflow.slice(start + 3).search(/\n  [A-Za-z0-9_-]+:/);
  return workflow.slice(start, next < 0 ? workflow.length : start + 3 + next);
}

function jobNames(workflow) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.ok(jobsStart >= 0, "missing jobs: block");
  const jobsBlock = workflow.slice(jobsStart);
  return [...jobsBlock.matchAll(/^  ([a-z0-9_-]+):\n/gm)].map((match) => match[1]);
}

// Every `run:` command in a job section, single-line and block-scalar (`run: |`)
// alike, in source order.
function runCommands(jobText) {
  const lines = jobText.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run: (.*)$/);
    if (!match) continue;
    const [, indent, rest] = match;
    if (rest === "|") {
      const bodyIndent = indent.length + 2;
      const body = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const bodyLine = lines[cursor];
        if (bodyLine.trim() === "") {
          body.push("");
          cursor += 1;
          continue;
        }
        if (bodyLine.match(/^(\s*)/)[1].length < bodyIndent) break;
        body.push(bodyLine.slice(bodyIndent));
        cursor += 1;
      }
      commands.push(body.join("\n").trim());
      index = cursor - 1;
    } else {
      commands.push(rest.trim());
    }
  }
  return commands;
}

test("the workflow name stays CI, so deploy.yml's workflow_run trigger still fires", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /^name: CI$/m);
});

test("gate aggregates every job except itself and validate-and-test, and both run unconditionally", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const names = jobNames(workflow);
  assert.ok(names.includes("gate"));
  assert.ok(names.includes("validate-and-test"));
  const expectedGateNeeds = names.filter(
    (name) => name !== "gate" && name !== "validate-and-test",
  );
  assert.ok(expectedGateNeeds.length >= 8, "expected at least 8 jobs for gate to aggregate");

  const gate = section(workflow, "gate");
  const gateNeedsMatch = gate.match(/needs:\s*\n?\s*\[([\s\S]*?)\]/);
  assert.ok(gateNeedsMatch, "gate.needs not found");
  const gateNeeds = gateNeedsMatch[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual([...gateNeeds].sort(), [...expectedGateNeeds].sort());
  assert.match(gate, /if: always\(\)/);

  const validateAndTest = section(workflow, "validate-and-test");
  assert.match(validateAndTest, /needs: \[gate\]/);
  assert.match(validateAndTest, /if: always\(\)/);
});

// IRO-267 revision 2, step 22: gate's predicate now special-cases
// dependency-scan by name, so this is what keeps that special case from
// silently growing - a job-level `if:` added to any other job would let it
// skip and still pass gate, undetected by the predicate alone.
test("only dependency-scan, gate and validate-and-test carry a job-level if:", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobLevelIfJobs = [];
  for (const job of jobNames(workflow)) {
    const jobText = section(workflow, job);
    // Job-level `if:` is indented 4 spaces; step-level `if:` sits under `steps:`
    // at 8+ spaces, so this line anchor is what tells them apart.
    if (/^    if:/m.test(jobText)) jobLevelIfJobs.push(job);
  }
  assert.deepEqual([...jobLevelIfJobs].sort(), ["dependency-scan", "gate", "validate-and-test"]);
});

// gate's own shell, read verbatim out of ci.yml and actually run against four
// synthetic `needs` payloads (IRO-267 revision 2, step 22). Deliberately not
// wrapped in a try/catch that would let a missing `jq` on this box skip the
// test instead of failing it: gate itself needs jq on the runner, so this
// must fail closed the same way.
test("gate's shell passes only when every job succeeded, dependency-scan excepted", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const gate = section(workflow, "gate");
  const [script] = runCommands(gate);
  assert.match(script, /jq -e/, "gate's run: step not found");

  const runGate = (needs) => {
    try {
      execFileSync("bash", ["-c", script], {
        env: { ...process.env, NEEDS: JSON.stringify(needs) },
        stdio: "pipe",
      });
      return 0;
    } catch (error) {
      return typeof error.status === "number" ? error.status : error;
    }
  };

  const allSuccess = {
    contracts: { result: "success" },
    pwa: { result: "success" },
    worker: { result: "success" },
    "worker-contract": { result: "success" },
    e2e: { result: "success" },
    evidence: { result: "success" },
    "secret-scan": { result: "success" },
    "paired-device-lighthouse": { result: "success" },
    "dependency-scan": { result: "success" },
  };
  assert.equal(runGate(allSuccess), 0, "all success must pass");

  const workerSkipped = { ...allSuccess, worker: { result: "skipped" } };
  assert.equal(runGate(workerSkipped), 1, "a skipped non-exempt job must fail gate");

  const dependencyScanSkipped = { ...allSuccess, "dependency-scan": { result: "skipped" } };
  assert.equal(runGate(dependencyScanSkipped), 0, "a skipped dependency-scan must still pass gate");

  const oneFailure = { ...allSuccess, contracts: { result: "failure" } };
  assert.equal(runGate(oneFailure), 1, "a real failure must fail gate");
});

test("no matrix job name is requested by deploy.yml, which requires exactly one job per name", async () => {
  const deployWorkflow = await readFile(deployWorkflowUrl, "utf8");
  const jobNamesMatch = deployWorkflow.match(/--job-names "([^"]*)"/);
  assert.ok(jobNamesMatch, "deploy.yml: --job-names not found");
  const requested = jobNamesMatch[1].split(",");
  assert.deepEqual(requested, ["paired-device-lighthouse", "gate", "validate-and-test"]);
  for (const matrixJob of ["worker", "e2e", "contracts", "pwa", "make check"]) {
    assert.ok(!requested.includes(matrixJob), `${matrixJob} must not be requested by name`);
  }
});

test("the worker matrix shard count matches WORKER_SHARDS", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const shardEnvMatch = workflow.match(/WORKER_SHARDS: (\d+)/);
  assert.ok(shardEnvMatch, "WORKER_SHARDS env not found");
  const shardCount = Number(shardEnvMatch[1]);
  const worker = section(workflow, "worker");
  const matrixMatch = worker.match(/shard: \[([^\]]+)\]/);
  assert.ok(matrixMatch, "worker job: shard matrix not found");
  const shards = matrixMatch[1].split(",").map((value) => Number(value.trim()));
  assert.deepEqual(
    shards,
    Array.from({ length: shardCount }, (_, index) => index + 1),
  );
  assert.match(worker, /make worker-shard SHARD=\$\{\{ matrix\.shard \}\}\/\$\{\{ env\.WORKER_SHARDS \}\}/);
});

test("the e2e matrix runs exactly the Makefile's E2E_SUITES, one suite per leg, through make", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const makefile = await readFile(makefileUrl, "utf8");
  const suitesMatch = makefile.match(/E2E_SUITES := ([\s\S]*?)\n\n/);
  assert.ok(suitesMatch, "Makefile: E2E_SUITES not found");
  const suites = suitesMatch[1]
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(suites.length, 12);

  const e2e = section(workflow, "e2e");
  const matrixSection = e2e.slice(e2e.indexOf("suite:"), e2e.indexOf("runs-on:"));
  const matrixSuites = [...matrixSection.matchAll(/- (\S+)/g)].map((match) => match[1]);
  assert.deepEqual([...matrixSuites].sort(), [...suites].sort());
  // One step, through make, so the build/suite split can never drift out of sync
  // with e2e-suite's own recipe (IRO-267 revision 1, step 14).
  assert.match(e2e, /make e2e-suite SUITE=\$\{\{ matrix\.suite \}\}/);
});

test("the worker-contract job restores the typecheck and deploy dry-run checks CI used to drop", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const workerContract = section(workflow, "worker-contract");
  assert.match(workerContract, /make worker-contract/);
});

test("evidence needs both pwa and worker, and merges the shard TAPs before the receipt", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const evidence = section(workflow, "evidence");
  assert.match(evidence, /needs: \[pwa, worker\]/);
  assert.match(evidence, /merge-worker-tap\.mjs --shards \$\{\{ env\.WORKER_SHARDS \}\}/);
  // IRO-267 revision 2: the shard TAP names no test file, so the merge step
  // must also carry the summed-test floor - otherwise four well-formed but
  // short shard TAPs still produce an accepted capability evidence receipt.
  assert.match(evidence, /merge-worker-tap\.mjs --shards \$\{\{ env\.WORKER_SHARDS \}\} --min-tests \$\{\{ env\.WORKER_TEST_FLOOR \}\}/);
  assert.match(evidence, /make evidence-receipt/);
});

test("every job gate depends on exists in the workflow", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  for (const job of [
    "contracts",
    "pwa",
    "worker",
    "worker-contract",
    "e2e",
    "evidence",
    "secret-scan",
    "paired-device-lighthouse",
    "dependency-scan",
  ]) {
    assert.ok(jobNames(workflow).includes(job), `missing job ${job}`);
  }
});

// Jobs whose run: steps are not make invocations by design: a timing budget
// with its own conditional steps, a scanner with no Makefile target, and the
// two aggregator jobs' pass/fail shells.
const NON_MAKE_JOBS = new Set(["paired-device-lighthouse", "dependency-scan", "gate", "validate-and-test"]);

test("every run: step in ci.yml is a make invocation, or on an explicit allowlist", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  for (const job of jobNames(workflow)) {
    if (NON_MAKE_JOBS.has(job)) continue;
    for (const command of runCommands(section(workflow, job))) {
      const isMake = /^make [a-z0-9-]/.test(command);
      // The evidence job's own merge step: it feeds worker-shard artifacts into
      // one TAP before `make evidence-receipt` can read it, so it cannot itself
      // be a make target without also owning the download steps.
      const isMergeWorkerTap = command.startsWith("node tools/merge-worker-tap.mjs");
      assert.ok(
        isMake || isMergeWorkerTap,
        `${job}: run step "${command}" is neither a make invocation nor on the allowlist`,
      );
    }
  }
});

const EXPECTED_MAKE_INVOCATIONS = [
  "make check-contracts",
  "make check-pwa",
  "make worker-shard SHARD=${{ matrix.shard }}/${{ env.WORKER_SHARDS }}",
  "make worker-contract",
  "make e2e-suite SUITE=${{ matrix.suite }}",
  "make evidence-receipt",
  "make secret-scan",
];

function deriveMakeInvocations(workflow) {
  const invocations = [];
  for (const job of jobNames(workflow)) {
    for (const command of runCommands(section(workflow, job))) {
      if (/^make /.test(command)) invocations.push(command);
    }
  }
  return invocations;
}

test("ci.yml's make invocations are exactly this expected list - a regex miss must not silently shrink it", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const invocations = [...new Set(deriveMakeInvocations(workflow))];
  assert.deepEqual(invocations.sort(), [...EXPECTED_MAKE_INVOCATIONS].sort());
});

// The "no check removed" proof, rebuilt for IRO-267 revision 1 (review
// 5362264330): the earlier version compared `check-worker`, a target no CI job
// runs. This derives every `make <target>` CI actually invokes from ci.yml
// itself - expanding the worker and e2e matrices to their real legs - and
// diffs the union of `make -n` over those against `make -n check e2e
// secret-scan`. One direction is the whole point: CI running *more* than
// `check` is harmless, CI running *less* is the bug, so only the local-only
// side is asserted exactly.
test("CI's make invocations, expanded across the worker and e2e matrices, reach exactly what `make check e2e secret-scan` reaches", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const makefile = await readFile(makefileUrl, "utf8");

  const shardCountMatch = workflow.match(/WORKER_SHARDS: (\d+)/);
  assert.ok(shardCountMatch, "WORKER_SHARDS env not found");
  const shardCount = Number(shardCountMatch[1]);

  const suitesMatch = makefile.match(/E2E_SUITES := ([\s\S]*?)\n\n/);
  assert.ok(suitesMatch, "Makefile: E2E_SUITES not found");
  const suites = suitesMatch[1]
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const expanded = [];
  for (const invocation of deriveMakeInvocations(workflow)) {
    if (invocation.includes("${{ matrix.shard }}")) {
      for (let shard = 1; shard <= shardCount; shard += 1) {
        expanded.push(
          invocation
            .replace("${{ matrix.shard }}", String(shard))
            .replace("${{ env.WORKER_SHARDS }}", String(shardCount)),
        );
      }
    } else if (invocation.includes("${{ matrix.suite }}")) {
      for (const suite of suites) {
        expanded.push(invocation.replace("${{ matrix.suite }}", suite));
      }
    } else {
      expanded.push(invocation);
    }
  }

  const run = (words) =>
    execFileSync("make", ["-n", ...words], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(repoRootPath).join("<repo>"))
      .filter(Boolean);

  const ciLines = new Set();
  const linesByInvocation = new Map();
  for (const invocation of expanded) {
    // "make <target> [VAR=value]" -> ["<target>", "VAR=value"].
    const lines = run(invocation.split(" ").slice(1));
    linesByInvocation.set(invocation, lines);
    for (const line of lines) ciLines.add(line);
  }
  const localLines = new Set(run(["check", "e2e", "secret-scan"]));

  // Tombstone for review 5362264330: the typecheck the earlier proof missed
  // is reached by the worker-contract invocation.
  assert.ok(ciLines.has("npm run typecheck --prefix workers-bus"));

  // Tombstone for review 5365838373: worker-contract now builds the real
  // bundle before the dry-run and greps its log for a nonzero read count, so
  // the dry-run's own recipe line now ends `| tee ... worker-dry-run.log` and
  // an exact-match assertion on it would be false even though the check
  // still runs. Assert on worker-contract's own lines, not the ciLines union
  // - `pwa` also runs `npm run build --prefix app`, so a union-only
  // assertion on that line would pass even if worker-contract dropped it.
  const workerContractLines = linesByInvocation.get("make worker-contract");
  assert.ok(workerContractLines, "make worker-contract not found among CI's invocations");
  assert.ok(workerContractLines.includes("npm run build --prefix app"));
  assert.ok(
    workerContractLines.some((line) =>
      line.startsWith("npm run deploy --prefix workers-bus -- --dry-run"),
    ),
  );
  assert.ok(
    workerContractLines.some((line) =>
      line.startsWith("grep -Eq 'Read [1-9][0-9]* files from the assets directory'"),
    ),
  );

  const onlyInLocal = [...localLines].filter((line) => !ciLines.has(line));
  assert.deepEqual(
    onlyInLocal.sort(),
    [
      "npm test --prefix workers-bus 2>&1 | tee tmp/check/worker-tests.tap",
      `for suite in ${suites.join(" ")}; do PW_SKIP_BUILD=1 npm run $suite --prefix app; done`,
    ].sort(),
  );
});

test("the static-plus-matrix job count stays at or under 100 - tools/release-promotion.mjs:260 reads a run's jobs unpaged", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const names = jobNames(workflow);
  const shardCountMatch = workflow.match(/WORKER_SHARDS: (\d+)/);
  assert.ok(shardCountMatch, "WORKER_SHARDS env not found");
  const shardCount = Number(shardCountMatch[1]);
  const worker = section(workflow, "worker");
  const workerMatrixMatch = worker.match(/shard: \[([^\]]+)\]/);
  const workerLegs = workerMatrixMatch[1].split(",").length;
  assert.equal(workerLegs, shardCount);

  const e2e = section(workflow, "e2e");
  const e2eMatrixSection = e2e.slice(e2e.indexOf("suite:"), e2e.indexOf("runs-on:"));
  const e2eLegs = [...e2eMatrixSection.matchAll(/- (\S+)/g)].length;

  const staticJobCount = names.length - 2; // "worker" and "e2e" are matrices, counted below.
  const totalJobCount = staticJobCount + workerLegs + e2eLegs;
  assert.ok(
    totalJobCount <= 100,
    `${totalJobCount} jobs exceeds the unpaged actions/runs/<id>/jobs?per_page=100 the release path reads`,
  );
});
