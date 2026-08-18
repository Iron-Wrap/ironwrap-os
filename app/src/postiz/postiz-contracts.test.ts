import { describe, expect, it } from "vitest";

import { postizConnectResponseSchema, postizIntentResponseSchema } from "./postiz-contracts";
import { postizIntentFixture } from "./postiz-test-fixture";

const oauthScopes = {
  facebook:
    "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
  "linkedin-page":
    "openid profile w_member_social r_basicprofile rw_organization_admin w_organization_social r_organization_social",
  gmb: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage",
} as const;

function oauthUrl(
  provider: keyof typeof oauthScopes,
  callbackOrigin = "https://postiz.example.invalid",
): string {
  const contract =
    provider === "facebook"
      ? { base: "https://www.facebook.com/v20.0/dialog/oauth", state: "Ab12Cd" }
      : provider === "linkedin-page"
        ? { base: "https://www.linkedin.com/oauth/v2/authorization", state: "Ef34Gh" }
        : { base: "https://accounts.google.com/o/oauth2/v2/auth", state: "Ij56Klm" };
  const query = new URLSearchParams();
  if (provider === "linkedin-page") {
    query.set("response_type", "code");
    query.set("prompt", "none");
  }
  if (provider === "gmb") {
    query.set("access_type", "offline");
    query.set("prompt", "consent");
  }
  query.set("client_id", provider === "gmb" ? "123.apps.googleusercontent.com" : "client_123");
  query.set("redirect_uri", `${callbackOrigin}/integrations/social/${provider}`);
  query.set("state", contract.state);
  query.set("scope", oauthScopes[provider]);
  if (provider === "gmb") query.set("response_type", "code");
  return `${contract.base}?${query.toString()}`;
}

describe("Postiz browser contracts", () => {
  it("accepts the bounded intent detail envelope", () => {
    const payload = postizIntentFixture();
    expect(postizIntentResponseSchema.parse(payload)).toEqual(payload);
  });

  it.each(["access_token", "api_key", "raw_provider_error", "html"])(
    "rejects secret or provider-rendered field %s",
    (field) => {
      const payload = postizIntentFixture() as unknown as MutablePostizIntentResponse;
      payload.intent[field] = "must-never-reach-the-browser";

      expect(postizIntentResponseSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("rejects undeclared actions and adapter drift", () => {
    const actionPayload = postizIntentFixture() as unknown as MutablePostizIntentResponse;
    actionPayload.allowed_actions = ["postiz.intent.publish"];
    const versionPayload = postizIntentFixture() as unknown as MutablePostizIntentResponse;
    versionPayload.adapter.expected_version = "latest";

    expect(postizIntentResponseSchema.safeParse(actionPayload).success).toBe(false);
    expect(postizIntentResponseSchema.safeParse(versionPayload).success).toBe(false);
  });

  it("allows only exact pinned provider OAuth handoff shapes", () => {
    for (const provider of ["facebook", "linkedin-page", "gmb"] as const) {
      expect(
        postizConnectResponseSchema.safeParse({
          version: 1,
          connect_url: oauthUrl(provider),
          callback_origin: "https://postiz.example.invalid",
          provider,
        }).success,
      ).toBe(true);
    }
    const callbackOrigin = "https://postiz.example.invalid:8443";
    expect(
      postizConnectResponseSchema.safeParse({
        version: 1,
        connect_url: oauthUrl("facebook", callbackOrigin),
        callback_origin: callbackOrigin,
        provider: "facebook",
      }).success,
    ).toBe(true);
  });

  it("rejects on-host redirectors, provider/path/query drift, credentials, and fragments", () => {
    const valid = oauthUrl("facebook");
    for (const connect_url of [
      "https://www.facebook.com/l.php?u=https%3A%2F%2Fattacker.example.invalid",
      valid.replace("/v20.0/dialog/oauth", "/dialog/oauth"),
      `${valid}&next=https%3A%2F%2Fattacker.example.invalid`,
      valid.replace("www.facebook.com", "www.linkedin.com"),
      valid.replace("https://", "https://user:pass@"),
      `${valid}#continue`,
      `${valid}&state=Ef34Gh`,
      oauthUrl("facebook", "https://evil.example"),
      oauthUrl("facebook", "https://auth.postiz.example.invalid"),
      oauthUrl("facebook", "https://postiz.example.invalid.evil.example"),
      oauthUrl("facebook", "https://postiz.example.invalid:8443"),
    ]) {
      expect(
        postizConnectResponseSchema.safeParse({
          version: 1,
          connect_url,
          callback_origin: "https://postiz.example.invalid",
          provider: "facebook",
        }).success,
      ).toBe(false);
    }
  });

  it("suppresses every provider release URL", () => {
    const payload = postizIntentFixture() as unknown as MutablePostizIntentResponse;
    payload.reconciliation.release_url = "https://www.facebook.com/posts/123";
    expect(postizIntentResponseSchema.safeParse(payload).success).toBe(false);
  });
});

type Fixture = ReturnType<typeof postizIntentFixture>;
type MutablePostizIntentResponse = Omit<
  Fixture,
  "allowed_actions" | "adapter" | "intent" | "reconciliation"
> & {
  allowed_actions: string[];
  adapter: { name: "postiz"; expected_version: string };
  intent: Fixture["intent"] & Record<string, unknown>;
  reconciliation: Omit<Fixture["reconciliation"], "release_url"> & {
    release_url: string | null;
  };
};
