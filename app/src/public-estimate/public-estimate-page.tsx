import { CheckCircle2, CircleAlert, ClipboardCheck, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ZodError } from "zod";

import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { clearStableClientSubmissionId, stableClientSubmissionId } from "./client-submission-id";
import {
  PublicEstimateApiError,
  loadPublicEstimateConfig,
  submitPublicInstantEstimate,
} from "./public-estimate-api";
import {
  NON_BINDING_ESTIMATE_DISCLAIMER,
  PUBLIC_ESTIMATE_BRANDS,
  PUBLIC_ESTIMATE_PROVINCES,
  PUBLIC_ESTIMATE_RANGE_PROVINCE,
  PUBLIC_ESTIMATE_SERVICES,
  publicEstimateFormSchema,
  publicEstimateBrandFromSearch,
  publicEstimateRequest,
  type PublicEstimateBrand,
  type PublicEstimateConfig,
  type PublicEstimateProvince,
  type PublicInstantEstimateResponse,
} from "./public-estimate-contracts";
import { TurnstileChallenge } from "./turnstile-challenge";

type FormErrors = Partial<
  Record<
    | "name"
    | "email"
    | "phone"
    | "address"
    | "province"
    | "service"
    | "contactConsent"
    | "privacyConsent",
    string
  >
>;

const formControlNames: Record<keyof FormErrors, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  address: "address",
  province: "province",
  service: "service",
  contactConsent: "contact-consent",
  privacyConsent: "privacy-consent",
};

function formDataValues(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    name: String(data.get("name") ?? ""),
    email: String(data.get("email") ?? ""),
    phone: String(data.get("phone") ?? ""),
    address: String(data.get("address") ?? ""),
    province: String(data.get("province") ?? ""),
    service: String(data.get("service") ?? ""),
    contactConsent: data.get("contact-consent") === "on",
    privacyConsent: data.get("privacy-consent") === "on",
  };
}

function errorsForForm(error: ZodError): FormErrors {
  const errors: FormErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && field in errors === false && field !== "") {
      errors[field as keyof FormErrors] = issue.message;
    }
  }
  return errors;
}

function formatCad(value: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function PublicEstimatePage() {
  const brand = publicEstimateBrandFromSearch(window.location.search);
  const brandCopy = PUBLIC_ESTIMATE_BRANDS[brand];
  const [config, setConfig] = useState<PublicEstimateConfig>();
  const [configError, setConfigError] = useState(false);
  const [configAttempt, setConfigAttempt] = useState(0);
  const [submissionId, setSubmissionId] = useState(stableClientSubmissionId);
  const [selectedProvince, setSelectedProvince] = useState<PublicEstimateProvince>(
    PUBLIC_ESTIMATE_RANGE_PROVINCE,
  );
  const [submittedProvince, setSubmittedProvince] = useState<PublicEstimateProvince>();
  const [turnstileToken, setTurnstileToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [challengeError, setChallengeError] = useState<string>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [requestError, setRequestError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PublicInstantEstimateResponse>();
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let active = true;
    void loadPublicEstimateConfig(brand)
      .then((nextConfig) => {
        if (active) setConfig(nextConfig);
      })
      .catch(() => {
        if (active) setConfigError(true);
      });
    return () => {
      active = false;
    };
  }, [brand, configAttempt]);

  useEffect(() => {
    document.title = `Get a roofing estimate | ${brandCopy.displayName}`;
  }, [brandCopy.displayName]);

  const clearError = useCallback((field: keyof FormErrors) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const onTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);

  const onTurnstileFailure = useCallback((message?: string) => {
    setChallengeError(message);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !config.enabled) return;

    setRequestError(undefined);
    setChallengeError(undefined);
    const parsed = publicEstimateFormSchema.safeParse(formDataValues(event.currentTarget));
    if (!parsed.success) {
      const nextErrors = errorsForForm(parsed.error);
      setErrors(nextErrors);
      const firstField = Object.keys(nextErrors)[0] as keyof FormErrors | undefined;
      const control = firstField
        ? event.currentTarget.elements.namedItem(formControlNames[firstField])
        : undefined;
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    if (config.turnstile_site_key && !turnstileToken) {
      setChallengeError("Complete the security check before sending your request.");
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const response = await submitPublicInstantEstimate(
        publicEstimateRequest(parsed.data, turnstileToken, submissionId, brand),
      );
      clearStableClientSubmissionId();
      setSubmittedProvince(parsed.data.province);
      setResult(response);
    } catch (error) {
      setRequestError(
        error instanceof PublicEstimateApiError
          ? error.message
          : "We could not submit your request. Please try again.",
      );
      // Turnstile tokens are single-use once the Worker verifies them. Recreate
      // the challenge after any failed transport so the next stable-idempotency
      // retry cannot accidentally reuse a consumed token.
      setTurnstileToken("");
      setChallengeVersion((version) => version + 1);
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherRequest() {
    clearStableClientSubmissionId();
    setSubmissionId(stableClientSubmissionId());
    setSelectedProvince(PUBLIC_ESTIMATE_RANGE_PROVINCE);
    setSubmittedProvince(undefined);
    setTurnstileToken("");
    setChallengeVersion((version) => version + 1);
    setChallengeError(undefined);
    setErrors({});
    setRequestError(undefined);
    setResult(undefined);
    form.current?.reset();
  }

  if (configError) {
    return (
      <PublicEstimateFrame brand={brand}>
        <ErrorState
          title="Estimate requests are unavailable"
          message="We could not open the estimate form. Check your connection and try again."
          onRetry={() => {
            setConfigError(false);
            setConfigAttempt((attempt) => attempt + 1);
          }}
        />
      </PublicEstimateFrame>
    );
  }

  if (!config) {
    return (
      <PublicEstimateFrame brand={brand}>
        <LoadingState label="Opening the estimate form…" />
      </PublicEstimateFrame>
    );
  }

  if (!config.enabled) {
    return (
      <PublicEstimateFrame brand={brand}>
        <section className="mx-auto max-w-lg py-10 text-center" aria-live="polite">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
            <CircleAlert className="size-6" aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-black tracking-[-0.035em]">
            Estimate requests are paused
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            An estimator can still help with your project. Please try this form again shortly.
          </p>
        </section>
      </PublicEstimateFrame>
    );
  }

  if (result) {
    return (
      <PublicEstimateFrame brand={brand}>
        <EstimateResult
          brand={brand}
          result={result}
          canShowRange={submittedProvince === PUBLIC_ESTIMATE_RANGE_PROVINCE}
          onStartAnotherRequest={startAnotherRequest}
        />
      </PublicEstimateFrame>
    );
  }

  return (
    <PublicEstimateFrame brand={brand}>
      <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-start lg:gap-12">
        <EstimateIntroduction
          rangeAvailable={
            config.range_available && selectedProvince === PUBLIC_ESTIMATE_RANGE_PROVINCE
          }
        />
        <Card className="overflow-hidden">
          <div className="border-b border-border bg-surface px-5 py-5 sm:px-7 sm:py-6">
            <p className="text-xs font-bold tracking-[0.14em] text-muted">PROJECT START</p>
            <h1 className="mt-2 text-2xl font-black tracking-[-0.04em] sm:text-3xl">
              Tell us about the exterior work.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
              We use these details to prepare a reviewable budget range or route your project to an
              estimator.
            </p>
          </div>
          <CardContent className="p-5 sm:p-7">
            <EstimateForm
              config={config}
              brand={brand}
              selectedProvince={selectedProvince}
              form={form}
              errors={errors}
              requestError={requestError}
              challengeError={challengeError}
              submitting={submitting}
              turnstileToken={turnstileToken}
              challengeVersion={challengeVersion}
              onSubmit={submit}
              onFieldChange={clearError}
              onProvinceChange={setSelectedProvince}
              onTurnstileToken={onTurnstileToken}
              onTurnstileFailure={onTurnstileFailure}
            />
          </CardContent>
        </Card>
      </div>
    </PublicEstimateFrame>
  );
}

function PublicEstimateFrame({
  brand,
  children,
}: {
  brand: PublicEstimateBrand;
  children: React.ReactNode;
}) {
  const brandCopy = PUBLIC_ESTIMATE_BRANDS[brand];
  return (
    <main className="min-h-dvh bg-background px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4 border-b border-border pb-4 sm:mb-10">
          <div>
            <p className="text-xs font-black tracking-[0.16em] text-foreground">
              {brandCopy.displayName.toUpperCase()}
            </p>
            <p className="mt-1 text-xs text-muted">{brandCopy.serviceArea}</p>
          </div>
          <ShieldCheck className="size-6 text-ok" aria-label="Your request is handled securely" />
        </header>
        {children}
      </div>
    </main>
  );
}

function EstimateIntroduction({ rangeAvailable }: { rangeAvailable: boolean }) {
  return (
    <section className="pt-1 sm:pt-4">
      <p className="text-xs font-bold tracking-[0.15em] text-ok">CLEAR SCOPE. NO SURPRISES.</p>
      <h2 className="mt-4 max-w-lg text-4xl font-black leading-[0.96] tracking-[-0.055em] sm:text-5xl">
        Start with the property, not a sales pitch.
      </h2>
      <div className="mt-7 flex max-w-md items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <svg viewBox="0 0 100 28" className="h-8 w-28 text-accent" fill="none">
          <path d="M3 24 45 4l21 11 12-7 19 16" stroke="currentColor" strokeWidth="3" />
        </svg>
        <span className="h-px flex-1 bg-border" />
      </div>
      <p className="mt-7 max-w-lg text-base leading-7 text-muted">
        Share the basics. Online ranges are limited to Alberta projects; every other request goes to
        estimator review without an online price.
      </p>
      <dl className="mt-8 grid max-w-lg gap-3 border-y border-border py-5 text-sm">
        <InfoRow label="1" text="We check scope and property details." />
        <InfoRow label="2" text="You may receive a non-binding range." />
        <InfoRow label="3" text="An estimator confirms measurements, access, and materials." />
      </dl>
      {!rangeAvailable ? (
        <p className="mt-5 text-sm leading-6 text-muted">
          This request will go straight to estimator review. We won’t invent a price online.
        </p>
      ) : null}
    </section>
  );
}

function InfoRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid grid-cols-[1.5rem_1fr] gap-3">
      <dt className="font-black text-accent">{label}</dt>
      <dd className="leading-6 text-muted">{text}</dd>
    </div>
  );
}

function EstimateForm({
  config,
  brand,
  selectedProvince,
  form,
  errors,
  requestError,
  challengeError,
  submitting,
  turnstileToken,
  challengeVersion,
  onSubmit,
  onFieldChange,
  onProvinceChange,
  onTurnstileToken,
  onTurnstileFailure,
}: {
  config: PublicEstimateConfig;
  brand: PublicEstimateBrand;
  selectedProvince: PublicEstimateProvince;
  form: React.RefObject<HTMLFormElement | null>;
  errors: FormErrors;
  requestError?: string;
  challengeError?: string;
  submitting: boolean;
  turnstileToken: string;
  challengeVersion: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: (field: keyof FormErrors) => void;
  onProvinceChange: (province: PublicEstimateProvince) => void;
  onTurnstileToken: (token: string) => void;
  onTurnstileFailure: (message?: string) => void;
}) {
  const fieldId = useId();
  const isChallengePending = Boolean(config.turnstile_site_key && !turnstileToken);
  const rangeAvailable =
    config.range_available && selectedProvince === PUBLIC_ESTIMATE_RANGE_PROVINCE;
  const disclaimer = config.disclaimer || NON_BINDING_ESTIMATE_DISCLAIMER;
  const brandCopy = PUBLIC_ESTIMATE_BRANDS[brand];

  return (
    <form ref={form} className="space-y-5" noValidate onSubmit={onSubmit}>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField label="Full name" error={errors.name} inputId={`${fieldId}-name`}>
          <Input
            id={`${fieldId}-name`}
            name="name"
            autoComplete="name"
            placeholder="Your name"
            invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${fieldId}-name-error` : undefined}
            onChange={() => onFieldChange("name")}
          />
        </FormField>
        <FormField label="Project address" error={errors.address} inputId={`${fieldId}-address`}>
          <Input
            id={`${fieldId}-address`}
            name="address"
            autoComplete="street-address"
            placeholder="123 Example Street"
            invalid={Boolean(errors.address)}
            aria-describedby={errors.address ? `${fieldId}-address-error` : undefined}
            onChange={() => onFieldChange("address")}
          />
        </FormField>
        <FormField
          label="Project province"
          hint="Online ranges are available for Alberta only. Other locations are reviewed by an estimator."
          error={errors.province}
          inputId={`${fieldId}-province`}
        >
          <select
            id={`${fieldId}-province`}
            name="province"
            value={selectedProvince}
            aria-invalid={Boolean(errors.province) || undefined}
            aria-describedby={errors.province ? `${fieldId}-province-error` : undefined}
            className="min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base text-foreground shadow-inner shadow-black/3 focus-visible:border-info focus-visible:outline-info aria-[invalid=true]:border-danger"
            onChange={(event) => {
              onProvinceChange(event.currentTarget.value as PublicEstimateProvince);
              onFieldChange("province");
            }}
          >
            {PUBLIC_ESTIMATE_PROVINCES.map((province) => (
              <option key={province.id} value={province.id}>
                {province.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Email"
          hint="Email or phone is required."
          error={errors.email}
          inputId={`${fieldId}-email`}
        >
          <Input
            id={`${fieldId}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? `${fieldId}-email-error` : undefined}
            onChange={() => onFieldChange("email")}
          />
        </FormField>
        <FormField
          label="Phone"
          hint="Email or phone is required."
          error={errors.phone}
          inputId={`${fieldId}-phone`}
        >
          <Input
            id={`${fieldId}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="403 555 0123"
            invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? `${fieldId}-phone-error` : undefined}
            onChange={() => onFieldChange("phone")}
          />
        </FormField>
      </div>

      <FormField
        label="What do you need help with?"
        error={errors.service}
        inputId={`${fieldId}-service`}
      >
        <select
          id={`${fieldId}-service`}
          name="service"
          defaultValue="roofing"
          aria-invalid={Boolean(errors.service) || undefined}
          aria-describedby={errors.service ? `${fieldId}-service-error` : undefined}
          className="min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base text-foreground shadow-inner shadow-black/3 focus-visible:border-info focus-visible:outline-info aria-[invalid=true]:border-danger"
          onChange={() => onFieldChange("service")}
        >
          {PUBLIC_ESTIMATE_SERVICES.map((service) => (
            <option key={service.id} value={service.id}>
              {service.label}
            </option>
          ))}
        </select>
      </FormField>

      <fieldset className="space-y-3 border-t border-border pt-5">
        <legend className="sr-only">Contact and privacy consent</legend>
        <ConsentField
          id={`${fieldId}-contact-consent`}
          name="contact-consent"
          checkedError={errors.contactConsent}
          description={`I agree that ${brandCopy.shortName} may contact me about this estimate request.`}
          onChange={() => onFieldChange("contactConsent")}
        />
        <ConsentField
          id={`${fieldId}-privacy-consent`}
          name="privacy-consent"
          checkedError={errors.privacyConsent}
          description="I understand these details are used to review my request and are not a final quote."
          onChange={() => onFieldChange("privacyConsent")}
        />
      </fieldset>

      <TurnstileChallenge
        key={`${config.turnstile_site_key ?? "not-required"}:${challengeVersion}`}
        siteKey={config.turnstile_site_key}
        onTokenChange={onTurnstileToken}
        onFailure={onTurnstileFailure}
      />
      {challengeError ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {challengeError}
        </p>
      ) : null}
      {requestError ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {requestError}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="accent"
        size="field"
        fullWidth
        busy={submitting}
        disabled={isChallengePending}
      >
        {rangeAvailable ? "Request my non-binding range" : "Request estimator review"}
      </Button>
      <p className="text-xs leading-5 text-muted">{disclaimer}</p>
    </form>
  );
}

function FormField({
  label,
  hint,
  error,
  inputId,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  inputId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm font-bold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${inputId}-error`} className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-5 text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function ConsentField({
  id,
  name,
  checkedError,
  description,
  onChange,
}: {
  id: string;
  name: string;
  checkedError?: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-3 text-sm leading-6">
        <input
          id={id}
          name={name}
          type="checkbox"
          className="mt-1 size-4 rounded border-border text-accent focus-visible:outline-info"
          aria-invalid={Boolean(checkedError) || undefined}
          aria-describedby={checkedError ? `${id}-error` : undefined}
          onChange={onChange}
        />
        <span>{description}</span>
      </label>
      {checkedError ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-danger" role="alert">
          {checkedError}
        </p>
      ) : null}
    </div>
  );
}

function EstimateResult({
  brand,
  result,
  canShowRange,
  onStartAnotherRequest,
}: {
  brand: PublicEstimateBrand;
  result: PublicInstantEstimateResponse;
  canShowRange: boolean;
  onStartAnotherRequest: () => void;
}) {
  const brandCopy = PUBLIC_ESTIMATE_BRANDS[brand];
  const range = result.range;
  const hasRange = range !== null && result.review_required && canShowRange;
  return (
    <section className="mx-auto max-w-xl py-4 sm:py-10" aria-live="polite">
      <Card className="overflow-hidden">
        <div className="border-b border-border bg-ok-soft px-5 py-6 sm:px-8 sm:py-8">
          <CheckCircle2 className="size-9 text-ok" aria-hidden="true" />
          <h1 className="mt-4 text-3xl font-black tracking-[-0.045em]">
            {hasRange ? "Your non-binding budget range" : "An estimator will review your project"}
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-6 text-muted">
            {hasRange
              ? "This range is an early planning guide, not a quote or a promise of final price."
              : `We received your request. A ${brandCopy.shortName} estimator will review the property and confirm the next step.`}
          </p>
        </div>
        <CardContent className="p-5 sm:p-8">
          {hasRange ? (
            <div className="border-l-4 border-accent bg-surface px-5 py-5">
              <p className="text-xs font-bold tracking-[0.13em] text-muted">
                SERVER-REVIEWED BUDGET RANGE
              </p>
              <p className="mt-2 text-3xl font-black tracking-[-0.05em] sm:text-4xl">
                {formatCad(range.min_cad)}–{formatCad(range.max_cad)}
              </p>
              <p className="mt-1 text-sm text-muted">CAD, before estimator review.</p>
            </div>
          ) : (
            <div className="flex gap-3 border-l-4 border-info bg-info-soft px-5 py-5 text-sm leading-6">
              <ClipboardCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
              <p>
                We do not generate a range when the available information cannot support one safely.
              </p>
            </div>
          )}
          <p className="mt-6 text-sm leading-6 text-muted">{result.disclaimer}</p>
          <Button className="mt-7" variant="outline" fullWidth onClick={onStartAnotherRequest}>
            Start another request
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
