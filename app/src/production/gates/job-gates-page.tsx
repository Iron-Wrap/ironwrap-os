import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { isOfflineSession } from "../../auth/session";
import { useSession } from "../../auth/session-context";
import { RoleGuard } from "../../components/role-guard";
import { Button } from "../../components/ui/button";
import { ErrorState } from "../../components/ui/state-panel";
import { useOnlineStatus } from "../../hooks/use-online-status";
import { ApiError, apiRequest } from "../../lib/api";
import { messageForLoad } from "../../lib/plain-error";
import { jobHistoryPath, jobHistoryResponseSchema } from "../../jobs/job-history-contracts";
import { loadProductionRunway } from "../production-api";
import { jobGatesQueryKey, loadJobGates } from "./gate-api";
import { gateCopy } from "./gate-copy";
import { isAttestableGate, type JobGate } from "./gate-contracts";
import {
  canReverse,
  canRecordSignedCopy,
  entryInForce,
  gateByName,
  gateForStep,
  gateSummary,
  gateView,
  gateViewFor,
  isGateStep,
  overviewClearable,
  scheduleHold,
  gatesBeforeSchedule,
  stepForGate,
  windowHolds,
  type GateStep,
} from "./gate-model";
import {
  heldScheduleLabel,
  stampOf,
  statusStrip,
  windowRowText,
  windowStampOf,
  type GateScreen,
} from "./gate-screen";
import { AttestStep } from "./gate-attest-step";
import { CrewStep, DepositStep } from "./gate-crew-step";
import { GateHistory, ReversalPanel } from "./gate-history";
import { WaiverStep } from "./gate-waiver-step";
import { WindowStep } from "./gate-window-step";
import {
  ActionRow,
  ErrorBanner,
  GateField,
  HeldButton,
  InfoBanner,
  NextLine,
  StepLink,
} from "./gate-ui";
import { proseTime } from "./gate-time";

/**
 * A job's gates and its cancellation window (P30 frames 1-23): the overview lists every gate and
 * the window, and each row opens its step. Who may do what is the Worker's call; this page only
 * draws the controls a person may use and says what each held control waits for.
 */
export function JobGatesPage({ jobId, step }: { jobId: string; step?: string }) {
  return (
    <RoleGuard surface="production">
      <JobGatesContent jobId={jobId} step={isGateStep(step) ? step : undefined} />
    </RoleGuard>
  );
}

function JobGatesContent({ jobId, step }: { jobId: string; step?: GateStep }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const gatesKey = jobGatesQueryKey(session.tenant.id, session.user.id, jobId);
  const gates = useQuery({ queryKey: gatesKey, queryFn: () => loadJobGates(jobId) });
  const runway = useQuery({
    queryKey: ["production-runway", session.tenant.id, session.user.id],
    queryFn: () => loadProductionRunway(),
  });
  const history = useQuery({
    queryKey: ["job-gates-identity", session.tenant.id, session.user.id, jobId],
    queryFn: () => apiRequest({ path: jobHistoryPath(jobId), schema: jobHistoryResponseSchema }),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: gatesKey }),
      queryClient.invalidateQueries({ queryKey: ["production-runway"] }),
    ]);
  }, [queryClient, gatesKey]);

  if (gates.isError || !gates.data) {
    if (gates.isError) {
      const notFound = gates.error instanceof ApiError && gates.error.status === 404;
      return (
        <section className="mx-auto max-w-3xl">
          <ErrorState
            title={
              gates.data
                ? gateCopy.page.readbackFailed
                : notFound
                  ? gateCopy.page.notFound
                  : gateCopy.page.loadFailed
            }
            message={messageForLoad(gates.error)}
            error={gates.error}
            action={
              <Button type="button" variant="secondary" onClick={() => void gates.refetch()}>
                {gateCopy.page.retry}
              </Button>
            }
          />
        </section>
      );
    }
    return (
      <section className="mx-auto max-w-3xl" aria-busy="true">
        <p className="text-sm text-muted">{gateCopy.page.loading}</p>
      </section>
    );
  }

  const runwayJob = runway.data?.jobs.find((job) => job.id === jobId) ?? null;
  const customer = history.data?.customer?.display_name?.trim() || null;
  const street = history.data?.job.address?.split(",")[0]?.trim() || null;
  const identity = [customer, street].filter((part): part is string => Boolean(part)).join(" · ");
  const screen: GateScreen = {
    jobId,
    model: gates.data,
    runwayJob,
    crews: runway.data?.crews ?? [],
    customerName: customer ?? gateCopy.page.customerFallback,
    jobLabel: identity || runwayJob?.job_number || gateCopy.page.jobFallback,
    session,
    role: session.user.role,
    now: new Date(),
    timeZone: session.tenant.time_zone,
    offline: isOfflineSession(session),
    refresh,
  };
  return <GatesScreen screen={screen} step={step} />;
}

export function GatesScreen({
  screen: loadedScreen,
  step,
}: {
  screen: GateScreen;
  step?: GateStep;
}) {
  const online = useOnlineStatus();
  const screen = { ...loadedScreen, offline: loadedScreen.offline || !online };
  const gateName = step ? gateForStep(step) : null;
  const gate = gateName ? gateByName(screen.model, gateName) : null;
  const title = !step
    ? gateCopy.page.gatesCrumb
    : step === "window"
      ? gateCopy.page.windowCrumb
      : step.startsWith("waive-") && gateName
        ? gateCopy.page.waiveCrumb(gateName)
        : (gateName ?? gateCopy.page.gatesCrumb);
  return (
    <section className="mx-auto grid max-w-3xl gap-5 pb-6">
      <Header screen={screen} title={title} step={step} />
      {!step ? (
        <Overview screen={screen} />
      ) : step === "window" ? (
        <WindowStep screen={screen} />
      ) : !gate ? (
        <ErrorBanner>{gateCopy.page.notFound}</ErrorBanner>
      ) : step.startsWith("waive-") ? (
        <WaiverStep screen={screen} gate={gate} />
      ) : (
        <GateStepBody screen={screen} gate={gate} />
      )}
    </section>
  );
}

function Header({ screen, title, step }: { screen: GateScreen; title: string; step?: GateStep }) {
  const strip = statusStrip(screen);
  const cw = screen.model.cancellation_window;
  const recordStep = step === "window" && cw.state === "unknown" && cw.contract;
  return (
    <header className="grid gap-2">
      <nav aria-label="Breadcrumb" className="text-sm font-semibold text-muted">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link to="/production" className="underline-offset-4 hover:underline">
              {gateCopy.page.breadcrumbRoot}
            </Link>
          </li>
          <Crumb>
            {step ? (
              <Link
                to="/production/jobs/$jobId/gates"
                params={{ jobId: screen.jobId }}
                search={{}}
                className="underline-offset-4 hover:underline"
              >
                {screen.jobLabel}
              </Link>
            ) : (
              screen.jobLabel
            )}
          </Crumb>
          <Crumb>
            <span aria-current="page">{title}</span>
          </Crumb>
        </ol>
      </nav>
      <h1 className="text-2xl leading-[1.15] font-[640] tracking-[-0.018em]">{title}</h1>
      <div className="grid gap-0.5 text-sm leading-6 text-muted">
        <p className="font-semibold text-foreground">{screen.jobLabel}</p>
        {step ? (
          <>
            <p>{strip.window}</p>
            <p>
              {recordStep && cw.contract
                ? gateCopy.strip.contractSigned(windowStampOf(screen, cw.contract.signed_at))
                : strip.gates}
            </p>
          </>
        ) : (
          <p>{gateCopy.overview.summary(gateSummary(screen.model))}</p>
        )}
      </div>
    </header>
  );
}

function Crumb({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <ChevronRight className="size-3.5" aria-hidden="true" />
      {children}
    </li>
  );
}

/** The row text of a gate in the overview (frames 1 and 12). */
function rowText(screen: GateScreen, gate: JobGate): { text: string; required: boolean } {
  const view = gateViewFor(gate, screen.role);
  const ended = !windowHolds(screen.model.cancellation_window);
  const entry = entryInForce(gate);
  switch (view) {
    case "not_a_gate":
      return { text: gateCopy.overview.depositNoDeposit, required: false };
    case "cleared":
      return {
        text: gateCopy.row.cleared(stampOf(screen, entry?.created_at)).trim(),
        required: false,
      };
    case "waived":
      return {
        text: gateCopy.row.waived(stampOf(screen, entry?.created_at)).trim(),
        required: false,
      };
    case "waiting_on_owner":
      return { text: gateCopy.row.waitingOnOwner, required: false };
    case "waiting_on_you":
      return { text: gateCopy.row.waitingOnYou, required: false };
    case "crew_waiting":
      return {
        text: ended ? gateCopy.row.crewWaitingLong : gateCopy.row.crewWaiting,
        required: false,
      };
    default:
      break;
  }
  switch (gate.gate) {
    case "Materials":
      return {
        text: ended ? gateCopy.row.materialsBlocked : gateCopy.row.materialsHeld,
        required: true,
      };
    case "Safety":
      return {
        text: ended ? gateCopy.row.safetyBlockedLong : gateCopy.row.safetyBlocked,
        required: true,
      };
    case "Access":
      return { text: gateCopy.row.accessBlocked, required: true };
    case "Weather":
      return {
        text: ended ? gateCopy.row.weatherBlockedLong : gateCopy.row.weatherBlocked,
        required: true,
      };
    case "Deposit":
      return { text: gateCopy.row.depositBlocked, required: true };
    default:
      return { text: gateCopy.row.crewWaiting, required: false };
  }
}

function Overview({ screen }: { screen: GateScreen }) {
  const model = screen.model;
  const cw = model.cancellation_window;
  const holds = windowHolds(cw);
  const clearable = overviewClearable(model, screen.role);
  const recordable = cw.state === "unknown" && canRecordSignedCopy(screen.role);
  const hold = scheduleHold(model);
  const heldSchedule = heldScheduleLabel(model);
  const blockedBeforeSchedule = gatesBeforeSchedule(model);
  const waivableBlocked = model.gates.some(
    (gate) =>
      (gate.gate === "Deposit" || gate.gate === "Materials" || gate.gate === "Access") &&
      gateView(gate) === "blocked",
  );
  const unwaivableBlocked = model.gates.some(
    (gate) => (gate.gate === "Safety" || gate.gate === "Weather") && gate.state === "blocked",
  );
  const showNotWaivable = !holds && !waivableBlocked && unwaivableBlocked;
  const deposit = gateByName(model, "Deposit");
  const shownAt =
    cw.unknown_reason === "signed_copy_unconfirmed" && cw.signed_copy_shown
      ? windowStampOf(screen, cw.signed_copy_shown.shown_at)
      : null;

  let next: string | null = null;
  if (cw.state === "unknown" && recordable) next = gateCopy.window.nextAfterAdd;
  else if (holds) next = gateCopy.overview.nextScheduleWindowAndGates(blockedBeforeSchedule.length);
  else if (hold?.kind === "gates") next = gateCopy.overview.nextScheduleGates(hold.gates);

  const controls: ReactNode[] = [];
  if (recordable) {
    controls.push(
      <StepLink key="record" jobId={screen.jobId} step="window">
        {gateCopy.window.addReceived(screen.customerName)}
      </StepLink>,
    );
  } else {
    clearable.forEach((name, index) => {
      controls.push(
        <StepLink
          key={name}
          jobId={screen.jobId}
          step={stepForGate(name)}
          variant={index === 0 ? "primary" : "secondary"}
        >
          {gateCopy.overview.clear(name)}
        </StepLink>,
      );
    });
  }
  if (heldSchedule) {
    controls.push(<HeldButton key="schedule" label={heldSchedule} />);
  } else if (hold === null) {
    controls.push(
      <StepLink
        key="schedule"
        jobId={screen.jobId}
        step="crew"
        variant={controls.length === 0 ? "primary" : "secondary"}
      >
        {gateCopy.overview.schedule}
      </StepLink>,
    );
  }

  return (
    <div className="grid gap-4">
      {cw.state === "unknown" ? (
        <ErrorBanner>
          {gateCopy.window.unknownBanner(screen.customerName, cw.unknown_reason, shownAt)}
        </ErrorBanner>
      ) : null}
      {cw.state === "unknown" && !recordable ? (
        <InfoBanner>{gateCopy.window.askOwnerOrOps(screen.customerName)}</InfoBanner>
      ) : null}
      {showNotWaivable ? <InfoBanner>{gateCopy.overview.notWaivable}</InfoBanner> : null}
      <ul className="grid gap-3">
        <li>
          <GateField
            label={gateCopy.overview.windowLabel}
            value={windowRowText(screen)}
            to={{ jobId: screen.jobId, step: "window" }}
          />
        </li>
        {deposit && gateView(deposit) === "not_a_gate" ? (
          <li>
            <GateField
              label={gateCopy.overview.depositLabel}
              value={gateCopy.overview.depositNoDeposit}
            />
          </li>
        ) : null}
        {model.gates
          .filter((gate) => gateView(gate) !== "not_a_gate")
          .map((gate) => {
            const row = rowText(screen, gate);
            return (
              <li key={gate.gate}>
                <GateField
                  label={gate.gate}
                  value={row.text}
                  to={{ jobId: screen.jobId, step: stepForGate(gate.gate) }}
                />
              </li>
            );
          })}
      </ul>
      {controls.length > 0 ? <ActionRow>{controls}</ActionRow> : null}
      {next ? <NextLine>{next}</NextLine> : null}
    </div>
  );
}

/** A gate's own step: its proof form, its waiver, its reversal, or Crew's schedule. */
function GateStepBody({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  if (gate.gate === "Crew") return <CrewStep screen={screen} gate={gate} />;
  if (gate.gate === "Deposit") return <DepositStep screen={screen} gate={gate} />;
  const view = gateView(gate);
  if (view === "waiting_on_owner" || view === "waiting_on_you") {
    return <WaiverStep screen={screen} gate={gate} />;
  }
  if (gate.state !== "blocked") {
    return (
      <div className="grid gap-4">
        {canReverse(gate, screen.role) ? (
          <ReversalPanel screen={screen} gate={gate} />
        ) : (
          <>
            <GateField label={gate.gate} value={rowText(screen, gate).text} />
            <ActionRow>
              <StepLink jobId={screen.jobId}>{gateCopy.page.backToList}</StepLink>
            </ActionRow>
            <GateHistory screen={screen} gate={gate} />
          </>
        )}
      </div>
    );
  }
  const latest = gate.entries[gate.entries.length - 1];
  if (latest?.kind === "reverse" && isAttestableGate(gate.gate)) {
    return <ReversedGate screen={screen} gate={gate as JobGate & { gate: typeof gate.gate }} />;
  }
  if (isAttestableGate(gate.gate)) {
    return <AttestStep screen={screen} gate={gate as JobGate & { gate: typeof gate.gate }} />;
  }
  return null;
}

/** Frame 13: a reversed clearance, with its history, and the way to clear it again. */
function ReversedGate({
  screen,
  gate,
}: {
  screen: GateScreen;
  gate: JobGate & { gate: "Materials" | "Safety" | "Access" | "Weather" };
}) {
  const [clearing, setClearing] = useState(false);
  if (clearing) return <AttestStep screen={screen} gate={gate} />;
  const latest = gate.entries[gate.entries.length - 1]!;
  const when = proseTime(latest.created_at, { timeZone: screen.timeZone, now: screen.now }) ?? "";
  const heldSchedule = heldScheduleLabel(screen.model);
  return (
    <div className="grid gap-4">
      <InfoBanner>{gateCopy.reversal.reversed(when, gate.gate)}</InfoBanner>
      <GateHistory screen={screen} gate={gate} />
      <ActionRow>
        <Button type="button" onClick={() => setClearing(true)}>
          {gateCopy.reversal.rightProof(gate.gate)}
        </Button>
        {heldSchedule ? <HeldButton label={heldSchedule} /> : null}
      </ActionRow>
      <NextLine>{gateCopy.schedule.nextStaysOff(gatesBeforeSchedule(screen.model))}</NextLine>
    </div>
  );
}
