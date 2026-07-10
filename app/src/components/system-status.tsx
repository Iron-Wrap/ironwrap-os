import { Cloud, CloudOff, Download, RefreshCw, ShieldAlert, UploadCloud } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";

import { useInstallPrompt } from "../hooks/use-install-prompt";
import { useOnlineStatus } from "../hooks/use-online-status";
import { cn } from "../lib/cn";
import { flushOutbox } from "../storage/outbox-processor";
import { useStorageDurability } from "../storage/durability";
import { useAppOpenOutboxSync, useOutboxSummary } from "../storage/use-outbox";
import { Button } from "./ui/button";
import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";

export function SystemStatus() {
  const online = useOnlineStatus();
  const outbox = useOutboxSummary();
  const install = useInstallPrompt();
  const session = useSession();
  const csrfToken = isOfflineSession(session) ? undefined : session.csrf_token;
  const canSync = online && Boolean(csrfToken);
  const storage = useStorageDurability();
  const storageWarning = storage.checked ? storage.warning : undefined;
  useAppOpenOutboxSync(csrfToken);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error("Service worker registration failed", error);
    },
  });

  const hasBanner =
    !online ||
    (!csrfToken && outbox.pending > 0) ||
    outbox.uploading > 0 ||
    outbox.needsAttention > 0 ||
    Boolean(storageWarning) ||
    needRefresh ||
    offlineReady;

  return (
    <>
      <div
        className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 pb-3 text-xs font-bold sm:px-6"
        aria-label="App status"
      >
        <StatusPill
          tone={online && csrfToken ? "ok" : "warning"}
          icon={
            online && csrfToken ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />
          }
        >
          {online && csrfToken ? "Online" : online ? "Session offline" : "Offline"}
        </StatusPill>
        {outbox.pending > 0 ? (
          <StatusPill tone="info" icon={<UploadCloud aria-hidden="true" />}>
            {outbox.pending} waiting
          </StatusPill>
        ) : null}
        {outbox.needsAttention > 0 ? (
          <StatusPill tone="danger" icon={<ShieldAlert aria-hidden="true" />}>
            {outbox.needsAttention} need attention
          </StatusPill>
        ) : null}
        {storageWarning ? (
          <StatusPill tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
            Device storage warning
          </StatusPill>
        ) : null}
        {install.canInstall ? (
          <Button size="compact" variant="outline" onClick={() => void install.promptInstall()}>
            <Download aria-hidden="true" />
            Install
          </Button>
        ) : null}
      </div>

      {hasBanner ? (
        <div
          className={cn(
            "border-b px-4 py-3 text-sm sm:px-6",
            outbox.needsAttention > 0
              ? "border-danger/30 bg-danger-soft text-danger"
              : !online || outbox.uploading > 0 || Boolean(storageWarning)
                ? "border-warning/30 bg-warning-soft text-warning"
                : "border-info/30 bg-info-soft text-info",
          )}
          role="status"
          aria-live="polite"
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <p className="font-semibold">
              {outbox.needsAttention > 0
                ? `${outbox.needsAttention} saved ${outbox.needsAttention === 1 ? "item needs" : "items need"} review. Nothing was discarded.`
                : !online
                  ? "Offline. New work stays on this device until you reconnect and keep the app open."
                  : !csrfToken && outbox.pending > 0
                    ? "Reconnect and verify this sign-in before syncing. Every saved item remains on this device."
                    : outbox.uploading > 0
                      ? "Syncing now. Keep IronWrap OS open until the server verifies every item."
                      : storageWarning === "low_storage"
                        ? "Device storage is low. Existing work stays intact; free space before a large photo run."
                        : storageWarning === "persistence_denied"
                          ? "This device did not grant durable storage. Capture still works, but sync saved work promptly."
                          : storageWarning === "check_failed"
                            ? "Device storage durability could not be verified. Capture still works; sync saved work promptly."
                            : needRefresh
                              ? "A safer, newer version of IronWrap OS is ready."
                              : storage.checked && storage.persistent
                                ? "Offline shell ready. This device granted durable storage for saved field work."
                                : storage.checked && !storage.supported
                                  ? "The app shell is available offline. This browser cannot report storage durability, so sync promptly."
                                  : "The app shell is available offline. Save and sync field work as soon as signal returns."}
            </p>
            <div className="flex flex-wrap gap-2">
              {canSync && outbox.pending > 0 && outbox.uploading === 0 ? (
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => void flushOutbox({ csrfToken })}
                >
                  <UploadCloud aria-hidden="true" />
                  Sync now
                </Button>
              ) : null}
              {needRefresh ? (
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => void updateServiceWorker(true)}
                >
                  <RefreshCw aria-hidden="true" />
                  Update now
                </Button>
              ) : null}
              {needRefresh ? (
                <Button size="compact" variant="ghost" onClick={() => setNeedRefresh(false)}>
                  Later
                </Button>
              ) : null}
              {offlineReady && !needRefresh ? (
                <Button size="compact" variant="ghost" onClick={() => setOfflineReady(false)}>
                  Got it
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatusPill({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warning" | "danger" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    ok: "border-ok/30 bg-ok-soft text-ok",
    warning: "border-warning/30 bg-warning-soft text-warning",
    danger: "border-danger/30 bg-danger-soft text-danger",
    info: "border-info/30 bg-info-soft text-info",
  };
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3",
        tones[tone],
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      {children}
    </span>
  );
}
