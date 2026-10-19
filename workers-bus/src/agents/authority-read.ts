// The A0 read behind `authority.evaluate` (registry binding `authority_read`): the authority records
// as the authority desk and the work fence read them (authority-records.ts), answered with the
// step's decision and written nowhere. It returns the named record's current head with the fence's
// own denial (`currentAuthorityHeads`, `lifecycleDenialForRow`) and, when the named assignment is
// the job's current one, each requirement frozen on it, resolved as the fence resolves it before
// work starts (`resolveAuthorityRequirement`). D1 holds no applicability record, so
// `applicability_id` stays on the receipt as the decision the step cites.
//
// The reader needs `authority:read` for the records and, because the read names a job's
// assignment, `production:read` or `jobs:read:any` as well: field holds `authority:read` but reads
// only the jobs it is assigned (`jobs:read:assigned`), so it reads none of this. A read the reader
// may not make, or one that fails, is answered with why (`role_may_not_read`, `read_failed`), and
// the step abstains (store.ts `readStop`).

import { permissionsForRole, ROLE_PERMISSIONS, type AppEnv, type AppRole } from "../app-types.ts";
import {
  currentAuthorityHeads,
  lifecycleDenialForRow,
  listAuthorityRecordReadbacks,
  resolveAuthorityRequirement,
  type AuthorityLifecycleDenial,
  type AuthorityRequirement,
} from "../authority-records.ts";
import { getCurrentOperatingJobAssignment } from "../operating-job-assignment-store.ts";
import type { AgentDb } from "./store.ts";

export interface AuthorityEvaluation {
  /** Null when the tenant holds no readback of the named record. */
  authority: {
    authority_record_id: string;
    /** The current head; null when its current versions contradict each other. */
    head: {
      authority_version: number;
      authority_kind: string | null;
      scope_type: string | null;
      scope_ref: string | null;
      verification_state: string;
      authority_effective_from: string | null;
      authority_expires_at: string | null;
      authority_revoked_at: string | null;
    } | null;
    denial_code: AuthorityLifecycleDenial | null;
  } | null;
  /** Null unless the named assignment is the named job's current one. */
  assignment: {
    assignment_id: string;
    roof_job_id: string;
    assignment_version: number;
    requirements: Array<{
      requirement: AuthorityRequirement;
      ok: boolean;
      denial_code: AuthorityLifecycleDenial | null;
      /** The current head that meets or fails the requirement, when one was found. */
      authority_record_id: string | null;
      authority_version: number | null;
    }>;
  } | null;
}

/** Why an authority read was not made, or did not finish. */
export interface AuthorityReadRefusal {
  reason: "role_may_not_read" | "read_failed";
}

/** Whether a role may read authority records and the job assignments the read names. */
export function readsAuthority(role: string | null): boolean {
  const permissions = role && Object.hasOwn(ROLE_PERMISSIONS, role) ? permissionsForRole(role as AppRole) : [];
  return permissions.includes("authority:read") && (permissions.includes("production:read") || permissions.includes("jobs:read:any"));
}

export async function evaluateAuthority(
  db: AgentDb,
  tenantId: string,
  role: string | null,
  args: { authority_id: string; job_id: string; assignment_id: string },
  now: string,
): Promise<AuthorityEvaluation | AuthorityReadRefusal> {
  if (!readsAuthority(role)) return { reason: "role_may_not_read" };
  const env = { DB: db } as unknown as AppEnv;
  try {
    const rows = await listAuthorityRecordReadbacks(env, tenantId, args.authority_id, 100);
    const heads = currentAuthorityHeads(rows);
    const head = heads.code ? null : (heads.rows[0] ?? null);
    const current = await getCurrentOperatingJobAssignment(env, tenantId, args.job_id);
    const assignment = current?.assignment_id === args.assignment_id ? current : null;
    const requirements = [];
    for (const requirement of assignment?.authority_requirements ?? []) {
      const verdict = await resolveAuthorityRequirement(env, { tenantId, now, requirement });
      requirements.push({
        requirement,
        ok: verdict.ok,
        denial_code: verdict.code,
        authority_record_id: verdict.current?.authority_record_id ?? null,
        authority_version: verdict.current?.authority_version ?? null,
      });
    }
    return {
      authority:
        rows.length === 0
          ? null
          : {
              authority_record_id: args.authority_id,
              head: head && {
                authority_version: head.authority_version,
                authority_kind: head.authority_kind,
                scope_type: head.scope_type,
                scope_ref: head.scope_ref,
                verification_state: head.verification_state,
                authority_effective_from: head.authority_effective_from,
                authority_expires_at: head.authority_expires_at,
                authority_revoked_at: head.authority_revoked_at,
              },
              denial_code: heads.code ?? (head ? lifecycleDenialForRow(head, { tenantId, now }) : "authority_missing"),
            },
      assignment: assignment && {
        assignment_id: assignment.assignment_id,
        roof_job_id: assignment.roof_job_id,
        assignment_version: assignment.assignment_version,
        requirements,
      },
    };
  } catch {
    return { reason: "read_failed" };
  }
}
