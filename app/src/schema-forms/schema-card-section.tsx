import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import type { FieldDateOptions } from "../field/field-formatting";
import { messageFor } from "../field/field-formatting";
import { roleCanAccess } from "../lib/roles";
import { loadSchemaCard } from "./schema-card-api";
import { schemaCardQueryKey, type SchemaCardEntry } from "./schema-card-contracts";
import {
  applyControllingVisibility,
  formatSchemaCardValue,
  groupSchemaCardEntries,
  schemaValueIsEmpty,
} from "./schema-card-presentation";

/**
 * The administrator-defined part of a record, rendered where the work happens.
 *
 * An administrator can already define a field in the owner configuration hub (IRO-245); without
 * this section nothing rendered it to the people who do the work, which made the whole capability a
 * configuration screen rather than a delivered feature (ELEC-181).
 *
 * Read-only by design. The record write route enforces write authority server-side, but the record
 * READ view (`recordFieldView`) publishes no `write_roles`, so a client cannot tell which fields
 * this role may edit without guessing — and guessing would either offer an edit that 403s or
 * re-implement an authority rule in the client. Editing waits on the server publishing writability;
 * see the note on IRO-242.
 */
export function SchemaCardSection({
  entityType,
  entityId,
  dateOptions,
  headingId = "schema-card-heading",
  title = "Configured fields",
}: {
  entityType: string;
  entityId: string | null;
  dateOptions: FieldDateOptions;
  headingId?: string;
  /**
   * Named by the host surface. The default stays deliberately generic: the job packet already
   * carries its own "Job details" section, and two identical headings on one page is a page
   * nobody can navigate — by heading, by screen reader, or by eye.
   */
  title?: string;
}) {
  const session = useSession();
  const query = useQuery({
    queryKey: schemaCardQueryKey(session.tenant.id, session.user.id, entityType, entityId ?? ""),
    enabled: Boolean(entityId),
    queryFn: () => loadSchemaCard(session, entityType, entityId!),
  });

  // A record with no id on this surface has no card to read; stay silent rather than erroring.
  if (!entityId) return null;
  if (query.isPending) return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;

  const entries = applyControllingVisibility(query.data.response.fields);
  const groups = groupSchemaCardEntries(entries);
  const canConfigure = roleCanAccess(session.user.role, "ownerConfiguration");

  // Nothing configured and nothing to configure with: do not spend a phone screen on an empty box.
  if (groups.length === 0 && !canConfigure) return null;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">Configured for this account</p>
          <h2 id={headingId} className="mt-1 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
            {title}
          </h2>
        </div>
        {canConfigure ? <CustomizeCardLink /> : null}
      </header>

      {query.data.offline ? (
        <p
          className="text-sm leading-6 text-muted"
          role="status"
          data-testid="schema-card-offline-notice"
        >
          Showing the copy saved on this device. Values may have changed since you were last online.
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="text-sm leading-6 text-muted">
          No fields are configured for this record yet.
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key || "__default"} className="space-y-3">
              {/*
                A group heading only earns its space when the card actually holds more than one
                service type's fields; with a single group the card heading already said it.
              */}
              {groups.length > 1 ? (
                <h3 className="text-base font-bold tracking-[-0.01em]">{group.label}</h3>
              ) : null}
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                {group.entries.map((entry) => (
                  <SchemaCardField
                    key={entry.definition.field_id}
                    entry={entry}
                    dateOptions={dateOptions}
                  />
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function SchemaCardField({
  entry,
  dateOptions,
}: {
  entry: SchemaCardEntry;
  dateOptions: FieldDateOptions;
}) {
  const empty = schemaValueIsEmpty(entry.value);
  return (
    <div className="min-w-0">
      <dt className="text-sm font-semibold text-muted">{entry.definition.label}</dt>
      <dd
        className={
          empty
            ? "mt-0.5 text-base leading-6 text-muted"
            : "mt-0.5 text-base leading-6 font-medium break-words"
        }
        data-testid={`schema-field-${entry.definition.field_key}`}
      >
        {formatSchemaCardValue(entry.definition, entry.value, dateOptions)}
      </dd>
    </div>
  );
}

/**
 * The on-card way into configuration.
 *
 * The stakeholder found the customization panel by himself mid-demo and the team read that as the
 * signal it was: configuration should be reachable from the thing being configured, not only from
 * a settings hub several taps away. This routes into the existing owner configuration page — it is
 * an entry point, not a second customizer.
 *
 * Owner-only, matching `roleCanAccess(role, "ownerConfiguration")` and the server's
 * `schema_configuration_forbidden` on every `/api/v1/admin/schema-fields` route. The link is a
 * navigation affordance over an already-guarded route, never the guard itself.
 */
export function CustomizeCardLink() {
  return (
    <Button asChild variant="outline" size="compact">
      <Link to="/settings/configuration/fields">
        <SlidersHorizontal aria-hidden="true" />
        Customize fields
      </Link>
    </Button>
  );
}
