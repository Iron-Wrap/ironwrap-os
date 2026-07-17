import type { AppEnv, AppSessionRecord } from "./app-types.ts";

const DEFAULT_SESSION_AGE_SECONDS = 15 * 60;

/**
 * Production scheduling has a deliberately independent decision authority. It
 * must not inherit the broad lead-triage approver, even when both happen to be
 * operated by the same human today.
 */
export interface ProductionScheduleApprovalDecisionConfig {
  approverId: string;
  maxSessionAgeSeconds: number;
}

export function productionScheduleApprovalDecisionConfig(
  env: AppEnv,
): ProductionScheduleApprovalDecisionConfig | null {
  const approverId = env.APP_PRODUCTION_SCHEDULE_APPROVER_ID?.trim() ?? "";
  const maxSessionAgeSeconds = boundedInt(
    env.APP_PRODUCTION_SCHEDULE_MAX_SESSION_AGE_SECONDS,
    DEFAULT_SESSION_AGE_SECONDS,
    60,
    60 * 60,
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverId) || maxSessionAgeSeconds === null) {
    return null;
  }
  return { approverId, maxSessionAgeSeconds };
}

export function sessionIsRecentForProductionScheduleApproval(
  sessionCreatedAt: AppSessionRecord["session_created_at"],
  config: Pick<ProductionScheduleApprovalDecisionConfig, "maxSessionAgeSeconds">,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(sessionCreatedAt);
  return Number.isFinite(createdAt) &&
    createdAt <= now &&
    now - createdAt <= config.maxSessionAgeSeconds * 1000;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}
