import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  FileStack,
  Heading,
  History,
  Link as LinkIcon,
  Plus,
  Save,
  Tag,
  Text as TextIcon,
  Trash2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

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
import { Textarea } from "../components/ui/textarea";
import type { DocumentBlock } from "../documents/document-contracts";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  configurationErrorMessage,
  createDocumentTemplate,
  loadAdminPipelines,
  loadDocumentTemplateHistory,
  loadDocumentTemplates,
  loadSchemaFields,
  retireDocumentTemplate,
  reviseDocumentTemplate,
} from "./configuration-api";
import {
  adminPipelineQueryKey,
  documentTemplateHistoryQueryKey,
  documentTemplateQueryKey,
  schemaFieldsQueryKey,
  type AdminDocumentTemplate,
  type AdminPipelineListResponse,
  type DocumentTemplateHistoryResponse,
  type DocumentTemplateWriteInput,
  type SchemaField,
} from "./configuration-contracts";
import { AdminPageHeader } from "./admin-shell";

/**
 * Authoring the documents a job carries — contracts, estimates, materials lists — as DATA an
 * administrator arranges, not as files an engineer ships.
 *
 * A document here is a layout: headings, paragraphs, and bindings naming the fields that fill it.
 * The values never live on the template. They are joined at read time by the surface the crew and
 * the shop already open (`documents/document-section.tsx`), which is the one place per-field
 * authority is applied — so authoring a document can never become a second, weaker way to publish
 * data an administrator was not entitled to hand out.
 *
 * The server keeps every revision. Revise appends; retire appends a revision that turns the
 * document off. Neither erases what a document said when it was sent.
 */
export function DocumentTemplatesConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <DocumentTemplatesContent />
    </RoleGuard>
  );
}

function DocumentTemplatesContent() {
  // Configuration refuses an offline edit and keeps nothing, so the app-wide banner
  // must not promise this screen's work is waiting on the device to be sent.
  useReadOnlyOfflineSurface();
  const session = useSession();
  const online = useOnlineStatus();
  const live = online && !isOfflineSession(session);
  const queryClient = useQueryClient();
  const templatesKey = documentTemplateQueryKey(session.tenant.id);
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: () => loadDocumentTemplates(),
    enabled: live,
  });
  const fields = useQuery({
    queryKey: schemaFieldsQueryKey(session.tenant.id),
    queryFn: () => loadSchemaFields(),
    enabled: live,
  });
  const pipelineCatalog = useQuery({
    queryKey: adminPipelineQueryKey(session.tenant.id),
    queryFn: () => loadAdminPipelines(),
    enabled: live,
  });

  if (!live && !templates.data) return <ConfigurationOffline />;
  if (templates.isPending && !templates.data) return <LoadingState label="Loading documents…" />;
  if (templates.isError && !templates.data) {
    return (
      <Section>
        <ErrorState
          title="Documents could not load"
          message={configurationErrorMessage(templates.error)}
          onRetry={() => void templates.refetch()}
        />
      </Section>
    );
  }
  const data = templates.data;
  if (!data) return null;

  const entityTypes: AdminPipelineListResponse["entity_types"] =
    pipelineCatalog.isError || !pipelineCatalog.data ? [] : pipelineCatalog.data.entity_types;
  const entityCatalogReady = entityTypes.length > 0;
  // A field block may only name an ACTIVE field of the same record type; the server refuses
  // anything else. Offering a retired field would be offering a save that cannot succeed.
  const availableFields = (fields.data?.fields ?? []).filter((field) => field.active);
  const fieldsReady = !fields.isError && Boolean(fields.data);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: templatesKey });

  return (
    <Section>
      <AdminPageHeader
        icon={<FileStack className="size-6 text-accent" aria-hidden="true" />}
        title="Documents"
        description="Build the contracts, estimates, and lists your team sends, out of your own fields. A document is filled from the record it is opened on; it is never a file somebody has to keep up to date by hand."
        action={<ConfigurationLink />}
      />
      {!live ? (
        <Notice tone="warning" title="Offline: configuration is read-only">
          Cached documents remain readable. Reconnect before creating, revising, or retiring one.
        </Notice>
      ) : null}
      {templates.isError ? (
        <Notice tone="danger" title="The latest refresh failed">
          {configurationErrorMessage(templates.error)} <ReloadButton />
        </Notice>
      ) : null}
      {live && !entityCatalogReady ? (
        <Notice
          tone="warning"
          title={
            pipelineCatalog.isError ? "Record type catalog unavailable" : "Loading record types"
          }
        >
          {pipelineCatalog.isError
            ? `${configurationErrorMessage(pipelineCatalog.error)} Existing documents stay readable, but creating one is disabled until the server catalog is available.`
            : "Creating a document is disabled until a verified server record type is available."}{" "}
          {pipelineCatalog.isError ? (
            <button
              type="button"
              className="ml-1 min-h-11 font-bold underline underline-offset-4 focus-visible:outline-focus"
              onClick={() => void pipelineCatalog.refetch()}
            >
              Retry record types
            </button>
          ) : null}
        </Notice>
      ) : null}
      {live && fields.isError ? (
        <Notice tone="warning" title="Fields could not load">
          {configurationErrorMessage(fields.error)} A document is built out of fields, so creating
          and revising one stays disabled until they load.{" "}
          <button
            type="button"
            className="ml-1 min-h-11 font-bold underline underline-offset-4 focus-visible:outline-focus"
            onClick={() => void fields.refetch()}
          >
            Retry fields
          </button>
        </Notice>
      ) : null}
      <DocumentCreateForm
        catalog={data.catalog}
        entityTypes={entityTypes}
        fields={availableFields}
        live={live && entityCatalogReady && fieldsReady}
        onCreated={refresh}
      />
      <DocumentList
        templates={data.templates}
        catalog={data.catalog}
        entityTypes={entityTypes}
        fields={availableFields}
        live={live && fieldsReady}
        onChanged={refresh}
      />
    </Section>
  );
}

/** Active first, then by record type and name — a retired document is history, not today's work. */
// eslint-disable-next-line react-refresh/only-export-components
export function sortDocumentTemplates(templates: AdminDocumentTemplate[]): AdminDocumentTemplate[] {
  return [...templates].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const byEntity = left.entity_type.localeCompare(right.entity_type);
    if (byEntity !== 0) return byEntity;
    return left.label.localeCompare(right.label);
  });
}

/**
 * A document with no field block renders the same words on every record, which is a static file
 * with extra steps. The server refuses one; this says so before the administrator spends a save.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function documentBlocksProblem(blocks: DocumentBlock[]): string | null {
  if (blocks.length === 0) return "Add at least one block to this document.";
  const empty = blocks.some(
    (block) => (block.kind === "heading" || block.kind === "text") && block.text.trim() === "",
  );
  if (empty) return "Every heading and paragraph needs text.";
  const markup = blocks.some(
    (block) =>
      (block.kind === "heading" || block.kind === "text") &&
      (block.text.includes("<") || block.text.includes(">")),
  );
  if (markup) return "Remove the angle brackets from the text. Documents hold plain text.";
  const bindings = blocks.filter((block) => block.kind === "field");
  if (bindings.length === 0)
    return "Add at least one field, so this document is filled from the record it is opened on.";
  const chosen = bindings.map((block) => (block.kind === "field" ? block.field_id : ""));
  if (new Set(chosen).size !== chosen.length)
    return "The same field is used twice. Each field can appear once in a document.";
  const missing = chosen.some((fieldId) => fieldId === "");
  return missing ? "Choose a field for every field block." : null;
}

function DocumentCreateForm({
  catalog,
  entityTypes,
  fields,
  live,
  onCreated,
}: {
  catalog: { retention_policies: string[] };
  entityTypes: AdminPipelineListResponse["entity_types"];
  fields: SchemaField[];
  live: boolean;
  onCreated: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: (input: DocumentTemplateWriteInput) => createDocumentTemplate(session, input),
    onSuccess: () => {
      setOpen(false);
      onCreated();
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>Create a document</CardTitle>
            <CardDescription>
              Give it a name, choose which records it belongs to, then lay out its headings, text,
              and fields.
            </CardDescription>
          </div>
          {!open ? (
            <div className="flex flex-wrap items-center gap-2">
              {create.isSuccess ? (
                <span className="text-sm font-bold text-ok" role="status">
                  Document created.
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!live}
                onClick={() => {
                  create.reset();
                  setOpen(true);
                }}
              >
                <Plus aria-hidden="true" /> New document
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      {open ? (
        <CardContent>
          <DocumentTemplateForm
            idPrefix="document-new"
            catalog={catalog}
            entityTypes={entityTypes}
            fields={fields}
            live={live}
            busy={create.isPending}
            error={create.error}
            submitLabel="Save document"
            onCancel={() => setOpen(false)}
            onSubmit={(input) => create.mutate(input)}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

function DocumentList({
  templates,
  catalog,
  entityTypes,
  fields,
  live,
  onChanged,
}: {
  templates: AdminDocumentTemplate[];
  catalog: { retention_policies: string[] };
  entityTypes: AdminPipelineListResponse["entity_types"];
  fields: SchemaField[];
  live: boolean;
  onChanged: () => void;
}) {
  if (templates.length === 0)
    return (
      <EmptyState
        title="No documents yet"
        message="Create one above. A document is the layout your team sends. Its values come from the record it is opened on."
      />
    );
  return (
    <ul className="space-y-4" aria-label="Documents">
      {sortDocumentTemplates(templates).map((template) => (
        <li key={template.template_id}>
          <DocumentTemplateCard
            template={template}
            catalog={catalog}
            entityTypes={entityTypes}
            fields={fields}
            live={live}
            onChanged={onChanged}
          />
        </li>
      ))}
    </ul>
  );
}

function DocumentTemplateCard({
  template,
  catalog,
  entityTypes,
  fields,
  live,
  onChanged,
}: {
  template: AdminDocumentTemplate;
  catalog: { retention_policies: string[] };
  entityTypes: AdminPipelineListResponse["entity_types"];
  fields: SchemaField[];
  live: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyKey = documentTemplateHistoryQueryKey(
    session.tenant.id,
    template.template_id,
    template.version,
  );
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => loadDocumentTemplateHistory(template.template_id),
    enabled: historyOpen && live,
  });
  const revise = useMutation({
    mutationFn: (input: DocumentTemplateWriteInput) =>
      reviseDocumentTemplate(session, template.template_id, input),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const retire = useMutation({
    mutationFn: () => retireDocumentTemplate(session, template),
    onSuccess: () => {
      setConfirmingRetire(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const fieldLabels = new Map(fields.map((field) => [field.field_id, field.label]));

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="truncate">{template.label}</span>
              <StatusPill active={template.active}>
                {template.active ? "In use" : "Retired"}
              </StatusPill>
            </CardTitle>
            <CardDescription className="mt-1 break-words">
              {template.entity_type} · key {template.template_key} · {template.blocks.length}{" "}
              {template.blocks.length === 1 ? "block" : "blocks"} · revision {template.version}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={!live || !template.active}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Close edit" : "Edit"}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="ghost"
              disabled={!live || !template.active}
              onClick={() => {
                retire.reset();
                setConfirmingRetire((value) => !value);
              }}
            >
              <Archive aria-hidden="true" />
              Retire
            </Button>
            <Button
              type="button"
              size="compact"
              variant="ghost"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History aria-hidden="true" />
              {historyOpen ? "Hide history" : "History"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!template.active ? (
          <Notice tone="info" title="Retired">
            This document is no longer offered on new work, and no automation can select it. Every
            revision it ever had stays readable below.
          </Notice>
        ) : null}
        <DocumentBlockSummary blocks={template.blocks} fieldLabels={fieldLabels} />
        {retire.isError ? (
          <Notice tone="danger" title="This document was not retired">
            {configurationErrorMessage(retire.error)} <ReloadButton />
          </Notice>
        ) : null}
        {confirmingRetire ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <h3 className="font-bold">Retire this document?</h3>
            <p className="mt-1 text-sm leading-5 text-muted">
              It stops being offered on new work and no automation can select it. Documents already
              sent are unaffected, and every revision stays readable in history.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                busy={retire.isPending}
                disabled={!live}
                onClick={() => retire.mutate()}
              >
                <Archive aria-hidden="true" />
                Retire document
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={retire.isPending}
                onClick={() => setConfirmingRetire(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
        {revise.isSuccess ? (
          <Notice tone="success" title="Revision saved">
            The previous layout stays in history, so a document that was already sent still reads
            the way it did.
          </Notice>
        ) : null}
        {editing ? (
          <DocumentTemplateForm
            key={`${template.template_id}:${template.version}`}
            idPrefix={template.template_id}
            catalog={catalog}
            // A revision cannot change which records a document belongs to, so the picker holds
            // exactly this document's own type - named the way the catalog names it when it can.
            entityTypes={[
              {
                entity_type: template.entity_type,
                label:
                  entityTypes.find((entry) => entry.entity_type === template.entity_type)?.label ??
                  template.entity_type,
              },
            ]}
            fields={fields}
            initial={template}
            live={live}
            busy={revise.isPending}
            error={revise.error}
            submitLabel="Save revision"
            onCancel={() => setEditing(false)}
            onSubmit={(input) => revise.mutate({ ...input, expected_version: template.version })}
          />
        ) : null}
        {historyOpen ? (
          <DocumentTemplateHistory
            template={template}
            history={history}
            live={live}
            onRetry={() => void history.refetch()}
          />
        ) : null}
        <p className="text-xs leading-5 text-muted">
          Created {formatDate(template.created_at)} by {template.actor.role}. Revisions are
          append-only and keep their prior revision link.
        </p>
      </CardContent>
    </Card>
  );
}

function DocumentBlockSummary({
  blocks,
  fieldLabels,
}: {
  blocks: DocumentBlock[];
  fieldLabels: Map<string, string>;
}) {
  return (
    <ol className="space-y-1.5" aria-label="Document layout">
      {blocks.map((block, index) => (
        <li
          key={`${block.kind}:${index}`}
          className="flex min-w-0 items-start gap-2.5 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm"
        >
          <span className="shrink-0 rounded bg-surface-muted px-2 py-0.5 text-xs font-bold">
            {blockKindLabel(block.kind)}
          </span>
          <span className="min-w-0 break-words">
            {block.kind === "field"
              ? (fieldLabels.get(block.field_id) ?? block.field_id)
              : block.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The block editor. Blocks are ordered, so reordering is a first-class control rather than a
 * drag an administrator has to land precisely on a phone: two buttons, both a full touch target,
 * both reachable from the keyboard, and each one named after the block it moves.
 */
function DocumentTemplateForm({
  idPrefix,
  catalog,
  entityTypes,
  fields,
  initial,
  live,
  busy,
  error,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  idPrefix: string;
  catalog: { retention_policies: string[] };
  entityTypes: AdminPipelineListResponse["entity_types"];
  fields: SchemaField[];
  initial?: AdminDocumentTemplate;
  live: boolean;
  busy: boolean;
  error: unknown;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: DocumentTemplateWriteInput) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [templateKey, setTemplateKey] = useState(initial?.template_key ?? "");
  const [entityType, setEntityType] = useState(
    initial?.entity_type ?? entityTypes[0]?.entity_type ?? "",
  );
  const [retention, setRetention] = useState(
    initial?.retention_policy ?? catalog.retention_policies[0] ?? "standard",
  );
  const [blocks, setBlocks] = useState<DocumentBlock[]>(initial?.blocks ?? []);
  const [submitted, setSubmitted] = useState(false);

  // Sorted the way the Fields screen sorts: an administrator who reordered their fields must not
  // meet a different order here, or two screens disagree about the same list.
  const entityFields = fields
    .filter((field) => field.entity_type === entityType)
    .sort(
      (left, right) =>
        left.position - right.position || left.field_key.localeCompare(right.field_key),
    );
  const blocksProblem = documentBlocksProblem(blocks);
  const identityProblem =
    label.trim() === ""
      ? "Give this document a name."
      : templateKey.trim() === ""
        ? "Give this document a key."
        : entityType === ""
          ? "Choose which records this document belongs to."
          : null;
  const problem = identityProblem ?? blocksProblem;
  const canSave = live && !problem;

  const setBlock = (index: number, next: DocumentBlock) =>
    setBlocks((current) => current.map((block, position) => (position === index ? next : block)));
  const moveBlock = (index: number, delta: number) =>
    setBlocks((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });

  return (
    <form
      className="space-y-5 border-t border-border pt-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (!canSave) return;
        onSubmit({
          entity_type: entityType,
          template_key: templateKey.trim(),
          label: label.trim(),
          blocks,
          retention_policy: retention,
        });
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          id={`${idPrefix}-label`}
          label="Name"
          hint="What your team calls it, such as Materials list."
          value={label}
          onChange={setLabel}
        />
        <TextField
          id={`${idPrefix}-key`}
          label="Key"
          hint="A short stable identifier, such as materials-list. It cannot change later."
          value={templateKey}
          disabled={Boolean(initial)}
          onChange={setTemplateKey}
        />
        <LabelledSelect
          id={`${idPrefix}-entity`}
          label="Belongs to"
          hint="Which records this document can be opened on."
          value={entityType}
          disabled={Boolean(initial)}
          options={entityTypes.map((entry) => ({
            value: entry.entity_type,
            label: entry.label,
          }))}
          onChange={(value) => {
            setEntityType(value);
            // A field block names a field of ONE record type. Keeping bindings across a switch
            // would offer a save the server refuses, so the layout's text survives and its
            // field choices are cleared back to "choose one".
            setBlocks((current) =>
              current.map((block) =>
                block.kind === "field" ? { kind: "field", field_id: "" } : block,
              ),
            );
          }}
        />
        <LabelledSelect
          id={`${idPrefix}-retention`}
          label="Retention"
          hint="How long the sent copies are kept. It can be raised later, never lowered."
          value={retention}
          options={catalog.retention_policies.map((value) => ({ value, label: value }))}
          onChange={setRetention}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold">Layout</legend>
        <p className="text-sm leading-5 text-muted">
          Headings and paragraphs read the same on every record. A field is filled from the record
          the document is opened on. That is what makes this a document and not a file.
        </p>
        {entityFields.length === 0 ? (
          <Notice tone="warning" title="No fields for this record type">
            Add a field under Fields first. A document has to be filled from something.
          </Notice>
        ) : null}
        {blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
            Nothing here yet. Add a heading, some text, or a field.
          </p>
        ) : (
          <ol className="space-y-3" aria-label="Document blocks">
            {blocks.map((block, index) => (
              <li
                key={`${idPrefix}-block-${index}`}
                className="rounded-lg border border-border bg-surface-raised p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold">
                    {index + 1}. {blockKindLabel(block.kind)}
                  </span>
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={`Move ${blockKindLabel(block.kind)} ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => moveBlock(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={`Move ${blockKindLabel(block.kind)} ${index + 1} down`}
                      disabled={index === blocks.length - 1}
                      onClick={() => moveBlock(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${blockKindLabel(block.kind)} ${index + 1}`}
                      onClick={() =>
                        setBlocks((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  {block.kind === "heading" ? (
                    <>
                      <LabelledSelect
                        id={`${idPrefix}-block-${index}-level`}
                        label="Size"
                        value={String(block.level)}
                        options={[
                          { value: "1", label: "Title" },
                          { value: "2", label: "Section" },
                          { value: "3", label: "Sub-section" },
                        ]}
                        onChange={(value) =>
                          setBlock(index, {
                            kind: "heading",
                            level: Number(value) as 1 | 2 | 3,
                            text: block.text,
                          })
                        }
                      />
                      <TextField
                        id={`${idPrefix}-block-${index}-text`}
                        label="Heading text"
                        value={block.text}
                        onChange={(value) =>
                          setBlock(index, { kind: "heading", level: block.level, text: value })
                        }
                      />
                    </>
                  ) : null}
                  {block.kind === "text" ? (
                    <div className="space-y-2">
                      <label
                        className="block text-sm font-bold"
                        htmlFor={`${idPrefix}-block-${index}-text`}
                      >
                        Paragraph
                      </label>
                      <Textarea
                        id={`${idPrefix}-block-${index}-text`}
                        value={block.text}
                        onChange={(event) =>
                          setBlock(index, { kind: "text", text: event.target.value })
                        }
                      />
                    </div>
                  ) : null}
                  {block.kind === "field" ? (
                    <LabelledSelect
                      id={`${idPrefix}-block-${index}-field`}
                      label="Field"
                      hint="Its value is read from the record when the document is opened."
                      value={block.field_id}
                      options={[
                        { value: "", label: "Choose a field" },
                        ...entityFields.map((field) => ({
                          value: field.field_id,
                          label: field.label,
                        })),
                      ]}
                      onChange={(value) => setBlock(index, { kind: "field", field_id: value })}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setBlocks((current) => [...current, { kind: "heading", level: 2, text: "" }])
            }
          >
            <Heading aria-hidden="true" /> Add heading
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setBlocks((current) => [...current, { kind: "text", text: "" }])}
          >
            <TextIcon aria-hidden="true" /> Add text
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={entityFields.length === 0}
            onClick={() => setBlocks((current) => [...current, { kind: "field", field_id: "" }])}
          >
            <Tag aria-hidden="true" /> Add field
          </Button>
        </div>
      </fieldset>

      {submitted && problem ? (
        <Notice tone="warning" title="Not ready to save">
          {problem}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" title="This document was not saved">
          {configurationErrorMessage(error)} <ReloadButton />
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="accent" busy={busy} disabled={!live}>
          <Save aria-hidden="true" />
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DocumentTemplateHistory({
  template,
  history,
  live,
  onRetry,
}: {
  template: AdminDocumentTemplate;
  history: {
    data?: DocumentTemplateHistoryResponse;
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
        Reconnect to read this document's revision history.
      </Notice>
    );
  if (history.isPending && !history.data)
    return (
      <p className="border-t border-border pt-4 text-sm text-muted" role="status">
        Loading document history…
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
    <div className="border-t border-border pt-4">
      <h3 className="font-bold">Immutable history</h3>
      <p className="mt-1 text-sm text-muted">
        Current revision {history.data.current_version ?? template.version}; retiring a document
        adds a revision rather than removing any.
      </p>
      <ol className="mt-3 space-y-2">
        {history.data.revisions.map((revision) => (
          <li
            key={revision.revision_id}
            className="rounded-md border border-border bg-surface-raised p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">
                Revision {revision.version} · {revisionActionLabel(revision.action)}
              </span>
              <span className="text-muted">{formatDate(revision.created_at)}</span>
            </div>
            <p className="mt-1 break-words text-muted">
              {revision.blocks.length} {revision.blocks.length === 1 ? "block" : "blocks"} ·{" "}
              {revision.actor.role} · {revision.revision_id}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
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

function LabelledSelect({
  id,
  label,
  hint,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled || options.length === 0}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function blockKindLabel(kind: DocumentBlock["kind"]): string {
  if (kind === "heading") return "Heading";
  if (kind === "text") return "Text";
  return "Field";
}

function revisionActionLabel(action: AdminDocumentTemplate["action"]): string {
  if (action === "create") return "created";
  if (action === "retire") return "retired";
  return "revised";
}

function ConfigurationLink() {
  return (
    <Link
      to="/settings/configuration"
      className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-bold text-muted hover:text-foreground focus-visible:outline-focus"
    >
      <LinkIcon className="size-4" aria-hidden="true" />
      Configuration hub
    </Link>
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
        title="Reconnect to open documents"
        message="Document configuration is not available offline yet. Reconnect to load cached-safe settings; no configuration change will be queued."
      />
    </Section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown time"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-5xl space-y-6 pb-6">{children}</section>;
}
