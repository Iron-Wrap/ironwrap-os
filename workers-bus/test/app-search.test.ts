import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  OPERATOR_SEARCH_DESTINATIONS,
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_RAW_QUERY_LENGTH,
  buildOperatorSearchReadModel,
  classifySearchQuery,
  normalizeSearchQuery,
  type OperatorSearchGroupId,
  type OperatorSearchReadModel,
} from "../src/app-search.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const MODIFIED = "2026-08-20T11:00:00.000Z";
const GENERATED = "2026-08-23T09:00:00.000Z";

interface JobFixture {
  roof_job_id: string;
  tenant_id: string;
  customer_id: string;
  job_number: string | null;
  service_type: string | null;
  job_status: string;
  brand: string | null;
  updated_at: string;
}

interface LeadFixture {
  lead_id: string;
  tenant_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  source: string | null;
  lifecycle_status: string | null;
  updated_at: string;
}

interface CustomerFixture {
  customer_id: string;
  tenant_id: string;
  display_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  updated_at: string;
}

interface AssignmentFixture {
  assignment_id: string;
  tenant_id: string;
  roof_job_id: string;
  assigned_users: string[];
}

interface Fixtures {
  jobs: JobFixture[];
  leads: LeadFixture[];
  customers: CustomerFixture[];
  assignments: AssignmentFixture[];
}

interface Recorded {
  sql: string;
  bindings: unknown[];
}

function job(overrides: Partial<JobFixture> = {}): JobFixture {
  return {
    roof_job_id: "JOB-A",
    tenant_id: TENANT,
    customer_id: "CUSTOMER-A",
    job_number: "IW-1001",
    service_type: "Metal re-roof",
    job_status: "in_progress",
    brand: "ironwrap",
    updated_at: MODIFIED,
    ...overrides,
  };
}

function lead(overrides: Partial<LeadFixture> = {}): LeadFixture {
  return {
    lead_id: "LEAD-A",
    tenant_id: TENANT,
    contact_name: "Nora Northwind",
    contact_phone: "+14035550101",
    contact_email: "nora@example.invalid",
    source: "website",
    lifecycle_status: "untriaged",
    updated_at: MODIFIED,
    ...overrides,
  };
}

function customer(overrides: Partial<CustomerFixture> = {}): CustomerFixture {
  return {
    customer_id: "CUSTOMER-A",
    tenant_id: TENANT,
    display_name: "Northside Holdings",
    contact_phone: "+14035550111",
    contact_email: "northside@example.invalid",
    updated_at: MODIFIED,
    ...overrides,
  };
}

function fixtures(overrides: Partial<Fixtures> = {}): Fixtures {
  return {
    jobs: [job()],
    leads: [lead()],
    customers: [customer()],
    assignments: [],
    ...overrides,
  };
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: MODIFIED,
      session_expires_at: "2026-08-24T11:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: MODIFIED,
      updated_at: MODIFIED,
      device_id: null,
      device_proof_hash: null,
    },
  };
}

/**
 * A D1 double that actually honours the endpoint's own SQL: prefix pattern, tenant, status filter,
 * NOCASE ordering and `LIMIT`. The cap and the more-results signal are only worth testing if the
 * double can return one row past the cap, so it does.
 */
function env(
  data: Fixtures = fixtures(),
  recorded: Recorded[] = [],
): AppEnv {
  return {
    APP_TENANT_ID: TENANT,
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            recorded.push({ sql, bindings });
            return {
              async all() {
                return { results: rowsFor(sql, bindings, data) };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
}

function rowsFor(
  sql: string,
  bindings: unknown[],
  data: Fixtures,
): Array<Record<string, unknown>> {
  if (sql.includes("FROM operating_roof_jobs\n")) {
    const [tenantId, pattern, ...rest] = bindings;
    const limit = Number(rest.at(-1));
    const statuses = rest.slice(0, 2).map(String);
    const scopeValues = rest.slice(2, -1).map(String);
    const assigned = sql.includes("current_assignment")
      ? [...data.assignments
          .filter(
            (row) =>
              row.tenant_id === tenantId &&
              row.assigned_users.some((user) =>
                scopeValues.includes(user.toLowerCase()),
              ),
          )
          .reduce((counts, row) => {
            counts.set(row.roof_job_id, (counts.get(row.roof_job_id) ?? 0) + 1);
            return counts;
          }, new Map<string, number>())]
          .filter(([, count]) => count === 1)
          .map(([roofJobId]) => roofJobId)
      : scopeValues;
    return data.jobs
      .filter(
        (row) =>
          row.tenant_id === tenantId &&
          statuses.includes(row.job_status) &&
          matchesPrefix(row.job_number, pattern) &&
          (!sql.includes("current_assignment") ||
            assigned.includes(row.roof_job_id)),
      )
      .sort(byTextThenId("job_number", "roof_job_id"))
      .slice(0, limit) as unknown as Array<Record<string, unknown>>;
  }
  if (sql.includes("FROM operating_leads")) {
    const [tenantId, pattern, limit] = bindings;
    const column = leadColumn(sql);
    return data.leads
      .filter(
        (row) =>
          row.tenant_id === tenantId && matchesPrefix(row[column], pattern),
      )
      .sort(byTextThenId(column, "lead_id"))
      .slice(0, Number(limit)) as unknown as Array<Record<string, unknown>>;
  }
  if (sql.includes("FROM operating_customers c")) {
    const [, , tenantId, pattern, , , limit] = bindings;
    const column = sql.includes("c.contact_phone LIKE ?")
      ? ("contact_phone" as const)
      : ("display_name" as const);
    const openJobs = data.jobs.filter((row) =>
      ["qualified", "in_progress"].includes(row.job_status),
    );
    return data.customers
      .filter(
        (row) =>
          row.tenant_id === tenantId &&
          matchesPrefix(row[column], pattern) &&
          openJobs.some((open) => open.customer_id === row.customer_id),
      )
      .sort(byTextThenId(column, "customer_id"))
      .slice(0, Number(limit))
      .map((row) => ({
        customer_id: row.customer_id,
        display_name: row.display_name,
        contact_phone: row.contact_phone,
        updated_at: row.updated_at,
        primary_roof_job_id:
          openJobs.find((open) => open.customer_id === row.customer_id)
            ?.roof_job_id ?? null,
      }));
  }
  throw new Error(`unexpected search query: ${sql}`);
}

function leadColumn(sql: string): "contact_name" | "contact_phone" | "contact_email" {
  if (sql.includes("contact_email LIKE ?")) return "contact_email";
  if (sql.includes("contact_phone LIKE ?")) return "contact_phone";
  return "contact_name";
}

/** Exactly SQLite's case-insensitive `LIKE 'prefix%'` for a pattern with no other wildcard. */
function matchesPrefix(value: string | null, pattern: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = String(pattern);
  assert.ok(text.endsWith("%"), `pattern must be a prefix pattern: ${text}`);
  const prefix = text.slice(0, -1);
  assert.ok(
    !prefix.includes("%") && !prefix.includes("_"),
    `prefix must not carry a LIKE wildcard: ${prefix}`,
  );
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function byTextThenId<T extends Record<string, unknown>>(
  column: string,
  id: string,
): (left: T, right: T) => number {
  return (left, right) => {
    const a = String(left[column] ?? "").toLowerCase();
    const b = String(right[column] ?? "").toLowerCase();
    if (a !== b) return a < b ? -1 : 1;
    return String(left[id]) < String(right[id]) ? -1 : 1;
  };
}

function groupIds(model: OperatorSearchReadModel): OperatorSearchGroupId[] {
  return model.groups.map((group) => group.group);
}

function group(model: OperatorSearchReadModel, id: OperatorSearchGroupId) {
  const found = model.groups.find((entry) => entry.group === id);
  assert.ok(found, `expected a ${id} group`);
  return found;
}

test("each role gets exactly the groups it can already read elsewhere", async () => {
  const expected: Record<AppRole, OperatorSearchGroupId[]> = {
    owner: ["jobs", "leads", "customers", "go_to"],
    ops: ["jobs", "leads", "customers", "go_to"],
    sales: ["leads", "go_to"],
    production: ["jobs", "customers", "go_to"],
    accounting: ["go_to"],
    field: ["jobs", "go_to"],
  };
  for (const [role, groups] of Object.entries(expected) as Array<
    [AppRole, OperatorSearchGroupId[]]
  >) {
    const model = await buildOperatorSearchReadModel(
      env(fixtures({ assignments: [] })),
      auth(role),
      "nor",
      GENERATED,
    );
    assert.deepEqual(groupIds(model), groups, role);
  }
});

test("a field session never sees a lead and only sees its own assigned jobs", async () => {
  const data = fixtures({
    jobs: [
      job({ roof_job_id: "JOB-A", job_number: "IW-1001" }),
      job({ roof_job_id: "JOB-B", job_number: "IW-1002" }),
    ],
    assignments: [
      {
        assignment_id: "ASSIGN-A",
        tenant_id: TENANT,
        roof_job_id: "JOB-A",
        assigned_users: ["field@example.invalid"],
      },
      {
        assignment_id: "ASSIGN-B",
        tenant_id: TENANT,
        roof_job_id: "JOB-B",
        assigned_users: ["someone-else@example.invalid"],
      },
    ],
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("field"),
    "iw-10",
    GENERATED,
  );
  assert.deepEqual(groupIds(model), ["jobs", "go_to"]);
  assert.deepEqual(
    group(model, "jobs").results.map((result) => result.id),
    ["JOB-A"],
  );
  assert.equal(JSON.stringify(model).includes("Nora"), false);
  assert.deepEqual(model.allowed_actions, [
    "search.read",
    "job.read.assigned",
    "navigation.read",
  ]);
});

test("a field session with an ambiguous assignment set cannot open the job", async () => {
  const data = fixtures({
    jobs: [job({ roof_job_id: "JOB-A", job_number: "IW-1001" })],
    assignments: [
      {
        assignment_id: "ASSIGN-A",
        tenant_id: TENANT,
        roof_job_id: "JOB-A",
        assigned_users: ["field@example.invalid"],
      },
      {
        assignment_id: "ASSIGN-A2",
        tenant_id: TENANT,
        roof_job_id: "JOB-A",
        assigned_users: ["field@example.invalid"],
      },
    ],
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("field"),
    "iw-10",
    GENERATED,
  );
  assert.deepEqual(group(model, "jobs").results, []);
  assert.equal(model.outcome, "no_matches");
});

test("a field session search does not truncate its assignment scope at 100 jobs", async () => {
  const data = fixtures({
    jobs: Array.from({ length: 101 }, (_unused, index) =>
      job({
        roof_job_id: `JOB-${index}`,
        job_number: `IW-${String(index).padStart(4, "0")}`,
      }),
    ),
    assignments: Array.from({ length: 101 }, (_unused, index) => ({
      assignment_id: `ASSIGN-${index}`,
      tenant_id: TENANT,
      roof_job_id: `JOB-${index}`,
      assigned_users: ["field@example.invalid"],
    })),
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("field"),
    "iw-0100",
    GENERATED,
  );
  assert.deepEqual(
    group(model, "jobs").results.map((result) => result.id),
    ["JOB-100"],
  );
});

test("assigned job search keeps the job and assignment predicates index-backed", async () => {
  const recorded: Recorded[] = [];
  await buildOperatorSearchReadModel(
    env(fixtures(), recorded),
    auth("field"),
    "iw-10",
    GENERATED,
  );
  const jobRead = recorded.find(
    (entry) =>
      entry.sql.includes("FROM operating_roof_jobs\n") &&
      entry.sql.includes("current_assignment"),
  );
  assert.ok(jobRead);

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE operating_roof_jobs (
        tenant_id TEXT NOT NULL,
        roof_job_id TEXT NOT NULL,
        job_number TEXT,
        service_type TEXT,
        job_status TEXT,
        brand TEXT,
        updated_at TEXT
      );
      CREATE TABLE operating_job_assignments (
        tenant_id TEXT NOT NULL,
        roof_job_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        assignment_version INTEGER NOT NULL,
        supersedes_assignment_id TEXT,
        assigned_users_json TEXT NOT NULL
      );
      CREATE INDEX idx_operating_roof_jobs_tenant_job_number_search
        ON operating_roof_jobs (tenant_id, job_number COLLATE NOCASE);
      CREATE UNIQUE INDEX idx_operating_job_assignments_job_version
        ON operating_job_assignments (tenant_id, roof_job_id, assignment_version);
      CREATE UNIQUE INDEX idx_operating_job_assignments_predecessor
        ON operating_job_assignments (tenant_id, supersedes_assignment_id);
    `);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${jobRead.sql}`)
      .all(...jobRead.bindings) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    assert.match(details, /idx_operating_roof_jobs_tenant_job_number_search/);
    assert.match(details, /idx_operating_job_assignments_job_version/);
    assert.match(details, /idx_operating_job_assignments_predecessor/);
  } finally {
    db.close();
  }
});

test("a field session with no assignment returns no job rows without an assignment prefetch", async () => {
  const recorded: Recorded[] = [];
  const model = await buildOperatorSearchReadModel(
    env(fixtures({ assignments: [] }), recorded),
    auth("field"),
    "iw-10",
    GENERATED,
  );
  assert.deepEqual(group(model, "jobs").results, []);
  assert.equal(
    recorded.some((entry) => entry.sql.includes("current_assignment")),
    true,
  );
});

test("a sales session sees leads and never a job, customer or money record", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("sales"),
    "nor",
    GENERATED,
  );
  assert.deepEqual(groupIds(model), ["leads", "go_to"]);
  assert.deepEqual(
    group(model, "leads").results.map((result) => result.label),
    ["Nora Northwind"],
  );
  const payload = JSON.stringify(model);
  for (const forbidden of [
    "Northside Holdings",
    "IW-1001",
    "JOB-A",
    "accounting",
    "quickbooks",
    "invoice",
    "cents",
  ]) {
    assert.equal(payload.includes(forbidden), false, forbidden);
  }
});

test("an accounting session gets its own destinations and no operating register", async () => {
  const recorded: Recorded[] = [];
  const model = await buildOperatorSearchReadModel(
    env(fixtures(), recorded),
    auth("accounting"),
    "mon",
    GENERATED,
  );
  assert.deepEqual(groupIds(model), ["go_to"]);
  assert.deepEqual(recorded, []);
  assert.deepEqual(
    group(model, "go_to").results.map((result) => result.href),
    ["/accounting"],
  );
});

test("a search result never links to a job the role could not open", async () => {
  const data = fixtures({
    jobs: [
      job({ roof_job_id: "JOB-A", job_number: "IW-1001" }),
      job({
        roof_job_id: "JOB-DONE",
        job_number: "IW-1002",
        job_status: "complete",
      }),
      job({
        roof_job_id: "JOB-GONE",
        job_number: "IW-1003",
        job_status: "cancelled",
      }),
    ],
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("owner"),
    "iw-100",
    GENERATED,
  );
  assert.deepEqual(
    group(model, "jobs").results.map((result) => result.href),
    ["/jobs/JOB-A"],
  );
});

test("a customer appears only when it owns a job the role can open", async () => {
  const data = fixtures({
    jobs: [
      job({
        roof_job_id: "JOB-CLOSED",
        customer_id: "CUSTOMER-CLOSED",
        job_number: "IW-2001",
        job_status: "complete",
      }),
    ],
    customers: [
      customer({
        customer_id: "CUSTOMER-CLOSED",
        display_name: "Northgate Closed",
      }),
    ],
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("owner"),
    "north",
    GENERATED,
  );
  assert.deepEqual(group(model, "customers").results, []);
});

test("a customer row carries name and phone and never an email", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("production"),
    "north",
    GENERATED,
  );
  const [result] = group(model, "customers").results;
  assert.ok(result);
  assert.equal(result.label, "Northside Holdings");
  assert.equal(result.detail, "+14035550111");
  assert.equal(result.href, "/jobs/JOB-A");
  assert.equal(
    JSON.stringify(model).includes("northside@example.invalid"),
    false,
  );
});

test("the per-group cap is hard and truncation is declared, not hidden", async () => {
  const data = fixtures({
    jobs: Array.from({ length: SEARCH_GROUP_LIMIT + 4 }, (_unused, index) =>
      job({
        roof_job_id: `JOB-${String(index).padStart(2, "0")}`,
        job_number: `IW-20${String(index).padStart(2, "0")}`,
      }),
    ),
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("owner"),
    "iw-20",
    GENERATED,
  );
  const jobs = group(model, "jobs");
  assert.equal(jobs.limit, SEARCH_GROUP_LIMIT);
  assert.equal(jobs.results.length, SEARCH_GROUP_LIMIT);
  assert.equal(jobs.more_results, true);
  assert.deepEqual(
    jobs.results.map((result) => result.label),
    Array.from(
      { length: SEARCH_GROUP_LIMIT },
      (_unused, index) => `IW-20${String(index).padStart(2, "0")}`,
    ),
  );
});

test("a group that fits under the cap does not claim more results exist", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "iw-1",
    GENERATED,
  );
  assert.equal(group(model, "jobs").results.length, 1);
  assert.equal(group(model, "jobs").more_results, false);
});

test("an empty or single-character query reads nothing and says so", async () => {
  for (const query of ["", "   ", "n", " %% "]) {
    const recorded: Recorded[] = [];
    const model = await buildOperatorSearchReadModel(
      env(fixtures(), recorded),
      auth("owner"),
      query,
      GENERATED,
    );
    assert.equal(model.outcome, "query_too_short", query);
    assert.equal(model.query_class, null);
    assert.deepEqual(recorded, [], query);
    assert.deepEqual(groupIds(model), ["jobs", "leads", "customers", "go_to"]);
    for (const entry of model.groups) {
      assert.deepEqual(entry.results, []);
      assert.deepEqual(entry.matched_fields, []);
      assert.equal(entry.more_results, false);
    }
  }
});

test("a query that matches nothing says so instead of returning a near miss", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "zzqq",
    GENERATED,
  );
  assert.equal(model.outcome, "no_matches");
  for (const entry of model.groups) assert.deepEqual(entry.results, []);
});

test("LIKE wildcards and SQL punctuation are neutralised before any lookup", async () => {
  const cases: Array<[string, string]> = [
    ["Nor%", "Nor%"],
    ["Nor_thside", "Nor thside%"],
    ["No'r", "No'r%"],
    ["Nor; DROP TABLE operating_leads;--", "Nor DROP TABLE operating leads --%"],
    ["Nor\\th", "Nor th%"],
    ["Nor%%%side", "Nor side%"],
  ];
  for (const [raw, expectedPattern] of cases) {
    const recorded: Recorded[] = [];
    const model = await buildOperatorSearchReadModel(
      env(fixtures(), recorded),
      auth("owner"),
      raw,
      GENERATED,
    );
    const leadRead = recorded.find((entry) =>
      entry.sql.includes("FROM operating_leads"),
    );
    assert.ok(leadRead, raw);
    assert.equal(leadRead.bindings[1], expectedPattern, raw);
    // The bound value is exactly the echoed query plus the one appended wildcard.
    const prefix = String(leadRead.bindings[1]).slice(0, -1);
    assert.equal(prefix, model.query, raw);
    assert.match(prefix, /^[\p{L}\p{N} .,'\-@+#&]*$/u, raw);
  }
});

test("a wildcard cannot reach a record the typed prefix does not name", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "Nor_thside",
    GENERATED,
  );
  assert.equal(model.query, "Nor thside");
  assert.deepEqual(group(model, "customers").results, []);
  assert.deepEqual(group(model, "leads").results, []);
  assert.equal(model.outcome, "no_matches");
});

test("a query made only of rejected characters is treated as too short", async () => {
  const recorded: Recorded[] = [];
  const model = await buildOperatorSearchReadModel(
    env(fixtures(), recorded),
    auth("owner"),
    "%%%__;",
    GENERATED,
  );
  assert.equal(model.query, "");
  assert.equal(model.outcome, "query_too_short");
  assert.deepEqual(recorded, []);
});

test("the executed query is echoed back, never the raw client string", async () => {
  const model = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "  <script>Nor</script>  ",
    GENERATED,
  );
  assert.equal(model.query, "script Nor script");
  assert.equal(JSON.stringify(model).includes("<script>"), false);
});

test("the query class picks one exact column family per group", async () => {
  assert.equal(classifySearchQuery("nora"), "text");
  assert.equal(classifySearchQuery("nora@example.invalid"), "email");
  assert.equal(classifySearchQuery("+14035550101"), "numeric");
  assert.equal(classifySearchQuery("4035550101"), "numeric");

  const byName = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "nor",
    GENERATED,
  );
  assert.deepEqual(group(byName, "leads").matched_fields, ["contact_name"]);
  assert.deepEqual(group(byName, "customers").matched_fields, ["display_name"]);
  assert.deepEqual(group(byName, "jobs").matched_fields, ["job_number"]);

  const byPhone = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "+1403555",
    GENERATED,
  );
  assert.deepEqual(group(byPhone, "leads").matched_fields, ["contact_phone"]);
  assert.deepEqual(group(byPhone, "customers").matched_fields, [
    "contact_phone",
  ]);
  assert.deepEqual(
    group(byPhone, "customers").results.map((result) => result.id),
    ["CUSTOMER-A"],
  );

  const byEmail = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "nora@",
    GENERATED,
  );
  assert.deepEqual(group(byEmail, "leads").matched_fields, ["contact_email"]);
  assert.deepEqual(group(byEmail, "jobs").matched_fields, []);
  assert.deepEqual(group(byEmail, "customers").matched_fields, []);
  assert.equal(
    group(byEmail, "leads").results.map((result) => result.id).join(),
    "LEAD-A",
  );
});

test("Go to offers exactly the destinations the role's own navigation offers", async () => {
  const expected: Record<AppRole, string[]> = {
    owner: [
      "/now",
      "/newo",
      "/sales",
      "/facet-designs",
      "/production",
      "/service",
      "/today",
      "/inventory",
      "/approvals",
      "/settings",
    ],
    ops: [
      "/now",
      "/newo",
      "/sales",
      "/facet-designs",
      "/production",
      "/service",
      "/today",
      "/inventory",
      "/approvals",
      "/settings",
    ],
    sales: ["/now", "/sales"],
    production: ["/now", "/production"],
    accounting: [
      "/accounting",
      "/accounting/exceptions",
      "/now",
      "/accounting/quickbooks",
    ],
    field: ["/now", "/check-in", "/vehicle", "/inventory"],
  };
  for (const [role, hrefs] of Object.entries(expected) as Array<
    [AppRole, string[]]
  >) {
    assert.deepEqual(
      OPERATOR_SEARCH_DESTINATIONS[role].map(
        (destination) => destination.href,
      ),
      hrefs,
      role,
    );
  }
});

test("Go to matches a whole word and never a fragment inside one", async () => {
  const desk = await buildOperatorSearchReadModel(
    env(),
    auth("accounting"),
    "desk",
    GENERATED,
  );
  assert.deepEqual(
    group(desk, "go_to").results.map((result) => result.label),
    ["Money desk"],
  );

  const inside = await buildOperatorSearchReadModel(
    env(),
    auth("accounting"),
    "one",
    GENERATED,
  );
  assert.deepEqual(group(inside, "go_to").results, []);

  const several = await buildOperatorSearchReadModel(
    env(),
    auth("owner"),
    "s",
    GENERATED,
  );
  assert.equal(several.outcome, "query_too_short");
});

test("the envelope reports the newest source row it actually read", async () => {
  const data = fixtures({
    jobs: [job({ updated_at: "2026-08-21T08:00:00.000Z" })],
    leads: [lead({ updated_at: "2026-08-22T08:00:00.000Z" })],
    customers: [customer({ updated_at: "2026-08-19T08:00:00.000Z" })],
  });
  const model = await buildOperatorSearchReadModel(
    env(data),
    auth("owner"),
    "nor",
    GENERATED,
  );
  assert.equal(model.version, 1);
  assert.equal(model.read_model_generated_at, GENERATED);
  assert.equal(model.source_updated_at, "2026-08-22T08:00:00.000Z");
  assert.deepEqual(model.stale_fields, []);
  assert.deepEqual(model.allowed_actions, [
    "search.read",
    "job.read",
    "lead.read",
    "customer.read",
    "navigation.read",
  ]);
});

test("normalizeSearchQuery caps the executed query length", () => {
  assert.equal(normalizeSearchQuery("a".repeat(200)).length, 64);
  assert.equal(normalizeSearchQuery("  Nora   Northwind  "), "Nora Northwind");
});

test("GET /api/v1/search answers the palette and refuses an oversized query", async () => {
  const appEnv = env();
  const ok = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/search?q=nor"),
    appEnv,
    auth("owner"),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  const body = (await ok.json()) as OperatorSearchReadModel;
  assert.equal(body.outcome, "results");
  assert.deepEqual(groupIds(body), ["jobs", "leads", "customers", "go_to"]);

  const missing = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/search"),
    appEnv,
    auth("field"),
  );
  assert.equal(missing.status, 200);
  assert.equal(
    ((await missing.json()) as OperatorSearchReadModel).outcome,
    "query_too_short",
  );

  const long = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/search?q=${"n".repeat(SEARCH_MAX_RAW_QUERY_LENGTH + 1)}`,
    ),
    appEnv,
    auth("owner"),
  );
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: "search_query_too_long" });
});

test("GET /api/v1/search fails closed when a source read throws", async () => {
  const broken = {
    APP_TENANT_ID: TENANT,
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all(): Promise<never> {
                throw new Error("no such index");
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/search?q=nor"),
    broken,
    auth("owner"),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
});
