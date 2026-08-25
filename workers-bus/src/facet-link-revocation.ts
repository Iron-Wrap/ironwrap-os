import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv } from "./app-types.ts";

export const FACET_LINK_REVOCATION_REASON_CODES = [
  "project_rebound",
  "producer_identity_compromised",
  "customer_identity_compromised",
  "source_authority_drift",
] as const;

export type FacetLinkRevocationKind =
  | "producer_identity"
  | "project"
  | "customer_identity";

export type FacetLinkRevocationReason =
  (typeof FACET_LINK_REVOCATION_REASON_CODES)[number];

export interface FacetLinkRevocationBody {
  link_kind: FacetLinkRevocationKind;
  link_id: string;
  reason_code: FacetLinkRevocationReason;
}

export interface FacetLinkRevocationRecord {
  revocation_id: string;
  link_kind: FacetLinkRevocationKind;
  link_id: string;
  reason_code: FacetLinkRevocationReason;
  revoked_by_user_id: string;
  destination_tenant_id: string;
  revoked_at: string;
}

export type FacetLinkRevocationResult =
  | {
      kind: "created" | "replayed";
      revocation: FacetLinkRevocationRecord;
    }
  | {
      kind: "rejected";
      code: "facet_link_not_found" | "facet_link_revocation_conflict";
      status: 404 | 409;
    };

const LINK_ID_PATTERNS: Record<FacetLinkRevocationKind, RegExp> = {
  producer_identity: /^ironwrap-identity-v1:[0-9a-f]{64}$/,
  project: /^ironwrap-project-v1:[0-9a-f]{64}$/,
  customer_identity: /^facet-customer-oidc-v1:[0-9a-f]{64}$/,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseFacetLinkRevocationBody(
  value: unknown,
): FacetLinkRevocationBody | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  if (
    !Object.prototype.hasOwnProperty.call(value, "link_kind") ||
    !Object.prototype.hasOwnProperty.call(value, "link_id") ||
    !Object.prototype.hasOwnProperty.call(value, "reason_code")
  ) return null;
  const linkKind = value.link_kind;
  const linkId = value.link_id;
  const reasonCode = value.reason_code;
  if (
    (linkKind !== "producer_identity" &&
      linkKind !== "project" &&
      linkKind !== "customer_identity") ||
    typeof linkId !== "string" ||
    !LINK_ID_PATTERNS[linkKind].test(linkId) ||
    typeof reasonCode !== "string" ||
    !(FACET_LINK_REVOCATION_REASON_CODES as readonly string[]).includes(reasonCode)
  ) return null;
  return {
    link_kind: linkKind,
    link_id: linkId,
    reason_code: reasonCode as FacetLinkRevocationReason,
  };
}

interface FacetLinkRevocationInput extends FacetLinkRevocationBody {
  tenantId: string;
  actorUserId: string;
  now?: Date;
}

type D1Row = Record<string, unknown>;

async function first<T>(env: Pick<AppEnv, "DB">, sql: string, ...args: unknown[]) {
  return await env.DB.prepare(sql).bind(...args).first<T>();
}

async function linkExists(
  env: Pick<AppEnv, "DB">,
  input: Pick<FacetLinkRevocationInput, "link_kind" | "link_id" | "tenantId">,
): Promise<boolean> {
  let row: D1Row | null;
  if (input.link_kind === "producer_identity") {
    row = await first<D1Row>(
      env,
      `SELECT producer_identity_link_id
         FROM facet_v2_producer_identity_links
        WHERE producer_identity_link_id = ? AND destination_tenant_id = ?
        LIMIT 1`,
      input.link_id,
      input.tenantId,
    );
  } else if (input.link_kind === "project") {
    row = await first<D1Row>(
      env,
      `SELECT external_project_link_id
         FROM facet_v2_project_links
        WHERE external_project_link_id = ? AND destination_tenant_id = ?
        UNION ALL
       SELECT external_project_link_id
         FROM facet_v2_prequote_project_links
        WHERE external_project_link_id = ? AND destination_tenant_id = ?
        LIMIT 1`,
      input.link_id,
      input.tenantId,
      input.link_id,
      input.tenantId,
    );
  } else {
    row = await first<D1Row>(
      env,
      `SELECT external_customer_identity_link_id
         FROM facet_v2_project_links
        WHERE external_customer_identity_link_id = ? AND destination_tenant_id = ?
        UNION ALL
       SELECT external_customer_identity_link_id
         FROM facet_v2_prequote_project_links
        WHERE external_customer_identity_link_id = ? AND destination_tenant_id = ?
        LIMIT 1`,
      input.link_id,
      input.tenantId,
      input.link_id,
      input.tenantId,
    );
  }
  return !!row;
}

async function readRevocation(
  env: Pick<AppEnv, "DB">,
  input: Pick<FacetLinkRevocationInput, "link_kind" | "link_id" | "tenantId">,
): Promise<FacetLinkRevocationRecord | null> {
  return await first<FacetLinkRevocationRecord>(
    env,
    `SELECT revocation_id, link_kind, link_id, reason_code,
            revoked_by_user_id, destination_tenant_id, revoked_at
       FROM facet_v2_link_revocations
      WHERE link_kind = ? AND link_id = ? AND destination_tenant_id = ?
      LIMIT 1`,
    input.link_kind,
    input.link_id,
    input.tenantId,
  );
}

function sameRevocation(
  record: FacetLinkRevocationRecord,
  input: Pick<FacetLinkRevocationInput, "link_kind" | "link_id" | "reason_code" | "tenantId">,
): boolean {
  return record.link_kind === input.link_kind &&
    record.link_id === input.link_id &&
    record.reason_code === input.reason_code &&
    record.destination_tenant_id === input.tenantId;
}

export async function revokeFacetLink(
  env: Pick<AppEnv, "DB">,
  input: FacetLinkRevocationInput,
): Promise<FacetLinkRevocationResult> {
  if (!(await linkExists(env, input))) {
    return { kind: "rejected", code: "facet_link_not_found", status: 404 };
  }

  const existing = await readRevocation(env, input);
  if (existing) {
    return sameRevocation(existing, input)
      ? { kind: "replayed", revocation: existing }
      : { kind: "rejected", code: "facet_link_revocation_conflict", status: 409 };
  }

  const revocationId = `facet-link-revocation-v1:${await sha256Hex(canonicalJson({
    link_id: input.link_id,
    link_kind: input.link_kind,
    reason_code: input.reason_code,
    tenant_id: input.tenantId,
  }))}`;
  const revokedAt = (input.now ?? new Date()).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO facet_v2_link_revocations
       (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
        destination_tenant_id, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revocationId,
      input.link_kind,
      input.link_id,
      input.reason_code,
      input.actorUserId,
      input.tenantId,
      revokedAt,
    ).run();
  } catch {
    const raced = await readRevocation(env, input);
    if (!raced) throw new Error("facet_link_revocation_insert_failed");
    return sameRevocation(raced, input)
      ? { kind: "replayed", revocation: raced }
      : { kind: "rejected", code: "facet_link_revocation_conflict", status: 409 };
  }

  const persisted = await readRevocation(env, input);
  if (!persisted || !sameRevocation(persisted, input) ||
      persisted.revocation_id !== revocationId ||
      persisted.revoked_by_user_id !== input.actorUserId ||
      persisted.revoked_at !== revokedAt) {
    throw new Error("facet_link_revocation_readback_mismatch");
  }
  return { kind: "created", revocation: persisted };
}
