/**
 * Operator search-and-jump read model for the office command palette.
 *
 * This is a read projection over facts the caller's role can already open elsewhere in the
 * product. It creates no new authority: every group is gated on the same permission that gates
 * the surface the result links to, and every row carries only fields that surface already
 * returns to that role.
 *
 *   `jobs`      -> `jobs:read:any` sees every job it can reach: the live ones `buildJobReadModel`
 *                  opens, and the finished ones `buildJobHistoryReadModel` reads. Each row points
 *                  at whichever reading exists. `jobs:read:assigned` sees only the live jobs its
 *                  own current assignment opens.
 *   `leads`     -> `sales:read`, the same lead register `buildSalesReadModel` lists.
 *   `customers` -> `jobs:read:any`, and only customers that own a job this caller can open,
 *                  because a job is where that role already reads a customer name and phone.
 *   `go_to`     -> the caller's own navigation, mirrored from `app/src/lib/roles.ts`.
 *
 * Nothing here is fuzzy. The query is normalized to a conservative character allowlist, routed
 * to one exact column class, and matched as a case-insensitive prefix against an index. A caller
 * that reaches a group's cap is told so instead of being handed a silently truncated list.
 */
import {
  appUserIdentities,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "./app-types.ts";
import { nativeJobStatusLabel } from "./app-read-models.ts";

/** Hard per-group result cap. A palette shows a short list; it never pages. */
export const SEARCH_GROUP_LIMIT = 8;
/** Below this the endpoint answers `query_too_short` and reads nothing. */
export const SEARCH_MIN_QUERY_LENGTH = 2;
/** Normalized queries are truncated here; the echoed `query` shows exactly what was searched. */
export const SEARCH_MAX_QUERY_LENGTH = 64;
/** Raw `?q=` longer than this is refused outright rather than silently trimmed. */
export const SEARCH_MAX_RAW_QUERY_LENGTH = 120;

/**
 * The job statuses the live work plan will open. `buildJobReadModel` returns null outside this
 * set, so a hit outside it must not be linked to `/jobs/{id}`.
 */
const SEARCHABLE_JOB_STATUSES = ["qualified", "in_progress"] as const;

/**
 * Every status a `jobs:read:any` caller can reach somewhere. A finished job used to be absent from
 * search entirely, because there was nowhere to send anyone: the work plan refuses it. Now that
 * `buildJobHistoryReadModel` reads the record of a job in any status, the reason for hiding it is
 * gone — so the palette finds it and points at the reading that exists.
 *
 * A `jobs:read:assigned` caller is deliberately still held to the live set: a crew is shown the
 * work in front of them, not the history of work that is over.
 */
const REACHABLE_JOB_STATUSES = [
  "qualified",
  "in_progress",
  "complete",
  "cancelled",
] as const;

/** The reading of a job that actually exists for its status. Never link at a 404. */
function jobHref(roofJobId: string, jobStatus: string | null): string {
  const live = (SEARCHABLE_JOB_STATUSES as readonly string[]).includes(
    jobStatus ?? "",
  );
  const id = encodeURIComponent(roofJobId);
  return live ? `/jobs/${id}` : `/jobs/${id}/history`;
}

export type OperatorSearchGroupId = "jobs" | "leads" | "customers" | "go_to";

/**
 * Which column family a query addresses. Chosen deterministically from the query text, never
 * guessed: an `@` means email, a leading digit or `+` means a number, everything else is a name.
 */
export type SearchQueryClass = "email" | "numeric" | "text";

export type OperatorSearchOutcome =
  "results" | "no_matches" | "query_too_short";

export interface OperatorSearchResult {
  id: string;
  label: string;
  detail: string | null;
  /** In-app destination. Always a surface this role may open. */
  href: string;
  /** The exact source column this row matched on. */
  matched_field: string;
}

export interface OperatorSearchGroup {
  group: OperatorSearchGroupId;
  label: string;
  limit: number;
  /**
   * The exact columns this query class searched in this group. Empty means this kind of query
   * cannot address this group at all -- an email query has nothing to match a job number
   * against -- which is a different statement from "searched and found nothing".
   */
  matched_fields: string[];
  results: OperatorSearchResult[];
  /** The bounded lookup filled its cap and at least one further match exists. */
  more_results: boolean;
}

export interface OperatorSearchReadModel {
  version: number;
  source_updated_at: string | null;
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
  /** The normalized query that was actually executed, never the raw client string. */
  query: string;
  query_class: SearchQueryClass | null;
  outcome: OperatorSearchOutcome;
  groups: OperatorSearchGroup[];
}

interface SearchDestination {
  id: string;
  label: string;
  href: string;
  workspace: string;
}

const OFFICE_DESTINATIONS: readonly SearchDestination[] = [
  { id: "now", label: "Now", href: "/now", workspace: "Command" },
  { id: "newo", label: "Reception", href: "/newo", workspace: "Revenue" },
  { id: "sales", label: "Sales", href: "/sales", workspace: "Revenue" },
  {
    id: "facet-designs",
    label: "Designs",
    href: "/facet-designs",
    workspace: "Revenue",
  },
  {
    id: "production",
    label: "Production",
    href: "/production",
    workspace: "Delivery",
  },
  { id: "service", label: "Service", href: "/service", workspace: "Delivery" },
  { id: "today", label: "Today", href: "/today", workspace: "Delivery" },
  {
    id: "inventory",
    label: "Inventory",
    href: "/inventory",
    workspace: "Resources",
  },
  {
    id: "approvals",
    label: "Approvals",
    href: "/approvals",
    workspace: "Control",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    workspace: "Control",
  },
];

/**
 * The operator's own navigable destinations, one list per role.
 *
 * This mirrors `navigationForRole` in `app/src/lib/roles.ts` exactly. It is restated here because
 * the Worker is the authority for what a session may reach and must not import a browser bundle;
 * `app-search.test.ts` pins the per-role sets so the two cannot drift silently.
 */
export const OPERATOR_SEARCH_DESTINATIONS: Readonly<
  Record<AppRole, readonly SearchDestination[]>
> = {
  owner: OFFICE_DESTINATIONS,
  ops: OFFICE_DESTINATIONS,
  sales: [
    { id: "now", label: "Now", href: "/now", workspace: "Command" },
    { id: "sales", label: "Sales", href: "/sales", workspace: "Revenue" },
  ],
  production: [
    { id: "now", label: "Now", href: "/now", workspace: "Command" },
    {
      id: "production",
      label: "Production",
      href: "/production",
      workspace: "Delivery",
    },
  ],
  accounting: [
    {
      id: "accounting",
      label: "Money desk",
      href: "/accounting",
      workspace: "Finance",
    },
    {
      id: "accounting-exceptions",
      label: "Exceptions",
      href: "/accounting/exceptions",
      workspace: "Finance",
    },
    { id: "now", label: "Now", href: "/now", workspace: "Command" },
    {
      id: "settings",
      label: "Settings",
      href: "/accounting/quickbooks",
      workspace: "Control",
    },
  ],
  field: [
    { id: "now", label: "Now", href: "/now", workspace: "Command" },
    {
      id: "check-in",
      label: "Check-in",
      href: "/check-in",
      workspace: "Delivery",
    },
    {
      id: "vehicle",
      label: "Vehicle",
      href: "/vehicle",
      workspace: "Resources",
    },
    {
      id: "inventory",
      label: "Inventory",
      href: "/inventory",
      workspace: "Resources",
    },
  ],
};

/**
 * Letters, digits, and the punctuation that genuinely occurs inside a name, a company name, a
 * phone number, an email address, or a job number. `%`, `_` and everything else become a space.
 */
const ALLOWED_QUERY_CHARACTER = /^[\p{L}\p{N} .,'\-@+#&]$/u;

/**
 * Reduce a raw client string to the exact text that will be executed.
 *
 * Anything outside the allowlist becomes a space rather than being deleted, so `Sm%ith` searches
 * for `Sm ith` and finds nothing instead of quietly becoming `Smith` and opening the wrong
 * customer. `%` and `_` cannot survive this, which is what lets the SQL below use a plain `LIKE`
 * prefix with no `ESCAPE` clause -- and an `ESCAPE` clause is exactly what would disable SQLite's
 * index-backed LIKE optimization.
 */
export function normalizeSearchQuery(raw: string): string {
  let normalized = "";
  for (const character of raw.normalize("NFC")) {
    normalized += ALLOWED_QUERY_CHARACTER.test(character) ? character : " ";
  }
  return normalized
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SEARCH_MAX_QUERY_LENGTH)
    .trim();
}

export function classifySearchQuery(normalized: string): SearchQueryClass {
  if (normalized.includes("@")) return "email";
  return /^[0-9+]/u.test(normalized) ? "numeric" : "text";
}

/** The prefix pattern bound into every lookup. Never contains a LIKE wildcard of its own. */
function prefixPattern(normalized: string): string {
  return `${normalized}%`;
}

export async function buildOperatorSearchReadModel(
  env: AppEnv,
  auth: AuthContext,
  rawQuery: string,
  generatedAt: string = new Date().toISOString(),
): Promise<OperatorSearchReadModel> {
  const query = normalizeSearchQuery(rawQuery);
  const scope = searchScope(auth);
  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    return {
      ...base(auth, scope, null, generatedAt),
      query,
      query_class: null,
      outcome: "query_too_short",
      groups: scope.groups.map((group) => emptyGroup(group, [])),
    };
  }

  const queryClass = classifySearchQuery(query);
  const pattern = prefixPattern(query);
  const [jobs, leads, customers] = await Promise.all([
    scope.groups.includes("jobs")
      ? jobResults(env, auth, scope, queryClass, pattern)
      : null,
    scope.groups.includes("leads")
      ? leadResults(env, auth, queryClass, pattern)
      : null,
    scope.groups.includes("customers")
      ? customerResults(env, auth, queryClass, pattern)
      : null,
  ]);
  const goTo = scope.groups.includes("go_to")
    ? destinationResults(auth.session.role, query)
    : null;

  const groups: OperatorSearchGroup[] = [];
  for (const id of scope.groups) {
    if (id === "jobs" && jobs) groups.push(jobs.group);
    if (id === "leads" && leads) groups.push(leads.group);
    if (id === "customers" && customers) groups.push(customers.group);
    if (id === "go_to" && goTo) groups.push(goTo);
  }
  const matched = groups.some((group) => group.results.length > 0);
  return {
    ...base(
      auth,
      scope,
      newestTimestamp([
        ...(jobs?.updatedAt ?? []),
        ...(leads?.updatedAt ?? []),
        ...(customers?.updatedAt ?? []),
      ]),
      generatedAt,
    ),
    query,
    query_class: queryClass,
    outcome: matched ? "results" : "no_matches",
    groups,
  };
}

interface SearchScope {
  groups: OperatorSearchGroupId[];
  jobMode: "any" | "assigned" | null;
  allowedActions: string[];
}

/**
 * The whole role contract, in one place.
 *
 * A group appears only when the caller already holds the permission that opens the surface the
 * group links to. Accounting therefore gets its own destinations and nothing else: the money desk
 * shows it the jobs an accounting intent already names, and enumerating the job or customer
 * register by prefix is not a read it has anywhere in the product today.
 */
function searchScope(auth: AuthContext): SearchScope {
  const groups: OperatorSearchGroupId[] = [];
  const allowedActions = ["search.read"];
  const jobMode = auth.permissions.includes("jobs:read:any")
    ? ("any" as const)
    : auth.permissions.includes("jobs:read:assigned")
      ? ("assigned" as const)
      : null;
  if (jobMode) {
    groups.push("jobs");
    allowedActions.push(jobMode === "any" ? "job.read" : "job.read.assigned");
  }
  if (auth.permissions.includes("sales:read")) {
    groups.push("leads");
    allowedActions.push("lead.read");
  }
  if (jobMode === "any") {
    groups.push("customers");
    allowedActions.push("customer.read");
  }
  groups.push("go_to");
  allowedActions.push("navigation.read");
  return { groups, jobMode, allowedActions };
}

function base(
  auth: AuthContext,
  scope: SearchScope,
  sourceUpdatedAt: string | null,
  generatedAt: string,
): Omit<
  OperatorSearchReadModel,
  "query" | "query_class" | "outcome" | "groups"
> {
  return {
    version: 1,
    source_updated_at: sourceUpdatedAt,
    read_model_generated_at: generatedAt,
    stale_fields: [],
    permissions: auth.permissions,
    allowed_actions: scope.allowedActions,
  };
}

const GROUP_LABELS: Readonly<Record<OperatorSearchGroupId, string>> = {
  jobs: "Jobs",
  leads: "Leads",
  customers: "Customers",
  go_to: "Go to",
};

function emptyGroup(
  id: OperatorSearchGroupId,
  matchedFields: string[],
): OperatorSearchGroup {
  return {
    group: id,
    label: GROUP_LABELS[id],
    limit: SEARCH_GROUP_LIMIT,
    matched_fields: matchedFields,
    results: [],
    more_results: false,
  };
}

interface GroupRead {
  group: OperatorSearchGroup;
  updatedAt: Array<string | null>;
}

interface JobRow {
  roof_job_id: string;
  job_number: string | null;
  service_type: string | null;
  job_status: string | null;
  brand: string | null;
  updated_at: string | null;
}

/**
 * Jobs are addressed by job number only. A job with no job number is unreachable here on purpose:
 * the alternative is matching on the opaque `roof_job_id`, which no operator types and which would
 * turn the palette into an identifier oracle.
 */
async function jobResults(
  env: AppEnv,
  auth: AuthContext,
  scope: SearchScope,
  queryClass: SearchQueryClass,
  pattern: string,
): Promise<GroupRead> {
  if (queryClass === "email") {
    return { group: emptyGroup("jobs", []), updatedAt: [] };
  }
  const matchedFields = ["job_number"];
  const reachable: readonly string[] =
    scope.jobMode === "any" ? REACHABLE_JOB_STATUSES : SEARCHABLE_JOB_STATUSES;
  let assignmentClause = "";
  let assignmentUsers: string[] = [];
  if (scope.jobMode === "assigned") {
    // Keep the assignment scope correlated with the indexed job lookup. The assignment list
    // helper is deliberately bounded for panels, so materializing it here would silently hide
    // a field user's 101st job; the count matches activeNativeAssignmentForJob's exact-one rule.
    assignmentUsers = appUserIdentities(auth.session);
    if (assignmentUsers.length === 0) {
      return { group: emptyGroup("jobs", matchedFields), updatedAt: [] };
    }
    assignmentClause = ` AND (
      SELECT COUNT(*)
        FROM operating_job_assignments current_assignment
       WHERE current_assignment.tenant_id = operating_roof_jobs.tenant_id
         AND current_assignment.roof_job_id = operating_roof_jobs.roof_job_id
         AND NOT EXISTS (
           SELECT 1
             FROM operating_job_assignments successor
            WHERE successor.tenant_id = current_assignment.tenant_id
              AND successor.supersedes_assignment_id = current_assignment.assignment_id
         )
         AND EXISTS (
           SELECT 1
             FROM json_each(current_assignment.assigned_users_json) worker
            WHERE lower(worker.value) IN (${assignmentUsers.map(() => "?").join(", ")})
         )
    ) = 1`;
  }
  const read = await boundedRows<JobRow>(
    env,
    `SELECT roof_job_id, job_number, service_type, job_status, brand, updated_at
       FROM operating_roof_jobs
      WHERE tenant_id = ?
        AND job_number LIKE ?
        AND job_status IN (${reachable.map(() => "?").join(", ")})${assignmentClause}
      ORDER BY job_number COLLATE NOCASE ASC, roof_job_id ASC
      LIMIT ?`,
    [auth.session.tenant_id, pattern, ...reachable, ...assignmentUsers],
  );
  return {
    group: {
      ...emptyGroup("jobs", matchedFields),
      more_results: read.more,
      results: read.rows.map((row) => ({
        id: row.roof_job_id,
        label: row.job_number ?? row.roof_job_id,
        detail: joinDetail([
          row.service_type,
          nativeJobStatusLabel(row.job_status),
        ]),
        href: jobHref(row.roof_job_id, row.job_status),
        matched_field: "job_number",
      })),
    },
    updatedAt: read.rows.map((row) => row.updated_at),
  };
}

interface LeadRow {
  lead_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  source: string | null;
  lifecycle_status: string | null;
  updated_at: string | null;
}

async function leadResults(
  env: AppEnv,
  auth: AuthContext,
  queryClass: SearchQueryClass,
  pattern: string,
): Promise<GroupRead> {
  const column =
    queryClass === "email"
      ? "contact_email"
      : queryClass === "numeric"
        ? "contact_phone"
        : "contact_name";
  const read = await boundedRows<LeadRow>(
    env,
    `SELECT lead_id, contact_name, contact_phone, contact_email, source,
            lifecycle_status, updated_at
       FROM operating_leads
      WHERE tenant_id = ?
        AND ${column} LIKE ?
      ORDER BY ${column} COLLATE NOCASE ASC, lead_id ASC
      LIMIT ?`,
    [auth.session.tenant_id, pattern],
  );
  return {
    group: {
      ...emptyGroup("leads", [column]),
      more_results: read.more,
      results: read.rows.map((row) => ({
        id: row.lead_id,
        label:
          row.contact_name ??
          row.contact_email ??
          row.contact_phone ??
          row.lead_id,
        detail: joinDetail([row.source, row.lifecycle_status]),
        href: `/sales/leads/${encodeURIComponent(row.lead_id)}/triage`,
        matched_field: column,
      })),
    },
    updatedAt: read.rows.map((row) => row.updated_at),
  };
}

interface CustomerRow {
  customer_id: string;
  display_name: string | null;
  contact_phone: string | null;
  primary_roof_job_id: string | null;
  primary_job_status: string | null;
  updated_at: string | null;
}

/**
 * Customers carry name and phone and nothing else, because name and phone are exactly what a job
 * already gives this role. Email is deliberately neither matched nor returned: a job does not carry
 * it, so the palette must not become the one place a customer's address book entry can be probed.
 *
 * A customer still appears only if they own a job this caller can actually open, which is what
 * keeps the row a projection of an existing read rather than a new customer register. The set of
 * openable jobs is simply larger now that a finished one has a record to open: a repeat customer
 * whose work is all complete used to be unfindable by name, which is precisely the customer an
 * office is most often looking up.
 */
async function customerResults(
  env: AppEnv,
  auth: AuthContext,
  queryClass: SearchQueryClass,
  pattern: string,
): Promise<GroupRead> {
  if (queryClass === "email") {
    return { group: emptyGroup("customers", []), updatedAt: [] };
  }
  const column = queryClass === "numeric" ? "contact_phone" : "display_name";
  const read = await boundedRows<CustomerRow>(
    env,
    `SELECT c.customer_id, c.display_name, c.contact_phone, c.updated_at,
            reachable_job.roof_job_id AS primary_roof_job_id,
            reachable_job.job_status AS primary_job_status
       FROM operating_customers c
       JOIN operating_roof_jobs reachable_job
         ON reachable_job.roof_job_id = (
              SELECT j.roof_job_id
                FROM operating_roof_jobs j
               WHERE j.tenant_id = c.tenant_id
                 AND j.customer_id = c.customer_id
                 AND j.job_status IN (${REACHABLE_JOB_STATUSES.map(() => "?").join(", ")})
               ORDER BY j.updated_at DESC, j.roof_job_id ASC
               LIMIT 1)
        AND reachable_job.tenant_id = c.tenant_id
      WHERE c.tenant_id = ?
        AND c.${column} LIKE ?
      ORDER BY c.${column} COLLATE NOCASE ASC, c.customer_id ASC
      LIMIT ?`,
    [...REACHABLE_JOB_STATUSES, auth.session.tenant_id, pattern],
  );
  return {
    group: {
      ...emptyGroup("customers", [column]),
      more_results: read.more,
      results: read.rows.flatMap((row) =>
        row.primary_roof_job_id
          ? [
              {
                id: row.customer_id,
                label: row.display_name ?? row.customer_id,
                detail: row.contact_phone,
                href: jobHref(row.primary_roof_job_id, row.primary_job_status),
                matched_field: column,
              },
            ]
          : [],
      ),
    },
    updatedAt: read.rows.map((row) => row.updated_at),
  };
}

/**
 * Destinations match on a whole word, so `desk` finds `Money desk` and `des` finds `Designs`.
 * A substring match inside a word is deliberately not offered: it is the kind of near-miss that
 * makes an operator press Enter on the wrong row.
 */
function destinationResults(role: AppRole, query: string): OperatorSearchGroup {
  const needle = query.toLowerCase();
  const matches = OPERATOR_SEARCH_DESTINATIONS[role].filter((destination) =>
    destination.label
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((word) => word.length > 0 && word.startsWith(needle)),
  );
  return {
    ...emptyGroup("go_to", ["label"]),
    more_results: matches.length > SEARCH_GROUP_LIMIT,
    results: matches.slice(0, SEARCH_GROUP_LIMIT).map((destination) => ({
      id: destination.id,
      label: destination.label,
      detail: destination.workspace,
      href: destination.href,
      matched_field: "label",
    })),
  };
}

/**
 * One bounded lookup. Reads one row past the cap so a full page can be reported as truncated
 * instead of being presented as the complete answer.
 */
async function boundedRows<T>(
  env: AppEnv,
  sql: string,
  bindings: readonly unknown[],
): Promise<{ rows: T[]; more: boolean }> {
  const result = await env.DB.prepare(sql)
    .bind(...bindings, SEARCH_GROUP_LIMIT + 1)
    .all<T>();
  const rows = result.results ?? [];
  return {
    rows: rows.slice(0, SEARCH_GROUP_LIMIT),
    more: rows.length > SEARCH_GROUP_LIMIT,
  };
}

function joinDetail(parts: Array<string | null>): string | null {
  const present = parts.filter(
    (part): part is string =>
      typeof part === "string" && part.trim().length > 0,
  );
  return present.length > 0 ? present.join(" · ") : null;
}

function newestTimestamp(values: Array<string | null>): string | null {
  let newest: string | null = null;
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (newest === null || value > newest) newest = value;
  }
  return newest;
}
