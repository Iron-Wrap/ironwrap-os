import type { AuthenticatedSession } from "../auth/session";
import { safetyEquipmentResponseSchema } from "../field/safety-contracts";
import { apiRequest } from "../lib/api";

const equipmentPath = (equipmentId: string) =>
  `/api/v1/safety/equipment/${encodeURIComponent(equipmentId)}`;

export function loadSafetyEquipment(equipmentId: string) {
  return apiRequest({ path: equipmentPath(equipmentId), schema: safetyEquipmentResponseSchema });
}

export function inspectSafetyEquipment(
  session: AuthenticatedSession,
  equipmentId: string,
  input: { result: "pass" | "fail"; detail: string; expected_version: number },
) {
  return apiRequest({
    path: `${equipmentPath(equipmentId)}/inspections`,
    method: "POST",
    body: input,
    csrfToken: session.csrf_token,
    schema: safetyEquipmentResponseSchema,
  });
}
