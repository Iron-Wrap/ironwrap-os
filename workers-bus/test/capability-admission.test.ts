import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  CAPABILITY_ACTION_REGISTRY,
  buildCapabilityReadinessReadModel,
  type CapabilityId,
} from "../src/capability-readiness.ts";
import { SqliteD1, USERS, auth, env } from "./company-setup-fixture.ts";

const SOURCE_COMMIT = "d71941e7f51ded5f677a6b497b09c64c5ca32baf";
const PATH = "https://app.example.invalid/api/v1/integrations";

function manifest(
  id = "capability_manifest_email_v1",
  version = 1,
  expectedVersion = version - 1,
) {
  const capabilityId: CapabilityId = "email_delivery";
  return {
    manifest_id: id,
    capability_id: capabilityId,
    manifest_version: version,
    expected_version: expectedVersion,
    provider_key: "google",
    provider_realm_ref: "realm:google-synthetic",
    provider_realm_digest_sha256: "e".repeat(64),
    direction: "outbound",
    actions: CAPABILITY_ACTION_REGISTRY[capabilityId].map((name) => ({
      name,
      enabled: true,
    })),
    auth_scope_names: ["gmail.send", "gmail.read"],
    data_class: "business",
    idempotency_contract: "Exact tenant key replays the original receipt.",
    retry_contract: "Bounded retry then provider readback.",
    readback_contract: "Read exact sender and message identity.",
    reconciliation_contract: "An unknown send waits for provider observation.",
    enabled: true,
    proof_ttl_seconds: 86400,
    safe_fallback: "Owner sends manually with a recorded receipt.",
    disable_contract: "Append a disabled manifest version.",
    rollback_contract: "Append a newly approved prior route.",
    tenant_config_digest_sha256: "a".repeat(64),
    credential_binding_digest_sha256: "b".repeat(64),
    route_digest_sha256: "c".repeat(64),
    artifact_digest_sha256: "d".repeat(64),
    source_repository: "Iron-Wrap/ironwrap-os",
    source_commit: SOURCE_COMMIT,
    source_path: "workers-bus/src/google.ts",
  };
}

function profile(
  id = "capability_profile_core_v1",
  version = 1,
  expectedVersion = version - 1,
) {
  const core: CapabilityId[] = [
    "email_delivery",
    "magic_link",
    "cloudflare_worker",
    "pwa",
    "d1",
    "r2",
    "queues",
    "backup_restore",
    "observability",
  ];
  return {
    profile_id: id,
    profile_key: "core",
    profile_version: version,
    expected_version: expectedVersion,
    capabilities: core.map((capability_id, ordinal) => ({
      capability_id,
      required: true,
      ordinal,
    })),
    dependencies: [],
    source_repository: "Iron-Wrap/ironwrap-os",
    source_commit: SOURCE_COMMIT,
    source_path: "config/readiness/core.json",
  };
}

async function post(
  db: SqliteD1,
  path: "manifests" | "profiles",
  body: unknown,
  role: "owner" | "ops" | "sales" = "owner",
  enabled: boolean | null = true,
  csrf = "csrf",
) {
  return handleAuthenticatedRoute(
    new Request(PATH + "/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    }),
    env(
      db,
      enabled === null
        ? {}
        : {
            APP_READINESS_ADMISSION_ENABLED: enabled ? "true" : "false",
          },
    ),
    auth(role),
  );
}

test("admission is disabled by default, office-only, and CSRF-bound", async () => {
  const db = new SqliteD1({ seedUsers: ["owner", "ops", "sales"] });
  assert.equal(
    (await post(db, "manifests", manifest(), "owner", false)).status,
    503,
  );
  assert.equal((await post(db, "manifests", manifest(), "sales")).status, 403);
  assert.equal(
    (await post(db, "manifests", manifest(), "owner", true, "wrong")).status,
    403,
  );
  assert.equal(
    (
      await post(db, "manifests", {
        ...manifest(),
        safe_fallback: "x".repeat(20_000),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("an absent admission flag refuses both declaration writes", async () => {
  const db = new SqliteD1();
  for (const path of ["manifests", "profiles"] as const) {
    const response = await post(
      db,
      path,
      path === "manifests" ? manifest() : profile(),
      "owner",
      null,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "integration_admission_disabled",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_readiness_profiles")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("an enabled admission refuses D1 actor-read faults without writing", async () => {
  for (const path of ["manifests", "profiles"] as const) {
    const db = new SqliteD1();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith("SELECT access_role AS role FROM app_users")) {
        throw new Error("D1 actor read unavailable");
      }
      return originalPrepare(sql);
    };
    const response = await post(
      db,
      path,
      path === "manifests" ? manifest() : profile(),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "integration_admission_store_unavailable",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM capability_readiness_profiles")
          .get() as { n: number }
      ).n,
      0,
    );
  }
});

test("an enabled admission refuses D1 insert faults without writing", async () => {
  for (const path of ["manifests", "profiles"] as const) {
    const db = new SqliteD1();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (
        sql.startsWith("INSERT INTO capability_integration_manifests") ||
        sql.startsWith("INSERT INTO capability_readiness_profiles")
      ) {
        throw new Error("D1 insert unavailable");
      }
      return originalPrepare(sql);
    };
    const response = await post(
      db,
      path,
      path === "manifests" ? manifest() : profile(),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "integration_admission_store_unavailable",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM capability_readiness_profiles")
          .get() as { n: number }
      ).n,
      0,
    );
  }
});

test("an admission whose insert committed before D1 failed replays the durable row", async () => {
  for (const path of ["manifests", "profiles"] as const) {
    const db = new SqliteD1();
    const table =
      path === "manifests"
        ? "capability_integration_manifests"
        : "capability_readiness_profiles";
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const prepared = originalPrepare(sql);
      if (!sql.startsWith(`INSERT INTO ${table}`)) return prepared;
      return {
        bind: (...args: unknown[]) => {
          const statement = prepared.bind(...args);
          const originalRun = statement.run.bind(statement);
          statement.run = async () => {
            await originalRun();
            throw new Error("D1 answer lost after commit");
          };
          return statement;
        },
      };
    };

    const input = path === "manifests" ? manifest() : profile();
    const response = await post(db, path, input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id:
        path === "manifests"
          ? "capability_manifest_email_v1"
          : "capability_profile_core_v1",
      version: 1,
      replayed: true,
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      (
        db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      1,
    );
  }
});

test("the route catches an unexpected admission store fault without a write", async () => {
  for (const path of ["manifests", "profiles"] as const) {
    const db = new SqliteD1();
    const table =
      path === "manifests"
        ? "capability_integration_manifests"
        : "capability_readiness_profiles";
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith(`SELECT * FROM ${table} WHERE`)) {
        throw new Error("D1 lookup unavailable");
      }
      return originalPrepare(sql);
    };

    const response = await post(
      db,
      path,
      path === "manifests" ? manifest() : profile(),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "integration_admission_store_unavailable",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      (
        db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      0,
    );
  }
});

test("one approved manifest is appended once; replay is exact and never writes a proof", async () => {
  const db = new SqliteD1();
  const first = await post(db, "manifests", manifest());
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    id: "capability_manifest_email_v1",
    version: 1,
    replayed: false,
  });
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const retry = await post(db, "manifests", manifest());
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { replayed: boolean }).replayed, true);
  const altered = await post(db, "manifests", {
    ...manifest(),
    provider_realm_ref: "realm:different",
  });
  assert.equal(altered.status, 409);
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_proof_facts")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("manifest versions have a head CAS and cannot skip or race", async () => {
  const db = new SqliteD1();
  assert.equal(
    (
      await post(
        db,
        "manifests",
        manifest("capability_manifest_email_v2", 2, 1),
      )
    ).status,
    409,
  );
  assert.equal((await post(db, "manifests", manifest())).status, 201);
  const contenders = await Promise.all([
    post(db, "manifests", manifest("capability_manifest_email_v2a", 2, 1)),
    post(db, "manifests", manifest("capability_manifest_email_v2b", 2, 1)),
  ]);
  assert.deepEqual(
    contenders.map((response) => response.status).sort(),
    [201, 409],
  );
  assert.deepEqual(
    db.raw
      .prepare(
        "SELECT manifest_version FROM capability_integration_manifests ORDER BY manifest_version",
      )
      .all()
      .map((row) => row.manifest_version),
    [1, 2],
  );
});

test("stale role, foreign tenant, malformed registry actions and extra keys are refused", async () => {
  const db = new SqliteD1({ seedUsers: ["owner", "ops"] });
  db.addUser("owner", "other-tenant", "appu_other_owner_1");
  db.raw
    .prepare(
      "UPDATE app_users SET access_role = 'sales', role = 'ops' WHERE user_id = ?",
    )
    .run(USERS.owner);
  assert.equal((await post(db, "manifests", manifest())).status, 403);
  db.raw
    .prepare(
      "UPDATE app_users SET access_role = 'owner', role = 'owner' WHERE user_id = ?",
    )
    .run(USERS.owner);
  assert.equal(
    (await post(db, "manifests", { ...manifest(), tenant_id: "other-tenant" }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(db, "manifests", {
        ...manifest(),
        actions: [{ name: "arbitrary.exec", enabled: true }],
      })
    ).status,
    400,
  );
  for (const direction of ["internal", "inbound"]) {
    assert.equal(
      (await post(db, "manifests", { ...manifest(), direction })).status,
      400,
    );
  }
  assert.equal(
    (await post(db, "manifests", { ...manifest(), auth_scope_names: [] }))
      .status,
    400,
  );
  assert.equal(
    (await post(db, "manifests", { ...manifest(), source_path: "../secret" }))
      .status,
    400,
  );
  assert.equal((await post(db, "manifests", manifest(), "ops")).status, 201);
});

test("malformed scalar types and an overlong scope list are client refusals", async () => {
  const db = new SqliteD1();
  const malformed = [
    { ...manifest(), manifest_id: [manifest().manifest_id] },
    { ...manifest(), provider_key: ["google"] },
    { ...manifest(), direction: ["outbound"] },
    { ...manifest(), data_class: ["business"] },
    {
      ...manifest(),
      auth_scope_names: Array.from(
        { length: 80 },
        (_, index) => `scope.${index}.${"x".repeat(110)}`,
      ),
    },
  ];
  for (const input of malformed) {
    const response = await post(db, "manifests", input);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "integration_manifest_invalid",
    });
  }
  const malformedProfile = await post(db, "profiles", {
    ...profile(),
    profile_id: [profile().profile_id],
  });
  assert.equal(malformedProfile.status, 400);
  assert.deepEqual(await malformedProfile.json(), {
    error: "integration_profile_invalid",
  });
  for (const table of [
    "capability_integration_manifests",
    "capability_readiness_profiles",
  ]) {
    assert.equal(
      (
        db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      0,
    );
  }
});

test("Unicode contract text uses D1 character counts for deterministic refusals", async () => {
  const refusedDb = new SqliteD1();
  const tooShort = await post(refusedDb, "manifests", {
    ...manifest(),
    idempotency_contract: "a😀",
  });
  assert.equal(tooShort.status, 400);
  assert.deepEqual(await tooShort.json(), {
    error: "integration_manifest_invalid",
  });
  assert.equal(
    (
      refusedDb.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    0,
  );
  const acceptedDb = new SqliteD1();
  assert.equal(
    (
      await post(acceptedDb, "manifests", {
        ...manifest(),
        idempotency_contract: "a😀b",
      })
    ).status,
    201,
  );
  const replay = await post(acceptedDb, "manifests", {
    ...manifest(),
    idempotency_contract: "a😀b",
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
});

test("ill-formed Unicode contract text is refused before D1 can replace it", async () => {
  const fields = [
    "idempotency_contract",
    "retry_contract",
    "readback_contract",
    "reconciliation_contract",
    "safe_fallback",
    "disable_contract",
    "rollback_contract",
  ] as const;
  for (const field of fields) {
    const db = new SqliteD1();
    const response = await post(db, "manifests", {
      ...manifest(),
      [field]: "ab\uD800",
    });
    assert.equal(response.status, 400, field);
    assert.deepEqual(await response.json(), {
      error: "integration_manifest_invalid",
    });
    assert.equal(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
          .get() as { n: number }
      ).n,
      0,
      field,
    );
  }
});

test("ill-formed Unicode source paths are refused before D1 can replace them", async () => {
  for (const [kind, body, table, error] of [
    [
      "manifests",
      { ...manifest(), source_path: "workers-bus/src/bad\uD800.ts" },
      "capability_integration_manifests",
      "integration_manifest_invalid",
    ],
    [
      "profiles",
      { ...profile(), source_path: "config/readiness/bad\uD800.json" },
      "capability_readiness_profiles",
      "integration_profile_invalid",
    ],
  ] as const) {
    const db = new SqliteD1();
    const response = await post(db, kind, body);
    assert.equal(response.status, 400, kind);
    assert.deepEqual(await response.json(), { error }, kind);
    assert.equal(
      (
        db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      0,
      kind,
    );
  }
});

test("the canonical scope limit accepts 8000 characters and refuses 8001", async () => {
  const scopes = Array.from({ length: 80 }, (_, index) => {
    const prefix = `scope.${index}.`;
    return prefix + "x".repeat((index === 79 ? 96 : 97) - prefix.length);
  });
  assert.equal(JSON.stringify([...scopes].sort()).length, 8_000);
  const acceptedDb = new SqliteD1();
  assert.equal(
    (
      await post(acceptedDb, "manifests", {
        ...manifest(),
        auth_scope_names: scopes,
      })
    ).status,
    201,
  );
  const refusedDb = new SqliteD1();
  const tooLong = [...scopes];
  tooLong[79] += "x";
  assert.equal(JSON.stringify([...tooLong].sort()).length, 8_001);
  const refusal = await post(refusedDb, "manifests", {
    ...manifest(),
    auth_scope_names: tooLong,
  });
  assert.equal(refusal.status, 400);
  assert.deepEqual(await refusal.json(), {
    error: "integration_manifest_invalid",
  });
  assert.equal(
    (
      refusedDb.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("a globally occupied declaration ID gives a generic conflict across tenants", async () => {
  const db = new SqliteD1();
  db.addUser("owner", "other-tenant", "appu_other_owner_1");
  db.addUser("sales", "other-tenant", "appu_other_sales_1");
  assert.equal((await post(db, "manifests", manifest())).status, 201);
  assert.equal((await post(db, "profiles", profile())).status, 201);
  for (const [path, input] of [
    ["manifests", { ...manifest(), source_path: "workers-bus/src/other.ts" }],
    ["profiles", { ...profile(), source_path: "config/readiness/other.json" }],
  ] as const) {
    const sameTenant = await post(db, path, input);
    assert.equal(sameTenant.status, 409);
    assert.deepEqual(await sameTenant.json(), {
      error: "integration_admission_id_conflict",
    });
  }
  const other = auth("owner", "other-tenant");
  other.session.user_id = "appu_other_owner_1";
  const denied = auth("sales", "other-tenant");
  denied.session.user_id = "appu_other_sales_1";
  for (const [path, input] of [
    ["manifests", manifest()],
    ["profiles", profile()],
  ] as const) {
    const idKey = path === "manifests" ? "manifest_id" : "profile_id";
    const deniedReplies = [];
    for (const id of [input[idKey], `capability_${path}_unknown_v1`]) {
      const deniedResponse = await handleAuthenticatedRoute(
        new Request(PATH + "/" + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": "csrf",
          },
          body: JSON.stringify({ ...input, [idKey]: id }),
        }),
        env(db, { APP_READINESS_ADMISSION_ENABLED: "true" }),
        denied,
      );
      assert.equal(deniedResponse.status, 403);
      deniedReplies.push(await deniedResponse.json());
    }
    assert.deepEqual(deniedReplies[0], deniedReplies[1]);
    const response = await handleAuthenticatedRoute(
      new Request(PATH + "/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "csrf" },
        body: JSON.stringify(input),
      }),
      env(db, { APP_READINESS_ADMISSION_ENABLED: "true" }),
      other,
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "integration_admission_id_conflict",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  for (const table of [
    "capability_integration_manifests",
    "capability_readiness_profiles",
  ]) {
    assert.equal(
      (
        db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      1,
    );
  }
});

test("a role removed after the first check cannot admit a manifest through the legacy role", async () => {
  const db = new SqliteD1();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const prepared = originalPrepare(sql);
    if (!sql.startsWith("INSERT INTO capability_integration_manifests"))
      return prepared;
    return {
      bind: (...args: unknown[]) => {
        const statement = prepared.bind(...args);
        const originalRun = statement.run.bind(statement);
        statement.run = async () => {
          db.raw
            .prepare(
              "UPDATE app_users SET access_role = NULL WHERE user_id = ?",
            )
            .run(USERS.owner);
          return originalRun();
        };
        return statement;
      },
    };
  };

  const response = await post(db, "manifests", manifest());
  assert.equal(response.status, 403);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "integration_approver_changed",
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_integration_manifests")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("a second tenant can admit its own version without reading the first tenant", async () => {
  const db = new SqliteD1();
  db.addUser("owner", "other-tenant", "appu_other_owner_1");
  assert.equal((await post(db, "manifests", manifest())).status, 201);
  const other = auth("owner", "other-tenant");
  other.session.user_id = "appu_other_owner_1";
  const response = await handleAuthenticatedRoute(
    new Request(PATH + "/manifests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf" },
      body: JSON.stringify(manifest("capability_manifest_other_v1")),
    }),
    env(db, { APP_READINESS_ADMISSION_ENABLED: "true" }),
    other,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(
    db.raw
      .prepare(
        "SELECT tenant_id FROM capability_integration_manifests ORDER BY tenant_id",
      )
      .all()
      .map((row) => row.tenant_id),
    ["ironwrap", "other-tenant"],
  );
});

test("profiles are immutable, head-bound declarations; incomplete required facts are rejected", async () => {
  const db = new SqliteD1();
  const first = await post(db, "profiles", profile());
  assert.equal(first.status, 201);
  assert.equal((await post(db, "profiles", profile())).status, 200);
  assert.equal(
    (
      await post(db, "profiles", {
        ...profile("capability_profile_core_bad", 2, 1),
        capabilities: profile().capabilities.filter(
          (item) => item.capability_id !== "email_delivery",
        ),
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(db, "profiles", profile("capability_profile_core_gap", 3, 2)))
      .status,
    409,
  );
  assert.equal(
    (await post(db, "profiles", profile("capability_profile_core_v2", 2, 1)))
      .status,
    201,
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_readiness_profiles")
        .get() as { n: number }
    ).n,
    2,
  );
  assert.equal(
    (
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM capability_proof_facts")
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal((await post(db, "manifests", manifest())).status, 201);
  const readiness = await buildCapabilityReadinessReadModel(
    env(db),
    "ironwrap",
    "core",
  );
  assert.equal(readiness.verdict, "blocked");
  assert.ok(
    readiness.capabilities
      .find((item) => item.id === "email_delivery")
      ?.blockers.includes("proof_missing"),
  );
});
