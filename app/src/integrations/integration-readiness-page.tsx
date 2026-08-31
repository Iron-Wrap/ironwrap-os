import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  PlugZap,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { useSession } from "../auth/session-context";
import {
  capabilityStateLabels,
  CAPABILITY_AVAILABLE_CAVEAT,
  capabilityCopy,
} from "../capabilities/capability-copy";
import { presentableCapabilities } from "../capabilities/capability-contracts";
import { useCapabilitySignal } from "../capabilities/capability-signal";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadIntegrationReadiness } from "./integration-readiness-api";
import type {
  IntegrationCapability,
  IntegrationReadinessResponse,
} from "./integration-readiness-contracts";

export function IntegrationReadinessPage() {
  return (
    <RoleGuard surface="owner">
      <IntegrationReadinessContent />
    </RoleGuard>
  );
}

function IntegrationReadinessContent() {
  const session = useSession();
  const query = useQuery({
    queryKey: ["integration-readiness", session.tenant.id, "reference_journey"],
    queryFn: () => loadIntegrationReadiness(),
    staleTime: 30_000,
  });

  if (!query.data && query.isPending)
    return <LoadingState label="Checking integrations and proof…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Integration readiness could not load"
        message="No readiness claim was made. Check the connection and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Checking integrations and proof…" />;

  return (
    <ReadinessScreen
      model={query.data}
      refreshFailed={query.isError}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
    />
  );
}

function ReadinessScreen({
  model,
  refreshFailed,
  refreshing,
  onRefresh,
}: {
  model: IntegrationReadinessResponse;
  refreshFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  // An integration somebody deliberately switched off is not an incident and must not sit in the
  // "N of M ready" arithmetic as though it were one. This page's own nav entry already promises
  // "proven, blocked, expired, or safely disabled"; until now the fourth was rendered as the
  // second (ELEC-234 §6.9).
  const required = model.capabilities.filter(
    (capability) => capability.required && !safelyDisabled(capability),
  );
  const disabled = model.capabilities.filter(safelyDisabled);
  const ready = required.filter((capability) => capability.state === "ready").length;
  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <PlugZap className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                    Integration readiness
                  </h1>
                  <StateLabel ready={model.verdict === "ready"} />
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  One evidence-backed view of the rails needed for a complete reference journey.
                  This page can inspect configuration and proof; it cannot change either.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Required capabilities</p>
            <p className="mt-2 text-2xl font-black tracking-[-0.03em]">
              {ready} of {required.length} ready
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Profile v{model.profile.version ?? "Not reported"}
            </p>
            {disabled.length > 0 ? (
              <p className="mt-2 text-sm leading-6 text-muted">
                {disabled.length} deliberately switched off, and not counted above.
              </p>
            ) : null}
            <p className="mt-2 text-sm leading-6 text-muted">
              Live signals are required where the repository has a runtime probe; evidence-only
              rails use fresh recorded readback proof.
            </p>
            <Button
              size="compact"
              variant="outline"
              className="mt-4"
              busy={refreshing}
              onClick={onRefresh}
              aria-label="Refresh integration readiness"
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </header>
      </Card>

      {refreshFailed ? (
        <Notice tone="warning" title="The latest check failed">
          The previous verified view remains visible. Refresh again before relying on it.
        </Notice>
      ) : null}

      {model.verdict === "ready" ? (
        <Notice tone="success" title="Reference journey is ready">
          Every required capability has a current approved manifest, fresh recorded readback fact,
          safe fallback, and dependency proof. This repository slice does not yet authenticate the
          external issuer of those facts.
        </Notice>
      ) : (
        <Notice tone="danger" title="Reference journey is blocked">
          At least one required rail has missing, stale, contradictory, or drifted evidence. The
          safe fallback remains in force.
        </Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Capability proof</CardTitle>
          <CardDescription>
            Optional rails are visible only when a profile includes them, and never block unless
            that profile marks them required.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {model.capabilities.map((capability) => (
            <CapabilityCard key={capability.id} capability={capability} />
          ))}
        </CardContent>
      </Card>

      <CapabilityAvailability />

      <Notice tone="info" title="Read-only control surface">
        Configuration changes stay unavailable until a separately governed authority and rollback
        path exists. There is no generic hook or integration CRUD endpoint behind this screen.
      </Notice>
    </section>
  );
}

/**
 * Deliberately switched off, and nothing else wrong with it.
 *
 * Only when `manifest_disabled` is the ONLY blocker. A rail that is both switched off and has
 * expired proof still has a real problem to show, so it stays blocked.
 */
function safelyDisabled(capability: IntegrationCapability): boolean {
  return (
    capability.state === "blocked" &&
    capability.blockers.length === 1 &&
    (capability.blockers[0] ?? "").split(":", 1)[0] === "manifest_disabled"
  );
}

function CapabilityCard({ capability }: { capability: IntegrationCapability }) {
  const ready = capability.state === "ready";
  const disabled = safelyDisabled(capability);
  const stateWord = ready ? "ready" : disabled ? "safely disabled" : "blocked";
  return (
    <article
      className={cn(
        "rounded-lg border p-4",
        ready
          ? "border-ok/30 bg-ok-soft/55"
          : disabled
            ? "border-border/80 bg-surface-muted/55"
            : "border-warning/35 bg-warning-soft/55",
      )}
      aria-label={`${label(capability.id)} ${stateWord}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-extrabold">{label(capability.id)}</h3>
          <p className="mt-1 text-xs font-bold text-muted">
            {capability.required ? "Required" : "Optional"}
            {disabled ? " · Turned off on purpose" : ""}
          </p>
        </div>
        {ready ? (
          <CheckCircle2 className="size-5 shrink-0 text-ok" aria-label="Ready" />
        ) : disabled ? (
          <CircleOff className="size-5 shrink-0 text-muted" aria-label="Safely disabled" />
        ) : (
          <AlertTriangle className="size-5 shrink-0 text-warning" aria-label="Blocked" />
        )}
      </div>
      {capability.manifest ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          {capability.manifest.provider} · manifest v{capability.manifest.version}
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">No approved manifest</p>
      )}
      {capability.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm leading-5 text-foreground">
          {capability.blockers.map((blocker) => (
            <li key={blocker}>• {blockerLabel(blocker)}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm font-bold text-ok">Recorded proof passes repository checks</p>
      )}
      {capability.manifest || capability.last_proof_at || capability.proof_expires_at ? (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-current/10 pt-3 text-xs leading-5 text-muted">
          {capability.last_proof_at ? (
            <>
              <dt className="font-bold text-foreground">Last proof</dt>
              <dd>
                <time dateTime={capability.last_proof_at}>
                  {formatProofInstant(capability.last_proof_at)}
                </time>
              </dd>
            </>
          ) : null}
          {capability.proof_expires_at ? (
            <>
              <dt className="font-bold text-foreground">Expires</dt>
              <dd>
                <time dateTime={capability.proof_expires_at}>
                  {formatProofInstant(capability.proof_expires_at)}
                </time>
              </dd>
            </>
          ) : null}
          {capability.manifest ? (
            <>
              <dt className="font-bold text-foreground">Realm</dt>
              <dd className="break-all">{capability.manifest.realm}</dd>
              <dt className="font-bold text-foreground">Source</dt>
              <dd className="break-all">
                <code title={capability.manifest.source_commit}>
                  {capability.manifest.source_repository}@
                  {capability.manifest.source_commit.slice(0, 12)}
                </code>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {capability.fallback ? (
        <p className="mt-3 text-xs leading-5 text-muted">Fallback: {capability.fallback}</p>
      ) : null}
    </article>
  );
}

/**
 * The other question, kept visibly separate.
 *
 * The card grid above answers "has this rail been PROVEN against a provider" from append-only
 * proof rows, and correctly answers `blocked` for everything this company has never proven. That
 * is useless for explaining why a button does nothing, so this section answers the prior, cheaper
 * one: is the capability in the build, is its flag on, is its configuration present
 * (`docs/CAPABILITY-SIGNAL-CONTRACT.md`). The two are never merged into one badge, and the copy
 * says which is which — a reachable capability can still be unproven, and both statements are
 * true at the same time.
 */
function CapabilityAvailability() {
  const session = useSession();
  const { model, isPending, isError, offline } = useCapabilitySignal();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capability availability</CardTitle>
        <CardDescription>
          A different question from the proof above: whether each capability is in this build,
          switched on, and set up. {CAPABILITY_AVAILABLE_CAVEAT}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {offline ? (
          <p className="text-sm leading-6 text-muted" role="status">
            This is a saved session, so capability state was not read. IronWrap will not claim a
            capability is on or off from a cached answer.
          </p>
        ) : isPending ? (
          <p className="text-sm leading-6 text-muted" role="status">
            Reading capability state…
          </p>
        ) : isError || !model ? (
          <p className="text-sm leading-6 text-muted" role="status">
            Capability state could not be read on this load. Nothing here is being reported as
            switched off — IronWrap simply does not know, and will not guess.
          </p>
        ) : (
          <>
            {model.readback_obligations ? (
              <Notice tone="warning" title="At least one state is not settled">
                One or more capabilities rest on something that has to be read back from the
                deployment before it can be settled. Those are neither working nor broken.
              </Notice>
            ) : null}
            <ul className="grid gap-3 md:grid-cols-2">
              {presentableCapabilities(model).map((capability) => {
                const copy = capabilityCopy(capability, session.user.role);
                return (
                  <li
                    key={capability.id}
                    className={cn(
                      "rounded-lg border p-4",
                      capability.state === "available"
                        ? "border-border/80 bg-surface-muted/45"
                        : capability.state === "off"
                          ? "border-border/80 bg-surface-muted/55"
                          : "border-warning/35 bg-warning-soft/55",
                    )}
                  >
                    <p className="text-sm font-[740] text-muted">
                      {capabilityStateLabels[capability.state]}
                    </p>
                    <h3 className="mt-1 font-extrabold">{capability.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted">
                      {copy ? copy.message : CAPABILITY_AVAILABLE_CAVEAT}
                    </p>
                    {copy ? (
                      <p className="mt-2 text-sm leading-6 text-muted">
                        <span className="font-[740] text-foreground">Next step</span>{" "}
                        {copy.nextAction}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="text-xs leading-5 text-muted">
              Capabilities you cannot reach are not listed. A capability missing from this list is
              one your role does not receive, never one that is switched off.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StateLabel({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold",
        ready ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger",
      )}
    >
      {ready ? (
        <ShieldCheck className="size-3.5" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3.5" aria-hidden="true" />
      )}
      {ready ? "Ready" : "Blocked"}
    </span>
  );
}

function label(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function blockerLabel(value: string): string {
  const [code, detail] = value.split(":", 2);
  const copy: Record<string, string> = {
    manifest_missing: "Approved manifest missing",
    manifest_disabled: "Required integration disabled",
    proof_missing: "Provider proof missing",
    proof_expired: "Provider proof expired",
    proof_timestamp_invalid: "Proof timestamp is invalid",
    proof_observed_in_future: "Proof observation is beyond allowed clock skew",
    provider_identity_unverified: "Provider or sender identity unverified",
    runtime_unready: "Live runtime binding is not ready",
    effect_runtime_unready: "Canonical external-effect ledger is not ready",
    rollback_missing: "Rollback contract missing",
    idempotency_contract_missing: "Idempotency contract missing",
    retry_contract_missing: "Retry contract missing",
    readback_contract_missing: "Readback contract missing",
    reconciliation_contract_missing: "Reconciliation contract missing",
    auth_scope_names_missing: "Mutation authorization scopes missing",
    config_digest_drift: "Tenant configuration changed",
    credential_binding_digest_drift: "Credential binding changed",
    realm_drift: "Provider realm changed",
    route_digest_drift: "Provider route changed",
  };
  const base = copy[code ?? ""] ?? label(code ?? value);
  return detail ? `${base}: ${detail}` : base;
}

function formatProofInstant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Invalid timestamp";
  const canonical = new Date(milliseconds).toISOString();
  return `${canonical.slice(0, 10)} ${canonical.slice(11, 16)} UTC`;
}
