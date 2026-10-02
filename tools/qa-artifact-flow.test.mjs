import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
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

const execute = promisify(execFile);
const workflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
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

async function runStep(workflow, name, directory) {
  try {
    const result = await execute("bash", ["-c", stepScript(workflow, name)], {
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        RELEASE_ENFORCER: enforcer,
      },
      timeout: 10_000,
    });
    return { status: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
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
