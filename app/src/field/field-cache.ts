import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { ApiError, apiRequest, isRetryableApiError } from "../lib/api";
import { getDatabase } from "../storage/db";
import { savedPlanBinding, type SavedPlanTarget, type SavedPlanModel } from "./saved-plan-context";
import {
  captureSavedPlanReadContext,
  isSavedPlanContextError,
  type SavedPlanReadContext,
} from "./saved-plan-read-context";
import {
  fieldMeasurementPageSchema,
  jobResponseSchema,
  NOT_SAVED_ON_DEVICE,
  proofPageResponseSchema,
  savedOfficeContactSchema,
  todayResponseSchema,
  workObjectResponseSchema,
  type FieldMeasurementPage,
  type JobResponse,
  type ProofPageResponse,
  type SavedOfficeContact,
  type TodayResponse,
  type WorkObjectResponse,
} from "./field-contracts";

export async function loadToday(
  session: AuthenticatedSession,
  fetcher: typeof fetch = fetch,
): Promise<TodayResponse> {
  let model: TodayResponse;
  try {
    model = await apiRequest({
      path: "/api/v1/today",
      schema: todayResponseSchema,
      fetcher,
      deviceProof: proofFor(session),
    });
  } catch (error) {
    return await offlineModel(cacheKey(session, "today"), todayResponseSchema, error);
  }
  return await keepForOffline(cacheKey(session, "today"), model);
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
  context?: SavedPlanReadContext,
): Promise<JobResponse> {
  const key = cacheKey(session, `job:${jobId}`);
  const bindingContext = context ?? (await optionalBindingContext(session));
  const deviceSecret = context
    ? context.deviceSecret
    : session.user.role === "field"
      ? await getDeviceSecret()
      : undefined;
  await context?.assertCurrent();
  let model: JobResponse;
  try {
    model = await apiRequest({
      path: `/api/v1/jobs/${encodeURIComponent(jobId)}`,
      schema: jobResponseSchema,
      fetcher,
      deviceProof: session.user.role === "field" ? async () => deviceSecret : undefined,
    });
  } catch (error) {
    await context?.assertCurrent();
    const cached = await offlineModel(key, jobResponseSchema, error);
    await context?.assertCurrent();
    return cached;
  }
  await context?.assertCurrent();
  await rememberOfficeContact(session, model);
  await context?.assertCurrent();
  return await keepForOffline(
    key,
    model,
    await bindingFor(
      session,
      { kind: "job", jobId },
      model,
      deviceSecret,
      bindingContext,
      context !== undefined,
    ),
    bindingContext,
    context !== undefined,
  );
}

export async function loadWorkObject(
  session: AuthenticatedSession,
  scope: WorkObjectResponse["work_object"],
  fetcher: typeof fetch = fetch,
  context?: SavedPlanReadContext,
): Promise<WorkObjectResponse> {
  const key = cacheKey(session, workObjectCacheSuffix(scope));
  const bindingContext = context ?? (await optionalBindingContext(session));
  const path = workObjectPath(scope);
  const deviceSecret = context
    ? context.deviceSecret
    : session.user.role === "field"
      ? await getDeviceSecret()
      : undefined;
  await context?.assertCurrent();
  let model: WorkObjectResponse;
  try {
    model = await apiRequest({
      path,
      schema: workObjectResponseSchema,
      fetcher,
      deviceProof: session.user.role === "field" ? async () => deviceSecret : undefined,
    });
  } catch (error) {
    await context?.assertCurrent();
    const cached = await offlineModel(key, workObjectResponseSchema, error);
    await context?.assertCurrent();
    return cached;
  }
  await context?.assertCurrent();
  await rememberOfficeContact(session, model);
  await context?.assertCurrent();
  return await keepForOffline(
    key,
    model,
    await bindingFor(
      session,
      { kind: "work-object", scope },
      model,
      deviceSecret,
      bindingContext,
      context !== undefined,
    ),
    bindingContext,
    context !== undefined,
  );
}

async function optionalBindingContext(session: AuthenticatedSession) {
  try {
    return await captureSavedPlanReadContext(session);
  } catch {
    return undefined;
  }
}

async function bindingFor(
  session: AuthenticatedSession,
  target: SavedPlanTarget,
  model: SavedPlanModel,
  deviceSecret: string | undefined,
  context?: SavedPlanReadContext,
  strict = true,
) {
  if (!context || context.deviceSecret !== deviceSecret) return undefined;
  try {
    return await savedPlanBinding(
      session,
      target,
      model,
      deviceSecret,
      context?.assertCurrent,
      context?.observation,
    );
  } catch (error) {
    if (strict && isSavedPlanContextError(error)) throw error;
    // A browser without the binding capability can still read live job details, but cannot
    // claim this packet is a bound saved work plan.
    return undefined;
  }
}

async function discardChangedBinding(key: string, binding: unknown): Promise<void> {
  try {
    const tx = (await getDatabase()).transaction("field_cache", "readwrite");
    const record = await tx.store.get(key);
    if (record && JSON.stringify(record.savedPlanBinding) === JSON.stringify(binding)) {
      delete record.savedPlanBinding;
      await tx.store.put(record);
    }
    await tx.done;
  } catch {
    // No changed-context result is returned; future context checks still refuse its receipt.
  }
}

/**
 * Keeps a validated live read for offline use. Storage failing (full, blocked, private mode)
 * never hides that read: it comes back marked, so the screen can say this copy will not open
 * without signal and the packet count does not claim it is saved.
 */
async function keepForOffline<
  T extends { source_updated_at: string | null; stale_fields: string[] },
>(
  key: string,
  model: T,
  binding?: unknown,
  context?: SavedPlanReadContext,
  strict = true,
): Promise<T> {
  try {
    await context?.assertCurrent();
    await cacheFieldModel(key, model, model.source_updated_at, binding);
    await context?.assertCurrent();
    return model;
  } catch (error) {
    if (isSavedPlanContextError(error)) {
      if (binding) await discardChangedBinding(key, binding);
      if (strict) throw error;
      return { ...model, stale_fields: [...new Set([...model.stale_fields, NOT_SAVED_ON_DEVICE])] };
    }
    await context?.assertCurrent();
    return { ...model, stale_fields: [...new Set([...model.stale_fields, NOT_SAVED_ON_DEVICE])] };
  }
}

/**
 * The office contact from the newest job or work-object read this phone got from the network, so
 * a screen whose own read carries none (Today, Vehicle, saved work, a refused job) can still offer
 * a call. An older Worker sends no contact and a failed profile read (`office_contact.unavailable`)
 * says nothing about it, so neither replaces what the phone already knows; a `null` contact does,
 * because it means the owner saved none.
 *
 * Reads can finish out of order, so the read generated last wins, checked and written in one
 * transaction. Keeping the contact is best effort: it never hides the fresh read it came with.
 */
async function rememberOfficeContact(
  session: AuthenticatedSession,
  model: Pick<JobResponse, "office_contact" | "read_model_generated_at" | "stale_fields">,
): Promise<void> {
  if (model.office_contact === undefined) return;
  if (model.stale_fields.includes("office_contact.unavailable")) return;
  const incoming: SavedOfficeContact = {
    contact: model.office_contact,
    synced_at: model.read_model_generated_at,
  };
  const key = cacheKey(session, "office-contact");
  try {
    const transaction = (await getDatabase()).transaction("field_cache", "readwrite");
    const current = savedOfficeContactSchema.safeParse((await transaction.store.get(key))?.value);
    if (!current.success || isNewerOfficeContact(incoming, current.data)) {
      await transaction.store.put({
        key,
        value: structuredClone(incoming),
        sourceUpdatedAt: incoming.synced_at,
        updatedAt: Date.now(),
      });
    }
    await transaction.done;
  } catch {
    // The phone keeps its last contact; the next read tries again.
  }
}

/** A later read wins; an exact tie is settled by the contact itself, never by arrival order. */
function isNewerOfficeContact(incoming: SavedOfficeContact, current: SavedOfficeContact): boolean {
  const generatedAt = (saved: SavedOfficeContact) => {
    const time = Date.parse(saved.synced_at);
    return Number.isNaN(time) ? -Infinity : time;
  };
  const [next, previous] = [generatedAt(incoming), generatedAt(current)];
  if (next !== previous) return next > previous;
  return JSON.stringify(incoming.contact) > JSON.stringify(current.contact);
}

/** The office contact this phone last read, or null when it has never read one. */
export async function loadOfficeContact(
  session: AuthenticatedSession,
): Promise<SavedOfficeContact | null> {
  const parsed = savedOfficeContactSchema.safeParse(
    await getCachedFieldModel(cacheKey(session, "office-contact")),
  );
  return parsed.success ? parsed.data : null;
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

/** One page of a job's crew readings, newest first; `null` asks for the first page. Online only. */
export async function loadFieldMeasurementPage(
  session: AuthenticatedSession,
  jobId: string,
  cursor: string | null,
  fetcher: typeof fetch = fetch,
): Promise<FieldMeasurementPage> {
  const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return await apiRequest({
    path: `/api/v1/jobs/${encodeURIComponent(jobId)}/field-measurements${query}`,
    schema: fieldMeasurementPageSchema,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function cacheFieldModel(
  key: string,
  value: unknown,
  sourceUpdatedAt: string | null,
  binding?: unknown,
): Promise<void> {
  await (
    await getDatabase()
  ).put("field_cache", {
    key,
    value: structuredClone(value),
    sourceUpdatedAt,
    updatedAt: Date.now(),
    ...(binding ? { savedPlanBinding: binding } : {}),
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
          const saved = !model.stale_fields.includes(NOT_SAVED_ON_DEVICE);
          result[job.id] = saved;
          options.onPacket?.(job.id, saved, model);
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
