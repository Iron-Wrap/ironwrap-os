import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";

import { adminErrorMessage } from "../admin/admin-api";
import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { Textarea } from "../components/ui/textarea";
import { ApiError } from "../lib/api";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  createOfficeLead,
  loadOfficeLeadReceipt,
  newOfficeLeadRequestId,
  resumeOfficeLeadIntake,
} from "./sales-api";
import type { NewLeadInput, OfficeLeadReceipt } from "./sales-contracts";
import "./new-lead-page.css";

const EMPTY: NewLeadInput = {
  name: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  province: "",
  postal_code: "",
  service: "",
  message: "",
  intake_source: "phone",
  preferred_contact_channel: null,
  email_estimate_follow_up_consent: false,
};

// These codes are returned before the intake receipt is allocated. An unfamiliar error
// must retain the request identity even if its HTTP status looks like a validation error.
const PREWRITE_VALIDATION = new Set([
  "invalid_body",
  "unexpected_field",
  "invalid_name",
  "invalid_email",
  "invalid_phone",
  "invalid_address",
  "invalid_city",
  "invalid_province",
  "invalid_postal_code",
  "invalid_service",
  "invalid_message",
  "contact_required",
  "invalid_intake_source",
  "invalid_preferred_contact_channel",
  "preferred_contact_channel_missing",
  "invalid_email_estimate_follow_up_consent",
  "consent_email_required",
  "invalid_intake_request_id",
]);
function isDefiniteRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    (error.status === 400 && PREWRITE_VALIDATION.has(error.code)) ||
    (error.status === 403 &&
      ["sales_lead_create_required", "csrf_failed", "tenant_identity_required"].includes(
        error.code,
      )) ||
    (error.status === 503 && error.code === "office_consent_jurisdiction_unconfigured")
  );
}

export function NewLeadPage() {
  const session = useSession();
  return (
    <RoleGuard surface="sales">
      <NewLeadContent key={`${session.tenant.id}:${session.user.id}`} />
    </RoleGuard>
  );
}

function NewLeadContent() {
  const session = useSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { receipt?: string };
  const receiptId = search.receipt;
  const online = useOnlineStatus();
  const offline = isOfflineSession(session) || !online;
  const canCreate = session.allowed_actions.includes("sales.lead.create");
  const queryClient = useQueryClient();
  const [values, setValues] = useState<NewLeadInput>(EMPTY);
  const [attempt, setAttempt] = useState<{ requestId: string; input: NewLeadInput } | null>(null);
  const [checkedRequest, setCheckedRequest] = useState<string | null>(null);
  const [resumableRead, setResumableRead] = useState<string | null>(null);
  const currentReceiptId = useRef(receiptId);
  const resumeVersion = useRef(0);
  const submitLock = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [focusNewForm, setFocusNewForm] = useState(false);
  useEffect(() => {
    currentReceiptId.current = receiptId;
  }, [receiptId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const receiptKey = (requestId: string | undefined) => [
    "office-lead-receipt",
    session.tenant.id,
    session.user.id,
    requestId,
  ];
  const create = useMutation({
    mutationFn: ({ input, requestId }: { input: NewLeadInput; requestId: string }) =>
      createOfficeLead(session, input, requestId),
    onSuccess: (result) => {
      queryClient.setQueryData(receiptKey(result.receipt.request_id), result);
    },
  });
  const resume = useMutation({
    mutationFn: (requestId: string) => resumeOfficeLeadIntake(session, requestId),
    onSuccess: async (result) => {
      // An older reconnect read must not replace this confirmed command result.
      await queryClient.cancelQueries({
        queryKey: receiptKey(result.receipt.request_id),
        exact: true,
      });
      queryClient.setQueryData(receiptKey(result.receipt.request_id), result);
    },
  });
  const saved = useQuery({
    queryKey: receiptKey(receiptId),
    queryFn: async () => {
      const requestId = receiptId!;
      const version = resumeVersion.current;
      setResumableRead(null);
      const result = await loadOfficeLeadReceipt(requestId);
      if (
        mounted.current &&
        currentReceiptId.current === requestId &&
        resumeVersion.current === version &&
        !submitLock.current
      ) {
        // A cached processing result or a mutation response cannot authorize resume.
        setResumableRead(result.receipt.state === "processing" ? requestId : null);
      }
      return result;
    },
    enabled: Boolean(receiptId) && receiptId !== attempt?.requestId && !offline,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: "always",
  });
  const receipt =
    receiptId && saved.data?.receipt.request_id === receiptId ? saved.data.receipt : undefined;
  const canResume =
    receipt?.state === "processing" &&
    resumableRead === receiptId &&
    saved.isSuccess &&
    !saved.isFetching;
  const currentResume = resume.variables === receiptId;
  const locked = Boolean(receiptId) || create.isPending || Boolean(attempt);
  const reachable = Boolean(values.phone.trim() || values.email.trim());
  const preferredReachable =
    !values.preferred_contact_channel || Boolean(values[values.preferred_contact_channel].trim());
  const consentReachable = !values.email_estimate_follow_up_consent || Boolean(values.email.trim());
  const ready =
    values.name.trim().length >= 2 && reachable && preferredReachable && consentReachable;
  const outcome = receipt?.state === "recorded" ? receipt.outcome : receipt?.state;

  useEffect(() => {
    if (
      receiptId &&
      (create.isError || outcome || saved.isError || (currentResume && resume.isError))
    )
      resultRef.current?.focus();
    if (!receiptId && create.isError) refusalRef.current?.focus();
  }, [
    receiptId,
    create.isError,
    outcome,
    receipt?.lead_id,
    saved.isError,
    currentResume,
    resume.isError,
  ]);

  useEffect(() => {
    if (!receiptId && focusNewForm) {
      formRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    }
  }, [receiptId, focusNewForm]);

  function set<K extends keyof NewLeadInput>(name: K, value: NewLeadInput[K]) {
    setValues((current) => ({ ...current, [name]: value }));
    if (create.isError) create.reset();
  }

  async function submit() {
    if (!ready || !canCreate || offline || receiptId || submitLock.current) return;
    submitLock.current = true;
    const requestId = newOfficeLeadRequestId();
    const input = Object.freeze({ ...values });
    setAttempt({ requestId, input });
    setCheckedRequest(null);
    try {
      // Persist only the opaque recovery identity before the request leaves this page.
      await navigate({ to: "/sales/new-lead", search: { receipt: requestId }, replace: true });
    } catch {
      submitLock.current = false;
      setAttempt(null);
      return;
    }
    try {
      if (!mounted.current) return;
      await create.mutateAsync({ input, requestId });
    } catch (error) {
      if (mounted.current && isDefiniteRefusal(error)) {
        await navigate({ to: "/sales/new-lead", search: {}, replace: true });
        setAttempt(null);
      }
      // An ambiguous write keeps this identity; a retry requires a read check first.
    } finally {
      submitLock.current = false;
    }
  }

  async function checkSavedResult() {
    if (offline || create.isPending || resume.isPending || !receiptId) return;
    const requestId = receiptId;
    await saved.refetch();
    if (mounted.current && currentReceiptId.current === requestId) setCheckedRequest(requestId);
  }

  async function resumeSavedIntake() {
    if (
      !receiptId ||
      !canResume ||
      offline ||
      !canCreate ||
      create.isPending ||
      resume.isPending ||
      saved.isFetching ||
      submitLock.current
    )
      return;
    submitLock.current = true;
    resumeVersion.current += 1;
    setResumableRead(null);
    setCheckedRequest(null);
    try {
      await resume.mutateAsync(receiptId);
    } catch {
      // The stored request remains locked. Another resume needs a fresh receipt read.
    } finally {
      // A read begun during this write cannot confirm its eventual outcome.
      resumeVersion.current += 1;
      submitLock.current = false;
    }
  }

  async function retrySameRequest() {
    if (
      !attempt ||
      attempt.requestId !== receiptId ||
      checkedRequest !== receiptId ||
      receipt ||
      offline ||
      !canCreate ||
      create.isPending ||
      resume.isPending ||
      saved.isFetching ||
      submitLock.current
    )
      return;
    submitLock.current = true;
    try {
      await create.mutateAsync(attempt);
    } catch {
      // A later refusal cannot prove the outcome of the earlier uncertain request.
    } finally {
      submitLock.current = false;
      setCheckedRequest(null);
    }
  }

  async function startAnother() {
    await navigate({ to: "/sales/new-lead", search: {}, replace: true });
    setValues(EMPTY);
    setAttempt(null);
    setResumableRead(null);
    create.reset();
    resume.reset();
    setFocusNewForm(true);
  }

  return (
    <section className="new-lead-page">
      <PageHeader
        title="Add a lead"
        back={
          <Link to="/sales" className="inline-flex min-h-11 items-center gap-2">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Sales desk
          </Link>
        }
      >
        <p className="max-w-xl text-sm leading-6 text-muted">
          Start with a name and a way to reply. Add what they need and the details you have.
        </p>
      </PageHeader>

      {offline ? (
        <Notice tone="warning" title="Reconnect before saving or checking a lead">
          {receiptId
            ? "Reconnect to check this submission or retry its original details. Nothing will be sent automatically."
            : "You can keep typing while this page is open. These form details are not saved on this device."}
        </Notice>
      ) : null}

      {receiptId ? (
        <div className="new-lead-result grid gap-4" ref={resultRef} tabIndex={-1}>
          {receipt ? (
            <ReceiptSummary receipt={receipt} />
          ) : (
            <Notice
              tone={create.isPending || saved.isFetching ? "info" : "warning"}
              title={
                create.isPending
                  ? "Saving this lead"
                  : saved.isFetching
                    ? "Checking the saved result"
                    : "We haven’t confirmed whether this lead was saved"
              }
            >
              Keep this page or its link to check the same submission. Checking never submits it
              again.
            </Notice>
          )}
          {saved.isError ? (
            <Notice
              tone="warning"
              title={
                receipt
                  ? "The latest saved status could not be checked"
                  : "The saved result could not be confirmed"
              }
            >
              {receipt
                ? "The last confirmed result is shown. Check again when the connection is ready."
                : saved.error instanceof ApiError && saved.error.status === 404
                  ? "There is no receipt available yet. This does not confirm that the lead was not saved."
                  : "Reconnect and check this submission again. Its outcome is still unconfirmed."}
            </Notice>
          ) : null}
          {currentResume && resume.isPending ? (
            <Notice tone="info" title="Resuming saved intake">
              Continuing the original submission with its saved details.
            </Notice>
          ) : null}
          {currentResume && resume.isError && !canResume && receipt?.state !== "recorded" ? (
            <Notice tone="warning" title="The resume result is unconfirmed">
              Check the saved result before resuming again. This submission keeps its original
              identity and details.
            </Notice>
          ) : null}
          {!attempt && !receipt && !saved.isFetching ? (
            <p className="new-lead-hint">
              This page was reopened without the original form details. Keep this link and check
              again, or ask the office to investigate this submission before entering it again.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {receipt?.state !== "recorded" || !receipt.lead_id ? (
              <Button
                variant="secondary"
                disabled={offline || create.isPending || resume.isPending}
                busy={saved.isFetching}
                onClick={() => void checkSavedResult()}
              >
                Check saved result
              </Button>
            ) : (
              <Button asChild>
                <Link to="/sales/leads/$leadId/triage" params={{ leadId: receipt.lead_id }}>
                  Review this lead
                </Link>
              </Button>
            )}
            {canResume || (currentResume && resume.isPending) ? (
              <Button
                variant="secondary"
                disabled={offline || !canCreate || create.isPending || saved.isFetching}
                busy={resume.isPending}
                onClick={() => void resumeSavedIntake()}
              >
                Resume saved intake
              </Button>
            ) : null}
            {attempt?.requestId === receiptId &&
            create.isError &&
            checkedRequest === receiptId &&
            !receipt ? (
              <Button
                variant="secondary"
                disabled={offline || !canCreate || saved.isFetching || resume.isPending}
                busy={create.isPending}
                onClick={() => void retrySameRequest()}
              >
                Retry same request
              </Button>
            ) : null}
            {receipt?.state === "recorded" && canCreate ? (
              <Button variant="quiet" onClick={() => void startAnother()}>
                Add another lead
              </Button>
            ) : null}
            <Button variant="quiet" asChild>
              <Link to="/sales">Sales desk</Link>
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="new-lead-sheet"
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {!canCreate ? (
            <div className="new-lead-section">
              <Notice tone="warning" title="You cannot add a lead with this account">
                Ask the office to check your access. You can still read a saved intake you are
                allowed to see.
              </Notice>
            </div>
          ) : null}
          {create.isError && isDefiniteRefusal(create.error) ? (
            <div className="new-lead-section" ref={refusalRef} tabIndex={-1}>
              <Notice tone="danger" title="Check these details before saving">
                {create.error instanceof ApiError &&
                create.error.code === "office_consent_jurisdiction_unconfigured"
                  ? "The office must configure estimate follow-up permission recording before saving this consent. Keep the form open and ask the office to check the setup."
                  : adminErrorMessage(create.error)}
              </Notice>
            </div>
          ) : null}
          <section className="new-lead-section" aria-labelledby="new-lead-person">
            <h2 id="new-lead-person">Person</h2>
            <LeadField
              label="Full name"
              name="name"
              value={values.name}
              onChange={set}
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
              disabled={locked}
            />
            <div className="new-lead-pair">
              <LeadField
                label="Phone"
                name="phone"
                type="tel"
                inputMode="tel"
                value={values.phone}
                onChange={set}
                maxLength={32}
                autoComplete="tel"
                hint="Phone or email is required."
                disabled={locked}
              />
              <LeadField
                label="Email"
                name="email"
                type="email"
                inputMode="email"
                value={values.email}
                onChange={set}
                maxLength={160}
                autoComplete="email"
                disabled={locked}
              />
            </div>
            <fieldset className="new-lead-choice-group" disabled={locked}>
              <legend>How they prefer to be contacted</legend>
              <div className="new-lead-choices">
                {(
                  [
                    ["phone", "Phone"],
                    ["email", "Email"],
                    [null, "Either"],
                  ] as const
                ).map(([value, label]) => (
                  <label className="new-lead-choice" key={label}>
                    <input
                      type="radio"
                      name="preferred_contact_channel"
                      checked={values.preferred_contact_channel === value}
                      onChange={() => set("preferred_contact_channel", value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="new-lead-hint mt-2">
                Either means no preference. It does not give permission to send messages.
              </p>
              {!preferredReachable ? (
                <p className="new-lead-hint mt-2">
                  Add their{" "}
                  {values.preferred_contact_channel === "email" ? "email address" : "phone number"}{" "}
                  or choose another preference.
                </p>
              ) : null}
            </fieldset>
            <div>
              <label className="new-lead-consent">
                <input
                  type="checkbox"
                  checked={values.email_estimate_follow_up_consent}
                  onChange={(event) =>
                    set("email_estimate_follow_up_consent", event.target.checked)
                  }
                  disabled={locked}
                  aria-describedby="new-lead-consent-hint"
                />
                <span>They agreed to receive estimate follow-up by email</span>
              </label>
              <p className="new-lead-hint" id="new-lead-consent-hint">
                Record only what they agreed to. Leaving this unchecked records no permission; it is
                not a refusal. Saving permission sends no message and does not allow marketing.
              </p>
              {!consentReachable ? (
                <p className="new-lead-hint mt-2">
                  Add their email address to record this permission.
                </p>
              ) : null}
            </div>
          </section>
          <section className="new-lead-section" aria-labelledby="new-lead-work">
            <h2 id="new-lead-work">Work needed</h2>
            <div className="new-lead-field">
              <label htmlFor="new-lead-message">
                What they need <span className="font-normal text-muted">(optional)</span>
              </label>
              <p className="new-lead-hint" id="new-lead-message-hint">
                In their words, including any other notes they shared. Keep your own interpretation
                for the lead review.
              </p>
              <Textarea
                id="new-lead-message"
                name="message"
                value={values.message}
                onChange={(event) => set("message", event.target.value)}
                maxLength={2000}
                aria-describedby="new-lead-message-hint"
                disabled={locked}
              />
            </div>
            <LeadField
              label="Kind of work"
              name="service"
              value={values.service}
              onChange={set}
              maxLength={120}
              hint="Use their description, or leave blank if you are not sure yet."
              disabled={locked}
            />
          </section>
          <section className="new-lead-section" aria-labelledby="new-lead-property">
            <h2 id="new-lead-property">Property</h2>
            <LeadField
              label="Street address"
              name="address"
              value={values.address}
              onChange={set}
              maxLength={200}
              autoComplete="street-address"
              disabled={locked}
            />
            <div className="new-lead-trio">
              <LeadField
                label="City or town"
                name="city"
                value={values.city}
                onChange={set}
                maxLength={80}
                autoComplete="address-level2"
                disabled={locked}
              />
              <LeadField
                label="Province"
                name="province"
                value={values.province}
                onChange={set}
                maxLength={80}
                autoComplete="address-level1"
                disabled={locked}
              />
              <LeadField
                label="Postal code"
                name="postal_code"
                value={values.postal_code}
                onChange={set}
                maxLength={24}
                autoComplete="postal-code"
                disabled={locked}
              />
            </div>
          </section>
          <section className="new-lead-section" aria-labelledby="new-lead-source">
            <h2 id="new-lead-source">Where it came from</h2>
            <fieldset className="new-lead-choice-group" disabled={locked}>
              <legend>Source</legend>
              <div className="new-lead-choices new-lead-source-choices">
                {(
                  [
                    ["phone", "Phone call"],
                    ["referral", "Referral"],
                    ["walk_in", "Walk-in"],
                  ] as const
                ).map(([value, label]) => (
                  <label className="new-lead-choice" key={value}>
                    <input
                      type="radio"
                      name="intake_source"
                      checked={values.intake_source === value}
                      onChange={() => set("intake_source", value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </section>
          <footer className="new-lead-footer">
            <Button
              type="submit"
              disabled={!ready || !canCreate || offline || locked}
              busy={create.isPending}
            >
              Save lead
            </Button>
            <Button variant="quiet" asChild>
              <Link to="/sales">Cancel</Link>
            </Button>
            <p className="new-lead-hint">Save the details, then check the recorded lead.</p>
          </footer>
        </form>
      )}
    </section>
  );
}

function ReceiptSummary({ receipt }: { receipt: OfficeLeadReceipt }) {
  const details = receipt.details;
  const duplicate = receipt.outcome === "duplicate";
  const sourceLabels = { phone: "Phone call", referral: "Referral", walk_in: "Walk-in" };
  return (
    <>
      <Notice
        tone={receipt.state === "processing" ? "info" : duplicate ? "warning" : "success"}
        title={
          receipt.state === "processing"
            ? "This intake is still processing"
            : duplicate
              ? "An existing lead was found"
              : "Lead intake recorded"
        }
      >
        {receipt.state === "processing"
          ? "The office is still processing this submission. Check its saved result before entering it again."
          : duplicate
            ? "A new lead was not created. Your submitted details, contact preference and email permission were not applied to the existing lead."
            : receipt.lead_id
              ? "The saved lead is ready for review."
              : "The intake was recorded. The lead is not ready for review yet; check again for its link."}
      </Notice>
      {details ? (
        <section
          className="new-lead-sheet"
          aria-label={duplicate ? "Existing lead details" : "Saved lead details"}
        >
          <div className="new-lead-section">
            <h2>{duplicate ? "Existing lead details" : "Saved lead details"}</h2>
            <dl className="new-lead-receipt-facts">
              {(
                [
                  ["Full name", details.name],
                  ["Phone", details.phone],
                  ["Email", details.email],
                  ["What they need", details.message],
                  ["Kind of work", details.service],
                  ["Street address", details.address],
                  ["City or town", details.city],
                  ["Province", details.province],
                  ["Postal code", details.postal_code],
                  [
                    "Source",
                    details.intake_source ? sourceLabels[details.intake_source] : details.source,
                  ],
                  [
                    "Contact preference",
                    details.preferred_contact_channel === "email"
                      ? "Email"
                      : details.preferred_contact_channel === "phone"
                        ? "Phone"
                        : "No preference recorded",
                  ],
                  [
                    "Email permission",
                    details.email_consent.status === "granted"
                      ? "Estimate follow-up permission recorded"
                      : "No estimate follow-up permission recorded",
                  ],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || "Not recorded"}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ) : null}
    </>
  );
}

type TextFieldName =
  "name" | "email" | "phone" | "address" | "city" | "province" | "postal_code" | "service";
function LeadField({
  label,
  name,
  value,
  onChange,
  hint,
  required,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "value" | "onChange"> & {
  label: string;
  name: TextFieldName;
  value: string;
  onChange: (name: TextFieldName, value: string) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="new-lead-field">
      <label htmlFor={id}>
        {label}
        {!required && name !== "phone" && name !== "email" ? (
          <span className="font-normal text-muted"> (optional)</span>
        ) : null}
      </label>
      {hint ? (
        <p className="new-lead-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
    </div>
  );
}
