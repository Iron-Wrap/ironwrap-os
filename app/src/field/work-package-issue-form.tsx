import { Plus, Send, Trash2 } from "lucide-react";
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
import { apiCommand } from "../lib/api";
import type { JobResponse } from "./field-contracts";
import { messageFor } from "../lib/plain-error";

type WorkPackage = JobResponse["packet"]["work_package"];

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
  onIssued,
}: {
  session: AuthenticatedSession;
  assignment: JobResponse["assignment"];
  workPackage: WorkPackage;
  endpoint: string;
  allowed: boolean;
  offline: boolean;
  onIssued: () => Promise<void>;
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
  const [expiresAt, setExpiresAt] = useState(futureLocalDateTime());
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
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  if (!allowed) return null;
  const assignmentModified = assignment?.modified ?? null;
  const canSend =
    Boolean(assignment && assignmentModified) &&
    !offline &&
    navigator.onLine &&
    !isOfflineSession(session);
  const nextVersion = workPackage ? workPackage.version + 1 : 1;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSavedVersion(null);
    if (!assignment || !assignmentModified || !canSend) {
      setError(
        "Nothing was issued. Reload the job while online so it has the latest crew assignment, then tap Issue job plan.",
      );
      return;
    }
    if (workPackage && !correctionReason.trim()) {
      setError("Say what changed before you replace the current job plan.");
      return;
    }
    const expires = new Date(expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) {
      setError("Choose an expiry after the current time.");
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
      setSavedVersion(nextVersion);
      await onIssued();
    } catch (caught) {
      setError(
        messageFor(caught, {
          refused:
            "This job plan was not accepted, and nothing was issued. Check every step and hold point, then tap Issue job plan again.",
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
        {workPackage ? `Issue corrected job plan, version ${nextVersion}` : "Issue job plan"}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
        When you issue, the job's crew, assignment and scope lock in. This form adds the steps, hold
        points and the proof the crew must add.
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
            id="wp-boundaries"
            label="Boundaries"
            value={boundaries}
            onChange={setBoundaries}
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

        {workPackage ? (
          <TextArea
            id="wp-correction-reason"
            label="What changed?"
            value={correctionReason}
            onChange={setCorrectionReason}
            maxLength={2000}
          />
        ) : null}

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

        {error ? (
          <p className="font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {savedVersion ? (
          <p className="font-semibold text-ok" role="status">
            Job plan version {savedVersion} is issued and verified.
          </p>
        ) : null}
        {!canSend ? (
          <p className="text-sm leading-6 text-warning" role="status">
            You need to be online, with the job's latest crew assignment loaded, to issue.
          </p>
        ) : null}
        <Button type="submit" variant="accent" busy={saving} disabled={!canSend}>
          <Send aria-hidden="true" /> Issue job plan version {nextVersion}
        </Button>
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  type?: InputHTMLAttributes<HTMLInputElement>["type"];
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      <Input
        id={id}
        className="mt-2"
        type={type}
        value={value}
        maxLength={maxLength}
        required
        onChange={(event) => onChange(event.target.value)}
      />
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

function futureLocalDateTime(): string {
  const future = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  return new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
