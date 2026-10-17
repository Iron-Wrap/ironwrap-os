import {
  Check,
  CloudOff,
  Download,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  UploadCloud,
} from "lucide-react";
import { registerSW } from "virtual:pwa-register";
import { useEffect, useRef, useState } from "react";

import { useInstallPrompt } from "../hooks/use-install-prompt";
import { useOfflineWriteMode } from "./offline-write-mode";
import { useOnlineStatus } from "../hooks/use-online-status";
import { cn } from "../lib/cn";
import { flushOutbox } from "../storage/outbox-processor";
import { useStorageDurability } from "../storage/durability";
import { useAppOpenOutboxSync, useOutboxSummary } from "../storage/use-outbox";
import type { OutboxReadState } from "../storage/use-outbox";
import { Button } from "./ui/button";
import { isOfflineSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { useSession } from "../auth/session-context";

/**
 * Connection, outbox, storage, install and update truth for the shell header. The compact part
 * sits in the header row; the banner takes its own line beneath it. Crew storage status is
 * present from the first render so an asynchronous storage check cannot move the run sheet.
 * `crew` also has an always-visible sync state: storage protection is not proof of delivery.
 */
export function SystemStatus({
  variant = "office",
  bannerClassName,
}: {
  variant?: "office" | "crew";
  bannerClassName?: string;
} = {}) {
  const online = useOnlineStatus();
  const install = useInstallPrompt();
  const session = useSession();
  const outboxPrincipal = { tenantId: session.tenant.id, userId: session.user.id };
  const outbox = useOutboxSummary(outboxPrincipal);
  const csrfToken = isOfflineSession(session) ? undefined : session.csrf_token;
  const deviceProof = session.user.role === "field" ? getDeviceSecret : undefined;
  const canSync = online && Boolean(csrfToken);
  const storage = useStorageDurability();
  // The queued-work promise below is true of the field surfaces and false of the
  // read-only configuration screens, where an offline edit is refused and kept
  // nowhere. Say what this surface actually does rather than promise a sync that
  // will never happen.
  const offlineWriteMode = useOfflineWriteMode();
  const offlineDiscardsWrites =
    offlineWriteMode === "read_only" && outbox.pending === 0 && outbox.uploading === 0;
  const storageWarning = storage.checked ? storage.warning : undefined;
  const storageNeedsEscalation =
    Boolean(storageWarning) &&
    (variant === "crew" || outbox.pending > 0 || outbox.uploading > 0 || outbox.needsAttention > 0);
  useAppOpenOutboxSync(outboxPrincipal, csrfToken, deviceProof);
  const { needRefresh, setNeedRefresh, updateServiceWorker } =
    useDeferredServiceWorkerRegistration();

  const hasBanner =
    outbox.readState === "error" ||
    !online ||
    (!csrfToken && outbox.pending > 0) ||
    outbox.uploading > 0 ||
    outbox.needsAttention > 0 ||
    outbox.unclaimed > 0 ||
    storageNeedsEscalation ||
    needRefresh;
  const hasCompactStatus =
    !online ||
    !csrfToken ||
    outbox.pending > 0 ||
    outbox.needsAttention > 0 ||
    outbox.unclaimed > 0 ||
    Boolean(storageWarning) ||
    install.canInstall;
  const hasBannerActions =
    outbox.readState === "error" ||
    (session.user.role === "field" && outbox.needsAttention > 0) ||
    (canSync && outbox.pending > 0 && outbox.uploading === 0) ||
    needRefresh;

  return (
    <>
      {variant === "crew" ? (
        <div className="crew-status flex min-h-11 items-center justify-between gap-2">
          <CrewSyncState
            online={online}
            signedIn={Boolean(csrfToken)}
            pending={outbox.pending}
            uploading={outbox.uploading}
            needsAttention={outbox.needsAttention}
            unclaimed={outbox.unclaimed}
            readState={outbox.readState}
          />
          {install.canInstall ? (
            <Button size="compact" variant="outline" onClick={() => void install.promptInstall()}>
              <Download aria-hidden="true" />
              Install
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className="flex min-h-11 max-w-[7.5rem] shrink flex-nowrap items-center gap-1 overflow-x-auto text-xs font-bold [scrollbar-width:none] min-[721px]:max-w-none min-[721px]:gap-1.5 [&::-webkit-scrollbar]:hidden"
          aria-label={hasCompactStatus ? "App status" : undefined}
          hidden={!hasCompactStatus}
        >
          {hasCompactStatus ? (
            <>
              {!online || !csrfToken ? (
                <StatusPill tone="warning" icon={<CloudOff aria-hidden="true" />}>
                  {online ? "Sign-in paused" : "Offline"}
                </StatusPill>
              ) : null}
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
                  {outbox.unclaimed} old {outbox.unclaimed === 1 ? "item" : "items"} on this device
                  only
                </StatusPill>
              ) : null}
              {storageWarning ? (
                <StatusPill tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
                  Storage warning
                </StatusPill>
              ) : null}
              {install.canInstall ? (
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => void install.promptInstall()}
                >
                  <Download aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Install</span>
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {hasBanner || variant === "crew" ? (
        <div
          className={cn(
            "order-last basis-full shrink-0 border-t px-4 py-3 text-sm min-[721px]:px-6 min-[1101px]:px-8",
            variant === "crew" &&
              "min-h-[calc(3lh+1.5rem+1px)] min-[721px]:min-h-[calc(1lh+1.5rem+1px)]",
            bannerClassName,
            !hasBanner
              ? "border-border bg-surface text-muted"
              : outbox.needsAttention > 0
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
              {outbox.readState === "error"
                ? "Could not read saved work on this device. Keep this device and reload to try again."
                : outbox.needsAttention > 0
                  ? `${outbox.needsAttention} saved ${outbox.needsAttention === 1 ? "item needs" : "items need"} a check. Nothing was thrown away.`
                  : outbox.unclaimed > 0
                    ? `${outbox.unclaimed} older saved ${outbox.unclaimed === 1 ? "item belongs" : "items belong"} to an older sign-in. ${outbox.unclaimed === 1 ? "It stays" : "They stay"} on this device and will not send with this sign-in. Keep this device for the office.`
                    : !online
                      ? offlineDiscardsWrites
                        ? "Offline. This screen is read-only until you reconnect; nothing here is queued for sending."
                        : "Offline. New work stays on this device until you go online and keep the app open."
                      : !csrfToken && outbox.pending > 0
                        ? "Go online and confirm this sign-in before sending. Every saved item stays on this device."
                        : outbox.uploading > 0
                          ? "Sending now. Keep this app open until every item is saved."
                          : storageNeedsEscalation && storageWarning === "low_storage"
                            ? "This device is low on space. Free space before you take more photos."
                            : storageNeedsEscalation && storageWarning === "persistence_denied"
                              ? "This device did not lock storage in place. Capture still works. Send saved work soon."
                              : storageNeedsEscalation && storageWarning === "check_failed"
                                ? "Could not check device storage. Capture still works. Send saved work soon."
                                : needRefresh
                                  ? "A newer version of this app is ready."
                                  : !storage.checked
                                    ? "Checking device storage. Keep this app open while sending saved work."
                                    : storage.persistent === true
                                      ? "Device storage is protected. Keep this app open while sending saved work."
                                      : "Storage protection is unavailable. Send saved work before leaving this device."}
            </p>
            {hasBannerActions ? (
              <div className="flex flex-wrap gap-2">
                {outbox.readState === "error" ? (
                  <Button size="compact" variant="outline" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                ) : null}
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
            ) : null}
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
    ok: "border-border bg-surface text-muted [&_svg]:text-ok",
    warning: "border-warning/25 bg-warning-soft/40 text-foreground [&_svg]:text-warning",
    danger: "border-danger/25 bg-danger-soft/40 text-foreground [&_svg]:text-danger",
    info: "border-border bg-surface text-muted [&_svg]:text-info",
  };
  return (
    <span
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 sm:px-2.5",
        tones[tone],
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      <span className="sr-only sm:not-sr-only">{children}</span>
    </span>
  );
}

/**
 * The crew phone's sync state, always shown, glyph and words together: nothing waiting, how many
 * items wait on the phone, sending, offline, or what needs a check. "Nothing to send" is said only when
 * the outbox holds nothing unsent; the server's verification is what empties it.
 */
function CrewSyncState({
  online,
  signedIn,
  pending,
  uploading,
  needsAttention,
  unclaimed,
  readState,
}: {
  online: boolean;
  signedIn: boolean;
  pending: number;
  uploading: number;
  needsAttention: number;
  unclaimed: number;
  readState: OutboxReadState;
}) {
  // Pending already includes the records currently uploading.
  const waiting = pending;
  const state =
    readState !== "ready"
      ? readState === "error"
        ? "unavailable"
        : "checking"
      : !online
        ? "offline"
        : needsAttention > 0 || unclaimed > 0
          ? "attention"
          : uploading > 0
            ? "sending"
            : !signedIn
              ? "paused"
              : waiting > 0
                ? "waiting"
                : "clear";
  const tone = {
    checking: "bg-surface text-muted",
    unavailable: "bg-warning-soft text-warning",
    offline: "bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--warning-line)]",
    attention: "bg-danger-soft text-danger shadow-[inset_0_0_0_1px_var(--danger-line)]",
    sending: "bg-info-soft text-info",
    paused: "bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--warning-line)]",
    waiting: "bg-local-soft text-local",
    clear: "bg-surface text-muted shadow-[inset_0_0_0_1px_var(--border)] [&>svg]:text-ok",
  }[state];
  const Icon = {
    checking: RefreshCw,
    unavailable: ShieldAlert,
    offline: CloudOff,
    attention: ShieldAlert,
    sending: RefreshCw,
    paused: CloudOff,
    waiting: Smartphone,
    clear: Check,
  }[state];
  const [words, detail] =
    state === "checking"
      ? ["Checking saved work", undefined]
      : state === "unavailable"
        ? ["Check saved work", undefined]
        : state === "offline"
          ? ["Offline", waiting > 0 ? `${waiting} on phone` : undefined]
          : state === "attention"
            ? needsAttention > 0
              ? [`${needsAttention} need a check`, undefined]
              : [`${unclaimed} on phone only`, undefined]
            : state === "sending"
              ? [`Sending ${waiting}`, undefined]
              : state === "paused"
                ? ["Sign-in paused", waiting > 0 ? `${waiting} on phone` : undefined]
                : state === "waiting"
                  ? [`${waiting} to send`, undefined]
                  : ["Nothing to send", undefined];

  return (
    <p
      role="status"
      aria-label={detail ? `Sync: ${words}, ${detail}` : `Sync: ${words}`}
      data-state={state}
      className={cn(
        "crew-sync inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2 text-[0.8125rem] leading-tight font-semibold whitespace-nowrap",
        tone,
      )}
    >
      <Icon
        className={cn("size-[0.9375rem] shrink-0", state === "sending" && "animate-spin")}
        aria-hidden="true"
      />
      <span className="flex flex-col">
        <span>{words}</span>
        {detail ? <span className="text-xs font-medium">{detail}</span> : null}
      </span>
    </p>
  );
}
