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
  const { needRefresh, setNeedRefresh, updateServiceWorker } =
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
    <div className="contents">
      <div
        className="col-span-2 col-start-1 row-start-2 flex min-h-9 flex-nowrap items-center gap-1.5 overflow-x-auto border-t border-border px-0 py-1.5 text-xs font-bold [scrollbar-width:none] sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:min-h-0 sm:border-t-0 sm:py-0 [&::-webkit-scrollbar]:hidden"
        aria-label="App status"
      >
        <StatusPill
          tone={online && csrfToken ? "ok" : "warning"}
          icon={
            online && csrfToken ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />
          }
        >
          {online && csrfToken ? "Online" : online ? "Sign-in paused" : "Offline"}
        </StatusPill>
        {outbox.pending > 0 ? (
          <StatusPill tone="info" icon={<UploadCloud aria-hidden="true" />}>
            {outbox.pending} waiting
          </StatusPill>
        ) : null}
        {outbox.needsAttention > 0 ? (
          <StatusPill tone="danger" icon={<ShieldAlert aria-hidden="true" />}>
            {outbox.needsAttention} need a check
          </StatusPill>
        ) : null}
        {outbox.unclaimed > 0 ? (
          <StatusPill tone="danger" icon={<ShieldAlert aria-hidden="true" />}>
            {outbox.unclaimed} old {outbox.unclaimed === 1 ? "item" : "items"} on this device only
          </StatusPill>
        ) : null}
        {storageWarning ? (
          <StatusPill tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
            Storage warning
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
            "col-span-full row-start-3 -mx-4 border-t px-4 py-3 text-sm sm:row-start-2 sm:-mx-6 sm:px-6",
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
                ? `${outbox.needsAttention} saved ${outbox.needsAttention === 1 ? "item needs" : "items need"} a check. Nothing was thrown away.`
                : outbox.unclaimed > 0
                  ? `${outbox.unclaimed} older saved ${outbox.unclaimed === 1 ? "item belongs" : "items belong"} to an older sign-in. ${outbox.unclaimed === 1 ? "It stays" : "They stay"} on this device and will not send with this sign-in. Keep this device for the office.`
                  : !online
                    ? "Offline. New work stays on this device until you go online and keep the app open."
                    : !csrfToken && outbox.pending > 0
                      ? "Go online and confirm this sign-in before sending. Every saved item stays on this device."
                      : outbox.uploading > 0
                        ? "Sending now. Keep this app open until every item is saved."
                        : storageNeedsEscalation && storageWarning === "low_storage"
                          ? "This device is low on space. Saved work is still here. Free space before you take many photos."
                          : storageNeedsEscalation && storageWarning === "persistence_denied"
                            ? "This device did not lock storage in place. Capture still works. Send saved work soon."
                            : storageNeedsEscalation && storageWarning === "check_failed"
                              ? "Could not check device storage. Capture still works. Send saved work soon."
                              : needRefresh
                                ? "A newer version of this app is ready."
                                : "Saved work needs a check before you continue."}
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
                  Send now
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
    </div>
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
    ok: "border-border bg-surface text-muted [&_svg]:text-ok",
    warning: "border-warning/25 bg-warning-soft/40 text-foreground [&_svg]:text-warning",
    danger: "border-danger/25 bg-danger-soft/40 text-foreground [&_svg]:text-danger",
    info: "border-border bg-surface text-muted [&_svg]:text-info",
  };
  return (
    <span
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5",
        tones[tone],
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      {children}
    </span>
  );
}
