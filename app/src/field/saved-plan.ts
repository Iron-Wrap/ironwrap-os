import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { ApiError } from "../lib/api";
import { getDatabase } from "../storage/db";
import { loadJob, loadWorkObject } from "./field-cache";
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
): Promise<boolean> {
  try {
    const record = await (
      await getDatabase()
    ).get("field_cache", savedPlanCacheKey(session, target));
    if (!record?.savedPlanBinding) return false;
    const parsed =
      target.kind === "job"
        ? jobResponseSchema.safeParse(record.value)
        : workObjectResponseSchema.safeParse(record.value);
    if (!parsed.success) return false;
    const secret = session.user.role === "field" ? await getDeviceSecret() : undefined;
    const expected = await savedPlanBinding(session, target, model ?? parsed.data, secret);
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
) {
  const model =
    target.kind === "job"
      ? await loadJob(session, target.jobId, fetcher)
      : await loadWorkObject(session, target.scope, fetcher);
  const plan = workPlanForTarget(target, model);
  const offline = model.stale_fields.includes("offline.cached_packet");
  const saved = await hasSavedPlan(session, target, model);
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

/** Saves both job and typed-work packets through the same actual reads their review routes use. */
export async function prefetchSavedPlans(
  session: AuthenticatedSession,
  today: TodayResponse,
  options: {
    fetcher?: typeof fetch;
    concurrency?: number;
    onPacket?: (target: SavedPlanTarget, ready: boolean, model?: SavedPlanModel) => void;
  } = {},
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const queue = assignedPlanTargets(today);
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        try {
          const read = await loadSavedPlan(session, target, options.fetcher);
          result[savedPlanTargetKey(target)] = read.saved;
          options.onPacket?.(target, read.saved, read.model);
        } catch {
          result[savedPlanTargetKey(target)] = false;
          options.onPacket?.(target, false);
        }
      }
    }),
  );
  return result;
}
