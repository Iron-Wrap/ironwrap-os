import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => text(max).nullable();
const uuidV4Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const isoDatetimeSchema = z.string().datetime();
const callbackOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/" &&
        url.origin === value &&
        safePublicHostname(url.hostname)
      );
    } catch {
      return false;
    }
  }, "Invalid trusted Postiz callback origin.");

export const postizProviders = ["facebook", "linkedin-page", "gmb"] as const;
export const postizActions = [
  "postiz.connect",
  "postiz.intent.review",
  "postiz.intent.approve",
  "postiz.intent.reject",
  "postiz.intent.stop",
  "postiz.intent.reconcile",
] as const;

const postizCitationSchema = z
  .object({
    id: text(100),
    label: text(160),
    source_ref: text(300),
  })
  .strict();

const postizIntentSchema = z
  .object({
    id: uuidV4Schema,
    title: text(160),
    content: z.string().min(1).max(5_000),
    provider: z.enum(postizProviders),
    integration_id: nullableText(200),
    scheduled_at: isoDatetimeSchema,
    evidence_refs: z.array(text(300)).min(1).max(20),
    citations: z.array(postizCitationSchema).min(1).max(20),
    permission_scope: text(100),
    state: z.enum([
      "pending_review",
      "submission_pending",
      "submitted",
      "published",
      "reconciliation_required",
      "stop_submitted",
      "stop_reconciliation_required",
      "connection_required",
      "rejected",
    ]),
    version: z.number().int().positive(),
    error_code: nullableText(100),
    created_at: isoDatetimeSchema,
    updated_at: isoDatetimeSchema,
  })
  .strict();

export const postizIntentResponseSchema = z
  .object({
    version: z.literal(1),
    adapter: z
      .object({
        name: z.literal("postiz"),
        expected_version: z.literal("v2.23.0"),
      })
      .strict(),
    enabled: z.boolean(),
    connected: z.boolean(),
    allowed_actions: z.array(z.enum(postizActions)).max(postizActions.length),
    intent: postizIntentSchema,
    reconciliation: z
      .object({
        last_checked_at: nullableText(64),
        remote_state: z.enum(["QUEUE", "PUBLISHED", "ERROR", "DRAFT"]).nullable(),
        release_url: z.null(),
        detail_code: nullableText(100),
      })
      .strict(),
  })
  .strict();

export const postizConnectResponseSchema = z
  .object({
    version: z.literal(1),
    connect_url: z.string().min(1).max(4_096),
    callback_origin: callbackOriginSchema,
    provider: z.enum(postizProviders),
  })
  .strict()
  .superRefine((value, context) => {
    if (!validPostizOAuthUrl(value.provider, value.connect_url, value.callback_origin)) {
      context.addIssue({
        code: "custom",
        path: ["connect_url"],
        message: "Untrusted Postiz OAuth handoff URL.",
      });
    }
  });

function validPostizOAuthUrl(
  provider: PostizProvider,
  value: string,
  callbackOrigin: string,
): boolean {
  const contract: {
    host: string;
    path: string;
    callbackPath: string;
    stateLength: number;
    scope: string;
    keys: readonly string[];
    fixed: Readonly<Record<string, string>>;
  } =
    provider === "facebook"
      ? {
          host: "www.facebook.com",
          path: "/v20.0/dialog/oauth",
          callbackPath: "/integrations/social/facebook",
          stateLength: 6,
          scope:
            "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
          keys: ["client_id", "redirect_uri", "state", "scope"],
          fixed: {},
        }
      : provider === "linkedin-page"
        ? {
            host: "www.linkedin.com",
            path: "/oauth/v2/authorization",
            callbackPath: "/integrations/social/linkedin-page",
            stateLength: 6,
            scope:
              "openid profile w_member_social r_basicprofile rw_organization_admin w_organization_social r_organization_social",
            keys: ["response_type", "prompt", "client_id", "redirect_uri", "state", "scope"],
            fixed: { response_type: "code", prompt: "none" },
          }
        : {
            host: "accounts.google.com",
            path: "/o/oauth2/v2/auth",
            callbackPath: "/integrations/social/gmb",
            stateLength: 7,
            scope:
              "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage",
            keys: [
              "access_type",
              "prompt",
              "state",
              "redirect_uri",
              "scope",
              "response_type",
              "client_id",
            ],
            fixed: { access_type: "offline", prompt: "consent", response_type: "code" },
          };
  if (!value.startsWith(`https://${contract.host}${contract.path}?`)) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== contract.host ||
      url.port ||
      url.pathname !== contract.path ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== contract.keys.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !contract.keys.includes(key))
    )
      return false;
    for (const [key, expected] of Object.entries(contract.fixed)) {
      if (url.searchParams.get(key) !== expected) return false;
    }
    const clientId = url.searchParams.get("client_id") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (
      !/^[A-Za-z0-9._-]{1,256}$/.test(clientId) ||
      clientId === "undefined" ||
      clientId === "null" ||
      !new RegExp(`^[A-Za-z0-9]{${contract.stateLength}}$`).test(state) ||
      url.searchParams.get("scope") !== contract.scope
    )
      return false;
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      callback.protocol === "https:" &&
      !callback.username &&
      !callback.password &&
      !callback.search &&
      !callback.hash &&
      callback.origin === callbackOrigin &&
      callback.pathname === contract.callbackPath
    );
  } catch {
    return false;
  }
}

function safePublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  )
    return false;
  if (normalized.includes(":")) return false;
  const octets = normalized.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return normalized.includes(".");
  const [a, b] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export type PostizProvider = (typeof postizProviders)[number];
export type PostizAction = (typeof postizActions)[number];
export type PostizIntentResponse = z.infer<typeof postizIntentResponseSchema>;
export type PostizConnectResponse = z.infer<typeof postizConnectResponseSchema>;
