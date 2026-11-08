import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { AgentHostService } from "../src/host/service.ts";
import { TenantBinding } from "../src/host/tenant.ts";
import type { GatewayHealth } from "../src/gateway/gateway.ts";
import type { WorkerTenant } from "../src/host/worker.ts";
import { tempDir } from "./helpers.ts";
import { fakeWorker, okResult, openedRun, signal, specialistsRoot } from "./host-helpers.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const READY: GatewayHealth = {
  ready: true, killed: false, alerts: [], providers: {} as GatewayHealth["providers"],
  usage: { teams: { live: { calls: 0, costUsd: 0 }, shadow: { calls: 0, costUsd: 0 }, eval: { calls: 0, costUsd: 0 } }, specialists: {} },
};

for (const mismatch of ["tenant", "data_class"] as const) {
  test(`an in-flight matching heartbeat cannot clear a concurrent ${mismatch} run refusal`, { timeout: 5000 }, async (t) => {
    const stateDir = tempDir(t);
    const matching = { tenant_id: "tenant-a", data_class: "synthetic" as const };
    const refused = deferred<void>();
    const gatewayStarted = deferred<void>();
    const finishGateway = deferred<void>();
    const heartbeatStarted = deferred<void>();
    const heartbeatReply = deferred<WorkerTenant | null>();
    const events: Array<Record<string, unknown>> = [];
    const log = (event: Record<string, unknown>) => {
      events.push(event);
      if (event.event === `${mismatch}_mismatch`) refused.resolve();
    };
    const worker = fakeWorker();
    worker.openRun = async (body) => {
      worker.opened.push(body);
      return openedRun(body.signal_id === "sig_refused"
        ? { run_id: "run_0000000001", ...(mismatch === "tenant" ? { tenant_id: "tenant-b", data_class: "synthetic" } : { tenant_id: "tenant-a", data_class: "business" }) }
        : { run_id: "run_0000000002", ...matching });
    };
    worker.heartbeat = async (body) => {
      worker.heartbeats.push(body);
      heartbeatStarted.resolve();
      return heartbeatReply.promise;
    };
    let gatewayCalls = 0;
    const host = new AgentHostService({
      worker, stateDir, tenant: new TenantBinding("tenant-a", stateDir, log, "synthetic"),
      specialistsRoot: specialistsRoot(t),
      gateway: { async run(request) { gatewayCalls += 1; gatewayStarted.resolve(); await finishGateway.promise; return okResult(request); } },
      actionServer: () => ({ command: "node", args: ["private-unused-adapter.mjs"], env: {}, passEnv: [] }),
      log, closeAttempts: 1, closeBackoffMs: 1, health: async () => READY,
      hostId: "private-readiness-host", version: "private", pollMs: 100000, batchSize: 2, concurrency: 2,
    });
    worker.batches.push({ signals: [], next_cursor: null, ...matching });
    await host.tick();
    assert.equal((await host.status()).ready, true);
    const heartbeat = host.heartbeat();
    await heartbeatStarted.promise;
    worker.batches.push({ signals: [signal({ signal_id: "sig_refused" }), signal({ signal_id: "sig_matching" })], next_cursor: "after-batch", ...matching });
    const tick = host.tick();
    try {
      await Promise.all([refused.promise, gatewayStarted.promise]);
      await setImmediate();
      const during = await host.status();
      assert.equal(during.inFlight, 1);
      assert.equal(during.ready, false, "known run-open mismatch must immediately revoke readiness before a peer finishes");
      assert.ok(during.alerts.includes(`${mismatch}_mismatch`));
      assert.equal(gatewayCalls, 1, "only the matching peer reaches the fake gateway");
      heartbeatReply.resolve(matching);
      await heartbeat;
      const late = await host.status();
      assert.equal(late.ready, false, "a previously started matching heartbeat cannot clear a later refusal");
      assert.ok(late.alerts.includes(`${mismatch}_mismatch`));
      assert.equal(late.inFlight, 1);
      await host.heartbeat();
      assert.equal(worker.heartbeats.length, 1, "new heartbeats stay suppressed while the mismatch is latched");
    } finally {
      heartbeatReply.resolve(matching);
      finishGateway.resolve();
      await Promise.allSettled([heartbeat, tick]);
    }
    assert.equal(gatewayCalls, 1);
    assert.equal((await host.status()).ready, false);
    assert.ok(events.some((event) => event.event === "batch_failed"));
    worker.batches.push({ signals: [], next_cursor: null, ...matching });
    await host.tick();
    assert.equal((await host.status()).ready, true, "a new matching batch restores readiness");
    assert.ok(!(await host.status()).alerts.includes(`${mismatch}_mismatch`));
  });
}
