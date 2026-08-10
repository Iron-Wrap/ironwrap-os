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

const TOOL = path.join(DEFAULT_REPO_ROOT, "tools/production-readiness.mjs");
const HOST_PREFLIGHT = path.join(DEFAULT_REPO_ROOT, "deploy/host-preflight.sh");
const BACKUP = path.join(DEFAULT_REPO_ROOT, "deploy/backup-to-r2.sh");
const RESTORE = path.join(DEFAULT_REPO_ROOT, "deploy/restore-from-r2.sh");
const D1_BACKUP = path.join(DEFAULT_REPO_ROOT, "deploy/backup-d1-to-r2.sh");
const D1_RESTORE = path.join(DEFAULT_REPO_ROOT, "deploy/restore-d1-from-r2.sh");
const BUILD = path.join(DEFAULT_REPO_ROOT, "deploy/build-production-image.sh");
const APPROVAL_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({
  type: "spki",
  format: "pem",
});

function validApprovalPublicKeyOptions() {
  return {
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => APPROVAL_PUBLIC_KEY,
  };
}

async function writeApprovalPublicKeyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-approval-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "approval-public.pem");
  await writeFile(file, APPROVAL_PUBLIC_KEY, { mode: 0o600 });
  return file;
}

async function writeExecutable(file, source) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

async function mockBackupEnvironment(t, { failCopy = false, signalCopy = false } = {}) {
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

async function mockRestoreEnvironment(t, {
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

async function stageD1Script(root, source) {
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

const REQUIRED_D1_TABLES = [
  "app_action_throttles", "app_auth_audit", "app_auth_throttles", "app_device_pairings",
  "app_devices", "app_magic_links", "app_sessions", "app_users", "approval_request_events",
  "approval_requests", "audit_log", "customer_portal_acceptance_challenges",
  "customer_portal_acceptance_events", "customer_portal_acceptance_intents",
  "customer_portal_access_throttles", "customer_portal_links", "dead_letter", "dedup_claims",
  "dev_outbox", "envelopes", "facet_customer_approval_events",
  "facet_customer_approval_projection_attempts", "facet_design_event_identity_registry",
  "facet_design_events", "facet_design_evidence_associations", "facet_design_ingest_nonce_registry",
  "facet_design_ingest_nonces", "facet_design_projection_attempts", "field_action_media",
  "field_actions", "field_work_package_actions", "governed_transition_outbox",
  "governed_transition_outbox_events", "governed_transitions", "heartbeat", "lead_ack_receipts",
  "measurement_deltas", "measurement_intake_receipts", "newo_control_actions",
  "newo_event_receipts", "newo_reconciliation_runs", "newo_sessions", "newo_slot_reservations",
  "production_schedule_approval_request_events", "production_schedule_approval_requests",
  "public_estimate_rate_limits", "quickbooks_projection_outbox", "quickbooks_webhook_receipts",
  "quote_revision_approval_request_events", "quote_revision_approval_requests", "replay_requests",
  "source_counts",
];

const REQUIRED_D1_TRIGGER_BINDINGS = [
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
];

function d1TriggerSql(name, table, {
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
} = {}) {
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
  if (name === weakApprovalTrigger) {
    const timing = name.endsWith("_delete") ? "DELETE" : "UPDATE";
    return `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} BEGIN SELECT 1; END;`;
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

function d1Sql({
  missingTable = "",
  missingTrigger = "",
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
} = {}) {
  const tables = REQUIRED_D1_TABLES.filter((name) => name !== missingTable);
  const triggers = REQUIRED_D1_TRIGGER_BINDINGS.filter(([name, table]) => name !== missingTrigger && table !== missingTable);
  return `BEGIN TRANSACTION;\n${tables.map((name, index) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY);\nINSERT INTO ${name} (id) VALUES ('row-${index}');`).join("\n")}\n${triggers.map(([name, table]) => d1TriggerSql(name, table, { weakReceiptTrigger, wrongTimingReceiptTrigger, weakApprovalTrigger, wrongTimingApprovalTrigger })).join("\n")}\nCOMMIT;\n`;
}

async function mockD1BackupEnvironment(t, {
  failCopy = false,
  signalCopy = false,
  missingTable = "",
  missingTrigger = "",
  weakReceiptTrigger = "",
  weakApprovalTrigger = "",
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
printf '%s' "$MOCK_D1_SQL" > "$output"
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

  return {
    root,
    state,
    script: staged.target,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      MOCK_STATE: state,
      MOCK_D1_SQL: d1Sql({ missingTable, missingTrigger, weakReceiptTrigger, weakApprovalTrigger }),
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

async function mockD1RestoreEnvironment(t, {
  badChecksum = false,
  targetCount = 0,
  signalDownload = false,
  missingTable = "",
  rowMismatch = false,
  triggerMismatch = false,
  triggerSemanticsMismatch = false,
  quoteRevisionTriggerSemanticsMismatch = false,
  governedTransitionTriggerSemanticsMismatch = false,
  missingTrigger = "",
  weakReceiptTrigger = "",
  wrongTimingReceiptTrigger = "",
  weakApprovalTrigger = "",
  wrongTimingApprovalTrigger = "",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-d1-restore-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const remote = path.join(root, "remote");
  const packageDir = path.join(root, "package");
  await Promise.all([mkdir(bin), mkdir(state), mkdir(remote), mkdir(packageDir)]);
  const staged = await stageD1Script(root, D1_RESTORE);
  const stamp = "20260710T120000Z";
  const sqlFile = `ironwrap-d1-ironwrap-bus-${stamp}.sql`;
  const sqlPath = path.join(packageDir, sqlFile);
  await writeFile(sqlPath, d1Sql({
    missingTable,
    missingTrigger,
    weakReceiptTrigger,
    wrongTimingReceiptTrigger,
    weakApprovalTrigger,
    wrongTimingApprovalTrigger,
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

  const matchingRows = JSON.stringify([{
    results: REQUIRED_D1_TABLES.map((table_name) => ({ table_name, row_count: 1 })),
    success: true,
  }]);
  const mismatchedRows = JSON.stringify([{
    results: REQUIRED_D1_TABLES.map((table_name, index) => ({ table_name, row_count: index === 0 ? 2 : 1 })),
    success: true,
  }]);
  const matchingTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name),
    })),
    success: true,
  }]);
  const mismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name], index) => ({
      trigger_name,
      table_name: index === 0 ? "lead_ack_receipts" : table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name),
    })),
    success: true,
  }]);
  const semanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingReceiptTrigger: "prevent_lead_ack_receipts_update" }),
    })),
    success: true,
  }]);
  const quoteRevisionSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingApprovalTrigger: "prevent_quote_revision_approval_event_update" }),
    })),
    success: true,
  }]);
  const governedTransitionSemanticallyMismatchedTriggers = JSON.stringify([{
    results: REQUIRED_D1_TRIGGER_BINDINGS.map(([trigger_name, table_name]) => ({
      trigger_name,
      table_name,
      trigger_sql: d1TriggerSql(trigger_name, table_name, { wrongTimingApprovalTrigger: "prevent_governed_transition_outbox_event_update" }),
    })),
    success: true,
  }]);

  await writeExecutable(path.join(staged.workerBin, "wrangler"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '4.110.0\\n'; exit 0; fi
[[ "\${CLOUDFLARE_API_TOKEN:-}" == 'cloudflare_d1_restore_write_91e6a4c8f02b735d' ]] || exit 77
printf '%s\\n' "$*" >> "$MOCK_STATE/wrangler.log"
file=''; config=''; json=0
while (( $# > 0 )); do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) shift ;;
  esac
done
if [[ -n "$config" ]]; then /bin/cp "$config" "$MOCK_STATE/target-config.json"; fi
if (( json == 1 )); then
  if [[ "$file" == *target-preflight.sql ]]; then
    printf '[{"results":[{"table_count":%s}],"success":true}]\\n' "$MOCK_TARGET_COUNT"
  elif [[ "$file" == *target-verify.sql ]]; then
    if [[ "$MOCK_ROW_MISMATCH" == '1' ]]; then printf '%s\\n' '${mismatchedRows}'; else printf '%s\\n' '${matchingRows}'; fi
  elif [[ "$file" == *target-trigger-verify.sql ]]; then
    if [[ "$MOCK_GOVERNED_TRANSITION_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then printf '%s\\n' '${governedTransitionSemanticallyMismatchedTriggers}'; elif [[ "$MOCK_QUOTE_REVISION_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then printf '%s\\n' '${quoteRevisionSemanticallyMismatchedTriggers}'; elif [[ "$MOCK_TRIGGER_SEMANTICS_MISMATCH" == '1' ]]; then printf '%s\\n' '${semanticallyMismatchedTriggers}'; elif [[ "$MOCK_TRIGGER_MISMATCH" == '1' ]]; then printf '%s\\n' '${mismatchedTriggers}'; else printf '%s\\n' '${matchingTriggers}'; fi
  fi
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
      MOCK_TARGET_COUNT: String(targetCount),
      MOCK_SIGNAL_DOWNLOAD: signalDownload ? "1" : "0",
      MOCK_ROW_MISMATCH: rowMismatch ? "1" : "0",
      MOCK_TRIGGER_MISMATCH: triggerMismatch ? "1" : "0",
      MOCK_TRIGGER_SEMANTICS_MISMATCH: triggerSemanticsMismatch ? "1" : "0",
      MOCK_QUOTE_REVISION_TRIGGER_SEMANTICS_MISMATCH: quoteRevisionTriggerSemanticsMismatch ? "1" : "0",
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

function validLiveEnv() {
  const adminToken = "admin_7f9e4c21b6a348d5a8f0c2e4";
  return {
    FRAPPE_VERSION: "v15.114.0",
    FRAPPE_COMMIT: "105b17938839f4e5c6cdff817d42afc40c3bcc32",
    FRAPPE_DOCKER_VERSION: "v3.2.1",
    FRAPPE_DOCKER_COMMIT: "d4a310089f5d6fc38ed1317b898d75b9c74901db",
    HERMES_VERSION: "v2026.7.7.2",
    HERMES_COMMIT: "9de9c25f620ff7f1ce0fd5457d596052d5159596",
    IRONWRAP_OS_IMAGE: `registry.ironwrap.internal/ironwrap-os:prod@sha256:${"a".repeat(64)}`,
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://os.ironwrapexteriors.com",
    ERPNEXT_API_KEY: "frappe_key_8c921",
    ERPNEXT_API_SECRET: "frappe_secret_d1a9f80c42",
    ERPNEXT_INTEGRATION_USER: "worker@ironwrapexteriors.com",
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

test("repository deployment contract is complete and Frappe-only", async () => {
  const result = await validateContract();
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.summary.failed, 0);
});

test("contract mode rejects a self-consistent D1 allowlist that omits a migration table", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), {
    recursive: true,
    preserveTimestamps: true,
  });
  await mkdir(path.join(root, "workers-bus"), { recursive: true });
  await cp(
    path.join(DEFAULT_REPO_ROOT, "workers-bus/migrations"),
    path.join(root, "workers-bus/migrations"),
    { recursive: true, preserveTimestamps: true },
  );
  const backupPath = path.join(root, "deploy/backup-d1-to-r2.sh");
  const backup = await readFile(backupPath, "utf8");
  await writeFile(
    backupPath,
    backup
      .replace(",facet_design_evidence_associations", "")
      .replace("REQUIRED_TABLE_COUNT=52", "REQUIRED_TABLE_COUNT=51"),
  );

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.d1.schema_inventory")?.status, "fail");
});

test("contract mode rejects a floating runtime reference", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.components.hermes.version = "main";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.lock.hermes.version")?.status, "fail");
});

test("contract mode rejects a Node.js floor below the PWA requirement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.host_requirements.node_version_minimum = "22.11.9";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.lock.host")?.status, "fail");
});

test("contract mode rejects an overridable container pin", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const containerfilePath = path.join(root, "deploy/Containerfile.frappe");
  const containerfile = await readFile(containerfilePath, "utf8");
  await writeFile(containerfilePath, `${containerfile}\nARG FRAPPE_BASE_IMAGE\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.container.non_overridable")?.status, "fail");
});

test("contract mode rejects a committed lead-broker secret", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const envPath = path.join(root, "deploy/env.example");
  const env = await readFile(envPath, "utf8");
  await writeFile(
    envPath,
    env.replace(
      "APPROVAL_BROKER_SHARED_SECRET=<unique-at-least-32-byte-worker-broker-secret>",
      "APPROVAL_BROKER_SHARED_SECRET=committed-secret-must-never-be-here",
    ),
  );

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.env.secret.APPROVAL_BROKER_SHARED_SECRET")?.status, "fail");
});

test("contract mode requires the launch-proof Frappe configuration inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const envPath = path.join(root, "deploy/env.example");
  const env = await readFile(envPath, "utf8");
  await writeFile(envPath, env.replace(/^FRAPPE_API_SECRET=.*\n/m, ""));

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.env.FRAPPE_API_SECRET")?.status, "fail");
});

test("live-env mode accepts a complete locked production environment", async () => {
  const result = await validateLiveEnv({ env: validLiveEnv(), ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.summary.failed, 0);
});

test("live-env mode requires a concrete realm and dedicated QuickBooks issuer", async () => {
  const env = validLiveEnv();
  env.QB_EXPECTED_REALM_ID = "not-a-realm";
  env.QB_RECONCILIATION_ISSUER_USER = env.ERPNEXT_INTEGRATION_USER;
  env.IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER = env.ERPNEXT_INTEGRATION_USER;
  env.QB_RECONCILIATION_ISSUER_API_KEY = env.ERPNEXT_API_KEY;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of ["live.quickbooks.realm", "live.quickbooks.issuer", "live.secret.separation"]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode requires dedicated bounded launch-proof credentials", async () => {
  const env = validLiveEnv();
  env.FRAPPE_BASE_URL = "https://other.ironwrapexteriors.com";
  env.FRAPPE_API_SECRET = env.ERPNEXT_API_SECRET;
  env.FRAPPE_PROOF_POLL_ATTEMPTS = "6";
  env.FRAPPE_PROOF_POLL_INTERVAL_MS = "5001";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.launch_proof.base_url_consistency",
    "live.secret.separation",
    "live.launch_proof.poll_attempts",
    "live.launch_proof.poll_interval",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail");
  }
});

test("live-env mode accepts an explicitly disabled public estimator without its enable-time secrets", async () => {
  const env = validLiveEnv();
  env.PUBLIC_ESTIMATE_ENABLED = "false";
  for (const name of [
    "ERPNEXT_INTEGRATION_USER",
    "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
    "PUBLIC_ESTIMATE_ALLOWED_BRANDS",
    "PUBLIC_ESTIMATE_CONSENT_JURISDICTION",
    "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY",
    "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
    "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
    "PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS",
    "PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX",
    "PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX",
    "PUBLIC_ESTIMATE_RANGE_RULES_JSON",
  ]) delete env[name];

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.checks.find((item) => item.id === "live.gate.public_estimate")?.status, "pass");
  assert.equal(result.checks.find((item) => item.id === "live.secret.PUBLIC_ESTIMATE_TURNSTILE_SECRET"), undefined);
});

test("live-env mode validates every enabled Facet integration rail", async () => {
  const env = validLiveEnv();
  Object.assign(env, {
    FACET_DESIGN_INGEST_ENABLED: "true",
    FACET_DESIGN_INGEST_SOURCE_TENANT_ID: "facet-production",
    FACET_DESIGN_INGEST_TENANT_MAP_JSON: JSON.stringify({
      "facet-production": { tenant_id: "ironwrap", brand_ids: ["ironwrap", "iroof"] },
    }),
    FACET_DESIGN_INGEST_HMAC_KEY: "facet_ingest_hmac_4c1b9e2f8a7d6c5b4a392817",
    FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "true",
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: "facet_projection_hmac_7d6c5b4a3928171615141312",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: "facet_projection_key_8c921",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: "facet_projection_secret_d1a9f80c42",
    APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "true",
    APP_QUOTE_REVISION_BROKER_URL: "https://quote-revision-broker.ironwrapexteriors.com",
    APP_QUOTE_REVISION_BROKER_KEY_ID: "quote-revision-v1",
    APP_QUOTE_REVISION_BROKER_TIMEOUT_MS: "15000",
    APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS: "45",
    QUOTE_REVISION_BROKER_SHARED_SECRET: "quote_revision_broker_9f1a4c27d8e6b5a493827161",
  });

  const enabled = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(enabled.ok, true, renderHuman(enabled));

  env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({
    "facet-staging": { tenant_id: "ironwrap", brand_ids: ["ironwrap"] },
  });
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = env.FACET_DESIGN_INGEST_HMAC_KEY;
  env.APP_QUOTE_REVISION_BROKER_URL = "http://quote-revision-broker.ironwrapexteriors.com";
  env.APP_QUOTE_REVISION_BROKER_TIMEOUT_MS = "999";
  const invalid = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(invalid.ok, false);
  for (const id of [
    "live.facet.ingest_tenant_map",
    "live.secret.separation",
    "live.facet.quote_revision_broker_url",
    "live.facet.quote_revision_broker_bounds",
  ]) {
    assert.equal(invalid.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode fails closed when public-estimator controls drift from the tenant contract", async () => {
  const env = validLiveEnv();
  env.PUBLIC_ESTIMATE_ALLOWED_ORIGINS = "https://marketing.ironwrapexteriors.com";
  env.PUBLIC_ESTIMATE_ALLOWED_BRANDS = "ironwrap,other";
  env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION = "Unspecified";
  env.PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX = "101";
  env.PUBLIC_ESTIMATE_RANGE_RULES_JSON = JSON.stringify([{
    rule_id: "wrong-service-v1",
    brand: "ironwrap",
    service: "invented_service",
    province: "AB",
    min_cad: 100,
    max_cad: 200,
  }]);

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.public_estimate.origin",
    "live.public_estimate.brands",
    "live.public_estimate.jurisdiction",
    "live.public_estimate.rate_limits",
    "live.public_estimate.rules",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode requires a readable Ed25519 approval public key", async () => {
  const env = validLiveEnv();
  const malformed = await validateLiveEnv({
    env,
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => "not a PEM public key",
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.checks.find((item) => item.id === "live.hermes.approval_public_key")?.status, "fail");

  const rsaPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "pem",
  });
  const wrongType = await validateLiveEnv({
    env,
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => rsaPublicKey,
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.checks.find((item) => item.id === "live.hermes.approval_public_key")?.status, "fail");
});

test("live-env mode refuses to trust an invalid repository contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.policy.erpnext = "allowed";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateLiveEnv({ env: validLiveEnv(), repoRoot: root, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "live.contract")?.status, "fail");
});

test("live-env mode fails closed on placeholders, HTTP URLs, and implicit gates", async () => {
  const env = validLiveEnv();
  env.ERPNEXT_API_SECRET = "<frappe-api-secret>";
  env.ERPNEXT_BASE_URL = "http://os.ironwrapexteriors.com";
  env.ERPNEXT_WRITE_ENABLED = "yes";
  env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS = "0";
  env.BACKUP_AGE_RECIPIENT = "<age-recipient>";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.env.ERPNEXT_API_SECRET",
    "live.url.ERPNEXT_BASE_URL",
    "live.gate.ERPNEXT_WRITE_ENABLED",
    "live.timeout.IRONWRAP_BUS_REQUEST_TIMEOUT_MS",
    "live.backup.encryption",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode binds Frappe receipt verification to a safe public key path and matching site URL", async () => {
  const env = validLiveEnv();
  env.IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE = "/run/secrets/../approval-public.pem";
  env.IRONWRAP_HERMES_SITE_BASE_URL = "https://other.ironwrapexteriors.com";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.frappe.approval_public_key_path",
    "live.frappe.site_base_url_consistency",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode aligns backup inputs with the executable backup contract", async () => {
  const env = validLiveEnv();
  env.RCLONE_CONFIG_R2_ENDPOINT = "https://a1b2c3d4.r2.cloudflarestorage.com/unexpected";
  env.BACKUP_RETENTION_DAYS = "30.0";
  env.FRAPPE_SITE = "other.ironwrapexteriors.com";
  env.HERMES_WRITE_TOKEN = env.ERPNEXT_API_SECRET;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.backup.endpoint",
    "live.backup.retention",
    "live.url.site_consistency",
    "live.secret.separation",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode binds D1 recovery to exact source, separated authority, and non-production defaults", async () => {
  const env = validLiveEnv();
  env.D1_PRODUCTION_DATABASE_ID = env.D1_RESTORE_TARGET_DATABASE_ID;
  env.D1_BACKUP_API_TOKEN = env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY;
  env.D1_RESTORE_API_TOKEN = env.RCLONE_CONFIG_R2_ACCESS_KEY_ID;
  env.D1_RESTORE_R2_COMPLETED_PREFIX = "d1/other/latest";
  env.D1_RESTORE_MODE = "remote";
  env.D1_RESTORE_TARGET_DATABASE_ID = "f0674848-13df-4422-9896-8ba2719663b8";
  env.D1_RESTORE_CONFIRMATION = "RESTORE_D1:unsafe";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.d1.source.id",
    "live.secret.separation",
    "live.secret.d1_restore_ephemeral",
    "live.d1.restore_prefix",
    "live.d1.restore_mode",
    "live.d1.target_id",
    "live.d1.confirmation",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("validator output never includes supplied secret values", async () => {
  const env = validLiveEnv();
  const secretValue = "do-not-print-this-sensitive-value";
  env.ADMIN_TOKEN = secretValue;
  env.IRONWRAP_ADMIN_TOKEN = secretValue;
  env.D1_BACKUP_API_TOKEN = secretValue;
  env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = secretValue;
  env.ERPNEXT_BASE_URL = `https://${secretValue}@os.ironwrapexteriors.com`;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secretValue), false);
  assert.equal(renderHuman(result).includes(secretValue), false);
});

test("CLI emits machine-readable JSON and an accurate exit code", () => {
  const run = spawnSync(process.execPath, [TOOL, "contract", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.mode, "contract");
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
});

test("live-env CLI supports JSON and human output modes", async (t) => {
  const approvalPublicKeyFile = await writeApprovalPublicKeyFixture(t);
  const env = { ...process.env, ...validLiveEnv(), HERMES_APPROVAL_PUBLIC_KEY_FILE: approvalPublicKeyFile };
  const jsonRun = spawnSync(process.execPath, [TOOL, "live-env", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const result = JSON.parse(jsonRun.stdout);
  assert.equal(result.mode, "live-env");
  assert.equal(result.ok, true);

  const humanRun = spawnSync(process.execPath, [TOOL, "live-env"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, /READY: \d+ passed, 0 failed/);
});

test("live-env CLI fails closed without printing a supplied secret", async (t) => {
  const secretValue = "cli-secret-that-must-never-be-printed";
  const approvalPublicKeyFile = await writeApprovalPublicKeyFixture(t);
  const env = {
    ...process.env,
    ...validLiveEnv(),
    HERMES_APPROVAL_PUBLIC_KEY_FILE: approvalPublicKeyFile,
    ERPNEXT_API_SECRET: secretValue,
    ERPNEXT_BASE_URL: `https://${secretValue}@os.ironwrapexteriors.com`,
  };
  const run = spawnSync(process.execPath, [TOOL, "live-env", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 1);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
  assert.equal(JSON.parse(run.stdout).ok, false);
});

test("backup commits its completion marker only after upload verification", async (t) => {
  const mock = await mockBackupEnvironment(t);
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations.slice(0, 3), ["copy", "check", "copyto"]);
  assert.deepEqual(operations.slice(3), ["delete", "delete", "rmdirs"]);
  assert.equal(operations.includes("purge"), false);
  assert.match(run.stdout, /restore-ready Frappe backup committed and verified/);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup purges an incomplete remote prefix and local plaintext on failure", async (t) => {
  const mock = await mockBackupEnvironment(t, { failCopy: true });
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  const output = `${run.stdout}${run.stderr}`;
  for (const name of ["RCLONE_CONFIG_R2_ACCESS_KEY_ID", "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY"]) {
    assert.equal(output.includes(mock.env[name]), false, name);
  }
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup signal traps exit and purge the incomplete remote prefix", async (t) => {
  const mock = await mockBackupEnvironment(t, { signalCopy: true });
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 143, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup rejects configuration in argv without echoing it", () => {
  const secretValue = "backup-argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [BACKUP, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});

test("restore verification validates a completed encrypted package without mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /cryptographically verified.*no restore mutation performed/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* (?:mktemp|bench|rm -rf)(?: |$)/.test(` ${line}`)), false, dockerOperations.join("\n"));
  assert.deepEqual((await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n"), ["cat", "copyto", "copyto"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore mode targets only an isolated site, merges only the source encryption key, migrates, and cleans staging", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_CONFIRMATION = `RESTORE:${mock.env.RESTORE_TARGET_SITE}@${mock.env.RESTORE_TARGET_CONTAINER}`;
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /isolated restore and migration completed/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.filter((line) => line.startsWith("cp ")).length, 4);
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") && line.includes("site_config_backup")), false);
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") && line.includes("IRONWRAP-RESTORE-ENCRYPTION-KEY.json")), true);
  assert.equal(dockerOperations.some((line) => line.includes(`bench --site ${mock.env.RESTORE_TARGET_SITE} restore `)), true);
  assert.equal(dockerOperations.some((line) => line.includes("python3 -c") && line.includes("encryption_key") && line.includes("site_config.json")), true);
  assert.equal(dockerOperations.some((line) => line.includes(`bench --site ${mock.env.RESTORE_TARGET_SITE} migrate`)), true);
  assert.equal(dockerOperations.at(-1)?.includes("rm -rf -- /tmp/ironwrap-restore.Mock1234"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore mode rejects a target-unbound confirmation before package download", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_CONFIRMATION = "RESTORE:wrong.example@wrong-container";
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /confirmation.*not bound/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("restore can never target the recorded production site or container", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_TARGET_SITE = mock.env.FRAPPE_SITE;
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /production site can never be a restore target/);
  await assert.rejects(readFile(path.join(mock.state, "docker.log"), "utf8"));
});

test("restore rejects an unpinned target image and a target without non-interactive database authority", async (t) => {
  const wrongImage = await mockRestoreEnvironment(t, { targetImageMismatch: true });
  const imageRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: wrongImage.env });
  assert.notEqual(imageRun.status, 0);
  assert.match(imageRun.stderr, /target container image does not match/);

  const missingRoot = await mockRestoreEnvironment(t, { targetRootReady: false });
  const rootRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: missingRoot.env });
  assert.notEqual(rootRun.status, 0);
  assert.match(rootRun.stderr, /non-interactive target-only root credential/);
  await assert.rejects(readFile(path.join(missingRoot.state, "rclone.log"), "utf8"));
});

test("restore rejects targets with an external Docker network or published host ports", async (t) => {
  const externalNetwork = await mockRestoreEnvironment(t, { targetNetworkInternal: false });
  const networkRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: externalNetwork.env });
  assert.notEqual(networkRun.status, 0);
  assert.match(networkRun.stderr, /Docker network must be internal/);
  await assert.rejects(readFile(path.join(externalNetwork.state, "rclone.log"), "utf8"));

  const publishedPorts = await mockRestoreEnvironment(t, { targetPortsPublished: true });
  const portRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: publishedPorts.env });
  assert.notEqual(portRun.status, 0);
  assert.match(portRun.stderr, /must not publish host ports/);
  await assert.rejects(readFile(path.join(publishedPorts.state, "rclone.log"), "utf8"));
});

test("restore rejects a bad remote checksum before decryption and mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t, { badChecksum: true });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  await assert.rejects(readFile(path.join(mock.state, "age.log"), "utf8"));
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("restore rejects manifest source-site mismatch without mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t, { manifestSite: "other.example.com" });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /manifest schema, source site, timestamp, format, or image does not match/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("restore rejects archive links and unexpected files before extraction", async (t) => {
  const mock = await mockRestoreEnvironment(t, { archiveLink: true });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /links, directories, and non-regular entries are forbidden/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("failed bench restore cleans container and host plaintext", async (t) => {
  const mock = await mockRestoreEnvironment(t, { failRestore: true });
  mock.env.RESTORE_CONFIRMATION = `RESTORE:${mock.env.RESTORE_TARGET_SITE}@${mock.env.RESTORE_TARGET_CONTAINER}`;
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 19, `${run.stdout}${run.stderr}`);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.includes(" bench ") && line.includes(" restore ")), true);
  assert.equal(dockerOperations.at(-1)?.includes("rm -rf -- /tmp/ironwrap-restore.Mock1234"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore rejects missing completion markers and configuration in argv", async (t) => {
  const mock = await mockRestoreEnvironment(t, { markerPresent: false });
  const missing = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no readable completion marker/);

  const secretValue = "restore-argv-secret-that-must-not-be-printed";
  const argv = spawnSync("bash", [RESTORE, "--restore", secretValue], { encoding: "utf8", env: mock.env });
  assert.equal(argv.status, 64);
  assert.equal(`${argv.stdout}${argv.stderr}`.includes(secretValue), false);
});

test("D1 backup exports through locked Wrangler, validates SQL, and commits its marker last", async (t) => {
  const mock = await mockD1BackupEnvironment(t);
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /exact production D1 export validated, encrypted, committed/);
  const wrangler = await readFile(path.join(mock.state, "wrangler.log"), "utf8");
  assert.match(wrangler, /^d1 export ironwrap-bus --remote --config .* --output /m);
  assert.equal(wrangler.includes(mock.env.D1_BACKUP_API_TOKEN), false);
  const config = JSON.parse(await readFile(path.join(mock.state, "source-config.json"), "utf8"));
  assert.equal(config.account_id, mock.env.D1_PRODUCTION_ACCOUNT_ID);
  assert.deepEqual(config.d1_databases, [{
    binding: "BACKUP_SOURCE",
    database_name: mock.env.D1_PRODUCTION_DATABASE_NAME,
    database_id: mock.env.D1_PRODUCTION_DATABASE_ID,
  }]);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations.slice(0, 3), ["copy", "check", "copyto"]);
  assert.equal(operations.indexOf("delete") > operations.indexOf("copyto"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup fails before upload when a required customer-portal table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "customer_portal_links" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: customer_portal_links/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup fails before upload when a production-schedule ledger table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "production_schedule_approval_request_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: production_schedule_approval_request_events/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the privacy-safe public-estimate rate-limit table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "public_estimate_rate_limits" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: public_estimate_rate_limits/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the governed-transition outbox evidence table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "governed_transition_outbox_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: governed_transition_outbox_events/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the field Work Package action ledger is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "field_work_package_actions" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: field_work_package_actions/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the durable QuickBooks projection outbox is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "quickbooks_projection_outbox" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when an invariant trigger is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTrigger: "prevent_lead_ack_receipts_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required invariant trigger: prevent_lead_ack_receipts_delete on lead_ack_receipts/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup rejects a named receipt trigger without immutable update/delete semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakReceiptTrigger: "prevent_lead_ack_receipts_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable receipt trigger semantics: prevent_lead_ack_receipts_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects a quote-revision ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakApprovalTrigger: "prevent_quote_revision_approval_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_quote_revision_approval_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects a governed-transition event trigger without immutable semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakApprovalTrigger: "prevent_governed_transition_outbox_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_governed_transition_outbox_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup purges incomplete remote state and plaintext on upload failure", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { failCopy: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 9, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup signal trap exits, purges incomplete objects, and removes plaintext", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { signalCopy: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 143, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 recovery defaults to local cryptographic and SQLite verification without remote mutation", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /no remote mutation performed/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-restore.")), false);
});

test("remote D1 drill uses exact generated target config and verifies restored tables and triggers", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /exact confirmed non-production drill database/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 4);
  assert.equal(operations.every((line) => line.startsWith(`d1 execute ${mock.env.D1_RESTORE_TARGET_DATABASE_NAME} --remote`)), true);
  assert.equal(operations.join("\n").includes(mock.env.D1_RESTORE_API_TOKEN), false);
  const config = JSON.parse(await readFile(path.join(mock.state, "target-config.json"), "utf8"));
  assert.equal(config.account_id, mock.env.D1_RESTORE_TARGET_ACCOUNT_ID);
  assert.deepEqual(config.d1_databases, [{
    binding: "RESTORE_TARGET",
    database_name: mock.env.D1_RESTORE_TARGET_DATABASE_NAME,
    database_id: mock.env.D1_RESTORE_TARGET_DATABASE_ID,
  }]);
});

test("remote D1 drill rejects reused backup, restore, or R2 authority before download", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = mock.env.D1_BACKUP_API_TOKEN;
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /pairwise distinct/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("remote D1 drill rejects production, unconfirmed, and nonempty targets before import", async (t) => {
  const production = await mockD1RestoreEnvironment(t);
  production.env.D1_RESTORE_MODE = "remote";
  production.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  production.env.D1_RESTORE_TARGET_DATABASE_NAME = production.env.D1_PRODUCTION_DATABASE_NAME;
  production.env.D1_RESTORE_TARGET_DATABASE_ID = production.env.D1_PRODUCTION_DATABASE_ID;
  production.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${production.env.D1_RESTORE_TARGET_DATABASE_NAME}@${production.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const productionRun = spawnSync("bash", [production.script], { encoding: "utf8", env: production.env });
  assert.notEqual(productionRun.status, 0);
  assert.match(productionRun.stderr, /name or UUID is unsafe|production D1 database can never/);
  await assert.rejects(readFile(path.join(production.state, "rclone.log"), "utf8"));

  const unconfirmed = await mockD1RestoreEnvironment(t);
  unconfirmed.env.D1_RESTORE_MODE = "remote";
  unconfirmed.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  unconfirmed.env.D1_RESTORE_CONFIRMATION = "RESTORE_D1:wrong@00000000-0000-4000-8000-000000000000";
  const unconfirmedRun = spawnSync("bash", [unconfirmed.script], { encoding: "utf8", env: unconfirmed.env });
  assert.notEqual(unconfirmedRun.status, 0);
  assert.match(unconfirmedRun.stderr, /confirmation is not bound/);
  await assert.rejects(readFile(path.join(unconfirmed.state, "rclone.log"), "utf8"));

  const nonempty = await mockD1RestoreEnvironment(t, { targetCount: 1 });
  nonempty.env.D1_RESTORE_MODE = "remote";
  nonempty.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  nonempty.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${nonempty.env.D1_RESTORE_TARGET_DATABASE_NAME}@${nonempty.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const nonemptyRun = spawnSync("bash", [nonempty.script], { encoding: "utf8", env: nonempty.env });
  assert.notEqual(nonemptyRun.status, 0);
  assert.match(nonemptyRun.stderr, /empty dedicated drill database/);
  const operations = (await readFile(path.join(nonempty.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 1);
});

test("remote D1 drill fails when any restored production-table row count differs", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { rowMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /table row counts differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 3);
});

test("D1 recovery rejects an export missing a required invariant trigger", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTrigger: "prevent_lead_ack_receipts_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required invariant trigger: prevent_lead_ack_receipts_update on lead_ack_receipts/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing a required customer-portal table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "customer_portal_access_throttles" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: customer_portal_access_throttles/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the privacy-safe public-estimate rate-limit table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "public_estimate_rate_limits" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: public_estimate_rate_limits/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the governed-transition outbox evidence table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "governed_transition_outbox_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: governed_transition_outbox_events/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the field Work Package action ledger", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "field_work_package_actions" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: field_work_package_actions/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the durable QuickBooks projection outbox", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "quickbooks_projection_outbox" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local receipt trigger without immutable update/delete semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakReceiptTrigger: "prevent_lead_ack_receipts_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable receipt trigger semantics: prevent_lead_ack_receipts_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local quote-revision ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_quote_revision_approval_event_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_quote_revision_approval_event_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local production-schedule ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_production_schedule_approval_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_production_schedule_approval_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a governed-transition outbox event trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_governed_transition_outbox_event_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_governed_transition_outbox_event_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("remote D1 drill fails when named invariant-trigger inventory differs", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { triggerMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or receipt semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 4);
});

test("remote D1 drill rejects receipt triggers without immutable update/delete semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { triggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or receipt semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 4);
});

test("remote D1 drill rejects quote-revision ledger triggers without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { quoteRevisionTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or receipt semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 4);
});

test("remote D1 drill rejects governed-transition outbox event triggers without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { governedTransitionTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or receipt semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 4);
});

test("D1 recovery rejects bad ciphertext checksums and signal-cleans decrypted workspace", async (t) => {
  const bad = await mockD1RestoreEnvironment(t, { badChecksum: true });
  const badRun = spawnSync("bash", [bad.script], { encoding: "utf8", env: bad.env });
  assert.notEqual(badRun.status, 0);
  await assert.rejects(readFile(path.join(bad.state, "age.log"), "utf8"));

  const signalled = await mockD1RestoreEnvironment(t, { signalDownload: true });
  const signalRun = spawnSync("bash", [signalled.script], { encoding: "utf8", env: signalled.env });
  assert.equal(signalRun.status, 143, `${signalRun.stdout}${signalRun.stderr}`);
  assert.equal((await readdir(signalled.root)).some((entry) => entry.startsWith("ironwrap-d1-restore.")), false);
});

test("D1 recovery commands reject argv without echoing supplied values", () => {
  const secretValue = "d1-argv-secret-that-must-not-be-printed";
  for (const script of [D1_BACKUP, D1_RESTORE]) {
    const run = spawnSync("bash", [script, secretValue], { encoding: "utf8" });
    assert.equal(run.status, 64);
    assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
  }
});

test("image build rejects configuration in argv without echoing it", () => {
  const secretValue = "build-argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [BUILD, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});

test("host preflight rejects configuration in argv without echoing it", () => {
  const secretValue = "argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [HOST_PREFLIGHT, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});
