import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";

// Each worker owns its unresolved fixture, including in the default CI matrix. The ordinary
// acceptance server and other field journeys keep their existing mode and mutable state.
const test = base.extend<object, { stopServer: string }>({
  stopServer: [
    // Playwright requires a destructuring fixture parameter even when no fixtures are needed.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const url = `http://127.0.0.1:${port}`;
      const server = spawn(process.execPath, ["scripts/acceptance-server.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          ACCEPTANCE_MODE: "field",
          ACCEPTANCE_PROTOCOL: "http1",
          ACCEPTANCE_SCOPE_UNRESOLVED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      server.stdout.on("data", (chunk) => (output += String(chunk)));
      server.stderr.on("data", (chunk) => (output += String(chunk)));
      const stopped = new Promise<void>((resolve) => {
        server.once("exit", () => resolve());
        server.once("error", (error) => {
          output += error.message;
          resolve();
        });
      });
      try {
        await expect
          .poll(() => {
            if (server.exitCode !== null) throw new Error(output);
            return output;
          })
          .toContain(`acceptance server listening at ${url}`);
        await provide(url);
      } finally {
        server.kill("SIGTERM");
        await stopped;
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ stopServer }, provide) => provide(stopServer),
});

const unresolvedMessage =
  "Work is stopped on every job. You reported a stop, and we couldn't tell which job it's for. The office is told.";
const deviceProof = "a".repeat(43);

test.beforeEach(async ({ request }) => {
  expect((await request.post("/__acceptance__/reset")).ok()).toBe(true);
});

function occurrencePayload() {
  return {
    kind: "report_occurrence",
    scope_type: "roof_job",
    scope_id: "JOB-ACCEPTANCE",
    captured_at: new Date().toISOString(),
    detail: "Ice on the north slope",
    occurrence_kind: "hazard",
    severity: "high",
  };
}

async function submit(request: APIRequestContext, id: string, payload: Record<string, unknown>) {
  return request.post("/api/v1/safety/actions", {
    headers: {
      "X-CSRF-Token": "acceptance-csrf",
      "X-Ironwrap-Device-Proof": deviceProof,
      "X-Device-Action-Id": id,
      "Idempotency-Key": id,
    },
    data: { device_action_id: id, payload },
  });
}

async function occurrences(request: APIRequestContext) {
  const response = await request.get("/api/v1/safety/panel");
  expect(response.ok()).toBe(true);
  return (await response.json()).panel.open_occurrences;
}

for (const example of [
  {
    name: "report",
    kind: "report_occurrence",
    id: "acceptance-regression-report",
    expectedId: "so_3bb3f7149a1796a34897b2cbba2baf42",
  },
  {
    name: "rescue",
    kind: "rescue_request",
    id: "acceptance-regression-rescue",
    expectedId: "so_77826961353890e60d5eedefe8c8f9d8",
  },
]) {
  test(`${example.name} identity matches Worker/PWA and retries keep one occurrence`, async ({
    request,
  }) => {
    const { occurrence_kind, severity, ...common } = occurrencePayload();
    const payload =
      example.kind === "rescue_request"
        ? { ...common, kind: example.kind }
        : { ...common, occurrence_kind, severity };
    const first = await submit(request, example.id, payload);
    expect(first.status()).toBe(200);
    const receipt = await first.json();
    // Known SHA-256 test vectors for these exact device action ids, not fixture-generated ids.
    expect(receipt.server_ref).toBe(example.expectedId);
    const replay = await submit(request, example.id, payload);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const conflict = await submit(request, example.id, { ...payload, detail: "Changed report" });
    expect(conflict.status()).toBe(409);
    expect(await occurrences(request)).toEqual([
      expect.objectContaining({ occurrence_id: example.expectedId, stop_active: true }),
    ]);
  });
}

for (const active of [true, false]) {
  test(`made-safe preserves stop_active=${active}`, async ({ request }) => {
    const payload = occurrencePayload();
    if (!active) {
      payload.scope_type = "shop";
      payload.scope_id = "SHOP-ACCEPTANCE";
      payload.severity = "low";
    }
    const raised = await submit(request, "acceptance-regression-state", payload);
    expect(raised.status()).toBe(200);
    const { server_ref: occurrenceId } = await raised.json();
    expect(await occurrences(request)).toEqual([
      expect.objectContaining({ occurrence_id: occurrenceId, stop_active: active }),
    ]);
    const safe = await submit(request, "acceptance-regression-safe", {
      kind: "make_safe",
      scope_type: payload.scope_type,
      scope_id: payload.scope_id,
      captured_at: payload.captured_at,
      detail: "Kept the crew away from the hazard",
      occurrence_id: occurrenceId,
    });
    expect(safe.status()).toBe(200);
    expect(await occurrences(request)).toEqual([
      expect.objectContaining({
        occurrence_id: occurrenceId,
        state: "made_safe",
        stop_active: active,
      }),
    ]);
  });
}

async function raiseFromPairedPhone(page: Page) {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
  await page.evaluate(async (proof) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ironwrap-os");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put({
          key: "field-device-secret-v1",
          value: { value: proof, createdAt: Date.now() },
          updatedAt: Date.now(),
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, deviceProof);
  await page.goto("/jobs/JOB-ACCEPTANCE");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page
    .getByLabel("What is unsafe (optional)", { exact: true })
    .fill("Ice on the north slope");
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/safety/actions") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send stop report" }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.scope_unresolved).toBe(true);
  await expect(page.getByText(unresolvedMessage, { exact: true })).toBeVisible();
  return receipt.server_ref as string;
}

async function reopenHelp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Help" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/safety/panel"),
  );
  await page.getByRole("button", { name: "Help", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  // Wait for the real panel response to settle before checking the persisted stop, not its
  // optimistic first render while the read is still on the way.
  await page.waitForLoadState("networkidle");
  await expect(dialog.getByText(unresolvedMessage, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send stop report" })).toHaveCount(0);
}

test("unresolved S21 persists after Done and reopening Help without release", async ({
  page,
  request,
}) => {
  const occurrenceId = await raiseFromPairedPhone(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "I've made the area safe" })).toBeVisible();
  await reopenHelp(page);
  expect(await occurrences(request)).toEqual([
    expect.objectContaining({ occurrence_id: occurrenceId, state: "reported", stop_active: true }),
  ]);
});

test("made-safe unresolved stop remains active on panel read and reopening Help", async ({
  page,
  request,
}) => {
  const occurrenceId = await raiseFromPairedPhone(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByLabel("What you did (optional)", { exact: true })
    .fill("Kept the crew away from the north slope");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/safety/actions") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "I've made the area safe" }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().payload.occurrence_id).toBe(occurrenceId);
  await expect(page.getByRole("button", { name: "I've made the area safe" })).toHaveCount(0);
  expect(await occurrences(request)).toEqual([
    expect.objectContaining({ occurrence_id: occurrenceId, state: "made_safe", stop_active: true }),
  ]);
  await reopenHelp(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "I've made the area safe" })).toHaveCount(0);
  await expect(
    page.getByText("This doesn't restart work. The office releases the stop.", { exact: true }),
  ).toBeVisible();
});
