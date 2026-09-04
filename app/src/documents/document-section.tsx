import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileText, Lock } from "lucide-react";
import { useState } from "react";

import { useSession } from "../auth/session-context";
import { Card } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import type { FieldDateOptions } from "../field/field-formatting";
import { messageFor } from "../field/field-formatting";
import { cn } from "../lib/cn";
import { loadSchemaCard } from "../schema-forms/schema-card-api";
import { schemaCardQueryKey } from "../schema-forms/schema-card-contracts";
import { loadEntityDocuments } from "./document-api";
import { entityDocumentsQueryKey } from "./document-contracts";
import {
  documentSegments,
  readableDocuments,
  resolveDocuments,
  sortDocumentsForShelf,
  type ResolvedDocument,
  type ResolvedDocumentLine,
} from "./document-resolution";

/**
 * The documents a record carries, on the surface where the work happens.
 *
 * A materials list, a contract, an estimate: the stakeholder's requirement is that these are smart
 * forms auto-populated from the job, "reachable throughout the workflow" — not a static file in a
 * separate documents area and not a form anybody retypes. Nothing here knows what a materials list
 * IS; it renders whatever layout the administrator authored, filled from the reader's authorized
 * field values (IRO-242, ELEC-182).
 *
 * Read-only. Every value shown came from the record read, which is also the only place a value can
 * be corrected — a document is a view of the job, never a second copy of it.
 */
export function EntityDocumentsSection({
  entityType,
  entityId,
  dateOptions,
  headingId = "entity-documents-heading",
  title = "Documents",
}: {
  entityType: string;
  entityId: string | null;
  dateOptions: FieldDateOptions;
  headingId?: string;
  title?: string;
}) {
  const session = useSession();
  const enabled = Boolean(entityId);
  const documents = useQuery({
    queryKey: entityDocumentsQueryKey(
      session.tenant.id,
      session.user.id,
      entityType,
      entityId ?? "",
    ),
    enabled,
    queryFn: () => loadEntityDocuments(session, entityType, entityId!),
  });
  // Deliberately the schema card's own query key: on a job packet that already renders the card,
  // the two surfaces share one read instead of asking the phone for the same values twice.
  const card = useQuery({
    queryKey: schemaCardQueryKey(session.tenant.id, session.user.id, entityType, entityId ?? ""),
    enabled,
    queryFn: () => loadSchemaCard(session, entityType, entityId!),
  });

  if (!entityId) return null;
  if (documents.isPending || card.isPending)
    return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  if (documents.isError)
    return (
      <ErrorState message={messageFor(documents.error)} onRetry={() => void documents.refetch()} />
    );
  if (card.isError)
    return <ErrorState message={messageFor(card.error)} onRetry={() => void card.refetch()} />;

  const resolved = sortDocumentsForShelf(
    readableDocuments(
      resolveDocuments(documents.data.response.documents, card.data.response.fields, dateOptions),
    ),
  );
  // An account that has configured no document for this kind of record has no shelf to show, and a
  // phone screen is too small to spend on an empty one.
  if (resolved.length === 0) return null;

  const offline = documents.data.offline || card.data.offline;
  return (
    <section className="space-y-4" aria-labelledby={headingId} data-testid="entity-documents">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">Filled from this job</p>
        <h2 id={headingId} className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
          {title}
        </h2>
      </header>

      {/*
        Deliberately not the schema card's wording. Both sections render on the job packet and both
        can be offline at once; two identical status lines one above the other read as a stutter and
        leave the reader unsure which half is stale (they also collide in the e2e locators).
      */}
      {offline ? (
        <p
          className="text-sm leading-6 text-muted"
          role="status"
          data-testid="documents-offline-notice"
        >
          These documents are the copy saved on this device. Values may have changed since you were
          last online.
        </p>
      ) : null}

      <div className="space-y-3">
        {resolved.map((document, index) => (
          <DocumentDisclosure
            key={document.templateId}
            document={document}
            defaultOpen={index === 0}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One document, opened in place.
 *
 * The first one is open because on most accounts there is only one and a tap to see it would be a
 * tap for nothing; the rest are collapsed so a phone shows the shelf before it shows the paper.
 */
function DocumentDisclosure({
  document,
  defaultOpen,
}: {
  document: ResolvedDocument;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `document-panel-${document.templateId}`;
  const buttonId = `document-toggle-${document.templateId}`;
  return (
    <Card className="overflow-hidden">
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left font-bold tracking-[-0.01em] sm:px-5"
          data-testid={`document-toggle-${document.templateKey}`}
        >
          <FileText className="size-5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{document.label}</span>
          <ChevronDown
            className={cn("size-5 shrink-0 text-muted transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="border-t border-border px-4 py-4 sm:px-5"
        data-testid={`document-body-${document.templateKey}`}
      >
        <DocumentBody document={document} />
      </div>
    </Card>
  );
}

function DocumentBody({ document }: { document: ResolvedDocument }) {
  return (
    <div className="space-y-4">
      {document.withheldCount > 0 ? (
        <p className="text-sm leading-6 text-muted" data-testid="document-withheld-note">
          {document.withheldCount === 1
            ? "One line is not shared with your role."
            : `${document.withheldCount} lines are not shared with your role.`}
        </p>
      ) : null}
      {documentSegments(document).map((segment, index) => {
        if (segment.kind === "heading")
          return (
            <DocumentHeading key={`segment-${index}`} level={segment.level} text={segment.text} />
          );
        if (segment.kind === "text")
          return (
            <p key={`segment-${index}`} className="text-sm leading-6 text-muted">
              {segment.text}
            </p>
          );
        return (
          <dl key={`segment-${index}`} className="space-y-3">
            {segment.lines.map((line) => (
              <DocumentLine key={line.fieldId} line={line} />
            ))}
          </dl>
        );
      })}
    </div>
  );
}

/**
 * One bound line.
 *
 * A line the reader may not read and a line nobody has filled in are different facts and must not
 * look like the same gray nothing: someone scanning a materials list for what to order has to tell
 * "ask the office" from "you are not allowed to see this" without stopping to read each row
 * (designer verdict, ELEC-197). The withheld row carries a lock, a left edge and an italic
 * non-label, so the distinction survives a fast skim; the unfilled row stays plain muted text.
 */
function DocumentLine({ line }: { line: Extract<ResolvedDocumentLine, { kind: "field" }> }) {
  const withheld = line.state === "withheld";
  return (
    <div
      data-line-state={line.state}
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5",
        withheld && "border-l-2 border-border pl-3",
      )}
    >
      <dt className={withheld ? "text-sm text-muted italic" : "text-sm font-semibold text-muted"}>
        {/*
          No label arrived, because the definition never did. Naming the row "Withheld line" in the
          same weight as a real field label made it read as a field on the document rather than a
          statement about one, so it is set apart instead.
        */}
        {line.label ?? "Hidden line"}
      </dt>
      <dd
        className={cn(
          "flex min-w-0 items-baseline gap-1.5 text-base leading-6 break-words",
          line.state === "value" ? "font-medium" : "text-muted",
        )}
        data-testid={`document-line-${line.fieldKey ?? line.fieldId}`}
      >
        {withheld ? <Lock className="size-4 shrink-0 translate-y-0.5" aria-hidden="true" /> : null}
        <span className="min-w-0 break-words">{line.text}</span>
      </dd>
    </div>
  );
}

/**
 * The administrator's heading levels are relative to the document, not to the page: the section
 * already owns an h2 and each document an h3, so the deepest authored level renders as an h4 and
 * the page keeps a heading order a screen reader can walk.
 */
function DocumentHeading({ level, text }: { level: 1 | 2 | 3; text: string }) {
  const className =
    level === 1
      ? "pt-1 text-base font-bold tracking-[-0.01em]"
      : "pt-1 text-sm font-bold tracking-[-0.01em]";
  if (level === 1) return <h4 className={className}>{text}</h4>;
  if (level === 2) return <h5 className={className}>{text}</h5>;
  return <h6 className={className}>{text}</h6>;
}
