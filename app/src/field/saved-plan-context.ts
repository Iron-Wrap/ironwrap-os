import type { AuthenticatedSession } from "../auth/session";
import type { JobResponse, TodayResponse, WorkObjectResponse } from "./field-contracts";

export type SavedPlanTarget =
  | { kind: "job"; jobId: string }
  | { kind: "work-object"; scope: WorkObjectResponse["work_object"] };
export type SavedPlanModel = JobResponse | WorkObjectResponse;
export type SavedWorkPackage = NonNullable<JobResponse["packet"]["work_package"]>;

export function assignedPlanTargets(today: TodayResponse): SavedPlanTarget[] {
  return [
    ...today.jobs.map((job): SavedPlanTarget => ({ kind: "job", jobId: job.id })),
    ...today.work_objects.map((work): SavedPlanTarget => ({
      kind: "work-object",
      scope: {
        workObjectType: work.work_object_type,
        workObjectId: work.work_object_id,
        physicalContextType: work.physical_context_type,
        physicalContextId: work.physical_context_id,
      },
    })),
  ];
}

export function savedPlanTargetKey(target: SavedPlanTarget): string {
  return JSON.stringify(
    target.kind === "job" ? ["job", target.jobId] : ["work-object", ...scopeParts(target.scope)],
  );
}

export function savedPlanCacheKey(session: AuthenticatedSession, target: SavedPlanTarget): string {
  const suffix =
    target.kind === "job"
      ? `job:${target.jobId}`
      : `work-object:${scopeParts(target.scope).join(":")}`;
  return `${session.tenant.id}:${session.user.id}:${suffix}`;
}

/** Never turn a typed object into a job, or accept the legacy parser's unknown scope defaults. */
export function workPlanForTarget(
  target: SavedPlanTarget,
  model: SavedPlanModel,
): SavedWorkPackage | null {
  const plan = "job" in model ? model.packet.work_package : model.work_package;
  if (!plan || plan.steps.length === 0 || !model.assignment) return null;
  if (model.stale_fields.some((field) => /work_package.*unavailable/.test(field))) return null;
  const expected =
    target.kind === "job"
      ? ["Roof Job", target.jobId, "Roof Site", target.jobId]
      : scopeParts(target.scope);
  if (
    target.kind === "job"
      ? !("job" in model) || model.job.id !== target.jobId
      : "job" in model ||
        target.scope.workObjectType === "Roof Job" ||
        JSON.stringify(scopeParts(model.work_object)) !== JSON.stringify(expected)
  ) {
    return null;
  }
  const actual = [
    plan.work_object_type,
    plan.work_object_id,
    plan.physical_context_type,
    plan.physical_context_id,
  ];
  if (actual.some((value) => !value.trim() || value === "unknown")) return null;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return null;
  if (
    [
      plan.title,
      plan.objective,
      plan.boundaries,
      plan.prerequisites,
      plan.expected_result,
      plan.stop_conditions,
      plan.make_safe_procedure,
      ...plan.steps.flatMap((step) => [
        step.instruction,
        step.required_evidence,
        step.acceptance_criteria,
      ]),
    ].some((value) => !value.trim())
  ) {
    return null;
  }
  return plan;
}

/** Context receipt for a read, not a permission, release, acknowledgement or safety attestation. */
export async function savedPlanBinding(
  session: AuthenticatedSession,
  target: SavedPlanTarget,
  model: SavedPlanModel,
  deviceSecret: string | undefined,
) {
  const plan = workPlanForTarget(target, model);
  if (!plan || (session.user.role === "field" && !deviceSecret)) return undefined;
  const read = {
    ...model,
    stale_fields: model.stale_fields.filter((field) => field !== "offline.cached_packet"),
  };
  return {
    format: "saved-plan-context-v1",
    tenantId: session.tenant.id,
    userId: session.user.id,
    role: session.user.role,
    workerIdentity: session.user.frappe_user_id,
    pairedDevice: session.user.role === "field" ? await digest(deviceSecret!) : null,
    target: savedPlanTargetKey(target),
    assignmentId: model.assignment!.id,
    packageId: plan.id,
    packageVersion: plan.version,
    releaseAttemptId: plan.release_attempt_id,
    generatedAt: model.read_model_generated_at,
    readDigest: await digest(
      JSON.stringify(read, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
            )
          : value,
      ),
    ),
  };
}

function scopeParts(scope: WorkObjectResponse["work_object"]): string[] {
  return [
    scope.workObjectType,
    scope.workObjectId,
    scope.physicalContextType,
    scope.physicalContextId,
  ];
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
