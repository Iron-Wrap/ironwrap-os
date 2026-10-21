import { BadgeCheck, ClipboardList, FileCheck2, Hammer, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { takeMagicLinkTokenFromWindow } from "../auth/magic-link-fragment";
import { officeSessionIsLive } from "../auth/session";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { useCustomerScope } from "../lib/theme";
import { describeInstallWindow } from "./install-window";
import { MaterialComparisonSection } from "./material-comparison-section";
import { loadCustomerPortal, requestCustomerContractAcceptanceChallenge } from "./portal-api";
import type { CustomerPortalResponse } from "./portal-contracts";

type PortalState =
  { kind: "loading" } | { kind: "ready"; model: CustomerPortalResponse } | { kind: "error" };

export function CustomerPortalPage() {
  const scope = useCustomerScope();
  // Reuse the existing fragment scrubber: the token is never a route parameter, query key, or
  // persisted browser value. It remains only in this component while the fixed-path request runs.
  const [token] = useState(() => takeMagicLinkTokenFromWindow());
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PortalState>(token ? { kind: "loading" } : { kind: "error" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    // Staff opening a customer's link from a signed-in browser preview it; the first open the
    // server records stays the customer's own.
    void officeSessionIsLive()
      .catch(() => false)
      .then((staffPreview) => loadCustomerPortal(token, undefined, staffPreview))
      .then(
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
      <main {...scope} className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title="This project link no longer works"
          message="Ask your project team for a new private link."
          onRetry={token ? retry : undefined}
        />
      </main>
    );
  }
  if (state.kind === "loading") {
    return (
      <main {...scope} className="grid min-h-dvh place-items-center p-4">
        <LoadingState label="Opening your private project page…" />
      </main>
    );
  }
  return <CustomerPortalView model={state.model} portalToken={token} />;
}

export function CustomerPortalView({
  model,
  portalToken,
}: {
  model: CustomerPortalResponse;
  portalToken?: string;
}) {
  const scope = useCustomerScope();
  const quote = model.proposal?.quote;
  return (
    <main {...scope} className="min-h-dvh bg-background px-4 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="border-b border-border pb-4">
          <p className="text-sm font-bold text-muted">{model.brand}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">Your project</h1>
          <p className="mt-2 text-base leading-6 text-muted">
            {model.job.job_number ? (
              <span className="font-mono">{model.job.job_number} · </span>
            ) : null}
            {model.job.service_type ?? "Project"}
            {model.job.status ? ` · ${model.job.status}` : ""}
          </p>
        </header>

        <ProjectOverview model={model} />
        {quote || model.proposal ? <ProposalCard model={model} portalToken={portalToken} /> : null}
        <ScopeCard model={model} />
        {/* Materials sit below the published scope and above progress: what the project will be
            made of is decided after the scope is agreed and before any of it gets built. Silent
            until the office approves at least one Option Package. */}
        {model.option_packages.length > 0 ? (
          <MaterialComparisonSection model={model} portalToken={portalToken} />
        ) : null}
        <ProgressCard model={model} />
        {model.closeout || model.warranty ? <CloseoutCard model={model} /> : null}
      </div>
    </main>
  );
}

function ProjectOverview({ model }: { model: CustomerPortalResponse }) {
  const quote = model.proposal?.quote;
  const hasBalance = quote?.balance_due !== null && quote?.balance_due !== undefined;
  const install = describeInstallWindow(model.install_window);
  const next =
    model.contract_acceptance_available &&
    quote?.status === "Approved" &&
    !model.proposal?.signed_at
      ? {
          title: "Review your proposal",
          detail: "Read the shared terms before requesting the acceptance email.",
          href: "#project-proposal",
        }
      : model.material_decision_available && model.option_packages.length > 0
        ? {
            title: "Choose materials and colours",
            detail: "Compare the choices your project team has shared.",
            href: "#project-materials",
          }
        : model.closeout || model.warranty
          ? {
              title: "Review completion and warranty",
              detail: "Read your shared completion record and coverage.",
              href: "#project-closeout",
            }
          : {
              title: "See project updates",
              detail: "Read the progress your project team has shared below.",
              href: "#project-progress",
            };

  return (
    <section aria-label="Project overview" className="space-y-4 border-b border-border pb-5">
      <dl className="grid gap-5 sm:grid-cols-2">
        <div>
          <dt className="text-base font-semibold text-muted">Installation date</dt>
          <dd className="mt-1">
            {install ? (
              <>
                <p className="text-xl font-bold leading-7">{install.day}</p>
                <p className="mt-1 text-base leading-6">{install.time}</p>
                <p className="mt-1 text-base leading-6 text-muted">
                  {model.brand} booked this time. If it does not work for you, contact them.
                </p>
              </>
            ) : (
              <>
                <p className="text-xl font-bold leading-7">Schedule not yet shared</p>
                <p className="mt-1 text-base leading-6 text-muted">
                  This page does not include a confirmed installation date. Ask your project team
                  for the schedule.
                </p>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-base font-semibold text-muted">Amount due</dt>
          <dd className="mt-1">
            <p className="text-xl font-bold leading-7">
              {hasBalance && quote ? (
                <span className="font-mono">{formatMoney(quote.balance_due!, quote.currency)}</span>
              ) : (
                "Amount not yet shared"
              )}
            </p>
            {hasBalance ? (
              <p className="mt-1 text-base leading-6 text-muted">
                {quote?.payment_due_date
                  ? `Due ${formatDate(quote.payment_due_date)}`
                  : "Payment due date not yet shared."}
              </p>
            ) : (
              <p className="mt-1 text-base leading-6 text-muted">
                {quote ? "Your proposal price is not a bill. " : ""}
                What you owe will appear here when {model.brand} shares it. Ask them if you need it
                sooner.
              </p>
            )}
            {quote?.payment_status ? (
              <p className="mt-1 text-base leading-6">{quote.payment_status}</p>
            ) : null}
          </dd>
        </div>
      </dl>
      <CompanyContact brand={model.brand} contact={model.company_contact} />
      <div className="border-t border-border pt-4">
        <h2 className="text-lg font-bold">Next step</h2>
        <p className="mt-1 text-base leading-6 text-muted">{next.detail}</p>
        <Button
          asChild
          variant="outline"
          className="mt-3 min-h-12 w-full whitespace-normal text-base sm:w-auto"
        >
          <a href={next.href}>{next.title}</a>
        </Button>
      </div>
    </section>
  );
}

function ProposalCard({
  model,
  portalToken,
}: {
  model: CustomerPortalResponse;
  portalToken?: string;
}) {
  const quote = model.proposal?.quote;
  return (
    <Card id="project-proposal">
      <CardHeader>
        <div className="flex items-start gap-3">
          <FileCheck2 className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Project proposal</CardTitle>
            <CardDescription>
              {model.proposal?.status ?? quote?.status ?? "Project terms"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {quote?.total !== null && quote?.total !== undefined ? (
          <p className="text-2xl font-bold tracking-[-0.03em]">
            {formatMoney(quote.total, quote.currency)}
          </p>
        ) : null}
        {quote?.valid_until ? (
          <Detail label="Good until" value={formatDate(quote.valid_until)} />
        ) : null}
        {quote?.payment_status ? (
          <Detail label="Payment status" value={quote.payment_status} />
        ) : null}
        {quote?.balance_due !== null && quote?.balance_due !== undefined ? (
          <Detail label="Amount due" value={formatMoney(quote.balance_due, quote.currency)} />
        ) : null}
        {quote?.scope_summary ? (
          <CopyBlock title="Work summary" value={quote.scope_summary} />
        ) : null}
        {quote?.assumptions ? <CopyBlock title="What we expect" value={quote.assumptions} /> : null}
        {quote?.exclusions ? <CopyBlock title="Not included" value={quote.exclusions} /> : null}
        {portalToken && quote?.status === "Approved" && model.contract_acceptance_available ? (
          <ContractAcceptanceRequest brand={model.brand} portalToken={portalToken} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ContractAcceptanceRequest({ brand, portalToken }: { brand: string; portalToken: string }) {
  const [state, setState] = useState<"idle" | "pending" | "sent" | "error">("idle");

  async function requestChallenge() {
    if (state === "pending" || state === "sent") return;
    setState("pending");
    try {
      await requestCustomerContractAcceptanceChallenge(portalToken);
      setState("sent");
    } catch {
      setState("error");
    }
  }

  return (
    <section className="border-t border-border pt-5" aria-labelledby="contract-acceptance-title">
      <h2 id="contract-acceptance-title" className="font-bold">
        Ready to accept?
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        We will email the address on file. Opening this page does not accept the contract.
      </p>
      {state === "sent" ? (
        <p className="mt-3 text-sm font-semibold text-ok" role="status">
          Email sent. Check the email address on file.
        </p>
      ) : (
        <>
          <Button
            className="mt-4 min-h-12 w-full whitespace-normal text-base sm:w-auto"
            type="button"
            disabled={state === "pending"}
            onClick={requestChallenge}
          >
            {state === "pending" ? "Sending email…" : "Send acceptance email"}
          </Button>
          {state === "error" ? (
            <p className="mt-3 text-sm font-semibold text-danger" role="alert">
              We could not send the email. Try again or call {brand}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ScopeCard({ model }: { model: CustomerPortalResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <ClipboardList className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Work in your plan</CardTitle>
            <CardDescription>This is the work your team shared for this project.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {model.scope.length === 0 ? (
          <p className="text-sm leading-6 text-muted">No work details have been shared yet.</p>
        ) : (
          <ul className="space-y-4">
            {model.scope.map((item) => (
              <li key={item.id} className="border-l-2 border-info/40 pl-4">
                <p className="font-bold">{item.title ?? item.type ?? "Planned work"}</p>
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
    <Card id="project-progress">
      <CardHeader>
        <div className="flex items-start gap-3">
          <Hammer className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Project updates</CardTitle>
            <CardDescription>Only checked updates are shown here.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {model.progress.length === 0 ? (
          <p className="text-sm leading-6 text-muted">No project updates have been shared yet.</p>
        ) : (
          <ol className="space-y-4">
            {model.progress.map((item) => (
              <li key={item.id} className="flex gap-3">
                <BadgeCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
                <div>
                  <p className="font-bold">{item.proof_slot ?? item.type ?? "Checked update"}</p>
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
    <Card id="project-closeout">
      <CardHeader>
        <div className="flex items-start gap-3">
          <Wrench className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Completion and warranty</CardTitle>
            <CardDescription>Your project finish and warranty status.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {model.closeout ? (
          <Detail
            label="Final project record"
            value={
              model.closeout.approved_at
                ? `Approved ${formatDate(model.closeout.approved_at)}`
                : "Approval not yet shared"
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
          <CopyBlock title="Not covered" value={model.warranty.exclusions} />
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
    }).format(value);
  } catch {
    return `${currency ?? "CAD"} ${value.toLocaleString("en-CA")}`;
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    // A date-only payment deadline is a calendar date, not midnight UTC shifted by the phone.
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : undefined,
  }).format(parsed);
}

function CompanyContact({
  brand,
  contact,
}: {
  brand: string;
  contact: CustomerPortalResponse["company_contact"];
}) {
  if (!contact || (!contact.phone && !contact.email)) return null;
  return (
    <div className="space-y-2">
      <p className="text-base font-semibold">Questions about your date or what you owe?</p>
      <div className="flex flex-wrap gap-3">
        {contact.phone ? (
          <Button asChild variant="ghost" className="min-h-12 whitespace-normal text-base">
            <a href={`tel:${contact.phone}`}>Call {brand}</a>
          </Button>
        ) : null}
        {contact.email ? (
          <Button asChild variant="ghost" className="min-h-12 whitespace-normal text-base">
            <a href={`mailto:${contact.email}`}>Email {brand}</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
