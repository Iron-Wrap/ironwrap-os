import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileText, History, Plus, Save } from "lucide-react";
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
import { Textarea } from "../components/ui/textarea";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  configurationErrorMessage,
  createSchemaField,
  loadAdminPipelines,
  loadSchemaFieldHistory,
  loadSchemaFields,
  reviseSchemaField,
} from "./configuration-api";
import {
  adminPipelineQueryKey,
  schemaFieldHistoryQueryKey,
  schemaFieldsQueryKey,
  type AdminPipelineListResponse,
  type SchemaField,
  type SchemaFieldCatalog,
  type SchemaFieldHistoryResponse,
  type SchemaFieldListResponse,
  type SchemaFieldWriteInput,
} from "./configuration-contracts";
import { AdminPageHeader } from "./admin-shell";

export function SchemaFieldsConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <SchemaFieldsConfigurationContent />
    </RoleGuard>
  );
}

function SchemaFieldsConfigurationContent() {
  // Configuration refuses an offline edit and keeps nothing, so the app-wide banner
  // must not promise this screen's work is waiting on the device to be sent.
  useReadOnlyOfflineSurface();
  const session = useSession();
  const online = useOnlineStatus();
  const live = online && !isOfflineSession(session);
  const queryClient = useQueryClient();
  const queryKey = schemaFieldsQueryKey(session.tenant.id);
  const pipelineQueryKey = adminPipelineQueryKey(session.tenant.id);
  const pipelineCatalog = useQuery({
    queryKey: pipelineQueryKey,
    queryFn: () => loadAdminPipelines(),
    enabled: live,
  });
  const fields = useQuery({
    queryKey,
    queryFn: () => loadSchemaFields(),
    enabled: live,
  });

  if (!live && !fields.data) return <ConfigurationOffline />;
  if (fields.isPending && !fields.data) return <LoadingState label="Loading field definitions…" />;
  if (fields.isError && !fields.data) {
    return (
      <Section>
        <ErrorState
          title="Field definitions could not load"
          message={configurationErrorMessage(fields.error)}
          onRetry={() => void fields.refetch()}
        />
      </Section>
    );
  }
  const data = fields.data;
  if (!data) return null;
  const verifiedEntityTypes =
    pipelineCatalog.isError || !pipelineCatalog.data ? [] : pipelineCatalog.data.entity_types;
  const entityCatalogReady = verifiedEntityTypes.length > 0;
  const entityTypes = entityCatalogReady
    ? verifiedEntityTypes.map((entry) => entry.entity_type)
    : [...new Set(data.fields.map((field) => field.entity_type))].sort();
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  return (
    <Section>
      <AdminPageHeader
        icon={<FileText className="size-6 text-accent" aria-hidden="true" />}
        title="Fields"
        description="Define the structured information your team can read and write. A correction adds a reasoned revision; it never erases the previous definition."
      />
      {!live ? (
        <Notice tone="warning" title="Offline: configuration is read-only">
          Cached definitions remain readable. Reconnect before creating, revising, or retiring a
          field.
        </Notice>
      ) : null}
      {fields.isError ? (
        <Notice tone="danger" title="The latest refresh failed">
          {configurationErrorMessage(fields.error)}
        </Notice>
      ) : null}
      {live && !entityCatalogReady ? (
        <Notice
          tone="warning"
          title={
            pipelineCatalog.isError
              ? "Entity type catalog unavailable"
              : "Loading entity type catalog"
          }
        >
          {pipelineCatalog.isError
            ? `${configurationErrorMessage(pipelineCatalog.error)} Existing field definitions remain readable, but creating or revising a field is disabled until the server catalog is available.`
            : "Creating or revising a field is disabled until a verified server entity type is available."}{" "}
          {pipelineCatalog.isError ? (
            <button
              type="button"
              className="ml-1 min-h-11 font-bold underline underline-offset-4 focus-visible:outline-focus"
              onClick={() => void pipelineCatalog.refetch()}
            >
              Retry entity catalog
            </button>
          ) : null}
        </Notice>
      ) : null}
      <FieldCreateForm
        catalog={data.catalog}
        entityTypes={verifiedEntityTypes}
        entityCatalogReady={entityCatalogReady}
        live={live}
        nextPosition={(entityType) => nextSchemaFieldPosition(data.fields, entityType)}
        onCreated={refresh}
      />
      <FieldList
        data={data}
        entityTypes={verifiedEntityTypes}
        entityTypeOptions={entityTypes}
        entityCatalogReady={entityCatalogReady}
        live={live}
        onChanged={refresh}
      />
    </Section>
  );
}

/**
 * The server publishes field definitions in `entity_type, position, field_key` order, but a client
 * that renders the response as it arrives shows whatever order the transport happened to produce —
 * which made an admin's reorder look like it had done nothing at all. Sorting on the same key makes
 * the rendered order the definition of record, as the pipeline configuration list already does.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sortSchemaFields(fields: SchemaField[]): SchemaField[] {
  return [...fields].sort(
    (left, right) =>
      left.entity_type.localeCompare(right.entity_type) ||
      left.position - right.position ||
      left.field_key.localeCompare(right.field_key),
  );
}

export interface SchemaFieldPlacement {
  field: SchemaField;
  position: number;
}

/**
 * Plan the revisions that move the field at `from` to `to` inside the list an admin can actually
 * see. Field definitions have no bulk order endpoint, so a move is expressed as one governed
 * revision per field whose position really changes — normally two.
 *
 * Positions are scoped to an entity type, so a move never crosses that boundary. The group's own
 * position values are reused as slots, forced strictly ascending, so definitions hidden behind a
 * filter keep the place they already hold and two fields sharing a server position cannot swallow
 * the move.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function planSchemaFieldReorder(
  visible: SchemaField[],
  from: number,
  to: number,
): SchemaFieldPlacement[] {
  const moved = visible[from];
  const target = visible[to];
  if (!moved || !target || moved.entity_type !== target.entity_type) return [];
  const group = visible.filter((field) => field.entity_type === moved.entity_type);
  const groupFrom = group.indexOf(moved);
  const groupTo = group.indexOf(target);
  if (groupFrom < 0 || groupTo < 0) return [];
  const next = [...group];
  next.splice(groupFrom, 1);
  next.splice(groupTo, 0, moved);
  const slots = group.map((field) => field.position).sort((left, right) => left - right);
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index]! <= slots[index - 1]!) slots[index] = slots[index - 1]! + 1;
  }
  return next
    .map((field, index) => ({ field, position: slots[index]! }))
    .filter((placement) => placement.position !== placement.field.position);
}

function nextSchemaFieldPosition(fields: SchemaField[], entityType: string): number {
  return fields
    .filter((field) => field.entity_type === entityType)
    .reduce((highest, field) => Math.max(highest, field.position + 1), 0);
}

function FieldList({
  data,
  entityTypes,
  entityTypeOptions,
  entityCatalogReady,
  live,
  onChanged,
}: {
  data: SchemaFieldListResponse;
  entityTypes: AdminPipelineListResponse["entity_types"];
  entityTypeOptions: string[];
  entityCatalogReady: boolean;
  live: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const [entityFilter, setEntityFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "retired">("all");
  const [orderError, setOrderError] = useState<unknown>();
  const [orderSaved, setOrderSaved] = useState(false);
  const ordered = useMemo(() => sortSchemaFields(data.fields), [data.fields]);
  const reorder = useMutation({
    mutationFn: async (placements: SchemaFieldPlacement[]) => {
      // One governed revision per moved field, applied in sequence so a refused
      // placement stops the rest instead of half-applying an order nobody asked for.
      for (const placement of placements) {
        await reviseSchemaField(
          session,
          placement.field.field_id,
          fieldInput(placement.field, {
            action: "reorder",
            position: placement.position,
            expected_version: placement.field.version,
          }),
        );
      }
    },
    onMutate: () => {
      setOrderError(undefined);
      setOrderSaved(false);
    },
    onSuccess: () => {
      setOrderSaved(true);
      onChanged();
    },
    onError: (error) => {
      setOrderError(error);
      // A refused placement can still follow an accepted one, so re-read the server
      // order rather than leaving a stale list on screen.
      onChanged();
    },
  });
  const visible = ordered.filter(
    (field) =>
      (!entityFilter || field.entity_type === entityFilter) &&
      (activeFilter === "all" || (activeFilter === "active" ? field.active : !field.active)),
  );

  function move(index: number, direction: -1 | 1) {
    if (!live || reorder.isPending) return;
    const placements = planSchemaFieldReorder(visible, index, index + direction);
    if (placements.length) reorder.mutate(placements);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <CardTitle>Field definitions</CardTitle>
            <CardDescription>
              {visible.length} of {data.fields.length} definitions shown, in the order your team
              reads them. Use the visible controls to arrange them; drag is not required.
            </CardDescription>
          </div>
          <div className="flex w-full flex-wrap gap-3 sm:w-auto">
            <label className="min-w-36 flex-1 space-y-1 text-sm font-bold sm:flex-none">
              Entity type
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base font-normal"
                value={entityFilter}
                onChange={(event) => setEntityFilter(event.target.value)}
              >
                <option value="">All entities</option>
                {entityTypeOptions.map((entityType) => (
                  <option key={entityType} value={entityType}>
                    {entityType}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-32 flex-1 space-y-1 text-sm font-bold sm:flex-none">
              Status
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base font-normal"
                value={activeFilter}
                onChange={(event) => setActiveFilter(event.target.value as typeof activeFilter)}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="retired">Retired</option>
              </select>
            </label>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {orderError ? (
          <Notice tone="danger" title="Field order was not saved">
            {configurationErrorMessage(orderError)} <ReloadButton />
          </Notice>
        ) : null}
        {orderSaved ? (
          <Notice tone="success" title="Field order saved">
            The visible controls now match the server order.
          </Notice>
        ) : null}
        {visible.length === 0 ? (
          <EmptyState
            title="No matching fields"
            message={
              data.fields.length === 0
                ? "Create the first field above; its definition will be versioned from the start."
                : "Try a different entity or status filter."
            }
          />
        ) : (
          <div className="space-y-4" role="list" aria-label="Field definitions">
            {visible.map((field, index) => (
              <FieldRow
                key={field.field_id}
                field={field}
                catalog={data.catalog}
                entityTypes={entityTypes}
                entityCatalogReady={entityCatalogReady}
                live={live}
                canMoveUp={visible[index - 1]?.entity_type === field.entity_type}
                canMoveDown={visible[index + 1]?.entity_type === field.entity_type}
                reordering={reorder.isPending}
                onMove={(direction) => move(index, direction)}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FieldCreateForm({
  catalog,
  entityTypes,
  entityCatalogReady,
  live,
  nextPosition,
  onCreated,
}: {
  catalog: SchemaFieldCatalog;
  entityTypes: AdminPipelineListResponse["entity_types"];
  entityCatalogReady: boolean;
  live: boolean;
  nextPosition: (entityType: string) => number;
  onCreated: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const create = useMutation({
    mutationFn: (input: SchemaFieldWriteInput) => createSchemaField(session, input),
    onSuccess: () => {
      setOpen(false);
      setSaved(true);
      onCreated();
    },
  });
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Create a field</CardTitle>
            <CardDescription>
              All policy choices come from the server catalog. Validator and visibility JSON appears
              only when that selected rule needs structured settings.
            </CardDescription>
          </div>
          {!open ? (
            <div className="flex flex-wrap items-center gap-2">
              {saved ? (
                <span className="text-sm font-bold text-ok" role="status">
                  Field created.
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!live || !entityCatalogReady}
                title={
                  entityCatalogReady
                    ? undefined
                    : "A verified server entity type catalog is required."
                }
                onClick={() => {
                  setSaved(false);
                  setOpen(true);
                }}
              >
                <Plus aria-hidden="true" />
                New field
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      {open ? (
        <CardContent>
          <FieldForm
            catalog={catalog}
            entityTypes={entityTypes}
            entityCatalogReady={entityCatalogReady}
            live={live}
            busy={create.isPending}
            error={create.error}
            nextPosition={nextPosition}
            onCancel={() => setOpen(false)}
            onSubmit={(input) => create.mutate(input)}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

function FieldRow({
  field,
  catalog,
  entityTypes,
  entityCatalogReady,
  live,
  canMoveUp,
  canMoveDown,
  reordering,
  onMove,
  onChanged,
}: {
  field: SchemaField;
  catalog: SchemaFieldCatalog;
  entityTypes: AdminPipelineListResponse["entity_types"];
  entityCatalogReady: boolean;
  live: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  reordering: boolean;
  onMove: (direction: -1 | 1) => void;
  onChanged: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyKey = schemaFieldHistoryQueryKey(session.tenant.id, field.field_id, field.version);
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => loadSchemaFieldHistory(field.field_id),
    enabled: historyOpen && live,
  });
  const revise = useMutation({
    mutationFn: (input: SchemaFieldWriteInput) => reviseSchemaField(session, field.field_id, input),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const deactivate = useMutation({
    mutationFn: () =>
      reviseSchemaField(
        session,
        field.field_id,
        fieldInput(field, { action: "retire", active: false, expected_version: field.version }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const busy = revise.isPending || deactivate.isPending || reordering;

  return (
    <article role="listitem" className="rounded-md border border-border bg-surface p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 font-bold">
            <span className="truncate">{field.label}</span>
            <StatusPill active={field.active}>{field.active ? "Active" : "Retired"}</StatusPill>
          </h3>
          <p className="mt-1 break-words text-sm text-muted">
            <span className="font-semibold text-foreground">{field.field_key}</span> ·{" "}
            {field.entity_type} · {field.field_type} · revision {field.version}
          </p>
          {!field.active ? (
            <p className="mt-1 text-xs leading-5 text-muted">
              Retired definitions stay in history; create a new field for a replacement.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={`Move ${field.label} up`}
            title="Move up"
            disabled={!live || busy || !canMoveUp}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={`Move ${field.label} down`}
            title="Move down"
            disabled={!live || busy || !canMoveDown}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="compact"
            disabled={!live || busy || !field.active || !entityCatalogReady}
            title={
              entityCatalogReady
                ? undefined
                : "A verified server entity type catalog is required before revising fields."
            }
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Close revise" : "Revise"}
          </Button>
          {field.active ? (
            <Button
              type="button"
              variant="danger"
              size="compact"
              busy={deactivate.isPending}
              disabled={!live || busy}
              onClick={() => {
                if (live) deactivate.mutate();
              }}
            >
              Deactivate
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <History aria-hidden="true" />
            {historyOpen ? "Hide history" : "History"}
          </Button>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-5 gap-y-2 border-t border-border pt-4 text-sm sm:grid-cols-2">
        <Meta
          label="Validation"
          value={`${field.validator_key}${Object.keys(field.validator_config).length ? ` · ${JSON.stringify(field.validator_config)}` : ""}`}
        />
        <Meta
          label="Visibility"
          value={`${field.visibility_key}${Object.keys(field.visibility_config).length ? ` · ${JSON.stringify(field.visibility_config)}` : ""}`}
        />
        <Meta
          label="Access"
          value={`Read: ${field.read_scope} (${field.read_roles.join(", ") || "none"}) · Write: ${field.write_scope} (${field.write_roles.join(", ") || "none"})`}
        />
        <Meta
          label="Policy"
          value={`Evidence: ${field.evidence_class}. Retention: ${field.retention_policy}. Offline: ${field.offline_mode}.`}
        />
      </dl>
      {revise.isError ? (
        <div className="mt-4">
          <Notice tone="danger" title="Field revision was not saved">
            {configurationErrorMessage(revise.error)} <ReloadButton />
          </Notice>
        </div>
      ) : null}
      {deactivate.isError ? (
        <div className="mt-4">
          <Notice tone="danger" title="Field was not deactivated">
            {configurationErrorMessage(deactivate.error)} <ReloadButton />
          </Notice>
        </div>
      ) : null}
      {deactivate.isSuccess ? (
        <div className="mt-4">
          <Notice tone="success" title="Field deactivated">
            The previous active definition remains in immutable history.
          </Notice>
        </div>
      ) : null}
      {revise.isSuccess ? (
        <div className="mt-4">
          <Notice tone="success" title="Field revision saved">
            The previous definition remains in immutable history.
          </Notice>
        </div>
      ) : null}
      {editing ? (
        <div className="mt-5 border-t border-border pt-5">
          <FieldForm
            key={`${field.field_id}:${field.version}`}
            catalog={catalog}
            entityTypes={entityTypes}
            entityCatalogReady={entityCatalogReady}
            initial={field}
            live={live}
            busy={revise.isPending}
            error={revise.error}
            nextPosition={() => field.position}
            onCancel={() => setEditing(false)}
            onSubmit={(input) => revise.mutate({ ...input, expected_version: field.version })}
          />
        </div>
      ) : null}
      {historyOpen ? (
        <FieldHistory
          field={field}
          history={history}
          live={live}
          onRetry={() => void history.refetch()}
        />
      ) : null}
      <p className="mt-4 text-xs leading-5 text-muted">
        Definition revision {field.revision_id}. Created {formatDate(field.created_at)} by{" "}
        {field.actor.role}; changes append a new reasoned revision.
      </p>
    </article>
  );
}

// The classifier is exported for deterministic field-action contract tests.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveSchemaFieldAction(
  current: SchemaField,
  next: SchemaFieldWriteInput,
): "relabel" | "reorder" | "revise" | null {
  const changedLabel = next.label !== current.label;
  const changedPosition = next.position !== current.position;
  const changedOutsideLabelAndPosition =
    next.entity_type !== current.entity_type ||
    next.field_key !== current.field_key ||
    next.field_type !== current.field_type ||
    next.validator_key !== current.validator_key ||
    stableJson(next.validator_config) !== stableJson(current.validator_config) ||
    next.visibility_key !== current.visibility_key ||
    stableJson(next.visibility_config) !== stableJson(current.visibility_config) ||
    next.evidence_class !== current.evidence_class ||
    next.retention_policy !== current.retention_policy ||
    next.offline_mode !== current.offline_mode ||
    next.read_scope !== current.read_scope ||
    next.write_scope !== current.write_scope ||
    !sameRoles(next.read_roles, current.read_roles) ||
    !sameRoles(next.write_roles, current.write_roles) ||
    (next.active ?? current.active) !== current.active;
  if (!changedLabel && !changedPosition && !changedOutsideLabelAndPosition) return null;
  if (changedLabel && !changedPosition && !changedOutsideLabelAndPosition) return "relabel";
  if (!changedLabel && changedPosition && !changedOutsideLabelAndPosition) return "reorder";
  return "revise";
}

function sameRoles(left: string[], right: string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function FieldForm({
  catalog,
  entityTypes,
  entityCatalogReady,
  initial,
  live,
  busy,
  error,
  nextPosition,
  onCancel,
  onSubmit,
}: {
  catalog: SchemaFieldCatalog;
  entityTypes: AdminPipelineListResponse["entity_types"];
  entityCatalogReady: boolean;
  initial?: SchemaField;
  live: boolean;
  busy: boolean;
  error: unknown;
  nextPosition: (entityType: string) => number;
  onCancel?: () => void;
  onSubmit: (input: SchemaFieldWriteInput) => void;
}) {
  const entityId = useId();
  const keyId = useId();
  const labelId = useId();
  const validatorConfigId = useId();
  const visibilityConfigId = useId();
  const [entityType, setEntityType] = useState(
    initial?.entity_type ?? entityTypes[0]?.entity_type ?? "",
  );
  const [fieldKey, setFieldKey] = useState(initial?.field_key ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [fieldType, setFieldType] = useState(
    initial?.field_type ?? catalog.field_types[0] ?? "text",
  );
  const [validator, setValidator] = useState(initial?.validator_key ?? "none");
  const [validatorConfig, setValidatorConfig] = useState(
    JSON.stringify(initial?.validator_config ?? {}, null, 2),
  );
  const [visibility, setVisibility] = useState(initial?.visibility_key ?? "always");
  const [visibilityConfig, setVisibilityConfig] = useState(
    JSON.stringify(initial?.visibility_config ?? {}, null, 2),
  );
  const [evidence, setEvidence] = useState(
    initial?.evidence_class ?? catalog.evidence_classes[0] ?? "none",
  );
  const [retention, setRetention] = useState(
    initial?.retention_policy ?? catalog.retention_policies[0] ?? "standard",
  );
  const [offline, setOffline] = useState(
    initial?.offline_mode ?? catalog.offline_modes[0] ?? "online_only",
  );
  const [readScope, setReadScope] = useState(initial?.read_scope ?? catalog.scopes[0] ?? "all");
  const [writeScope, setWriteScope] = useState(initial?.write_scope ?? catalog.scopes[0] ?? "all");
  const [readRoles, setReadRoles] = useState(
    initial?.read_roles ?? catalog.roles.filter((role) => role === "owner" || role === "ops"),
  );
  const [writeRoles, setWriteRoles] = useState(
    initial?.write_roles ?? catalog.roles.filter((role) => role === "owner" || role === "ops"),
  );
  const [formError, setFormError] = useState<string>();
  const needsValidatorConfig = validator === "options" || validator === "range";
  const needsVisibilityConfig = visibility !== "always";
  const entityTypeOptions =
    initial && !entityTypes.some((entry) => entry.entity_type === initial.entity_type)
      ? [
          ...entityTypes,
          {
            entity_type: initial.entity_type,
            label: `${initial.entity_type} (current; not in catalog)`,
          },
        ]
      : entityTypes;

  function parseConfig(raw: string, name: string): Record<string, unknown> | null {
    if (!raw.trim()) return {};
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      setFormError(`Enter valid JSON for ${name}.`);
      return null;
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!live) return;
    setFormError(undefined);
    const parsedValidator = needsValidatorConfig
      ? parseConfig(validatorConfig, "validator configuration")
      : {};
    const parsedVisibility = needsVisibilityConfig
      ? parseConfig(visibilityConfig, "visibility configuration")
      : {};
    if (parsedValidator === null || parsedVisibility === null) return;
    if (!fieldKey.trim() || !label.trim() || !entityType.trim()) {
      setFormError("Complete the entity type, field key, and label.");
      return;
    }
    if (!entityCatalogReady || !entityTypes.some((entry) => entry.entity_type === entityType)) {
      setFormError("Choose an entity type from the verified server catalog before saving.");
      return;
    }
    const next: SchemaFieldWriteInput = {
      entity_type: entityType,
      field_key: fieldKey.trim(),
      label: label.trim(),
      // Ordering is owned by the move controls on the list, not by a number an
      // admin has to guess: a revision keeps its place, a new field lands last.
      position: initial ? initial.position : nextPosition(entityType),
      field_type: fieldType,
      validator_key: validator,
      validator_config: needsValidatorConfig ? parsedValidator : {},
      visibility_key: visibility,
      visibility_config: needsVisibilityConfig ? parsedVisibility : {},
      evidence_class: evidence,
      retention_policy: retention,
      offline_mode: offline,
      read_scope: readScope,
      write_scope: writeScope,
      read_roles: readRoles,
      write_roles: writeRoles,
      active: initial?.active ?? true,
    };
    const action = initial ? deriveSchemaFieldAction(initial, next) : "create";
    if (initial && !action) {
      setFormError("No changes to save. Update a field setting before creating a revision.");
      return;
    }
    onSubmit({ ...next, action: action ?? undefined });
  }

  function toggleRole(
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    role: string,
    checked: boolean,
  ) {
    setter((current) =>
      checked ? [...new Set([...current, role])] : current.filter((entry) => entry !== role),
    );
  }

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label className="block text-sm font-bold" htmlFor={entityId}>
            Entity type
          </label>
          <Select
            id={entityId}
            value={entityType}
            disabled={!entityCatalogReady}
            onChange={(event) => setEntityType(event.target.value)}
          >
            {!entityTypeOptions.length ? <option value="">No verified entity types</option> : null}
            {entityTypeOptions.map((entry) => (
              <option
                key={entry.entity_type}
                value={entry.entity_type}
                disabled={Boolean(
                  initial && !entityTypes.some((item) => item.entity_type === entry.entity_type),
                )}
              >
                {entry.label}
              </option>
            ))}
          </Select>
          <p id={`${entityId}-hint`} className="text-xs leading-5 text-muted">
            Published by the server; identity changes stay within this catalog.
          </p>
        </div>
        <LabeledInput
          id={keyId}
          label="Field key"
          hint="Stable lowercase key; it is not renamed by a label correction."
          value={fieldKey}
          onChange={setFieldKey}
        />
        <LabeledInput id={labelId} label="Label" value={label} onChange={setLabel} />
        <div className="space-y-2">
          <label className="block text-sm font-bold" htmlFor={`${keyId}-type`}>
            Field type
          </label>
          <Select
            id={`${keyId}-type`}
            value={fieldType}
            disabled={Boolean(initial)}
            onChange={(event) => setFieldType(event.target.value)}
          >
            {catalog.field_types.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {initial ? (
            <p className="text-xs leading-5 text-muted">Field type is immutable after creation.</p>
          ) : null}
        </div>
        <CatalogSelect
          id={`${keyId}-validator`}
          label="Validator"
          value={validator}
          options={catalog.validators}
          onChange={(value) => setValidator(value)}
        />
      </div>
      {needsValidatorConfig ? (
        <JsonConfig
          id={validatorConfigId}
          label="Validator configuration"
          value={validatorConfig}
          onChange={setValidatorConfig}
          hint={validator === "options" ? '{"options":["one","two"]}' : '{"min":0,"max":100}'}
        />
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <CatalogSelect
          id={`${keyId}-visibility`}
          label="Visibility"
          value={visibility}
          options={catalog.visibility_rules}
          onChange={(value) => setVisibility(value)}
        />
        {needsVisibilityConfig ? (
          <JsonConfig
            id={visibilityConfigId}
            label="Visibility configuration"
            value={visibilityConfig}
            onChange={setVisibilityConfig}
            hint='{ "field_key": "other-field", "value": "yes" }'
          />
        ) : null}
        <CatalogSelect
          id={`${keyId}-evidence`}
          label="Evidence class"
          value={evidence}
          options={catalog.evidence_classes}
          onChange={setEvidence}
        />
        <CatalogSelect
          id={`${keyId}-retention`}
          label="Retention policy"
          value={retention}
          options={catalog.retention_policies}
          onChange={setRetention}
        />
        <CatalogSelect
          id={`${keyId}-offline`}
          label="Offline mode"
          value={offline}
          options={catalog.offline_modes}
          onChange={setOffline}
        />
        <CatalogSelect
          id={`${keyId}-read-scope`}
          label="Read scope"
          value={readScope}
          options={catalog.scopes}
          onChange={setReadScope}
        />
        <CatalogSelect
          id={`${keyId}-write-scope`}
          label="Write scope"
          value={writeScope}
          options={catalog.scopes}
          onChange={setWriteScope}
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <RolePicker
          title="Read roles"
          roles={catalog.roles}
          selected={readRoles}
          onToggle={(role, checked) => toggleRole(setReadRoles, role, checked)}
        />
        <RolePicker
          title="Write roles"
          roles={catalog.roles}
          selected={writeRoles}
          onToggle={(role, checked) => toggleRole(setWriteRoles, role, checked)}
        />
      </div>
      {formError ? (
        <Notice tone="danger" title="Check the field settings">
          {formError}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" title="Field was not saved">
          {configurationErrorMessage(error)} <ReloadButton />
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" busy={busy} disabled={!live}>
          <Save aria-hidden="true" />
          Save field definition
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function fieldInput(
  field: SchemaField,
  overrides: Partial<SchemaFieldWriteInput> = {},
): SchemaFieldWriteInput {
  return {
    entity_type: field.entity_type,
    field_key: field.field_key,
    label: field.label,
    position: field.position,
    field_type: field.field_type,
    validator_key: field.validator_key,
    validator_config: field.validator_config,
    visibility_key: field.visibility_key,
    visibility_config: field.visibility_config,
    evidence_class: field.evidence_class,
    retention_policy: field.retention_policy,
    offline_mode: field.offline_mode,
    read_scope: field.read_scope,
    write_scope: field.write_scope,
    read_roles: field.read_roles,
    write_roles: field.write_roles,
    active: field.active,
    ...overrides,
  };
}

function FieldHistory({
  field,
  history,
  live,
  onRetry,
}: {
  field: SchemaField;
  history: {
    data?: SchemaFieldHistoryResponse;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  live: boolean;
  onRetry: () => void;
}) {
  if (!live && !history.data)
    return (
      <Notice tone="warning" title="History is not cached">
        Reconnect to read this field's immutable revision history.
      </Notice>
    );
  if (history.isPending && !history.data)
    return (
      <p className="mt-4 text-sm text-muted" role="status">
        Loading immutable revision history…
      </p>
    );
  if (history.isError && !history.data)
    return (
      <Notice tone="danger" title="History could not load">
        {configurationErrorMessage(history.error)}{" "}
        <button type="button" className="ml-1 min-h-11 font-bold underline" onClick={onRetry}>
          Try again
        </button>
      </Notice>
    );
  if (!history.data) return null;
  return (
    <div className="mt-5 border-t border-border pt-4">
      <h4 className="font-bold">Immutable history for {field.field_key}</h4>
      <p className="mt-1 text-sm text-muted">
        Current revision {history.data.current_version}; each entry records the actor and prior
        revision.
      </p>
      <ol className="mt-3 space-y-2">
        {history.data.revisions.map((revision) => (
          <li
            key={revision.revision_id}
            className="rounded-md border border-border bg-surface-raised p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">
                Revision {revision.version} · {revision.action}
              </span>
              <span className="text-muted">{formatDate(revision.created_at)}</span>
            </div>
            <p className="mt-1 text-muted">
              {revision.label} · {revision.actor.role} · {revision.revision_id}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RolePicker({
  title,
  roles,
  selected,
  onToggle,
}: {
  title: string;
  roles: string[];
  selected: string[];
  onToggle: (role: string, checked: boolean) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-bold">{title}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {roles.map((role) => (
          <label key={role} className="inline-flex min-h-11 items-center gap-2 rounded-md px-2">
            <input
              type="checkbox"
              checked={selected.includes(role)}
              onChange={(event) => onToggle(role, event.target.checked)}
            />
            {roleLabel(role)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CatalogSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </div>
  );
}

function JsonConfig({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  return (
    <div className="space-y-2 sm:col-span-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Textarea
        id={id}
        rows={3}
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs leading-5 text-muted">
        Example: {hint}
      </p>
    </div>
  );
}

function LabeledInput({
  id,
  label,
  hint,
  value,
  type = "text",
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  type?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs leading-5 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-bold">{label}</dt>
      <dd className="break-words text-muted">{value}</dd>
    </div>
  );
}

function StatusPill({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-bold ${active ? "bg-ok-soft text-ok" : "bg-surface-muted text-muted"}`}
    >
      {children}
    </span>
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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown time"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
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
        title="Reconnect to open field configuration"
        message="Field configuration is not available offline yet. Reconnect to load cached-safe settings; no definition change will be queued."
      />
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-5xl space-y-6 pb-6">{children}</section>;
}
