import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ClipboardList, Coins } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
import { Notice } from "./service-notice";
import { cadFromCents, codeLabel, severityLabel, stateLabel } from "./service-presentation";

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
        title="This callback link is incomplete"
        message="No service case was named. Return to the callback desk and choose a case."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading this callback…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="Callback unavailable"
        message="Nothing about this case was changed. Reconnect and re-open the callback desk."
        onRetry={() => void query.refetch()}
        action={
          <Button asChild variant="outline">
            <Link to="/service">Back to callback desk</Link>
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
    <section className="mx-auto max-w-4xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <Button asChild variant="ghost" size="compact" className="-ml-2">
          <Link to="/service">
            <ArrowLeft aria-hidden="true" />
            Back to callback desk
          </Link>
        </Button>
        <div className="mt-4 flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <ClipboardList className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              {severityLabel(serviceCase.severity)} · {stateLabel(serviceCase.state)}
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              {codeLabel(serviceCase.symptom_code)}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              {serviceCase.roof_job_id} · response due {serviceCase.response_due_at} · version{" "}
              {serviceCase.version}
            </p>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to act on this callback">
          Service decisions are not queued offline. Nothing on this page is recorded until it
          reaches IronWrap OS.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="That step was refused">
          {actionError}
        </Notice>
      ) : null}
      {serviceCase.duplicate_of_case_id ? (
        <Notice tone="info" title="This report is a linked duplicate">
          The live remedy is on{" "}
          <Link
            to="/service/$caseId"
            params={{ caseId: serviceCase.duplicate_of_case_id }}
            className="underline"
          >
            the original case
          </Link>
          . It is kept so the second call is never lost.
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

      <section className="border border-border bg-surface" aria-label="Case history">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">History</h2>
        </div>
        <ol className="divide-y divide-border">
          {model.events.map((event) => (
            <li key={event.event_id} className="px-5 py-3 text-sm leading-6 sm:px-6">
              <span className="font-bold">{codeLabel(event.event_type)}</span>{" "}
              <span className="text-muted">
                · {stateLabel(event.case_state)} · v{event.case_version} · {event.created_at}
                {event.detail_code ? ` · ${codeLabel(event.detail_code)}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>
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
      title="Triage this callback"
      description="Triage is a human decision. A model may advise it, but the category and the responsibility recorded here carry your name."
      submitLabel="Record triage"
      busy={mutation.isPending}
      disabled={offline || unknownBlame || !/^[0-9a-f]{64}$/.test(evidenceDigest.trim())}
      onSubmit={() => mutation.mutate()}
      footer={
        model.service_case.state === "reopened"
          ? "A reopened case is triaged again; the closure that came before stays in the history."
          : undefined
      }
    >
      <Choice
        id="triage-category"
        label="Category"
        value={finalCategory}
        options={serviceTriageCategories}
        onChange={setFinalCategory}
      />
      <Choice
        id="triage-responsibility"
        label="Responsibility"
        value={responsibility}
        options={serviceResponsibilities}
        onChange={setResponsibility}
      />
      <Digest
        id="triage-evidence"
        label="Triage evidence digest"
        value={evidenceDigest}
        onChange={setEvidenceDigest}
      />
      {unknownBlame ? (
        <p className="text-sm leading-6 text-danger sm:col-span-2">
          An unknown category may not assign blame. Leave responsibility undetermined.
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
      title="Record the diagnosis"
      description="A diagnosis names the root cause and issues the governed service work package that will carry the remedy. Physical work is never dispatched any other way."
      submitLabel="Record diagnosis"
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
        label="Root cause code"
        value={rootCauseCode}
        onChange={setRootCauseCode}
      />
      <Field
        id="diagnosis-corrective-action"
        label="Corrective action code"
        value={correctiveActionCode}
        onChange={setCorrectiveActionCode}
      />
      <Field
        id="diagnosis-work-package"
        label="Service work package"
        value={workPackageRef}
        onChange={setWorkPackageRef}
      />
      <Field
        id="diagnosis-reserve"
        label="Warranty reserve (cents)"
        value={warrantyReserve}
        onChange={setWarrantyReserve}
      />
      <Digest
        id="diagnosis-evidence"
        label="Diagnosis evidence digest"
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
      title="Issue the remedy"
      description="Schedules the return visit and freezes the parts manifest it will carry."
      submitLabel="Issue remedy"
      busy={mutation.isPending}
      disabled={offline || !windowValid || !/^[0-9a-f]{64}$/.test(partsManifestDigest.trim())}
      onSubmit={() => mutation.mutate()}
    >
      <DateTime id="remedy-start" label="Scheduled start" value={start} onChange={setStart} />
      <DateTime id="remedy-end" label="Scheduled end" value={end} onChange={setEnd} />
      <Digest
        id="remedy-parts"
        label="Parts manifest digest"
        value={partsManifestDigest}
        onChange={setPartsManifestDigest}
      />
      {start && end && !windowValid ? (
        <p className="text-sm leading-6 text-danger sm:col-span-2">
          The scheduled end must be after the scheduled start.
        </p>
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
      title="Verify the remedy"
      description="A supervisor's verification is a separate fact from the customer's acceptance. A failed verification keeps its evidence and returns the case to diagnosis for rework."
      submitLabel="Record verification"
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
        label="Outcome"
        value={outcome}
        options={["verified", "failed"] as const}
        onChange={(value) => setOutcome(value as "verified" | "failed")}
      />
      <Field
        id="verification-cost"
        label="Actual cost (cents)"
        value={costActual}
        onChange={setCostActual}
      />
      <Digest
        id="verification-evidence"
        label="Field evidence digest"
        value={fieldEvidenceDigest}
        onChange={setFieldEvidenceDigest}
      />
      {outcome === "failed" ? (
        <Field
          id="verification-failure"
          label="Failure code"
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
      title="Record the customer's decision"
      description="A dispute is a first-class outcome, not an error. It keeps the verification evidence intact and sends the case back for rework or an honest non-remedied closure."
      submitLabel="Record decision"
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
        label="Decision"
        value={decision}
        options={["accepted", "disputed"] as const}
        onChange={(value) => setDecision(value as "accepted" | "disputed")}
      />
      {decision === "accepted" ? (
        <Field
          id="customer-acceptance"
          label="Customer decision record"
          value={acceptanceRef}
          onChange={setAcceptanceRef}
        />
      ) : (
        <Field
          id="customer-dispute"
          label="Dispute code"
          value={disputeCode}
          onChange={setDisputeCode}
        />
      )}
      <Digest
        id="customer-evidence"
        label="Decision evidence digest"
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
      title="Close this callback"
      description="Accepted work closes as remedied. Anything unresolved closes under an honest non-remedied reason, and the bus refuses a closure its state does not support."
      submitLabel="Close case"
      busy={mutation.isPending}
      disabled={offline}
      onSubmit={() => mutation.mutate()}
    >
      <Choice
        id="closure-reason"
        label="Closure reason"
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
      title="Reopen this callback"
      description="Reopening corrects the case forward with a raised reopen count. The closure that came before stays in the history and is never erased."
      submitLabel="Reopen case"
      busy={mutation.isPending}
      disabled={offline || !reopenCode.trim()}
      onSubmit={() => mutation.mutate()}
    >
      <Field
        id="reopen-code"
        label="Reopen reason code"
        value={reopenCode}
        onChange={setReopenCode}
      />
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
    <section className="border border-border bg-surface" aria-label="Cost and recovery">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <Coins className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold tracking-[-0.02em]">Cost and recovery</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Measured cost, not an estimate of it: reserve, what the remedy actually cost, and what
              settled recovery brought back.
            </p>
          </div>
        </div>
      </div>
      <dl className="grid gap-4 p-5 sm:grid-cols-4 sm:p-6">
        <Figure label="Warranty reserve" value={cadFromCents(cost.warranty_reserve_cents)} />
        <Figure label="Actual cost" value={cadFromCents(cost.actual_cost_cents)} />
        <Figure label="Recovered" value={cadFromCents(cost.recovered_cents)} />
        <Figure label="Net cost carried" value={cadFromCents(cost.net_cost_cents)} />
      </dl>

      {model.cost_recovery_claims.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {model.cost_recovery_claims.map((claim) => (
            <li key={claim.claim_id} className="px-5 py-4 sm:px-6">
              <p className="font-bold tracking-[-0.01em]">
                {claim.counterparty_ref} · {claim.counterparty_kind}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {cadFromCents(claim.claimed_amount_cents)} claimed ·{" "}
                {codeLabel(claim.claim_basis_code)} · {claim.state} · one attempt permitted
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
          Claiming money back from a supplier, manufacturer, or insurer is the owner's decision.
        </p>
      )}
    </section>
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
      title="Claim this cost back"
      description="Records the intent to claim; no supplier, manufacturer, or insurer is contacted from here. Exactly one submission attempt is ever permitted, and the bus refuses recovery where triage kept responsibility inside IronWrap's own crews."
      submitLabel="Record claim intent"
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
      footer={diagnosed ? undefined : "A claim needs a diagnosis first."}
    >
      <Choice
        id="claim-counterparty-kind"
        label="Counterparty"
        value={counterpartyKind}
        options={serviceCounterpartyKinds}
        onChange={setCounterpartyKind}
      />
      <Field
        id="claim-counterparty"
        label="Counterparty record"
        value={counterpartyRef}
        onChange={setCounterpartyRef}
      />
      <Field
        id="claim-basis"
        label="Claim basis code"
        value={claimBasisCode}
        onChange={setClaimBasisCode}
      />
      <Field
        id="claim-amount"
        label="Claimed amount (cents)"
        value={claimedAmount}
        onChange={setClaimedAmount}
      />
      <DateTime
        id="claim-deadline"
        label="Counterparty claim deadline"
        value={deadline}
        onChange={setDeadline}
      />
      <Digest
        id="claim-evidence"
        label="Claim evidence digest"
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
      title="Reconcile this uncertain claim"
      description="An uncertain attempt has exactly one way out, and it is an independently observed outcome. It is never retried behind your back."
      submitLabel="Record reconciliation"
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
        label="Observed outcome"
        value={outcome}
        options={["executed", "not_executed", "inconclusive"] as const}
        onChange={setOutcome}
      />
      <Field
        id={`reconcile-ref-${claim.claim_id}`}
        label="Reconciliation evidence"
        value={reconciliationRef}
        onChange={setReconciliationRef}
      />
      {outcome === "executed" ? (
        <Field
          id={`reconcile-amount-${claim.claim_id}`}
          label="Recovered amount (cents)"
          value={recoveredAmount}
          onChange={setRecoveredAmount}
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
    <form className="border border-border bg-surface" onSubmit={handle} aria-label={title}>
      <div className="border-b border-border px-5 py-5 sm:px-6">
        <h2 className="text-lg font-bold tracking-[-0.02em]">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">{children}</div>
      <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="max-w-xl text-sm leading-6 text-muted">{footer ?? ""}</p>
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
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-black tracking-[-0.03em]">{value}</dd>
    </div>
  );
}

function Field({
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="mt-3"
      />
      <p className="mt-2 text-xs leading-5 text-muted">
        The 64-character digest of the evidence already stored for this step.
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
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3 min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base shadow-inner shadow-black/3 outline-none focus:border-info focus:outline-info disabled:cursor-not-allowed disabled:opacity-55"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {codeLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "That step was not recorded. Re-open this callback before trying again.";
}
