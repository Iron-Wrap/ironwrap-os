import { roleLabel, type AppRole } from "../lib/roles";
import type { AccessConflict, AccessState } from "./admin-contracts";

// The derived parts of the access-conflict copy on Settings › People (SET-03 "Access conflict
// states", with Track B's rulings for #13). The design's own sentences live in team-page.tsx;
// only what a person's one role and their access can say is composed here: what is different
// now, what a pending change does, who made the other change and when. There is no pronoun
// field, so a person is "they"; a clause that would open on a pronoun opens on the first name.
// The Worker cannot name the device a change came from, so the viewer's own other change is
// always "somewhere else".

/** "Grace" for "Grace Obi". */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;

/**
 * When the other change was made, by Track B's time ladder: under a minute "a moment ago", under
 * an hour "{n} min ago", under a week "on {Weekday} at {hh:mm}" (the viewer's local time, 24-hour
 * clock), then "over a week ago". Never a calendar date. A time the Worker did not send, or one
 * ahead of this device's clock, reads "a moment ago".
 */
export function whenChanged(changedAt: string | null | undefined, now: number): string {
  const at = changedAt ? Date.parse(changedAt) : Number.NaN;
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return "a moment ago";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed >= WEEK) return "over a week ago";
  const date = new Date(at);
  const weekday = new Intl.DateTimeFormat("en-CA", { weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `on ${weekday} at ${time}`;
}

/** {what is different now}, after the conflict line's colon. */
export function whatIsDifferentNow(before: AccessState, after: AccessState): string {
  if (before.active && !after.active) return "they no longer have access";
  const role =
    before.role === after.role
      ? null
      : `their role is now ${roleLabel(after.role)}, not ${roleLabel(before.role)}`;
  if (!before.active && after.active) {
    return role ? `they have access again and ${role}` : "they have access again";
  }
  return role ?? "nothing you can see here changed";
}

/**
 * {what the change does} for a pending role choice. `whose` opens the clause: the first name with
 * its possessive ("Grace’s") where the clause starts a sentence's point, "their" inside one.
 */
export function whatTheChangeDoes(whose: string, saved: AppRole, pending: AppRole): string {
  return `${whose} role changes from ${roleLabel(saved)} to ${roleLabel(pending)}`;
}

/**
 * Who made the other change: the viewer, another named person, or nobody the Worker could name.
 * An unknown actor may be the viewer on another device, so the copy then says what happened in
 * the passive and names nobody (Track B's fallback for missing data).
 */
function actorOf(
  conflict: AccessConflict | null,
): { kind: "you" } | { kind: "other"; name: string } | { kind: "unknown" } {
  const actor = conflict?.changed_by;
  if (!actor) return { kind: "unknown" };
  if (actor.is_self_actor) return { kind: "you" };
  return actor.display_name ? { kind: "other", name: actor.display_name } : { kind: "unknown" };
}

/**
 * The conflict line: who changed `name`’s access, when, and what is different now. When the
 * Worker's answer cannot be read at all, the line only says the access was changed; the reload
 * shows the values.
 */
export function conflictLine(
  name: string,
  conflict: AccessConflict | null,
  seen: AccessState,
  now: number,
): string {
  const when = whenChanged(conflict?.changed_at, now);
  if (!conflict) return `${name}’s access was changed ${when}.`;
  const what = whatIsDifferentNow(conflict.change.before ?? seen, conflict.change.after);
  const actor = actorOf(conflict);
  if (actor.kind === "you") return `You changed ${name}’s access somewhere else ${when}: ${what}.`;
  if (actor.kind === "other") return `${actor.name} changed ${name}’s access ${when}: ${what}.`;
  return `${name}’s access was changed ${when}: ${what}.`;
}

/** Why a pending role change cannot apply: `name` was removed from the team meanwhile. */
export function cannotApplyLine(
  name: string,
  conflict: AccessConflict | null,
  now: number,
): string {
  const when = whenChanged(conflict?.changed_at, now);
  const actor = actorOf(conflict);
  if (actor.kind === "you") {
    return `Your change cannot apply: you removed ${name} from the team somewhere else ${when}.`;
  }
  if (actor.kind === "other") {
    return `Your change cannot apply: ${actor.name} removed ${name} from the team ${when}.`;
  }
  return `Your change cannot apply: ${name} was removed from the team ${when}.`;
}

/**
 * After a reload, what happened to a value changed elsewhere and when: "changed somewhere else
 * {time}" for the viewer's own other change, "changed by {Actor} {time}" for another person, and
 * "changed {time}" when the Worker could not say who. A role reads "{Role} · changed …" (frame 3);
 * the access chip carries it capitalised.
 */
export function changedElsewhere(conflict: AccessConflict | null, now: number): string {
  const when = whenChanged(conflict?.changed_at, now);
  const actor = actorOf(conflict);
  if (actor.kind === "you") return `changed somewhere else ${when}`;
  if (actor.kind === "other") return `changed by ${actor.name} ${when}`;
  return `changed ${when}`;
}

/** Beside a value this page showed before the other change: "{Value} · may be out of date". */
export const MAY_BE_OUT_OF_DATE = "may be out of date";

/** Under the values marked out of date (frames 2, 4, 6a and 6b). */
export const OUT_OF_DATE_NOTE =
  "Values marked “may be out of date” update when their access reloads.";

/** Under Remove on frames 1 and 3, after the "Remove {First} from the team:" lead. */
export const REMOVE_EXPLAINS =
  "signs them out everywhere and unpairs any crew phone they use. Giving them access back undoes it; a crew phone must then be paired again.";

/** Frame 4, after the reload's line: what the held remove will do. */
export const REMOVING_EXPLAINS =
  "Removing them signs them out everywhere and unpairs any crew phone they use.";

/**
 * In the "Give {First} access back:" line, after "the access they had ({Role})", only when removing
 * their access unpaired a crew phone (`crew_phone_unpaired`).
 */
export const PAIR_AGAIN = "a crew phone must be paired again";
