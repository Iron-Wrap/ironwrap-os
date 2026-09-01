import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = join(root, "start-local-runtime.sh");
const stubPath = join(root, "deploy", "local", "erpnext-stub.mjs");
const launcher = readFileSync(launcherPath, "utf8");
const workerPackage = JSON.parse(
  readFileSync(join(root, "workers-bus", "package.json"), "utf8"),
);

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

async function launchRuntime(t, extraEnvironment = {}) {
  const workspace = mkdtempSync(
    join(tmpdir(), "ironwrap-runtime-launcher-test-"),
  );
  const receipt = join(workspace, "npm-receipt.log");
  writeFileSync(
    join(workspace, "npm"),
    [
      "#!/bin/sh",
      'printf "%s|%s|%s\\n" "$PWD" "$*" "${ERPNEXT_TENANT_ID-}" >> "$IRONWRAP_RUNTIME_TEST_RECEIPT"',
      'if [ "${IRONWRAP_RUNTIME_TEST_FAIL_CWD-}" = "$PWD" ]; then',
      '  echo "synthetic child exit for $PWD" >&2',
      '  exit "${IRONWRAP_RUNTIME_TEST_FAIL_STATUS:-0}"',
      "fi",
      "exec /bin/sleep 30",
    ].join("\n"),
    { mode: 0o755 },
  );

  const stubPort = await freePort();
  let busPort = await freePort();
  while (busPort === stubPort) busPort = await freePort();

  const environment = {
    ...process.env,
    PATH: `${workspace}:${dirname(process.execPath)}:${process.env.PATH}`,
    IRONWRAP_ADMIN_TOKEN: "synthetic-local-test-token",
    IRONWRAP_LOCAL_APPROVAL_BROKERS: "off",
    IRONWRAP_RUNTIME_TEST_RECEIPT: receipt,
    ERPNEXT_STUB_PORT: String(stubPort),
    ERPNEXT_STUB_USER: "owner@example.invalid",
    HERMES_BUS_PORT: String(busPort),
    ...extraEnvironment,
  };
  delete environment.ERPNEXT_TENANT_ID;
  const child = spawn("/bin/bash", [launcherPath], {
    cwd: root,
    detached: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  t.after(async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (child.exitCode === null) {
      await Promise.race([exited, delay(2_000, undefined, { ref: false })]);
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  return { child, exited, receipt, output: () => output };
}

test("the Worker package owns the one local port argument", () => {
  assert.match(
    workerPackage.scripts.dev,
    /--port \$\{IRONWRAP_LOCAL_WORKER_PORT:-7100\}/,
  );
  assert.match(
    launcher,
    /export IRONWRAP_LOCAL_WORKER_PORT="\$HERMES_BUS_PORT"/,
  );
  assert.match(launcher, /npm run dev\s*$/m);
  assert.doesNotMatch(launcher, /npm run dev -- --port/);
});

test("the launcher waits for the stub, forwards one Worker port, and leaves stdio MCPs to their client", async (t) => {
  const runtime = await launchRuntime(t);

  for (
    let attempt = 0;
    attempt < 100 && !runtime.output().includes("All services started.");
    attempt += 1
  ) {
    if (runtime.child.exitCode !== null) break;
    await delay(100);
  }
  assert.match(
    runtime.output(),
    /erpnext-stub ready[\s\S]*Starting: workers-bus/,
  );
  assert.match(runtime.output(), /All services started\./);

  let launches = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      launches = readFileSync(runtime.receipt, "utf8").trim().split("\n");
    } catch {
      launches = [];
    }
    if (
      launches.some((line) => line.startsWith(`${join(root, "workers-bus")}|`)) &&
      launches.some((line) => line.startsWith(`${join(root, "app")}|`))
    ) {
      break;
    }
    await delay(50);
  }
  const worker = launches.find((line) =>
    line.startsWith(`${join(root, "workers-bus")}|`),
  );
  assert.equal(worker, `${join(root, "workers-bus")}|run dev|`);
  assert.equal(
    launches.some((line) => line.startsWith(`${join(root, "mcp")}/`)),
    false,
    "stdio MCP servers must be spawned by an MCP client, not supervised as daemons",
  );
});

test("a required child exit fails the supervisor with its service name and log", async (t) => {
  const runtime = await launchRuntime(t, {
    IRONWRAP_RUNTIME_TEST_FAIL_CWD: join(root, "app"),
    IRONWRAP_RUNTIME_TEST_FAIL_STATUS: "0",
  });
  const [code, signal] = await Promise.race([
    runtime.exited,
    delay(10_000, undefined, { ref: false }).then(() => {
      throw new Error(
        `supervisor stayed alive after app exited: ${runtime.output()}`,
      );
    }),
  ]);

  assert.equal(signal, null);
  assert.equal(code, 1, runtime.output());
  assert.match(
    runtime.output(),
    /ERROR: required service app exited unexpectedly with status 0\./,
  );
  assert.match(runtime.output(), /\.runtime-logs\/app\.log/);
});

test("the local ERP stub serves actor attestation and resource reads", async (t) => {
  const child = spawn(process.execPath, [stubPath], {
    cwd: root,
    env: {
      ...process.env,
      ERPNEXT_STUB_PORT: "0",
      ERPNEXT_STUB_USER: "owner@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => {
      throw new Error(`ERP stub exited ${code}: ${stderr}`);
    }),
    delay(5_000).then(() => {
      throw new Error("ERP stub did not become ready within 5 seconds");
    }),
  ]);

  const match = stdout.match(
    /stub ERPNext server on http:\/\/127\.0\.0\.1:(\d+)/,
  );
  assert.ok(match, `missing readiness line: ${stdout}${stderr}`);
  const origin = `http://127.0.0.1:${match[1]}`;

  const actor = await fetch(`${origin}/api/method/frappe.auth.get_logged_user`);
  assert.equal(actor.status, 200);
  assert.deepEqual(await actor.json(), { message: "owner@example.invalid" });

  const resources = await fetch(`${origin}/api/resource/Lead`);
  assert.equal(resources.status, 200);
  assert.deepEqual(await resources.json(), { data: [] });

  const missing = await fetch(`${origin}/not-a-frappe-route`);
  assert.equal(missing.status, 404);
});
