// Signal text retention (AI-TEAM-CONTRACT.md "Signal text retention", migration 0207).
//
// The free text a person or a specialist wrote into a signal is kept for the run that answers it
// and then for SIGNAL_TEXT_RETENTION_DAYS (the owner's ruling, final). After that the daily cron
// redacts it in place, once: an inbound event loses its excerpt, form fields and service, a
// person's ask its question, a handoff its reason, and each gains `"redacted": true`. Ids, roles,
// the envelope, the channel, objects and the expected action stay. The row keeps its original
// content_sha256, so a receipt that cited the signal still names the hash of what was received;
// nothing hashes content_json again. A watch holds the Worker's own records and keeps them.
//
// Migration 0207 lets only this update past the append-only guard and reads the age on D1's own
// clock with the same ninety days, so this code cannot redact a younger signal. The statement reads
// D1's clock too: 'now' is stable within one statement, so the rows it picks and the guard agree.
// The inbound envelope itself is the business record (three years); its redaction is a later slice,
// while owner-verified erasure and source-bound proposal fields are handled separately by
// subject-erasure.ts and migration 0208. The cron retains its ninety-day floor.

import { changesOf, type AgentDb } from "./store.ts";

/** Days a signal's free text is kept after it was received; migration 0207 holds the same floor. */
export const SIGNAL_TEXT_RETENTION_DAYS = 90;
/** Signals redacted per run at most, oldest first; the rest wait for the next day's run. */
export const SIGNAL_REDACTION_BATCH = 500;

// The partial index of signals still holding their text (0207), named: a redacted signal leaves it,
// so the read never walks the ones already done. A plan that cannot use it fails to prepare.
const REDACT = `UPDATE agent_signals SET content_json = CASE kind
    WHEN 'event' THEN json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))
    WHEN 'owner_request' THEN json_set(json_remove(content_json, '$.question'), '$.redacted', json('true'))
    WHEN 'handoff' THEN json_set(json_remove(content_json, '$.reason'), '$.redacted', json('true'))
  END
  WHERE signal_seq IN (
    SELECT signal_seq FROM agent_signals INDEXED BY idx_agent_signals_unredacted
     WHERE tenant_id = ? AND kind IN ('event', 'owner_request', 'handoff') AND json_extract(content_json, '$.redacted') IS NULL
       AND received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND json_type(content_json) = 'object'
     ORDER BY received_at, signal_seq LIMIT ?)`;

/** AGENT_SIGNAL_REDACTION: "on" runs the daily redaction; anything else, blank included, is off. */
export function signalRedactionOn(raw: string | undefined): boolean {
  return raw?.trim() === "on";
}

/**
 * Redacts the text of the tenant's signals older than SIGNAL_TEXT_RETENTION_DAYS, oldest first and
 * at most SIGNAL_REDACTION_BATCH of them, and answers how many it redacted. A second run redacts
 * nothing it already did.
 */
export async function redactSignalText(db: AgentDb, tenantId: string): Promise<number> {
  const result = await db.prepare(REDACT).bind(tenantId, `-${SIGNAL_TEXT_RETENTION_DAYS} days`, SIGNAL_REDACTION_BATCH).run();
  return changesOf(result);
}
