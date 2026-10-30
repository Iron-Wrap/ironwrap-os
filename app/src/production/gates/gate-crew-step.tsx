import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { newProductionScheduleKey, scheduleProductionJob } from "../production-api";
import {
  clearProductionGate,
  newProductionGateClearanceKey,
} from "../production-gate-clearance-api";
import { gateCopy } from "./gate-copy";
import type { JobGate } from "./gate-contracts";
import {
  canClearGates,
  canReverse,
  canSchedule,
  countedGates,
  depositIsContractState,
  entryInForce,
  gateView,
  scheduleHold,
  waiverStage,
} from "./gate-model";
import { gateErrorWords } from "./gate-refusals";
import { heldScheduleLabel, stampOf, type GateScreen } from "./gate-screen";
import { dayLabel, instantFromLocal } from "./gate-time";
import {
  ActionRow,
  BackToList,
  ErrorBanner,
  GateField,
  HeldButton,
  InfoBanner,
  StepLink,
} from "./gate-ui";
import { GateHistory, ReversalPanel } from "./gate-history";

/**
 * Crew (P30 frames 7 and 7b): it clears by policy when the crew is scheduled, so this step holds
 * the schedule itself. "Schedule the crew" waits for the window and every other gate; once Crew
 * is cleared, "Issue the job plan" is the next step, on the job page.
 */
export function CrewStep({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  const hold = scheduleHold(screen.model);
  const runwayJob = screen.runwayJob;
  const [crewId, setCrewId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [correction, setCorrection] = useState("");
  const [failure, setFailure] = useState<{ text: string; error: unknown }>();
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const crew = screen.crews.find((candidate) => candidate.id === crewId);
      const startAt = instantFromLocal(start, screen.timeZone);
      const endAt = end ? instantFromLocal(end, screen.timeZone) : null;
      if (!crew || !startAt || !runwayJob) throw new Error("schedule_form_incomplete");
      return await scheduleProductionJob(
        screen.session,
        {
          roofJobId: screen.jobId,
          expectedRoofJobVersion: runwayJob.version,
          crewId: crew.id,
          expectedCrewVersion: crew.version,
          scheduledStart: startAt.withOffset,
          scheduledEnd: endAt ? endAt.withOffset : null,
          supersedesAssignmentId: runwayJob.assignment ? runwayJob.assignment.id : null,
          correctionReason: runwayJob.assignment ? correction.trim() : null,
        },
        newProductionScheduleKey(),
      );
    },
    onSuccess: async () => {
      setFailure(undefined);
      await screen.refresh();
    },
    onError: async (error) => {
      setFailure({ text: gateErrorWords(error), error });
      await screen.refresh();
    },
  });

  // Frame 7b.
  if (gate.state !== "blocked") {
    const entry = entryInForce(gate);
    const crewName =
      screen.crews.find((crew) => crew.id === runwayJob?.assignment?.crew_id)?.name ??
      gateCopy.crew.crewFallback;
    const startStamp = runwayJob?.assignment?.scheduled_start
      ? stampOf(screen, runwayJob.assignment.scheduled_start)
      : null;
    const window = screen.model.cancellation_window;
    const counted = countedGates(screen.model);
    const allClear =
      window.state === "ended" && counted.every((candidate) => candidate.state !== "blocked");
    const waived = counted.filter((candidate) => gateView(candidate) === "waived").length;
    return (
      <div className="grid gap-4">
        {allClear ? (
          <InfoBanner>{gateCopy.crew.allClear(counted.length, waived)}</InfoBanner>
        ) : null}
        <GateField
          label={gateCopy.crew.field}
          value={gateCopy.crew.clearedLine(
            stampOf(screen, entry?.created_at),
            crewName,
            startStamp,
            window.state === "ended" ? dayLabel(window.last_day) : null,
          )}
        />
        <ActionRow>
          <Button asChild>
            <Link to="/jobs/$jobId" params={{ jobId: screen.jobId }}>
              {gateCopy.crew.issuePlan}
            </Link>
          </Button>
        </ActionRow>
      </div>
    );
  }

  const heldSchedule = heldScheduleLabel(screen.model);
  const ready = hold === null && canSchedule(screen.role);
  const crewReady = screen.crews.some((crew) => crew.id === crewId);
  const startAt = instantFromLocal(start, screen.timeZone);
  const endAt = end ? instantFromLocal(end, screen.timeZone) : null;
  const endInvalid = Boolean(startAt && endAt && Date.parse(endAt.iso) <= Date.parse(startAt.iso));
  const needsCorrection = Boolean(runwayJob?.assignment);
  const correctionReady = !needsCorrection || correction.trim().length >= 3;
  const formReady =
    ready && Boolean(runwayJob) && crewReady && Boolean(startAt) && !endInvalid && correctionReady;

  return (
    <div className="grid gap-4">
      <InfoBanner>{gateCopy.crew.rule}</InfoBanner>
      <GateField label={gateCopy.crew.field} value={gateCopy.crew.notYet} />
      {ready ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (formReady) mutation.mutate();
          }}
        >
          {screen.crews.length === 0 ? <InfoBanner>{gateCopy.crew.noCrews}</InfoBanner> : null}
          <Field label={gateCopy.crew.pickCrew}>
            {(control) => (
              <Select
                {...control}
                value={crewId}
                onChange={(event) => setCrewId(event.target.value)}
              >
                <option value="">{gateCopy.crew.pickCrewPlaceholder}</option>
                {screen.crews.map((crew) => (
                  <option key={crew.id} value={crew.id}>
                    {crew.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={gateCopy.crew.start}>
              {(control) => (
                <Input
                  {...control}
                  type="datetime-local"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={gateCopy.crew.end}
              help={gateCopy.crew.endHelp}
              error={endInvalid ? gateCopy.crew.endBeforeStart : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  type="datetime-local"
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              )}
            </Field>
          </div>
          {needsCorrection ? (
            <Field label={gateCopy.crew.correction}>
              {(control) => (
                <Textarea
                  {...control}
                  value={correction}
                  maxLength={1_200}
                  onChange={(event) => setCorrection(event.target.value)}
                />
              )}
            </Field>
          ) : null}
          {failure ? <ErrorBanner error={failure.error}>{failure.text}</ErrorBanner> : null}
          <ActionRow>
            <Button type="submit" busy={mutation.isPending} disabled={!formReady || screen.offline}>
              {gateCopy.schedule.action}
            </Button>
          </ActionRow>
        </form>
      ) : (
        <ActionRow>{heldSchedule ? <HeldButton label={heldSchedule} /> : null}</ActionRow>
      )}
    </div>
  );
}

/**
 * Deposit: a System state under an OD-01 contract ("No deposit under this contract"), or, where
 * the business takes deposits (MD-13), a gate that clears on the settled deposit invoice or by
 * the owner's waiver. The MD-13 step has no frame yet.
 */
export function DepositStep({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  const [failure, setFailure] = useState<{ text: string; error: unknown }>();
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await clearProductionGate(
        screen.session,
        { roofJobId: screen.jobId, gate: "Deposit", basis: "deposit_settlement" },
        newProductionGateClearanceKey(),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      await screen.refresh();
    },
    onError: (error) => setFailure({ text: gateErrorWords(error), error }),
  });

  if (depositIsContractState(gate)) {
    return (
      <div className="grid gap-4">
        <GateField
          label={gateCopy.overview.depositLabel}
          value={gateCopy.overview.depositNoDeposit}
        />
        <ActionRow>
          <BackToList jobId={screen.jobId} />
        </ActionRow>
        <GateHistory screen={screen} gate={gate} />
      </div>
    );
  }
  if (gate.state !== "blocked") {
    return (
      <div className="grid gap-4">
        {canReverse(gate, screen.role) ? (
          <ReversalPanel screen={screen} gate={gate} />
        ) : (
          <ActionRow>
            <BackToList jobId={screen.jobId} />
          </ActionRow>
        )}
        <GateHistory screen={screen} gate={gate} />
      </div>
    );
  }
  const stage = waiverStage(gate, screen.role);
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
  return (
    <div className="grid gap-4">
      <GateField label="Deposit" value={gateCopy.row.depositBlocked} required />
      <p className="text-sm leading-6 text-muted">{gateCopy.deposit.settlementHelp}</p>
      {failure ? <ErrorBanner error={failure.error}>{failure.text}</ErrorBanner> : null}
      <ActionRow>
        <Button
          type="button"
          busy={mutation.isPending}
          disabled={screen.offline}
          onClick={() => mutation.mutate()}
        >
          {gateCopy.deposit.clearOnSettlement}
        </Button>
        {stage.kind === "ask" || stage.kind === "owner_request" ? (
          <StepLink jobId={screen.jobId} step="waive-deposit" variant="secondary">
            {gateCopy.waiver.askToWaive("Deposit")}
          </StepLink>
        ) : null}
        {heldScheduleLabel(screen.model) ? (
          <HeldButton label={heldScheduleLabel(screen.model) ?? ""} />
        ) : null}
      </ActionRow>
    </div>
  );
}
