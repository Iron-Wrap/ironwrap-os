// Typed client for the Worker agent API. The host holds one service token for it and nothing
// else: it reads signals, opens and closes coordination runs, and reports its health. Every
// decision about an action belongs to the Worker; the host only transports.

import type { JsonSchema } from "../gateway/types.ts";

export type SignalKind = "event" | "watch" | "owner_request" | "handoff";

export interface Signal {
  signal_id: string;
  kind: SignalKind;
  specialist_id: string;
  watch_id: string | null;
  source: string;
  subject: { aggregate: string; id: string } | null;
  /** Untrusted content (a message, a form, a supplier email); always rendered as data. */
  content: unknown;
  received_at: string;
}

export interface Fact {
  fact_id: string;
  kind: string;
  version: number;
  hash: string;
  trust: "owned" | "external_verified" | "external_unverified" | "untrusted_text";
  observed_at: string;
  fresh_until: string | null;
  data: unknown;
}

export interface RunTool {
  action_id: string;
  tool_name: string;
  autonomy: "A0" | "A1" | "A2" | "A3";
  side_effect_class: string;
  undo: string;
  description: string;
  args_schema: JsonSchema;
}

export interface OpenedRun {
  run_id: string;
  goal: string;
  context: { snapshot_hash: string; facts: Fact[] };
  tools: RunTool[];
}

export interface RunClose {
  status: "ok" | "abstained";
  reason: string | null;
  detail: string | null;
  output: unknown;
  /** Null when no model ran (the specialist could not load). */
  model: { provider: string; model: string; models_used: string[]; auth_mode: string; tier: string } | null;
  hashes: { system: string; prompt: string; schema: string } | null;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  cost_usd: number;
  attempts: number;
  duration_ms: number;
  tool_calls: Array<{ tool: string; arguments: unknown }>;
}

export interface Heartbeat {
  host_id: string;
  version: string;
  ready: boolean;
  alerts: string[];
  providers: unknown;
  in_flight: number;
  backlog: { pending_closes: number; oldest_pending_ms: number | null; rejected_closes: number; rejected_signals: number };
}

export class WorkerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WorkerError";
    this.status = status;
    this.code = code;
  }
}

export interface WorkerClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
  }

  signals(after: string | null, limit: number): Promise<{ signals: Signal[]; next_cursor: string | null }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set("after", after);
    return this.request("GET", `/api/v1/agents/signals?${query}`);
  }

  openRun(body: { signal_id: string; specialist_id: string; host_run_key: string }): Promise<OpenedRun> {
    return this.request("POST", "/api/v1/agents/runs", body);
  }

  closeRun(runId: string, body: RunClose): Promise<{ run_id: string; terminal: string }> {
    return this.request("POST", `/api/v1/agents/runs/${encodeURIComponent(runId)}/close`, body);
  }

  heartbeat(body: Heartbeat): Promise<unknown> {
    return this.request("POST", "/api/v1/agents/host/heartbeat", body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new WorkerError(response.status, "invalid_json", `${method} ${path.split("?")[0]} returned non-JSON`);
    }
    if (!response.ok) {
      const code = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : "http_error";
      throw new WorkerError(response.status, code, `${method} ${path.split("?")[0]} failed with ${response.status} ${code}`);
    }
    return parsed as T;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HTTPS only, except an explicit local Worker; no credentials, query or fragment in the URL. */
export function parseWorkerUrl(raw: string, allowInsecureLocal: boolean): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error("worker URL must be a bare origin");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowInsecureLocal && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  throw new Error("worker URL must use HTTPS");
}
