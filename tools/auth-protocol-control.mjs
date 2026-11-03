// Auth-control is a new private control writer, not the retired release-issuer.
// Only the protected, captured predecessor may call this adapter with writer credentials.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  canonicalV2,
  validateControlHead,
} from "../shared/auth-protocol-v2.mjs";
import {
  readControlObject,
  putControlObject,
} from "../shared/auth-control-s3.mjs";
import {
  computeEnvironmentConfigDigest,
  computeSourceEvidence,
  validateProviderTargetPolicy,
  validateWorkerVersionReadback,
} from "./release-permit.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const execFile = promisify(execFileCallback);
const verified = new WeakSet();
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = "Iron-Wrap/ironwrap-os";
// Captured tool-only P0 warmup can own this executable closure without pretending that
// the future candidate's Worker auth runtime already exists in the predecessor tree.
export const AUTH_CONTROL_WRITER_POLICY_FILES = Object.freeze([
  "tools/auth-protocol-control.mjs",
  "tools/release-permit.mjs",
  "tools/release-promotion.mjs",
  "tools/canonical-json.mjs",
  "tools/wrangler-vars.mjs",
  "shared/auth-protocol-v2.mjs",
  "shared/auth-protocol-v2.d.mts",
  "shared/auth-protocol-v2.contract.json",
  "shared/auth-protocol-v2.vectors.json",
  "shared/auth-control-s3.mjs",
  "shared/auth-control-s3.d.mts",
  "deploy/release-provider-policy.json",
]);
export const AUTH_PROTOCOL_POLICY_FILES = Object.freeze([
  ...AUTH_CONTROL_WRITER_POLICY_FILES,
  "workers-bus/src/auth-protocol-control.ts",
  "workers-bus/src/auth-protocol-api.ts",
  "workers-bus/src/auth-protocol-store.ts",
  "workers-bus/src/app-auth.ts",
  "workers-bus/src/app-auth-store.ts",
  "workers-bus/src/app-api.ts",
  "workers-bus/src/app-types.ts",
  "workers-bus/src/secret-bindings.d.ts",
  "workers-bus/wrangler.jsonc",
  "workers-bus/migrations/0173_app_auth_protocol_v2.sql",
]);
const READER_NAMES = [
  "AUTH_CONTROL_READ_ACCESS_KEY_ID",
  "AUTH_CONTROL_READ_SECRET_ACCESS_KEY",
];
const WRITER_NAMES = [
  "RELEASE_AUTH_CONTROL_R2_ACCESS_KEY_ID",
  "RELEASE_AUTH_CONTROL_R2_SECRET_ACCESS_KEY",
];
const fail = (code) => {
  throw new Error(`auth_control_${code}`);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("evidence_invalid");
  return value;
}
async function git(root, args) {
  return (
    await execFile("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();
}

function requireLegacyDeployment(deployment, bindings) {
  const legacy = bindings.filter((binding) => binding.protocol === 1);
  if (
    legacy.length !== 1 ||
    deployment.versions.length !== 1 ||
    deployment.versions[0].version_id !== legacy[0].versionId ||
    deployment.versions[0].percentage !== 100
  )
    fail("legacy_predecessor_not_current");
}

async function requirePristineBootstrapMirror(account, database, token, fetcher) {
  const mirror = await d1Query(
    account,
    database,
    `SELECT p.*,
      (SELECT count(*) FROM app_auth_contexts WHERE generation>0) AS enrolled_contexts
      FROM app_auth_protocol p WHERE singleton=1`,
    [],
    token,
    fetcher,
  );
  const row = mirror.results?.[0];
  // A one-time genesis authorization is not recovery from a missing external head.
  // Any prior D1 lineage must use the reviewed isolated-restore procedure instead.
  if (
    !row ||
    row.protocol_floor !== 1 ||
    row.mode !== "staged" ||
    row.control_revision !== 0 ||
    row.issuer !== null ||
    row.activation_id !== null ||
    row.database_identity !== null ||
    row.enrollment_open !== 0 ||
    row.enrolled_contexts !== 0
  )
    fail("genesis_not_preactivation");
}

export async function authProtocolComponentManifest(
  root,
  sourceCommit = "HEAD",
) {
  const source = await git(root, ["rev-parse", `${sourceCommit}^{commit}`]);
  const listing = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    source,
    "--",
    "workers-bus",
    "shared",
    ...AUTH_PROTOCOL_POLICY_FILES,
  ]);
  const leaves = [];
  for (const line of listing.split("\n").filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) fail("component_leaf_invalid");
    leaves.push({ path: match[3], mode: match[1], gitBlob: match[2] });
  }
  for (const required of AUTH_PROTOCOL_POLICY_FILES)
    if (!leaves.some((x) => x.path === required))
      fail("component_closure_missing");
  return { sourceCommit: source, leaves, digest: hash(canonicalV2(leaves)) };
}

// The only constructor for a write authorization performs real source/provider/CI adapters.
// Tests may replace HTTP transport; such local results are never completed qualification.
export async function authorizeAuthControl({
  policyRoot,
  expectedPolicyCommit,
  candidateRoots,
  environment,
  bindings,
  bootstrap = false,
  qualification = null,
  fetcher = globalThis.fetch,
  githubToken,
  providerToken,
}) {
  if (
    !["qa", "production"].includes(environment) ||
    !COMMIT.test(expectedPolicyCommit)
  )
    fail("environment_invalid");
  const ownRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  if (
    (await realpath(policyRoot)) !== (await realpath(ownRoot)) ||
    (await git(policyRoot, ["rev-parse", "HEAD"])) !== expectedPolicyCommit ||
    (await git(policyRoot, ["status", "--porcelain"])) !== ""
  )
    fail("trusted_predecessor_required");
  for (const relative of AUTH_CONTROL_WRITER_POLICY_FILES) {
    const tracked = await execFile(
      "git",
      ["show", `${expectedPolicyCommit}:${relative}`],
      { cwd: policyRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    if (
      hash(tracked.stdout) !==
      hash(await readFile(path.join(policyRoot, relative)))
    )
      fail("trusted_closure_drift");
  }
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 16)
    fail("bindings_invalid");
  const checked = [];
  for (const binding of bindings) {
    const b = record(binding);
    const root = candidateRoots[b.versionId];
    if (typeof root !== "string") fail("source_root_missing");
    if (
      !COMMIT.test(b.sourceCommit) ||
      (await git(root, ["rev-parse", "HEAD"])) !== b.sourceCommit
    )
      fail("source_identity_drift");
    const source = await computeSourceEvidence({
      repoRoot: root,
      sourceCommit: b.sourceCommit,
      baseCommit: b.baseCommit,
    });
    const config = await computeEnvironmentConfigDigest({
      repoRoot: root,
      environment,
    });
    await validateProviderTargetPolicy({
      candidateRoot: root,
      policyRoot,
      environment,
    });
    const raw = JSON.parse(
      (
        await readFile(path.join(root, "workers-bus/wrangler.jsonc"), "utf8")
      ).replace(/^\s*\/\/.*$/gm, ""),
    );
    const selected = environment === "production" ? raw : raw.env[environment];
    const vars = flattenWranglerVars(selected.vars);
    const protocol = b.protocol ?? 2;
    const db = (selected.d1_databases ?? raw.d1_databases).find(
      (x) => x.binding === "DB",
    );
    if (!db || ![1, 2].includes(protocol)) fail("source_protocol_invalid");
    if (
      protocol === 2 &&
      (vars.AUTH_DATABASE_IDENTITY !== db.database_id ||
        vars.AUTH_CONTROL_KEY !== "auth-control/head-v2" ||
        vars.AUTH_CONTROL_ACCOUNT_ID !==
          (selected.account_id ?? raw.account_id) ||
        vars.AUTH_CONTROL_ENVIRONMENT !== environment)
    )
      fail("source_control_target_drift");
    if (
      bootstrap &&
      protocol === 2 &&
      vars.AUTH_RECOVERY_ENROLLMENT_ENABLED !== "false"
    )
      fail("bootstrap_enrollment_open");
    const run = await githubRun(b.ciRunId, fetcher, githubToken);
    if (
      run.event !== "push" ||
      run.head_branch !== "main" ||
      run.path !== ".github/workflows/ci.yml" ||
      run.head_sha !== b.sourceCommit
    )
      fail("ci_source_drift");
    const account = selected.account_id ?? raw.account_id;
    const worker =
      selected.name ??
      (environment === "production" ? raw.name : `${raw.name}-${environment}`);
    if (!["candidate", "predecessor"].includes(b.role))
      fail("producer_role_missing");
    if (b.role === "predecessor") {
      const qa = await githubRun(b.qaRunId, fetcher, githubToken);
      if (
        qa.path !== ".github/workflows/deploy.yml" ||
        qa.head_sha !== b.sourceCommit ||
        qa.event !== "workflow_run"
      )
        fail("predecessor_qualification_missing");
    }
    const provider = await providerVersion(
      account,
      worker,
      b.versionId,
      fetcher,
      providerToken,
    );
    const result = validateWorkerVersionReadback(provider, {
      versionId: b.versionId,
      sourceCommit: b.sourceCommit,
      sourceTreeSha256: source.source_tree_sha256,
      artifactDigest: b.artifactHash,
      configDigest: config.digest,
      bindingManifest: config.binding_manifest,
      runtimeManifest: config.runtime_manifest,
      secretNames: config.secret_names,
    });
    if (!HASH.test(b.artifactHash)) fail("artifact_invalid");
    const actualNames = provider.resources.bindings;
    if (
      protocol === 2 &&
      (!actualNames.some(
        (x) =>
          x.name === "CF_VERSION_METADATA" && x.type === "version_metadata",
      ) ||
        READER_NAMES.some(
          (name) =>
            !actualNames.some(
              (x) => x.name === name && x.type === "secret_text",
            ),
        ) ||
        WRITER_NAMES.some((name) => actualNames.some((x) => x.name === name)))
    )
      fail("credential_binding_drift");
    if (protocol === 1) {
      if (!bootstrap || b.role !== "predecessor")
        fail("legacy_binding_only_at_explicit_bootstrap");
      if (
        (await git(root, [
          "ls-tree",
          "--name-only",
          b.sourceCommit,
          "--",
          "workers-bus/src/auth-protocol-control.ts",
        ])) !== ""
      )
        fail("legacy_source_not_p0");
      const deployment = await providerDeployment(
        account,
        worker,
        fetcher,
        providerToken,
      );
      if (
        deployment.versions.length !== 1 ||
        deployment.versions[0].version_id !== b.versionId ||
        deployment.versions[0].percentage !== 100
      )
        fail("legacy_predecessor_not_current");
    }
    const component =
      protocol === 2
        ? await authProtocolComponentManifest(root, b.sourceCommit)
        : { digest: source.component_digests.worker };
    checked.push({
      versionId: b.versionId,
      artifactHash: b.artifactHash,
      componentManifestHash: component.digest,
      protocol,
      databaseIdentity: db.database_id,
      issuer: b.issuer,
      providerReadbackHash: result.version_digest,
      sourceCommit: b.sourceCommit,
      ciRunId: String(run.id),
      role: b.role,
      dataClass: vars.AGENT_DATA_CLASS,
      workerName: worker,
      controlConfig: {
        accountId: vars.AUTH_CONTROL_ACCOUNT_ID,
        bucket: vars.AUTH_CONTROL_BUCKET,
        key: vars.AUTH_CONTROL_KEY,
      },
    });
  }
  const controlConfig = checked.find((x) => x.protocol === 2)?.controlConfig;
  if (!controlConfig) fail("fence_aware_bridge_required");
  if (
    checked.some(
      (x) =>
        x.protocol === 2 &&
        canonicalV2(x.controlConfig) !== canonicalV2(controlConfig),
    )
  )
    fail("control_target_crossed");
  let completed = null;
  if (qualification !== null)
    completed = await verifyQualification(
      qualification,
      checked,
      environment,
      fetcher,
      githubToken,
    );
  if (
    checked.filter((x) => x.role === "candidate").length !== 1 ||
    !checked.some((x) => x.role === "predecessor") ||
    new Set(checked.map((x) => x.workerName)).size !== 1
  )
    fail("candidate_predecessor_pair_required");
  const workerName = checked[0].workerName;
  const deployed = await providerDeployment(
    controlConfig.accountId,
    workerName,
    fetcher,
    providerToken,
  );
  if (bootstrap) {
    if (checked.filter((x) => x.protocol === 1).length !== 1)
      fail("bootstrap_legacy_predecessor_required");
    const db = checked.find((x) => x.protocol === 2).databaseIdentity;
    requireLegacyDeployment(deployed, checked);
    await requirePristineBootstrapMirror(
      controlConfig.accountId,
      db,
      providerToken,
      fetcher,
    );
  }
  const authorization = deepFreeze({
    environment,
    bootstrap,
    bindings: checked,
    qualification: completed,
    policyCommit: expectedPolicyCommit,
    controlConfig,
    workerName,
    membership: deployed.versions.map((x) => x.version_id),
  });
  verified.add(authorization);
  return authorization;
}

export function validateAuthControlTransition(current, next, authorization) {
  if (!verified.has(authorization)) fail("verified_predecessor_required");
  validateControlHead(next);
  if (current) validateControlHead(current);
  if (next.controlRevision !== (current ? current.controlRevision + 1 : 1))
    fail("revision_not_next");
  if (!current) {
    if (
      !authorization.bootstrap ||
      next.mode !== "staged" ||
      next.minProducerProtocol !== 1 ||
      next.qualificationReceiptHash !== null
    )
      fail("explicit_staged_genesis_required");
  } else {
    if (
      next.minProducerProtocol < current.minProducerProtocol ||
      (current.minProducerProtocol === 2 && next.mode === "staged") ||
      (current.qualificationReceiptHash !== null &&
        next.qualificationReceiptHash === null)
    )
      fail("floor_rollback");
    if (
      next.issuer !== current.issuer ||
      next.databaseIdentity !== current.databaseIdentity ||
      next.activationId !== current.activationId
    ) {
      if (
        current.mode !== "closed" ||
        next.mode !== "closed" ||
        current.databaseIdentity === next.databaseIdentity ||
        !next.issuer.startsWith(`issuer-v2:${next.controlRevision}:`) ||
        !next.activationId.startsWith(`activation-v2:${next.controlRevision}:`)
      )
        fail("isolated_fresh_restore_required");
    }
    if (
      next.mode === "active" &&
      current.mode !== "active" &&
      current.mode !== "closed"
    )
      fail("close_before_active");
  }
  if (
    !current &&
    (!next.issuer.startsWith("issuer-v2:1:") ||
      !next.activationId.startsWith("activation-v2:1:"))
  )
    fail("fresh_genesis_identity_required");
  for (const entry of next.allowedProducerBindings) {
    const binding = authorization.bindings.find(
      (x) => x.versionId === entry.versionId,
    );
    if (
      !binding ||
      canonicalV2(entry) !==
        canonicalV2(
          Object.fromEntries(
            Object.keys(entry).map((key) => [key, binding[key]]),
          ),
        )
    )
      fail("unobserved_producer_binding");
  }
  if (
    next.minProducerProtocol === 2 &&
    authorization.membership.some(
      (version) =>
        !next.allowedProducerBindings.some(
          (x) => x.versionId === version && x.protocol === 2,
        ),
    )
  )
    fail("unsafe_deployment_member");
  if (
    next.minProducerProtocol === 2 &&
    authorization.environment === "production" &&
    !authorization.qualification
  )
    fail("completed_qa_qualification_required");
  if (
    next.minProducerProtocol === 2 &&
    next.qualificationReceiptHash === null &&
    (authorization.environment !== "qa" ||
      authorization.bindings.some((x) => x.dataClass !== "synthetic"))
  )
    fail("unqualified_probe_not_isolated_synthetic_qa");
  if (next.mode === "active") {
    if (
      next.allowedProducerBindings.length < 2 ||
      next.allowedProducerBindings.some((x) => x.protocol !== 2)
    )
      fail("fence_aware_pair_required");
    if (
      authorization.environment === "production" &&
      !authorization.qualification
    )
      fail("completed_qa_qualification_required");
  }
  if (
    next.qualificationReceiptHash !== null &&
    next.qualificationReceiptHash !== authorization.qualification?.hash
  )
    fail("qualification_hash_unproven");
  return next;
}

export async function commitAuthControlUpdate({
  authorization,
  next,
  readerAndWriterConfig,
  providerToken,
  fetcher = globalThis.fetch,
}) {
  if (!verified.has(authorization)) fail("verified_predecessor_required");
  const config = readerAndWriterConfig;
  for (const key of ["accountId", "bucket", "key"])
    if (config[key] !== authorization.controlConfig[key])
      fail("writer_target_drift");
  const current = await readControlObject(config, fetcher);
  validateAuthControlTransition(current?.head ?? null, next, authorization);
  const membership = await providerDeployment(
    config.accountId,
    authorization.workerName,
    fetcher,
    providerToken,
  );
  if (!current) {
    requireLegacyDeployment(membership, authorization.bindings);
    await requirePristineBootstrapMirror(
      config.accountId,
      next.databaseIdentity,
      providerToken,
      fetcher,
    );
  }
  if (
    next.minProducerProtocol === 2 &&
    membership.versions.some(
      (v) =>
        !next.allowedProducerBindings.some(
          (x) => x.versionId === v.version_id && x.protocol === 2,
        ),
    )
  )
    fail("unsafe_deployment_member");
  const result = await putControlObject(
    config,
    next,
    current ? { ifMatch: current.etag } : { ifNoneMatch: "*" },
    fetcher,
  );
  return {
    format: "ironwrap-auth-control-write-v2",
    controlRevision: result.head.controlRevision,
    headHash: result.bodyHash,
    policyCommit: authorization.policyCommit,
    qualificationReceiptHash: result.head.qualificationReceiptHash,
  };
}

// A preflight is safe to call before candidate, predecessor and failure-cleanup switches.
// It never mutates the provider/head and a missing head cannot select P0.
export async function preflightAuthSwitch({
  config,
  versionId,
  databaseIdentity,
  provider,
  fetcher = globalThis.fetch,
}) {
  const object = await readControlObject(config, fetcher);
  if (!object) fail("head_missing");
  if (
    !provider ||
    provider.accountId !== config.accountId ||
    typeof provider.workerName !== "string"
  )
    fail("provider_probe_required");
  const mirrorRead = await d1Query(
    provider.accountId,
    databaseIdentity,
    `SELECT p.*,
    (SELECT count(*) FROM app_auth_contexts WHERE generation>0) AS enrolled_contexts
    FROM app_auth_protocol p WHERE singleton=1`,
    [],
    provider.token,
    fetcher,
  );
  const mirror = mirrorRead.results?.[0];
  if (!mirror) fail("mirror_missing");
  const head = object.head;
  const binding = head.allowedProducerBindings.find(
    (x) => x.versionId === versionId,
  );
  if (
    !binding ||
    head.mode === "closed" ||
    head.databaseIdentity !== databaseIdentity ||
    mirror.issuer !== head.issuer ||
    mirror.activation_id !== head.activationId ||
    mirror.database_identity !== databaseIdentity ||
    mirror.protocol_floor !== head.minProducerProtocol ||
    mirror.mode !== head.mode ||
    mirror.control_revision !== head.controlRevision
  )
    fail("switch_incompatible");
  if (head.minProducerProtocol === 2 && binding.protocol !== 2)
    fail("unsafe_predecessor");
  if (
    head.mode === "staged" &&
    (mirror.enrollment_open !== 0 || mirror.enrolled_contexts !== 0)
  )
    fail("legacy_rollback_not_empty");
  const deployment = await providerDeployment(
    provider.accountId,
    provider.workerName,
    fetcher,
    provider.token,
  );
  if (
    deployment.versions.some(
      (v) =>
        !head.allowedProducerBindings.some(
          (x) =>
            x.versionId === v.version_id &&
            x.protocol >= head.minProducerProtocol,
        ),
    )
  )
    fail("unsafe_deployment_member");
  const finalHead = await readControlObject(config, fetcher);
  if (!finalHead || finalHead.bodyHash !== object.bodyHash)
    fail("switch_head_changed");
  return {
    format: "ironwrap-auth-switch-preflight-v2",
    versionId,
    headHash: object.bodyHash,
    controlRevision: head.controlRevision,
    protocolFloor: head.minProducerProtocol,
    databaseIdentity,
  };
}

export async function readAuthControlReleaseConfig({
  repoRoot,
  policyRoot,
  environment,
}) {
  await validateProviderTargetPolicy({
    candidateRoot: repoRoot,
    policyRoot,
    environment,
  });
  const raw = JSON.parse(
    (
      await readFile(path.join(repoRoot, "workers-bus/wrangler.jsonc"), "utf8")
    ).replace(/^\s*\/\/.*$/gm, ""),
  );
  const selected = environment === "production" ? raw : raw.env[environment];
  const vars = flattenWranglerVars(selected.vars);
  const db = (selected.d1_databases ?? raw.d1_databases).find(
    (x) => x.binding === "DB",
  );
  if (
    !db ||
    vars.AUTH_DATABASE_IDENTITY !== db.database_id ||
    vars.AUTH_CONTROL_ENVIRONMENT !== environment ||
    vars.AUTH_CONTROL_ACCOUNT_ID !== (selected.account_id ?? raw.account_id)
  )
    fail("source_control_target_drift");
  return {
    accountId: vars.AUTH_CONTROL_ACCOUNT_ID,
    bucket: vars.AUTH_CONTROL_BUCKET,
    key: vars.AUTH_CONTROL_KEY,
    databaseIdentity: db.database_id,
    workerName:
      selected.name ??
      (environment === "production" ? raw.name : `${raw.name}-${environment}`),
  };
}

// Source/config adapter only until an explicitly authorized protected job calls it.
// Cutover is one SQL UPDATE whose owning trigger retires every old credential atomically.
export async function writeAuthProtocolMirror({
  authorization,
  config,
  phase,
  providerToken,
  fetcher = globalThis.fetch,
}) {
  if (
    !verified.has(authorization) ||
    ![
      "stage",
      "cutover",
      "close",
      "sync_active_revision",
      "open_closed_enrollment",
    ].includes(phase)
  )
    fail("mirror_authorization_required");
  for (const key of ["accountId", "bucket", "key"])
    if (config[key] !== authorization.controlConfig[key])
      fail("writer_target_drift");
  const object = await readControlObject(config, fetcher);
  if (!object) fail("head_missing");
  const h = object.head;
  if (
    !authorization.bindings.some(
      (x) =>
        x.protocol === 2 &&
        x.databaseIdentity === h.databaseIdentity &&
        x.issuer === h.issuer,
    )
  )
    fail("mirror_target_unbound");
  let sql;
  let params;
  if (phase === "stage") {
    if (
      h.mode !== "staged" ||
      h.minProducerProtocol !== 1 ||
      !authorization.bootstrap
    )
      fail("mirror_stage_refused");
    sql = `UPDATE app_auth_protocol SET issuer=?,activation_id=?,database_identity=?,control_revision=?,enrollment_open=0
      WHERE singleton=1 AND protocol_floor=1 AND mode='staged' AND control_revision<=?
        AND enrollment_open=0
        AND NOT EXISTS (SELECT 1 FROM app_auth_contexts WHERE generation>0)
        AND ((control_revision=0 AND issuer IS NULL AND activation_id IS NULL AND database_identity IS NULL)
          OR (control_revision>0 AND issuer=? AND activation_id=? AND database_identity=?))`;
    params = [
      h.issuer,
      h.activationId,
      h.databaseIdentity,
      h.controlRevision,
      h.controlRevision,
      h.issuer,
      h.activationId,
      h.databaseIdentity,
    ];
  } else if (phase === "cutover") {
    if (
      h.mode !== "closed" ||
      h.minProducerProtocol !== 2 ||
      h.allowedProducerBindings.some((x) => x.protocol !== 2) ||
      h.allowedProducerBindings.length < 2
    )
      fail("mirror_cutover_refused");
    const current = await providerDeployment(
      config.accountId,
      authorization.workerName,
      fetcher,
      providerToken,
    );
    if (
      current.versions.some(
        (v) =>
          !h.allowedProducerBindings.some(
            (x) => x.versionId === v.version_id && x.protocol === 2,
          ),
      )
    )
      fail("unsafe_deployment_member");
    sql = `UPDATE app_auth_protocol SET protocol_floor=2,mode='closed',control_revision=?,enrollment_open=0
      WHERE singleton=1 AND protocol_floor=1 AND mode='staged' AND enrollment_open=0
        AND control_revision<=? AND issuer=? AND activation_id=? AND database_identity=?
        AND NOT EXISTS (SELECT 1 FROM app_auth_contexts WHERE generation>0)`;
    params = [h.controlRevision, h.controlRevision, h.issuer, h.activationId, h.databaseIdentity];
  } else if (phase === "close") {
    if (h.mode !== "closed") fail("mirror_close_refused");
    sql = `UPDATE app_auth_protocol SET mode='closed',control_revision=?,enrollment_open=0
      WHERE singleton=1 AND protocol_floor=? AND issuer=? AND activation_id=? AND database_identity=? AND control_revision<=?`;
    params = [
      h.controlRevision,
      h.minProducerProtocol,
      h.issuer,
      h.activationId,
      h.databaseIdentity,
      h.controlRevision,
    ];
  } else {
    if (
      h.mode !== "active" ||
      h.minProducerProtocol !== 2 ||
      (authorization.environment === "production" &&
        !authorization.qualification)
    )
      fail("mirror_open_refused");
    sql = `UPDATE app_auth_protocol SET mode='active',control_revision=?,enrollment_open=0
      WHERE singleton=1 AND protocol_floor=2 AND mode=? AND issuer=? AND activation_id=? AND database_identity=? AND control_revision<=?`;
    params = [
      h.controlRevision,
      phase === "sync_active_revision" ? "active" : "closed",
      h.issuer,
      h.activationId,
      h.databaseIdentity,
      h.controlRevision,
    ];
  }
  const result = await d1Query(
    config.accountId,
    h.databaseIdentity,
    sql,
    params,
    providerToken,
    fetcher,
  );
  if (result.meta?.changes !== 1) fail("mirror_write_unconfirmed");
  const readback = await d1Query(
    config.accountId,
    h.databaseIdentity,
    `SELECT p.*,
    (SELECT count(*) FROM app_auth_contexts WHERE generation>0) AS enrolled_contexts,
    (SELECT count(*) FROM app_sessions WHERE auth_protocol=1 AND revoked_at IS NULL) AS legacy_sessions,
    (SELECT count(*) FROM app_magic_links WHERE auth_protocol=1 AND consumed_at IS NULL) AS legacy_magic,
    (SELECT count(*) FROM app_device_pairings WHERE auth_protocol=1 AND consumed_at IS NULL AND revoked_at IS NULL) AS legacy_pair
    FROM app_auth_protocol p WHERE singleton=1`,
    [],
    providerToken,
    fetcher,
  );
  const row = readback.results?.[0];
  if (
    !row ||
    row.issuer !== h.issuer ||
    row.activation_id !== h.activationId ||
    row.database_identity !== h.databaseIdentity ||
    row.protocol_floor !== h.minProducerProtocol ||
    row.mode !== h.mode ||
    row.control_revision !== h.controlRevision ||
    row.enrollment_open !== 0 ||
    (phase === "stage" && row.enrolled_contexts !== 0) ||
    (phase === "cutover" &&
      (row.legacy_sessions || row.legacy_magic || row.legacy_pair))
  )
    fail("mirror_readback_drift");
  const after = await readControlObject(config, fetcher);
  if (!after || after.bodyHash !== object.bodyHash)
    fail("mirror_control_changed_unconfirmed");
  return {
    format: "ironwrap-auth-mirror-write-v2",
    phase,
    headHash: object.bodyHash,
    mirror: row,
    enrollment: "closed",
  };
}

async function githubRun(id, fetcher, token) {
  if (
    !/^[1-9][0-9]*$/.test(String(id)) ||
    typeof token !== "string" ||
    token.length < 20
  )
    fail("ci_credentials_missing");
  const response = await fetcher(
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${id}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) fail("ci_unavailable");
  const run = record(await response.json());
  if (
    String(run.id) !== String(id) ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    fail("ci_not_successful");
  return run;
}
async function providerVersion(account, worker, version, fetcher, token) {
  if (
    !/^[0-9a-f]{32}$/.test(account) ||
    !/^[a-z0-9-]+$/.test(worker) ||
    !/^[0-9a-f-]{36}$/.test(version) ||
    typeof token !== "string" ||
    token.length < 20
  )
    fail("provider_identity_invalid");
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/versions/${version}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) fail("provider_unavailable");
  const result = await response.json();
  if (result.success !== true || !result.result) fail("provider_unavailable");
  return result.result;
}
async function providerDeployment(account, worker, fetcher, token) {
  if (
    !/^[0-9a-f]{32}$/.test(account) ||
    !/^[a-z0-9-]+$/.test(worker) ||
    typeof token !== "string" ||
    token.length < 20
  )
    fail("deployment_identity_invalid");
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/deployments`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) fail("deployment_unavailable");
  const data = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    data.success !== true ||
    !data.result ||
    typeof data.result !== "object" ||
    Array.isArray(data.result) ||
    !Array.isArray(data.result.deployments) ||
    !data.result.deployments.length
  )
    fail("deployment_unavailable");
  const rows = data.result.deployments.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.created_on !== "string"
    )
      fail("deployment_order_ambiguous");
    return { ...row, time: Date.parse(row.created_on) };
  });
  if (
    rows.some((x) => !Number.isFinite(x.time)) ||
    new Set(rows.map((x) => x.time)).size !== rows.length
  )
    fail("deployment_order_ambiguous");
  const latest = rows.sort((a, b) => b.time - a.time)[0];
  if (
    !Array.isArray(latest.versions) ||
    latest.versions.length === 0 ||
    latest.versions.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.version_id) ||
        typeof entry.percentage !== "number" ||
        !Number.isFinite(entry.percentage) ||
        entry.percentage < 0 ||
        entry.percentage > 100,
    ) ||
    new Set(latest.versions.map((entry) => entry.version_id)).size !== latest.versions.length ||
    Math.abs(latest.versions.reduce((total, entry) => total + entry.percentage, 0) - 100) > 1e-9
  )
    fail("deployment_invalid");
  return latest;
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
async function d1Query(account, database, sql, params, token, fetcher) {
  if (
    !/^[0-9a-f]{32}$/.test(account) ||
    !/^[0-9a-f-]{36}$/.test(database) ||
    typeof token !== "string" ||
    token.length < 20
  )
    fail("d1_target_invalid");
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) fail("d1_unconfirmed");
  const body = await response.json();
  if (
    body.success !== true ||
    !Array.isArray(body.result) ||
    body.result.length !== 1 ||
    body.result[0].success !== true
  )
    fail("d1_unconfirmed");
  return body.result[0];
}
async function verifyQualification(
  input,
  bindings,
  environment,
  fetcher,
  token,
) {
  const q = record(input);
  const run = await githubRun(q.runId, fetcher, token);
  if (
    run.path !== ".github/workflows/deploy.yml" ||
    run.event !== "workflow_run" ||
    !bindings.some((x) => x.sourceCommit === run.head_sha)
  )
    fail("qualification_run_drift");
  // This artifact must be emitted by the future protected producer qualification job. P1
  // supplies no such artifact, so neither CI-only success nor a source/health receipt can open it.
  const response = await fetcher(
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${q.runId}/artifacts`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) fail("qualification_artifact_unavailable");
  const artifacts = (await response.json()).artifacts;
  const named = Array.isArray(artifacts)
    ? artifacts.filter(
        (x) =>
          x.name === `auth-producer-qualification-${run.head_sha}` &&
          !x.expired,
      )
    : [];
  if (
    named.length !== 1 ||
    named[0].digest !== `sha256:${q.archiveHash}` ||
    !HASH.test(q.archiveHash)
  )
    fail("qualification_artifact_drift");
  const bytes = await readFile(q.archivePath);
  if (hash(bytes) !== q.archiveHash || bytes.length > 1048576)
    fail("qualification_archive_drift");
  const { stdout } = await execFile(
    "unzip",
    ["-p", q.archivePath, "auth-producer-qualification.json"],
    { maxBuffer: 262144 },
  );
  const proof = JSON.parse(stdout);
  if (
    proof.format !== "ironwrap-auth-producer-qualification-v2" ||
    proof.status !== "completed" ||
    proof.environment !== "qa" ||
    proof.sourceCommit !== run.head_sha ||
    proof.enrollmentShipping !== "closed" ||
    !HASH.test(proof.schemaHash) ||
    proof.controlReadOnlyCredentialProbe !== "passed" ||
    proof.conditionalWriterRace !== "passed" ||
    proof.nativeD1BarrierOracles !== "passed" ||
    proof.activePredecessorRollback !== "passed" ||
    proof.allEntryPointsInventoried !== true ||
    proof.isolatedRestore !== "passed"
  )
    fail("qualification_incomplete");
  const pair = [proof.candidateVersion, proof.predecessorVersion];
  if (
    new Set(pair).size !== 2 ||
    pair.some(
      (v) => !bindings.some((b) => b.versionId === v && b.protocol === 2),
    ) ||
    bindings.some(
      (b) =>
        b.databaseIdentity !== proof.databaseIdentity ||
        b.issuer !== proof.issuer,
    )
  )
    fail("qualification_pair_drift");
  return {
    hash: hash(stdout),
    environment,
    runId: String(run.id),
    pair,
    schemaHash: proof.schemaHash,
  };
}
