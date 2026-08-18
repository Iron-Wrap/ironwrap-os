import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { ApiError, apiRequest, isRetryableApiError } from "../lib/api";
import { getDatabase } from "../storage/db";
import {
  jobResponseSchema,
  proofPageResponseSchema,
  todayResponseSchema,
  workObjectResponseSchema,
  type JobResponse,
  type ProofPageResponse,
  type TodayResponse,
  type WorkObjectResponse,
} from "./field-contracts";

export async function loadToday(
  session: AuthenticatedSession,
  fetcher: typeof fetch = fetch,
): Promise<TodayResponse> {
  try {
    const model = await apiRequest({
      path: "/api/v1/today",
      schema: todayResponseSchema,
      fetcher,
      deviceProof: proofFor(session),
    });
    await cacheToday(session, model);
    return model;
  } catch (error) {
    return await offlineModel(cacheKey(session, "today"), todayResponseSchema, error);
  }
}

export async function cacheToday(
  session: AuthenticatedSession,
  model: TodayResponse,
): Promise<void> {
  await cacheFieldModel(cacheKey(session, "today"), model, model.source_updated_at);
}

export async function loadJob(
  session: AuthenticatedSession,
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<JobResponse> {
  const key = cacheKey(session, `job:${jobId}`);
  try {
    const model = await apiRequest({
      path: `/api/v1/jobs/${encodeURIComponent(jobId)}`,
      schema: jobResponseSchema,
      fetcher,
      deviceProof: proofFor(session),
    });
    await cacheFieldModel(key, model, model.source_updated_at);
    return model;
  } catch (error) {
    return await offlineModel(key, jobResponseSchema, error);
  }
}

export async function loadWorkObject(
  session: AuthenticatedSession,
  scope: WorkObjectResponse["work_object"],
  fetcher: typeof fetch = fetch,
): Promise<WorkObjectResponse> {
  const key = cacheKey(session, workObjectCacheSuffix(scope));
  const path = workObjectPath(scope);
  try {
    const model = await apiRequest({
      path,
      schema: workObjectResponseSchema,
      fetcher,
      deviceProof: proofFor(session),
    });
    await cacheFieldModel(key, model, model.source_updated_at);
    return model;
  } catch (error) {
    return await offlineModel(key, workObjectResponseSchema, error);
  }
}

export async function loadProofPage(
  session: AuthenticatedSession,
  jobId: string,
  cursor: string,
  fetcher: typeof fetch = fetch,
): Promise<ProofPageResponse> {
  return await apiRequest({
    path: `/api/v1/jobs/${encodeURIComponent(jobId)}/proof?cursor=${encodeURIComponent(cursor)}`,
    schema: proofPageResponseSchema,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function cacheFieldModel(
  key: string,
  value: unknown,
  sourceUpdatedAt: string | null,
): Promise<void> {
  await (
    await getDatabase()
  ).put("field_cache", {
    key,
    value: structuredClone(value),
    sourceUpdatedAt,
    updatedAt: Date.now(),
  });
}

export async function getCachedFieldModel(key: string): Promise<unknown | undefined> {
  return (await (await getDatabase()).get("field_cache", key))?.value;
}

export async function hasCachedJobPacket(
  session: AuthenticatedSession,
  jobId: string,
): Promise<boolean> {
  return (await getCachedFieldModel(cacheKey(session, `job:${jobId}`))) !== undefined;
}

export async function prefetchAssignedPackets(
  session: AuthenticatedSession,
  today: TodayResponse,
  options: {
    fetcher?: typeof fetch;
    concurrency?: number;
    onPacket?: (jobId: string, ready: boolean, model?: JobResponse) => void;
  } = {},
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const queue = [...today.jobs];
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) return;
        try {
          const model = await loadJob(session, job.id, options.fetcher ?? fetch);
          result[job.id] = true;
          options.onPacket?.(job.id, true, model);
        } catch {
          const cached = await hasCachedJobPacket(session, job.id);
          result[job.id] = cached;
          options.onPacket?.(job.id, cached);
        }
      }
    }),
  );
  return result;
}

function cacheKey(session: AuthenticatedSession, suffix: string): string {
  return `${session.tenant.id}:${session.user.id}:${suffix}`;
}

export function workObjectPath(scope: WorkObjectResponse["work_object"]): string {
  return `/api/v1/work-objects/${encodeURIComponent(scope.workObjectType)}/${encodeURIComponent(scope.workObjectId)}/physical-contexts/${encodeURIComponent(scope.physicalContextType)}/${encodeURIComponent(scope.physicalContextId)}`;
}

function workObjectCacheSuffix(scope: WorkObjectResponse["work_object"]): string {
  return `work-object:${scope.workObjectType}:${scope.workObjectId}:${scope.physicalContextType}:${scope.physicalContextId}`;
}

function proofFor(session: AuthenticatedSession) {
  return session.user.role === "field" ? getDeviceSecret : undefined;
}

async function offlineModel<T>(
  key: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  error: unknown,
): Promise<T> {
  if (!isRetryableApiError(error)) throw error;
  const cached = await getCachedFieldModel(key);
  const parsed = schema.safeParse(cached);
  if (!parsed.success) {
    throw new ApiError({
      status: 0,
      code: "offline_packet_unavailable",
      message:
        "This field packet has not been opened on this device yet. Reconnect to load it once.",
      cause: error,
    });
  }
  const model = parsed.data as T & { stale_fields: string[] };
  return {
    ...model,
    stale_fields: [...new Set([...model.stale_fields, "offline.cached_packet"])],
  };
}
