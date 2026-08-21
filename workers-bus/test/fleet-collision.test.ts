import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCollisionNotTelematicsAuthorized,
  canTransitionFleetCollision,
  FLEET_COLLISION_KIND,
  FLEET_COLLISION_TRANSITIONS,
  fleetCollisionIsSafetyOccurrence,
  parseFleetCollisionId,
} from "../src/fleet-collision.ts";
import { SAFETY_OCCURRENCE_KINDS } from "../src/safety-lifecycle.ts";

test("a fleet collision is not an IRO-44 safety occurrence", () => {
  assert.equal(fleetCollisionIsSafetyOccurrence(), false);
  assert.equal(
    SAFETY_OCCURRENCE_KINDS.some((kind) => String(kind) === FLEET_COLLISION_KIND),
    false,
  );
  assert.deepEqual([...SAFETY_OCCURRENCE_KINDS], [
    "injury",
    "near_miss",
    "hazard",
    "environmental",
    "emergency",
  ]);
});

test("collision ids are branded and refuse a safety or job lookalike", () => {
  assert.equal(parseFleetCollisionId("fc_device-fleet-0001"), "fc_device-fleet-0001");
  assert.equal(parseFleetCollisionId("injury"), null);
  assert.equal(parseFleetCollisionId("ow_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
});

test("the collision lifecycle cannot skip investigation or reopen a closure", () => {
  assert.equal(canTransitionFleetCollision("reported", "investigating"), true);
  assert.equal(canTransitionFleetCollision("reported", "closed"), false);
  assert.equal(canTransitionFleetCollision("investigating", "repairing"), true);
  assert.equal(canTransitionFleetCollision("repairing", "closed"), true);
  assert.equal(canTransitionFleetCollision("closed", "reported"), false);
  assert.equal(canTransitionFleetCollision("cancelled", "investigating"), false);
  assert.deepEqual(FLEET_COLLISION_TRANSITIONS.closed, []);
});

test("telematics cannot authorize a collision without a physical reporter", () => {
  assert.doesNotThrow(() =>
    assertCollisionNotTelematicsAuthorized("driver@example.invalid", "samsara:trip-9"),
  );
  assert.throws(
    () => assertCollisionNotTelematicsAuthorized(null, "samsara:trip-9"),
    /fleet_collision_physical_reporter_required/,
  );
  assert.throws(
    () => assertCollisionNotTelematicsAuthorized("   ", null),
    /fleet_collision_physical_reporter_required/,
  );
});
