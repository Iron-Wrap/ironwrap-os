// The long-running host: two independent loops.
//
// Work loop: retry pending closes, pull signals after the persisted cursor, run them with bounded
// concurrency, and advance the cursor only once the whole batch is handled (runs are idempotent by
// host_run_key, so a failure or restart re-delivers at most one batch).
//
// Heartbeat loop: every poll interval, whatever the work loop is doing, sample the gateway's health
// and the host's backlog and send them to the Worker, so a sign-in that stopped refreshing, or a
// close the Worker keeps refusing, reaches the owner while long runs are still in flight.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GatewayHealth } from "../gateway/gateway.ts";
import { closeBacklog, retryPendingCloses, runSignal, type CloseBacklog, type RunnerOptions } from "./runner.ts";
import type { Signal, WorkerClient } from "./worker.ts";

type ServiceWorker = RunnerOptions["worker"] & Pick<WorkerClient, "signals" | "heartbeat">;

export interface ServiceOptions extends RunnerOptions {
  worker: ServiceWorker;
  health: () => Promise<GatewayHealth>;
  hostId: string;
  version: string;
  pollMs: number;
  batchSize: number;
  concurrency: number;
  now?: () => number;
}

export interface HostStatus {
  ready: boolean;
  alerts: string[];
  workerReachable: boolean;
  lastWorkerContactAt: number | null;
  lastPollError: string | null;
  inFlight: number;
  backlog: CloseBacklog;
  gateway: GatewayHealth;
}

export class AgentHostService {
  private readonly options: ServiceOptions;
  private readonly runnerOptions: RunnerOptions;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private cursor: string | null;
  private lastWorkerContactAt: number | null = null;
  private lastPollError: string | null = null;
  private inFlight = 0;
  private loops: Promise<void>[] = [];

  constructor(options: ServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // Any Worker answer, from a poll, a run open or close, or a heartbeat, proves reachability.
    const contact = <T>(call: Promise<T>) =>
      call.then((value) => {
        this.lastWorkerContactAt = this.now();
        return value;
      });
    const worker = options.worker;
    this.runnerOptions = {
      ...options,
      worker: {
        openRun: (body) => contact(worker.openRun(body)),
        closeRun: (runId, body) => contact(worker.closeRun(runId, body)),
      },
    };
    const file = join(options.stateDir, "signal-cursor");
    this.cursor = existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.loops = [this.every(() => this.tick()), this.every(() => this.heartbeat())];
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.loops);
  }

  /** One pass of the work loop. */
  async tick(): Promise<void> {
    try {
      await retryPendingCloses(this.runnerOptions);
      const { signals, next_cursor } = await this.options.worker.signals(this.cursor, this.options.batchSize);
      this.lastWorkerContactAt = this.now();
      await this.dispatch(signals);
      if (next_cursor && next_cursor !== this.cursor) this.saveCursor(next_cursor);
      // Cleared only once a whole batch got through, so a batch that keeps failing slowly does not
      // flip readiness back and forth.
      this.lastPollError = null;
    } catch (error) {
      this.lastPollError = error instanceof Error ? error.message : String(error);
      this.options.log({ event: "batch_failed", error: this.lastPollError });
    }
  }

  /** One heartbeat, with health sampled just before it is sent. Never throws. */
  async heartbeat(): Promise<void> {
    try {
      const status = await this.status();
      await this.options.worker.heartbeat({
        host_id: this.options.hostId,
        version: this.options.version,
        ready: status.ready,
        // Reaching the Worker is what this call proves; the alert would only mislead it.
        alerts: status.alerts.filter((alert) => alert !== "worker_unreachable"),
        providers: status.gateway.providers,
        in_flight: status.inFlight,
        backlog: {
          pending_closes: status.backlog.pending,
          oldest_pending_ms: status.backlog.oldestPendingMs,
          rejected_closes: status.backlog.rejectedCloses,
          rejected_signals: status.backlog.rejectedSignals,
        },
      });
      this.lastWorkerContactAt = this.now();
    } catch (error) {
      this.options.log({ event: "heartbeat_failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async status(): Promise<HostStatus> {
    const gateway = await this.options.health();
    const backlog = closeBacklog(this.options.stateDir, this.now());
    const window = this.options.pollMs * 3;
    const workerReachable = this.lastWorkerContactAt !== null && this.now() - this.lastWorkerContactAt <= window;
    const alerts = [...gateway.alerts];
    if (!workerReachable) alerts.push("worker_unreachable");
    // A batch that keeps failing stalls the feed even while heartbeats get through.
    if (this.lastPollError !== null) alerts.push("batch_failing");
    if (backlog.oldestPendingMs !== null && backlog.oldestPendingMs > window) alerts.push("closes_pending");
    if (backlog.rejectedCloses > 0) alerts.push("closes_rejected");
    if (backlog.rejectedSignals > 0) alerts.push("signals_rejected");
    return {
      ready: gateway.ready && workerReachable && this.lastPollError === null,
      alerts,
      workerReachable,
      lastWorkerContactAt: this.lastWorkerContactAt,
      lastPollError: this.lastPollError,
      inFlight: this.inFlight,
      backlog,
      gateway,
    };
  }

  private async every(step: () => Promise<void>): Promise<void> {
    while (!this.abort.signal.aborted) {
      await step();
      try {
        await sleep(this.options.pollMs, undefined, { signal: this.abort.signal });
      } catch {
        return;
      }
    }
  }

  private async dispatch(signals: Signal[]): Promise<void> {
    const queue = [...signals];
    const workers = Array.from({ length: Math.min(this.options.concurrency, queue.length) }, async () => {
      for (let signal = queue.shift(); signal; signal = queue.shift()) {
        if (this.abort.signal.aborted) throw new Error("host stopping");
        this.inFlight += 1;
        try {
          await runSignal(this.runnerOptions, signal, this.abort.signal);
        } finally {
          this.inFlight -= 1;
        }
      }
    });
    // Let every in-flight run finish; any failure (including a stop) leaves the cursor where it
    // was, so the batch is re-delivered and already-closed runs are skipped by their host_run_key.
    const failed = (await Promise.allSettled(workers)).find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  private saveCursor(cursor: string): void {
    const file = join(this.options.stateDir, "signal-cursor");
    writeFileSync(`${file}.tmp`, cursor);
    renameSync(`${file}.tmp`, file);
    this.cursor = cursor;
  }
}
