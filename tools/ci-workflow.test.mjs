import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Pins the shape of .github/workflows/ci.yml (IRO-267): nothing pinned it before
// this split, unlike tools/deploy-workflow.test.mjs for deploy.yml.
const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const makefileUrl = new URL("../Makefile", import.meta.url);
const repoRoot = new URL("../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot).replace(/\/$/, "");
const workflowsDirUrl = new URL("../.github/workflows/", import.meta.url);

// A job's GitHub-visible name is its job-level `name:` when the job declares one
// (`dependency-scan` -> `dependency scan`), else its id. A job carrying a job-level
// `strategy:` is a matrix job: its real per-run job names are never its bare id, so
// `collectCiChecks`' exactly-one-successful-job rule can never match it by id.
function ciJobs(workflow) {
  return jobNames(workflow).map((id) => {
    const jobText = section(workflow, id);
    const isMatrix = /^ {4}strategy:/m.test(jobText);
    const nameMatch = jobText.match(/^ {4}name: (.+)$/m);
    return { id, name: nameMatch ? nameMatch[1].trim() : id, isMatrix };
  });
}

// Every `--job-names "..."` caller across the workflow directory, comment lines
// stripped first so prose mentioning `--job-names` (lighthouse-harness-ab.yml) is
// never read as a caller.
async function jobNamesCallers() {
  const files = await readdir(workflowsDirUrl);
  const callers = [];
  for (const file of files) {
    const text = await readFile(new URL(file, workflowsDirUrl), "utf8");
    const stripped = text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const match of stripped.matchAll(/--job-names "([^"]*)"/g)) {
      callers.push({ file, names: match[1].split(",") });
    }
  }
  return callers;
}

// Derivation from ci.yml: throws unless every requested name is a known,
// non-matrix ci.yml job name. Independent of which three names a caller is
// pinned to - that is assertJobNamesCaller's concern, not this one's.
function assertAdmissibleJobNames(file, names, jobs) {
  const admissible = jobs.map((job) => job.name);
  const matrixNames = jobs.filter((job) => job.isMatrix).map((job) => job.name);
  for (const requestedName of names) {
    assert.ok(admissible.includes(requestedName), `${file}: ${requestedName} is not a ci.yml job name`);
    assert.ok(!matrixNames.includes(requestedName), `${file}: ${requestedName} is a matrix job`);
  }
}

// Caller policy on top of the derivation above: shared by the real test below
// and by the negative tests.
function assertJobNamesCaller(file, names, jobs) {
  assertAdmissibleJobNames(file, names, jobs);
  assert.deepEqual(names, ["paired-device-lighthouse", "gate", "validate-and-test"], file);
}

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

// The e2e matrix's suite groups: one quoted, space-separated list per leg.
function e2eGroups(workflow) {
  const e2e = section(workflow, "e2e");
  const matrixSection = e2e.slice(e2e.indexOf("group:"), e2e.indexOf("runs-on:"));
  return [...matrixSection.matchAll(/^ {10}- "([^"]+)"$/gm)].map((match) => match[1].split(" "));
}

function makefileSuites(makefile) {
  const suitesMatch = makefile.match(/E2E_SUITES := ([\s\S]*?)\n\n/);
  assert.ok(suitesMatch, "Makefile: E2E_SUITES not found");
  return suitesMatch[1]
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Jobs `changes` may legitimately skip, by the scope output that decides each.
// gate's own predicate must carry exactly this map; see the tests below.
const SCOPED_JOBS = {
  e2e: "app",
  "paired-device-lighthouse": "app",
  pwa: "code",
  worker: "code",
  "worker-contract": "code",
  evidence: "code",
};

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
test("only dependency-scan, gate, validate-and-test and the scoped jobs carry a job-level if:", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobLevelIfJobs = [];
  for (const job of jobNames(workflow)) {
    const jobText = section(workflow, job);
    // Job-level `if:` is indented 4 spaces; step-level `if:` sits under `steps:`
    // at 8+ spaces, so this line anchor is what tells them apart.
    if (/^    if:/m.test(jobText)) jobLevelIfJobs.push(job);
  }
  assert.deepEqual(
    [...jobLevelIfJobs].sort(),
    ["dependency-scan", "gate", "validate-and-test", ...Object.keys(SCOPED_JOBS)].sort(),
  );
});

// A scoped job may only be conditioned on its own scope, and must need `changes`
// to read it; any other condition would be a skip gate cannot account for.
test("each scoped job's only condition is its own scope output from changes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  for (const [job, scope] of Object.entries(SCOPED_JOBS)) {
    const jobText = section(workflow, job);
    const conditions = [...jobText.matchAll(/^ {4}if: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(conditions, [`needs.changes.outputs.${scope} == 'true'`], job);
    assert.match(jobText, /^ {4}needs: \[changes(, [a-z-]+)*\]$/m, `${job} must need changes`);
  }
  const changes = section(workflow, "changes");
  assert.match(changes, /app: \$\{\{ steps\.scope\.outputs\.app \}\}/);
  assert.match(changes, /code: \$\{\{ steps\.scope\.outputs\.code \}\}/);
  assert.match(changes, /fetch-depth: 2/);
  assert.deepEqual(runCommands(changes), ["node tools/ci-scope.mjs"]);
});

// gate's own shell, read verbatim out of ci.yml and actually run against four
// synthetic `needs` payloads (IRO-267 revision 2, step 22). Deliberately not
// wrapped in a try/catch that would let a missing `jq` on this box skip the
// test instead of failing it: gate itself needs jq on the runner, so this
// must fail closed the same way.
test("gate's shell passes only when every job succeeded or was skipped where its scope allows", async () => {
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
    changes: { result: "success", outputs: { app: "true", code: "true" } },
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

  const skipped = (needs, jobs) =>
    Object.fromEntries(
      Object.entries(needs).map(([job, value]) => [job, jobs.includes(job) ? { result: "skipped" } : value]),
    );
  const appJobs = Object.keys(SCOPED_JOBS).filter((job) => SCOPED_JOBS[job] === "app");
  const codeJobs = Object.keys(SCOPED_JOBS).filter((job) => SCOPED_JOBS[job] === "code");
  const scoped = (app, code) => ({ ...allSuccess, changes: { result: "success", outputs: { app, code } } });

  assert.equal(runGate(skipped(scoped("false", "true"), appJobs)), 0, "a Worker-only change may skip the bundle legs");
  assert.equal(
    runGate(skipped(scoped("false", "false"), [...appJobs, ...codeJobs, "dependency-scan"])),
    0,
    "a markdown-only change may skip every suite",
  );
  for (const job of Object.keys(SCOPED_JOBS)) {
    assert.equal(runGate(skipped(allSuccess, [job])), 1, `${job} skipped while its scope said run must fail gate`);
  }
  assert.equal(
    runGate(skipped(scoped("false", "true"), codeJobs)),
    1,
    "a test suite skipped while code is in scope must fail gate",
  );
  assert.equal(runGate(skipped(scoped("false", "false"), ["contracts"])), 1, "contracts is never scoped");
  assert.equal(runGate(skipped(scoped("false", "false"), ["secret-scan"])), 1, "secret-scan is never scoped");
  const changesFailed = { ...skipped(allSuccess, [...appJobs, ...codeJobs]), changes: { result: "failure", outputs: {} } };
  assert.equal(runGate(changesFailed), 1, "a failed changes job fails gate, whatever it skipped");
  const unset = skipped({ ...allSuccess, changes: { result: "success", outputs: {} } }, appJobs);
  assert.equal(runGate(unset), 1, "a skip with no scope output fails gate");
});

test("gate's skip map is exactly the scoped jobs and their scopes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const [script] = runCommands(section(workflow, "gate"));
  const mapMatch = script.match(/\{([^{}]*)\} as \$scoped/);
  assert.ok(mapMatch, "gate's $scoped map not found");
  const map = Object.fromEntries(
    [...mapMatch[1].matchAll(/"([a-z0-9-]+)": "([a-z]+)"/g)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(map, SCOPED_JOBS);
});

test("ci.yml job names: dependency-scan's override, worker and e2e as matrix jobs", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobs = ciJobs(workflow);
  assert.equal(jobs.find((job) => job.id === "dependency-scan")?.name, "dependency scan");
  assert.deepEqual(
    [...jobs.filter((job) => job.isMatrix).map((job) => job.id)].sort(),
    ["e2e", "worker"],
  );
});

test("every --job-names caller in .github/workflows requests only the three non-matrix ci.yml jobs it needs", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobs = ciJobs(workflow);
  const callers = await jobNamesCallers();
  // A prose mention (lighthouse-harness-ab.yml) must never surface as a caller, and
  // an empty read here would make every assertion below pass vacuously.
  assert.ok(callers.length >= 2, `expected at least two --job-names callers, found ${callers.length}`);
  for (const { file, names } of callers) {
    assertJobNamesCaller(file, names, jobs);
  }
});

test("a caller requesting the deleted make check job, or any matrix job, fails the ci.yml derivation", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobs = ciJobs(workflow);
  assert.throws(
    () =>
      assertAdmissibleJobNames(
        "synthetic",
        ["make check", "paired-device-lighthouse", "gate", "validate-and-test"],
        jobs,
      ),
    /make check is not a ci\.yml job name/,
  );
  assert.throws(
    () => assertAdmissibleJobNames("synthetic", ["worker", "gate", "validate-and-test"], jobs),
    /worker is a matrix job/,
  );
});

test("a caller requesting admissible jobs that are not the pinned three still fails the caller pin", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobs = ciJobs(workflow);
  const names = ["gate", "validate-and-test", "secret-scan"];
  assertAdmissibleJobNames("synthetic", names, jobs);
  assert.throws(() => assertJobNamesCaller("synthetic", names, jobs));
});

test("removing a requested job from ci.yml fails validation for every caller that still names it", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const jobs = ciJobs(workflow).filter((job) => job.id !== "gate");
  const callers = await jobNamesCallers();
  assert.ok(callers.length >= 2);
  for (const { file, names } of callers) {
    assert.throws(() => assertJobNamesCaller(file, names, jobs), `${file}: gate missing from ci.yml must be caught`);
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

test("the e2e matrix runs every one of the Makefile's E2E_SUITES exactly once, grouped, through make", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const makefile = await readFile(makefileUrl, "utf8");
  const suites = makefileSuites(makefile);
  assert.equal(suites.length, 17);

  const groups = e2eGroups(workflow);
  assert.ok(groups.length >= 2, `expected at least two e2e groups, found ${groups.length}`);
  for (const group of groups) assert.ok(group.length >= 1);
  const matrixSuites = groups.flat();
  assert.equal(new Set(matrixSuites).size, matrixSuites.length, "a suite appears in two groups");
  assert.deepEqual([...matrixSuites].sort(), [...suites].sort());
  // One step, through make, so the build/suite split can never drift out of sync
  // with e2e-suite's own recipe (IRO-267 revision 1, step 14).
  const e2e = section(workflow, "e2e");
  assert.match(e2e, /make e2e-suite SUITE="\$\{\{ matrix\.group \}\}"/);
});

test("e2e and e2e-suite fail when any suite fails, not only the last", async () => {
  const makefile = await readFile(makefileUrl, "utf8");
  const loops = makefile.match(/^\tstatus=0; for suite in .*$/gm) ?? [];
  assert.equal(loops.length, 2, "expected the e2e and e2e-suite loops");
  for (const loop of loops) {
    assert.match(loop, /\|\| status=1; done; exit \$\$status$/);
  }
  assert.doesNotMatch(makefile, /^\tfor suite in .*; done$/m, "a bare for loop masks earlier failures");
});

test("the worker-contract job restores the typecheck and deploy dry-run checks CI used to drop", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const workerContract = section(workflow, "worker-contract");
  assert.match(workerContract, /make worker-contract/);
});

test("evidence needs both pwa and worker, and merges the shard TAPs before the receipt", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const evidence = section(workflow, "evidence");
  assert.match(evidence, /needs: \[changes, pwa, worker\]/);
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
    "changes",
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
// with its own conditional steps, a scanner with no Makefile target, the scope
// decision every scoped job reads, and the two aggregator jobs' pass/fail shells.
const NON_MAKE_JOBS = new Set(["changes", "paired-device-lighthouse", "dependency-scan", "gate", "validate-and-test"]);

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
  'make e2e-suite SUITE="${{ matrix.group }}"',
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

  const suites = makefileSuites(makefile);
  const groups = e2eGroups(workflow);

  // Each entry is [invocation label, make argv].
  const expanded = [];
  for (const invocation of deriveMakeInvocations(workflow)) {
    if (invocation.includes("${{ matrix.shard }}")) {
      for (let shard = 1; shard <= shardCount; shard += 1) {
        const label = invocation
          .replace("${{ matrix.shard }}", String(shard))
          .replace("${{ env.WORKER_SHARDS }}", String(shardCount));
        expanded.push([label, label.split(" ").slice(1)]);
      }
    } else if (invocation.includes("${{ matrix.group }}")) {
      for (const group of groups) {
        const suiteList = group.join(" ");
        expanded.push([`make e2e-suite SUITE="${suiteList}"`, ["e2e-suite", `SUITE=${suiteList}`]]);
      }
    } else {
      expanded.push([invocation, invocation.split(" ").slice(1)]);
    }
  }

  const run = (words) =>
    execFileSync("make", ["-n", ...words], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(repoRootPath).join("<repo>"))
      .filter(Boolean);

  const ciLines = new Set();
  const linesByInvocation = new Map();
  for (const [invocation, argv] of expanded) {
    const lines = run(argv);
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
      `status=0; for suite in ${suites.join(" ")}; do PW_SKIP_BUILD=1 npm run $suite --prefix app || status=1; done; exit $status`,
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

  const e2eLegs = e2eGroups(workflow).length;

  const staticJobCount = names.length - 2; // "worker" and "e2e" are matrices, counted below.
  const totalJobCount = staticJobCount + workerLegs + e2eLegs;
  assert.ok(
    totalJobCount <= 100,
    `${totalJobCount} jobs exceeds the unpaged actions/runs/<id>/jobs?per_page=100 the release path reads`,
  );
});
