import { roleLabel, type AppRole } from "../lib/roles";
import type { AccessConflict, AccessState } from "./admin-contracts";

// The derived parts of the access-conflict copy on Settings › People (SET-03 "Access conflict
// states", frozen build 7, with Track B's rulings for #13). The frozen sentences live in
// team-page.tsx; only what a person's one role and their access can say is composed here: what is
// different now, what a pending change does, and who made the other change. There is no pronoun
// field, so a person is "they"; a clause that would open on a pronoun opens on the first name.
// The Worker cannot name the device a change came from, so the viewer's own other change is
// always "somewhere else".

/** "Grace" for "Grace Obi". */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
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
  return role ?? "their access is the same as what you see here";
}

/**
 * {what the change does} for a pending role choice. `whose` opens the clause: the first name with
 * its possessive ("Grace’s") where the clause starts a sentence's point, "their" inside one.
 */
export function whatTheChangeDoes(whose: string, saved: AppRole, pending: AppRole): string {
  return `${whose} role changes from ${roleLabel(saved)} to ${roleLabel(pending)}`;
}

function actorName(conflict: AccessConflict | null): string | null {
  const actor = conflict?.changed_by;
  return actor && !actor.is_self_actor ? (actor.display_name ?? "Someone else") : null;
}

/** The conflict line: who changed `name`’s access and what is different now. */
export function conflictLine(
  name: string,
  conflict: AccessConflict | null,
  seen: AccessState,
): string {
  if (!conflict) return `${name}’s access changed somewhere else a moment ago.`;
  const what = whatIsDifferentNow(conflict.change.before ?? seen, conflict.change.after);
  const other = actorName(conflict);
  if (other) return `${other} changed ${name}’s access a moment ago: ${what}.`;
  return conflict.changed_by
    ? `You changed ${name}’s access somewhere else a moment ago: ${what}.`
    : `${name}’s access changed somewhere else a moment ago: ${what}.`;
}

/** Why a pending role change cannot apply: `name` was removed from the team meanwhile. */
export function cannotApplyLine(name: string, conflict: AccessConflict | null): string {
  const other = actorName(conflict);
  if (other)
    return `Your change cannot apply: ${other} removed ${name} from the team a moment ago.`;
  return conflict?.changed_by
    ? `Your change cannot apply: you removed ${name} from the team somewhere else a moment ago.`
    : `Your change cannot apply: ${name} was removed from the team a moment ago.`;
}

/** After a reload, on the role that was chosen elsewhere. */
export function chosenElsewhere(conflict: AccessConflict | null): string {
  const other = actorName(conflict);
  return other ? `Chosen by ${other} a moment ago` : "Chosen somewhere else a moment ago";
}
