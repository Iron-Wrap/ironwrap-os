import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LifeBuoy, PhoneIncoming } from "lucide-react";
import { useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { loadServiceCases, openServiceCase } from "./service-api";
import {
  EMERGENCY_RESPONSE_SLA_CEILING_MINUTES,
  serviceCaseSeverities,
  serviceReportedChannels,
  type ServiceCase,
  type ServiceCaseIntakeInput,
} from "./service-contracts";
import { Notice } from "./service-notice";
import { severityLabel, stateLabel } from "./service-presentation";

/**
 * The callback desk: every live service case in response order, and the intake form that opens a
 * new one. Filing a complaint is a record, not a dispatch -- nothing is scheduled or promised to
 * the customer until the case is triaged and diagnosed.
 */
export function ServiceDeskPage() {
  return (
    <RoleGuard surface="owner">
      <ServiceDeskContent />
    </RoleGuard>
  );
}

function ServiceDeskContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["service-cases", session.tenant.id],
    queryFn: () => loadServiceCases(),
    retry: false,
  });

  const [customerId, setCustomerId] = useState("");
  const [propertyKey, setPropertyKey] = useState("");
  const [roofJobId, setRoofJobId] = useState("");
  const [warrantyPacketId, setWarrantyPacketId] = useState("");
  const [severity, setSeverity] = useState<ServiceCase["severity"]>("standard");
  const [symptomCode, setSymptomCode] = useState("");
  const [reportedChannel, setReportedChannel] = useState<ServiceCase["reported_channel"]>("phone");
  const [consentRef, setConsentRef] = useState("");
  const [intakeEvidenceDigest, setIntakeEvidenceDigest] = useState("");
  const [responseSlaMinutes, setResponseSlaMinutes] = useState("1440");
  const [actionError, setActionError] = useState<string>();
  const [outcome, setOutcome] = useState<"opened" | "duplicate">();

  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: ServiceCaseIntakeInput) => await openServiceCase(session, input),
    onSuccess: async (result) => {
      setActionError(undefined);
      setOutcome(result.result);
      setSymptomCode("");
      setIntakeEvidenceDigest("");
      await queryClient.invalidateQueries({ queryKey: ["service-cases", session.tenant.id] });
    },
    onError: (error) => {
      setOutcome(undefined);
      setActionError(messageFor(error));
    },
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading the callback desk…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="Service desk unavailable"
        message="No callback was opened or changed. Reconnect and re-open the desk before filing a complaint."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const slaMinutes = Number(responseSlaMinutes);
  const emergencyOverrun =
    severity === "emergency" &&
    Number.isFinite(slaMinutes) &&
    slaMinutes > EMERGENCY_RESPONSE_SLA_CEILING_MINUTES;
  const submitDisabled =
    offline ||
    mutation.isPending ||
    emergencyOverrun ||
    !customerId.trim() ||
    !propertyKey.trim() ||
    !roofJobId.trim() ||
    !symptomCode.trim() ||
    !consentRef.trim() ||
    !/^[0-9a-f]{64}$/.test(intakeEvidenceDigest.trim()) ||
    !Number.isInteger(slaMinutes) ||
    slaMinutes < 1;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;
    setActionError(undefined);
    mutation.mutate({
      customerId: customerId.trim(),
      propertyKey: propertyKey.trim(),
      roofJobId: roofJobId.trim(),
      warrantyPacketId: warrantyPacketId.trim() || null,
      severity,
      symptomCode: symptomCode.trim(),
      reportedChannel,
      consentRef: consentRef.trim(),
      intakeEvidenceDigest: intakeEvidenceDigest.trim(),
      responseSlaMinutes: slaMinutes,
    });
  }

  const cases = query.data.service_cases;

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <LifeBuoy className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">Service</p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              Callback desk
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Every live complaint, warranty claim, and service callback, in the order their
              response window runs out.
            </p>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to file a complaint">
          Callbacks are not queued offline. A complaint filed here must reach IronWrap OS before it
          is a record.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The complaint was not filed">
          {actionError}
        </Notice>
      ) : null}
      {outcome === "opened" ? (
        <Notice tone="success" title="Callback opened">
          The case is in intake. Triage it before any remedy work is planned.
        </Notice>
      ) : null}
      {outcome === "duplicate" ? (
        <Notice tone="warning" title="Recorded as a duplicate of the live callback">
          This symptom already has an open case on that job. The second report is kept and linked so
          it is never lost, and the original remedy is not forked.
        </Notice>
      ) : null}

      <section aria-label="Open callbacks" className="border border-border bg-surface">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">Callbacks</h2>
        </div>
        {cases.length === 0 ? (
          <div className="p-5 sm:p-6">
            <EmptyState
              title="No service cases yet"
              message="Nothing has been reported against a completed job. File a complaint below when a customer calls back."
            />
          </div>
        ) : (
          <ul>
            {cases.map((serviceCase) => (
              <li
                key={serviceCase.service_case_id}
                className="border-b border-border last:border-b-0"
              >
                <Link
                  to="/service/$caseId"
                  params={{ caseId: serviceCase.service_case_id }}
                  className="flex flex-col gap-1 px-5 py-4 hover:bg-surface-muted sm:px-6"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold tracking-[-0.01em]">{serviceCase.symptom_code}</span>
                    <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
                      {severityLabel(serviceCase.severity)} · {stateLabel(serviceCase.state)}
                    </span>
                  </span>
                  <span className="text-sm leading-6 text-muted">
                    {serviceCase.roof_job_id} · response due {serviceCase.response_due_at}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="border border-border bg-surface"
        onSubmit={submit}
        aria-label="File a complaint"
      >
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">File a complaint</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Opening a case records the report and its consent to contact the customer. It does not
            schedule a truck or promise a remedy.
          </p>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <TextField
            id="service-customer"
            label="Customer"
            value={customerId}
            onChange={setCustomerId}
          />
          <TextField
            id="service-property"
            label="Property"
            value={propertyKey}
            onChange={setPropertyKey}
          />
          <TextField id="service-job" label="Roof job" value={roofJobId} onChange={setRoofJobId} />
          <TextField
            id="service-warranty"
            label="Warranty packet (optional)"
            value={warrantyPacketId}
            onChange={setWarrantyPacketId}
          />
          <SelectField
            id="service-severity"
            label="Severity"
            value={severity}
            options={serviceCaseSeverities}
            format={(value) => severityLabel(value as ServiceCase["severity"])}
            onChange={(value) => setSeverity(value as ServiceCase["severity"])}
          />
          <SelectField
            id="service-channel"
            label="Reported through"
            value={reportedChannel}
            options={serviceReportedChannels}
            format={(value) => value.charAt(0).toUpperCase() + value.slice(1)}
            onChange={(value) => setReportedChannel(value as ServiceCase["reported_channel"])}
          />
          <TextField
            id="service-symptom"
            label="Symptom code"
            value={symptomCode}
            onChange={setSymptomCode}
            hint="Lowercase words joined by underscores, for example interior_water_stain."
          />
          <TextField
            id="service-consent"
            label="Communication consent"
            value={consentRef}
            onChange={setConsentRef}
            hint="The recorded consent that authorizes contacting this customer."
          />
          <TextField
            id="service-evidence"
            label="Intake evidence digest"
            value={intakeEvidenceDigest}
            onChange={setIntakeEvidenceDigest}
            hint="The 64-character digest of the stored intake evidence."
          />
          <div>
            <label htmlFor="service-sla" className="text-sm font-bold text-foreground">
              Response window (minutes)
            </label>
            <Input
              id="service-sla"
              inputMode="numeric"
              value={responseSlaMinutes}
              onChange={(event) => setResponseSlaMinutes(event.target.value)}
              disabled={offline || mutation.isPending}
              required
              className="mt-3"
            />
            <p className="mt-2 text-xs leading-5 text-muted">
              An emergency callback may not exceed {EMERGENCY_RESPONSE_SLA_CEILING_MINUTES} minutes.
            </p>
          </div>
        </div>

        {emergencyOverrun ? (
          <div className="px-5 pb-5 sm:px-6">
            <Notice tone="danger" title="An emergency cannot wait that long">
              Lower the response window to {EMERGENCY_RESPONSE_SLA_CEILING_MINUTES} minutes or less,
              or file this at a lower severity.
            </Notice>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            A second report of the same symptom on the same job is kept and linked to the live case
            rather than opening a competing one.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={submitDisabled}
          >
            <PhoneIncoming aria-hidden="true" />
            Open callback
          </Button>
        </div>
      </form>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold text-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="mt-3"
      />
      {hint ? <p className="mt-2 text-xs leading-5 text-muted">{hint}</p> : null}
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  format: (value: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold text-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3 min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base shadow-inner shadow-black/3 outline-none focus:border-info focus:outline-info disabled:cursor-not-allowed disabled:opacity-55"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {format(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The complaint could not be filed. Re-open the callback desk before trying again.";
}
