import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  operatingJobAssignmentInputSchema,
  operatingJobAssignmentResponseSchema,
  productionRunwayResponseSchema,
  type OperatingJobAssignmentInput,
  type OperatingJobAssignmentResponse,
  type ProductionRunwayResponse,
} from "./production-contracts";

export async function loadProductionRunway(
  fetcher: typeof fetch = fetch,
): Promise<ProductionRunwayResponse> {
  return await apiRequest({
    path: API_PATHS.production,
    schema: productionRunwayResponseSchema,
    fetcher,
  });
}

export async function scheduleProductionJob(
  session: AuthenticatedSession,
  input: OperatingJobAssignmentInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<OperatingJobAssignmentResponse> {
  const command = operatingJobAssignmentInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.productionJobSchedule(command.roofJobId),
    schema: operatingJobAssignmentResponseSchema,
    method: "POST",
    body: {
      expected_roof_job_version: command.expectedRoofJobVersion,
      crew_id: command.crewId,
      expected_crew_version: command.expectedCrewVersion,
      scheduled_start: command.scheduledStart,
      scheduled_end: command.scheduledEnd,
      supersedes_assignment_id: command.supersedesAssignmentId,
      correction_reason: command.correctionReason,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export function newProductionScheduleKey(): string {
  return `operating-job-assignment:${crypto.randomUUID()}`;
}
