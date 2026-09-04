import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import type { FieldDateOptions } from "../field/field-formatting";
import { messageFor } from "../field/field-formatting";
import { useOnlineStatus } from "../hooks/use-online-status";
import { roleCanAccess } from "../lib/roles";
import { subscribeOutboxChanges } from "../storage/outbox-store";
import { loadSchemaCard, pendingSchemaCardWrites } from "./schema-card-api";
import { schemaCardQueryKey } from "./schema-card-contracts";
import { SchemaCardValueEditor } from "./schema-card-editor";
import { applyControllingVisibility, groupSchemaCardEntries } from "./schema-card-presentation";

/**
 * The administrator-defined part of a record, rendered where the work happens.
 *
 * An administrator can already define a field in the owner configuration hub (IRO-245); without
 * this section nothing rendered it to the people who do the work, which made the whole capability a
 * configuration screen rather than a delivered feature (ELEC-181).
 *
 * Read AND write (ELEC-181, then ELEC-193). #200 shipped this read-only and said why: the record
 * read view published no way to tell which fields this caller could edit, and the two ways of
 * guessing — draw a control everywhere and let writes 403, or re-derive authority from role lists
 * the view deliberately withholds — were both wrong. The server now publishes a derived `writable`
 * per field (ELEC-192), so the edit affordance follows that one boolean and nothing else.
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
  const online = useOnlineStatus();
  const query = useQuery({
    queryKey: schemaCardQueryKey(session.tenant.id, session.user.id, entityType, entityId ?? ""),
    enabled: Boolean(entityId),
    queryFn: () => loadSchemaCard(session, entityType, entityId!),
    /*
     * React Query's default network mode PAUSES a fetch while the device is offline, and a paused
     * refetch never settles. Both reads on this card are answerable without a network — the card
     * falls back to the device cache, and the queued list is device state that never had one — so
     * pausing them would strand every caller precisely when the crew member is on a roof with no
     * signal, which is the case this surface exists for.
     */
    networkMode: "always",
  });
  /**
   * What this device is still holding for this record. Kept beside the card rather than inside it
   * because it is device state, not record state: the server has not seen these values yet, and a
   * card that rendered them as values would be telling the crew the office can see something it
   * cannot.
   */
  const pending = useQuery({
    queryKey: [
      ...schemaCardQueryKey(session.tenant.id, session.user.id, entityType, entityId ?? ""),
      "pending",
    ],
    enabled: Boolean(entityId),
    queryFn: () => pendingSchemaCardWrites(session, entityType, entityId!),
    networkMode: "always",
  });
  /*
   * The outbox advances on its own — a background flush, another tab, a reconnect — so the pending
   * list follows its notifications rather than a poll.
   *
   * A DROP in what this device is holding means one of those values reached the server, and the
   * record now says something this card does not. Re-reading only on the drop is what makes a
   * value entered on a roof appear as the field's value the moment signal comes back, without
   * spending a read on every intermediate queued/uploading notification.
   */
  const refetchPending = pending.refetch;
  const refetchCard = query.refetch;
  const heldCount = useRef(0);
  useEffect(
    () =>
      subscribeOutboxChanges(() => {
        void refetchPending().then((result) => {
          const held = result.data?.size ?? 0;
          if (held < heldCount.current) void refetchCard();
          heldCount.current = held;
        });
      }),
    [refetchCard, refetchPending],
  );
  // Keeps the count true across a reload that opened with values already queued, which the
  // notification path alone would never have observed rising.
  const heldNow = pending.data?.size;
  useEffect(() => {
    if (heldNow !== undefined) heldCount.current = heldNow;
  }, [heldNow]);

  // A record with no id on this surface has no card to read; stay silent rather than erroring.
  if (!entityId) return null;
  if (query.isPending) return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  /*
   * A read that fails with nothing in hand has nothing to show. A read that fails with a card
   * already in hand is a different situation entirely: replacing the card with a retry panel takes
   * away the fields the crew member is looking at AND whatever they were part-way through typing
   * into one. The last good copy stays, and the failure is said out loud above it.
   */
  const card = query.data;
  if (!card)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;

  const entries = applyControllingVisibility(card.response.fields);
  const groups = groupSchemaCardEntries(entries);
  const canConfigure = roleCanAccess(session.user.role, "ownerConfiguration");

  // Nothing configured and nothing to configure with: do not spend a phone screen on an empty box.
  if (groups.length === 0 && !canConfigure) return null;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">Configured for this account</p>
          <h2 id={headingId} className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
            {title}
          </h2>
        </div>
        {canConfigure ? <CustomizeCardLink /> : null}
      </header>

      {card.offline ? (
        <p
          className="text-sm leading-6 text-muted"
          role="status"
          data-testid="schema-card-offline-notice"
        >
          Showing the copy saved on this device. Values may have changed since you were last online.
        </p>
      ) : null}

      {/*
        Test id for the same reason #203 gave the offline notice one: the documents section below
        this card carries its own device-state copy, so an unscoped page-wide text match resolves
        to both.
      */}
      {query.isError && !card.offline ? (
        <p
          className="text-sm leading-6 font-semibold text-danger"
          role="status"
          data-testid="schema-card-refresh-failure"
        >
          These values could not be refreshed just now. Nothing you have entered was lost.
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
                  <SchemaCardValueEditor
                    key={entry.definition.field_id}
                    entry={entry}
                    entityType={entityType}
                    entityId={entityId}
                    dateOptions={dateOptions}
                    online={online}
                    pending={pending.data?.get(entry.definition.field_id)}
                    onWritten={async () => {
                      await query.refetch({ throwOnError: true });
                      await pending.refetch();
                    }}
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
