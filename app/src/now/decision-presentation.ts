import type { DecisionItem, DecisionKind, NowCard, NowResponse } from "./now-contracts";
import type { StatusKind } from "../components/ui/status";

export const decisionLabels: Record<DecisionKind, string> = {
  lead_triage: "Lead reviews",
  quote_revision: "Quote changes",
  proposal_publication: "Proposals",
  production_schedule: "Schedule approvals",
  postiz: "Marketing",
  quickbooks_final_invoice: "Final invoices",
};

export function decisionStatus(item: DecisionItem): { label: string; kind: StatusKind } {
  const state = item.native_state;
  if (state.includes("uncertain") || state.includes("reconciliation")) {
    return { label: "Check the result", kind: "attention" };
  }
  if (state === "failed" || state === "audit_failed" || state === "blocked") {
    return {
      label: state === "audit_failed" ? "Save record failed" : "Needs a check",
      kind: "stopped",
    };
  }
  if (state === "connection_required") return { label: "Connect account", kind: "attention" };
  if (state === "executing" || state === "submission_pending")
    return { label: "In progress", kind: "pending" };
  if (state === "pending" || state === "pending_review")
    return { label: "Needs review", kind: "attention" };
  return {
    label: state.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
    kind: "neutral",
  };
}

/** Present the real decisions projection in the same Now list and inspector. */
export function decisionsView(model: NowResponse): NowResponse {
  const decisions = model.decisions;
  const count = decisions?.items.length ?? 0;
  const limited = !decisions || decisions.state === "limited";
  return {
    ...model,
    ui: {
      ...model.ui,
      state: limited ? "limited" : count ? "ready" : "empty",
      title: "Decisions",
      explanation: "Review requests and check uncertain results in their work records.",
      sync_label: !decisions
        ? "The decisions list is unavailable. Refresh to check again."
        : limited
          ? "This list is incomplete. Check the source status before assuming there is no more work."
          : count
            ? `${count} ${count === 1 ? "request loaded" : "requests loaded"}. Open a record to review its current state.`
            : decisions.sources.some((source) => source.state !== "retired")
              ? "No open requests in the connected decision sources."
              : "No decision sources are available for your role.",
      primary_action: null,
      sections: (decisions?.sources ?? [])
        .filter((source) => source.state !== "retired")
        .map((source) => ({
          id: source.kind,
          title: decisionLabels[source.kind],
          summary:
            source.state === "unavailable"
              ? "This source could not load."
              : source.has_more
                ? `${source.loaded_count} requests loaded; more are available in this source.`
                : `${source.loaded_count} ${source.loaded_count === 1 ? "request loaded" : "requests loaded"}.`,
          cards: (decisions?.items ?? [])
            .filter((item) => item.kind === source.kind)
            .map((item): NowCard => ({
              id: item.key,
              tone: decisionStatus(item).kind === "stopped" ? "critical" : "neutral",
              eyebrow: decisionLabels[item.kind],
              title: item.title,
              detail: item.summary,
              action: {
                id: `review:${item.key}`,
                kind: "navigate",
                label: "Open review",
                href: item.review_href,
                reason: "Check the current record before choosing an action.",
                citation_ids: [],
              },
              citations: [],
            })),
        })),
    },
  };
}
