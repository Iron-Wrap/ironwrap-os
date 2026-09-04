import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { loadOperatingIntake } from "./operating-intake-api";
import type { OperatingIntakeLead } from "./operating-intake-contracts";

const INTAKE_PREVIEW_LIMIT = 3;

export function OperatingIntakePanel(): JSX.Element | null {
  const session = useSession();
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const query = useQuery({
    queryKey: ["operating-intake", session.tenant.id, session.user.id],
    queryFn: () => loadOperatingIntake(),
    enabled: ready,
  });

  if (!ready || (!query.data && query.isPending)) return null;

  if (!query.data && query.isError) {
    return (
      <Card className="border-warning/35 bg-warning-soft p-5 sm:p-6" role="status">
        <p className="font-bold">Website intake could not load</p>
        <p className="mt-1 text-sm leading-6 text-muted">
          Assigned work and money records were not changed. Try again.
        </p>
      </Card>
    );
  }

  const model = query.data;
  if (!model) return null;
  const visibleLeads = expanded ? model.leads : model.leads.slice(0, INTAKE_PREVIEW_LIMIT);
  const remaining = model.leads.length - INTAKE_PREVIEW_LIMIT;

  return (
    <section aria-labelledby="operating-intake-heading">
      <Card className="p-5 sm:p-6">
        <header className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-muted">
            <Inbox className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="operating-intake-heading" className="text-xl font-bold tracking-[-0.025em]">
              Website intake
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              These are website leads saved from the website. They are not assigned field jobs, not
              published portal proposals, and not money intents.
            </p>
          </div>
        </header>
        {model.leads.length === 0 ? (
          <p className="mt-5 text-sm leading-6 text-muted">
            No website intake leads for this tenant.
          </p>
        ) : (
          <ul
            id="operating-intake-leads"
            className="mt-5 divide-y divide-border"
            aria-label="Website intake leads"
          >
            {visibleLeads.map((lead) => (
              <IntakeLeadRow key={lead.envelope_id} lead={lead} />
            ))}
          </ul>
        )}
        {remaining > 0 ? (
          <footer className="mt-4 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              size="compact"
              aria-controls="operating-intake-leads"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show fewer" : `Show ${remaining} more`}
            </Button>
          </footer>
        ) : null}
      </Card>
    </section>
  );
}

function IntakeLeadRow({ lead }: { lead: OperatingIntakeLead }): JSX.Element {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <p className="font-bold tracking-[-0.02em]">{lead.contact_name ?? "Name not recorded"}</p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-bold text-muted">Intake status</dt>
          <dd className="mt-1 font-semibold">Intake</dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-muted">Source</dt>
          <dd className="mt-1 font-semibold">{lead.source}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-muted">Phone</dt>
          <dd className="mt-1 font-semibold">{lead.contact_phone ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-muted">Email</dt>
          <dd className="mt-1 break-all font-semibold">{lead.contact_email ?? "Not recorded"}</dd>
        </div>
      </dl>
    </li>
  );
}
