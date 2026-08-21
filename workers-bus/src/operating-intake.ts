// D1-native operating intake. Website/estimate envelopes are the owned lead
// record. This module is the desk-facing read of that spine. It does not
// invent a Roof Job, portal proposal, or money intent — those stay IRO-195 /
// IRO-31. Frappe is never consulted.

import { OPERATING_TENANT_ID_RE, operatingTenantId, type EnvelopeRecord } from "./core.ts";
import { listRecentEnvelopes } from "./store.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

export type EnvelopeId = string & { readonly __brand: "EnvelopeId" };
export type TenantId = string & { readonly __brand: "TenantId" };

const OPERATING_AUTHORITY = "d1" as const;
const DESK_STATE = "intake" as const;
const INTAKE_LIMIT = 50;
const ENVELOPE_ID_RE = /^ow_[0-9a-f-]{36}$/;

const DESK_PERMISSIONS = [
  "now:read",
  "today:read",
  "sales:read",
  "production:read",
  "accounting:read",
] as const;

export type OperatingAuthority = typeof OPERATING_AUTHORITY;
export type IntakeDeskState = typeof DESK_STATE;

export interface OperatingIntakeLead {
  envelope_id: EnvelopeId;
  source: string;
  status: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  received_at: string;
  job_ref: string | null;
  desk_state: IntakeDeskState;
  not_a_scheduled_job: true;
  not_a_money_intent: true;
}

export interface OperatingIntakeReadModel {
  version: 1;
  operating_authority: OperatingAuthority;
  tenant_id: TenantId;
  generated_at: string;
  leads: OperatingIntakeLead[];
}

export function isEnvelopeId(value: string): value is EnvelopeId {
  return ENVELOPE_ID_RE.test(value);
}

export function isTenantId(value: string): value is TenantId {
  return OPERATING_TENANT_ID_RE.test(value);
}

export function parseEnvelopeId(value: string): EnvelopeId | null {
  return isEnvelopeId(value) ? value : null;
}

export function parseTenantId(value: string | null): TenantId | null {
  const tenantId = operatingTenantId(value);
  return tenantId && isTenantId(tenantId) ? tenantId : null;
}

export function canReadOperatingIntake(auth: AuthContext): boolean {
  return DESK_PERMISSIONS.some((permission) => auth.permissions.includes(permission));
}

export async function buildOperatingIntakeReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<
  OperatingIntakeReadModel | { error: "tenant_identity_required" | "operating_intake_read_required" }
> {
  if (!canReadOperatingIntake(auth)) return { error: "operating_intake_read_required" };
  const tenantId = parseTenantId(env.APP_TENANT_ID ?? auth.session.tenant_id);
  if (!tenantId) return { error: "tenant_identity_required" };

  const rows = await listRecentEnvelopes(env, INTAKE_LIMIT);
  return {
    version: 1,
    operating_authority: OPERATING_AUTHORITY,
    tenant_id: tenantId,
    generated_at: now.toISOString(),
    leads: rows.flatMap((row) => projectIntakeLead(row, tenantId)),
  };
}

export function projectIntakeLead(
  row: EnvelopeRecord,
  tenantId: TenantId,
): OperatingIntakeLead[] {
  if (row.status === "duplicate") return [];
  if (row.tenant_id && row.tenant_id !== tenantId) return [];
  const envelopeId = parseEnvelopeId(row.envelope_id);
  if (!envelopeId) return [];
  return [
    {
      envelope_id: envelopeId,
      source: row.source,
      status: row.status,
      contact_name: row.contact_name,
      contact_phone: row.contact_phone,
      contact_email: row.contact_email,
      received_at: row.ts,
      job_ref: row.job_ref,
      desk_state: DESK_STATE,
      not_a_scheduled_job: true,
      not_a_money_intent: true,
    },
  ];
}
