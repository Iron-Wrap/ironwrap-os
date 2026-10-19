// Provider data terms per run class, as docs/COMPLIANCE-REGISTER.md "AI model providers" records
// them. Every provider account names the register row it is on (`compliance_ref`). This table is
// that register as code: configuration cannot widen it, except an owner risk acceptance, which adds
// `eval_history` to a consumer ref and nothing else.

import type { ProviderConfig } from "./config.ts";
import type { AdapterKind, CredentialMode, RiskAcceptance, RunClass, Scope } from "./types.ts";

export interface ComplianceRef {
  /** The adapter and credential mode an account on this ref has. */
  adapter: AdapterKind;
  credentialMode: CredentialMode;
  /** Run classes the ref serves without an owner risk acceptance. */
  runClasses: readonly RunClass[];
  /** Consumer terms: never live or shadow, and `eval_history` only under an owner risk acceptance. */
  consumer: boolean;
  /** Live and shadow runs wait for the owner's written retention confirmation (`confirmed_retention`). */
  retentionConfirmation: boolean;
}

const EVERY: readonly RunClass[] = ["live", "shadow", "eval_history", "synthetic"];
const SYNTHETIC: readonly RunClass[] = ["synthetic"];

export const COMPLIANCE_REFS: Readonly<Record<string, ComplianceRef>> = Object.freeze({
  "ai.anthropic.api": { adapter: "claude_agent_sdk", credentialMode: "api_key", runClasses: EVERY, consumer: false, retentionConfirmation: false },
  "ai.anthropic.claude-commercial": { adapter: "claude_agent_sdk", credentialMode: "oauth", runClasses: EVERY, consumer: false, retentionConfirmation: false },
  "ai.anthropic.claude-consumer": { adapter: "claude_agent_sdk", credentialMode: "oauth", runClasses: SYNTHETIC, consumer: true, retentionConfirmation: false },
  "ai.openai.api": { adapter: "codex", credentialMode: "api_key", runClasses: EVERY, consumer: false, retentionConfirmation: false },
  "ai.openai.chatgpt-commercial": { adapter: "codex", credentialMode: "oauth", runClasses: EVERY, consumer: false, retentionConfirmation: true },
  "ai.openai.chatgpt-consumer": { adapter: "codex", credentialMode: "oauth", runClasses: SYNTHETIC, consumer: true, retentionConfirmation: false },
});

/**
 * ChatGPT plan claims of consumer plans, as the Codex CLI names them; the commercial ref refuses a
 * sign-in plan list that holds one, so a personal sign-in cannot pass for a business workspace.
 */
export const CONSUMER_CHATGPT_PLANS: ReadonlySet<string> = new Set(["free", "go", "plus", "pro", "prolite", "promax"]);

/** What data the host's Worker holds: `business` (the default) or `synthetic` (a QA or dev host on seed data). */
export type DataClass = "business" | "synthetic";

/**
 * A run's class: eval runs from the request's `data` (unset reads as history, the stricter class);
 * live and shadow runs from the scope, except on a synthetic host, where every run is synthetic.
 */
export function runClassOf(scope: Scope, dataClass: DataClass, data: "synthetic" | "history" | undefined): RunClass {
  if (scope === "eval") return data === "synthetic" ? "synthetic" : "eval_history";
  if (dataClass === "synthetic") return "synthetic";
  return scope === "shadow" ? "shadow" : "live";
}

/**
 * Whether the account's terms let it serve this run class: the reason it may not, or the owner
 * risk acceptance that lets it (null when its ref allows the class outright).
 */
export function complianceOf(
  account: Pick<ProviderConfig, "id" | "complianceRef" | "confirmedRetention">,
  runClass: RunClass,
  acceptances: readonly RiskAcceptance[],
): { refused: string } | { acceptance: RiskAcceptance | null } {
  const name = account.complianceRef;
  if (name === null) return { refused: `${account.id} names no compliance_ref, so it serves no run (docs/COMPLIANCE-REGISTER.md)` };
  // The parser takes only refs of the table; own keys only, so no prototype member passes for one.
  if (!Object.hasOwn(COMPLIANCE_REFS, name)) return { refused: `${account.id} names ${name}, which the compliance register does not hold` };
  const ref = COMPLIANCE_REFS[name];
  let acceptance: RiskAcceptance | null = null;
  if (!ref.runClasses.includes(runClass)) {
    acceptance = (ref.consumer && acceptances.find((entry) => entry.ref === name && entry.runClass === runClass)) || null;
    if (acceptance === null) return { refused: `${account.id} is on ${name}, which does not serve ${runClass} runs` };
  }
  if (ref.retentionConfirmation && (runClass === "live" || runClass === "shadow") && account.confirmedRetention === null) {
    return { refused: `${account.id} is on ${name}, which serves ${runClass} runs only after the owner's confirmed_retention is recorded` };
  }
  return { acceptance };
}
