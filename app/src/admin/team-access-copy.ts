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
 * {what the change does} for a pending role choice, in the pending and next-to-Save lines. `whose`
 * opens the clause: the first name with its possessive ("Grace’s"). Frame 5's give-back line says
 * it its own way ({@link giveBackThenSave}).
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

/**
 * Frame 5's disabled Save: it waits for their access, not for them to sign in again (Track B's
 * built-screen Z1, t04 and t05).
 */
export function saveAfterAccessBack(first: string): string {
  return `Save ${first}’s access · after their access is back`;
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
 * The crew-phone clause belongs to the role they end up with (Track B's ruling for #13): it shows
 * only when removing their access unpaired a crew phone (`crew_phone_unpaired`) and that role is
 * Crew. Only the field role pairs a phone, so a phone they had as Crew does not matter once they
 * get any other role. It ends on where to pair it; after Save, it says "must then be paired".
 */
function pairAgain(role: AppRole, crewPhoneUnpaired: boolean, afterSave = false): string {
  if (!crewPhoneUnpaired || role !== "field") return "";
  return `; a crew phone must ${afterSave ? "then " : ""}be paired again in Settings › Crew devices`;
}

/**
 * The line after the "Give {First} access back:" lead when no change is held: giving access back
 * returns the role they had at once, so the clause follows that role.
 */
export function giveBack(had: AppRole, crewPhoneUnpaired: boolean): string {
  return `it returns the access they had (${roleLabel(had)}) right away${pairAgain(had, crewPhoneUnpaired)}.`;
}

/**
 * Frame 5's line after the "Give {First} access back:" lead (the lead's ruling for #13): giving
 * access back returns it at once, and the held role change then needs only Save, not their next
 * sign-in. The crew-phone clause follows the save sentence, for the role after Save. "moves from" is
 * this line's alone; the other lines say "changes from".
 */
export function giveBackThenSave(
  had: AppRole,
  pending: AppRole,
  crewPhoneUnpaired: boolean,
): string {
  return `it returns the access they had (${roleLabel(had)}) right away. Then save to add your change: their role moves from ${roleLabel(had)} to ${roleLabel(pending)}${pairAgain(pending, crewPhoneUnpaired, true)}. You don’t need to wait for them to sign in.`;
}

/** Adding an address already on the list (or added by someone else a moment ago), Track B's line. */
export function alreadyOnTeam(email: string): string {
  return `${email} is already on your team, so nothing was added.`;
}

export const ALREADY_ON_TEAM_NEXT = "To change their access, use “See access” on their row.";
