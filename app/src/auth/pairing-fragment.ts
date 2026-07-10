export interface PairingLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface PairingHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

let fragmentRead = false;
let pendingToken: string | undefined;

export function takePairingTokenFromWindow(): string | undefined {
  if (!fragmentRead) {
    fragmentRead = true;
    pendingToken = extractAndScrubPairingToken();
  }
  return pendingToken;
}

export function clearPendingPairingToken(): void {
  pendingToken = undefined;
}

export function extractAndScrubPairingToken(
  location: PairingLocation = window.location,
  history: PairingHistory = window.history,
): string | undefined {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const token = new URLSearchParams(fragment).get("token")?.trim() || undefined;
  if (location.hash) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return token;
}
