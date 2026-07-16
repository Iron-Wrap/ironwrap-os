import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Copy, KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";
import {
  issueCustomerPortalLink,
  loadCustomerPortalLinks,
  revokeCustomerPortalLink,
} from "./customer-portal-office-api";
import type { CustomerPortalLink } from "./customer-portal-office-contracts";
import { customerPortalExpiryBounds, customerPortalExpiryToIso } from "./customer-portal-expiry";

export function CustomerPortalOfficeAccess({
  roofJobId,
  locale,
}: {
  roofJobId: string;
  locale: string;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const officeRole = session.user.role === "owner" || session.user.role === "ops";
  const [expiresAt, setExpiresAt] = useState("");
  const [issuedPortalUrl, setIssuedPortalUrl] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [revokeCandidate, setRevokeCandidate] = useState<CustomerPortalLink>();
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<"expiry" | "request">();
  const issueInFlight = useRef(false);
  const revokeInFlight = useRef(false);
  const expiryBounds = customerPortalExpiryBounds();
  const queryKey = [
    "customer-portal-links",
    session.tenant.id,
    session.user.id,
    roofJobId,
  ] as const;
  const query = useQuery({
    queryKey,
    enabled: officeRole && !offline && Boolean(roofJobId),
    queryFn: () => loadCustomerPortalLinks(roofJobId),
    retry: false,
  });
  const revoke = useMutation({
    retry: false,
    mutationFn: async (link: CustomerPortalLink) => {
      await revokeCustomerPortalLink(session, link.id);
    },
    onSuccess: async () => {
      setRevokeCandidate(undefined);
      setIssuedPortalUrl(undefined);
      setCopyState("idle");
      await queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      revokeInFlight.current = false;
    },
  });

  const links = (query.data?.links ?? [])
    .filter((link) => link.roof_job_id === roofJobId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const activeLink = links.find(isActiveLink);
  const hasValidExpiry = Boolean(customerPortalExpiryToIso(expiresAt));

  async function copyIssuedLink() {
    if (!issuedPortalUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(issuedPortalUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function submitIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasValidExpiry || issuing || revoke.isPending || offline || issueInFlight.current) return;
    const parsedExpiry = customerPortalExpiryToIso(expiresAt);
    if (!parsedExpiry) {
      setIssueError("expiry");
      return;
    }
    setIssuedPortalUrl(undefined);
    setCopyState("idle");
    setIssueError(undefined);
    issueInFlight.current = true;
    setIssuing(true);
    void issueLink(parsedExpiry);
  }

  function startRevoke(link: CustomerPortalLink) {
    setIssueError(undefined);
    revoke.reset();
    setRevokeCandidate(link);
  }

  function confirmRevoke() {
    if (!revokeCandidate || revoke.isPending || revokeInFlight.current) return;
    revokeInFlight.current = true;
    revoke.mutate(revokeCandidate);
  }

  async function issueLink(expiresAt: string) {
    try {
      const result = await issueCustomerPortalLink(session, { roofJobId, expiresAt });
      setIssuedPortalUrl(result.portal_url);
      setExpiresAt("");
      setCopyState("idle");
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setIssueError("request");
    } finally {
      issueInFlight.current = false;
      setIssuing(false);
    }
  }

  if (!officeRole) return null;

  return (
    <section className="border-y border-border py-6" aria-labelledby="customer-access-heading">
      <div className="px-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <KeyRound className="size-4 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="customer-access-heading" className="text-lg font-bold tracking-[-0.02em]">
              Customer access
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Issue a time-limited project link only when you are ready to share it. The raw link is
              shown once, then cannot be recovered from IronWrap OS.
            </p>
          </div>
        </div>

        {offline ? (
          <AccessNotice tone="warning" title="Customer links are unavailable offline.">
            Reconnect to inspect or change access. No link was issued or revoked from this saved
            session.
          </AccessNotice>
        ) : query.isPending ? (
          <div
            className="mt-5 h-32 animate-pulse border border-border bg-surface-muted/45"
            aria-busy="true"
          />
        ) : query.isError ? (
          <AccessNotice tone="warning" title="Customer access could not be read.">
            No link was changed. Refresh the current access record before issuing a replacement.
            <Button
              type="button"
              variant="outline"
              size="compact"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh access
            </Button>
          </AccessNotice>
        ) : (
          <>
            <AccessLedger links={links} locale={locale} onRevoke={startRevoke} />

            {revokeCandidate ? (
              <AccessNotice tone="danger" title="Revoke this customer link?">
                This ends access immediately. A replacement must be issued deliberately if the
                customer still needs the portal.
                <div className="mt-3 flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="danger"
                    size="compact"
                    busy={revoke.isPending}
                    onClick={confirmRevoke}
                  >
                    <ShieldOff aria-hidden="true" />
                    Revoke link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    disabled={revoke.isPending}
                    onClick={() => setRevokeCandidate(undefined)}
                  >
                    Keep link
                  </Button>
                </div>
              </AccessNotice>
            ) : null}

            {revoke.isError ? (
              <AccessNotice tone="danger" title="The link was not revoked.">
                Reconnect and re-read this access record before trying again.
              </AccessNotice>
            ) : null}

            <form className="mt-5 border-t border-border pt-5" onSubmit={submitIssue}>
              <label htmlFor="customer-portal-expiry" className="text-sm font-bold text-foreground">
                Access expires at
              </label>
              <p id="customer-portal-expiry-help" className="mt-1 text-sm leading-6 text-muted">
                Choose the exact local expiry. Issuing a new link revokes any active link for this
                project.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Input
                  id="customer-portal-expiry"
                  type="datetime-local"
                  required
                  value={expiresAt}
                  min={expiryBounds.min}
                  max={expiryBounds.max}
                  aria-describedby="customer-portal-expiry-help"
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
                <Button
                  type="submit"
                  variant={activeLink ? "outline" : "default"}
                  busy={issuing}
                  disabled={!hasValidExpiry || revoke.isPending}
                >
                  <KeyRound aria-hidden="true" />
                  {activeLink ? "Replace active link" : "Issue customer link"}
                </Button>
              </div>
            </form>

            {issueError ? (
              <AccessNotice
                tone="danger"
                title={
                  issueError === "expiry"
                    ? "Choose a current customer-access expiry."
                    : "The link was not issued."
                }
              >
                {issueError === "expiry"
                  ? "The selected time is no longer within the one-hour to 90-day access window. Choose a new expiry before issuing a link."
                  : "Check the selected expiry, then re-read this project before trying again. No link can be inferred from an incomplete request."}
              </AccessNotice>
            ) : null}

            {issuedPortalUrl ? (
              <div className="mt-5 border border-ok/40 bg-ok-soft/45 p-4" role="status">
                <div className="flex gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-bold text-foreground">Copy the new customer link now.</p>
                    <p className="mt-1 text-sm leading-6 text-muted">
                      This raw bearer link is not saved in the office record or browser history.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                  <Input
                    aria-label="New customer portal link"
                    value={issuedPortalUrl}
                    readOnly
                    className="min-h-11 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    onClick={() => void copyIssuedLink()}
                  >
                    <Copy aria-hidden="true" />
                    {copyState === "copied" ? "Copied" : "Copy link"}
                  </Button>
                </div>
                {copyState === "failed" ? (
                  <p className="mt-2 text-sm font-semibold text-warning">
                    Clipboard access was unavailable. Select and copy the displayed link manually.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function AccessLedger({
  links,
  locale,
  onRevoke,
}: {
  links: CustomerPortalLink[];
  locale: string;
  onRevoke: (link: CustomerPortalLink) => void;
}) {
  if (links.length === 0) {
    return (
      <p className="mt-5 border border-border bg-surface-muted/45 px-4 py-3 text-sm leading-6 text-muted">
        No customer portal link has been issued for this project.
      </p>
    );
  }
  return (
    <ol
      className="mt-5 divide-y divide-border border-y border-border"
      aria-label="Customer access links"
    >
      {links.slice(0, 8).map((link) => {
        const state = linkState(link);
        return (
          <li key={link.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-foreground">
                  <AccessState state={state} />
                  <span>{state === "active" ? "Current customer access" : "Recorded access"}</span>
                </p>
                <dl className="mt-2 grid gap-x-5 gap-y-1 text-sm leading-6 text-muted sm:grid-cols-2">
                  <div>
                    <dt className="sr-only">Issued</dt>
                    <dd>Issued {formatDate(link.created_at, locale)}</dd>
                  </div>
                  <div>
                    <dt className="sr-only">Expiry</dt>
                    <dd>Expires {formatDate(link.expires_at, locale)}</dd>
                  </div>
                  <div>
                    <dt className="sr-only">Use</dt>
                    <dd>
                      {link.access_count === 0 ? "Not opened" : `Opened ${link.access_count} times`}
                    </dd>
                  </div>
                  {link.last_accessed_at ? (
                    <div>
                      <dt className="sr-only">Last opened</dt>
                      <dd>Last opened {formatDate(link.last_accessed_at, locale)}</dd>
                    </div>
                  ) : null}
                  {link.revoked_at ? (
                    <div>
                      <dt className="sr-only">Revoked</dt>
                      <dd>Revoked {formatDate(link.revoked_at, locale)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              {state === "active" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => onRevoke(link)}
                >
                  <ShieldOff aria-hidden="true" />
                  Revoke access
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function AccessState({ state }: { state: "active" | "expired" | "revoked" }) {
  const labels = {
    active: "Active",
    expired: "Expired",
    revoked: "Revoked",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold",
        state === "active" && "bg-ok-soft text-ok",
        state === "expired" && "bg-warning-soft text-warning",
        state === "revoked" && "bg-surface-muted text-muted",
      )}
    >
      {labels[state]}
    </span>
  );
}

function AccessNotice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-5 flex gap-3 border p-4 text-sm leading-6",
        tone === "warning"
          ? "border-warning/40 bg-warning-soft/55"
          : "border-danger/40 bg-danger-soft/55",
      )}
      role="status"
    >
      <CircleAlert
        className={cn(
          "mt-0.5 size-5 shrink-0",
          tone === "warning" ? "text-warning" : "text-danger",
        )}
        aria-hidden="true"
      />
      <div>
        <p className="font-bold text-foreground">{title}</p>
        <div className="mt-1 text-muted">{children}</div>
      </div>
    </div>
  );
}

function isActiveLink(link: CustomerPortalLink): boolean {
  return !link.revoked_at && Date.parse(link.expires_at) > Date.now();
}

function linkState(link: CustomerPortalLink): "active" | "expired" | "revoked" {
  if (link.revoked_at) return "revoked";
  return isActiveLink(link) ? "active" : "expired";
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      date,
    );
  } catch {
    return date.toLocaleString();
  }
}
