import type { AppEnv, AuthContext } from "./app-types.ts";

export type DecisionKind =
  | "lead_triage"
  | "quote_revision"
  | "proposal_publication"
  | "production_schedule"
  | "postiz"
  | "quickbooks_final_invoice";

type LiveDecisionKind = Exclude<DecisionKind, "production_schedule">;

export interface DecisionItem {
  key: string;
  kind: LiveDecisionKind;
  id: string;
  version: number;
  native_state: string;
  title: string;
  summary: string;
  job_id: string | null;
  updated_at: string;
  expires_at: string | null;
  review_href: string;
}

export interface DecisionSource {
  kind: DecisionKind;
  state: "current" | "limited" | "unavailable" | "retired";
  loaded_count: number;
  has_more: boolean | null;
  next_cursor: string | null;
  read_model_generated_at: string | null;
}

export interface DecisionsReadModel {
  version: 1;
  state: "ready" | "empty" | "limited";
  sources: DecisionSource[];
  items: DecisionItem[];
}

export const DECISION_SOURCE_LIMIT = 25;

const approvalStates = [
  "pending",
  "executing",
  "failed",
  "audit_failed",
  "execution_uncertain",
] as const;

const states: Record<LiveDecisionKind, readonly string[]> = {
  lead_triage: approvalStates,
  quote_revision: approvalStates,
  proposal_publication: approvalStates,
  postiz: [
    "connection_required",
    "pending_review",
    "submission_pending",
    "submitted",
    "reconciliation_required",
    "stop_submitted",
    "stop_reconciliation_required",
  ],
  quickbooks_final_invoice: [
    "connection_required",
    "blocked",
    "pending_review",
    "submission_pending",
    "submitted",
    "failed",
    "reconciliation_required",
  ],
};

const nativeIds: Record<LiveDecisionKind, RegExp> = {
  lead_triage: /^approval:[A-Za-z0-9_-]{16,64}$/,
  quote_revision: /^quote-revision-approval:[A-Za-z0-9_-]{16,64}$/,
  proposal_publication: /^proposal-publication-approval:[A-Za-z0-9_-]{16,64}$/,
  postiz:
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  quickbooks_final_invoice: /^[A-Za-z0-9:_-]{16,160}$/,
};

// This projection never calls the legacy list helpers: those helpers expire requests
// and execution leases while reading. Browsing this inbox must only SELECT owned state.
const queries: Record<LiveDecisionKind, string> = {
  lead_triage: `SELECT approval_request_id AS id, state, version, request_text AS summary,
      NULL AS job_id, updated_at, expires_at
    FROM approval_requests`,
  quote_revision: `SELECT quote_revision_approval_id AS id, state, version,
      correction_reason AS summary, roof_job_id AS job_id, target_quote_version,
      updated_at, expires_at FROM quote_revision_approval_requests`,
  proposal_publication: `SELECT proposal_publication_approval_id AS id, state, version,
      request_text AS summary, roof_job_id AS job_id, updated_at, expires_at
    FROM proposal_publication_approval_requests`,
  postiz: `SELECT intent_id AS id, state, version, title AS summary,
      NULL AS job_id, updated_at, NULL AS expires_at FROM postiz_intents`,
  quickbooks_final_invoice: `SELECT intent_id AS id, state, version,
      roof_job_id AS job_id, updated_at, NULL AS expires_at,
      currency || ' ' || final_balance AS summary FROM quickbooks_final_invoice_intents`,
};

const prioritySql = `CASE state
  WHEN 'execution_uncertain' THEN 0 WHEN 'reconciliation_required' THEN 0
  WHEN 'stop_reconciliation_required' THEN 0
  WHEN 'pending' THEN 1 WHEN 'pending_review' THEN 1
  WHEN 'executing' THEN 2 WHEN 'submission_pending' THEN 2
  WHEN 'submitted' THEN 2 WHEN 'stop_submitted' THEN 2
  WHEN 'failed' THEN 3 WHEN 'audit_failed' THEN 3
  WHEN 'blocked' THEN 3 WHEN 'connection_required' THEN 3 ELSE 4 END`;

interface DecisionCursor {
  v: 1;
  kind: LiveDecisionKind;
  tenant: string;
  priority: number;
  updated_at: string;
  id: string;
}

export interface DecisionPageRequest {
  kind: LiveDecisionKind;
  after: DecisionCursor | null;
}

function visibleKinds(auth: AuthContext): LiveDecisionKind[] {
  const kinds: LiveDecisionKind[] = [];
  if (
    auth.permissions.includes("approvals:read") &&
    ["owner", "ops", "sales"].includes(auth.session.role)
  ) {
    if (auth.session.role === "owner" || auth.session.role === "ops")
      kinds.push("lead_triage");
    kinds.push("quote_revision");
    // Sales can open the estimator job, but its nested ProposalPublicationAction
    // only loads publication requests for owner/ops. Match that narrower guard.
    if (auth.session.role === "owner" || auth.session.role === "ops")
      kinds.push("proposal_publication");
  }
  if (auth.session.role === "owner") kinds.push("postiz");
  if (
    auth.permissions.includes("quickbooks:read") &&
    ["owner", "accounting"].includes(auth.session.role)
  )
    kinds.push("quickbooks_final_invoice");
  return kinds;
}

export function parseDecisionPageRequest(
  params: URLSearchParams,
  auth: AuthContext,
):
  | { ok: true; includeDecisions: boolean; page?: DecisionPageRequest }
  | { ok: false; status: 400 | 404 } {
  const include = params.get("include_decisions");
  if (
    params.getAll("include_decisions").length > 1 ||
    (include !== null && include !== "1")
  ) {
    return { ok: false, status: 400 };
  }
  const kind = params.get("decision_source");
  const cursor = params.get("decision_cursor");
  if (kind === null && cursor === null)
    return { ok: true, includeDecisions: include === "1" };
  if (
    kind === null ||
    params.getAll("decision_source").length !== 1 ||
    params.getAll("decision_cursor").length > 1
  ) {
    return { ok: false, status: 400 };
  }
  if (!visibleKinds(auth).includes(kind as LiveDecisionKind))
    return { ok: false, status: 404 };
  if (cursor === null)
    return {
      ok: true,
      includeDecisions: true,
      page: { kind: kind as LiveDecisionKind, after: null },
    };
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))
      throw new Error("cursor_invalid");
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(cursor.replace(/-/g, "+").replace(/_/g, "/")),
          (char) => char.charCodeAt(0),
        ),
      ),
    ) as DecisionCursor;
    if (
      decoded.v !== 1 ||
      decoded.kind !== kind ||
      decoded.tenant !== auth.session.tenant_id ||
      !Number.isInteger(decoded.priority) ||
      decoded.priority < 0 ||
      decoded.priority > 3 ||
      Object.keys(decoded).length !== 6
    )
      throw new Error("cursor_invalid");
    text(decoded.updated_at, 80);
    if (!nativeIds[kind as LiveDecisionKind].test(text(decoded.id, 180)))
      throw new Error("cursor_invalid");
    return {
      ok: true,
      includeDecisions: true,
      page: { kind: kind as LiveDecisionKind, after: decoded },
    };
  } catch {
    return { ok: false, status: 400 };
  }
}

function nextCursor(item: DecisionItem, tenant: string): string {
  const priority = [
    "execution_uncertain",
    "reconciliation_required",
    "stop_reconciliation_required",
  ].includes(item.native_state)
    ? 0
    : ["pending", "pending_review"].includes(item.native_state)
      ? 1
      : [
            "executing",
            "submission_pending",
            "submitted",
            "stop_submitted",
          ].includes(item.native_state)
        ? 2
        : 3;
  const value: DecisionCursor = {
    v: 1,
    kind: item.kind,
    tenant,
    priority,
    updated_at: item.updated_at,
    id: item.id,
  };
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function buildDecisionsReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
  page?: DecisionPageRequest,
): Promise<DecisionsReadModel> {
  const kinds = page
    ? visibleKinds(auth).filter((kind) => kind === page.kind)
    : visibleKinds(auth);
  const canReadApprovals =
    auth.permissions.includes("approvals:read") &&
    ["owner", "ops", "sales"].includes(auth.session.role);

  const reads = await Promise.allSettled(
    kinds.map(async (kind) => {
      const placeholders = states[kind].map(() => "?").join(", ");
      const after = page?.after;
      const keyset = after
        ? `AND (${prioritySql} > ? OR (${prioritySql} = ? AND
      (updated_at < ? OR (updated_at = ? AND id > ?))))`
        : "";
      const result = await env.DB.prepare(
        `${queries[kind]} WHERE tenant_id = ? AND state IN (${placeholders})
      ${keyset} ORDER BY ${prioritySql}, updated_at DESC, id ASC LIMIT ?`,
      )
        .bind(
          auth.session.tenant_id,
          ...states[kind],
          ...(after
            ? [
                after.priority,
                after.priority,
                after.updated_at,
                after.updated_at,
                after.id,
              ]
            : []),
          DECISION_SOURCE_LIMIT + 1,
        )
        .all<Record<string, unknown>>();
      if (!result.success || !Array.isArray(result.results)) {
        throw new Error("decision_source_unavailable");
      }
      return {
        items: result.results
          .slice(0, DECISION_SOURCE_LIMIT)
          .map((row) => projectDecision(kind, row)),
        hasMore: result.results.length > DECISION_SOURCE_LIMIT,
      };
    }),
  );

  const items: DecisionItem[] = [];
  const sources: DecisionSource[] = reads.map((read, index) => {
    const kind = kinds[index];
    if (read.status === "rejected") {
      return {
        kind,
        state: "unavailable",
        loaded_count: 0,
        has_more: null,
        next_cursor: null,
        read_model_generated_at: null,
      };
    }
    items.push(...read.value.items);
    return {
      kind,
      state: read.value.hasMore ? "limited" : "current",
      loaded_count: read.value.items.length,
      has_more: read.value.hasMore,
      next_cursor: read.value.hasMore
        ? nextCursor(read.value.items.at(-1)!, auth.session.tenant_id)
        : null,
      read_model_generated_at: now.toISOString(),
    };
  });
  if (canReadApprovals && !page) {
    // The native scheduling cutover retired this entire API family. Its old
    // ledger is not a source of current decisions and must never be queried here.
    sources.splice(3, 0, {
      kind: "production_schedule",
      state: "retired",
      loaded_count: 0,
      has_more: null,
      next_cursor: null,
      read_model_generated_at: null,
    });
  }
  return {
    version: 1,
    state: sources.some(
      (source) => source.state === "limited" || source.state === "unavailable",
    )
      ? "limited"
      : items.length > 0
        ? "ready"
        : "empty",
    sources,
    items,
  };
}

function projectDecision(
  kind: LiveDecisionKind,
  row: Record<string, unknown>,
): DecisionItem {
  const id = text(row.id, 180);
  if (!nativeIds[kind].test(id)) throw new Error("decision_id_invalid");
  const nativeState = text(row.state, 64);
  if (!states[kind].includes(nativeState))
    throw new Error("decision_state_invalid");
  const version = positiveInteger(row.version);
  const jobId = row.job_id === null ? null : text(row.job_id, 160);
  if (
    [
      "quote_revision",
      "proposal_publication",
      "quickbooks_final_invoice",
    ].includes(kind) &&
    !jobId
  ) {
    throw new Error("decision_job_missing");
  }
  if (jobId && (jobId === "." || jobId === ".." || jobId !== jobId.trim()))
    throw new Error("decision_job_invalid");
  let title: string;
  let href: string;
  switch (kind) {
    case "lead_triage":
      title = "Review lead note";
      href = `/approvals?review=${encodeURIComponent(id)}`;
      break;
    case "quote_revision":
      title = `Review empty draft V${positiveInteger(row.target_quote_version)}`;
      href = `/quote-revision-approvals/${encodeURIComponent(id)}`;
      break;
    case "proposal_publication":
      if (!jobId) throw new Error("decision_job_missing");
      title = "Review proposal publication";
      href = `/estimator/jobs/${encodeURIComponent(jobId)}`;
      break;
    case "postiz":
      title = "Review marketing publication";
      href = `/marketing/postiz/${encodeURIComponent(id)}`;
      break;
    case "quickbooks_final_invoice":
      title = "Review final invoice";
      href = `/accounting/quickbooks/final-invoices/${encodeURIComponent(id)}`;
      break;
  }
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    version,
    native_state: nativeState,
    title,
    summary: text(row.summary, 4_000),
    job_id: jobId,
    updated_at: text(row.updated_at, 80),
    expires_at: row.expires_at === null ? null : text(row.expires_at, 80),
    review_href: href,
  };
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error("decision_field_invalid");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("decision_version_invalid");
  }
  return value;
}
