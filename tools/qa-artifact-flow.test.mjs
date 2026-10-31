import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { diagnosticFromStderr } from "./qa-smoke-diagnostic.mjs";

const execute = promisify(execFile);
const workflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const productionWorkflowUrl = new URL("../.github/workflows/deploy-production.yml", import.meta.url);
const enforcer = path.resolve(import.meta.dirname, "release-promotion.mjs");

function stepScript(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  const step = workflow.slice(start, next < 0 ? undefined : next);
  const marker = "        run: |\n";
  const run = step.indexOf(marker);
  assert.ok(run >= 0, `missing shell script: ${name}`);
  const lines = step.slice(run + marker.length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ironwrap-qa-artifact-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runStep(workflow, name, directory, extraEnv = {}, cwd = undefined) {
  try {
    const result = await execute("bash", ["-c", stepScript(workflow, name)], {
      cwd,
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        RELEASE_ENFORCER: enforcer,
        ...extraEnv,
      },
      timeout: 30_000,
    });
    return { status: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function trustedWranglerStep(t, workflow, {
  manifestVersion = "4.151.0",
  rootLockVersion = manifestVersion,
  lockedVersion = manifestVersion,
  binaryVersion = manifestVersion,
} = {}) {
  const directory = await fixture(t);
  const candidate = path.join(directory, "candidate");
  const trusted = path.join(directory, "policy-enforcer", "workers-bus");
  const bin = path.join(directory, "bin");
  await Promise.all([
    mkdir(path.join(candidate, "workers-bus"), { recursive: true }),
    mkdir(path.join(trusted, "node_modules", ".bin"), { recursive: true }),
    mkdir(path.join(directory, "context-download"), { recursive: true }),
    mkdir(bin),
  ]);
  const manifest = (version) => JSON.stringify({ devDependencies: { wrangler: version } });
  const lock = (rootVersion, version) => JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { wrangler: rootVersion } },
      "node_modules/wrangler": version === null ? undefined : { version },
    },
  });
  await Promise.all([
    writeFile(path.join(candidate, "workers-bus", "package.json"), manifest("4.152.0")),
    writeFile(path.join(candidate, "workers-bus", "package-lock.json"), lock("4.152.0", "4.152.0")),
    writeFile(path.join(trusted, "package.json"), manifest(manifestVersion)),
    writeFile(path.join(trusted, "package-lock.json"), lock(rootLockVersion, lockedVersion)),
    writeFile(path.join(directory, "context-download", "context.json"), JSON.stringify({ base_commit: "a".repeat(40) })),
  ]);
  const stubs = {
    git: `#!/bin/sh
set -eu
printf 'git %s\\n' "$*" >> "$RUNNER_TEMP/tool-calls.log"
case "$1 $2" in
  'rev-list --parents') printf '%s %s\\n' "$RELEASE_SOURCE_COMMIT" "$TRUSTED_BASE_COMMIT" ;;
  'worktree add') test "$3" = --detach; test "$4" = "$RUNNER_TEMP/policy-enforcer"; test "$5" = "$TRUSTED_BASE_COMMIT" ;;
  *) exit 98 ;;
esac
`,
    npm: `#!/bin/sh
set -eu
test "$*" = "ci --ignore-scripts --prefix $RUNNER_TEMP/policy-enforcer/workers-bus"
printf 'npm %s\\n' "$*" >> "$RUNNER_TEMP/tool-calls.log"
`,
    node: `#!/bin/sh
set -eu
test "$1" = "$RUNNER_TEMP/policy-enforcer/tools/release-promotion.mjs"
test "$2" = provider-targets
printf 'node %s\\n' "$*" >> "$RUNNER_TEMP/tool-calls.log"
`,
  };
  await Promise.all(Object.entries(stubs).map(([name, source]) => writeFile(path.join(bin, name), source, { mode: 0o755 })));
  await writeFile(path.join(trusted, "node_modules", ".bin", "wrangler"), `#!/bin/sh
set -eu
test "$*" = --version
printf 'wrangler %s\\n' "$*" >> "$RUNNER_TEMP/tool-calls.log"
printf '%s\\n' "$TRUSTED_BINARY_VERSION"
`, { mode: 0o755 });
  const githubEnv = path.join(directory, "github-env");
  await writeFile(githubEnv, "");
  const result = await runStep(workflow,
    "Load generation N policy enforcement and trusted Wrangler", directory, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_WORKSPACE: candidate,
      GITHUB_ENV: githubEnv,
      RELEASE_SOURCE_COMMIT: "b".repeat(40),
      TRUSTED_BASE_COMMIT: "a".repeat(40),
      TRUSTED_BINARY_VERSION: binaryVersion,
      WORKER_VERSION: "4.152.0",
    }, candidate);
  return {
    result,
    environment: await readFile(githubEnv, "utf8"),
    calls: await readFile(path.join(directory, "tool-calls.log"), "utf8"),
    trusted,
  };
}

for (const [name, url] of [["qa", workflowUrl], ["production", productionWorkflowUrl]]) {
  test(`${name} loads the predecessor's locked Wrangler when the candidate upgrades its CLI`, async (t) => {
    const workflow = await readFile(url, "utf8");
    const proof = await trustedWranglerStep(t, workflow);
    assert.equal(proof.result.status, 0, proof.result.stdout + proof.result.stderr);
    assert.ok(proof.environment.includes(`WRANGLER_BIN=${path.join(proof.trusted, "node_modules", ".bin", "wrangler")}\n`));
    assert.ok(proof.environment.includes("/policy-enforcer/tools/release-promotion.mjs\n"));
    assert.match(proof.calls, /npm ci --ignore-scripts --prefix .*\/policy-enforcer\/workers-bus/);
    assert.match(proof.calls, /wrangler --version/);

    // Reproduce the old transition defect: a trusted 4.151.0 binary cannot be
    // compared to the candidate build's 4.152.0 pin, even though both are valid.
    const regressed = workflow.replace(
      'test "$("$trusted_wrangler" --version)" = "$trusted_worker_version"',
      'test "$("$trusted_wrangler" --version)" = "$WORKER_VERSION"',
    );
    assert.notEqual(regressed, workflow);
    const failure = await trustedWranglerStep(t, regressed);
    assert.notEqual(failure.result.status, 0);
    assert.ok(!failure.environment.includes("WRANGLER_BIN="));
  });

  for (const [drift, options] of [
    ["binary matching only the candidate", { binaryVersion: "4.152.0" }],
    ["root lock pin", { rootLockVersion: "4.152.0" }],
    ["resolved lock version", { lockedVersion: "4.152.0" }],
    ["missing resolved lock version", { lockedVersion: null }],
    ["non-exact manifest pin", { manifestVersion: "^4.151.0" }],
  ]) {
    test(`${name} rejects trusted Wrangler ${drift} drift before exporting the provider CLI`, async (t) => {
      const proof = await trustedWranglerStep(t, await readFile(url, "utf8"), options);
      assert.notEqual(proof.result.status, 0);
      assert.ok(!proof.environment.includes("WRANGLER_BIN="));
      assert.doesNotMatch(proof.calls, /node .*provider-targets/);
    });
  }
}

// Execute the workflow shell, with only external commands replaced. jq stays real.
// All clock advances are virtual; no fixture reaches Cloudflare or waits in real time.
async function drainFixture(t, responses) {
  const directory = await fixture(t);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  for (const [name, contents] of Object.entries({
    clock: "0\n", index: "0\n", requests: "", sleeps: "", exports: "",
  })) await writeFile(path.join(directory, name), contents);
  for (const [index, response] of responses.entries()) {
    await writeFile(path.join(directory, `response-${index}.meta`),
      `${response.duration || 0} ${response.http || 200} ${response.exit || 0}\n`);
    await writeFile(path.join(directory, `response-${index}.body`), response.body);
  }
  const stub = `#!/bin/bash
set -euo pipefail
read -r now < "$DRAIN_FIXTURE/clock"
read -r index < "$DRAIN_FIXTURE/index"
case "\${0##*/}" in
  date)
    [[ "$*" == "+%s" ]]
    printf '%s\\n' "$now"
    ;;
  sleep)
    printf '%s %s\\n' "$now" "$1" >> "$DRAIN_FIXTURE/sleeps"
    printf '%s\\n' "$((now + $1))" > "$DRAIN_FIXTURE/clock"
    ;;
  curl)
    while (( $# )); do
      case "$1" in
        --connect-timeout) connect_time=$2; shift 2 ;;
        --max-time) max_time=$2; shift 2 ;;
        --output) output=$2; shift 2 ;;
        --write-out) [[ "$2" == '%{http_code}' ]]; shift 2 ;;
        --header) [[ "$2" == 'Authorization: Bearer synthetic-admin-token' ]]; shift 2 ;;
        --silent|--show-error) shift ;;
        https://qa.example.invalid/admin/status) shift ;;
        *) exit 99 ;;
      esac
    done
    printf '%s %s %s\\n' "$now" "$max_time" "$connect_time" >> "$DRAIN_FIXTURE/requests"
    response_index=$((index < DRAIN_RESPONSES ? index : DRAIN_RESPONSES - 1))
    read -r duration http status < "$DRAIN_FIXTURE/response-$response_index.meta"
    cp "$DRAIN_FIXTURE/response-$response_index.body" "$output"
    printf '%s' "$http"
    printf '%s\\n' "$((index + 1))" > "$DRAIN_FIXTURE/index"
    if (( duration > max_time )); then duration=$max_time; status=28; fi
    printf '%s\\n' "$((now + duration))" > "$DRAIN_FIXTURE/clock"
    exit "$status"
    ;;
  wrangler)
    [[ "$1 $2 $3" == 'd1 export ironwrap-bus-qa' ]]
    printf '%s %s\\n' "$now" "$index" >> "$DRAIN_FIXTURE/exports"
    while [[ "$1" != '--output' ]]; do shift; done
    printf '%s\\n' '-- synthetic export' > "$2"
    ;;
  node)
    # Restore/readback commands are outside this drain fixture's scope.
    if [[ "$2" == 'context-field' ]]; then printf '%s\\n' 'synthetic-context'; fi
    ;;
  *) exit 99 ;;
esac
`;
  for (const name of ["date", "sleep", "curl", "wrangler", "node"]) {
    const target = path.join(bin, name);
    await writeFile(target, stub);
    await chmod(target, 0o755);
  }
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runStep(workflow,
    "Export and restore qa data into a separate local drill target", directory, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      DRAIN_FIXTURE: directory,
      DRAIN_RESPONSES: String(responses.length),
      WRANGLER_BIN: path.join(bin, "wrangler"),
      RELEASE_QA_BASE_URL: "https://qa.example.invalid",
      ADMIN_TOKEN: "synthetic-admin-token",
      GITHUB_RUN_ID: "synthetic-run",
    });
  const rows = async (name) => (await readFile(path.join(directory, name), "utf8"))
    .trim().split("\n").filter(Boolean).map(line => line.split(" ").map(Number));
  const state = {
    now: Number(await readFile(path.join(directory, "clock"), "utf8")),
    requests: (await rows("requests")).map(([at, maxTime, connectTime]) => ({ at, maxTime, connectTime })),
    sleeps: (await rows("sleeps")).map(([at, seconds]) => ({ at, seconds })),
    exports: (await rows("exports")).map(([at, requests]) => ({ at, requests })),
  };
  for (const { at, maxTime, connectTime } of state.requests) {
    assert.ok(maxTime > 0 && maxTime <= 10 && maxTime <= 300 - at);
    assert.ok(connectTime > 0 && connectTime <= 3 && connectTime <= maxTime);
  }
  for (const { at, seconds } of state.sleeps) {
    assert.ok(seconds > 0 && seconds <= 5 && seconds <= 300 - at);
  }
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-admin-token|private_status_value/);
  return { result, state };
}

const drainedBody = JSON.stringify({ counts: { pending: 0, open_dead_letters: 0 }, secret: "private_status_value" });
const pendingBody = JSON.stringify({ counts: { pending: 1, open_dead_letters: 0 } });

test("qa drain rejects zeros received at the deadline", async (t) => {
  const responses = [
    ...Array.from({ length: 23 }, () => ({ duration: 8, body: pendingBody })),
    { duration: 1, body: drainedBody },
  ];
  const { result, state } = await drainFixture(t, responses);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(state.now, 300);
  assert.equal(state.requests.at(-1).maxTime, 1);
  assert.equal(state.requests.at(-1).connectTime, 1);
  assert.deepEqual(state.exports, []);
  assert.match(result.stderr, /^release_qa_queue_not_drained\n$/);
  assert.doesNotMatch(result.stdout, /release_qa_queue_drained|release_qa_export_starting/);
});

test("qa drain caps its final sleep by the remaining deadline", async (t) => {
  const { result, state } = await drainFixture(t, [
    { duration: 2, body: pendingBody }, { body: pendingBody },
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(state.now, 300);
  assert.equal(state.sleeps.at(-1).seconds, 3);
  assert.deepEqual(state.exports, []);
  assert.match(result.stderr, /^release_qa_queue_not_drained\n$/);
});

for (const [name, responses] of [
  ["immediate numeric zeros", [{ body: drainedBody }]],
  ["pending then zeros", [{ body: pendingBody }, { body: drainedBody }]],
  ["HTTP failure then recovery", [{ http: 503, body: drainedBody }, { body: drainedBody }]],
  ["network failure then recovery", [{ exit: 7, body: drainedBody }, { body: drainedBody }]],
  ["request timeout then recovery", [{ duration: 11, body: drainedBody }, { body: drainedBody }]],
]) {
  test(`qa drain exports only after ${name}`, async (t) => {
    const { result, state } = await drainFixture(t, responses);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(state.exports, [{ at: state.now, requests: responses.length }]);
    assert.equal(state.requests.length, responses.length);
    assert.equal(state.sleeps.length, responses.length - 1);
    assert.match(result.stdout, /release_qa_queue_drained pending=0 open_dead_letters=0\nrelease_qa_export_starting\n/);
    assert.doesNotMatch(result.stdout + result.stderr, /release_qa_queue_not_drained/);
    assert.ok(state.now < 300);
  });
}

for (const [name, response] of [
  ["pending envelopes", { body: pendingBody }],
  ["open dead letters", { body: JSON.stringify({ counts: { pending: 0, open_dead_letters: 1 } }) }],
  ["malformed JSON", { body: "private_status_value" }],
  ["missing counts", { body: '{"counts":{"pending":0}}' }],
  ["string counts", { body: '{"counts":{"pending":"0","open_dead_letters":"0"}}' }],
  ["null counts", { body: '{"counts":{"pending":null,"open_dead_letters":null}}' }],
  ["multiple JSON documents", { body: drainedBody + "\n" + drainedBody }],
  ["HTTP errors with zeros", { http: 503, body: drainedBody }],
  ["repeated request timeouts", { duration: 11, body: drainedBody }],
  ["slow requests near deadline", { duration: 8, body: pendingBody }],
]) {
  test(`qa drain fails closed at the deadline for ${name}`, async (t) => {
    const { result, state } = await drainFixture(t, [response]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(state.exports, []);
    assert.equal(state.now, 300);
    assert.match(result.stderr, /^release_qa_queue_not_drained\n$/);
    assert.doesNotMatch(result.stdout, /release_qa_queue_drained|release_qa_export_starting/);
    assert.ok(state.requests.length <= 60);
    assert.ok(state.sleeps.length <= 60);
  });
}

test("QA publishes a flat context with the exact admission and component bytes", async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, "admission"));
  const files = {
    "context.json": JSON.stringify({ artifact_digest: "a".repeat(64) }),
    "pr-context.json": JSON.stringify({ source: "synthetic admitted source" }),
    "artifact-components.json": JSON.stringify({ worker: "synthetic worker" }),
  };
  for (const [name, contents] of Object.entries(files)) {
    const parent =
      name === "artifact-components.json"
        ? directory
        : path.join(directory, "admission");
    await writeFile(path.join(parent, name), contents);
  }
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runStep(
    workflow,
    "Stage the built context as one directory",
    directory,
  );
  assert.equal(result.status, 0, result.stderr);
  const staged = path.join(directory, "built-context");
  assert.deepEqual((await readdir(staged)).sort(), Object.keys(files).sort());
  for (const [name, contents] of Object.entries(files)) {
    assert.equal(await readFile(path.join(staged, name), "utf8"), contents);
  }
  assert.match(
    workflow,
    /name: iro41-built-context-[^\n]+\n\s+path: \$\{\{ runner\.temp \}\}\/built-context\n/,
  );
});

async function artifactFixture(t, tamper) {
  const directory = await fixture(t);
  const payload = path.join(directory, "payload");
  const download = path.join(directory, "artifact-download");
  const context = path.join(directory, "context-download");
  await Promise.all([mkdir(payload), mkdir(download), mkdir(context)]);
  await writeFile(
    path.join(payload, "synthetic-artifact.txt"),
    "synthetic immutable artifact",
  );
  const archive = path.join(download, "ironwrap-release-artifact.tar");
  await execute("tar", ["-cf", archive, "-C", payload, "."]);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    path.join(context, "context.json"),
    JSON.stringify({ artifact_digest: digest }),
  );
  if (tamper) {
    await writeFile(
      path.join(payload, "synthetic-artifact.txt"),
      "changed artifact after binding",
    );
    await execute("tar", ["-cf", archive, "-C", payload, "."]);
  }
  return directory;
}

test("QA verifies the downloaded archive and unpacks the same bytes", async (t) => {
  const directory = await artifactFixture(t, false);
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runStep(
    workflow,
    "Verify the same immutable artifact bytes",
    directory,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(path.join(directory, "synthetic-artifact.txt"), "utf8"),
    "synthetic immutable artifact",
  );
});

test("QA refuses a changed archive before unpacking any candidate files", async (t) => {
  const directory = await artifactFixture(t, true);
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runStep(
    workflow,
    "Verify the same immutable artifact bytes",
    directory,
  );
  assert.notEqual(result.status, 0);
  await assert.rejects(
    readFile(path.join(directory, "synthetic-artifact.txt")),
    { code: "ENOENT" },
  );
});

test("QA smoke failures retain only allowlisted diagnostics and the original exit", async (t) => {
  const directory = await fixture(t);
  const policy = path.join(directory, "policy");
  await mkdir(policy);
  await writeFile(
    path.join(policy, "launch-proof.mjs"),
    'process.stderr.write("health: HTTP 200\\nready: HTTP 503\\nAuthorization: Bearer synthetic-secret\\n"); process.exit(23);\n',
  );
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(
    stepScript(workflow, "Run authenticated affected-workflow smoke receipt"),
    /env -i PATH="\$PATH" node "\$GITHUB_WORKSPACE\/tools\/qa-smoke-diagnostic\.mjs"/,
  );
  const result = await runStep(
    workflow,
    "Run authenticated affected-workflow smoke receipt",
    directory,
    {
      RELEASE_ENFORCER: path.join(policy, "release-promotion.mjs"),
      GITHUB_WORKSPACE: path.resolve(import.meta.dirname, ".."),
    },
  );
  assert.equal(result.status, 23);
  const diagnostic = await readFile(
    path.join(directory, "qa-smoke-diagnostic.json"),
    "utf8",
  );
  assert.deepEqual(JSON.parse(diagnostic), {
    proof: "ironwrap-qa-smoke-failure-v1",
    phase: "initial",
    exit_status: 23,
    completed_steps: [
      { name: "health", http_status: 200 },
      { name: "ready", http_status: 503 },
    ],
  });
  assert.equal(result.stderr, diagnostic);
  assert.ok(!diagnostic.includes("synthetic-secret"));
  assert.match(
    await readFile(path.join(directory, "qa-smoke-raw.log"), "utf8"),
    /synthetic-secret/,
  );
  const artifactStep = workflow.slice(
    workflow.indexOf(
      "      - name: Publish isolated qa smoke failure diagnostics\n",
    ),
  );
  assert.match(artifactStep, /\n        if: \$\{\{ failure\(\) \}\}/);
  assert.match(artifactStep, /\/qa-smoke-diagnostic\.json/);
  assert.match(artifactStep, /\/qa-rollback-smoke-diagnostic\.json/);
  assert.doesNotMatch(
    artifactStep,
    /\/qa-smoke-raw\.log|\/qa-rollback-smoke-raw\.log/,
  );
});

test("successful QA smoke still writes the established evidence file", async (t) => {
  const directory = await fixture(t);
  const policy = path.join(directory, "policy");
  await mkdir(policy);
  await writeFile(
    path.join(policy, "launch-proof.mjs"),
    'process.stderr.write("health: HTTP 200\\n"); process.stdout.write("{\\"proof\\":\\"synthetic\\"}\\n");\n',
  );
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runStep(
    workflow,
    "Run authenticated affected-workflow smoke receipt",
    directory,
    { RELEASE_ENFORCER: path.join(policy, "release-promotion.mjs") },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "health: HTTP 200\n");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "qa-smoke-evidence.json"))),
    { proof: "synthetic" },
  );
  await assert.rejects(
    readFile(path.join(directory, "qa-smoke-diagnostic.json")),
    {
      code: "ENOENT",
    },
  );
});

test("QA smoke diagnostic rejects unlisted lines and invalid scope", () => {
  assert.deepEqual(
    diagnosticFromStderr(
      "rollback",
      29,
      "health: HTTP 200\nAuthorization: Bearer synthetic-secret\nunknown: HTTP 200\n",
    ),
    {
      proof: "ironwrap-qa-smoke-failure-v1",
      phase: "rollback",
      exit_status: 29,
      completed_steps: [{ name: "health", http_status: 200 }],
    },
  );
  assert.throws(() => diagnosticFromStderr("other", 29, ""));
  assert.throws(() => diagnosticFromStderr("initial", 0, ""));
});

test("failed rollback smoke keeps the previous revision and never re-promotes", async (t) => {
  const directory = await fixture(t);
  const policy = path.join(directory, "policy");
  const bin = path.join(directory, "bin");
  await Promise.all([mkdir(policy), mkdir(bin)]);
  await writeFile(
    path.join(directory, "qa-version.id"),
    "synthetic-candidate\n",
  );
  await writeFile(
    path.join(policy, "release-promotion.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.RUNNER_TEMP + "/policy-calls.log", JSON.stringify(args) + "\\n");
const output = args.indexOf("--output");
if (output >= 0) writeFileSync(args[output + 1], "{}");
`,
  );
  await writeFile(
    path.join(policy, "launch-proof.mjs"),
    'process.stderr.write("health: HTTP 200\\nAuthorization: Bearer synthetic-secret\\n"); process.exit(23);\n',
  );
  const wrangler = path.join(bin, "wrangler");
  await writeFile(
    wrangler,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUNNER_TEMP/wrangler-calls.log"\nif [ "$1" = deployments ]; then printf "{}\\n"; fi\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, "curl"), '#!/bin/sh\nprintf "{}\\n"\n', {
    mode: 0o755,
  });
  const workflow = await readFile(workflowUrl, "utf8");
  const script = stepScript(
    workflow,
    "Roll back qa candidate and prove the previous revision against migrated data",
  ).replace("${{ steps.capture_qa.outputs.previous }}", "synthetic-previous");
  assert.match(
    script,
    /env -i PATH="\$PATH" node "\$GITHUB_WORKSPACE\/tools\/qa-smoke-diagnostic\.mjs"/,
  );
  let result;
  try {
    result = await execute("bash", ["-c", script], {
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        RELEASE_ENFORCER: path.join(policy, "release-promotion.mjs"),
        GITHUB_WORKSPACE: path.resolve(import.meta.dirname, ".."),
        WRANGLER_BIN: wrangler,
        BUS_BASE_URL: "https://qa.example.invalid",
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    result.code = 0;
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    result = { ...error, code: error.code };
  }
  assert.equal(result.code, 23);
  const diagnostic = await readFile(
    path.join(directory, "qa-rollback-smoke-diagnostic.json"),
    "utf8",
  );
  assert.deepEqual(JSON.parse(diagnostic), {
    proof: "ironwrap-qa-smoke-failure-v1",
    phase: "rollback",
    exit_status: 23,
    completed_steps: [{ name: "health", http_status: 200 }],
  });
  assert.equal(result.stderr, diagnostic);
  assert.ok(!diagnostic.includes("synthetic-secret"));
  const calls = await readFile(
    path.join(directory, "wrangler-calls.log"),
    "utf8",
  );
  assert.match(calls, /versions deploy .*synthetic-previous/);
  assert.doesNotMatch(calls, /synthetic-candidate/);
  await assert.rejects(readFile(path.join(directory, "qa-repromoted.json")), {
    code: "ENOENT",
  });
});
