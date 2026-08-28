// The role-scoped record documents read (ELEC-195, IRO-209).
//
// `GET /api/v1/documents/:entityType/:entityId` publishes an administrator's document LAYOUT to
// the people who do the work. `docs/RECORD-DOCUMENTS-READ-CONTRACT.md` is the specification; this
// suite is what holds it, so the rules below are asserted rather than described.
//
// The client half is imported directly, not restated: `entityDocumentsResponseSchema` is the zod
// contract `app/src/documents/document-api.ts` parses every response with, so a server change that
// renames or drops a key fails here instead of rendering an empty shelf on a phone in a truck.
// That import needs the PWA's dependencies on disk (`npm ci --prefix app`), which is the order CI
// already installs them in.

import assert from "node:assert/strict";
import { test } from "node:test";

import { entityDocumentsResponseSchema } from "../../app/src/documents/document-contracts.ts";
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
const JOB_ID = "job:board:0001";
const LEAD_ID = "lead:board:0001";
const JOB_DOCUMENTS = `/api/v1/documents/job/${encodeURIComponent(JOB_ID)}`;

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: {
    body?: unknown;
    who?: Parameters<typeof auth>[0];
    tenant?: string;
    idempotency?: string | null;
  } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    request(method, path, {
      body: options.body,
      idempotency: options.idempotency === undefined
        ? method === "GET" ? null : "record-documents-key-0001"
        : options.idempotency,
    }),
    harness.env,
    auth(options.who ?? "owner", options.tenant ?? TENANT),
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** An owner-authored job field. `readRoles` is what makes a block reach a reader who may not read its value. */
async function createJobField(
  harness: Harness,
  fieldKey: string,
  readRoles: string[],
  idempotency: string,
): Promise<Record<string, any>> {
  const response = await call(harness, "POST", ADMIN_FIELDS, {
    idempotency,
    body: {
      entity_type: "job",
      field_key: fieldKey,
      label: fieldKey,
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
      read_roles: readRoles,
      write_roles: ["owner"],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.field as Record<string, any>;
}

async function createJobTemplate(
  harness: Harness,
  templateKey: string,
  blocks: unknown[],
  idempotency: string,
): Promise<Record<string, any>> {
  const response = await call(harness, "POST", ADMIN_TEMPLATES, {
    idempotency,
    body: {
      entity_type: "job",
      template_key: templateKey,
      label: `${templateKey} label`,
      blocks,
      retention_policy: "standard",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.template as Record<string, any>;
}

test("a record's documents publish the authored layout, verbatim and in order, to a reader of the record", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  const blocks = [
    { kind: "heading", level: 1, text: "Order for the shop" },
    { kind: "field", field_id: field.field_id },
    { kind: "text", text: "Confirm counts with the shop." },
  ];
  const template = await createJobTemplate(harness, "materials-list", blocks, "rd-template-0001");

  const read = await call(harness, "GET", JOB_DOCUMENTS, { who: "production" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body, {
    entity_type: "job",
    entity_id: JOB_ID,
    documents: [
      {
        template_id: template.template_id,
        template_key: "materials-list",
        label: "materials-list label",
        revision_id: template.revision_id,
        version: 1,
        blocks,
      },
    ],
  });

  // The client parses every response with this schema, so proving the halves agree is a parse,
  // not an inspection of the keys this test happens to know about.
  const parsed = entityDocumentsResponseSchema.safeParse(read.body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.documents[0]?.blocks, blocks);

  // Authoring coordinates are not a reader's business and must not leak through this route.
  const document = read.body.documents[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(document).sort(), [
    "blocks", "label", "revision_id", "template_id", "template_key", "version",
  ]);
  for (const key of ["action", "actor", "active", "command_fingerprint", "entity_type",
    "effective_at", "retention_policy", "idempotency_key_hash", "created_at"])
    assert.equal(key in document, false, `${key} must not travel on a record document read`);
  harness.db.close();
});

test("layout travels and values never do, however the record read answers", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );

  const secret = "Charcoal-standing-seam-42";
  const wrote = await call(
    harness,
    "POST",
    `/api/v1/schema-fields/job/${encodeURIComponent(JOB_ID)}/${encodeURIComponent(field.field_id)}/values`,
    {
      idempotency: "rd-value-0001",
      body: {
        field_definition_revision_id: field.revision_id,
        expected_version: 0,
        value: secret,
      },
    },
  );
  assert.equal(wrote.status, 201, JSON.stringify(wrote.body));

  // The value is readable, on the one route that applies per-field authority.
  const values = await call(harness, "GET", `/api/v1/schema-fields/job/${encodeURIComponent(JOB_ID)}`, {
    who: "production",
  });
  assert.equal(values.body.fields[0].value.value, secret);

  // It is not readable here, for anyone - not even the owner who wrote it.
  for (const who of ["owner", "production"] as const) {
    const read = await call(harness, "GET", JOB_DOCUMENTS, { who });
    assert.equal(read.status, 200);
    assert.equal(JSON.stringify(read.body).includes(secret), false);
    for (const block of read.body.documents[0].blocks as Array<Record<string, unknown>>)
      assert.deepEqual(Object.keys(block).sort(), ["field_id", "kind"]);
  }
  harness.db.close();
});

test("a reader who may not read the value of a bound field still receives its block", async () => {
  const harness = setup();
  // Readable by the owner alone. Production may read the job, so it may read the layout, but the
  // field is simply absent from its record read - and the client marks that line withheld.
  const ownerOnly = await createJobField(harness, "owner-note", ["owner"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "heading", level: 2, text: "Costing" }, { kind: "field", field_id: ownerOnly.field_id }],
    "rd-template-0001",
  );

  const documents = await call(harness, "GET", JOB_DOCUMENTS, { who: "production" });
  assert.equal(documents.status, 200, JSON.stringify(documents.body));
  assert.deepEqual(documents.body.documents[0].blocks, [
    { kind: "heading", level: 2, text: "Costing" },
    { kind: "field", field_id: ownerOnly.field_id },
  ]);

  const values = await call(harness, "GET", `/api/v1/schema-fields/job/${encodeURIComponent(JOB_ID)}`, {
    who: "production",
  });
  assert.deepEqual(values.body.fields, []);

  // The owner's own read is unchanged by the presence of a second consumer.
  const ownerValues = await call(harness, "GET", `/api/v1/schema-fields/job/${encodeURIComponent(JOB_ID)}`);
  assert.equal(ownerValues.body.fields.length, 1);
  harness.db.close();
});

test("a retired template is absent, and the record that carried it answers with an empty shelf", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  const retiring = await createJobTemplate(
    harness,
    "old-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );
  const staying = await createJobTemplate(
    harness,
    "current-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0002",
  );

  const before = await call(harness, "GET", JOB_DOCUMENTS, { who: "production" });
  assert.deepEqual(
    (before.body.documents as Array<Record<string, unknown>>).map((document) => document.template_key),
    ["current-list", "old-list"],
  );

  const retired = await call(
    harness,
    "POST",
    `${ADMIN_TEMPLATES}/${encodeURIComponent(retiring.template_id)}`,
    {
      idempotency: "rd-template-retire-0001",
      body: { action: "retire", active: false, expected_version: 1 },
    },
  );
  assert.equal(retired.status, 200, JSON.stringify(retired.body));

  const after = await call(harness, "GET", JOB_DOCUMENTS, { who: "production" });
  assert.equal(after.status, 200);
  assert.deepEqual(
    (after.body.documents as Array<Record<string, unknown>>).map((document) => document.template_key),
    ["current-list"],
  );

  const retiredToo = await call(
    harness,
    "POST",
    `${ADMIN_TEMPLATES}/${encodeURIComponent(staying.template_id)}`,
    {
      idempotency: "rd-template-retire-0002",
      body: { action: "retire", active: false, expected_version: 1 },
    },
  );
  assert.equal(retiredToo.status, 200, JSON.stringify(retiredToo.body));

  const empty = await call(harness, "GET", JOB_DOCUMENTS, { who: "production" });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { entity_type: "job", entity_id: JOB_ID, documents: [] });
  assert.ok(entityDocumentsResponseSchema.safeParse(empty.body).success);
  harness.db.close();
});

test("a record that exists and carries no document is an empty shelf, not a refusal", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );

  // The lead exists and the owner may read it; the tenant has authored nothing for leads.
  const read = await call(harness, "GET", `/api/v1/documents/lead/${encodeURIComponent(LEAD_ID)}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body, { entity_type: "lead", entity_id: LEAD_ID, documents: [] });
  assert.ok(entityDocumentsResponseSchema.safeParse(read.body).success);
  harness.db.close();
});

test("a record this session may not read is a 404, whichever way it may not read it", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );

  // A record in another tenant. The tenant on the session decides, never the caller.
  const crossTenant = await call(harness, "GET", JOB_DOCUMENTS, { tenant: OTHER_TENANT });
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.body.error, "not_found");

  // A role that may not read this kind of record at all: sales reads leads, not jobs.
  const sales = await call(harness, "GET", JOB_DOCUMENTS, { who: "sales" });
  assert.equal(sales.status, 404);
  assert.equal(sales.body.error, "not_found");

  // A record id that names nothing, and an entity type nobody registers.
  const missing = await call(harness, "GET", "/api/v1/documents/job/job%3Aboard%3A9999");
  assert.equal(missing.status, 404);
  const unknownType = await call(harness, "GET", "/api/v1/documents/widget/w-1");
  assert.equal(unknownType.status, 404);

  // The reader learns nothing about the record from the refusal: an unreadable record and an
  // unknown one answer with the same body.
  assert.deepEqual(sales.body, missing.body);
  harness.db.close();
});

test("the route is read-only and leaves document generation owner-only", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner", "production"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );

  for (const method of ["POST", "PUT", "DELETE"]) {
    const attempt = await call(harness, method, JOB_DOCUMENTS, {
      body: { blocks: [] },
      idempotency: `rd-write-${method}-0001`,
    });
    assert.equal(attempt.status, 404, `${method} must not be a command on a read route`);
  }

  // Reading a layout is not authoring one: the administration surface stays owner-only.
  const adminAttempt = await call(harness, "GET", `${ADMIN_TEMPLATES}?entity_type=job`, {
    who: "production",
  });
  assert.equal(adminAttempt.status, 403);
  assert.equal(adminAttempt.body.error, "schema_configuration_forbidden");

  const generation = await call(harness, "POST", "/api/v1/document-generations", {
    who: "production",
    idempotency: "rd-generation-0001",
    body: { entity_type: "job", entity_id: JOB_ID, template_id: "whatever" },
  });
  assert.equal(generation.status, 403);
  assert.equal(generation.body.error, "document_generation_forbidden");
  harness.db.close();
});

test("every role that may read the record may read its layout, and no other role may", async () => {
  const harness = setup();
  const field = await createJobField(harness, "shop-note", ["owner"], "rd-field-0001");
  await createJobTemplate(
    harness,
    "materials-list",
    [{ kind: "field", field_id: field.field_id }],
    "rd-template-0001",
  );

  // The gate is exactly the one `listAuthorizedSchemaFieldValues` applies to the record read, so
  // the two answer the same question about who may look at all - `field` included, whose record
  // read then narrows to the jobs they are assigned. Reading a layout is not reading the job.
  for (const who of ["owner", "ops", "production", "field"] as const) {
    const read = await call(harness, "GET", JOB_DOCUMENTS, { who });
    assert.equal(read.status, 200, `${who}: ${JSON.stringify(read.body)}`);
    assert.equal(read.body.documents.length, 1);
  }
  for (const who of ["sales"] as const) {
    const read = await call(harness, "GET", JOB_DOCUMENTS, { who });
    assert.equal(read.status, 404, `${who} may not read a job`);
  }
  assert.equal(USERS.field.role, "field");
  harness.db.close();
});
