// HTTP surface of the AI team.
//
// `/api/v1/agents/*` serves the agent host and its per-run action server. It accepts only the
// AGENT_HOST_TOKEN bearer, never a browser session, and stays dark (404) while that secret is
// unset. `/api/v1/agent-team/*` serves people through the app session (owner and ops): the
// receipt lanes and the hosts' health. No route here lets an agent change its own delegation.

import { operatingTenantId } from "../core.ts";
import type { AuthContext } from "../app-types.ts";
import { listHostHealth, listReceipts, receiptOf, type ReceiptView } from "./receipts.ts";
import { RUN_OUTPUT_SCHEMA } from "./run-output.ts";
import {
  closeRun,
  getRun,
  listSignals,
  openRun,
  proposeStep,
  recordHeartbeat,
  runContext,
  runTools,
  type AgentDb,
} from "./store.ts";

export interface AgentEnv {
  DB: unknown;
  AGENT_HOST_TOKEN?: string;
  APP_TENANT_ID?: string;
}

const MAX_BODY_BYTES = 256 * 1024;
const HOST_RUN_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STEP_KEY = /^[0-9a-f]{64}$/;

export async function handleAgentHostApi(req: Request, env: AgentEnv, now = () => Date.now()): Promise<Response> {
  if (!env.AGENT_HOST_TOKEN) return reply({ error: "not_found" }, 404);
  if (!(await tokenMatches(req, env.AGENT_HOST_TOKEN))) return reply({ error: "unauthorized" }, 401);
  const tenantId = operatingTenantId(env.APP_TENANT_ID);
  if (!tenantId) return reply({ error: "tenant_not_configured" }, 503);
  const db = env.DB as AgentDb;
  const url = new URL(req.url);
  const path = url.pathname;
  const iso = () => new Date(now()).toISOString();

  if (req.method === "GET" && path === "/api/v1/agents/signals") {
    const after = url.searchParams.get("after");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if ((after !== null && !/^\d{1,15}$/.test(after)) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return reply({ error: "invalid_query" }, 400);
    }
    return reply(await listSignals(db, tenantId, Number(after ?? "0"), limit));
  }

  if (req.method === "POST" && path === "/api/v1/agents/runs") {
    const body = await readJson(req);
    if (body === TOO_LARGE) return reply({ error: "body_too_large" }, 413);
    if (!isRecord(body) || !exactKeys(body, ["signal_id", "specialist_id", "host_run_key"])) return reply({ error: "invalid_body" }, 400);
    const { signal_id, specialist_id, host_run_key } = body;
    if (!isId(signal_id) || !isId(specialist_id) || typeof host_run_key !== "string" || !HOST_RUN_KEY.test(host_run_key)) {
      return reply({ error: "invalid_body" }, 400);
    }
    const opened = await openRun(db, tenantId, { signal_id, specialist_id, host_run_key }, iso());
    if ("error" in opened) return reply({ error: opened.error }, opened.status);
    const { run, resumed } = opened;
    return reply({ run_id: run.run_id, goal: run.goal, resumed, context: runContext(run), tools: runTools(run) }, resumed ? 200 : 201);
  }

  const runMatch = path.match(/^\/api\/v1\/agents\/runs\/([^/]+)\/(tools|steps|close)$/);
  if (runMatch) {
    const runId = safeDecode(runMatch[1]);
    if (!runId || !ID.test(runId)) return reply({ error: "run_not_found" }, 404);
    const run = await getRun(db, tenantId, runId);
    if (!run) return reply({ error: "run_not_found" }, 404);
    const operation = runMatch[2];
    if (operation === "tools" && req.method === "GET") return reply({ tools: runTools(run) });
    if (operation === "steps" && req.method === "POST") {
      if (run.state !== "open") return reply({ error: "run_closed" }, 409);
      const body = await readJson(req);
      if (body === TOO_LARGE) return reply({ error: "body_too_large" }, 413);
      if (!isRecord(body) || !exactKeys(body, ["action_id", "args", "citations", "step_key"])) return reply({ error: "invalid_body" }, 400);
      if (typeof body.action_id !== "string" || body.action_id.length > 128 || typeof body.step_key !== "string" || !STEP_KEY.test(body.step_key)) {
        return reply({ error: "invalid_body" }, 400);
      }
      const citations = parseCitations(body.citations);
      if (!citations) return reply({ error: "invalid_body" }, 400);
      const step = await proposeStep(db, tenantId, run, { action_id: body.action_id, args: body.args, citations, step_key: body.step_key }, now());
      if ("error" in step) return reply({ error: step.error }, step.status);
      const receipt = receiptOf(step);
      return reply({ step_id: step.step_id, decision: decisionWord(receipt), outcome: step.outcome, reason_codes: receipt.policy.reason_codes, receipt });
    }
    if (operation === "close" && req.method === "POST") {
      const body = await readJson(req);
      if (body === TOO_LARGE) return reply({ error: "body_too_large" }, 413);
      const closed = await closeRun(db, tenantId, run, body, RUN_OUTPUT_SCHEMA, iso());
      if ("error" in closed) return reply({ error: closed.error }, closed.status);
      return reply({ run_id: run.run_id, terminal: closed.result });
    }
    return reply({ error: "method_not_allowed" }, 405);
  }

  if (req.method === "POST" && path === "/api/v1/agents/host/heartbeat") {
    const body = await readJson(req);
    if (body === TOO_LARGE) return reply({ error: "body_too_large" }, 413);
    const recorded = await recordHeartbeat(db, tenantId, body, iso());
    if ("error" in recorded) return reply({ error: recorded.error }, recorded.status);
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  }
  return reply({ error: "not_found" }, 404);
}

/** Owner and ops read the team's receipts and the hosts' health through their app session. */
export async function handleAgentTeamAppRoute(req: Request, env: AgentEnv, auth: AuthContext): Promise<Response> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") return reply({ error: "forbidden" }, 403);
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
  const db = env.DB as AgentDb;
  const url = new URL(req.url);
  if (url.pathname === "/api/v1/agent-team/receipts") {
    const view = (url.searchParams.get("view") ?? "needs_you") as ReceiptView;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!["needs_you", "doing", "done"].includes(view) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return reply({ error: "invalid_query" }, 400);
    }
    return reply({ view, receipts: await listReceipts(db, auth.session.tenant_id, view, limit) });
  }
  if (url.pathname === "/api/v1/agent-team/hosts") return reply({ hosts: await listHostHealth(db, auth.session.tenant_id) });
  return reply({ error: "not_found" }, 404);
}

function decisionWord(receipt: ReturnType<typeof receiptOf>): string {
  if (receipt.outcome === "abstained") return "abstained";
  if (receipt.outcome === "failed") return "denied";
  if (receipt.outcome === "succeeded") return receipt.permit.kind === "draft" ? "drafted" : "recorded";
  if (receipt.policy.result === "needs_approval") return "awaiting_approval";
  return receipt.needs_from_you ? "escalated" : "accepted";
}

function parseCitations(value: unknown): Array<{ fact_id: string; version: number }> | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  const citations: Array<{ fact_id: string; version: number }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeys(entry, ["fact_id", "version"])) return null;
    if (typeof entry.fact_id !== "string" || entry.fact_id.length === 0 || entry.fact_id.length > 160) return null;
    if (!Number.isInteger(entry.version) || (entry.version as number) < 0) return null;
    citations.push({ fact_id: entry.fact_id, version: entry.version as number });
  }
  return citations;
}

const TOO_LARGE = Symbol("too_large");

/** The body as JSON; TOO_LARGE past the byte limit, undefined when it is not JSON. */
async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return TOO_LARGE;
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return TOO_LARGE;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function tokenMatches(req: Request, expected: string): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  // Compare digests so the comparison takes the same time whatever the presented length.
  const [a, b] = await Promise.all(
    [header.slice(7), expected].map((value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
