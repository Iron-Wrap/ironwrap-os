import type { OperatingIntakeResponse } from "./operating-intake-contracts";

export function operatingIntakePayload(
  overrides: Partial<OperatingIntakeResponse> = {},
): OperatingIntakeResponse {
  return {
    version: 1,
    operating_authority: "d1",
    tenant_id: "ironwrap",
    generated_at: "2026-08-21T16:00:00.000Z",
    leads: [
      {
        envelope_id: "ow_01234567-89ab-cdef-0123-456789abcdef",
        source: "website",
        status: "received",
        contact_name: "Launch Proof",
        contact_phone: "+15875550199",
        contact_email: "launch-proof+iro-189@example.invalid",
        received_at: "2026-08-21T15:59:00.000Z",
        job_ref: null,
        desk_state: "intake",
        not_a_scheduled_job: true,
        not_a_money_intent: true,
      },
    ],
    ...overrides,
  };
}
