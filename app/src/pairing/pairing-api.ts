import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import type { AuthenticatedSession } from "../auth/session";
import { sessionResponseSchema } from "../auth/session";
import {
  devicePairingsResponseSchema,
  fieldUsersResponseSchema,
  issueDevicePairingResponseSchema,
  issueHermesDesktopPairingResponseSchema,
  revokeDevicePairingResponseSchema,
  type IssuedDevicePairing,
  type IssuedHermesDesktopPairing,
} from "./pairing-contracts";

export async function listFieldUsers(session: AuthenticatedSession) {
  return await apiRequest({
    path: API_PATHS.fieldUsers,
    schema: fieldUsersResponseSchema,
    csrfToken: session.csrf_token,
  });
}

export async function listDevicePairings(session: AuthenticatedSession) {
  return await apiRequest({
    path: API_PATHS.devicePairings,
    schema: devicePairingsResponseSchema,
    csrfToken: session.csrf_token,
  });
}

export async function issueDevicePairing(
  session: AuthenticatedSession,
  fieldUserId: string,
): Promise<IssuedDevicePairing> {
  return await apiRequest({
    path: API_PATHS.devicePairings,
    method: "POST",
    body: { field_user_id: fieldUserId },
    schema: issueDevicePairingResponseSchema,
    csrfToken: session.csrf_token,
  });
}

export async function issueHermesDesktopPairing(
  session: AuthenticatedSession,
): Promise<IssuedHermesDesktopPairing> {
  return await apiRequest({
    path: API_PATHS.hermesDesktopPairings,
    method: "POST",
    body: {},
    schema: issueHermesDesktopPairingResponseSchema,
    csrfToken: session.csrf_token,
  });
}

export async function revokeDevicePairing(session: AuthenticatedSession, deviceId: string) {
  return await apiRequest({
    path: API_PATHS.devicePairingRevoke(deviceId),
    method: "POST",
    schema: revokeDevicePairingResponseSchema,
    csrfToken: session.csrf_token,
  });
}

export async function consumeDevicePairing(
  token: string,
  deviceProof: string,
): Promise<AuthenticatedSession> {
  const session = await apiRequest({
    path: API_PATHS.devicePairingConsume,
    method: "POST",
    body: { token, device_proof: deviceProof },
    schema: sessionResponseSchema,
  });
  if (!session.authenticated || session.user.role !== "field") {
    throw new ApiError({
      status: 200,
      code: "invalid_pairing_session",
      message: "This phone could not finish pairing. Ask the office for a new code.",
    });
  }
  return session;
}
