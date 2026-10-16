import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Pins the governed qa dead-letter inspection (.github/workflows/qa-dead-letter.yml): manual
// dispatch only, in the qa environment, behind Deploy's qa group, and read-only. Replay is absent
// until an approval step that code verifies exists; an agent holding the owner's token must not
// be able to record a person's approval by dispatching a run.
const workflow = await readFile(new URL("../.github/workflows/qa-dead-letter.yml", import.meta.url), "utf8");
const body = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const runBlocks = [...body.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((match) => match[1]);

test("runs only by manual dispatch, in the qa environment, queued behind Deploy's qa group", () => {
  assert.match(body, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(body, /^\s+(push|pull_request|schedule|workflow_run|inputs):/m);
  assert.match(body, /environment: qa\n/);
  assert.match(body, /concurrency:\n  group: deploy-qa\n  cancel-in-progress: false/);
  assert.match(body, /permissions:\n  contents: read\n/);
});

test("only reads: no replay, no request body, no write method", () => {
  assert.doesNotMatch(body, /admin\/replay|--data|-X POST|--request|approved_by/);
  assert.equal(runBlocks.length, 1, "only the inspection script may run");
  const gets = [...body.matchAll(/get "?([^"\s)]+)/g)].map((match) => match[1]);
  assert.ok(gets.length >= 3, `expected the three admin reads, found ${gets.join(", ")}`);
});

test("the admin bearer reaches only the inspection step, through env", () => {
  assert.equal((body.match(/secrets\.RELEASE_QA_ADMIN_TOKEN/g) ?? []).length, 1);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/);
});

async function inspect(t, { envelopeId = "ow_synthetic01", withoutBearer = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ironwrap-qa-inspect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = path.join(directory, "summary.md");
  const requests = path.join(directory, "requests.jsonl");
  const payload = "synthetic-private-payload";
  const fixtureBearer = randomUUID();
  await writeFile(summary, "");
  await writeFile(requests, "");
  await writeFile(path.join(directory, "status.json.fixture"), JSON.stringify({
    counts: { dead_letters: 2, queued: 0 },
    recent_audit: [{ payload }],
  }));
  await writeFile(path.join(directory, "dead.json.fixture"), JSON.stringify({
    dead_letters: [
      { envelope_id: null, stage: "measurement", error: "review_required", ts: "recorded" },
      { envelope_id: envelopeId, stage: "crm", error: "dependency_unavailable", ts: "recorded", payload },
    ],
  }));
  await writeFile(path.join(directory, "envelope.json.fixture"), JSON.stringify({
    envelope: { status: "dead", source: "jotform", jn_contact_id: "synthetic-legacy-contact", jn_job_id: null, payload },
  }));
  await writeFile(path.join(directory, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let url;
while (args.length) {
  const arg = args.shift();
  if (["--fail-with-body", "--silent", "--show-error"].includes(arg)) continue;
  if (arg === "--max-time" && args.shift() === "20") continue;
  if (arg === "--header" && args.shift() === "Authorization: Bearer " + process.env.INSPECTION_EXPECTED_BEARER) continue;
  if (arg.startsWith("https://qa.example.invalid/")) { url = new URL(arg); continue; }
  throw new Error("unexpected curl argument");
}
if (!url) throw new Error("missing inspection URL");
fs.appendFileSync(process.env.INSPECTION_REQUESTS, JSON.stringify({ method: "GET", path: url.pathname + url.search }) + "\\n");
const fixture = url.pathname === "/admin/status" ? "status" :
  url.pathname === "/admin/dead-letter" ? "dead" :
  url.pathname === "/admin/envelope/ow_synthetic01" ? "envelope" : null;
if (!fixture) throw new Error("unexpected inspection URL");
process.stdout.write(fs.readFileSync(path.join(process.env.INSPECTION_FIXTURES, fixture + ".json.fixture")));
`, { mode: 0o755 });
  assert.equal(runBlocks.length, 1);
  const result = spawnSync("bash", ["-c", runBlocks[0]], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      ADMIN_TOKEN: withoutBearer ? "" : fixtureBearer,
      QA_BASE_URL: "https://qa.example.invalid",
      GITHUB_STEP_SUMMARY: summary,
      INSPECTION_REQUESTS: requests,
      INSPECTION_FIXTURES: directory,
      INSPECTION_EXPECTED_BEARER: fixtureBearer,
    },
  });
  assert.ifError(result.error);
  const log = (await readFile(requests, "utf8")).trim();
  return {
    ...result,
    requests: log ? log.split("\n").map((line) => JSON.parse(line)) : [],
    summary: await readFile(summary, "utf8"),
    payload,
    fixtureBearer,
  };
}

test("inspection reads the real response shapes, skips unbound rows and omits private fields", async (t) => {
  const result = await inspect(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.requests, [
    { method: "GET", path: "/admin/status" },
    { method: "GET", path: "/admin/dead-letter?limit=100" },
    { method: "GET", path: "/admin/envelope/ow_synthetic01" },
  ]);
  assert.match(result.summary, /dead_letters: 2/);
  assert.match(result.summary, /ow_synthetic01: status=dead source=jotform jn_contact=set jn_job=none/);
  for (const privateValue of [result.payload, result.fixtureBearer, "synthetic-legacy-contact"]) {
    assert.ok(!result.summary.includes(privateValue));
    assert.ok(!(result.stdout + result.stderr).includes(privateValue));
  }
});

test("inspection rejects an invalid envelope id before making another request", async (t) => {
  const result = await inspect(t, { envelopeId: "../replay" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected envelope id shape/);
  assert.equal(result.requests.length, 2);
});

test("inspection without its admin bearer fails before any request", async (t) => {
  const result = await inspect(t, { withoutBearer: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release_qa_admin_token_missing/);
  assert.deepEqual(result.requests, []);
});
