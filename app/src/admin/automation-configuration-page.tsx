import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, History, Link as LinkIcon, Plus, Save } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { useReadOnlyOfflineSurface } from "../components/offline-write-mode";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  configurationErrorMessage,
  createAutomationRule,
  loadAdminPipelines,
  loadAutomationHistory,
  loadAutomationRules,
  reviseAutomationRule,
} from "./configuration-api";
import {
  adminPipelineQueryKey,
  automationHistoryQueryKey,
  automationQueryKey,
  type AdminPipeline,
  type AutomationCatalog,
  type AutomationHistoryResponse,
  type AutomationListResponse,
  type AutomationRule,
  type AutomationWriteInput,
} from "./configuration-contracts";
import { AdminPageHeader } from "./admin-shell";

export function AutomationConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <AutomationConfigurationContent />
    </RoleGuard>
  );
}

function AutomationConfigurationContent() {
  // Configuration refuses an offline edit and keeps nothing, so the app-wide banner
  // must not promise this screen's work is waiting on the device to be sent.
  useReadOnlyOfflineSurface();
  const session = useSession();
  const online = useOnlineStatus();
  const live = online && !isOfflineSession(session);
  const queryClient = useQueryClient();
  const pipelinesKey = adminPipelineQueryKey(session.tenant.id);
  const pipelines = useQuery({
    queryKey: pipelinesKey,
    queryFn: () => loadAdminPipelines(),
    enabled: live,
  });
  const [selectedPipelineId, setSelectedPipelineId] = useState("");
  const pipelineData = pipelines.data;
  const resolvedPipelineId =
    pipelineData?.pipelines.find((candidate) => candidate.pipeline_id === selectedPipelineId)
      ?.pipeline_id ??
    pipelineData?.pipelines[0]?.pipeline_id ??
    "";
  const automationKey = automationQueryKey(session.tenant.id, resolvedPipelineId);
  const rules = useQuery({
    queryKey: automationKey,
    queryFn: () => loadAutomationRules(resolvedPipelineId),
    enabled: live && Boolean(resolvedPipelineId),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: automationKey });

  if (!live && !pipelines.data) return <ConfigurationOffline />;
  if (pipelines.isPending && !pipelines.data) return <LoadingState label="Loading pipelines…" />;
  if (pipelines.isError && !pipelines.data) {
    return (
      <Section>
        <ErrorState
          title="Automation pipelines could not load"
          message={configurationErrorMessage(pipelines.error)}
          onRetry={() => void pipelines.refetch()}
        />
      </Section>
    );
  }

  if (!pipelineData) return null;
  if (pipelineData.pipelines.length === 0) {
    return (
      <Section>
        <AdminPageHeader
          icon={<BellRing className="size-6 text-accent" aria-hidden="true" />}
          title="Automations"
          description="Send a governed stage-change email when a card enters a configured stage."
          action={<ConfigurationLink />}
        />
        {!live ? <OfflineNotice /> : null}
        <EmptyState
          title="Create a pipeline first"
          message="Automations belong to a pipeline and use only its active stages."
          action={
            <Link
              to="/settings/configuration/pipelines"
              className="inline-flex min-h-12 items-center rounded-lg bg-accent px-4 text-sm font-bold text-accent-foreground focus-visible:outline-focus"
            >
              Open pipelines
            </Link>
          }
        />
      </Section>
    );
  }

  const pipeline =
    pipelineData.pipelines.find((candidate) => candidate.pipeline_id === selectedPipelineId) ??
    pipelineData.pipelines[0];
  if (!pipeline) return null;

  return (
    <Section>
      <AdminPageHeader
        icon={<BellRing className="size-6 text-accent" aria-hidden="true" />}
        title="Automations"
        description="Send a governed stage-change email when a card enters a configured stage. Actions, templates, and recipient references come from the server catalog."
        action={<ConfigurationLink />}
      />
      {!live ? <OfflineNotice /> : null}
      {pipelines.isError ? (
        <Notice tone="danger" title="The latest pipeline refresh failed">
          {configurationErrorMessage(pipelines.error)} <ReloadButton />
        </Notice>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Choose a pipeline</CardTitle>
          <CardDescription>
            Rules are scoped to one pipeline. An inactive pipeline cannot run new automation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label
            className="block max-w-xl space-y-2 text-sm font-bold"
            htmlFor="automation-pipeline"
          >
            Pipeline
            <Select
              id="automation-pipeline"
              value={pipeline.pipeline_id}
              onChange={(event) => setSelectedPipelineId(event.target.value)}
            >
              {pipelineData.pipelines.map((candidate) => (
                <option key={candidate.pipeline_id} value={candidate.pipeline_id}>
                  {candidate.name} · {candidate.entity_type}
                </option>
              ))}
            </Select>
          </label>
        </CardContent>
      </Card>
      {rules.isPending && !rules.data ? <LoadingState label="Loading automation rules…" /> : null}
      {rules.isError && !rules.data ? (
        <ErrorState
          title="Automation rules could not load"
          message={configurationErrorMessage(rules.error)}
          onRetry={() => void rules.refetch()}
        />
      ) : null}
      {!live && !rules.data ? (
        <ErrorState
          title="Automation history is not cached"
          message="Reconnect to read this pipeline's rules. Configuration never changes while offline."
        />
      ) : null}
      {rules.data ? (
        <AutomationWorkspace
          pipeline={pipeline}
          data={rules.data}
          live={live}
          onChanged={refresh}
        />
      ) : null}
      {rules.isError && rules.data ? (
        <Notice tone="danger" title="The latest automation refresh failed">
          {configurationErrorMessage(rules.error)} <ReloadButton />
        </Notice>
      ) : null}
    </Section>
  );
}

function AutomationWorkspace({
  pipeline,
  data,
  live,
  onChanged,
}: {
  pipeline: AdminPipeline;
  data: AutomationListResponse;
  live: boolean;
  onChanged: () => void;
}) {
  const activeStages = pipeline.stages
    .filter((stage) => stage.is_active)
    .sort((left, right) => left.position - right.position);
  const availableStages = activeStages.filter(
    (stage) => !data.rules.some((rule) => rule.to_stage_id === stage.stage_id),
  );
  const stageName = new Map(pipeline.stages.map((stage) => [stage.stage_id, stage.name]));
  const hasCatalog =
    data.catalog.actions.length > 0 &&
    data.catalog.templates.length > 0 &&
    data.catalog.recipient_configured &&
    data.catalog.recipient_refs.length > 0;

  return (
    <>
      {!data.catalog.recipient_configured ? (
        <Notice tone="warning" title="Recipient configuration unavailable">
          The deployment did not provide a usable recipient catalog. Rules remain readable, but a
          new or revised email automation cannot be saved until the configured recipient service is
          available and valid. No raw email address can be entered in this screen.
        </Notice>
      ) : data.catalog.recipient_refs.length === 0 ? (
        <Notice tone="warning" title="No recipient references are available">
          The server catalog has no configured recipients. No raw email address can be entered here;
          ask an administrator to repair deployment-owned recipient configuration.
        </Notice>
      ) : null}
      {data.rules.some((rule) => !data.catalog.recipient_refs.includes(rule.recipient_ref)) ? (
        <Notice tone="warning" title="A saved rule uses an unavailable recipient reference">
          Refresh the catalog before revising that rule. The unavailable reference cannot be
          replaced with a raw address.
        </Notice>
      ) : null}
      <AutomationCreateForm
        pipeline={pipeline}
        catalog={data.catalog}
        stages={availableStages}
        live={live && pipeline.is_active}
        enabled={hasCatalog}
        onCreated={onChanged}
      />
      {activeStages.length > 0 && availableStages.length === 0 ? (
        <Notice tone="info" title="Every active stage already has a rule">
          Revise an existing rule below, or add another active stage before creating a new rule.
        </Notice>
      ) : null}
      {activeStages.length === 0 ? (
        <EmptyState
          title="No active stages"
          message="Add an active stage to this pipeline before creating a stage-change automation."
        />
      ) : null}
      {data.rules.length === 0 ? (
        <EmptyState
          title="No automations yet"
          message="Create a rule above to send a governed email when a card enters one of this pipeline's stages."
        />
      ) : (
        <div className="space-y-4" aria-label="Automation rules">
          {data.rules.map((rule) => (
            <AutomationRuleCard
              key={rule.rule_id}
              rule={rule}
              catalog={data.catalog}
              stages={activeStages}
              stageName={stageName}
              live={live && pipeline.is_active}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </>
  );
}

function AutomationCreateForm({
  pipeline,
  catalog,
  stages,
  live,
  enabled,
  onCreated,
}: {
  pipeline: AdminPipeline;
  catalog: AutomationCatalog;
  stages: AdminPipeline["stages"];
  live: boolean;
  enabled: boolean;
  onCreated: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState("");
  const [action, setAction] = useState("");
  const [template, setTemplate] = useState("");
  const [recipient, setRecipient] = useState("");
  const create = useMutation({
    mutationFn: (input: AutomationWriteInput) =>
      createAutomationRule(session, pipeline.pipeline_id, input),
    onSuccess: () => {
      setOpen(false);
      setStage("");
      setAction("");
      setTemplate("");
      setRecipient("");
      onCreated();
    },
  });
  const selectedStage = stage || stages[0]?.stage_id || "";
  const selectedAction = action || catalog.actions[0]?.action || "";
  const selectedTemplate =
    catalog.templates.find((entry) => entry.template_key === template) ?? catalog.templates[0];
  const selectedRecipient = recipient || catalog.recipient_refs[0] || "";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Create an automation</CardTitle>
            <CardDescription>
              Choose a stage and a deployment-owned recipient reference. The action is executable
              email only; no address, webhook, SMS, or formula is accepted.
            </CardDescription>
          </div>
          {!open ? (
            <div className="flex flex-wrap items-center gap-2">
              {create.isSuccess ? (
                <span className="text-sm font-bold text-ok" role="status">
                  Automation created.
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!live || !enabled || stages.length === 0}
                onClick={() => {
                  create.reset();
                  setOpen(true);
                }}
              >
                <Plus aria-hidden="true" /> New rule
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      {open ? (
        <CardContent>
          <form
            className="grid gap-5 sm:grid-cols-2"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!live) return;
              if (!selectedStage || !selectedAction || !selectedTemplate || !selectedRecipient)
                return;
              create.mutate({
                to_stage_id: selectedStage,
                action: selectedAction,
                recipient_ref: selectedRecipient,
                template_key: selectedTemplate.template_key,
                template_version: selectedTemplate.version,
                active: true,
              });
            }}
          >
            <CatalogSelect
              id="automation-new-stage"
              label="When a card enters"
              value={selectedStage}
              options={stages.map((entry) => ({ value: entry.stage_id, label: entry.name }))}
              onChange={setStage}
            />
            <CatalogSelect
              id="automation-new-action"
              label="Action"
              value={selectedAction}
              options={catalog.actions.map((entry) => ({
                value: entry.action,
                label: entry.label,
              }))}
              onChange={setAction}
            />
            <CatalogSelect
              id="automation-new-template"
              label="Template"
              value={selectedTemplate?.template_key ?? ""}
              options={catalog.templates.map((entry) => ({
                value: entry.template_key,
                label: `${entry.label} · v${entry.version}`,
              }))}
              onChange={setTemplate}
            />
            <CatalogSelect
              id="automation-new-recipient"
              label="Recipient reference"
              value={selectedRecipient}
              options={catalog.recipient_refs.map((value) => ({ value, label: value }))}
              onChange={setRecipient}
            />
            <p className="text-xs leading-5 text-muted sm:col-span-2">
              Recipient references are catalog identifiers. Their addresses stay deployment-owned
              and are never entered or displayed here.
            </p>
            {create.isError ? (
              <div className="sm:col-span-2">
                <Notice tone="danger" title="Automation was not created">
                  {configurationErrorMessage(create.error)} <ReloadButton />
                </Notice>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button
                type="submit"
                variant="accent"
                busy={create.isPending}
                disabled={
                  !live ||
                  !enabled ||
                  !selectedStage ||
                  !selectedAction ||
                  !selectedTemplate ||
                  !selectedRecipient
                }
              >
                <Save aria-hidden="true" />
                Save automation
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={create.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}

function AutomationRuleCard({
  rule,
  catalog,
  stages,
  stageName,
  live,
  onChanged,
}: {
  rule: AutomationRule;
  catalog: AutomationCatalog;
  stages: AdminPipeline["stages"];
  stageName: Map<string, string>;
  live: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const targetIsActive = stages.some((stage) => stage.stage_id === rule.to_stage_id);
  const historyKey = automationHistoryQueryKey(
    session.tenant.id,
    rule.pipeline_id,
    rule.rule_id,
    rule.version,
  );
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => loadAutomationHistory(rule.pipeline_id, rule.rule_id),
    enabled: historyOpen && live,
  });
  const revise = useMutation({
    mutationFn: (input: AutomationWriteInput) =>
      reviseAutomationRule(session, rule.pipeline_id, rule.rule_id, input),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const unavailableRecipient = !catalog.recipient_refs.includes(rule.recipient_ref);

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="truncate">{stageName.get(rule.to_stage_id) ?? "Unknown stage"}</span>
              <StatusPill active={rule.active === 1}>
                {rule.active === 1 ? "Enabled" : "Disabled"}
              </StatusPill>
            </CardTitle>
            <CardDescription className="mt-1 break-words">
              {rule.action} · {rule.template_key} v{rule.template_version} · {rule.recipient_ref} ·
              revision {rule.version}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={!live || !targetIsActive}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Close revise" : "Revise"}
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
        {unavailableRecipient ? (
          <Notice tone="warning" title="Recipient reference unavailable">
            This saved reference is not in the current server catalog. Refresh the catalog before
            revising it.
          </Notice>
        ) : null}
        {!targetIsActive ? (
          <Notice tone="warning" title="Stage is no longer active">
            This rule cannot be revised until its stage is active again.
          </Notice>
        ) : null}
        {revise.isError ? (
          <Notice tone="danger" title="Automation revision was not saved">
            {configurationErrorMessage(revise.error)} <ReloadButton />
          </Notice>
        ) : null}
        {revise.isSuccess ? (
          <Notice tone="success" title="Automation revision saved">
            The previous rule remains in immutable history.
          </Notice>
        ) : null}
        {editing ? (
          <AutomationRuleForm
            key={`${rule.rule_id}:${rule.version}`}
            rule={rule}
            catalog={catalog}
            stages={stages}
            live={live}
            busy={revise.isPending}
            error={revise.error}
            onCancel={() => setEditing(false)}
            onSubmit={(input) => revise.mutate({ ...input, expected_version: rule.version })}
          />
        ) : null}
        {historyOpen ? (
          <AutomationHistory
            rule={rule}
            history={history}
            live={live}
            onRetry={() => void history.refetch()}
          />
        ) : null}
        <p className="text-xs leading-5 text-muted">
          Created {formatDate(rule.created_at)} by {rule.actor_role}. Revisions are append-only and
          keep their prior revision link.
        </p>
      </CardContent>
    </Card>
  );
}

function AutomationRuleForm({
  rule,
  catalog,
  stages,
  live,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  rule: AutomationRule;
  catalog: AutomationCatalog;
  stages: AdminPipeline["stages"];
  live: boolean;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: AutomationWriteInput) => void;
}) {
  const [stage, setStage] = useState(rule.to_stage_id);
  const [action, setAction] = useState(rule.action);
  const [template, setTemplate] = useState(rule.template_key);
  const [recipient, setRecipient] = useState(rule.recipient_ref);
  const [active, setActive] = useState(rule.active === 1);
  const selectedTemplate = catalog.templates.find((entry) => entry.template_key === template);
  const canSave = Boolean(
    stages.some((entry) => entry.stage_id === stage) &&
    catalog.actions.some((entry) => entry.action === action) &&
    selectedTemplate &&
    catalog.recipient_refs.includes(recipient),
  );

  return (
    <form
      className="grid gap-5 border-t border-border pt-5 sm:grid-cols-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!live) return;
        if (!selectedTemplate || !canSave) return;
        onSubmit({
          to_stage_id: stage,
          action,
          recipient_ref: recipient,
          template_key: selectedTemplate.template_key,
          template_version: selectedTemplate.version,
          active,
        });
      }}
    >
      <CatalogSelect
        id={`${rule.rule_id}-stage`}
        label="When a card enters"
        value={stage}
        options={stages.map((entry) => ({ value: entry.stage_id, label: entry.name }))}
        disabled
        onChange={setStage}
      />
      <CatalogSelect
        id={`${rule.rule_id}-action`}
        label="Action"
        value={action}
        options={catalog.actions.map((entry) => ({ value: entry.action, label: entry.label }))}
        onChange={setAction}
      />
      <CatalogSelect
        id={`${rule.rule_id}-template`}
        label="Template"
        value={template}
        options={catalog.templates.map((entry) => ({
          value: entry.template_key,
          label: `${entry.label} · v${entry.version}`,
        }))}
        onChange={setTemplate}
      />
      <CatalogSelect
        id={`${rule.rule_id}-recipient`}
        label="Recipient reference"
        value={recipient}
        options={catalog.recipient_refs.map((value) => ({ value, label: value }))}
        onChange={setRecipient}
      />
      <label className="inline-flex min-h-11 items-center gap-3 text-sm font-bold sm:col-span-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        Enable this automation
      </label>
      <p className="text-xs leading-5 text-muted sm:col-span-2">
        Saving appends a revision. The recipient remains a server-provided reference; addresses are
        never accepted by this form.
      </p>
      {error ? (
        <div className="sm:col-span-2">
          <Notice tone="danger" title="Automation was not saved">
            {configurationErrorMessage(error)} <ReloadButton />
          </Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" busy={busy} disabled={!live || !canSave}>
          <Save aria-hidden="true" />
          Save revision
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AutomationHistory({
  rule,
  history,
  live,
  onRetry,
}: {
  rule: AutomationRule;
  history: {
    data?: AutomationHistoryResponse;
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
        Reconnect to read this automation's immutable revision history.
      </Notice>
    );
  if (history.isPending && !history.data)
    return (
      <p className="border-t border-border pt-4 text-sm text-muted" role="status">
        Loading immutable automation history…
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
        Current revision {history.data.current_version ?? rule.version}; every entry keeps its prior
        revision link.
      </p>
      <ol className="mt-3 space-y-2">
        {history.data.revisions.map((revision) => (
          <li
            key={revision.revision_id}
            className="rounded-md border border-border bg-surface-raised p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">Revision {revision.version}</span>
              <span className="text-muted">{formatDate(revision.created_at)}</span>
            </div>
            <p className="mt-1 break-words text-muted">
              {revision.action} · {revision.recipient_ref} · {revision.actor_role} ·{" "}
              {revision.revision_id}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CatalogSelect({
  id,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
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

function OfflineNotice() {
  return (
    <Notice tone="warning" title="Offline — configuration is read-only">
      Cached rules remain readable when available. Reconnect before creating, revising, enabling, or
      disabling an automation; no mutation is queued.
    </Notice>
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
        title="Reconnect to open automation configuration"
        message="Automation configuration is not available offline yet. Reconnect to load cached-safe settings; no configuration change will be queued."
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
