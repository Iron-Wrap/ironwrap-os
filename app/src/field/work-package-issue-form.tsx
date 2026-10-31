import { Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import {
  useState,
  type Dispatch,
  type FormEvent,
  type InputHTMLAttributes,
  type SetStateAction,
} from "react";

import type { AuthenticatedSession } from "../auth/session";
import { isOfflineSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useOnlineStatus } from "../hooks/use-online-status";
import { apiCommand } from "../lib/api";
import type { JobResponse } from "./field-contracts";
import { messageFor } from "../lib/plain-error";
import { formatFieldStamp } from "./field-formatting";
import { firstCrewReview } from "./job-plan-status";

type WorkPackage = JobResponse["packet"]["work_package"];

/**
 * A1: the one refusal a reload of the job fixes, so it is the one that carries Reload job. It names
 * the issue button by the words that button shows right then.
 */
function reloadToIssue(issueLabel: string): string {
  return `Nothing was issued. Reload the job while online so it has the latest crew assignment, then tap ${issueLabel}.`;
}

interface StepDraft {
  key: string;
  instruction: string;
  requiredEvidence: string;
  acceptanceCriteria: string;
}

interface HoldDraft {
  key: string;
  holdPoint: string;
  releasePhase: "Pre-start" | "In-process" | "Completion";
  releaseAuthority: string;
  requiredEvidence: string;
  acceptanceCriteria: string;
}

export function WorkPackageIssueForm({
  session,
  assignment,
  workPackage,
  endpoint,
  allowed,
  offline,
  readAt,
  issuedVersion,
  onIssuedVersionChange,
  onIssued,
  onReload,
}: {
  session: AuthenticatedSession;
  assignment: JobResponse["assignment"];
  workPackage: WorkPackage;
  endpoint: string;
  allowed: boolean;
  offline: boolean;
  /** When the server made the job read: expiry is judged by this clock, never the device's. */
  readAt: string;
  /**
   * The version this person issued from this page, held by the page: a first issue swaps the
   * empty state for the plan, which remounts this form, and the issued line must outlive that.
   */
  issuedVersion: number | null;
  onIssuedVersionChange: (version: number | null) => void;
  /** Reads the job again after an issue, so the page shows the plan the crew now gets. */
  onIssued: () => Promise<void>;
  /** Reads the job again: the page's own refetch of this packet. */
  onReload: () => Promise<void>;
}) {
  const [title, setTitle] = useState(workPackage?.title ?? "");
  const [objective, setObjective] = useState(workPackage?.objective ?? "");
  const [boundaries, setBoundaries] = useState(workPackage?.boundaries ?? "");
  const [prerequisites, setPrerequisites] = useState(workPackage?.prerequisites ?? "");
  const [expectedResult, setExpectedResult] = useState(workPackage?.expected_result ?? "");
  const [stopConditions, setStopConditions] = useState(workPackage?.stop_conditions ?? "");
  const [makeSafeProcedure, setMakeSafeProcedure] = useState(
    workPackage?.make_safe_procedure ?? "",
  );
  const [correctionReason, setCorrectionReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>(
    workPackage?.steps.map((step) => ({
      key: `step-${step.sequence}`,
      instruction: step.instruction,
      requiredEvidence: step.required_evidence,
      acceptanceCriteria: step.acceptance_criteria,
    })) ?? [blankStep()],
  );
  const [holds, setHolds] = useState<HoldDraft[]>(
    workPackage?.hold_points.map((hold) => ({
      key: `hold-${hold.sequence}`,
      holdPoint: hold.hold_point,
      releasePhase: hold.release_phase,
      releaseAuthority: hold.release_authority,
      requiredEvidence: hold.required_evidence,
      acceptanceCriteria: hold.acceptance_criteria,
    })) ?? [blankHold()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A1 is showing: the line is written at render, so it names the button as it reads now. */
  const [reloadOffered, setReloadOffered] = useState(false);
  const [reloading, setReloading] = useState(false);

  const connected = useOnlineStatus();

  if (!allowed) return null;
  const assignmentModified = assignment?.modified ?? null;
  const canSend =
    Boolean(assignment && assignmentModified) &&
    !offline &&
    navigator.onLine &&
    !isOfflineSession(session);
  const blocked = workPackage?.status === "Blocked";
  const nextVersion = workPackage ? workPackage.version + 1 : 1;
  const scheduledEnd = assignment?.scheduled_end;
  const lastWorkDay =
    scheduledEnd && Number.isFinite(Date.parse(scheduledEnd)) ? scheduledEnd : null;
  const online = connected && !offline && navigator.onLine;
  const issued = issuedVersion !== null;
  const officeDates = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  // A crew phone sending I reviewed this plan turns the plan Acknowledged, and Start keeps that
  // review on record. Only for the plan this person issued, and only then, may the line say so.
  const issuedPlan = issued && workPackage?.version === issuedVersion ? workPackage : null;
  const reviewedAt = issuedPlan ? firstCrewReview(issuedPlan) : null;
  const crewReviewed =
    issuedPlan !== null &&
    (issuedPlan.status === "Acknowledged" ||
      issuedPlan.status === "In Progress" ||
      reviewedAt !== null);
  // Past its expiry by the server's clock at this read: the crew can no longer add proof to it.
  const expired =
    workPackage !== null &&
    Number.isFinite(Date.parse(readAt)) &&
    Number.isFinite(Date.parse(workPackage.expires_at)) &&
    Date.parse(workPackage.expires_at) <= Date.parse(readAt);
  const expiresLabel = Number.isFinite(new Date(expiresAt).getTime())
    ? `Expires ${formatFieldStamp(new Date(expiresAt).toISOString(), officeDates)}`
    : undefined;
  /** The issue button's words. Every line that tells a person to tap it uses these. */
  const issueLabel = issued
    ? "Issue a corrected plan"
    : workPackage
      ? "Issue the corrected job plan"
      : "Issue job plan";
  const errorText = error ?? (reloadOffered ? reloadToIssue(issueLabel) : null);

  async function reload() {
    setReloading(true);
    try {
      await onReload();
      setError(null);
      setReloadOffered(false);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setReloading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setReloadOffered(false);
    onIssuedVersionChange(null);
    // Clearing the issued state turns the button back into this one, so the lines below name it.
    const retryLabel = workPackage ? "Issue the corrected job plan" : "Issue job plan";
    if (!assignment || !assignmentModified || !canSend) {
      setReloadOffered(true);
      return;
    }
    if (blocked) {
      setError(
        "This plan is stopped. Review this plan’s stop for release before issuing a corrected plan.",
      );
      return;
    }
    if (workPackage && !correctionReason.trim()) {
      setError("Give the reason for replacing this job plan.");
      return;
    }
    const expires = new Date(expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) {
      setError("Choose an expiry after the current time.");
      return;
    }
    if (lastWorkDay && expires.getTime() <= Date.parse(lastWorkDay)) {
      setError("Choose an expiry after the last scheduled work day ends.");
      return;
    }
    const deviceActionId = crypto.randomUUID();
    setSaving(true);
    try {
      await apiCommand({
        path: endpoint,
        csrfToken: session.csrf_token,
        idempotencyKey: deviceActionId,
        deviceActionId,
        body: {
          assignment_id: assignment.id,
          assignment_modified: assignmentModified,
          version: nextVersion,
          issued_at: new Date().toISOString(),
          expires_at: expires.toISOString(),
          title,
          objective,
          boundaries,
          prerequisites,
          expected_result: expectedResult,
          stop_conditions: stopConditions,
          make_safe_procedure: makeSafeProcedure,
          correction_reason: workPackage ? correctionReason.trim() : null,
          steps: steps.map((step) => ({
            instruction: step.instruction,
            required_evidence: step.requiredEvidence,
            acceptance_criteria: step.acceptanceCriteria,
          })),
          hold_points: holds.map((hold) => ({
            hold_point: hold.holdPoint,
            release_phase: hold.releasePhase,
            release_authority: hold.releaseAuthority,
            required_evidence: hold.requiredEvidence,
            acceptance_criteria: hold.acceptanceCriteria,
          })),
        },
      });
      onIssuedVersionChange(nextVersion);
      await onIssued();
    } catch (caught) {
      setError(
        messageFor(caught, {
          refused: `This job plan was not accepted, and nothing was issued. Check every step and hold point, then tap ${retryLabel} again.`,
          fallback:
            "We could not confirm the job plan was issued. Reload the job and check it before you issue it again.",
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="border-2 border-info/45 bg-info-soft p-4 sm:p-5"
      aria-labelledby="work-package-issue-heading"
    >
      <p className="text-sm font-semibold text-info">Production authority</p>
      <h2 id="work-package-issue-heading" className="mt-1 text-2xl font-bold tracking-[-0.03em]">
        {workPackage ? "Issue the corrected job plan" : "Issue job plan"}
      </h2>
      {workPackage ? (
        <p className="mt-2 max-w-3xl font-semibold leading-6">
          It replaces the plan the crew has now. The crew sees the new one the next time their phone
          loads the job.
        </p>
      ) : null}
      {expired ? (
        <p
          className="mt-3 max-w-3xl border border-warning/45 bg-warning-soft p-3 font-semibold text-warning"
          role="status"
        >
          {workPackage?.status === "Blocked"
            ? "Expired: the crew can't add proof. Review this plan’s stop for release, then issue a corrected plan."
            : "Expired: the crew can't add proof. Issue a corrected plan to set a new time."}
        </p>
      ) : null}
      {blocked ? (
        <p className="mt-3 font-semibold">
          <a href="#job-plan-stop-release" className="underline underline-offset-4">
            Review this plan’s stop for release
          </a>
          . Issuing a correction cannot release a stop.
        </p>
      ) : null}
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
        When you issue, the job's crew, assignment and scope lock in. This form adds the steps, hold
        points and the proof the crew must add.
      </p>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
        Issuing doesn't wait for the gates. The gates hold the firm start.
      </p>

      {!assignmentModified ? (
        <p
          className="mt-4 border border-warning/45 bg-warning-soft p-3 font-semibold text-warning"
          role="status"
        >
          The job's latest crew assignment did not load, so a job plan cannot be issued. Reload the
          job while online.
        </p>
      ) : null}

      <form className="mt-5 space-y-6" onSubmit={(event) => void submit(event)}>
        <div className="space-y-3 border-2 border-info/45 bg-surface p-4">
          <TextArea
            id="wp-boundaries"
            label="Work scope for the crew"
            value={boundaries}
            onChange={setBoundaries}
          />
          {workPackage ? (
            <>
              <p className="text-sm leading-6 text-muted">
                Edit the work scope here. Keep the other plan fields unless the change also affects
                their instructions, proof or safety checks.
              </p>
              <TextArea
                id="wp-correction-reason"
                label="Reason for replacing this plan"
                value={correctionReason}
                onChange={setCorrectionReason}
                maxLength={2000}
              />
              <p className="text-sm leading-6 text-muted">
                The reason goes in the change history. It does not change the crew’s instructions.
              </p>
            </>
          ) : null}
        </div>
        <p className="font-semibold">
          {lastWorkDay
            ? `Last scheduled work day ends ${formatFieldStamp(lastWorkDay, officeDates)}.`
            : "Last scheduled work day is not set. Confirm it with production before choosing expiry."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="wp-title"
            label="Title"
            value={title}
            onChange={setTitle}
            maxLength={200}
          />
          <TextField
            id="wp-expires"
            label="Expires"
            value={expiresAt}
            onChange={setExpiresAt}
            type="datetime-local"
            note={expiresLabel}
            hint="Choose a time after the last work day. After expiry the crew can still read the plan, but cannot add the photos or notes listed under Proof needed."
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <TextArea id="wp-objective" label="Objective" value={objective} onChange={setObjective} />
          <TextArea
            id="wp-expected-result"
            label="Expected result"
            value={expectedResult}
            onChange={setExpectedResult}
          />
          <TextArea
            id="wp-prerequisites"
            label="Prerequisites"
            value={prerequisites}
            onChange={setPrerequisites}
          />
          <TextArea
            id="wp-stop-conditions"
            label="Stop conditions"
            value={stopConditions}
            onChange={setStopConditions}
          />
          <TextArea
            id="wp-make-safe"
            label="Make-safe procedure"
            value={makeSafeProcedure}
            onChange={setMakeSafeProcedure}
          />
        </div>

        <fieldset className="space-y-3 border border-border p-4">
          <legend className="px-2 font-bold">Ordered steps</legend>
          {steps.map((step, index) => (
            <div
              key={step.key}
              className="grid gap-3 border-b border-border pb-4 last:border-0 last:pb-0 lg:grid-cols-3"
            >
              <TextArea
                id={`wp-step-${index + 1}-instruction`}
                label={`Step ${index + 1}`}
                value={step.instruction}
                onChange={(value) => updateStep(setSteps, step.key, "instruction", value)}
              />
              <TextArea
                id={`wp-step-${index + 1}-evidence`}
                label="Required evidence"
                value={step.requiredEvidence}
                onChange={(value) => updateStep(setSteps, step.key, "requiredEvidence", value)}
              />
              <div>
                <TextArea
                  id={`wp-step-${index + 1}-acceptance`}
                  label="Acceptance criteria"
                  value={step.acceptanceCriteria}
                  onChange={(value) => updateStep(setSteps, step.key, "acceptanceCriteria", value)}
                />
                {steps.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    className="mt-2"
                    onClick={() =>
                      setSteps((current) => current.filter((item) => item.key !== step.key))
                    }
                  >
                    <Trash2 aria-hidden="true" /> Remove step
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="compact"
            onClick={() => setSteps((current) => [...current, blankStep()])}
          >
            <Plus aria-hidden="true" /> Add step
          </Button>
        </fieldset>

        <fieldset className="space-y-3 border border-border p-4">
          <legend className="px-2 font-bold">Hold points</legend>
          {holds.map((hold, index) => (
            <div
              key={hold.key}
              className="grid gap-3 border-b border-border pb-4 last:border-0 last:pb-0 lg:grid-cols-2"
            >
              <TextArea
                id={`wp-hold-${index + 1}-name`}
                label={`Hold ${index + 1}`}
                value={hold.holdPoint}
                onChange={(value) => updateHold(setHolds, hold.key, "holdPoint", value)}
              />
              <div>
                <label htmlFor={`wp-hold-${index + 1}-phase`} className="text-sm font-bold">
                  Release phase
                </label>
                <select
                  id={`wp-hold-${index + 1}-phase`}
                  className="mt-2 min-h-12 w-full border bg-surface px-3"
                  value={hold.releasePhase}
                  onChange={(event) =>
                    updateHold(
                      setHolds,
                      hold.key,
                      "releasePhase",
                      event.target.value as HoldDraft["releasePhase"],
                    )
                  }
                >
                  <option>Pre-start</option>
                  <option>In-process</option>
                  <option>Completion</option>
                </select>
              </div>
              <TextField
                id={`wp-hold-${index + 1}-authority`}
                label="Release authority"
                value={hold.releaseAuthority}
                onChange={(value) => updateHold(setHolds, hold.key, "releaseAuthority", value)}
                maxLength={140}
              />
              <TextArea
                id={`wp-hold-${index + 1}-evidence`}
                label="Required evidence"
                value={hold.requiredEvidence}
                onChange={(value) => updateHold(setHolds, hold.key, "requiredEvidence", value)}
              />
              <TextArea
                id={`wp-hold-${index + 1}-acceptance`}
                label="Acceptance criteria"
                value={hold.acceptanceCriteria}
                onChange={(value) => updateHold(setHolds, hold.key, "acceptanceCriteria", value)}
              />
              {holds.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  className="self-end"
                  onClick={() =>
                    setHolds((current) => current.filter((item) => item.key !== hold.key))
                  }
                >
                  <Trash2 aria-hidden="true" /> Remove hold
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="compact"
            onClick={() => setHolds((current) => [...current, blankHold()])}
          >
            <Plus aria-hidden="true" /> Add hold point
          </Button>
        </fieldset>

        {errorText ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-semibold text-danger" role="alert">
              {errorText}
            </p>
            {reloadOffered ? (
              // Offline, a reload cannot reach the office: the control stays off, as the app's
              // other online-only controls do, and says why beside it.
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  busy={reloading}
                  disabled={!online}
                  onClick={() => void reload()}
                >
                  <RefreshCw aria-hidden="true" /> Reload job
                </Button>
                {!online ? (
                  <span className="text-sm text-muted">
                    Reload job works once you're back online.
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {issued ? (
          <p className="font-semibold text-ok" role="status">
            {crewReviewed
              ? reviewedAt
                ? `Reviewed by the crew · ${formatFieldStamp(reviewedAt, officeDates)}. Nothing more to send.`
                : "Reviewed by the crew. Nothing more to send."
              : "Job plan issued. The crew hasn't reviewed it yet. It shows on their Today screen the next time their phone loads the job. Nothing more to send."}
          </p>
        ) : null}
        {!canSend ? (
          <p className="text-sm leading-6 text-warning" role="status">
            You need to be online, with the job's latest crew assignment loaded, to issue.
          </p>
        ) : null}
        {issued ? (
          <Button type="submit" variant="secondary" busy={saving} disabled={!canSend || blocked}>
            <Send aria-hidden="true" /> {issueLabel}
          </Button>
        ) : (
          <Button type="submit" variant="accent" busy={saving} disabled={!canSend || blocked}>
            <Send aria-hidden="true" /> {issueLabel}
          </Button>
        )}
      </form>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  maxLength = 4000,
  type = "text",
  note,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  type?: InputHTMLAttributes<HTMLInputElement>["type"];
  /** A line under the control that reads its value back in words, such as an expiry stamp. */
  note?: string;
  /** What the value does, under the note. */
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold">
        {label}
        <RequiredMark />
      </label>
      <Input
        id={id}
        className="mt-2"
        type={type}
        value={value}
        maxLength={maxLength}
        required
        aria-describedby={
          [note ? `${id}-note` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") ||
          undefined
        }
        onChange={(event) => onChange(event.target.value)}
      />
      {note ? (
        <p id={`${id}-note`} className="mt-1 text-sm text-muted">
          {note}
        </p>
      ) : null}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 max-w-md text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
  maxLength = 4000,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold">
        {label}
        <RequiredMark />
      </label>
      <textarea
        id={id}
        className="mt-2 min-h-28 w-full border bg-surface p-3"
        value={value}
        maxLength={maxLength}
        required
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Every text field on this form is required, and its label says so, as "(optional)" does elsewhere. */
function RequiredMark() {
  return <span className="font-normal text-muted"> (required)</span>;
}

function blankStep(): StepDraft {
  return {
    key: crypto.randomUUID(),
    instruction: "",
    requiredEvidence: "",
    acceptanceCriteria: "",
  };
}

function blankHold(): HoldDraft {
  return {
    key: crypto.randomUUID(),
    holdPoint: "",
    releasePhase: "Pre-start",
    releaseAuthority: "IronWrap Production",
    requiredEvidence: "",
    acceptanceCriteria: "",
  };
}

function updateStep(
  setter: Dispatch<SetStateAction<StepDraft[]>>,
  key: string,
  field: keyof Omit<StepDraft, "key">,
  value: string,
) {
  setter((current) =>
    current.map((step) => (step.key === key ? { ...step, [field]: value } : step)),
  );
}

function updateHold(
  setter: Dispatch<SetStateAction<HoldDraft[]>>,
  key: string,
  field: keyof Omit<HoldDraft, "key">,
  value: string,
) {
  setter((current) =>
    current.map((hold) => (hold.key === key ? { ...hold, [field]: value } : hold)),
  );
}
