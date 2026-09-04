import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, Copy, Plus, Save, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { useReadOnlyOfflineSurface } from "../components/offline-write-mode";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  addAdminPipelineStage,
  configurationErrorMessage,
  copyAdminPipeline,
  createAdminPipeline,
  DEFAULT_CARD_TEMPLATE,
  loadAdminPipelines,
  removeAdminPipelineStage,
  reorderAdminPipelineStages,
  reorderAdminPipelines,
  updateAdminPipeline,
  updateAdminPipelineRoles,
  updateAdminPipelineStage,
} from "./configuration-api";
import {
  adminPipelineQueryKey,
  type AdminPipeline,
  type AdminPipelineListResponse,
  type AdminPipelineStage,
  type PipelineRoleGrant,
} from "./configuration-contracts";
import { AdminPageHeader } from "./admin-shell";

type PipelineMutationNotice = { title: string; message: string };

export function PipelineConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <PipelineConfigurationContent />
    </RoleGuard>
  );
}

function PipelineConfigurationContent() {
  // Configuration refuses an offline edit and keeps nothing, so the app-wide banner
  // must not promise this screen's work is waiting on the device to be sent.
  useReadOnlyOfflineSurface();
  const session = useSession();
  const online = useOnlineStatus();
  const live = online && !isOfflineSession(session);
  const queryClient = useQueryClient();
  const queryKey = adminPipelineQueryKey(session.tenant.id);
  const pipelines = useQuery({
    queryKey,
    queryFn: () => loadAdminPipelines(),
    enabled: live,
  });

  if (!live && !pipelines.data) return <ConfigurationOffline />;
  if (pipelines.isPending && !pipelines.data) return <LoadingState label="Loading pipelines…" />;
  if (pipelines.isError && !pipelines.data) {
    return (
      <Section>
        <ErrorState
          title="Pipelines could not load"
          message={configurationErrorMessage(pipelines.error)}
          onRetry={() => void pipelines.refetch()}
        />
      </Section>
    );
  }

  const data = pipelines.data;
  if (!data) return null;
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  return (
    <Section>
      <AdminPageHeader
        icon={<Boxes className="size-6 text-accent" aria-hidden="true" />}
        title="Pipelines"
        description="Shape the boards your team works from. Changes are versioned and every stage keeps its history."
      />
      {!live ? (
        <Notice tone="warning" title="Offline: configuration is read-only">
          Cached pipelines remain readable. Reconnect before creating, renaming, reordering,
          archiving, or changing stages and role access.
        </Notice>
      ) : null}
      {pipelines.isError ? (
        <Notice tone="danger" title="The latest refresh failed">
          {configurationErrorMessage(pipelines.error)}
        </Notice>
      ) : null}
      <PipelineCreateForm data={data} live={live} onCreated={refresh} />
      {data.pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines yet"
          message="Create the first board above. The server will keep its stages and role access versioned."
        />
      ) : (
        <PipelineList data={data} live={live} onChanged={refresh} />
      )}
    </Section>
  );
}

function PipelineCreateForm({
  data,
  live,
  onCreated,
}: {
  data: AdminPipelineListResponse;
  live: boolean;
  onCreated: () => void;
}) {
  const session = useSession();
  const keyId = useId();
  const nameId = useId();
  const entityId = useId();
  const ownerId = useId();
  const stageKeyId = useId();
  const stageNameId = useId();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("");
  const [owningRole, setOwningRole] = useState("");
  const [stageKey, setStageKey] = useState("start");
  const [stageName, setStageName] = useState("Start");
  const [saved, setSaved] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createAdminPipeline(session, {
        key: key.trim(),
        name: name.trim(),
        entity_type: entityType || data.entity_types[0]?.entity_type || "",
        owning_role: owningRole || null,
        card_template: DEFAULT_CARD_TEMPLATE,
        stages: [{ key: stageKey.trim(), name: stageName.trim(), color: null }],
        role_grants: [],
      }),
    onSuccess: () => {
      setSaved(true);
      setKey("");
      setName("");
      setStageKey("start");
      setStageName("Start");
      onCreated();
    },
  });

  const selectedEntity = entityType || data.entity_types[0]?.entity_type || "";
  const ready = Boolean(
    key.trim() && name.trim() && selectedEntity && stageKey.trim() && stageName.trim(),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a pipeline</CardTitle>
        <CardDescription>
          Start with one stage, then add and arrange the rest. Pipelines copy without cards, so a
          new board never carries customer work with it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!live) return;
            setSaved(false);
            create.mutate();
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <LabeledInput
              id={keyId}
              label="Key"
              hint="Lowercase letters, numbers, and underscores."
              value={key}
              onChange={setKey}
            />
            <LabeledInput id={nameId} label="Name" value={name} onChange={setName} />
            <div className="min-w-0 space-y-2">
              <label className="block text-sm font-bold" htmlFor={entityId}>
                Entity type
              </label>
              <Select
                id={entityId}
                value={selectedEntity}
                onChange={(event) => setEntityType(event.target.value)}
              >
                {data.entity_types.map((entry) => (
                  <option key={entry.entity_type} value={entry.entity_type}>
                    {entry.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs leading-5 text-muted">
                Published by the server for this account.
              </p>
            </div>
            <div className="min-w-0 space-y-2">
              <label className="block text-sm font-bold" htmlFor={ownerId}>
                Owning role
              </label>
              <Select
                id={ownerId}
                value={owningRole}
                onChange={(event) => setOwningRole(event.target.value)}
              >
                <option value="">No owner; use explicit grants</option>
                {data.roles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </Select>
            </div>
            <LabeledInput
              id={stageKeyId}
              label="First stage key"
              value={stageKey}
              onChange={setStageKey}
            />
            <LabeledInput
              id={stageNameId}
              label="First stage name"
              value={stageName}
              onChange={setStageName}
            />
          </div>
          {create.isError ? (
            <Notice tone="danger" title="Pipeline was not created">
              {configurationErrorMessage(create.error)}
              {create.error instanceof Error &&
              "status" in create.error &&
              (create.error as { status?: number }).status === 409 ? (
                <ReloadButton />
              ) : null}
            </Notice>
          ) : null}
          {saved ? (
            <Notice tone="success" title="Pipeline created">
              Your new board is ready to configure below.
            </Notice>
          ) : null}
          <Button
            type="submit"
            variant="accent"
            fullWidth
            busy={create.isPending}
            disabled={!live || !ready}
          >
            <Plus aria-hidden="true" />
            Create pipeline
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PipelineList({
  data,
  live,
  onChanged,
}: {
  data: AdminPipelineListResponse;
  live: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const [orderError, setOrderError] = useState<unknown>();
  const [orderSaved, setOrderSaved] = useState(false);
  const [pipelineNotice, setPipelineNotice] = useState<{ title: string; message: string }>();
  const ordered = useMemo(
    () => [...data.pipelines].sort((left, right) => left.position - right.position),
    [data.pipelines],
  );
  const reorder = useMutation({
    mutationFn: (next: AdminPipeline[]) =>
      reorderAdminPipelines(
        session,
        next.map((pipeline) => ({
          pipeline_id: pipeline.pipeline_id,
          expected_version: pipeline.version,
        })),
      ),
    onSuccess: () => {
      setOrderError(undefined);
      setOrderSaved(true);
      onChanged();
    },
    onMutate: () => {
      setPipelineNotice(undefined);
      setOrderSaved(false);
    },
    onError: (error) => {
      setPipelineNotice(undefined);
      setOrderSaved(false);
      setOrderError(error);
    },
  });

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (!live || target < 0 || target >= ordered.length || reorder.isPending) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next);
  }

  function handlePipelineMutation(notice?: PipelineMutationNotice) {
    // Pipeline cards remount when the server advances their version so an open
    // draft can never be paired with a newer expected_version. Keep success
    // feedback at the list level so that safety remount does not erase it.
    setPipelineNotice(notice);
    setOrderSaved(false);
    if (notice) onChanged();
  }

  return (
    <div className="space-y-5">
      {orderError ? (
        <Notice tone="danger" title="Pipeline order was not saved">
          {configurationErrorMessage(orderError)} <ReloadButton />
        </Notice>
      ) : null}
      {orderSaved ? (
        <Notice tone="success" title="Pipeline order saved">
          The board order is now shared with the team.
        </Notice>
      ) : null}
      {pipelineNotice ? (
        <Notice tone="success" title={pipelineNotice.title}>
          {pipelineNotice.message}
        </Notice>
      ) : null}
      {ordered.map((pipeline, index) => (
        <PipelineCard
          key={`${pipeline.pipeline_id}:${pipeline.version}:${pipeline.name}`}
          pipeline={pipeline}
          roles={data.roles}
          stageLimit={data.stage_limit}
          live={live}
          index={index}
          total={ordered.length}
          onMove={(direction) => move(index, direction)}
          onPipelineMutation={handlePipelineMutation}
        />
      ))}
    </div>
  );
}

function PipelineCard({
  pipeline,
  roles,
  stageLimit,
  live,
  index,
  total,
  onMove,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  roles: string[];
  stageLimit: number;
  live: boolean;
  index: number;
  total: number;
  onMove: (direction: -1 | 1) => void;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [editingName, setEditingName] = useState(false);
  const [copying, setCopying] = useState(false);
  const [name, setName] = useState(pipeline.name);
  const [copyKey, setCopyKey] = useState(`${pipeline.key}_copy`);
  const [copyName, setCopyName] = useState(`${pipeline.name} copy`);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    title: string;
    message: string;
  }>();
  const update = useMutation({
    mutationFn: (input: { name?: string; is_active?: boolean }) =>
      updateAdminPipeline(session, pipeline.pipeline_id, pipeline.version, input),
    onMutate: () => {
      setNotice(undefined);
      onPipelineMutation();
    },
    onSuccess: () => {
      setEditingName(false);
      onPipelineMutation({
        title: "Pipeline saved",
        message: "The latest server version is now live.",
      });
    },
    onError: (error) => {
      onPipelineMutation();
      setNotice({
        tone: "danger",
        title: "Pipeline was not saved",
        message: configurationErrorMessage(error),
      });
    },
  });
  const copy = useMutation({
    mutationFn: () =>
      copyAdminPipeline(session, pipeline.pipeline_id, {
        key: copyKey.trim(),
        name: copyName.trim(),
        copy_role_grants: true,
      }),
    onMutate: () => {
      setNotice(undefined);
      onPipelineMutation();
    },
    onSuccess: () => {
      setCopying(false);
      onPipelineMutation({
        title: "Pipeline copied",
        message: "The copy starts with no cards.",
      });
    },
    onError: (error) => {
      onPipelineMutation();
      setNotice({
        tone: "danger",
        title: "Pipeline was not copied",
        message: configurationErrorMessage(error),
      });
    },
  });

  return (
    <Card className={!pipeline.is_active ? "border-dashed opacity-85" : undefined}>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="truncate">{pipeline.name}</span>
              {!pipeline.is_active ? <StatusPill tone="muted">Archived</StatusPill> : null}
              {pipeline.is_template ? <StatusPill tone="info">Template</StatusPill> : null}
            </CardTitle>
            <CardDescription className="mt-1">
              <span className="font-semibold text-foreground">{pipeline.key}</span> ·{" "}
              {pipeline.entity_type} · version {pipeline.version} · {pipeline.card_count}{" "}
              {pipeline.card_count === 1 ? "card" : "cards"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={`Move ${pipeline.name} up`}
              title="Move up"
              disabled={!live || index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={`Move ${pipeline.name} down`}
              title="Move down"
              disabled={!live || index === total - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={!live}
              onClick={() => setEditingName((value) => !value)}
            >
              {editingName ? "Close rename" : "Rename"}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={!live}
              onClick={() => setCopying((value) => !value)}
            >
              <Copy aria-hidden="true" />
              Copy
            </Button>
            <Button
              type="button"
              size="compact"
              variant={pipeline.is_active ? "danger" : "accent"}
              busy={update.isPending}
              disabled={!live}
              onClick={() => {
                if (live) update.mutate({ is_active: !pipeline.is_active });
              }}
            >
              {pipeline.is_active ? "Archive" : "Activate"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {pipeline.card_count > 0 ? (
          <Notice tone="info" title="Archive safety">
            {pipeline.is_active
              ? `Archiving hides this board from day-to-day work but keeps its ${pipeline.card_count} ${pipeline.card_count === 1 ? "card" : "cards"} and audit history. Reactivate it here to make it available again.`
              : `This archived board retains its ${pipeline.card_count} ${pipeline.card_count === 1 ? "card" : "cards"} and audit history. Reactivate it here to make it available again.`}
          </Notice>
        ) : null}
        {editingName ? (
          <InlineRename
            id={`${pipeline.pipeline_id}-rename`}
            name={name}
            setName={setName}
            busy={update.isPending}
            live={live}
            onSave={() => update.mutate({ name: name.trim() })}
          />
        ) : null}
        {copying ? (
          <InlineCopy
            id={`${pipeline.pipeline_id}-copy`}
            keyValue={copyKey}
            setKey={setCopyKey}
            name={copyName}
            setName={setCopyName}
            busy={copy.isPending}
            live={live}
            onCopy={() => copy.mutate()}
          />
        ) : null}
        {notice ? (
          <Notice tone={notice.tone} title={notice.title}>
            {notice.message}
            {notice.tone === "danger" ? <ReloadButton /> : null}
          </Notice>
        ) : null}
        <RoleGrantEditor
          key={`${pipeline.pipeline_id}:${pipeline.version}`}
          pipeline={pipeline}
          roles={roles}
          live={live}
          onPipelineMutation={onPipelineMutation}
        />
        <StageEditorList
          pipeline={pipeline}
          roles={roles}
          stageLimit={stageLimit}
          live={live}
          onPipelineMutation={onPipelineMutation}
        />
      </CardContent>
    </Card>
  );
}

function RoleGrantEditor({
  pipeline,
  roles,
  live,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  roles: string[];
  live: boolean;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [grants, setGrants] = useState<PipelineRoleGrant[]>(pipeline.role_grants);
  const update = useMutation({
    mutationFn: () =>
      updateAdminPipelineRoles(session, pipeline.pipeline_id, pipeline.version, grants),
    onMutate: () => {
      onPipelineMutation();
    },
    onSuccess: () => {
      onPipelineMutation({
        title: "Role access saved",
        message: "The selected roles now use this board.",
      });
    },
    onError: () => onPipelineMutation(),
  });
  const grantFor = (role: string) => grants.find((grant) => grant.role === role);

  function setRole(role: string, read: boolean, write: boolean) {
    setGrants((current) => {
      const next = current.filter((grant) => grant.role !== role);
      return read || write ? [...next, { role, can_write: write }] : next;
    });
  }

  return (
    <Card className="bg-surface">
      <CardHeader>
        <CardTitle>Role access</CardTitle>
        <CardDescription>
          The owning role can use the board. Grants add other roles explicitly; write access always
          includes read access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Additional pipeline roles</legend>
          {roles.map((role) => {
            const grant = grantFor(role);
            const read = Boolean(grant);
            const write = grant?.can_write ?? false;
            const readId = `${pipeline.pipeline_id}-${role}-read`;
            const writeId = `${pipeline.pipeline_id}-${role}-write`;
            return (
              <div key={role} className="rounded-md border border-border bg-surface-raised p-3">
                <p className="font-bold">{roleLabel(role)}</p>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input
                      id={readId}
                      type="checkbox"
                      checked={read}
                      disabled={!live || update.isPending}
                      onChange={(event) =>
                        setRole(role, event.target.checked, event.target.checked && write)
                      }
                    />
                    Read
                  </label>
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input
                      id={writeId}
                      type="checkbox"
                      checked={write}
                      disabled={!live || !read || update.isPending}
                      onChange={(event) => setRole(role, true, event.target.checked)}
                    />
                    Write
                  </label>
                </div>
              </div>
            );
          })}
        </fieldset>
        {update.isError ? (
          <Notice tone="danger" title="Role access was not saved">
            {configurationErrorMessage(update.error)} <ReloadButton />
          </Notice>
        ) : null}
        <Button
          type="button"
          variant="outline"
          fullWidth
          busy={update.isPending}
          disabled={!live}
          onClick={() => {
            if (live) update.mutate();
          }}
        >
          <Save aria-hidden="true" />
          Save role access
        </Button>
      </CardContent>
    </Card>
  );
}

function StageEditorList({
  pipeline,
  roles,
  stageLimit,
  live,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  roles: string[];
  stageLimit: number;
  live: boolean;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [stageError, setStageError] = useState<unknown>();
  const activeStages = useMemo(
    () =>
      pipeline.stages
        .filter((stage) => stage.is_active)
        .sort((left, right) => left.position - right.position),
    [pipeline.stages],
  );
  const reorder = useMutation({
    mutationFn: (stageIds: string[]) =>
      reorderAdminPipelineStages(session, pipeline.pipeline_id, pipeline.version, stageIds),
    onMutate: () => {
      onPipelineMutation();
    },
    onSuccess: () => {
      setStageError(undefined);
      onPipelineMutation({
        title: "Stage order saved",
        message: "The visible controls now match the server order.",
      });
    },
    onError: (error) => {
      onPipelineMutation();
      setStageError(error);
    },
  });

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (!live || target < 0 || target >= activeStages.length || reorder.isPending) return;
    const next = [...activeStages];
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next.map((stage) => stage.stage_id));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-bold tracking-[-0.02em]">Stages</h3>
          <p className="mt-1 text-sm text-muted">
            {activeStages.length} of {stageLimit} active stages. Use the visible controls to arrange
            them; drag is not required.
          </p>
        </div>
        <StageAddForm
          pipeline={pipeline}
          roles={roles}
          stageLimit={stageLimit}
          live={live}
          onPipelineMutation={onPipelineMutation}
        />
      </div>
      {stageError ? (
        <Notice tone="danger" title="Stage order was not saved">
          {configurationErrorMessage(stageError)} <ReloadButton />
        </Notice>
      ) : null}
      {activeStages.length === 0 ? (
        <EmptyState
          title="No active stages"
          message="The server requires a board to keep at least one stage."
        />
      ) : null}
      <div className="space-y-3" role="list" aria-label={`${pipeline.name} stages`}>
        {activeStages.map((stage, index) => (
          <div
            key={stage.stage_id}
            role="listitem"
            className="rounded-md border border-border bg-surface p-4"
          >
            <div className="flex min-w-0 flex-wrap items-start gap-3">
              <StageSwatch color={stage.color} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-bold">
                  <span className="truncate">{stage.name}</span>
                  {stage.is_won ? <StatusPill tone="success">Won</StatusPill> : null}
                  {stage.is_lost ? <StatusPill tone="danger">Lost</StatusPill> : null}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {stage.key} · {stage.card_count} {stage.card_count === 1 ? "card" : "cards"}
                  {stage.min_role_to_enter
                    ? ` · ${roleLabel(stage.min_role_to_enter)} may enter`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Move ${stage.name} up`}
                  title="Move up"
                  disabled={!live || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Move ${stage.name} down`}
                  title="Move down"
                  disabled={!live || index === activeStages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="compact"
                  variant="outline"
                  disabled={!live}
                  onClick={() =>
                    setEditing((current) => (current === stage.stage_id ? null : stage.stage_id))
                  }
                >
                  {editing === stage.stage_id ? "Close edit" : "Edit"}
                </Button>
                <Button
                  type="button"
                  size="compact"
                  variant="ghost"
                  disabled={!live || activeStages.length <= 1}
                  onClick={() =>
                    setRemoving((current) => (current === stage.stage_id ? null : stage.stage_id))
                  }
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </div>
            </div>
            {editing === stage.stage_id ? (
              <StageEditForm
                key={`${stage.stage_id}:${pipeline.version}`}
                pipeline={pipeline}
                stage={stage}
                roles={roles}
                live={live}
                onChanged={() => {
                  setEditing(null);
                  onPipelineMutation({
                    title: "Stage saved",
                    message: "The latest stage version is now live.",
                  });
                }}
                onPipelineMutation={onPipelineMutation}
              />
            ) : null}
            {removing === stage.stage_id ? (
              <StageRemoveForm
                pipeline={pipeline}
                stage={stage}
                stages={activeStages}
                live={live}
                onChanged={() => {
                  setRemoving(null);
                  onPipelineMutation({
                    title: "Stage removed",
                    message: "The stage change is now recorded.",
                  });
                }}
                onPipelineMutation={onPipelineMutation}
              />
            ) : null}
          </div>
        ))}
      </div>
      {pipeline.stages.some((stage) => !stage.is_active) ? (
        <details className="rounded-md border border-dashed border-border p-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold">
            Show archived stages
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            {pipeline.stages
              .filter((stage) => !stage.is_active)
              .map((stage) => (
                <li key={stage.stage_id}>
                  {stage.name} · {stage.key} · retained for history
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function StageAddForm({
  pipeline,
  roles,
  stageLimit,
  live,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  roles: string[];
  stageLimit: number;
  live: boolean;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [role, setRole] = useState("");
  const add = useMutation({
    mutationFn: () =>
      addAdminPipelineStage(session, pipeline.pipeline_id, pipeline.version, {
        key: key.trim(),
        name: name.trim(),
        color: color.trim() || null,
        min_role_to_enter: role || null,
      }),
    onMutate: () => onPipelineMutation(),
    onSuccess: () => {
      setOpen(false);
      setKey("");
      setName("");
      setColor("");
      setRole("");
      onPipelineMutation({
        title: "Stage added",
        message: "The new stage is now available on this board.",
      });
    },
    onError: () => onPipelineMutation(),
  });
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="compact"
          disabled={
            !live || pipeline.stages.filter((stage) => stage.is_active).length >= stageLimit
          }
          onClick={() => setOpen(true)}
        >
          <Plus aria-hidden="true" />
          Add stage
        </Button>
      </div>
    );
  return (
    <Card className="w-full bg-surface">
      <CardContent className="pt-5">
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!live) return;
            add.mutate();
          }}
        >
          <LabeledInput
            id={`${pipeline.pipeline_id}-new-stage-key`}
            label="Stage key"
            value={key}
            onChange={setKey}
          />
          <LabeledInput
            id={`${pipeline.pipeline_id}-new-stage-name`}
            label="Stage name"
            value={name}
            onChange={setName}
          />
          <LabeledInput
            id={`${pipeline.pipeline_id}-new-stage-color`}
            label="Colour token"
            hint="Optional, such as slate or #64748b."
            value={color}
            onChange={setColor}
          />
          <div className="space-y-2">
            <label
              className="block text-sm font-bold"
              htmlFor={`${pipeline.pipeline_id}-new-stage-role`}
            >
              Entry role
            </label>
            <Select
              id={`${pipeline.pipeline_id}-new-stage-role`}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="">Any allowed role</option>
              {roles.map((entry) => (
                <option key={entry} value={entry}>
                  {roleLabel(entry)}
                </option>
              ))}
            </Select>
          </div>
          {add.isError ? (
            <div className="sm:col-span-2">
              <Notice tone="danger" title="Stage was not added">
                {configurationErrorMessage(add.error)} <ReloadButton />
              </Notice>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              type="submit"
              variant="accent"
              busy={add.isPending}
              disabled={!live || !key.trim() || !name.trim()}
            >
              Add stage
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={add.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function StageEditForm({
  pipeline,
  stage,
  roles,
  live,
  onChanged,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  stage: AdminPipelineStage;
  roles: string[];
  live: boolean;
  onChanged: () => void;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color ?? "");
  const [role, setRole] = useState(stage.min_role_to_enter ?? "");
  const [won, setWon] = useState(stage.is_won);
  const [lost, setLost] = useState(stage.is_lost);
  const update = useMutation({
    mutationFn: () =>
      updateAdminPipelineStage(session, pipeline.pipeline_id, stage.stage_id, pipeline.version, {
        name: name.trim(),
        color: color.trim() || null,
        min_role_to_enter: role || null,
        is_won: won,
        is_lost: lost,
      }),
    onMutate: () => onPipelineMutation(),
    onSuccess: onChanged,
    onError: () => onPipelineMutation(),
  });
  return (
    <form
      className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!live) return;
        update.mutate();
      }}
    >
      <LabeledInput
        id={`${stage.stage_id}-name`}
        label="Stage name"
        value={name}
        onChange={setName}
      />
      <LabeledInput
        id={`${stage.stage_id}-color`}
        label="Colour token"
        value={color}
        onChange={setColor}
      />
      <div className="space-y-2">
        <label className="block text-sm font-bold" htmlFor={`${stage.stage_id}-role`}>
          Entry role
        </label>
        <Select
          id={`${stage.stage_id}-role`}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="">Any allowed role</option>
          {roles.map((entry) => (
            <option key={entry} value={entry}>
              {roleLabel(entry)}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="flex flex-wrap items-end gap-4">
        <legend className="sr-only">Stage outcome flags</legend>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={won}
            onChange={(event) => {
              setWon(event.target.checked);
              if (event.target.checked) setLost(false);
            }}
          />
          Won
        </label>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={lost}
            onChange={(event) => {
              setLost(event.target.checked);
              if (event.target.checked) setWon(false);
            }}
          />
          Lost
        </label>
      </fieldset>
      {update.isError ? (
        <div className="sm:col-span-2">
          <Notice tone="danger" title="Stage was not saved">
            {configurationErrorMessage(update.error)} <ReloadButton />
          </Notice>
        </div>
      ) : null}
      <Button
        type="submit"
        variant="accent"
        busy={update.isPending}
        disabled={!live || !name.trim()}
      >
        Save stage
      </Button>
    </form>
  );
}

function StageRemoveForm({
  pipeline,
  stage,
  stages,
  live,
  onChanged,
  onPipelineMutation,
}: {
  pipeline: AdminPipeline;
  stage: AdminPipelineStage;
  stages: AdminPipelineStage[];
  live: boolean;
  onChanged: () => void;
  onPipelineMutation: (notice?: PipelineMutationNotice) => void;
}) {
  const session = useSession();
  const [destination, setDestination] = useState(
    stages.find((candidate) => candidate.stage_id !== stage.stage_id)?.stage_id ?? "",
  );
  const remove = useMutation({
    mutationFn: () =>
      removeAdminPipelineStage(
        session,
        pipeline.pipeline_id,
        stage.stage_id,
        pipeline.version,
        stage.card_count > 0 ? destination : undefined,
      ),
    onMutate: () => onPipelineMutation(),
    onSuccess: onChanged,
    onError: () => onPipelineMutation(),
  });
  const hasCards = stage.card_count > 0;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="text-sm leading-6 text-muted">
        {hasCards
          ? `This stage holds ${stage.card_count} ${stage.card_count === 1 ? "card" : "cards"}. Choose where to move them; the server commits the move and removal together.`
          : "This stage has no cards. The server will retain it as archived if its history is needed."}
      </p>
      {hasCards ? (
        <div className="mt-3 space-y-2">
          <label className="block text-sm font-bold" htmlFor={`${stage.stage_id}-destination`}>
            Move cards to
          </label>
          <Select
            id={`${stage.stage_id}-destination`}
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          >
            {stages
              .filter((candidate) => candidate.stage_id !== stage.stage_id)
              .map((candidate) => (
                <option key={candidate.stage_id} value={candidate.stage_id}>
                  {candidate.name}
                </option>
              ))}
          </Select>
        </div>
      ) : null}
      {remove.isError ? (
        <div className="mt-3">
          <Notice tone="danger" title="Stage was not removed">
            {configurationErrorMessage(remove.error)} <ReloadButton />
          </Notice>
        </div>
      ) : null}
      <div className="mt-3">
        <Button
          type="button"
          variant="danger"
          busy={remove.isPending}
          disabled={!live || (hasCards && !destination)}
          onClick={() => {
            if (live) remove.mutate();
          }}
        >
          Remove stage
        </Button>
      </div>
    </div>
  );
}

function InlineRename({
  id,
  name,
  setName,
  busy,
  live,
  onSave,
}: {
  id: string;
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  live: boolean;
  onSave: () => void;
}) {
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!live) return;
        onSave();
      }}
    >
      <div className="min-w-48 flex-1 space-y-2">
        <label className="block text-sm font-bold" htmlFor={id}>
          New name
        </label>
        <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <Button type="submit" variant="accent" busy={busy} disabled={!live || !name.trim()}>
        Save name
      </Button>
    </form>
  );
}

function InlineCopy({
  id,
  keyValue,
  setKey,
  name,
  setName,
  busy,
  live,
  onCopy,
}: {
  id: string;
  keyValue: string;
  setKey: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  live: boolean;
  onCopy: () => void;
}) {
  return (
    <form
      className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!live) return;
        onCopy();
      }}
    >
      <LabeledInput id={`${id}-key`} label="Copy key" value={keyValue} onChange={setKey} />
      <LabeledInput id={`${id}-name`} label="Copy name" value={name} onChange={setName} />
      <div className="sm:col-span-2">
        <p className="text-xs leading-5 text-muted">
          Stages and role grants copy; cards and transition history do not.
        </p>
      </div>
      <Button
        type="submit"
        variant="accent"
        busy={busy}
        disabled={!live || !keyValue.trim() || !name.trim()}
      >
        Copy pipeline
      </Button>
    </form>
  );
}

function LabeledInput({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// The presentation helper is exported for deterministic component-contract tests.
// eslint-disable-next-line react-refresh/only-export-components
export function stageSwatchPresentation(color: string | null): {
  className: string;
  style?: React.CSSProperties;
} {
  const value = color?.trim() ?? "";
  const baseClassName = "mt-1 size-3 shrink-0 rounded-full border border-border-strong";
  if (value && cssColorIsSupported(value)) {
    return { className: baseClassName, style: { backgroundColor: value } };
  }
  return { className: `${baseClassName} bg-surface-muted` };
}

function StageSwatch({ color }: { color: string | null }) {
  const appearance = stageSwatchPresentation(color);
  return <span className={appearance.className} style={appearance.style} aria-hidden="true" />;
}

function cssColorIsSupported(value: string): boolean {
  if (
    !/^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\))$/i.test(value)
  ) {
    return false;
  }
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    try {
      return CSS.supports("color", value);
    } catch {
      return false;
    }
  }
  return /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|transparent|currentcolor)$/i.test(
    value,
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "muted" | "info" | "success" | "danger";
  children: React.ReactNode;
}) {
  const className =
    tone === "danger"
      ? "bg-danger-soft text-danger"
      : tone === "success"
        ? "bg-ok-soft text-ok"
        : tone === "info"
          ? "bg-info-soft text-info"
          : "bg-surface-muted text-muted";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${className}`}>{children}</span>
  );
}

function roleLabel(role: string): string {
  return role === "owner"
    ? "Owner"
    : role === "ops"
      ? "Operations"
      : role === "sales"
        ? "Sales"
        : role === "production"
          ? "Production"
          : role === "accounting"
            ? "Accounting"
            : role === "field"
              ? "Crew"
              : role;
}

function ReloadButton() {
  return (
    <button
      type="button"
      className="ml-1 min-h-11 font-bold underline underline-offset-4 focus-visible:outline-focus"
      onClick={() => window.location.reload()}
    >
      Reload
    </button>
  );
}

function ConfigurationOffline() {
  return (
    <Section>
      <ErrorState
        title="Reconnect to open configuration"
        message="Owner configuration is not available offline yet. Reconnect to load cached-safe settings; no configuration change will be queued."
      />
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-5xl space-y-6 pb-6">{children}</section>;
}
