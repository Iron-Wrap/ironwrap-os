import { BadgeCheck, ClipboardList, FileCheck2, Hammer, ShieldCheck, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { extractAndScrubMagicLinkToken } from "../auth/magic-link-fragment";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { loadCustomerPortal } from "./portal-api";
import type { CustomerPortalResponse } from "./portal-contracts";

type PortalState =
  { kind: "loading" } | { kind: "ready"; model: CustomerPortalResponse } | { kind: "error" };

export function CustomerPortalPage() {
  // Reuse the existing fragment scrubber: the token is never a route parameter, query key, or
  // persisted browser value. It remains only in this component while the fixed-path request runs.
  const [token] = useState(() => extractAndScrubMagicLinkToken());
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PortalState>(token ? { kind: "loading" } : { kind: "error" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    void loadCustomerPortal(token).then(
      (model) => {
        if (active) setState({ kind: "ready", model });
      },
      () => {
        if (active) setState({ kind: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, token]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  };

  if (!token || state.kind === "error") {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title="This project link is no longer available"
          message="Ask your IronWrap contact for a fresh private project link."
          onRetry={token ? retry : undefined}
        />
      </main>
    );
  }
  if (state.kind === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <LoadingState label="Opening your private project portal…" />
      </main>
    );
  }
  return <CustomerPortalView model={state.model} />;
}

export function CustomerPortalView({ model }: { model: CustomerPortalResponse }) {
  const quote = model.proposal?.quote;
  return (
    <main className="min-h-dvh bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="border-b border-border pb-6">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-muted text-foreground">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </div>
          <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
            {model.brand} project portal
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            {model.job.job_number ?? "Your project"}
          </h1>
          <p className="mt-3 text-base leading-7 text-muted">
            {model.job.service_type ?? "Project"}
            {model.job.status ? ` · ${model.job.status}` : ""}
          </p>
        </header>

        {quote || model.proposal ? <ProposalCard model={model} /> : null}
        <ScopeCard model={model} />
        <ProgressCard model={model} />
        {model.closeout || model.warranty ? <CloseoutCard model={model} /> : null}
      </div>
    </main>
  );
}

function ProposalCard({ model }: { model: CustomerPortalResponse }) {
  const quote = model.proposal?.quote;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <FileCheck2 className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Approved proposal</CardTitle>
            <CardDescription>
              {model.proposal?.status ?? quote?.status ?? "Published project terms"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {quote?.total !== null && quote?.total !== undefined ? (
          <p className="text-2xl font-black tracking-[-0.03em]">
            {formatMoney(quote.total, quote.currency)}
          </p>
        ) : null}
        {quote?.valid_until ? (
          <Detail label="Valid until" value={formatDate(quote.valid_until)} />
        ) : null}
        {quote?.payment_status ? (
          <Detail label="Payment status" value={quote.payment_status} />
        ) : null}
        {quote?.balance_due !== null && quote?.balance_due !== undefined ? (
          <Detail label="Balance due" value={formatMoney(quote.balance_due, quote.currency)} />
        ) : null}
        {quote?.scope_summary ? (
          <CopyBlock title="Scope summary" value={quote.scope_summary} />
        ) : null}
        {quote?.assumptions ? <CopyBlock title="Assumptions" value={quote.assumptions} /> : null}
        {quote?.exclusions ? <CopyBlock title="Exclusions" value={quote.exclusions} /> : null}
      </CardContent>
    </Card>
  );
}

function ScopeCard({ model }: { model: CustomerPortalResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <ClipboardList className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Approved scope</CardTitle>
            <CardDescription>
              Only clauses your team has published for this project appear here.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {model.scope.length === 0 ? (
          <p className="text-sm leading-6 text-muted">
            No customer-facing scope clauses have been published yet.
          </p>
        ) : (
          <ul className="space-y-4">
            {model.scope.map((item) => (
              <li key={item.id} className="border-l-2 border-info/40 pl-4">
                <p className="font-bold">{item.title ?? item.type ?? "Approved scope"}</p>
                {item.text ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">
                    {item.text}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProgressCard({ model }: { model: CustomerPortalResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Hammer className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Verified progress</CardTitle>
            <CardDescription>
              Only customer-safe, verified project updates are listed.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {model.progress.length === 0 ? (
          <p className="text-sm leading-6 text-muted">
            No customer-safe progress updates have been published yet.
          </p>
        ) : (
          <ol className="space-y-4">
            {model.progress.map((item) => (
              <li key={item.id} className="flex gap-3">
                <BadgeCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
                <div>
                  <p className="font-bold">{item.proof_slot ?? item.type ?? "Verified update"}</p>
                  {item.summary ? (
                    <p className="mt-1 text-sm leading-6 text-muted">{item.summary}</p>
                  ) : null}
                  {item.captured_at ? (
                    <p className="mt-1 text-xs font-semibold text-muted">
                      {formatDate(item.captured_at)}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function CloseoutCard({ model }: { model: CustomerPortalResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Wrench className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Completion and warranty</CardTitle>
            <CardDescription>Published closeout status for this project.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {model.closeout ? (
          <Detail
            label="Completion packet"
            value={
              model.closeout.approved_at
                ? `Approved ${formatDate(model.closeout.approved_at)}`
                : "Approved"
            }
          />
        ) : null}
        {model.closeout?.warranty_ready ? <Detail label="Warranty" value="Ready" /> : null}
        {model.warranty?.material_system ? (
          <Detail label="Material system" value={model.warranty.material_system} />
        ) : null}
        {model.warranty?.coverage_start ? (
          <Detail label="Coverage starts" value={formatDate(model.warranty.coverage_start)} />
        ) : null}
        {model.warranty?.coverage_years !== null && model.warranty?.coverage_years !== undefined ? (
          <Detail label="Coverage" value={`${model.warranty.coverage_years} years`} />
        ) : null}
        {model.warranty?.terms ? (
          <CopyBlock title="Warranty terms" value={model.warranty.terms} />
        ) : null}
        {model.warranty?.exclusions ? (
          <CopyBlock title="Warranty exclusions" value={model.warranty.exclusions} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-sm leading-6">
      <span className="font-bold">{label}: </span>
      {value}
    </p>
  );
}

function CopyBlock({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{value}</p>
    </div>
  );
}

function formatMoney(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency ?? "CAD",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency ?? "CAD"} ${value.toLocaleString("en-CA")}`;
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(parsed);
}
