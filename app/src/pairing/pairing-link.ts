const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Pairing links are short-lived bearer credentials. Render or share only an
 * exact same-origin fragment URL so a malformed server response can never
 * redirect a crew member or put the token in a query string.
 */
export function safePairingUrl(
  value: string,
  origin: string = window.location.origin,
): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.pathname !== "/auth/pair" || url.search) return undefined;
    const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const params = new URLSearchParams(fragment);
    const token = params.get("token")?.trim();
    if (!token || !TOKEN_PATTERN.test(token) || [...params.keys()].some((key) => key !== "token")) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function pairingExpiryLabel(expiresAt: string, now = Date.now()): string {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) return "Expired. Issue a new code.";
  const seconds = Math.ceil((expiry - now) / 1_000);
  if (seconds < 60) return "Expires in under one minute.";
  const minutes = Math.ceil(seconds / 60);
  return `Expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export function formatDateTime(value: string): string {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(date),
  );
}
