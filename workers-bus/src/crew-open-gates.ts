import { ROLE_PERMISSIONS, type AppEnv } from "./app-types.ts";

export const CREW_SCHEDULING_GATES = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;
export type CrewSchedulingGate = (typeof CREW_SCHEDULING_GATES)[number];
export interface CrewOpenGate {
  gate: CrewSchedulingGate;
  label: string;
  clearer_display_name: string;
}
export interface CrewOpenGatesProjection {
  open_gates: CrewOpenGate[] | null;
  stale_fields: string[];
}
interface GateRow {
  gate: string;
  state: string;
  owner_user: string;
}
interface HolderRow {
  gate: CrewSchedulingGate;
  display_name: string;
  ambiguous_name: number;
  assigned: number;
  holder_count: number;
  assignee_count: number;
}
const NON_BLOCKING = new Set(["ready", "waived", "complete"]);
const KNOWN_STATES = new Set(["blocked", "in_progress", ...NON_BLOCKING]);
const CLEAR_ROLES = Object.entries(ROLE_PERMISSIONS)
  .filter(([, permissions]) => permissions.includes("production:clear_gate"))
  .map(([role]) => role);
const QA_SEED_CREATOR = "system:owner_directed_qa_seed_grant";

function usableName(row: HolderRow): string | null {
  const name = row.display_name?.trim();
  // A display field can contain an email or an ambiguous name; neither should identify a clearer.
  return name &&
    name.length <= 120 &&
    !row.ambiguous_name &&
    !/[@\u0000-\u001f\u007f]/.test(name)
    ? name
    : null;
}

/**
 * A narrow crew projection, called only after the existing job/assignment authorization. This
 * never grants clearance or serializes office ledger, identity, evidence or competency records.
 * Stored gates, live safety stops, Weather validity and the cancellation window are distinct.
 */
export async function crewOpenGatesForJob(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  source: { rows: readonly GateRow[]; partial: boolean; unavailable?: boolean },
): Promise<CrewOpenGatesProjection> {
  if (source.unavailable)
    return { open_gates: null, stale_fields: ["open_gates.unavailable"] };
  const rows = source.rows.filter((row) =>
    (CREW_SCHEDULING_GATES as readonly string[]).includes(row.gate),
  );
  if (
    source.partial ||
    rows.length !== CREW_SCHEDULING_GATES.length ||
    new Set(rows.map((row) => row.gate)).size !==
      CREW_SCHEDULING_GATES.length ||
    rows.some((row) => !KNOWN_STATES.has(row.state))
  ) {
    return { open_gates: null, stale_fields: ["open_gates.incomplete"] };
  }
  const open = CREW_SCHEDULING_GATES.flatMap((gate) =>
    rows.filter((row) => row.gate === gate && !NON_BLOCKING.has(row.state)),
  );
  if (open.length === 0) return { open_gates: [], stale_fields: [] };
  const named = open.filter((row) => row.gate !== "Crew");
  const byGate = new Map<string, HolderRow[]>();
  const stale: string[] = [];
  if (named.length > 0) {
    try {
      // The same active role/seed exclusion as A1 and the same crew-identity separation and
      // site_safety competency conditions as A3. Window counts inspect the entire holder set;
      // at most three display candidates per gate leave D1, so a bounded read cannot invent a
      // unique holder. A unique eligible explicit assignee sorts before unassigned holders.
      // Non-ASCII/control identity coordinates cannot prove parity with JavaScript normalization;
      // keep their attribution with the office instead of naming a possibly crewed attester.
      const today = new Date().toISOString().slice(0, 10);
      const result = await env.DB.prepare(
        `
        WITH requested(gate, owner_user) AS (VALUES ${named.map(() => "(?, ?)").join(", ")}),
        people AS (
          SELECT user_id, display_name, email_normalized, frappe_user_id
          FROM app_users
          WHERE tenant_id = ? AND active = 1 AND created_by != ?
            AND access_role IN (${CLEAR_ROLES.map(() => "?").join(", ")})
            AND user_id NOT GLOB '*[^ -~]*' AND email_normalized NOT GLOB '*[^ -~]*'
            AND COALESCE(frappe_user_id, '') NOT GLOB '*[^ -~]*'
        ), identities AS (
          SELECT user_id, lower(trim(user_id)) AS identity FROM people
          UNION SELECT user_id, lower(trim(email_normalized)) FROM people
          UNION SELECT user_id, lower(trim(frappe_user_id)) FROM people
            WHERE frappe_user_id IS NOT NULL AND trim(frappe_user_id) != ''
        ), eligible AS (
          SELECT requested.gate, person.user_id, person.display_name,
            EXISTS (SELECT 1 FROM identities i WHERE i.user_id = person.user_id
                     AND i.identity = lower(trim(requested.owner_user))) AS assigned,
            EXISTS (SELECT 1 FROM app_users other
                    WHERE other.tenant_id = ? AND other.active = 1
                      AND other.user_id != person.user_id
                      AND lower(trim(other.display_name)) = lower(trim(person.display_name))) AS ambiguous_name
          FROM requested CROSS JOIN people person
          WHERE (requested.gate = 'Deposit' OR NOT EXISTS (
            SELECT 1 FROM fleet_crew_members membership
            JOIN app_users worker ON worker.tenant_id = membership.tenant_id AND worker.user_id = membership.user_id
            WHERE membership.tenant_id = ? AND membership.active = 1
              AND (worker.user_id GLOB '*[^ -~]*' OR worker.email_normalized GLOB '*[^ -~]*'
                OR COALESCE(worker.frappe_user_id, '') GLOB '*[^ -~]*'
                OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = person.user_id
                          AND i.identity IN (lower(worker.user_id), worker.email_normalized,
                                             lower(trim(worker.frappe_user_id)))))
          )) AND (requested.gate != 'Safety' OR EXISTS (
            SELECT 1 FROM authority_record_readbacks competency
            WHERE competency.tenant_id = ? AND competency.subject_type = 'Person'
              AND competency.subject_role = 'Worker' AND competency.authority_kind = 'Worker Competency'
              AND competency.authority_scope = 'site_safety'
              AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id = person.user_id
                           AND i.identity = lower(trim(competency.person_user)))
              AND (competency.roof_job IS NULL OR competency.roof_job = ?)
              AND competency.verification_state = 'verified' AND competency.authority_revoked_at IS NULL
              AND competency.authority_verification_method = 'Internal Competency Assessment'
              AND competency.authority_effective_from <= ? AND competency.authority_expires_at >= ?
              AND NOT EXISTS (
                SELECT 1 FROM authority_record_readbacks other
                WHERE other.tenant_id = competency.tenant_id
                  AND other.authority_record_id = competency.authority_record_id
                  AND (other.authority_version > competency.authority_version
                    OR (other.authority_version = competency.authority_version
                      AND other.authority_state_digest_sha256 != competency.authority_state_digest_sha256))
              ) AND NOT EXISTS (
                SELECT 1 FROM authority_record_readbacks successor
                WHERE successor.tenant_id = competency.tenant_id
                  AND successor.supersedes_authority_record_id = competency.authority_record_id
              )
          ))
        ), ranked AS (
          SELECT *, COUNT(*) OVER (PARTITION BY gate) AS holder_count,
            SUM(assigned) OVER (PARTITION BY gate) AS assignee_count,
            ROW_NUMBER() OVER (PARTITION BY gate ORDER BY assigned DESC, lower(display_name), user_id) AS ordinal
          FROM eligible
        )
        SELECT gate, display_name, ambiguous_name, assigned, holder_count, assignee_count
        FROM ranked WHERE ordinal <= 3 ORDER BY gate, ordinal
      `,
      )
        .bind(
          ...named.flatMap((row) => [row.gate, row.owner_user]),
          tenantId,
          QA_SEED_CREATOR,
          ...CLEAR_ROLES,
          tenantId,
          tenantId,
          tenantId,
          jobId,
          today,
          today,
        )
        .all<HolderRow>();
      for (const row of result.results ?? [])
        byGate.set(row.gate, [...(byGate.get(row.gate) ?? []), row]);
    } catch {
      // Clearer availability never erases a gate known to be open.
      stale.push("open_gates.clearers_unavailable");
    }
  }
  return {
    open_gates: open.map((row) => {
      const holders = byGate.get(row.gate) ?? [];
      const first = holders[0];
      let clearer = "The office";
      if (first?.assignee_count === 1 && first.assigned === 1) {
        clearer = usableName(first) ?? clearer;
      } else if (
        first &&
        first.holder_count <= 2 &&
        holders.length === first.holder_count
      ) {
        const names = holders.map(usableName);
        if (names.every((name): name is string => name !== null))
          clearer = names.join(" or ");
      }
      return {
        gate: row.gate as CrewSchedulingGate,
        label: row.gate === "Safety" ? "Safety check" : row.gate,
        clearer_display_name: clearer,
      };
    }),
    stale_fields: stale,
  };
}
