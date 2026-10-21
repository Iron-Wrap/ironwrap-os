import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Laptop,
  QrCode,
  Share2,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { CapabilityUnavailable } from "../capabilities/capability-unavailable";
import { capabilityPreventsUse, useCapability } from "../capabilities/capability-signal";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { messageFor, messageForLoad, type PlainErrorCopy } from "../lib/plain-error";
import {
  issueDevicePairing,
  issueHermesDesktopPairing,
  listDevicePairings,
  listFieldUsers,
  revokeDevicePairing,
} from "./pairing-api";
import type {
  DevicePairing,
  IssuedDevicePairing,
  IssuedHermesDesktopPairing,
} from "./pairing-contracts";
import {
  formatDateTime,
  pairingExpiryLabel,
  safeHermesDesktopPairingUrl,
  safePairingUrl,
} from "./pairing-link";

export function DevicePairingSettings() {
  return (
    <RoleGuard surface="pairing">
      <OfficeDevicePairingSettings />
    </RoleGuard>
  );
}

function OfficeDevicePairingSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = !isOfflineSession(session);
  // Before this read the desktop pairing button was live whatever the flag said, and a crew lead
  // learned the pilot was switched off from a generic error after the tap (ELEC-232 audit).
  const hermesDesktop = useCapability("hermes_desktop");
  const hermesDesktopUnusable = capabilityPreventsUse(hermesDesktop);
  const fieldUsers = useQuery({
    queryKey: ["field-users", session.tenant.id],
    queryFn: () => listFieldUsers(session),
    enabled: canManage,
  });
  const devices = useQuery({
    queryKey: ["device-pairings", session.tenant.id],
    queryFn: () => listDevicePairings(session),
    enabled: canManage,
  });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [issued, setIssued] = useState<IssuedDevicePairing>();
  const [desktopIssued, setDesktopIssued] = useState<IssuedHermesDesktopPairing>();
  const [desktopIssueError, setDesktopIssueError] = useState<unknown>();
  const [desktopIssuing, setDesktopIssuing] = useState(false);
  const [issueError, setIssueError] = useState<unknown>();
  const [issuing, setIssuing] = useState(false);
  const [confirmingDeviceId, setConfirmingDeviceId] = useState<string>();
  const [revokeError, setRevokeError] = useState<unknown>();
  const [revokingDeviceId, setRevokingDeviceId] = useState<string>();

  async function issue() {
    const fieldUserId = selectedUserId || fieldUsers.data?.users[0]?.id;
    if (!fieldUserId || issuing) return;
    setIssuing(true);
    setIssueError(undefined);
    try {
      const next = await issueDevicePairing(session, fieldUserId);
      setIssued(next);
    } catch (error) {
      setIssueError(error);
    } finally {
      setIssuing(false);
    }
  }

  async function issueDesktop() {
    if (desktopIssuing) return;
    setDesktopIssuing(true);
    setDesktopIssueError(undefined);
    try {
      setDesktopIssued(await issueHermesDesktopPairing(session));
    } catch (error) {
      setDesktopIssueError(error);
    } finally {
      setDesktopIssuing(false);
    }
  }

  async function revoke(device: DevicePairing) {
    if (revokingDeviceId) return;
    setRevokingDeviceId(device.id);
    setRevokeError(undefined);
    try {
      await revokeDevicePairing(session, device.id);
      setConfirmingDeviceId(undefined);
      await queryClient.invalidateQueries({ queryKey: ["device-pairings", session.tenant.id] });
    } catch (error) {
      setRevokeError(error);
    } finally {
      setRevokingDeviceId(undefined);
    }
  }

  if (!canManage) {
    return (
      <ErrorState
        title="Reconnect before managing devices"
        message="Pairing or removing a crew phone needs you signed in to the office. Work already saved on a phone stays on that phone."
      />
    );
  }
  if (fieldUsers.isPending || devices.isPending) {
    return <LoadingState label="Loading crew phones…" />;
  }
  if (fieldUsers.isError || devices.isError) {
    return (
      <ErrorState
        title="Crew phones could not load"
        message={messageForLoad(fieldUsers.error ?? devices.error)}
        error={fieldUsers.error ?? devices.error}
        onRetry={() => {
          void fieldUsers.refetch();
          void devices.refetch();
        }}
      />
    );
  }

  const activeUserId = selectedUserId || fieldUsers.data.users[0]?.id || "";
  const selectedUser = fieldUsers.data.users.find((user) => user.id === activeUserId);
  const pairingUrl = issued ? safePairingUrl(issued.pairing_url) : undefined;
  const desktopPairingUrl = desktopIssued
    ? safeHermesDesktopPairingUrl(desktopIssued.pairing_url)
    : undefined;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header className="max-w-3xl">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-muted text-foreground">
          <Smartphone className="size-6" aria-hidden="true" />
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">Crew phones</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">
          Pair one field browser under supervision. The code is short-lived, device-bound, and never
          needs a password on the roof.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Laptop aria-hidden="true" />
            Hermes desktop text pilot
          </CardTitle>
          <CardDescription>
            Issue a one-time link for this signed-in owner or operations account. The dedicated
            desktop MCP consumes it without receiving admin, write, or connector credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {desktopIssueError ? (
            <InlineError message={messageFor(desktopIssueError, pairingRefusals)} />
          ) : null}
          <CapabilityUnavailable read={hermesDesktop} />
          {/*
            Disabled, never relabelled or hidden: a screen-reader user has to keep hearing WHAT is
            unavailable, and the panel immediately before it in DOM order supplies WHY. The button
            also keeps its full height while disabled, so switching the pilot on does not move it.
          */}
          <Button
            type="button"
            variant="outline"
            busy={desktopIssuing}
            disabled={hermesDesktopUnusable}
            onClick={() => void issueDesktop()}
          >
            <Laptop aria-hidden="true" />
            Issue desktop pairing link
          </Button>
          {desktopIssued ? (
            desktopPairingUrl ? (
              <>
                <p className="text-sm font-bold text-warning">
                  {pairingExpiryLabel(desktopIssued.expires_at)} Paste the bootstrap prompt into the
                  desktop AI client once, complete pairing, then discard it.
                </p>
                <label
                  className="block text-sm font-bold"
                  htmlFor="hermes-desktop-bootstrap-prompt"
                >
                  Self-configuring Hermes bootstrap prompt
                </label>
                <Textarea
                  id="hermes-desktop-bootstrap-prompt"
                  className="min-h-48 bg-surface-muted px-3 py-3 font-mono text-xs"
                  readOnly
                  value={desktopIssued.bootstrap_prompt}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <p className="text-xs text-muted">
                  Bound API audience: <code>{desktopIssued.api_audience}</code>
                </p>
                <label className="block text-sm font-bold" htmlFor="hermes-desktop-pairing-link">
                  One-time Hermes desktop pairing link
                </label>
                <Input
                  id="hermes-desktop-pairing-link"
                  className="min-h-14 bg-surface-muted font-mono text-xs"
                  readOnly
                  value={desktopPairingUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </>
            ) : (
              <InlineError message="The server returned an unsafe desktop pairing link. Discard it and check the configured app origin." />
            )
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode aria-hidden="true" />
            Issue pairing code
          </CardTitle>
          <CardDescription>
            Choose the active crew account, then scan or share the one-time code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {fieldUsers.data.users.length === 0 ? (
            <EmptyState
              title="No crew accounts yet"
              message="Add someone with the crew role on the People page before you pair a phone."
            />
          ) : (
            <>
              <label className="block font-bold" htmlFor="field-user">
                Active field user
              </label>
              <Select
                field
                id="field-user"
                className="bg-surface font-bold"
                value={activeUserId}
                onChange={(event) => {
                  setSelectedUserId(event.target.value);
                  setIssued(undefined);
                  setIssueError(undefined);
                }}
              >
                {fieldUsers.data.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.display_name} · {user.email}
                  </option>
                ))}
              </Select>
              {selectedUser?.frappe_user_id ? (
                <p className="text-sm text-muted">
                  Linked operating user: {selectedUser.frappe_user_id}
                </p>
              ) : null}
              {issueError ? (
                <InlineError message={messageFor(issueError, pairingRefusals)} />
              ) : null}
              <Button
                type="button"
                variant="accent"
                size="field"
                fullWidth
                busy={issuing}
                disabled={!activeUserId}
                onClick={() => void issue()}
              >
                <QrCode aria-hidden="true" />
                Issue one-time QR code
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {issued ? (
        pairingUrl ? (
          <IssuedPairingCard pairing={issued} pairingUrl={pairingUrl} />
        ) : (
          <ErrorState
            title="The pairing link was not safe to share"
            message="The server response did not contain the expected same-origin fragment link. Do not share it. Issue a fresh code after the connection is checked."
          />
        )
      ) : null}

      <DeviceList
        devices={devices.data.devices}
        confirmingDeviceId={confirmingDeviceId}
        revokingDeviceId={revokingDeviceId}
        revokeError={revokeError}
        onAskRevoke={setConfirmingDeviceId}
        onCancelRevoke={() => {
          setConfirmingDeviceId(undefined);
          setRevokeError(undefined);
        }}
        onConfirmRevoke={(device) => void revoke(device)}
      />
    </section>
  );
}

function IssuedPairingCard({
  pairing,
  pairingUrl,
}: {
  pairing: IssuedDevicePairing;
  pairingUrl: string;
}) {
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = Date.parse(pairing.expires_at);
  const expired = !Number.isFinite(expiresAt) || expiresAt <= now;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  async function copyLink() {
    if (!navigator.clipboard?.writeText) {
      setNotice("Select the pairing link below and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setNotice("Pairing link copied. It expires soon.");
    } catch {
      setNotice("Copy was blocked. Select the pairing link below and copy it manually.");
    }
  }

  async function shareLink() {
    const share = getShareFunction();
    if (!share) return;
    try {
      await share({
        title: "IronWrap OS device pairing",
        text: `Pair ${pairing.field_user.display_name}'s phone before the code expires.`,
        url: pairingUrl,
      });
      setNotice("Pairing link shared.");
    } catch {
      // The platform reports cancellation as a rejected share. It is not an application failure.
    }
  }

  return (
    <Card className="border-accent/40">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="text-ok" aria-hidden="true" />
              Pair {pairing.field_user.display_name}'s device
            </CardTitle>
            <CardDescription className="mt-2 flex items-center gap-2 text-warning">
              <Clock3 aria-hidden="true" />
              {pairingExpiryLabel(pairing.expires_at, now)}
            </CardDescription>
          </div>
          <span className="rounded-full bg-warning-soft px-3 py-1 text-xs font-bold text-warning">
            One-time code
          </span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-center">
        <div className="space-y-4">
          {expired ? (
            <p
              className="rounded-lg border border-warning/30 bg-warning-soft p-4 font-bold text-warning"
              role="status"
            >
              This pairing code has expired. Issue a new code before handing the device to the crew.
            </p>
          ) : (
            <>
              <p className="leading-7 text-muted">
                On the crew phone, open the camera and scan this code. The app creates its private
                device credential locally, then opens Today after the office pairing is verified.
              </p>
              <p className="text-sm font-bold text-warning">
                Pairing expiry: {formatDateTime(pairing.expires_at)}. Do not photograph or save this
                code after use.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button type="button" variant="outline" onClick={() => void copyLink()}>
                  <ClipboardCopy aria-hidden="true" />
                  Copy pairing link
                </Button>
                {getShareFunction() ? (
                  <Button type="button" variant="outline" onClick={() => void shareLink()}>
                    <Share2 aria-hidden="true" />
                    Share link
                  </Button>
                ) : null}
              </div>
              <label className="block text-sm font-bold" htmlFor="pairing-link">
                No camera? Copy or open this one-time link on the crew phone.
              </label>
              <Input
                id="pairing-link"
                className="min-h-14 bg-surface-muted font-mono text-xs"
                readOnly
                value={pairingUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              {notice ? (
                <p className="text-sm font-bold text-info" role="status">
                  {notice}
                </p>
              ) : null}
            </>
          )}
        </div>
        {!expired ? (
          <div
            className="mx-auto rounded-xl border bg-white p-4 shadow-inner"
            role="img"
            aria-label="One-time crew phone pairing QR code"
          >
            <QRCodeSVG value={pairingUrl} size={208} level="M" includeMargin />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeviceList({
  devices,
  confirmingDeviceId,
  revokingDeviceId,
  revokeError,
  onAskRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  devices: DevicePairing[];
  confirmingDeviceId?: string;
  revokingDeviceId?: string;
  revokeError: unknown;
  onAskRevoke: (deviceId: string) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: (device: DevicePairing) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone aria-hidden="true" />
          Active and revoked devices
        </CardTitle>
        <CardDescription>
          Revoke a lost device explicitly. It cannot sync again until the office issues a fresh
          pairing code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devices.length === 0 ? (
          <EmptyState
            title="No crew phones paired yet"
            message="Issued codes become devices only after the crew phone completes pairing."
          />
        ) : (
          devices.map((device) => {
            const revoked = Boolean(device.revoked_at);
            const confirming = confirmingDeviceId === device.id;
            return (
              <div key={device.id} className="rounded-lg border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-bold">{device.field_user_name}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">{device.id}</p>
                    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                      <DeviceFact label="Paired" value={formatDateTime(device.paired_at)} />
                      <DeviceFact
                        label="Last seen"
                        value={
                          device.last_seen_at ? formatDateTime(device.last_seen_at) : "Not recorded"
                        }
                      />
                      {revoked ? (
                        <DeviceFact label="Revoked" value={formatDateTime(device.revoked_at!)} />
                      ) : null}
                      {device.revoked_by ? (
                        <DeviceFact label="Revoked by" value={device.revoked_by} />
                      ) : null}
                    </dl>
                  </div>
                  <span
                    className={
                      revoked
                        ? "rounded-full bg-surface-muted px-3 py-1 text-xs font-bold text-muted"
                        : "rounded-full bg-ok-soft px-3 py-1 text-xs font-bold text-ok"
                    }
                  >
                    {revoked ? "Revoked" : "Active"}
                  </span>
                </div>
                {!revoked && !confirming ? (
                  <Button
                    type="button"
                    className="mt-4"
                    size="compact"
                    variant="danger"
                    onClick={() => onAskRevoke(device.id)}
                  >
                    <ShieldOff aria-hidden="true" />
                    Revoke lost device
                  </Button>
                ) : null}
                {confirming ? (
                  <div
                    className="mt-4 rounded-lg border border-danger/30 bg-danger-soft p-4"
                    role="alert"
                  >
                    <p className="font-bold text-danger">Revoke this device now?</p>
                    <p className="mt-1 text-sm leading-6 text-danger">
                      {device.field_user_name} will need a new supervised pairing before this
                      browser can use the crew phone app again.
                    </p>
                    {revokeError ? (
                      <InlineError message={messageFor(revokeError, pairingRefusals)} />
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="compact"
                        variant="danger"
                        busy={revokingDeviceId === device.id}
                        onClick={() => onConfirmRevoke(device)}
                      >
                        Confirm revoke
                      </Button>
                      <Button
                        type="button"
                        size="compact"
                        variant="outline"
                        onClick={onCancelRevoke}
                      >
                        Keep device active
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function DeviceFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 font-bold">{value}</dd>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="mt-3 rounded-lg bg-danger-soft p-3 text-sm font-bold text-danger" role="alert">
      {message}
    </p>
  );
}

/** The pairing routes' own refusals, and what an owner or operations lead does about the rest. */
const pairingRefusals: PlainErrorCopy = {
  byCode: {
    field_user_not_found:
      "This crew member is no longer on the list. Reload the page and pick them again.",
    device_not_found_or_revoked:
      "This phone was already removed. Reload the page to see the current list.",
  },
  refused:
    "IronWrap OS did not accept this, and nothing was changed. Reload the page to see the current list.",
  fallback:
    "We could not confirm this went through. Reload the page to see the current list before you try again.",
};

function getShareFunction(): ((data: ShareData) => Promise<void>) | undefined {
  const capability = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  return typeof capability.share === "function" ? capability.share.bind(navigator) : undefined;
}
