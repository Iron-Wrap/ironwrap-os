const SUBMISSION_KEY = "ironwrap.public-estimate.submission-id";

export function stableClientSubmissionId(): string {
  const generated = newClientSubmissionId();
  try {
    const stored = window.sessionStorage.getItem(SUBMISSION_KEY);
    if (stored && /^[a-z0-9][a-z0-9-]{15,127}$/i.test(stored)) return stored;
    window.sessionStorage.setItem(SUBMISSION_KEY, generated);
  } catch {
    // Storage can be blocked in an embedded browsing context. The component state keeps this ID stable.
  }
  return generated;
}

export function clearStableClientSubmissionId(): void {
  try {
    window.sessionStorage.removeItem(SUBMISSION_KEY);
  } catch {
    // A blocked storage area does not affect a completed request.
  }
}

function newClientSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `estimate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
