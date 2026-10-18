// The face's ask runs (AI-TEAM-CONTRACT.md "Requests through the face"). A person's question is an
// `owner_request` signal to the face from `ask:<user_id>`. The Worker writes its content: the
// question as untrusted text, and the asker's role at ask time and the screen context as its own
// metadata. The face's run reads shared memory as that role, never as the face's reviewer role,
// and only an ask run may return a view spec (view-spec.ts, Track E's generated copy). The Worker
// checks the view at close: the validator's rules for the asker's place against the catalog in
// force, then that the spec names this run and cites only facts this run read, at that version and
// hash. A refused view is dropped with its issue codes; the plain answer stands.
//
// The model sees a person's ask or request for what it is: the route's word and the person's role
// as the Worker wrote it (`signalActor`), never "owner" for anyone but the owner.

import { CATALOG } from "./catalog.ts";
import { CATALOG_JSON, CATALOG_SHA256 } from "./contract-catalog.ts";
import type { FactRef } from "./memory.ts";
import {
  catalogFromContractJson,
  READ_MODELS,
  validateViewSpec,
  viewSpecJsonSchema,
  type ViewSpec,
  type ViewSpecIssueCode,
} from "./view-spec.ts";

export const FACE = "orchestrator";
export const ASK_SOURCE = "ask:";
/** A press on a view's action, an `owner_request` to the action's owning specialist. */
export const REQUEST_SOURCE = "request:";

/** How long an ask may wait for a run to take it up; after that it reads as not answered. */
export const ASK_UNANSWERED_MS = 15 * 60_000;

/**
 * Close reason codes that reach a person even when a question raised them (contract "Abstention"
 * and "Escalation to a named person"): an emergency, a safety event, and every abstain code a
 * protective catalog action carries (suspected injection). Any other unanswered question goes back
 * to its asker alone.
 */
export const PERSON_CODES: ReadonlySet<string> = new Set([
  "emergency",
  "safety_event",
  ...CATALOG.receipt.reason_codes.abstained.filter((code) =>
    CATALOG.actions.some((action) => action.protective && action.reason_codes?.includes(code)),
  ),
]);

/** The catalog in force as the view validator reads it; a view's `catalog_sha256` must name it. */
export const VIEW_CATALOG = catalogFromContractJson(CATALOG_JSON, CATALOG_SHA256);

/** The strict output schema of a view, which the host merges into an ask run's output schema. */
export const VIEW_SCHEMA = viewSpecJsonSchema({ catalog: VIEW_CATALOG, readModels: READ_MODELS });

/** The role an ask signal's run reads as; null for any other signal. An ask without one reads nothing. */
export function askerRole(signal: SignalLike): string | null {
  if (signal.kind !== "owner_request" || signal.specialist_id !== FACE || !signal.source.startsWith(ASK_SOURCE)) return null;
  const content: unknown = JSON.parse(signal.content_json);
  const role = isRecord(content) ? content.asker_role : undefined;
  return typeof role === "string" ? role : "";
}

type SignalLike = { kind: string; specialist_id: string; source: string; content_json: string };

/** Who a person's ask or request came from, as the model sees it. */
export interface SignalActor {
  type: "owner" | "staff" | "worker";
  role: string;
  ref: string;
  authenticated: true;
}

/**
 * The person behind an ask or a request, from the Worker's own record of it: the role at the time,
 * never text from the model or the person. `owner` only for the owner, `worker` for a field person
 * (who only asks: the crew phone offers no action), `staff` for every other role. Null for every
 * other signal.
 */
export function signalActor(signal: SignalLike): SignalActor | null {
  const asked = askerRole(signal);
  const requested = signal.kind === "owner_request" && signal.source.startsWith(REQUEST_SOURCE);
  if (asked === null && !requested) return null;
  const content: unknown = JSON.parse(signal.content_json);
  const recorded = asked ?? (isRecord(content) ? content.requester_role : undefined);
  const role = typeof recorded === "string" ? recorded : "";
  const userId = signal.source.slice((asked === null ? REQUEST_SOURCE : ASK_SOURCE).length);
  return { type: role === "owner" ? "owner" : role === "field" ? "worker" : "staff", role, ref: `person:${userId}`, authenticated: true };
}

/** The route's word the model reads for a person's signal: `ask` or `request`. */
export function actorWord(signal: SignalLike): "ask" | "request" {
  return signal.source.startsWith(ASK_SOURCE) ? "ask" : "request";
}

/** An ask run as its close is checked: its id, the fact refs it read and whose role it read as. */
export interface AskRun {
  run_id: string;
  facts: FactRef[];
  asker_role: string;
}

/** One problem with a refused view, as the run record keeps it. */
export interface ViewIssue {
  code: ViewSpecIssueCode;
  /** JSON pointer into the spec. */
  path: string;
}

/** A refused view's issues the run record keeps: the first ones, enough to say why. */
const ISSUES_KEPT = 20;

/** What the Worker made of the view a run returned. */
export interface ViewVerdict {
  offered: boolean;
  /** The checked spec; null when none was offered or it was refused. */
  view: ViewSpec | null;
  /** A refused view's first issues; empty otherwise. Only the run record holds them. */
  issues: ViewIssue[];
}

export function checkView(view: unknown, run: AskRun): ViewVerdict {
  if (view === null || view === undefined) return { offered: false, view: null, issues: [] };
  // A field person asks from the crew phone; every other role reads in the office.
  const checked = validateViewSpec(view, VIEW_CATALOG, { place: run.asker_role === "field" ? "crew" : "office" });
  const issues = checked.ok ? ownIssues(checked.spec, run) : checked.issues.map(({ code, path }) => ({ code, path }));
  if (checked.ok && issues.length === 0) return { offered: true, view: checked.spec, issues: [] };
  return { offered: true, view: null, issues: issues.slice(0, ISSUES_KEPT) };
}

/**
 * The Worker's checks after the validator's, with the run codes view-spec.ts names
 * (VIEW_SPEC_RUN_ISSUE_CODES): the spec is this run's, and it cites only what the run read.
 */
function ownIssues(spec: ViewSpec, run: AskRun): ViewIssue[] {
  const read = new Set(run.facts.map((fact) => `${fact.fact_id} ${fact.version} ${fact.hash}`));
  const issues: ViewIssue[] = spec.run_id === run.run_id ? [] : [{ code: "run_mismatch", path: "/run_id" }];
  spec.data.forEach((entry, index) =>
    entry.sources.forEach((source, at) => {
      if (!read.has(`${source.fact_id} ${source.version} ${source.hash}`))
        issues.push({ code: "source_not_in_snapshot", path: `/data/${index}/sources/${at}` });
    }),
  );
  return issues;
}

/** The facts a shown view cites, each once. */
export function viewSources(view: ViewSpec | null): Array<{ fact_id: string; version: number; hash: string }> {
  const seen = new Set<string>();
  const sources: Array<{ fact_id: string; version: number; hash: string }> = [];
  for (const entry of view?.data ?? [])
    for (const { fact_id, version, hash } of entry.sources)
      if (!seen.has(fact_id)) {
        seen.add(fact_id);
        sources.push({ fact_id, version, hash });
      }
  return sources;
}

/**
 * An ask run's close as the Worker records it: `output.view` replaced by the checked spec or null,
 * and a refused view's first issues ({code, path}) under `view_spec_invalid`. The answer receipt
 * carries only the reason code. An output without a view (a host that predates views) records
 * null. A close without output is recorded as received.
 */
export function recordAskClose(body: unknown, run: AskRun): { body: unknown; verdict: ViewVerdict | null } {
  if (!isRecord(body) || body.status !== "ok" || !isRecord(body.output)) return { body, verdict: null };
  const verdict = checkView(body.output.view, run);
  return {
    body: {
      ...body,
      output: { ...body.output, view: verdict.view },
      ...(verdict.issues.length > 0 ? { view_spec_invalid: verdict.issues } : {}),
    },
    verdict,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
