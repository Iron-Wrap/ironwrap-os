import type { AuthenticatedSession } from "../auth/session";

export interface DocumentRequest {
  entityType: string;
  entityId: string;
  templateId: string;
  templateRevisionId: string;
  idempotencyKey: string;
}

/** Only request identity is saved, never document contents or a cached claim of success. */
export function documentRequestKey(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
  templateId: string,
) {
  return JSON.stringify([
    "document-request-v1",
    session.tenant.id,
    session.user.id,
    entityType,
    entityId,
    templateId,
  ]);
}

export function restoreDocumentRequest(key: string): DocumentRequest | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const input = JSON.parse(raw) as DocumentRequest;
  if (
    !input ||
    ![
      input.entityType,
      input.entityId,
      input.templateId,
      input.templateRevisionId,
      input.idempotencyKey,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    throw new Error("Saved request is unreadable.");
  const scope = JSON.parse(key) as string[];
  if (
    scope[3] !== input.entityType ||
    scope[4] !== input.entityId ||
    scope[5] !== input.templateId ||
    !/^[A-Za-z0-9._:-]{8,140}$/.test(input.idempotencyKey)
  )
    throw new Error("Saved request has a different scope.");
  return input;
}

export function retainDocumentRequest(key: string, input: DocumentRequest) {
  // Write before submitting. If storage is unavailable, stop rather than promise reload safety.
  sessionStorage.setItem(key, JSON.stringify(input));
}
