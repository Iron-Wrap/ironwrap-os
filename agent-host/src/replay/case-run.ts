// One eval case as one production-shaped run. The case signal and facts become the Signal and the
// context snapshot the Worker would hand the host, with case times resolved against the case clock,
// and the production buildRunInput assembles the input. The replay offers the specialist's full
// allowlist, in catalog order and worded as the Worker words its tools; a production run sees only
// the actions the Worker registry binds, so `prompt_sha256` matches production only once the
// registry exposes the same actions. Nothing the model sees names the case, its suite or its
// expectations.
//
// The Worker side of the run is answerCall: a deterministic decision for every proposed step,
// served by tool-server.ts, which never executes anything.

import { canonicalJson, sha256 } from "../gateway/schema.ts";
import type { JsonSchema } from "../gateway/types.ts";
import { buildRunInput, type RunInput } from "../host/prompt.ts";
import type { Specialist } from "../host/specialists.ts";
import type { Fact, OpenedRun, RunTool, Signal } from "../host/worker.ts";
import type { Catalog, EvalCase } from "./evals.ts";

/**
 * The default case clock. A fixed instant keeps every snapshot reproducible: 14:00 in Edmonton on a
 * summer weekday, the time the cases' own clock facts carry most often.
 */
export const CASE_CLOCK_MS = Date.UTC(2026, 6, 7, 20, 0, 0);

const SEASON_MONTHS: Record<string, number> = { winter: 0, spring: 3, summer: 6, fall: 9 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a case runs at: its optional `clock` ({season, weekday, local_time}, Edmonton local
 * time, no calendar date) as the first such weekday on or after the 8th of the season's month
 * (January, April, July, October) of CASE_CLOCK_MS's year, else CASE_CLOCK_MS itself. A clock of
 * any other shape is refused.
 */
export function caseClock(item: Pick<EvalCase, "clock">): number {
  if (item.clock === undefined) return CASE_CLOCK_MS;
  const clock = item.clock as unknown;
  const keys = isObject(clock) ? Object.keys(clock).sort().join() : "";
  const time = isObject(clock) && typeof clock.local_time === "string" ? LOCAL_TIME.exec(clock.local_time) : null;
  if (!isObject(clock) || keys !== "local_time,season,weekday" || typeof clock.season !== "string" || !Object.hasOwn(SEASON_MONTHS, clock.season) || typeof clock.weekday !== "string" || !WEEKDAYS.includes(clock.weekday) || !time) {
    throw new Error(`clock must be {season: winter|spring|summer|fall, weekday: monday..sunday, local_time: HH:MM}, not ${JSON.stringify(clock)}`);
  }
  const year = new Date(CASE_CLOCK_MS).getUTCFullYear();
  const month = SEASON_MONTHS[String(clock.season)];
  const eighth = new Date(Date.UTC(year, month, 8)).getUTCDay();
  const day = 8 + ((WEEKDAYS.indexOf(String(clock.weekday)) - eighth + 7) % 7);
  const wall = Date.UTC(year, month, day, Number(time[1]), Number(time[2]));
  // The wall time read as UTC, moved by Edmonton's offset at that moment; the second reading only
  // matters within an hour of a daylight-saving change.
  const first = wall - edmontonOffsetMinutes(wall) * 60_000;
  return wall - edmontonOffsetMinutes(first) * 60_000;
}

// America/Edmonton's UTC offset at an instant, read from Intl as workers-bus/src/hermes-desktop.ts
// reads a configured zone's offset.
function edmontonOffsetMinutes(at: number): number {
  const label = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", timeZoneName: "longOffset" })
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label ?? "");
  if (!match) throw new Error(`no America/Edmonton offset in ${JSON.stringify(label)}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

const DURATION = /^(-?)P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** A case time (an ISO 8601 duration from the case clock, evals/README.md) as a timestamp. */
export function caseTime(duration: string, clockMs = CASE_CLOCK_MS): string {
  const match = DURATION.exec(duration);
  if (!match) throw new Error(`case time ${JSON.stringify(duration)} is not a relative ISO 8601 duration`);
  const [, sign, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const ms = (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return new Date(clockMs + (sign ? -ms : ms)).toISOString();
}

/** A run tool with the catalog marks the Worker's answer depends on. */
export interface ReplayTool extends RunTool {
  protective: boolean;
  requires_citations: boolean;
}

// Arguments stay open: the Worker registry holds strict schemas for a few actions only, and some
// name arguments differently from the contract conventions the cases are written in (COMMON.md
// "Arguments of the shared actions"). The scorer checks arguments against each case.
const OPEN_ARGS: JsonSchema = { type: "object", properties: {}, additionalProperties: true };

/** The specialist's allowlisted catalog actions, as the Worker words and orders its tools (owned, never people-only). */
export function replayTools(specialist: Specialist, catalog: Catalog): ReplayTool[] {
  const allowlisted = new Set(specialist.allowlist.map((entry) => entry.action_id));
  const tools: ReplayTool[] = [];
  for (const action of catalog.actions.values()) {
    const { autonomy } = action;
    if (!allowlisted.has(action.action_id) || !action.owners.includes(specialist.id) || autonomy === "H" || action.human_only) continue;
    tools.push({
      action_id: action.action_id,
      // workers-bus/src/agents/catalog.ts toolName: MCP tool names allow no dots.
      tool_name: action.action_id.replaceAll(".", "__"),
      autonomy,
      side_effect_class: action.side_effect_class,
      undo: action.undo,
      description: `${action.action_id} on ${action.aggregate}${action.protective ? " (protective)" : ""}.`,
      args_schema: OPEN_ARGS,
      protective: action.protective,
      requires_citations: action.requires_citations,
    });
  }
  return tools;
}

export type ReplaySignal = Signal & { actor?: unknown };

/** What the stdio action server answers from for one run. */
export interface ToolFile {
  schema_version: "ironwrap.eval-tool-file.v1";
  clock: string;
  tools: ReplayTool[];
  facts: Fact[];
}

export interface ReplayRun {
  signal: ReplaySignal;
  run: OpenedRun;
  input: RunInput;
  toolFile: ToolFile;
}

export function replayRun(specialist: Specialist, tools: ReplayTool[], item: EvalCase, runId: string, clockMs = caseClock(item)): ReplayRun {
  const { kind, source, watch_id, at, content, actor } = item.signal;
  const signal: ReplaySignal = {
    // A case id names its suite, which the model must not see.
    signal_id: `sig_${sha256(item.id).slice(0, 32)}`,
    kind,
    specialist_id: specialist.id,
    watch_id: watch_id ?? null,
    source,
    subject: null,
    content,
    received_at: caseTime(at, clockMs),
    ...(actor === undefined ? {} : { actor }),
  };
  const facts: Fact[] = [
    // The snapshot starts with the signal as in production, under the pseudo-fact id receipts cite
    // for it (evals/README.md); it is untrusted text like every signal.
    contextFact("signal", "signal", 1, "untrusted_text", signal.received_at, null, content),
    ...item.facts.map((fact) =>
      contextFact(
        fact.fact_id,
        fact.kind,
        fact.version,
        fact.trust,
        caseTime(fact.observed_at, clockMs),
        fact.fresh_until === undefined ? null : caseTime(fact.fresh_until, clockMs),
        fact.data ?? null,
      ),
    ),
  ];
  const run: OpenedRun = {
    run_id: runId,
    goal: goalFor(signal),
    context: { snapshot_hash: sha256(canonicalJson(facts.map(({ fact_id, version, hash }) => ({ fact_id, version, hash })))), facts, omitted: [] },
    tools,
  };
  return {
    signal,
    run,
    input: buildRunInput(specialist, run, signal, tools),
    toolFile: { schema_version: "ironwrap.eval-tool-file.v1", clock: new Date(clockMs).toISOString(), tools, facts },
  };
}

// The fact shape and hash of workers-bus/src/agents/memory.ts: `sha256:` over the canonical value.
function contextFact(fact_id: string, kind: string, version: number, trust: Fact["trust"], observed_at: string, fresh_until: string | null, data: unknown): Fact {
  return { fact_id, kind, version, hash: `sha256:${sha256(canonicalJson(data))}`, trust, observed_at, fresh_until, data };
}

/** workers-bus/src/agents/store.ts goalFor, for a signal without a subject. */
function goalFor(signal: Signal): string {
  const origin = signal.kind === "watch" ? `watch ${signal.watch_id}` : `${signal.kind.replace("_", " ")} from ${signal.source}`;
  return `Act on the ${origin} (signal ${signal.signal_id}).`;
}

// mcp/ironwrap-bus-mcp/src/agent-server.mjs: a step is proposed as { args, citations }.
const CITATIONS_SCHEMA = {
  type: "array",
  maxItems: 40,
  description: "The exact facts this step relies on, by fact_id and the version you read.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["fact_id", "version"],
    properties: {
      fact_id: { type: "string", minLength: 1, maxLength: 160 },
      version: { type: "integer", minimum: 0 },
    },
  },
};

/** tools/list, worded as the production action server words it. */
export function listTools(file: ToolFile) {
  return file.tools.map((tool) => ({
    name: tool.tool_name,
    description: `${tool.description} Autonomy ${tool.autonomy}. This proposes a step; the Worker decides whether it runs and answers with the decision.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["args", "citations"],
      properties: { args: tool.args_schema, citations: CITATIONS_SCHEMA },
    },
  }));
}

export interface ToolAnswer {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

/**
 * The Worker's answer to one proposed step, decided from the tool file alone and never executed.
 * Citations are checked as workers-bus/src/agents/policy.ts checks them; then an A0 read answers
 * with the case facts it names, an A1 output is drafted, a protective step goes to its person, and
 * any other A2 or A3 step waits for approval, so the run can finish.
 */
export function answerCall(file: ToolFile, name: string, input: unknown, step: number): ToolAnswer {
  const tool = file.tools.find((candidate) => candidate.tool_name === name);
  if (!tool) return failure("unknown_tool", `${name} is not an action of this run`);
  if (!isObject(input) || !Object.hasOwn(input, "args") || !Array.isArray(input.citations)) {
    return failure("invalid_arguments", "call with { args, citations }");
  }
  const citations: unknown[] = input.citations;
  if (!citations.every((citation) => isObject(citation) && typeof citation.fact_id === "string" && Number.isInteger(citation.version))) {
    return failure("invalid_arguments", "every citation is { fact_id, version }");
  }
  const cited = citations as Array<{ fact_id: string; version: number }>;
  const facts = new Map(file.facts.map((fact) => [fact.fact_id, fact]));
  const decide = (decision: string, outcome: string | null, reasonCodes: string[] = [], extra: object = {}) =>
    answer({ step_id: `step_${step}`, decision, outcome, reason_codes: reasonCodes, ...extra });
  const unverifiable = cited.some((citation) => facts.get(citation.fact_id)?.version !== citation.version);
  if ((tool.requires_citations && cited.length === 0) || unverifiable) return decide("abstained", "abstained", ["citation_unverifiable"]);
  const clock = Date.parse(file.clock);
  if (cited.some((citation) => isStale(facts.get(citation.fact_id) as Fact, clock))) return decide("abstained", "abstained", ["fact_stale"]);
  if (tool.autonomy === "A0") return decide("recorded", "succeeded", [], read(input.args, cited, facts));
  if (tool.autonomy === "A1") return decide("drafted", "succeeded");
  return decide(tool.protective ? "escalated" : "awaiting_approval", null);
}

const isStale = (fact: Fact, clock: number) => fact.fresh_until !== null && Date.parse(fact.fresh_until) < clock;

// A read returns the facts its citations and id arguments name, by full id or by the id after the
// kind (`lead:L-1001` for `L-1001`); anything absent is not found (evals/README.md).
function read(args: unknown, citations: Array<{ fact_id: string }>, facts: Map<string, Fact>) {
  const named = new Set(citations.map((citation) => citation.fact_id));
  collectIds(args, "", named);
  const ids = (fact: Fact) => [fact.fact_id, fact.fact_id.slice(fact.fact_id.indexOf(":") + 1)];
  const found = [...facts.values()].filter((fact) => ids(fact).some((id) => named.has(id)));
  const matched = new Set(found.flatMap(ids));
  return { facts: found, not_found: [...named].filter((id) => !matched.has(id)) };
}

function collectIds(value: unknown, key: string, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach((item) => collectIds(item, key, into));
  else if (isObject(value)) for (const [inner, item] of Object.entries(value)) collectIds(item, inner, into);
  else if (typeof value === "string" && (key.endsWith("_id") || key.endsWith("_ids"))) into.add(value);
}

function answer(body: unknown): ToolAnswer {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

function failure(code: string, message: string): ToolAnswer {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
