import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  postizConnectResponseSchema,
  postizIntentResponseSchema,
  type PostizConnectResponse,
  type PostizIntentResponse,
  type PostizProvider,
} from "./postiz-contracts";

export async function loadPostizIntent(
  intentId: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizIntentResponse> {
  return await apiRequest({
    path: API_PATHS.postizIntent(intentId),
    schema: postizIntentResponseSchema,
    fetcher,
  });
}

export async function connectPostiz(
  session: AuthenticatedSession,
  provider: PostizProvider,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizConnectResponse> {
  return await apiRequest({
    path: API_PATHS.postizConnect,
    schema: postizConnectResponseSchema,
    method: "POST",
    body: { provider },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approvePostizIntent(
  session: AuthenticatedSession,
  intentId: string,
  expectedVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizIntentResponse> {
  return await commandPostizIntent(
    session,
    API_PATHS.postizIntentApprove(intentId),
    expectedVersion,
    idempotencyKey,
    fetcher,
  );
}

export async function stopPostizIntent(
  session: AuthenticatedSession,
  intentId: string,
  expectedVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizIntentResponse> {
  return await commandPostizIntent(
    session,
    API_PATHS.postizIntentStop(intentId),
    expectedVersion,
    idempotencyKey,
    fetcher,
  );
}

export async function rejectPostizIntent(
  session: AuthenticatedSession,
  intentId: string,
  expectedVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizIntentResponse> {
  return await commandPostizIntent(
    session,
    API_PATHS.postizIntentReject(intentId),
    expectedVersion,
    idempotencyKey,
    fetcher,
  );
}

export async function reconcilePostizIntent(
  session: AuthenticatedSession,
  intentId: string,
  expectedVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<PostizIntentResponse> {
  return await commandPostizIntent(
    session,
    API_PATHS.postizIntentReconcile(intentId),
    expectedVersion,
    idempotencyKey,
    fetcher,
  );
}

async function commandPostizIntent(
  session: AuthenticatedSession,
  path: string,
  expectedVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch,
): Promise<PostizIntentResponse> {
  return await apiRequest({
    path,
    schema: postizIntentResponseSchema,
    method: "POST",
    body: { expected_version: expectedVersion },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export function newPostizActionKey(action: string): string {
  return `postiz:${action}:${crypto.randomUUID()}`;
}
