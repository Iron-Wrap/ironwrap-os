import { z, type ZodType } from "zod";

export const apiErrorBodySchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    request_id: z.string().optional(),
  })
  .passthrough();

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code ?? "api_error";
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export interface ApiRequestOptions<T> {
  path: string;
  schema: ZodType<T>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface ApiCommandOptions {
  path: string;
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<T> {
  const response = await executeRequest(options);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ApiError({
      status: response.status,
      code: "invalid_json",
      message: "The server returned an unreadable response.",
      requestId: response.headers.get("X-Request-ID") ?? undefined,
      cause: error,
    });
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      status: response.status,
      code: "invalid_response",
      message: "The server response did not match the app contract.",
      requestId: response.headers.get("X-Request-ID") ?? undefined,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function apiCommand(options: ApiCommandOptions): Promise<void> {
  await executeRequest({ ...options, method: "POST" });
}

async function executeRequest(
  options: Omit<ApiRequestOptions<unknown>, "schema"> & {
    method?: ApiRequestOptions<unknown>["method"];
  },
): Promise<Response> {
  assertApiPath(options.path);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.csrfToken) headers.set("X-CSRF-Token", options.csrfToken);

    const response = await fetcher(options.path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) throw await responseError(response);
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError({
        status: 0,
        code: options.signal?.aborted ? "aborted" : "timeout",
        message: options.signal?.aborted
          ? "The request was cancelled."
          : "The connection took too long. Try again when signal improves.",
        cause: error,
      });
    }
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: "No connection to IronWrap OS. Your saved work stays on this device.",
      cause: error,
    });
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function responseError(response: Response): Promise<ApiError> {
  let body: z.infer<typeof apiErrorBodySchema> = {};
  try {
    const parsed = apiErrorBodySchema.safeParse(await response.json());
    if (parsed.success) body = parsed.data;
  } catch {
    // The status and headers still carry enough truth for an actionable error.
  }
  return new ApiError({
    status: response.status,
    code: body.code ?? body.error ?? `http_${response.status}`,
    message: body.message ?? response.statusText ?? "The request could not be completed.",
    requestId: body.request_id ?? response.headers.get("X-Request-ID") ?? undefined,
    retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After")),
  });
}

function assertApiPath(path: string): void {
  if (!path.startsWith("/api/v1/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("API requests must use a same-origin /api/v1/ path.");
  }
}
