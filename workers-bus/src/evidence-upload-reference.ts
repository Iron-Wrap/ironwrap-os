/**
 * Upload receipts may become evidence references only through receipt resolution,
 * which checks the actor, tenant, scope, bytes and immutable manifest. Generic
 * opaque-reference fields cannot grant that meaning to user-supplied text.
 */
export function isReservedEvidenceUploadReference(value: unknown): boolean {
  return typeof value === "string" && /^evidence-upload:\/\//i.test(value.trim());
}
