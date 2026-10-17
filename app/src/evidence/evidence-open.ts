import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { apiBlob } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import type { EvidenceFileRef } from "./evidence-types";
import { evidenceTransferTimeoutMs } from "./evidence-upload";

/** How long a file stays readable at its temporary address before the browser lets go of it. */
export const OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Opens one attached file. The bytes are fetched through the app's own authenticated call, because
 * a paired field device has to send its proof header and a plain link would not. They are then
 * shown from a temporary address, in a tab opened at the moment of the tap (a tab opened after
 * the wait for the file is often blocked), and the tab is closed again if the file never comes.
 * Throws the `ApiError` the Worker's refusal became, for the caller to put into words.
 */
export async function openEvidenceFile(input: {
  session: AuthenticatedSession;
  file: Pick<EvidenceFileRef, "receipt_id" | "file_name" | "content_type" | "byte_size">;
  fetcher?: typeof fetch | undefined;
  /** Replaces the wait worked out from the file's size. For tests. */
  timeoutMs?: number | undefined;
}): Promise<void> {
  const tab = window.open("", "_blank");
  if (tab) {
    try {
      // The tab shows a file from this app's own temporary address; it needs no hold on the app.
      tab.opener = null;
    } catch {
      // Some browsers refuse to change it. It still opens.
    }
  }
  try {
    const blob = await apiBlob({
      path: API_PATHS.evidenceContent(input.file.receipt_id),
      deviceProof: input.session.user.role === "field" ? getDeviceSecret : undefined,
      timeoutMs: input.timeoutMs ?? evidenceTransferTimeoutMs(input.file.byte_size),
      fetcher: input.fetcher,
    });
    // The address runs as this app, so what it shows is decided here, not by the response: the
    // record's own type, one of the six it may list, never whatever the answer claimed.
    const typed = new Blob([blob], { type: input.file.content_type });
    const url = URL.createObjectURL(typed);
    if (tab) tab.location.href = url;
    else saveFromAddress(url, input.file.file_name);
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Where a tab could not be opened, the browser's own download carries the file instead. */
function saveFromAddress(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
