import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  AUTH_CONTROL_WRITER_POLICY_FILES,
  AUTH_PROTOCOL_POLICY_FILES,
  validateAuthControlTransition,
} from "./auth-protocol-control.mjs";
import { canonicalV2 } from "../shared/auth-protocol-v2.mjs";
import {
  readControlObject,
  putControlObject,
  signedControlRequest,
} from "../shared/auth-control-s3.mjs";
import {
  ProtocolD1,
  protocolHead,
} from "../workers-bus/test/auth-protocol-fixture.ts";

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = "2588cb2833d58ba11793c19686da6033bd31bbb1";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const versions = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const keys = {
  reader: {
    id: "synthetic-reader-access",
    secret: "synthetic-reader-secret-with-more-than32-characters",
  },
  writer: {
    id: "synthetic-writer-access",
    secret: "synthetic-writer-secret-with-more-than32-characters",
  },
};

async function sourceFixture(parent, legacy) {
  const root = path.join(parent, legacy ? "p0" : "p1");
  await mkdir(root, { recursive: true });
  const files = legacy
    ? [
        ...AUTH_CONTROL_WRITER_POLICY_FILES,
        "workers-bus/wrangler.jsonc",
        "workers-bus/src/secret-bindings.d.ts",
        "deploy/release-provider-policy.json",
      ]
    : [...AUTH_PROTOCOL_POLICY_FILES, "deploy/release-provider-policy.json"];
  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    let data =
      legacy && file.startsWith("workers-bus/")
        ? (
            await execFile("git", ["show", `${base}:${file}`], {
              cwd: repo,
              maxBuffer: 16 * 1024 * 1024,
            })
          ).stdout
        : await readFile(path.join(repo, file));
    // A pure policy warmup can carry the new Node writer without enabling P1's Worker
    // runtime. This is a synthetic source capsule, never a deployed predecessor proof.
    if (legacy && file === "tools/release-promotion.mjs")
      data = data
        .toString()
        .replaceAll(
          "AUTH_PROTOCOL_POLICY_FILES",
          "AUTH_CONTROL_WRITER_POLICY_FILES",
        );
    await writeFile(target, data);
  }
  await execFile("git", ["init", "-b", "main"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile(
    "git",
    [
      "-c",
      "user.name=Synthetic fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "synthetic protocol fixture",
    ],
    { cwd: root },
  );
  const head = (
    await execFile("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  return { root, head };
}

function verifyS3(request, body) {
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/auto\/s3\/aws4_request), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      request.headers.authorization ?? "",
    );
  assert.ok(parsed, "actual adapter sends SigV4");
  const credential = Object.values(keys).find((x) => x.id === parsed[1]);
  assert.ok(credential);
  // The loopback adapter changes the network host. Preserve the original signed host only
  // in this test transport; the production Request signs its actual fixed R2 URL.
  const headers = parsed[3]
    .split(";")
    .map(
      (name) =>
        `${name}:${String(
          name === "host"
            ? request.headers["x-synthetic-signing-host"]
            : request.headers[name],
        ).trim()}\n`,
    )
    .join("");
  const canonical = [
    request.method,
    request.url,
    "",
    headers,
    parsed[3],
    sha(body),
  ].join("\n");
  const toSign = `AWS4-HMAC-SHA256\n${request.headers["x-amz-date"]}\n${parsed[2]}\n${sha(canonical)}`;
  let key = hmac(`AWS4${credential.secret}`, parsed[2].slice(0, 8));
  for (const part of ["auto", "s3", "aws4_request"]) key = hmac(key, part);
  assert.equal(hmac(key, toSign).toString("hex"), parsed[4]);
  return credential.id === keys.writer.id;
}

test("a fabricated JSON authorization cannot write or bless an active head", () => {
  assert.throws(
    () =>
      validateAuthControlTransition(
        null,
        {},
        Object.freeze({ environment: "qa", bootstrap: true }),
      ),
    /verified_predecessor_required/,
  );
});

test("actual signed HTTP conditional writer has one CAS winner and never silently retries or writes with reader credentials", async (t) => {
  let stored = null;
  let etag = null;
  let writes = 0;
  let signingErrors = 0;
  let signingFailure = null;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const writer = verifyS3(req, body);
      if (req.method === "GET") {
        if (stored === null) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { etag });
        res.end(stored);
        return;
      }
      if (!writer) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (
        (req.headers["if-none-match"] === "*" && stored !== null) ||
        (req.headers["if-match"] && req.headers["if-match"] !== etag)
      ) {
        res.writeHead(412);
        res.end();
        return;
      }
      stored = body.toString();
      etag = `"${sha(body)}"`;
      writes++;
      res.writeHead(200, { etag });
      res.end();
    } catch (error) {
      signingErrors++;
      signingFailure = {
        name: error.name,
        message: error.message,
        host: req.headers.host,
        path: req.url,
      };
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const fetcher = async (input, init) => {
    const req = new Request(input, init);
    const original = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("x-synthetic-signing-host", original.host);
    return fetch(
      `http://127.0.0.1:${server.address().port}${original.pathname}`,
      {
        method: req.method,
        headers,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
        signal: req.signal,
      },
    );
  };
  const config = {
    accountId: "0".repeat(32),
    bucket: "auth-control-synthetic",
    key: "auth-control/head-v2",
    accessKeyId: keys.writer.id,
    secretAccessKey: keys.writer.secret,
  };
  let initial;
  try {
    initial = await putControlObject(
      config,
      protocolHead("staged"),
      { ifNoneMatch: "*" },
      fetcher,
    );
  } catch (error) {
    throw new Error(
      `${error.message}: synthetic HTTP signature diagnostic ${JSON.stringify(signingFailure)}`,
    );
  }
  assert.equal(writes, 1);
  const next = { ...initial.head, controlRevision: 2 };
  const results = await Promise.allSettled([
    putControlObject(config, next, { ifMatch: initial.etag }, fetcher),
    putControlObject(config, next, { ifMatch: initial.etag }, fetcher),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const lost = results.find((x) => x.status === "rejected");
  assert.equal(lost.reason.message, "auth_control_cas_lost");
  assert.equal(typeof lost.reason.currentHeadHash, "string");
  assert.equal(writes, 2);
  const readConfig = {
    ...config,
    accessKeyId: keys.reader.id,
    secretAccessKey: keys.reader.secret,
  };
  const current = await readControlObject(readConfig, fetcher);
  assert.equal(current.head.controlRevision, 2);
  await assert.rejects(
    putControlObject(
      readConfig,
      { ...next, controlRevision: 3 },
      { ifMatch: current.etag },
      fetcher,
    ),
  );
  assert.equal(writes, 2);
  await assert.rejects(
    signedControlRequest(config, "PUT", canonicalV2(next), {}),
  );
  assert.equal(signingErrors, 0);
});

test("real HTTP adapters bind source/CI/provider, conditionally write STAGED, read SQL mirror and refuse unsafe authority", async (t) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "ironwrap-auth-control-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const p0 = await sourceFixture(temporary, true);
  const p1 = await sourceFixture(temporary, false);
  const impl = await import(
    pathToFileURL(path.join(p0.root, "tools/auth-protocol-control.mjs"))
  );
  const release = await import(
    pathToFileURL(path.join(p1.root, "tools/release-permit.mjs"))
  );
  const db = new ProtocolD1();
  t.after(() => db.raw.close());
  let stored = null;
  let etag = null;
  let puts = 0;
  let unsigned = 0;
  let deploymentVersions = [{ version_id: versions[0], percentage: 100 }];
  let changeHeadOnDeployment = false;
  const providers = new Map();
  const runs = new Map();
  const contexts = [];
  for (const [index, source] of [p0, p1].entries()) {
    const evidence = await release.computeSourceEvidence({
      repoRoot: source.root,
      sourceCommit: source.head,
      baseCommit: source.head,
    });
    const config = await release.computeEnvironmentConfigDigest({
      repoRoot: source.root,
      environment: "qa",
    });
    const raw = JSON.parse(
      (
        await readFile(
          path.join(source.root, "workers-bus/wrangler.jsonc"),
          "utf8",
        )
      ).replace(/^\s*\/\/.*$/gm, ""),
    );
    const selected = raw.env.qa;
    const bindings = config.binding_manifest.map((binding) => {
      const out = { name: binding.name, type: binding.type };
      if (binding.type === "json") out.json = selected.vars[binding.name];
      if (binding.type === "plain_text") out.text = selected.vars[binding.name];
      if (binding.type === "d1") out.id = binding.resource_id;
      if (binding.type === "r2_bucket") out.bucket_name = binding.resource_name;
      if (binding.type === "queue") out.queue_name = binding.resource_name;
      return out;
    });
    providers.set(versions[index], {
      id: versions[index],
      metadata: { created_on: new Date().toISOString() },
      annotations: {
        "workers/message": release.releaseVersionMessage({
          sourceCommit: source.head,
          sourceTreeSha256: evidence.source_tree_sha256,
          artifactDigest: "a".repeat(64),
          configDigest: config.digest,
        }),
      },
      resources: {
        bindings,
        script_runtime: {
          compatibility_date: raw.compatibility_date,
          compatibility_flags: raw.compatibility_flags,
        },
      },
    });
    const runId = String(index * 2 + 1);
    const common = {
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: source.head,
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
    };
    runs.set(runId, {
      ...common,
      id: Number(runId),
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
      role: index === 0 ? "predecessor" : "candidate",
      ciRunId: runId,
      qaRunId: String(index * 2 + 2),
    });
  }
  const raw = JSON.parse(
    (
      await readFile(path.join(p1.root, "workers-bus/wrangler.jsonc"), "utf8")
    ).replace(/^\s*\/\/.*$/gm, ""),
  );
  const vars = raw.env.qa.vars.CFG_APP;
  const config = {
    accountId: vars.AUTH_CONTROL_ACCOUNT_ID,
    bucket: vars.AUTH_CONTROL_BUCKET,
    key: vars.AUTH_CONTROL_KEY,
    accessKeyId: keys.writer.id,
    secretAccessKey: keys.writer.secret,
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://synthetic.invalid");
      if (url.pathname.endsWith("/auth-control/head-v2")) {
        const writable = verifyS3(request, body);
        if (request.method === "GET") {
          if (stored === null) {
            response.writeHead(404);
            response.end();
            return;
          }
          response.writeHead(200, { etag });
          response.end(stored);
          return;
        }
        if (!writable) {
          response.writeHead(403);
          response.end();
          return;
        }
        if (request.method !== "PUT") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (
          (request.headers["if-none-match"] === "*" && stored !== null) ||
          (request.headers["if-match"] && request.headers["if-match"] !== etag)
        ) {
          response.writeHead(412);
          response.end();
          return;
        }
        assert.ok(
          request.headers["if-match"] || request.headers["if-none-match"],
        );
        stored = body.toString();
        etag = `"${sha(body)}"`;
        puts++;
        response.writeHead(200, { etag });
        response.end();
        return;
      }
      const run = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
      if (run) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(runs.get(run[1])));
        return;
      }
      const version = /\/versions\/([^/]+)$/.exec(url.pathname);
      if (version) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ success: true, result: providers.get(version[1]) }),
        );
        return;
      }
      if (url.pathname.endsWith("/deployments")) {
        if (changeHeadOnDeployment) {
          changeHeadOnDeployment = false;
          stored = canonicalV2({ ...JSON.parse(stored), controlRevision: 2 });
          etag = `"${sha(stored)}"`;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: true,
            result: [
              {
                created_on: new Date().toISOString(),
                versions: deploymentVersions,
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/query")) {
        const query = JSON.parse(body);
        let result;
        if (/^\s*SELECT/.test(query.sql))
          result = {
            success: true,
            results: db.raw.prepare(query.sql).all(...query.params),
            meta: { changes: 0 },
          };
        else
          result = {
            success: true,
            results: [],
            meta: {
              changes: Number(
                db.raw.prepare(query.sql).run(...query.params).changes,
              ),
            },
          };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, result: [result] }));
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      unsigned++;
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    const original = new URL(request.url);
    if (original.hostname === "api.github.com")
      assert.ok(
        original.pathname.startsWith("/repos/Iron-Wrap/ironwrap-os/"),
        "actual canonical repository API target",
      );
    const headers = new Headers(request.headers);
    headers.set("x-synthetic-signing-host", original.host);
    return fetch(`${local}${original.pathname}${original.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      redirect: "error",
      signal: request.signal,
    });
  };
  const authorizeInput = {
    policyRoot: p0.root,
    expectedPolicyCommit: p0.head,
    candidateRoots: { [versions[0]]: p0.root, [versions[1]]: p1.root },
    environment: "qa",
    bindings: contexts,
    bootstrap: true,
    fetcher,
    githubToken: "synthetic-github-token-with-20-characters",
    providerToken: "synthetic-provider-token-with-20-characters",
  };
  const authorization = await impl.authorizeAuthControl(authorizeInput);
  const firstRun = runs.get("1");
  firstRun.head_repository = { full_name: "untrusted-fork/ironwrap-os" };
  await assert.rejects(
    impl.authorizeAuthControl(authorizeInput),
    /auth_control_ci_not_successful/,
  );
  firstRun.head_repository = { full_name: "Iron-Wrap/ironwrap-os" };
  const head = {
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
  };
  const committed = await impl.commitAuthControlUpdate({
    authorization,
    next: head,
    readerAndWriterConfig: config,
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  assert.equal(committed.controlRevision, 1);
  assert.equal(puts, 1);
  const mirror = await impl.writeAuthProtocolMirror({
    authorization,
    config,
    phase: "stage",
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  assert.equal(mirror.enrollment, "closed");
  assert.equal(mirror.mirror.protocol_floor, 1);
  const preflight = await impl.preflightAuthSwitch({
    config,
    versionId: versions[0],
    databaseIdentity: head.databaseIdentity,
    provider: {
      accountId: config.accountId,
      workerName: "ironwrap-bus-qa",
      token: "synthetic-provider-token-with-20-characters",
    },
    fetcher,
  });
  assert.equal(preflight.protocolFloor, 1);
  changeHeadOnDeployment = true;
  await assert.rejects(
    impl.preflightAuthSwitch({
      config,
      versionId: versions[0],
      databaseIdentity: head.databaseIdentity,
      provider: {
        accountId: config.accountId,
        workerName: "ironwrap-bus-qa",
        token: "synthetic-provider-token-with-20-characters",
      },
      fetcher,
    }),
    /auth_control_switch_head_changed/,
  );
  stored = canonicalV2(head);
  etag = `"${sha(stored)}"`;
  assert.throws(() =>
    impl.validateAuthControlTransition(
      head,
      { ...head, controlRevision: 2, minProducerProtocol: 2, mode: "active" },
      authorization,
    ),
  );
  const reader = {
    ...config,
    accessKeyId: keys.reader.id,
    secretAccessKey: keys.reader.secret,
  };
  const readback = await readControlObject(reader, fetcher);
  assert.equal(readback.head.mode, "staged");
  await assert.rejects(
    putControlObject(
      reader,
      { ...head, controlRevision: 2 },
      { ifMatch: readback.etag },
      fetcher,
    ),
  );
  assert.equal(puts, 1);
  assert.equal(unsigned, 0);
  await assert.rejects(signedControlRequest(reader, "DELETE"));
  assert.equal(canonicalV2(JSON.parse(stored)), canonicalV2(head));

  // Two actual read-back protocol2 provider versions over the frozen synthetic P1 source.
  // This exercises control/SQLite adapters, never deployed predecessor qualification.
  providers.set(versions[2], {
    ...providers.get(versions[1]),
    id: versions[2],
  });
  deploymentVersions = [
    { version_id: versions[1], percentage: 100 },
    { version_id: versions[2], percentage: 0 },
  ];
  const pairAuthorization = await impl.authorizeAuthControl({
    policyRoot: p0.root,
    expectedPolicyCommit: p0.head,
    candidateRoots: { [versions[1]]: p1.root, [versions[2]]: p1.root },
    environment: "qa",
    bindings: [
      contexts[1],
      {
        ...contexts[1],
        versionId: versions[2],
        role: "predecessor",
        qaRunId: "4",
      },
    ],
    fetcher,
    githubToken: "synthetic-github-token-with-20-characters",
    providerToken: "synthetic-provider-token-with-20-characters",
  });
  const pair = pairAuthorization.bindings.map(
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
  );
  const closed = {
    ...head,
    controlRevision: 2,
    minProducerProtocol: 2,
    mode: "closed",
    allowedProducerBindings: pair,
  };
  await impl.commitAuthControlUpdate({
    authorization: pairAuthorization,
    next: closed,
    readerAndWriterConfig: config,
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  const cutover = await impl.writeAuthProtocolMirror({
    authorization: pairAuthorization,
    config,
    phase: "cutover",
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  assert.equal(cutover.mirror.protocol_floor, 2);
  assert.equal(cutover.enrollment, "closed");
  const active = { ...closed, controlRevision: 3, mode: "active" };
  await impl.commitAuthControlUpdate({
    authorization: pairAuthorization,
    next: active,
    readerAndWriterConfig: config,
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  const opened = await impl.writeAuthProtocolMirror({
    authorization: pairAuthorization,
    config,
    phase: "open_closed_enrollment",
    providerToken: "synthetic-provider-token-with-20-characters",
    fetcher,
  });
  assert.equal(opened.mirror.enrollment_open, 0);
  const switchArgs = {
    config,
    databaseIdentity: head.databaseIdentity,
    provider: {
      accountId: config.accountId,
      workerName: "ironwrap-bus-qa",
      token: "synthetic-provider-token-with-20-characters",
    },
    fetcher,
  };
  assert.equal(
    (await impl.preflightAuthSwitch({ ...switchArgs, versionId: versions[2] }))
      .protocolFloor,
    2,
  );
  await assert.rejects(
    impl.preflightAuthSwitch({ ...switchArgs, versionId: versions[0] }),
    /auth_control_switch_incompatible/,
  );
  assert.throws(
    () =>
      impl.validateAuthControlTransition(
        active,
        { ...head, controlRevision: 4 },
        pairAuthorization,
      ),
    /auth_control_floor_rollback/,
  );
  deploymentVersions = [
    ...deploymentVersions,
    { version_id: versions[0], percentage: 0 },
  ];
  await assert.rejects(
    impl.preflightAuthSwitch({ ...switchArgs, versionId: versions[2] }),
    /auth_control_unsafe_deployment_member/,
  );
  assert.equal(
    db.raw
      .prepare("SELECT count(*) AS n FROM app_auth_contexts WHERE generation>0")
      .get().n,
    0,
  );
  assert.equal(unsigned, 0);
});
