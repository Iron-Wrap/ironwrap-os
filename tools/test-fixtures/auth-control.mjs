// Synthetic consumer-contract fixtures only. No deployed Worker/schema qualification.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTH_CONTROL_WRITER_POLICY_FILES,
  AUTH_PROTOCOL_POLICY_FILES,
} from "../auth-protocol-control.mjs";
import { canonicalV2 } from "../../shared/auth-protocol-v2.mjs";
import { flattenWranglerVars } from "../wrangler-vars.mjs";

const execFile = promisify(execFileCallback);
const repo = fileURLToPath(new URL("../..", import.meta.url));
export const sha = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
export const versions = [1, 2, 3, 4].map(
  (n) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
);
export const credentials = Object.fromEntries(
  ["reader", "writer"].map((role) => [
    role,
    {
      id: `synthetic-${role}-access`,
      secret: `synthetic-${role}-secret-with-more-than32-characters`,
    },
  ]),
);
export const githubToken = "synthetic-github-token-with-20-characters";
export const providerToken = "synthetic-provider-token-with-20-characters";

// A deliberately small SQL consumer, not a copy or qualification of migration0173.
// It exercises the writer's real SQL statements and conditional cutover readback.
export function syntheticDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE app_auth_protocol(singleton INTEGER PRIMARY KEY,protocol_floor INTEGER,
      mode TEXT,issuer TEXT,activation_id TEXT,database_identity TEXT,control_revision INTEGER,enrollment_open INTEGER);
    INSERT INTO app_auth_protocol VALUES(1,1,'staged',NULL,NULL,NULL,0,0);
    CREATE TABLE app_auth_contexts(context_id TEXT PRIMARY KEY,generation INTEGER);
    CREATE TABLE app_sessions(auth_protocol INTEGER,revoked_at TEXT);
    CREATE TABLE app_magic_links(auth_protocol INTEGER,consumed_at TEXT);
    CREATE TABLE app_device_pairings(auth_protocol INTEGER,consumed_at TEXT,revoked_at TEXT);
    CREATE TRIGGER synthetic_cutover AFTER UPDATE OF protocol_floor ON app_auth_protocol
      WHEN OLD.protocol_floor=1 AND NEW.protocol_floor=2 BEGIN
      UPDATE app_sessions SET revoked_at='synthetic-cutover' WHERE auth_protocol=1;
      UPDATE app_magic_links SET consumed_at='synthetic-cutover' WHERE auth_protocol=1;
      UPDATE app_device_pairings SET revoked_at='synthetic-cutover' WHERE auth_protocol=1;
    END;
  `);
  return db;
}

export function sourceBoundP1Database() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const directory = path.join(repo, "workers-bus/migrations");
    for (const name of readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort())
      db.exec(readFileSync(path.join(directory, name), "utf8"));
    const fixture = readFileSync(
      new URL("auth-protocol-v2.sql", import.meta.url),
      "utf8",
    );
    const binding = JSON.parse(
      readFileSync(new URL("auth-protocol-v2.json", import.meta.url), "utf8"),
    );
    assert.equal(sha(fixture), binding.sha256);
    db.exec(fixture);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function sourceCapsules() {
  const parent = await mkdtemp(path.join(tmpdir(), "ironwrap-auth-control-"));
  const raw = JSON.parse(
    (
      await readFile(path.join(repo, "workers-bus/wrangler.jsonc"), "utf8")
    ).replace(/^\s*\/\/.*$/gm, ""),
  );
  const secrets = await readFile(
    path.join(repo, "workers-bus/src/secret-bindings.d.ts"),
    "utf8",
  );
  async function capsule(legacy) {
    const root = path.join(parent, legacy ? "p0" : "synthetic-p1");
    await mkdir(root);
    for (const relative of AUTH_CONTROL_WRITER_POLICY_FILES) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(
        path.join(root, relative),
        await readFile(path.join(repo, relative)),
      );
    }
    const config = structuredClone(raw);
    if (!legacy) {
      for (const [environment, selected] of [
        ["production", config],
        ["qa", config.env.qa],
      ]) {
        const database = (selected.d1_databases ?? config.d1_databases).find(
          (entry) => entry.binding === "DB",
        );
        selected.vars.CFG_AUTH = {
          ...selected.vars.CFG_AUTH,
          AUTH_CONTROL_ACCOUNT_ID: selected.account_id ?? config.account_id,
          AUTH_CONTROL_BUCKET: `ironwrap-${environment}-auth-control`,
          AUTH_CONTROL_KEY: "auth-control/head-v2",
          AUTH_CONTROL_ENVIRONMENT: environment,
          AUTH_DATABASE_IDENTITY: database.database_id,
          AUTH_RECOVERY_ENROLLMENT_ENABLED: "false",
        };
        selected.version_metadata = { binding: "CF_VERSION_METADATA" };
      }
      for (const relative of AUTH_PROTOCOL_POLICY_FILES.filter((name) =>
        name.startsWith("workers-bus/"),
      )) {
        await mkdir(path.dirname(path.join(root, relative)), {
          recursive: true,
        });
        await writeFile(
          path.join(root, relative),
          relative.endsWith("/0173_app_auth_protocol_v2.sql")
            ? await readFile(new URL("auth-protocol-v2.sql", import.meta.url))
            : "// Synthetic P1 source marker; never deployed or compiled.\n",
        );
      }
    }
    await mkdir(path.join(root, "workers-bus/src"), { recursive: true });
    await writeFile(
      path.join(root, "workers-bus/wrangler.jsonc"),
      JSON.stringify(config, null, 2) + "\n",
    );
    await writeFile(
      path.join(root, "workers-bus/src/secret-bindings.d.ts"),
      secrets +
        (legacy
          ? ""
          : "\ninterface SyntheticAuthReaderSecrets {\n  AUTH_CONTROL_READ_ACCESS_KEY_ID: string;\n  AUTH_CONTROL_READ_SECRET_ACCESS_KEY: string;\n}\n"),
    );
    await execFile("git", ["init", "-b", "main"], { cwd: root });
    await execFile("git", ["add", "."], { cwd: root });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Synthetic fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "synthetic source contract",
      ],
      { cwd: root },
    );
    return {
      root,
      head: (
        await execFile("git", ["rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim(),
      config,
    };
  }
  try {
    const p0 = await capsule(true),
      p1 = await capsule(false);
    return {
      parent,
      p0,
      p1,
      cleanup: () => rm(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

export function verifyS3(
  request,
  body,
  signingHost = new URL(request.url).host,
) {
  const headers =
    request.headers instanceof Headers
      ? request.headers
      : new Headers(request.headers);
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/auto\/s3\/aws4_request), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      headers.get("authorization"),
    );
  assert.ok(match, "signed request required");
  const credential = Object.values(credentials).find(
    (entry) => entry.id === match[1],
  );
  assert.ok(credential, "synthetic credential required");
  const url = new URL(request.url);
  assert.equal(headers.get("x-amz-content-sha256"), sha(body));
  const canonical = [
    request.method,
    url.pathname,
    "",
    match[3]
      .split(";")
      .map(
        (name) =>
          `${name}:${name === "host" ? signingHost : headers.get(name).trim()}\n`,
      )
      .join(""),
    match[3],
    sha(body),
  ].join("\n");
  const toSign = `AWS4-HMAC-SHA256\n${headers.get("x-amz-date")}\n${match[2]}\n${sha(canonical)}`;
  let key = hmac(`AWS4${credential.secret}`, match[2].slice(0, 8));
  for (const part of ["auto", "s3", "aws4_request"]) key = hmac(key, part);
  assert.equal(hmac(key, toSign).toString("hex"), match[4]);
  return credential.id === credentials.writer.id;
}

export function memoryS3() {
  return {
    stored: null,
    etag: null,
    puts: 0,
    gets: 0,
    set(head) {
      this.stored = head === null ? null : canonicalV2(head);
      this.etag = head === null ? null : `"${sha(this.stored)}"`;
    },
    async fetch(request, signingHost) {
      const body =
        request.method === "GET"
          ? Buffer.alloc(0)
          : Buffer.from(await request.arrayBuffer());
      const writer = verifyS3(request, body, signingHost);
      if (request.method === "GET") {
        this.gets++;
        return this.stored === null
          ? new Response(null, { status: 404 })
          : new Response(this.stored, { headers: { etag: this.etag } });
      }
      if (!writer) return new Response(null, { status: 403 });
      if (
        (request.headers.get("if-none-match") === "*" &&
          this.stored !== null) ||
        (request.headers.has("if-match") &&
          request.headers.get("if-match") !== this.etag)
      )
        return new Response(null, { status: 412 });
      assert.ok(
        request.headers.has("if-match") ||
          request.headers.get("if-none-match") === "*",
      );
      this.stored = body.toString();
      this.etag = `"${sha(body)}"`;
      this.puts++;
      return new Response(null, { status: 200 });
    },
  };
}

export async function harness(
  capsules,
  t,
  environment = "qa",
  database = null,
) {
  const { p0, p1 } = capsules;
  const impl = await import(
    pathToFileURL(path.join(p0.root, "tools/auth-protocol-control.mjs"))
  );
  const release = await import(
    pathToFileURL(path.join(p0.root, "tools/release-permit.mjs"))
  );
  const cli = await import(
    pathToFileURL(path.join(p0.root, "tools/release-promotion.mjs"))
  );
  const selected = environment === "production" ? p1.config : p1.config.env.qa;
  const vars = flattenWranglerVars(selected.vars);
  const config = {
    accountId: vars.AUTH_CONTROL_ACCOUNT_ID,
    bucket: vars.AUTH_CONTROL_BUCKET,
    key: vars.AUTH_CONTROL_KEY,
    accessKeyId: credentials.writer.id,
    secretAccessKey: credentials.writer.secret,
  };
  const db = database ?? syntheticDatabase();
  t.after(() => db.close());
  const s3 = memoryS3(),
    providers = new Map(),
    runs = new Map();
  const contexts = [];
  for (const [index, source] of [p0, p1, p1].entries()) {
    const evidence = await release.computeSourceEvidence({
      repoRoot: source.root,
      sourceCommit: source.head,
      baseCommit: source.head,
    });
    const digest = await release.computeEnvironmentConfigDigest({
      repoRoot: source.root,
      environment,
    });
    const selectedConfig =
      environment === "production" ? source.config : source.config.env.qa;
    const bindings = digest.binding_manifest.map((binding) => {
      const out = { name: binding.name, type: binding.type };
      if (binding.type === "json") out.json = selectedConfig.vars[binding.name];
      if (binding.type === "plain_text")
        out.text = selectedConfig.vars[binding.name];
      if (binding.type === "d1") out.id = binding.resource_id;
      if (binding.type === "r2_bucket") out.bucket_name = binding.resource_name;
      if (binding.type === "queue") out.queue_name = binding.resource_name;
      return out;
    });
    providers.set(versions[index], {
      id: versions[index],
      metadata: { created_on: new Date(0).toISOString() },
      annotations: {
        "workers/message": release.releaseVersionMessage({
          sourceCommit: source.head,
          sourceTreeSha256: evidence.source_tree_sha256,
          artifactDigest: "a".repeat(64),
          configDigest: digest.digest,
        }),
      },
      resources: { bindings, script_runtime: digest.runtime_manifest },
    });
    const common = {
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: source.head,
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
    };
    runs.set(String(index * 2 + 1), {
      ...common,
      id: index * 2 + 1,
      event: "push",
      path: ".github/workflows/ci.yml",
    });
    runs.set(String(index * 2 + 2), {
      ...common,
      id: index * 2 + 2,
      event: "workflow_run",
      path: ".github/workflows/deploy.yml",
    });
    contexts.push({
      versionId: versions[index],
      sourceCommit: source.head,
      baseCommit: source.head,
      artifactHash: "a".repeat(64),
      issuer: "issuer-v2:1:synthetic",
      protocol: index === 0 ? 1 : 2,
      role: index === 1 ? "candidate" : "predecessor",
      ciRunId: String(index * 2 + 1),
      qaRunId: String(index * 2 + 2),
    });
  }
  const state = {
    impl,
    cli,
    config,
    db,
    s3,
    providers,
    runs,
    contexts,
    deploymentVersions: [{ version_id: versions[0], percentage: 100 }],
    requests: [],
    beforeDeployment: null,
    beforeD1: null,
  };
  state.fetcher = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    state.requests.push({
      method: request.method,
      host: url.host,
      path: url.pathname,
    });
    if (url.host.endsWith(".r2.cloudflarestorage.com")) {
      assert.equal(url.host, `${config.accountId}.r2.cloudflarestorage.com`);
      assert.equal(url.pathname, `/${config.bucket}/auth-control/head-v2`);
      return s3.fetch(request);
    }
    if (url.host === "api.github.com") {
      assert.ok(url.pathname.startsWith("/repos/Iron-Wrap/ironwrap-os/"));
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${githubToken}`,
      );
      const run = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
      assert.ok(run, "unimplemented synthetic GitHub route");
      return Response.json(runs.get(run[1]));
    }
    assert.equal(url.host, "api.cloudflare.com", "no external test transport");
    assert.equal(
      request.headers.get("authorization"),
      `Bearer ${providerToken}`,
    );
    assert.ok(
      url.pathname.startsWith(`/client/v4/accounts/${config.accountId}/`),
    );
    const version = /\/versions\/([^/]+)$/.exec(url.pathname);
    if (version)
      return Response.json({
        success: true,
        result: providers.get(version[1]),
      });
    if (url.pathname.endsWith("/deployments")) {
      await state.beforeDeployment?.();
      return Response.json({
        success: true,
        result: [
          {
            created_on: new Date(0).toISOString(),
            versions: state.deploymentVersions,
          },
        ],
      });
    }
    assert.equal(
      url.pathname,
      `/client/v4/accounts/${config.accountId}/d1/database/${vars.AUTH_DATABASE_IDENTITY}/query`,
    );
    const query = await request.json();
    await state.beforeD1?.(query);
    const statement = db.prepare(query.sql);
    const result = /^\s*SELECT/.test(query.sql)
      ? {
          success: true,
          results: statement.all(...query.params),
          meta: { changes: 0 },
        }
      : {
          success: true,
          results: [],
          meta: { changes: Number(statement.run(...query.params).changes) },
        };
    return Response.json({ success: true, result: [result] });
  };
  state.input = (bootstrap = true) => ({
    policyRoot: p0.root,
    expectedPolicyCommit: p0.head,
    candidateRoots: {
      [versions[0]]: p0.root,
      [versions[1]]: p1.root,
      [versions[2]]: p1.root,
    },
    environment,
    bindings: bootstrap ? contexts.slice(0, 2) : contexts.slice(1),
    bootstrap,
    fetcher: state.fetcher,
    githubToken,
    providerToken,
  });
  state.authorize = (bootstrap = true, overrides = {}) =>
    impl.authorizeAuthControl({ ...state.input(bootstrap), ...overrides });
  state.head = (authorization) => ({
    format: "ironwrap-auth-control-v2",
    controlRevision: 1,
    minProducerProtocol: 1,
    mode: "staged",
    activationId: "activation-v2:1:synthetic",
    issuer: "issuer-v2:1:synthetic",
    databaseIdentity: vars.AUTH_DATABASE_IDENTITY,
    allowedProducerBindings: authorization.bindings.map(
      ({
        versionId,
        artifactHash,
        componentManifestHash,
        protocol,
        databaseIdentity,
        issuer,
      }) => ({
        versionId,
        artifactHash,
        componentManifestHash,
        protocol,
        databaseIdentity,
        issuer,
      }),
    ),
    qualificationReceiptHash: null,
  });
  state.commit = (authorization, next, overrides = {}) =>
    impl.commitAuthControlUpdate({
      authorization,
      next,
      readerAndWriterConfig: config,
      providerToken,
      fetcher: state.fetcher,
      ...overrides,
    });
  state.mirror = (authorization, phase) =>
    impl.writeAuthProtocolMirror({
      authorization,
      config,
      phase,
      providerToken,
      fetcher: state.fetcher,
    });
  state.switch = (versionId) =>
    impl.preflightAuthSwitch({
      config,
      versionId,
      databaseIdentity: vars.AUTH_DATABASE_IDENTITY,
      provider: {
        accountId: config.accountId,
        workerName:
          selected.name ??
          (environment === "production"
            ? p1.config.name
            : `${p1.config.name}-${environment}`),
        token: providerToken,
      },
      fetcher: state.fetcher,
    });
  state.stage = async () => {
    const authorization = await state.authorize();
    const head = state.head(authorization);
    await state.commit(authorization, head);
    await state.mirror(authorization, "stage");
    return { authorization, head };
  };
  return state;
}
