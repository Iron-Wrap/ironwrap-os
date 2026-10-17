// Builds history cases from JobNimbus and GoHighLevel exports for the specialists whose ground truth
// they carry.
// Each case is a point-in-time snapshot: only rows created at or before the decision time, times as
// ISO 8601 offsets from it, current-state fields never copied, every identifier in the whole export
// tokenised and scrubbed from free text, and the outcome kept apart in `truths`. Text that cannot be
// cleaned is dropped and counted; any other field that still fails the guard stops the build.
// Nothing here reads output/ or writes anywhere: the runner passes parsed rows in and stores the
// result under output/evals/history.

import { buildVocabulary, createGuard, createScrubber, normaliseText, placesPattern, pseudonymizeRecord, safePlaces } from "./privacy.mjs";
import { BASE_WORDS } from "./privacy-words.mjs";

const DAY = 86400;
const ALBERTA = "America/Edmonton";
const PROVINCES = new Set(["AB", "BC", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL", "YT", "NT", "NU"]);

/** "-P3DT4H" style offset of `at` (unix seconds) from `decisionAt`. */
export function relative(at, decisionAt) {
  let seconds = Math.round(at - decisionAt);
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(seconds);
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const time = hours || minutes ? `T${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}` : "";
  return days || time ? `${sign}P${days ? `${days}D` : ""}${time}` : "PT0M";
}

const lower = (value) => normaliseText(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const linkedIds = (row) => (row.related ?? []).map((link) => link?.id).filter(Boolean);

function exportTime(exportedAt) {
  if (typeof exportedAt !== "number" || !Number.isFinite(exportedAt) || exportedAt < 1e9 || exportedAt > 1e10) {
    throw new Error("exportedAt must be the export time in unix seconds");
  }
  return exportedAt;
}

// Collects the whole export's identifiers, so free text on any record is scrubbed of every person
// it could name, and compiles the scrubber and the guard once over them. Street lines and postal
// codes join the dictionary as addresses; the vocabulary of ordinary words comes from the same
// export's free text.
function createDictionary(privacy, pseudonymizer) {
  const known = [];
  const add = (kind, value) => {
    if (value === undefined || value === null || typeof value === "object" || String(value).trim() === "") return;
    known.push({ kind, value: String(value), token: pseudonymizer.token(kind, value) });
  };
  const fields = (row, block) => {
    for (const [field, kind] of Object.entries(block.identifiers)) {
      const value = field.split(".").reduce((node, part) => node?.[part], row);
      (Array.isArray(value) ? value : [value]).forEach((item) => add(kind, item));
    }
    // An address line has a number and a word; a country or a geo object is not one.
    for (const field of block.address) if (typeof row[field] === "string" && /\d/.test(row[field]) && /\p{L}{2}/u.test(row[field])) add("address", row[field]);
  };
  // Free text keeps only the places no export name shares a word with; a case's location still
  // uses the full list.
  const compile = (texts) => {
    const names = known.filter((entry) => entry.kind === "person" || entry.kind === "company").map((entry) => entry.value);
    const places = placesPattern(safePlaces(privacy.municipalities, names));
    const vocabulary = buildVocabulary(texts, { names, minRecords: privacy.vocabulary_min_records });
    return { places, scrub: createScrubber(known, { places, vocabulary }), guard: createGuard(pseudonymizer.originals(), places, privacy.municipalities) };
  };
  return { add, fields, compile };
}

const textsOf = (rows, block) => rows.flatMap((row) => block.free_text.map((field) => row[field]));

function dictionary({ contacts = [], jobs = [], activities = [] }, privacy, pseudonymizer) {
  const { add, fields, compile } = createDictionary(privacy, pseudonymizer);
  for (const contact of contacts) fields(contact, privacy.contact);
  for (const job of jobs) {
    fields(job, privacy.job);
    for (const link of [...(job.related ?? []), job.primary].filter(Boolean)) add("person", link.name);
  }
  for (const activity of activities) {
    fields(activity, privacy.activity);
    for (const link of activity.related ?? []) add("person", link?.name);
  }
  return compile([...textsOf(contacts, privacy.contact), ...textsOf(jobs, privacy.job), ...textsOf(activities, privacy.activity)]);
}

// Text that reports an outcome: dropped wherever it could have been written after the decision.
const OUTCOME = /\b(?:took|finish(?:ed)?|complete[ds]?|done|wrapped|invoiced|paid|signed|sold|won|lost|cancell?ed|closed|update[ds]?|final)\b/i;

function context(exportRows, spec, pseudonymizer) {
  const { scrub, guard, places } = dictionary(exportRows, spec.privacy, pseudonymizer);
  const municipalities = new Map(spec.privacy.municipalities.map((name) => [lower(name), name]));
  // Municipality from the fixed list (anything else is "other"), province from its code list.
  const location = (row) => ({
    municipality: row.city ? municipalities.get(lower(row.city)) ?? "other" : null,
    province: PROVINCES.has(String(row.state_text ?? "").trim().toUpperCase()) ? String(row.state_text).trim().toUpperCase() : null,
  });
  const byLink = new Map();
  for (const activity of exportRows.activities ?? []) {
    for (const id of linkedIds(activity)) {
      if (!byLink.has(id)) byLink.set(id, []);
      byLink.get(id).push(activity);
    }
  }
  const options = { scrub, places, guard };
  const clean = (row, block, generalise = () => null) => pseudonymizeRecord(row, block, pseudonymizer, generalise, options);
  return { guard, location, byLink, clean };
}

/** Source as one of the spec's categories, matched on whole words; the raw value never reaches a case. */
function sourceCategory(contact, categories) {
  const raw = lower(contact.source_name || (contact.tags ?? []).find((tag) => String(tag).startsWith("source:"))?.slice(7) || "");
  if (!raw) return null;
  const has = (word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(raw);
  for (const [category, words] of Object.entries(categories)) if (words.some(has)) return category;
  return "other";
}

function statusOf(note, pattern) {
  const match = pattern.exec(lower(note).replace(/["'“”]/g, ""));
  return match ? lower(match[1]).replace(/[.]$/, "") : null;
}

function finish(cases, guard) {
  for (const entry of cases) {
    const violations = guard(JSON.stringify(entry));
    if (violations.length > 0) throw new Error(`history case ${entry.id} fails the privacy guard: ${violations.map((v) => `${v.kind} (${v.reason})`).join(", ")}`);
  }
}

/**
 * Lead concierge: one case per contact that is a lead, decided at the end of its intake window.
 * The snapshot holds the source category, generalised location, the description when it was last
 * written before the decision, and intake notes; the truth is whether a related job reached a won
 * status within the conversion horizon, and how many days that took.
 */
export function buildLeadCases(exportRows, spec, pseudonymizer) {
  const { contacts, jobs, activities } = exportRows;
  const exportedAt = exportTime(exportRows.exportedAt);
  const { guard, location, byLink, clean } = context(exportRows, spec, pseudonymizer);
  const won = new Set(spec.won_statuses.map(lower));
  const excluded = new Set(spec.excluded_record_types.map(lower));
  const pattern = new RegExp(spec.status_change_pattern, "i");
  const counts = { contacts: contacts.length, without_date: 0, excluded_type: 0, existing_customer: 0, too_recent: 0, kept_text: 0, dropped_text: 0, unparsed_status_changes: 0 };
  const jobsOf = new Map();
  for (const row of jobs) {
    for (const id of linkedIds(row)) {
      if (!jobsOf.has(id)) jobsOf.set(id, []);
      jobsOf.get(id).push(row);
    }
  }
  const cases = [];
  const truths = [];
  for (const contact of contacts) {
    if (!(contact.date_created > 0)) {
      counts.without_date += 1;
      continue;
    }
    if (excluded.has(lower(contact.record_type_name))) {
      counts.excluded_type += 1;
      continue;
    }
    const created = contact.date_created;
    const contactJobs = jobsOf.get(contact.jnid) ?? [];
    if (contactJobs.some((row) => row.date_created < created)) {
      counts.existing_customer += 1;
      continue;
    }
    if (exportedAt - created < spec.min_outcome_age_days * DAY) {
      counts.too_recent += 1;
      continue;
    }
    const at = created + spec.intake_window_minutes * 60;
    // The description is current state: it counts only when it was last written by the decision.
    const described = contact.date_updated > 0 && contact.date_updated <= at ? contact : { ...contact, description: null };
    const { record, dropped, kept } = clean(described, spec.privacy.contact, location);
    counts.dropped_text += dropped;
    counts.kept_text += kept;
    const notes = (byLink.get(contact.jnid) ?? [])
      .filter((row) => !row.is_status_change && row.date_created >= created && row.date_created <= at)
      .map((row) => {
        const note = clean(row, spec.privacy.activity);
        counts.dropped_text += note.dropped;
        counts.kept_text += note.kept;
        return note.record.note ? { at: relative(row.date_created, at), note: note.record.note } : null;
      })
      .filter(Boolean);
    const source = sourceCategory(contact, spec.source_categories);
    const id = `history.lead_concierge.${record.jnid}`;
    cases.push({
      id,
      specialist_id: "lead_concierge",
      signal: { kind: "watch", source: "history", watch_id: "new_inbound", at: "PT0M", content: { text: record.description || `New inquiry (source: ${source ?? "unknown"}).` } },
      facts: [
        {
          fact_id: `lead:${record.jnid}`,
          kind: "lead",
          version: 1,
          trust: "untrusted_text",
          observed_at: relative(created, at),
          data: { lead_id: record.jnid, source, location: record.location, description: record.description ?? null, intake_notes: notes },
        },
      ],
    });
    const changes = contactJobs.flatMap((row) =>
      (byLink.get(row.jnid) ?? [])
        .filter((activity) => activity.is_status_change)
        .map((activity) => {
          const status = statusOf(activity.note, pattern);
          if (!status) counts.unparsed_status_changes += 1;
          return { at: activity.date_created, status };
        }),
    );
    const horizon = created + spec.conversion_horizon_days * DAY;
    const first = changes.filter((change) => change.status && won.has(change.status) && change.at >= created && change.at <= horizon).sort((a, b) => a.at - b.at)[0];
    truths.push({ case_id: id, converted: Boolean(first), days_to_convert: first ? (first.at - created) / DAY : null });
  }
  finish(cases, guard);
  return { cases, truths, counts };
}

const seconds = (iso) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
};

/**
 * Lead concierge from GoHighLevel: one case per opportunity, decided at the end of its intake
 * window. GHL keeps only the current status and the time of the last status change, so the truth
 * is: won (converted, days to the last status change), lost or abandoned (not converted), and open
 * past the conversion horizon (not converted); open within it is too recent. Custom fields carry
 * current state without timestamps, so only those the spec lists as intake fields are copied, as
 * scrubbed text, and a value that reports an outcome is dropped. Opportunity names, values, stages,
 * tags, files, and contact details never are. `won_after_horizon` and `open_past_horizon` count the
 * labels the horizon decides, so the horizon's effect can be read.
 */
export function buildGhlLeadCases({ opportunities, contacts = [], exportedAt }, spec, pseudonymizer) {
  const now = exportTime(exportedAt);
  const { add, fields, compile } = createDictionary(spec.privacy, pseudonymizer);
  const intake = new Set(spec.intake_custom_fields);
  const intakeValues = (opportunity) =>
    (Array.isArray(opportunity.customFields) ? opportunity.customFields : [])
      .filter((field) => intake.has(field?.id) && typeof field.fieldValueString === "string" && field.fieldValueString.trim())
      .map((field) => field.fieldValueString);
  for (const contact of contacts) fields(contact, spec.privacy.ghl_contact);
  for (const opportunity of opportunities) {
    fields(opportunity, spec.privacy.ghl_opportunity);
    // The opportunity name usually carries the contact's name; parts made only of listed words
    // ("Metal Roof") are not names.
    for (const part of String(opportunity.name ?? "").split(/\s+[-|:/]\s+|[()]/)) {
      if ((normaliseText(part).toLowerCase().match(/\p{L}+/gu) ?? []).some((word) => !BASE_WORDS.has(word))) add("person", part.trim());
    }
  }
  const { scrub, guard } = compile(opportunities.flatMap(intakeValues));
  const municipalities = new Map(spec.privacy.municipalities.map((name) => [lower(name), name]));
  const byContact = new Map(contacts.map((contact) => [contact.id, contact]));
  const counts = { opportunities: opportunities.length, without_date: 0, too_recent: 0, won_after_horizon: 0, open_past_horizon: 0, outcome_text: 0, kept_text: 0, dropped_text: 0 };
  const cases = [];
  const truths = [];
  for (const opportunity of opportunities) {
    const created = seconds(opportunity.createdAt);
    if (created === null) {
      counts.without_date += 1;
      continue;
    }
    const status = lower(opportunity.status);
    const horizon = created + spec.conversion_horizon_days * DAY;
    if (status === "open" && now < horizon) {
      counts.too_recent += 1;
      continue;
    }
    const at = created + spec.intake_window_minutes * 60;
    const contact = byContact.get(opportunity.contactId) ?? {};
    const notes = intakeValues(opportunity)
      .map((value) => {
        if (OUTCOME.test(normaliseText(value))) {
          counts.outcome_text += 1;
          return null;
        }
        const scrubbed = scrub(value);
        if (scrubbed.reliable && guard(scrubbed.text).length === 0) {
          counts.kept_text += 1;
          return scrubbed.text;
        }
        counts.dropped_text += 1;
        return null;
      })
      .filter(Boolean);
    const source = sourceCategory({ source_name: opportunity.source || contact.source || opportunity.attributions?.[0]?.utmSessionSource }, spec.source_categories);
    const leadId = pseudonymizer.token("contact", opportunity.id);
    const id = `history.lead_concierge.${leadId}`;
    cases.push({
      id,
      specialist_id: "lead_concierge",
      signal: { kind: "watch", source: "history", watch_id: "new_inbound", at: "PT0M", content: { text: notes[0] ?? `New inquiry (source: ${source ?? "unknown"}).` } },
      facts: [
        {
          fact_id: `lead:${leadId}`,
          kind: "lead",
          version: 1,
          trust: "untrusted_text",
          observed_at: relative(created, at),
          data: {
            lead_id: leadId,
            source,
            location: {
              municipality: contact.city ? municipalities.get(lower(contact.city)) ?? "other" : null,
              province: PROVINCES.has(String(contact.state ?? "").trim().toUpperCase()) ? String(contact.state).trim().toUpperCase() : null,
            },
            intake_notes: notes,
          },
        },
      ],
    });
    const changed = seconds(opportunity.lastStatusChangeAt);
    const won = status === "won" && changed !== null && changed <= horizon;
    if (status === "won" && !won) counts.won_after_horizon += 1;
    if (status === "open") counts.open_past_horizon += 1;
    truths.push({ case_id: id, converted: won, days_to_convert: won ? Math.max(0, changed - created) / DAY : null });
  }
  finish(cases, guard);
  return { cases, truths, counts };
}

const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA, year: "numeric", month: "2-digit", day: "2-digit" });
// A time at exactly UTC midnight is a stored date, not a moment, so it keeps its own day.
const localDay = (at) => (at % DAY === 0 ? at / DAY : Date.parse(`${LOCAL_DATE.format(at * 1000)}T00:00:00Z`) / (DAY * 1000));

/**
 * Working days from the first to the last scheduled day, both included: Monday to Friday by Alberta
 * dates (statutory holidays count as working days). A job scheduled only on a weekend counts its
 * own days.
 */
export function workingDays(start, end) {
  let weekdays = 0;
  let all = 0;
  for (let day = localDay(start); day <= localDay(end); day += 1) {
    all += 1;
    const weekday = new Date(day * DAY * 1000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) weekdays += 1;
  }
  return weekdays || all;
}

/**
 * Scheduler: one case per finished job whose dates were entered before it started, decided
 * `decision_lead_days` before the start. The truth is `workingDays` from start to end, the unit of
 * `planned_days`; JobNimbus start and end are scheduled dates, so this measures planning, not a
 * crew time sheet. The scope is the job description, which carries no edit history: when the job
 * was updated after the decision, a description that reports an outcome is left out.
 */
export function buildDurationCases(exportRows, spec, pseudonymizer) {
  const { jobs } = exportRows;
  const exportedAt = exportTime(exportRows.exportedAt);
  const { guard, location, byLink, clean } = context(exportRows, spec, pseudonymizer);
  const finished = new Set(spec.completed_statuses.map(lower));
  const counts = { jobs: jobs.length, without_dates: 0, not_finished: 0, entered_late: 0, outcome_text: 0, kept_text: 0, dropped_text: 0 };
  const cases = [];
  const truths = [];
  for (const job of jobs) {
    if (!(job.date_start > 0 && job.date_end >= job.date_start)) {
      counts.without_dates += 1;
      continue;
    }
    if (job.date_end > exportedAt || !finished.has(lower(job.status_name))) {
      counts.not_finished += 1;
      continue;
    }
    if (!(job.date_created > 0) || job.date_created >= job.date_start - DAY) {
      counts.entered_late += 1;
      continue;
    }
    const at = Math.max(job.date_created, job.date_start - spec.decision_lead_days * DAY);
    const reports = !(job.date_updated > 0 && job.date_updated <= at) && typeof job.description === "string" && OUTCOME.test(normaliseText(job.description));
    if (reports) counts.outcome_text += 1;
    const { record, dropped, kept } = clean(reports ? { ...job, description: null } : job, spec.privacy.job, location);
    counts.dropped_text += dropped;
    counts.kept_text += kept;
    const notes = (byLink.get(job.jnid) ?? [])
      .filter((row) => !row.is_status_change && row.date_created <= at)
      .map((row) => {
        const note = clean(row, spec.privacy.activity);
        counts.dropped_text += note.dropped;
        counts.kept_text += note.kept;
        return note.record.note ? { at: relative(row.date_created, at), note: note.record.note } : null;
      })
      .filter(Boolean);
    const id = `history.scheduler_dispatcher.${record.jnid}`;
    cases.push({
      id,
      specialist_id: "scheduler_dispatcher",
      signal: { kind: "handoff", source: "history", at: "PT0M", content: { text: `Draft the schedule for job ${record.jnid}, starting ${relative(job.date_start, at)} from now.` } },
      facts: [
        {
          fact_id: `job:${record.jnid}`,
          kind: "job",
          version: 1,
          trust: "owned",
          observed_at: relative(job.date_created, at),
          data: { job_id: record.jnid, job_type: job.record_type_name ? lower(job.record_type_name) : null, scope: record.description ?? null, location: record.location, starts_in: relative(job.date_start, at), notes },
        },
      ],
    });
    truths.push({ case_id: id, actual_days: workingDays(job.date_start, job.date_end) });
  }
  finish(cases, guard);
  return { cases, truths, counts };
}

/**
 * Deterministic sample of at most `size` cases. With `stratify`, half come from cases whose truth
 * satisfies it and half from the rest (fewer when a class runs out), in case-id order; ids are
 * tokens, so the order is unrelated to the records.
 */
export function sampleCases({ cases, truths }, size, stratify = null) {
  const byId = new Map(truths.map((truth) => [truth.case_id, truth]));
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const picked = stratify
    ? [...ordered.filter((entry) => stratify(byId.get(entry.id))).slice(0, Math.ceil(size / 2)), ...ordered.filter((entry) => !stratify(byId.get(entry.id))).slice(0, Math.floor(size / 2))]
    : ordered.slice(0, size);
  const ids = new Set(picked.map((entry) => entry.id));
  return { cases: picked, truths: truths.filter((truth) => ids.has(truth.case_id)) };
}

// What a run proposed, reduced to the fields the history metrics compare.
export function leadOutcome(toolCalls, spec) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const find = (actionId) => calls.find((call) => call?.action_id === actionId);
  if (find("inbound.quarantine") || find("suppression.apply")) return { decision: "spam" };
  const close = find("inquiry.close");
  if (close && spec.disqualify_reasons.includes(close.args?.reason_code)) return { decision: "disqualified" };
  const triage = find("inquiry.record_triage");
  if (triage?.args?.lifecycle_status === "qualified") return { decision: "qualified" };
  if (triage?.args?.lifecycle_status === "triaged") return { decision: "nurture" };
  return { abstained: true };
}

export function durationOutcome(toolCalls) {
  const draft = (Array.isArray(toolCalls) ? toolCalls : []).find((call) => call?.action_id === "schedule.draft");
  const days = Number(draft?.args?.planned_days);
  return Number.isFinite(days) && days > 0 ? { predicted_days: days } : { abstained: true };
}
