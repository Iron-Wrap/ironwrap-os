// The AI team catalog as the Worker enforces it: the machine-readable block of
// docs/AI-TEAM-CONTRACT.md, copied byte for byte into contract-catalog.ts. Classes, owners,
// delegability and protective marks come only from here; nothing at runtime changes them.

import { CATALOG_JSON, CATALOG_SHA256 } from "./contract-catalog.ts";

export type Autonomy = "A0" | "A1" | "A2" | "A3" | "H";
export type Delegation = "asks_first" | "within_limits" | "off_until_enabled";
export type SideEffectClass =
  | "none"
  | "internal_reversible"
  | "external_reversible"
  | "external_irreversible"
  | "money"
  | "legal"
  | "safety";

export interface CatalogSpecialist {
  specialist_id: string;
  display_name: string;
  reviewer_role: string;
  wave: number;
  tiers: string[];
  watches: string[];
}

export interface CatalogAction {
  action_id: string;
  owners: string[];
  aggregate: string;
  autonomy: Autonomy;
  human_only: boolean;
  side_effect_class: SideEffectClass;
  readback: "none" | "owned_store" | "provider";
  default_delegation: Delegation | null;
  delegable: boolean;
  undo: "none" | "automatic" | "manual";
  requires_citations: boolean;
  protective: boolean;
  reviewer_role: string | null;
  reason_codes?: string[];
  never_targets?: string[];
}

export interface CatalogWatch {
  watch_id: string;
  owner: string;
  every?: string;
  trigger?: string;
  after?: string[];
  proposes: string[];
}

export interface Catalog {
  schema: "ironwrap_ai_team_contract_v1";
  specialists: CatalogSpecialist[];
  actions: CatalogAction[];
  watches: CatalogWatch[];
  receipt: {
    fields: string[];
    outcomes: string[];
    policy_results: string[];
    permit_kinds: string[];
    reason_codes: Record<string, string[]>;
  };
}

export const CATALOG: Catalog = JSON.parse(CATALOG_JSON);
export const CATALOG_VERSION = CATALOG_SHA256;

const ACTIONS = new Map(CATALOG.actions.map((action) => [action.action_id, action]));
const SPECIALISTS = new Map(CATALOG.specialists.map((specialist) => [specialist.specialist_id, specialist]));

export function catalogAction(actionId: string): CatalogAction | null {
  return ACTIONS.get(actionId) ?? null;
}

export function catalogSpecialist(specialistId: string): CatalogSpecialist | null {
  return SPECIALISTS.get(specialistId) ?? null;
}

/** MCP tool names allow no dots; action ids never contain "__", so the mapping is one to one. */
export function toolName(actionId: string): string {
  return actionId.replaceAll(".", "__");
}

export function isReasonCode(outcome: "failed" | "unknown" | "abstained", code: string): boolean {
  return (CATALOG.receipt.reason_codes[outcome] ?? []).includes(code);
}
