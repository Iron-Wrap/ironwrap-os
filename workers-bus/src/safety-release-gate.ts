import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, WorkObjectScope } from "./app-types.ts";
import {
  evaluateSafetyReadiness,
  recordSafetyReadinessSnapshot,
  safetyWorkObjectKey,
  type SafetyBlocker,
  type SafetyReadiness,
  type SafetyReadinessConsumer,
  type SafetyScopeRef,
  type SafetyScopeType,
} from "./safety-lifecycle.ts";

/**
 * The one place a release decision consults safety.
 *
 * Work Package release and production-schedule release both call
 * `safetyReleaseGate`, which evaluates current readiness, durably records what
 * it saw, and reports whether the release may proceed. Read-only surfaces call
 * `safetyReadinessForScope`, which evaluates without writing a snapshot so a
 * page refresh does not manufacture release evidence.
 *
 * Both fail closed: a store error becomes a blocker, never a pass.
 */

export interface SafetyGateScopeInput {
  tenantId: string;
  scope: SafetyScopeRef;
  /** Parent job, when the scope is narrower than the job it belongs to. */
  jobId: string | null;
  /** Complete committed/authorized identity; jobId alone is not a universal parent relation. */
  workObjectScope?: WorkObjectScope;
  /** App user ids whose individually issued PPE gates this release. */
  subjectUserIds: string[];
  now: string;
}

export interface SafetyGateResult {
  readiness: SafetyReadiness;
  snapshot_id: string;
  snapshot_sha256: string;
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;

/**
 * A tenant-wide stop reaches every job; a job stop reaches every package on
 * that job. The chain is explicit so the query can never silently miss a level.
 */
export function safetyScopeChain(
  tenantId: string,
  scope: SafetyScopeRef,
  jobId: string | null,
  workObjectScope?: WorkObjectScope,
): SafetyScopeRef[] {
  const chain: SafetyScopeRef[] = [{ type: "tenant", id: tenantId }];
  if (workObjectScope) safetyWorkObjectKey(workObjectScope);
  const roofJobId = !workObjectScope ? jobId
    : workObjectScope.workObjectType === "Roof Job" ? workObjectScope.workObjectId
    : workObjectScope.physicalContextType === "Roof Job" ? workObjectScope.physicalContextId
    : null;
  if (roofJobId && SCOPE_ID.test(roofJobId) && scope.type !== "roof_job") {
    chain.push({ type: "roof_job", id: roofJobId });
  }
  if (scope.type !== "tenant" && SCOPE_ID.test(scope.id)) chain.push(scope);
  return chain;
}

/**
 * Read-only readiness for a scope. Never writes, never throws: an unreadable
 * store yields a synthetic blocker so a degraded backend cannot look safe.
 */
export async function safetyReadinessForScope(
  env: AppEnv,
  input: SafetyGateScopeInput,
): Promise<SafetyReadiness> {
  let scopes: SafetyScopeRef[] = [{ type: "tenant", id: input.tenantId }];
  try {
    scopes = safetyScopeChain(input.tenantId, input.scope, input.jobId, input.workObjectScope);
    return await evaluateSafetyReadiness(env, {
      tenantId: input.tenantId,
      scopes,
      workObjectScope: input.workObjectScope,
      subjectUserIds: input.subjectUserIds,
      now: input.now,
    });
  } catch {
    return {
      ready: false,
      blockers: [
        {
          code: "safety_event_uncontrolled",
          subject_type: "occurrence",
          subject_id: input.scope.id,
          detail: "Current safety state could not be read, so release stays blocked.",
        },
      ],
      scopes,
      evaluated_at: input.now,
    };
  }
}

/**
 * Evaluates readiness for an actual release decision and records the immutable
 * snapshot of what the gate saw, including a refusal.
 */
export async function safetyReleaseGate(
  env: AppEnv,
  input: SafetyGateScopeInput & {
    consumer: SafetyReadinessConsumer;
    evaluatedByUserId: string;
    decisionRef: string;
  },
): Promise<SafetyGateResult> {
  const readiness = await safetyReadinessForScope(env, input);
  const snapshotId = `srs_${(await sha256Hex(`${input.tenantId}:${input.consumer}:${input.decisionRef}:${input.now}`)).slice(0, 40)}`;
  let digest = "";
  try {
    digest = await recordSafetyReadinessSnapshot(env, {
      tenantId: input.tenantId,
      snapshotId,
      scope: input.scope,
      consumer: input.consumer,
      readiness,
      evaluatedByUserId: input.evaluatedByUserId,
      now: input.now,
    });
  } catch {
    // A snapshot that cannot be written is itself a reason to refuse: the
    // release would otherwise proceed with no durable record of its basis.
    return {
      readiness: {
        ...readiness,
        ready: false,
        blockers: [
          ...readiness.blockers,
          {
            code: "safety_event_uncontrolled",
            subject_type: "occurrence",
            subject_id: input.scope.id,
            detail: "The safety readiness snapshot could not be recorded, so release stays blocked.",
          },
        ],
      },
      snapshot_id: snapshotId,
      snapshot_sha256: "",
    };
  }
  return { readiness, snapshot_id: snapshotId, snapshot_sha256: digest };
}

/**
 * Blockers that must remove a work-package action from a worker's device.
 * Stopping work is never in this set: no safety state may make a stop harder.
 */
export function safetyBlockedActions(blockers: SafetyBlocker[]): string[] {
  return blockers.length === 0
    ? []
    : ["work_package.acknowledge", "work_package.start", "work_package.complete"];
}

export function safetyScopeRef(type: SafetyScopeType, id: string): SafetyScopeRef {
  return { type, id };
}
