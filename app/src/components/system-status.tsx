import { Cloud, CloudOff, Download, RefreshCw, ShieldAlert, UploadCloud } from "lucide-react";
import { registerSW } from "virtual:pwa-register";
import { useEffect, useRef, useState } from "react";

import { useInstallPrompt } from "../hooks/use-install-prompt";
import { useOnlineStatus } from "../hooks/use-online-status";
import { cn } from "../lib/cn";
import { flushOutbox } from "../storage/outbox-processor";
import { useStorageDurability } from "../storage/durability";
import { useAppOpenOutboxSync, useOutboxSummary } from "../storage/use-outbox";
import { Button } from "./ui/button";
import { isOfflineSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { useSession } from "../auth/session-context";

export function SystemStatus() {
  const online = useOnlineStatus();
  const install = useInstallPrompt();
  const session = useSession();
  const outboxPrincipal = { tenantId: session.tenant.id, userId: session.user.id };
  const outbox = useOutboxSummary(outboxPrincipal);
  const csrfToken = isOfflineSession(session) ? undefined : session.csrf_token;
  const deviceProof = session.user.role === "field" ? getDeviceSecret : undefined;
  const canSync = online && Boolean(csrfToken);
  const storage = useStorageDurability();
  const storageWarning = storage.checked ? storage.warning : undefined;
  const storageNeedsEscalation =
    Boolean(storageWarning) &&
    (outbox.pending > 0 || outbox.uploading > 0 || outbox.needsAttention > 0);
  useAppOpenOutboxSync(outboxPrincipal, csrfToken, deviceProof);
  const { offlineReady, needRefresh, setNeedRefresh, updateServiceWorker } =
    useDeferredServiceWorkerRegistration();

  const hasBanner =
    !online ||
    (!csrfToken && outbox.pending > 0) ||
    outbox.uploading > 0 ||
    outbox.needsAttention > 0 ||
    outbox.unclaimed > 0 ||
    storageNeedsEscalation ||
    needRefresh;

  return (
    <>
      <div
        className="mx-auto flex max-w-7xl flex-nowrap items-center gap-2 overflow-x-auto px-4 pb-3 text-xs font-bold sm:flex-wrap sm:overflow-visible sm:px-6"
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
        {outbox.unclaimed > 0 ? (
          <StatusPill tone="danger" icon={<ShieldAlert aria-hidden="true" />}>
            {outbox.unclaimed} legacy {outbox.unclaimed === 1 ? "item" : "items"} isolated
          </StatusPill>
        ) : null}
        {storageWarning ? (
          <StatusPill tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
            Device storage warning
          </StatusPill>
        ) : null}
        {offlineReady ? (
          <StatusPill tone="info" icon={<Cloud aria-hidden="true" />}>
            Offline shell ready
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
              : !online || outbox.uploading > 0 || storageNeedsEscalation
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
                : outbox.unclaimed > 0
                  ? `${outbox.unclaimed} older saved ${outbox.unclaimed === 1 ? "item predates" : "items predate"} account binding. They are isolated and will not sync under this user; keep this device for administrator recovery.`
                  : !online
                    ? "Offline. New work stays on this device until you reconnect and keep the app open."
                    : !csrfToken && outbox.pending > 0
                      ? "Reconnect and verify this sign-in before syncing. Every saved item remains on this device."
                      : outbox.uploading > 0
                        ? "Syncing now. Keep IronWrap OS open until the server verifies every item."
                        : storageNeedsEscalation && storageWarning === "low_storage"
                          ? "Device storage is low. Existing work stays intact; free space before a large photo run."
                          : storageNeedsEscalation && storageWarning === "persistence_denied"
                            ? "This device did not grant durable storage. Capture still works, but sync saved work promptly."
                            : storageNeedsEscalation && storageWarning === "check_failed"
                              ? "Device storage durability could not be verified. Capture still works; sync saved work promptly."
                              : needRefresh
                                ? "A safer, newer version of IronWrap OS is ready."
                                : "Saved work needs attention before you continue."}
            </p>
            <div className="flex flex-wrap gap-2">
              {session.user.role === "field" && outbox.needsAttention > 0 ? (
                <Button asChild size="compact" variant="outline">
                  <a href="/today#saved-work">
                    <ShieldAlert aria-hidden="true" />
                    Review saved work
                  </a>
                </Button>
              ) : null}
              {canSync && outbox.pending > 0 && outbox.uploading === 0 ? (
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => void flushOutbox({ ...outboxPrincipal, csrfToken, deviceProof })}
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const SERVICE_WORKER_START_DELAY_MS = 1_000;

function useDeferredServiceWorkerRegistration() {
  const [offlineReady, setOfflineReady] = useState(false);
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateServiceWorkerRef = useRef<(reloadPage?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    // The verified run sheet is the first operationally useful field view. Register the
    // worker just after it has a chance to commit, rather than contending with its first
    // network and render cycle. Existing installed workers still control immediately.
    const timeout = window.setTimeout(() => {
      updateServiceWorkerRef.current = registerSW({
        immediate: true,
        onOfflineReady: () => setOfflineReady(true),
        onNeedRefresh: () => setNeedRefresh(true),
        onRegisterError(error) {
          console.error("Service worker registration failed", error);
        },
      });
    }, SERVICE_WORKER_START_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return {
    offlineReady,
    needRefresh,
    setNeedRefresh,
    updateServiceWorker: (reloadPage?: boolean) => updateServiceWorkerRef.current(reloadPage),
  };
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
        "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3",
        tones[tone],
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      {children}
    </span>
  );
}
