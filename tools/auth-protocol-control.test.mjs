import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTH_CONTROL_WRITER_POLICY_FILES,
  AUTH_PROTOCOL_POLICY_FILES,
  validateAuthControlTransition,
} from "./auth-protocol-control.mjs";
import {
  RELEASE_POLICY_FILES,
  computeReleasePolicyHash,
} from "./release-promotion.mjs";
import {
  readControlObject,
  putControlObject,
  signedControlRequest,
} from "../shared/auth-control-s3.mjs";
import { canonicalV2 } from "../shared/auth-protocol-v2.mjs";
import {
  credentials,
  versions,
  sha,
  memoryS3,
  sourceCapsules,
  sourceBoundP1Database,
  harness,
  githubToken,
  providerToken,
} from "./test-fixtures/auth-control.mjs";

let capsules;
before(async () => {
  capsules = await sourceCapsules();
});
after(async () => {
  await capsules?.cleanup();
});

test("P0 release hash includes the complete Node writer closure without absent P1 runtime/schema", async () => {
  assert.equal(new Set(RELEASE_POLICY_FILES).size, RELEASE_POLICY_FILES.length);
  for (const name of AUTH_CONTROL_WRITER_POLICY_FILES)
    assert.ok(RELEASE_POLICY_FILES.includes(name), name);
  for (const name of AUTH_PROTOCOL_POLICY_FILES.filter((name) =>
    name.startsWith("workers-bus/"),
  ))
    assert.ok(!RELEASE_POLICY_FILES.includes(name), name);
  assert.match(
    await computeReleasePolicyHash(new URL("..", import.meta.url).pathname),
    /^[0-9a-f]{64}$/,
  );
});

test("fabricated or JSON-roundtripped authorizations cannot write", async (t) => {
  const h = await harness(capsules, t);
  assert.throws(
    () =>
      validateAuthControlTransition(
        null,
        {},
        Object.freeze({ bootstrap: true, environment: "qa" }),
      ),
    /verified_predecessor_required/,
  );
  const authorization = await h.authorize();
  assert.ok(Object.isFrozen(authorization.bindings[0]));
  assert.throws(() => {
    authorization.bindings[0].issuer = "forged";
  }, TypeError);
  await assert.rejects(
    h.commit(JSON.parse(JSON.stringify(authorization)), h.head(authorization)),
    /verified_predecessor_required/,
  );
  assert.equal(h.s3.puts, 0);
});

test("signed loopback HTTP has one CAS winner, read-only credentials and no unconditional retry", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  const store = memoryS3();
  let serverError = null;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        headers = new Headers(incoming.headers);
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers,
        body: incoming.method === "GET" ? undefined : body,
      });
      const response = await store.fetch(
        request,
        headers.get("x-synthetic-signing-host"),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      serverError = error;
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const fetcher = async (input) => {
    const request = new Request(input),
      original = new URL(request.url),
      headers = new Headers(request.headers);
    headers.set("x-synthetic-signing-host", original.host);
    return fetch(
      `http://127.0.0.1:${server.address().port}${original.pathname}`,
      {
        method: request.method,
        headers,
        body:
          request.method === "GET" ? undefined : await request.arrayBuffer(),
        redirect: "error",
        signal: request.signal,
      },
    );
  };
  const initial = await putControlObject(
    h.config,
    head,
    { ifNoneMatch: "*" },
    fetcher,
  );
  const next = { ...head, controlRevision: 2 };
  const results = await Promise.allSettled([
    putControlObject(h.config, next, { ifMatch: initial.etag }, fetcher),
    putControlObject(h.config, next, { ifMatch: initial.etag }, fetcher),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const loser = results.find((result) => result.status === "rejected");
  assert.equal(loser.reason.message, "auth_control_cas_lost");
  assert.equal(loser.reason.currentHeadHash, sha(canonicalV2(next)));
  const reader = {
    ...h.config,
    accessKeyId: credentials.reader.id,
    secretAccessKey: credentials.reader.secret,
  };
  assert.equal(
    (await readControlObject(reader, fetcher)).head.controlRevision,
    2,
  );
  await assert.rejects(
    putControlObject(
      reader,
      { ...next, controlRevision: 3 },
      { ifMatch: store.etag },
      fetcher,
    ),
  );
  assert.equal(store.puts, 2);
  assert.equal(serverError, null);
  for (const condition of [
    {},
    { ifMatch: store.etag, ifNoneMatch: "*" },
    { ifMatch: "unquoted" },
  ])
    await assert.rejects(
      signedControlRequest(h.config, "PUT", canonicalV2(next), condition),
    );
  await assert.rejects(signedControlRequest(h.config, "DELETE"));
  const signed = await signedControlRequest(h.config, "GET");
  assert.equal(signed.redirect, "error");
  assert.equal(signed.cache, "no-store");
});

test("control reads fail closed on missing, malformed, oversized or noncanonical objects", async (t) => {
  const h = await harness(capsules, t);
  assert.equal(
    await readControlObject(
      h.config,
      async () => new Response(null, { status: 404 }),
    ),
    null,
  );
  for (const response of [
    new Response("{}"),
    new Response("{}", { headers: { etag: '"test"' } }),
    new Response("x".repeat(65537), { headers: { etag: '"test"' } }),
    new Response(null, { status: 403 }),
  ])
    await assert.rejects(readControlObject(h.config, async () => response));
  const authorization = await h.authorize();
  const head = h.head(authorization);
  await assert.rejects(
    readControlObject(
      h.config,
      async () =>
        new Response(JSON.stringify(head, null, 2), {
          headers: { etag: '"test"' },
        }),
    ),
  );
  await assert.rejects(h.switch(versions[0]), /head_missing/);
  assert.equal(h.s3.puts, 0);
});

test("source, repository, workflow, predecessor and provider metadata are bound before any write", async (t) => {
  const h = await harness(capsules, t);
  for (const [id, field, value, expected] of [
    [
      "1",
      "repository",
      { full_name: "Iron-Wrap/ironwrap" },
      /ci_not_successful/,
    ],
    [
      "1",
      "head_repository",
      { full_name: "untrusted/ironwrap-os" },
      /ci_not_successful/,
    ],
    ["3", "head_sha", "0".repeat(40), /ci_source_drift/],
    ["3", "event", "pull_request", /ci_source_drift/],
    [
      "2",
      "path",
      ".github/workflows/ci.yml",
      /predecessor_qualification_missing/,
    ],
  ]) {
    const old = h.runs.get(id);
    h.runs.set(id, { ...old, [field]: value });
    await assert.rejects(h.authorize(), expected);
    h.runs.set(id, old);
  }
  const provider = h.providers.get(versions[1]),
    original = structuredClone(provider);
  provider.annotations["workers/message"] += "forged";
  await assert.rejects(h.authorize(), /version_.*(?:invalid|drift)/);
  h.providers.set(versions[1], original);
  for (const mutation of [
    (bindings) =>
      bindings.filter((entry) => entry.name !== "CF_VERSION_METADATA"),
    (bindings) => [
      ...bindings,
      {
        name: "RELEASE_AUTH_CONTROL_R2_SECRET_ACCESS_KEY",
        type: "secret_text",
      },
    ],
    (bindings) =>
      bindings.filter(
        (entry) => entry.name !== "AUTH_CONTROL_READ_ACCESS_KEY_ID",
      ),
    (bindings) => [...bindings, bindings[0]],
  ]) {
    h.providers.set(versions[1], {
      ...original,
      resources: {
        ...original.resources,
        bindings: mutation(original.resources.bindings),
      },
    });
    await assert.rejects(h.authorize());
  }
  h.providers.set(versions[1], original);
  await assert.rejects(
    h.authorize(true, { expectedPolicyCommit: "0".repeat(40) }),
    /trusted_predecessor_required/,
  );
  await assert.rejects(
    h.authorize(false, {
      bindings: h.contexts
        .slice(1)
        .map((entry) => ({ ...entry, role: "candidate" })),
    }),
    /candidate_predecessor_pair_required/,
  );
  assert.equal(h.s3.puts, 0);
});

test("explicit staged bootstrap writes and mirrors without opening recovery; CLI dispatch writes bound receipts", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  const proposalPath = path.join(capsules.parent, "cli-proposal.json"),
    output = path.join(capsules.parent, "cli-receipt.json");
  const input = h.input();
  delete input.fetcher;
  delete input.githubToken;
  delete input.providerToken;
  await writeFile(proposalPath, JSON.stringify({ ...input, next: head }));
  const savedFetch = globalThis.fetch;
  const values = {
    RELEASE_AUTH_CONTROL_R2_ACCESS_KEY_ID: credentials.writer.id,
    RELEASE_AUTH_CONTROL_R2_SECRET_ACCESS_KEY: credentials.writer.secret,
    GH_TOKEN: githubToken,
    CLOUDFLARE_API_TOKEN: providerToken,
  };
  const savedEnv = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  globalThis.fetch = h.fetcher;
  Object.assign(process.env, values);
  const args = [
    "--repo-root",
    capsules.p1.root,
    "--environment",
    "qa",
    "--input",
    proposalPath,
    "--policy-commit",
    capsules.p0.head,
    "--output",
    output,
  ];
  await h.cli.main(["auth-control-update", ...args]);
  const receipt = JSON.parse(await readFile(output));
  assert.equal(receipt.policyCommit, capsules.p0.head);
  assert.equal(receipt.headHash, sha(canonicalV2(head)));
  await h.cli.main(["auth-protocol-mirror", ...args, "--phase", "stage"]);
  assert.equal(JSON.parse(await readFile(output)).mirror.enrollment_open, 0);
  await h.cli.main([
    "auth-switch-preflight",
    ...args,
    "--version-id",
    versions[0],
  ]);
  assert.equal(JSON.parse(await readFile(output)).protocolFloor, 1);
  assert.equal(h.s3.puts, 1);
  delete process.env.RELEASE_AUTH_CONTROL_R2_SECRET_ACCESS_KEY;
  const beforeRequests = h.requests.length;
  await assert.rejects(
    h.cli.main(["auth-control-update", ...args]),
    /release_auth_control_r2_secret_access_key_missing/,
  );
  assert.equal(h.requests.length, beforeRequests);
  assert.equal(
    h.db
      .prepare("SELECT count(*) AS n FROM app_auth_contexts WHERE generation>0")
      .get().n,
    0,
  );
});

test("bootstrap refuses a previously staged mirror after unexpected external-head loss", async (t) => {
  const h = await harness(capsules, t);
  await h.stage();
  h.s3.set(null);
  await assert.rejects(h.authorize(), /genesis_not_preactivation/);
  assert.equal(h.s3.puts, 1);
});

test("a cached bootstrap authorization cannot recreate a lost head after staging", async (t) => {
  const h = await harness(capsules, t),
    { authorization, head } = await h.stage();
  h.s3.set(null);
  await assert.rejects(
    h.commit(authorization, head),
    /genesis_not_preactivation/,
  );
  assert.equal(h.s3.puts, 1);
});

test("genesis rechecks legacy membership immediately before conditional PUT", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  h.deploymentVersions = [
    { version_id: versions[0], percentage: 100 },
    { version_id: versions[3], percentage: 0 },
  ];
  await assert.rejects(
    h.commit(authorization, head),
    /legacy_predecessor_not_current/,
  );
  assert.equal(h.s3.puts, 0);
});

test("genesis rechecks the pristine empty mirror immediately before conditional PUT", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  h.db
    .prepare("INSERT INTO app_auth_contexts VALUES('unexpected-enrolled',1)")
    .run();
  await assert.rejects(
    h.commit(authorization, head),
    /genesis_not_preactivation/,
  );
  assert.equal(h.s3.puts, 0);
});

test("stage SQL refuses a concurrent enrolled context", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  await h.commit(authorization, head);
  h.db
    .prepare("INSERT INTO app_auth_contexts VALUES('unexpected-enrolled',1)")
    .run();
  await assert.rejects(
    h.mirror(authorization, "stage"),
    /mirror_write_unconfirmed/,
  );
  assert.equal(
    h.db.prepare("SELECT control_revision FROM app_auth_protocol").get()
      .control_revision,
    0,
  );
});

test("stage SQL refuses a crossed activation identity", async (t) => {
  const h = await harness(capsules, t),
    authorization = await h.authorize(),
    head = h.head(authorization);
  await h.commit(authorization, head);
  h.db
    .prepare(
      "UPDATE app_auth_protocol SET issuer=?,activation_id=?,database_identity=?,control_revision=1",
    )
    .run(head.issuer, "crossed-activation", head.databaseIdentity);
  await assert.rejects(
    h.mirror(authorization, "stage"),
    /mirror_write_unconfirmed/,
  );
});

test("stage and cutover fences are evaluated by the same SQL write as the mirror mutation", async (t) => {
  for (const phase of ["stage", "cutover"]) {
    for (const drift of ["enrollment", "context", "activation"]) {
      await t.test(`${phase}-${drift}`, async (child) => {
        const h = await harness(capsules, child);
        let authorization;
        if (phase === "stage") {
          authorization = await h.authorize();
          await h.commit(authorization, h.head(authorization));
        } else {
          await h.stage();
          h.deploymentVersions = [
            { version_id: versions[1], percentage: 100 },
            { version_id: versions[2], percentage: 0 },
          ];
          authorization = await h.authorize(false);
          await h.commit(authorization, {
            ...h.head(authorization),
            controlRevision: 2,
            minProducerProtocol: 2,
            mode: "closed",
          });
        }
        h.beforeD1 = (query) => {
          if (!query.sql.startsWith("UPDATE")) return;
          h.beforeD1 = null;
          if (drift === "enrollment")
            h.db.exec("UPDATE app_auth_protocol SET enrollment_open=1");
          if (drift === "context")
            h.db.exec(
              "INSERT INTO app_auth_contexts VALUES('concurrent-context',1)",
            );
          if (drift === "activation")
            h.db.exec(
              "UPDATE app_auth_protocol SET activation_id='crossed-activation'",
            );
        };
        await assert.rejects(
          h.mirror(authorization, phase),
          /mirror_write_unconfirmed/,
        );
        assert.equal(
          h.db.prepare("SELECT protocol_floor FROM app_auth_protocol").get()
            .protocol_floor,
          1,
        );
      });
    }
  }
});

test("deployment membership parsing fails closed instead of accepting an empty or malformed set", async (t) => {
  const h = await harness(capsules, t);
  await h.stage();
  for (const [name, members] of Object.entries({
    empty: [],
    null: [null],
    text_percentage: [{ version_id: versions[0], percentage: "100" }],
    incomplete: [{ version_id: versions[0], percentage: 99 }],
    negative: [{ version_id: versions[0], percentage: -1 }],
    duplicate: [
      { version_id: versions[0], percentage: 100 },
      { version_id: versions[0], percentage: 0 },
    ],
    invalid_version: [{ version_id: "not-a-version", percentage: 100 }],
  })) {
    await t.test(name, async () => {
      h.deploymentVersions = members;
      await assert.rejects(h.switch(versions[0]), /deployment_invalid/);
    });
  }
});

test("two observed P1 versions can close/cut over; zero-percent legacy membership, stale heads and floor rollback stop", async (t) => {
  const h = await harness(capsules, t);
  const { head } = await h.stage();
  h.db.exec(
    "INSERT INTO app_sessions VALUES(1,NULL); INSERT INTO app_magic_links VALUES(1,NULL); INSERT INTO app_device_pairings VALUES(1,NULL,NULL)",
  );
  h.deploymentVersions = [
    { version_id: versions[1], percentage: 100 },
    { version_id: versions[2], percentage: 0 },
  ];
  const pair = await h.authorize(false);
  const closed = {
    ...h.head(pair),
    controlRevision: 2,
    minProducerProtocol: 2,
    mode: "closed",
  };
  await h.commit(pair, closed);
  const cutover = await h.mirror(pair, "cutover");
  assert.equal(cutover.mirror.protocol_floor, 2);
  assert.equal(cutover.mirror.legacy_sessions, 0);
  assert.equal(cutover.mirror.legacy_magic, 0);
  assert.equal(cutover.mirror.legacy_pair, 0);
  const active = { ...closed, controlRevision: 3, mode: "active" };
  await h.commit(pair, active);
  await h.mirror(pair, "open_closed_enrollment");
  assert.equal((await h.switch(versions[2])).protocolFloor, 2);
  await assert.rejects(h.switch(versions[0]), /switch_incompatible/);
  assert.throws(
    () =>
      h.impl.validateAuthControlTransition(
        active,
        { ...head, controlRevision: 4 },
        pair,
      ),
    /floor_rollback/,
  );
  assert.throws(
    () =>
      h.impl.validateAuthControlTransition(
        active,
        {
          ...active,
          controlRevision: 4,
          issuer: "issuer-v2:4:reused",
          allowedProducerBindings: active.allowedProducerBindings.map(
            (entry) => ({ ...entry, issuer: "issuer-v2:4:reused" }),
          ),
        },
        pair,
      ),
    /isolated_fresh_restore_required/,
  );
  assert.throws(
    () =>
      h.impl.validateAuthControlTransition(
        active,
        { ...active, controlRevision: 5 },
        pair,
      ),
    /revision_not_next/,
  );
  assert.throws(
    () =>
      h.impl.validateAuthControlTransition(
        active,
        {
          ...active,
          controlRevision: 4,
          qualificationReceiptHash: "c".repeat(64),
        },
        pair,
      ),
    /qualification_hash_unproven/,
  );
  h.deploymentVersions.push({ version_id: versions[0], percentage: 0 });
  await assert.rejects(h.switch(versions[2]), /unsafe_deployment_member/);
  await assert.rejects(
    h.commit(pair, { ...active, controlRevision: 4 }),
    /unsafe_deployment_member/,
  );
  h.deploymentVersions.pop();
  h.beforeDeployment = () => {
    h.beforeDeployment = null;
    h.s3.set({ ...active, controlRevision: 4 });
  };
  await assert.rejects(h.switch(versions[2]), /switch_head_changed/);
  assert.equal(
    h.db.prepare("SELECT enrollment_open FROM app_auth_protocol").get()
      .enrollment_open,
    0,
  );
});

test("production floor2 needs completed exact QA qualification; source/CI/bootstrap cannot substitute", async (t) => {
  const h = await harness(capsules, t, "production");
  h.deploymentVersions = [
    { version_id: versions[1], percentage: 100 },
    { version_id: versions[2], percentage: 0 },
  ];
  const pair = await h.authorize(false),
    staged = h.head(pair);
  const closed = {
    ...staged,
    controlRevision: 2,
    minProducerProtocol: 2,
    mode: "closed",
  };
  assert.throws(
    () => h.impl.validateAuthControlTransition(staged, closed, pair),
    /completed_qa_qualification_required/,
  );
  assert.equal(h.s3.puts, 0);
});

test("committed P1 SQL fixture composes with current migrations and the exact writer without deployed qualification", async (t) => {
  const h = await harness(capsules, t, "qa", sourceBoundP1Database());
  const created = new Date(0).toISOString(),
    expires = new Date(Date.now() + 60000).toISOString();
  const user = "appu_synthetic_writer_owner";
  h.db
    .prepare(
      `INSERT INTO app_users(user_id,tenant_id,email_normalized,display_name,role,access_role,active,created_by,created_at,updated_at)
    VALUES (?,'ironwrap','writer@example.invalid','Synthetic writer','owner','owner',1,'synthetic',?,?)`,
    )
    .run(user, created, created);
  h.db
    .prepare(
      `INSERT INTO app_sessions(session_hash,user_id,tenant_id,created_at,expires_at,last_seen_at,created_ip_hash,created_user_agent_hash)
    VALUES (?,?,'ironwrap',?,?,?,?,?)`,
    )
    .run(
      "a".repeat(64),
      user,
      created,
      expires,
      created,
      "0".repeat(64),
      "0".repeat(64),
    );
  assert.equal(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM app_sessions WHERE revoked_at IS NULL",
      )
      .get().n,
    1,
  );
  await h.stage();
  h.deploymentVersions = [
    { version_id: versions[1], percentage: 100 },
    { version_id: versions[2], percentage: 0 },
  ];
  const pair = await h.authorize(false);
  await h.commit(pair, {
    ...h.head(pair),
    controlRevision: 2,
    minProducerProtocol: 2,
    mode: "closed",
  });
  const result = await h.mirror(pair, "cutover");
  assert.equal(result.mirror.protocol_floor, 2);
  assert.equal(result.mirror.enrollment_open, 0);
  assert.equal(result.mirror.legacy_sessions, 0);
  assert.equal(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM app_auth_audit WHERE event='auth_protocol_cutover' AND outcome='legacy_retired'",
      )
      .get().n,
    1,
  );
  assert.throws(
    () => h.db.exec("UPDATE app_auth_protocol SET protocol_floor=1"),
    /auth_protocol_floor/,
  );
});
