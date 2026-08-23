import type { SessionResponse } from "./session";

/**
 * Where a freshly signed-in session belongs.
 *
 * `/today` is the field run sheet and is guarded to the field role, so sending every role
 * there made the first screen after sign-in a "this work belongs to another role" refusal
 * for sales, production and accounting (ELEC-157). `/now` is the one landing page every
 * role's navigation carries, and it renders the run sheet itself for a field session — so
 * a paired phone still opens on its work, without an office role meeting a refusal it
 * cannot act on.
 *
 * An unauthenticated response resolves office-shaped on purpose: the field entry is only
 * ever reached by a device that proved a pairing, and guessing `/today` for an unknown
 * session would put the refusal back.
 */
export function landingPathFor(session: SessionResponse): "/now" | "/today" {
  return session.authenticated && session.user.role === "field" ? "/today" : "/now";
}
