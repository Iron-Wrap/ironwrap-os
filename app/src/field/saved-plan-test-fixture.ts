import { fetchSession, type AuthenticatedSession } from "../auth/session";
import type { JobResponse } from "./field-contracts";
const stamp = new Date(0).toISOString();

/** A synthetic HTTP reply goes through the production auth parser/observer/snapshot writer. */
export async function verifiedSavedPlanSessionFixture(
  overrides: Partial<AuthenticatedSession> = {},
): Promise<AuthenticatedSession> {
  const raw = { ...savedPlanSessionFixture(), ...overrides };
  const session = await fetchSession(async () => Response.json(raw));
  if (!session.authenticated) throw new Error("Expected a synthetic authenticated session");
  return session;
}

export function savedPlanSessionFixture(): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: "appu_synthetic_crew",
      email: "crew@example.invalid",
      display_name: "Synthetic crew",
      role: "field",
      frappe_user_id: "crew@example.invalid",
    },
    tenant: {
      id: "synthetic-tenant",
      name: "Synthetic tenant",
      brand: "Synthetic",
      locale: "en-CA",
      time_zone: "UTC",
      currency: "CAD",
    },
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    csrf_token: "synthetic-csrf",
    session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    source_updated_at: stamp,
    read_model_generated_at: stamp,
    stale_fields: [],
  };
}

export function savedPlanJobFixture(): JobResponse {
  return {
    version: 1,
    source_updated_at: stamp,
    read_model_generated_at: stamp,
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: [
      "field.checkin.create",
      "work_package.acknowledge",
      "work_package.start",
      "work_package.complete",
    ],
    job: {
      id: "JOB-SYNTHETIC",
      roof_job_id: null,
      job_number: "IW-SYNTHETIC",
      brand: "Synthetic",
      service_type: "Roofing",
      status: "In Production",
      address: "Synthetic training site",
      current_gate_state: "Blocked",
    },
    assignment: {
      id: "ASSIGN-SYNTHETIC",
      assignment_id: "assignment-synthetic",
      type: "Production",
      status: "Assigned",
      crew_profile: null,
      scheduled_start: null,
      scheduled_end: null,
      blocker_reason: null,
    },
    gates: [
      {
        id: "CHECK-SYNTHETIC",
        name: "Independent work check",
        state: "Blocked",
        blocker_reason: "Office evidence pending",
        owner: "Synthetic office",
        due_at: null,
      },
    ],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: {
        id: "WP-SYNTHETIC",
        version: 7,
        status: "Blocked",
        title: "Synthetic released work instructions",
        objective: "Inspect the synthetic work area",
        boundaries: "Training area only",
        prerequisites: "Inspect controls before access",
        expected_result: "Recorded inspection",
        stop_conditions: "Stop if the boundary is unsafe",
        make_safe_procedure: "Secure the training area and contact the office",
        issued_at: stamp,
        released_at: stamp,
        expires_at: stamp,
        work_object_type: "Roof Job",
        work_object_id: "JOB-SYNTHETIC",
        physical_context_type: "Roof Site",
        physical_context_id: "JOB-SYNTHETIC",
        release_attempt_id: "release-synthetic-7",
        supersession: null,
        acknowledgement: { current_user_acknowledged: false, acknowledged_at: null, workers: [] },
        evidence_slots: [],
        steps: [
          {
            sequence: 1,
            instruction: "Inspect the synthetic anchor",
            required_evidence: "Synthetic anchor record",
            acceptance_criteria: "The control is present",
          },
        ],
        hold_points: [
          {
            sequence: 1,
            hold_point: "Office control review",
            release_phase: "Pre-start",
            release_authority: "Office",
            required_evidence: "Verified control record",
            acceptance_criteria: "Office verifies the control",
            released: false,
          },
        ],
      },
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}
