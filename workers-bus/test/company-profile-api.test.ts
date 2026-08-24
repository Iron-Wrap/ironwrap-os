import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv } from "../src/app-types.ts";
import { resolveCompanyProfile } from "../src/company-profile.ts";
import {
  handlePublicInstantEstimate,
  type PublicEstimatorEnv,
} from "../src/public-estimator.ts";
import worker from "../src/index.ts";
import {
  PNG_1X1_BASE64,
  TEST_ORIGIN,
  MemoryR2,
  apiRequest,
  authFor,
} from "./onboarding-fixture.ts";
import { SqliteD1, env as setupEnv } from "./company-setup-fixture.ts";

const PROFILE = {
  company_name: "FreshCo Exteriors Ltd.",
  brand_name: "FreshCo",
  service_area: "Greater Edmonton roofing",
  phone: "+1 780 555 0134",
  email: "hello@freshco.example",
  website: "https://freshco.example",
  address_line1: "88 Shingle Way",
  address_line2: "Unit 4",
  city: "Edmonton",
  region: "AB",
  postal_code: "T5J 0N3",
  country: "Canada",
  brand_labels: {},
  time_zone: "America/Edmonton",
  currency: "CAD",
  week_start: "monday",
};

function profileEnv(overrides: Partial<AppEnv> = {}) {
  const raw = new MemoryR2();
  const database = new SqliteD1();
  const env = setupEnv(database, {
    APP_TENANT_ID: "freshco",
    APP_TENANT_NAME: "FreshCo Exteriors",
    APP_TENANT_BRAND: "FreshCo",
    APP_PUBLIC_ORIGIN: TEST_ORIGIN,
    APP_ALLOWED_ORIGINS: TEST_ORIGIN,
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco",
    RAW: raw,
    ...overrides,
  });
  return { env, raw, database };
}

function profileBody(version = 0, overrides: Record<string, unknown> = {}) {
  return { ...PROFILE, expected_profile_version: version, ...overrides };
}

function mutationRequest(
  path: string,
  options: { method?: "PUT" | "DELETE"; body: unknown; csrf?: string | null },
  key = "company-profile-api-key-0001",
): Request {
  const request = apiRequest(path, options);
  request.headers.set("idempotency-key", key);
  return request;
}

test("a fresh tenant reads the generated defaults before an owner has saved anything", async () => {
  const { env } = profileEnv();
  const response = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile"),
    env,
    authFor("owner"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    profile: {
      company_name: string;
      brand_name: string;
      updated_at: string | null;
    };
    logo_url: string | null;
    public_brands: Array<{ id: string; display_name: string }>;
  };
  assert.equal(body.profile.company_name, "FreshCo Exteriors");
  assert.equal(body.profile.brand_name, "FreshCo");
  assert.equal(body.profile.updated_at, null);
  assert.equal(body.logo_url, null);
  assert.deepEqual(body.public_brands, [
    {
      id: "freshco",
      display_name: "FreshCo Exteriors",
      short_name: "FreshCo",
      service_area: "",
    },
  ]);
});

test("an owner saves company details and reads them back without touching a config file", async () => {
  const { env, raw } = profileEnv();
  const write = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile", {
      method: "PUT",
      body: profileBody(),
    }),
    env,
    authFor("owner"),
  );
  assert.equal(write.status, 200);

  const stored = await resolveCompanyProfile(env, "freshco");
  assert.equal(stored.company_name, "FreshCo Exteriors Ltd.");
  assert.equal(stored.city, "Edmonton");
  assert.equal(stored.updated_by_user_id, "appu_owner");
  assert.ok(stored.updated_at);
  assert.equal(
    raw.objects.has("tenant-config/freshco/company-profile.json"),
    false,
  );

  const read = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile"),
    env,
    authFor("owner"),
  );
  const body = (await read.json()) as { profile: { website: string } };
  assert.equal(body.profile.website, "https://freshco.example");
});

test("company profile writes refuse a missing name, a bad website, and an unknown field", async () => {
  const { env } = profileEnv();
  const cases: Array<[Record<string, unknown>, string]> = [
    [profileBody(0, { company_name: "  " }), "invalid_company_name"],
    [profileBody(0, { website: "javascript:alert(1)" }), "invalid_website"],
    [profileBody(0, { email: "not-an-email" }), "invalid_email"],
    [profileBody(0, { tenant_id: "someone-else" }), "unexpected_field"],
  ];
  for (const [body, expected] of cases) {
    const response = await handleAuthenticatedRoute(
      mutationRequest("/api/v1/admin/company-profile", { method: "PUT", body }),
      env,
      authFor("owner"),
    );
    assert.equal(response.status, 400, expected);
    assert.deepEqual(await response.json(), { error: expected });
  }
});

test("company profile is closed to non-office roles and to a request without the CSRF header", async () => {
  const { env } = profileEnv();
  for (const role of ["sales", "production", "accounting", "field"] as const) {
    const response = await handleAuthenticatedRoute(
      apiRequest("/api/v1/admin/company-profile"),
      env,
      authFor(role),
    );
    assert.equal(response.status, 403, role);
  }
  const noCsrf = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile", {
      method: "PUT",
      body: profileBody(),
      csrf: null,
    }),
    env,
    authFor("owner"),
  );
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await noCsrf.json(), { error: "csrf_failed" });
});

test("logo replacement and removal change D1 without destructively deleting R2 versions", async () => {
  const { env, raw, database } = profileEnv();
  const upload = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: {
        content_type: "image/png",
        data_base64: PNG_1X1_BASE64,
        expected_profile_version: 0,
      },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(upload.status, 200);
  const uploaded = (await upload.json()) as {
    outcome: string;
    profile: {
      profile_version: number;
      logo: { content_type: string; version: string; byte_size: number } | null;
    };
    logo_url: string | null;
  };
  assert.equal(uploaded.outcome, "updated");
  assert.equal(uploaded.profile.profile_version, 1);
  assert.equal(uploaded.profile.logo?.content_type, "image/png");
  assert.ok(uploaded.profile.logo!.byte_size > 0);
  assert.equal(
    uploaded.logo_url,
    `/public/company-logo?v=${uploaded.profile.logo!.version}`,
  );
  assert.ok(
    raw.objects.has(
      `tenant-config/freshco/logo/${uploaded.profile.logo!.version}`,
    ),
  );

  const replay = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: {
        content_type: "image/png",
        data_base64: PNG_1X1_BASE64,
        expected_profile_version: 0,
      },
    }),
    env,
    authFor("owner"),
  );
  const replayed = (await replay.json()) as {
    outcome: string;
    profile: { profile_version: number };
  };
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.profile.profile_version, 1);
  assert.equal(
    (
      database.raw
        .prepare("SELECT COUNT(*) AS n FROM tenant_company_profile_revisions")
        .get() as { n: number }
    ).n,
    1,
  );

  const staleSvg = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>',
  );
  const stale = await handleAuthenticatedRoute(
    mutationRequest(
      "/api/v1/admin/company-profile/logo",
      {
        method: "PUT",
        body: {
          content_type: "image/svg+xml",
          data_base64: staleSvg,
          expected_profile_version: 0,
        },
      },
      "company-profile-api-key-stale",
    ),
    env,
    authFor("owner"),
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "company_profile_version_conflict",
  });
  assert.equal(raw.objects.size, 1);

  const served = await worker.fetch(
    new Request("https://worker.example.com/public/company-logo"),
    env as never,
    { waitUntil() {} } as never,
  );
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const replacementSvg = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
  );
  const replaced = await handleAuthenticatedRoute(
    mutationRequest(
      "/api/v1/admin/company-profile/logo",
      {
        method: "PUT",
        body: {
          content_type: "image/svg+xml",
          data_base64: replacementSvg,
          expected_profile_version: 1,
        },
      },
      "company-profile-api-key-replacement",
    ),
    env,
    authFor("owner"),
  );
  assert.equal(replaced.status, 200);
  const replacedModel = (await replaced.json()) as {
    profile: { profile_version: number; logo: { version: string } | null };
  };
  assert.equal(replacedModel.profile.profile_version, 2);
  assert.ok(replacedModel.profile.logo);
  assert.ok(
    raw.objects.has(
      `tenant-config/freshco/logo/${uploaded.profile.logo!.version}`,
    ),
  );
  assert.ok(
    raw.objects.has(
      `tenant-config/freshco/logo/${replacedModel.profile.logo!.version}`,
    ),
  );
  assert.deepEqual(raw.deletedKeys, []);

  const removed = await handleAuthenticatedRoute(
    mutationRequest(
      "/api/v1/admin/company-profile/logo",
      { method: "DELETE", body: { expected_profile_version: 2 } },
      "company-profile-api-key-0002",
    ),
    env,
    authFor("owner"),
  );
  assert.equal(removed.status, 200);
  const removedModel = (await removed.json()) as {
    profile: { profile_version: number };
    logo_url: string | null;
  };
  assert.equal(removedModel.profile.profile_version, 3);
  assert.deepEqual(removedModel.logo_url, null);
  assert.ok(
    raw.objects.has(
      `tenant-config/freshco/logo/${uploaded.profile.logo!.version}`,
    ),
  );
  assert.ok(
    raw.objects.has(
      `tenant-config/freshco/logo/${replacedModel.profile.logo!.version}`,
    ),
  );
  assert.deepEqual(raw.deletedKeys, []);

  const gone = await worker.fetch(
    new Request("https://worker.example.com/public/company-logo"),
    env as never,
    { waitUntil() {} } as never,
  );
  assert.equal(gone.status, 404);
});

test("SVG validation scans the complete bounded payload", async () => {
  const { env } = profileEnv();
  const lateScript = btoa(
    `<svg xmlns="http://www.w3.org/2000/svg"><!--${"safe".repeat(1_200)}--><script>alert(1)</script></svg>`,
  );
  const response = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: {
        content_type: "image/svg+xml",
        data_base64: lateScript,
        expected_profile_version: 0,
      },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "logo_content_mismatch" });
});

test("a logo upload refuses an oversized file, an unsupported type, and bytes that contradict the type", async () => {
  const { env } = profileEnv();
  const oversize = "A".repeat(Math.ceil((512 * 1024 + 64) / 3) * 4);
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [
      { content_type: "image/gif", data_base64: PNG_1X1_BASE64 },
      "unsupported_logo_type",
      400,
    ],
    [
      { content_type: "image/png", data_base64: oversize },
      "logo_too_large",
      400,
    ],
    [
      { content_type: "image/png", data_base64: btoa("not a png at all") },
      "logo_content_mismatch",
      400,
    ],
    [
      {
        content_type: "image/svg+xml",
        data_base64: btoa(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      },
      "logo_content_mismatch",
      400,
    ],
  ];
  for (const [body, expected, status] of cases) {
    const response = await handleAuthenticatedRoute(
      mutationRequest("/api/v1/admin/company-profile/logo", {
        method: "PUT",
        body: { ...body, expected_profile_version: 0 },
      }),
      env,
      authFor("owner"),
    );
    assert.equal(response.status, status, expected);
    assert.deepEqual(await response.json(), { error: expected });
  }
});

test("a plain SVG logo is accepted and served with a locked-down content policy", async () => {
  const { env } = profileEnv();
  const svg = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
  );
  const upload = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: {
        content_type: "image/svg+xml",
        data_base64: svg,
        expected_profile_version: 0,
      },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(upload.status, 200);
  const served = await worker.fetch(
    new Request("https://worker.example.com/public/company-logo"),
    env as never,
    { waitUntil() {} } as never,
  );
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  // The Worker-wide policy is what stops a stored SVG being a script if someone opens it directly.
  assert.equal(
    served.headers.get("content-security-policy"),
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
});

test("the public estimate config names this tenant's own brand instead of a hard-coded one", async () => {
  const { env } = profileEnv({
    PUBLIC_ESTIMATE_ENABLED: "true",
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: TEST_ORIGIN,
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco",
    PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "Alberta, Canada",
    PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY: "site-key",
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: "turnstile-secret",
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER:
      "rate-pepper-with-at-least-thirty-two-characters",
    PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "5",
    PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX: "5",
    PUBLIC_ESTIMATE_RANGE_RULES_JSON: "[]",
  } as never);
  await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile", {
      method: "PUT",
      body: profileBody(),
    }),
    env,
    authFor("owner"),
  );

  const response = await handlePublicInstantEstimate(
    new Request("https://worker.example.com/public/instant-estimate/config", {
      headers: { origin: TEST_ORIGIN },
    }),
    env as unknown as PublicEstimatorEnv,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    enabled: boolean;
    brands: Array<{
      id: string;
      display_name: string;
      short_name: string;
      service_area: string;
    }>;
    default_brand: string | null;
  };
  assert.equal(body.enabled, true);
  assert.equal(body.default_brand, "freshco");
  assert.deepEqual(body.brands, [
    {
      id: "freshco",
      display_name: "FreshCo Exteriors Ltd.",
      short_name: "FreshCo",
      service_area: "Greater Edmonton roofing",
    },
  ]);
});

test("an owner can name every brand the Worker accepts, and only those", async () => {
  const { env } = profileEnv({
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco,freshco-commercial",
  } as never);
  const write = await handleAuthenticatedRoute(
    mutationRequest("/api/v1/admin/company-profile", {
      method: "PUT",
      body: profileBody(0, {
        brand_labels: {
          "freshco-commercial": {
            display_name: "FreshCo Commercial",
            short_name: "FreshCo CX",
            service_area: "Alberta commercial roofing",
          },
        },
      }),
    }),
    env,
    authFor("owner"),
  );
  assert.equal(write.status, 200);
  const body = (await write.json()) as {
    public_brands: Array<{ id: string; display_name: string }>;
  };
  assert.deepEqual(
    body.public_brands.map((brand) => brand.id),
    ["freshco", "freshco-commercial"],
  );
  assert.equal(body.public_brands[1]!.display_name, "FreshCo Commercial");
});
