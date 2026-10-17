// One signal, one specialist, one coordination run: open the run on the Worker (which builds the
// context snapshot and the run's tool list, and may name the run under review, the expected
// action and a shadow mode), load the specialist, call the gateway with only the tools both the
// Worker and the allowlist permit, and close the run with the exact outcome and route. An
// abstention closes the run too, so every receipt says why nothing happened.
//
// Durability: the close body is written to `pending-closes/` before it is sent and removed once
// the Worker has it, so a crash cannot lose a finished run, and a re-delivered signal whose close
// is still pending is never run through the model again. A run interrupted by the host stopping is
// left open, so the re-delivered signal resumes it after the restart.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../gateway/schema.ts";
import type { GatewayRequest, GatewayResult, McpStdioServer } from "../gateway/types.ts";
import { buildRunInput } from "./prompt.ts";
import { loadSpecialist } from "./specialists.ts";
import { WorkerError, type OpenedRun, type RunClose, type Signal, type WorkerClient } from "./worker.ts";

export type WorkerLike = Pick<WorkerClient, "openRun" | "closeRun">;
export interface GatewayLike {
  run(request: GatewayRequest): Promise<GatewayResult>;
}

export interface RunnerOptions {
  gateway: GatewayLike;
  worker: WorkerLike;
  specialistsRoot: string;
  stateDir: string;
  /** The stdio action server for one run, exposing only these catalog actions. */
  actionServer: (runId: string, actionIds: string[]) => McpStdioServer;
  log: (event: Record<string, unknown>) => void;
  closeAttempts?: number;
  closeBackoffMs?: number;
}

export type RunOutcome =
  | { status: "skipped" | "rejected" | "recovered"; signal_id: string }
  | { status: "ok" | "abstained"; signal_id: string; run_id: string; reason: string | null; closed: boolean };

/** The host is stopping; the run stays open and the signal is re-delivered after the restart. */
export class HostStopping extends Error {
  constructor() {
    super("host stopping");
    this.name = "HostStopping";
  }
}

const PENDING = "pending-closes";
const REJECTED_CLOSES = "rejected-closes";
const REJECTED_SIGNALS = "rejected-signals.jsonl";

export async function runSignal(options: RunnerOptions, signal: Signal, abort?: AbortSignal): Promise<RunOutcome> {
  let run: OpenedRun;
  try {
    run = await options.worker.openRun({
      signal_id: signal.signal_id,
      specialist_id: signal.specialist_id,
      host_run_key: sha256(`${signal.signal_id}:${signal.specialist_id}`).slice(0, 40),
    });
  } catch (error) {
    // A run the Worker already closed (a re-delivered signal) is done. A refusal the Worker will
    // repeat is dead-lettered so it cannot stall every later signal; anything else is retried with
    // the batch on the next poll.
    if (error instanceof WorkerError && error.status === 409) return { status: "skipped", signal_id: signal.signal_id };
    if (error instanceof WorkerError && !retryable(error)) {
      appendFileSync(
        join(options.stateDir, REJECTED_SIGNALS),
        `${JSON.stringify({ status: error.status, code: error.code, signal })}\n`,
      );
      options.log({ event: "signal_rejected", signal_id: signal.signal_id, status: error.status, code: error.code });
      return { status: "rejected", signal_id: signal.signal_id };
    }
    throw error;
  }

  if (existsSync(pendingPath(options.stateDir, run.run_id))) {
    // The model already answered for this run; only its close is outstanding.
    await sendPendingClose(options, pendingPath(options.stateDir, run.run_id));
    return { status: "recovered", signal_id: signal.signal_id };
  }

  // A Worker that sends any routing field also accepts them back in the close.
  const routed = ["review_of", "expected_action_id", "mode"].some((field) => Object.hasOwn(run, field));
  const reviewOf = run.review_of ?? null;
  const action = run.expected_action_id ?? null;
  // Unset reads as live. A mode this host does not know is refused, never guessed: it could stand
  // for any budget.
  const declared: unknown = run.mode ?? "live";
  const mode = declared === "live" || declared === "shadow" ? declared : null;
  let body: RunClose;
  if (mode === null) {
    body = abstainedBody("unknown_run_mode", `the Worker opened the run in mode ${JSON.stringify(declared).slice(0, 40)}, which this host does not know`);
  } else {
    try {
      const specialist = await loadSpecialist(options.specialistsRoot, signal.specialist_id);
      const allowlisted = new Set(specialist.allowlist.map((entry) => entry.action_id));
      const tools = run.tools.filter((tool) => allowlisted.has(tool.action_id));
      const input = buildRunInput(specialist, run, signal, tools);
      const result = await options.gateway.run({
        specialist: specialist.id,
        tier: specialist.tier,
        scope: mode === "shadow" ? "shadow" : "production",
        ...(reviewOf ? { reviewOf: { runId: reviewOf.run_id, provider: reviewOf.provider } } : {}),
        ...(action ? { action } : {}),
        system: input.system,
        prompt: input.prompt,
        outputSchema: input.outputSchema,
        ...(tools.length > 0
          ? {
              tools: {
                server: options.actionServer(
                  run.run_id,
                  tools.map((tool) => tool.action_id),
                ),
                allowed: tools.map((tool) => tool.tool_name),
              },
            }
          : {}),
        ...(abort ? { signal: abort } : {}),
      });
      body = closeBody(result, routed ? mode : null);
    } catch (error) {
      body = abstainedBody("specialist_unavailable", error instanceof Error ? error.message : String(error));
    }
  }
  if (abort?.aborted) throw new HostStopping();

  const file = pendingPath(options.stateDir, run.run_id);
  mkdirSync(join(options.stateDir, PENDING), { recursive: true });
  writeAtomic(file, JSON.stringify({ run_id: run.run_id, body }));
  const closed = await sendPendingClose(options, file);
  options.log({
    event: "run_closed",
    run_id: run.run_id,
    signal_id: signal.signal_id,
    specialist_id: signal.specialist_id,
    status: body.status,
    reason: body.reason,
    closed,
  });
  return { status: body.status, signal_id: signal.signal_id, run_id: run.run_id, reason: body.reason, closed };
}

/** Closes that failed earlier are retried before new work. */
export async function retryPendingCloses(options: RunnerOptions): Promise<number> {
  const dir = join(options.stateDir, PENDING);
  if (!existsSync(dir)) return 0;
  let sent = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    if (await sendPendingClose({ ...options, closeAttempts: 1 }, join(dir, name))) sent += 1;
  }
  return sent;
}

export interface CloseBacklog {
  pending: number;
  oldestPendingMs: number | null;
  rejectedCloses: number;
  rejectedSignals: number;
}

export function closeBacklog(stateDir: string, now: number): CloseBacklog {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".json")) : []);
  const pending = list(join(stateDir, PENDING));
  const oldest = pending.reduce<number | null>((min, name) => {
    const at = statSync(join(stateDir, PENDING, name)).mtimeMs;
    return min === null || at < min ? at : min;
  }, null);
  const rejectedSignalsFile = join(stateDir, REJECTED_SIGNALS);
  return {
    pending: pending.length,
    oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest),
    rejectedCloses: list(join(stateDir, REJECTED_CLOSES)).length,
    rejectedSignals: existsSync(rejectedSignalsFile)
      ? readFileSync(rejectedSignalsFile, "utf8").split("\n").filter(Boolean).length
      : 0,
  };
}

async function sendPendingClose(options: RunnerOptions, file: string): Promise<boolean> {
  let entry: { run_id: string; body: RunClose };
  try {
    entry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const attempts = options.closeAttempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await options.worker.closeRun(entry.run_id, entry.body);
      unlinkSync(file);
      return true;
    } catch (error) {
      if (error instanceof WorkerError && error.status === 409) {
        unlinkSync(file);
        return true;
      }
      if (error instanceof WorkerError && !retryable(error)) {
        // The Worker will refuse this body every time: keep it for inspection, stop resending.
        mkdirSync(join(options.stateDir, REJECTED_CLOSES), { recursive: true });
        renameSync(file, join(options.stateDir, REJECTED_CLOSES, file.split("/").at(-1) as string));
        options.log({ event: "close_rejected", run_id: entry.run_id, status: error.status, code: error.code });
        return false;
      }
      options.log({ event: "close_failed", run_id: entry.run_id, attempt, error: error instanceof Error ? error.message : String(error) });
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, (options.closeBackoffMs ?? 250) * 2 ** attempt));
    }
  }
  return false;
}

// Only a refusal of this exact request's content is permanent. Everything else (an expired or
// rotated token, an Access or WAF page, a route not deployed yet, rate limits, outages) is
// retried, so a misconfigured or half-deployed Worker stalls the feed instead of dropping work.
const PERMANENT = new Set([400, 410, 413, 422]);

export function retryable(error: WorkerError): boolean {
  return error.code === "invalid_json" || !PERMANENT.has(error.status);
}

function pendingPath(stateDir: string, runId: string): string {
  return join(stateDir, PENDING, `${sha256(runId).slice(0, 40)}.json`);
}

function writeAtomic(file: string, content: string): void {
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}

/** `mode` is null for a Worker without the routing fields, which gets the close it knows. */
function closeBody(result: GatewayResult, mode: "live" | "shadow" | null): RunClose {
  const { provider, model, authMode, routeId, reviewOf } = result;
  return {
    status: result.status,
    reason: result.status === "abstained" ? result.reason : null,
    detail: result.status === "abstained" ? result.detail : null,
    output: result.status === "ok" ? result.output : null,
    // No route means no model ran (`no_independent_route`).
    model:
      provider === null || model === null || authMode === null || routeId === null
        ? null
        : {
            provider,
            model,
            models_used: result.modelsUsed,
            auth_mode: authMode,
            tier: result.tier,
            ...(mode === null
              ? {}
              : { route_id: routeId, review_of: reviewOf ? { run_id: reviewOf.runId, provider: reviewOf.provider } : null, mode }),
          },
    hashes: result.hashes,
    usage: {
      input_tokens: result.usage.inputTokens,
      cached_input_tokens: result.usage.cachedInputTokens,
      output_tokens: result.usage.outputTokens,
    },
    cost_usd: result.costUsd,
    attempts: result.attempts,
    duration_ms: result.durationMs,
    tool_calls: result.toolCalls,
  };
}

function abstainedBody(reason: string, detail: string): RunClose {
  return {
    status: "abstained",
    reason,
    detail: detail.slice(0, 300),
    output: null,
    model: null,
    hashes: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    cost_usd: 0,
    attempts: 0,
    duration_ms: 0,
    tool_calls: [],
  };
}
