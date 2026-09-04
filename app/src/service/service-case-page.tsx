import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ClipboardList, Coins } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import {
  closeServiceCase,
  issueServiceRemedy,
  loadServiceCase,
  openCostRecoveryClaim,
  recordCustomerServiceDecision,
  recordServiceDiagnosis,
  recordServiceTriage,
  reconcileCostRecoveryClaim,
  reopenServiceCase,
  verifyServiceRemedy,
} from "./service-api";
import {
  serviceClosureReasons,
  serviceCounterpartyKinds,
  serviceResponsibilities,
  serviceTriageCategories,
  type CostRecoveryClaim,
  type ServiceCaseDetailResponse,
  type ServiceRemedy,
} from "./service-contracts";
import { cadFromCents, codeLabel, stateLabel } from "./service-presentation";

/**
 * One callback, end to end. The panel offered here is the single step the case's current state
 * actually admits -- the bus refuses anything else -- so the office is never shown a control that
 * cannot do anything.
 */
export function ServiceCasePage() {
  return (
    <RoleGuard surface="owner">
      <ServiceCaseContent />
    </RoleGuard>
  );
}

function ServiceCaseContent() {
  const { caseId } = useParams({ strict: false }) as { caseId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string>();
  const queryKey = ["service-case", session.tenant.id, caseId];
  const query = useQuery({
    queryKey,
    queryFn: () => loadServiceCase(caseId ?? ""),
    enabled: Boolean(caseId),
    retry: false,
  });

  async function refresh() {
    setActionError(undefined);
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey: ["service-cases", session.tenant.id] });
  }

  if (!caseId) {
    return (
      <ErrorState
        title="This call link is not ready"
        message="Go back to Service calls and pick a call."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading this call…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="We could not load this call"
        message="Nothing changed. Check your link and try again."
        onRetry={() => void query.refetch()}
        action={
          <Button asChild variant="outline">
            <Link to="/service">Back to Service calls</Link>
          </Button>
        }
      />
    );
  }

  const model = query.data;
  const serviceCase = model.service_case;
  const remedy = model.remedies.at(-1) ?? null;
  const canRecoverCost = model.allowed_actions.includes("service_case.recover_cost");

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <Button asChild variant="ghost" size="compact" className="-ml-2">
        <Link to="/service">
          <ArrowLeft aria-hidden="true" />
          Back to Service calls
        </Link>
      </Button>

      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <ClipboardList className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] text-balance capitalize sm:text-4xl">
                  {codeLabel(serviceCase.symptom_code)}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Finish the next safe step. Each saved step stays in the call history.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Job ID</p>
            <p className="mt-2 break-words text-lg font-bold tracking-[-0.02em]">
              {serviceCase.roof_job_id}
            </p>
            <p className="mt-4 text-sm font-bold text-muted">Call by</p>
            <p className="mt-2 text-sm font-semibold leading-6">
              {formatDateTime(
                serviceCase.response_due_at,
                session.tenant.locale,
                session.tenant.time_zone,
              )}
            </p>
            <details className="mt-4 text-xs text-muted">
              <summary className="cursor-pointer font-bold text-foreground">System details</summary>
              <p className="mt-2 break-all leading-5">
                Call ID {serviceCase.service_case_id} · Version {serviceCase.version}
              </p>
            </details>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online to save a step">
          This page does not save work while you are offline.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="We could not save this step">
          <p>Check the call and try again.</p>
          <details className="mt-2">
            <summary className="cursor-pointer font-bold text-foreground">System details</summary>
            <p className="mt-1 break-words">{actionError}</p>
          </details>
        </Notice>
      ) : null}
      {serviceCase.duplicate_of_case_id ? (
        <Notice tone="info" title="This call was saved twice">
          Work from{" "}
          <Link
            to="/service/$caseId"
            params={{ caseId: serviceCase.duplicate_of_case_id }}
            className="underline"
          >
            the first call
          </Link>
          . This copy stays in the history.
        </Notice>
      ) : null}

      <NextStep
        model={model}
        caseId={caseId}
        remedy={remedy}
        offline={offline}
        onError={setActionError}
        onDone={refresh}
      />

      <CostPanel
        model={model}
        caseId={caseId}
        canRecoverCost={canRecoverCost}
        offline={offline}
        onError={setActionError}
        onDone={refresh}
      />

      <Card className="overflow-hidden" aria-label="Call history">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">Call history</h2>
          <p className="mt-1 text-sm leading-6 text-muted">Saved steps, newest data kept safe.</p>
        </div>
        <ol className="divide-y divide-border">
          {model.events.map((event) => (
            <li key={event.event_id} className="px-5 py-3 text-sm leading-6 sm:px-6">
              <p className="font-bold capitalize">{codeLabel(event.event_type)}</p>
              <p className="mt-1 text-muted">
                {stateLabel(event.case_state)} ·{" "}
                {formatDateTime(event.created_at, session.tenant.locale, session.tenant.time_zone)}
                {event.detail_code ? ` · ${codeLabel(event.detail_code)}` : ""}
              </p>
              <details className="mt-2 text-xs text-muted">
                <summary className="cursor-pointer font-bold text-foreground">
                  System details
                </summary>
                <p className="mt-1 break-all">
                  Event {event.event_id} · Version {event.case_version}
                </p>
              </details>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

interface StepProps {
  model: ServiceCaseDetailResponse;
  caseId: string;
  remedy: ServiceRemedy | null;
  offline: boolean;
  onError: (message: string) => void;
  onDone: () => Promise<void>;
}

function NextStep(props: StepProps): ReactNode {
  const state = props.model.service_case.state;
  if (state === "intake" || state === "reopened") return <TriagePanel {...props} />;
  if (state === "triaged" || state === "diagnosed" || state === "disputed") {
    return (
      <>
        {state === "diagnosed" ? <RemedyPanel {...props} /> : <DiagnosisPanel {...props} />}
        <ClosurePanel {...props} />
      </>
    );
  }
  if (state === "remedy_issued") return <VerificationPanel {...props} />;
  if (state === "remedy_verified") return <CustomerDecisionPanel {...props} />;
  if (state === "customer_accepted") return <ClosurePanel {...props} />;
  return <ReopenPanel {...props} />;
}

function TriagePanel({ model, caseId, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [finalCategory, setFinalCategory] = useState<string>("workmanship");
  const [responsibility, setResponsibility] = useState<string>("ironwrap_workmanship");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await recordServiceTriage(session, caseId, {
        advisorySource: "none",
        finalCategory,
        responsibility,
        evidenceDigest: evidenceDigest.trim(),
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });
  const unknownBlame = finalCategory === "unknown" && responsibility !== "undetermined";

  return (
    <ActionCard
      title="Check this call"
      description="Pick the problem type and who may need to fix it. Your choice is saved."
      submitLabel="Save check"
      busy={mutation.isPending}
      disabled={offline || unknownBlame || !/^[0-9a-f]{64}$/.test(evidenceDigest.trim())}
      onSubmit={() => mutation.mutate()}
      footer={
        model.service_case.state === "reopened"
          ? "This call was opened again. The old work stays in the history."
          : undefined
      }
    >
      <Choice
        id="triage-category"
        label="Problem type"
        value={finalCategory}
        options={serviceTriageCategories}
        onChange={setFinalCategory}
      />
      <Choice
        id="triage-responsibility"
        label="Who may need to fix it"
        value={responsibility}
        options={serviceResponsibilities}
        onChange={setResponsibility}
      />
      <Digest
        id="triage-evidence"
        label="Proof code"
        value={evidenceDigest}
        onChange={setEvidenceDigest}
      />
      {unknownBlame ? (
        <p className="text-sm leading-6 text-danger sm:col-span-2">
          If the problem type is not known, pick Not known for who may need to fix it.
        </p>
      ) : null}
    </ActionCard>
  );
}

function DiagnosisPanel({ caseId, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [rootCauseCode, setRootCauseCode] = useState("");
  const [correctiveActionCode, setCorrectiveActionCode] = useState("");
  const [workPackageRef, setWorkPackageRef] = useState("");
  const [warrantyReserve, setWarrantyReserve] = useState("0");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const reserveCents = Number(warrantyReserve);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await recordServiceDiagnosis(session, caseId, {
        rootCauseCode: rootCauseCode.trim(),
        correctiveActionCode: correctiveActionCode.trim(),
        workPackageRef: workPackageRef.trim(),
        workPackageVersion: 1,
        warrantyReserveCents: reserveCents,
        evidenceDigest: evidenceDigest.trim(),
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <ActionCard
      title="Save the cause"
      description="Name what caused the problem and what work may fix it. This does not send a crew."
      submitLabel="Save cause"
      busy={mutation.isPending}
      disabled={
        offline ||
        !rootCauseCode.trim() ||
        !correctiveActionCode.trim() ||
        !workPackageRef.trim() ||
        !Number.isInteger(reserveCents) ||
        reserveCents < 0 ||
        !/^[0-9a-f]{64}$/.test(evidenceDigest.trim())
      }
      onSubmit={() => mutation.mutate()}
    >
      <Field
        id="diagnosis-root-cause"
        label="Cause code"
        value={rootCauseCode}
        onChange={setRootCauseCode}
      />
      <Field
        id="diagnosis-corrective-action"
        label="Fix code"
        value={correctiveActionCode}
        onChange={setCorrectiveActionCode}
      />
      <Field
        id="diagnosis-work-package"
        label="Work plan ID"
        value={workPackageRef}
        onChange={setWorkPackageRef}
      />
      <Field
        id="diagnosis-reserve"
        label="Money set aside (cents)"
        value={warrantyReserve}
        onChange={setWarrantyReserve}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
      />
      <Digest
        id="diagnosis-evidence"
        label="Proof code"
        value={evidenceDigest}
        onChange={setEvidenceDigest}
      />
    </ActionCard>
  );
}

function RemedyPanel({ caseId, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [partsManifestDigest, setPartsManifestDigest] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await issueServiceRemedy(session, caseId, {
        scheduledStartAt: new Date(start).toISOString(),
        scheduledEndAt: new Date(end).toISOString(),
        partsManifestDigest: partsManifestDigest.trim(),
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });
  const windowValid = Boolean(start) && Boolean(end) && Date.parse(end) > Date.parse(start);

  return (
    <ActionCard
      title="Plan the fix"
      description="Set the return visit and save the parts proof."
      submitLabel="Save fix plan"
      busy={mutation.isPending}
      disabled={offline || !windowValid || !/^[0-9a-f]{64}$/.test(partsManifestDigest.trim())}
      onSubmit={() => mutation.mutate()}
    >
      <DateTime id="remedy-start" label="Start" value={start} onChange={setStart} />
      <DateTime id="remedy-end" label="End" value={end} onChange={setEnd} />
      <Digest
        id="remedy-parts"
        label="Parts proof code"
        value={partsManifestDigest}
        onChange={setPartsManifestDigest}
      />
      {start && end && !windowValid ? (
        <p className="text-sm leading-6 text-danger sm:col-span-2">End must be after start.</p>
      ) : null}
    </ActionCard>
  );
}

function VerificationPanel({ caseId, remedy, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [outcome, setOutcome] = useState<"verified" | "failed">("verified");
  const [fieldEvidenceDigest, setFieldEvidenceDigest] = useState("");
  const [costActual, setCostActual] = useState("0");
  const [failureCode, setFailureCode] = useState("");
  const costCents = Number(costActual);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await verifyServiceRemedy(session, caseId, remedy?.remedy_id ?? "", {
        outcome,
        fieldEvidenceDigest: fieldEvidenceDigest.trim(),
        costActualCents: costCents,
        failureCode: outcome === "failed" ? failureCode.trim() : null,
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <ActionCard
      title="Check the fix"
      description="A manager checks the work. Save the customer answer in the next step."
      submitLabel="Save fix check"
      busy={mutation.isPending}
      disabled={
        offline ||
        !remedy ||
        !/^[0-9a-f]{64}$/.test(fieldEvidenceDigest.trim()) ||
        !Number.isInteger(costCents) ||
        costCents < 0 ||
        (outcome === "failed" && !failureCode.trim())
      }
      onSubmit={() => mutation.mutate()}
    >
      <Choice
        id="verification-outcome"
        label="Did the fix pass?"
        value={outcome}
        options={["verified", "failed"] as const}
        onChange={(value) => setOutcome(value as "verified" | "failed")}
      />
      <Field
        id="verification-cost"
        label="Work cost (cents)"
        value={costActual}
        onChange={setCostActual}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
      />
      <Digest
        id="verification-evidence"
        label="Work proof code"
        value={fieldEvidenceDigest}
        onChange={setFieldEvidenceDigest}
      />
      {outcome === "failed" ? (
        <Field
          id="verification-failure"
          label="Problem code"
          value={failureCode}
          onChange={setFailureCode}
        />
      ) : null}
    </ActionCard>
  );
}

function CustomerDecisionPanel({ caseId, remedy, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [decision, setDecision] = useState<"accepted" | "disputed">("accepted");
  const [acceptanceRef, setAcceptanceRef] = useState("");
  const [disputeCode, setDisputeCode] = useState("");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await recordCustomerServiceDecision(session, caseId, remedy?.remedy_id ?? "", {
        decision,
        acceptanceRef: decision === "accepted" ? acceptanceRef.trim() : null,
        disputeCode: decision === "disputed" ? disputeCode.trim() : null,
        evidenceDigest: evidenceDigest.trim(),
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <ActionCard
      title="Save the customer answer"
      description="Save yes or no. A no answer sends the call back for more work."
      submitLabel="Save answer"
      busy={mutation.isPending}
      disabled={
        offline ||
        !remedy ||
        !/^[0-9a-f]{64}$/.test(evidenceDigest.trim()) ||
        (decision === "accepted" ? !acceptanceRef.trim() : !disputeCode.trim())
      }
      onSubmit={() => mutation.mutate()}
    >
      <Choice
        id="customer-decision"
        label="Customer answer"
        value={decision}
        options={["accepted", "disputed"] as const}
        onChange={(value) => setDecision(value as "accepted" | "disputed")}
      />
      {decision === "accepted" ? (
        <Field
          id="customer-acceptance"
          label="Answer record ID"
          value={acceptanceRef}
          onChange={setAcceptanceRef}
        />
      ) : (
        <Field
          id="customer-dispute"
          label="Problem code"
          value={disputeCode}
          onChange={setDisputeCode}
        />
      )}
      <Digest
        id="customer-evidence"
        label="Proof code"
        value={evidenceDigest}
        onChange={setEvidenceDigest}
      />
    </ActionCard>
  );
}

function ClosurePanel({ caseId, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [closureReason, setClosureReason] = useState<string>("remedied_accepted");
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => await closeServiceCase(session, caseId, { closureReason }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <ActionCard
      title="Mark this call done"
      description="Pick the true reason. The old work stays in the history."
      submitLabel="Mark done"
      busy={mutation.isPending}
      disabled={offline}
      onSubmit={() => mutation.mutate()}
    >
      <Choice
        id="closure-reason"
        label="Why is it done?"
        value={closureReason}
        options={serviceClosureReasons}
        onChange={setClosureReason}
      />
    </ActionCard>
  );
}

function ReopenPanel({ model, caseId, offline, onError, onDone }: StepProps) {
  const session = useSession();
  const [reopenCode, setReopenCode] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => await reopenServiceCase(session, caseId, reopenCode.trim()),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });
  if (model.service_case.duplicate_of_case_id) return null;

  return (
    <ActionCard
      title="Open this call again"
      description="Add the reason. The old work stays in the history."
      submitLabel="Open again"
      busy={mutation.isPending}
      disabled={offline || !reopenCode.trim()}
      onSubmit={() => mutation.mutate()}
    >
      <Field id="reopen-code" label="Reason code" value={reopenCode} onChange={setReopenCode} />
    </ActionCard>
  );
}

function CostPanel({
  model,
  caseId,
  canRecoverCost,
  offline,
  onError,
  onDone,
}: {
  model: ServiceCaseDetailResponse;
  caseId: string;
  canRecoverCost: boolean;
  offline: boolean;
  onError: (message: string) => void;
  onDone: () => Promise<void>;
}) {
  const cost = model.cost;
  return (
    <Card className="overflow-hidden" aria-label="Cost check">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <Coins className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold tracking-[-0.02em]">Cost check</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              See the saved work cost and any money paid back.
            </p>
          </div>
        </div>
      </div>
      <dl className="grid gap-4 p-5 sm:grid-cols-4 sm:p-6">
        <Figure label="Money set aside" value={cadFromCents(cost.warranty_reserve_cents)} />
        <Figure label="Work cost" value={cadFromCents(cost.actual_cost_cents)} />
        <Figure label="Money paid back" value={cadFromCents(cost.recovered_cents)} />
        <Figure label="Cost left" value={cadFromCents(cost.net_cost_cents)} />
      </dl>

      {model.cost_recovery_claims.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {model.cost_recovery_claims.map((claim) => (
            <li key={claim.claim_id} className="px-5 py-4 sm:px-6">
              <p className="font-bold tracking-[-0.01em]">
                {claim.counterparty_ref} · {claim.counterparty_kind}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {cadFromCents(claim.claimed_amount_cents)} asked for ·{" "}
                {codeLabel(claim.claim_basis_code)} · {codeLabel(claim.state)} · one send try
              </p>
              {claim.state === "uncertain" && canRecoverCost ? (
                <ReconcilePanel
                  caseId={caseId}
                  claim={claim}
                  offline={offline}
                  onError={onError}
                  onDone={onDone}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canRecoverCost ? (
        <ClaimPanel
          caseId={caseId}
          model={model}
          offline={offline}
          onError={onError}
          onDone={onDone}
        />
      ) : (
        <p className="border-t border-border px-5 py-4 text-sm leading-6 text-muted sm:px-6">
          Only the owner can ask a supplier, maker, or insurance company to pay this cost.
        </p>
      )}
    </Card>
  );
}

function ClaimPanel({
  caseId,
  model,
  offline,
  onError,
  onDone,
}: {
  caseId: string;
  model: ServiceCaseDetailResponse;
  offline: boolean;
  onError: (message: string) => void;
  onDone: () => Promise<void>;
}) {
  const session = useSession();
  const [counterpartyKind, setCounterpartyKind] = useState<string>("manufacturer");
  const [counterpartyRef, setCounterpartyRef] = useState("");
  const [claimBasisCode, setClaimBasisCode] = useState("");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const [deadline, setDeadline] = useState("");
  const amountCents = Number(claimedAmount);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await openCostRecoveryClaim(session, caseId, {
        counterpartyKind: counterpartyKind as CostRecoveryClaim["counterparty_kind"],
        counterpartyRef: counterpartyRef.trim(),
        claimBasisCode: claimBasisCode.trim(),
        claimedAmountCents: amountCents,
        evidenceDigest: evidenceDigest.trim(),
        deadlineAt: new Date(deadline).toISOString(),
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });
  const diagnosed = model.diagnoses.length > 0;

  return (
    <ActionCard
      title="Ask for money back"
      description="This saves a request. It does not contact anyone. Only one send try is allowed."
      submitLabel="Save request"
      busy={mutation.isPending}
      disabled={
        offline ||
        !diagnosed ||
        !counterpartyRef.trim() ||
        !claimBasisCode.trim() ||
        !Number.isInteger(amountCents) ||
        amountCents < 1 ||
        !/^[0-9a-f]{64}$/.test(evidenceDigest.trim()) ||
        !deadline
      }
      onSubmit={() => mutation.mutate()}
      footer={diagnosed ? undefined : "Save the cause first."}
    >
      <Choice
        id="claim-counterparty-kind"
        label="Who may pay"
        value={counterpartyKind}
        options={serviceCounterpartyKinds}
        onChange={setCounterpartyKind}
      />
      <Field
        id="claim-counterparty"
        label="Company ID"
        value={counterpartyRef}
        onChange={setCounterpartyRef}
      />
      <Field
        id="claim-basis"
        label="Reason code"
        value={claimBasisCode}
        onChange={setClaimBasisCode}
      />
      <Field
        id="claim-amount"
        label="Amount (cents)"
        value={claimedAmount}
        onChange={setClaimedAmount}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
      />
      <DateTime id="claim-deadline" label="Send by" value={deadline} onChange={setDeadline} />
      <Digest
        id="claim-evidence"
        label="Proof code"
        value={evidenceDigest}
        onChange={setEvidenceDigest}
      />
    </ActionCard>
  );
}

function ReconcilePanel({
  caseId,
  claim,
  offline,
  onError,
  onDone,
}: {
  caseId: string;
  claim: CostRecoveryClaim;
  offline: boolean;
  onError: (message: string) => void;
  onDone: () => Promise<void>;
}) {
  const session = useSession();
  const [outcome, setOutcome] = useState<string>("executed");
  const [reconciliationRef, setReconciliationRef] = useState("");
  const [recoveredAmount, setRecoveredAmount] = useState("0");
  const recoveredCents = Number(recoveredAmount);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () =>
      await reconcileCostRecoveryClaim(session, caseId, claim.claim_id, {
        outcome: outcome as "executed" | "not_executed" | "inconclusive",
        reconciliationRef: reconciliationRef.trim(),
        recoveredAmountCents: outcome === "executed" ? recoveredCents : null,
      }),
    onSuccess: onDone,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <ActionCard
      title="Check a send result"
      description="The first result is not known. Save what another source shows. Do not send it again."
      submitLabel="Save result"
      busy={mutation.isPending}
      disabled={
        offline ||
        !reconciliationRef.trim() ||
        (outcome === "executed" && (!Number.isInteger(recoveredCents) || recoveredCents < 0))
      }
      onSubmit={() => mutation.mutate()}
    >
      <Choice
        id={`reconcile-outcome-${claim.claim_id}`}
        label="What happened?"
        value={outcome}
        options={["executed", "not_executed", "inconclusive"] as const}
        onChange={setOutcome}
      />
      <Field
        id={`reconcile-ref-${claim.claim_id}`}
        label="Result proof"
        value={reconciliationRef}
        onChange={setReconciliationRef}
      />
      {outcome === "executed" ? (
        <Field
          id={`reconcile-amount-${claim.claim_id}`}
          label="Money paid back (cents)"
          value={recoveredAmount}
          onChange={setRecoveredAmount}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
        />
      ) : null}
    </ActionCard>
  );
}

function ActionCard({
  title,
  description,
  submitLabel,
  busy,
  disabled,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  description: string;
  submitLabel: string;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
  children: ReactNode;
  footer?: string;
}) {
  function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled && !busy) onSubmit();
  }
  return (
    <Card className="overflow-hidden">
      <form onSubmit={handle} aria-label={title}>
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">{children}</div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            {footer ?? (disabled ? "Fill each needed box to save." : "Ready to save.")}
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={busy}
            disabled={disabled || busy}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-bold text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold tracking-[-0.03em]">{value}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  min,
  step,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  inputMode?: "numeric";
  min?: number;
  step?: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold text-foreground">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        min={min}
        step={step}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="mt-3"
      />
    </div>
  );
}

function Digest({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className="text-sm font-bold text-foreground">
        {label}
      </label>
      <Input
        id={id}
        required
        minLength={64}
        maxLength={64}
        pattern="[0-9a-f]{64}"
        title="Enter the 64-letter proof code. Use only a to f and 0 to 9."
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="mt-3"
      />
      <p className="mt-2 text-xs leading-5 text-muted">
        Paste the 64-letter proof code for the saved file. Use a to f and 0 to 9.
      </p>
    </div>
  );
}

function DateTime({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-bold text-foreground">
        {label}
      </label>
      <Input
        id={id}
        type="datetime-local"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3"
      />
      <p className="mt-2 text-xs leading-5 text-muted">Uses this device’s local time.</p>
    </div>
  );
}

function Choice({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
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
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {codeLabel(option)}
          </option>
        ))}
      </Select>
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "This step was not saved. Open the call again and try once more.";
}

function formatDateTime(value: string, locale: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not found";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}
