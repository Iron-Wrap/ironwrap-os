import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { roleCanAccess } from "../../lib/roles";
import { attestGate, newGateKey } from "./gate-api";
import { gateCopy, held } from "./gate-copy";
import {
  FORECAST_SOURCE_PATTERN,
  MAX_NOTE_LENGTH,
  PERMIT_NUMBER_PATTERN,
  REFERENCE_PATTERN,
  type AttestableGate,
  type GateAttestation,
  type JobGate,
} from "./gate-contracts";
import { attestationFrom, emptyForm, type FormState } from "./gate-form";
import { attestationHold, canClearGates, waiveStepFor } from "./gate-model";
import { gateRefusal, type GateRefusal } from "./gate-refusals";
import {
  heldScheduleLabel,
  nextAfterGate,
  stampOf,
  windowHoldText,
  type GateScreen,
} from "./gate-screen";
import { dayLabel, instantFromLocal, localInputValue, spanDays } from "./gate-time";
import {
  ActionRow,
  BackToList,
  ErrorBanner,
  GateField,
  HeldButton,
  InfoBanner,
  NextLine,
  StepLink,
} from "./gate-ui";

/**
 * The proof forms of the four attestable gates (P30 frames 3-6) and the refusals each one is
 * drawn as (frames 2, 11, 14-18). A refused proof keeps what the person typed; the one control
 * that fixes it is the primary, and "Clear … with this proof" waits, saying for what.
 */

export function AttestStep({
  screen,
  gate,
}: {
  screen: GateScreen;
  gate: JobGate & { gate: AttestableGate };
}) {
  const name = gate.gate;
  const [form, setForm] = useState<FormState>(emptyForm);
  const [refusal, setRefusal] = useState<GateRefusal | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);
  const mutation = useMutation({
    retry: false,
    mutationFn: async (attestation: GateAttestation) =>
      await attestGate(
        screen.session,
        { jobId: screen.jobId, gate: name, expectedGateVersion: gate.version, attestation },
        newGateKey("attestation"),
      ),
    onSuccess: async () => {
      setRefusal(null);
      await screen.refresh();
    },
    onError: async (error) => {
      const next = gateRefusal(error);
      setRefusal(next);
      if (next.kind === "window_held") await screen.refresh();
    },
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const focusLater = (id: string) =>
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-focus="${id}"]`);
      target?.focus();
      focusRef.current = target;
    }, 0);

  const heldSchedule = heldScheduleLabel(screen.model);
  const scheduleControl = heldSchedule ? <HeldButton label={heldSchedule} /> : null;

  // Frame 2: Materials waits for the window, whatever the form says.
  if (attestationHold(screen.model, name) === "window") {
    return (
      <div className="grid gap-4">
        <InfoBanner>{gateCopy.materials.canStillCancel(screen.customerName)}</InfoBanner>
        <GateField label={gateCopy.window.holdsField} value={windowHoldText(screen)} />
        <ActionRow>
          <HeldButton
            label={held(gateCopy.materials.clearWithProof, gateCopy.window.afterWindow)}
          />
          <BackToList jobId={screen.jobId} />
        </ActionRow>
        <NextLine>{gateCopy.materials.nextHeld}</NextLine>
      </div>
    );
  }

  if (!canClearGates(screen.role)) {
    return (
      <div className="grid gap-4">
        <InfoBanner>{gateCopy.overview.readOnly}</InfoBanner>
        <ActionRow>
          <BackToList jobId={screen.jobId} />
        </ActionRow>
      </div>
    );
  }

  const attestation = attestationFrom(name, form, screen.timeZone);
  const clearLabel = clearWithProofLabel(name);
  const submit = () => {
    if (attestation) mutation.mutate(attestation);
  };

  if (refusal && refusal.kind !== "message" && refusal.kind !== "window_held") {
    return (
      <RefusalView
        screen={screen}
        gate={name}
        form={form}
        refusal={refusal}
        scheduleControl={scheduleControl}
        onFix={(focusId, reset) => {
          if (reset) setForm((current) => ({ ...current, ...reset }));
          setRefusal(null);
          if (focusId) focusLater(focusId);
        }}
      />
    );
  }

  const waiveStep = waiveStepFor(name);
  const ids = fieldIds(gate.gate);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {name === "Safety" ? <InfoBanner>{gateCopy.safety.whoClears}</InfoBanner> : null}
      {name === "Weather" ? <InfoBanner>{gateCopy.weather.rule}</InfoBanner> : null}
      <GateFormFields gate={name} form={form} set={set} ids={ids} timeZone={screen.timeZone} />
      {refusal?.kind === "message" ? (
        <ErrorBanner error={refusal.error}>{refusal.text}</ErrorBanner>
      ) : null}
      <ActionRow>
        <Button type="submit" busy={mutation.isPending} disabled={!attestation || screen.offline}>
          {clearLabel}
        </Button>
        {waiveStep ? (
          <StepLink jobId={screen.jobId} step={waiveStep} variant="secondary">
            {gateCopy.waiver.askToWaive(name)}
          </StepLink>
        ) : null}
        {scheduleControl}
      </ActionRow>
      {screen.offline ? <p className="text-sm text-muted">{gateCopy.page.offline}</p> : null}
      <NextLine>{nextAfterGate(screen.model, name)}</NextLine>
    </form>
  );
}

function clearWithProofLabel(gate: AttestableGate): string {
  switch (gate) {
    case "Materials":
      return gateCopy.materials.clearWithProof;
    case "Safety":
      return gateCopy.safety.clearWithProof;
    case "Access":
      return gateCopy.access.clearWithProof;
    default:
      return gateCopy.weather.clearWithProof;
  }
}

function fieldIds(gate: AttestableGate) {
  const base = `gate-${gate.toLowerCase()}`;
  return {
    supplier: `${base}-supplier`,
    reference: `${base}-reference`,
    hazard: `${base}-hazard`,
    assessedAt: `${base}-assessed-at`,
    permit: `${base}-permit`,
    permitNumber: `${base}-permit-number`,
    fall: `${base}-fall`,
    fallPlan: `${base}-fall-plan`,
    confirmedWith: `${base}-confirmed-with`,
    confirmedAt: `${base}-confirmed-at`,
    windowStart: `${base}-window-start`,
    forecastAt: `${base}-forecast-at`,
  };
}

type FieldIds = ReturnType<typeof fieldIds>;

function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  id,
}: {
  legend: string;
  name: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id: string;
}) {
  return (
    <fieldset className="grid gap-2" data-focus={id} tabIndex={-1}>
      <legend className="mb-1.5 text-[length:var(--type-label-size)] font-semibold">
        {legend}
      </legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--control-radius)] border border-control-border px-3"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="size-4"
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function GateFormFields({
  gate,
  form,
  set,
  ids,
  timeZone,
}: {
  gate: AttestableGate;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  ids: FieldIds;
  timeZone: string;
}) {
  if (gate === "Materials") {
    const referenceTyped = form.reference.trim();
    return (
      <>
        <Field label={gateCopy.materials.supplier} help={gateCopy.materials.supplierHelp}>
          {(control) => (
            <Input
              {...control}
              data-focus={ids.supplier}
              value={form.supplier}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => set("supplier", event.target.value)}
            />
          )}
        </Field>
        <Field
          label={gateCopy.materials.reference}
          help={gateCopy.materials.referenceHelp}
          error={
            referenceTyped && !REFERENCE_PATTERN.test(referenceTyped)
              ? gateCopy.materials.referenceInvalid
              : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              data-focus={ids.reference}
              value={form.reference}
              maxLength={80}
              onChange={(event) => set("reference", event.target.value)}
            />
          )}
        </Field>
      </>
    );
  }
  if (gate === "Access") {
    return (
      <>
        <Choice
          legend={gateCopy.access.whoLegend}
          name="access-confirmed-with"
          id={ids.confirmedWith}
          value={form.confirmedWith}
          onChange={(value) => set("confirmedWith", value)}
          options={[
            { value: "customer", label: gateCopy.access.customer },
            { value: "property_manager", label: gateCopy.access.propertyManager },
            { value: "not_needed", label: gateCopy.access.notNeeded },
          ]}
        />
        <Field label={gateCopy.access.when}>
          {(control) => (
            <Input
              {...control}
              data-focus={ids.confirmedAt}
              type="datetime-local"
              value={form.confirmedAt}
              onChange={(event) => set("confirmedAt", event.target.value)}
            />
          )}
        </Field>
        <Field label={gateCopy.access.what}>
          {(control) => (
            <Textarea
              {...control}
              value={form.accessNote}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => set("accessNote", event.target.value)}
            />
          )}
        </Field>
      </>
    );
  }
  if (gate === "Weather") {
    const start = instantFromLocal(form.windowStart, timeZone)?.iso ?? null;
    const end = instantFromLocal(form.windowEnd, timeZone)?.iso ?? null;
    const days = start && end ? spanDays(start, end, timeZone) : null;
    const source = form.forecastSource.trim();
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={gateCopy.weather.windowStart}>
            {(control) => (
              <Input
                {...control}
                data-focus={ids.windowStart}
                type="datetime-local"
                value={form.windowStart}
                onChange={(event) => set("windowStart", event.target.value)}
              />
            )}
          </Field>
          <Field label={gateCopy.weather.windowEnd}>
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                value={form.windowEnd}
                onChange={(event) => set("windowEnd", event.target.value)}
              />
            )}
          </Field>
        </div>
        {start && end && days ? (
          <p className="text-sm font-semibold" aria-live="polite">
            {gateCopy.weather.windowSummary(
              shortStamp(start, timeZone),
              shortStamp(end, timeZone),
              days,
            )}
          </p>
        ) : null}
        <Field label={gateCopy.weather.forecast} help={gateCopy.weather.forecastHelp}>
          {(control) => (
            <Input
              {...control}
              value={form.forecast}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => set("forecast", event.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={gateCopy.weather.forecastRead}>
            {(control) => (
              <Input
                {...control}
                data-focus={ids.forecastAt}
                type="datetime-local"
                value={form.forecastAt}
                onChange={(event) => set("forecastAt", event.target.value)}
              />
            )}
          </Field>
          <Field
            label={gateCopy.weather.forecastSource}
            help={gateCopy.weather.forecastSourceHelp}
            error={
              source && !FORECAST_SOURCE_PATTERN.test(source)
                ? gateCopy.weather.forecastSourceInvalid
                : undefined
            }
          >
            {(control) => (
              <Input
                {...control}
                value={form.forecastSource}
                maxLength={64}
                onChange={(event) => set("forecastSource", event.target.value)}
              />
            )}
          </Field>
        </div>
      </>
    );
  }
  const number = form.permitNumber.trim();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={gateCopy.safety.hazard} help={gateCopy.safety.hazardHelp}>
          {(control) => (
            <Input
              {...control}
              data-focus={ids.hazard}
              value={form.hazardRef}
              maxLength={80}
              onChange={(event) => set("hazardRef", event.target.value)}
            />
          )}
        </Field>
        <Field label={gateCopy.safety.assessedAt}>
          {(control) => (
            <Input
              {...control}
              data-focus={ids.assessedAt}
              type="datetime-local"
              value={form.assessedAt}
              onChange={(event) => set("assessedAt", event.target.value)}
            />
          )}
        </Field>
      </div>
      <Choice
        legend={gateCopy.safety.permitLegend}
        name="safety-permit"
        id={ids.permit}
        value={form.permit}
        onChange={(value) => set("permit", value)}
        options={[
          { value: "needed_and_held", label: gateCopy.safety.permitHeld },
          { value: "not_needed", label: gateCopy.safety.permitNotNeeded },
          { value: "unknown", label: gateCopy.safety.permitUnknown },
        ]}
      />
      {form.permit === "needed_and_held" ? (
        <Field
          label={gateCopy.safety.permitNumber}
          help={gateCopy.safety.permitNumberHelp}
          error={
            number && !PERMIT_NUMBER_PATTERN.test(number.replace(/\s+/g, " "))
              ? gateCopy.safety.permitNumberInvalid
              : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              data-focus={ids.permitNumber}
              value={form.permitNumber}
              maxLength={80}
              onChange={(event) => set("permitNumber", event.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Choice
        legend={gateCopy.safety.fallLegend}
        name="safety-fall"
        id={ids.fall}
        value={form.fall}
        onChange={(value) => set("fall", value)}
        options={[
          { value: "plan", label: gateCopy.safety.fallPlan },
          { value: "no_exposure", label: gateCopy.safety.fallNoExposure },
        ]}
      />
      {form.fall === "plan" ? (
        <Field label={gateCopy.safety.fallPlanRef} help={gateCopy.safety.fallPlanHelp}>
          {(control) => (
            <Input
              {...control}
              data-focus={ids.fallPlan}
              value={form.fallPlanRef}
              maxLength={80}
              onChange={(event) => set("fallPlanRef", event.target.value)}
            />
          )}
        </Field>
      ) : null}
    </>
  );
}

function shortStamp(iso: string, timeZone: string): string {
  const local = localInputValue(iso, timeZone);
  const day = dayLabel(local.slice(0, 10)) ?? local.slice(0, 10);
  return `${day} ${local.slice(11, 16)}`;
}

/** Frames 11, 14, 15, 16, 17 and 18: the refused proof, the one fix, the held clear. */
function RefusalView({
  screen,
  gate,
  form,
  refusal,
  scheduleControl,
  onFix,
}: {
  screen: GateScreen;
  gate: AttestableGate;
  form: FormState;
  refusal: Exclude<GateRefusal, { kind: "message" } | { kind: "window_held" }>;
  scheduleControl: ReactNode;
  onFix: (focusId: string | null, reset?: Partial<FormState>) => void;
}) {
  const ids = fieldIds(gate);
  const clearLabel = clearWithProofLabel(gate);
  const officeReach = (surface: "people" | "safety" | "inventory") =>
    roleCanAccess(screen.role, surface === "people" ? "authority" : surface);
  const hazardValue = form.hazardRef
    ? `${form.hazardRef}${
        form.assessedAt
          ? ` · ${stampOf(screen, instantFromLocal(form.assessedAt, screen.timeZone)?.iso)}`
          : ""
      }`
    : "";
  const facts: ReactNode[] = [];
  if (gate === "Safety" && hazardValue) {
    facts.push(<GateField key="hazard" label={gateCopy.safety.hazard} value={hazardValue} />);
  }

  let title: string;
  let primary: ReactNode;
  let heldAfter: string;
  let next: string;
  switch (refusal.kind) {
    case "permit_unknown":
      facts.push(
        <GateField
          key="permit"
          label={gateCopy.safety.permitLegend}
          value={gateCopy.safety.permitUnknownValue}
          required
        />,
      );
      title = gateCopy.safety.permitUnknownTitle;
      primary = (
        <Button type="button" onClick={() => onFix(ids.permit, { permit: null })}>
          {gateCopy.safety.changePermit}
        </Button>
      );
      heldAfter = gateCopy.safety.afterPermit;
      next = gateCopy.safety.nextPermit;
      break;
    case "on_crew":
      title = gateCopy.onCrew.title(gate);
      primary = <BackToList jobId={screen.jobId} />;
      heldAfter = gateCopy.onCrew.after;
      next = gateCopy.onCrew.next(gate);
      break;
    case "competency":
      title = gateCopy.safety.competencyTitle;
      primary = officeReach("people") ? (
        <Button asChild>
          <Link to="/people">{gateCopy.safety.addCompetency}</Link>
        </Button>
      ) : (
        <BackToList jobId={screen.jobId} />
      );
      heldAfter = gateCopy.safety.afterCompetency;
      next = gateCopy.safety.nextCompetency;
      if (!officeReach("people")) {
        facts.push(<InfoBanner key="ask">{gateCopy.safety.askCompetency}</InfoBanner>);
      }
      break;
    case "stop":
      title =
        refusal.variant === "job_unknown"
          ? gateCopy.safety.stopJobUnknownTitle
          : refusal.variant === "plan_unknown"
            ? gateCopy.safety.stopPlanUnknownTitle
            : gateCopy.safety.stopTitle;
      primary = officeReach("safety") ? (
        <Button asChild>
          <Link to="/safety">{gateCopy.safety.seeStop}</Link>
        </Button>
      ) : (
        <BackToList jobId={screen.jobId} />
      );
      heldAfter = gateCopy.safety.afterStop;
      next = gateCopy.safety.nextStop;
      break;
    case "material_problem":
      title = gateCopy.materials.problemTitle;
      primary = officeReach("inventory") ? (
        <Button asChild>
          <Link to="/inventory">{gateCopy.materials.seeProblem}</Link>
        </Button>
      ) : (
        <BackToList jobId={screen.jobId} />
      );
      heldAfter = gateCopy.materials.afterProblem;
      next = gateCopy.materials.nextProblem;
      break;
    case "forecast_stale": {
      const read = instantFromLocal(form.forecastAt, screen.timeZone)?.iso ?? null;
      const day = read ? (dayLabel(localInputValue(read, screen.timeZone).slice(0, 10)) ?? "") : "";
      facts.push(
        <GateField
          key="forecast"
          label={gateCopy.weather.forecast}
          value={`${form.forecast ? `${form.forecast} · ` : ""}${stampOf(screen, read)}`}
          required
        />,
      );
      title = gateCopy.weather.staleTitle(day);
      primary = (
        <Button type="button" onClick={() => onFix(ids.forecastAt, { forecastAt: "" })}>
          {gateCopy.weather.addForecast}
        </Button>
      );
      heldAfter = gateCopy.weather.afterForecast;
      next = gateCopy.weather.nextForecast;
      break;
    }
    case "weather_window_invalid":
      title = gateCopy.weather.windowInvalidTitle;
      primary = (
        <Button type="button" onClick={() => onFix(ids.windowStart)}>
          {gateCopy.weather.changeWindow}
        </Button>
      );
      heldAfter = gateCopy.weather.afterForecast;
      next = gateCopy.weather.nextForecast;
      break;
    case "not_waivable":
    case "waiver_requested":
    default:
      title = gateCopy.overview.notWaivable;
      primary = <BackToList jobId={screen.jobId} />;
      heldAfter = gateCopy.window.afterWindow;
      next = nextAfterGate(screen.model, gate);
      break;
  }
  return (
    <div className="grid gap-4">
      {facts}
      <ErrorBanner>{title}</ErrorBanner>
      <ActionRow>
        {primary}
        <HeldButton label={held(clearLabel, heldAfter)} />
        {refusal.kind === "on_crew" ? null : scheduleControl}
      </ActionRow>
      <NextLine>{next}</NextLine>
    </div>
  );
}
