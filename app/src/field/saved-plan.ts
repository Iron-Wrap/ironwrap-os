import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { ApiError } from "../lib/api";
import { getDatabase } from "../storage/db";
import type { PrincipalReadObservation } from "../auth/principal-context";
import { getCachedFieldModel, loadJob, loadWorkObject } from "./field-cache";
import {
  captureSavedPlanReadContext,
  isSavedPlanContextError,
  type SavedPlanReadContext,
} from "./saved-plan-read-context";
import { jobResponseSchema, workObjectResponseSchema, type TodayResponse } from "./field-contracts";
import {
  assignedPlanTargets,
  savedPlanBinding,
  savedPlanCacheKey,
  savedPlanTargetKey,
  workPlanForTarget,
  type SavedPlanModel,
  type SavedPlanTarget,
} from "./saved-plan-context";

export async function hasSavedPlan(
  session: AuthenticatedSession,
  target: SavedPlanTarget,
  model?: SavedPlanModel,
  context?: SavedPlanReadContext,
): Promise<boolean> {
  try {
    const readContext = context ?? (await captureSavedPlanReadContext(session));
    await readContext.assertCurrent();
    const record = await (
      await getDatabase()
    ).get("field_cache", savedPlanCacheKey(session, target));
    await readContext.assertCurrent();
    if (!record?.savedPlanBinding) return false;
    const parsed =
      target.kind === "job"
        ? jobResponseSchema.safeParse(record.value)
        : workObjectResponseSchema.safeParse(record.value);
    if (!parsed.success) return false;
    const expected = await savedPlanBinding(
      session,
      target,
      model ?? parsed.data,
      readContext.deviceSecret,
      readContext.assertCurrent,
      readContext.observation,
    );
    await readContext.assertCurrent();
    return (
      expected !== undefined && JSON.stringify(record.savedPlanBinding) === JSON.stringify(expected)
    );
  } catch {
    return false;
  }
}

export async function loadSavedPlan(
  session: AuthenticatedSession,
  target: SavedPlanTarget,
  fetcher: typeof fetch = fetch,
  isCurrent?: () => boolean,
  observation?: PrincipalReadObservation,
) {
  const context = await captureSavedPlanReadContext(session, isCurrent, observation);
  // An offline session cannot attest a new live paired principal. Until auth refresh, it may
  // read only a previously acquired snapshot bound to its own session/principal/device.
  const model = isOfflineSession(session)
    ? await cachedPlanModel(session, target)
    : target.kind === "job"
      ? await loadJob(session, target.jobId, fetcher, context)
      : await loadWorkObject(session, target.scope, fetcher, context);
  await context.assertCurrent();
  const plan = workPlanForTarget(target, model);
  const offline = model.stale_fields.includes("offline.cached_packet");
  const saved = await hasSavedPlan(session, target, model, context);
  await context.assertCurrent();
  if (!plan || (offline && !saved)) {
    throw new ApiError({
      status: 409,
      code: "saved_plan_unavailable",
      message:
        "A complete plan for this work could not be verified on this phone. Keep work stopped. Go online and ask the office for the current work and safety plan.",
    });
  }
  return { model, plan, offline, saved };
}

async function cachedPlanModel(
  session: AuthenticatedSession,
  target: SavedPlanTarget,
): Promise<SavedPlanModel> {
  const value = await getCachedFieldModel(savedPlanCacheKey(session, target));
  const parsed =
    target.kind === "job"
      ? jobResponseSchema.safeParse(value)
      : workObjectResponseSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError({
      status: 0,
      code: "offline_packet_unavailable",
      message:
        "This phone has no verified saved plan for this work. Keep work stopped and go online.",
    });
  return {
    ...parsed.data,
    stale_fields: [...new Set([...parsed.data.stale_fields, "offline.cached_packet"])],
  };
}

/** Saves both job and typed-work packets through the same actual reads their review routes use. */
export async function prefetchSavedPlans(
  session: AuthenticatedSession,
  today: TodayResponse,
  options: {
    fetcher?: typeof fetch;
    concurrency?: number;
    isCurrent?: () => boolean;
    observation?: PrincipalReadObservation;
    onPacket?: (target: SavedPlanTarget, ready: boolean, model?: SavedPlanModel) => void;
  } = {},
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const queue = assignedPlanTargets(today);
  const context = await captureSavedPlanReadContext(
    session,
    options.isCurrent,
    options.observation,
  );
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        try {
          await context.assertCurrent();
          const read = await loadSavedPlan(
            session,
            target,
            options.fetcher,
            options.isCurrent,
            options.observation,
          );
          await context.assertCurrent();
          result[savedPlanTargetKey(target)] = read.saved;
          options.onPacket?.(target, read.saved, read.model);
        } catch (error) {
          if (isSavedPlanContextError(error)) return;
          await context.assertCurrent();
          result[savedPlanTargetKey(target)] = false;
          options.onPacket?.(target, false);
        }
      }
    }),
  );
  return result;
}
