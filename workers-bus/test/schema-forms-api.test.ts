import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  auth,
  OTHER_TENANT,
  request,
  setup,
  TENANT,
  USERS,
  type Harness,
} from "./pipeline-board-fixture.ts";

const ADMIN_FIELDS = "/api/v1/admin/schema-fields";
const ADMIN_TEMPLATES = "/api/v1/admin/document-templates";
const LEAD_ID = "lead:board:0001";
const JOB_ID = "job:board:0001";

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: {
    body?: unknown;
    who?: Parameters<typeof auth>[0];
    tenant?: string;
    idempotency?: string | null;
    csrf?: boolean;
  } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    request(method, path, {
      body: options.body,
      csrf: options.csrf,
      idempotency: options.idempotency === undefined
        ? method === "GET" ? null : "schema-api-key-00000001"
        : options.idempotency,
    }),
    harness.env,
    auth(options.who ?? "owner", options.tenant ?? TENANT),
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function fieldBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_type: "lead",
    field_key: "roof-colour",
    label: "Roof colour",
    position: 1,
    field_type: "text",
    validator_key: "none",
    validator_config: {},
    visibility_key: "always",
    visibility_config: {},
    evidence_class: "source",
    retention_policy: "standard",
    offline_mode: "queueable",
    read_scope: "all",
    write_scope: "all",
    read_roles: ["owner", "ops", "sales"],
    write_roles: ["owner", "ops"],
    ...overrides,
  };
}

async function createField(
  harness: Harness,
  key = "schema-field-create-0001",
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = await call(harness, "POST", ADMIN_FIELDS, {
    body: fieldBody(overrides),
    idempotency: key,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.field as Record<string, any>;
}

test("configuration is owner-only and the session overrides every client authority coordinate", async () => {
  const harness = setup();

  const deniedRead = await call(harness, "GET", ADMIN_FIELDS, { who: "ops" });
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.body.error, "schema_configuration_forbidden");

  const deniedWrite = await call(harness, "POST", ADMIN_FIELDS, {
    who: "ops",
    csrf: false,
    body: fieldBody(),
  });
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body.error, "schema_configuration_forbidden");

  const noCsrf = await call(harness, "POST", ADMIN_FIELDS, { csrf: false, body: fieldBody() });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const noKey = await call(harness, "POST", ADMIN_FIELDS, {
    idempotency: null,
    body: fieldBody(),
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "idempotency_key_required");

  const created = await call(harness, "POST", ADMIN_FIELDS, {
    idempotency: "schema-field-authority-0001",
    body: fieldBody({
      tenant_id: OTHER_TENANT,
      tenantId: OTHER_TENANT,
      role: "field",
      actor: { type: "worker", role: "field", userId: USERS.field.userId },
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.field.actor, {
    type: "owner",
    role: "owner",
    id: USERS.owner.userId,
    authority_ref: `app:${USERS.owner.userId}`,
  });

  const stored = harness.db.raw.prepare(
    `SELECT tenant_id, actor_type, actor_role, actor_id
       FROM schema_field_definition_revisions WHERE revision_id = ?`,
  ).get(created.body.field.revision_id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, {
    tenant_id: TENANT,
    actor_type: "owner",
    actor_role: "owner",
    actor_id: USERS.owner.userId,
  });
  harness.db.close();
});

test("field configuration replays exactly, rejects drift and stale revisions, and preserves history", async () => {
  const harness = setup();
  const key = "schema-field-replay-0001";
  const field = await createField(harness, key);

  const replay = await call(harness, "POST", ADMIN_FIELDS, { body: fieldBody(), idempotency: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.outcome, "replayed");
  assert.equal(replay.body.field.revision_id, field.revision_id);

  const drift = await call(harness, "POST", ADMIN_FIELDS, {
    body: fieldBody({ label: "Different command" }),
    idempotency: key,
  });
  assert.equal(drift.status, 409);
  assert.equal(drift.body.error, "schema_field_idempotency_conflict");

  const revised = await call(harness, "POST", `${ADMIN_FIELDS}/${encodeURIComponent(field.field_id)}`, {
    idempotency: "schema-field-revise-0001",
    body: { action: "relabel", expected_version: 1, label: "Exterior colour" },
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.field.version, 2);
  assert.equal(revised.body.field.label, "Exterior colour");

  const stale = await call(harness, "POST", `${ADMIN_FIELDS}/${encodeURIComponent(field.field_id)}`, {
    idempotency: "schema-field-stale-0001",
    body: { action: "relabel", expected_version: 1, label: "Stale colour" },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "schema_field_definition_version_conflict");

  const history = await call(harness, "GET", `${ADMIN_FIELDS}/${encodeURIComponent(field.field_id)}/revisions`);
  assert.equal(history.status, 200);
  assert.equal(history.body.current_version, 2);
  assert.deepEqual(history.body.revisions.map((revision: Record<string, unknown>) => revision.version), [1, 2]);

  const listed = await call(harness, "GET", `${ADMIN_FIELDS}?entity_type=lead`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.fields.length, 1);
  assert.ok(listed.body.catalog.field_types.includes("attachment"));
  harness.db.close();
});

test("record routes omit unauthorized fields and bind value writes to the authenticated session", async () => {
  const harness = setup();
  const field = await createField(harness, "schema-value-field-0001");
  const path = `/api/v1/schema-fields/lead/${encodeURIComponent(LEAD_ID)}`;
  const valuePath = `${path}/${encodeURIComponent(field.field_id)}/values`;
  const valueBody = {
    field_definition_revision_id: field.revision_id,
    expected_version: 0,
    value: "Charcoal",
    tenant_id: OTHER_TENANT,
    actor: { type: "worker", role: "field", userId: USERS.field.userId },
  };

  const created = await call(harness, "POST", valuePath, {
    body: valueBody,
    idempotency: "schema-value-create-0001",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.value.provenance_actor_type, "owner");

  const stored = harness.db.raw.prepare(
    `SELECT tenant_id, provenance_actor_type, provenance_actor_id
       FROM schema_field_value_revisions WHERE value_revision_id = ?`,
  ).get(created.body.value.value_revision_id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, {
    tenant_id: TENANT,
    provenance_actor_type: "owner",
    provenance_actor_id: USERS.owner.userId,
  });

  const replay = await call(harness, "POST", valuePath, {
    body: valueBody,
    idempotency: "schema-value-create-0001",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.outcome, "replayed");

  const drift = await call(harness, "POST", valuePath, {
    body: { ...valueBody, value: "Green" },
    idempotency: "schema-value-create-0001",
  });
  assert.equal(drift.status, 409);
  assert.equal(drift.body.error, "schema_field_idempotency_conflict");

  const stale = await call(harness, "POST", valuePath, {
    body: { ...valueBody, value: "Silver" },
    idempotency: "schema-value-stale-0001",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "schema_field_value_version_conflict");

  const salesRead = await call(harness, "GET", path, { who: "sales" });
  assert.equal(salesRead.status, 200);
  assert.equal(salesRead.body.fields.length, 1);
  assert.equal(salesRead.body.fields[0].value.value, "Charcoal");
  assert.equal("command_fingerprint" in salesRead.body.fields[0].definition, false);
  assert.equal("read_roles" in salesRead.body.fields[0].definition, false);
  assert.equal("write_roles" in salesRead.body.fields[0].definition, false);
  assert.equal("idempotency_key_hash" in salesRead.body.fields[0].value, false);
  // Sales reads the field and may not write it: the derived answer says so without publishing
  // the role lists it was derived from (ELEC-192).
  assert.equal(salesRead.body.fields[0].writable, false);

  const productionRead = await call(harness, "GET", path, { who: "production" });
  assert.equal(productionRead.status, 200);
  assert.deepEqual(productionRead.body.fields, []);

  const crossTenant = await call(harness, "GET", path, { tenant: OTHER_TENANT });
  assert.equal(crossTenant.status, 200);
  assert.deepEqual(crossTenant.body.fields, []);

  const historyPath = `${path}/${encodeURIComponent(field.field_id)}/revisions`;
  const salesHistory = await call(harness, "GET", historyPath, { who: "sales" });
  assert.equal(salesHistory.body.revisions.length, 1);
  const forbiddenHistory = await call(harness, "GET", historyPath, { who: "production" });
  assert.deepEqual(forbiddenHistory.body.revisions, []);
  harness.db.close();
});

/**
 * Reads the card as `who`, then attempts the exact write that card's `writable` flag predicts, both
 * through the real routes. Asserting the two against each other in BOTH directions is the point:
 * the flag is a derivation of `assertValueWriteAuthority`, so a change that moved one without the
 * other would fail here rather than reach a contractor's phone as a disabled control over a field
 * they may edit, or an edit control that bounces off a 403.
 */
async function writeProbe(
  harness: Harness,
  who: Parameters<typeof auth>[0],
  entityPath: string,
  field: Record<string, any>,
  idempotency: string,
): Promise<{ writable: boolean | null; status: number; error: string | null }> {
  const read = await call(harness, "GET", entityPath, { who });
  assert.equal(read.status, 200);
  const entry = read.body.fields.find(
    (candidate: Record<string, any>) => candidate.definition.field_id === field.field_id,
  );
  const write = await call(harness, "POST", `${entityPath}/${encodeURIComponent(field.field_id)}/values`, {
    who,
    idempotency,
    body: {
      field_definition_revision_id: field.revision_id,
      expected_version: entry?.value?.version ?? 0,
      value: `probe-${idempotency}`,
    },
  });
  const accepted = write.status < 400;
  const context = `${who} on ${field.field_key}: ${write.status} ${JSON.stringify(write.body)}`;
  if (entry) {
    assert.equal(typeof entry.writable, "boolean", context);
    assert.equal(entry.writable, accepted, context);
  } else {
    // A field the caller may not even read must never be writable either.
    assert.equal(accepted, false, context);
  }
  return {
    writable: entry ? entry.writable as boolean : null,
    status: write.status,
    error: (write.body.error as string | undefined) ?? null,
  };
}

test("the record read publishes a writable flag that is exactly what the write route accepts", async () => {
  const harness = setup();
  const leadPath = `/api/v1/schema-fields/lead/${encodeURIComponent(LEAD_ID)}`;
  const jobPath = `/api/v1/schema-fields/job/${encodeURIComponent(JOB_ID)}`;

  // The ordinary office grant: sales reads it, owner and ops write it.
  const officeField = await createField(harness, "writable-office-0001", {
    field_key: "office-note",
    read_roles: ["owner", "ops", "sales"],
    write_roles: ["owner", "ops"],
  });
  // A tenant grant the PLATFORM refuses: `sales` is named in write_roles, but no role except
  // owner and ops carries lead-write authority, so the derivation has to answer false anyway.
  const grantedButUnpermitted = await createField(harness, "writable-granted-0001", {
    field_key: "sales-note",
    read_roles: ["owner", "sales"],
    write_roles: ["owner", "sales"],
  });
  // Both role conditions pass and the SCOPE refuses: an assigned write scope on a lead can never
  // be satisfied, which is why the flag derives the whole write predicate and not just its roles.
  const assignedScope = await createField(harness, "writable-scope-0001", {
    field_key: "scoped-note",
    read_roles: ["owner", "ops", "sales"],
    write_roles: ["owner", "ops"],
    write_scope: "assigned",
  });
  // The same divergence on a job, where the owner reads every card and is assigned to none.
  const jobField = await createField(harness, "writable-job-0001", {
    entity_type: "job",
    field_key: "crew-note",
    read_roles: ["owner", "field"],
    write_roles: ["owner", "field"],
    write_scope: "assigned",
  });

  assert.deepEqual(
    await writeProbe(harness, "owner", leadPath, officeField, "writable-probe-owner-0001"),
    { writable: true, status: 201, error: null },
  );
  assert.deepEqual(
    await writeProbe(harness, "ops", leadPath, officeField, "writable-probe-ops-0001"),
    { writable: true, status: 201, error: null },
  );
  assert.deepEqual(
    await writeProbe(harness, "sales", leadPath, officeField, "writable-probe-sales-0001"),
    { writable: false, status: 403, error: "schema_field_write_forbidden" },
  );
  assert.deepEqual(
    await writeProbe(harness, "sales", leadPath, grantedButUnpermitted, "writable-probe-granted-0001"),
    { writable: false, status: 403, error: "schema_field_write_forbidden" },
  );
  assert.deepEqual(
    await writeProbe(harness, "owner", leadPath, grantedButUnpermitted, "writable-probe-granted-0002"),
    { writable: true, status: 201, error: null },
  );
  assert.deepEqual(
    await writeProbe(harness, "owner", leadPath, assignedScope, "writable-probe-scope-0001"),
    { writable: false, status: 403, error: "schema_field_assignment_forbidden" },
  );
  assert.deepEqual(
    await writeProbe(harness, "owner", jobPath, jobField, "writable-probe-job-0001"),
    { writable: false, status: 403, error: "schema_field_assignment_forbidden" },
  );
  // Unreadable for this role, so absent from the card and refused at the write route alike.
  assert.deepEqual(
    await writeProbe(harness, "production", leadPath, officeField, "writable-probe-production-0001"),
    { writable: null, status: 403, error: "schema_field_write_forbidden" },
  );
  assert.deepEqual(
    await writeProbe(harness, "field", jobPath, jobField, "writable-probe-field-0001"),
    { writable: null, status: 403, error: "schema_field_assignment_forbidden" },
  );

  // Every field of the response carries the flag, and none of them carries the role lists or
  // scopes it was derived from - #196's posture holds, widened to the write direction.
  const salesCard = await call(harness, "GET", leadPath, { who: "sales" });
  assert.deepEqual(
    salesCard.body.fields.map((entry: Record<string, any>) => entry.definition.field_key).sort(),
    ["office-note", "sales-note", "scoped-note"],
  );
  for (const entry of salesCard.body.fields as Array<Record<string, any>>) {
    assert.equal(typeof entry.writable, "boolean");
    assert.equal(entry.writable, false);
    for (const leaked of ["read_roles", "write_roles", "read_scope", "write_scope"])
      assert.equal(leaked in entry.definition, false, `${leaked} leaked on ${entry.definition.field_key}`);
  }
  assert.equal(JSON.stringify(salesCard.body).includes("_roles"), false);
  assert.equal(JSON.stringify(salesCard.body).includes("_scope"), false);

  // Tenant isolation is unchanged: no card, and no write, across the boundary.
  const crossTenant = await call(harness, "GET", leadPath, { tenant: OTHER_TENANT });
  assert.equal(crossTenant.status, 200);
  assert.deepEqual(crossTenant.body.fields, []);
  const crossTenantWrite = await call(
    harness,
    "POST",
    `${leadPath}/${encodeURIComponent(officeField.field_id)}/values`,
    {
      tenant: OTHER_TENANT,
      idempotency: "writable-probe-cross-tenant-0001",
      body: { field_definition_revision_id: officeField.revision_id, expected_version: 0, value: "leak" },
    },
  );
  assert.equal(crossTenantWrite.status, 404);
  assert.equal(crossTenantWrite.body.error, "schema_field_not_found");
  harness.db.close();
});

test("template administration is tenant-bound, replay-safe, versioned, and wired through the app router", async () => {
  const harness = setup();
  const field = await createField(harness, "schema-template-field-0001");
  const key = "schema-template-create-0001";
  const body = {
    entity_type: "lead",
    template_key: "materials-list",
    label: "Materials list",
    blocks: [
      { kind: "heading", level: 1, text: "Materials" },
      { kind: "field", field_id: field.field_id },
    ],
    retention_policy: "standard",
    tenant_id: OTHER_TENANT,
    actor: { type: "worker", role: "field", userId: USERS.field.userId },
  };

  const denied = await call(harness, "GET", ADMIN_TEMPLATES, { who: "ops" });
  assert.equal(denied.status, 403);

  const created = await call(harness, "POST", ADMIN_TEMPLATES, { body, idempotency: key });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const template = created.body.template as Record<string, any>;
  assert.equal(template.actor.id, USERS.owner.userId);

  const stored = harness.db.raw.prepare(
    `SELECT tenant_id, actor_id FROM document_template_revisions WHERE revision_id = ?`,
  ).get(template.revision_id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, { tenant_id: TENANT, actor_id: USERS.owner.userId });

  const replay = await call(harness, "POST", ADMIN_TEMPLATES, { body, idempotency: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.outcome, "replayed");

  const drift = await call(harness, "POST", ADMIN_TEMPLATES, {
    body: { ...body, label: "Changed" },
    idempotency: key,
  });
  assert.equal(drift.status, 409);
  assert.equal(drift.body.error, "document_template_idempotency_conflict");

  const revised = await call(harness, "POST", `${ADMIN_TEMPLATES}/${encodeURIComponent(template.template_id)}`, {
    body: { action: "revise", expected_version: 1, label: "Material order list" },
    idempotency: "schema-template-revise-0001",
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.template.version, 2);

  const listed = await call(harness, "GET", `${ADMIN_TEMPLATES}?entity_type=lead`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.templates.length, 1);
  assert.equal("idempotency_key_hash" in listed.body.templates[0], false);

  const history = await call(
    harness,
    "GET",
    `${ADMIN_TEMPLATES}/${encodeURIComponent(template.template_id)}/revisions`,
  );
  assert.equal(history.body.current_version, 2);
  assert.deepEqual(history.body.revisions.map((revision: Record<string, unknown>) => revision.version), [1, 2]);

  const otherTenant = await call(
    harness,
    "GET",
    `${ADMIN_TEMPLATES}/${encodeURIComponent(template.template_id)}`,
    { tenant: OTHER_TENANT },
  );
  assert.equal(otherTenant.status, 404);
  harness.db.close();
});
