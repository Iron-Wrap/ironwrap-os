import { z, type ZodType } from "zod";

import { API_PATHS } from "../lib/api-paths";
import {
  publicEstimateConfigSchema,
  publicInstantEstimateRequestSchema,
  publicInstantEstimateResponseSchema,
  type PublicEstimateConfig,
  type PublicEstimateBrand,
  type PublicInstantEstimateRequest,
  type PublicInstantEstimateResponse,
} from "./public-estimate-contracts";

const publicErrorSchema = z.object({ error: z.string().min(1) });
const REQUEST_TIMEOUT_MS = 12_000;

export class PublicEstimateApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(publicErrorMessage(code));
    this.name = "PublicEstimateApiError";
    this.code = code;
  }
}

export async function loadPublicEstimateConfig(
  brand: PublicEstimateBrand,
  fetcher: typeof fetch = fetch,
): Promise<PublicEstimateConfig> {
  return publicRequest(
    `${API_PATHS.publicInstantEstimateConfig}?brand=${encodeURIComponent(brand)}`,
    publicEstimateConfigSchema,
    {
      fetcher,
    },
  );
}

export async function submitPublicInstantEstimate(
  input: PublicInstantEstimateRequest,
  fetcher: typeof fetch = fetch,
): Promise<PublicInstantEstimateResponse> {
  const body = publicInstantEstimateRequestSchema.parse(input);
  return publicRequest(API_PATHS.publicInstantEstimate, publicInstantEstimateResponseSchema, {
    fetcher,
    body,
    idempotencyKey: body.client_submission_id,
  });
}

async function publicRequest<T>(
  path: string,
  schema: ZodType<T>,
  input: { fetcher: typeof fetch; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  if (!path.startsWith("/public/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("Public estimate requests must use a same-origin public path.");
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { fetcher } = input;
    const headers = new Headers({ Accept: "application/json" });
    if (input.body !== undefined) headers.set("Content-Type", "application/json");
    if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);

    const response = await fetcher(path, {
      method: input.body === undefined ? "GET" : "POST",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "strict-origin",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });

    const payload = await readJson(response);
    if (!response.ok) {
      const error = publicErrorSchema.safeParse(payload);
      throw new PublicEstimateApiError(error.success ? error.data.error : "request_failed");
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new PublicEstimateApiError("invalid_response");
    return parsed.data;
  } catch (error) {
    if (error instanceof PublicEstimateApiError) throw error;
    if (controller.signal.aborted) throw new PublicEstimateApiError("timeout");
    throw new PublicEstimateApiError("network_error");
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function publicErrorMessage(code: string): string {
  switch (code) {
    case "turnstile_failed":
      return "The security check did not complete. Please try it again.";
    case "rate_limited":
      return "Too many requests were sent. Please wait a moment and try again.";
    case "not_available":
    case "public_estimate_not_configured":
    case "submission_unavailable":
      return "Online estimate requests are unavailable right now. Please try again later.";
    case "timeout":
      return "The request took too long. Please check your connection and try again.";
    case "network_error":
      return "We could not reach the estimator. Please check your connection and try again.";
    default:
      return "We could not submit your request. Please try again.";
  }
}
