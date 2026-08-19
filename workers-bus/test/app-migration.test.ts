import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("0011 auth migration contains every readiness artifact and never stores raw tokens", async () => {
  const sql = await readFile(
    new URL("../migrations/0011_app_bff_auth.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "app_users",
    "app_magic_links",
    "app_sessions",
    "app_auth_throttles",
    "app_auth_audit",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_app_users_tenant_role_active",
    "idx_app_magic_links_user_expiry",
    "idx_app_sessions_user_expiry",
    "idx_app_auth_throttles_expiry",
    "idx_app_auth_audit_tenant_created",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.match(sql, /session_hash TEXT PRIMARY KEY/);
  assert.doesNotMatch(sql, /raw_token|raw_session|session_token|magic_token/i);
  assert.match(sql, /role IN \('owner', 'ops', 'field'\)/);
  assert.match(sql, /UNIQUE \(tenant_id, email_normalized\)/);
  assert.match(sql, /UNIQUE \(user_id\)/);
});

test("Wrangler asset routing keeps all dynamic/auth surfaces Worker-first", async () => {
  const config = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  assert.match(config, /"directory": "\.\.\/app\/dist"/);
  assert.match(config, /"not_found_handling": "single-page-application"/);
  for (const route of [
    "/api/*",
    "/health",
    "/ready",
    "/admin/*",
    "/ingest/*",
    "/public/*",
    "/webhook/*",
  ]) {
    assert.ok(
      config.includes(`"${route}"`),
      `missing Worker-first route ${route}`,
    );
  }
});

test("Wrangler environments declare Newo explicitly and staging keeps its queue isolated", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const newoVarNames = Object.keys(config.vars)
    .filter((name) => name.startsWith("NEWO_"))
    .sort();

  for (const name of ["local", "staging"]) {
    const environment = config.env[name];
    assert.deepEqual(
      Object.keys(environment.vars)
        .filter((key) => key.startsWith("NEWO_"))
        .sort(),
      newoVarNames,
      `${name} must not inherit Newo configuration`,
    );
    assert.equal(environment.vars.NEWO_ENABLED, "false");
    assert.equal(environment.vars.NEWO_CONTROL_WRITE_ENABLED, "false");
    assert.equal(environment.vars.NEWO_OUTBOUND_ENABLED, "false");
  }

  assert.equal(config.env.local.vars.NEWO_PRODUCTION_REQUIRED, "false");
  assert.equal(config.env.staging.vars.NEWO_PRODUCTION_REQUIRED, "true");
  assert.equal(config.vars.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED, "false");
  assert.equal(
    config.env.local.vars.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED,
    "false",
  );
  assert.equal(
    config.env.staging.vars.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED,
    "false",
  );
  assert.equal(config.vars.APP_FIRST_OWNER_BOOTSTRAP_ENABLED, "false");
  assert.equal(config.env.local.vars.APP_FIRST_OWNER_BOOTSTRAP_ENABLED, "true");
  assert.equal(
    config.env.staging.vars.APP_FIRST_OWNER_BOOTSTRAP_ENABLED,
    "false",
  );
  assert.equal(config.vars.FACET_DESIGN_INGEST_ENABLED, "false");
  assert.equal(config.env.local.vars.FACET_DESIGN_INGEST_ENABLED, "false");
  assert.equal(config.env.staging.vars.FACET_DESIGN_INGEST_ENABLED, "false");
  assert.equal(config.vars.FACET_DESIGN_INGEST_TENANT_MAP_JSON, "{}");
  assert.equal(config.env.local.vars.FACET_DESIGN_INGEST_TENANT_MAP_JSON, "{}");
  assert.equal(
    config.env.staging.vars.FACET_DESIGN_INGEST_TENANT_MAP_JSON,
    "{}",
  );
  assert.equal(config.vars.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED, "false");
  assert.equal(
    config.env.local.vars.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED,
    "false",
  );
  assert.equal(
    config.env.staging.vars.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED,
    "false",
  );
  assert.equal(config.vars.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED, "false");
  assert.equal(
    config.env.local.vars.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED,
    "false",
  );
  assert.equal(
    config.env.staging.vars.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED,
    "false",
  );
  for (const environment of [
    config.vars,
    config.env.local.vars,
    config.env.staging.vars,
  ]) {
    assert.equal(
      "FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON" in environment,
      false,
    );
  }
  assert.deepEqual(
    config.env.staging.queues.producers.find(
      (queue: { binding: string }) => queue.binding === "NEWO_QUEUE",
    ),
    { binding: "NEWO_QUEUE", queue: "ironwrap-staging-newo-events" },
  );
  assert.ok(
    config.env.staging.queues.consumers.some(
      (queue: { queue: string; dead_letter_queue?: string }) =>
        queue.queue === "ironwrap-staging-newo-events" &&
        queue.dead_letter_queue === "ironwrap-staging-newo-dlq",
    ),
  );
});

test("Wrangler gives measurement processing an isolated queue and DLQ in every environment", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const environments = [
    [
      "production",
      config,
      "ironwrap-measurements",
      "ironwrap-measurements-dlq",
    ],
    [
      "local",
      config.env.local,
      "ironwrap-local-measurements",
      "ironwrap-local-measurements-dlq",
    ],
    [
      "staging",
      config.env.staging,
      "ironwrap-staging-measurements",
      "ironwrap-staging-measurements-dlq",
    ],
  ] as const;
  const queueNames = new Set<string>();

  for (const [name, environment, queueName, dlqName] of environments) {
    assert.equal(
      environment.vars.MEASUREMENT_OCR_ENABLED,
      "true",
      `${name} measurement OCR enabled`,
    );
    assert.equal(
      environment.vars.MEASUREMENT_OCR_MODEL,
      "claude-opus-5",
      `${name} measurement OCR model`,
    );
    assert.deepEqual(
      environment.queues.producers.find(
        (queue: { binding: string }) => queue.binding === "MEASUREMENT_QUEUE",
      ),
      { binding: "MEASUREMENT_QUEUE", queue: queueName },
      `${name} measurement producer`,
    );
    assert.deepEqual(
      environment.queues.consumers.find(
        (queue: { queue: string }) => queue.queue === queueName,
      ),
      {
        queue: queueName,
        max_retries: 5,
        max_batch_size: 1,
        max_batch_timeout: 1,
        dead_letter_queue: dlqName,
      },
      `${name} measurement consumer`,
    );
    assert.deepEqual(
      environment.queues.consumers.find(
        (queue: { queue: string }) => queue.queue === dlqName,
      ),
      { queue: dlqName, max_retries: 1 },
      `${name} measurement DLQ consumer`,
    );
    queueNames.add(queueName);
    queueNames.add(dlqName);
  }

  assert.equal(
    queueNames.size,
    environments.length * 2,
    "queue names must not cross environments",
  );
});

test("0018 customer portal migration stores only revocable capability hashes", async () => {
  const sql = await readFile(
    new URL("../migrations/0018_customer_portal_links.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "customer_portal_links",
    "customer_portal_access_throttles",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_customer_portal_links_tenant_job_active",
    "idx_customer_portal_access_throttles_expiry",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /customer_id TEXT NOT NULL/);
  assert.match(sql, /revoked_at TEXT/);
  assert.match(
    sql,
    /FOREIGN KEY \(issued_by_user_id, tenant_id\)[\s\S]*ON DELETE RESTRICT/,
  );
  assert.doesNotMatch(sql, /raw_token|portal_token|token_value/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0019 measurement intake migration keeps retries hash-addressed and reviewable", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0019_measurement_intake_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS measurement_intake_receipts\b/);
  assert.match(sql, /idempotency_key_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /measurement_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /content_type TEXT NOT NULL/);
  assert.match(
    sql,
    /key_strategy IN \('request_header', 'provider_attachment', 'attachment_job', 'payload_hash'\)/,
  );
  assert.match(
    sql,
    /status IN \('processing', 'matched', 'unmatched', 'retryable_error'\)/,
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_measurement_intake_receipts_exception_updated\b/,
  );
  assert.match(sql, /raw_key GLOB 'raw\/measurements\/\[0-9a-f\]\*\.json'/);
  assert.doesNotMatch(
    sql,
    /raw_provider_id|attachment_identifier|signed_report_url/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0021 public estimate rate guard stores only bounded keyed hashes", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0021_public_estimate_rate_limits.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public_estimate_rate_limits\b/);
  assert.match(sql, /PRIMARY KEY \(scope, subject_hash\)/);
  assert.match(sql, /scope IN \('ip', 'client'\)/);
  assert.match(sql, /length\(subject_hash\) = 64/);
  assert.match(sql, /idx_public_estimate_rate_limits_expiry/);
  assert.doesNotMatch(
    schema,
    /raw_ip|ip_address|client_submission_id|turnstile|contact_email|contact_phone|customer_name/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0012 field migration preserves idempotent actions and immutable media receipts", async () => {
  const sql = await readFile(
    new URL("../migrations/0012_field_companion.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["field_actions", "field_action_media"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /device_action_id TEXT PRIMARY KEY/);
  assert.match(sql, /PRIMARY KEY \(device_action_id, attachment_id\)/);
  assert.match(sql, /r2_key TEXT NOT NULL UNIQUE/);
  assert.match(sql, /checksum_sha256 TEXT NOT NULL/);
  assert.match(sql, /ON DELETE RESTRICT/g);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
  assert.match(
    sql,
    /status IN \('processing', 'r2_stored', 'frappe_persisted', 'verified', 'retryable_error'\)/,
  );
});

test("0013 field upload throttles are bounded and user-scoped", async () => {
  const sql = await readFile(
    new URL("../migrations/0013_field_action_throttles.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_action_throttles\b/);
  assert.match(sql, /PRIMARY KEY \(tenant_id, user_id, scope\)/);
  assert.match(sql, /scope IN \('field_upload'\)/);
  assert.match(sql, /idx_app_action_throttles_expiry/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0014 QR pairing binds field sessions to revocable hashed device proofs", async () => {
  const sql = await readFile(
    new URL("../migrations/0014_device_pairing.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE app_sessions ADD COLUMN device_id TEXT/);
  for (const table of ["app_device_pairings", "app_devices"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_app_sessions_device_active",
    "idx_app_device_pairings_user_expiry",
    "idx_app_devices_tenant_user_active",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /device_proof_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.doesNotMatch(
    sql,
    /raw_token|raw_session|device_proof[^_h]|pairing_token/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0015 lead-ack receipts preserve provider-acceptance evidence without recipient content", async () => {
  const sql = await readFile(
    new URL("../migrations/0015_lead_ack_receipts.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_ack_receipts\b/);
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_lead_ack_receipts_envelope_observed\b/,
  );
  for (const trigger of [
    "prevent_lead_ack_receipts_update",
    "prevent_lead_ack_receipts_delete",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  assert.match(sql, /BEFORE UPDATE ON lead_ack_receipts/);
  assert.match(sql, /BEFORE DELETE ON lead_ack_receipts/);
  assert.match(sql, /RAISE\(ABORT, 'lead_ack_receipts_immutable'\)/);
  assert.match(sql, /provider_accepted/);
  assert.match(sql, /attempt_failed/);
  assert.match(sql, /no_eligible_channel/);
  assert.match(sql, /provider_message_id TEXT/);
  assert.doesNotMatch(
    schema,
    /recipient|contact_email|message_body|raw_message/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("approval migrations avoid nested CASE statements in remote D1 trigger commands", async () => {
  const sql = await readFile(
    new URL("../migrations/0016_approval_requests.sql", import.meta.url),
    "utf8",
  );
  const transitionKernelSql = await readFile(
    new URL("../migrations/0027_transition_kernel.sql", import.meta.url),
    "utf8",
  );
  const facetCustomerApprovalSql = await readFile(
    new URL(
      "../migrations/0034_facet_customer_approval_ingest.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const migration of [
    "0016_approval_requests.sql",
    "0017_quote_revision_approval_requests.sql",
    "0020_production_schedule_approval_requests.sql",
  ]) {
    const migrationSql = await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(migrationSql, /\bCASE\b/i);
    assert.match(
      migrationSql,
      /COALESCE\(NULLIF\(NEW\.state, 'executing'\), 'execution_claimed'\)/,
    );
  }
  assert.doesNotMatch(facetCustomerApprovalSql, /\bCASE\b/i);
  for (const code of [
    "approval_request_version_transition_required",
    "approval_request_transition_actor_required",
    "approval_request_reconciliation_requires_uncertain",
    "approval_request_reconciliation_actor_required",
  ]) {
    assert.match(
      sql,
      new RegExp(`SELECT RAISE\\(ABORT, '${code}'\\)\\s+WHERE`),
    );
  }
  assert.doesNotMatch(transitionKernelSql, /\bCASE\b/i);
  assert.match(
    transitionKernelSql,
    /renew_approval_execution_lease_from_governed_outbox_claim/,
  );
});

test("0028 keeps work-package commands bounded and independently recoverable", async () => {
  const sql = await readFile(
    new URL("../migrations/0028_work_package_actions.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS field_work_package_actions\b/);
  // 0028 shipped on 2026-07-30 and production applied it on 2026-08-13, so its
  // bytes are frozen: the action_kind CHECK here must stay the three-member one
  // that is live in production. complete_work is widened forward by
  // 0057_work_package_completion_action_kind.sql, and the applied-chain test
  // below is what asserts the end state. Asserting the widened list here is what
  // let the edited migration pass review in the first place (Linear IRO-62).
  assert.match(
    sql,
    /action_kind IN \('acknowledge', 'stop_work', 'start_work'\)/,
  );
  assert.doesNotMatch(sql, /complete_work/);
  assert.match(
    sql,
    /status IN \('processing', 'r2_stored', 'verified', 'retryable_error'\)/,
  );
  assert.match(sql, /idx_field_work_package_actions_job_created/);
  assert.match(sql, /idx_field_work_package_actions_recovery/);
  assert.match(sql, /REFERENCES app_users\(user_id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0029 keeps customer contract acceptance hash-addressed and append-only", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0029_customer_contract_acceptance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of [
    "customer_portal_acceptance_challenges",
    "customer_portal_acceptance_intents",
    "customer_portal_acceptance_events",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_customer_portal_acceptance_one_active_challenge",
    "idx_customer_portal_acceptance_challenges_expiry",
    "idx_customer_portal_acceptance_intents_state_lease",
    "idx_customer_portal_acceptance_events_created",
  ]) {
    assert.match(
      sql,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${index}\\b`),
    );
  }
  for (const trigger of [
    "customer_portal_acceptance_challenge_immutable",
    "customer_portal_acceptance_challenges_append_only_delete",
    "customer_portal_acceptance_immutable_intent",
    "customer_portal_acceptance_intents_append_only_delete",
    "customer_portal_acceptance_events_append_only_update",
    "customer_portal_acceptance_events_append_only_delete",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /email_hash TEXT NOT NULL/);
  assert.match(sql, /idempotency_key_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /provider_message_id TEXT/);
  assert.match(sql, /receipt_key TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(
    sql,
    /raw_token|challenge_token|customer_email|idempotency_key TEXT/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0030 keeps Facet design ingress immutable, hash-addressed, and commercially inert", async () => {
  const sql = await readFile(
    new URL("../migrations/0030_facet_design_ingest.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of ["facet_design_events", "facet_design_ingest_nonces"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const trigger of [
    "facet_design_events_append_only_update",
    "facet_design_events_append_only_delete",
    "facet_design_ingest_nonces_append_only_update",
    "facet_design_ingest_nonces_append_only_delete",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  assert.match(sql, /event_type = 'facet\.design\.approved\.v1'/);
  assert.match(sql, /schema_version = 1/);
  assert.match(sql, /design_revision_sha256 TEXT NOT NULL/);
  assert.match(sql, /frozen_evidence_sha256 TEXT NOT NULL/);
  assert.match(sql, /raw_key TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(schema, /quote|contract|acceptance|frappe|payload_json/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0034 keeps Facet customer approvals provenance-bearing, append-only, and non-commercial", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0034_facet_customer_approval_ingest.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "facet_customer_approval_events",
    "facet_design_event_identity_registry",
    "facet_design_ingest_nonce_registry",
  ])
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  for (const trigger of [
    "facet_customer_approval_events_append_only_update",
    "facet_customer_approval_events_append_only_delete",
    "facet_design_events_register_identity",
    "facet_customer_approval_events_register_identity",
    "facet_design_event_identity_registry_append_only_update",
    "facet_design_event_identity_registry_append_only_delete",
    "facet_design_ingest_nonce_registry_append_only_update",
    "facet_design_ingest_nonce_registry_append_only_delete",
  ])
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  assert.match(sql, /event_type = 'facet\.design\.customer_approved\.v2'/);
  assert.match(sql, /schema_version = 2/);
  assert.match(sql, /approval_actor_type = 'customer_capability'/);
  assert.match(sql, /identity_assurance = 'bearer_capability_only'/);
  assert.match(sql, /capability_fingerprint TEXT NOT NULL/);
  assert.match(sql, /INSERT OR IGNORE INTO facet_design_ingest_nonce_registry/);
  assert.match(
    sql,
    /INSERT OR IGNORE INTO facet_design_event_identity_registry/,
  );
  assert.doesNotMatch(
    schema,
    /customer_name|customer_email|customer_phone|address|price|amount|estimate|payload_json/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0035 keeps Facet evidence associations operator-authored, immutable, and v2-bound", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0035_facet_design_evidence_associations.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "facet_design_evidence_associations",
    "facet_customer_approval_projection_attempts",
  ])
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  for (const trigger of [
    "facet_design_evidence_associations_validate_insert",
    "facet_design_evidence_associations_append_only_update",
    "facet_design_evidence_associations_append_only_delete",
    "facet_customer_approval_projection_attempts_append_only_update",
    "facet_customer_approval_projection_attempts_append_only_delete",
  ])
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  for (const anchor of [
    "event_id",
    "tenant_id",
    "brand_id",
    "facet_project_id",
    "design_revision_id",
    "design_revision_sha256",
    "frozen_evidence_sha256",
    "association_anchor_sha256",
  ])
    assert.match(sql, new RegExp(`${anchor}\\s+TEXT`));
  assert.match(
    sql,
    /REFERENCES facet_customer_approval_events\(event_id\) ON DELETE RESTRICT/g,
  );
  assert.match(
    sql,
    /REFERENCES app_users\(user_id, tenant_id\) ON DELETE RESTRICT/,
  );
  assert.match(sql, /idempotency_key_sha256 TEXT NOT NULL UNIQUE/);
  assert.match(sql, /association_intent_sha256 TEXT NOT NULL/);
  assert.match(sql, /approval_actor_type = 'customer_capability'/);
  assert.match(sql, /identity_assurance = 'bearer_capability_only'/);
  assert.match(sql, /actor\.role IN \('owner', 'ops'\)/);
  assert.doesNotMatch(
    schema,
    /capability_fingerprint|raw_sha256 TEXT NOT NULL UNIQUE|customer_name|customer_email|customer_phone|address|price|amount|quote_total|payload_json/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0037 makes measurement calibration tenant-bound, append-only, and replay-safe", async () => {
  const sql = await readFile(
    new URL("../migrations/0037_measurement_calibration.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /ALTER TABLE measurement_deltas\s+ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'ironwrap'/,
  );
  assert.match(
    sql,
    /ALTER TABLE measurement_deltas\s+ADD COLUMN error_kind TEXT NOT NULL DEFAULT ''/,
  );
  assert.match(
    sql,
    /ALTER TABLE measurement_deltas\s+ADD COLUMN signed_error REAL/,
  );
  assert.match(sql, /UPDATE measurement_deltas[\s\S]*signed_error = CASE/);
  assert.match(sql, /DROP INDEX idx_measurement_deltas_identity/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_deltas_identity[\s\S]*\(tenant_id, receipt_id, check_name, metric\)/,
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_measurement_deltas_tenant_cohort_created[\s\S]*\(tenant_id, provider, source, metric, error_kind, created_at, id\)/,
  );
  for (const trigger of [
    "measurement_deltas_append_only_update",
    "measurement_deltas_append_only_delete",
  ])
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  assert.match(sql, /RAISE\(ABORT, 'measurement_deltas_append_only'\)/);
  assert.doesNotMatch(sql, /DROP TABLE|REPLACE INTO|ON DELETE CASCADE/i);
});

const HERMES_BINDING = {
  tenantId: "ironwrap",
  userId: "user:owner:001",
  role: "owner",
  pairingId: "hdpair:001",
  deviceId: "hddev:001",
  apiAudience: "https://bus.example",
  boundIssuer: "https://app.example",
  boundOrigin: "https://app.example",
  capabilitiesJson: '[{"operations":["read"],"provider":"gmail"}]',
} as const;

const digest = (character: string): string => character.repeat(64);

async function createHermesMigrationDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0011_app_bff_auth.sql",
    "0036_hermes_desktop_pilot.sql",
  ]) {
    db.exec(
      await readFile(
        new URL(`../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return db;
}

function insertHermesUser(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', NULL, 1,
             'migration-test', '2026-08-11T09:00:00.000Z', '2026-08-11T09:00:00.000Z')`,
  ).run(HERMES_BINDING.userId, HERMES_BINDING.tenantId);
}

function insertHermesPairing(
  db: DatabaseSync,
  pairingId = HERMES_BINDING.pairingId,
  tokenSha256 = digest("a"),
): void {
  db.prepare(
    `INSERT INTO hermes_desktop_pairings
     (pairing_id, token_sha256, tenant_id, user_id, role, api_audience,
      bound_issuer, bound_origin, issued_at, expires_at, consumed_at,
      consumed_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-11T10:00:00.000Z',
             '2026-08-11T10:10:00.000Z', NULL, NULL)`,
  ).run(
    pairingId,
    tokenSha256,
    HERMES_BINDING.tenantId,
    HERMES_BINDING.userId,
    HERMES_BINDING.role,
    HERMES_BINDING.apiAudience,
    HERMES_BINDING.boundIssuer,
    HERMES_BINDING.boundOrigin,
  );
}

function insertHermesDevice(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO hermes_desktop_devices
     (device_id, pairing_id, tenant_id, user_id, role, api_audience,
      bound_issuer, bound_origin, connector_capabilities_json, device_name,
      device_proof_sha256, access_token_sha256, access_expires_at, paired_at,
      last_seen_at, revoked_at, revoked_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Office Mac', ?, ?,
             '2026-08-11T11:01:00.000Z', '2026-08-11T10:01:00.000Z',
             NULL, NULL, NULL)`,
  ).run(
    HERMES_BINDING.deviceId,
    HERMES_BINDING.pairingId,
    HERMES_BINDING.tenantId,
    HERMES_BINDING.userId,
    HERMES_BINDING.role,
    HERMES_BINDING.apiAudience,
    HERMES_BINDING.boundIssuer,
    HERMES_BINDING.boundOrigin,
    HERMES_BINDING.capabilitiesJson,
    digest("b"),
    digest("c"),
  );
  db.prepare(
    `UPDATE hermes_desktop_pairings
        SET consumed_at = '2026-08-11T10:01:00.000Z', consumed_device_id = ?
      WHERE pairing_id = ?`,
  ).run(HERMES_BINDING.deviceId, HERMES_BINDING.pairingId);
}

function insertHermesEnvelope(db: DatabaseSync, suffix: string) {
  const envelope = {
    envelopeId: `hdenv:${suffix}`,
    initialContextSha256: digest(suffix === "001" ? "d" : "e"),
    initialProviderRequestSha256: digest(suffix === "001" ? "9" : "a"),
    contextId: null,
    contextSha256: digest(suffix === "001" ? "d" : "e"),
    providerRequestSha256: digest(suffix === "001" ? "9" : "a"),
  };
  db.prepare(
    `INSERT INTO hermes_desktop_envelopes
     (envelope_id, version, workflow, tenant_id, user_id, role, device_id,
      pairing_id, lead_id, lead_envelope_id, roof_job_id, channel, recipient_ref,
      consent_id, consent_basis, state, context_sha256, context_json,
      envelope_json, provider_request_json, provider_request_sha256,
      output_schema_sha256, messages_sha256, issued_at, expires_at, submitted_at)
     VALUES (?, 'task_envelope_v1', 'lead_follow_up_draft', ?, ?, ?, ?, ?, ?, ?,
             NULL, 'Email', 'recipient:001', 'consent:001', 'Express', 'issued', ?,
             '{"stage":"issued"}', '{"version":"task_envelope_v1"}',
             '{"messages":[],"model":"initial"}', ?, ?, ?,
             '2026-08-11T10:02:00.000Z', '2026-08-11T10:09:00.000Z', NULL)`,
  ).run(
    envelope.envelopeId,
    HERMES_BINDING.tenantId,
    HERMES_BINDING.userId,
    HERMES_BINDING.role,
    HERMES_BINDING.deviceId,
    HERMES_BINDING.pairingId,
    `lead:${suffix}`,
    `lead-envelope:${suffix}`,
    envelope.initialContextSha256,
    envelope.initialProviderRequestSha256,
    digest("3"),
    digest("4"),
  );
  return envelope;
}

function insertHermesContext(
  db: DatabaseSync,
  envelope: ReturnType<typeof insertHermesEnvelope>,
) {
  const suffix = envelope.envelopeId.slice("hdenv:".length);
  const context = {
    ...envelope,
    contextId: `hdctx:${suffix}`,
    contextSha256: digest(suffix === "001" ? "f" : "0"),
    providerRequestSha256: digest(suffix === "001" ? "1" : "2"),
  };
  db.prepare(
    `INSERT INTO hermes_desktop_contexts
     (context_id, envelope_id, tenant_id, user_id, role, device_id, pairing_id,
      prior_context_sha256, context_sha256, observations_json,
      calendar_slots_json, context_json, provider_request_json,
      provider_request_sha256, output_schema_sha256, messages_sha256, staged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{"stage":"staged"}',
             '{"messages":[],"model":"test"}', ?, ?, ?,
             '2026-08-11T10:03:00.000Z')`,
  ).run(
    context.contextId,
    context.envelopeId,
    HERMES_BINDING.tenantId,
    HERMES_BINDING.userId,
    HERMES_BINDING.role,
    HERMES_BINDING.deviceId,
    HERMES_BINDING.pairingId,
    context.initialContextSha256,
    context.contextSha256,
    context.providerRequestSha256,
    digest("3"),
    digest("4"),
  );
  return context;
}

function stageHermesEnvelope(
  db: DatabaseSync,
  context: ReturnType<typeof insertHermesContext>,
): void {
  db.prepare(
    `UPDATE hermes_desktop_envelopes
        SET state = 'staged', context_sha256 = ?, context_json = '{"stage":"staged"}',
            envelope_json = '{"stage":"staged","version":"task_envelope_v1"}',
            provider_request_json = '{"messages":[],"model":"test"}',
            provider_request_sha256 = ?, output_schema_sha256 = ?, messages_sha256 = ?
      WHERE envelope_id = ?`,
  ).run(
    context.contextSha256,
    context.providerRequestSha256,
    digest("3"),
    digest("4"),
    context.envelopeId,
  );
}

function insertHermesResult(
  db: DatabaseSync,
  context: {
    envelopeId: string;
    contextId: string | null;
    contextSha256: string;
    providerRequestSha256: string;
  },
  input: {
    resultId: string;
    outcome: "accepted" | "rejected" | "uncertain";
    idempotencyDigest: string;
    recordedAt?: string;
    sourceChannel?: "desktop" | "hosted_reference";
  },
): void {
  db.prepare(
    `INSERT INTO hermes_desktop_results
     (result_id, envelope_id, context_id, tenant_id, user_id, role, device_id,
      pairing_id, context_sha256, provider_request_sha256, source_channel,
      idempotency_key_sha256, input_sha256, outcome, validation_sha256,
      handoff_sha256, result_sha256, result_json, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             '{"output":"bounded"}', ?)`,
  ).run(
    input.resultId,
    context.envelopeId,
    context.contextId,
    HERMES_BINDING.tenantId,
    HERMES_BINDING.userId,
    HERMES_BINDING.role,
    HERMES_BINDING.deviceId,
    HERMES_BINDING.pairingId,
    context.contextSha256,
    context.providerRequestSha256,
    input.sourceChannel ?? "desktop",
    input.idempotencyDigest,
    digest("5"),
    input.outcome,
    digest("6"),
    digest("7"),
    digest("8"),
    input.recordedAt ?? "2026-08-11T10:04:00.000Z",
  );
}

test("0036 persists canonical Hermes parity evidence through composite bindings", async () => {
  const sql = await readFile(
    new URL("../migrations/0036_hermes_desktop_pilot.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "hermes_desktop_pairings",
    "hermes_desktop_devices",
    "hermes_desktop_envelopes",
    "hermes_desktop_contexts",
    "hermes_desktop_results",
    "hermes_desktop_events",
  ])
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  assert.doesNotMatch(sql, /hermes_desktop_submissions/);
  for (const index of [
    "idx_hermes_desktop_pairings_user_expiry",
    "idx_hermes_desktop_devices_binding_active",
    "idx_hermes_desktop_envelopes_device_state_expiry",
    "idx_hermes_desktop_results_one_accepted_handoff",
    "idx_hermes_desktop_results_idempotency_identity",
    "idx_hermes_desktop_events_tenant_created",
  ])
    assert.match(
      sql,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${index}\\b`),
    );
  for (const column of [
    "api_audience",
    "bound_issuer",
    "bound_origin",
    "connector_capabilities_json",
    "provider_request_json",
    "provider_request_sha256",
    "output_schema_sha256",
    "messages_sha256",
    "source_channel",
    "idempotency_key_sha256",
    "input_sha256",
    "validation_sha256",
    "handoff_sha256",
    "result_sha256",
    "result_json",
  ])
    assert.match(sql, new RegExp(`${column}\\s+TEXT\\s+NOT NULL`));
  assert.equal(sql.match(/provider_request_json TEXT NOT NULL/g)?.length, 2);
  assert.equal(sql.match(/provider_request_sha256 TEXT NOT NULL/g)?.length, 3);
  assert.equal(
    sql.match(/connector_capabilities_json TEXT NOT NULL/g)?.length,
    1,
  );
  assert.match(sql, /source_channel IN \('desktop', 'hosted_reference'\)/);
  assert.match(sql, /outcome IN \('accepted', 'rejected', 'uncertain'\)/);
  assert.match(sql, /event_type = 'device_revoked'/);
  assert.match(sql, /event_type = 'hosted_call_started'/);
  assert.match(sql, /WHERE outcome = 'accepted'/);
  assert.match(
    sql,
    /ON hermes_desktop_results\(tenant_id, user_id, idempotency_key_sha256\)/,
  );
  assert.match(sql, /CHECK \(access_expires_at > paired_at\)/);
  assert.doesNotMatch(
    schema,
    /FOREIGN KEY \((?:pairing_id|device_id|envelope_id|context_id|result_id)\)\s+REFERENCES hermes_desktop_/,
  );
  assert.doesNotMatch(
    schema,
    /raw_token|pairing_token|access_token\s+TEXT|device_proof\s+TEXT|idempotency_key\s+TEXT/i,
  );
  assert.doesNotMatch(
    sql,
    /\bCASE\b|ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i,
  );
});

test("0036 enforces the exact Hermes trigger contract", async () => {
  const db = await createHermesMigrationDb();
  try {
    const triggerNames = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'hermes_desktop_%'
        ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    assert.deepEqual(triggerNames, [
      "hermes_desktop_contexts_immutable_delete",
      "hermes_desktop_contexts_immutable_update",
      "hermes_desktop_devices_binding_immutable",
      "hermes_desktop_devices_revocation_monotonic",
      "hermes_desktop_envelopes_binding_immutable",
      "hermes_desktop_envelopes_state_transition",
      "hermes_desktop_events_immutable_delete",
      "hermes_desktop_events_immutable_update",
      "hermes_desktop_pairings_binding_immutable",
      "hermes_desktop_pairings_consumption_monotonic",
      "hermes_desktop_results_append_only_delete",
      "hermes_desktop_results_append_only_update",
    ]);

    insertHermesUser(db);
    insertHermesPairing(db);
    insertHermesDevice(db);
    const envelope = insertHermesEnvelope(db, "001");

    assert.throws(
      () =>
        db.exec(
          "UPDATE hermes_desktop_pairings SET bound_origin = 'https://other.example'",
        ),
      /hermes_desktop_pairing_binding_immutable/,
    );
    assert.throws(
      () =>
        db.exec(
          "UPDATE hermes_desktop_pairings SET consumed_at = NULL, consumed_device_id = NULL",
        ),
      /hermes_desktop_pairing_consumption_not_monotonic/,
    );
    assert.throws(
      () =>
        db.exec("UPDATE hermes_desktop_devices SET device_name = 'Renamed'"),
      /hermes_desktop_device_binding_immutable/,
    );
    assert.throws(
      () =>
        db.exec("UPDATE hermes_desktop_envelopes SET lead_id = 'lead:other'"),
      /hermes_desktop_envelope_binding_immutable/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE hermes_desktop_envelopes SET state = 'submitted', submitted_at = ? WHERE envelope_id = ?",
          )
          .run("2026-08-11T10:04:00.000Z", envelope.envelopeId),
      /hermes_desktop_envelope_state_transition_invalid/,
    );

    const context = insertHermesContext(db, envelope);
    stageHermesEnvelope(db, context);
    db.prepare(
      `INSERT INTO hermes_desktop_events
       (event_id, event_type, tenant_id, user_id, role, pairing_id, device_id,
        envelope_id, context_id, result_id, detail_sha256, created_at)
       VALUES ('hdevent:hosted-start', 'hosted_call_started', ?, ?, ?, ?, ?, ?, ?,
               NULL, ?, '2026-08-11T10:03:30.000Z')`,
    ).run(
      HERMES_BINDING.tenantId,
      HERMES_BINDING.userId,
      HERMES_BINDING.role,
      HERMES_BINDING.pairingId,
      HERMES_BINDING.deviceId,
      envelope.envelopeId,
      context.contextId,
      digest("b"),
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE hermes_desktop_contexts SET context_json = context_json WHERE context_id = ?",
          )
          .run(context.contextId),
      /hermes_desktop_contexts_immutable/,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM hermes_desktop_contexts WHERE context_id = ?")
          .run(context.contextId),
      /hermes_desktop_contexts_immutable/,
    );

    const acceptedAt = "2026-08-11T10:04:00.000Z";
    insertHermesResult(db, context, {
      resultId: "hdresult:accepted",
      outcome: "accepted",
      idempotencyDigest: digest("9"),
      recordedAt: acceptedAt,
    });
    assert.throws(
      () =>
        db.exec("UPDATE hermes_desktop_results SET result_json = result_json"),
      /hermes_desktop_results_append_only/,
    );
    assert.throws(
      () => db.exec("DELETE FROM hermes_desktop_results"),
      /hermes_desktop_results_append_only/,
    );
    db.prepare(
      "UPDATE hermes_desktop_envelopes SET state = 'submitted', submitted_at = ? WHERE envelope_id = ?",
    ).run(acceptedAt, envelope.envelopeId);

    db.prepare(
      `INSERT INTO hermes_desktop_events
       (event_id, event_type, tenant_id, user_id, role, pairing_id, device_id,
        envelope_id, context_id, result_id, detail_sha256, created_at)
       VALUES ('hdevent:result', 'draft_result_recorded', ?, ?, ?, ?, ?, ?, ?,
               'hdresult:accepted', ?, ?)`,
    ).run(
      HERMES_BINDING.tenantId,
      HERMES_BINDING.userId,
      HERMES_BINDING.role,
      HERMES_BINDING.pairingId,
      HERMES_BINDING.deviceId,
      envelope.envelopeId,
      context.contextId,
      digest("a"),
      acceptedAt,
    );
    assert.throws(
      () =>
        db.exec(
          "UPDATE hermes_desktop_events SET detail_sha256 = detail_sha256",
        ),
      /hermes_desktop_events_immutable/,
    );
    assert.throws(
      () => db.exec("DELETE FROM hermes_desktop_events"),
      /hermes_desktop_events_immutable/,
    );

    db.prepare(
      `UPDATE hermes_desktop_devices
          SET revoked_at = '2026-08-11T10:05:00.000Z', revoked_by_user_id = ?
        WHERE device_id = ?`,
    ).run(HERMES_BINDING.userId, HERMES_BINDING.deviceId);
    db.prepare(
      `INSERT INTO hermes_desktop_events
       (event_id, event_type, tenant_id, user_id, role, pairing_id, device_id,
        envelope_id, context_id, result_id, detail_sha256, created_at)
       VALUES ('hdevent:revoke', 'device_revoked', ?, ?, ?, ?, ?, NULL, NULL,
               NULL, ?, '2026-08-11T10:05:00.000Z')`,
    ).run(
      HERMES_BINDING.tenantId,
      HERMES_BINDING.userId,
      HERMES_BINDING.role,
      HERMES_BINDING.pairingId,
      HERMES_BINDING.deviceId,
      digest("c"),
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE hermes_desktop_devices SET revoked_at = NULL, revoked_by_user_id = NULL WHERE device_id = ?",
          )
          .run(HERMES_BINDING.deviceId),
      /hermes_desktop_device_revocation_not_monotonic/,
    );
  } finally {
    db.close();
  }
});

test("0036 rejects every cross-table Hermes binding mismatch", async () => {
  const db = await createHermesMigrationDb();
  try {
    insertHermesUser(db);
    insertHermesPairing(db);
    insertHermesDevice(db);
    insertHermesPairing(db, "hdpair:fk", digest("9"));

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO hermes_desktop_devices
         (device_id, pairing_id, tenant_id, user_id, role, api_audience,
          bound_issuer, bound_origin, connector_capabilities_json, device_name,
          device_proof_sha256, access_token_sha256, access_expires_at, paired_at,
          last_seen_at, revoked_at, revoked_by_user_id)
         VALUES ('hddev:fk', 'hdpair:fk', ?, ?, 'owner', ?, ?,
                 'https://mismatch.example', ?, 'Mismatch', ?, ?,
                 '2026-08-11T11:01:00.000Z', '2026-08-11T10:01:00.000Z',
                 NULL, NULL, NULL)`,
          )
          .run(
            HERMES_BINDING.tenantId,
            HERMES_BINDING.userId,
            HERMES_BINDING.apiAudience,
            HERMES_BINDING.boundIssuer,
            HERMES_BINDING.capabilitiesJson,
            digest("7"),
            digest("8"),
          ),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO hermes_desktop_envelopes
         (envelope_id, version, workflow, tenant_id, user_id, role, device_id,
          pairing_id, lead_id, lead_envelope_id, roof_job_id, channel,
          recipient_ref, consent_id, consent_basis, state, context_sha256,
          context_json, envelope_json, provider_request_json,
          provider_request_sha256, output_schema_sha256, messages_sha256,
          issued_at, expires_at, submitted_at)
         VALUES ('hdenv:bad-binding', 'task_envelope_v1', 'lead_follow_up_draft',
                 ?, ?, 'owner', ?, 'hdpair:fk', 'lead:bad', 'lead-env:bad', NULL,
                 'Email', 'recipient:bad', 'consent:bad', 'Express', 'issued', ?,
                 '{}', '{}', '{}', ?, ?, ?, '2026-08-11T10:02:00.000Z',
                 '2026-08-11T10:09:00.000Z', NULL)`,
          )
          .run(
            HERMES_BINDING.tenantId,
            HERMES_BINDING.userId,
            HERMES_BINDING.deviceId,
            digest("d"),
            digest("e"),
            digest("f"),
            digest("0"),
          ),
      /FOREIGN KEY constraint failed/,
    );

    const envelope = insertHermesEnvelope(db, "001");
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO hermes_desktop_contexts
         (context_id, envelope_id, tenant_id, user_id, role, device_id,
          pairing_id, prior_context_sha256, context_sha256, observations_json,
          calendar_slots_json, context_json, provider_request_json,
          provider_request_sha256, output_schema_sha256, messages_sha256, staged_at)
         VALUES ('hdctx:bad-binding', ?, ?, ?, 'owner', 'hddev:missing', ?, ?, ?,
                 '[]', '[]', '{}', '{}', ?, ?, ?,
                 '2026-08-11T10:03:00.000Z')`,
          )
          .run(
            envelope.envelopeId,
            HERMES_BINDING.tenantId,
            HERMES_BINDING.userId,
            HERMES_BINDING.pairingId,
            envelope.initialContextSha256,
            digest("f"),
            digest("1"),
            digest("2"),
            digest("3"),
          ),
      /FOREIGN KEY constraint failed/,
    );

    const context = insertHermesContext(db, envelope);
    stageHermesEnvelope(db, context);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO hermes_desktop_results
         (result_id, envelope_id, context_id, tenant_id, user_id, role,
          device_id, pairing_id, context_sha256, provider_request_sha256,
          source_channel, idempotency_key_sha256, input_sha256, outcome,
          validation_sha256, handoff_sha256, result_sha256, result_json, recorded_at)
         VALUES ('hdresult:bad-binding', ?, ?, ?, ?, 'owner', ?, ?, ?, ?,
                 'desktop', ?, ?, 'rejected', ?, ?, ?, '{}',
                 '2026-08-11T10:04:00.000Z')`,
          )
          .run(
            context.envelopeId,
            context.contextId,
            HERMES_BINDING.tenantId,
            HERMES_BINDING.userId,
            HERMES_BINDING.deviceId,
            HERMES_BINDING.pairingId,
            context.contextSha256,
            digest("0"),
            digest("4"),
            digest("5"),
            digest("6"),
            digest("7"),
            digest("8"),
          ),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("0036 serializes terminal Hermes results and preserves every attempt append-only", async () => {
  const db = await createHermesMigrationDb();
  try {
    insertHermesUser(db);
    insertHermesPairing(db);
    insertHermesDevice(db);
    const first = insertHermesContext(db, insertHermesEnvelope(db, "001"));
    stageHermesEnvelope(db, first);

    insertHermesResult(db, first, {
      resultId: "hdresult:rejected",
      outcome: "rejected",
      idempotencyDigest: digest("a"),
    });
    insertHermesResult(db, first, {
      resultId: "hdresult:uncertain",
      outcome: "uncertain",
      idempotencyDigest: digest("b"),
      sourceChannel: "hosted_reference",
    });
    insertHermesResult(db, first, {
      resultId: "hdresult:accepted",
      outcome: "accepted",
      idempotencyDigest: digest("c"),
    });
    assert.throws(
      () =>
        insertHermesResult(db, first, {
          resultId: "hdresult:accepted-race",
          outcome: "accepted",
          idempotencyDigest: digest("d"),
        }),
      /UNIQUE constraint failed: hermes_desktop_results.envelope_id/,
    );

    const second = insertHermesContext(db, insertHermesEnvelope(db, "002"));
    stageHermesEnvelope(db, second);
    assert.throws(
      () =>
        insertHermesResult(db, second, {
          resultId: "hdresult:idempotency-race",
          outcome: "rejected",
          idempotencyDigest: digest("a"),
        }),
      /UNIQUE constraint failed/,
    );

    const direct = insertHermesEnvelope(db, "003");
    const directAcceptedAt = "2026-08-11T10:04:30.000Z";
    insertHermesResult(db, direct, {
      resultId: "hdresult:direct-accepted",
      outcome: "accepted",
      idempotencyDigest: digest("e"),
      recordedAt: directAcceptedAt,
    });
    db.prepare(
      "UPDATE hermes_desktop_envelopes SET state = 'submitted', submitted_at = ? WHERE envelope_id = ?",
    ).run(directAcceptedAt, direct.envelopeId);
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT state, submitted_at FROM hermes_desktop_envelopes WHERE envelope_id = ?",
          )
          .get(direct.envelopeId),
      },
      { state: "submitted", submitted_at: directAcceptedAt },
    );
    assert.throws(
      () =>
        db.exec(
          "UPDATE hermes_desktop_results SET outcome = 'uncertain' WHERE outcome = 'rejected'",
        ),
      /hermes_desktop_results_append_only/,
    );
    assert.throws(
      () =>
        db.exec(
          "DELETE FROM hermes_desktop_results WHERE outcome = 'uncertain'",
        ),
      /hermes_desktop_results_append_only/,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT outcome, source_channel FROM hermes_desktop_results ORDER BY result_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { outcome: "accepted", source_channel: "desktop" },
        { outcome: "accepted", source_channel: "desktop" },
        { outcome: "rejected", source_channel: "desktop" },
        { outcome: "uncertain", source_channel: "hosted_reference" },
      ],
    );
  } finally {
    db.close();
  }
});

test("0038 adds effective work roles without rebuilding users or widening Facet authority", async () => {
  const sql = await readFile(
    new URL("../migrations/0038_app_access_roles.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE app_users ADD COLUMN access_role TEXT/);
  for (const role of [
    "owner",
    "ops",
    "sales",
    "admin",
    "production",
    "shop",
    "accounting",
    "field",
  ]) {
    assert.match(sql, new RegExp(`['\"]${role}['\"]`));
  }
  assert.match(sql, /idx_app_users_tenant_access_role_active/);
  assert.match(
    sql,
    /UPDATE app_users SET access_role = role WHERE access_role IS NULL/,
  );
  assert.match(sql, /actor\.access_role IN \('owner', 'ops'\)/);
  assert.doesNotMatch(sql, /COALESCE\(/);
  assert.doesNotMatch(sql, /DROP TABLE|ON DELETE CASCADE|REPLACE INTO/i);
});

test("0040 keeps Postiz execution governed, single-attempt, and append-only", async () => {
  const sql = await readFile(
    new URL("../migrations/0040_postiz_control_plane.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "postiz_intents",
    "postiz_intent_events",
    "postiz_effect_outbox",
    "postiz_reconciliation_observations",
  ])
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(sql, /drafted_by_agent_role = 'specialized_marketing_agent'/);
  assert.match(sql, /attempt_count BETWEEN 0 AND 1/);
  assert.match(sql, /postiz_effect_outbox_single_attempt/);
  assert.match(sql, /postiz_intent_events_append_only_update/);
  assert.match(sql, /postiz_intent_events_append_only_delete/);
  assert.match(sql, /postiz_reconciliation_observations_append_only_update/);
  assert.match(sql, /postiz_reconciliation_observations_append_only_delete/);
  assert.match(sql, /postiz_submission_approval_required/);
  assert.match(sql, /postiz_rejection_decision_required/);
  assert.match(sql, /postiz_intents_stop_outbox/);
  assert.match(sql, /published_observed_at TEXT/);
  assert.match(
    sql,
    /OLD\.state = 'published' AND NEW\.state IN \('published', 'reconciliation_required'\)/,
  );
  assert.match(sql, /postiz_intents_publication_evidence_guard/);
  assert.doesNotMatch(
    schema,
    /access_token|refresh_token|api_key|oauth_code|provider_body|raw_response|customer_name|customer_email|customer_phone/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("Postiz stays default-off with an exact v2.23.0 contract in every Wrangler environment", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const postizVarNames = Object.keys(config.vars)
    .filter((name) => name.startsWith("POSTIZ_"))
    .sort();
  for (const [name, environment] of [
    ["production", config.vars],
    ["local", config.env.local.vars],
    ["staging", config.env.staging.vars],
  ] as const) {
    assert.deepEqual(
      Object.keys(environment)
        .filter((key) => key.startsWith("POSTIZ_"))
        .sort(),
      postizVarNames,
      `${name} Postiz variable parity`,
    );
    assert.equal(environment.POSTIZ_ENABLED, "false");
    assert.equal(environment.POSTIZ_FACET_DRAFT_ENABLED, "false");
    assert.equal(environment.POSTIZ_FACET_DRAFT_NOT_BEFORE, "");
    assert.equal(environment.POSTIZ_EXPECTED_VERSION, "v2.23.0");
    assert.equal(environment.POSTIZ_API_BASE_URL, "");
    assert.equal(
      environment.POSTIZ_ALLOWED_PROVIDERS,
      "facebook,linkedin-page,gmb",
    );
    assert.equal("POSTIZ_API_KEY" in environment, false);
  }
});

test("0041 keeps QuickBooks OAuth encrypted and final-invoice effects governed", async () => {
  const sql = await readFile(
    new URL("../migrations/0041_quickbooks_final_invoice.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "quickbooks_oauth_states",
    "quickbooks_connections",
    "quickbooks_connection_events",
    "quickbooks_final_invoice_intents",
    "quickbooks_final_invoice_events",
    "quickbooks_final_invoice_outbox",
    "quickbooks_final_invoice_attempts",
    "quickbooks_final_invoice_observations",
    "quickbooks_final_invoice_candidate_holds",
    "quickbooks_final_invoice_command_receipts",
  ])
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(sql, /oauth_state_sha256 TEXT NOT NULL UNIQUE/);
  assert.match(sql, /currency TEXT NOT NULL CHECK \(currency = 'CAD'\)/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key_sha256\)/);
  assert.match(sql, /quickbooks_final_invoice_basis_immutable/);
  assert.match(sql, /NEW\.shop_order_id IS NOT OLD\.shop_order_id/);
  assert.match(sql, /quickbooks_final_invoice_outbox_identity_immutable/);
  assert.match(sql, /quickbooks_final_invoice_outbox_retained/);
  assert.match(sql, /quickbooks_final_invoice_provider_evidence_invalid/);
  assert.doesNotMatch(
    schema,
    /access_token|refresh_token|client_secret|customer_name|customer_email|customer_phone|street_address/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("QuickBooks final invoicing stays default-off and secret-free in every Wrangler environment", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const names = Object.keys(config.vars)
    .filter((name) => name.startsWith("QB_"))
    .sort();
  for (const [name, environment] of [
    ["production", config.vars],
    ["local", config.env.local.vars],
    ["staging", config.env.staging.vars],
  ] as const) {
    assert.deepEqual(
      Object.keys(environment)
        .filter((key) => key.startsWith("QB_"))
        .sort(),
      names,
      `${name} QB variable parity`,
    );
    assert.equal(environment.QB_OAUTH_ENABLED, "false");
    assert.equal(environment.QB_FINAL_INVOICE_ENABLED, "false");
    assert.match(environment.QB_API_ENVIRONMENT, /^(sandbox|production)$/);
    assert.equal(environment.QB_API_MINOR_VERSION, "75");
    for (const secret of [
      "QB_CLIENT_ID",
      "QB_CLIENT_SECRET",
      "QB_TOKEN_ENCRYPTION_KEY",
      "QB_FINAL_INVOICE_FRAPPE_API_KEY",
      "QB_FINAL_INVOICE_FRAPPE_API_SECRET",
    ])
      assert.equal(secret in environment, false);
  }
});

test("0043 keeps Facet v2 identity, intake, decisions, receipts, and projection evidence append-only", async () => {
  const sql = await readFile(
    new URL("../migrations/0043_facet_v2_signed_identity.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "facet_v2_producer_identity_links",
    "facet_v2_project_links",
    "facet_v2_project_launches",
    "facet_v2_link_revocations",
    "facet_v2_raw_intakes",
    "facet_v2_customer_decisions",
    "facet_v2_consumer_receipts",
    "facet_v2_projection_attempts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.match(sql, new RegExp(`BEFORE UPDATE ON ${table}\\b`));
    assert.match(sql, new RegExp(`BEFORE DELETE ON ${table}\\b`));
  }
  assert.match(sql, /event_type TEXT NOT NULL CHECK \(event_type = 'facet\.design\.customer_approved\.v2'\)/);
  assert.match(sql, /identity_assurance TEXT NOT NULL CHECK \(identity_assurance = 'oidc'\)/);
  assert.match(sql, /UNIQUE \(destination_tenant_id\)/);
  assert.doesNotMatch(
    sql.match(
      /CREATE TABLE IF NOT EXISTS facet_v2_producer_identity_links[\s\S]*?\n\);/,
    )?.[0] ?? "",
    /brand_id/,
  );
  assert.match(sql, /UNIQUE \(destination_tenant_id, facet_project_id\)/);
  assert.match(sql, /facet_v2_project_launches[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /nonce_sha256 TEXT NOT NULL UNIQUE/);
  assert.match(sql, /signature_algorithm TEXT NOT NULL CHECK \(signature_algorithm = 'HMAC-SHA256'\)/);
  assert.match(sql, /'projected_blank_draft'/);
  assert.doesNotMatch(sql, /bearer_capability_only|facet\.design\.approved\.v1/);
  assert.doesNotMatch(sql, /DROP TABLE|REPLACE INTO|ON DELETE CASCADE/i);
});

test("signed Facet v2 intake is default-off and secret-free in every Wrangler environment", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  for (const environment of [config, config.env.local, config.env.staging]) {
    assert.equal(environment.vars.FACET_V2_INGEST_ENABLED, "false");
    assert.equal(environment.vars.FACET_V2_ROUTES_JSON, "[]");
    assert.equal(environment.vars.FACET_V2_FRAPPE_PROJECTION_ENABLED, "false");
    assert.equal(environment.vars.APP_FACET_LAUNCH_ENABLED, "false");
    assert.equal(environment.vars.APP_FACET_LAUNCH_BASE_URL, "");
    assert.equal(environment.vars.APP_FACET_LAUNCH_SOURCE_TENANT_ID, "");
    assert.equal("FACET_V2_KEYS_JSON" in environment, false);
    assert.equal("FACET_V2_KEYS_JSON" in environment.vars, false);
    assert.equal("FACET_LAUNCH_HMAC_KEY" in environment, false);
    assert.equal("FACET_LAUNCH_HMAC_KEY" in environment.vars, false);
  }
});

test("0031 makes QuickBooks projection recovery leased, due-scheduled, and non-terminal by default", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0031_quickbooks_projection_outbox.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS quickbooks_projection_outbox\b/,
  );
  assert.match(sql, /PRIMARY KEY \(payload_hash, event_index\)/);
  assert.match(
    sql,
    /projection_status TEXT NOT NULL CHECK \(projection_status IN \('pending', 'projected', 'rejected'\)\)/,
  );
  assert.match(
    sql,
    /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/,
  );
  assert.match(sql, /next_attempt_at TEXT NOT NULL/);
  assert.match(sql, /escalated_at TEXT/);
  assert.match(sql, /lease_token TEXT/);
  assert.match(sql, /lease_expires_at TEXT/);
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_qb_projection_outbox_pending\b/,
  );
  assert.match(
    sql,
    /projection_status, next_attempt_at, lease_expires_at, updated_at/,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(payload_hash\) REFERENCES quickbooks_webhook_receipts\(payload_hash\) ON DELETE RESTRICT/,
  );
  assert.doesNotMatch(
    schema,
    /raw_payload|provider_amount|payment_status|customer_email/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0042 keeps external effects durable, append-only, and reconciliation-gated", async () => {
  const sql = await readFile(new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE external_effects\b/);
  assert.match(sql, /CREATE TABLE external_effect_attempts\b/);
  assert.match(sql, /CREATE TABLE external_effect_events\b/);
  assert.match(sql, /CREATE TABLE external_effect_exceptions\b/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /external_effect_attempt_binding_guard/);
  assert.match(sql, /external_effect_events_append_only_update/);
  assert.match(sql, /external_effect_exceptions_append_only_delete/);
  assert.match(sql, /OLD\.state = 'unknown' AND NEW\.state IN \('succeeded', 'reconciled', 'manual_exception'\)/);
  assert.match(sql, /OLD\.state = 'succeeded' AND NEW\.state = 'compensating'/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0047 keeps safety records additive, right-preserving, and separation-enforced", async () => {
  const sql = await readFile(
    new URL("../migrations/0047_safety_lifecycle.sql", import.meta.url),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "safety_equipment",
    "safety_equipment_events",
    "safety_occurrences",
    "safety_occurrence_events",
    "safety_notifications",
    "safety_corrective_actions",
    "safety_corrective_action_events",
    "safety_readiness_snapshots",
    "safety_device_actions",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_safety_equipment_assignment",
    "idx_safety_occurrences_scope_open",
    "idx_safety_notifications_open",
    "idx_safety_corrective_actions_open",
    "idx_safety_readiness_snapshots_scope",
    "idx_safety_device_actions_recovery",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  // Every safety event stream and every readiness snapshot refuses UPDATE and
  // DELETE: rollback may stop new automation but never erases safety evidence.
  for (const trigger of [
    "safety_equipment_events_append_only_update",
    "safety_equipment_events_append_only_delete",
    "safety_occurrence_events_append_only_update",
    "safety_occurrence_events_append_only_delete",
    "safety_corrective_action_events_append_only_update",
    "safety_corrective_action_events_append_only_delete",
    "safety_readiness_snapshots_append_only_update",
    "safety_readiness_snapshots_append_only_delete",
    "safety_equipment_append_only_delete",
    "safety_occurrences_append_only_delete",
    "safety_notifications_append_only_delete",
    "safety_corrective_actions_append_only_delete",
    "safety_device_actions_append_only_delete",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  for (const trigger of [
    "safety_equipment_identity_immutable",
    "safety_occurrences_identity_immutable",
    "safety_notifications_guard_update",
    "safety_corrective_actions_guard_update",
    "safety_device_actions_identity_immutable",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  // Authority acts name their exact roles; reporting and make-safe never do.
  assert.match(sql, /safety_inspection_authority_required/);
  assert.match(sql, /safety_rescue_authority_required/);
  assert.match(sql, /safety_release_authority_required/);
  assert.match(sql, /safety_notification_authority_required/);
  assert.match(sql, /safety_verification_authority_required/);
  assert.match(sql, /safety_verification_separation_required/);
  assert.match(sql, /safety_stop_release_not_permitted/);
  assert.match(sql, /safety_stop_reactivation_forbidden/);
  assert.match(sql, /safety_occurrence_severity_downgrade_forbidden/);
  for (const kind of [
    "reported",
    "make_safe",
    "rescue_dispatched",
    "rescue_completed",
    "investigation_opened",
    "finding_recorded",
    "controlled",
    "released",
    "closed",
  ]) {
    assert.ok(
      sql.includes(`'${kind}'`),
      `missing occurrence event kind ${kind}`,
    );
  }
  assert.match(sql, /UNIQUE \(tenant_id, report_fingerprint_sha256\)/);
  assert.match(
    sql,
    /action_kind IN \('report_occurrence', 'make_safe', 'equipment_defect', 'rescue_request'\)/,
  );
  // Physical safety events are their own aggregate; the integration incident
  // record must never be reused for a worker injury.
  assert.doesNotMatch(schema, /automation_incident/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0046 keeps offline fleet captures bounded, idempotent, and independently recoverable", async () => {
  const sql = await readFile(new URL("../migrations/0046_fleet_asset_actions.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fleet_asset_actions\b/);
  assert.match(sql, /device_action_id TEXT PRIMARY KEY/);
  assert.match(
    sql,
    /action_kind IN \('pre_trip_inspection', 'post_trip_inspection', 'defect_report'\)/,
  );
  assert.match(sql, /status IN \('processing', 'r2_stored', 'verified', 'retryable_error'\)/);
  assert.match(sql, /payload_hash TEXT NOT NULL CHECK \(\s*length\(payload_hash\) = 64/);
  assert.match(sql, /idx_fleet_asset_actions_asset_created/);
  assert.match(sql, /idx_fleet_asset_actions_recovery/);
  assert.match(sql, /REFERENCES app_users\(user_id\) ON DELETE RESTRICT/);
  // A verified receipt must always carry its response and verification time,
  // so a replay can never be answered from a half-written row.
  assert.match(sql, /status = 'verified' AND response_json IS NOT NULL AND verified_at IS NOT NULL/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("the complete D1 migration chain applies cleanly and carries every schedule-ledger invariant", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    // The chain starts at 0001 and is unique and increasing, but it is not contiguous: the
    // service lane takes 0056 and the IRO-62 forward repair takes 0057, each above every number
    // in flight on an open head when it was numbered. #54 kept 0046 and #48 kept 0047, both of
    // which landed on `main`, so the gap from 0048 to 0055 is expected and not a missing
    // migration.
    assert.equal(migrations.length, 49);
    assert.equal(migrations[0], "0001_init.sql");
    assert.equal(
      migrations.at(-1),
      "0057_work_package_completion_action_kind.sql",
    );
    for (const migration of migrations) {
      if (migration === "0038_app_access_roles.sql") {
        db.prepare(
          `INSERT INTO app_users
            (user_id, tenant_id, email_normalized, display_name, role, active,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
        ).run(
          "appu_legacy_ops_0001",
          "ironwrap",
          "legacy-ops@example.com",
          "Legacy Operations",
          "owner@example.com",
          "2026-08-13T11:59:00.000Z",
          "2026-08-13T11:59:00.000Z",
        );
      }
      db.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }

    assert.equal(
      (
        db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        }
      ).integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const counts = db
      .prepare(
        `SELECT
         SUM(type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
         SUM(type = 'index' AND name LIKE 'idx_%') AS indexes,
         SUM(type = 'trigger') AS triggers
       FROM sqlite_master`,
      )
      .get() as { tables: number; indexes: number; triggers: number };
    assert.deepEqual({ ...counts }, { tables: 104, indexes: 148, triggers: 219 });
    // The applied chain — not the text of any single file — is what production
    // ends up running, so the complete_work receipt kind is asserted here.
    // 0028 is frozen at its shipped three-member CHECK and 0057 widens it
    // forward (Linear IRO-62).
    assert.match(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'field_work_package_actions'",
          )
          .get() as { sql: string }
      ).sql,
      /action_kind IN \('acknowledge', 'stop_work', 'start_work', 'complete_work'\)/,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_dead_letter_open_measurement'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    const fieldActionColumns = db
      .prepare("PRAGMA table_info(field_actions)")
      .all() as Array<{ name: string }>;
    for (const name of [
      "work_package_id",
      "work_package_version",
      "evidence_slot_id",
      "evidence_requirement",
      "evidence_source",
      "evidence_device_id",
      "evidence_freshness",
      "evidence_conflict_state",
      "evidence_verification",
      "evidence_disposition",
      "evidence_correction_of",
      "evidence_item_correction_of",
      "work_package_release_attempt_id",
      "correction_reason",
    ]) {
      assert.equal(
        fieldActionColumns.some((column) => column.name === name),
        true,
        `missing ${name}`,
      );
    }
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_field_actions_work_package_evidence'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    const workPackageBindingTriggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'field_actions_work_package_binding_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      workPackageBindingTriggers.map(({ name }) => name),
      [
        "field_actions_work_package_binding_guard",
        "field_actions_work_package_binding_shape",
      ],
    );

    const fieldActionBase = {
      tenant_id: "ironwrap",
      user_id: "appu_legacy_ops_0001",
      job_id: "JOB-A",
      assignment_id: "ASSIGN-A",
      action_kind: "field_checkin",
      payload_hash: "a".repeat(64),
      status: "processing",
      checkin_id: "fci_0044-valid-0001",
      created_at: "2026-08-17T10:00:00.000Z",
      updated_at: "2026-08-17T10:00:00.000Z",
    };
    const insertFieldAction = (
      deviceActionId: string,
      typed: Record<string, unknown> = {},
    ) =>
      db
        .prepare(
          `INSERT INTO field_actions
          (device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind,
           payload_hash, status, checkin_id, created_at, updated_at,
           work_package_id, work_package_version, evidence_slot_id, evidence_requirement,
           evidence_source, evidence_device_id, evidence_freshness, evidence_conflict_state,
           evidence_verification, evidence_disposition, evidence_correction_of,
           evidence_item_correction_of, work_package_release_attempt_id, correction_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deviceActionId,
          fieldActionBase.tenant_id,
          fieldActionBase.user_id,
          fieldActionBase.job_id,
          fieldActionBase.assignment_id,
          fieldActionBase.action_kind,
          fieldActionBase.payload_hash,
          fieldActionBase.status,
          fieldActionBase.checkin_id,
          fieldActionBase.created_at,
          fieldActionBase.updated_at,
          typed.work_package_id ?? null,
          typed.work_package_version ?? null,
          typed.evidence_slot_id ?? null,
          typed.evidence_requirement ?? null,
          typed.evidence_source ?? null,
          typed.evidence_device_id ?? null,
          typed.evidence_freshness ?? null,
          typed.evidence_conflict_state ?? null,
          typed.evidence_verification ?? null,
          typed.evidence_disposition ?? null,
          typed.evidence_correction_of ?? null,
          typed.evidence_item_correction_of ?? null,
          typed.work_package_release_attempt_id ?? null,
          typed.correction_reason ?? null,
        );
    assert.throws(
      () =>
        insertFieldAction("field-action-0044-bad", { work_package_id: "WP-1" }),
      /field_action_work_package_binding_invalid/,
    );
    assert.throws(
      () =>
        insertFieldAction("field-action-0044-orphan", {
          evidence_source: "field-companion",
        }),
      /field_action_work_package_binding_invalid/,
    );
    insertFieldAction("field-action-0044-good", {
      work_package_id: "WP-1",
      work_package_version: 4,
      evidence_slot_id: "step:1",
      evidence_requirement: "Anchor photo",
      evidence_source: "field-companion",
      evidence_device_id: "paired-device-1",
      evidence_freshness: "Current",
      evidence_conflict_state: "None",
      evidence_verification: "Verified",
      evidence_disposition: "Open",
      work_package_release_attempt_id: "attempt-0044",
    });
    insertFieldAction("field-action-0044-ordinary-correction", {
      correction_reason:
        "The original check-in was corrected after a fresh field review.",
    });
    assert.throws(
      () =>
        insertFieldAction("field-action-0044-forged-lifecycle", {
          work_package_id: "WP-1",
          work_package_version: 4,
          evidence_slot_id: "step:1",
          evidence_requirement: "Anchor photo",
          evidence_source: "field-companion",
          evidence_device_id: "paired-device-1",
          evidence_freshness: "Current",
          evidence_conflict_state: "None",
          evidence_verification: "Pending",
          evidence_disposition: "Accepted",
          work_package_release_attempt_id: "attempt-0044",
        }),
      /field_action_work_package_binding_invalid/,
    );
    assert.throws(
      () =>
        insertFieldAction("field-action-0044-partial-correction", {
          work_package_id: "WP-1",
          work_package_version: 4,
          evidence_slot_id: "step:1",
          evidence_requirement: "Anchor photo",
          evidence_source: "field-companion",
          evidence_device_id: "paired-device-1",
          evidence_freshness: "Current",
          evidence_conflict_state: "None",
          evidence_verification: "Verified",
          evidence_disposition: "Open",
          work_package_release_attempt_id: "attempt-0044",
          evidence_correction_of: "event-0044",
        }),
      /field_action_work_package_binding_invalid/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE field_actions SET evidence_slot_id = 'step:2' WHERE device_action_id = ?",
          )
          .run("field-action-0044-good"),
      /field_action_work_package_binding_immutable/,
    );

    const appUserColumns = db
      .prepare("PRAGMA table_info(app_users)")
      .all() as Array<{
      name: string;
    }>;
    assert.equal(
      appUserColumns.some(({ name }) => name === "access_role"),
      true,
    );
    assert.deepEqual(
      {
        ...(db
          .prepare("SELECT role, access_role FROM app_users WHERE user_id = ?")
          .get("appu_legacy_ops_0001") as {
          role: string;
          access_role: string;
        }),
      },
      { role: "ops", access_role: "ops" },
    );
    db.prepare(
      `INSERT INTO app_users
        (user_id, tenant_id, email_normalized, display_name, role, access_role, active,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ops', 'sales', 1, ?, ?, ?)`,
    ).run(
      "appu_sales_0001",
      "ironwrap",
      "sales@example.com",
      "Sales Desk",
      "owner@example.com",
      "2026-08-13T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    );
    assert.equal(
      (
        db
          .prepare("SELECT role, access_role FROM app_users WHERE user_id = ?")
          .get("appu_sales_0001") as { role: string; access_role: string }
      ).role,
      "ops",
    );
    assert.equal(
      (
        db
          .prepare("SELECT access_role FROM app_users WHERE user_id = ?")
          .get("appu_sales_0001") as { access_role: string }
      ).access_role,
      "sales",
    );
    const facetAssociationTrigger = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get("facet_design_evidence_associations_validate_insert") as {
      sql: string;
    };
    assert.match(
      facetAssociationTrigger.sql,
      /actor\.access_role IN \('owner', 'ops'\)/,
    );

    const quickBooksOutboxColumns = db
      .prepare("PRAGMA table_info(quickbooks_projection_outbox)")
      .all() as Array<{ name: string; pk: number }>;
    for (const name of [
      "payload_hash",
      "event_index",
      "realm_id",
      "entity_type",
      "entity_id",
      "operation",
      "projection_status",
      "attempt_count",
      "next_attempt_at",
      "escalated_at",
      "lease_token",
      "lease_expires_at",
      "projected_at",
    ]) {
      assert.equal(
        quickBooksOutboxColumns.some((column) => column.name === name),
        true,
        `missing ${name}`,
      );
    }
    assert.equal(
      quickBooksOutboxColumns.find(({ name }) => name === "payload_hash")?.pk,
      1,
    );
    assert.equal(
      quickBooksOutboxColumns.find(({ name }) => name === "event_index")?.pk,
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_qb_projection_outbox_pending'",
        )
        .get() !== undefined,
      true,
    );

    const newoTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'newo_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      newoTables.map(({ name }) => name),
      [
        "newo_control_actions",
        "newo_event_receipts",
        "newo_reconciliation_runs",
        "newo_sessions",
        "newo_slot_reservations",
      ],
    );
    const receiptColumns = db
      .prepare("PRAGMA table_info(newo_event_receipts)")
      .all() as Array<{
      name: string;
      pk: number;
    }>;
    assert.equal(receiptColumns.find(({ name }) => name === "event_id")?.pk, 1);
    assert.equal(
      receiptColumns.some(({ name }) =>
        /transcript|recording|payload_json/.test(name),
      ),
      false,
    );
    const controlColumns = db
      .prepare("PRAGMA table_info(newo_control_actions)")
      .all() as Array<{
      name: string;
    }>;
    for (const name of [
      "approval_reason",
      "dry_run_expires_at",
      "approval_expires_at",
      "result_json",
      "consumed_at",
    ]) {
      assert.equal(
        controlColumns.some((column) => column.name === name),
        true,
        `missing ${name}`,
      );
    }
    const sessionColumns = db
      .prepare("PRAGMA table_info(newo_sessions)")
      .all() as Array<{ name: string }>;
    for (const name of [
      "report_expected_at",
      "report_received_at",
      "report_event_id",
      "missing_report_detected_at",
      "sync_updated_at",
    ]) {
      assert.equal(
        sessionColumns.some((column) => column.name === name),
        true,
        `missing ${name}`,
      );
    }
    const reconciliationColumns = db
      .prepare("PRAGMA table_info(newo_reconciliation_runs)")
      .all() as Array<{
      name: string;
    }>;
    for (const name of [
      "run_type",
      "status",
      "missing_reports",
      "unresolved_incidents",
      "drift_reasons_json",
      "usage_status",
      "usage_minutes",
      "usage_limit_minutes",
    ]) {
      assert.equal(
        reconciliationColumns.some((column) => column.name === name),
        true,
        `missing ${name}`,
      );
    }

    const scheduleTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'production_schedule_approval_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      scheduleTables.map(({ name }) => name),
      [
        "production_schedule_approval_request_events",
        "production_schedule_approval_requests",
      ],
    );
    const scheduleIndexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_production_schedule_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      scheduleIndexes.map(({ name }) => name),
      [
        "idx_production_schedule_approval_events_tenant_created",
        "idx_production_schedule_approvals_active_target",
        "idx_production_schedule_approvals_pending_expiry",
        "idx_production_schedule_approvals_state_lease",
        "idx_production_schedule_approvals_tenant_state_updated",
      ],
    );
    const scheduleTriggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%production_schedule_approval%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      scheduleTriggers.map(({ name }) => name),
      [
        "append_production_schedule_approval_created_event",
        "append_production_schedule_approval_reconciliation_event",
        "append_production_schedule_approval_transition_event",
        "enforce_production_schedule_approval_reconciliation",
        "enforce_production_schedule_approval_transition",
        "prevent_production_schedule_approval_binding_rewrite",
        "prevent_production_schedule_approval_delete",
        "prevent_production_schedule_approval_event_delete",
        "prevent_production_schedule_approval_event_update",
      ],
    );
  } finally {
    db.close();
  }
});

test("0032 keeps Facet projection outcomes append-only, anchored, and commercially inert", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0032_facet_design_frappe_projection.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS facet_design_projection_attempts\b/,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(event_id\) REFERENCES facet_design_events\(event_id\) ON DELETE RESTRICT/,
  );
  assert.match(sql, /idx_facet_design_projection_one_success/);
  assert.match(sql, /idx_facet_design_projection_one_frappe_rejection/);
  assert.match(sql, /facet_design_projection_attempts_append_only_update/);
  assert.match(sql, /facet_design_projection_attempts_append_only_delete/);
  for (const field of [
    "tenant_id",
    "facet_project_id",
    "design_revision_id",
    "design_revision_sha256",
    "frozen_evidence_sha256",
    "raw_key",
    "raw_sha256",
    "association_sha256",
  ])
    assert.match(sql, new RegExp(`${field}\\s+TEXT`));
  assert.doesNotMatch(
    schema,
    /price|amount|contract_acceptance|proposal_evidence_pack|customer_name|address/i,
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0056 keeps the service lifecycle versioned, human-authored, append-only, and provider-free", async () => {
  const sql = await readFile(new URL("../migrations/0056_service_case_lifecycle.sql", import.meta.url), "utf8");
  const schema = sql.replace(/^--.*$/gm, "");
  for (const table of [
    "service_cases",
    "service_case_events",
    "service_case_triage",
    "service_case_diagnoses",
    "service_case_remedies",
    "service_cost_recovery_claims",
    "service_cost_recovery_events",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));

  // The complaint binds the whole subject: customer, property, job, asset, warranty, and the
  // consent that authorizes contacting the customer at all.
  for (const field of [
    "customer_id", "property_key", "roof_job_id", "asset_ref", "warranty_packet_id",
    "origin_work_package_ref", "consent_ref", "intake_evidence_digest", "response_due_at",
  ]) assert.match(sql, new RegExp(`${field}\\s+TEXT`));

  // No model-only final authority: the triage authority column admits exactly one value.
  assert.match(sql, /authority_kind TEXT NOT NULL CHECK \(authority_kind = 'human'\)/);
  assert.match(sql, /decided_by_user_id TEXT NOT NULL/);
  assert.match(sql, /advisory_source TEXT NOT NULL CHECK \(advisory_source IN \('model', 'rule', 'none'\)\)/);
  assert.match(sql, /final_category != 'unknown' OR responsibility = 'undetermined'/);

  // Every case step is one version step by a named actor, and history is never rewritten.
  assert.match(sql, /SELECT RAISE\(ABORT, 'service_case_version_step_required'\)\s+WHERE/);
  assert.match(sql, /SELECT RAISE\(ABORT, 'service_case_transition_not_allowed'\)\s+WHERE/);
  assert.match(sql, /SELECT RAISE\(ABORT, 'service_case_reopen_must_preserve_history'\)\s+WHERE/);
  for (const guard of [
    "service_cases_append_only",
    "service_case_events_append_only",
    "service_case_events_immutable",
    "service_case_triage_immutable",
    "service_case_diagnoses_immutable",
    "service_cost_recovery_events_immutable",
  ]) assert.match(sql, new RegExp(`RAISE\\(ABORT, '${guard}'\\)`));

  // Remedy work is only ever issued as a governed Work Package, and only off an actionable triage.
  assert.match(sql, /work_package_ref TEXT NOT NULL/);
  assert.match(sql, /service_case_diagnosis_requires_actionable_triage/);

  // Cost recovery carries the canonical one-attempt effect shape.
  assert.match(sql, /state IN \('pending', 'leased', 'succeeded', 'failed', 'uncertain', 'reconciled'\)/);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count BETWEEN 0 AND 1\)/);
  assert.match(sql, /service_cost_recovery_invalid_uncertain_transition/);
  assert.match(sql, /service_cost_recovery_responsibility_required/);

  // The spine stores bounded codes, references, and digests: never customer content or secrets.
  assert.doesNotMatch(schema, /contact_email|phone_number|address_line|photo|transcript|recording|payload_json|access_token/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0057 widens the work-package receipt kinds forward without editing the shipped 0028", async () => {
  const sql = await readFile(
    new URL(
      "../migrations/0057_work_package_completion_action_kind.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // A CHECK cannot be altered in place in SQLite, so this migration is a
  // bounded copy-preserving rebuild of one table: staging copy, drop, recreate
  // with the shipped DDL plus complete_work, copy back, recreate both indexes
  // under their original names. Every one of those steps is asserted so the
  // rebuild can never silently lose the copy-back or an index.
  assert.match(
    sql,
    /CREATE TABLE _mig0057_field_work_package_actions_staging\b/,
  );
  assert.match(
    sql,
    /INSERT INTO _mig0057_field_work_package_actions_staging[\s\S]*FROM field_work_package_actions;/,
  );
  assert.match(sql, /DROP TABLE field_work_package_actions;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS field_work_package_actions\b/);
  assert.match(
    sql,
    /action_kind TEXT NOT NULL CHECK \(action_kind IN \('acknowledge', 'stop_work', 'start_work', 'complete_work'\)\)/,
  );
  assert.match(
    sql,
    /INSERT INTO field_work_package_actions[\s\S]*FROM _mig0057_field_work_package_actions_staging;/,
  );
  assert.match(
    sql,
    /DROP TABLE _mig0057_field_work_package_actions_staging;/,
  );
  assert.match(sql, /idx_field_work_package_actions_job_created/);
  assert.match(sql, /idx_field_work_package_actions_recovery/);
  assert.match(sql, /REFERENCES app_users\(user_id\) ON DELETE RESTRICT/);
  // The rebuild is the only DROP TABLE this migration is allowed to perform.
  assert.equal(sql.match(/DROP TABLE/g)?.length, 2);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|REPLACE INTO/i);
});

test("a database that already applied the shipped 0028 reaches complete_work through 0057 with every row intact", async () => {
  // This is the production starting state: 0028 was applied on 2026-08-13 in its
  // original three-member form, wrangler keys the ledger by filename, and rows
  // exist. The test proves the receipt kind is rejected before the forward
  // migration and accepted after it, with no row lost in the rebuild.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    const shippedIndex = migrations.indexOf("0028_work_package_actions.sql");
    assert.notEqual(shippedIndex, -1);

    const seedOperator = () =>
      db
        .prepare(
          `INSERT OR IGNORE INTO app_users
            (user_id, tenant_id, email_normalized, display_name, role, active,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
        )
        .run(
          "appu_legacy_ops_0001",
          "ironwrap",
          "legacy-ops@example.com",
          "Legacy Operations",
          "owner@example.com",
          "2026-08-13T11:59:00.000Z",
          "2026-08-13T11:59:00.000Z",
        );

    const apply = async (name: string) => {
      if (name === "0038_app_access_roles.sql") seedOperator();
      db.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    };

    for (const name of migrations.slice(0, shippedIndex + 1)) await apply(name);
    seedOperator();

    const insertReceipt = (deviceActionId: string, kind: string) =>
      db
        .prepare(
          `INSERT INTO field_work_package_actions
            (device_action_id, tenant_id, user_id, job_id, assignment_id,
             work_package_id, action_kind, payload_hash, status,
             created_at, updated_at)
           VALUES (?, 'ironwrap', 'appu_legacy_ops_0001', 'JOB-A', 'ASSIGN-A',
                   'WP-A', ?, ?, 'processing', ?, ?)`,
        )
        .run(
          deviceActionId,
          kind,
          "a".repeat(64),
          "2026-08-13T12:00:00.000Z",
          "2026-08-13T12:00:00.000Z",
        );

    for (const [index, kind] of [
      "acknowledge",
      "start_work",
      "stop_work",
    ].entries()) {
      insertReceipt(`dact_shipped_000${index + 1}`, kind);
    }
    const rowsBefore = (
      db
        .prepare("SELECT COUNT(*) AS count FROM field_work_package_actions")
        .get() as { count: number }
    ).count;
    assert.equal(rowsBefore, 3);

    // The live defect: production cannot record a work-package completion.
    assert.throws(
      () => insertReceipt("dact_shipped_complete_pre", "complete_work"),
      /CHECK constraint failed/,
    );

    for (const name of migrations.slice(shippedIndex + 1)) await apply(name);

    const rowsAfter = (
      db
        .prepare("SELECT COUNT(*) AS count FROM field_work_package_actions")
        .get() as { count: number }
    ).count;
    assert.equal(rowsAfter, rowsBefore);
    assert.deepEqual(
      (
        db
          .prepare(
            "SELECT device_action_id, action_kind FROM field_work_package_actions ORDER BY device_action_id",
          )
          .all() as Array<{ device_action_id: string; action_kind: string }>
      ).map(({ device_action_id, action_kind }) => `${device_action_id}:${action_kind}`),
      [
        "dact_shipped_0001:acknowledge",
        "dact_shipped_0002:start_work",
        "dact_shipped_0003:stop_work",
      ],
    );

    insertReceipt("dact_shipped_complete_post", "complete_work");
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM field_work_package_actions WHERE action_kind = 'complete_work'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    // Widening is bounded: it admits complete_work and nothing else.
    assert.throws(
      () => insertReceipt("dact_shipped_bogus_0001", "field_checkin"),
      /CHECK constraint failed/,
    );

    // The rebuild keeps both named indexes, which the D1 backup and restore
    // inventories in deploy/ require by name.
    assert.deepEqual(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'index' AND tbl_name = 'field_work_package_actions'
                AND name LIKE 'idx_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
      [
        "idx_field_work_package_actions_job_created",
        "idx_field_work_package_actions_recovery",
      ],
    );
    assert.equal(
      (
        db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        }
      ).integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
