import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/replay/cli.ts", import.meta.url));

// No sign-in file and the kill switch on: even a regression past the checks reaches no provider.
function cli(dir: string, args: string[], envFile = join(dir, "absent.env")) {
  const env = { ...process.env, AGENT_HOST_ENV_FILE: envFile, CODEX_HOME: join(dir, "codex"), AGENT_HOST_KILL: "1" };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

test("qualify refuses to start without exactly one explicit start or resume flag", (t) => {
  const dir = tempDir(t);
  const output = join(dir, "out");
  for (const args of [
    ["qualify", "--stage", "pilot"],
    ["qualify", "--stage", "pilot", "--start", "--resume"],
    ["qualify", "--start"],
    ["qualify", "--stage", "wave9", "--start"],
    ["qualify", "--stage", "pilot", "--start", "--case", "x"],
    ["replay", "--specialist", "orchestrator"],
    ["replay", "--specialist", "orchestrator", "--case", "orchestrator.golden.001", "--resume"],
    ["evaluate"],
  ]) {
    const result = cli(dir, [...args, "--output", output]);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage: npm run qualify/);
  }
  assert.match(cli(dir, ["qualify", "--stage", "pilot", "--output", output]).stderr, /starts or resumes only on an explicit signal/);
  assert.equal(existsSync(output), false);
});

test("qualify refuses a second start, and a resume before the paused stage's retry time", (t) => {
  const dir = tempDir(t);
  const output = join(dir, "out");
  mkdirSync(join(output, "pilot"), { recursive: true });
  const state = { stage: "pilot", status: "paused", halts: [{ reason: "rate_limited" }], retry_at: Date.now() + 3_600_000 };
  writeFileSync(join(output, "pilot", "state.json"), JSON.stringify(state));
  const started = cli(dir, ["qualify", "--stage", "pilot", "--start", "--output", output]);
  assert.equal(started.status, 2, started.stderr);
  assert.match(started.stderr, /has started already; resume it with --resume/);
  const early = cli(dir, ["qualify", "--stage", "pilot", "--resume", "--output", output]);
  assert.equal(early.status, 3, early.stderr);
  assert.match(early.stderr, /stage pilot cannot resume before .* \(rate_limited\)/);
  assert.deepEqual(readdirSync(join(output, "pilot")), ["state.json"]);
});

test("the stage and the eval tree are checked before any sign-in is read, and a sign-in failure is a one-line refusal", (t) => {
  const dir = tempDir(t);
  const output = join(dir, "out");
  // applyLocalEnv refuses a sign-in file that others may read, so reaching it shows in the message.
  const envFile = join(dir, "agent-host.env");
  writeFileSync(envFile, "SYNTHETIC_SETTING=1\n");
  chmodSync(envFile, 0o644);
  const unknown = cli(dir, ["qualify", "--stage", "wave9", "--start", "--output", output], envFile);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /^unknown stage wave9; stages: pilot, wave1, wave2, wave3\n/);
  const nobody = cli(dir, ["replay", "--specialist", "synthetic_nobody", "--case", "synthetic.golden.001", "--output", output], envFile);
  assert.equal(nobody.status, 2, nobody.stderr);
  assert.match(nobody.stderr, /^unknown specialist synthetic_nobody\n/);
  const signIn = cli(dir, ["qualify", "--stage", "pilot", "--start", "--output", output], envFile);
  assert.equal(signIn.status, 2, signIn.stderr);
  assert.match(signIn.stderr, /^cannot read the local sign-ins: .*agent-host\.env must be readable by its owner only \(chmod 600\)\n/);
  assert.doesNotMatch(signIn.stderr, /\n\s+at /);
  assert.equal(existsSync(output), false);
});

test("a single-case replay names unchecked mapped catastrophes on stderr and in its result line", (t) => {
  const dir = tempDir(t);
  const result = cli(dir, ["replay", "--specialist", "orchestrator", "--case", "orchestrator.golden.001", "--output", join(dir, "out")]);
  assert.equal(result.status, 4, result.stderr);
  const line = JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as { event: string; warnings: string[] };
  assert.equal(line.event, "replay");
  const mapped = existsSync(fileURLToPath(new URL("../evals/action-catastrophes.v1.json", import.meta.url)));
  assert.equal(line.warnings.length, mapped ? 0 : 1);
  assert.equal(/^warning: Mapped catastrophes were not checked/m.test(result.stderr), !mapped);
});
