import { mismatchedDetail } from "../../accounting/money-fixtures";
import { inventoryOverview } from "../../inventory/inventory-fixtures";

/**
 * One synthetic response per read model the Worker serves today, in the route's own shape and
 * carrying every path the registry publishes. The tests parse each with the app's zod contract
 * where one exists (`job_commercial_context` and `job_phase` have none, so those two follow the
 * Worker's TypeScript types and omit branches the registry does not publish) and resolve every
 * published path against it. Nothing here is a real customer, job, address or amount.
 */

const AT = "2026-08-20T09:00:00.000Z";

export const READ_MODEL_FIXTURES = {
  now: {
    version: 1,
    role: "owner",
    read_model_generated_at: AT,
    permissions: ["now:read"],
    allowed_actions: [],
    sources: [{ id: "owner", state: "current", read_model_generated_at: AT, stale_fields: [] }],
    ui: {
      schema_version: 1,
      state: "ready",
      title: "What needs you now",
      explanation: "One job cannot start until its materials arrive.",
      sync_label: "Your records are current for this view.",
      primary_action: null,
      sections: [
        {
          id: "exceptions",
          title: "Decide first",
          summary: "One job is waiting on materials.",
          cards: [
            {
              id: "owner:gate_example_a",
              tone: "warning",
              eyebrow: "Blocked gate",
              title: "Materials have not arrived",
              detail: "The job cannot start until delivery is confirmed.",
              action: null,
              citations: [],
            },
          ],
        },
      ],
    },
  },
  owner_now: {
    version: 1,
    source_updated_at: AT,
    read_model_generated_at: AT,
    stale_fields: ["exceptions.next_action"],
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    exceptions: [
      {
        id: "gate_example_a",
        kind: "blocked_gate",
        severity: null,
        title: "Materials gate blocked",
        why: "Delivery is not confirmed",
        next_action: null,
        job_id: "job-example-0001",
        occurred_at: AT,
        due_at: AT,
        received_at: AT,
        bus_status: null,
        triage_status: null,
        mctb: null,
      },
    ],
    partial_sources: [],
    summary: {
      active_jobs: 3,
      field_blockers: 0,
      blocked_gates: 1,
      open_incidents: 0,
      finance_exceptions: 0,
      untriaged_leads: 0,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 0,
    },
  },
  search: {
    version: 1,
    source_updated_at: AT,
    read_model_generated_at: AT,
    stale_fields: [],
    permissions: ["search.read"],
    allowed_actions: ["search.read", "job.read"],
    query: "example",
    query_class: "text",
    outcome: "results",
    groups: [
      {
        group: "jobs",
        label: "Jobs",
        limit: 8,
        matched_fields: ["job_number"],
        results: [
          {
            id: "job-example-0001",
            label: "EX-0001",
            detail: "Roofing · In Production",
            href: "/jobs/job-example-0001",
            matched_field: "job_number",
          },
        ],
        more_results: false,
      },
    ],
  },
  job_commercial_context: {
    schema: "ironwrap_commercial_context_v1",
    generated_at: AT,
    job: {
      roof_job_id: "job-example-0001",
      job_number: "EX-0001",
      status: "in_progress",
      version: 4,
      customer_display_name: "Example Customer",
    },
    offer: {
      state: "accepted",
      quote_head: null,
      quote: null,
      proposal: null,
      publication: {
        publication_event_id: "pub-example-0001",
        publication_version: 1,
        state: "published",
        occurred_at: AT,
      },
      acceptance: { acceptance_id: "acc-example-0001", accepted_at: AT },
      withdrawn_acceptance: null,
      expired: false,
    },
    contact: { email: null, consent: null, consent_limits: [] },
    follow_up: { blockers: [] },
    stale_reasons: [],
  },
  job_history: {
    version: 1,
    source_updated_at: AT,
    read_model_generated_at: AT,
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: [],
    job: {
      id: "job-example-0001",
      roof_job_id: "job-example-0001",
      job_number: "EX-0001",
      brand: "ironwrap",
      service_type: null,
      status: "In Production",
      address: "100 Example Street, Edmonton AB T0T 0T0, Canada",
      current_gate_state: "Blocked",
    },
    customer: { display_name: "Example Customer", phone: "780-555-0100" },
    gates: [
      {
        id: "gate-example-materials",
        name: "Materials",
        state: "Blocked",
        blocker_reason: "Delivery is not confirmed",
        owner: "Production",
        due_at: AT,
      },
    ],
    proof: {
      items: [
        {
          id: "evi_00000000000000000000000000000001",
          type: null,
          proof_slot: null,
          occurred_at: AT,
          summary: "Photo of the north slope",
          customer_safe: false,
          source: "Crew phone",
          sync_state: "Verified",
          blocker: false,
        },
      ],
      next_cursor: null,
    },
    openable: true,
    proof_unavailable: false,
  },
  inventory_overview: inventoryOverview(),
  job_phase: {
    version: 1,
    read_model_generated_at: AT,
    phase: "production_blocked",
    job: {
      roof_job_id: "job-example-0001",
      lead_id: "lead-example-0001",
      customer_id: "customer-example-0001",
      property_id: "property-example-0001",
      status: "in_progress",
      current_gate_state: "blocked",
      version: 4,
    },
    facts: {
      production: {
        gates: [
          {
            gate: "Materials",
            state: "blocked",
            blocker_reason: "Delivery is not confirmed",
            version: 2,
            updated_at: AT,
          },
        ],
        all_required_gates_ready: false,
        assignment: {
          assignment_id: "assignment-example-0001",
          assignment_version: 1,
          crew_id: "crew-example-0001",
          scheduled_start: AT,
          scheduled_end: AT,
          updated_at: AT,
        },
        work_package: null,
      },
      safety: {
        active_stops: [
          {
            occurrence_id: "occurrence-example-0001",
            severity: "moderate",
            state: "reported",
            updated_at: AT,
          },
        ],
        blocked: true,
      },
    },
    stale_reasons: [],
  },
  accounting_intent: mismatchedDetail(),
} as const;

export type ServedReadModel = keyof typeof READ_MODEL_FIXTURES;
