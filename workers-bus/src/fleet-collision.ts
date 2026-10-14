/**
 * Fleet collision lifecycle — distinct from IRO-44 worker safety occurrences.
 *
 * A collision is a vehicle/asset incident: damage, out-of-service, repair, and
 * return. It is not an injury, near-miss, hazard, environmental, or emergency
 * occurrence. Those stay on the safety spine.
 *
 * Records live as R2 JSON with conditional create and transition writes.
 * The object keys are the list authority; a shared mutable index can lose
 * concurrently reported collisions.
 */

import { SAFETY_OCCURRENCE_KINDS } from "./safety-lifecycle.ts";

export const FLEET_COLLISION_KIND = "vehicle_collision" as const;
export const FLEET_COLLISION_STATES = [
  "reported",
  "investigating",
  "repairing",
  "closed",
  "cancelled",
] as const;

export type FleetCollisionId = string & { readonly __brand: "FleetCollisionId" };
export type FleetCollisionState = (typeof FLEET_COLLISION_STATES)[number];
export type FleetCollisionKind = typeof FLEET_COLLISION_KIND;

export type FleetCollisionSeverity = "Minor" | "Major" | "Out of Service";

export interface FleetCollisionPhotoRef {
  attachment_id: string;
  file_name: string;
  content_type: string;
  sha256: string;
  r2_key: string;
}

export interface FleetCollisionRecord {
  collision_id: FleetCollisionId;
  tenant_id: string;
  fleet_asset_id: string;
  kind: FleetCollisionKind;
  state: FleetCollisionState;
  severity: FleetCollisionSeverity;
  occurred_at: string;
  reported_by: string;
  description: string;
  photo_evidence: FleetCollisionPhotoRef[];
  telematics_reference: string | null;
  created_at: string;
  updated_at: string;
}

export const FLEET_COLLISION_TRANSITIONS = {
  reported: ["investigating", "cancelled"],
  investigating: ["repairing", "cancelled"],
  repairing: ["closed"],
  closed: [],
  cancelled: [],
} as const satisfies Record<FleetCollisionState, readonly FleetCollisionState[]>;

export function isFleetCollisionId(value: string): value is FleetCollisionId {
  return /^fc_[A-Za-z0-9._:-]{8,60}$/.test(value);
}

export function parseFleetCollisionId(value: string): FleetCollisionId | null {
  return isFleetCollisionId(value) ? value : null;
}

export function fleetCollisionIsSafetyOccurrence(): boolean {
  return SAFETY_OCCURRENCE_KINDS.some((kind) => String(kind) === FLEET_COLLISION_KIND);
}

export function canTransitionFleetCollision(
  from: FleetCollisionState,
  to: FleetCollisionState,
): boolean {
  const allowed: readonly FleetCollisionState[] = FLEET_COLLISION_TRANSITIONS[from];
  return allowed.includes(to);
}

export function collisionRecordKey(scopeDigest: string, collisionId: FleetCollisionId): string {
  return `fleet/v1/${scopeDigest}/collision/${collisionId}/record.json`;
}

export function collisionRecordPrefix(scopeDigest: string): string {
  return `fleet/v1/${scopeDigest}/collision/`;
}

export function assertCollisionNotTelematicsAuthorized(
  performedBy: string | null,
  telematicsReference: string | null,
): void {
  if (!performedBy?.trim()) {
    throw new Error("fleet_collision_physical_reporter_required");
  }
  if (telematicsReference && !performedBy.trim()) {
    throw new Error("telematics_cannot_authorize_collision");
  }
}
