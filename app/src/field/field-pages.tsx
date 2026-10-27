import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  HardHat,
  MapPin,
  Mic,
  Phone,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { getDeviceSecret } from "../auth/device-credential";
import { OutboxStateBadge } from "../components/outbox-state-badge";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { ApiError, apiCommand } from "../lib/api";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { subscribeOutboxChanges } from "../storage/outbox-store";
import { flushOutbox } from "../storage/outbox-processor";
import { outboxFailureGuidance } from "../storage/outbox-failure";
import type { JsonValue, OutboxAction } from "../storage/outbox-types";
import { loadJob, loadWorkObject, loadProofPage } from "./field-cache";
import { OfflineReadiness } from "./offline-readiness";
import {
  NOT_SAVED_ON_DEVICE,
  type JobResponse,
  type ProofStreamItem,
  type WorkObjectResponse,
} from "./field-contracts";
import {
  formatFieldSchedule,
  formatFieldStamp,
  formatFieldTimestamp,
  plainFieldNames,
  type FieldDateOptions,
} from "./field-formatting";
import { jobPlanBadge, type StampClock } from "./job-plan-status";
import { messageFor, messageForLoad, type PlainErrorCopy } from "../lib/plain-error";
import {
  afterFailedSend,
  dropWorkPlanIntent,
  keepWorkPlanIntent,
  keptWorkPlanIntent,
  workPlanIdentity,
  workPlanIntentKey,
} from "./work-plan-intent";
import { ErrorSystemDetails } from "../components/ui/system-details";
import { CustomerJobHistorySection } from "../customers/customer-history-section";
import { EntityDocumentsSection } from "../documents/document-section";
import { SchemaCardSection } from "../schema-forms/schema-card-section";
import { GateChip } from "./gate-chip";
import { ProofStream } from "./proof-stream";
import { WorkPackageIssueForm } from "./work-package-issue-form";

const FIELD_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
]);
const MAX_MEDIA_COUNT = 12;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_ACTION_BYTES = 24 * 1024 * 1024;

/**
 * The job route answers `not_found` for a job that does not exist, is no longer active or is not
 * assigned to this crew member, and cannot say which, so neither does the phone.
 */
const jobNotOnList =
  "This job is not on your list. It may be finished, or not assigned to you. Ask the office if you should be on it.";

const jobReadRefusals: PlainErrorCopy = { byCode: { not_found: jobNotOnList } };

/** A save on this phone failed part way: it may already be in saved work, waiting to send. */
const savedWorkUnconfirmed =
  "This phone could not confirm it saved this. Check saved work before you try again.";

/**
 * Start and Finish whose answer was lost. The phone kept the request (`work-plan-intent.ts`), so
 * pressing again resends the same one and is safe.
 */
const startUnconfirmed =
  "We could not confirm work started. Press Start work again: it sends the same request, so work cannot start twice.";
const finishUnconfirmed =
  "We could not confirm the work was finished. Press Finish work again: it sends the same request, so it cannot finish twice.";

const pressAgain = {
  start: "press Start work again: it sends the same request, so work cannot start twice.",
  finish: "press Finish work again: it sends the same request, so it cannot finish twice.",
} as const;

/**
 * The words for a Start or Finish whose request is kept (`afterFailedSend` said keep). A session
 * or access problem on a resend does not settle it: the first send may have committed, so the
 * person fixes the session and presses again.
 */
function workPlanUnconfirmed(kind: "start" | "finish", error: unknown): PlainErrorCopy {
  const unconfirmed = kind === "start" ? startUnconfirmed : finishUnconfirmed;
  const byCode: Record<string, string> = { network_error: unconfirmed, timeout: unconfirmed };
  // Keyed by the code that came back, so these win over the status words for a 401 or 403.
  if (error instanceof ApiError && error.code === "csrf_failed") {
    byCode.csrf_failed = `Your session needs refreshing. Reload the page, then ${pressAgain[kind]}`;
  } else if (error instanceof ApiError && error.status === 401) {
    byCode[error.code] =
      `Your session expired before the office answered. Sign in again, then ${pressAgain[kind]}`;
  } else if (error instanceof ApiError && error.status === 403) {
    byCode[error.code] =
      `Your account lost access before the office answered. Ask the office to check your access, then ${pressAgain[kind]}`;
  }
  return { byCode, fallback: unconfirmed };
}

/** The office has the same request and is still working on it. */
function workPlanStillRunning(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  return `The office is still working on this. This phone sends the same request again in ${
    seconds === 1 ? "a second" : `${seconds} seconds`
  }.`;
}

const MAX_IN_PROGRESS_RESENDS = 3;

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === "idempotency_conflict";
}

/** Start and Finish go straight to the office (no saved copy), so these are their answers. */
const workPlanRefusals: PlainErrorCopy = {
  byCode: {
    not_found: jobNotOnList,
    work_package_not_available: jobNotOnList,
    work_package_actor_not_assigned:
      "You are not on the crew for this job plan. Ask the office to add you to it.",
    work_package_version_conflict:
      "The job plan changed after this phone opened it. Open the job again to see the new plan.",
    work_package_release_attempt_conflict:
      "The job plan changed after this phone opened it. Open the job again to see the new plan.",
    idempotency_conflict:
      "The office already holds a different request from this phone for this plan. Check the plan, then press the button again.",
  },
};
const PROOF_SLOTS = [
  "Production",
  "Safety",
  "Access",
  "Weather",
  "Crew",
  "Materials",
  "Change Order",
  "Completion",
  "Other",
];
const BLOCKER_CATEGORIES = [
  "Safety",
  "Weather",
  "Access",
  "Material",
  "Crew",
  "Scope",
  "Customer",
  "Other",
];

export function JobPage() {
  const session = useSession();
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  // Keep the capture and its receipt above the versioned plan. A job readback can replace the
  // plan after sending without discarding the saved action the person is still reviewing.
  const [quickCapture, setQuickCapture] = useState<{ jobId: string; photos: File[] } | null>(null);
  const query = useQuery({
    queryKey: ["job", session.tenant.id, session.user.id, jobId],
    enabled: Boolean(jobId),
    queryFn: () => loadJob(session, jobId!),
  });
  if (!jobId) return <ErrorState message="This job link is incomplete." />;
  if (quickCapture?.jobId === jobId) {
    return (
      <CheckInFlow
        key={jobId}
        jobId={jobId}
        initialPhotos={quickCapture.photos}
        onReturnToJob={() => setQuickCapture(null)}
      />
    );
  }
  if (query.isPending) return <LoadingState label="Loading job plan…" />;
  if (query.isError)
    return (
      <ErrorState
        message={messageForLoad(query.error, jobReadRefusals)}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <JobSurface
      key={query.data.read_model_generated_at}
      model={query.data}
      offline={query.data.stale_fields.includes("offline.cached_packet")}
      onPhotosCaptured={(photos) => setQuickCapture({ jobId, photos })}
      savingOffline={query.isFetching}
      onRetryOffline={() => void query.refetch()}
    />
  );
}

export function WorkObjectPage() {
  const session = useSession();
  const params = useParams({ strict: false }) as {
    workObjectType?: string;
    workObjectId?: string;
    physicalContextType?: string;
    physicalContextId?: string;
  };
  const scope: WorkObjectResponse["work_object"] | null =
    params.workObjectType &&
    params.workObjectId &&
    params.physicalContextType &&
    params.physicalContextId
      ? {
          workObjectType: params.workObjectType,
          workObjectId: params.workObjectId,
          physicalContextType: params.physicalContextType,
          physicalContextId: params.physicalContextId,
        }
      : null;
  const query = useQuery({
    queryKey: scope
      ? [
          "work-object",
          session.tenant.id,
          session.user.id,
          scope.workObjectType,
          scope.workObjectId,
          scope.physicalContextType,
          scope.physicalContextId,
        ]
      : ["work-object", session.tenant.id, session.user.id, "missing"],
    enabled: scope !== null,
    queryFn: () => loadWorkObject(session, scope!),
  });
  if (!scope) return <ErrorState message="This work link is incomplete." />;
  if (query.isPending) return <LoadingState label="Loading job plan…" />;
  if (query.isError)
    return (
      <ErrorState
        message={messageForLoad(query.error)}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <WorkObjectSurface
      key={query.data.read_model_generated_at}
      model={query.data}
      offline={query.data.stale_fields.includes("offline.cached_packet")}
    />
  );
}

function WorkObjectSurface({ model, offline }: { model: WorkObjectResponse; offline: boolean }) {
  const session = useSession();
  const workPackage = model.work_package;
  const panelModel: WorkPackagePanelModel = {
    job: { id: model.work_object.workObjectId },
    read_model_generated_at: model.read_model_generated_at,
    assignment: model.assignment,
    allowed_actions: model.allowed_actions,
    packet: { work_package: workPackage },
    scope: {
      work_object_type: model.work_object.workObjectType,
      work_object_id: model.work_object.workObjectId,
      physical_context_type: model.work_object.physicalContextType,
      physical_context_id: model.work_object.physicalContextId,
    },
  };
  const captureAllowed =
    session.user.role === "field" && model.allowed_actions.includes("field.checkin.create");
  const workObjectDates: FieldDateOptions = {
    locale: session.tenant.locale,
    timeZone: session.tenant.time_zone,
  };
  return (
    <RoleGuard surface="job">
      <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
        <Button asChild variant="ghost" size="compact">
          <Link to="/today">
            <ChevronLeft aria-hidden="true" />
            Today
          </Link>
        </Button>
        <WorkObjectPacketHeader
          model={model}
          offline={offline}
          dateOptions={workObjectDates}
          clock={session.user.role === "field" ? "12h" : "24h"}
        />
        <WorkPackagePanel
          model={panelModel}
          offline={offline}
          dateOptions={workObjectDates}
          captureAllowed={captureAllowed}
        />
        <CaptureProofPanel
          jobId={model.work_object.workObjectId}
          workObjectScope={workPackage ? workObjectScopeForPackage(workPackage) : null}
          blocked={false}
          fieldCaptureAllowed={captureAllowed}
          fieldRole={session.user.role === "field"}
        />
      </section>
    </RoleGuard>
  );
}

function WorkObjectPacketHeader({
  model,
  offline,
  dateOptions,
  clock,
}: {
  model: WorkObjectResponse;
  offline: boolean;
  dateOptions: FieldDateOptions;
  clock: StampClock;
}) {
  const assignment = [model.assignment?.type, model.assignment?.status].filter(Boolean).join(" · ");
  return (
    <header className="border-b border-border pb-5 sm:pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">{model.work_object.workObjectType}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.04em] text-pretty sm:text-4xl">
            {model.work_object.workObjectId}
          </h1>
          <p className="mt-2 text-base leading-6 text-muted">
            {model.work_object.physicalContextType} · {model.work_object.physicalContextId}
          </p>
        </div>
        <p className="border border-border bg-surface-raised px-3 py-2 text-sm font-bold text-muted">
          {offline ? "Saved copy" : "Up to date"}
        </p>
      </div>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        <JobFact label="Assignment" value={assignment || "Assignment details are missing"} />
        <JobFact
          label="Job plan"
          value={
            model.work_package
              ? `Issued to the crew · ${formatFieldStamp(model.work_package.released_at, dateOptions, { clock })}`
              : "Not ready"
          }
        />
      </dl>
    </header>
  );
}

function JobSurface({
  model,
  offline,
  onPhotosCaptured,
  savingOffline,
  onRetryOffline,
}: {
  model: JobResponse;
  offline: boolean;
  onPhotosCaptured: (photos: File[]) => void;
  savingOffline: boolean;
  onRetryOffline: () => void;
}) {
  const session = useSession();
  const [quickPhotoError, setQuickPhotoError] = useState<string | null>(null);
  const [proof, setProof] = useState<ProofStreamItem[]>(model.proof_stream);
  const [cursor, setCursor] = useState(model.proof_page.next_cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const dateOptions = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const blockedGates = model.gates.filter((gate) => gate.state?.trim().toLowerCase() === "blocked");
  const fieldCaptureAllowed =
    session.user.role === "field" &&
    model.assignment !== null &&
    model.allowed_actions.includes("field.checkin.create");
  /*
    A marker belongs in "Some job details may be old" only if nothing else on the screen explains
    it. The `.native_unavailable` slots are now explained inside their own panel, and leaving them
    here too put six lines of machine vocabulary -- "Packet Materials Takeoffs Native Unavailable"
    -- in front of a crew on every job forever, which buried the rare marker that means something
    (a stale address, a contact whose phone did not come back). Access instructions stay: they have
    no panel of their own, so this disclosure is the only place that says so.
  */
  const dataLimits = model.stale_fields.filter(
    (field) => field !== "offline.cached_packet" && !field.endsWith(".native_unavailable"),
  );

  async function loadOlder() {
    if (!cursor || loadingMore || offline) return;
    setLoadingMore(true);
    try {
      const page = await loadProofPage(session, model.job.id, cursor);
      setProof((current) => dedupeProof([...current, ...page.items]));
      setCursor(page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function capturePhotos(files: FileList | null) {
    if (!files?.length) return;
    const photos = [...files];
    const error = validateMedia(photos);
    setQuickPhotoError(error);
    if (!error) onPhotosCaptured(photos);
  }

  return (
    <RoleGuard surface="job">
      <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
        <Button asChild variant="ghost" size="compact">
          {session.user.role === "production" ? (
            <Link to="/production">
              <ChevronLeft aria-hidden="true" />
              Production
            </Link>
          ) : (
            <Link to="/today">
              <ChevronLeft aria-hidden="true" />
              Today
            </Link>
          )}
        </Button>
        <OfflineReadiness
          ready={!model.stale_fields.includes(NOT_SAVED_ON_DEVICE)}
          saving={savingOffline}
          savedDetail="This job plan is saved on this phone. Work and safety checks still apply."
          missingDetail="This job plan is not saved on this phone."
          onRetry={onRetryOffline}
        />
        <JobPacketHeader model={model} offline={offline} dateOptions={dateOptions} />
        {offline ? (
          <JobOfflineNotice generatedAt={model.read_model_generated_at} dateOptions={dateOptions} />
        ) : null}
        {dataLimits.length > 0 ? <JobDataLimits fields={dataLimits} /> : null}
        {session.user.role === "field" ? (
          <CaptureProofPanel
            jobId={model.job.id}
            workObjectScope={
              model.packet.work_package
                ? workObjectScopeForPackage(model.packet.work_package)
                : null
            }
            blocked={blockedGates.length > 0}
            fieldCaptureAllowed={fieldCaptureAllowed}
            fieldRole
            onPhotosSelected={capturePhotos}
            error={quickPhotoError}
          />
        ) : null}
        {session.user.role !== "field" && session.permissions.includes("jobs:read:any") ? (
          <Button asChild variant="outline">
            <Link to="/jobs/$jobId/history" params={{ jobId: model.job.id }}>
              Job history
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
        <WorkPackagePanel
          model={model}
          offline={offline}
          dateOptions={dateOptions}
          captureAllowed={fieldCaptureAllowed}
        />
        <WorkStatus model={model} blockedGates={blockedGates} dateOptions={dateOptions} />
        {/*
          Whatever the administrator configured for this account, rendered for whoever is holding
          the phone. The entity id is the `operating_roof_jobs` key the server's entity registry
          binds `job` fields to, not the read-model job id.
        */}
        <SchemaCardSection
          entityType="job"
          entityId={model.job.roof_job_id}
          dateOptions={dateOptions}
          headingId="job-configured-details-heading"
        />
        {/*
          The documents this job carries — a materials list, a contract, an estimate — rendered from
          the same authorized values the card above shows, so the shop and the crew reach them where
          the work is rather than in a separate documents area (ELEC-182).
        */}
        <EntityDocumentsSection
          entityType="job"
          entityId={model.job.roof_job_id}
          dateOptions={dateOptions}
          headingId="job-documents-heading"
        />
        {/*
          What else this customer has had done, finished work included. Renders for office readers
          only — the server refuses `jobs:read:assigned`, so a crew member sees nothing here.
        */}
        <CustomerJobHistorySection
          jobId={model.job.roof_job_id}
          dateOptions={dateOptions}
          headingId="customer-history-heading"
        />
        {session.user.role !== "field" ? (
          <CaptureProofPanel
            jobId={model.job.id}
            workObjectScope={
              model.packet.work_package
                ? workObjectScopeForPackage(model.packet.work_package)
                : null
            }
            blocked={blockedGates.length > 0}
            fieldCaptureAllowed={fieldCaptureAllowed}
            fieldRole={false}
          />
        ) : null}
        <SafetyAndAccess model={model} dateOptions={dateOptions} />
        <section className="space-y-4" aria-labelledby="proof-stream-heading">
          <header className="border-b border-border pb-4">
            <p className="text-sm font-semibold text-muted">Sent job proof</p>
            <h2
              id="proof-stream-heading"
              className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl"
            >
              Job proof
            </h2>
          </header>
          <ProofStream
            items={proof}
            hasMore={Boolean(cursor) && !offline}
            loadingMore={loadingMore}
            onLoadMore={() => void loadOlder()}
            locale={dateOptions.locale}
            timeZone={dateOptions.timeZone}
          />
        </section>
        <PacketDetails model={model} dateOptions={dateOptions} />
      </section>
    </RoleGuard>
  );
}

function JobPacketHeader({
  model,
  offline,
  dateOptions,
}: {
  model: JobResponse;
  offline: boolean;
  dateOptions: FieldDateOptions;
}) {
  const assignment = [model.assignment?.type, model.assignment?.status].filter(Boolean).join(" · ");
  // The job's facts follow the header's own width: the crew shell is a phone-wide column even on
  // a desktop, where window breakpoints squeezed three facts into it.
  return (
    <header className="@container border-b border-border pb-5 sm:pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">
            {model.job.job_number ?? "Assigned job"}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.04em] text-pretty sm:text-4xl">
            {model.job.address ?? "Job plan"}
          </h1>
        </div>
        <p className="border border-border bg-surface-raised px-3 py-2 text-sm font-bold text-muted">
          {offline ? "Saved copy" : "Office update"}
        </p>
      </div>
      <dl className="mt-5 grid gap-4 text-sm @2xl:grid-cols-3">
        <JobFact label="Service" value={model.job.service_type ?? "Service details are missing"} />
        <JobFact label="Assignment" value={assignment || "Assignment details are missing"} />
        <JobFact
          label="Scheduled"
          value={formatFieldSchedule(model.assignment?.scheduled_start ?? null, dateOptions)}
        />
      </dl>
      <p className="mt-4 text-sm leading-6 text-muted">
        {offline ? "Saved" : "Updated"}{" "}
        {formatFieldTimestamp(model.read_model_generated_at, dateOptions)} ·{" "}
        {model.source_updated_at
          ? `Office update ${formatFieldTimestamp(model.source_updated_at, dateOptions)}`
          : "Office update time is missing"}
      </p>
    </header>
  );
}

function JobOfflineNotice({
  generatedAt,
  dateOptions,
}: {
  generatedAt: string;
  dateOptions: FieldDateOptions;
}) {
  return (
    <div
      className="flex items-start gap-3 border border-warning/35 bg-warning-soft p-4 text-warning"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="font-bold leading-6">
        This is a saved copy from {formatFieldTimestamp(generatedAt, dateOptions)}. You can save new
        proof. Go online before you trust a changed work check, plan, or safety note.
      </p>
    </div>
  );
}

function JobDataLimits({ fields }: { fields: string[] }) {
  const staleFields = fields.filter((field) => field !== NOT_SAVED_ON_DEVICE);
  const names = plainFieldNames(staleFields);
  return (
    <>
      {staleFields.length > 0 ? (
        <details className="border border-border bg-surface-raised">
          <summary className="min-h-14 cursor-pointer px-4 py-4 text-sm font-bold">
            Some job details may be old
          </summary>
          <p className="border-t border-border px-4 py-4 text-sm leading-6 text-muted">
            {names.length
              ? `Check the job again before you use these details: ${names.join(", ")}.`
              : "Check the job again before you rely on its details."}{" "}
            This screen cannot clear a work check.
          </p>
        </details>
      ) : null}
    </>
  );
}

type WorkPackagePanelModel = {
  job: Pick<JobResponse["job"], "id">;
  /** When the server made this read: the clock the issue form judges expiry by. */
  read_model_generated_at: string;
  assignment: JobResponse["assignment"];
  allowed_actions: string[];
  packet: Pick<JobResponse["packet"], "work_package">;
  scope?: TypedWorkObjectScope | null;
};

type FieldWorkPackage = NonNullable<JobResponse["packet"]["work_package"]>;
type TypedWorkObjectScope = {
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
};

function workObjectScopeForPackage(workPackage: FieldWorkPackage): TypedWorkObjectScope | null {
  if (
    workPackage.work_object_type === "Roof Job" ||
    !workPackage.work_object_type ||
    !workPackage.work_object_id ||
    !workPackage.physical_context_type ||
    !workPackage.physical_context_id
  ) {
    return null;
  }
  return {
    work_object_type: workPackage.work_object_type,
    work_object_id: workPackage.work_object_id,
    physical_context_type: workPackage.physical_context_type,
    physical_context_id: workPackage.physical_context_id,
  };
}

function workPackageActionPayload(
  workPackage: FieldWorkPackage,
  payload: Record<string, JsonValue>,
): JsonValue {
  const scope = workObjectScopeForPackage(workPackage);
  return {
    ...payload,
    ...(scope
      ? {
          work_object_type: scope.work_object_type,
          work_object_id: scope.work_object_id,
          physical_context_type: scope.physical_context_type,
          physical_context_id: scope.physical_context_id,
        }
      : {}),
  };
}

function fieldPacketQueryKey(
  session: ReturnType<typeof useSession>,
  jobId: string,
  scope: TypedWorkObjectScope | null,
) {
  return scope
    ? [
        "work-object",
        session.tenant.id,
        session.user.id,
        scope.work_object_type,
        scope.work_object_id,
        scope.physical_context_type,
        scope.physical_context_id,
      ]
    : ["job", session.tenant.id, session.user.id, jobId];
}

function WorkPackagePanel({
  model,
  offline,
  dateOptions,
  captureAllowed,
}: {
  model: WorkPackagePanelModel;
  offline: boolean;
  dateOptions: FieldDateOptions;
  captureAllowed: boolean;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const workPackage = model.packet.work_package;
  const [acknowledgementConfirmed, setAcknowledgementConfirmed] = useState(false);
  const [stopReason, setStopReason] = useState("");
  /** The words shown, and for a failed request the error whose code System details keeps. */
  const [actionError, setActionError] = useState<{ text: string; error?: unknown } | null>(null);
  const [savingAction, setSavingAction] = useState<
    "work_package_acknowledgement" | "work_package_stop" | null
  >(null);
  const [savedAction, setSavedAction] = useState<OutboxAction | null>(null);
  const [stopInstructionActive, setStopInstructionActive] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [completingWork, setCompletingWork] = useState(false);
  /**
   * The job plan version this person issued here, kept by the panel: a first issue swaps the
   * empty state for the plan, which remounts the issue form, and its "issued" line must stay.
   */
  const [issuedPlan, setIssuedPlan] = useState<{ packet: string; version: number } | null>(null);
  /** Set before any await, so a second tap in the same moment sends nothing. */
  const commandInFlight = useRef(false);
  /** The automatic resend while the office is still processing the same Start or Finish. */
  const resendTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resendTimer.current), []);
  const principal = { tenantId: session.tenant.id, userId: session.user.id };

  useEffect(() => {
    if (!savedAction || savedAction.state === "verified") return;
    const refresh = () =>
      void getOutboxAction(savedAction.deviceActionId).then(
        (latest) => latest && setSavedAction(latest),
      );
    // A stopped item changes only when the office settles it, so listen instead of polling.
    if (savedAction.state === "needs_attention") return subscribeOutboxChanges(refresh);
    const interval = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(interval);
  }, [savedAction]);

  const commandScope = workPackage ? workObjectScopeForPackage(workPackage) : null;
  const startPath = workPackageStartEndpoint(model.job.id, commandScope);
  const finishPath = workPackageCompleteEndpoint(model.job.id, commandScope);
  const plan = workPackage ? workPlanIdentity(workPackage) : null;

  // A Start or Finish whose answer was lost is kept on this phone; say so when the panel opens.
  useEffect(() => {
    if (!plan) return;
    let active = true;
    const keeper = { tenantId: session.tenant.id, userId: session.user.id };
    void (async () => {
      for (const [path, unconfirmed] of [
        [startPath, startUnconfirmed],
        [finishPath, finishUnconfirmed],
      ] as const) {
        const kept = await keptWorkPlanIntent(workPlanIntentKey(keeper, path), plan);
        if (kept && active) {
          setActionError({ text: unconfirmed });
          return;
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [session.tenant.id, session.user.id, startPath, finishPath, plan]);

  const issueScope = model.scope ?? (workPackage ? workObjectScopeForPackage(workPackage) : null);
  const issuePacketKey = fieldPacketQueryKey(session, model.job.id, issueScope);
  const issuePacket = JSON.stringify(issuePacketKey);
  const reloadIssuePacket = async () => {
    await queryClient.invalidateQueries({ queryKey: issuePacketKey });
  };
  const issueForm = (
    <WorkPackageIssueForm
      session={session}
      assignment={model.assignment}
      workPackage={workPackage}
      endpoint={workPackageEndpointBase(model.job.id, issueScope)}
      allowed={model.allowed_actions.includes("work_package.issue")}
      offline={offline}
      readAt={model.read_model_generated_at}
      issuedVersion={issuedPlan?.packet === issuePacket ? issuedPlan.version : null}
      onIssuedVersionChange={(version) =>
        setIssuedPlan(version === null ? null : { packet: issuePacket, version })
      }
      onIssued={reloadIssuePacket}
      onReload={reloadIssuePacket}
    />
  );

  if (!workPackage) {
    return (
      <div className="space-y-5">
        {issueForm}
        <section
          className="border-2 border-warning/45 bg-warning-soft p-4 sm:p-5"
          aria-labelledby="work-package-heading"
        >
          <p className="text-sm font-semibold text-warning">Job plan</p>
          <h2 id="work-package-heading" className="mt-1 text-2xl font-bold tracking-[-0.03em]">
            No job plan is ready
          </h2>
          <p className="mt-2 leading-6 text-muted">
            Do not start, resume, release a hold point, or change scope. Go online for the latest
            issued plan, or call production.
          </p>
        </section>
      </div>
    );
  }

  const activeWorkPackage = workPackage;
  const currentWorkerUser = session.user.frappe_user_id ?? session.user.id;
  const currentWorkerInFrozenRoster = activeWorkPackage.acknowledgement.workers.some(
    (worker) =>
      worker.required && worker.worker_user.toLowerCase() === currentWorkerUser.toLowerCase(),
  );
  const canCaptureEvidence =
    captureAllowed && Boolean(activeWorkPackage.release_attempt_id) && currentWorkerInFrozenRoster;
  const canAcknowledge =
    model.allowed_actions.includes("work_package.acknowledge") &&
    Boolean(activeWorkPackage.release_attempt_id) &&
    currentWorkerInFrozenRoster &&
    !workPackage.acknowledgement.current_user_acknowledged;
  const canStop = model.allowed_actions.includes("work_package.stop_work");
  const canAttemptSync = navigator.onLine && !isOfflineSession(session);
  const canStart =
    !offline &&
    !stopInstructionActive &&
    canAttemptSync &&
    workPackage.status === "Acknowledged" &&
    Boolean(activeWorkPackage.release_attempt_id) &&
    currentWorkerInFrozenRoster &&
    workPackage.hold_points
      .filter((holdPoint) => holdPoint.release_phase === "Pre-start")
      .every((holdPoint) => holdPoint.released) &&
    model.allowed_actions.includes("work_package.start");
  const completionAllowed = model.allowed_actions.includes("work_package.complete");
  const canComplete = completionAllowed && !offline && canAttemptSync;

  function showActionFailure(error: unknown, copy?: PlainErrorCopy) {
    setActionError({ text: messageFor(error, copy), error });
  }

  async function saveWorkPackageAction(kind: "work_package_acknowledgement" | "work_package_stop") {
    setSavingAction(kind);
    setActionError(null);
    try {
      const payload =
        kind === "work_package_acknowledgement"
          ? workPackageActionPayload(activeWorkPackage, {
              work_package_id: activeWorkPackage.id,
              work_package_version: activeWorkPackage.version,
              release_attempt_id: activeWorkPackage.release_attempt_id,
            })
          : workPackageActionPayload(activeWorkPackage, {
              work_package_id: activeWorkPackage.id,
              work_package_version: activeWorkPackage.version,
              blocker_reason: stopReason.trim(),
            });
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind,
        endpoint: workPackageActionEndpoint(
          model.job.id,
          kind,
          workObjectScopeForPackage(activeWorkPackage),
        ),
        payload,
      });
      setSavedAction(action);
      const queued = await queueOutboxAction(action.deviceActionId);
      setSavedAction(queued);
      if (!canAttemptSync) return;
      await flushOutbox({
        tenantId: session.tenant.id,
        userId: session.user.id,
        csrfToken: session.csrf_token,
        deviceProof: getDeviceSecret,
      });
      const latest = await getOutboxAction(action.deviceActionId);
      if (latest) setSavedAction(latest);
      await queryClient.invalidateQueries({
        queryKey: fieldPacketQueryKey(
          session,
          model.job.id,
          workObjectScopeForPackage(activeWorkPackage),
        ),
      });
    } catch (error) {
      showActionFailure(error, { fallback: savedWorkUnconfirmed });
    } finally {
      setSavingAction(null);
    }
  }

  function saveAcknowledgement() {
    if (!acknowledgementConfirmed) {
      setActionError({ text: "Check the box to show that you read this job plan." });
      return;
    }
    void saveWorkPackageAction("work_package_acknowledgement");
  }

  function saveStopWork() {
    if (!stopReason.trim()) {
      setActionError({ text: "Say why work must stop." });
      return;
    }
    setStopInstructionActive(true);
    void saveWorkPackageAction("work_package_stop");
  }

  /**
   * Start and Finish go straight to the office. The request is kept on this phone before it is
   * sent and dropped only on a definite answer (`afterFailedSend`), so a press after a lost answer,
   * or after signing in again, resends the same request (same device action ID, key and body) and
   * the work cannot start or finish twice. `attempt` counts automatic resends while the office
   * says the same request is still being processed.
   */
  async function sendWorkPlanCommand(kind: "start" | "finish", attempt = 0) {
    if (commandInFlight.current) return;
    if (kind === "start" ? !canStart : !canComplete) return;
    commandInFlight.current = true;
    window.clearTimeout(resendTimer.current);
    const setBusy = kind === "start" ? setStartingWork : setCompletingWork;
    const path = kind === "start" ? startPath : finishPath;
    const key = workPlanIntentKey(principal, path);
    const packetKey = fieldPacketQueryKey(
      session,
      model.job.id,
      workObjectScopeForPackage(activeWorkPackage),
    );
    setBusy(true);
    setActionError(null);
    let resend = false;
    try {
      const activePlan = workPlanIdentity(activeWorkPackage);
      const kept = await keptWorkPlanIntent(key, activePlan);
      // An automatic resend only ever resends: if the kept request was settled meanwhile (a fresh
      // read showed the plan moved on), it never mints a new one.
      if (!kept && attempt > 0) return;
      resend = kept !== undefined;
      const deviceActionId = kept?.deviceActionId ?? crypto.randomUUID();
      const intent = kept ?? {
        deviceActionId,
        path,
        plan: activePlan,
        createdAt: Date.now(),
        body: {
          device_action_id: deviceActionId,
          payload: workPackageActionPayload(activeWorkPackage, {
            work_package_id: activeWorkPackage.id,
            work_package_version: activeWorkPackage.version,
            release_attempt_id: activeWorkPackage.release_attempt_id,
          }),
        },
      };
      if (!kept) await keepWorkPlanIntent(key, intent);
      await apiCommand({
        path: intent.path,
        body: intent.body,
        csrfToken: session.csrf_token,
        idempotencyKey: intent.deviceActionId,
        deviceActionId: intent.deviceActionId,
        deviceProof: getDeviceSecret,
      });
      await dropWorkPlanIntent(key);
      await queryClient.invalidateQueries({ queryKey: packetKey });
    } catch (error) {
      const next = afterFailedSend(error, resend);
      if (next === "drop") await dropWorkPlanIntent(key);
      if (typeof next === "object" && attempt < MAX_IN_PROGRESS_RESENDS) {
        setActionError({ text: workPlanStillRunning(next.waitMs), error });
        // The same kept request goes again, whatever this render's plan shows by then: resending
        // it is safe by design, and a moved-on plan gets a definite answer.
        resendTimer.current = window.setTimeout(
          () => void sendWorkPlanCommand(kind, attempt + 1),
          next.waitMs,
        );
      } else {
        showActionFailure(
          error,
          next === "drop" ? workPlanRefusals : workPlanUnconfirmed(kind, error),
        );
      }
      // Read the plan again unless the office refused the action itself: if the work did start or
      // finish, or the plan moved on, the fresh plan shows it and the kept request is dropped.
      if (next !== "drop" || isIdempotencyConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: packetKey });
      }
    } finally {
      setBusy(false);
      commandInFlight.current = false;
    }
  }

  return (
    <section
      className="border-2 border-foreground bg-surface-raised"
      aria-labelledby="work-package-heading"
    >
      {issueForm}
      <header className="@container border-b border-border px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-muted">Job plan</p>
            <h2 id="work-package-heading" className="mt-1 text-2xl font-bold tracking-[-0.03em]">
              {workPackage.title}
            </h2>
          </div>
          <p className="border border-border bg-surface px-3 py-2 text-sm font-bold">
            {jobPlanBadge(workPackage, dateOptions, session.user.role === "field" ? "12h" : "24h")}
          </p>
        </div>
        <dl className="mt-5 grid gap-4 text-sm @2xl:grid-cols-3">
          <JobFact
            label="Issued"
            value={formatFieldTimestamp(workPackage.issued_at, dateOptions)}
          />
          <JobFact
            label="Released"
            value={formatFieldTimestamp(workPackage.released_at, dateOptions)}
          />
          <JobFact
            label="Expires"
            value={formatFieldTimestamp(workPackage.expires_at, dateOptions)}
          />
        </dl>
        <dl className="mt-4 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2">
          <JobFact
            label="Work object"
            value={`${workPackage.work_object_type} · ${workPackage.work_object_id}`}
          />
          <JobFact
            label="Work area"
            value={`${workPackage.physical_context_type} · ${workPackage.physical_context_id}`}
          />
        </dl>
      </header>

      {offline ? (
        <div
          className="flex items-start gap-3 border-b border-warning/35 bg-warning-soft p-4 text-warning"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p className="font-bold leading-6">
            This saved plan may be old. You may save a review or a Stop Work report. Neither one
            starts work, clears a stop, or changes the job plan.
          </p>
        </div>
      ) : null}

      <div className="space-y-5 p-4 sm:p-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <JobFact label="Goal" value={workPackage.objective} />
          <JobFact label="Done looks like" value={workPackage.expected_result} />
          <JobFact label="Limits" value={workPackage.boundaries} />
          <JobFact label="Before you start" value={workPackage.prerequisites} />
          <JobFact label="When to stop" value={workPackage.stop_conditions} />
          <JobFact label="Make it safe" value={workPackage.make_safe_procedure} />
        </dl>

        {workPackage.supersession ? (
          <section
            className="border-2 border-warning/45 bg-warning-soft p-4"
            aria-labelledby="work-package-change-heading"
          >
            <p className="text-sm font-semibold text-warning">Plan changed</p>
            <h3 id="work-package-change-heading" className="mt-1 text-lg font-bold">
              This plan replaces {workPackage.supersession.prior_id}
            </h3>
            <p className="mt-2 leading-6">{workPackage.supersession.reason}</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Steps changed:{" "}
              {workPackage.supersession.changed_steps.length
                ? workPackage.supersession.changed_steps.join(", ")
                : "none"}{" "}
              · Stops changed:{" "}
              {workPackage.supersession.changed_hold_points.length
                ? workPackage.supersession.changed_hold_points.join(", ")
                : "none"}
            </p>
          </section>
        ) : null}

        <section aria-labelledby="work-package-steps-heading">
          <h3 id="work-package-steps-heading" className="font-bold">
            Work steps
          </h3>
          <ol className="mt-3 space-y-3">
            {workPackage.steps.map((step) => (
              <li key={step.sequence} className="border border-border p-4">
                <p className="font-bold">
                  Step {step.sequence} · {step.instruction}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">Proof: {step.required_evidence}</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Pass when: {step.acceptance_criteria}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="work-package-holds-heading">
          <h3 id="work-package-holds-heading" className="font-bold">
            Stop and check
          </h3>
          <ol className="mt-3 space-y-3">
            {workPackage.hold_points.map((holdPoint) => (
              <li
                key={holdPoint.sequence}
                className={
                  holdPoint.released
                    ? "border border-ok/35 bg-ok-soft p-4"
                    : "border border-warning/35 bg-warning-soft p-4"
                }
              >
                <p className={holdPoint.released ? "font-bold text-ok" : "font-bold text-warning"}>
                  Check {holdPoint.sequence} · {holdPoint.hold_point}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {holdPoint.released
                    ? "The office cleared this check. You still need a live Start work button before you begin."
                    : `Waiting for ${holdPoint.release_authority}. You can add proof, but this app cannot clear the stop.`}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  When: {holdPoint.release_phase} · Proof: {holdPoint.required_evidence} · Pass
                  when: {holdPoint.acceptance_criteria}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-workers-heading"
        >
          <h3 id="work-package-workers-heading" className="font-bold">
            Crew
          </h3>
          {workPackage.acknowledgement.workers.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {workPackage.acknowledgement.workers.map((worker) => (
                <li
                  key={worker.worker_user}
                  className={
                    worker.acknowledged
                      ? "border border-ok/35 bg-ok-soft p-3"
                      : "border border-warning/35 bg-warning-soft p-3"
                  }
                >
                  <p className="font-bold [overflow-wrap:anywhere]">
                    {worker.worker_user} · {worker.worker_role}
                    {worker.required ? " · required" : " · optional"}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    {worker.acknowledged
                      ? `Reviewed${worker.acknowledged_at ? ` at ${formatFieldTimestamp(worker.acknowledged_at, dateOptions)}` : ""}.`
                      : "This worker still needs to review this plan."}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm leading-6 text-warning">
              The crew list is missing. You cannot start work.
            </p>
          )}
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-evidence-heading"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 id="work-package-evidence-heading" className="font-bold">
              Proof needed
            </h3>
            <span className="text-sm font-semibold text-muted">
              {workPackage.evidence_slots.length} saved item
              {workPackage.evidence_slots.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Each photo or note is saved with this plan. A fix adds a new item. It does not delete
            the old one.
          </p>
          <ul className="mt-3 space-y-2">
            {workPackage.steps.map((step) => {
              const slotId = `step:${step.sequence}`;
              const latest = [...workPackage.evidence_slots]
                .reverse()
                .find((item) => item.slot_id === slotId && !item.superseded);
              return (
                <li
                  key={slotId}
                  className="flex flex-wrap items-center justify-between gap-3 border border-border p-3"
                >
                  <div>
                    <p className="font-bold">
                      Step {step.sequence} · {step.required_evidence}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {latest
                        ? `State: ${latest.disposition}. Freshness: ${latest.freshness}. Conflict: ${latest.conflict_state}.`
                        : "No proof added yet"}
                    </p>
                  </div>
                  {canCaptureEvidence ? (
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="inline-flex min-h-11 items-center justify-center border border-foreground px-3 text-sm font-bold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-3"
                        aria-label={`Add proof for step ${step.sequence}`}
                        href={workPackageEvidenceHref(
                          model.job.id,
                          workPackage.id,
                          workPackage.version,
                          workPackage.release_attempt_id ?? "",
                          slotId,
                          step.required_evidence,
                          undefined,
                          workObjectScopeForPackage(workPackage),
                        )}
                      >
                        Add proof
                      </a>
                      {latest && sameFieldActor(latest.actor_user, currentWorkerUser) ? (
                        <a
                          className="inline-flex min-h-11 items-center justify-center border border-warning/60 px-3 text-sm font-bold text-warning underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-3"
                          aria-label={`Fix proof for step ${step.sequence}`}
                          href={workPackageEvidenceHref(
                            model.job.id,
                            workPackage.id,
                            workPackage.version,
                            workPackage.release_attempt_id ?? "",
                            slotId,
                            step.required_evidence,
                            { eventId: latest.event_id, evidenceItem: latest.evidence_item },
                            workObjectScopeForPackage(workPackage),
                          )}
                        >
                          Fix proof
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm font-semibold text-muted">
                      You cannot add proof right now
                    </span>
                  )}
                </li>
              );
            })}
            {workPackage.hold_points.map((holdPoint) => {
              const slotId = `hold:${holdPoint.sequence}`;
              const latest = [...workPackage.evidence_slots]
                .reverse()
                .find((item) => item.slot_id === slotId && !item.superseded);
              return (
                <li
                  key={slotId}
                  className="flex flex-wrap items-center justify-between gap-3 border border-border p-3"
                >
                  <div>
                    <p className="font-bold">
                      Check {holdPoint.sequence} · {holdPoint.required_evidence}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {latest
                        ? `State: ${latest.disposition}. Freshness: ${latest.freshness}. Conflict: ${latest.conflict_state}.`
                        : "No proof added yet"}
                    </p>
                  </div>
                  {canCaptureEvidence ? (
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="inline-flex min-h-11 items-center justify-center border border-foreground px-3 text-sm font-bold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-3"
                        aria-label={`Add proof for stop ${holdPoint.sequence}`}
                        href={workPackageEvidenceHref(
                          model.job.id,
                          workPackage.id,
                          workPackage.version,
                          workPackage.release_attempt_id ?? "",
                          slotId,
                          holdPoint.required_evidence,
                          undefined,
                          workObjectScopeForPackage(workPackage),
                        )}
                      >
                        Add proof
                      </a>
                      {latest && sameFieldActor(latest.actor_user, currentWorkerUser) ? (
                        <a
                          className="inline-flex min-h-11 items-center justify-center border border-warning/60 px-3 text-sm font-bold text-warning underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-3"
                          aria-label={`Fix proof for stop ${holdPoint.sequence}`}
                          href={workPackageEvidenceHref(
                            model.job.id,
                            workPackage.id,
                            workPackage.version,
                            workPackage.release_attempt_id ?? "",
                            slotId,
                            holdPoint.required_evidence,
                            { eventId: latest.event_id, evidenceItem: latest.evidence_item },
                            workObjectScopeForPackage(workPackage),
                          )}
                        >
                          Fix proof
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm font-semibold text-muted">
                      You cannot add proof right now
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-acknowledgement-heading"
        >
          <h3 id="work-package-acknowledgement-heading" className="font-bold">
            Review and agree
          </h3>
          {workPackage.acknowledgement.current_user_acknowledged ? (
            <p className="mt-2 text-sm leading-6 text-ok">
              You reviewed this job plan
              {workPackage.acknowledgement.acknowledged_at
                ? ` at ${formatFieldTimestamp(workPackage.acknowledgement.acknowledged_at, dateOptions)}`
                : ""}
              .
            </p>
          ) : canAcknowledge ? (
            <>
              <label className="mt-3 flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 size-5"
                  checked={acknowledgementConfirmed}
                  onChange={(event) => setAcknowledgementConfirmed(event.target.checked)}
                />
                I read this version. I know its limits, steps, stop rules, safety steps, and checks.
              </label>
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="accent"
                disabled={!acknowledgementConfirmed}
                busy={savingAction === "work_package_acknowledgement"}
                onClick={saveAcknowledgement}
              >
                <Check aria-hidden="true" />I reviewed this plan
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-muted">
              You can agree only when the server sends a current plan. This does not start work.
            </p>
          )}
        </section>

        <section className="border border-border p-4" aria-labelledby="work-package-start-heading">
          <h3 id="work-package-start-heading" className="font-bold">
            Start work
          </h3>
          {canStart ? (
            <>
              <p className="mt-2 text-sm leading-6 text-muted">
                This asks the server to start the current plan. It only works online.
              </p>
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="accent"
                busy={startingWork}
                onClick={() => void sendWorkPlanCommand("start")}
              >
                Start work
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-muted">
              Go online and open the latest plan. The Start work button will show when every check
              is clear.
            </p>
          )}
        </section>

        {completionAllowed ? (
          <section
            className="border-2 border-ok/45 bg-ok-soft p-4"
            aria-labelledby="work-package-completion-heading"
          >
            <h3 id="work-package-completion-heading" className="font-bold text-ok">
              Finish this job plan
            </h3>
            {canComplete ? (
              <>
                <p className="mt-2 text-sm leading-6 text-muted">
                  The crew checks, work stops, and proof checks are clear. This button works online.
                </p>
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  className="mt-4"
                  variant="accent"
                  busy={completingWork}
                  onClick={() => void sendWorkPlanCommand("finish")}
                >
                  <Check aria-hidden="true" />
                  Finish work
                </Button>
              </>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted">
                You can finish only when you are online and every required check is clear.
              </p>
            )}
          </section>
        ) : null}

        <section
          className="border-2 border-danger/55 bg-danger-soft/45 p-4"
          aria-labelledby="stop-work-heading"
        >
          <h3 id="stop-work-heading" className="font-bold text-danger">
            Stop Work
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted">
            If a stop rule applies, stop now and make the area safe. Saving this report does not
            change the job until the server gets it.
          </p>
          {stopInstructionActive ? (
            <p className="mt-3 font-bold leading-6 text-danger" role="alert">
              Stop now. Make the area safe. This report will send when the phone is online.
            </p>
          ) : null}
          {canStop ? (
            <>
              <label className="mt-4 block font-bold" htmlFor="work-package-stop-reason">
                What requires work to stop?
              </label>
              <Textarea
                id="work-package-stop-reason"
                className="mt-2 min-h-28 rounded-none bg-surface"
                maxLength={1000}
                value={stopReason}
                onChange={(event) => setStopReason(event.target.value)}
              />
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="danger"
                busy={savingAction === "work_package_stop"}
                onClick={saveStopWork}
              >
                <AlertTriangle aria-hidden="true" />
                Stop Work and save report
              </Button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-6 text-muted">
              You cannot send another Stop Work report from this plan. Stop now if needed and call
              production.
            </p>
          )}
        </section>

        {actionError ? (
          <div role="alert">
            <p className="font-semibold text-danger">{actionError.text}</p>
            <ErrorSystemDetails error={actionError.error} />
          </div>
        ) : null}
        {savedAction ? <WorkPackageActionState action={savedAction} /> : null}
        {!offline && !canAttemptSync ? (
          <p className="text-sm leading-6 text-warning" role="status">
            Sign in online before this phone can send the saved job plan update.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function WorkPackageActionState({ action }: { action: OutboxAction }) {
  const review = action.kind === "work_package_acknowledgement";
  const label = review ? "Plan review" : "Stop Work report";
  const guidance = outboxFailureGuidance(action);
  const detail =
    action.state === "verified"
      ? guidance.officeConfirmed
        ? `The office confirmed it has your ${review ? "plan review" : label}. Nothing else to do with it.`
        : "The server got this update. Open the plan again to see the latest work state."
      : action.state === "needs_attention"
        ? `${guidance.reason} ${guidance.nextStep} It did not change the plan or unlock work.`
        : `${label} is saved on this phone and is waiting to send. It does not change the plan or unlock work.`;
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 border border-border bg-surface-muted p-4"
      role="status"
    >
      <p className="max-w-xl text-sm leading-6 text-muted">{detail}</p>
      <OutboxStateBadge state={action.state} />
    </div>
  );
}

function WorkStatus({
  model,
  blockedGates,
  dateOptions,
}: {
  model: JobResponse;
  blockedGates: JobResponse["gates"];
  dateOptions: FieldDateOptions;
}) {
  const blocked = blockedGates.length > 0;
  return (
    <section
      aria-labelledby="work-status-heading"
      className="border border-border bg-surface-raised"
    >
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="text-sm font-semibold text-muted">Before work starts</p>
        <h2 id="work-status-heading" className="mt-1 text-2xl font-bold tracking-[-0.03em]">
          Work checks
        </h2>
      </header>
      <div
        className={
          blocked ? "bg-danger-soft p-4 text-danger sm:p-5" : "bg-surface-muted p-4 sm:p-5"
        }
      >
        <div className="flex items-start gap-3">
          {blocked ? (
            <AlertTriangle className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
          ) : (
            <ClipboardCheck className="mt-0.5 size-6 shrink-0 text-info" aria-hidden="true" />
          )}
          <div>
            <p className="text-lg font-bold tracking-[-0.02em]">
              {blocked
                ? `${blockedGates.length} ${blockedGates.length === 1 ? "check blocks" : "checks block"} work`
                : model.job.current_gate_state
                  ? `Work check: ${model.job.current_gate_state}`
                  : "No work check was sent"}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted">
              {blocked
                ? "You can add proof of the block. Only the office can clear this work check."
                : "A clear work check is not a safety pass. Read the safety plan before work."}
            </p>
          </div>
        </div>
      </div>
      {model.gates.length > 0 ? (
        <ol className="divide-y divide-border">
          {model.gates.map((gate) => (
            <li key={gate.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <GateChip name={gate.name ?? "Work check"} state={gate.state ?? "Unknown"} />
                {gate.due_at ? (
                  <p className="text-sm font-semibold text-muted">
                    Due {formatFieldSchedule(gate.due_at, dateOptions)}
                  </p>
                ) : null}
              </div>
              {gate.blocker_reason ? (
                <p className="mt-3 font-semibold leading-6">{gate.blocker_reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function CaptureProofPanel({
  jobId,
  workObjectScope,
  blocked,
  fieldCaptureAllowed,
  fieldRole,
  onPhotosSelected,
  error,
}: {
  jobId: string;
  workObjectScope: TypedWorkObjectScope | null;
  blocked: boolean;
  fieldCaptureAllowed: boolean;
  fieldRole: boolean;
  onPhotosSelected?: (files: FileList | null) => void;
  error?: string | null;
}) {
  if (!fieldCaptureAllowed) {
    return (
      <section
        className="border border-border bg-surface-muted p-4 sm:p-5"
        aria-labelledby="capture-boundary-heading"
      >
        <p className="text-sm font-semibold text-muted">Add job proof</p>
        <h2 id="capture-boundary-heading" className="mt-1 text-xl font-bold tracking-[-0.025em]">
          {fieldRole ? "Current job needed" : "View only"}
        </h2>
        <p className="mt-2 leading-6 text-muted">
          {fieldRole
            ? "This job is not assigned to you, so you cannot add proof."
            : "Only the assigned field crew can add proof from this plan."}
        </p>
      </section>
    );
  }
  return (
    <section
      className="border-2 border-foreground bg-surface-raised p-4 sm:p-5"
      aria-labelledby="capture-proof-heading"
    >
      <div className="flex flex-col gap-4">
        <div className="max-w-2xl">
          <h2 id="capture-proof-heading" className="mt-1 text-2xl font-bold tracking-[-0.03em]">
            {blocked ? "Show the blocked site" : "Show this site"}
          </h2>
          <p className="mt-2 leading-6 text-muted">
            {blocked
              ? "Add a photo or note that shows the block. This does not clear the work check."
              : "Add photos, a voice note, or a site note. Capturing proof does not authorize work."}
          </p>
        </div>
        {onPhotosSelected ? (
          <label className="environment-control flex min-h-16 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-center text-base font-bold text-primary-foreground focus-within:outline focus-within:outline-3 focus-within:outline-focus focus-within:outline-offset-3">
            <Camera aria-hidden="true" className="size-5" />
            Take photo
            <input
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              capture="environment"
              aria-label="Take photo for this job"
              onChange={(event) => {
                onPhotosSelected(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        ) : null}
        {error ? (
          <p className="text-base font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button asChild size="field" variant={onPhotosSelected || blocked ? "outline" : "accent"}>
            <a href={fieldCheckInHref(jobId, workObjectScope)}>
              <Camera aria-hidden="true" />
              {blocked ? "Add blocker proof" : "Add job proof"}
            </a>
          </Button>
          <Button asChild size="field" variant="outline">
            <a
              href={`${fieldCheckInHref(jobId, workObjectScope)}${workObjectScope ? "&" : "?"}capture_purpose=measurement`}
            >
              <ClipboardCheck aria-hidden="true" />
              Measurement evidence
            </a>
          </Button>
        </div>
        <p className="text-base leading-6 text-muted">
          Measurement photos and readings go to the office for review. They do not update the
          survey, design, or cut list.
        </p>
      </div>
    </section>
  );
}

function SafetyAndAccess({
  model,
  dateOptions,
}: {
  model: JobResponse;
  dateOptions: FieldDateOptions;
}) {
  const safety = model.packet.safety_plan;
  const contact = model.packet.contact;
  const officePhone = useSession().tenant.office_phone ?? null;
  const safetyFacts = safety
    ? [
        [
          "Effective",
          safety.effective_date ? formatFieldSchedule(safety.effective_date, dateOptions) : null,
        ],
        ["Hazards", safety.hazard_summary],
        ["Controls", safety.controls],
        ["PPE", safety.ppe_requirements],
        ["Weather limits", safety.weather_limits],
        ["Emergency plan", safety.emergency_plan],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];
  return (
    <section aria-labelledby="safety-access-heading" className="@container space-y-4">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">Check before work</p>
        <h2
          id="safety-access-heading"
          className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl"
        >
          Safety and site
        </h2>
      </header>
      <EmergencyLine officePhone={officePhone} />
      <div className="grid gap-4 @3xl:grid-cols-2">
        <article className="border border-border bg-surface-raised p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <HardHat className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="font-bold">
                Safety plan{safety?.version ? ` · v${safety.version}` : ""}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {safety?.status ?? "No safety plan is in this job."}
              </p>
            </div>
          </div>
          {safetyFacts.length > 0 ? (
            <dl className="mt-5 space-y-4">
              {safetyFacts.map(([label, value]) => (
                <JobFact key={label} label={label} value={value} />
              ))}
            </dl>
          ) : (
            <p className="mt-5 rounded-md border border-warning pl-3 text-sm font-semibold leading-6 text-warning">
              The safety plan is missing. Do not start work.
            </p>
          )}
        </article>
        <article className="border border-border bg-surface-raised p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
            <div>
              <p className="font-bold">Job contact and access</p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {contact?.display_name ?? "Contact name is missing"}
              </p>
            </div>
          </div>
          {dialableNumber(contact?.phone) ? (
            <Button asChild variant="outline" size="field" fullWidth className="mt-5">
              <a href={`tel:${dialableNumber(contact?.phone)}`}>
                <Phone aria-hidden="true" />
                Call job contact
              </a>
            </Button>
          ) : contact?.phone ? (
            <p className="mt-5 text-sm font-semibold">{contact.phone}</p>
          ) : (
            <p className="mt-5 text-sm font-semibold text-muted">Phone number is missing</p>
          )}
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-xs font-bold text-muted">How to enter the site</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {contact?.access_instructions ?? "Site entry steps are missing."}
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function PacketDetails({
  model,
  dateOptions,
}: {
  model: JobResponse;
  dateOptions: FieldDateOptions;
}) {
  const materialCount =
    model.packet.materials.takeoffs.length + model.packet.materials.supplier_orders.length;
  // The server already tells us which slots it cannot fill on this path; the panels just never
  // read it, so every empty one claimed the job had none.
  const uncarried = (...fields: string[]) => fields.some((f) => model.stale_fields.includes(f));
  return (
    <section aria-labelledby="packet-details-heading" className="space-y-4">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">More job details</p>
        <h2
          id="packet-details-heading"
          className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl"
        >
          Job details
        </h2>
      </header>
      <div className="divide-y divide-border border-y border-border">
        <PacketDetail
          title="Approved scope"
          count={model.packet.scope_clauses.length}
          unavailable={uncarried("packet.scope_clauses.native_unavailable")}
        >
          {model.packet.scope_clauses.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.title ?? item.type ?? "Scope"}
              detail={item.text}
            />
          ))}
        </PacketDetail>
        <PacketDetail
          title="Measurements"
          count={model.packet.measurements.length}
          unavailable={uncarried("packet.measurements.native_unavailable")}
        >
          {model.packet.measurements.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.provider ?? "Measurement"}
              detail={joinKnown([
                item.review_status,
                item.parsed_at
                  ? `Parsed ${formatFieldSchedule(item.parsed_at, dateOptions)}`
                  : null,
              ])}
            />
          ))}
        </PacketDetail>
        <PacketDetail
          title="Materials"
          count={materialCount}
          unavailable={uncarried(
            "packet.materials.takeoffs.native_unavailable",
            "packet.materials.supplier_orders.native_unavailable",
          )}
        >
          {model.packet.materials.takeoffs.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title="Takeoff"
              detail={joinKnown([
                item.status,
                item.prepared_at
                  ? `Prepared ${formatFieldSchedule(item.prepared_at, dateOptions)}`
                  : null,
              ])}
            />
          ))}
          {model.packet.materials.supplier_orders.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title="Supplier order"
              detail={joinKnown([
                item.status,
                item.delivery_notes,
                item.requested_delivery_date
                  ? `Requested ${formatFieldSchedule(item.requested_delivery_date, dateOptions)}`
                  : null,
              ])}
            />
          ))}
        </PacketDetail>
        <PacketDetail
          title="Change orders"
          count={model.packet.change_orders.length}
          unavailable={uncarried("packet.change_orders.native_unavailable")}
        >
          {model.packet.change_orders.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.title ?? item.number ?? "Change order"}
              detail={joinKnown([
                item.status,
                item.scope_delta,
                item.version !== null ? `v${item.version}` : null,
              ])}
            />
          ))}
        </PacketDetail>
      </div>
    </section>
  );
}

function PacketDetail({
  title,
  count,
  unavailable = false,
  children,
}: {
  title: string;
  count: number;
  /** The server said it does not carry this slot here -- not that the job has none of it. */
  unavailable?: boolean;
  children: ReactNode;
}) {
  return (
    <details>
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-1 py-4 font-bold [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="text-sm font-semibold text-muted">
          {unavailable && count === 0
            ? "Not shown here"
            : `${count} ${count === 1 ? "item" : "items"}`}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border pb-5 pt-4">
        {count ? (
          children
        ) : unavailable ? (
          /*
            An empty panel used to say "No items are in this work plan" whatever the reason, so a
            slot this system does not carry yet read to a crew on a roof as a fact about the job:
            no approved scope, no change orders. That is the one thing this screen must never say
            by accident, so an uncarried slot now says so and points at someone who would know.
          */
          <p className="text-sm leading-6 text-muted">
            This screen does not carry {title.toLowerCase()} yet. Do not read that as none — ask the
            office before you rely on it.
          </p>
        ) : (
          <p className="text-sm leading-6 text-muted">No items are in this job plan.</p>
        )}
      </div>
    </details>
  );
}

function PacketEvidenceLine({ title, detail }: { title: string; detail: string | null }) {
  return (
    <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
      <p className="font-bold">{title}</p>
      {detail ? <p className="mt-1 text-sm leading-6 text-muted">{detail}</p> : null}
    </div>
  );
}

/**
 * Who to call in an emergency, with a control for each: 911 first, then the office from the
 * company's profile (safety block, rework ruling). Never a literal office number in code; while the
 * profile gives none, the line still says to call the office and offers 911.
 */
function EmergencyLine({ officePhone }: { officePhone: string | null }) {
  const dialable = dialableNumber(officePhone);
  return (
    <div
      className="border-2 border-danger/45 bg-danger-soft p-4 sm:p-5"
      role="region"
      aria-labelledby="emergency-line"
    >
      <p id="emergency-line" className="font-bold leading-6">
        Emergency: call 911 · then the office{officePhone ? `, ${officePhone}` : ""}
      </p>
      <div className="mt-3 grid gap-2 @md:grid-cols-2">
        <Button asChild variant="danger" size="field" fullWidth>
          <a href="tel:911">
            <Phone aria-hidden="true" />
            Call 911
          </a>
        </Button>
        {dialable ? (
          <Button asChild variant="outline" size="field" fullWidth>
            <a href={`tel:${dialable}`}>
              <Phone aria-hidden="true" />
              Call the office
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The number a tel: link may dial, or null when the text is not one plain phone number. A label
 * before it ("Cell:") and anything after an extension mark ("ext", "x", "#", ",") are left out;
 * only digits, spaces, dots, dashes and brackets may stand around the digits, a "+" only first.
 * A local number has 7 or 10 digits, or 11 starting with 1; an international one ("+") 8 to 15
 * digits with no "(0)" trunk group. A shown number that is not dialable gets no Call button,
 * never a wrong one.
 */
export function dialableNumber(text: string | null | undefined): string | null {
  const number = (text ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/^[^\d+(]*:\s*/, "")
    .split(/\s*(?:ext\.?|x|#|,)/i)[0]!
    .trim();
  if (!/^\+?[\d\s().-]+$/.test(number)) return null;
  const digits = number.replace(/\D/g, "");
  if (number.startsWith("+")) {
    if (/\(\s*0\s*\)/.test(number) || digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const local =
    digits.length === 7 || digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  return local ? digits : null;
}

function JobFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 font-semibold leading-6">{value}</dd>
    </div>
  );
}

function joinKnown(values: Array<string | null>): string | null {
  const known = values.filter((value): value is string => Boolean(value));
  return known.length > 0 ? known.join(" · ") : null;
}

function sameFieldActor(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function workPackageActionEndpoint(
  jobId: string,
  kind: "work_package_acknowledgement" | "work_package_stop",
  scope: TypedWorkObjectScope | null = null,
): string {
  const base = workPackageEndpointBase(jobId, scope);
  return kind === "work_package_acknowledgement" ? `${base}/acknowledgements` : `${base}/stop-work`;
}

function workPackageStartEndpoint(
  jobId: string,
  scope: TypedWorkObjectScope | null = null,
): string {
  return `${workPackageEndpointBase(jobId, scope)}/start`;
}

function workPackageCompleteEndpoint(
  jobId: string,
  scope: TypedWorkObjectScope | null = null,
): string {
  return `${workPackageEndpointBase(jobId, scope)}/complete`;
}

function workPackageEndpointBase(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/api/v1/jobs/${encodeURIComponent(jobId)}/work-package`;
  return `/api/v1/work-objects/${encodeURIComponent(scope.work_object_type)}/${encodeURIComponent(scope.work_object_id)}/physical-contexts/${encodeURIComponent(scope.physical_context_type)}/${encodeURIComponent(scope.physical_context_id)}/work-package`;
}

function fieldCheckInHref(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/check-in/${encodeURIComponent(jobId)}`;
  const query = new URLSearchParams({
    work_object_type: scope.work_object_type,
    work_object_id: scope.work_object_id,
    physical_context_type: scope.physical_context_type,
    physical_context_id: scope.physical_context_id,
  });
  return `/check-in/${encodeURIComponent(jobId)}?${query.toString()}`;
}

function fieldCheckInEndpoint(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/api/v1/jobs/${encodeURIComponent(jobId)}/check-ins`;
  return `${workObjectEndpointBase(scope)}/check-ins`;
}

function workObjectEndpointBase(scope: TypedWorkObjectScope): string {
  return `/api/v1/work-objects/${encodeURIComponent(scope.work_object_type)}/${encodeURIComponent(scope.work_object_id)}/physical-contexts/${encodeURIComponent(scope.physical_context_type)}/${encodeURIComponent(scope.physical_context_id)}`;
}

function workPackageEvidenceHref(
  jobId: string,
  workPackageId: string,
  version: number,
  releaseAttemptId: string,
  slotId: string,
  requirement: string,
  correction?: { eventId: string; evidenceItem: string },
  scope: TypedWorkObjectScope | null = null,
): string {
  const query = new URLSearchParams({
    work_package_id: workPackageId,
    work_package_version: String(version),
    evidence_slot_id: slotId,
    evidence_requirement: requirement,
    evidence_source: "field-companion",
    work_package_release_attempt_id: releaseAttemptId,
    ...(correction
      ? {
          evidence_correction_of: correction.eventId,
          evidence_item_correction_of: correction.evidenceItem,
        }
      : {}),
    ...(scope
      ? {
          work_object_type: scope.work_object_type,
          work_object_id: scope.work_object_id,
          physical_context_type: scope.physical_context_type,
          physical_context_id: scope.physical_context_id,
        }
      : {}),
  });
  return `/check-in/${encodeURIComponent(jobId)}?${query.toString()}`;
}

export function CheckInPage() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  if (!jobId) {
    return (
      <RoleGuard surface="field">
        <EmptyState
          title="Choose an assigned job"
          message="Pick a job on Today. Each check-in is tied to that job."
          action={
            <Button asChild size="field" variant="accent">
              <Link to="/today">Back to Today</Link>
            </Button>
          }
        />
      </RoleGuard>
    );
  }
  return <CheckInFlow key={jobId} jobId={jobId} />;
}

type EvidenceCaptureContext = {
  workPackageId: string;
  workPackageVersion: number;
  workPackageReleaseAttemptId: string;
  evidenceSlotId: string;
  evidenceRequirement: string;
  evidenceSource: string;
  evidenceCorrectionOf: string | null;
  evidenceItemCorrectionOf: string | null;
};

function workObjectScopeFromLocation(): TypedWorkObjectScope | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const values = {
    work_object_type: params.get("work_object_type")?.trim() ?? "",
    work_object_id: params.get("work_object_id")?.trim() ?? "",
    physical_context_type: params.get("physical_context_type")?.trim() ?? "",
    physical_context_id: params.get("physical_context_id")?.trim() ?? "",
  };
  const present = Object.values(values).some(Boolean);
  if (!present) return null;
  if (Object.values(values).some((value) => !value)) return null;
  if (values.work_object_type === "Roof Job") return null;
  return values;
}

function toCheckInJobResponse(model: WorkObjectResponse): JobResponse {
  return {
    version: model.version,
    source_updated_at: model.source_updated_at,
    read_model_generated_at: model.read_model_generated_at,
    stale_fields: model.stale_fields,
    permissions: model.permissions,
    allowed_actions: model.allowed_actions,
    job: {
      id: model.work_object.workObjectId,
      roof_job_id: null,
      job_number: null,
      brand: null,
      service_type: model.work_object.workObjectType,
      status: model.work_package?.status ?? null,
      address: `${model.work_object.physicalContextType} · ${model.work_object.physicalContextId}`,
      current_gate_state: null,
    },
    assignment: model.assignment,
    gates: [],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: model.work_package,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}

function evidenceCaptureContext(): EvidenceCaptureContext | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const workPackageId = params.get("work_package_id")?.trim() ?? "";
  const evidenceSlotId = params.get("evidence_slot_id")?.trim() ?? "";
  const evidenceRequirement = params.get("evidence_requirement")?.trim() ?? "";
  const workPackageVersion = Number(params.get("work_package_version"));
  const workPackageReleaseAttemptId = params.get("work_package_release_attempt_id")?.trim() ?? "";
  const evidenceCorrectionOf = params.get("evidence_correction_of")?.trim() || null;
  const evidenceItemCorrectionOf = params.get("evidence_item_correction_of")?.trim() || null;
  if (
    !workPackageId ||
    !evidenceSlotId ||
    !evidenceRequirement ||
    !workPackageReleaseAttemptId ||
    !Number.isInteger(workPackageVersion) ||
    workPackageVersion < 1
  ) {
    return null;
  }
  if (Boolean(evidenceCorrectionOf) !== Boolean(evidenceItemCorrectionOf)) return null;
  return {
    workPackageId,
    workPackageVersion,
    workPackageReleaseAttemptId,
    evidenceSlotId,
    evidenceRequirement,
    evidenceSource: params.get("evidence_source")?.trim() || "field-companion",
    evidenceCorrectionOf,
    evidenceItemCorrectionOf,
  };
}

function CheckInFlow({
  jobId,
  initialPhotos = [],
  onReturnToJob,
}: {
  jobId: string;
  initialPhotos?: File[];
  onReturnToJob?: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const stepPanelRef = useRef<HTMLElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const typedScope = workObjectScopeFromLocation();
  const jobQuery = useQuery({
    queryKey: typedScope
      ? [
          "work-object",
          session.tenant.id,
          session.user.id,
          typedScope.work_object_type,
          typedScope.work_object_id,
          typedScope.physical_context_type,
          typedScope.physical_context_id,
        ]
      : ["job", session.tenant.id, session.user.id, jobId],
    queryFn: async () =>
      typedScope
        ? toCheckInJobResponse(
            await loadWorkObject(session, {
              workObjectType: typedScope.work_object_type,
              workObjectId: typedScope.work_object_id,
              physicalContextType: typedScope.physical_context_type,
              physicalContextId: typedScope.physical_context_id,
            }),
          )
        : loadJob(session, jobId),
  });
  const startedAt = useRef(new Date().toISOString());
  const [step, setStep] = useState(initialPhotos.length > 0 ? 2 : 1);
  const [photos, setPhotos] = useState<File[]>(initialPhotos);
  const [measurementEvidence, setMeasurementEvidence] = useState(
    () => new URLSearchParams(window.location.search).get("capture_purpose") === "measurement",
  );
  const [voice, setVoice] = useState<File | null>(null);
  const [proofSlot, setProofSlot] = useState("Production");
  const [notes, setNotes] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [blocker, setBlocker] = useState(false);
  const [blockerCategory, setBlockerCategory] = useState("Safety");
  const [blockerSummary, setBlockerSummary] = useState("");
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);
  const [locationPermissionState, setLocationPermissionState] = useState<
    "not_requested" | "granted" | "denied" | "unavailable" | "error"
  >("not_requested");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAction, setSavedAction] = useState<OutboxAction | null>(null);
  const lastScrollStep = useRef(0);
  const typedEvidence = evidenceCaptureContext();

  useEffect(() => {
    if (!savedAction || savedAction.state === "verified") return;
    const refresh = () =>
      void getOutboxAction(savedAction.deviceActionId).then(
        (latest) => latest && setSavedAction(latest),
      );
    // A stopped item changes only when the office settles it, so listen instead of polling.
    if (savedAction.state === "needs_attention") return subscribeOutboxChanges(refresh);
    const interval = window.setInterval(refresh, 1000);
    return () => window.clearInterval(interval);
  }, [savedAction]);

  useEffect(() => {
    if (lastScrollStep.current === step) return;
    const panel = stepPanelRef.current;
    if (!panel || typeof panel.scrollIntoView !== "function") return;
    const initialStep = lastScrollStep.current === 0;
    lastScrollStep.current = step;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const crewHeader = panel.closest(".crew")?.querySelector(".crew-top");
    const headerBottom = Math.max(0, crewHeader?.getBoundingClientRect().bottom ?? 112);
    panel.style.scrollMarginTop = `${headerBottom + 16}px`;
    panel.scrollIntoView({
      block: "start",
      behavior: initialStep || reduceMotion ? "auto" : "smooth",
    });
    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [step, jobQuery.isPending]);

  if (session.user.role !== "field") {
    return (
      <ErrorState
        title="Assigned field account required"
        message="Office users can read job plans but cannot add field proof."
      />
    );
  }

  // A stored receipt is independent of whether the next plan read succeeds or the assignment
  // changes. Keep showing the saved/queued/verified result until the person leaves it.
  if (step === 3 && savedAction) {
    return (
      <RoleGuard surface="field">
        <section className="mx-auto max-w-3xl space-y-4 pb-8">
          <h1 className="text-2xl font-bold tracking-[-0.03em]">Job proof receipt</h1>
          <section ref={stepPanelRef} className="scroll-mt-32">
            <CheckInSaved
              action={savedAction}
              jobId={jobId}
              headingRef={stepHeadingRef}
              onReturnToJob={onReturnToJob}
            />
          </section>
        </section>
      </RoleGuard>
    );
  }

  if (jobQuery.isPending) return <LoadingState label="Opening job…" />;
  if (jobQuery.isError)
    return (
      <ErrorState
        message={messageForLoad(jobQuery.error, jobReadRefusals)}
        error={jobQuery.error}
        onRetry={() => void jobQuery.refetch()}
      />
    );
  const model = jobQuery.data;
  if (!model.allowed_actions.includes("field.checkin.create")) {
    return (
      <ErrorState
        title="You cannot add a check-in"
        message="Open the job again and refresh it. The job must be assigned to you."
      />
    );
  }
  const assignmentId = model.assignment?.id;
  if (!assignmentId) {
    return (
      <ErrorState
        title="Assignment required"
        message="This job no longer has an active field assignment. Return to Today and refresh."
      />
    );
  }
  const activeAssignmentId = assignmentId;

  function choosePhotos(files: FileList | null) {
    const next = files ? [...files] : [];
    const combined = [...photos, ...next];
    const error = validateMedia([...combined, ...(voice ? [voice] : [])]);
    setFormError(error);
    if (!error) setPhotos(combined);
  }

  function chooseVoice(files: FileList | null) {
    const next = files?.[0] ?? null;
    const error = validateMedia([...photos, ...(next ? [next] : [])]);
    setFormError(error);
    if (!error) setVoice(next);
  }

  function removePhoto(index: number) {
    setPhotos((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setFormError(null);
  }

  function removeVoice() {
    setVoice(null);
    setFormError(null);
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationPermissionState("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocationPermissionState("granted");
      },
      (error) => {
        setLocation(null);
        setLocationPermissionState(error.code === error.PERMISSION_DENIED ? "denied" : "error");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  function moveToStep(nextStep: number) {
    setStep(nextStep);
  }

  async function save() {
    const files = [...photos, ...(voice ? [voice] : [])];
    const mediaError = validateMedia(files);
    if (mediaError) return setFormError(mediaError);
    if (measurementEvidence && !notes.trim())
      return setFormError(
        "Add the readings, units, and where you measured for the office to review.",
      );
    if (files.length === 0 && !notes.trim() && !blocker)
      return setFormError("Add a photo, voice note, field note, or blocker before saving.");
    if (typedEvidence && files.length === 0)
      return setFormError("This proof item needs at least one photo or voice note.");
    if (blocker && !blockerSummary.trim())
      return setFormError("Describe what is blocked so the office can act.");
    if (typedEvidence?.evidenceCorrectionOf && !correctionReason.trim())
      return setFormError("Say why this file fixes the old proof.");
    if (typedEvidence?.evidenceCorrectionOf && files.length !== 1)
      return setFormError("Add one file only when you fix old proof.");
    setSaving(true);
    setFormError(null);
    try {
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "field_checkin",
        endpoint: fieldCheckInEndpoint(jobId, typedScope),
        payload: {
          assignment_id: activeAssignmentId,
          proof_slot: proofSlot,
          capture_started_at: startedAt.current,
          capture_completed_at: new Date().toISOString(),
          notes: measurementEvidence
            ? `Measurement evidence for office review\n${notes.trim()}`
            : notes.trim() || null,
          blocker,
          blocker_category: blocker ? blockerCategory : null,
          blocker_summary: blocker ? blockerSummary.trim() : null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          location_accuracy_m: location?.accuracy ?? null,
          location_permission_state: locationPermissionState,
          correction_of: null,
          correction_reason: typedEvidence?.evidenceCorrectionOf ? correctionReason.trim() : null,
          evidence_correction_of: typedEvidence?.evidenceCorrectionOf ?? null,
          evidence_item_correction_of: typedEvidence?.evidenceItemCorrectionOf ?? null,
          work_package_release_attempt_id: typedEvidence
            ? typedEvidence.workPackageReleaseAttemptId
            : null,
          customer_safe_requested: false,
          ...(typedEvidence
            ? {
                work_package_id: typedEvidence.workPackageId,
                work_package_version: typedEvidence.workPackageVersion,
                evidence_slot_id: typedEvidence.evidenceSlotId,
                evidence_requirement: typedEvidence.evidenceRequirement,
                evidence_source: typedEvidence.evidenceSource,
                evidence_freshness: "Current",
                evidence_conflict_state: "None",
                evidence_verification: "Verified",
                evidence_disposition: "Open",
              }
            : {}),
        },
        attachments: files.map((file) => ({
          blob: file,
          fileName: file.name,
          lastModified: file.lastModified,
        })),
      });
      setSavedAction(action);
      const queued = await queueOutboxAction(action.deviceActionId);
      setSavedAction(queued);
      setStep(3);
      if (navigator.onLine && session.csrf_token !== "offline-session-no-csrf") {
        await flushOutbox({
          tenantId: session.tenant.id,
          userId: session.user.id,
          csrfToken: session.csrf_token,
          deviceProof: getDeviceSecret,
        });
        const latest = await getOutboxAction(action.deviceActionId);
        if (latest) setSavedAction(latest);
        await queryClient.invalidateQueries({
          queryKey: typedScope
            ? [
                "work-object",
                session.tenant.id,
                session.user.id,
                typedScope.work_object_type,
                typedScope.work_object_id,
                typedScope.physical_context_type,
                typedScope.physical_context_id,
              ]
            : ["job", session.tenant.id, session.user.id, jobId],
        });
      }
    } catch (error) {
      setFormError(messageFor(error, { fallback: savedWorkUnconfirmed }));
    } finally {
      setSaving(false);
    }
  }

  const selectedMedia = [...photos, ...(voice ? [voice] : [])];
  const saveMessage =
    navigator.onLine && session.csrf_token !== "offline-session-no-csrf"
      ? "Saves on this device first, then sends while the app stays open."
      : "Saves on this device and queues when this app is open.";

  return (
    <RoleGuard surface="field">
      <section className="field-capture-flow mx-auto max-w-3xl space-y-4 pb-16 lg:pb-4">
        <CheckInHeader model={model} />
        <CheckInProgress step={step} />
        {formError ? (
          <div
            className="border border-danger/35 bg-danger-soft p-4 font-bold leading-6 text-danger"
            role="alert"
          >
            {formError}
          </div>
        ) : null}
        {step === 1 ? (
          <section
            ref={stepPanelRef}
            className="scroll-mt-32 border border-border bg-surface-raised"
            aria-labelledby="capture-evidence-heading"
          >
            <header className="border-b border-border px-4 py-3 sm:px-5">
              <h2
                ref={stepHeadingRef}
                id="capture-evidence-heading"
                tabIndex={-1}
                className="text-2xl font-bold tracking-[-0.03em]"
              >
                Capture what you see
              </h2>
            </header>
            <div className="space-y-4 p-4 sm:p-5">
              <label className="grid min-h-16 cursor-pointer place-items-center border-2 border-foreground bg-foreground px-4 text-center text-background focus-within:outline focus-within:outline-3 focus-within:outline-focus focus-within:outline-offset-3">
                <span className="flex items-center gap-2 text-lg font-bold">
                  <Camera aria-hidden="true" />
                  Take photos
                </span>
                <span className="mt-1 text-sm font-semibold text-background/75">
                  Up to 12 files
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  capture="environment"
                  multiple
                  onChange={(event) => choosePhotos(event.target.files)}
                />
              </label>
              <label className="grid min-h-16 cursor-pointer place-items-center border border-border bg-surface px-4 text-center text-lg font-bold focus-within:outline focus-within:outline-3 focus-within:outline-focus focus-within:outline-offset-3">
                <span className="flex items-center gap-2">
                  <Mic aria-hidden="true" />
                  Add voice note
                </span>
                <span className="mt-1 text-sm font-semibold text-muted">
                  Optional voice note for your team
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/webm,audio/wav,audio/x-wav"
                  capture
                  onChange={(event) => chooseVoice(event.target.files)}
                />
              </label>
              <CaptureReview
                photos={photos}
                voice={voice}
                onRemovePhoto={removePhoto}
                onRemoveVoice={removeVoice}
              />
              <button
                type="button"
                aria-pressed={measurementEvidence}
                className="environment-control flex min-h-12 w-full items-center gap-2 rounded-md border border-border-control bg-surface px-4 py-3 text-left text-base font-semibold text-foreground"
                onClick={() => setMeasurementEvidence((current) => !current)}
              >
                <ClipboardCheck aria-hidden="true" className="size-5 shrink-0" />
                {measurementEvidence ? "Measurement evidence selected" : "Add measurement readings"}
              </button>
              {measurementEvidence ? (
                <p className="text-base leading-6 text-muted">
                  Photograph the reading and add its units and location in the next step. This is
                  evidence for office review; it does not update the survey, design, or cut list.
                </p>
              ) : null}
              <details className="border border-border">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 font-bold [&::-webkit-details-marker]:hidden">
                  <span>Proof type</span>
                  <span className="text-sm text-muted">{proofSlot}</span>
                </summary>
                <div className="border-t border-border p-4">
                  <label className="block text-sm font-bold" htmlFor="proof-slot">
                    Change proof type
                  </label>
                  <Select
                    field
                    id="proof-slot"
                    className="mt-3 rounded-none bg-surface text-lg font-bold"
                    value={proofSlot}
                    onChange={(event) => setProofSlot(event.target.value)}
                  >
                    {PROOF_SLOTS.map((slot) => (
                      <option key={slot}>{slot}</option>
                    ))}
                  </Select>
                </div>
              </details>
              <p className="rounded-md border border-info pl-3 text-sm font-semibold leading-6 text-info">
                Your files stay in this form until you save them. Keep this page open.
              </p>
            </div>
            <CheckInActionBar
              message={
                selectedMedia.length
                  ? "Check your files, then add a note if needed."
                  : "You can continue with a note or a blocker report instead of media."
              }
            >
              <Button
                type="button"
                size="field"
                fullWidth
                variant="accent"
                onClick={() => moveToStep(2)}
              >
                Continue to review
                <ChevronRight aria-hidden="true" />
              </Button>
            </CheckInActionBar>
          </section>
        ) : null}
        {step === 2 ? (
          <section
            ref={stepPanelRef}
            className="scroll-mt-32 border border-border bg-surface-raised"
            aria-labelledby="capture-detail-heading"
          >
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold text-muted">Add only what is new</p>
              <h2
                ref={stepHeadingRef}
                id="capture-detail-heading"
                tabIndex={-1}
                className="mt-1 text-2xl font-bold tracking-[-0.03em]"
              >
                Add job details
              </h2>
            </header>
            <div className="space-y-4 p-4 sm:p-5">
              {selectedMedia.length > 0 ? (
                <CaptureReview
                  photos={photos}
                  voice={voice}
                  onRemovePhoto={removePhoto}
                  onRemoveVoice={removeVoice}
                />
              ) : null}
              {typedEvidence?.evidenceCorrectionOf ? (
                <section
                  className="border-2 border-warning/45 bg-warning-soft p-4"
                  aria-labelledby="evidence-correction-heading"
                >
                  <p className="text-sm font-semibold text-warning">Fix an old proof item</p>
                  <h3 id="evidence-correction-heading" className="mt-1 font-bold">
                    This one file will replace the old view.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    The old item will stay in the log. Say what changed before you save.
                  </p>
                  <label className="mt-3 block font-bold" htmlFor="evidence-correction-reason">
                    Why is this a correction? <span aria-hidden="true">*</span>
                  </label>
                  <Textarea
                    id="evidence-correction-reason"
                    className="mt-2 min-h-28 rounded-none bg-surface"
                    maxLength={1000}
                    required
                    value={correctionReason}
                    onChange={(event) => setCorrectionReason(event.target.value)}
                  />
                </section>
              ) : null}
              <Button
                type="button"
                size="field"
                fullWidth
                variant={blocker ? "danger" : "outline"}
                onClick={() => {
                  setBlocker((current) => !current);
                  if (blocker) setBlockerSummary("");
                }}
              >
                <AlertTriangle aria-hidden="true" />
                {blocker ? "Close blocker report" : "Report a blocker"}
              </Button>
              {blocker ? (
                <div className="space-y-4 border border-danger/35 bg-danger-soft p-4">
                  <p className="font-bold text-danger">Tell the office what stops work.</p>
                  <label className="block font-bold" htmlFor="blocker-category">
                    Blocker type
                  </label>
                  <Select
                    field
                    id="blocker-category"
                    className="rounded-none bg-surface text-lg font-bold"
                    value={blockerCategory}
                    onChange={(event) => setBlockerCategory(event.target.value)}
                  >
                    {BLOCKER_CATEGORIES.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </Select>
                  <label className="block font-bold" htmlFor="blocker-summary">
                    What must happen next?
                  </label>
                  <Textarea
                    id="blocker-summary"
                    className="min-h-28 rounded-none bg-surface"
                    maxLength={1000}
                    value={blockerSummary}
                    onChange={(event) => setBlockerSummary(event.target.value)}
                  />
                </div>
              ) : null}
              <details className="border border-border" open={measurementEvidence || undefined}>
                <summary className="min-h-16 cursor-pointer px-4 py-4 font-bold">
                  {measurementEvidence ? "Measurement readings" : "Add a note (optional)"}
                </summary>
                <div className="border-t border-border p-4">
                  <label className="block font-bold" htmlFor="field-notes">
                    {measurementEvidence
                      ? "Readings, units, location, and how you measured"
                      : "What changed or what did you finish?"}
                  </label>
                  <Textarea
                    id="field-notes"
                    className="mt-3 min-h-32 rounded-none bg-surface"
                    maxLength={2000}
                    placeholder={
                      measurementEvidence
                        ? "For example: north flashing, 450 mm wide, measured with a tape."
                        : undefined
                    }
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                  {measurementEvidence ? (
                    <p className="mt-3 text-base leading-6 text-muted">
                      For office review. Saving this proof does not approve a measurement revision.
                    </p>
                  ) : null}
                </div>
              </details>
              <LocationCapture
                location={location}
                permissionState={locationPermissionState}
                onRequest={requestLocation}
              />
            </div>
            <CheckInActionBar message={saveMessage}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="outline"
                  onClick={() => moveToStep(1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  Back to files
                </Button>
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="accent"
                  busy={saving}
                  onClick={() => void save()}
                >
                  <Check aria-hidden="true" />
                  Save on device
                </Button>
              </div>
            </CheckInActionBar>
          </section>
        ) : null}
      </section>
    </RoleGuard>
  );
}

function CheckInHeader({ model }: { model: JobResponse }) {
  return (
    <header>
      <h1 className="text-2xl font-bold tracking-[-0.03em] sm:text-3xl">Add job proof</h1>
      <p className="mt-1 text-base font-semibold leading-6 text-muted">
        {model.job.job_number ?? "Assigned job"} · {model.job.address ?? "Address unavailable"}
      </p>
    </header>
  );
}

function CheckInProgress({ step }: { step: number }) {
  return (
    <ol
      className="grid grid-cols-3 border-y border-border"
      aria-label={`Check-in progress, step ${step} of 3`}
    >
      {["Files", "Details", "Saved"].map((label, index) => {
        const active = index + 1 === step;
        const complete = index + 1 < step;
        return (
          <li
            key={label}
            className={`flex min-h-12 items-center justify-center gap-2 px-2 py-2 text-center text-base font-bold ${index > 0 ? "border-l border-border" : ""} ${active ? "border-b-4 border-accent text-foreground" : complete ? "text-ok" : "text-muted"}`}
            aria-current={active ? "step" : undefined}
          >
            <span>{index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function CaptureReview({
  photos,
  voice,
  onRemovePhoto,
  onRemoveVoice,
}: {
  photos: File[];
  voice: File | null;
  onRemovePhoto: (index: number) => void;
  onRemoveVoice: () => void;
}) {
  const items = [
    ...photos.map((file, index) => ({
      id: `photo:${file.name}:${file.lastModified}:${index}`,
      kind: "Photo",
      file,
      remove: () => onRemovePhoto(index),
    })),
    ...(voice
      ? [
          {
            id: `voice:${voice.name}:${voice.lastModified}`,
            kind: "Voice note",
            file: voice,
            remove: onRemoveVoice,
          },
        ]
      : []),
  ];
  const totalBytes = items.reduce((total, item) => total + item.file.size, 0);
  return (
    <section className="border border-border" aria-labelledby="selected-evidence-heading">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 id="selected-evidence-heading" className="font-bold">
          Files to save
        </h3>
        <p className="text-sm font-semibold text-muted">
          {items.length} of 12 items · {formatBytes(totalBytes)} of 24 MB
        </p>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-sm leading-6 text-muted">
          No files added. You can still save a note or a blocker in the next step.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-bold">{item.kind}</p>
                <p className="truncate text-sm text-muted">
                  {item.file.name || `${item.kind} attachment`}
                </p>
              </div>
              <Button
                type="button"
                size="field"
                variant="ghost"
                onClick={item.remove}
                aria-label={`Remove ${item.file.name || item.kind}`}
              >
                <X aria-hidden="true" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckInActionBar({ message, children }: { message: string; children: ReactNode }) {
  return (
    <div className="field-action-bar border-t border-border bg-surface-raised p-3 sm:p-4">
      <p className="pb-2 text-base font-semibold leading-6 text-muted">{message}</p>
      {children}
    </div>
  );
}

function LocationCapture({
  location,
  permissionState,
  onRequest,
}: {
  location: { latitude: number; longitude: number; accuracy: number } | null;
  permissionState: "not_requested" | "granted" | "denied" | "unavailable" | "error";
  onRequest: () => void;
}) {
  const status = locationStatus(location, permissionState);
  return (
    <details className="border border-border">
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 font-bold [&::-webkit-details-marker]:hidden">
        <span>Add this phone's location (optional)</span>
        <span className="text-sm text-muted">
          {permissionState === "granted" ? "Captured" : "Optional"}
        </span>
      </summary>
      <div className="border-t border-border p-4">
        <p className="text-sm leading-6 text-muted">
          Adds a rough location to this check-in. It does not prove who was at the site.
        </p>
        <Button
          type="button"
          size="field"
          fullWidth
          variant="outline"
          className="mt-4"
          onClick={onRequest}
        >
          <MapPin aria-hidden="true" />
          {permissionState === "granted" ? "Refresh device location" : "Add device location"}
        </Button>
        <p className="mt-3 text-sm font-semibold leading-6 text-muted" role="status">
          {status}
        </p>
      </div>
    </details>
  );
}

function CheckInSaved({
  action,
  jobId,
  headingRef,
  onReturnToJob,
}: {
  action: OutboxAction;
  jobId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onReturnToJob?: () => void;
}) {
  const guidance = outboxFailureGuidance(action);
  return (
    <section
      data-testid="checkin-saved"
      className="border-2 border-foreground bg-surface-raised p-4 sm:p-5"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-muted">
            {action.state === "needs_attention" && guidance.notSent
              ? "Saved here, not sent"
              : "Saved on this phone"}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className="mt-1 text-2xl font-bold tracking-[-0.03em]">
            {action.state === "needs_attention" ? "Check-in needs a check" : "Check-in saved"}
          </h2>
        </div>
        <OutboxStateBadge state={action.state} />
      </div>
      {action.state === "needs_attention" ? (
        <div className="mt-4 space-y-2 border-2 border-danger/45 bg-danger-soft p-4" role="alert">
          <p className="font-bold text-danger">
            {guidance.notSent ? "This check-in did not send." : "This check-in is not confirmed."}
          </p>
          <p className="leading-7">{guidance.reason}</p>
          <p className="leading-7 font-bold">{guidance.nextStep}</p>
        </div>
      ) : (
        <p className="mt-4 leading-7 text-muted">
          {action.state === "verified"
            ? guidance.officeConfirmed
              ? guidance.reason
              : "The server got this check-in."
            : "This check-in is safe on this phone. Keep the app open so it can send when it can."}
        </p>
      )}
      {onReturnToJob ? (
        <Button size="field" fullWidth variant="accent" className="mt-5" onClick={onReturnToJob}>
          Return to job
        </Button>
      ) : (
        <Button asChild size="field" fullWidth variant="accent" className="mt-5">
          <Link to="/jobs/$jobId" params={{ jobId }}>
            Return to job
          </Link>
        </Button>
      )}
    </section>
  );
}

function locationStatus(
  location: { latitude: number; longitude: number; accuracy: number } | null,
  permissionState: "not_requested" | "granted" | "denied" | "unavailable" | "error",
): string {
  if (location && permissionState === "granted")
    return `Location added · about ${Math.round(location.accuracy)} m accuracy.`;
  if (permissionState === "denied") return "Location was not shared because permission was denied.";
  if (permissionState === "unavailable") return "Location is not available on this device.";
  if (permissionState === "error")
    return "Location could not be captured. You can continue without it.";
  return "No device location added.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateMedia(files: File[]): string | null {
  if (files.length > MAX_MEDIA_COUNT)
    return `Use at most ${MAX_MEDIA_COUNT} files per check-in. Submit additional check-ins for large jobs.`;
  if (files.some((file) => !FIELD_MEDIA_TYPES.has(file.type.toLowerCase())))
    return "One file format is not supported. Use a photo or voice-note format listed by the picker.";
  if (files.some((file) => file.size < 1 || file.size > MAX_MEDIA_BYTES))
    return "Each file must be between 1 byte and 12 MB.";
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ACTION_BYTES)
    return "This check-in is over 24 MB. Split it into smaller check-ins.";
  return null;
}

function dedupeProof(items: ProofStreamItem[]): ProofStreamItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => {
    const leftTime = Date.parse(left.occurred_at ?? "") || 0;
    const rightTime = Date.parse(right.occurred_at ?? "") || 0;
    return rightTime - leftTime || right.id.localeCompare(left.id);
  });
}
