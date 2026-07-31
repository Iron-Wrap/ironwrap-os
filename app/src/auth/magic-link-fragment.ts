export interface MagicLinkLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface MagicLinkHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

let fragmentRead = false;
let pendingToken: string | undefined;

export function takeMagicLinkTokenFromWindow(): string | undefined {
  if (!fragmentRead) {
    fragmentRead = true;
    pendingToken = extractAndScrubMagicLinkToken();
  }
  return pendingToken;
}

export function clearPendingMagicLinkToken(): void {
  fragmentRead = false;
  pendingToken = undefined;
}

export function extractAndScrubMagicLinkToken(
  location: MagicLinkLocation = window.location,
  history: MagicLinkHistory = window.history,
): string | undefined {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const token = new URLSearchParams(fragment).get("token")?.trim() || undefined;
  if (location.hash) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return token;
}
