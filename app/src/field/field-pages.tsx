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
  PackageCheck,
  Phone,
  Ruler,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { OutboxStateBadge } from "../components/outbox-state-badge";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { OutboxAction } from "../storage/outbox-types";
import {
  hasCachedJobPacket,
  loadJob,
  loadProofPage,
  loadToday,
  prefetchAssignedPackets,
} from "./field-cache";
import type { JobResponse, ProofStreamItem } from "./field-contracts";
import { GateChip } from "./gate-chip";
import { ProofStream } from "./proof-stream";

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

export function TodayPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [packetReady, setPacketReady] = useState<Record<string, boolean>>({});
  const query = useQuery({
    queryKey: ["today", session.tenant.id, session.user.id],
    queryFn: () => loadToday(session),
  });
  const today = query.data;
  useEffect(() => {
    if (!today) return;
    let active = true;
    void Promise.all(
      today.jobs.map(async (job) => [job.id, await hasCachedJobPacket(session, job.id)] as const),
    ).then((entries) => active && setPacketReady(Object.fromEntries(entries)));
    if (navigator.onLine) {
      void prefetchAssignedPackets(session, today, {
        concurrency: 3,
        onPacket(jobId, ready, model) {
          if (!active) return;
          setPacketReady((current) => ({ ...current, [jobId]: ready }));
          if (model)
            queryClient.setQueryData(["job", session.tenant.id, session.user.id, jobId], model);
        },
      });
    }
    return () => {
      active = false;
    };
  }, [queryClient, session, today]);
  if (query.isPending) return <LoadingState label="Loading assigned work…" />;
  if (query.isError) {
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  }
  const offline = query.data.stale_fields.includes("offline.cached_packet");
  const readyCount = query.data.jobs.filter((job) => packetReady[job.id]).length;
  return (
    <section className="space-y-6">
      <PageHeader
        eyebrow="Field and operations"
        title="Today"
        description={
          offline ? "Offline packet from this device" : `Live assignments for ${query.data.date}`
        }
      />
      {offline ? <OfflineNotice /> : null}
      {query.data.jobs.length > 0 ? (
        <div
          className={
            readyCount === query.data.jobs.length
              ? "rounded-lg border border-ok/30 bg-ok-soft p-4 font-bold text-ok"
              : "rounded-lg border border-warning/30 bg-warning-soft p-4 font-bold text-warning"
          }
          role="status"
        >
          {readyCount} of {query.data.jobs.length} job packets ready offline
        </div>
      ) : null}
      {query.data.jobs.length === 0 ? (
        <EmptyState
          title="No assigned work today"
          message="Field jobs appear only from an active direct or crew Job Assignment. Office roles can still see active jobs awaiting assignment."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {query.data.jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
                      {job.job_number ?? job.id}
                    </p>
                    <CardTitle className="mt-1">{job.address ?? "Address unavailable"}</CardTitle>
                  </div>
                  {job.blocked_gate_count > 0 ? (
                    <span className="rounded-full bg-danger-soft px-3 py-1 text-xs font-bold text-danger">
                      {job.blocked_gate_count} blocked
                    </span>
                  ) : null}
                </div>
                <span
                  className={
                    packetReady[job.id]
                      ? "text-xs font-extrabold text-ok"
                      : "text-xs font-extrabold text-warning"
                  }
                >
                  {packetReady[job.id] ? "Ready offline" : "Needs download"}
                </span>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <Fact label="Assignment" value={job.assignment?.type ?? "Awaiting assignment"} />
                  <Fact label="Start" value={formatDate(job.scheduled_start)} />
                </dl>
                <p className="rounded-lg bg-surface-muted p-3 font-bold">Next: {job.next_action}</p>
                <Button
                  asChild
                  size="field"
                  fullWidth
                  variant={job.blocked_gate_count ? "outline" : "accent"}
                >
                  <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
                    Open job packet
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

export function JobPage() {
  const session = useSession();
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const query = useQuery({
    queryKey: ["job", session.tenant.id, session.user.id, jobId],
    enabled: Boolean(jobId),
    queryFn: () => loadJob(session, jobId!),
  });
  if (!jobId) return <ErrorState message="This job link is incomplete." />;
  if (query.isPending) return <LoadingState label="Loading field packet…" />;
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  return (
    <JobSurface
      key={query.data.read_model_generated_at}
      model={query.data}
      offline={query.data.stale_fields.includes("offline.cached_packet")}
    />
  );
}

function JobSurface({ model, offline }: { model: JobResponse; offline: boolean }) {
  const session = useSession();
  const [proof, setProof] = useState<ProofStreamItem[]>(model.proof_stream);
  const [cursor, setCursor] = useState(model.proof_page.next_cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  async function loadOlder() {
    if (!cursor || loadingMore || offline) return;
    setLoadingMore(true);
    try {
      const page = await loadProofPage(model.job.id, cursor);
      setProof((current) => dedupeProof([...current, ...page.items]));
      setCursor(page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <RoleGuard surface="field">
      <section className="space-y-6">
        <Button asChild variant="ghost" size="compact">
          <Link to="/today">
            <ChevronLeft aria-hidden="true" />
            Today
          </Link>
        </Button>
        <PageHeader
          eyebrow={model.job.job_number ?? "Assigned job"}
          title={model.job.address ?? "Job packet"}
          description={[
            model.job.service_type,
            model.assignment?.type,
            formatDate(model.assignment?.scheduled_start ?? null),
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        {offline ? <OfflineNotice /> : null}
        <div className="flex flex-wrap gap-2">
          {model.gates.map((gate) => (
            <GateChip key={gate.id} name={gate.name ?? "Gate"} state={gate.state ?? "Unknown"} />
          ))}
        </div>
        {model.assignment && session.user.role === "field" ? (
          <Button asChild size="field" fullWidth variant="accent">
            <Link to="/check-in/$jobId" params={{ jobId: model.job.id }}>
              <Camera aria-hidden="true" />
              Start check-in
            </Link>
          </Button>
        ) : (
          <EmptyState
            title={
              session.user.role === "field"
                ? "Field action not assigned"
                : "Read-only office packet"
            }
            message={
              session.user.role === "field"
                ? "This check-in requires your active direct or crew Job Assignment."
                : "Office roles can review this packet, but only the assigned field account can capture proof."
            }
          />
        )}
        <ContactCard model={model} />
        <PacketGrid model={model} />
        <section className="space-y-4" aria-labelledby="proof-stream-heading">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
              Evidence ledger
            </p>
            <h2 id="proof-stream-heading" className="mt-1 text-2xl font-black">
              Proof Stream
            </h2>
          </div>
          <ProofStream
            items={proof}
            hasMore={Boolean(cursor) && !offline}
            loadingMore={loadingMore}
            onLoadMore={() => void loadOlder()}
          />
        </section>
      </section>
    </RoleGuard>
  );
}

export function CheckInPage() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  if (!jobId) {
    return (
      <RoleGuard surface="field">
        <EmptyState
          title="Choose an assigned job"
          message="Open Today, then open the job packet. Check-ins are always bound to the active Job Assignment."
          action={
            <Button asChild size="field" variant="accent">
              <Link to="/today">Open Today</Link>
            </Button>
          }
        />
      </RoleGuard>
    );
  }
  return <CheckInFlow key={jobId} jobId={jobId} />;
}

function CheckInFlow({ jobId }: { jobId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const jobQuery = useQuery({
    queryKey: ["job", session.tenant.id, session.user.id, jobId],
    queryFn: () => loadJob(session, jobId),
  });
  const startedAt = useRef(new Date().toISOString());
  const [step, setStep] = useState(1);
  const [photos, setPhotos] = useState<File[]>([]);
  const [voice, setVoice] = useState<File | null>(null);
  const [proofSlot, setProofSlot] = useState("Production");
  const [notes, setNotes] = useState("");
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

  useEffect(() => {
    if (!savedAction || savedAction.state === "verified" || savedAction.state === "needs_attention")
      return;
    const interval = window.setInterval(() => {
      void getOutboxAction(savedAction.deviceActionId).then(
        (latest) => latest && setSavedAction(latest),
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [savedAction]);

  if (session.user.role !== "field") {
    return (
      <ErrorState
        title="Assigned field account required"
        message="Office roles can review job packets but cannot submit field capture actions."
      />
    );
  }

  if (jobQuery.isPending) return <LoadingState label="Opening assigned packet…" />;
  if (jobQuery.isError)
    return (
      <ErrorState message={messageFor(jobQuery.error)} onRetry={() => void jobQuery.refetch()} />
    );
  const model = jobQuery.data;
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
    const error = validateMedia([...next, ...(voice ? [voice] : [])]);
    setFormError(error);
    if (!error) setPhotos(next);
  }

  function chooseVoice(files: FileList | null) {
    const next = files?.[0] ?? null;
    const error = validateMedia([...photos, ...(next ? [next] : [])]);
    setFormError(error);
    if (!error) setVoice(next);
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationPermissionState("unavailable");
      setFormError("Location is not available on this device. You can continue without it.");
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
        setFormError(null);
      },
      (error) => {
        setLocation(null);
        setLocationPermissionState(error.code === error.PERMISSION_DENIED ? "denied" : "error");
        setFormError("Location was not captured. You can continue without it.");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function save() {
    const files = [...photos, ...(voice ? [voice] : [])];
    const mediaError = validateMedia(files);
    if (mediaError) return setFormError(mediaError);
    if (files.length === 0 && !notes.trim() && !blocker)
      return setFormError("Add a photo, voice note, field note, or blocker before saving.");
    if (blocker && !blockerSummary.trim())
      return setFormError("Describe what is blocked so the office can act.");
    setSaving(true);
    setFormError(null);
    try {
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "field_checkin",
        endpoint: `/api/v1/jobs/${encodeURIComponent(jobId)}/check-ins`,
        payload: {
          assignment_id: activeAssignmentId,
          proof_slot: proofSlot,
          capture_started_at: startedAt.current,
          capture_completed_at: new Date().toISOString(),
          notes: notes.trim() || null,
          blocker,
          blocker_category: blocker ? blockerCategory : null,
          blocker_summary: blocker ? blockerSummary.trim() : null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          location_accuracy_m: location?.accuracy ?? null,
          location_permission_state: locationPermissionState,
          correction_of: null,
          correction_reason: null,
          evidence_correction_of: null,
          customer_safe_requested: false,
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
        });
        const latest = await getOutboxAction(action.deviceActionId);
        if (latest) setSavedAction(latest);
        await queryClient.invalidateQueries({
          queryKey: ["job", session.tenant.id, session.user.id, jobId],
        });
      }
    } catch (error) {
      setFormError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RoleGuard surface="field">
      <section className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          eyebrow={model.job.job_number ?? "Assigned job"}
          title="Field check-in"
          description={model.job.address ?? "Address unavailable"}
        />
        <ol className="grid grid-cols-3 gap-2" aria-label="Check-in progress">
          {["Capture", "Details", "Saved"].map((label, index) => (
            <li
              key={label}
              className={
                index + 1 <= step
                  ? "rounded-lg bg-accent px-2 py-3 text-center text-sm font-black text-accent-foreground"
                  : "rounded-lg bg-surface-muted px-2 py-3 text-center text-sm font-bold text-muted"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        {formError ? (
          <div
            className="rounded-lg border border-danger/30 bg-danger-soft p-4 font-bold text-danger"
            role="alert"
          >
            {formError}
          </div>
        ) : null}
        {step === 1 ? (
          <Card>
            <CardHeader>
              <CardTitle>Capture proof</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="block text-sm font-extrabold" htmlFor="proof-slot">
                Proof slot
              </label>
              <select
                id="proof-slot"
                className="min-h-16 w-full rounded-lg border bg-surface px-4 text-lg font-bold"
                value={proofSlot}
                onChange={(event) => setProofSlot(event.target.value)}
              >
                {PROOF_SLOTS.map((slot) => (
                  <option key={slot}>{slot}</option>
                ))}
              </select>
              <label className="grid min-h-16 cursor-pointer place-items-center rounded-lg border-2 border-dashed bg-surface p-4 text-center text-lg font-black">
                <span className="flex items-center gap-2">
                  <Camera aria-hidden="true" />
                  Add photos
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
              <p className="text-sm text-muted" role="status">
                {photos.length} photo{photos.length === 1 ? "" : "s"} saved for this action
              </p>
              <label className="grid min-h-16 cursor-pointer place-items-center rounded-lg border-2 border-dashed bg-surface p-4 text-center text-lg font-black">
                <span className="flex items-center gap-2">
                  <Mic aria-hidden="true" />
                  Optional voice note
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/webm,audio/wav,audio/x-wav"
                  capture
                  onChange={(event) => chooseVoice(event.target.files)}
                />
              </label>
              <p className="rounded-lg bg-info-soft p-3 text-sm font-bold text-info">
                All field media starts internal. This flow cannot mark it customer-safe.
              </p>
              <Button
                type="button"
                size="field"
                fullWidth
                variant="accent"
                onClick={() => setStep(2)}
              >
                Continue <ChevronRight aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>
        ) : null}
        {step === 2 ? (
          <Card>
            <CardHeader>
              <CardTitle>Details and blockers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="block font-extrabold" htmlFor="field-notes">
                Field note
              </label>
              <textarea
                id="field-notes"
                className="min-h-32 w-full rounded-lg border bg-surface p-4 text-base"
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What changed or was completed?"
              />
              <label className="flex min-h-16 items-center gap-4 rounded-lg border bg-surface px-4 text-lg font-black">
                <input
                  className="size-6"
                  type="checkbox"
                  checked={blocker}
                  onChange={(event) => setBlocker(event.target.checked)}
                />
                Work is blocked
              </label>
              {blocker ? (
                <div className="space-y-4 rounded-lg border border-danger/30 bg-danger-soft p-4">
                  <label className="block font-extrabold" htmlFor="blocker-category">
                    Blocker type
                  </label>
                  <select
                    id="blocker-category"
                    className="min-h-16 w-full rounded-lg border bg-surface px-4 text-lg font-bold"
                    value={blockerCategory}
                    onChange={(event) => setBlockerCategory(event.target.value)}
                  >
                    {BLOCKER_CATEGORIES.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                  <label className="block font-extrabold" htmlFor="blocker-summary">
                    What must happen next?
                  </label>
                  <textarea
                    id="blocker-summary"
                    className="min-h-28 w-full rounded-lg border bg-surface p-4"
                    maxLength={1000}
                    value={blockerSummary}
                    onChange={(event) => setBlockerSummary(event.target.value)}
                  />
                </div>
              ) : null}
              <Button
                type="button"
                size="field"
                fullWidth
                variant="outline"
                onClick={requestLocation}
              >
                <MapPin aria-hidden="true" />
                {location ? "Location captured" : "Add device location"}
              </Button>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="outline"
                  onClick={() => setStep(1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  Back
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
            </CardContent>
          </Card>
        ) : null}
        {step === 3 && savedAction ? (
          <Card aria-live="polite">
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardTitle>Check-in saved</CardTitle>
                <OutboxStateBadge state={savedAction.state} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="leading-7 text-muted">
                {savedAction.state === "verified"
                  ? "R2 and Frappe verified this exact device action."
                  : savedAction.state === "needs_attention"
                    ? "Nothing was deleted. The office can review this preserved action and its media."
                    : "It remains on this device and will retry safely while the app is open."}
              </p>
              <Button asChild size="field" fullWidth variant="accent">
                <Link to="/jobs/$jobId" params={{ jobId }}>
                  Return to job
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </section>
    </RoleGuard>
  );
}

function ContactCard({ model }: { model: JobResponse }) {
  const contact = model.packet.contact;
  if (!contact) return null;
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 sm:pt-6">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
            Job contact
          </p>
          <p className="mt-1 text-lg font-black">{contact.display_name ?? "Name unavailable"}</p>
        </div>
        {contact.phone ? (
          <Button asChild variant="outline" size="field" fullWidth>
            <a href={`tel:${contact.phone}`}>
              <Phone aria-hidden="true" />
              Call approved number
            </a>
          </Button>
        ) : (
          <p className="text-sm text-muted">Phone unavailable</p>
        )}
      </CardContent>
    </Card>
  );
}

function PacketGrid({ model }: { model: JobResponse }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PacketCard
        icon={<ClipboardCheck />}
        title="Approved scope"
        count={model.packet.scope_clauses.length}
      >
        {model.packet.scope_clauses.map((item) => (
          <PacketLine key={item.id} title={item.title ?? item.type ?? "Scope"} detail={item.text} />
        ))}
      </PacketCard>
      <PacketCard icon={<Ruler />} title="Measurements" count={model.packet.measurements.length}>
        {model.packet.measurements.map((item) => (
          <PacketLine
            key={item.id}
            title={item.provider ?? "Measurement"}
            detail={item.review_status}
          />
        ))}
      </PacketCard>
      <PacketCard
        icon={<PackageCheck />}
        title="Materials"
        count={
          model.packet.materials.supplier_orders.length + model.packet.materials.takeoffs.length
        }
      >
        {model.packet.materials.supplier_orders.map((item) => (
          <PacketLine
            key={item.id}
            title={item.status ?? "Supplier order"}
            detail={item.delivery_notes ?? item.requested_delivery_date}
          />
        ))}
      </PacketCard>
      <PacketCard
        icon={<ShieldCheck />}
        title="Safety plan"
        count={model.packet.safety_plan ? 1 : 0}
      >
        {model.packet.safety_plan ? (
          <PacketLine
            title={model.packet.safety_plan.status ?? "Safety plan"}
            detail={
              model.packet.safety_plan.ppe_requirements ?? model.packet.safety_plan.hazard_summary
            }
          />
        ) : null}
      </PacketCard>
      <PacketCard
        icon={<HardHat />}
        title="Change orders"
        count={model.packet.change_orders.length}
      >
        {model.packet.change_orders.map((item) => (
          <PacketLine
            key={item.id}
            title={item.title ?? item.number ?? "Change order"}
            detail={item.scope_delta}
          />
        ))}
      </PacketCard>
      <PacketCard icon={<Camera />} title="Required proof" count={model.required_proof.length}>
        {model.required_proof.map((item) => (
          <PacketLine
            key={item.id}
            title={`${item.label} · ${item.state}`}
            detail={item.blocker_reason}
          />
        ))}
      </PacketCard>
    </div>
  );
}

function PacketCard({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-black">
            {count}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {count ? (
          children
        ) : (
          <p className="text-sm text-muted">No approved records in this packet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PacketLine({ title, detail }: { title: string; detail: string | null }) {
  return (
    <div className="border-l-4 border-accent pl-3">
      <p className="font-bold">{title}</p>
      {detail ? <p className="mt-1 text-sm leading-6 text-muted">{detail}</p> : null}
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header>
      <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">{title}</h1>
      <p className="mt-3 text-base leading-7 text-muted">{description}</p>
    </header>
  );
}

function OfflineNotice() {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft p-4 text-warning"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="font-bold">
        Offline: showing the last packet opened on this device. Saved work remains queued.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-extrabold uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="mt-1 font-bold">{value}</dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "This field packet could not be loaded.";
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
