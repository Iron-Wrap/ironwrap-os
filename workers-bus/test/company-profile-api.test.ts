import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { resolveCompanyProfile } from "../src/company-profile.ts";
import { handlePublicInstantEstimate, type PublicEstimatorEnv } from "../src/public-estimator.ts";
import worker from "../src/index.ts";
import {
  PNG_1X1_BASE64,
  TEST_ORIGIN,
  apiRequest,
  authFor,
  onboardingEnv,
} from "./onboarding-fixture.ts";

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
};

test("a fresh tenant reads the generated defaults before an owner has saved anything", async () => {
  const { env } = onboardingEnv();
  const response = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile"),
    env,
    authFor("owner"),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    profile: { company_name: string; brand_name: string; updated_at: string | null };
    logo_url: string | null;
    public_brands: Array<{ id: string; display_name: string }>;
  };
  assert.equal(body.profile.company_name, "FreshCo Exteriors");
  assert.equal(body.profile.brand_name, "FreshCo");
  assert.equal(body.profile.updated_at, null);
  assert.equal(body.logo_url, null);
  assert.deepEqual(body.public_brands, [
    { id: "freshco", display_name: "FreshCo Exteriors", short_name: "FreshCo", service_area: "" },
  ]);
});

test("an owner saves company details and reads them back without touching a config file", async () => {
  const { env, raw } = onboardingEnv();
  const write = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile", { method: "PUT", body: PROFILE }),
    env,
    authFor("owner"),
  );
  assert.equal(write.status, 200);

  const stored = await resolveCompanyProfile(env, "freshco");
  assert.equal(stored.company_name, "FreshCo Exteriors Ltd.");
  assert.equal(stored.city, "Edmonton");
  assert.equal(stored.updated_by, "owner@freshco.example");
  assert.ok(stored.updated_at);
  assert.ok(raw.objects.has("tenant-config/freshco/company-profile.json"));

  const read = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile"),
    env,
    authFor("owner"),
  );
  const body = await read.json() as { profile: { website: string } };
  assert.equal(body.profile.website, "https://freshco.example");
});

test("company profile writes refuse a missing name, a bad website, and an unknown field", async () => {
  const { env } = onboardingEnv();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...PROFILE, company_name: "  " }, "invalid_company_name"],
    [{ ...PROFILE, website: "javascript:alert(1)" }, "invalid_website"],
    [{ ...PROFILE, email: "not-an-email" }, "invalid_email"],
    [{ ...PROFILE, tenant_id: "someone-else" }, "unexpected_field"],
  ];
  for (const [body, expected] of cases) {
    const response = await handleAuthenticatedRoute(
      apiRequest("/api/v1/admin/company-profile", { method: "PUT", body }),
      env,
      authFor("owner"),
    );
    assert.equal(response.status, 400, expected);
    assert.deepEqual(await response.json(), { error: expected });
  }
});

test("company profile is closed to non-office roles and to a request without the CSRF header", async () => {
  const { env } = onboardingEnv();
  for (const role of ["sales", "production", "accounting", "field"] as const) {
    const response = await handleAuthenticatedRoute(
      apiRequest("/api/v1/admin/company-profile"),
      env,
      authFor(role),
    );
    assert.equal(response.status, 403, role);
  }
  const noCsrf = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile", { method: "PUT", body: PROFILE, csrf: null }),
    env,
    authFor("owner"),
  );
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await noCsrf.json(), { error: "csrf_failed" });
});

test("a logo upload is stored, published on a versioned public URL, and removable", async () => {
  const { env, raw } = onboardingEnv();
  const upload = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: { content_type: "image/png", data_base64: PNG_1X1_BASE64 },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(upload.status, 200);
  const uploaded = await upload.json() as {
    profile: { logo: { content_type: string; version: string; byte_size: number } | null };
    logo_url: string | null;
  };
  assert.equal(uploaded.profile.logo?.content_type, "image/png");
  assert.ok(uploaded.profile.logo!.byte_size > 0);
  assert.equal(uploaded.logo_url, `/public/company-logo?v=${uploaded.profile.logo!.version}`);
  assert.ok(raw.objects.has(`tenant-config/freshco/logo/${uploaded.profile.logo!.version}`));

  const served = await worker.fetch(
    new Request("https://worker.example.com/public/company-logo"),
    env as never,
    { waitUntil() {} } as never,
  );
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const removed = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile/logo", { method: "DELETE" }),
    env,
    authFor("owner"),
  );
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json() as { logo_url: string | null }).logo_url, null);
  assert.equal(raw.objects.has(`tenant-config/freshco/logo/${uploaded.profile.logo!.version}`), false);

  const gone = await worker.fetch(
    new Request("https://worker.example.com/public/company-logo"),
    env as never,
    { waitUntil() {} } as never,
  );
  assert.equal(gone.status, 404);
});

test("a logo upload refuses an oversized file, an unsupported type, and bytes that contradict the type", async () => {
  const { env } = onboardingEnv();
  const oversize = "A".repeat(Math.ceil((512 * 1024 + 64) / 3) * 4);
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [{ content_type: "image/gif", data_base64: PNG_1X1_BASE64 }, "unsupported_logo_type", 400],
    [{ content_type: "image/png", data_base64: oversize }, "logo_too_large", 400],
    [{ content_type: "image/png", data_base64: btoa("not a png at all") }, "logo_content_mismatch", 400],
    [
      {
        content_type: "image/svg+xml",
        data_base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      },
      "logo_content_mismatch",
      400,
    ],
  ];
  for (const [body, expected, status] of cases) {
    const response = await handleAuthenticatedRoute(
      apiRequest("/api/v1/admin/company-profile/logo", { method: "PUT", body }),
      env,
      authFor("owner"),
    );
    assert.equal(response.status, status, expected);
    assert.deepEqual(await response.json(), { error: expected });
  }
});

test("a plain SVG logo is accepted and served with a locked-down content policy", async () => {
  const { env } = onboardingEnv();
  const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
  const upload = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile/logo", {
      method: "PUT",
      body: { content_type: "image/svg+xml", data_base64: svg },
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
  const { env } = onboardingEnv({
    PUBLIC_ESTIMATE_ENABLED: "true",
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: TEST_ORIGIN,
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco",
    PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "Alberta, Canada",
    PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY: "site-key",
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: "turnstile-secret",
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: "rate-pepper-with-at-least-thirty-two-characters",
    PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "5",
    PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX: "5",
    PUBLIC_ESTIMATE_RANGE_RULES_JSON: "[]",
  } as never);
  await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile", { method: "PUT", body: PROFILE }),
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
  const body = await response.json() as {
    enabled: boolean;
    brands: Array<{ id: string; display_name: string; short_name: string; service_area: string }>;
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
  const { env } = onboardingEnv({ PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco,freshco-commercial" } as never);
  const write = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/company-profile", {
      method: "PUT",
      body: {
        ...PROFILE,
        brand_labels: {
          "freshco-commercial": {
            display_name: "FreshCo Commercial",
            short_name: "FreshCo CX",
            service_area: "Alberta commercial roofing",
          },
        },
      },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(write.status, 200);
  const body = await write.json() as { public_brands: Array<{ id: string; display_name: string }> };
  assert.deepEqual(body.public_brands.map((brand) => brand.id), ["freshco", "freshco-commercial"]);
  assert.equal(body.public_brands[1]!.display_name, "FreshCo Commercial");
});
