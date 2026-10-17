import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, LifeBuoy, PhoneIncoming } from "lucide-react";
import { useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { ErrorSystemDetails } from "../components/ui/system-details";
import { isRefusal, messageFor, messageForLoad } from "../lib/plain-error";
import { loadServiceCases, openServiceCase } from "./service-api";
import {
  EMERGENCY_RESPONSE_SLA_CEILING_MINUTES,
  serviceCaseSeverities,
  serviceReportedChannels,
  type ServiceCase,
  type ServiceCaseIntakeInput,
} from "./service-contracts";
import { codeLabel, severityLabel, stateLabel } from "./service-presentation";

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
  const [actionError, setActionError] = useState<unknown>();
  const [outcome, setOutcome] = useState<"opened" | "duplicate" | "replayed">();

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
      setActionError(error);
    },
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading service calls…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="Service calls could not load"
        message={messageForLoad(query.error)}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const slaMinutes = Number(responseSlaMinutes);
  const emergencyOverrun =
    severity === "emergency" &&
    Number.isFinite(slaMinutes) &&
    slaMinutes > EMERGENCY_RESPONSE_SLA_CEILING_MINUTES;
  const intakeInvalid =
    !customerId.trim() ||
    !propertyKey.trim() ||
    !roofJobId.trim() ||
    !symptomCode.trim() ||
    !consentRef.trim() ||
    !/^[0-9a-f]{64}$/.test(intakeEvidenceDigest.trim()) ||
    !Number.isInteger(slaMinutes) ||
    slaMinutes < 1;
  const submitDisabled = offline || mutation.isPending || emergencyOverrun;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || intakeInvalid) return;
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
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <LifeBuoy className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] text-balance sm:text-4xl">
                  Service calls
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  See open calls in due-time order. Save a new call when a customer needs help.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Open now</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">
              {cases.length} {cases.length === 1 ? "call" : "calls"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {`List made ${formatDateTime(query.data.read_model_generated_at, session.tenant.locale, session.tenant.time_zone)}`}
            </p>
            <p className="mt-4 text-sm font-semibold text-foreground">
              Open the oldest call first.
            </p>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online to save this call">
          This form does not save calls while offline.
        </Notice>
      ) : null}
      {actionError !== undefined ? (
        <Notice
          tone="danger"
          title={isRefusal(actionError) ? "The call was not saved" : "The call was not confirmed"}
        >
          {messageFor(actionError, {
            refused: "Check the details and try again.",
            fallback:
              "We could not confirm the call was saved. Check the list of calls before you save it again.",
          })}
          <ErrorSystemDetails error={actionError} />
        </Notice>
      ) : null}
      {outcome === "opened" ? (
        <Notice tone="success" title="Callback saved">
          Check the call before anyone plans a fix.
        </Notice>
      ) : null}
      {outcome === "duplicate" ? (
        <Notice tone="warning" title="This call is already open">
          We saved the new report with the first one. Use the first call so two teams do not do the
          same work.
        </Notice>
      ) : null}

      <Card className="overflow-hidden">
        <section aria-label="Open service calls">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
            <div>
              <h2 className="text-lg font-bold tracking-[-0.02em]">Open calls</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Calls are shown by due time.</p>
            </div>
            <p className="text-sm font-semibold text-muted">
              {cases.length} {cases.length === 1 ? "call" : "calls"}
            </p>
          </div>
          {cases.length === 0 ? (
            <div className="p-5 sm:p-6">
              <EmptyState
                title="No open calls"
                message="When a customer calls about a finished job, save the call below."
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
                    className="flex min-h-20 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-muted sm:px-6"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-bold tracking-[-0.01em]">
                          {codeLabel(serviceCase.symptom_code)}
                        </span>
                        <span className="text-sm font-bold text-muted">
                          {severityLabel(serviceCase.severity)} · {stateLabel(serviceCase.state)}
                        </span>
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-muted">
                        Job {serviceCase.roof_job_id} · Call by{" "}
                        {formatDateTime(
                          serviceCase.response_due_at,
                          session.tenant.locale,
                          session.tenant.time_zone,
                        )}
                      </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card>

      <Card className="overflow-hidden">
        <form onSubmit={submit} aria-label="Save a service call">
          <div className="border-b border-border px-5 py-5 sm:px-6">
            <h2 className="text-lg font-bold tracking-[-0.02em]">Save a new call</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              This saves the report and the contact rule. It does not send a truck or promise a fix.
            </p>
          </div>

          <div className="space-y-7 p-5 sm:p-6">
            <fieldset>
              <legend className="text-sm font-bold text-foreground">Who and where</legend>
              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                  id="service-customer"
                  label="Customer ID"
                  value={customerId}
                  onChange={setCustomerId}
                  minLength={3}
                />
                <TextField
                  id="service-property"
                  label="Property ID"
                  value={propertyKey}
                  onChange={setPropertyKey}
                  minLength={3}
                />
                <TextField
                  id="service-job"
                  label="Job ID"
                  value={roofJobId}
                  onChange={setRoofJobId}
                  minLength={3}
                />
                <TextField
                  id="service-warranty"
                  label="Warranty file ID (optional)"
                  value={warrantyPacketId}
                  onChange={setWarrantyPacketId}
                  required={false}
                  minLength={3}
                />
              </div>
            </fieldset>

            <fieldset className="border-t border-border pt-6">
              <legend className="text-sm font-bold text-foreground">What happened</legend>
              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <SelectField
                  id="service-severity"
                  label="Need level"
                  value={severity}
                  options={serviceCaseSeverities}
                  format={(value) => severityLabel(value as ServiceCase["severity"])}
                  onChange={(value) => setSeverity(value as ServiceCase["severity"])}
                />
                <SelectField
                  id="service-channel"
                  label="Told us by"
                  value={reportedChannel}
                  options={serviceReportedChannels}
                  format={(value) => value.charAt(0).toUpperCase() + value.slice(1)}
                  onChange={(value) => setReportedChannel(value as ServiceCase["reported_channel"])}
                />
                <TextField
                  id="service-symptom"
                  label="Problem code"
                  value={symptomCode}
                  onChange={setSymptomCode}
                  hint="Use small letters, numbers, and _. Example: interior_water_stain."
                  minLength={3}
                  pattern="[a-z0-9_]+"
                  title="Use small letters, numbers, and _ only."
                />
                <div>
                  <label htmlFor="service-sla" className="text-sm font-bold text-foreground">
                    Call back in (minutes)
                  </label>
                  <Input
                    id="service-sla"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={60 * 24 * 30}
                    step={1}
                    value={responseSlaMinutes}
                    onChange={(event) => setResponseSlaMinutes(event.target.value)}
                    disabled={offline || mutation.isPending}
                    required
                    className="mt-3"
                  />
                  <p className="mt-2 text-xs leading-5 text-muted">
                    An emergency call must be answered in {EMERGENCY_RESPONSE_SLA_CEILING_MINUTES}
                    minutes or less.
                  </p>
                </div>
              </div>
            </fieldset>

            <fieldset className="border-t border-border pt-6">
              <legend className="text-sm font-bold text-foreground">Saved proof</legend>
              <p className="mt-1 text-sm leading-6 text-muted">
                Add the saved IDs that show we can call the customer and keep this report.
              </p>
              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                  id="service-consent"
                  label="Contact rule ID"
                  value={consentRef}
                  onChange={setConsentRef}
                  hint="Use the saved rule that lets us call this customer."
                  minLength={3}
                />
                <TextField
                  id="service-evidence"
                  label="Proof code"
                  value={intakeEvidenceDigest}
                  onChange={setIntakeEvidenceDigest}
                  hint="Paste the 64-letter proof code from the saved report."
                  minLength={64}
                  maxLength={64}
                  pattern="[0-9a-f]{64}"
                  title="Use the 64-letter proof code."
                />
              </div>
            </fieldset>
          </div>

          {emergencyOverrun ? (
            <div className="px-5 pb-5 sm:px-6">
              <Notice tone="danger" title="An emergency cannot wait that long">
                Set the call-back time to {EMERGENCY_RESPONSE_SLA_CEILING_MINUTES} minutes or less,
                or pick a lower need level.
              </Notice>
            </div>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="max-w-xl text-sm leading-6 text-muted">
              If this call is already open, the new report is saved with the first one.
            </p>
            <Button
              type="submit"
              variant="accent"
              className="shrink-0"
              busy={mutation.isPending}
              disabled={submitDisabled}
            >
              <PhoneIncoming aria-hidden="true" />
              Save call
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  required = true,
  minLength,
  maxLength,
  pattern,
  title,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  title?: string;
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
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        pattern={pattern}
        title={title}
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
      <Select
        field
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {format(option)}
          </option>
        ))}
      </Select>
    </div>
  );
}

function formatDateTime(value: string, locale: string, timeZone: string): string {
  if (Number.isNaN(Date.parse(value))) return "time not found";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "time not found";
  }
}
