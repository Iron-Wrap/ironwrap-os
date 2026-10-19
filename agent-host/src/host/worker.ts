// Typed client for the Worker agent API. The host holds one service token for it and nothing
// else: it reads signals, opens and closes coordination runs, and reports its health. Every
// decision about an action belongs to the Worker; the host only transports.

import type { Family, JsonSchema, ProviderId } from "../gateway/types.ts";

export type SignalKind = "event" | "watch" | "owner_request" | "handoff";

export interface Signal {
  signal_id: string;
  kind: SignalKind;
  specialist_id: string;
  watch_id: string | null;
  /** `ask` or `request` for a person's signal through the app, else the recorded source. */
  source: string;
  /**
   * Who a person's ask or request came from, as the Worker recorded it (`{type: "owner" | "staff" |
   * "worker", role, ref: "person:<user_id>", authenticated: true}`); null for every other signal. The host
   * passes it to the model as data and never reads it.
   */
  actor?: unknown;
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
  /**
   * Facts with their values, read now. A resumed run's fact that changed since it opened carries
   * `data: null` and `current: false`; `omitted` names facts that belong but could not be included.
   */
  context: {
    snapshot_hash: string;
    facts: Array<Fact & { current?: false }>;
    omitted?: Array<{ fact_id: string; reason: "unreadable" | "too_large" | "limit_reached" }>;
  };
  tools: RunTool[];
  // Routing fields; a Worker that predates them omits all three, and missing reads as null/live.
  /**
   * The run whose work this run reviews: the provider id that ran it and, from a Worker on the v3
   * close model, its family. A legacy hint's provider maps to its family (claude: anthropic,
   * codex: openai).
   */
  review_of?: { run_id: string; provider?: ProviderId; family?: Family } | null;
  /** The single catalog action the run is expected to take. */
  expected_action_id?: string | null;
  /** A shadow run spends the shadow budget, never the live ceilings. */
  mode?: "live" | "shadow";
  /**
   * The specialist's current owner-recorded qualifications (`agent_qualifications`): for each
   * provider, model, effort and release, the latest row, sent only while it passed. Live and shadow
   * runs take only a route one of them names; without them those runs abstain `no_qualified_route`.
   */
  qualifications?: Array<{ qualification_id: string; provider: ProviderId; model: string; effort: string; release_sha256: string }>;
  /** 3 when the Worker accepts the v3 close model block; any other value gets the legacy close. */
  close_model?: number;
  /**
   * Output this run may return beyond the run output schema. Only a face run answering a person's
   * ask carries `view`: the strict schema of a view spec, merged in as a nullable property.
   */
  output_extension?: { view?: JsonSchema } | null;
  /**
   * The people-only acts this specialist may name in a receipt, by catalog name; never tools. A
   * Worker that predates the field omits it.
   */
  people_only?: PeopleOnlyAct[];
}

export interface PeopleOnlyAct {
  action_id: string;
  name: string;
}

export interface RunClose {
  status: "ok" | "abstained";
  reason: string | null;
  detail: string | null;
  output: unknown;
  /**
   * Null when no route was resolved (the specialist could not load, or no route of another family
   * could review the work). `route_id`, `review_of` and `mode` go only to a Worker that sent the
   * routing fields, and the v3 block only to one that advertises `close_model: 3`: an older Worker
   * refuses unknown close fields.
   */
  model: LegacyCloseModel | CloseModelV3 | null;
  hashes: { system: string; prompt: string; schema: string } | null;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  cost_usd: number;
  attempts: number;
  duration_ms: number;
  tool_calls: Array<{ tool: string; arguments: unknown }>;
}

export interface LegacyCloseModel {
  provider: string;
  model: string;
  models_used: string[];
  auth_mode: string;
  tier: string;
  route_id?: string;
  review_of?: { run_id: string; provider: string } | null;
  mode?: "live" | "shadow";
}

/** The close model block of gateway config v3 (R3 design section 6). */
export interface CloseModelV3 {
  provider: string;
  adapter: string;
  family: string;
  model: string;
  /** The effort of the route that answered, which its qualification names. */
  effort: string;
  models_used: string[];
  /** The account's credential mode. */
  auth_mode: string;
  billing: string;
  tier: string;
  route_id: string;
  route: "primary" | "declared_fallback";
  /** Every hop the run passed over or failed on, in order (at most three), with its family (null with no registry entry). */
  failover: Array<{ route_id: string; provider: string; model: string; family: string | null; reason: string; retry_at: number | null }>;
  /** The Worker's `qualification_id` the route matched; null on a synthetic run. */
  qualification_ref: string | null;
  release_sha256: string | null;
  gateway_config_sha256: string;
  review_of: { run_id: string; family: string } | null;
  mode: "live" | "shadow";
  /** The account's docs/COMPLIANCE-REGISTER.md ref and the run class it served. */
  compliance_ref: string | null;
  run_class: string;
  risk_acceptance: { ref: string; run_class: string; reason: string } | null;
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
  /**
   * Opening a run builds (or, on resume, re-reads) its context snapshot on the Worker, which takes
   * far longer than a poll for a watch with many subjects. Defaults to `timeoutMs`.
   */
  openTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.openTimeoutMs = options.openTimeoutMs ?? options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
  }

  signals(after: string | null, limit: number): Promise<{ signals: Signal[]; next_cursor: string | null }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set("after", after);
    return this.request("GET", `/api/v1/agents/signals?${query}`);
  }

  openRun(body: { signal_id: string; specialist_id: string; host_run_key: string }): Promise<OpenedRun> {
    return this.request("POST", "/api/v1/agents/runs", body, this.openTimeoutMs);
  }

  closeRun(runId: string, body: RunClose): Promise<{ run_id: string; terminal: string }> {
    return this.request("POST", `/api/v1/agents/runs/${encodeURIComponent(runId)}/close`, body);
  }

  heartbeat(body: Heartbeat): Promise<unknown> {
    return this.request("POST", "/api/v1/agents/host/heartbeat", body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const route = `${method} ${path.split("?")[0]}`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Name the call: a bare "aborted due to timeout" in the log cannot say which route is slow.
      if (error instanceof Error && error.name === "TimeoutError") throw new WorkerError(0, "timeout", `${route} timed out after ${timeoutMs} ms`);
      throw new WorkerError(0, "network", `${route} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
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
