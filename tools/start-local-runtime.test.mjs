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

test("the ERP MCP receives a stable local tenant", () => {
  assert.match(
    launcher,
    /ERPNEXT_TENANT_ID="\$\{ERPNEXT_TENANT_ID:-ironwrap\}"/,
  );

  const mcpStart = launcher.indexOf('start_service "erpnext-roofing-mcp"');
  assert.notEqual(mcpStart, -1);
  assert.match(
    launcher.slice(mcpStart),
    /env ERPNEXT_BASE_URL=.*ERPNEXT_TENANT_ID="\$ERPNEXT_TENANT_ID"/s,
  );
});

test("the launcher waits for the stub and forwards one Worker port plus the default tenant", async (t) => {
  const workspace = mkdtempSync(
    join(tmpdir(), "ironwrap-runtime-launcher-test-"),
  );
  const receipt = join(workspace, "npm-receipt.log");
  writeFileSync(
    join(workspace, "npm"),
    [
      "#!/bin/sh",
      'printf "%s|%s|%s\\n" "$PWD" "$*" "${ERPNEXT_TENANT_ID-}" >> "$IRONWRAP_RUNTIME_TEST_RECEIPT"',
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
  };
  delete environment.ERPNEXT_TENANT_ID;
  const child = spawn("/bin/bash", [launcherPath], {
    cwd: root,
    detached: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([once(child, "exit"), delay(2_000)]);
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  for (
    let attempt = 0;
    attempt < 100 && !output.includes("All services started.");
    attempt += 1
  ) {
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.match(
    output,
    /erpnext-stub ready[\s\S]*Starting: erpnext-roofing-mcp/,
  );
  assert.match(output, /All services started\./);

  const launches = readFileSync(receipt, "utf8").trim().split("\n");
  const worker = launches.find((line) =>
    line.startsWith(`${join(root, "workers-bus")}|`),
  );
  assert.equal(worker, `${join(root, "workers-bus")}|run dev|`);
  const erpMcp = launches.find((line) =>
    line.startsWith(`${join(root, "mcp", "erpnext-roofing-mcp")}|`),
  );
  assert.equal(
    erpMcp,
    `${join(root, "mcp", "erpnext-roofing-mcp")}|start|ironwrap`,
  );
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
