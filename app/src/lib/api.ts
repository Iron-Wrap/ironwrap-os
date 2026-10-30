import { z, type ZodType } from "zod";

import { clearDeviceSecret, type DeviceProofProvider } from "../auth/device-credential";

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
  /**
   * The rest of the error body, verbatim. Our routes answer a refused command with the
   * exact blocker AND the facts that make it actionable — `required_role` on a stage
   * refusal, `card_version` on a CAS conflict, `undo_window_seconds` on an expired undo
   * (`workers-bus/src/pipeline-board-api.ts`). Keeping them here is what lets a surface
   * render the server's reason instead of flattening every refusal into one toast.
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code ?? "api_error";
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
    this.details = Object.freeze({ ...(input.details ?? {}) });
  }

  /** One detail field, when the server sent it as a string. */
  detailText(key: string): string | undefined {
    const value = this.details[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  /** One detail field, when the server sent it as a finite number. */
  detailNumber(key: string): number | undefined {
    const value = this.details[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
}

export interface ApiRequestOptions<T> {
  path: string;
  schema: ZodType<T>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** What this call asks for; JSON unless it is fetching a file. */
  accept?: string;
  csrfToken?: string;
  idempotencyKey?: string;
  deviceActionId?: string;
  deviceProof?: DeviceProofProvider;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  credentials?: RequestCredentials;
}

export interface ApiCommandOptions {
  path: string;
  body?: unknown;
  csrfToken?: string;
  idempotencyKey?: string;
  deviceActionId?: string;
  deviceProof?: DeviceProofProvider;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  credentials?: RequestCredentials;
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

/**
 * The server accepted the request (2xx) but its answer was lost or cut off on the way back. The
 * request may already have taken effect, so this is never a refusal; a read may simply be retried.
 */
export function isAnswerLost(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 200 &&
    error.status < 300 &&
    (error.code === "response_lost" || error.code === "invalid_json")
  );
}

export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500 ||
    isAnswerLost(error)
  );
}

export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<T> {
  // The timeout and the caller's abort stay armed until the whole body has been read: an answer
  // whose headers arrive but whose body stalls must end, not leave the screen waiting for ever.
  const { response, release, failure } = await executeRequest(options, true);
  const requestId = response.headers.get("X-Request-ID") ?? undefined;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const lost = failure(error);
    // The server answered, so it may already have acted; the body never arrived.
    throw new ApiError({
      status: response.status,
      code: lost.code === "aborted" ? "aborted" : "response_lost",
      message: "The answer was lost before it arrived.",
      requestId,
      cause: error,
    });
  } finally {
    release();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new ApiError({
      status: response.status,
      code: "invalid_json",
      message: "The server returned an unreadable response.",
      requestId,
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

export type ApiBlobOptions = Pick<
  ApiRequestOptions<unknown>,
  "path" | "deviceProof" | "signal" | "timeoutMs" | "fetcher" | "credentials"
>;

/**
 * A file read through the same authenticated path as every other call, so a paired field device
 * sends its proof header (a plain link would not) and a refusal arrives as the same `ApiError`.
 */
export async function apiBlob(options: ApiBlobOptions): Promise<Blob> {
  // The timeout and the caller's abort stay armed until the last byte has arrived: a download that
  // stalls halfway must end with an answer, not hang for ever.
  const { response, release, failure } = await executeRequest({ ...options, accept: "*/*" }, true);
  try {
    return await response.blob();
  } catch (error) {
    throw failure(error);
  } finally {
    release();
  }
}

interface Exchange {
  response: Response;
  /** Disarms the timeout and the abort forwarding. Called by whoever reads the body last. */
  release: () => void;
  /** What a failure while reading the body means: cancelled, too slow, or no connection. */
  failure: (error: unknown) => ApiError;
}

async function executeRequest(
  options: Omit<ApiRequestOptions<unknown>, "schema"> & {
    method?: ApiRequestOptions<unknown>["method"];
  },
  readBodyLater = false,
): Promise<Exchange> {
  assertApiPath(options.path);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const release = () => {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  };
  const failure = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;
    if (controller.signal.aborted) {
      return new ApiError({
        status: 0,
        code: options.signal?.aborted ? "aborted" : "timeout",
        message: options.signal?.aborted
          ? "The request was cancelled."
          : "The connection took too long. Try again when signal improves.",
        cause: error,
      });
    }
    return new ApiError({
      status: 0,
      code: "network_error",
      message: "No connection to IronWrap OS. Your saved work stays on this device.",
      cause: error,
    });
  };

  try {
    const headers = new Headers({ Accept: options.accept ?? "application/json" });
    // A multipart body must keep the boundary the browser writes into its own Content-Type.
    const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    if (options.body !== undefined && !multipart) headers.set("Content-Type", "application/json");
    if (options.csrfToken) headers.set("X-CSRF-Token", options.csrfToken);
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.deviceActionId) headers.set("X-Device-Action-Id", options.deviceActionId);
    const deviceProof = await options.deviceProof?.();
    if (deviceProof) headers.set("X-IronWrap-Device-Proof", deviceProof);

    const response = await fetcher(options.path, {
      method: options.method ?? "GET",
      credentials: options.credentials ?? "same-origin",
      cache: "no-store",
      headers,
      body:
        options.body === undefined
          ? undefined
          : multipart
            ? (options.body as FormData)
            : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await responseError(response);
      if (options.deviceProof && error.status === 401) await clearDeviceSecret();
      throw error;
    }
    if (!readBodyLater) release();
    return { response, release, failure };
  } catch (error) {
    release();
    throw failure(error);
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
  const {
    error: _error,
    code: _code,
    message: _message,
    request_id: _requestId,
    ...details
  } = body;
  return new ApiError({
    status: response.status,
    code: body.code ?? body.error ?? `http_${response.status}`,
    message: body.message ?? response.statusText ?? "The request could not be completed.",
    requestId: body.request_id ?? response.headers.get("X-Request-ID") ?? undefined,
    retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After")),
    details,
  });
}

function assertApiPath(path: string): void {
  if (!path.startsWith("/api/v1/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("API requests must use a same-origin /api/v1/ path.");
  }
}
