// Loads a specialist exactly as `specialists/README.md` defines it: COMMON.md, then the
// specialist's playbook, then its allowlist. A malformed playbook or allowlist fails the load;
// the runtime never falls back to a broader tool set.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tier } from "../gateway/types.ts";

export const PLAYBOOK_HEADINGS = [
  "Mission",
  "Watches",
  "Reads",
  "Reasoning from macro to micro",
  "Decision rules",
  "Never",
  "Abstain and escalate",
  "Drafts and tone",
  "Receipt",
] as const;

const SPECIALIST_ID = /^[a-z][a-z0-9_]{1,63}$/;
const AUTONOMY = new Set(["A0", "A1", "A2", "A3"]);
const TIERS = new Set<Tier>(["routine", "hard", "audit"]);

export interface AllowlistEntry {
  action_id: string;
  autonomy: "A0" | "A1" | "A2" | "A3";
  purpose: string;
}

export interface Specialist {
  id: string;
  displayName: string;
  tier: Tier;
  common: string;
  playbook: string;
  allowlist: AllowlistEntry[];
  /** The contract catalog revision the allowlist pins, part of the release; null when it pins none. */
  catalogSha256: string | null;
}

export class SpecialistLoadError extends Error {
  constructor(id: string, message: string) {
    super(`specialist ${id}: ${message}`);
    this.name = "SpecialistLoadError";
  }
}

export async function loadSpecialist(root: string, id: string): Promise<Specialist> {
  if (!SPECIALIST_ID.test(id)) throw new SpecialistLoadError(id, "is not a specialist id");
  const fail = (message: string): never => {
    throw new SpecialistLoadError(id, message);
  };
  const read = async (path: string) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return fail(`${path} is missing`);
    }
  };
  const common = await read("COMMON.md");
  const playbook = await read(join(id, "playbook.md"));
  const rawAllowlist = await read(join(id, "allowlist.json"));

  const title = /^# (.+)$/m.exec(playbook)?.[1]?.trim() ?? fail("playbook has no title");
  const declaredId = /^Specialist id: `([^`]+)`$/m.exec(playbook)?.[1];
  if (declaredId !== id) fail(`playbook declares specialist id ${declaredId ?? "nothing"}`);
  const tier = /^Runtime tier: (\w+)$/m.exec(playbook)?.[1] as Tier | undefined;
  if (!tier || !TIERS.has(tier)) fail("playbook has no valid Runtime tier");
  const headings = [...playbook.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  if (headings.join("\n") !== PLAYBOOK_HEADINGS.join("\n")) {
    fail(`playbook headings must be exactly: ${PLAYBOOK_HEADINGS.join(", ")}`);
  }

  let allowlist: { schema_version?: unknown; specialist_id?: unknown; catalog_sha256?: unknown; actions?: unknown };
  try {
    allowlist = JSON.parse(rawAllowlist);
  } catch {
    return fail("allowlist.json is not JSON");
  }
  if (allowlist.schema_version !== "ironwrap.specialist-allowlist.v1") fail("allowlist schema_version is wrong");
  if (allowlist.specialist_id !== id) fail("allowlist names another specialist");
  if (!Array.isArray(allowlist.actions) || allowlist.actions.length === 0) fail("allowlist has no actions");
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const entry of allowlist.actions as Array<Record<string, unknown>>) {
    const actionId = entry?.action_id;
    if (typeof actionId !== "string" || actionId === "") fail("allowlist entry without action_id");
    if (seen.has(actionId as string)) fail(`allowlist lists ${String(actionId)} twice`);
    if (!AUTONOMY.has(entry.autonomy as string)) fail(`allowlist ${String(actionId)} has autonomy outside A0-A3`);
    seen.add(actionId as string);
    entries.push({
      action_id: actionId as string,
      autonomy: entry.autonomy as AllowlistEntry["autonomy"],
      purpose: typeof entry.purpose === "string" ? entry.purpose : "",
    });
  }
  const catalogSha256 = typeof allowlist.catalog_sha256 === "string" && /^[0-9a-f]{64}$/.test(allowlist.catalog_sha256) ? allowlist.catalog_sha256 : null;
  return { id, displayName: title, tier: tier as Tier, common, playbook, allowlist: entries, catalogSha256 };
}
