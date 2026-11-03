import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAppApi } from "../src/app-api.ts";
import type { AppEnv } from "../src/app-types.ts";
import { protocolFixture } from "./auth-protocol-fixture.ts";
import {
  beginEnrollmentV2,
  findFencedSessionV2,
  findGrantV2,
  issueGrantV2,
  readAuthContextV2,
  transitionAuthV2,
  type AuthTransitionV2,
} from "../src/auth-protocol-store.ts";
import {
  canonicalV2,
  decodeV2,
  encodeV2,
  subjectDigestV2,
  validateReceipt,
} from "../../shared/auth-protocol-v2.mjs";
import { protocolContextHashFor, sessionHashFor } from "../src/app-auth.ts";
import * as legacyStore from "../src/app-auth-store.ts";

const auditRequest = {
  ip_hash: "a".repeat(64),
  user_agent_hash: "b".repeat(64),
};
const pin = "p".repeat(43);
type Fixture = ReturnType<typeof protocolFixture>;
async function invoke(
  f: Fixture,
  path: string,
  kind: string,
  base: number,
  options: {
    body?: unknown;
    rawBody?: BodyInit;
    cookie?: string;
    csrf?: string;
    proof?: string;
    issuer?: string | null;
    secret?: string;
  } = {},
) {
  const headers = new Headers({
    Origin: "http://localhost:7100",
    "X-IronWrap-Auth-Context": options.secret ?? pin,
    "X-IronWrap-Auth-Exchange": encodeV2({
      v: 2,
      exchangeId: `exchange-${crypto.randomUUID()}`,
      issuer: options.issuer === undefined ? f.head.issuer : options.issuer,
      kind,
      baseGeneration: base,
    }),
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  if (options.proof) headers.set("x-ironwrap-device-proof", options.proof);
  const hasBody = options.rawBody !== undefined || options.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");
  const original = globalThis.fetch;
  globalThis.fetch = f.fetcher as typeof fetch;
  const tasks: Promise<unknown>[] = [];
  try {
    const response = await handleAppApi(
      new Request(`http://localhost:7100${path}`, {
        method: hasBody ? "POST" : "GET",
        headers,
        body:
          options.rawBody ??
          (options.body ? canonicalV2(options.body) : undefined),
      }),
      f.env,
      {
        waitUntil(task: Promise<unknown>) {
          tasks.push(task);
        },
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);
    return response;
  } finally {
    globalThis.fetch = original;
  }
}

async function enrolledApi() {
  const f = protocolFixture("active", true);
  const user = f.db.user("owner");
  const begin = await invoke(f, "/api/v1/session", "begin_enrollment", 0, {
    body: { operation: "begin_enrollment", intentId: "api-intent" },
  });
  assert.equal(begin.status, 200);
  const intent = (await begin.json()) as { challenge: string };
  const issued = await invoke(
    f,
    "/api/v1/auth/magic-link/request",
    "magic_issue",
    0,
    { body: { email: user.email_normalized } },
  );
  assert.equal(issued.status, 202);
  const href = f.db.raw
    .prepare("SELECT href FROM dev_outbox WHERE kind='magic_link'")
    .get()!.href as string;
  const rawToken = new URLSearchParams(new URL(href).hash.slice(1)).get(
    "token",
  )!;
  const consumed = await invoke(
    f,
    "/api/v1/auth/magic-link/consume",
    "magic_consume",
    0,
    {
      body: {
        token: rawToken,
        intentId: "api-intent",
        challenge: intent.challenge,
      },
    },
  );
  assert.equal(consumed.status, 200);
  const cookie = consumed.headers.get("set-cookie")!.split(";")[0];
  const payload = (await consumed.json()) as Record<string, any>;
  return { ...f, cookie, payload, user };
}

async function pairedApi() {
  const f = await enrolledApi();
  const field = f.db.user("field");
  const secret = "q".repeat(43);
  const proof = "r".repeat(43);
  const begun = await invoke(f, "/api/v1/session", "begin_enrollment", 0, {
    secret,
    body: { operation: "begin_enrollment", intentId: "field-intent" },
  });
  assert.equal(begun.status, 200);
  const intent = (await begun.json()) as { challenge: string };
  const issued = await invoke(f, "/api/v1/device-pairings", "pair_issue", 1, {
    cookie: f.cookie,
    csrf: f.payload.csrf_token,
    body: { field_user_id: field.user_id },
  });
  assert.equal(issued.status, 200);
  const link = (await issued.json()) as { pairing_url: string };
  const rawToken = new URLSearchParams(
    new URL(link.pairing_url).hash.slice(1),
  ).get("token")!;
  const consumed = await invoke(
    f,
    "/api/v1/auth/device-pairing/consume",
    "pair_consume",
    0,
    {
      secret,
      body: {
        token: rawToken,
        device_proof: proof,
        intentId: "field-intent",
        challenge: intent.challenge,
      },
    },
  );
  assert.equal(consumed.status, 200);
  return {
    ...f,
    field,
    secret,
    proof,
    fieldCookie: consumed.headers.get("set-cookie")!.split(";")[0],
    fieldPayload: (await consumed.json()) as Record<string, any>,
  };
}

async function readyOffice() {
  const f = protocolFixture("active", true);
  const user = f.db.user("owner");
  const context = "c".repeat(64);
  const challenge = "d".repeat(43);
  const now = new Date().toISOString();
  await beginEnrollmentV2(f.env, {
    admission: f.admission,
    tenant: "ironwrap",
    context,
    base: 0,
    intent: "intent-office",
    challenge,
    now,
  });
  await issueGrantV2(f.env, {
    admission: f.admission,
    kind: "magic",
    tokenHash: "e".repeat(64),
    user,
    now,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    request: auditRequest,
  });
  const grant = await findGrantV2(
    f.env,
    f.admission,
    "magic",
    "e".repeat(64),
    "ironwrap",
  );
  assert.ok(grant);
  const input: AuthTransitionV2 = {
    admission: f.admission,
    tenant: "ironwrap",
    context,
    base: 0,
    kind: "magic",
    user: grant,
    grant,
    intent: "intent-office",
    challenge,
    newSessionHash: "f".repeat(64),
    deviceId: null,
    deviceProofHash: null,
    now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    request: auditRequest,
  };
  return { ...f, user, context, input };
}

test("P1 never selects legacy authority when the non-restored head is missing", async () => {
  const env = {
    APP_BFF_ENABLED: "true",
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "Synthetic company",
    APP_TENANT_BRAND: "Synthetic",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "http://localhost:7100",
    APP_ALLOWED_ORIGINS: "http://localhost:7100",
    APP_AUTH_PEPPER:
      "synthetic-only-pepper-with-more-than-thirty-two-characters",
  } as unknown as AppEnv;
  const response = await handleAppApi(
    new Request("http://localhost:7100/api/v1/session"),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-ironwrap-auth-receipt"), null);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "auth_control_unavailable",
  );
});

test("a null qualification head is admitted only for explicitly synthetic QA, never ordinary business or an unknown environment", async () => {
  for (const [environment, dataClass] of [
    ["qa", "business"],
    ["production", "synthetic"],
    ["unknown", "synthetic"],
  ]) {
    const f = protocolFixture("active", true);
    f.env.AUTH_CONTROL_ENVIRONMENT = environment;
    f.env.AGENT_DATA_CLASS = dataClass;
    const response = await invoke(f, "/api/v1/session", "observe", 0);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-ironwrap-auth-receipt"), null);
    assert.equal(
      f.db.raw.prepare("SELECT count(*) AS n FROM app_auth_contexts").get()!.n,
      0,
    );
    f.db.raw.close();
  }
});

test("auth bodies reject invalid UTF-8, noncanonical duplicate/space encodings and oversize bytes before issuance", async () => {
  const prefix = new TextEncoder().encode('{"email":"a');
  const suffix = new TextEncoder().encode('b@example.invalid"}');
  const invalidUtf8 = new Uint8Array([...prefix, 255, ...suffix]);
  for (const rawBody of [
    invalidUtf8.buffer,
    '\ufeff{"email":"a@example.invalid"}',
    '{"email":"a@example.invalid"} ',
    '{"email":"a@example.invalid","email":"a@example.invalid"}',
    "x".repeat(4097),
  ]) {
    const f = protocolFixture("active", true);
    const response = await invoke(
      f,
      "/api/v1/auth/magic-link/request",
      "magic_issue",
      0,
      { rawBody },
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-ironwrap-auth-receipt"), null);
    assert.equal(
      f.db.raw.prepare("SELECT count(*) AS n FROM app_magic_links").get()!.n,
      0,
    );
    f.db.raw.close();
  }
});

test("real SQLite authority batch enrolls an office session and recovery fences its old pointer without extending expiry", async () => {
  const f = await readyOffice();
  assert.equal(await transitionAuthV2(f.env, f.input), true);
  const session = await findFencedSessionV2(
    f.env,
    f.admission,
    "ironwrap",
    f.context,
    "f".repeat(64),
  );
  assert.ok(session);
  assert.equal(session.auth_context_generation, 1);
  assert.equal(
    await transitionAuthV2(f.env, {
      ...f.input,
      kind: "recovery",
      base: 1,
      user: session,
      oldSession: session,
      grant: undefined,
      intent: undefined,
      challenge: undefined,
      newSessionHash: "1".repeat(64),
      expiresAt: session.session_expires_at,
    }),
    true,
  );
  assert.equal(
    await findFencedSessionV2(
      f.env,
      f.admission,
      "ironwrap",
      f.context,
      "f".repeat(64),
    ),
    null,
  );
  const current = await findFencedSessionV2(
    f.env,
    f.admission,
    "ironwrap",
    f.context,
    "1".repeat(64),
  );
  assert.ok(current);
  assert.equal(current.auth_context_generation, 2);
  assert.equal(current.session_expires_at, session.session_expires_at);
});

test("a genuinely older unused grant fails the actual intent issuance floor and leaves context/grant/session unchanged", async () => {
  const f = await readyOffice();
  await beginEnrollmentV2(f.env, {
    admission: f.admission,
    tenant: "ironwrap",
    context: f.context,
    base: 0,
    intent: "new-intent",
    challenge: "n".repeat(43),
    now: new Date().toISOString(),
  });
  await assert.rejects(
    transitionAuthV2(f.env, {
      ...f.input,
      intent: "new-intent",
      challenge: "n".repeat(43),
    }),
  );
  assert.equal(
    (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
      .generation,
    0,
  );
  assert.equal(
    f.db.raw.prepare("SELECT consumed_at FROM app_magic_links").get()!
      .consumed_at,
    null,
  );
  assert.equal(
    f.db.raw.prepare("SELECT count(*) AS n FROM app_sessions").get()!.n,
    0,
  );
});

test("lost begin response resumes the original challenge/floor and never adopts a later floor", async () => {
  const f = await readyOffice();
  const repeated = await beginEnrollmentV2(f.env, {
    admission: f.admission,
    tenant: "ironwrap",
    context: f.context,
    base: 0,
    intent: "intent-office",
    challenge: "x".repeat(43),
    now: new Date().toISOString(),
  });
  assert.equal(repeated!.challenge, "d".repeat(43));
  assert.equal(repeated!.issue_floor, 0);
});

test("every injected SQL failure after the winning CAS rolls the real batch back", async () => {
  for (const failAt of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const f = await readyOffice();
    f.db.failAt = failAt;
    await assert.rejects(transitionAuthV2(f.env, f.input));
    assert.equal(
      (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
        .generation,
      0,
      `stage ${failAt}`,
    );
    assert.equal(
      f.db.raw.prepare("SELECT consumed_at FROM app_magic_links").get()!
        .consumed_at,
      null,
    );
    assert.equal(
      f.db.raw.prepare("SELECT count(*) AS n FROM app_sessions").get()!.n,
      0,
    );
  }
});

test("required zero-row session/audit stages abort instead of committing a claimed grant", async () => {
  for (const table of ["app_sessions", "app_auth_audit"]) {
    const f = await readyOffice();
    f.db.raw.exec(
      `CREATE TRIGGER synthetic_zero BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
    );
    await assert.rejects(transitionAuthV2(f.env, f.input));
    assert.equal(
      (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
        .generation,
      0,
    );
    assert.equal(
      f.db.raw.prepare("SELECT consumed_at FROM app_magic_links").get()!
        .consumed_at,
      null,
    );
  }
});

test("P1 staged head/mirror retains P0 anonymous behavior without any v2 enrollment or viewing receipt", async () => {
  const f = protocolFixture("staged");
  const response = await invoke(f, "/api/v1/session", "read", 0);
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { authenticated: boolean }).authenticated,
    false,
  );
  assert.equal(response.headers.get("x-ironwrap-auth-receipt"), null);
  const enrollment = await invoke(f, "/api/v1/session", "begin_enrollment", 0, {
    body: { operation: "begin_enrollment", intentId: "closed" },
  });
  assert.notEqual(enrollment.status, 200);
  assert.equal(
    f.db.raw.prepare("SELECT count(*) AS n FROM app_auth_contexts").get()!.n,
    0,
  );
});

test("P1 closed enrollment and discovery are non-authorizing even with a caller-chosen generation/issuer", async () => {
  const f = protocolFixture("active", false);
  const discovery = await invoke(f, "/api/v1/session", "discovery", 0, {
    issuer: null,
  });
  assert.equal(discovery.status, 200);
  const receipt = validateReceipt(
    decodeV2(discovery.headers.get("x-ironwrap-auth-receipt")!),
  );
  assert.equal(receipt.kind, "metadata");
  assert.equal(receipt.actualIssuer, f.head.issuer);
  assert.equal(receipt.actualContextIdOrNull, null);
  assert.equal(receipt.authenticatedSubjectDigestOrNull, null);
  assert.equal(receipt.producerQualificationReceiptHashOrNull, null);
  const begin = await invoke(f, "/api/v1/session", "begin_enrollment", 0, {
    body: { operation: "begin_enrollment", intentId: "closed" },
  });
  assert.equal(begin.status, 409);
  assert.equal(
    ((await begin.json()) as { error: string }).error,
    "enrollment_closed",
  );
  assert.equal(
    f.db.raw.prepare("SELECT count(*) AS n FROM app_auth_contexts").get()!.n,
    0,
  );
});

test("actual routes issue and consume a genuinely fresh grant, attest canonical DTO, recover and reject stale/foreign cookie pointers", async () => {
  const f = await enrolledApi();
  const read = await invoke(f, "/api/v1/session", "read", 1, {
    cookie: f.cookie,
  });
  assert.equal(read.status, 200);
  const dto = (await read.json()) as Record<string, any>;
  const receipt = validateReceipt(
    decodeV2(read.headers.get("x-ironwrap-auth-receipt")!),
  );
  assert.equal(receipt.kind, "authenticated");
  assert.equal(receipt.actualGenerationOrNull, 1);
  assert.equal(
    receipt.authenticatedSubjectDigestOrNull,
    await subjectDigestV2(dto, null),
  );
  assert.equal(
    dto.auth_context.subjectDigest,
    receipt.authenticatedSubjectDigestOrNull,
  );
  assert.equal(
    read.headers
      .get("access-control-expose-headers")!
      .includes("X-IronWrap-Auth-Receipt"),
    true,
  );
  assert.equal(
    read.headers.get("access-control-expose-headers")!.includes("Set-Cookie"),
    false,
  );
  const recovery = await invoke(f, "/api/v1/session", "recovery", 1, {
    cookie: f.cookie,
    csrf: dto.csrf_token,
    body: { operation: "recover" },
  });
  assert.equal(recovery.status, 200);
  const repaired = (await recovery.json()) as Record<string, any>;
  assert.equal(repaired.auth_context.generation, 2);
  assert.equal(repaired.session_expires_at, dto.session_expires_at);
  const old = await invoke(f, "/api/v1/session", "read", 1, {
    cookie: f.cookie,
  });
  assert.equal(old.status, 409);
  assert.equal(old.headers.get("set-cookie"), null);
  assert.equal(
    ((await old.json()) as { error: string }).error,
    "cookie_required",
  );
  const cookie = recovery.headers.get("set-cookie")!.split(";")[0];
  const foreign = await invoke(f, "/api/v1/session", "read", 2, {
    cookie,
    secret: "q".repeat(43),
  });
  assert.equal(foreign.status, 409);
  assert.equal(
    validateReceipt(decodeV2(foreign.headers.get("x-ironwrap-auth-receipt")!))
      .kind,
    "refused",
  );
  const context = await protocolContextHashFor(f.env, "ironwrap", pin);
  const raw = cookie.split("=")[1];
  assert.ok(
    await findFencedSessionV2(
      f.env,
      f.admission,
      "ironwrap",
      context,
      await sessionHashFor(f.env, raw, f.head.issuer),
    ),
  );
});

test("actual supervised pairing and protected GET distinguish missing proof from a stale cookie without expiring either", async () => {
  const f = await pairedApi();
  const proofless = await invoke(f, "/api/v1/session", "read", 1, {
    secret: f.secret,
    cookie: f.fieldCookie,
  });
  assert.equal(proofless.status, 401);
  assert.equal(
    ((await proofless.json()) as { error: string }).error,
    "device_proof_required",
  );
  assert.equal(proofless.headers.get("set-cookie"), null);
  const valid = await invoke(f, "/api/v1/session", "read", 1, {
    secret: f.secret,
    cookie: f.fieldCookie,
    proof: f.proof,
  });
  assert.equal(valid.status, 200);
  const receipt = validateReceipt(
    decodeV2(valid.headers.get("x-ironwrap-auth-receipt")!),
  );
  assert.equal(
    receipt.authenticatedSubjectDigestOrNull,
    await subjectDigestV2(
      (await valid.json()) as Record<string, any>,
      f.db.raw.prepare("SELECT device_proof_hash FROM app_devices").get()!
        .device_proof_hash as string,
    ),
  );
  const stale = await invoke(f, "/api/v1/session", "read", 1, {
    secret: f.secret,
    cookie: f.cookie,
    proof: f.proof,
  });
  assert.equal(stale.status, 409);
  assert.equal(
    ((await stale.json()) as { error: string }).error,
    "cookie_required",
  );
  assert.equal(stale.headers.get("set-cookie"), null);
});

test("actual old role CAS rebinds only the live pointer and old withdrawal SQL advances once", async () => {
  const f = await readyOffice();
  assert.equal(await transitionAuthV2(f.env, f.input), true);
  const changed = await legacyStore.setAppUserAccessRole(f.env, {
    tenantId: "ironwrap",
    userId: f.user.user_id,
    role: "ops",
    now: new Date().toISOString(),
    authority: {
      actorUserId: f.user.user_id,
      actorRole: "owner",
      expectedTarget: f.user,
    },
  });
  assert.ok(changed);
  const row = await readAuthContextV2(
    f.env,
    "ironwrap",
    f.head.issuer,
    f.context,
  );
  assert.equal(row!.generation, 2);
  assert.equal(row!.current_session_hash, "f".repeat(64));
  const session = await findFencedSessionV2(
    f.env,
    f.admission,
    "ironwrap",
    f.context,
    "f".repeat(64),
  );
  assert.ok(session);
  assert.equal(session.role, "ops");
  assert.equal(session.session_expires_at, f.input.expiresAt);
  const withdrawn = await legacyStore.setAppUserActive(f.env, {
    tenantId: "ironwrap",
    userId: changed.user_id,
    active: false,
    now: new Date().toISOString(),
    authority: {
      actorUserId: changed.user_id,
      actorRole: "ops",
      expectedTarget: changed,
    },
  });
  assert.ok(withdrawn);
  const stopped = await readAuthContextV2(
    f.env,
    "ironwrap",
    f.head.issuer,
    f.context,
  );
  assert.equal(stopped!.generation, 3);
  assert.equal(stopped!.current_session_hash, null);
  assert.equal(
    await findFencedSessionV2(
      f.env,
      f.admission,
      "ironwrap",
      f.context,
      "f".repeat(64),
    ),
    null,
  );
});

test("old device revocation SQL and its redundant session update invalidate a field context once", async () => {
  const f = await pairedApi();
  const context = await protocolContextHashFor(f.env, "ironwrap", f.secret);
  const device = f.db.raw.prepare("SELECT device_id FROM app_devices").get()!
    .device_id as string;
  assert.equal(
    await legacyStore.revokeDeviceBinding(f.env, {
      tenantId: "ironwrap",
      deviceId: device,
      revokedByUserId: f.user.user_id,
      now: new Date().toISOString(),
    }),
    true,
  );
  const row = await readAuthContextV2(
    f.env,
    "ironwrap",
    f.head.issuer,
    context,
  );
  assert.equal(row!.generation, 2);
  assert.equal(row!.current_session_hash, null);
});

test("a paired-device ownership change withdraws the original field pointer instead of accepting another user's row", async () => {
  const f = await pairedApi();
  const next = f.db.user("field", "different-paired-owner");
  f.db.raw.prepare("UPDATE app_devices SET user_id=?").run(next.user_id);
  const context = await protocolContextHashFor(f.env, "ironwrap", f.secret);
  const row = await readAuthContextV2(
    f.env,
    "ironwrap",
    f.head.issuer,
    context,
  );
  assert.equal(row!.generation, 2);
  assert.equal(row!.current_session_hash, null);
  const read = await invoke(f, "/api/v1/session", "read", 2, {
    secret: f.secret,
    cookie: f.fieldCookie,
    proof: f.proof,
  });
  assert.equal(read.status, 409);
  assert.equal(
    validateReceipt(decodeV2(read.headers.get("x-ironwrap-auth-receipt")!))
      .kind,
    "refused",
  );
});

test("required zero-row grant/device stages and final database-clock expiry guard roll every change back", async () => {
  for (const target of ["grant", "expiry"]) {
    const f = await readyOffice();
    if (target === "grant")
      f.db.raw.exec(
        "CREATE TRIGGER synthetic_zero BEFORE UPDATE OF consumed_at ON app_magic_links BEGIN SELECT RAISE(IGNORE); END",
      );
    else {
      f.input.now = new Date(Date.now() - 60000).toISOString();
      f.db.raw
        .prepare("UPDATE app_magic_links SET created_at=?")
        .run(f.input.now);
      f.db.raw
        .exec(`CREATE TRIGGER synthetic_expiry AFTER INSERT ON app_auth_audit WHEN NEW.event='v2_magic'
        BEGIN UPDATE app_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second'); END`);
    }
    await assert.rejects(transitionAuthV2(f.env, f.input));
    assert.equal(
      (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
        .generation,
      0,
    );
    assert.equal(
      f.db.raw.prepare("SELECT consumed_at FROM app_magic_links").get()!
        .consumed_at,
      null,
    );
    assert.equal(
      f.db.raw.prepare("SELECT count(*) AS n FROM app_sessions").get()!.n,
      0,
    );
  }
  const f = await pairedApi();
  const field = f.db.user("field", "second-field");
  const context = "2".repeat(64);
  const now = new Date().toISOString();
  await beginEnrollmentV2(f.env, {
    admission: f.admission,
    tenant: "ironwrap",
    context,
    base: 0,
    intent: "second-field",
    challenge: "s".repeat(43),
    now,
  });
  const owner = await findFencedSessionV2(
    f.env,
    f.admission,
    "ironwrap",
    await protocolContextHashFor(f.env, "ironwrap", pin),
    await sessionHashFor(f.env, f.cookie.split("=")[1], f.head.issuer),
  );
  assert.ok(owner);
  await issueGrantV2(f.env, {
    admission: f.admission,
    kind: "pair",
    tokenHash: "3".repeat(64),
    user: field,
    actor: owner,
    now,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    request: auditRequest,
  });
  const grant = await findGrantV2(
    f.env,
    f.admission,
    "pair",
    "3".repeat(64),
    "ironwrap",
  );
  assert.ok(grant);
  f.db.raw.exec(
    "CREATE TRIGGER synthetic_zero BEFORE INSERT ON app_devices BEGIN SELECT RAISE(IGNORE); END",
  );
  await assert.rejects(
    transitionAuthV2(f.env, {
      admission: f.admission,
      tenant: "ironwrap",
      context,
      base: 0,
      kind: "pair",
      user: grant,
      grant,
      intent: "second-field",
      challenge: "s".repeat(43),
      newSessionHash: "4".repeat(64),
      deviceId: `appd_${crypto.randomUUID()}`,
      deviceProofHash: "5".repeat(64),
      now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      request: auditRequest,
    }),
  );
  assert.equal(
    (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, context))!
      .generation,
    0,
  );
  assert.equal(
    f.db.raw
      .prepare("SELECT consumed_at FROM app_device_pairings WHERE token_hash=?")
      .get("3".repeat(64))!.consumed_at,
    null,
  );
});

test("same-base competing principals execute in both real SQLite commit orders; loser keeps its grant", async () => {
  for (const reverse of [false, true]) {
    const f = await readyOffice();
    const user = f.db.user("ops", "other-ops");
    const now = new Date().toISOString();
    await issueGrantV2(f.env, {
      admission: f.admission,
      kind: "magic",
      tokenHash: "6".repeat(64),
      user,
      now,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      request: auditRequest,
    });
    const grant = await findGrantV2(
      f.env,
      f.admission,
      "magic",
      "6".repeat(64),
      "ironwrap",
    );
    assert.ok(grant);
    // Both grants exist before either competing transition starts. A timestamp captured
    // before issuing the second grant would incorrectly predate that grant's creation.
    const commitNow = new Date().toISOString();
    const other = {
      ...f.input,
      now: commitNow,
      user: grant,
      grant,
      newSessionHash: "7".repeat(64),
    };
    const original = { ...f.input, now: commitNow };
    const [first, last] = reverse ? [other, original] : [original, other];
    assert.equal(await transitionAuthV2(f.env, first), true);
    await assert.rejects(transitionAuthV2(f.env, last));
    assert.equal(
      (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
        .generation,
      1,
    );
    assert.equal(
      f.db.raw
        .prepare("SELECT consumed_at FROM app_magic_links WHERE token_hash=?")
        .get(last.grant!.token_hash)!.consumed_at,
      null,
    );
    assert.equal(
      f.db.raw.prepare("SELECT count(*) AS n FROM app_sessions").get()!.n,
      1,
    );
  }
});

test("an old fetched active control head cannot commit after a completed close/reopen revision barrier", async () => {
  const f = await readyOffice();
  f.db.raw.exec(
    "UPDATE app_auth_protocol SET mode='closed',control_revision=2,enrollment_open=0",
  );
  f.db.raw.exec(
    "UPDATE app_auth_protocol SET mode='active',control_revision=3,enrollment_open=1",
  );
  await assert.rejects(transitionAuthV2(f.env, f.input));
  assert.equal(
    (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
      .generation,
    0,
  );
  assert.equal(
    f.db.raw.prepare("SELECT consumed_at FROM app_magic_links").get()!
      .consumed_at,
    null,
  );
  assert.equal(
    f.db.raw.prepare("SELECT count(*) AS n FROM app_sessions").get()!.n,
    0,
  );
});

test("context/floor/sequence tombstones and non-integer/overflow counters never reset or wrap", async () => {
  const f = await readyOffice();
  for (const sql of [
    "DELETE FROM app_auth_contexts",
    "DELETE FROM app_auth_issuance",
    "DELETE FROM app_auth_protocol",
    "UPDATE app_auth_protocol SET protocol_floor=1,mode='staged'",
    "UPDATE app_auth_contexts SET generation=0.5",
    "UPDATE app_auth_issuance SET sequence=0.5",
  ])
    assert.throws(() => f.db.raw.exec(sql));
  assert.throws(() =>
    f.db.raw.exec("UPDATE app_auth_issuance SET sequence=9007199254740991"),
  );
  assert.equal(
    await transitionAuthV2(f.env, {
      ...f.input,
      base: Number.MAX_SAFE_INTEGER,
    }),
    false,
  );
  assert.equal(
    await transitionAuthV2(f.env, {
      ...f.input,
      base: Number.MAX_SAFE_INTEGER + 1,
    }),
    false,
  );
  assert.equal(
    (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, f.context))!
      .generation,
    0,
  );
});

test("logout is a fenced signed-out acknowledgement; its old cookie cannot reopen the context", async () => {
  const f = await enrolledApi();
  const out = await invoke(f, "/api/v1/auth/logout", "logout", 1, {
    cookie: f.cookie,
    csrf: f.payload.csrf_token,
    body: {},
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  const receipt = validateReceipt(
    decodeV2(out.headers.get("x-ironwrap-auth-receipt")!),
  );
  assert.equal(receipt.kind, "metadata");
  assert.equal(receipt.status, "signed_out");
  assert.equal(receipt.actualGenerationOrNull, 2);
  const old = await invoke(f, "/api/v1/session", "read", 2, {
    cookie: f.cookie,
  });
  assert.equal(old.status, 409);
  assert.equal(
    validateReceipt(decodeV2(old.headers.get("x-ironwrap-auth-receipt")!))
      .authenticatedSubjectDigestOrNull,
    null,
  );
});

test("control loss after a committed recovery withholds cookie/receipt; a genuinely later new grant can restore current authority", async () => {
  const f = await enrolledApi();
  const good = f.fetcher;
  let calls = 0;
  f.fetcher = async (request) => {
    if (++calls === 2) throw new Error("synthetic_control_cut");
    return good(request);
  };
  const lost = await invoke(f, "/api/v1/session", "recovery", 1, {
    cookie: f.cookie,
    csrf: f.payload.csrf_token,
    body: { operation: "recover" },
  });
  assert.equal(lost.status, 503);
  assert.equal(lost.headers.get("set-cookie"), null);
  assert.equal(lost.headers.get("x-ironwrap-auth-receipt"), null);
  const context = await protocolContextHashFor(f.env, "ironwrap", pin);
  assert.equal(
    (await readAuthContextV2(f.env, "ironwrap", f.head.issuer, context))!
      .generation,
    2,
  );
  f.fetcher = good;
  const begin = await invoke(f, "/api/v1/session", "begin_enrollment", 2, {
    body: { operation: "begin_enrollment", intentId: "after-lost-recovery" },
  });
  assert.equal(begin.status, 200);
  const intent = (await begin.json()) as { challenge: string };
  assert.equal(
    (
      await invoke(f, "/api/v1/auth/magic-link/request", "magic_issue", 2, {
        body: { email: f.user.email_normalized },
      })
    ).status,
    202,
  );
  const href = f.db.raw
    .prepare(
      "SELECT href FROM dev_outbox WHERE kind='magic_link' ORDER BY rowid DESC LIMIT 1",
    )
    .get()!.href as string;
  const rawToken = new URLSearchParams(new URL(href).hash.slice(1)).get(
    "token",
  )!;
  const restored = await invoke(
    f,
    "/api/v1/auth/magic-link/consume",
    "magic_consume",
    2,
    {
      body: {
        token: rawToken,
        intentId: "after-lost-recovery",
        challenge: intent.challenge,
      },
    },
  );
  assert.equal(restored.status, 200);
  assert.equal(
    ((await restored.json()) as Record<string, any>).auth_context.generation,
    3,
  );
});
