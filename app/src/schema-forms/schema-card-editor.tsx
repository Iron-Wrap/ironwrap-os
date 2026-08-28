import { CloudUpload, Pencil } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import type { FieldDateOptions } from "../field/field-formatting";
import { ApiError, isRetryableApiError } from "../lib/api";
import type { OutboxAction } from "../storage/outbox-types";
import { queueSchemaCardValue, writeSchemaCardValue } from "./schema-card-api";
import type { SchemaCardEntry } from "./schema-card-contracts";
import {
  formatSchemaCardValue,
  schemaCardControlValue,
  schemaCardCorrectionNote,
  schemaCardEditability,
  schemaCardReadOnlyCopy,
  schemaCardRequiresCorrection,
  schemaCardWireValue,
  schemaCardWriteRefusal,
  schemaValueIsEmpty,
} from "./schema-card-presentation";

/**
 * Filling in an administrator-defined field, from the phone the work is done on.
 *
 * #200 rendered these fields read-only and said why: the record view published no way to tell
 * which of them this caller could write, and both ways of guessing were wrong. The server now
 * publishes `writable` per field (ELEC-192), so the affordance follows an authority decision that
 * has already happened rather than a role list re-derived here.
 *
 * Three behaviours are load-bearing and none of them is decoration:
 *
 * - A field this caller may not write draws no control at all. Drawing one and letting the write
 *   bounce off a 403 teaches a crew member that the app lies about what they can do.
 * - Losing signal queues the entry. This is a field surface, and a value typed on a roof has to
 *   survive the walk back to the truck (ELEC-188 draws the line: configuration surfaces discard
 *   and say so, field surfaces queue).
 * - A conflict is shown, never resolved silently. Whoever else wrote the field had a reason, and
 *   on an evidence-classed or long-retention field the crew member must say what they are
 *   correcting before the correction is accepted.
 */

type EditorState =
  | { phase: "idle" }
  | { phase: "editing" }
  | { phase: "saving" }
  /**
   * Only entered once the record has been re-read, so `entry.value` is the value that actually
   * won. Nothing about the conflict is snapshotted: a stale copy of "what is on the card now" is
   * worse than no copy, because it invites the crew member to overwrite something they never saw.
   */
  | { phase: "conflict"; reason: string };

export function SchemaCardValueEditor({
  entry,
  entityType,
  entityId,
  dateOptions,
  online,
  pending,
  onWritten,
  fetcher,
}: {
  entry: SchemaCardEntry;
  entityType: string;
  entityId: string;
  dateOptions: FieldDateOptions;
  online: boolean;
  /** A value this device is still holding for this field, if any. */
  pending?: OutboxAction;
  /** Ask the host to re-read the record; a write is only real once the server's copy says so. */
  onWritten: () => void | Promise<unknown>;
  fetcher?: typeof fetch;
}) {
  const session = useSession();
  const { definition, value } = entry;
  const [state, setState] = useState<EditorState>({ phase: "idle" });
  const [draft, setDraft] = useState<string | string[] | boolean>(() =>
    schemaCardControlValue(definition, value),
  );
  const [refusal, setRefusal] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const controlId = useId();
  const reasonId = useId();

  const editability = schemaCardEditability(entry, { online });
  const empty = schemaValueIsEmpty(value);
  const correctionNote = schemaCardCorrectionNote(value);

  function startEditing() {
    setDraft(schemaCardControlValue(definition, value));
    setRefusal(undefined);
    setSaved(undefined);
    setState({ phase: "editing" });
  }

  function cancel() {
    setRefusal(undefined);
    setState({ phase: "idle" });
  }

  /**
   * One save attempt against one expected version.
   *
   * `expectedVersion` and the correction lineage are passed in rather than read from the entry,
   * because resolving a conflict means re-aiming the same command at the version the server
   * actually holds.
   */
  async function save(options: {
    expectedVersion: number;
    basedOnValueRevisionId?: string | null;
    correctionReason?: string | null;
  }) {
    const wire = schemaCardWireValue(definition, draft);
    if (!wire.ok) {
      setRefusal(wire.message);
      return;
    }
    const command = {
      entityType,
      entityId,
      fieldId: definition.field_id,
      fieldDefinitionRevisionId: definition.revision_id,
      expectedVersion: options.expectedVersion,
      value: wire.value,
      basedOnValueRevisionId: options.basedOnValueRevisionId ?? null,
      correctionReason: options.correctionReason ?? null,
    };
    setRefusal(undefined);
    setState({ phase: "saving" });

    // Offline and queueable never touches the network: attempting first would spend the crew
    // member's time on a request that cannot succeed before saying the same thing.
    if (!online && editability.kind === "editable" && editability.queueable) {
      await queue(command);
      return;
    }
    try {
      await writeSchemaCardValue(session, command, fetcher);
    } catch (error) {
      if (isRetryableApiError(error) && editability.kind === "editable" && editability.queueable) {
        // The connection dropped mid-save. The value is not lost, it is queued.
        await queue(command);
        return;
      }
      if (error instanceof ApiError && error.code === "schema_field_value_version_conflict") {
        await enterConflict();
        return;
      }
      setRefusal(schemaCardWriteRefusal(error, definition));
      setState({ phase: "editing" });
      return;
    }
    setSaved("Saved.");
    setState({ phase: "idle" });
    await refresh();
  }

  async function queue(command: Parameters<typeof queueSchemaCardValue>[1]) {
    try {
      await queueSchemaCardValue(session, command, fetcher);
    } catch (error) {
      setRefusal(
        error instanceof Error
          ? error.message
          : "This value could not be saved on this phone. Write it down.",
      );
      setState({ phase: "editing" });
      return;
    }
    setSaved("Saved on this phone. It sends itself when you have signal.");
    setState({ phase: "idle" });
    await refresh();
  }

  /**
   * Re-read the record after the value has landed.
   *
   * Deliberately outside the save's own error handling. A write that the server accepted stays
   * accepted whether or not the card can be re-read a moment later, and reporting the failed read
   * as a failed write would send a crew member to enter the value a second time. The section says
   * the refresh failed, above a card that still shows everything it had.
   */
  async function refresh() {
    try {
      await onWritten();
    } catch {
      // Said by the section, once, rather than by every field that happened to be open.
    }
  }

  /**
   * A conflict is a fact about the record, so it is read from the record rather than assumed. The
   * refreshed card carries the value that actually won, which is what the crew member has to see
   * before deciding whether their entry still belongs — and what the correction has to point at.
   *
   * A refresh that fails leaves nothing honest to show, so the conflict is reported as a refusal
   * and the entry stays in the box rather than being resolved against a copy nobody has seen.
   */
  async function enterConflict() {
    try {
      await onWritten();
    } catch {
      setRefusal(
        "Someone else changed this field, and this phone could not read their value. Reload the card before saving again.",
      );
      setState({ phase: "editing" });
      return;
    }
    setRefusal(undefined);
    setState({ phase: "conflict", reason: "" });
  }

  if (editability.kind === "read_only") {
    const note = schemaCardReadOnlyCopy[editability.reason];
    return (
      <ValueShell
        entry={entry}
        dateOptions={dateOptions}
        empty={empty}
        correctionNote={correctionNote}
        pending={pending}
      >
        {note ? <p className="mt-1.5 text-sm leading-6 text-muted">{note}</p> : null}
      </ValueShell>
    );
  }

  if (state.phase === "idle") {
    return (
      <ValueShell
        entry={entry}
        dateOptions={dateOptions}
        empty={empty}
        correctionNote={correctionNote}
        pending={pending}
      >
        <div className="mt-2">
          <Button
            type="button"
            size="compact"
            variant="outline"
            onClick={startEditing}
            data-testid={`schema-field-edit-${definition.field_key}`}
          >
            <Pencil aria-hidden="true" />
            {empty
              ? `Add ${definition.label.toLowerCase()}`
              : `Change ${definition.label.toLowerCase()}`}
          </Button>
          {saved ? (
            <p className="mt-2 text-sm leading-6 text-muted" role="status">
              {saved}
            </p>
          ) : null}
        </div>
      </ValueShell>
    );
  }

  const busy = state.phase === "saving";
  const correctionRequired = state.phase === "conflict" && schemaCardRequiresCorrection(definition);
  // Always the version the last read reported. In a conflict that read is the refresh that
  // `enterConflict` just completed, which is what makes re-aiming the command legitimate.
  const currentVersion = value?.version ?? 0;

  /*
   * Editing keeps the card's `dl > div > dt + dd` shape rather than breaking out of it. The host
   * renders every field into one description list, so a control that escaped the grouping would
   * make the whole list invalid — for a screen reader first, and for the accessibility gate the
   * job packet's e2e run applies second.
   */
  return (
    <div className="min-w-0">
      <dt>
        <label
          htmlFor={controlId}
          className="block text-sm font-semibold text-muted"
          data-testid={`schema-field-label-${definition.field_key}`}
        >
          {definition.label}
        </label>
      </dt>
      <dd className="mt-0">
        {state.phase === "conflict" ? (
          <div
            className="mt-2 rounded-lg border border-warning/40 bg-warning-soft px-3.5 py-3"
            role="alert"
            data-testid={`schema-field-conflict-${definition.field_key}`}
          >
            <p className="font-bold text-foreground">
              Someone else changed this while you were entering it.
            </p>
            <dl className="mt-2 space-y-1 text-sm leading-6">
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-semibold text-muted">On the card now</dt>
                <dd data-testid={`schema-field-conflict-current-${definition.field_key}`}>
                  {formatSchemaCardValue(definition, value, dateOptions)}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-semibold text-muted">What you entered</dt>
                <dd>{describeDraft(draft)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm leading-6 text-muted">
              {correctionRequired
                ? "This field is kept as evidence, so both values stay on the record. Say what you are correcting before you save."
                : "Saving keeps both entries in the record's history and makes yours the current one."}
            </p>
          </div>
        ) : null}

        <div className="mt-2">
          <FieldControl
            id={controlId}
            entry={entry}
            draft={draft}
            disabled={busy}
            invalid={Boolean(refusal)}
            describedBy={refusal ? `${controlId}-refusal` : undefined}
            onChange={setDraft}
          />
        </div>

        {correctionRequired && state.phase === "conflict" ? (
          <div className="mt-3">
            <label htmlFor={reasonId} className="block text-sm font-semibold text-muted">
              What are you correcting?
            </label>
            <Textarea
              id={reasonId}
              className="mt-1.5"
              value={state.reason}
              disabled={busy}
              onChange={(event) => setState({ phase: "conflict", reason: event.target.value })}
              placeholder="Measured again after the tear-off"
            />
          </div>
        ) : null}

        {refusal ? (
          <p
            id={`${controlId}-refusal`}
            className="mt-2 text-sm leading-6 font-semibold text-danger"
            role="alert"
          >
            {refusal}
          </p>
        ) : null}

        {!online && editability.queueable ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm leading-6 text-muted">
            <CloudUpload className="size-4 shrink-0" aria-hidden="true" />
            No signal. This saves on the phone and sends itself later.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="compact"
            busy={busy}
            disabled={correctionRequired && state.phase === "conflict" && !state.reason.trim()}
            data-testid={`schema-field-save-${definition.field_key}`}
            onClick={() =>
              void save(
                state.phase === "conflict"
                  ? {
                      expectedVersion: currentVersion,
                      ...(correctionRequired
                        ? {
                            basedOnValueRevisionId: value?.value_revision_id ?? null,
                            correctionReason: state.reason.trim(),
                          }
                        : {}),
                    }
                  : { expectedVersion: currentVersion },
              )
            }
          >
            {state.phase === "conflict"
              ? correctionRequired
                ? "Save correction"
                : "Replace"
              : "Save"}
          </Button>
          <Button type="button" size="compact" variant="ghost" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </dd>
    </div>
  );
}

/** The read presentation of one field, shared by every state that is not actively editing. */
function ValueShell({
  entry,
  dateOptions,
  empty,
  correctionNote,
  pending,
  children,
}: {
  entry: SchemaCardEntry;
  dateOptions: FieldDateOptions;
  empty: boolean;
  correctionNote: string | null;
  pending?: OutboxAction;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm font-semibold text-muted">{entry.definition.label}</dt>
      <dd className="mt-0.5">
        {/*
          The value keeps its own element so a test — and a reader — can tell the recorded value
          apart from everything the card says ABOUT it: a correction note, a queued entry, an edit
          affordance. Folding them into one node would make "what does this field hold" unanswerable.
        */}
        <p
          className={
            empty ? "text-base leading-6 text-muted" : "text-base leading-6 font-medium break-words"
          }
          data-testid={`schema-field-${entry.definition.field_key}`}
        >
          {formatSchemaCardValue(entry.definition, entry.value, dateOptions)}
        </p>
        {correctionNote ? (
          <p
            className="mt-1 text-sm leading-6 text-muted"
            data-testid={`schema-field-correction-${entry.definition.field_key}`}
          >
            {correctionNote}
          </p>
        ) : null}
        {pending ? <PendingNote entry={entry} pending={pending} /> : null}
        {children}
      </dd>
    </div>
  );
}

/**
 * What this device is still holding for this field.
 *
 * Deliberately not rendered as the field's value: a queued entry is not yet a fact on the server,
 * and showing it as one is how a crew member ends up believing the office can see something it
 * cannot. `needs_attention` is called out separately because the saved-work panel is where that
 * item gets resolved.
 */
function PendingNote({ entry, pending }: { entry: SchemaCardEntry; pending: OutboxAction }) {
  const stuck = pending.state === "needs_attention";
  const held = (pending.payload as { value?: unknown } | null)?.value;
  return (
    <p
      className={`mt-1 text-sm leading-6 ${stuck ? "font-semibold text-danger" : "text-muted"}`}
      role="status"
      data-testid={`schema-field-pending-${entry.definition.field_key}`}
    >
      {stuck
        ? "Waiting for office review: this entry could not be sent. Nothing was thrown away."
        : `Waiting to send: ${describeDraft(held as string | string[] | boolean)}`}
    </p>
  );
}

function FieldControl({
  id,
  entry,
  draft,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  entry: SchemaCardEntry;
  draft: string | string[] | boolean;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  onChange: (next: string | string[] | boolean) => void;
}) {
  const { definition } = entry;
  const testId = `schema-field-input-${definition.field_key}`;
  const options = configuredOptions(definition.validator_config);

  if (definition.field_type === "boolean") {
    return (
      <label className="flex min-h-12 items-center gap-3">
        <input
          id={id}
          type="checkbox"
          className="size-6 rounded border-border accent-[var(--accent)]"
          checked={draft === true}
          disabled={disabled}
          aria-describedby={describedBy}
          data-testid={testId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="text-base leading-6">Yes</span>
      </label>
    );
  }

  if (definition.field_type === "multiselect") {
    const held = Array.isArray(draft) ? draft : [];
    return (
      <fieldset className="space-y-2" aria-describedby={describedBy} data-testid={testId}>
        <legend className="sr-only">{definition.label}</legend>
        {options.map((option) => (
          <label key={option} className="flex min-h-12 items-center gap-3">
            <input
              type="checkbox"
              className="size-6 rounded border-border accent-[var(--accent)]"
              checked={held.includes(option)}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...held, option]
                    : held.filter((entryValue) => entryValue !== option),
                )
              }
            />
            <span className="text-base leading-6">{option}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (options.length > 0) {
    return (
      <Select
        id={id}
        field
        invalid={invalid}
        disabled={disabled}
        aria-describedby={describedBy}
        data-testid={testId}
        value={typeof draft === "string" ? draft : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not recorded</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }

  return (
    <Input
      id={id}
      type={inputType(definition.field_type)}
      inputMode={inputMode(definition.field_type)}
      step={
        definition.field_type === "money" || definition.field_type === "number" ? "any" : undefined
      }
      invalid={invalid}
      disabled={disabled}
      aria-describedby={describedBy}
      data-testid={testId}
      value={typeof draft === "string" ? draft : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * The option list is the administrator's, read off the field's own validator configuration. A
 * `select` field without one falls back to a free-text box rather than an empty dropdown, because
 * an administrator mid-configuration should not lock the crew out of the field.
 */
function configuredOptions(config: Record<string, unknown>): string[] {
  const options = config.options;
  if (!Array.isArray(options)) return [];
  return options.filter((option): option is string => typeof option === "string");
}

function inputType(fieldType: string): string {
  if (fieldType === "date") return "date";
  if (fieldType === "datetime") return "datetime-local";
  if (fieldType === "integer" || fieldType === "number" || fieldType === "money") return "number";
  return "text";
}

function inputMode(fieldType: string): "numeric" | "decimal" | undefined {
  if (fieldType === "integer") return "numeric";
  if (fieldType === "number" || fieldType === "money") return "decimal";
  return undefined;
}

function describeDraft(draft: string | string[] | boolean | undefined): string {
  if (draft === true) return "Yes";
  if (draft === false) return "No";
  if (Array.isArray(draft)) return draft.length > 0 ? draft.join(", ") : "Nothing";
  if (typeof draft === "number") return String(draft);
  return typeof draft === "string" && draft.trim() ? draft : "Nothing";
}
