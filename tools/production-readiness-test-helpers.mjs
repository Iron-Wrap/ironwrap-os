import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEFAULT_REPO_ROOT,
  renderHuman,
  validateContract,
  validateLiveEnv,
} from "./production-readiness.mjs";

export const TOOL = path.join(DEFAULT_REPO_ROOT, "tools/production-readiness.mjs");
export const HOST_PREFLIGHT = path.join(DEFAULT_REPO_ROOT, "deploy/host-preflight.sh");
export const BACKUP = path.join(DEFAULT_REPO_ROOT, "deploy/backup-to-r2.sh");
export const RESTORE = path.join(DEFAULT_REPO_ROOT, "deploy/restore-from-r2.sh");
export const D1_BACKUP = path.join(DEFAULT_REPO_ROOT, "deploy/backup-d1-to-r2.sh");
export const D1_RESTORE = path.join(DEFAULT_REPO_ROOT, "deploy/restore-d1-from-r2.sh");
export const BUILD = path.join(DEFAULT_REPO_ROOT, "deploy/build-production-image.sh");
export const D1_BACKUP_CONTRACT = await readFile(D1_BACKUP, "utf8");
export const HERMES_DESKTOP_MIGRATION = await readFile(
  path.join(DEFAULT_REPO_ROOT, "workers-bus/migrations/0036_hermes_desktop_pilot.sql"),
  "utf8",
);
export const APPROVAL_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({
  type: "spki",
  format: "pem",
});

export function validApprovalPublicKeyOptions() {
  return {
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => APPROVAL_PUBLIC_KEY,
  };
}

export async function writeApprovalPublicKeyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-approval-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "approval-public.pem");
  await writeFile(file, APPROVAL_PUBLIC_KEY, { mode: 0o600 });
  return file;
}

export async function writeExecutable(file, source) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

export async function mockBackupEnvironment(t, { failCopy = false, signalCopy = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-backup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await Promise.all([mkdir(bin), mkdir(state)]);

  await writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  inspect) exit 0 ;;
  exec)
    if [[ "\${3:-}" == "find" ]]; then
      if [[ -f "$MOCK_STATE/created" ]]; then
        printf '%s\\n' \\
          '20260710_120000-os_ironwrapexteriors_com-database.sql.gz' \\
          '20260710_120000-os_ironwrapexteriors_com-files.tar' \\
          '20260710_120000-os_ironwrapexteriors_com-private-files.tar' \\
          '20260710_120000-os_ironwrapexteriors_com-site_config_backup.json'
      fi
    elif [[ "\${3:-}" == "bench" ]]; then
      : > "$MOCK_STATE/created"
    else
      exit 2
    fi
    ;;
  cp)
    source_path="\${2:-}"
    destination="\${@: -1}"
    [[ "\${source_path##*/}" == "\${destination##*/}" ]] || exit 2
    mkdir -p "\${destination%/*}"
    printf 'backup-data\\n' > "$destination"
    ;;
  *) exit 2 ;;
esac
`);
  await writeExecutable(path.join(bin, "age"), `#!/usr/bin/env bash
set -euo pipefail
output=''
input=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --recipient) shift 2 ;;
    --encrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
cp "$input" "$output"
`);
  await writeExecutable(path.join(bin, "tar"), `#!/usr/bin/env bash
set -euo pipefail
output=''
while (( $# > 0 )); do
  if [[ "$1" == '--file' ]]; then output="$2"; shift 2; else shift; fi
done
printf 'mock-archive\\n' > "$output"
`);
  await writeExecutable(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(path.join(bin, "rclone"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${1:-}" >> "$MOCK_STATE/rclone.log"
if [[ "\${1:-}" == 'copy' && "\${MOCK_FAIL_COPY:-0}" == '1' ]]; then exit 9; fi
if [[ "\${1:-}" == 'copy' && "\${MOCK_SIGNAL_COPY:-0}" == '1' ]]; then kill -TERM "$PPID"; fi
exit 0
`);

  return {
    root,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      MOCK_STATE: state,
      MOCK_FAIL_COPY: failCopy ? "1" : "0",
      MOCK_SIGNAL_COPY: signalCopy ? "1" : "0",
      FRAPPE_SITE: "os.ironwrapexteriors.com",
      BACKEND_CONTAINER: "frappe-backend-1",
      R2_BACKUP_BUCKET: "ironwrap-backups-prod",
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "r2_access_31a68f02",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "r2_secret_97c63bd012ab45f6a1e8029f",
      RCLONE_CONFIG_R2_ENDPOINT: "https://a1b2c3d4.r2.cloudflarestorage.com",
      BACKUP_AGE_RECIPIENT: `age1${"q".repeat(58)}`,
      IRONWRAP_OS_IMAGE: `registry.ironwrap.internal/ironwrap-os:v1@sha256:${"a".repeat(64)}`,
      BACKUP_RETENTION_DAYS: "30",
    },
  };
}

export async function mockRestoreEnvironment(t, {
  badChecksum = false,
  manifestSite = "os.ironwrapexteriors.com",
  archiveLink = false,
  failRestore = false,
  markerPresent = true,
  targetImageMismatch = false,
  targetNetworkInternal = true,
  targetPortsPublished = false,
  targetRootReady = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-restore-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const remote = path.join(root, "remote");
  const source = path.join(root, "source");
  await Promise.all([mkdir(bin), mkdir(state), mkdir(remote), mkdir(source)]);

  const stamp = "20260710T120000Z";
  const prefix = "20260710_120000-os_ironwrapexteriors_com";
  const image = `registry.ironwrap.internal/ironwrap-os:v1@sha256:${"a".repeat(64)}`;
  const names = {
    database: `${prefix}-database.sql.gz`,
    siteConfig: `${prefix}-site_config_backup.json`,
    publicFiles: `${prefix}-files.tar`,
    privateFiles: `${prefix}-private-files.tar`,
  };
  await writeFile(path.join(source, names.database), "database-backup\n");
  await writeFile(path.join(source, names.siteConfig), `${JSON.stringify({
    db_name: "production_db",
    encryption_key: "FrappeBackupEncryptionKey_20260710_Stable",
  })}\n`);
  await writeFile(path.join(source, names.publicFiles), "public-file-backup\n");
  await writeFile(path.join(source, names.privateFiles), "private-file-backup\n");
  await writeFile(path.join(source, "IRONWRAP-BACKUP-MANIFEST.txt"), [
    "schema_version=1",
    `created_utc=${stamp}`,
    `site=${manifestSite}`,
    "format=frappe-v15-bench-backup",
    "encrypted=true",
    `image=${image}`,
    `database_file=${names.database}`,
    `site_config_file=${names.siteConfig}`,
    `public_files_file=${names.publicFiles}`,
    `private_files_file=${names.privateFiles}`,
    "",
  ].join("\n"));
  const archiveEntries = ["IRONWRAP-BACKUP-MANIFEST.txt", names.database, names.siteConfig, names.publicFiles, names.privateFiles];
  if (archiveLink) {
    await rm(path.join(source, names.publicFiles));
    await symlink(names.database, path.join(source, names.publicFiles));
  }
  const archiveName = `ironwrap-os.ironwrapexteriors.com-${stamp}.tar.gz.age`;
  const archivePath = path.join(remote, archiveName);
  const tarRun = spawnSync("tar", ["-czf", archivePath, "-C", source, ...archiveEntries], { encoding: "utf8" });
  assert.equal(tarRun.status, 0, tarRun.stderr);
  const archiveBytes = await readFile(archivePath);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  await writeFile(path.join(remote, `${archiveName}.sha256`), `${badChecksum ? "b".repeat(64) : digest}  ${archiveName}\n`);
  if (markerPresent) {
    await writeFile(path.join(remote, "IRONWRAP-BACKUP-COMPLETE"), [
      "schema_version=1",
      `created_utc=${stamp}`,
      `archive=${archiveName}`,
      `checksum=${archiveName}.sha256`,
      "",
    ].join("\n"));
  }
  const identity = path.join(root, "age-identity.txt");
  await writeFile(identity, "AGE-SECRET-KEY-MOCK\n", { mode: 0o600 });
  await chmod(identity, 0o600);

  await writeExecutable(path.join(bin, "rclone"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${1:-}" >> "$MOCK_STATE/rclone.log"
case "\${1:-}" in
  cat)
    file="\${2##*/}"
    [[ -f "$MOCK_REMOTE/$file" ]] || exit 4
    /bin/cat "$MOCK_REMOTE/$file"
    ;;
  copyto)
    file="\${2##*/}"
    [[ -f "$MOCK_REMOTE/$file" ]] || exit 4
    /bin/cp "$MOCK_REMOTE/$file" "$3"
    ;;
  *) exit 2 ;;
esac
`);
  await writeExecutable(path.join(bin, "age"), `#!/usr/bin/env bash
set -euo pipefail
printf 'decrypt\n' >> "$MOCK_STATE/age.log"
output=''
input=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --identity) shift 2 ;;
    --decrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
/bin/cp "$input" "$output"
`);
  await writeExecutable(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_STATE/docker.log"
case "\${1:-}" in
  inspect)
    if [[ "\${2:-}" == '--format' && "\${3:-}" == *'restore-target'* ]]; then
      printf 'true\n'
    elif [[ "\${2:-}" == '--format' && "\${3:-}" == *'Config.Image'* ]]; then
      printf '%s\n' "$MOCK_TARGET_IMAGE"
    elif [[ "\${2:-}" == '--format' && "\${3:-}" == *'NetworkSettings.Networks'* ]]; then
      printf '{"restore_internal":{}}\n'
    fi
    ;;
  network)
    [[ "\${2:-}" == 'inspect' ]] || exit 2
    printf '%s\n' "$MOCK_TARGET_NETWORK_INTERNAL"
    ;;
  port)
    if [[ "$MOCK_TARGET_PORTS_PUBLISHED" == '1' ]]; then
      printf '8080/tcp -> 0.0.0.0:18080\n'
    fi
    ;;
  exec)
    shift 2
    case "\${1:-}" in
      test) exit 0 ;;
      python3)
        if [[ "$*" == *'root-ready'* ]]; then
          printf '%s\n' "$MOCK_TARGET_CONFIG_STATUS"
        elif [[ "$*" == *'encryption_key'* ]]; then
          exit 0
        else
          exit 2
        fi
        ;;
      mktemp) printf '/tmp/ironwrap-restore.Mock1234\n' ;;
      rm) exit 0 ;;
      bench)
        if [[ "$*" == *' restore '* && "\${MOCK_FAIL_RESTORE:-0}" == '1' ]]; then exit 19; fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  cp) exit 0 ;;
  *) exit 2 ;;
esac
`);

  return {
    root,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      MOCK_STATE: state,
      MOCK_REMOTE: remote,
      MOCK_FAIL_RESTORE: failRestore ? "1" : "0",
      MOCK_TARGET_IMAGE: targetImageMismatch ? `registry.ironwrap.internal/ironwrap-os:v2@sha256:${"b".repeat(64)}` : image,
      MOCK_TARGET_NETWORK_INTERNAL: targetNetworkInternal ? "true" : "false",
      MOCK_TARGET_PORTS_PUBLISHED: targetPortsPublished ? "1" : "0",
      MOCK_TARGET_CONFIG_STATUS: `restore_drill_db|${targetRootReady ? "root-ready" : "root-missing"}`,
      FRAPPE_SITE: "os.ironwrapexteriors.com",
      BACKEND_CONTAINER: "frappe-backend-1",
      R2_BACKUP_BUCKET: "ironwrap-backups-prod",
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "r2_access_31a68f02",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "r2_secret_97c63bd012ab45f6a1e8029f",
      RCLONE_CONFIG_R2_ENDPOINT: "https://a1b2c3d4.r2.cloudflarestorage.com",
      IRONWRAP_OS_IMAGE: image,
      RESTORE_R2_COMPLETED_PREFIX: "os.ironwrapexteriors.com/20260710T120000Z-1234-5678",
      RESTORE_AGE_IDENTITY_FILE: identity,
      RESTORE_TARGET_SITE: "restore-drill.ironwrap.invalid",
      RESTORE_TARGET_CONTAINER: "frappe-restore-drill-1",
      RESTORE_CONFIRMATION: "",
    },
  };
}

export async function stageD1Script(root, source) {
  const deploy = path.join(root, "deploy");
  const workerBin = path.join(root, "workers-bus/node_modules/.bin");
  await mkdir(deploy, { recursive: true });
  await mkdir(workerBin, { recursive: true });
  const target = path.join(deploy, path.basename(source));
  await cp(source, target);
  await chmod(target, 0o755);
  await writeFile(path.join(root, "workers-bus/package-lock.json"), `${JSON.stringify({
    packages: { "node_modules/wrangler": { version: "4.110.0" } },
  })}\n`);
  return { target, workerBin };
}

export const BASE_REQUIRED_D1_TABLES = [
  "app_action_throttles", "app_auth_audit", "app_auth_throttles", "app_device_pairings",
  "app_devices", "app_magic_links", "app_sessions", "app_users", "approval_request_events",
  "approval_requests", "audit_log", "authority_record_actions", "authority_record_readbacks",
  "customer_portal_acceptance_challenges",
  "customer_portal_acceptance_events", "customer_portal_acceptance_intents",
  "customer_portal_access_throttles", "customer_portal_links", "dead_letter", "dedup_claims",
  "dev_outbox", "envelopes", "facet_customer_approval_events",
  "facet_customer_approval_projection_attempts", "facet_design_event_identity_registry",
  "facet_design_events", "facet_design_evidence_associations", "facet_design_ingest_nonce_registry",
  "facet_design_ingest_nonces", "facet_design_projection_attempts", "field_action_media",
  "field_actions", "field_work_package_actions", "fleet_asset_actions",
  "governed_transition_outbox",
  "governed_transition_outbox_events", "governed_transitions", "heartbeat", "hermes_desktop_contexts",
  "hermes_desktop_devices", "hermes_desktop_envelopes", "hermes_desktop_events",
  "hermes_desktop_pairings", "hermes_desktop_results", "lead_ack_receipts",
  "measurement_deltas", "measurement_intake_receipts", "newo_control_actions",
  "newo_event_receipts", "newo_reconciliation_runs", "newo_sessions", "newo_slot_reservations",
  "production_schedule_approval_request_events", "production_schedule_approval_requests",
  "public_estimate_rate_limits", "quickbooks_projection_outbox", "quickbooks_webhook_receipts",
  "quote_revision_approval_request_events", "quote_revision_approval_requests", "replay_requests",
  "source_counts",
];

export const BASE_REQUIRED_D1_INDEX_BINDINGS = [
  ["idx_app_action_throttles_expiry", "app_action_throttles"],
  ["idx_app_auth_audit_tenant_created", "app_auth_audit"],
  ["idx_app_auth_throttles_expiry", "app_auth_throttles"],
  ["idx_app_device_pairings_user_expiry", "app_device_pairings"],
  ["idx_app_devices_tenant_user_active", "app_devices"],
  ["idx_app_magic_links_user_expiry", "app_magic_links"],
  ["idx_app_sessions_device_active", "app_sessions"],
  ["idx_app_sessions_user_expiry", "app_sessions"],
  ["idx_app_users_tenant_role_active", "app_users"],
  ["idx_approval_request_events_tenant_created", "approval_request_events"],
  ["idx_approval_requests_pending_expiry", "approval_requests"],
  ["idx_approval_requests_state_lease", "approval_requests"],
  ["idx_approval_requests_tenant_state_updated", "approval_requests"],
  ["idx_audit_env", "audit_log"],
  ["idx_audit_result_ts", "audit_log"],
  ["idx_audit_run_id", "audit_log"],
  ["idx_customer_portal_acceptance_challenges_expiry", "customer_portal_acceptance_challenges"],
  ["idx_customer_portal_acceptance_events_created", "customer_portal_acceptance_events"],
  ["idx_customer_portal_acceptance_intents_state_lease", "customer_portal_acceptance_intents"],
  ["idx_customer_portal_acceptance_one_active_challenge", "customer_portal_acceptance_challenges"],
  ["idx_customer_portal_access_throttles_expiry", "customer_portal_access_throttles"],
  ["idx_customer_portal_links_tenant_job_active", "customer_portal_links"],
  ["idx_dead_letter_open_envelope", "dead_letter"],
  ["idx_dedup_claims_first_seen", "dedup_claims"],
  ["idx_dev_outbox_created", "dev_outbox"],
  ["idx_env_day", "envelopes"],
  ["idx_env_dedup", "envelopes"],
  ["idx_env_erpnext", "envelopes"],
  ["idx_env_erpnext_instant_estimate", "envelopes"],
  ["idx_env_erpnext_roof_job", "envelopes"],
  ["idx_env_estimate_submission_key", "envelopes"],
  ["idx_env_status", "envelopes"],
  ["idx_envelopes_erpnext_error_open", "envelopes"],
  ["idx_envelopes_operational", "envelopes"],
  ["idx_facet_customer_approval_tenant_brand_occurred", "facet_customer_approval_events"],
  ["idx_facet_customer_projection_attempts_event_time", "facet_customer_approval_projection_attempts"],
  ["idx_facet_customer_projection_distinct_hold", "facet_customer_approval_projection_attempts"],
  ["idx_facet_customer_projection_one_frappe_rejection", "facet_customer_approval_projection_attempts"],
  ["idx_facet_customer_projection_one_success", "facet_customer_approval_projection_attempts"],
  ["idx_facet_design_events_tenant_project_occurred", "facet_design_events"],
  ["idx_facet_design_evidence_associations_tenant_time", "facet_design_evidence_associations"],
  ["idx_facet_design_projection_attempts_event_time", "facet_design_projection_attempts"],
  ["idx_facet_design_projection_distinct_hold", "facet_design_projection_attempts"],
  ["idx_facet_design_projection_one_frappe_rejection", "facet_design_projection_attempts"],
  ["idx_facet_design_projection_one_success", "facet_design_projection_attempts"],
  ["idx_field_action_media_evidence", "field_action_media"],
  ["idx_field_actions_job_created", "field_actions"],
  ["idx_field_actions_recovery", "field_actions"],
  ["idx_field_work_package_actions_job_created", "field_work_package_actions"],
  ["idx_field_work_package_actions_recovery", "field_work_package_actions"],
  ["idx_governed_transition_outbox_events_tenant_created", "governed_transition_outbox_events"],
  ["idx_governed_transition_outbox_pending", "governed_transition_outbox"],
  ["idx_governed_transitions_tenant_created", "governed_transitions"],
  ["idx_heartbeat_ran_at", "heartbeat"],
  ["idx_hermes_desktop_devices_binding_active", "hermes_desktop_devices"],
  ["idx_hermes_desktop_envelopes_device_state_expiry", "hermes_desktop_envelopes"],
  ["idx_hermes_desktop_events_tenant_created", "hermes_desktop_events"],
  ["idx_hermes_desktop_pairings_user_expiry", "hermes_desktop_pairings"],
  ["idx_hermes_desktop_results_idempotency_identity", "hermes_desktop_results"],
  ["idx_hermes_desktop_results_one_accepted_handoff", "hermes_desktop_results"],
  ["idx_lead_ack_receipts_envelope_observed", "lead_ack_receipts"],
  ["idx_measurement_deltas_created", "measurement_deltas"],
  ["idx_measurement_deltas_identity", "measurement_deltas"],
  ["idx_measurement_deltas_metric", "measurement_deltas"],
  ["idx_measurement_deltas_tenant_cohort_created", "measurement_deltas"],
  ["idx_measurement_intake_receipts_exception_updated", "measurement_intake_receipts"],
  ["idx_newo_control_status", "newo_control_actions"],
  ["idx_newo_receipts_session", "newo_event_receipts"],
  ["idx_newo_receipts_status", "newo_event_receipts"],
  ["idx_newo_reconciliation_runs_at", "newo_reconciliation_runs"],
  ["idx_newo_sessions_appointment", "newo_sessions"],
  ["idx_newo_sessions_missing_report", "newo_sessions"],
  ["idx_newo_sessions_phone", "newo_sessions"],
  ["idx_newo_sessions_status", "newo_sessions"],
  ["idx_newo_sessions_sync", "newo_sessions"],
  ["idx_newo_sessions_verified_job", "newo_sessions"],
  ["idx_newo_slots_expiry", "newo_slot_reservations"],
  ["idx_production_schedule_approval_events_tenant_created", "production_schedule_approval_request_events"],
  ["idx_production_schedule_approvals_active_target", "production_schedule_approval_requests"],
  ["idx_production_schedule_approvals_pending_expiry", "production_schedule_approval_requests"],
  ["idx_production_schedule_approvals_state_lease", "production_schedule_approval_requests"],
  ["idx_production_schedule_approvals_tenant_state_updated", "production_schedule_approval_requests"],
  ["idx_public_estimate_rate_limits_expiry", "public_estimate_rate_limits"],
  ["idx_qb_projection_outbox_pending", "quickbooks_projection_outbox"],
  ["idx_qb_receipts_last_seen", "quickbooks_webhook_receipts"],
  ["idx_qb_webhook_receipts_envelope", "quickbooks_webhook_receipts"],
  ["idx_quote_revision_approval_events_tenant_created", "quote_revision_approval_request_events"],
  ["idx_quote_revision_approvals_active_target", "quote_revision_approval_requests"],
  ["idx_quote_revision_approvals_pending_expiry", "quote_revision_approval_requests"],
  ["idx_quote_revision_approvals_state_lease", "quote_revision_approval_requests"],
  ["idx_quote_revision_approvals_tenant_state_updated", "quote_revision_approval_requests"],
  ["idx_replay_requests_envelope_approver_created", "replay_requests"],
  ["idx_replay_requests_status_updated", "replay_requests"],
  ["idx_app_users_tenant_access_role_active", "app_users"],
  ["idx_authority_record_actions_pending", "authority_record_actions"],
  ["idx_authority_record_actions_tenant_record", "authority_record_actions"],
  ["idx_authority_record_readbacks_state", "authority_record_readbacks"],
  ["idx_authority_record_readbacks_tenant_record", "authority_record_readbacks"],
  ["idx_dead_letter_open_measurement", "dead_letter"],
  ["idx_measurement_intake_receipts_ocr_review", "measurement_intake_receipts"],
  ["idx_field_actions_work_package_evidence", "field_actions"],
];

export const BASE_REQUIRED_D1_TRIGGER_BINDINGS = [
  ["append_approval_request_created_event", "approval_requests"],
  ["append_approval_request_reconciliation_event", "approval_requests"],
  ["append_approval_request_transition_event", "approval_requests"],
  ["append_governed_transition_outbox_intent_event", "governed_transition_outbox"],
  ["append_governed_transition_outbox_state_event", "governed_transition_outbox"],
  ["append_production_schedule_approval_created_event", "production_schedule_approval_requests"],
  ["append_production_schedule_approval_reconciliation_event", "production_schedule_approval_requests"],
  ["append_production_schedule_approval_transition_event", "production_schedule_approval_requests"],
  ["append_quote_revision_approval_created_event", "quote_revision_approval_requests"],
  ["append_quote_revision_approval_reconciliation_event", "quote_revision_approval_requests"],
  ["append_quote_revision_approval_transition_event", "quote_revision_approval_requests"],
  ["customer_portal_acceptance_challenge_immutable", "customer_portal_acceptance_challenges"],
  ["customer_portal_acceptance_challenges_append_only_delete", "customer_portal_acceptance_challenges"],
  ["customer_portal_acceptance_consume_challenge", "customer_portal_acceptance_intents"],
  ["customer_portal_acceptance_events_append_only_delete", "customer_portal_acceptance_events"],
  ["customer_portal_acceptance_events_append_only_update", "customer_portal_acceptance_events"],
  ["customer_portal_acceptance_immutable_intent", "customer_portal_acceptance_intents"],
  ["customer_portal_acceptance_intents_append_only_delete", "customer_portal_acceptance_intents"],
  ["customer_portal_acceptance_record_frappe_attempt", "customer_portal_acceptance_intents"],
  ["customer_portal_acceptance_record_state_event", "customer_portal_acceptance_intents"],
  ["customer_portal_acceptance_valid_transition", "customer_portal_acceptance_intents"],
  ["enforce_approval_request_reconciliation", "approval_requests"],
  ["enforce_approval_request_transition", "approval_requests"],
  ["enforce_governed_transition_outbox_update", "governed_transition_outbox"],
  ["enforce_production_schedule_approval_reconciliation", "production_schedule_approval_requests"],
  ["enforce_production_schedule_approval_transition", "production_schedule_approval_requests"],
  ["enforce_quote_revision_approval_reconciliation", "quote_revision_approval_requests"],
  ["enforce_quote_revision_approval_transition", "quote_revision_approval_requests"],
  ["enqueue_governed_transition_from_approval_claim", "approval_requests"],
  ["facet_customer_approval_events_append_only_delete", "facet_customer_approval_events"],
  ["facet_customer_approval_events_append_only_update", "facet_customer_approval_events"],
  ["facet_customer_approval_events_register_identity", "facet_customer_approval_events"],
  ["facet_customer_approval_projection_attempts_append_only_delete", "facet_customer_approval_projection_attempts"],
  ["facet_customer_approval_projection_attempts_append_only_update", "facet_customer_approval_projection_attempts"],
  ["facet_design_event_identity_registry_append_only_delete", "facet_design_event_identity_registry"],
  ["facet_design_event_identity_registry_append_only_update", "facet_design_event_identity_registry"],
  ["facet_design_events_append_only_delete", "facet_design_events"],
  ["facet_design_events_append_only_update", "facet_design_events"],
  ["facet_design_events_register_identity", "facet_design_events"],
  ["facet_design_evidence_associations_append_only_delete", "facet_design_evidence_associations"],
  ["facet_design_evidence_associations_append_only_update", "facet_design_evidence_associations"],
  ["facet_design_evidence_associations_validate_insert", "facet_design_evidence_associations"],
  ["facet_design_ingest_nonce_registry_append_only_delete", "facet_design_ingest_nonce_registry"],
  ["facet_design_ingest_nonce_registry_append_only_update", "facet_design_ingest_nonce_registry"],
  ["facet_design_ingest_nonces_append_only_delete", "facet_design_ingest_nonces"],
  ["facet_design_ingest_nonces_append_only_update", "facet_design_ingest_nonces"],
  ["facet_design_projection_attempts_append_only_delete", "facet_design_projection_attempts"],
  ["facet_design_projection_attempts_append_only_update", "facet_design_projection_attempts"],
  ["hermes_desktop_contexts_immutable_delete", "hermes_desktop_contexts"],
  ["hermes_desktop_contexts_immutable_update", "hermes_desktop_contexts"],
  ["hermes_desktop_devices_binding_immutable", "hermes_desktop_devices"],
  ["hermes_desktop_devices_revocation_monotonic", "hermes_desktop_devices"],
  ["hermes_desktop_envelopes_binding_immutable", "hermes_desktop_envelopes"],
  ["hermes_desktop_envelopes_state_transition", "hermes_desktop_envelopes"],
  ["hermes_desktop_events_immutable_delete", "hermes_desktop_events"],
  ["hermes_desktop_events_immutable_update", "hermes_desktop_events"],
  ["hermes_desktop_pairings_binding_immutable", "hermes_desktop_pairings"],
  ["hermes_desktop_pairings_consumption_monotonic", "hermes_desktop_pairings"],
  ["hermes_desktop_results_append_only_delete", "hermes_desktop_results"],
  ["hermes_desktop_results_append_only_update", "hermes_desktop_results"],
  ["measurement_deltas_append_only_delete", "measurement_deltas"],
  ["measurement_deltas_append_only_update", "measurement_deltas"],
  ["prevent_approval_request_binding_rewrite", "approval_requests"],
  ["prevent_approval_request_delete", "approval_requests"],
  ["prevent_approval_request_event_delete", "approval_request_events"],
  ["prevent_approval_request_event_update", "approval_request_events"],
  ["prevent_governed_transition_delete", "governed_transitions"],
  ["prevent_governed_transition_outbox_delete", "governed_transition_outbox"],
  ["prevent_governed_transition_outbox_event_delete", "governed_transition_outbox_events"],
  ["prevent_governed_transition_outbox_event_update", "governed_transition_outbox_events"],
  ["prevent_governed_transition_update", "governed_transitions"],
  ["prevent_lead_ack_receipts_delete", "lead_ack_receipts"],
  ["prevent_lead_ack_receipts_update", "lead_ack_receipts"],
  ["prevent_production_schedule_approval_binding_rewrite", "production_schedule_approval_requests"],
  ["prevent_production_schedule_approval_delete", "production_schedule_approval_requests"],
  ["prevent_production_schedule_approval_event_delete", "production_schedule_approval_request_events"],
  ["prevent_production_schedule_approval_event_update", "production_schedule_approval_request_events"],
  ["prevent_quote_revision_approval_binding_rewrite", "quote_revision_approval_requests"],
  ["prevent_quote_revision_approval_delete", "quote_revision_approval_requests"],
  ["prevent_quote_revision_approval_event_delete", "quote_revision_approval_request_events"],
  ["prevent_quote_revision_approval_event_update", "quote_revision_approval_request_events"],
  ["project_governed_transition_outbox_reconciliation", "approval_requests"],
  ["project_governed_transition_outbox_terminal", "approval_requests"],
  ["renew_approval_execution_lease_from_governed_outbox_claim", "governed_transition_outbox"],
  ["validate_source_count_insert", "source_counts"],
  ["validate_source_count_update", "source_counts"],
  ["authority_record_actions_append_only_delete", "authority_record_actions"],
  ["authority_record_actions_identity_immutable", "authority_record_actions"],
  ["authority_record_actions_validate_actor", "authority_record_actions"],
  ["authority_record_readbacks_append_only_delete", "authority_record_readbacks"],
  ["authority_record_readbacks_append_only_update", "authority_record_readbacks"],
  ["authority_record_readbacks_validate_actor", "authority_record_readbacks"],
];

export function d1ContractCsv(name) {
  const initial = D1_BACKUP_CONTRACT.match(new RegExp(`^${name}="([^"]*)"$`, "m"))?.[1] ?? "";
  const additions = [...D1_BACKUP_CONTRACT.matchAll(new RegExp(`^${name}\\+="([^"]*)"$`, "gm"))]
    .map((match) => match[1]);
  return [initial, ...additions].join("").split(",").filter(Boolean);
}

export function extendD1Bindings(baseline, current) {
  const bindings = [];
  for (const value of current) {
    const separator = value.indexOf("=");
    assert.ok(separator > 0, `invalid D1 binding fixture: ${value}`);
    const name = value.slice(0, separator);
    const table = value.slice(separator + 1);
    bindings.push([name, table]);
  }
  const currentBindings = new Map(bindings);
  assert.equal(currentBindings.size, bindings.length, "duplicate D1 binding fixture");
  for (const [name, table] of baseline) {
    assert.equal(currentBindings.get(name), table, `D1 binding drift: ${name}`);
  }
  return bindings;
}

export const REQUIRED_D1_TABLES = d1ContractCsv("REQUIRED_TABLES");
assert.equal(new Set(REQUIRED_D1_TABLES).size, REQUIRED_D1_TABLES.length, "duplicate D1 table fixture");
for (const table of BASE_REQUIRED_D1_TABLES) assert.ok(REQUIRED_D1_TABLES.includes(table), `missing D1 table fixture: ${table}`);
export const REQUIRED_D1_INDEX_BINDINGS = extendD1Bindings(
  BASE_REQUIRED_D1_INDEX_BINDINGS,
  d1ContractCsv("REQUIRED_INDEX_BINDINGS"),
);
export const REQUIRED_D1_TRIGGER_BINDINGS = extendD1Bindings(
  BASE_REQUIRED_D1_TRIGGER_BINDINGS,
  d1ContractCsv("REQUIRED_TRIGGER_BINDINGS"),
);
export const D1_TRIGGER_VERIFY_QUERY_PREFIX = "SELECT name AS trigger_name, tbl_name AS table_name, sql AS trigger_sql FROM sqlite_master WHERE type='trigger' AND name IN (";
export const D1_TRIGGER_VERIFY_QUERY_SUFFIX = ") ORDER BY name;";
export const MAX_REMOTE_D1_READ_COMMAND_LENGTH = 16_384;

export function d1TriggerVerificationBatchCount() {
  let batchNames = "";
  let batchCount = 0;
  for (const [triggerName] of REQUIRED_D1_TRIGGER_BINDINGS) {
    const quotedName = `'${triggerName}'`;
    const candidateNames = batchNames ? `${batchNames},${quotedName}` : quotedName;
    const candidate = `${D1_TRIGGER_VERIFY_QUERY_PREFIX}${candidateNames}${D1_TRIGGER_VERIFY_QUERY_SUFFIX}`;
    if (candidate.length > MAX_REMOTE_D1_READ_COMMAND_LENGTH) {
      assert.notEqual(batchNames, "", "single D1 trigger name exceeds the bounded read contract");
      batchCount += 1;
      batchNames = quotedName;
    } else {
      batchNames = candidateNames;
    }
  }
  assert.notEqual(batchNames, "", "D1 trigger inventory must not be empty");
  return batchCount + 1;
}

export const REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT = d1TriggerVerificationBatchCount();

export const HERMES_D1_TABLES = new Set([
  "hermes_desktop_contexts",
  "hermes_desktop_devices",
  "hermes_desktop_envelopes",
  "hermes_desktop_events",
  "hermes_desktop_pairings",
  "hermes_desktop_results",
]);
export const HERMES_D1_INDEXES = new Set(
  REQUIRED_D1_INDEX_BINDINGS
    .filter(([, table]) => HERMES_D1_TABLES.has(table))
    .map(([name]) => name),
);
export const HERMES_D1_TRIGGERS = new Set(
  REQUIRED_D1_TRIGGER_BINDINGS
    .filter(([, table]) => HERMES_D1_TABLES.has(table))
    .map(([name]) => name),
);

export function hermesTriggerSql(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = HERMES_DESKTOP_MIGRATION.match(new RegExp(
    `CREATE\\s+TRIGGER\\s+IF\\s+NOT\\s+EXISTS\\s+${escapedName}\\b[\\s\\S]*?\\nEND;`,
    "i",
  ));
  assert.ok(match, `missing Hermes migration trigger fixture: ${name}`);
  return match[0];
}

export function hermesMigrationSql({ missingTrigger = "" } = {}) {
  if (!HERMES_D1_TRIGGERS.has(missingTrigger)) return HERMES_DESKTOP_MIGRATION;
  return HERMES_DESKTOP_MIGRATION.replace(hermesTriggerSql(missingTrigger), "");
}

export function hermesIndexSql(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = HERMES_DESKTOP_MIGRATION.match(new RegExp(
    `CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${escapedName}\\b[\\s\\S]*?;`,
    "i",
  ));
  assert.ok(match, `missing Hermes migration index fixture: ${name}`);
  return match[0].replace(/\s+IF\s+NOT\s+EXISTS/i, "");
}

export function d1IndexSql(name, table) {
  if (HERMES_D1_INDEXES.has(name)) return hermesIndexSql(name);
  if (name === "idx_app_users_tenant_access_role_active")
    return `CREATE INDEX ${name} ON ${table}(tenant_id, active, access_role, updated_at);`;
  if (name === "idx_measurement_deltas_identity")
    return `CREATE UNIQUE INDEX ${name} ON ${table}(tenant_id, receipt_id, check_name, metric);`;
  if (name === "idx_measurement_deltas_tenant_cohort_created")
    return `CREATE INDEX ${name} ON ${table}(tenant_id, provider, source, metric, error_kind, created_at, id);`;
  if (name === "idx_measurement_intake_receipts_ocr_review")
    return `CREATE INDEX ${name} ON ${table}(ocr_review_required, ocr_status, updated_at DESC);`;
  if (name === "idx_dead_letter_open_measurement")
    return `CREATE UNIQUE INDEX ${name} ON ${table}(envelope_id, stage) WHERE recovered = 0 AND stage = 'measurement_processing';`;
  if (name === "idx_native_measurement_revisions_job")
    return `CREATE INDEX ${name} ON ${table}(tenant_id, roof_job_id, created_at DESC) WHERE roof_job_id IS NOT NULL;`;
  if (name === "idx_native_measurement_revisions_root")
    return `CREATE INDEX ${name} ON ${table}(tenant_id, root_measurement_id, revision_number DESC);`;
  if (name === "idx_native_measurement_revisions_one_successor")
    return `CREATE UNIQUE INDEX ${name} ON ${table}(tenant_id, supersedes_measurement_revision_id) WHERE supersedes_measurement_revision_id IS NOT NULL;`;
  if (name === "idx_native_photo_evidence_submissions_envelope")
    return `CREATE UNIQUE INDEX ${name} ON ${table}(tenant_id, envelope_id);`;
  if (name === "idx_native_photo_evidence_submissions_job")
    return `CREATE INDEX ${name} ON ${table}(tenant_id, job_number, created_at DESC);`;
  if (name === "idx_native_photo_evidence_items_submission")
    return `CREATE UNIQUE INDEX ${name} ON ${table}(submission_id, item_index);`;
  return `CREATE INDEX ${name} ON ${table}(id);`;
}

export function d1GenericTableSql(name, index) {
  if (name === "app_users") return `CREATE TABLE app_users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL,
    access_role TEXT CHECK (
      access_role IS NULL OR access_role IN (
        'owner', 'ops', 'sales', 'admin', 'production', 'shop', 'accounting', 'field'
      )
    ),
    updated_at TEXT NOT NULL
  );
  INSERT INTO app_users (id, tenant_id, active, role, access_role, updated_at)
  VALUES ('row-${index}', 'ironwrap', 1, 'owner', 'owner', '2026-08-13T00:00:00.000Z');`;
  if (name === "dead_letter") return `CREATE TABLE dead_letter (
    id TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO dead_letter (id, envelope_id, stage, recovered)
  VALUES ('row-${index}', 'envelope-${index}', 'other', 0);`;
  if (name === "measurement_deltas") return `CREATE TABLE measurement_deltas (
    id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    check_name TEXT NOT NULL,
    metric TEXT NOT NULL,
    provider TEXT NOT NULL,
    source TEXT NOT NULL,
    error_kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO measurement_deltas
    (id, tenant_id, receipt_id, check_name, metric, provider, source, error_kind, created_at)
  VALUES (1, 'ironwrap', 'receipt-1', 'cross_source_roof_area', 'roof_area',
    'applicad', 'google_solar', 'relative_fraction', '2026-08-13T00:00:00.000Z');`;
  if (name === "measurement_intake_receipts") return `CREATE TABLE measurement_intake_receipts (
    id TEXT PRIMARY KEY,
    report_raw_key TEXT CHECK (
      report_raw_key IS NULL OR (
        length(report_raw_key) = 92 AND substr(report_raw_key, 1, 24) = 'raw/measurement-reports/' AND
        substr(report_raw_key, 25, 64) NOT GLOB '*[^0-9a-f]*' AND substr(report_raw_key, 89) = '.bin'
      )
    ),
    report_sha256 TEXT CHECK (
      report_sha256 IS NULL OR (length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    ocr_status TEXT NOT NULL DEFAULT 'not_requested'
      CHECK (ocr_status IN ('not_requested', 'processing', 'completed', 'failed')),
    ocr_result_key TEXT CHECK (
      ocr_result_key IS NULL OR (
        length(ocr_result_key) = 166 AND
        substr(ocr_result_key, 1, 32) = 'raw/measurement-ocr/measurement_' AND
        substr(ocr_result_key, 33, 64) NOT GLOB '*[^0-9a-f]*' AND
        substr(ocr_result_key, 97, 1) = '/' AND
        substr(ocr_result_key, 98, 64) NOT GLOB '*[^0-9a-f]*' AND
        substr(ocr_result_key, 162) = '.json'
      )
    ),
    ocr_result_sha256 TEXT CHECK (
      ocr_result_sha256 IS NULL OR (length(ocr_result_sha256) = 64 AND ocr_result_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    ocr_review_required INTEGER NOT NULL DEFAULT 0 CHECK (ocr_review_required IN (0, 1)),
    updated_at TEXT NOT NULL,
    tenant_id TEXT CHECK (
      tenant_id IS NULL OR (
        length(tenant_id) BETWEEN 2 AND 64
        AND tenant_id NOT GLOB '*[^a-z0-9-]*'
      )
    ),
    native_measurement_revision_id TEXT CHECK (
      native_measurement_revision_id IS NULL OR (
        length(native_measurement_revision_id) = 69
        AND native_measurement_revision_id GLOB 'mrev_[0-9a-f]*'
        AND substr(native_measurement_revision_id, 6) NOT GLOB '*[^0-9a-f]*'
      )
    ),
    native_projection_sha256 TEXT CHECK (
      native_projection_sha256 IS NULL OR (
        length(native_projection_sha256) = 64
        AND native_projection_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
  );
  INSERT INTO measurement_intake_receipts (id, updated_at)
  VALUES ('row-${index}', '2026-08-13T00:00:00.000Z');`;
  if (name === "native_measurement_revisions") return `CREATE TABLE native_measurement_revisions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    receipt_id TEXT,
    measurement_id TEXT,
    root_measurement_id TEXT,
    revision_number INTEGER,
    roof_job_id TEXT,
    created_at TEXT,
    supersedes_measurement_revision_id TEXT,
    measurement_revision_id TEXT,
    report_raw_key TEXT,
    report_sha256 TEXT,
    projection_json TEXT NOT NULL CHECK (
      length(projection_json) BETWEEN 2 AND 2097152 AND json_valid(projection_json)
    ),
    UNIQUE (receipt_id),
    UNIQUE (measurement_id),
    UNIQUE (tenant_id, root_measurement_id, revision_number),
    CHECK ((report_raw_key IS NULL) = (report_sha256 IS NULL)),
    FOREIGN KEY (roof_job_id, tenant_id)
      REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (supersedes_measurement_revision_id, tenant_id)
      REFERENCES native_measurement_revisions(measurement_revision_id, tenant_id) ON DELETE RESTRICT
  );
  INSERT INTO native_measurement_revisions (id, projection_json)
  VALUES ('row-${index}', '{}');`;
  if (name === "native_photo_evidence_submissions") return `CREATE TABLE native_photo_evidence_submissions (
    id TEXT PRIMARY KEY,
    submission_id TEXT,
    tenant_id TEXT,
    envelope_id TEXT,
    job_number TEXT,
    roof_job_id TEXT,
    operating_job_version INTEGER,
    association_status TEXT,
    association_error TEXT,
    created_at TEXT,
    photo_count INTEGER,
    projection_json TEXT NOT NULL CHECK (
      length(projection_json) BETWEEN 2 AND 2097152 AND json_valid(projection_json)
    ),
    UNIQUE (submission_id, tenant_id),
    FOREIGN KEY (roof_job_id, tenant_id)
      REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
    CHECK (
      (association_status = 'matched'
        AND roof_job_id IS NOT NULL
        AND operating_job_version IS NOT NULL
        AND association_error IS NULL)
      OR
      (association_status = 'unmatched'
        AND roof_job_id IS NULL
        AND operating_job_version IS NULL
        AND association_error IS NOT NULL)
    )
  );
  INSERT INTO native_photo_evidence_submissions (id, projection_json, association_status, association_error)
  VALUES ('row-${index}', '{}', 'unmatched', 'no-job');`;
  if (name === "native_photo_evidence_items") return `CREATE TABLE native_photo_evidence_items (
    id TEXT PRIMARY KEY,
    evidence_id TEXT,
    submission_id TEXT,
    tenant_id TEXT,
    item_index INTEGER,
    UNIQUE (evidence_id, tenant_id),
    FOREIGN KEY (submission_id, tenant_id)
      REFERENCES native_photo_evidence_submissions(submission_id, tenant_id) ON DELETE RESTRICT
  );
  INSERT INTO native_photo_evidence_items (id)
  VALUES ('row-${index}');`;
  return `CREATE TABLE ${name} (id TEXT PRIMARY KEY);\nINSERT INTO ${name} (id) VALUES ('row-${index}');`;
}

export const HERMES_D1_SEED_SQL = `
INSERT INTO hermes_desktop_pairings (
  pairing_id, token_sha256, tenant_id, user_id, role, api_audience,
  bound_issuer, bound_origin, issued_at, expires_at
) VALUES (
  'pairing-1', '${"a".repeat(64)}', 'tenant-a', 'user-a', 'owner',
  'https://bus.example.invalid', 'https://os.example.invalid',
  'https://app.example.invalid', '2026-08-13T00:00:00.000Z', '2026-08-13T01:00:00.000Z'
);
INSERT INTO hermes_desktop_devices (
  device_id, pairing_id, tenant_id, user_id, role, api_audience, bound_issuer,
  bound_origin, connector_capabilities_json, device_name, device_proof_sha256,
  access_token_sha256, access_expires_at, paired_at
) VALUES (
  'device-0001', 'pairing-1', 'tenant-a', 'user-a', 'owner',
  'https://bus.example.invalid', 'https://os.example.invalid',
  'https://app.example.invalid', '{}', 'Fixture desktop', '${"b".repeat(64)}',
  '${"c".repeat(64)}', '2026-08-13T01:00:00.000Z', '2026-08-13T00:00:00.000Z'
);
INSERT INTO hermes_desktop_envelopes (
  envelope_id, version, workflow, tenant_id, user_id, role, device_id,
  pairing_id, lead_id, lead_envelope_id, channel, recipient_ref, consent_id,
  consent_basis, state, context_sha256, context_json, envelope_json,
  provider_request_json, provider_request_sha256, output_schema_sha256,
  messages_sha256, issued_at, expires_at
) VALUES (
  'envelope-1', 'task_envelope_v1', 'lead_follow_up_draft', 'tenant-a', 'user-a',
  'owner', 'device-0001', 'pairing-1', 'lead-0001', 'lead-envelope-1', 'Email',
  'lead@example.invalid', 'consent-1', 'express', 'issued', '${"d".repeat(64)}',
  '{}', '{}', '{}', '${"e".repeat(64)}', '${"f".repeat(64)}', '${"1".repeat(64)}',
  '2026-08-13T00:00:00.000Z', '2026-08-13T01:00:00.000Z'
);
INSERT INTO hermes_desktop_contexts (
  context_id, envelope_id, tenant_id, user_id, role, device_id, pairing_id,
  prior_context_sha256, context_sha256, observations_json, calendar_slots_json,
  context_json, provider_request_json, provider_request_sha256,
  output_schema_sha256, messages_sha256, staged_at
) VALUES (
  'context-1', 'envelope-1', 'tenant-a', 'user-a', 'owner', 'device-0001',
  'pairing-1', '${"0".repeat(64)}', '${"d".repeat(64)}', '[]', '[]', '{}', '{}',
  '${"e".repeat(64)}', '${"f".repeat(64)}', '${"1".repeat(64)}',
  '2026-08-13T00:05:00.000Z'
);
INSERT INTO hermes_desktop_results (
  result_id, envelope_id, context_id, tenant_id, user_id, role, device_id,
  pairing_id, context_sha256, provider_request_sha256, source_channel,
  idempotency_key_sha256, input_sha256, outcome, validation_sha256,
  handoff_sha256, result_sha256, result_json, recorded_at
) VALUES (
  'result-0001', 'envelope-1', 'context-1', 'tenant-a', 'user-a', 'owner',
  'device-0001', 'pairing-1', '${"d".repeat(64)}', '${"e".repeat(64)}', 'desktop',
  '${"2".repeat(64)}', '${"3".repeat(64)}', 'accepted', '${"4".repeat(64)}',
  '${"5".repeat(64)}', '${"6".repeat(64)}', '{}', '2026-08-13T00:10:00.000Z'
);
INSERT INTO hermes_desktop_events (
  event_id, event_type, tenant_id, user_id, role, pairing_id, device_id,
  envelope_id, context_id, result_id, detail_sha256, created_at
) VALUES (
  'event-0001', 'draft_result_recorded', 'tenant-a', 'user-a', 'owner',
  'pairing-1', 'device-0001', 'envelope-1', 'context-1', 'result-0001',
  '${"7".repeat(64)}', '2026-08-13T00:10:00.000Z'
);`;

export function d1TriggerSql(name, table, {
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakMeasurementTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
  weakAccessRoleTrigger = false,
} = {}) {
  if (HERMES_D1_TRIGGERS.has(name)) return hermesTriggerSql(name);
  if (name === "native_measurement_revisions_receipt_guard") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_measurement_receipt_evidence_mismatch')
      WHERE EXISTS (
        SELECT 1 FROM measurement_intake_receipts AS receipt
        WHERE receipt.payload_hash = NEW.measurement_raw_sha256
      );
    END;`;
  }
  if (name === "native_measurement_revisions_job_guard") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_measurement_job_anchor_mismatch')
      WHERE EXISTS (
        SELECT 1 FROM operating_roof_jobs AS job
        WHERE job.version = NEW.operating_job_version
      );
    END;`;
  }
  if (name === "native_measurement_revisions_lineage_guard") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_measurement_lineage_mismatch')
      WHERE EXISTS (
        SELECT 1 FROM native_measurement_revisions AS predecessor
        WHERE predecessor.revision_number = NEW.revision_number - 1
      );
    END;`;
  }
  if (name === "native_measurement_revisions_no_insert_replace") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_measurement_insert_replace_forbidden')
      WHERE EXISTS (
        SELECT 1 FROM native_measurement_revisions AS existing
        WHERE existing.receipt_id = NEW.receipt_id
      );
    END;`;
  }
  if (name === "native_measurement_revisions_append_only_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_measurement_revisions_append_only'); END;`;
  }
  if (name === "native_measurement_revisions_append_only_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_measurement_revisions_append_only'); END;`;
  }
  if (name === "measurement_intake_receipts_native_binding_guard") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN
      SELECT RAISE(ABORT, 'measurement_native_binding_immutable')
      WHERE EXISTS (
        SELECT 1 FROM native_measurement_revisions AS revision
        WHERE revision.projection_sha256 = NEW.native_projection_sha256
          AND revision.measurement_raw_sha256 IS NOT NEW.payload_hash
      );
    END;`;
  }
  if (name === "native_photo_evidence_submissions_job_guard") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_photo_job_anchor_mismatch')
      WHERE EXISTS (
        SELECT 1 FROM operating_roof_jobs AS job
        WHERE job.version = NEW.operating_job_version
      );
    END;`;
  }
  if (name === "native_photo_evidence_submissions_no_insert_replace") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_photo_insert_replace_forbidden')
      WHERE EXISTS (
        SELECT 1 FROM native_photo_evidence_submissions AS existing
        WHERE existing.submission_id = NEW.submission_id
      );
    END;`;
  }
  if (name === "native_photo_evidence_submissions_append_only_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_submissions_append_only'); END;`;
  }
  if (name === "native_photo_evidence_submissions_append_only_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_submissions_append_only'); END;`;
  }
  if (name === "native_photo_evidence_items_parent_guard") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_photo_item_parent_mismatch')
      WHERE EXISTS (
        SELECT 1 FROM native_photo_evidence_submissions AS submission
        WHERE NEW.item_index < submission.photo_count
      );
    END;`;
  }
  if (name === "native_photo_evidence_items_no_insert_replace") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'native_photo_item_insert_replace_forbidden')
      WHERE EXISTS (
        SELECT 1 FROM native_photo_evidence_items AS existing
        WHERE existing.evidence_id = NEW.evidence_id
      );
    END;`;
  }
  if (name === "native_photo_evidence_items_append_only_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_items_append_only'); END;`;
  }
  if (name === "native_photo_evidence_items_append_only_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_items_append_only'); END;`;
  }
  if (name === "validate_source_count_insert") {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN 0 BEGIN SELECT RAISE(ABORT, 'invalid_source_count'); END;`;
  }
  if (name === "validate_source_count_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} WHEN 0 BEGIN SELECT RAISE(ABORT, 'invalid_source_count'); END;`;
  }
  if (name === weakReceiptTrigger) {
    const timing = name === "prevent_lead_ack_receipts_update" ? "UPDATE" : "DELETE";
    return `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name === wrongTimingReceiptTrigger) {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'lead_ack_receipts_immutable'); END;`;
  }
  if (name === weakMeasurementTrigger) {
    const timing = name.endsWith("_delete") ? "DELETE" : "UPDATE";
    return `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'wrong_measurement_abort'); END;`;
  }
  if (name === weakApprovalTrigger) {
    const timing = name.endsWith("_delete") ? "DELETE" : "UPDATE";
    return `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'wrong_approval_ledger_abort'); END;`;
  }
  if (name === wrongTimingApprovalTrigger) {
    const [bindingAbort, eventAbort, deleteAbort] = name.startsWith("prevent_governed_transition_outbox_event_")
      ? [
        "governed_transition_outbox_binding_immutable",
        "governed_transition_outbox_events_immutable",
        "governed_transition_outbox_events_append_only",
      ]
      : name.startsWith("prevent_production_schedule_")
      ? [
        "production_schedule_approval_binding_immutable",
        "production_schedule_approval_events_immutable",
        "production_schedule_approvals_append_only",
      ]
      : name.startsWith("prevent_quote_revision_")
        ? [
          "quote_revision_approval_binding_immutable",
          "quote_revision_approval_events_immutable",
          "quote_revision_approvals_append_only",
        ]
        : [
          "approval_request_binding_immutable",
          "approval_request_events_immutable",
          "approval_requests_append_only",
        ];
    const abort = name.endsWith("binding_rewrite")
      ? bindingAbort
      : name.endsWith("_delete") && !name.includes("_event_")
        ? deleteAbort
        : eventAbort;
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${abort}'); END;`;
  }
  if (name === "prevent_lead_ack_receipts_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'lead_ack_receipts_immutable'); END;`;
  }
  if (name === "prevent_lead_ack_receipts_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'lead_ack_receipts_immutable'); END;`;
  }
  if (name === "measurement_deltas_append_only_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'measurement_deltas_append_only'); END;`;
  }
  if (name === "measurement_deltas_append_only_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'measurement_deltas_append_only'); END;`;
  }
  if (name === "facet_design_evidence_associations_validate_insert") {
    const rolePredicate = weakAccessRoleTrigger
      ? "actor.role IN ('owner', 'ops')"
      : "actor.access_role IN ('owner', 'ops')";
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN
      SELECT RAISE(ABORT, 'facet_design_association_event_anchor_mismatch') WHERE NOT EXISTS (
        SELECT 1 FROM facet_customer_approval_events AS event
        WHERE event.event_type = 'facet.design.customer_approved.v2' AND event.schema_version = 2
          AND event.identity_assurance = 'bearer_capability_only'
      );
      SELECT RAISE(ABORT, 'facet_design_association_office_actor_required') WHERE NOT EXISTS (
        SELECT 1 FROM app_users AS actor WHERE ${rolePredicate}
      );
    END;`;
  }
  if (name === "prevent_approval_request_binding_rewrite") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'approval_request_binding_immutable'); END;`;
  }
  if (name === "prevent_approval_request_event_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'approval_request_events_immutable'); END;`;
  }
  if (name === "prevent_approval_request_event_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'approval_request_events_immutable'); END;`;
  }
  if (name === "prevent_approval_request_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'approval_requests_append_only'); END;`;
  }
  if (name === "prevent_quote_revision_approval_binding_rewrite") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'quote_revision_approval_binding_immutable'); END;`;
  }
  if (name === "prevent_quote_revision_approval_event_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'quote_revision_approval_events_immutable'); END;`;
  }
  if (name === "prevent_quote_revision_approval_event_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'quote_revision_approval_events_immutable'); END;`;
  }
  if (name === "prevent_quote_revision_approval_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'quote_revision_approvals_append_only'); END;`;
  }
  if (name === "prevent_production_schedule_approval_binding_rewrite") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'production_schedule_approval_binding_immutable'); END;`;
  }
  if (name === "prevent_production_schedule_approval_event_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'production_schedule_approval_events_immutable'); END;`;
  }
  if (name === "prevent_production_schedule_approval_event_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'production_schedule_approval_events_immutable'); END;`;
  }
  if (name === "prevent_production_schedule_approval_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'production_schedule_approvals_append_only'); END;`;
  }
  if (name === "prevent_governed_transition_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transitions_immutable'); END;`;
  }
  if (name === "prevent_governed_transition_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transitions_append_only'); END;`;
  }
  if (name === "enforce_governed_transition_outbox_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transition_outbox_binding_immutable') WHERE 0; SELECT RAISE(ABORT, 'governed_transition_outbox_invalid_uncertain_transition') WHERE 0; SELECT RAISE(ABORT, 'governed_transition_outbox_terminal') WHERE 0; END;`;
  }
  if (name === "prevent_governed_transition_outbox_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transition_outbox_append_only'); END;`;
  }
  if (name === "prevent_governed_transition_outbox_event_update") {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transition_outbox_events_immutable'); END;`;
  }
  if (name === "prevent_governed_transition_outbox_event_delete") {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'governed_transition_outbox_events_append_only'); END;`;
  }
  if (name === "append_governed_transition_outbox_intent_event") {
    return `CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name === "append_governed_transition_outbox_state_event") {
    return `CREATE TRIGGER ${name} AFTER UPDATE OF state ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name === "renew_approval_execution_lease_from_governed_outbox_claim") {
    return `CREATE TRIGGER ${name} AFTER UPDATE OF state ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name.startsWith("append_approval_request_")) {
    return `CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name.startsWith("append_quote_revision_approval_")) {
    return `CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END;`;
  }
  if (name.startsWith("append_production_schedule_approval_")) {
    return `CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END;`;
  }
  return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT 1; END;`;
}

export function d1Sql({
  missingTable = "",
  missingIndex = "",
  missingTrigger = "",
  missingEvidencePrivacyView = "",
  brokenEvidencePrivacyView = "",
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakMeasurementTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
  weakAccessRoleTrigger = false,
  nullActiveAccessRole = false,
} = {}) {
  const tables = REQUIRED_D1_TABLES.filter((name) => name !== missingTable);
  const triggers = REQUIRED_D1_TRIGGER_BINDINGS.filter(([name, table]) => name !== missingTrigger && table !== missingTable);
  const genericTables = tables.filter((name) => !HERMES_D1_TABLES.has(name));
  const indexes = REQUIRED_D1_INDEX_BINDINGS.filter(([name, table]) =>
    !HERMES_D1_INDEXES.has(name) && name !== missingIndex && table !== missingTable
  );
  const genericTriggers = triggers.filter(([name]) => !HERMES_D1_TRIGGERS.has(name));
  // Synthetic views exercise the backup/restore view boundary. The real join
  // semantics are covered by migration tests against the full D1 schema.
  const evidencePrivacyViews = [
    ["evidence_upload_durable_refs", "evidence_upload_receipts", "ref"],
    ["evidence_upload_disposed_manifests", "evidence_upload_manifests", "sha256"],
  ].filter(([name]) => name !== missingEvidencePrivacyView).map(([name, table, value]) =>
    `CREATE VIEW ${name} AS SELECT id AS tenant_id, id AS ${value} FROM ${name === brokenEvidencePrivacyView ? "missing_evidence_source" : table} WHERE 0;`
  );
  return `BEGIN TRANSACTION;\n${genericTables.map(d1GenericTableSql).join("\n")}\n${nullActiveAccessRole ? "UPDATE app_users SET access_role = NULL WHERE active = 1;\n" : ""}${hermesMigrationSql({ missingTrigger })}\n${HERMES_D1_SEED_SQL}\n${indexes.map(([name, table]) => d1IndexSql(name, table)).join("\n")}\n${evidencePrivacyViews.join("\n")}\n${genericTriggers.map(([name, table]) => d1TriggerSql(name, table, { weakReceiptTrigger, wrongTimingReceiptTrigger, weakMeasurementTrigger, weakApprovalTrigger, wrongTimingApprovalTrigger, weakAccessRoleTrigger })).join("\n")}\nCOMMIT;\n`;
}

/** Actual migration/schema/data export, including an unresolved provider write. */
export async function evidenceWriteClaimSqlFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-claim-schema-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(DEFAULT_REPO_ROOT, "workers-bus/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")));
  const database = path.join(root, "source.sqlite3");
  const receiptId = `evu_${"a".repeat(64)}`;
  const seed = `
INSERT INTO app_users
  (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active, created_by, created_at, updated_at)
  VALUES ('appu_claim_synthetic_1', 'ironwrap', 'claim-owner@example.invalid', 'Synthetic claim owner',
    'owner', 'owner', 'claim-owner@example.invalid', 1, 'seed', 'synthetic-start', 'synthetic-start');
INSERT INTO evidence_upload_write_claims
  (claim_id, tenant_id, receipt_id, actor_user_id, request_sha256, r2_key, started_at, last_transition_at, state)
  VALUES ('ewc_00000000-0000-4000-8000-000000000001', 'ironwrap', '${receiptId}', 'appu_claim_synthetic_1',
    '${"b".repeat(64)}', 'evidence/v1/${"a".repeat(64)}.bin', 'synthetic-start', 'synthetic-start', 'active');
UPDATE evidence_upload_write_claims SET state = 'unknown', failure_code = 'raw_put_outcome_unknown',
  last_transition_at = 'synthetic-unknown';`;
  const create = spawnSync("sqlite3", ["-bail", database], {
    input: `PRAGMA foreign_keys = ON;\n${migrations.join("\n")}\n${seed}`, encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(create.status, 0, create.stderr);
  const dump = spawnSync("sqlite3", [database, ".dump"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(dump.stdout, /raw_put_outcome_unknown/);
  return dump.stdout;
}

export async function mockD1BackupEnvironment(t, {
  sqlFixture = null,
  failCopy = false,
  signalCopy = false,
  missingTable = "",
  missingIndex = "",
  missingTrigger = "",
  missingEvidencePrivacyView = "",
  brokenEvidencePrivacyView = "",
  weakReceiptTrigger = "",
  weakMeasurementTrigger = "",
  weakApprovalTrigger = "",
  weakAccessRoleTrigger = false,
  nullActiveAccessRole = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-d1-backup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await Promise.all([mkdir(bin), mkdir(state)]);
  const staged = await stageD1Script(root, D1_BACKUP);

  await writeExecutable(path.join(staged.workerBin, "wrangler"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '4.110.0\\n'; exit 0; fi
[[ "\${CLOUDFLARE_API_TOKEN:-}" == 'cloudflare_d1_backup_read_4c8f0b2d6a9137e5' ]] || exit 77
printf '%s\\n' "$*" >> "$MOCK_STATE/wrangler.log"
output=''; config=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]] || exit 2
if [[ -n "$config" ]]; then /bin/cp "$config" "$MOCK_STATE/source-config.json"; fi
/bin/cp "$MOCK_D1_SQL_FILE" "$output"
`);
  await writeExecutable(path.join(bin, "age"), `#!/usr/bin/env bash
set -euo pipefail
output=''; input=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --recipient) shift 2 ;;
    --encrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
/bin/cp "$input" "$output"
`);
  await writeExecutable(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(path.join(bin, "rclone"), `#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${CLOUDFLARE_API_TOKEN:-}" && -z "\${D1_BACKUP_API_TOKEN:-}" && -z "\${D1_RESTORE_API_TOKEN:-}" ]] || exit 78
printf '%s\\n' "\${1:-}" >> "$MOCK_STATE/rclone.log"
if [[ "\${1:-}" == 'copy' && "\${MOCK_SIGNAL_COPY:-0}" == '1' ]]; then kill -TERM "$PPID"; exit 143; fi
if [[ "\${1:-}" == 'copy' && "\${MOCK_FAIL_COPY:-0}" == '1' ]]; then exit 9; fi
exit 0
`);

  const fixtureSql = path.join(state, "fixture.sql");
  await writeFile(fixtureSql, sqlFixture ?? d1Sql({
    missingTable,
    missingIndex,
    missingTrigger,
    missingEvidencePrivacyView,
    brokenEvidencePrivacyView,
    weakReceiptTrigger,
    weakMeasurementTrigger,
    weakApprovalTrigger,
    weakAccessRoleTrigger,
    nullActiveAccessRole,
  }));

  return {
    root,
    state,
    script: staged.target,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      MOCK_STATE: state,
      MOCK_D1_SQL_FILE: fixtureSql,
      MOCK_FAIL_COPY: failCopy ? "1" : "0",
      MOCK_SIGNAL_COPY: signalCopy ? "1" : "0",
      D1_BACKUP_API_TOKEN: "cloudflare_d1_backup_read_4c8f0b2d6a9137e5",
      D1_PRODUCTION_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
      D1_PRODUCTION_DATABASE_NAME: "ironwrap-bus",
      D1_PRODUCTION_DATABASE_ID: "f0674848-13df-4422-9896-8ba2719663b8",
      D1_R2_BACKUP_BUCKET: "ironwrap-backups-prod",
      D1_BACKUP_RETENTION_DAYS: "30",
      BACKUP_AGE_RECIPIENT: `age1${"q".repeat(58)}`,
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "r2_access_31a68f02",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "r2_secret_97c63bd012ab45f6a1e8029f",
      RCLONE_CONFIG_R2_ENDPOINT: "https://a1b2c3d4.r2.cloudflarestorage.com",
    },
  };
}

export async function mockD1RestoreEnvironment(t, {
  sqlFixture = null,
  badChecksum = false,
  targetObject = "",
  preflightResponseMode = "normal",
  privacyViewResponseMode = "normal",
  signalDownload = false,
  missingTable = "",
  rowMismatch = false,
  indexMismatch = false,
  indexSemanticsMismatch = false,
  measurementIndexSemanticsMismatch = false,
  rowResultMode = "normal",
  triggerMismatch = false,
  triggerResultMode = "normal",
  triggerSemanticsMismatch = false,
  measurementTriggerSemanticsMismatch = false,
  quoteRevisionTriggerSemanticsMismatch = false,
  productionScheduleTriggerSemanticsMismatch = false,
  governedTransitionTriggerSemanticsMismatch = false,
  missingTrigger = "",
  missingIndex = "",
  missingEvidencePrivacyView = "",
  brokenEvidencePrivacyView = "",
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakMeasurementTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
  weakAccessRoleTrigger = false,
  nullActiveAccessRole = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-d1-restore-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const remote = path.join(root, "remote");
  const packageDir = path.join(root, "package");
  await Promise.all([mkdir(bin), mkdir(state), mkdir(remote), mkdir(packageDir)]);
  const targetDatabase = path.join(state, "target.sqlite3");
  const targetSchema = targetObject === "wrong_type_cf_kv"
    ? [`CREATE VIEW "_cf_KV" AS SELECT 1 AS value;`]
    : [
        `CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB);`,
        ...(targetObject === "user_table" ? [`CREATE TABLE user_data (id INTEGER);`] : []),
        ...(targetObject === "user_view" ? [`CREATE VIEW user_view AS SELECT 1 AS value;`] : []),
        ...(targetObject === "user_trigger" ? [
          `CREATE TABLE trigger_source (id INTEGER);`,
          `CREATE TRIGGER user_trigger AFTER INSERT ON trigger_source BEGIN SELECT 1; END;`,
        ] : []),
        ...(targetObject === "user_index" ? [
          `CREATE TABLE indexed_source (id INTEGER);`,
          `CREATE INDEX user_index ON indexed_source (id);`,
        ] : []),
        ...(targetObject === "unexpected_cf" ? [`CREATE TABLE "_cf_OTHER" (id INTEGER);`] : []),
      ];
  const targetSchemaRun = spawnSync("sqlite3", ["-bail", targetDatabase], {
    encoding: "utf8",
    input: targetSchema.join("\n"),
  });
  assert.equal(targetSchemaRun.status, 0, targetSchemaRun.stderr);
  const staged = await stageD1Script(root, D1_RESTORE);
  const stamp = "20260710T120000Z";
  const sqlFile = `ironwrap-d1-ironwrap-bus-${stamp}.sql`;
  const sqlPath = path.join(packageDir, sqlFile);
  await writeFile(sqlPath, sqlFixture ?? d1Sql({
    missingTable,
    missingIndex,
    missingTrigger,
    missingEvidencePrivacyView,
    brokenEvidencePrivacyView,
    weakReceiptTrigger,
    wrongTimingReceiptTrigger,
    weakMeasurementTrigger,
    weakApprovalTrigger,
    wrongTimingApprovalTrigger,
    weakAccessRoleTrigger,
    nullActiveAccessRole,
  }));
  const sqlDigest = createHash("sha256").update(await readFile(sqlPath)).digest("hex");
  await writeFile(path.join(packageDir, "IRONWRAP-D1-BACKUP-MANIFEST.txt"), [
    "schema_version=1",
    `created_utc=${stamp}`,
    "account_id=7ee5775bc1ba46f05c5a65235b60e939",
    "database_name=ironwrap-bus",
    "database_id=f0674848-13df-4422-9896-8ba2719663b8",
    "format=cloudflare-d1-sql-export",
    "wrangler_version=4.110.0",
    `sql_file=${sqlFile}`,
    `sql_sha256=${sqlDigest}`,
    `required_tables=${REQUIRED_D1_TABLES.join(",")}`,
    `required_indexes=${REQUIRED_D1_INDEX_BINDINGS.map(([name, table]) => `${name}=${table}`).join(",")}`,
    `required_triggers=${REQUIRED_D1_TRIGGER_BINDINGS.map(([name, table]) => `${name}=${table}`).join(",")}`,
    "",
  ].join("\n"));
  const archiveName = `ironwrap-d1-ironwrap-bus-${stamp}.tar.gz.age`;
  const archivePath = path.join(remote, archiveName);
  const tarRun = spawnSync("tar", ["-czf", archivePath, "-C", packageDir, "IRONWRAP-D1-BACKUP-MANIFEST.txt", sqlFile], { encoding: "utf8" });
  assert.equal(tarRun.status, 0, tarRun.stderr);
  const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  await writeFile(path.join(remote, `${archiveName}.sha256`), `${badChecksum ? "b".repeat(64) : digest}  ${archiveName}\n`);
  await writeFile(path.join(remote, "IRONWRAP-D1-BACKUP-COMPLETE"), [
    "schema_version=1",
    `created_utc=${stamp}`,
    "database_name=ironwrap-bus",
    "database_id=f0674848-13df-4422-9896-8ba2719663b8",
    `archive=${archiveName}`,
    `checksum=${archiveName}.sha256`,
    "",
  ].join("\n"));
  const identity = path.join(root, "age-identity.txt");
  await writeFile(identity, "AGE-SECRET-KEY-MOCK\n", { mode: 0o600 });
  await chmod(identity, 0o600);

  const matchingIndexes = JSON.stringify([{
    results: REQUIRED_D1_INDEX_BINDINGS.map(([index_name, table_name]) => ({
      index_name,
      table_name,
      index_sql: d1IndexSql(index_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const mismatchedIndexes = JSON.stringify([{
    results: REQUIRED_D1_INDEX_BINDINGS.map(([index_name, table_name], index) => ({
      index_name,
      table_name: index === 0 ? "lead_ack_receipts" : table_name,
      index_sql: d1IndexSql(index_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const semanticallyMismatchedIndexes = JSON.stringify([{
    results: REQUIRED_D1_INDEX_BINDINGS.map(([index_name, table_name]) => ({
      index_name,
      table_name,
      index_sql: index_name === "idx_hermes_desktop_results_one_accepted_handoff"
        ? "CREATE INDEX idx_hermes_desktop_results_one_accepted_handoff ON hermes_desktop_results(envelope_id)"
        : d1IndexSql(index_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const measurementSemanticallyMismatchedIndexes = JSON.stringify([{
    results: REQUIRED_D1_INDEX_BINDINGS.map(([index_name, table_name]) => ({
      index_name,
      table_name,
      index_sql: index_name === "idx_measurement_deltas_identity"
        ? "CREATE UNIQUE INDEX idx_measurement_deltas_identity ON measurement_deltas(receipt_id, check_name, metric)"
        : d1IndexSql(index_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const matchingTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const mismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name], index) => ({
      trigger_name,
      table_name: index === 0 ? "lead_ack_receipts" : table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const semanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingReceiptTrigger: "prevent_lead_ack_receipts_update" }),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const measurementSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, {
        weakMeasurementTrigger: "measurement_deltas_append_only_update",
      }),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const quoteRevisionSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingApprovalTrigger: "prevent_quote_revision_approval_event_update" }),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const productionScheduleSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingApprovalTrigger: "prevent_production_schedule_approval_event_update" }),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const governedTransitionSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingApprovalTrigger: "prevent_governed_transition_outbox_event_update" }),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const missingTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.slice(1).map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name),
    })),
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const duplicateTriggers = JSON.stringify([{
    results: [
      ...REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
        trigger_name,
        table_name,
        trigger_sql: d1TriggerSql(trigger_name, table_name),
      })),
      {
        trigger_name: REQUIRED_D1_TRIGGER_BINDINGS[0][0],
        table_name: REQUIRED_D1_TRIGGER_BINDINGS[0][1],
        trigger_sql: d1TriggerSql(...REQUIRED_D1_TRIGGER_BINDINGS[0]),
      },
    ],
    success: true,
    meta: { changes: 0, changed_db: false },
  }]);
  const errorTriggers = JSON.stringify([{
    results: [],
    success: false,
    meta: { changes: 0, changed_db: false },
  }]);
  await Promise.all([
    ["matching", matchingTriggers],
    ["mismatched", mismatchedTriggers],
    ["semantically-mismatched", semanticallyMismatchedTriggers],
    ["measurement-semantically-mismatched", measurementSemanticallyMismatchedTriggers],
    ["quote-revision-semantically-mismatched", quoteRevisionSemanticallyMismatchedTriggers],
    ["production-schedule-semantically-mismatched", productionScheduleSemanticallyMismatchedTriggers],
    ["governed-transition-semantically-mismatched", governedTransitionSemanticallyMismatchedTriggers],
    ["missing", missingTriggers],
    ["duplicate", duplicateTriggers],
    ["error", errorTriggers],
  ].map(([name, payload]) => writeFile(path.join(state, `triggers-${name}.json`), payload)));
  await writeExecutable(path.join(bin, "filter-trigger-response"), `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const [fixture, command] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(fixture, "utf8"));
const namesClause = command.match(/\\bname IN \\((.*)\\) ORDER BY name;$/);
if (!namesClause || !Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0]?.results)) process.exit(2);
const requested = new Set([...namesClause[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
payload[0].results = payload[0].results.filter((row) => requested.has(row.trigger_name));
process.stdout.write(JSON.stringify(payload) + "\\n");
`);

  await writeExecutable(path.join(staged.workerBin, "wrangler"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '4.110.0\\n'; exit 0; fi
[[ "\${CLOUDFLARE_API_TOKEN:-}" == 'cloudflare_d1_restore_write_91e6a4c8f02b735d' ]] || exit 77
printf '%s\\n' "$*" >> "$MOCK_STATE/wrangler.log"
file=''; config=''; command=''; json=0
while (( $# > 0 )); do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    --command) command="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) shift ;;
  esac
done
if [[ -n "$config" ]]; then /bin/cp "$config" "$MOCK_STATE/target-config.json"; fi
if [[ -n "$command" ]]; then printf '%s\\n' "\${#command}" >> "$MOCK_STATE/command-lengths.log"; fi
if (( json == 1 )); then
  if [[ -n "$file" ]]; then
    printf 'Checking remote upload status...\\n[{"success":true,"result":{"total_queries":1}}]\\n'
    exit 0
  fi
  if [[ "$command" == *cloudflare_internal_table_count* ]]; then
    printf '%s\\n' "$command" > "$MOCK_STATE/preflight-command.sql"
    if [[ "$MOCK_PREFLIGHT_RESPONSE_MODE" == 'progress' ]]; then
      printf 'Checking remote query status...\\n[{"results":[],"success":true,"meta":{"changes":0,"changed_db":false}}]\\n'
    elif [[ "$MOCK_PREFLIGHT_RESPONSE_MODE" == 'bulk' ]]; then
      printf '[{"success":true,"result":{"total_queries":1}}]\\n'
    else
      results="$(sqlite3 -json "$MOCK_TARGET_DATABASE" "$command")"
      printf '[{"results":%s,"success":true,"meta":{"changes":0,"changed_db":false}}]\\n' "$results"
    fi
  elif [[ "$command" == *" AS durable_view"* ]]; then
    if [[ "$MOCK_PRIVACY_VIEW_RESPONSE_MODE" == 'missing' ]]; then
      printf '[{"results":[{"durable_view":0,"disposed_view":1,"durable_query":0,"disposed_query":0}],"success":true,"meta":{"changes":0,"changed_db":false}}]\\n'
    else
      printf '[{"results":[{"durable_view":1,"disposed_view":1,"durable_query":0,"disposed_query":0}],"success":true,"meta":{"changes":0,"changed_db":false}}]\\n'
    fi
  elif [[ "$command" == *" AS table_name, COUNT(*) AS row_count FROM "* ]]; then
    IFS="'" read -r _ table_name _ <<< "$command"
    result_table="$table_name"
    row_count=1
    success=true
    results_mode=one
    if [[ "$MOCK_ROW_MISMATCH" == '1' && "$table_name" == '${REQUIRED_D1_TABLES[0]}' ]]; then row_count=2; fi
    if [[ "$MOCK_ROW_RESULT_MODE" == 'missing' && "$table_name" == '${REQUIRED_D1_TABLES.at(-1)}' ]]; then results_mode=missing; fi
    if [[ "$MOCK_ROW_RESULT_MODE" == 'duplicate' && "$table_name" == '${REQUIRED_D1_TABLES[1]}' ]]; then result_table='${REQUIRED_D1_TABLES[0]}'; fi
    if [[ "$MOCK_ROW_RESULT_MODE" == 'error' && "$table_name" == '${REQUIRED_D1_TABLES.at(-1)}' ]]; then success=false; fi
    if [[ "$results_mode" == 'missing' ]]; then
      printf '[{"results":[],"success":%s,"meta":{"changes":0,"changed_db":false}}]\\n' "$success"
    else
      printf '[{"results":[{"table_name":"%s","row_count":%s}],"success":%s,"meta":{"changes":0,"changed_db":false}}]\\n' "$result_table" "$row_count" "$success"
    fi
  elif [[ "$command" == *" AS index_name"* ]]; then
    if [[ "$MOCK_MEASUREMENT_INDEX_SEMANTICS_MISMATCH" == '1' ]]; then printf '%s\\n' '${measurementSemanticallyMismatchedIndexes}'; elif [[ "$MOCK_INDEX_SEMANTICS_MISMATCH" == '1' ]]; then printf '%s\\n' '${semanticallyMismatchedIndexes}'; elif [[ "$MOCK_INDEX_MISMATCH" == '1' ]]; then printf '%s\\n' '${mismatchedIndexes}'; else printf '%s\\n' '${matchingIndexes}'; fi
  elif [[ "$command" == *" AS trigger_name"* ]]; then
    trigger_fixture="$MOCK_STATE/triggers-matching.json"
    if [[ "$MOCK_TRIGGER_RESULT_MODE" == 'error' ]]; then
      trigger_fixture="$MOCK_STATE/triggers-error.json"
    elif [[ "$MOCK_TRIGGER_RESULT_MODE" == 'missing' ]]; then
      trigger_fixture="$MOCK_STATE/triggers-missing.json"
    elif [[ "$MOCK_TRIGGER_RESULT_MODE" == 'duplicate' ]]; then
      trigger_fixture="$MOCK_STATE/triggers-duplicate.json"
    elif [[ "$MOCK_GOVERNED_TRANSITION_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-governed-transition-semantically-mismatched.json"
    elif [[ "$MOCK_PRODUCTION_SCHEDULE_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-production-schedule-semantically-mismatched.json"
    elif [[ "$MOCK_QUOTE_REVISION_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-quote-revision-semantically-mismatched.json"
    elif [[ "$MOCK_MEASUREMENT_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-measurement-semantically-mismatched.json"
    elif [[ "$MOCK_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-semantically-mismatched.json"
    elif [[ "$MOCK_TRIGGER_MISMATCH" == '1' ]]; then trigger_fixture="$MOCK_STATE/triggers-mismatched.json"
    fi
    filter-trigger-response "$trigger_fixture" "$command"
  else
    exit 2
  fi
elif [[ -n "$file" ]]; then
  : > "$MOCK_STATE/imported"
else
  exit 2
fi
`);
  await writeExecutable(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(path.join(bin, "age"), `#!/usr/bin/env bash
set -euo pipefail
printf 'decrypt\\n' >> "$MOCK_STATE/age.log"
output=''; input=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --identity) shift 2 ;;
    --decrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
/bin/cp "$input" "$output"
`);
  await writeExecutable(path.join(bin, "rclone"), `#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${CLOUDFLARE_API_TOKEN:-}" && -z "\${D1_BACKUP_API_TOKEN:-}" && -z "\${D1_RESTORE_API_TOKEN:-}" ]] || exit 78
printf '%s\\n' "\${1:-}" >> "$MOCK_STATE/rclone.log"
case "\${1:-}" in
  cat) /bin/cat "$MOCK_REMOTE/\${2##*/}" ;;
  copyto)
    if [[ "\${MOCK_SIGNAL_DOWNLOAD:-0}" == '1' ]]; then kill -TERM "$PPID"; exit 143; fi
    /bin/cp "$MOCK_REMOTE/\${2##*/}" "$3"
    ;;
  *) exit 2 ;;
esac
`);

  return {
    root,
    state,
    script: staged.target,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      MOCK_STATE: state,
      MOCK_REMOTE: remote,
      MOCK_TARGET_DATABASE: targetDatabase,
      MOCK_PREFLIGHT_RESPONSE_MODE: preflightResponseMode,
      MOCK_PRIVACY_VIEW_RESPONSE_MODE: privacyViewResponseMode,
      MOCK_SIGNAL_DOWNLOAD: signalDownload ? "1" : "0",
      MOCK_ROW_MISMATCH: rowMismatch ? "1" : "0",
      MOCK_INDEX_MISMATCH: indexMismatch ? "1" : "0",
      MOCK_INDEX_SEMANTICS_MISMATCH: indexSemanticsMismatch ? "1" : "0",
      MOCK_MEASUREMENT_INDEX_SEMANTICS_MISMATCH: measurementIndexSemanticsMismatch ? "1" : "0",
      MOCK_ROW_RESULT_MODE: rowResultMode,
      MOCK_TRIGGER_MISMATCH: triggerMismatch ? "1" : "0",
      MOCK_TRIGGER_RESULT_MODE: triggerResultMode,
      MOCK_TRIGGER_SEMANTICS_MISMATCH: triggerSemanticsMismatch ? "1" : "0",
      MOCK_MEASUREMENT_TRIGGER_SEMANTICS_MISMATCH: measurementTriggerSemanticsMismatch ? "1" : "0",
      MOCK_QUOTE_REVISION_TRIGGER_SEMANTICS_MISMATCH: quoteRevisionTriggerSemanticsMismatch ? "1" : "0",
      MOCK_PRODUCTION_SCHEDULE_TRIGGER_SEMANTICS_MISMATCH: productionScheduleTriggerSemanticsMismatch ? "1" : "0",
      MOCK_GOVERNED_TRANSITION_TRIGGER_SEMANTICS_MISMATCH: governedTransitionTriggerSemanticsMismatch ? "1" : "0",
      D1_BACKUP_API_TOKEN: "cloudflare_d1_backup_read_4c8f0b2d6a9137e5",
      D1_RESTORE_API_TOKEN: "",
      D1_PRODUCTION_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
      D1_PRODUCTION_DATABASE_NAME: "ironwrap-bus",
      D1_PRODUCTION_DATABASE_ID: "f0674848-13df-4422-9896-8ba2719663b8",
      D1_R2_BACKUP_BUCKET: "ironwrap-backups-prod",
      D1_RESTORE_R2_COMPLETED_PREFIX: "d1/ironwrap-bus/20260710T120000Z-1234-5678",
      D1_RESTORE_AGE_IDENTITY_FILE: identity,
      D1_RESTORE_MODE: "verify",
      D1_RESTORE_TARGET_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
      D1_RESTORE_TARGET_DATABASE_NAME: "ironwrap-restore-drill-monthly",
      D1_RESTORE_TARGET_DATABASE_ID: "83b5835e-24cf-4b52-8f89-e3a822e1c980",
      D1_RESTORE_CONFIRMATION: "",
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "r2_access_31a68f02",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "r2_secret_97c63bd012ab45f6a1e8029f",
      RCLONE_CONFIG_R2_ENDPOINT: "https://a1b2c3d4.r2.cloudflarestorage.com",
    },
  };
}

export function validLiveEnv() {
  const adminToken = "admin_7f9e4c21b6a348d5a8f0c2e4";
  const effectRuntimeToken = "effect_runtime_8f6e4c2a0b9d7e5f3a1c8b6d4e2f0a9c";
  return {
    FRAPPE_VERSION: "v15.114.0",
    FRAPPE_COMMIT: "105b17938839f4e5c6cdff817d42afc40c3bcc32",
    FRAPPE_DOCKER_VERSION: "v3.2.1",
    FRAPPE_DOCKER_COMMIT: "d4a310089f5d6fc38ed1317b898d75b9c74901db",
    HERMES_VERSION: "v2026.7.7.2",
    HERMES_COMMIT: "9de9c25f620ff7f1ce0fd5457d596052d5159596",
    IRONWRAP_OS_IMAGE: `registry.ironwrap.internal/ironwrap-os:prod@sha256:${"a".repeat(64)}`,
    ERPNEXT_ENABLED: "false",
    ERPNEXT_BASE_URL: "https://os.ironwrapexteriors.com",
    ERPNEXT_API_KEY: "frappe_key_8c921",
    ERPNEXT_API_SECRET: "frappe_secret_d1a9f80c42",
    ERPNEXT_INTEGRATION_USER: "worker@ironwrapexteriors.com",
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet_capture_key_8c921",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet_capture_secret_d1a9f80c42",
    WORK_PACKAGE_FRAPPE_API_KEY: "work_package_key_8c921",
    WORK_PACKAGE_FRAPPE_API_SECRET: "work_package_secret_d1a9f80c42",
    QB_WEBHOOK_TOKEN: "quickbooks_webhook_4c8f0b2d6a9137e5",
    QB_EXPECTED_REALM_ID: "123456789012345",
    QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
    QB_RECONCILIATION_ISSUER_API_KEY: "quickbooks_issuer_key_8c921",
    QB_RECONCILIATION_ISSUER_API_SECRET: "quickbooks_issuer_secret_d1a9f80c42",
    IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
    PUBLIC_ESTIMATE_ENABLED: "true",
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: "https://bus.ironwrapexteriors.com",
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "ironwrap,iroof",
    PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "Alberta, Canada",
    PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY: "0x4AAAAAABusEstimatorKey",
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: "turnstile_secret_4c1b9e2f8a7d",
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: "estimate_rate_pepper_4c1b9e2f8a7d6c5b4a3",
    PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "12",
    PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX: "3",
    PUBLIC_ESTIMATE_RANGE_RULES_JSON: "[]",
    FACET_DESIGN_INGEST_ENABLED: "false",
    FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "false",
    APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "false",
    IRONWRAP_BUS_BASE_URL: "https://bus.ironwrapexteriors.com",
    IRONWRAP_ADMIN_TOKEN: adminToken,
    IRONWRAP_EFFECT_RUNTIME_ENABLED: "true",
    IRONWRAP_EFFECT_RUNTIME_URL: "https://bus.ironwrapexteriors.com",
    IRONWRAP_EFFECT_RUNTIME_TOKEN: effectRuntimeToken,
    IRONWRAP_BUS_WRITE_ENABLED: "false",
    ERPNEXT_WRITE_ENABLED: "false",
    HERMES_WRITE_TOKEN: "approval_1d9a84f620be4c7a936820d5ef31",
    HERMES_AGENT_ROLE: "owner-operator",
    HERMES_ACTOR_USER: "owner@ironwrapexteriors.com",
    HERMES_APPROVER_ID: "owner@ironwrapexteriors.com",
    HERMES_DRY_RUN_SIGNING_KEY: "dry_run_0a9e8f7d6c5b4a392817161514131211",
    APPROVAL_BROKER_SHARED_SECRET: "lead_broker_9f1a4c27d8e6b5a49382716151413121",
    HERMES_APPROVAL_PUBLIC_KEY_FILE: "/run/secrets/hermes-approval-public.pem",
    IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE: "/run/secrets/hermes-approval-public.pem",
    IRONWRAP_HERMES_SITE_BASE_URL: "https://os.ironwrapexteriors.com",
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "10000",
    ERPNEXT_REQUEST_TIMEOUT_MS: "10000",
    BUS_BASE_URL: "https://bus.ironwrapexteriors.com",
    INGEST_TOKEN: "ingest_4ef90c12a86b43d1ab75f3e8",
    ADMIN_TOKEN: adminToken,
    EFFECT_RUNTIME_TOKEN: effectRuntimeToken,
    FRAPPE_BASE_URL: "https://os.ironwrapexteriors.com",
    FRAPPE_API_KEY: "launch_proof_key_6a8f21",
    FRAPPE_API_SECRET: "launch_proof_secret_8d1c4b7a2e",
    FRAPPE_PROOF_POLL_ATTEMPTS: "3",
    FRAPPE_PROOF_POLL_INTERVAL_MS: "1000",
    FRAPPE_SITE: "os.ironwrapexteriors.com",
    BACKEND_CONTAINER: "frappe-backend-1",
    RCLONE_CONFIG_R2_TYPE: "s3",
    RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: "r2_access_31a68f02",
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "r2_secret_97c63bd012ab45f6a1e8029f",
    RCLONE_CONFIG_R2_ENDPOINT: "https://a1b2c3d4.r2.cloudflarestorage.com",
    R2_BACKUP_BUCKET: "ironwrap-backups-prod",
    BACKUP_RETENTION_DAYS: "30",
    BACKUP_AGE_RECIPIENT: `age1${"q".repeat(58)}`,
    D1_BACKUP_API_TOKEN: "cloudflare_d1_backup_read_4c8f0b2d6a9137e5",
    D1_RESTORE_API_TOKEN: "",
    D1_PRODUCTION_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
    D1_PRODUCTION_DATABASE_NAME: "ironwrap-bus",
    D1_PRODUCTION_DATABASE_ID: "f0674848-13df-4422-9896-8ba2719663b8",
    D1_R2_BACKUP_BUCKET: "ironwrap-backups-prod",
    D1_BACKUP_RETENTION_DAYS: "30",
    D1_RESTORE_R2_COMPLETED_PREFIX: "d1/ironwrap-bus/20260710T120000Z-1234-5678",
    D1_RESTORE_AGE_IDENTITY_FILE: "/secure/ironwrap/d1-restore-age-identity.txt",
    D1_RESTORE_MODE: "verify",
    D1_RESTORE_TARGET_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
    D1_RESTORE_TARGET_DATABASE_NAME: "ironwrap-restore-drill-monthly",
    D1_RESTORE_TARGET_DATABASE_ID: "83b5835e-24cf-4b52-8f89-e3a822e1c980",
    D1_RESTORE_CONFIRMATION: "",
    RESTORE_R2_COMPLETED_PREFIX: "os.ironwrapexteriors.com/20260710T120000Z-1234-5678",
    RESTORE_AGE_IDENTITY_FILE: "/secure/ironwrap/restore-age-identity.txt",
    RESTORE_TARGET_SITE: "restore-drill.ironwrap.invalid",
    RESTORE_TARGET_CONTAINER: "frappe-restore-drill-1",
    RESTORE_CONFIRMATION: "",
  };
}
